import { STALENESS_THRESHOLDS_MS, type PathCategory, type SearchScope } from "./search-constants.js";
import type { StalenessBucket } from "./search-types.js";

const SEARCH_AGENT_FIT_NEUTRAL = 1.0;
const SEARCH_AGENT_FIT_TEST_INTENT_MULTIPLIER = 1.25;
const SEARCH_AGENT_FIT_TEST_DEMOTION_RUNTIME = 0.45;
const SEARCH_AGENT_FIT_TEST_DEMOTION_MIXED = 0.65;
const SEARCH_AGENT_FIT_IMPLEMENTATION_TEST_DEMOTION = 0.25;
const SEARCH_AGENT_FIT_IMPLEMENTATION_SYMBOL_MULTIPLIER = 1.25;
const SEARCH_AGENT_FIT_IMPLEMENTATION_CHUNK_MULTIPLIER = 1.15;
const SEARCH_AGENT_FIT_SCRIPT_IMPLEMENTATION_MULTIPLIER = 1.30;
const SEARCH_AGENT_FIT_WRITER_OWNER_MULTIPLIER = 2.25;
const SEARCH_AGENT_FIT_WRITER_NON_OWNER_DEMOTION = 0.55;
const SEARCH_AGENT_FIT_TYPE_DEMOTION = 0.72;
const SEARCH_AGENT_FIT_SCHEMA_DEMOTION = 0.80;
const SEARCH_AGENT_FIT_ANONYMOUS_DEMOTION = 0.70;

type SearchLexicalTermLike = {
    value: string;
    kind: "whole" | "fragment";
};

type SearchQueryPlanLike = {
    testSeeking: boolean;
    implementationSeeking: boolean;
    writerSeeking: boolean;
    lexicalTerms: SearchLexicalTermLike[];
};

type SearchResultLike = {
    relativePath: string;
    content?: string | null;
    symbolLabel?: string | null;
    symbolId?: string | null;
    startLine?: number;
};

type SearchCandidateLike = {
    result: SearchResultLike;
    finalScore: number;
    passesMatchedMust: boolean;
    exactLexicalMatch: boolean;
    exactMatchPinned: boolean;
    rerankAdjusted: boolean;
    retrievalPasses: string[];
    backendScoreKindsSeen: Array<"dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown">;
};

type SearchOwnerSourceLike = "owner_metadata" | "registry_repair" | "fallback";
type TokenBoundaryMatcher = (field: string, term: string) => boolean;

function compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
    const left = a === undefined || a === null ? Number.POSITIVE_INFINITY : a;
    const right = b === undefined || b === null ? Number.POSITIVE_INFINITY : b;
    return left - right;
}

function compareNullableStringsAsc(a?: string | null, b?: string | null): number {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
}

