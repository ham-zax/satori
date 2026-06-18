import assert from "node:assert/strict";
import test from "node:test";
import {
    extractMcpPayload,
    normalizeResult,
    parseArgs,
    parseCommandSpec,
    scoreResult,
    summarize,
} from "./code-intelligence-vs.mjs";

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
