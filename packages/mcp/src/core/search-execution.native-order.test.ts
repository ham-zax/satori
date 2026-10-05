import assert from "node:assert/strict";
import test from "node:test";
import type { Reranker, RerankResult } from "@satori-code/core";
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
        capabilities: {
            hasReranker: () => reranker !== null,
            getDefaultRerankEnabled: () => reranker !== null,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker,
        gitignoreForceReloadEveryN: 1000,
    });
}

function buildInput(
    query = "where find the relevant implementation",
    flags: Record<string, boolean> = {},
): SearchExecutionInput {
    const parsedOperators = parseSearchOperators(query);
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
        flags: { path_demotion: false, ...flags },
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

test("cancellation after retrieval prevents projection and reranking", async () => {
    const controller = new AbortController();
    const input = { ...buildInput(), signal: controller.signal };
    let reranked = false;
    const reranker = rerankerReturning([]);
    reranker.rerank = async () => { reranked = true; return []; };
    const host = buildHost([], reranker);
    host.semanticSearch = async () => {
        controller.abort(new Error('cancel retrieval'));
        return [candidate('a.ts', 0.9)];
    };
    await assert.rejects(run(input, host), /cancel retrieval/);
    assert.equal(reranked, false);
});

test("reranker receives cancellation and cancellation does not publish fallback results", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const reranker = rerankerReturning([]);
    reranker.rerank = async (_query, _documents, options) => {
        observed = options?.signal;
        controller.abort(new Error('cancel reranking'));
        throw new Error('provider cancelled');
    };
    await assert.rejects(run({ ...buildInput(), signal: controller.signal },
        buildHost([candidate('a.ts', 0.9)], reranker)), /cancel reranking/);
    assert.equal(observed, controller.signal);
});

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

test("scope constrains retrieval before topK so excluded hits cannot exhaust the candidate budget", async () => {
    const input = buildInput("where is the documentation for cache invalidation");
    input.scope = "docs";
    input.retrievalFilter = { kind: "in", field: "relativePath", values: ["docs/cache.md"] };
    const runtime = Array.from({ length: 100 }, (_, i) => candidate(`src/runtime${i}.ts`, 0.99));
    const doc = candidate("docs/cache.md", 0.5);
    const host = buildHost([], null);
    const filters: unknown[] = [];
    host.semanticSearch = async (request) => {
        filters.push(request.filter);
        const eligible = request.filter ? [doc] : [...runtime, doc];
        return eligible.slice(0, request.topK);
    };
    const outcome = await run(input, host);
    assert.equal(outcome.kind, "ok");
    assert.deepEqual(outcome.scored.map((entry) => entry.result.relativePath), ["docs/cache.md"]);
    assert.ok(filters.length > 0);
    assert.ok(filters.every((filter) => filter === input.retrievalFilter));
});

test("missing source-backed functions reach the bounded reranker and retain the shared scope filters", async () => {
    const input = buildInput("where are useEffect dependencies compared");
    const results = Array.from({ length: 35 }, (_, i) => ({
        ...candidate("src/hooks.ts", 0.9), startLine: i * 10 + 1, endLine: i * 10 + 4,
    }));
    const correct = {
        ...candidate("src/hooks.ts", 0), startLine: 501, endLine: 510,
        symbolLabel: "areHookInputsEqual", content: "function areHookInputsEqual() { compareDependencies(); }",
    };
    let providerDocuments = 0;
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "test", model: "test", profile: "test" }),
        getMaxDocuments: () => 32,
        rerank: async (_query, documents) => {
            providerDocuments = documents.length;
            return documents.map((document, index) => ({
                index, relevanceScore: document.includes("areHookInputsEqual") ? 1 : 0,
            })).sort((a, b) => b.relevanceScore - a.relevanceScore);
        },
    };
    const host = buildHost(results, reranker);
    host.supplementCandidates = async () => [correct, candidate("docs/hooks.md", 0)];
    const outcome = await run(input, host);
    assert.equal(outcome.kind, "ok");
    assert.equal(providerDocuments, 32);
    assert.equal(outcome.scored[0]?.result.symbolLabel, "areHookInputsEqual");
    assert.equal(outcome.scored.some((entry) => entry.result.relativePath === "docs/hooks.md"), false);
    assert.equal(outcome.scored.length, 36);
});

