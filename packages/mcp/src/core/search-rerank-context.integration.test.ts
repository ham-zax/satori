import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { Reranker, RerankResult } from "@zokizuan/satori-core";
import type { CapabilityResolver } from "./capabilities.js";
import {
    runSearchExecution,
    type SearchDiagnostics,
    type SearchExecutionHost,
    type SearchExecutionInput,
} from "./search-execution.js";
import { SearchQuerySupport } from "./search-query-support.js";
import { buildSearchQueryPlan, parseSearchOperators } from "./search-query-planning.js";
import { resolveSearchAnswerFocus } from "./search-answer-focus.js";
import {
    buildSearchRerankQuery,
    SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
} from "./search-rerank-query.js";
import { resolveSearchRerankQuery } from "./search-rerank-query-routing.js";
import { resolveSearchCandidateRole } from "./search-candidate-role.js";
import { resolveSearchPolicy } from "./search-policy.js";
import type { SearchRerankProjectionResult } from "./search-rerank-projection-result.js";

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
        getSyncWatchDebounceMs: () => 0,
        capabilities: {
            hasReranker: () => reranker !== null,
            getDefaultRerankEnabled: () => reranker !== null,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker,
        gitignoreForceReloadEveryN: 25,
    });
}

function buildInput(query: string): SearchExecutionInput {
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
        retrievalPolicy: resolveSearchPolicy({ resultLimit: 3, hasMustOperators: false }),
    };
}

function typedProjection(result: FixtureCandidate): SearchRerankProjectionResult {
    const candidateRole = resolveSearchCandidateRole({
        relativePath: result.relativePath,
        language: result.language,
    });
    const document = JSON.stringify({
        repository_relative_path: result.relativePath,
        candidate_role: candidateRole,
        query_relevant_source_excerpt: result.content,
    });
    return {
        ok: true,
        document,
        utf8Bytes: Buffer.byteLength(document, "utf8"),
        sha256: crypto.createHash("sha256").update(document, "utf8").digest("hex"),
        candidateRole,
        projectionIdentity: "search_rerank_document_v4",
    };
}

function buildHost(
    results: FixtureCandidate[],
    reranker: Reranker | null,
): SearchExecutionHost {
    return {
        searchQuerySupport: buildSupport(reranker),
        semanticSearch: async () => results,
        reranker,
        buildRerankDocument: async (_query, result) => typedProjection(result as FixtureCandidate),
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
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

test("production context derives implementation focus for mechanism questions", () => {
    const input = buildInput("how does Shariah compliance checking block trades");
    assert.equal(input.answerFocus, "implementation");
});

test("production context derives tests focus for test-seeking questions", () => {
    const input = buildInput("find tests for trade veto behavior");
    assert.equal(input.answerFocus, "tests");
});

test("production context derives configuration focus for configuration questions", () => {
    const input = buildInput("where is the risk threshold configured");
    assert.equal(input.answerFocus, "configuration");
});

test("the reranker receives the exact focused question and factual documents", async () => {
    const question = "how does Shariah compliance checking block trades";
    const captured: { query?: string; documents?: string[] } = {};
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async (query, documents, options) => {
            captured.query = query;
            captured.documents = [...documents];
            const identities = options?.identities ?? [];
            return identities.map((_identity, index) => ({
                index,
                relevanceScore: 1 - index / 10,
            })) satisfies RerankResult[];
        },
    };
    const results = [
        candidate("impl", "src/core/veto.ts", 0.9),
        candidate("test", "tests/veto.test.ts", 0.8),
    ];
    await runSearchExecution(buildInput(question), buildHost(results, reranker), buildDiagnostics());

    const query = captured.query ?? "";
    assert.equal(query.split(question).length - 1, 1, "question appears exactly once");
    assert.ok(query.includes("Requested answer type:"));
    assert.ok(query.includes("production implementation, control flow, and integration path"));
    assert.equal(query.includes("Answer focus:"), false, "current query must not carry the retired v1 focus label");
    assert.equal(query.includes("implementation runtime source entrypoint"), false);
    assert.equal(/multiplier|weight|boost|preference\s*\d/i.test(query), false);
    assert.equal(/\d\.\d+/.test(query), false);

    const documents = captured.documents ?? [];
    assert.equal(documents.length, 2);
    assert.ok(documents[0]!.includes('"candidate_role":"implementation"'));
    assert.ok(documents[1]!.includes('"candidate_role":"test"'));
});

test("provider order stays authoritative when tests outrank implementation", async () => {
    const question = "how does Shariah compliance checking block trades";
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async (_query, documents) => {
            // Provider puts the test document first for an implementation query.
            const order = [1, 0].slice(0, documents.length);
            return order.map((index, rank) => ({
                index,
                relevanceScore: 1 - rank / 10,
            })) satisfies RerankResult[];
        },
    };
    const results = [
        candidate("impl", "src/core/veto.ts", 0.9),
        candidate("test", "tests/veto.test.ts", 0.8),
    ];
    const outcome = await runSearchExecution(
        buildInput(question),
        buildHost(results, reranker),
        buildDiagnostics(),
    );
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.orderAuthority, "reranker_order");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["test", "impl"],
    );
});

