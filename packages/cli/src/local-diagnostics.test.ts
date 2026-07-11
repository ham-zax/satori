import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildLocalDiagnosticEvent,
    readLocalDiagnosticsSummary,
    recordLocalDiagnosticEvent,
} from "./local-diagnostics.js";

function toolResult(envelope: Record<string, unknown>, isError = false): Record<string, unknown> {
    return {
        isError,
        content: [{ type: "text", text: JSON.stringify(envelope) }],
    };
}

test("buildLocalDiagnosticEvent extracts only bounded privacy-safe search measurements", () => {
    const event = buildLocalDiagnosticEvent({
        toolName: "search_codebase",
        args: { path: "/secret/repo", query: "private CustomerToken symbol" },
        result: toolResult({
            status: "ok",
            results: [{ file: "src/private.ts" }, { file: "src/secret.ts" }],
            warnings: [
                { code: "SEARCH_DIRTY_WORKTREE_NOT_SYNCED", action: "Open /secret/repo" },
                { code: "invalid code with spaces" },
            ],
            fallbackUsed: true,
        }),
        durationMs: 17.8,
    });

    assert.deepEqual(event, {
        schemaVersion: "v1",
        kind: "tool_call",
        tool: "search_codebase",
        durationMs: 18,
        outcome: "ok",
        resultCount: 2,
        warningCodes: ["SEARCH_DIRTY_WORKTREE_NOT_SYNCED"],
        fallbackUsed: true,
    });
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /secret|CustomerToken|private\.ts|query|path|symbol/i);
});

test("buildLocalDiagnosticEvent limits resultCount to search result envelopes", () => {
    const cases = [
        { toolName: "file_outline", envelope: { status: "ok", outline: { symbols: [{ name: "run" }] } } },
        { toolName: "call_graph", envelope: { status: "ok", nodes: [{ id: "run" }], edges: [{ source: "run" }] } },
        { toolName: "read_file", envelope: { status: "ok", content: "source" } },
        { toolName: "list_codebases", envelope: { status: "ok", codebases: ["/repo"] } },
    ];

    for (const { toolName, envelope } of cases) {
        const event = buildLocalDiagnosticEvent({
            toolName,
            args: {},
            result: toolResult(envelope),
            durationMs: 1,
        });
        assert.equal(event.resultCount, undefined, `${toolName} must not overload search result count`);
    }
});

test("buildLocalDiagnosticEvent records lifecycle outcome and repair success without a root", () => {
    const event = buildLocalDiagnosticEvent({
        toolName: "manage_index",
        args: { action: "repair", path: "/private/worktree" },
        result: toolResult({ status: "ok", path: "/private/worktree", proof: { marker: "matched" } }),
        durationMs: 4,
    });

    assert.deepEqual(event, {
        schemaVersion: "v1",
        kind: "tool_call",
        tool: "manage_index",
        durationMs: 4,
        outcome: "ok",
        lifecycleAction: "repair",
        recoverySuccess: true,
    });
});

test("buildLocalDiagnosticEvent preserves public non-ok lifecycle and navigation outcomes", () => {
    for (const outcome of ["not_indexed", "requires_reindex", "not_found", "unsupported", "ambiguous"] as const) {
        const event = buildLocalDiagnosticEvent({
            toolName: outcome === "not_indexed" || outcome === "requires_reindex" ? "manage_index" : "file_outline",
            args: { action: "status", path: "/private/worktree" },
            result: toolResult({ status: outcome, path: "/private/worktree" }),
            durationMs: 1,
        });
        assert.equal(event.outcome, outcome);
    }
});

test("buildLocalDiagnosticEvent bounds untrusted values and unknown tools", () => {
    const event = buildLocalDiagnosticEvent({
        toolName: "private_tool_name",
        args: { action: "private-action" },
        result: toolResult({
            status: "private-status",
            warnings: ["RERANKER_FAILED", "PRIVATE_SYMBOL_TOKEN", "x".repeat(80)],
            results: new Array(20_000).fill(null),
        }),
        durationMs: Number.POSITIVE_INFINITY,
    });

    assert.deepEqual(event, {
        schemaVersion: "v1",
        kind: "tool_call",
        tool: "unknown",
        durationMs: 0,
        outcome: "unknown",
        resultCount: 10_000,
        warningCodes: ["RERANKER_FAILED"],
        fallbackUsed: true,
    });
});

