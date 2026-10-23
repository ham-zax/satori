import assert from "node:assert/strict";
import test from "node:test";
import { buildGroupedSearchEnvelope } from "../packages/mcp/src/core/search-response-envelopes.ts";
import * as harness from "./code-intelligence-vs.mjs";
import {
    extractMcpPayload,
    normalizeResult,
    parseArgs,
    parseCommandSpec,
    scoreResult,
    summarize,
} from "./code-intelligence-vs.mjs";

const SEARCH_ROOT = "/indexed/production-shaped-repo";

function makeGroupedResult({ file, symbolId, graph = "ready" }) {
    return {
        target: {
            file,
            span: { startLine: 4, endLine: 8 },
            ...(symbolId === undefined ? {} : { symbolId }),
        },
        displayLabel: "function selectedTarget()",
        language: "typescript",
        quality: { owner: symbolId ? "high" : "low", semantic: "medium" },
        preview: "function selectedTarget() {}",
        navigation: graph === "ready" ? { graph, inbound: "verify" } : { graph },
    };
}

function makeProductionSearchEnvelope(results) {
    return buildGroupedSearchEnvelope({
        codebaseRoot: SEARCH_ROOT,
        absolutePath: SEARCH_ROOT,
        query: "find the selected target",
        scope: "runtime",
        groupBy: "symbol",
        limit: results.length,
        debugMode: "none",
        warnings: [],
        results,
    });
}

function makeSatoriSession(searchEnvelope, graphResponse = {
    content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
}) {
    const calls = [];
    return {
        calls,
        async callTool(name, args) {
            calls.push({ name, args });
            if (name === "search_codebase") {
                return {
                    response: {
                        content: [{ type: "text", text: JSON.stringify(searchEnvelope) }],
                    },
                    latencyMs: 1,
                };
            }
            return { response: graphResponse, latencyMs: 2 };
        },
    };
}

function runStubbedSatoriTask(session, task) {
    assert.equal(typeof harness.runSatoriTask, "function", "runSatoriTask must be exported for session stubs");
    return harness.runSatoriTask(session, task, { repo: "/different/context/repo" });
}

test("callgraph uses the first graph-ready production target and envelope root", async () => {
    const searchEnvelope = makeProductionSearchEnvelope([
        makeGroupedResult({ file: "src/not-ready.ts", symbolId: "symbol-not-ready", graph: "unsupported_language" }),
        makeGroupedResult({ file: "", symbolId: "symbol-empty-file" }),
        makeGroupedResult({ file: "src/missing-symbol.ts" }),
        makeGroupedResult({ file: "src/selected.ts", symbolId: "symbol-selected" }),
        makeGroupedResult({ file: "src/second.ts", symbolId: "symbol-second" }),
    ]);
    const selectedTarget = searchEnvelope.results[3].target;
    const session = makeSatoriSession(searchEnvelope);

    const result = await runStubbedSatoriTask(session, {
        id: "callgraph-production-contract",
        kind: "callgraph",
        query: "find the selected target",
        direction: "callees",
        depth: 3,
        graphLimit: 17,
    });

    assert.equal(searchEnvelope.formatVersion, 3);
    assert.equal(searchEnvelope.codebaseRoot, SEARCH_ROOT);
    assert.equal(result.status, "ok");
    assert.deepEqual(session.calls.map((call) => call.name), ["search_codebase", "call_graph"]);
    assert.deepEqual(session.calls[1].args, {
        path: searchEnvelope.codebaseRoot,
        symbolRef: selectedTarget,
        direction: "callees",
        depth: 3,
        limit: 17,
    });
});

test("callgraph reports unsupported without traversal when no usable graph target exists", async (t) => {
    const cases = [
        {
            name: "non-ready result",
            results: [makeGroupedResult({ file: "src/not-ready.ts", symbolId: "symbol-not-ready", graph: "unsupported_language" })],
        },
        {
            name: "graph-ready result without symbol ID",
            results: [makeGroupedResult({ file: "src/missing-symbol.ts" })],
        },
        {
            name: "graph-ready result without file",
            results: [makeGroupedResult({ file: "", symbolId: "symbol-empty-file" })],
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const session = makeSatoriSession(makeProductionSearchEnvelope(item.results));
            const result = await runStubbedSatoriTask(session, {
                id: "callgraph-no-target",
                kind: "callgraph",
                query: "find a graph target",
            });

            assert.equal(result.status, "unsupported");
            assert.equal(result.unsupported, true);
            assert.ok(result.warnings.includes("call_graph:no_supported_hint"));
            assert.deepEqual(session.calls.map((call) => call.name), ["search_codebase"]);
        });
    }
});

test("callgraph MCP error after target selection remains an error", async () => {
    const searchEnvelope = makeProductionSearchEnvelope([
        makeGroupedResult({ file: "src/selected.ts", symbolId: "symbol-selected" }),
    ]);
    const session = makeSatoriSession(searchEnvelope, {
        isError: true,
        content: [{ type: "text", text: "call_graph traversal failed" }],
    });

    const result = await runStubbedSatoriTask(session, {
        id: "callgraph-mcp-error",
        kind: "callgraph",
        query: "find a graph target",
    });

    assert.deepEqual(session.calls.map((call) => call.name), ["search_codebase", "call_graph"]);
    assert.equal(result.status, "error");
    assert.equal(result.unsupported, false);
    assert.match(result.error, /call_graph traversal failed/);
});

