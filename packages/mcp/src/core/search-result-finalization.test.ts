import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityResolver } from "./capabilities.js";
import { parseSearchOperators, buildSearchQueryPlan } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { buildSearchRerankQuery, SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from "./search-rerank-query.js";
import { resolveSearchPolicy } from "./search-policy.js";
import { runSearchExecution, type SearchDiagnostics } from "./search-execution.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { finalizeSearchResults, type SearchResultFinalizationHost } from "./search-result-finalization.js";
import { SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES } from "./search-constants.js";
import { WARNING_CODES } from "./warnings.js";

async function finalizeRaw(chunkBytes: number, count: number) {
    const parsedOperators = parseSearchOperators("where is the billing implementation");
    const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    const searchQuerySupport = new SearchQuerySupport({
        normalizeSearchPath: (value) => value,
        hasPathSegment: () => false,
        isGeneratedPath: () => false,
        isTestPath: () => false,
        isFixturePath: () => false,
        isDocPath: () => false,
        getContextActiveIgnorePatterns: () => [],
        getContextTrackedRelativePaths: () => [],
        classifyPathCategory: () => "core",
        shouldIncludeCategoryInScope: () => true,
        capabilities: { hasReranker: () => false, getDefaultRerankEnabled: () => false } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 1000,
    });
    const candidates = Array.from({ length: count }, (_, index) => ({
        relativePath: `src/billing${index}.ts`,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content: `export function billing${index}() { return "${"x".repeat(chunkBytes)}"; }`,
        score: 1 - index / 1000,
        symbolLabel: `function billing${index}()`,
    }));
    const execution = await runSearchExecution({
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: "default",
        resultMode: "raw",
        limit: count,
        debugMode: "none",
        semanticQuery: parsedOperators.semanticQuery,
        answerFocus,
        rerankQuery: buildSearchRerankQuery({ semanticQuery: parsedOperators.semanticQuery, answerFocus }),
        rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        parsedOperators,
        queryPlan,
        exactRegistryEligible: false,
        exactRegistryFallbackForTrackedLexical: false,
        freshnessMode: "synced",
        observedChangedFilesState: { available: false, files: new Set() },
        dirtyFilesNotFreshened: false,
        retrievalPolicy: resolveSearchPolicy({ resultLimit: count, hasMustOperators: false }),
        flags: { path_demotion: false },
    }, {
        searchQuerySupport,
        semanticSearch: async () => candidates,
        reranker: null,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    }, {} as SearchDiagnostics);
    assert.equal(execution.kind, "ok");
    return finalizeSearchResults({
        absolutePath: "/repo",
        effectiveRoot: "/repo",
        query: "where is the billing implementation",
        scope: "runtime",
        groupBy: "symbol",
        resultMode: "raw",
        limit: count,
        disclosureLimit: count,
        includeResultIndex: false,
        rerankerResultLimit: count,
        debugMode: "none",
        rankingMode: "default",
        freshnessDecision: { mode: "synced" } as never,
        freshnessSummary: {} as never,
        partialIndexSearchWarnings: [],
        phaseTimings: {} as never,
        readiness: {} as never,
        parsedOperators,
        queryPlan,
        maxAttempts: 1,
        execution,
        navigationAuthority: "unavailable",
    }, {
        searchQuerySupport,
        buildGeneratedArtifactsVerificationHint: () => undefined,
        now: () => Date.now(),
    } as unknown as SearchResultFinalizationHost);
}

test("raw results drop lowest-ranked chunks to fit the response byte budget and disclose it", async () => {
    const finalized = await finalizeRaw(2048, 60);
    assert.equal(finalized.kind, "ok");
    const envelope = finalized.envelope as { results: Array<{ file: string }>; warnings?: Array<{ code: string }> };
    assert.ok(Buffer.byteLength(JSON.stringify(envelope), "utf8") <= SEARCH_GROUPED_RESPONSE_MAX_UTF8_BYTES);
    assert.ok(envelope.results.length > 1 && envelope.results.length < 60);
    // Kept chunks are a rank-order prefix.
    assert.deepEqual(
        envelope.results.map((result) => result.file),
        envelope.results.map((_, index) => `src/billing${index}.ts`),
    );
    assert.ok(envelope.warnings?.some((warning) => warning.code === WARNING_CODES.SEARCH_RAW_RESULTS_TRIMMED_TO_BYTE_BUDGET));

    const small = await finalizeRaw(16, 5);
    const smallEnvelope = small.envelope as { results: unknown[]; warnings?: Array<{ code: string }> };
    assert.equal(smallEnvelope.results.length, 5);
    assert.ok(!smallEnvelope.warnings?.some((warning) => warning.code === WARNING_CODES.SEARCH_RAW_RESULTS_TRIMMED_TO_BYTE_BUDGET));
});
