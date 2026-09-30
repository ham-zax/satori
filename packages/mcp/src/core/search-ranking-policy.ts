import { STALENESS_THRESHOLDS_MS, type PathCategory, type SearchScope } from "./search-constants.js";
import type { SearchQueryPlan } from "./search-lexical-scoring.js";
import type { SearchAnswerFocus } from "./search-rerank-context.js";
import type { StalenessBucket } from "./search-types.js";

type SearchCandidateLike = {
    result: {
        relativePath: string;
    };
    exactMatchPinned: boolean;
    exactLexicalMatch: boolean;
    rerankAdjusted: boolean;
    retrievalPasses: string[];
    backendScoreKindsSeen: Array<"dense_similarity" | "lexical_rank" | "rrf_fusion" | "unknown">;
};

type SearchOwnerSourceLike = "owner_metadata" | "registry_repair" | "fallback";

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
        || /\.spec\.[^/]+$/.test(normalizedPath)
        || /_(?:test|tests)\.[^/]+$/.test(normalizedPath);
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

const CONFIGURATION_PATH_EXTENSIONS = [
    ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".xml", ".properties", ".env",
];

export function isConfigurationPath(normalizedPath: string): boolean {
    const baseName = normalizedPath.split("/").pop() || "";
    return baseName === "dockerfile"
        || CONFIGURATION_PATH_EXTENSIONS.some((extension) => normalizedPath.endsWith(extension));
}

function isArtifactPath(normalizedPath: string): boolean {
    return hasLeadingPathSegment(normalizedPath, "reports")
        || hasLeadingPathSegment(normalizedPath, "report")
        || hasLeadingPathSegment(normalizedPath, "investigations")
        || hasLeadingPathSegment(normalizedPath, "investigation")
        || hasLeadingPathSegment(normalizedPath, "scripts/archive")
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
        || hasPathSegment(normalizedPath, "cli")
        || normalizedPath.split("/").some((segment) => /(?:^|[-_])mcp[-_](?:server|client)$/.test(segment));
}

function isEntrypointPath(normalizedPath: string): boolean {
    const entryNames = ["main.", "index.", "app.", "server.", "cli.", "entry."];
    const baseName = normalizedPath.split("/").pop() || "";
    return entryNames.some((prefix) => baseName.startsWith(prefix));
}

function isScriptRuntimePath(normalizedPath: string): boolean {
    return normalizedPath === "scripts" || normalizedPath.startsWith("scripts/");
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
    if (scope === "docs") return category === "docs";
    return true;
}

export function isWriterActionTerm(term: string): boolean {
    return /^(?:write|writes|writing|written|update|updates|updated|updating|create|creates|created|creating|generate|generates|generated|generating|emit|emits|emitted|emitting|persist|persists|persisted|persisting|configure|configures|configured|configuring|install|installs|installed|installing|build|builds|built|builder)$/.test(term);
}

export function getStalenessBucket(indexedAt: string | undefined, nowMs: number): StalenessBucket {
    if (!indexedAt) return "unknown";
    const indexedAtMs = Date.parse(indexedAt);
    if (!Number.isFinite(indexedAtMs)) return "unknown";
    const ageMs = Math.max(0, nowMs - indexedAtMs);
    if (ageMs <= STALENESS_THRESHOLDS_MS.fresh) return "fresh";
    if (ageMs <= STALENESS_THRESHOLDS_MS.aging) return "aging";
    return "stale";
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

/** Apply answer intent without blending relevance scores or reordering peers. */
export function preferImplementationCandidates<T>(input: {
    candidates: readonly T[];
    relativePath: (candidate: T) => string;
    answerFocus: SearchAnswerFocus;
    queryPlan: Pick<SearchQueryPlan, "route" | "testSeeking" | "documentationSeeking" | "referenceSeeking" | "lexicalTerms">;
    hasPathConstraint: boolean;
}): T[] {
    const plan = input.queryPlan;
    if (input.answerFocus !== "implementation" || input.hasPathConstraint
        || plan.testSeeking || plan.documentationSeeking || plan.referenceSeeking
        || plan.route.kind === "exact_path" || plan.route.kind === "configuration"
        || plan.route.kind === "references") {
        return [...input.candidates];
    }
    const queryTerms = new Set(plan.lexicalTerms.map((term) => term.value.toLowerCase()));
    const implementations: T[] = [];
    const adapters: T[] = [];
    const supporting: T[] = [];
    for (const candidate of input.candidates) {
        const path = normalizeSearchPath(input.relativePath(candidate));
        const category = classifyPathCategory(path);
        if (category === "adapter") {
            // A named integration is implementation evidence when the query
            // asks for that integration. Its package name alone is not enough.
            const requested = path.split(/[^a-z0-9]+/).some((term) => (
                /^(?:mcp|cli|tools?|adapters?)$/.test(term) && queryTerms.has(term)
            ));
            (requested ? implementations : adapters).push(candidate);
        } else if (category === "tests" || category === "fixture" || category === "docs"
            || category === "generated" || category === "example" || category === "artifact"
            || category === "landing" || isConfigurationPath(path)) {
            supporting.push(candidate);
        } else {
            implementations.push(candidate);
        }
    }
    return [...implementations, ...adapters, ...supporting];
}