export function normalizeSearchPath(relativePath: string): string {
    return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function hasPathSegment(normalizedPath: string, segment: string): boolean {
    return normalizedPath === segment
        || normalizedPath.startsWith(`${segment}/`)
        || normalizedPath.includes(`/${segment}/`);
}

function hasLeadingPathSegment(normalizedPath: string, segment: string): boolean {
    return normalizedPath === segment || normalizedPath.startsWith(`${segment}/`);
}

export function isTestPath(normalizedPath: string): boolean {
    return hasPathSegment(normalizedPath, "test")
        || hasPathSegment(normalizedPath, "tests")
        || hasPathSegment(normalizedPath, "__tests__")
        || /\.test\.[^/]+$/.test(normalizedPath)
        || /\.spec\.[^/]+$/.test(normalizedPath);
}

export function isDocPath(normalizedPath: string): boolean {
    return hasPathSegment(normalizedPath, "docs")
        || hasPathSegment(normalizedPath, "doc")
        || hasPathSegment(normalizedPath, "documentation")
        || hasPathSegment(normalizedPath, "guide")
        || hasPathSegment(normalizedPath, "guides")
        || normalizedPath.endsWith(".md")
        || normalizedPath.endsWith(".mdx")
        || normalizedPath.endsWith(".rst")
        || normalizedPath.endsWith(".adoc")
        || normalizedPath.endsWith(".txt");
}

export function isGeneratedPath(normalizedPath: string): boolean {
    return hasPathSegment(normalizedPath, "dist")
        || hasPathSegment(normalizedPath, "build")
        || hasPathSegment(normalizedPath, "coverage")
        || hasPathSegment(normalizedPath, ".next")
        || hasPathSegment(normalizedPath, ".output")
        || hasPathSegment(normalizedPath, "generated")
        || normalizedPath.endsWith(".min.js")
        || normalizedPath.endsWith(".min.css");
}

export function isFixturePath(normalizedPath: string): boolean {
    return hasPathSegment(normalizedPath, "fixtures")
        || hasPathSegment(normalizedPath, "__fixtures__");
}

function isArtifactPath(normalizedPath: string): boolean {
    return hasLeadingPathSegment(normalizedPath, "reports")
        || hasLeadingPathSegment(normalizedPath, "report")
        || hasLeadingPathSegment(normalizedPath, "investigations")
        || hasLeadingPathSegment(normalizedPath, "investigation")
        || hasPathSegment(normalizedPath, ".codebase-memory")
        || hasPathSegment(normalizedPath, ".satori");
}

function isLandingPath(normalizedPath: string): boolean {
    return hasPathSegment(normalizedPath, "satori-landing")
        || hasPathSegment(normalizedPath, "landing")
        || hasPathSegment(normalizedPath, "landing-page");
}

function isExamplePath(normalizedPath: string): boolean {
    return hasPathSegment(normalizedPath, "examples")
        || hasPathSegment(normalizedPath, "example")
        || hasPathSegment(normalizedPath, "demo")
        || hasPathSegment(normalizedPath, "samples")
        || hasPathSegment(normalizedPath, "sample");
}

function isAdapterPath(normalizedPath: string): boolean {
    return hasPathSegment(normalizedPath, "adapters")
        || hasPathSegment(normalizedPath, "adapter")
        || hasPathSegment(normalizedPath, "tools")
        || hasPathSegment(normalizedPath, "cli");
}

function isPublicToolOrCliAdapterPath(relativePath: string): boolean {
    const normalizedPath = normalizeSearchPath(relativePath);
    return hasPathSegment(normalizedPath, "tools")
        || hasPathSegment(normalizedPath, "cli");
}

function isEntrypointPath(normalizedPath: string): boolean {
    const entryNames = ["main.", "index.", "app.", "server.", "cli.", "entry."];
    const baseName = normalizedPath.split("/").pop() || "";
    return entryNames.some((prefix) => baseName.startsWith(prefix));
}

function isScriptRuntimePath(normalizedPath: string): boolean {
    return normalizedPath === "scripts" || normalizedPath.startsWith("scripts/");
}

function isImplementationPathCategory(category: PathCategory): boolean {
    return category === "entrypoint"
        || category === "core"
        || category === "srcRuntime"
        || category === "scriptRuntime"
        || category === "adapter"
        || category === "neutral";
}

function classifyAgentFitSymbolRole(result: SearchResultLike): "implementation" | "type" | "schema" | "anonymous" | "unknown" {
    const label = typeof result?.symbolLabel === "string" ? result.symbolLabel.trim().toLowerCase() : "";
    const content = typeof result?.content === "string" ? result.content.slice(0, 400).toLowerCase() : "";
    const evidence = `${label}\n${content}`;

    if (/<anonymous>/.test(evidence)) return "anonymous";
    if (/\b(?:schema|inputschema|outputschema|responseenvelope|requestinput)\b/.test(evidence)) return "schema";
    if (/^(?:interface|type|enum)\b/.test(label)) return "type";
    if (/^(?:async\s+)?(?:function|method|class|def)\b/.test(label)) return "implementation";
    if (/^(?:const|let|var)\s+[a-z0-9_$]+\s*=/.test(label) && /\b(?:async\s+)?function\b|=>/.test(content)) {
        return "implementation";
    }
    return "unknown";
}

function isWriterOwnerResult(result: SearchResultLike): boolean {
    const label = typeof result?.symbolLabel === "string" ? result.symbolLabel.trim().toLowerCase() : "";
    const content = typeof result?.content === "string" ? result.content.slice(0, 800).toLowerCase() : "";
    const evidence = `${label}\n${content}`;

    if (/^(?:async\s+)?(?:(?:function|method|const|let|var)\s+)?(?:[a-z0-9_$]+\.)*(?:write|update|build|prepare|generate|emit|install|configure|persist|create|ensure|set|save|add|remove|delete)[a-z0-9_$]*(?:\b|\()/.test(label)) {
        return true;
    }
    return /\b(?:writefilesync|writefile|appendfile|mkdir|rename|unlink|rm|copyfile|lines\.splice)\b/.test(evidence);
}

function isStrongWriterOwnerResult(result: SearchResultLike): boolean {
    const label = typeof result?.symbolLabel === "string" ? result.symbolLabel.trim().toLowerCase() : "";
    const content = typeof result?.content === "string" ? result.content.slice(0, 800).toLowerCase() : "";
    const evidence = `${label}\n${content}`;

    if (/^(?:async\s+)?(?:(?:function|method|const|let|var)\s+)?(?:[a-z0-9_$]+\.)*(?:write|update|generate|emit|install|configure|persist|create|set|save|add|remove|delete)[a-z0-9_$]*(?:\b|\()/.test(label)) {
        return true;
    }
    return /\b(?:writefilesync|writefile|appendfile|mkdir|rename|unlink|rm|copyfile|lines\.splice)\b/.test(evidence);
}

export function isWriterActionTerm(term: string): boolean {
    return /^(?:write|writes|writing|written|update|updates|updated|updating|create|creates|created|creating|generate|generates|generated|generating|emit|emits|emitted|emitting|persist|persists|persisted|persisting|configure|configures|configured|configuring|install|installs|installed|installing|build|builds|built|builder)$/.test(term);
}

function countCandidateDomainTermMatches(
    plan: SearchQueryPlanLike,
    result: SearchResultLike,
    hasTokenBoundaryMatch: TokenBoundaryMatcher,
): number {
    const content = typeof result?.content === "string" ? result.content : "";
    const label = typeof result?.symbolLabel === "string" ? result.symbolLabel : "";
    const relativePath = typeof result?.relativePath === "string" ? result.relativePath : "";
    const evidence = `${label}\n${relativePath}\n${content}`
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[/\\._:-]+/g, " ")
        .toLowerCase();
    const matched = new Set<string>();

    for (const term of plan.lexicalTerms) {
        if (term.kind !== "whole" || isWriterActionTerm(term.value)) {
            continue;
        }
        if (hasTokenBoundaryMatch(evidence, term.value)) {
            matched.add(term.value);
        }
    }

    return matched.size;
}

function parseIndexedAtMs(indexedAt?: string): number | undefined {
    if (!indexedAt) return undefined;
    const parsed = Date.parse(indexedAt);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function compareSearchCandidates(
    a: SearchCandidateLike,
    b: SearchCandidateLike,
    options?: { exactMatchFirst?: boolean; mustMatchesFirst?: boolean },
): number {
    if (options?.mustMatchesFirst === true && a.passesMatchedMust !== b.passesMatchedMust) {
        return a.passesMatchedMust ? -1 : 1;
    }
    if (options?.exactMatchFirst === true && a.exactLexicalMatch !== b.exactLexicalMatch) {
        return a.exactLexicalMatch ? -1 : 1;
    }
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    const fileCmp = compareNullableStringsAsc(a.result.relativePath, b.result.relativePath);
    if (fileCmp !== 0) return fileCmp;
    const startCmp = compareNullableNumbersAsc(a.result.startLine, b.result.startLine);
    if (startCmp !== 0) return startCmp;
    const labelCmp = compareNullableStringsAsc(a.result.symbolLabel, b.result.symbolLabel);
    if (labelCmp !== 0) return labelCmp;
    return compareNullableStringsAsc(a.result.symbolId, b.result.symbolId);
}

export function classifyPathCategory(relativePath: string): PathCategory {
    const normalized = normalizeSearchPath(relativePath);
    if (isGeneratedPath(normalized)) return "generated";
    if (isFixturePath(normalized)) return "fixture";
    if (isLandingPath(normalized)) return "landing";
    if (isArtifactPath(normalized)) return "artifact";
    if (isTestPath(normalized)) return "tests";
    if (isDocPath(normalized)) return "docs";
    if (isExamplePath(normalized)) return "example";
    if (isScriptRuntimePath(normalized)) return "scriptRuntime";
    if (isAdapterPath(normalized)) return "adapter";
    if (isEntrypointPath(normalized)) return "entrypoint";
    if (normalized.includes("/src/core/") || normalized.includes("/core/")) return "core";
    if (normalized.includes("/src/")) return "srcRuntime";
    return "neutral";
}

export function shouldIncludeCategoryInScope(scope: SearchScope, category: PathCategory): boolean {
    if (scope === "runtime") {
        return category !== "docs"
            && category !== "generated"
            && category !== "artifact"
            && category !== "landing"
            && category !== "fixture";
    }
    if (scope === "docs") {
        // Docs-only: tests stay in runtime/mixed so "docs scope" is trustworthy for contract reading.
        return category === "docs";
    }
    return true;
}

export function shouldApplyChangedFilesBoost(category: PathCategory, plan: SearchQueryPlanLike): boolean {
    if (category === "tests") {
        return plan.testSeeking;
    }
    return isImplementationPathCategory(category);
}

export function resolveAgentFitMultiplier(input: {
    plan: SearchQueryPlanLike;
    result: SearchResultLike;
    category: PathCategory;
    scope: SearchScope;
    hasTokenBoundaryMatch: TokenBoundaryMatcher;
}): { multiplier: number; reason: string } {
    const { plan, result, category, scope, hasTokenBoundaryMatch } = input;
    if (scope === "docs") {
        return { multiplier: SEARCH_AGENT_FIT_NEUTRAL, reason: "docs_scope_neutral" };
    }

    if (category === "tests") {
        if (plan.testSeeking) {
            return { multiplier: SEARCH_AGENT_FIT_TEST_INTENT_MULTIPLIER, reason: "test_intent" };
        }
        if (plan.implementationSeeking) {
            return { multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_TEST_DEMOTION, reason: "implementation_query_test_demotion" };
        }
        return {
            multiplier: scope === "mixed" ? SEARCH_AGENT_FIT_TEST_DEMOTION_MIXED : SEARCH_AGENT_FIT_TEST_DEMOTION_RUNTIME,
            reason: "test_without_test_intent",
        };
    }

    const role = classifyAgentFitSymbolRole(result);
    const domainTermMatches = plan.writerSeeking
        ? countCandidateDomainTermMatches(plan, result, hasTokenBoundaryMatch)
        : 0;

    if (plan.writerSeeking) {
        if (isWriterOwnerResult(result)
            && isImplementationPathCategory(category)
            && (domainTermMatches >= 2 || isStrongWriterOwnerResult(result))) {
            return { multiplier: SEARCH_AGENT_FIT_WRITER_OWNER_MULTIPLIER, reason: "writer_owner" };
        }
        if (role === "implementation" && isImplementationPathCategory(category) && domainTermMatches >= 2) {
            return { multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_SYMBOL_MULTIPLIER, reason: "implementation_symbol" };
        }
        if (role === "schema") return { multiplier: SEARCH_AGENT_FIT_SCHEMA_DEMOTION, reason: "schema_not_owner" };
        if (role === "type") return { multiplier: SEARCH_AGENT_FIT_TYPE_DEMOTION, reason: "type_not_owner" };
        if (role === "anonymous") return { multiplier: SEARCH_AGENT_FIT_ANONYMOUS_DEMOTION, reason: "anonymous_not_owner" };
        return { multiplier: SEARCH_AGENT_FIT_WRITER_NON_OWNER_DEMOTION, reason: "writer_query_non_writer" };
    }

    if (plan.implementationSeeking && category === "scriptRuntime") {
        return { multiplier: SEARCH_AGENT_FIT_SCRIPT_IMPLEMENTATION_MULTIPLIER, reason: "script_implementation" };
    }
    if (plan.implementationSeeking && role === "schema") {
        return { multiplier: SEARCH_AGENT_FIT_SCHEMA_DEMOTION, reason: "schema_not_owner" };
    }
    if (plan.implementationSeeking && role === "type") {
        return { multiplier: SEARCH_AGENT_FIT_TYPE_DEMOTION, reason: "type_not_owner" };
    }
    if (plan.implementationSeeking && role === "anonymous") {
        return { multiplier: SEARCH_AGENT_FIT_ANONYMOUS_DEMOTION, reason: "anonymous_not_owner" };
    }
    if (
        plan.implementationSeeking
        && role === "implementation"
        && category === "adapter"
        && isPublicToolOrCliAdapterPath(result.relativePath)
    ) {
        return { multiplier: SEARCH_AGENT_FIT_NEUTRAL, reason: "adapter_not_canonical_owner" };
    }
    if (plan.implementationSeeking && role === "implementation") {
        return { multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_SYMBOL_MULTIPLIER, reason: "implementation_symbol" };
    }
    if (plan.implementationSeeking && !result.symbolLabel && isImplementationPathCategory(category)) {
        return { multiplier: SEARCH_AGENT_FIT_IMPLEMENTATION_CHUNK_MULTIPLIER, reason: "implementation_chunk" };
    }

    return { multiplier: SEARCH_AGENT_FIT_NEUTRAL, reason: "neutral" };
}

export function getStalenessBucket(indexedAt: string | undefined, nowMs: number): StalenessBucket {
    const indexedAtMs = parseIndexedAtMs(indexedAt);
    if (indexedAtMs === undefined) return "unknown";
    const ageMs = Math.max(0, nowMs - indexedAtMs);
    if (ageMs <= STALENESS_THRESHOLDS_MS.fresh) return "fresh";
    if (ageMs <= STALENESS_THRESHOLDS_MS.aging) return "aging";
    return "stale";
}

export function sortSearchCandidates(
    candidates: SearchCandidateLike[],
    exactMatchFirst: boolean,
    mustMatchesFirst = false,
): boolean {
    const topWithoutPinning = candidates.length > 0
        ? [...candidates].sort((a, b) => compareSearchCandidates(a, b, { mustMatchesFirst }))[0]
        : undefined;
    candidates.sort((a, b) => compareSearchCandidates(a, b, { exactMatchFirst, mustMatchesFirst }));
    if (!exactMatchFirst || !topWithoutPinning || candidates.length === 0) {
        return false;
    }
    const applied = topWithoutPinning.exactLexicalMatch !== candidates[0].exactLexicalMatch;
    if (applied) {
        candidates[0].exactMatchPinned = true;
    }
    return applied;
}

export function buildSearchCandidateProvenance(
    candidate: SearchCandidateLike,
    ownerSource: SearchOwnerSourceLike = "fallback",
) {
    const retrievalPasses = [...candidate.retrievalPasses].sort();
    const backendScoreKinds = [...candidate.backendScoreKindsSeen].sort();
    return {
        retrievalPasses,
        backendScoreKinds,
        semanticCandidate: retrievalPasses.some((passId) => passId === "primary" || passId === "expanded"),
        lexicalCandidate: retrievalPasses.some((passId) => passId === "lexical_files" || passId === "live_path")
            || backendScoreKinds.includes("lexical_rank"),
        rerankAdjusted: candidate.rerankAdjusted,
        exactMatchPinned: candidate.exactMatchPinned,
        ownerRepairApplied: ownerSource === "registry_repair",
    };
}