test("validated symbol evidence admits an existing deep retrieval hit without duplicating it", async () => {
    const results = Array.from({ length: 40 }, (_, index) => candidate(`src/owner${index}.ts`, 1 - index / 100));
    const correct = results[39];
    correct.symbolLabel = "exportToBlob";
    correct.content = "export function exportToBlob() { return canvas.toBlob(); }";
    let providerDocuments = 0;
    const reranker: Reranker = {
        getIdentity: () => ({ provider: "test", model: "test", profile: "test" }),
        getMaxDocuments: () => 32,
        rerank: async (_query, documents) => {
            providerDocuments = documents.length;
            return documents.map((document, index) => ({
                index, relevanceScore: document.includes("exportToBlob") ? 1 : 0,
            })).sort((a, b) => b.relevanceScore - a.relevanceScore);
        },
    };
    const host = buildHost(results, reranker);
    host.supplementCandidates = async () => [correct];
    const outcome = await run(buildInput(), host);
    assert.equal(outcome.kind, "ok");
    assert.equal(providerDocuments, 32);
    assert.equal(outcome.scored[0]?.result.symbolLabel, "exportToBlob");
    assert.equal(outcome.scored.length, 40);
    assert.equal(outcome.scored.filter((entry) => entry.result === correct).length, 1);
});

test("serving a previous publication never starts live source refinement", async () => {
    const input = buildInput();
    input.freshnessMode = "served_previous_generation";
    const host = buildHost([candidate("src/run.ts", 0.9)], rerankerReturning([]));
    host.supplementCandidates = async () => { throw new Error("live source must not be read"); };
    const outcome = await run(input, host);
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.scored.length, 1);
    assert.equal(outcome.rerankerAttempted, false);
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


test("implementation focus puts runtime owners before tests and unrelated adapters", async () => {
    const results = [
        candidate("tests/cleanup.test.ts", 0.95),
        candidate("packages/helper-mcp-server/src/index.ts", 0.90),
        candidate("src/core/cleanup.ts", 0.80),
        candidate("src/core/effects.ts", 0.70),
    ];
    const reranker = rerankerReturning(results.map((_row, index) => ({ index, relevanceScore: 1 - index * 0.1 })));
    const outcome = await run(buildInput(), buildHost(results, reranker));
    assert.equal(outcome.kind, "ok");
    assert.deepEqual(outcome.scored.map((entry) => entry.result.relativePath), [
        "src/core/cleanup.ts", "src/core/effects.ts",
        "packages/helper-mcp-server/src/index.ts", "tests/cleanup.test.ts",
    ]);
    assert.equal(outcome.orderAuthority, "reranker_order");
    assert.deepEqual(outcome.scored.map((entry) => entry.rerankerRank), [3, 4, 2, 1]);
});

test("neutral focus keeps provider order unless neutral_owner_preference is enabled", async () => {
    const results = [candidate("tests/cleanup.test.ts", 0.95), candidate("src/core/cleanup.ts", 0.80)];
    const reranker = rerankerReturning([{ index: 0, relevanceScore: 0.9 }, { index: 1, relevanceScore: 0.8 }]);
    const query = "stale cleanup effects";
    assert.equal(buildInput(query).answerFocus, "neutral");
    const byDefault = await run(buildInput(query), buildHost(results, reranker));
    const preferred = await run(
        buildInput(query, { neutral_owner_preference: true }),
        buildHost(results, reranker),
    );
    assert.equal(byDefault.kind, "ok");
    assert.equal(preferred.kind, "ok");
    assert.deepEqual(byDefault.scored.map((entry) => entry.result.relativePath), [
        "tests/cleanup.test.ts", "src/core/cleanup.ts",
    ]);
    assert.deepEqual(preferred.scored.map((entry) => entry.result.relativePath), [
        "src/core/cleanup.ts", "tests/cleanup.test.ts",
    ]);
});

test("default definition discovery admits metadata candidates and fuses their definition evidence", async () => {
    const rows = [candidate("src/noise.ts", 0.95)];
    const recovered = { ...candidate("src/actions.ts", 0.1), symbolKind: "function", symbolLabel: "function tradeWorkflow" };
    const input = buildInput("trade workflow rejected bundle loop");
    let calls = 0;
    const host = buildHost(rows, {
        getIdentity: () => ({ provider: "voyage", model: "test", profile: "test" }),
        rerank: async (_query, documents) => {
            calls++;
            return documents.map((_document, index) => ({ index, relevanceScore: 1 - index * 0.1 }));
        },
    });
    host.symbolMetadataSearch = async () => [recovered];
    host.definitionMetadata = result => ({ name: result.relativePath === "src/actions.ts" ? "tradeWorkflow" : "formatCurrency", qualifiedName: "", file: result.relativePath, kind: "function" });
    const outcome = await run(input, host);
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.orderAuthority, "definition_fusion_order");
    assert.equal(outcome.scored[0]?.result.relativePath, "src/actions.ts");
    assert.ok(outcome.scored.find(entry => entry.result.relativePath === "src/actions.ts")?.retrievalPasses.includes("symbol_metadata_bm25"));
    assert.equal(calls, 1);
});

