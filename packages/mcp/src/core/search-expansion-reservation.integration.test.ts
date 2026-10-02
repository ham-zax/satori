import assert from "node:assert/strict";
import test from "node:test";
import type { SemanticSearchResult } from "@satori-code/core";
import type { CapabilityResolver } from "./capabilities.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchExecutionHost,
    type SearchExecutionInput,
} from "./search-execution.js";
import { isPrimarySearchCandidate } from "./search-expansion-reservation.js";
import { SEARCH_MAX_CANDIDATES } from "./search-constants.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { buildSearchRerankQuery, SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from "./search-rerank-query.js";
import { resolveSearchPolicy } from "./search-policy.js";

type PassResults = {
    primary: SemanticSearchResult[];
    expanded: SemanticSearchResult[];
};

function fixtureResult(
    candidateId: string,
    relativePath: string,
    score: number,
): SemanticSearchResult {
    return {
        candidateId,
        relativePath,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content: "export function zzimpl() { return 1; }",
        score,
        symbolLabel: "function zzimpl()",
    };
}

/**
 * 60 primary candidates and 80 candidates that only the expansion pass finds.
 * The expansion results carry strictly higher scores, so a naive score-ordered
 * truncation would fill the whole budget with expansion candidates and drop
 * every primary one.
 */
function syntheticPasses(): PassResults {
    return {
        primary: Array.from({ length: 60 }, (_, i) =>
            fixtureResult(`p${i}`, `src/primary_${i}.ts`, 0.1 + i * 1e-6),
        ),
        expanded: Array.from({ length: 80 }, (_, i) =>
            fixtureResult(`e${i}`, `src/expansion_${i}.ts`, 0.9 - i * 1e-6),
        ),
    };
}

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

function buildInput(): SearchExecutionInput {
    const query = 'alt_terms is supplied by the caller for a lifecycle question';
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
        alt_terms: ['destroy', 'unmount', 'teardown', 'dispose'],
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

test("a novel caller-expansion hit survives the default small budget beside primary hits", async () => {
    const passes = syntheticPasses();
    const observedQueries: string[] = [];
    const host: SearchExecutionHost = {
        searchQuerySupport: buildSupport(),
        semanticSearch: async (request) => {
            observedQueries.push(request.query);
            // Model a real backend: each pass obeys its requested topK.
            const results = observedQueries.length === 1 ? passes.primary : passes.expanded;
            return results.slice(0, request.topK);
        },
        reranker: null,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
    const outcome = await runSearchExecution(buildInput(), host, buildDiagnostics());
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.semanticExpansion.reason, "caller_alt_terms");
    assert.equal(observedQueries.length, 2);
    assert.equal(outcome.candidateLimit, 32);
    assert.equal(outcome.scored.length, 32);
    assert.equal(outcome.scored.filter(isPrimarySearchCandidate).length, 22);
    assert.equal(outcome.scored.filter((c) => !isPrimarySearchCandidate(c)).length, 10);
    assert.ok(outcome.scored.some((c) => c.result.candidateId === "e0"), "expansion-only owner must reach ranking");
    assert.ok(outcome.scored.length <= SEARCH_MAX_CANDIDATES);
    const stages = outcome.candidateSurvival?.stages ?? [];
    for (const name of ["mcp_fusion", "mcp_filtered"]) {
        const stage = stages.find((s) => s.stage === name);
        assert.ok(stage, `${name} must be recorded`);
        assert.deepEqual(stage.candidates.map((c) => c.candidateId), outcome.scored.map((c) => c.result.candidateId));
    }
});

test("the fused-pool trace excludes candidates rejected by a hard exclude operator", async () => {
    let calls = 0;
    const host: SearchExecutionHost = {
        searchQuerySupport: buildSupport(),
        semanticSearch: async () => ++calls === 1
            ? [fixtureResult("owner", "src/owner.ts", 0.9)]
            : [{ ...fixtureResult("excluded", "src/other.ts", 0.95), content: "function poison() {}" }],
        reranker: null,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
    const input = buildInput();
    input.parsedOperators.exclude = ["poison"];
    const outcome = await runSearchExecution(input, host, buildDiagnostics());
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const admitted = outcome.scored.map((c) => c.result.candidateId);
    assert.deepEqual(admitted, ["owner"]);
    const fusion = outcome.candidateSurvival?.stages.find((s) => s.stage === "mcp_fusion");
    assert.ok(fusion);
    assert.deepEqual(fusion.candidates.map((c) => c.candidateId), admitted);
});
