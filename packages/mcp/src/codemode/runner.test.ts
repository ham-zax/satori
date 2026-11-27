import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScript } from "./runner.js";

const unexpectedTool = () => Promise.reject(new Error("Unexpected nested tool call."));

test("CodeMode exposes Satori's read tools and dispatches only index status", async () => {
    const dispatched: Array<{ name: string; args: unknown }> = [];
    const result = await runScript({
        code: `
            const catalog = ALL_TOOLS.map(({ name }) => name).sort();
            const status = await tools.manage_index({ action: "status", path: "/repo" });
            const otherActions = ["create", "reindex", "sync", "cancel", "clear", undefined];
            const outcomes = await Promise.allSettled(otherActions.map(action =>
                tools.manage_index({ action, path: "/repo" })));
            return { catalog, status, rejected: outcomes.map(outcome => outcome.status) };
        `,
        callSessionTool: async (name, args) => {
            dispatched.push({ name, args });
            return { content: [{ type: "text", text: '{"status":"indexed"}' }] };
        },
    });
    assert.equal(result.isError, undefined, result.content[0]!.text);
    assert.deepEqual(JSON.parse(result.content[0]!.text), {
        catalog: [
            "architecture_overview", "call_graph", "continue_search", "detect_changes",
            "file_outline", "find_references", "list_codebases", "manage_index",
            "read_file", "search_codebase", "trace_path",
        ],
        status: { status: "indexed" },
        rejected: Array(6).fill("rejected"),
    });
    assert.deepEqual(dispatched, [{ name: "manage_index", args: { action: "status", path: "/repo" } }]);
});

test("CodeMode bounds UTF-8 output, diagnostics, and tool calls", async () => {
    const printed = await runScript({ code: 'return "🙂".repeat(16_384);', callSessionTool: unexpectedTool });
    assert.equal(printed.isError, undefined);
    const output = printed.content[0]!.text;
    assert.ok(Buffer.byteLength(output) <= 16 * 1024);
    assert.match(output, /\[truncated\]$/);
    assert.doesNotMatch(output, /\ufffd/);

    const failed = await runScript({ code: 'throw new Error("x".repeat(32_768));', callSessionTool: unexpectedTool });
    assert.equal(failed.isError, true);
    assert.ok(Buffer.byteLength(failed.content[0]!.text) < 1100);
    assert.match(failed.content[0]!.text, /\[truncated\]$/);

    let calls = 0;
    const excess = await runScript({
        code: "for (let i = 0; i < 33; i++) await tools.read_file({});",
        callSessionTool: async () => {
            calls += 1;
            return { content: [{ type: "text", text: "{}" }] };
        },
    });
    assert.equal(calls, 32);
    assert.equal(excess.isError, true);
    assert.match(excess.content[0]!.text, /tool call limit/);
});

test("CodeMode rejects malformed configuration without revealing its contents", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-script-config-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, "servers.json");
    fs.writeFileSync(configPath, '{"mcpServers":{"fixture":{"command":"unused","args":[PRIVATE_ARG]}}}');
    const result = await runScript({ code: "return 42;", callSessionTool: unexpectedTool, configPath });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, "CodeMode MCP configuration is not valid JSON.");
});

test("CodeMode rejects colliding downstream aliases before any connection", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-script-alias-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, "servers.json");
    fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: { fixture: { command: "unused", allowedTools: ["some-tool", "some_tool"] } },
    }));
    const result = await runScript({ code: "return 42;", callSessionTool: unexpectedTool, configPath });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Duplicate CodeMode tool name or alias/);
});

test("CodeMode deadline closes a downstream connection during handshake and permits reuse", { timeout: 10_000 }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-script-timeout-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const log = path.join(directory, "requests");
    const configPath = path.join(directory, "servers.json");
    const fixture = `
        const fs = require("node:fs");
        process.stdin.on("data", () => fs.appendFileSync(process.argv[1], "started\\n"));
        process.stdin.on("end", () => fs.appendFileSync(process.argv[1], "closed\\n"));
    `;
    fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: ["-e", fixture, log], allowedTools: ["blocked"] } },
    }));
    const result = await runScript({
        code: "return await tools.fixture__blocked({});",
        callSessionTool: unexpectedTool,
        configPath,
        timeoutMs: 2500,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /Script timed out/);
    assert.equal(fs.readFileSync(log, "utf8"), "started\nclosed\n");
    const reused = await runScript({ code: "return 42;", callSessionTool: unexpectedTool });
    assert.deepEqual(reused.content, [{ type: "text", text: "42" }]);
});
