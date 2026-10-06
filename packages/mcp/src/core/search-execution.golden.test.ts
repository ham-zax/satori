/**
 * Golden snapshots for runSearchExecution.
 *
 * Each scenario drives the real execution pipeline with fake hosts (no model,
 * no network) and records the host calls, the final ordered results, the
 * outcome flags and the full candidate-survival trace. The snapshot is the
 * behavioral contract for refactors of search-execution.ts: any change to
 * fusion, admission, reservation, rerank or fallback ordering shows up as a
 * snapshot diff. Regenerate deliberately with:
 *   node --import tsx --import ./src/test-state-root.ts --test --test-update-snapshots \
 *     src/core/search-execution.golden.test.ts
 *
 * Every scenario carries an `expect` check proving it takes the branch it is
 * named for, so a fixture that silently stops exercising its branch fails
 * loudly instead of snapshotting an unrelated path.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
    LexicalRetrievalModeUnsupportedError,
    RerankerRequestError,
    type RerankExecutionDiagnostics,
    type Reranker,
    type RerankResult,
    type SemanticSearchResult,
} from "@satori-code/core";
import type { CapabilityResolver } from "./capabilities.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { resolveSearchCandidateRole } from "./search-candidate-role.js";
import { resolveSearchAltTerms } from "./search-expansion-terms.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { resolveSearchPolicy } from "./search-policy.js";
import {
    buildSearchRerankQuery,
    SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
} from "./search-rerank-query.js";
import type { SearchResultLike } from "./search-lexical-scoring.js";
import type { SearchRerankProjectionResult } from "./search-rerank-projection-result.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchExecutionHost,
    type SearchExecutionInput,
    type SearchExecutionOutcome,
} from "./search-execution.js";

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

type Row = SemanticSearchResult;

function row(relativePath: string, score: number, extra: Partial<Row> = {}): Row {
    const slug = relativePath.replace(/[^A-Za-z0-9]/g, "_");
    return {
        relativePath,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content: `export function ${slug}() { return true; }`,
        score,
        symbolLabel: `function ${slug}()`,
        ...extra,
    };
}

/** `count` deterministic rows `<dir>/<prefix>_<i>.ts` with strictly decreasing scores. */
function pool(dir: string, prefix: string, count: number, top: number, step = 1e-3): Row[] {
    return Array.from({ length: count }, (_, i) => row(`${dir}/${prefix}_${i}.ts`, top - i * step));
}

const Q_IMPL = "where find the relevant implementation";
const Q_NEUTRAL = "stale cleanup effects";
const Q_DEF = "trade workflow rejected bundle loop";
const Q_DIRTY = "where is naive utc handling";
const Q_MUST = "must:tzinfo where is naive utc handling";
const Q_MUST_TWO = "must:tzinfo must:None where is naive utc handling";
const Q_PATH = "path:src/dirty.ts where is the relevant implementation";

// ---------------------------------------------------------------------------
// Scenario model
// ---------------------------------------------------------------------------

type PassName = "primary" | "expanded" | "must_lane";

type SemanticCall = {
    n: number;
    pass: PassName;
    query: string;
    topK: number;
    retrievalMode: string;
    lexicalMatchMode?: string;
    lexicalFallbackTerms?: string[];
    hasFilter: boolean;
};

type ScenarioContext = { abort: (reason: Error) => void };

type RerankerSpec = {
    provider: "voyage" | "lateon";
    /** Provider behavior; the default orders by index with a boost for paths containing "winner". */
    behavior?: "ranked" | "throw" | "malformed" | "abort_then_throw";
    error?: Error;
    diagnostics?: RerankExecutionDiagnostics;
    maxDocuments?: number;
};

type Scenario = {
    name: string;
    query: string;
    flags?: Record<string, boolean>;
    altTerms?: string[];
    reservationPolicy?: string;
    limit?: number;
    resultMode?: "raw" | "grouped";
    rankingMode?: "default" | "auto_changed_first";
    freshnessMode?: "synced" | "served_previous_generation";
    changedFiles?: string[];
    dirtyFilesNotFreshened?: boolean;
    /** Request cancellation: the signal is attached to the input. */
    withSignal?: boolean;
    semantic: (call: SemanticCall, ctx: ScenarioContext) => Row[];
    reranker?: RerankerSpec;
    tracked?: Row[];
    dirty?: Row[];
    live?: Row[];
    metadata?: (query?: string) => Row[];
    definitions?: Record<string, string>;
    projection?: (result: Row) => SearchRerankProjectionResult;
    embeddingDiagnostic?: (error: unknown) => unknown;
    vectorDiagnostic?: (error: unknown) => unknown;
    /** Branch evidence: asserts the scenario really took the branch it is named for. */
    expect: (rec: Record<string, unknown>) => void;
};

// ---------------------------------------------------------------------------
// Harness (helper patterns copied from the sibling search-execution tests)
// ---------------------------------------------------------------------------

