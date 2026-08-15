import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
    RerankerRequestError,
    type Reranker,
    type RerankResult,
} from "@zokizuan/satori-core";
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
import { SEARCH_RERANK_INPUT_MAX_UTF8_BYTES } from "./search-constants.js";
import { searchRerankCandidateId } from "./search-rerank-projection.js";
import type {
    SearchRerankProjectionFailureReason,
    SearchRerankProjectionResult,
} from "./search-rerank-projection-result.js";
import { resolveSearchPolicy } from "./search-policy.js";
import { resolveRequestedSearchSubdirectory } from "./search-requested-scope.js";

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

function candidate(
    candidateId: string,
    relativePath: string,
    score: number,
    content = "export function implementation() { return true; }",
): FixtureCandidate {
    return {
        candidateId,
        relativePath,
        startLine: 1,
        endLine: 4,
        language: "typescript",
        content,
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

function buildInput(
    query = "where find the relevant implementation",
    overrides: {
        limit?: number;
        debugMode?: SearchExecutionInput["debugMode"];
        queryPlan?: Partial<SearchExecutionInput["queryPlan"]>;
    } = {},
): SearchExecutionInput {
    const parsedOperators = parseSearchOperators(query);
    const baseQueryPlan = buildSearchQueryPlan(
        parsedOperators.semanticQuery,
        true,
        parsedOperators,
    );
    const queryPlan = {
        ...baseQueryPlan,
        ...(overrides.queryPlan || {}),
    };
    const limit = overrides.limit ?? 3;
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    return {
        effectiveRoot: "/repo",
        scope: "runtime",
        rankingMode: "default",
        resultMode: "raw",
        limit,
        debugMode: overrides.debugMode ?? "none",
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
            hasMustOperators: parsedOperators.must.length > 0,
        }),
    };
}

