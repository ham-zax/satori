import assert from "node:assert/strict";
import test from "node:test";
import type { Reranker, RerankResult } from "@satori-code/core";
import type { CapabilityResolver } from "./capabilities.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchExecutionHost,
    type SearchExecutionInput,
} from "./search-execution.js";
import { resolveSearchFlags } from "./search-flags.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import { buildSearchRerankQuery, SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from "./search-rerank-query.js";
import { resolveSearchPolicy } from "./search-policy.js";

type FixtureCandidate = {
    candidateId: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    content: string;
    score: number;
    symbolLabel: string;
};

function candidate(candidateId: string, relativePath: string, score: number): FixtureCandidate {
    return {
        candidateId,
        relativePath,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content: "export function implementation() { return true; }",
        score,
        symbolLabel: "function implementation()",
    };
}

function buildSupport(reranker: Reranker | null): SearchQuerySupport {
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
            hasReranker: () => reranker !== null,
            getDefaultRerankEnabled: () => reranker !== null,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker,
        gitignoreForceReloadEveryN: 25,
    });
}

function buildInput(
    flags?: Record<string, boolean>,
    limit = 10,
): SearchExecutionInput {
    const query = "where find the relevant implementation";
    const parsedOperators = parseSearchOperators(query);
    const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan, flags).focus;
    return {
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: "default",
        resultMode: "raw",
        limit,
        debugMode: "none",
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
            resultLimit: limit,
            hasMustOperators: false,
        }),
        ...(flags ? { flags } : {}),
    };
}

function buildHost(results: FixtureCandidate[], reranker: Reranker | null): SearchExecutionHost {
    return {
        searchQuerySupport: buildSupport(reranker),
        semanticSearch: async () => results,
        reranker,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
}

function buildReranker(
    buildResults: (documents: readonly string[], candidateIds: readonly string[]) => RerankResult[],
    onCall?: (candidateIds: readonly string[]) => void,
): Reranker {
    return {
        getIdentity: () => ({ provider: "voyage", model: "test", profile: "blend" }),
        rerank: async (_query, documents, options) => {
            const candidateIds = options?.identities || [];
            onCall?.(candidateIds);
            return buildResults(documents, candidateIds);
        },
    };
}

function buildDiagnostics(): SearchDiagnostics {
    return {
        queryLength: 0,
        limitRequested: 10,
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

/**
 * A provider permutation that is NOT the exact reverse of the candidate order.
 *
 * With a perfect reversal every candidate's blend score is
 * 0.5*n + 0.5*(n-index) which is identical for all of them, so the blend sorts
 * to a no-op and the flag becomes unobservable. This permutation gives each
 * candidate a distinct blend score.
 *
 * index:      0    1    2    3
 * provider:   2    0    3    1
 * blend:    2.0  1.5  3.5  3.0   (0.5*providerRank + 0.5*(index+1))
 */
const PROVIDER_INDEX_ORDER = [2, 0, 3, 1];

function permutedResults(documents: readonly string[]): RerankResult[] {
    return documents.map((_document, position) => ({
        index: PROVIDER_INDEX_ORDER[position]!,
        relevanceScore: 1 - position / Math.max(1, documents.length),
    }));
}

const RESULTS = [
    candidate("a", "src/a.ts", 0.9),
    candidate("b", "src/b.ts", 0.8),
    candidate("c", "src/c.ts", 0.7),
    candidate("d", "src/d.ts", 0.6),
];

async function run(flags?: Record<string, boolean>) {
    const reranker = buildReranker(permutedResults);
    const outcome = await runSearchExecution(
        buildInput(flags),
        buildHost(RESULTS, reranker),
        buildDiagnostics(),
    );
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") throw new Error("expected an ok outcome");
    return outcome;
}

test("rerank_blend is off at default flags and the provider order wins", async () => {
    const outcome = await run(undefined);
    assert.equal(resolveSearchFlags().rerank_blend, false);
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.orderAuthority, "reranker_order");
    // With the blend off the provider order is published verbatim, which for
    // PROVIDER_INDEX_ORDER = [2, 0, 3, 1] is c, a, d, b.
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["c", "a", "d", "b"],
    );
});

test("rerank_blend on changes the order, so the default is not silently blending", async () => {
    const blended = await run({ rerank_blend: true });
    const baseline = await run(undefined);
    const blendedOrder = blended.scored.map((entry) => entry.result.candidateId);
    const baselineOrder = baseline.scored.map((entry) => entry.result.candidateId);
    assert.notDeepEqual(
        blendedOrder,
        baselineOrder,
        'the blend must be observable, otherwise the default cannot be proven off',
    );
    // Blending 0.5*providerRank + 0.5*(fusedRank) over the same permutation
    // gives a(1.5) < c(2.0) < b(3.0) < d(3.5), i.e. a, c, b, d.
    assert.deepEqual(blendedOrder, ["a", "c", "b", "d"]);
});

test("an explicit rerank_blend:false is honoured even when the env enables it", async () => {
    const previous = process.env.SATORI_SEARCH_FLAGS;
    try {
        process.env.SATORI_SEARCH_FLAGS = "rerank_blend";
        const viaEnv = await run(undefined);
        const viaExplicitOff = await run({ rerank_blend: false });
        const expected = await run({ rerank_blend: true });
        assert.deepEqual(
            viaExplicitOff.scored.map((e) => e.result.candidateId),
            ["c", "a", "d", "b"],
            'the explicit object branch must overwrite the env value',
        );
        assert.notDeepEqual(
            viaExplicitOff.scored.map((e) => e.result.candidateId),
            expected.scored.map((e) => e.result.candidateId),
        );
        assert.deepEqual(
            viaEnv.scored.map((e) => e.result.candidateId),
            expected.scored.map((e) => e.result.candidateId),
            'the env alone must enable the blend',
        );
    } finally {
        if (previous === undefined) delete process.env.SATORI_SEARCH_FLAGS;
        else process.env.SATORI_SEARCH_FLAGS = previous;
    }
});