test("default definition alt_terms admit and fuse owners the query vocabulary cannot reach", async () => {
    const rows = [candidate("src/noise.ts", 0.95)];
    const recovered = { ...candidate("src/effects.ts", 0.1), symbolKind: "function", symbolLabel: "function commitHookEffectListUnmount" };
    const runWith = async (flags: Record<string, boolean>) => {
        const input = { ...buildInput("trade workflow cleanup loop", flags), alt_terms: ["commitHookEffectListUnmount"] };
        const host = buildHost(rows, {
            getIdentity: () => ({ provider: "voyage", model: "test", profile: "test" }),
            rerank: async (_query, documents) => documents.map((_document, index) => ({ index, relevanceScore: 1 - index * 0.1 })),
        });
        const metadataQueries: Array<string | undefined> = [];
        host.symbolMetadataSearch = async query => {
            metadataQueries.push(query);
            return query?.includes("commitHookEffectListUnmount") ? [recovered] : [];
        };
        host.definitionMetadata = result => ({ name: result.relativePath === "src/effects.ts" ? "commitHookEffectListUnmount" : "formatCurrency", qualifiedName: "", file: result.relativePath, kind: "function" });
        return { outcome: await run(input, host), metadataQueries };
    };
    const enabled = await runWith({});
    assert.equal(enabled.outcome.kind, "ok");
    assert.deepEqual(enabled.metadataQueries, [undefined, "commitHookEffectListUnmount"]);
    assert.equal(enabled.outcome.scored[0]?.result.relativePath, "src/effects.ts");
    assert.ok(enabled.outcome.scored[0]?.retrievalPasses.includes("symbol_metadata_bm25_alt"));
    const disabled = await runWith({ definition_alt_terms: false });
    assert.equal(disabled.outcome.kind, "ok");
    assert.deepEqual(disabled.metadataQueries, [undefined]);
    assert.ok(!disabled.outcome.scored.some(entry => entry.retrievalPasses.includes("symbol_metadata_bm25_alt")));
});