function buildHost(
    results: FixtureCandidate[],
    reranker: Reranker | null,
    options: {
        buildRerankDocument?: SearchExecutionHost["buildRerankDocument"];
    } = {},
): SearchExecutionHost {
    const support = buildSupport(reranker);
    return {
        searchQuerySupport: support,
        semanticSearch: async () => results,
        reranker,
        ...(options.buildRerankDocument
            ? { buildRerankDocument: options.buildRerankDocument }
            : {}),
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
}

function buildReranker(
    buildResults: (documents: readonly string[], candidateIds: readonly string[]) => RerankResult[],
    onCall?: (documents: readonly string[], candidateIds: readonly string[]) => void,
): Reranker {
    return {
        getIdentity: () => ({ provider: "voyage", model: "test", profile: "native-order" }),
        rerank: async (_query, documents, options) => {
            const candidateIds = options?.identities || [];
            onCall?.(documents, candidateIds);
            return buildResults(documents, candidateIds);
        },
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

async function run(
    input: SearchExecutionInput,
    host: SearchExecutionHost,
) {
    return runSearchExecution(input, host, buildDiagnostics());
}

function reverseResults(
    documents: readonly string[],
): RerankResult[] {
    return documents.map((_document, index) => ({
        index: documents.length - index - 1,
        relevanceScore: index / Math.max(1, documents.length),
    }));
}

test("production execution rejects every malformed provider response before fallback", async () => {
    const malformedResponses: Array<{ name: string; results: RerankResult[] }> = [
        {
            name: "cardinality",
            results: [{ index: 0, relevanceScore: 1 }],
        },
        {
            name: "duplicate index",
            results: [
                { index: 0, relevanceScore: 1 },
                { index: 0, relevanceScore: 0.5 },
                { index: 1, relevanceScore: 0.25 },
            ],
        },
        {
            name: "foreign index",
            results: [
                { index: 0, relevanceScore: 1 },
                { index: 1, relevanceScore: 0.5 },
                { index: 3, relevanceScore: 0.25 },
            ],
        },
        {
            name: "non-finite score",
            results: [
                { index: 0, relevanceScore: Number.NaN },
                { index: 1, relevanceScore: 0.5 },
                { index: 2, relevanceScore: Number.POSITIVE_INFINITY },
            ],
        },
    ];

    for (const malformed of malformedResponses) {
        const results = [
            candidate("a", "src/a.ts", 0.9),
            candidate("b", "src/b.ts", 0.8),
            candidate("c", "src/c.ts", 0.7),
        ];
        const outcome = await run(
            buildInput(),
            buildHost(results, buildReranker(() => malformed.results)),
        );

        assert.equal(outcome.kind, "ok", malformed.name);
        if (outcome.kind !== "ok") continue;
        assert.deepEqual(
            outcome.scored.map((entry) => entry.result.candidateId),
            ["a", "b", "c"],
            malformed.name,
        );
        assert.equal(outcome.orderAuthority, "retrieval_order", malformed.name);
        assert.equal(outcome.rerankerApplied, false, malformed.name);
        assert.equal(outcome.rerankerFailurePhase, "parse_results", malformed.name);
    }
});

test("filters are complete before native provider admission", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker = buildReranker((documents) => reverseResults(documents), (_documents, candidateIds) => {
        providerCandidateIds.push([...candidateIds]);
    });
    const results = [
        candidate("allowed", "src/allowed.ts", 0.9),
        candidate("excluded", "src/secret.ts", 0.99),
        candidate("allowed-2", "src/allowed-2.ts", 0.8),
    ];
    const outcome = await run(
        buildInput("-path:src/secret.ts find the relevant implementation"),
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(providerCandidateIds, [["allowed", "allowed-2"]]);
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["allowed-2", "allowed"],
    );
});

test("requested subdirectory is a hard scope before native provider admission", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker = buildReranker((documents) => reverseResults(documents), (_documents, candidateIds) => {
        providerCandidateIds.push([...candidateIds]);
    });
    const results = [
        candidate("in-scope", "src/alpha/a.ts", 0.7),
        candidate("in-scope-2", "src/alpha/nested/a2.ts", 0.65),
        candidate("sibling", "src/beta/b.ts", 0.99),
        candidate("prefix-collision", "src/alpha-x/c.ts", 0.95),
    ];
    const outcome = await run(
        {
            ...buildInput("find the relevant implementation"),
            requestedSubdirectory: resolveRequestedSearchSubdirectory({
                indexedRoot: "/repo",
                requestedPath: "/repo/src/alpha",
            }),
        },
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(providerCandidateIds, [["in-scope", "in-scope-2"]]);
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["in-scope-2", "in-scope"],
    );
    assert.equal(outcome.filterSummary.removedByRequestedSubdirectory, 2);
});

test("root requests admit every candidate when no subdirectory is requested", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker = buildReranker((documents) => reverseResults(documents), (_documents, candidateIds) => {
        providerCandidateIds.push([...candidateIds]);
    });
    const results = [
        candidate("a", "src/alpha/a.ts", 0.9),
        candidate("b", "src/beta/b.ts", 0.8),
    ];
    const requestedSubdirectory = resolveRequestedSearchSubdirectory({
        indexedRoot: "/repo",
        requestedPath: "/repo",
    });
    assert.equal(requestedSubdirectory, null);
    const outcome = await run(
        {
            ...buildInput("find the relevant implementation"),
            requestedSubdirectory,
        },
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(providerCandidateIds, [["a", "b"]]);
    assert.equal(outcome.filterSummary.removedByRequestedSubdirectory, 0);
});

test("native execution preserves an exact-owned prefix and reranks only its suffix", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker = buildReranker((documents) => reverseResults(documents), (_documents, candidateIds) => {
        providerCandidateIds.push([...candidateIds]);
    });
    const results = [
        candidate("exact", "src/target.ts", 0.1, "export function target() {}"),
        candidate("tail-a", "src/a.ts", 0.9),
        candidate("tail-b", "src/b.ts", 0.8),
    ];
    const outcome = await run(
        buildInput("where is target implementation", {
            queryPlan: {
                exactMatchPinningEnabled: true,
                rerankAllowed: true,
            },
        }),
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(providerCandidateIds, [["tail-a", "tail-b"]]);
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["exact", "tail-b", "tail-a"],
    );
    assert.deepEqual(outcome.scored.map((entry) => entry.authoritativeRank), [1, 2, 3]);
});