test("survival metadata carries answer focus and query projection identity", async () => {
    const question = "how does Shariah compliance checking block trades";
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v3" }),
        rerank: async (_query, _documents, options) => (options?.identities ?? []).map(
            (_identity, index) => ({ index, relevanceScore: 1 - index / 10 }),
        ),
    };
    const results = [
        candidate("impl", "src/core/veto.ts", 0.9),
        candidate("test", "tests/veto.test.ts", 0.8),
    ];
    const outcome = await runSearchExecution(
        buildInput(question),
        buildHost(results, reranker),
        buildDiagnostics(),
    );
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const rerankInputStage = outcome.candidateSurvival?.stages.find(
        (stage) => stage.stage === "reranker_input",
    );
    assert.ok(rerankInputStage);
    assert.ok((rerankInputStage!.candidates.length) >= 2);
    for (const occurrence of rerankInputStage!.candidates) {
        assert.equal(occurrence.rerankInput?.answerFocus, "implementation");
        assert.equal(occurrence.rerankInput?.queryProjectionIdentity, "search_rerank_query_v2");
        assert.equal(occurrence.rerankInput?.projectionIdentity, "search_rerank_document_v4");
    }
});

test("explicit historical reranker profile receives the raw question byte-exact", async () => {
    const question = "how does Shariah compliance checking block trades";
    const captured: { query?: string } = {};
    const reranker: Reranker = {
        getIdentity: () => ({
            provider: "lateon",
            model: "test",
            profile: "lateon_offline_quality_projection_v2_d32_v2",
        }),
        getQueryProjectionVersion: () => "semantic_query_raw_v1",
        rerank: async (query, _documents, options) => {
            captured.query = query;
            return (options?.identities ?? []).map((_identity, index) => ({
                index,
                relevanceScore: 1 - index / 10,
            })) satisfies RerankResult[];
        },
    };
    const base = buildInput(question);
    const resolved = resolveSearchRerankQuery({
        semanticQuery: base.semanticQuery,
        focusedQueryV2: base.rerankQuery,
        projectionIdentity: reranker.getQueryProjectionVersion?.(),
    });
    const results = [
        candidate("impl", "src/core/veto.ts", 0.9),
        candidate("test", "tests/veto.test.ts", 0.8),
    ];
    const outcome = await runSearchExecution(
        {
            ...base,
            rerankQuery: resolved.query,
            rerankQueryProjectionIdentity: resolved.queryProjectionIdentity,
        },
        buildHost(results, reranker),
        buildDiagnostics(),
    );
    assert.equal(outcome.kind, "ok");
    assert.equal(captured.query, question, "historical profile must receive the raw question exactly");
    if (outcome.kind !== "ok") return;
    const rerankInputStage = outcome.candidateSurvival?.stages.find(
        (stage) => stage.stage === "reranker_input",
    );
    assert.ok(rerankInputStage);
    for (const occurrence of rerankInputStage!.candidates) {
        assert.equal(occurrence.rerankInput?.queryProjectionIdentity, "semantic_query_raw_v1");
    }
});

test("retired v1 query projection identity is rejected", () => {
    const base = buildInput("how does Shariah compliance checking block trades");
    assert.throws(
        () => resolveSearchRerankQuery({
            semanticQuery: base.semanticQuery,
            projectionIdentity: "search_rerank_query_v1",
        }),
        /search_rerank_query_projection_identity_unknown:search_rerank_query_v1/,
    );
});

test("source excerpt projection receives the exact semantic question rather than the expanded provider query", async () => {
    const question = "validate the exact shariah gate";
    const providerQuery = [
        "Question:",
        question,
        "",
        "Requested answer type:",
        "production implementation, control flow, and integration path",
    ].join("\n");
    const capturedProjectionQueries: string[] = [];
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "lateon", model: "test", profile: "context-v4" }),
        getMaxDocuments: () => 32,
        rerank: async (_query, _documents, options) => (options?.identities ?? []).map(
            (_identity, index) => ({ index, relevanceScore: 1 - index / 10 }),
        ),
    };
    const base = buildInput(question);
    const host = buildHost([
        candidate("impl", "src/core/veto.ts", 0.9),
        candidate("test", "tests/veto.test.ts", 0.8),
    ], reranker);
    host.buildRerankDocument = async (sourceSelectionQuery, result) => {
        capturedProjectionQueries.push(sourceSelectionQuery);
        return typedProjection(result as FixtureCandidate);
    };
    const outcome = await runSearchExecution({
        ...base,
        rerankQuery: providerQuery,
        rerankQueryProjectionIdentity: "search_rerank_query_v2",
    }, host, buildDiagnostics());
    assert.equal(outcome.kind, "ok");
    assert.deepEqual(capturedProjectionQueries, [question, question]);
});