test("symbol metadata BM25 is default-off and its enabled candidates reach fusion and reranking", async () => {
    const query = "click executor state signature legal target validation";
    const primary = candidate("src/content/action-guide.ts", 0.9);
    const owner = candidate("engine/crates/catan-core/src/state.rs", 5);
    owner.symbolLabel = "legal_actions";
    owner.content = "pub fn legal_actions() {}";
    const build = () => {
        let laneCalls = 0;
        let ownerReachedProvider = false;
        const reranker: Reranker = {
            getIdentity: () => ({ provider: "test", model: "test", profile: "test" }),
            rerank: async (_query, documents) => {
                ownerReachedProvider = documents.some((document) => document.includes("legal_actions"));
                return documents.map((_document, index) => ({ index, relevanceScore: 1 - index / 10 }));
            },
        };
        const host = buildHost([primary], reranker);
        host.symbolMetadataSearch = async () => { laneCalls++; return [owner]; };
        return { host, calls: () => laneCalls, reached: () => ownerReachedProvider };
    };
    const baseline = build();
    const off = await run(buildInput(query), baseline.host);
    assert.equal(off.kind, "ok");
    assert.equal(baseline.calls(), 0);
    assert.equal(baseline.reached(), false);
    assert.deepEqual(off.scored.map((entry) => entry.result.relativePath), [primary.relativePath]);

    const experiment = build();
    const on = await run(buildInput(query, { symbol_metadata_bm25: true }), experiment.host);
    assert.equal(on.kind, "ok");
    assert.equal(experiment.calls(), 1);
    assert.equal(experiment.reached(), true);
    assert.ok(on.scored.some((entry) => entry.result === owner));
    assert.deepEqual(on.rankingProvenance.lexicalPassesUsed, ["symbol_metadata_bm25"]);
});

test("symbol metadata BM25 preserves explicit-intent and previous-publication search paths", async () => {
    for (const query of ["tests for stale cleanup effects", "configuration for cleanup effects",
        "callers of cleanup", "path:src/core/cleanup.ts stale cleanup effects"]) {
        const host = buildHost([candidate("src/core/cleanup.ts", 0.9)], null);
        host.symbolMetadataSearch = async () => { throw new Error("metadata lane must stay off"); };
        assert.equal((await run(buildInput(query, { symbol_metadata_bm25: true }), host)).kind, "ok");
    }
    const input = buildInput("click executor state signature legal target validation", { symbol_metadata_bm25: true });
    input.freshnessMode = "served_previous_generation";
    const host = buildHost([candidate("src/core/cleanup.ts", 0.9)], null);
    host.symbolMetadataSearch = async () => { throw new Error("previous publication cannot read live source"); };
    assert.equal((await run(input, host)).kind, "ok");
});

test("explicit tests, configuration, references, and qualified paths retain provider order", async () => {
    const results = [candidate("tests/cleanup.test.ts", 0.95), candidate("src/core/cleanup.ts", 0.80)];
    const reranker = rerankerReturning([{ index: 0, relevanceScore: 0.9 }, { index: 1, relevanceScore: 0.8 }]);
    for (const query of [
        "tests for cleanup implementation", "configuration for cleanup", "callers of cleanup",
        "path:tests/cleanup.test.ts implementation",
    ]) {
        const outcome = await run(buildInput(query), buildHost(results, reranker));
        assert.equal(outcome.kind, "ok");
        assert.equal(outcome.scored[0]?.result.relativePath, "tests/cleanup.test.ts", query);
    }
});

test("an implementation question about an MCP server retains the requested adapter", async () => {
    const results = [candidate("packages/helper-mcp-server/src/index.ts", 0.95), candidate("src/core/cleanup.ts", 0.80)];
    const reranker = rerankerReturning([{ index: 0, relevanceScore: 0.9 }, { index: 1, relevanceScore: 0.8 }]);
    const outcome = await run(buildInput("how does the MCP server implement cleanup"), buildHost(results, reranker));
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.scored[0]?.result.relativePath, "packages/helper-mcp-server/src/index.ts");
});