test("advertised provider capacity admits all eligible families independently of result limit", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker = buildReranker(
        (documents) => reverseResults(documents),
        (_documents, candidateIds) => providerCandidateIds.push([...candidateIds]),
    );
    reranker.getMaxDocuments = () => 32;
    const results = Array.from({ length: 26 }, (_, index) => candidate(
        `candidate-${index + 1}`,
        `src/candidate-${index + 1}.ts`,
        26 - index,
    ));
    const outcome = await run(buildInput("find implementation", { limit: 2 }), buildHost(results, reranker));
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.rerankerCandidatePoolCount, 26);
    assert.equal(outcome.rerankerCandidateBudget, 26);
    assert.equal(outcome.rerankerBudgetReason, "complete_family_pool");
    assert.equal(providerCandidateIds[0]?.length, 26);
    assert.ok(providerCandidateIds[0]?.includes("candidate-17"));
});

test("provider capacity confines native permutation to admitted slots", async () => {
    const reranker = buildReranker((documents) => reverseResults(documents));
    reranker.getMaxDocuments = () => 2;
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
        candidate("d", "src/d.ts", 0.6),
    ];
    const outcome = await run(buildInput(), buildHost(results, reranker));

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["b", "a", "c", "d"],
    );
});

test("projection failure falls back without calling the provider", async () => {
    let providerCalls = 0;
    const reranker = buildReranker(() => {
        providerCalls += 1;
        return [];
    });
    const results = [candidate("a", "src/a.ts", 0.9), candidate("b", "src/b.ts", 0.8)];
    const outcome = await run(
        buildInput(),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => ({
                ok: false,
                candidateId: searchRerankCandidateId(result),
                reason: "projection_contract_failed",
            }),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(providerCalls, 0);
    assert.equal(outcome.rerankerFailurePhase, undefined);
    assert.equal(outcome.rerankerAttempted, false);
    assert.ok(outcome.searchWarnings.includes("RERANKER_SKIPPED_INPUT"));
    assert.ok(!outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.deepEqual(
        outcome.rerankerProjection?.failureCounts,
        { projection_contract_failed: 2 },
    );
    assert.equal(outcome.rerankerProjection?.skippedCandidates, 2);
    assert.deepEqual(outcome.scored.map((entry) => entry.result.candidateId), ["a", "b"]);
});

test("every typed projection failure reason falls back before provider admission", async () => {
    const reasons: SearchRerankProjectionFailureReason[] = [
        "generation_receipt_missing",
        "navigation_status_invalid",
        "registry_load_failed",
        "registry_manifest_mismatch",
        "owner_not_found",
        "candidate_span_invalid",
        "source_unavailable",
        "source_exceeds_projection_limit",
        "source_hash_mismatch",
        "projection_contract_failed",
    ];
    for (const reason of reasons) {
        let providerCalls = 0;
        const reranker = buildReranker(() => {
            providerCalls += 1;
            return [];
        });
        const results = [candidate("a", "src/a.ts", 0.9), candidate("b", "src/b.ts", 0.8)];
        const outcome = await run(
            buildInput(),
            buildHost(results, reranker, {
                buildRerankDocument: async (_query, result) => ({
                    ok: false,
                    candidateId: searchRerankCandidateId(result),
                    reason,
                }),
            }),
        );

        assert.equal(outcome.kind, "ok", reason);
        if (outcome.kind !== "ok") continue;
        assert.equal(providerCalls, 0, reason);
        assert.equal(outcome.rerankerApplied, false, reason);
        assert.equal(outcome.rerankerFailurePhase, undefined, reason);
        assert.ok(outcome.searchWarnings.includes("RERANKER_SKIPPED_INPUT"), reason);
        assert.ok(!outcome.searchWarnings.includes("RERANKER_FAILED"), reason);
        assert.deepEqual(outcome.rerankerProjection?.failureCounts, { [reason]: 2 }, reason);
        assert.equal(outcome.rerankerProjection?.firstFailure?.reason, reason, reason);
        assert.deepEqual(
            outcome.scored.map((entry) => entry.result.candidateId),
            ["a", "b"],
            reason,
        );
    }
});

test("one projection failure degrades input and reranks only the projectable slots", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker = buildReranker((documents) => reverseResults(documents), (_documents, candidateIds) => {
        providerCandidateIds.push([...candidateIds]);
    });
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
        candidate("d", "src/d.ts", 0.6),
    ];
    const outcome = await run(
        buildInput(),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => (
                result.relativePath === "src/c.ts"
                    ? {
                        ok: false,
                        candidateId: searchRerankCandidateId(result),
                        reason: "source_hash_mismatch",
                    }
                    : {
                        ok: true,
                        document: `document ${result.relativePath}`,
                        utf8Bytes: Buffer.byteLength(`document ${result.relativePath}`, "utf8"),
                        sha256: "0".repeat(64),
                        candidateRole: "unknown",
                        projectionIdentity: "search_rerank_document_v2",
                    }
            ),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(providerCandidateIds, [["a", "b", "d"]]);
    assert.ok(outcome.searchWarnings.includes("RERANKER_INPUT_DEGRADED"));
    assert.ok(!outcome.searchWarnings.includes("RERANKER_SKIPPED_INPUT"));
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.orderAuthority, "reranker_order");
    assert.equal(outcome.rerankerProjection?.requestedCandidates, 4);
    assert.equal(outcome.rerankerProjection?.projectedCandidates, 3);
    assert.equal(outcome.rerankerProjection?.skippedCandidates, 1);
    assert.deepEqual(outcome.rerankerProjection?.failureCounts, { source_hash_mismatch: 1 });
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["d", "b", "c", "a"],
    );
});