test("recordLocalDiagnosticEvent caps the local log and readLocalDiagnosticsSummary is deterministic", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-local-diagnostics-"));
    const diagnosticsPath = path.join(tempDir, "nested", "events.jsonl");
    try {
        for (let index = 0; index < 4; index += 1) {
            recordLocalDiagnosticEvent(diagnosticsPath, {
                schemaVersion: "v1",
                kind: "tool_call",
                tool: index === 3 ? "manage_index" : "search_codebase",
                durationMs: index + 1,
                outcome: index === 2 ? "error" : "ok",
                ...(index < 3 ? { resultCount: index === 1 ? 0 : index } : {}),
                ...(index === 3 ? { lifecycleAction: "sync" as const } : {}),
                ...(index === 1 ? { warningCodes: ["SEARCH_DIRTY_WORKTREE_NOT_SYNCED", "RERANKER_FAILED"], fallbackUsed: true } : {}),
            }, { maxEvents: 3 });
        }
        fs.appendFileSync(diagnosticsPath, "not-json\n", "utf8");

        assert.equal(fs.statSync(diagnosticsPath).mode & 0o777, 0o600);
        const summary = readLocalDiagnosticsSummary(diagnosticsPath);
        assert.deepEqual(summary, {
            schemaVersion: "v1",
            storage: "local_only",
            privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
            eventsRead: 3,
            malformedEventsSkipped: 1,
            totalDurationMs: 9,
            toolCalls: [
                {
                    tool: "manage_index",
                    count: 1,
                    errorCount: 0,
                    durationMs: 4,
                    resultBearingCalls: 0,
                    resultCount: 0,
                    zeroResultCalls: 0,
                },
                {
                    tool: "search_codebase",
                    count: 2,
                    errorCount: 1,
                    durationMs: 5,
                    resultBearingCalls: 2,
                    resultCount: 2,
                    zeroResultCalls: 1,
                },
            ],
            warningCodes: [
                { code: "RERANKER_FAILED", count: 1 },
                { code: "SEARCH_DIRTY_WORKTREE_NOT_SYNCED", count: 1 },
            ],
            fallbackUses: 1,
            lifecycleOutcomes: [{ action: "sync", outcome: "ok", count: 1 }],
            recovery: { attempts: 0, successes: 0 },
        });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("recordLocalDiagnosticEvent refuses a symlinked diagnostics file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-local-diagnostics-link-"));
    const diagnosticsPath = path.join(tempDir, "events.jsonl");
    const targetPath = path.join(tempDir, "target.txt");
    try {
        fs.writeFileSync(targetPath, "PRIVATE_PATH=/secret/repo\n", { mode: 0o644 });
        fs.symlinkSync(targetPath, diagnosticsPath);

        recordLocalDiagnosticEvent(diagnosticsPath, {
            schemaVersion: "v1",
            kind: "tool_call",
            tool: "search_codebase",
            durationMs: 1,
            outcome: "ok",
        }, { lockTimeoutMs: 0 });

        assert.equal(fs.readFileSync(targetPath, "utf8"), "PRIVATE_PATH=/secret/repo\n");
        assert.equal(fs.statSync(targetPath).mode & 0o777, 0o644);
        assert.equal(fs.lstatSync(diagnosticsPath).isSymbolicLink(), true);
        assert.equal(readLocalDiagnosticsSummary(diagnosticsPath).eventsRead, 0);
        assert.equal(fs.readFileSync(targetPath, "utf8"), "PRIVATE_PATH=/secret/repo\n");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("local diagnostics refuses a symlinked parent directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-local-diagnostics-parent-link-"));
    const targetDir = path.join(tempDir, "target");
    const linkedDir = path.join(tempDir, "diagnostics");
    const diagnosticsPath = path.join(linkedDir, "events.jsonl");
    try {
        fs.mkdirSync(targetDir);
        fs.symlinkSync(targetDir, linkedDir, "dir");

        recordLocalDiagnosticEvent(diagnosticsPath, {
            schemaVersion: "v1",
            kind: "tool_call",
            tool: "search_codebase",
            durationMs: 1,
            outcome: "ok",
        }, { lockTimeoutMs: 0 });

        assert.equal(fs.existsSync(path.join(targetDir, "events.jsonl")), false);
        const summary = readLocalDiagnosticsSummary(diagnosticsPath);
        assert.equal(summary.eventsRead, 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("recordLocalDiagnosticEvent retains only revalidated privacy-safe events", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-local-diagnostics-sanitize-"));
    const diagnosticsPath = path.join(tempDir, "events.jsonl");
    try {
        fs.writeFileSync(diagnosticsPath, [
            JSON.stringify({
                schemaVersion: "v1",
                kind: "tool_call",
                tool: "search_codebase",
                durationMs: 3,
                outcome: "ok",
                path: "/secret/repo",
                query: "PrivateOwner",
            }),
            "PRIVATE_PATH=/secret/repo",
            "",
        ].join("\n"));

        recordLocalDiagnosticEvent(diagnosticsPath, {
            schemaVersion: "v1",
            kind: "tool_call",
            tool: "search_codebase",
            durationMs: 4,
            outcome: "ok",
        }, { lockTimeoutMs: 0 });

        const contents = fs.readFileSync(diagnosticsPath, "utf8");
        assert.doesNotMatch(contents, /secret|PrivateOwner|query|path/i);
        const lines = contents.trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((event) => event.durationMs), [3, 4]);
        assert.deepEqual(fs.readdirSync(tempDir), ["events.jsonl"]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("recordLocalDiagnosticEvent drops a contending write without disturbing the lock", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-local-diagnostics-lock-"));
    const diagnosticsPath = path.join(tempDir, "events.jsonl");
    const lockPath = `${diagnosticsPath}.lock`;
    try {
        fs.writeFileSync(lockPath, "held\n", { mode: 0o600 });
        recordLocalDiagnosticEvent(diagnosticsPath, {
            schemaVersion: "v1",
            kind: "tool_call",
            tool: "search_codebase",
            durationMs: 1,
            outcome: "ok",
        }, { lockTimeoutMs: 0 });

        assert.equal(fs.existsSync(diagnosticsPath), false);
        assert.equal(fs.readFileSync(lockPath, "utf8"), "held\n");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("readLocalDiagnosticsSummary returns an empty report when no log exists", () => {
    const summary = readLocalDiagnosticsSummary("/definitely/missing/satori-events.jsonl");
    assert.equal(summary.eventsRead, 0);
    assert.equal(summary.malformedEventsSkipped, 0);
    assert.deepEqual(summary.toolCalls, []);
});
