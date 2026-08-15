import assert from "node:assert/strict";
import test from "node:test";
import type { Reranker, RerankResult } from "@zokizuan/satori-core";
import { CapabilityResolver } from "./capabilities.js";
import { parseSearchOperators, buildSearchQueryPlan } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import {
    buildSearchRerankQuery,
    SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
} from "./search-rerank-query.js";
import { resolveSearchPolicy } from "./search-policy.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchExecutionHost,
    type SearchExecutionInput,
} from "./search-execution.js";
import { SearchQuerySupport } from "./search-query-support.js";

type Candidate = {
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    content: string;
    score: number;
    symbolLabel: string;
};

const candidate = (relativePath: string, score: number): Candidate => ({
    relativePath,
    startLine: 1,
    endLine: 4,
    language: "typescript",
    content: `export function ${relativePath.replace(/[^a-z]/g, "")}() { return true; }`,
    score,
    symbolLabel: "function candidate()",
});

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
        classifyPathCategory: () => "core",
        shouldIncludeCategoryInScope: () => true,
        getSyncWatchDebounceMs: () => 0,
        capabilities: {
            hasReranker: () => reranker !== null,
            getDefaultRerankEnabled: () => reranker !== null,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker,
        gitignoreForceReloadEveryN: 1000,
    });
}

function buildInput(): SearchExecutionInput {
    const parsedOperators = parseSearchOperators("where find the relevant implementation");
    const queryPlan = buildSearchQueryPlan(parsedOperators.semanticQuery, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    return {
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: "default",
        resultMode: "raw",
        limit: 3,
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
        retrievalPolicy: resolveSearchPolicy({ resultLimit: 3, hasMustOperators: false }),
    };
}

function buildHost(
    results: Candidate[],
    reranker: Reranker | null,
): SearchExecutionHost {
    const support = buildSupport(reranker);
    return {
        searchQuerySupport: support,
        semanticSearch: async () => results,
        reranker,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
}

function rerankerReturning(results: RerankResult[] | Error): Reranker {
    return {
        getIdentity: () => ({ provider: "voyage", model: "test", profile: "test" }),
        rerank: async () => {
            if (results instanceof Error) throw results;
            return results;
        },
    };
}

async function run(
    input: SearchExecutionInput,
    host: SearchExecutionHost,
) {
    return runSearchExecution(input, host, {} as SearchDiagnostics);
}

test("native execution publishes complete provider order without score blending", async () => {
    const results = [candidate("a.ts", 0.90), candidate("b.ts", 0.80), candidate("c.ts", 0.70)];
    const reranker = rerankerReturning([
        { index: 2, relevanceScore: 0.10 },
        { index: 0, relevanceScore: 0.90 },
        { index: 1, relevanceScore: 0.80 },
    ]);
    const outcome = await run(buildInput(), buildHost(results, reranker));

    assert.equal(outcome.kind, "ok");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.relativePath),
        ["c.ts", "a.ts", "b.ts"],
    );
    assert.equal(outcome.orderAuthority, "reranker_order");
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.scored[0]?.rerankerScore, 0.10);
    assert.deepEqual(
        outcome.scored.map((entry) => entry.authoritativeRank),
        [1, 2, 3],
    );
});

test("native execution restores the exact retrieval order after provider failure", async () => {
    const results = [candidate("a.ts", 0.90), candidate("b.ts", 0.80), candidate("c.ts", 0.70)];
    const outcome = await run(
        buildInput(),
        buildHost(results, rerankerReturning(new Error("timeout"))),
    );

    assert.equal(outcome.kind, "ok");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.relativePath),
        ["a.ts", "b.ts", "c.ts"],
    );
    assert.equal(outcome.orderAuthority, "retrieval_order");
    assert.equal(outcome.rerankerApplied, false);
    assert.equal(outcome.rerankerFailurePhase, "api_call");
});

test("native execution surfaces qualified reranker deadline diagnostics", async () => {
    const results = [candidate("a.ts", 0.90), candidate("b.ts", 0.80), candidate("c.ts", 0.70)];
    const diagnostics = {
        attempts: 1,
        retries: 0,
        timeouts: 0,
        queueWaitMs: 3,
        effectiveScoreDeadlineMs: 500,
        effectiveStageDeadlineMs: 600,
        observedWallMs: 42,
    };
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "test" }),
        rerank: async (_query, documents, options) => {
            options?.onExecutionDiagnostics?.(diagnostics);
            return documents.map((_document, index) => ({ index, relevanceScore: 1 - index * 0.1 }));
        },
    };
    const outcome = await run(buildInput(), buildHost(results, reranker));

    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.rerankerApplied, true);
    assert.deepEqual(outcome.rerankerExecutionDiagnostics, diagnostics);
});
