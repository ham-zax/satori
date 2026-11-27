import test from "node:test";
import assert from "node:assert/strict";
import { connectCliMcpSession } from "./client.js";
import { CliError } from "./errors.js";

const FAKE_STDIO_SERVER = `
const readline = require("node:readline");
process.stdout.write("non-json startup banner\\n");
process.stderr.write("fake-server-stderr-ready\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-stdio-server", version: "1.0.0" },
            },
        }) + "\\n");
        return;
    }
    if (msg.method === "tools/list") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
                tools: [{ name: "stall", description: "stalls", inputSchema: { type: "object" } }],
            },
        }) + "\\n");
        return;
    }
    if (msg.method === "tools/call") {
        // Deliberately never respond so the client timeout path fires.
        return;
    }
});
`;

test("connectCliMcpSession tolerates stdout banner, pipes stderr, records pid, and maps SDK timeout to E_CALL_TIMEOUT", async (t) => {
    const stderrChunks: string[] = [];
    const launcherPids: number[] = [];
    const session = await connectCliMcpSession({
        command: process.execPath,
        args: ["-e", FAKE_STDIO_SERVER],
        env: process.env,
        startupTimeoutMs: 5_000,
        callTimeoutMs: 120,
        writeStderr: (text) => stderrChunks.push(text),
        onLauncherStarted: (pid) => launcherPids.push(pid),
    });
    t.after(async () => {
        await session.close();
    });

    assert.ok(session.launcherPid && session.launcherPid > 0);
    assert.deepEqual(launcherPids, [session.launcherPid]);
    assert.deepEqual(session.serverVersion, { name: "fake-stdio-server", version: "1.0.0" });

    const listed = await session.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["stall"]);
    assert.match(stderrChunks.join(""), /fake-server-stderr-ready/);

    await assert.rejects(
        session.callTool("stall", {}),
        (error: unknown) => {
            assert.ok(error instanceof CliError);
            assert.equal(error.token, "E_CALL_TIMEOUT");
            assert.equal(error.exitCode, 3);
            return true;
        },
    );
});
