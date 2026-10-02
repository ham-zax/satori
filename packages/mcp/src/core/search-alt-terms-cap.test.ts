import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityResolver } from "./capabilities.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchExecutionHost,
    type SearchExecutionInput,
} from "./search-execution.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { SEARCH_ALT_TERMS_MAX } from "./search-constants.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { buildSearchRerankQuery, SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from "./search-rerank-query.js";
import { resolveSearchPolicy } from "./search-policy.js";

function buildSupport(): SearchQuerySupport {
    return new SearchQuerySupport({
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
            hasReranker: () => false,
            getDefaultRerankEnabled: () => false,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 25,
    });
}

function buildInput(alt_terms: string[] | string): SearchExecutionInput {
    const query = "where is cleanup executed";
    const parsedOperators = parseSearchOperators(query);
    const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    return {
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: "default",
        resultMode: "raw",
        limit: 3,
        debugMode: "full",
        semanticQuery: parsedOperators.semanticQuery,
        answerFocus,
        rerankQuery: buildSearchRerankQuery({
            semanticQuery: parsedOperators.semanticQuery,
            answerFocus,
        }),
        rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        parsedOperators,
        queryPlan,
        exactRegistryEligible: false,
        exactRegistryFallbackForTrackedLexical: false,
        freshnessMode: "synced",
        observedChangedFilesState: { available: false, files: new Set() },
        dirtyFilesNotFreshened: false,
        retrievalPolicy: resolveSearchPolicy({
            resultLimit: 3,
            hasMustOperators: false,
        }),
        alt_terms,
    };
}

function buildDiagnostics(): SearchDiagnostics {
    return {
        queryLength: 0,
        limitRequested: 3,
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

const host: SearchExecutionHost = {
    searchQuerySupport: buildSupport(),
    semanticSearch: async () => [],
    reranker: null,
    shouldForceSearchPassFailure: () => false,
    classifyEmbeddingProviderError: () => null,
    classifyVectorBackendError: () => null,
    measureSearchPhase: async (_phase, run) => run(),
};

test("alt_terms past the cap are recorded as termsDropped, not silently discarded", async () => {
    const outcome = await runSearchExecution(
        buildInput(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']),
        host,
        buildDiagnostics(),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const expansion = outcome.semanticExpansion;
    assert.equal(expansion.reason, "caller_alt_terms");
    assert.deepEqual(
        expansion.termsEmitted,
        ['alpha', 'beta', 'gamma', 'delta'],
        'the expanded pass must use exactly the first N terms',
    );
    assert.deepEqual(
        expansion.termsDropped,
        ['epsilon', 'zeta'],
        'terms past the cap must be reported',
    );
});

test("a request at the cap records no dropped terms", async () => {
    const outcome = await runSearchExecution(
        buildInput(['alpha', 'beta', 'gamma', 'delta']),
        host,
        buildDiagnostics(),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(outcome.semanticExpansion.termsEmitted, ['alpha', 'beta', 'gamma', 'delta']);
    assert.equal(outcome.semanticExpansion.termsDropped, undefined);
});

test("the string form is capped the same way and reports the same overflow", async () => {
    const overCap = await runSearchExecution(
        buildInput('alpha beta gamma delta epsilon zeta'),
        host,
        buildDiagnostics(),
    );
    assert.equal(overCap.kind, "ok");
    if (overCap.kind !== "ok") return;
    assert.deepEqual(overCap.semanticExpansion.termsEmitted, ['alpha', 'beta', 'gamma', 'delta']);
    assert.deepEqual(overCap.semanticExpansion.termsDropped, ['epsilon', 'zeta']);

    const atCap = await runSearchExecution(
        buildInput('alpha beta gamma delta'),
        host,
        buildDiagnostics(),
    );
    assert.equal(atCap.kind, "ok");
    if (atCap.kind !== "ok") return;
    assert.deepEqual(atCap.semanticExpansion.termsEmitted, ['alpha', 'beta', 'gamma', 'delta']);
    assert.equal(atCap.semanticExpansion.termsDropped, undefined);
});

test("the runtime cap and the exported constant are the same number", async () => {
    const many = Array.from({ length: SEARCH_ALT_TERMS_MAX + 3 }, (_, i) => `t${i}`);
    const outcome = await runSearchExecution(buildInput(many), host, buildDiagnostics());
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.semanticExpansion.termsEmitted?.length, SEARCH_ALT_TERMS_MAX);
    assert.equal(outcome.semanticExpansion.termsDropped?.length, 3);
});
