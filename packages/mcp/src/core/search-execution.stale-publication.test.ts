import assert from "node:assert/strict";
import test from "node:test";
import type { Reranker } from "@zokizuan/satori-core";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
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
import type { SearchQuerySupport } from "./search-query-support.js";

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

function buildInput(): SearchExecutionInput {
    const parsedOperators = parseSearchOperators(
        "path:src/dirty.ts where is the relevant implementation",
    );
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
        freshnessMode: "served_previous_generation",
        observedChangedFilesState: {
            available: true,
            files: new Set(["src/dirty.ts"]),
        },
        dirtyFilesNotFreshened: true,
        retrievalPolicy: resolveSearchPolicy({ resultLimit: 3, hasMustOperators: false }),
    };
}

test("served_previous_generation uses only publication-bound execution evidence", async () => {
    const calls = {
        dirtyOverlay: 0,
        trackedLexical: 0,
        livePath: 0,
        reranker: 0,
    };

    const support = {
        buildOperatorSummary: () => ({}),
        resolveRerankDecision: () => ({
            enabledByPolicy: true,
            skippedByScopeDocs: false,
            skippedByIdentifierIntent: false,
            exactMatchPinningEnabled: false,
            capabilityPresent: true,
            rerankerPresent: true,
            enabled: true,
        }),
        buildDirtyFileSearchResults: async () => {
            calls.dirtyOverlay += 1;
            return [];
        },
        buildTrackedLexicalSearchResults: async () => {
            calls.trackedLexical += 1;
            return {
                results: [],
                debug: {
                    enabled: true,
                    trackedPathCount: 1,
                    filesConsidered: 1,
                    filesScanned: 1,
                    bytesRead: 10,
                    cappedByFiles: false,
                    cappedByBytes: false,
                    returnedResults: 0,
                },
            };
        },
        buildLivePathScopedSearchResults: async () => {
            calls.livePath += 1;
            return [];
        },
        pathMatchesAnyPattern: () => true,
        tokenMatchesAnyField: () => true,
        detectSearchLexicalEvidence: () => ({
            hasLexicalEvidence: true,
            exactLexicalMatch: false,
        }),
    } as unknown as SearchQuerySupport;

    const reranker: Reranker = {
        getIdentity: () => ({ provider: "voyage", model: "test", profile: "test" }),
        rerank: async (_query, documents) => {
            calls.reranker += 1;
            return documents.map((_document, index) => ({
                index,
                relevanceScore: 1 - index * 0.1,
            }));
        },
    };

    const host: SearchExecutionHost = {
        searchQuerySupport: support,
        semanticSearch: async () => [
            candidate("a.ts", 0.9),
            candidate("b.ts", 0.8),
            candidate("c.ts", 0.7),
        ],
        reranker,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };

    const outcome = await runSearchExecution(
        buildInput(),
        host,
        {} as SearchDiagnostics,
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;

    assert.equal(calls.dirtyOverlay, 0, "stale publication reads must not scan dirty working-tree files");
    assert.equal(calls.trackedLexical, 0, "stale publication reads must not scan tracked files from current disk");
    assert.equal(calls.livePath, 0, "stale publication reads must not inject live path evidence");
    assert.equal(calls.reranker, 0, "stale publication reads must not use current-source-dependent reranking");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.relativePath),
        ["a.ts", "b.ts", "c.ts"],
    );
    assert.equal(outcome.orderAuthority, "retrieval_order");
    assert.equal(outcome.rerankerAttempted, false);
    assert.equal(outcome.freshnessSummary.syncMode, "served_previous_generation");
});