function buildSupport(
    reranker: Reranker | null,
    scenario: Scenario,
    counters: Record<string, number>,
): SearchQuerySupport {
    const support = new SearchQuerySupport({
        normalizeSearchPath: (value) => value,
        hasPathSegment: () => false,
        isGeneratedPath: () => false,
        isTestPath: () => false,
        isFixturePath: () => false,
        isDocPath: () => false,
        getContextActiveIgnorePatterns: () => [],
        getContextTrackedRelativePaths: () => [],
        classifyPathCategory: () => "srcRuntime",
        shouldIncludeCategoryInScope: () => true,
        capabilities: {
            hasReranker: () => reranker !== null,
            getDefaultRerankEnabled: () => reranker !== null,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker,
        gitignoreForceReloadEveryN: 1000,
    });
    // Working-tree readers are replaced by deterministic stubs that count their calls.
    support.buildDirtyFileSearchResults = async () => {
        counters.dirtyOverlayCalls += 1;
        return (scenario.dirty ?? []) as never;
    };
    support.buildTrackedLexicalSearchResults = async () => {
        counters.trackedLexicalCalls += 1;
        return {
            results: (scenario.tracked ?? []) as never,
            debug: {
                enabled: true,
                trackedPathCount: 0,
                filesConsidered: 0,
                filesScanned: 0,
                bytesRead: 0,
                cappedByFiles: false,
                cappedByBytes: false,
                returnedResults: (scenario.tracked ?? []).length,
            },
        };
    };
    support.buildLivePathScopedSearchResults = async () => {
        counters.livePathCalls += 1;
        return (scenario.live ?? []) as never;
    };
    return support;
}

function buildReranker(
    spec: RerankerSpec,
    log: Array<Record<string, unknown>>,
    ctx: ScenarioContext,
): Reranker {
    return {
        getIdentity: () => ({ provider: spec.provider, model: "golden", profile: "golden" }),
        ...(spec.maxDocuments !== undefined ? { getMaxDocuments: () => spec.maxDocuments } : {}),
        rerank: async (query, documents, options): Promise<RerankResult[]> => {
            log.push({
                query,
                documents: documents.map((document) => document.split("\n")[0]!.slice(0, 80)),
                signalProvided: options?.signal !== undefined,
            });
            if (spec.diagnostics) options?.onExecutionDiagnostics?.(spec.diagnostics);
            if (spec.behavior === "throw") throw spec.error ?? new Error("golden reranker failure");
            if (spec.behavior === "abort_then_throw") {
                ctx.abort(new Error("cancel reranking"));
                throw new Error("provider cancelled");
            }
            if (spec.behavior === "malformed") {
                return [{ index: 9999, relevanceScore: 1 }];
            }
            return documents
                .map((document, index) => ({
                    index,
                    relevanceScore: (document.includes("winner") ? 1 : 0.5) - index * 0.01,
                }))
                .sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
        },
    };
}

function buildInput(scenario: Scenario, signal: AbortSignal | undefined): SearchExecutionInput {
    const parsedOperators = parseSearchOperators(scenario.query);
    const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    const limit = scenario.limit ?? 3;
    // Replicates the request coordinator: caller terms reach the reranker question
    // unless the rerank_alt_terms flag is off.
    const emitted = resolveSearchAltTerms(scenario.altTerms).termsEmitted;
    const rerankAltTerms = scenario.flags?.rerank_alt_terms !== false;
    return {
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: scenario.rankingMode ?? "default",
        resultMode: scenario.resultMode ?? "raw",
        limit,
        debugMode: "full",
        semanticQuery: parsedOperators.semanticQuery,
        answerFocus,
        rerankQuery: buildSearchRerankQuery({
            semanticQuery: parsedOperators.semanticQuery,
            answerFocus,
            callerTerms: rerankAltTerms ? emitted : [],
        }),
        rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        parsedOperators,
        queryPlan,
        exactRegistryEligible: false,
        exactRegistryFallbackForTrackedLexical: false,
        freshnessMode: scenario.freshnessMode ?? "synced",
        observedChangedFilesState: {
            available: (scenario.changedFiles ?? []).length > 0,
            files: new Set(scenario.changedFiles ?? []),
        },
        dirtyFilesNotFreshened: scenario.dirtyFilesNotFreshened ?? false,
        retrievalPolicy: resolveSearchPolicy({
            resultLimit: limit,
            hasMustOperators: parsedOperators.must.length > 0,
        }),
        ...(scenario.flags ? { flags: scenario.flags } : {}),
        ...(scenario.altTerms ? { alt_terms: scenario.altTerms } : {}),
        ...(scenario.reservationPolicy ? { reservation_policy: scenario.reservationPolicy } : {}),
        ...(signal ? { signal } : {}),
    };
}

function buildDiagnostics(limit: number): SearchDiagnostics {
    return {
        queryLength: 0,
        limitRequested: limit,
        resultsBeforeFilter: 0,
        resultsAfterFilter: 0,
        excludedByIgnore: 0,
        excludedBySubdirectory: 0,
        filterPass: "expanded",
        freshnessMode: undefined,
        searchPassCount: 0,
        searchPassSuccessCount: 0,
        searchPassFailureCount: 0,
        rerankerAttempted: false,
        rerankerUsed: false,
        semanticSearchAttempts: 0,
        embeddingCallsByCurrentContract: 0,
        denseQueriesByCurrentContract: 0,
        sparseQueriesByCurrentContract: 0,
        rerankerCalls: 0,
        rerankerCandidates: 0,
        rerankerInputBytes: 0,
        rerankerFailures: 0,
        rerankerRetries: 0,
        rerankerTimeouts: 0,
        candidatesWithSemanticEvidence: 0,
        candidatesWithLexicalEvidence: 0,
        candidatesWithCurrentSourceEvidence: 0,
        semanticExpansionAttempted: false,
    };
}

function summarizeOutcome(outcome: SearchExecutionOutcome): Record<string, unknown> {
    if (outcome.kind !== "ok") return { ...outcome };
    return {
        kind: outcome.kind,
        results: outcome.scored.map((c) => ({
            rank: c.authoritativeRank,
            relativePath: c.result.relativePath,
            symbolLabel: c.result.symbolLabel,
            startLine: c.result.startLine,
            endLine: c.result.endLine,
            score: c.finalScore,
            fusionScore: c.fusionScore,
            backendScore: c.backendScore,
            rerankerRank: c.rerankerRank,
            rerankerScore: c.rerankerScore,
            retrievalPasses: [...c.retrievalPasses].sort(),
        })),
        orderAuthority: outcome.orderAuthority,
        attemptsUsed: outcome.attemptsUsed,
        candidateLimit: outcome.candidateLimit,
        passesUsed: [...outcome.passesUsed].sort(),
        searchWarnings: [...outcome.searchWarnings].sort(),
        semanticExpansion: outcome.semanticExpansion,
        filterSummary: outcome.filterSummary,
        exactMatchPinningApplied: outcome.exactMatchPinningApplied,
        skippedByExactPin: outcome.skippedByExactPin,
        rerankerAttempted: outcome.rerankerAttempted,
        rerankerApplied: outcome.rerankerApplied,
        rerankerFailurePhase: outcome.rerankerFailurePhase,
        rerankerOperationalReason: outcome.rerankerOperationalReason,
        rerankerFailureKind: outcome.rerankerFailureKind,
        rerankerExecutionDiagnostics: outcome.rerankerExecutionDiagnostics,
        rerankerCandidatesIn: outcome.rerankerCandidatesIn,
        rerankerCandidatesReranked: outcome.rerankerCandidatesReranked,
        rerankerCandidatePoolCount: outcome.rerankerCandidatePoolCount,
        rerankerCandidateBudget: outcome.rerankerCandidateBudget,
        rerankerBudgetReason: outcome.rerankerBudgetReason,
        rerankerProjection: outcome.rerankerProjection,
        rankingProvenance: outcome.rankingProvenance,
        providerWork: outcome.providerWork,
        mustConstraintRetrievalOutcome: outcome.mustConstraintRetrievalOutcome,
        mustConstraintMustTokens: outcome.mustConstraintMustTokens,
        mustCoverage: outcome.mustCoverage,
        trackedLexicalDebug: outcome.trackedLexicalDebug,
        semanticPassFailures: outcome.semanticPassFailures,
        candidateSurvival: outcome.candidateSurvival,
    };
}

async function execute(scenario: Scenario): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const ctx: ScenarioContext = { abort: (reason) => controller.abort(reason) };
    const counters = { dirtyOverlayCalls: 0, trackedLexicalCalls: 0, livePathCalls: 0 };
    const semanticCalls: SemanticCall[] = [];
    const rerankerCalls: Array<Record<string, unknown>> = [];
    const metadataQueries: Array<string | null> = [];
    const reranker = scenario.reranker ? buildReranker(scenario.reranker, rerankerCalls, ctx) : null;
    const input = buildInput(scenario, scenario.withSignal ? controller.signal : undefined);
    const semanticQuery = input.semanticQuery;
    const host: SearchExecutionHost = {
        searchQuerySupport: buildSupport(reranker, scenario, counters),
        semanticSearch: async (request) => {
            const pass: PassName = request.retrievalMode === "lexical" && request.lexicalMatchMode === "all_terms"
                ? "must_lane"
                : request.query === semanticQuery ? "primary" : "expanded";
            const call: SemanticCall = {
                n: semanticCalls.length + 1,
                pass,
                query: request.query,
                topK: request.topK,
                retrievalMode: request.retrievalMode,
                ...(request.lexicalMatchMode ? { lexicalMatchMode: request.lexicalMatchMode } : {}),
                ...(request.lexicalFallbackTerms ? { lexicalFallbackTerms: request.lexicalFallbackTerms } : {}),
                hasFilter: request.filter !== undefined,
            };
            semanticCalls.push(call);
            return scenario.semantic(call, ctx).slice(0, request.topK);
        },
        reranker,
        ...(scenario.metadata ? {
            symbolMetadataSearch: async (query?: string) => {
                metadataQueries.push(query ?? null);
                return scenario.metadata!(query);
            },
        } : {}),
        ...(scenario.definitions ? {
            definitionMetadata: (result: SearchResultLike) => ({
                name: scenario.definitions![result.relativePath] ?? "formatCurrency",
                qualifiedName: "",
                file: result.relativePath,
                kind: "function",
            }),
        } : {}),
        ...(scenario.projection ? {
            buildRerankDocument: async (_query: string, result: SearchResultLike) => scenario.projection!(result as Row),
        } : {}),
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: (error) => (scenario.embeddingDiagnostic?.(error) ?? null) as never,
        classifyVectorBackendError: (error) => (scenario.vectorDiagnostic?.(error) ?? null) as never,
        measureSearchPhase: async (_phase, run) => run(),
    };
    const diagnostics = buildDiagnostics(input.limit);
    let outcomeRecord: Record<string, unknown>;
    try {
        outcomeRecord = summarizeOutcome(await runSearchExecution(input, host, diagnostics));
    } catch (error) {
        outcomeRecord = { kind: "threw", message: error instanceof Error ? error.message : String(error) };
    }
    return {
        scenario: scenario.name,
        query: scenario.query,
        limit: input.limit,
        altTerms: scenario.altTerms ?? null,
        flags: scenario.flags ?? null,
        reservationPolicy: scenario.reservationPolicy ?? null,
        rerankQuery: input.rerankQuery,
        semanticCalls,
        rerankerCalls,
        metadataQueries,
        stubCalls: counters,
        outcome: outcomeRecord,
        searchDiagnostics: diagnostics,
    };
}