test("a single surviving projection skips the provider and preserves retrieval order", async () => {
    let providerCalls = 0;
    const reranker = buildReranker(() => {
        providerCalls += 1;
        return [];
    });
    const results = [candidate("a", "src/a.ts", 0.9), candidate("b", "src/b.ts", 0.8)];
    const outcome = await run(
        buildInput(),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => (
                result.relativePath === "src/b.ts"
                    ? {
                        ok: false,
                        candidateId: searchRerankCandidateId(result),
                        reason: "owner_not_found",
                    }
                    : {
                        ok: true,
                        document: "document a",
                        utf8Bytes: 10,
                        sha256: "0".repeat(64),
                        candidateRole: "unknown",
                        projectionIdentity: "search_rerank_document_v2",
                    }
            ),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(providerCalls, 0);
    assert.equal(outcome.rerankerAttempted, false);
    assert.equal(outcome.rerankerApplied, false);
    assert.equal(outcome.rerankerFailurePhase, undefined);
    assert.ok(outcome.searchWarnings.includes("RERANKER_SKIPPED_INPUT"));
    assert.ok(!outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.equal(outcome.rerankerProjection?.projectedCandidates, 1);
    assert.equal(outcome.rerankerProjection?.skippedCandidates, 1);
    assert.deepEqual(outcome.scored.map((entry) => entry.result.candidateId), ["a", "b"]);
});

test("a shared-authority mass failure records every failure without RERANKER_FAILED", async () => {
    let providerCalls = 0;
    const reranker = buildReranker(() => {
        providerCalls += 1;
        return [];
    });
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await run(
        buildInput(),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => ({
                ok: false,
                candidateId: searchRerankCandidateId(result),
                reason: "registry_manifest_mismatch",
            }),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(providerCalls, 0);
    assert.equal(outcome.rerankerFailurePhase, undefined);
    assert.ok(!outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.ok(outcome.searchWarnings.includes("RERANKER_SKIPPED_INPUT"));
    assert.equal(outcome.rerankerProjection?.requestedCandidates, 3);
    assert.equal(outcome.rerankerProjection?.projectedCandidates, 0);
    assert.equal(outcome.rerankerProjection?.skippedCandidates, 3);
    assert.deepEqual(
        outcome.rerankerProjection?.failureCounts,
        { registry_manifest_mismatch: 3 },
    );
    assert.equal(
        outcome.rerankerProjection?.firstFailure?.reason,
        "registry_manifest_mismatch",
    );
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["a", "b", "c"],
    );
});

test("a provider timeout after partial projection keeps the full frozen retrieval order", async () => {
    const reranker = buildReranker(() => {
        throw new RerankerRequestError(
            "timeout",
            null,
            2,
            "reranker request timed out",
        );
    });
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await run(
        buildInput(),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => (
                result.relativePath === "src/c.ts"
                    ? {
                        ok: false,
                        candidateId: searchRerankCandidateId(result),
                        reason: "source_unavailable",
                    }
                    : {
                        ok: true,
                        document: `document ${result.relativePath}`,
                        utf8Bytes: 20,
                        sha256: "0".repeat(64),
                        candidateRole: "unknown",
                        projectionIdentity: "search_rerank_document_v2",
                    }
            ),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.ok(outcome.searchWarnings.includes("RERANKER_INPUT_DEGRADED"));
    assert.ok(outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.equal(outcome.rerankerFailurePhase, "api_call");
    assert.equal(outcome.rerankerApplied, false);
    assert.equal(outcome.rerankerProjection?.skippedCandidates, 1);
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["a", "b", "c"],
    );
});

test("zero-byte reranker admission falls back to the frozen retrieval order", async () => {
    let providerCalls = 0;
    const reranker = buildReranker(() => {
        providerCalls += 1;
        return [];
    });
    const results = [candidate("a", "src/a.ts", 0.9), candidate("b", "src/b.ts", 0.8)];
    const outcome = await run(
        buildInput(),
        buildHost(results, reranker, {
            buildRerankDocument: async (): Promise<SearchRerankProjectionResult> => {
                const document = "x".repeat(SEARCH_RERANK_INPUT_MAX_UTF8_BYTES + 1);
                return {
                    ok: true,
                    document,
                    utf8Bytes: Buffer.byteLength(document, "utf8"),
                    sha256: "0".repeat(64),
                    candidateRole: "unknown",
                    projectionIdentity: "search_rerank_document_v2",
                };
            },
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(providerCalls, 0);
    assert.equal(outcome.rerankerAttempted, false);
    assert.equal(outcome.rerankerApplied, false);
    assert.deepEqual(outcome.scored.map((entry) => entry.result.candidateId), ["a", "b"]);
});

test("provider timeout restores the frozen retrieval order", async () => {
    const reranker = buildReranker(() => {
        throw new RerankerRequestError(
            "timeout",
            null,
            2,
            "reranker request timed out",
        );
    });
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await run(buildInput(), buildHost(results, reranker));

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.rerankerFailurePhase, "api_call");
    assert.equal(outcome.rerankerFailureKind, "timeout");
    assert.equal(outcome.rerankerApplied, false);
    assert.ok(outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["a", "b", "c"],
    );
});

test("no reranker leaves the frozen retrieval order with zero provider calls", async () => {
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await run(buildInput(), buildHost(results, null));

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.rerankerAttempted, false);
    assert.equal(outcome.rerankerApplied, false);
    assert.equal(outcome.orderAuthority, "retrieval_order");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["a", "b", "c"],
    );
});

test("policy-disabled reranking keeps retrieval order with zero provider calls", async () => {
    let providerCalls = 0;
    const reranker = buildReranker(() => {
        providerCalls += 1;
        return [];
    });
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await run(
        buildInput("find the relevant implementation", {
            queryPlan: { rerankAllowed: false },
        }),
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(providerCalls, 0);
    assert.equal(outcome.rerankerAttempted, false);
    assert.equal(outcome.rerankerApplied, false);
    assert.equal(outcome.orderAuthority, "retrieval_order");
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["a", "b", "c"],
    );
});

test("a sole exact result skips provider admission entirely", async () => {
    let providerCalls = 0;
    const reranker = buildReranker(() => {
        providerCalls += 1;
        return [];
    });
    const results = [
        candidate("only", "src/target.ts", 0.1, "export function target() {}"),
    ];
    const outcome = await run(
        buildInput("where is target implementation", {
            queryPlan: { rerankAllowed: true },
        }),
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(providerCalls, 0);
    assert.equal(outcome.skippedByExactPin, true);
    assert.equal(outcome.rerankerAttempted, false);
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["only"],
    );
});

test("must, exclude, and lang rejection completes before provider admission", async () => {
    const providerCandidateIds: string[][] = [];
    const reranker = buildReranker((documents) => reverseResults(documents), (_documents, candidateIds) => {
        providerCandidateIds.push([...candidateIds]);
    });
    const results = [
        {
            ...candidate("survivor", "src/survivor.ts", 0.9),
            content: "export function zzunique() { return true; }",
            symbolLabel: "function zzunique()",
        },
        {
            ...candidate("must-rejected", "src/must-rejected.ts", 0.99),
            content: "export function unrelated() { return 1; }",
            symbolLabel: "function unrelated()",
        },
        {
            ...candidate("exclude-rejected", "src/exclude-rejected.ts", 0.95),
            content: "export function secret() { return 2; }",
            symbolLabel: "function secret()",
        },
        {
            ...candidate("lang-rejected", "src/lang-rejected.ts", 0.8),
            language: "python",
        },
    ];
    const outcome = await run(
        buildInput("must:zzunique exclude:secret lang:typescript locate the code"),
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.deepEqual(providerCandidateIds, [["survivor"]]);
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["survivor"],
    );
});

test("candidate survival records the exact reranker input and output suffix", async () => {
    const reranker = buildReranker((documents) => reverseResults(documents));
    const results = [
        candidate("exact", "src/target.ts", 0.1, "export function target() {}"),
        candidate("tail-a", "src/a.ts", 0.9),
        candidate("tail-b", "src/b.ts", 0.8),
        candidate("tail-c", "src/c.ts", 0.7),
    ];
    const outcome = await run(
        buildInput("where is target implementation", {
            debugMode: "full",
            queryPlan: {
                exactMatchPinningEnabled: true,
                rerankAllowed: true,
            },
        }),
        buildHost(results, reranker),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const stages = outcome.candidateSurvival?.stages ?? [];
    const inputStage = stages.find((stage) => stage.stage === "reranker_input");
    const outputStage = stages.find((stage) => stage.stage === "reranker_output");
    assert.ok(inputStage, "reranker_input stage must be recorded");
    assert.ok(outputStage, "reranker_output stage must be recorded");
    assert.deepEqual(
        inputStage.candidates.map((entry) => entry.candidateId),
        ["tail-a", "tail-b", "tail-c"],
    );
    assert.deepEqual(
        outputStage.candidates.map((entry) => entry.candidateId),
        ["tail-c", "tail-b", "tail-a"],
    );
    assert.deepEqual(
        outcome.scored.map((entry) => entry.result.candidateId),
        ["exact", "tail-c", "tail-b", "tail-a"],
    );
});

function typedOkProjection(result: { relativePath: string }) {
    const document = `focused rerank body ${result.relativePath}`;
    return {
        ok: true as const,
        document,
        utf8Bytes: Buffer.byteLength(document, "utf8"),
        sha256: crypto.createHash("sha256").update(document, "utf8").digest("hex"),
        candidateRole: "unknown" as const,
        projectionIdentity: "search_rerank_document_v2",
    };
}

test("full debug records bounded per-document rerank input provenance without text", async () => {
    const providerDocuments: string[][] = [];
    const reranker = buildReranker((documents) => reverseResults(documents), (documents) => {
        providerDocuments.push([...documents]);
    });
    const results = [candidate("a", "src/a.ts", 0.9), candidate("b", "src/b.ts", 0.8)];
    const buildRerankDocument = async (
        _query: string,
        result: { relativePath: string },
    ) => typedOkProjection(result);
    const outcome = await run(
        buildInput(undefined, { debugMode: "full" }),
        buildHost(results, reranker, { buildRerankDocument }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.candidateSurvival?.schemaVersion, "search_candidate_survival_v4");
    const stages = outcome.candidateSurvival?.stages ?? [];
    const inputStage = stages.find((stage) => stage.stage === "reranker_input");
    assert.ok(inputStage, "reranker_input stage must be recorded");
    assert.equal(providerDocuments.length, 1);
    for (const occurrence of inputStage.candidates) {
        const providerDocument = providerDocuments[0]![occurrence.rank - 1]!;
        assert.equal(providerDocument, `focused rerank body ${occurrence.relativePath}`);
        assert.deepEqual(occurrence.rerankInput, {
            documentUtf8Bytes: Buffer.byteLength(providerDocument, "utf8"),
            documentSha256: crypto.createHash("sha256")
                .update(providerDocument, "utf8")
                .digest("hex"),
            candidateRole: "unknown",
            answerFocus: "implementation",
            projectionIdentity: "search_rerank_document_v2",
            queryProjectionIdentity: "search_rerank_query_v2",
        });
    }
    for (const stage of stages) {
        if (stage.stage === "reranker_input") continue;
        for (const occurrence of stage.candidates) {
            assert.equal(occurrence.rerankInput, undefined, stage.stage);
        }
    }
    assert.equal(JSON.stringify(outcome.candidateSurvival).includes("focused rerank body"), false);

    const nonFull = await run(buildInput(), buildHost(results, reranker, { buildRerankDocument }));
    assert.equal(nonFull.kind, "ok");
    if (nonFull.kind !== "ok") return;
    assert.equal(nonFull.candidateSurvival, undefined);
});

test("projection failures appear as removals with candidate identity and no source text", async () => {
    const reranker = buildReranker((documents) => reverseResults(documents));
    const results = [
        candidate("a", "src/a.ts", 0.9),
        candidate("b", "src/b.ts", 0.8),
        candidate("c", "src/c.ts", 0.7),
    ];
    const outcome = await run(
        buildInput(undefined, { debugMode: "full" }),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => (
                result.relativePath === "src/c.ts"
                    ? {
                        ok: false,
                        candidateId: searchRerankCandidateId(result),
                        reason: "source_hash_mismatch",
                    }
                    : typedOkProjection(result)
            ),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const removals = outcome.candidateSurvival?.removals ?? [];
    assert.deepEqual(
        removals.filter((removal) => removal.reason === "reranker_document_projection_failed"),
        [{
            candidateId: "src/c.ts:1:4",
            afterStage: "mcp_ranked",
            reason: "reranker_document_projection_failed",
        }],
    );
    assert.equal(JSON.stringify(outcome.candidateSurvival).includes("focused rerank body"), false);
});

test("insufficient projectable documents record reranker_input_insufficient removals", async () => {
    const reranker = buildReranker(() => []);
    const results = [candidate("a", "src/a.ts", 0.9), candidate("b", "src/b.ts", 0.8)];
    const outcome = await run(
        buildInput(undefined, { debugMode: "full" }),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => (
                result.relativePath === "src/b.ts"
                    ? {
                        ok: false,
                        candidateId: searchRerankCandidateId(result),
                        reason: "owner_not_found",
                    }
                    : typedOkProjection(result)
            ),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    const removals = outcome.candidateSurvival?.removals ?? [];
    assert.deepEqual(
        removals.map((removal) => [removal.candidateId, removal.reason]),
        [
            ["src/b.ts:1:4", "reranker_document_projection_failed"],
            ["a", "reranker_input_insufficient"],
        ],
    );
});

test("incompatible structural context keeps candidates and emits a dedicated integrity warning", async () => {
    const reranker = buildReranker((documents) => reverseResults(documents));
    const results = [candidate("a", "src/a.ts", 0.9), candidate("b", "src/b.ts", 0.8)];
    const outcome = await run(
        buildInput(),
        buildHost(results, reranker, {
            buildRerankDocument: async (_query, result) => ({
                ok: true,
                document: `document ${result.relativePath}`,
                utf8Bytes: Buffer.byteLength(`document ${result.relativePath}`, "utf8"),
                sha256: "0".repeat(64),
                candidateRole: "implementation",
                projectionIdentity: "search_rerank_document_v4",
                structuralContextStatus: "incompatible",
            }),
        }),
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.rerankerApplied, true);
    assert.equal(outcome.rerankerProjection?.structuralContextStatus, "incompatible");
    assert.ok(outcome.searchWarnings.includes("RERANKER_CONTEXT_DEGRADED"));
    assert.ok(!outcome.searchWarnings.includes("RERANKER_FAILED"));
    assert.deepEqual(outcome.scored.map((entry) => entry.result.candidateId), ["b", "a"]);
});
