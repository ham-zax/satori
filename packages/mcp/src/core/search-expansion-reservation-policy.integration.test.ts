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

function buildInput(reservationPolicy?: string): SearchExecutionInput {
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
        ...(reservationPolicy !== undefined ? { reservation_policy: reservationPolicy } : {}),
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
        rerankerTimeouts: 0,
        rerankerRetries: 0,
        candidatesWithSemanticEvidence: 0,
        candidatesWithLexicalEvidence: 0,
        candidatesWithCurrentSourceEvidence: 0,
        semanticExpansionAttempted: false,
    };
}

async function runWithPolicy(reservationPolicy?: string) {
    const passes = syntheticPasses();
    const observedQueries: string[] = [];
    const host: SearchExecutionHost = {
        searchQuerySupport: buildSupport(),
        semanticSearch: async (request) => {
            observedQueries.push(request.query);
            return (observedQueries.length === 1 ? passes.primary : passes.expanded).slice(0, request.topK);
        },
        reranker: null,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
    const outcome = await runSearchExecution(buildInput(reservationPolicy), host, buildDiagnostics());
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    assert.equal(outcome.semanticExpansion.reason, "caller_alt_terms");
    assert.ok(observedQueries.length >= 2, `expected two passes, saw ${observedQueries.length}`);
    return outcome.scored;
}

const primaryOnlyPaths = (scored: Parameters<typeof isPrimarySearchCandidate>[0][]) =>
    scored.filter((entry) => isPrimarySearchCandidate(entry))
        .map((entry) => entry.result.relativePath)
        .filter((p) => p.startsWith("src/primary_"));

test("default and cap55 admit the same bounded small-budget pool", async () => {
    const def = await runWithPolicy(undefined);
    const cap55 = await runWithPolicy("cap55");
    assert.equal(def.length, 32);
    assert.equal(primaryOnlyPaths(def).length, 22);
    assert.equal(primaryOnlyPaths(cap55).length, 22);
    assert.deepEqual(def.map((e) => e.result.relativePath), cap55.map((e) => e.result.relativePath));
});

test("cap64 preserves its wider primary share without excluding all expansion hits", async () => {
    const scored = await runWithPolicy("cap64");
    assert.equal(scored.length, 32);
    assert.equal(primaryOnlyPaths(scored).length, 25);
    assert.equal(scored.filter((c) => !isPrimarySearchCandidate(c)).length, 7);
});

test("off disables reservation while preserving the same total budget", async () => {
    const scored = await runWithPolicy("off");
    assert.equal(scored.length, 32);
    assert.ok(scored.some((c) => !isPrimarySearchCandidate(c)));
});