// ---------------------------------------------------------------------------
// Snapshot serializer: stable key order, compact leaf containers
// ---------------------------------------------------------------------------

function isLeafContainer(value: object): boolean {
    const entries = Array.isArray(value) ? value : Object.values(value);
    return entries.every((entry) => entry === null || typeof entry !== "object"
        || (Array.isArray(entry) && entry.every((item) => item === null || typeof item !== "object")));
}

function render(value: unknown, depth: number): string {
    if (value === undefined) return "null";
    const compact = JSON.stringify(value);
    if (value === null || typeof value !== "object") return compact;
    if (compact.length <= 100 || (isLeafContainer(value) && compact.length <= 400)) return compact;
    const pad = "  ".repeat(depth + 1);
    const close = "  ".repeat(depth);
    if (Array.isArray(value)) {
        return `[\n${value.map((item) => `${pad}${render(item, depth + 1)}`).join(",\n")}\n${close}]`;
    }
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    return `{\n${entries.map(([key, entry]) => `${pad}${JSON.stringify(key)}: ${render(entry, depth + 1)}`).join(",\n")}\n${close}}`;
}

const serialize = (value: unknown): string => `${render(value, 0)}\n`;

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const outcomeOf = (rec: Rec) => rec.outcome as Rec;
const resultsOf = (rec: Rec) => (outcomeOf(rec).results ?? []) as Array<Rec & { relativePath: string; retrievalPasses: string[] }>;
const passesOf = (rec: Rec) => (outcomeOf(rec).passesUsed ?? []) as string[];
const traceStages = (rec: Rec) => ((outcomeOf(rec).candidateSurvival as Rec | undefined)?.stages ?? []) as Array<{ stage: string; passId?: string; candidates: Array<Rec> }>;
const hasTracePass = (rec: Rec, passId: string) => traceStages(rec).some((s) => s.stage === "mcp_pass" && s.passId === passId);
const calls = (rec: Rec) => rec.semanticCalls as SemanticCall[];

