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

function candidate(candidateId: string, relativePath: string, score: number, symbolLabel: string): FixtureCandidate {
    return {
        candidateId,
        relativePath,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content: "export function implementation() { return true; }",
        score,
        symbolLabel,
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
    const query = "trade workflow rejected bundle loop";
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
): Reranker {
    return {
        getIdentity: () => ({ provider: "voyage", model: "test", profile: "floor" }),
        rerank: async (_query, documents, options) => {
            const candidateIds = options?.identities || [];
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

/** Full reversal: the reranker buries the first-stage #1 at rank 5 of 5. */
function reversedResults(documents: readonly string[]): RerankResult[] {
    return documents.map((_document, position) => ({
        index: documents.length - 1 - position,
        relevanceScore: 1 - position / Math.max(1, documents.length),
    }));
}

const RESULTS = [
    candidate("a", "src/owner.ts", 0.9, "function tradeWorkflow()"),
    candidate("b", "src/b.ts", 0.8, "function helperOne()"),
    candidate("c", "src/c.ts", 0.7, "function helperTwo()"),
    candidate("d", "src/d.ts", 0.6, "function helperThree()"),
    candidate("e", "src/e.ts", 0.5, "function helperFour()"),
];

async function run(flags?: Record<string, boolean>) {
    const reranker = buildReranker(reversedResults);
    const outcome = await runSearchExecution(
        buildInput(flags),
        buildHost(RESULTS, reranker),
        buildDiagnostics(),
    );
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") throw new Error("expected an ok outcome");
    return outcome;
}

test("first_stage_owner_floor is off by default and the buried owner stays buried", async () => {
    const outcome = await run(undefined);
    assert.equal(resolveSearchFlags().first_stage_owner_floor, false);
    assert.equal(outcome.rerankerApplied, true);
    // Full reversal publishes e, d, c, b, a: the tradeWorkflow owner ends at rank 5.
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["e", "d", "c", "b", "a"],
    );
});

test("first_stage_owner_floor keeps a query-covered first-stage owner in the top 3", async () => {
    const floored = await run({ first_stage_owner_floor: true });
    // tradeWorkflow splits into {trade, workflow} and the query carries both:
    // coverage 2/2 holds the owner at rank 3 instead of rank 5.
    assert.deepEqual(
        floored.scored.map((entry) => entry.result.candidateId),
        ["e", "d", "a", "c", "b"],
    );
});