test("parseCommandSpec accepts JSON array command specs", () => {
    assert.deepEqual(
        parseCommandSpec("[\"node\",\"server.js\",\"--flag\"]"),
        ["node", "server.js", "--flag"]
    );
});

test("parseCommandSpec accepts simple quoted command specs", () => {
    assert.deepEqual(
        parseCommandSpec("node \"packages/mcp/dist/index.js\""),
        ["node", "packages/mcp/dist/index.js"]
    );
});

test("parseArgs keeps provider selection explicit", () => {
    const options = parseArgs([
        "--provider",
        "codebase-memory",
        "--cmm-command",
        "[\"node\",\"cmm.js\"]",
        "--cmm-project",
        "home-hamza-repo-satori",
    ], {});

    assert.equal(options.provider, "codebase-memory");
    assert.deepEqual(options.cmmCommand, ["node", "cmm.js"]);
    assert.equal(options.cmmProject, "home-hamza-repo-satori");
});

test("extractMcpPayload parses JSON text responses", () => {
    const { payload, text } = extractMcpPayload({
        content: [{ type: "text", text: "{\"status\":\"ok\",\"results\":[{\"file\":\"src/a.ts\"}]}" }],
    });

    assert.equal(payload.status, "ok");
    assert.equal(payload.results[0].file, "src/a.ts");
    assert.match(text, /src\/a\.ts/);
});

test("normalizeResult collects files, symbols, warnings, and unsupported states", () => {
    const task = { id: "t1", kind: "search" };
    const result = normalizeResult("satori", task, [{
        tool: "search_codebase",
        latencyMs: 12,
        response: {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: "requires_reindex",
                    warnings: ["SEARCH_SYMBOL_REGISTRY_UNAVAILABLE:missing_symbol_registry"],
                    results: [{
                        file: "packages/mcp/src/core/handlers.ts",
                        symbolLabel: "method handleSearchCode(args: any)",
                    }],
                }),
            }],
        },
    }]);

    assert.equal(result.provider, "satori");
    assert.equal(result.unsupported, true);
    assert.equal(result.latencyMs, 12);
    assert.ok(result.files.includes("packages/mcp/src/core/handlers.ts"));
    assert.ok(result.symbols.some((symbol) => symbol.includes("handleSearchCode")));
    assert.ok(result.warnings.some((warning) => warning.includes("requires_reindex")));
});

test("normalizeResult does not treat nested navigation fallback reasons as task-level unsupported", () => {
    const task = { id: "t1", kind: "search" };
    const result = normalizeResult("satori", task, [{
        tool: "search_codebase",
        latencyMs: 12,
        response: {
            content: [{
                type: "text",
                text: JSON.stringify({
                    status: "ok",
                    results: [{
                        file: "packages/mcp/src/core/handlers.ts",
                        symbolLabel: "method handleSearchCode(args: any)",
                        callGraphHint: {
                            supported: false,
                            reason: "unsupported_language",
                        },
                    }],
                }),
            }],
        },
    }]);

    assert.equal(result.unsupported, false);
    assert.ok(result.files.includes("packages/mcp/src/core/handlers.ts"));
    assert.ok(result.symbols.some((symbol) => symbol.includes("handleSearchCode")));
});

test("scoreResult rewards expected anchors and rejects forbidden text", () => {
    const task = {
        id: "find-search-handler",
        kind: "search",
        expected: {
            files: ["packages/mcp/src/core/handlers.ts"],
            symbols: ["handleSearchCode"],
            text: ["freshnessDecision"],
            forbiddenText: ["legacy v3 fallback"],
        },
    };
    const result = {
        status: "ok",
        files: ["packages/mcp/src/core/handlers.ts"],
        symbols: ["method handleSearchCode(args: any)"],
        text: "freshnessDecision callGraphHint",
    };

    const score = scoreResult(task, result);

    assert.equal(score.passed, true);
    assert.equal(score.score, score.maxScore);
});

test("scoreResult fails when required anchors are absent", () => {
    const task = {
        id: "miss",
        kind: "search",
        expected: {
            files: ["packages/core/src/config/defaults.ts"],
            symbols: ["DEFAULT_SUPPORTED_EXTENSIONS"],
        },
    };
    const score = scoreResult(task, {
        status: "ok",
        files: ["README.md"],
        symbols: [],
        text: "unrelated",
    });

    assert.equal(score.passed, false);
    assert.equal(score.score, 0);
});

test("scoreResult does not pass unsupported responses even when anchors match", () => {
    const task = {
        id: "unsupported",
        kind: "search",
        expected: {
            text: ["core", "mcp", "cli"],
        },
    };
    const score = scoreResult(task, {
        status: "ok",
        unsupported: true,
        files: [],
        symbols: [],
        text: "core mcp cli",
    });

    assert.equal(score.ratio, 1);
    assert.equal(score.passed, false);
});

test("summarize reports tied task leaders explicitly", () => {
    const summary = summarize({
        generatedAt: "2026-06-18T00:00:00.000Z",
        tasks: [{ id: "outline", kind: "outline" }],
        providers: [{ name: "satori" }, { name: "codebase-memory" }],
        results: [
            {
                provider: "satori",
                taskId: "outline",
                latencyMs: 50,
                unsupported: false,
                score: { score: 3, maxScore: 3, ratio: 1, passed: true },
            },
            {
                provider: "codebase-memory",
                taskId: "outline",
                latencyMs: 10,
                unsupported: false,
                score: { score: 3, maxScore: 3, ratio: 1, passed: true },
            },
        ],
    });

    assert.match(summary, /outline: tie satori, codebase-memory \(100\.0%, pass\)/);
});