const backend = (primary: Row[], expanded: Row[] = primary) => (call: SemanticCall): Row[] =>
    call.pass === "expanded" ? expanded : primary;

const projectionOf = (result: Row): SearchRerankProjectionResult => {
    const candidateRole = resolveSearchCandidateRole({ relativePath: result.relativePath, language: result.language });
    const document = JSON.stringify({ path: result.relativePath, role: candidateRole, source: result.content });
    return {
        ok: true,
        document,
        utf8Bytes: Buffer.byteLength(document, "utf8"),
        sha256: crypto.createHash("sha256").update(document, "utf8").digest("hex"),
        candidateRole,
        projectionIdentity: "search_rerank_document_golden",
    };
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const implPool = [
    row("src/alpha.ts", 0.9),
    row("src/beta.ts", 0.8),
    row("src/gamma.ts", 0.7),
    row("src/winner.ts", 0.6),
    row("tests/alpha.test.ts", 0.55),
];

// 80 rows; only index 70 holds both must tokens, so it is invisible until attempt 3 (topK 80).
const retryPool = pool("src", "tz_pool", 80, 0.9).map((r, i) => i === 70
    ? { ...r, relativePath: "src/tz_owner.ts", symbolLabel: "function tzOwner()", content: "export function tzOwner(tzinfo) { return tzinfo ?? None; }" }
    : r);

const mustLaneOwner = row("src/tz_lane_owner.ts", 0.5, {
    symbolLabel: "function laneOwner()",
    content: "export function laneOwner() { return tzinfo ?? None; }",
});
const mustPrimary = [row("src/service.ts", 0.9, { content: "export function service() { return 1; }" })];

const reservationBackend = (primary: Row[], expanded: Row[]) => (call: SemanticCall): Row[] =>
    call.pass === "expanded" ? expanded : primary;
const reservationPrimary = Array.from({ length: 60 }, (_, i) => row(`src/primary_${i}.ts`, 0.1 + i * 1e-6));
const reservationExpanded = Array.from({ length: 80 }, (_, i) => row(`src/expansion_${i}.ts`, 0.9 - i * 1e-6));
const reservationBase = {
    query: Q_NEUTRAL,
    altTerms: ["destroy", "unmount", "teardown", "dispose"],
    semantic: reservationBackend(reservationPrimary, reservationExpanded),
};
const primaryCount = (rec: Rec) => resultsOf(rec).filter((r) => r.retrievalPasses.includes("primary")).length;
const expandedOnlyCount = (rec: Rec) => resultsOf(rec).filter((r) => !r.retrievalPasses.includes("primary")).length;

const effectsPrimary = [row("src/noise.ts", 0.95), row("src/format.ts", 0.9)];
const effectsExpanded = [row("src/dispose_helper.ts", 0.8, { symbolLabel: "function disposeHelper()" })];
const effectsRecovered = row("src/effects.ts", 0.1, { symbolKind: "function", symbolLabel: "function commitHookEffectListUnmount" });
const effectsMetadata = (query?: string): Row[] => query?.includes("commitHookEffectListUnmount") ? [effectsRecovered] : [];
const effectsDefinitions = { "src/effects.ts": "commitHookEffectListUnmount" };
const effectsAltBase = {
    query: Q_NEUTRAL,
    altTerms: ["commitHookEffectListUnmount", "destroy"],
    semantic: backend(effectsPrimary, effectsExpanded),
    reranker: { provider: "voyage" } as RerankerSpec,
    metadata: effectsMetadata,
    definitions: effectsDefinitions,
};

const defRows = [row("src/noise.ts", 0.95)];
const defRecovered = row("src/actions.ts", 0.1, { symbolKind: "function", symbolLabel: "function tradeWorkflow" });
const defBase = {
    query: Q_DEF,
    semantic: backend(defRows),
    reranker: { provider: "voyage" } as RerankerSpec,
    metadata: () => [defRecovered],
    definitions: { "src/actions.ts": "tradeWorkflow" },
};

const lateOnDiagnostics: RerankExecutionDiagnostics = {
    attempts: 1,
    retries: 0,
    timeouts: 0,
    queueWaitMs: 3,
    effectiveScoreDeadlineMs: 500,
    effectiveStageDeadlineMs: 600,
    observedWallMs: 42,
};

const scenarios: Scenario[] = [
    // 1. retry attempts and fallback --------------------------------------------------------
    {
        name: "retry_must_three_attempts",
        query: Q_MUST,
        semantic: (call) => call.pass === "must_lane" ? [] : retryPool,
        expect: (rec) => {
            assert.equal(outcomeOf(rec).attemptsUsed, 3);
            assert.deepEqual(calls(rec).filter((c) => c.pass === "primary").map((c) => c.topK), [32, 64, 80]);
            assert.deepEqual(resultsOf(rec).map((r) => r.relativePath), ["src/tz_owner.ts"]);
        },
    },
    {
        name: "fallback_primary_failed_expanded_runs",
        query: Q_IMPL,
        semantic: (call) => {
            if (call.pass === "primary") throw new Error("primary backend hiccup");
            return implPool.slice(0, 3);
        },
        expect: (rec) => {
            assert.equal((outcomeOf(rec).semanticExpansion as Rec).reason, "primary_failed_fallback");
            assert.deepEqual(passesOf(rec), ["expanded"]);
            assert.equal(outcomeOf(rec).searchWarnings instanceof Array && (outcomeOf(rec).searchWarnings as string[]).length > 0, true);
        },
    },
    {
        name: "fallback_lexical_files_pass",
        query: Q_DIRTY,
        semantic: backend([row("src/clean.ts", 0.9)]),
        tracked: [row("src/clean.ts", 0.4), row("src/lexical_only.ts", 0.3)],
        expect: (rec) => {
            assert.ok(passesOf(rec).includes("lexical_files"));
            assert.ok(hasTracePass(rec, "attempt:1/lexical_files"));
            assert.ok(calls(rec).every((c) => c.lexicalFallbackTerms !== undefined && c.lexicalFallbackTerms.length > 0));
            assert.ok(resultsOf(rec).some((r) => r.relativePath === "src/lexical_only.ts"));
        },
    },
    {
        name: "fallback_all_passes_failed_embedding_provider",
        query: Q_IMPL,
        semantic: () => { throw new Error("embedding provider down"); },
        embeddingDiagnostic: () => ({ code: "golden_embedding_unavailable", retryable: true, message: "embedding provider down" }),
        expect: (rec) => assert.equal(outcomeOf(rec).kind, "embedding_provider_unavailable"),
    },
    {
        name: "fallback_all_passes_failed_vector_backend",
        query: Q_IMPL,
        semantic: () => { throw new Error("vector backend down"); },
        vectorDiagnostic: () => ({
            code: "VECTOR_BACKEND_UNREACHABLE",
            message: "vector backend down",
            hints: {
                backend: {
                    code: "VECTOR_BACKEND_UNREACHABLE",
                    provider: "unknown",
                    retryable: true,
                    nextSteps: ["Confirm the vector backend is running and reachable."],
                },
            },
        }),
        expect: (rec) => assert.equal(outcomeOf(rec).kind, "vector_backend_unavailable"),
    },
    {
        name: "fallback_all_semantic_passes_failed",
        query: Q_IMPL,
        semantic: () => { throw new Error("unclassified failure"); },
        expect: (rec) => assert.equal(outcomeOf(rec).kind, "all_semantic_passes_failed"),
    },

    // 2. must lane --------------------------------------------------------------------------
    {
        name: "must_lane_results",
        query: Q_MUST_TWO,
        limit: 10,
        resultMode: "grouped",
        rankingMode: "auto_changed_first",
        semantic: (call) => call.pass === "must_lane" ? [mustLaneOwner] : mustPrimary,
        expect: (rec) => {
            assert.ok(passesOf(rec).includes("must_lane"));
            assert.ok(hasTracePass(rec, "attempt:1/must_lane"));
            const owner = resultsOf(rec).find((r) => r.relativePath === "src/tz_lane_owner.ts");
            assert.deepEqual(owner?.retrievalPasses, ["must_lane"]);
            assert.ok(calls(rec).some((c) => c.pass === "must_lane" && c.query === "tzinfo None" && c.topK === 80));
        },
    },
    {
        name: "must_lane_unsupported",
        query: Q_MUST_TWO,
        limit: 10,
        resultMode: "grouped",
        rankingMode: "auto_changed_first",
        semantic: (call) => {
            if (call.pass === "must_lane") throw new LexicalRetrievalModeUnsupportedError("conjunctive lexical retrieval is not supported");
            return mustPrimary;
        },
        expect: (rec) => {
            assert.ok(!passesOf(rec).includes("must_lane"));
            assert.ok(calls(rec).some((c) => c.pass === "must_lane"));
        },
    },
    {
        name: "must_lane_failed",
        query: Q_MUST_TWO,
        limit: 10,
        resultMode: "grouped",
        rankingMode: "auto_changed_first",
        semantic: (call) => {
            if (call.pass === "must_lane") throw new Error("mock must lane failure");
            return mustPrimary;
        },
        expect: (rec) => {
            assert.ok(!passesOf(rec).includes("must_lane"));
            assert.ok(calls(rec).some((c) => c.pass === "must_lane"));
        },
    },

    // 3. dirty-file overlay -----------------------------------------------------------------
    {
        name: "dirty_overlay",
        query: Q_DIRTY,
        limit: 10,
        resultMode: "grouped",
        rankingMode: "auto_changed_first",
        changedFiles: ["src/dirty.ts"],
        dirtyFilesNotFreshened: true,
        semantic: backend([row("src/clean.ts", 0.9, { symbolLabel: "function naiveUtcClean()" })]),
        dirty: [row("src/dirty.ts", 0.9, { symbolLabel: "function naiveUtc()" })],
        expect: (rec) => {
            assert.ok(passesOf(rec).includes("dirty_overlay"));
            assert.ok(hasTracePass(rec, "attempt:1/dirty_overlay"));
            assert.deepEqual(resultsOf(rec).find((r) => r.relativePath === "src/dirty.ts")?.retrievalPasses, ["dirty_overlay"]);
            assert.equal((rec.stubCalls as Rec).dirtyOverlayCalls, 1);
        },
    },

    // 4. live_path pass ---------------------------------------------------------------------
    {
        name: "live_path",
        query: Q_PATH,
        changedFiles: ["src/dirty.ts"],
        semantic: backend([row("src/dirty.ts", 0.9, { symbolLabel: "function dirty()" })]),
        live: [row("src/dirty.ts", 0.5, { startLine: 10, endLine: 14, symbolLabel: "function liveDirty()" })],
        expect: (rec) => {
            assert.ok(passesOf(rec).includes("live_path"));
            assert.ok(hasTracePass(rec, "attempt:1/live_path"));
            assert.equal((outcomeOf(rec).rankingProvenance as Rec).livePathSupplementUsed, true);
            assert.equal((rec.stubCalls as Rec).livePathCalls, 1);
        },
    },

    // 5. alt_terms on and off ---------------------------------------------------------------
    {
        name: "alt_terms_on_defaults",
        ...effectsAltBase,
        expect: (rec) => {
            assert.ok(passesOf(rec).includes("expanded"));
            assert.ok(hasTracePass(rec, "attempt:1/symbol_metadata_bm25_alt"));
            assert.deepEqual(rec.metadataQueries, [null, "commitHookEffectListUnmount destroy"]);
            assert.equal((outcomeOf(rec).semanticExpansion as Rec).reason, "caller_alt_terms");
            assert.equal(outcomeOf(rec).orderAuthority, "definition_fusion_order");
            assert.equal(resultsOf(rec)[0]?.relativePath, "src/effects.ts");
            assert.match(String(rec.rerankQuery), /commitHookEffectListUnmount/);
        },
    },
    {
        name: "alt_terms_off",
        ...effectsAltBase,
        altTerms: undefined,
        expect: (rec) => {
            assert.ok(!hasTracePass(rec, "attempt:1/symbol_metadata_bm25_alt"));
            assert.ok(!calls(rec).some((c) => c.pass === "expanded" && /commitHook/.test(c.query)));
            assert.deepEqual(rec.metadataQueries, [null]);
            assert.notEqual((outcomeOf(rec).semanticExpansion as Rec).reason, "caller_alt_terms");
            assert.doesNotMatch(String(rec.rerankQuery), /commitHookEffectListUnmount/);
        },
    },
    {
        name: "alt_terms_on_definition_alt_terms_false",
        ...effectsAltBase,
        flags: { definition_alt_terms: false },
        expect: (rec) => {
            assert.ok(passesOf(rec).includes("expanded"));
            assert.ok(!hasTracePass(rec, "attempt:1/symbol_metadata_bm25_alt"));
            assert.deepEqual(rec.metadataQueries, [null]);
            assert.match(String(rec.rerankQuery), /commitHookEffectListUnmount/);
        },
    },
    {
        name: "alt_terms_on_rerank_alt_terms_false",
        ...effectsAltBase,
        flags: { rerank_alt_terms: false },
        expect: (rec) => {
            assert.ok(passesOf(rec).includes("expanded"));
            assert.ok(hasTracePass(rec, "attempt:1/symbol_metadata_bm25_alt"));
            assert.doesNotMatch(String(rec.rerankQuery), /commitHookEffectListUnmount/);
            assert.doesNotMatch(JSON.stringify(rec.rerankerCalls), /commitHookEffectListUnmount/);
        },
    },
    {
        name: "alt_terms_over_cap_dropped_terms_traced",
        ...effectsAltBase,
        altTerms: ["commitHookEffectListUnmount", "destroy", "teardown", "dispose", "release", "cleanup"],
        expect: (rec) => {
            const expansion = outcomeOf(rec).semanticExpansion as Rec;
            assert.deepEqual(expansion.termsDropped, ["release", "cleanup"]);
            assert.deepEqual(expansion.termsEmitted, ["commitHookEffectListUnmount", "destroy", "teardown", "dispose"]);
        },
    },

    // 6. reservation_policy cap55 / cap64 / off ----------------------------------------------
    {
        name: "reservation_default_small_budget",
        ...reservationBase,
        limit: 3,
        expect: (rec) => {
            assert.equal(outcomeOf(rec).candidateLimit, 32);
            assert.equal((outcomeOf(rec).semanticExpansion as Rec).reason, "caller_alt_terms");
            assert.ok(expandedOnlyCount(rec) > 0 && primaryCount(rec) > 0);
        },
    },
    {
        name: "reservation_cap55",
        ...reservationBase,
        limit: 10,
        reservationPolicy: "cap55",
        expect: (rec) => {
            assert.equal(outcomeOf(rec).candidateLimit, 80);
            assert.equal(resultsOf(rec).length, 80);
            assert.equal(expandedOnlyCount(rec), 25);
        },
    },
    {
        name: "reservation_cap64",
        ...reservationBase,
        limit: 10,
        reservationPolicy: "cap64",
        expect: (rec) => {
            assert.equal(outcomeOf(rec).candidateLimit, 80);
            assert.equal(resultsOf(rec).length, 80);
            assert.equal(expandedOnlyCount(rec), 20);
        },
    },
    {
        name: "reservation_off",
        ...reservationBase,
        limit: 10,
        reservationPolicy: "off",
        expect: (rec) => {
            assert.equal(outcomeOf(rec).candidateLimit, 80);
            assert.equal(resultsOf(rec).length, 80);
            assert.equal(expandedOnlyCount(rec), 40);
            assert.equal(primaryCount(rec), 40);
        },
    },

    // 7. served previous generation (stale publication) ---------------------------------------
    {
        name: "stale_publication_hybrid_with_reranker",
        query: Q_IMPL,
        freshnessMode: "served_previous_generation",
        changedFiles: ["src/dirty.ts"],
        dirtyFilesNotFreshened: true,
        semantic: backend(implPool.slice(0, 3)),
        reranker: { provider: "voyage" },
        dirty: [row("src/live_must_not_appear.ts", 0.99)],
        tracked: [row("src/live_must_not_appear.ts", 0.99)],
        live: [row("src/live_must_not_appear.ts", 0.99)],
        expect: (rec) => {
            assert.deepEqual(rec.stubCalls, { dirtyOverlayCalls: 0, trackedLexicalCalls: 0, livePathCalls: 0 });
            assert.deepEqual(rec.rerankerCalls, []);
            assert.equal(outcomeOf(rec).orderAuthority, "retrieval_order");
            assert.equal(outcomeOf(rec).rerankerAttempted, false);
            assert.ok(!resultsOf(rec).some((r) => r.relativePath === "src/live_must_not_appear.ts"));
        },
    },
    {
        name: "stale_publication_path_query_skips_live_path",
        query: Q_PATH,
        freshnessMode: "served_previous_generation",
        changedFiles: ["src/dirty.ts"],
        semantic: backend([row("src/dirty.ts", 0.9)]),
        live: [row("src/live_must_not_appear.ts", 0.99)],
        expect: (rec) => {
            assert.deepEqual(rec.stubCalls, { dirtyOverlayCalls: 0, trackedLexicalCalls: 0, livePathCalls: 0 });
            assert.ok(!passesOf(rec).includes("live_path"));
        },
    },

    // 8. aborted request ----------------------------------------------------------------------
    {
        name: "abort_after_retrieval",
        query: Q_IMPL,
        withSignal: true,
        semantic: (_call, ctx) => {
            ctx.abort(new Error("cancel retrieval"));
            return implPool.slice(0, 3);
        },
        reranker: { provider: "voyage" },
        expect: (rec) => {
            assert.deepEqual(outcomeOf(rec), { kind: "threw", message: "cancel retrieval" });
            assert.deepEqual(rec.rerankerCalls, []);
        },
    },
    {
        name: "abort_inside_reranker",
        query: Q_IMPL,
        withSignal: true,
        semantic: backend(implPool.slice(0, 3)),
        reranker: { provider: "voyage", behavior: "abort_then_throw" },
        expect: (rec) => {
            assert.deepEqual(outcomeOf(rec), { kind: "threw", message: "cancel reranking" });
            assert.equal((rec.rerankerCalls as unknown[]).length, 1);
        },
    },

    // 9. reranker success, operational failure, none -------------------------------------------
    {
        name: "reranker_success_reorders",
        query: Q_IMPL,
        semantic: backend(implPool),
        reranker: { provider: "voyage" },
        expect: (rec) => {
            assert.equal(outcomeOf(rec).orderAuthority, "reranker_order");
            assert.equal(outcomeOf(rec).rerankerApplied, true);
            assert.equal(resultsOf(rec)[0]?.relativePath, "src/winner.ts");
        },
    },
    {
        name: "reranker_lateon_applied",
        query: Q_IMPL,
        semantic: backend(implPool),
        reranker: { provider: "lateon", diagnostics: lateOnDiagnostics },
        expect: (rec) => {
            assert.equal(outcomeOf(rec).rerankerOperationalReason, "lateon_applied");
            assert.deepEqual(outcomeOf(rec).rerankerExecutionDiagnostics, lateOnDiagnostics);
        },
    },
    {
        name: "reranker_lateon_operational_failure",
        query: Q_IMPL,
        semantic: backend(implPool),
        reranker: {
            provider: "lateon",
            behavior: "throw",
            error: Object.assign(new Error("lateon execution exceeded its deadline"), { reason: "lateon_execution_timeout" }),
            diagnostics: { ...lateOnDiagnostics, timeouts: 1 },
        },
        expect: (rec) => {
            assert.equal(outcomeOf(rec).rerankerFailurePhase, "api_call");
            assert.equal(outcomeOf(rec).rerankerOperationalReason, "lateon_execution_timeout");
            assert.equal(outcomeOf(rec).orderAuthority, "retrieval_order");
            assert.equal(outcomeOf(rec).rerankerApplied, false);
        },
    },
    {
        name: "reranker_voyage_request_error",
        query: Q_IMPL,
        semantic: backend(implPool),
        reranker: {
            provider: "voyage",
            behavior: "throw",
            error: new RerankerRequestError("timeout", null, 3, "rerank request timed out"),
        },
        expect: (rec) => {
            assert.equal(outcomeOf(rec).rerankerFailurePhase, "api_call");
            assert.equal(outcomeOf(rec).rerankerFailureKind, "timeout");
            assert.equal(outcomeOf(rec).rerankerApplied, false);
        },
    },
    {
        name: "reranker_malformed_result",
        query: Q_IMPL,
        semantic: backend(implPool),
        reranker: { provider: "voyage", behavior: "malformed" },
        expect: (rec) => {
            assert.equal(outcomeOf(rec).rerankerFailurePhase, "parse_results");
            assert.equal(outcomeOf(rec).orderAuthority, "retrieval_order");
        },
    },
    {
        name: "reranker_document_projection_partial_failure",
        query: Q_IMPL,
        semantic: backend(implPool),
        reranker: { provider: "voyage" },
        projection: (result) => result.relativePath === "src/gamma.ts"
            ? { ok: false, candidateId: "projection-failed-gamma", reason: "source_unavailable" }
            : projectionOf(result),
        expect: (rec) => {
            const projection = outcomeOf(rec).rerankerProjection as Rec;
            assert.equal(projection.skippedCandidates, 1);
            assert.ok(((outcomeOf(rec).candidateSurvival as Rec).removals as Rec[]).some((r) => r.reason === "reranker_document_projection_failed"));
        },
    },
    {
        name: "reranker_none_retrieval_order",
        query: Q_IMPL,
        semantic: backend(implPool),
        expect: (rec) => {
            assert.equal(outcomeOf(rec).orderAuthority, "retrieval_order");
            assert.equal(outcomeOf(rec).rerankerAttempted, false);
            assert.deepEqual(rec.rerankerCalls, []);
        },
    },

    // 10. definition discovery on and off ------------------------------------------------------
    {
        name: "definition_discovery_on",
        ...defBase,
        expect: (rec) => {
            assert.equal(outcomeOf(rec).orderAuthority, "definition_fusion_order");
            assert.equal(resultsOf(rec)[0]?.relativePath, "src/actions.ts");
            assert.ok(resultsOf(rec)[0]?.retrievalPasses.includes("symbol_metadata_bm25"));
            assert.deepEqual(rec.metadataQueries, [null]);
        },
    },
    {
        name: "definition_discovery_off",
        ...defBase,
        flags: { definition_discovery: false },
        expect: (rec) => {
            assert.equal(outcomeOf(rec).orderAuthority, "reranker_order");
            assert.deepEqual(rec.metadataQueries, []);
            assert.ok(!resultsOf(rec).some((r) => r.relativePath === "src/actions.ts"));
        },
    },
];

for (const scenario of scenarios) {
    test(`golden: ${scenario.name}`, async (t) => {
        const rec = await execute(scenario);
        scenario.expect(rec);
        t.assert.snapshot(rec, { serializers: [serialize] });
    });
}

test("golden: scenario names are unique", () => {
    assert.equal(new Set(scenarios.map((s) => s.name)).size, scenarios.length);
});
