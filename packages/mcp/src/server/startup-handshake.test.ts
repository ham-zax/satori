import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { SyncManager } from "../core/sync.js";
import { toolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

type InProcessSession = {
    instructions?: string;
    request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
    close: () => Promise<void>;
};

type JsonRpcResponse = {
    id?: unknown;
    error?: unknown;
    result?: {
        content?: Array<{ type?: string; text?: string }>;
        tools?: Array<{ name: string; description?: string }>;
        instructions?: string;
        isError?: boolean;
    };
};

type ToolPayload = Record<string, unknown> & {
    status?: string;
    reason?: string;
    code?: string;
    results?: unknown[];
    hints?: {
        setup?: {
            missingEnv?: unknown;
        };
    };
};

type SessionEnvResult = {
    session: InProcessSession;
    tempDir: string;
    logs: string[];
};

const EXPECTED_TOOLS = [
    "manage_index",
    "search_codebase",
    "architecture_overview",
    "continue_search",
    "call_graph",
    "trace_path",
    "find_references",
    "detect_changes",
    "file_outline",
    "read_file",
    "list_codebases",
    "run_script",
];

const PROVIDER_ENV_KEYS = [
    "EMBEDDING_PROVIDER",
    "OPENAI_API_KEY",
    "VOYAGEAI_API_KEY",
    "SATORI_RERANKER_PROVIDER",
    "SATORI_LATEON_MODEL_PATH",
    "SATORI_LATEON_REQUEST_DEADLINE_MS",
    "SATORI_LATEON_INTRA_OP_THREADS",
    "GEMINI_API_KEY",
    "VECTOR_STORE_PROVIDER",
    "MILVUS_ADDRESS",
    "MILVUS_TOKEN",
    "SATORI_CODEMODE",
    "SATORI_CODEMODE_MCP_CONFIG",
    "SATORI_TOOL_PROFILE",
];

function clearProviderEnv(): Record<string, string | undefined> {
    const saved: Record<string, string | undefined> = {};
    for (const key of PROVIDER_ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    return saved;
}

function restoreProviderEnv(saved: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

async function createSession(runMode: "mcp" | "cli" = "cli"): Promise<InProcessSession> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const pending = new Map<number, (response: JsonRpcResponse) => void>();
    let nextId = 1;
    let stdoutBuffer = "";

    stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
        while (stdoutBuffer.includes("\n")) {
            const newline = stdoutBuffer.indexOf("\n");
            const raw = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!raw) {
                continue;
            }
            const response = JSON.parse(raw) as JsonRpcResponse;
            if (typeof response.id === "number") {
                pending.get(response.id)?.(response);
                pending.delete(response.id);
            }
        }
    });

    const { startMcpServerFromEnv } = await import("./start-server.js");
    const server = await startMcpServerFromEnv({
        runMode,
        protocolStdin: stdin,
        protocolStdout: stdout,
        args: [],
    });
    assert.ok(server);

    const request = async (method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> => {
        const id = nextId++;
        const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timed out waiting for response id=${id}`));
            }, params.name === "run_script" ? 5_000 : 1_000);
            pending.set(id, (response) => {
                clearTimeout(timeout);
                resolve(response);
            });
        });
        stdin.write(JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
        }) + "\n");
        return responsePromise;
    };

    const initialize = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
            name: "satori-startup-test",
            version: "1.0.0",
        },
    });
    assert.equal(initialize.error, undefined);
    stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
    }) + "\n");

    return {
        instructions: initialize.result?.instructions,
        request,
        close: async () => {
            await server.shutdown();
            stdin.destroy();
            stdout.destroy();
        },
    };
}

async function withProviderEnvSession(
    envOverrides: Record<string, string>,
    run: (result: SessionEnvResult) => Promise<void>,
    runMode: "mcp" | "cli" = "cli",
): Promise<void> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-empty-env-"));
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const savedEnv = clearProviderEnv();
    const savedHome = process.env.HOME;
    const savedSessionRoots = process.env.SATORI_SESSION_ROOTS_JSON;
    const originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
    };
    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
        logs.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
    };
    process.env.HOME = homeDir;
    Object.assign(process.env, envOverrides);
    if (process.env.SATORI_SESSION_ROOTS_JSON === undefined) {
        // Authorize the temp workspace so manage_index/search reach their
        // empty-provider behavior instead of being denied by the workspace gate.
        process.env.SATORI_SESSION_ROOTS_JSON = JSON.stringify([tempDir]);
    }
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    let session: InProcessSession | null = null;
    try {
        session = await createSession(runMode);
        await run({ session, tempDir, logs });
    } finally {
        if (session) {
            await session.close();
        }
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        restoreProviderEnv(savedEnv);
        if (savedHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = savedHome;
        }
        if (savedSessionRoots === undefined) {
            delete process.env.SATORI_SESSION_ROOTS_JSON;
        } else {
            process.env.SATORI_SESSION_ROOTS_JSON = savedSessionRoots;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

test("production MCP start leaves provider sync and watcher lazy", async () => {
    const originalStartBackgroundSync = SyncManager.prototype.startBackgroundSync;
    const originalStartWatcherMode = SyncManager.prototype.startWatcherMode;
    let backgroundSyncCalls = 0;
    let watcherCalls = 0;

    SyncManager.prototype.startBackgroundSync = function () {
        backgroundSyncCalls += 1;
    };
    SyncManager.prototype.startWatcherMode = async function () {
        watcherCalls += 1;
    };

    try {
        await withProviderEnvSession({
            MCP_ENABLE_WATCHER: "true",
        }, async () => {
            // Periodic sync/watcher are owned by the embedding ProviderRuntime on first
            // provider-backed tool use, not by the unconfigured local-only SyncManager.
            assert.equal(backgroundSyncCalls, 0);
            assert.equal(watcherCalls, 0);
        }, "mcp");
    } finally {
        SyncManager.prototype.startBackgroundSync = originalStartBackgroundSync;
        SyncManager.prototype.startWatcherMode = originalStartWatcherMode;
    }
});

test("production CLI start leaves provider sync and watcher lazy", async () => {
    const originalStartBackgroundSync = SyncManager.prototype.startBackgroundSync;
    const originalStartWatcherMode = SyncManager.prototype.startWatcherMode;
    let backgroundSyncCalls = 0;
    let watcherCalls = 0;

    SyncManager.prototype.startBackgroundSync = function () {
        backgroundSyncCalls += 1;
    };
    SyncManager.prototype.startWatcherMode = async function () {
        watcherCalls += 1;
    };

    try {
        await withProviderEnvSession({
            MCP_ENABLE_WATCHER: "true",
        }, async () => {
            assert.equal(backgroundSyncCalls, 0);
            assert.equal(watcherCalls, 0);
        });
    } finally {
        SyncManager.prototype.startBackgroundSync = originalStartBackgroundSync;
        SyncManager.prototype.startWatcherMode = originalStartWatcherMode;
    }
});

async function withEmptyEnvSession(run: (session: InProcessSession, tempDir: string) => Promise<void>): Promise<void> {
    await withProviderEnvSession({}, async ({ session, tempDir }) => {
        await run(session, tempDir);
    });
}

function parseToolPayload(response: JsonRpcResponse): ToolPayload {
    assert.equal(response.error, undefined);
    const text = response.result?.content?.find((item) => item?.type === "text")?.text;
    assert.equal(typeof text, "string");
    return JSON.parse(text!) as ToolPayload;
}

function toolNames(response: JsonRpcResponse): string[] {
    return (response.result?.tools || []).map((tool) => tool.name).sort();
}

test("empty provider env still handshakes and lists exactly the twelve MCP tools", async () => {
    await withEmptyEnvSession(async (session) => {
        const response = await session.request("tools/list");
        assert.equal(response.error, undefined);
        const names = toolNames(response);
        assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
    });
});

test("direct stdio executes JavaScript by default and honors the originating read scope", async () => {
    await withProviderEnvSession({}, async ({ session }) => {
        const pure = await session.request("tools/call", {
            name: "run_script",
            arguments: { code: "const values = []; for (let i = 1; i <= 3; i++) values.push(i * i); return { values, process: typeof process, fetch: typeof fetch };" },
        });
        assert.equal(pure.result?.isError, undefined, JSON.stringify(pure));
        assert.equal(pure.result?.content?.[0]?.text,
            '{"values":[1,4,9],"process":"undefined","fetch":"undefined"}');

        const args = { path: "/etc/passwd" };
        const direct = await session.request("tools/call", { name: "read_file", arguments: args });
        assert.equal(direct.result?.isError, true, JSON.stringify(direct));
        const nested = await session.request("tools/call", {
            name: "run_script",
            arguments: { code: `try { return await tools.read_file(${JSON.stringify(args)}); } catch (error) { return error.message; }` },
        });
        assert.equal(nested.result?.isError, undefined);
        assert.equal(nested.result?.content?.[0]?.text, direct.result?.content?.[0]?.text);
    }, "mcp");
});

test("direct stdio advertises seven compact tools and routes specialists through run_script", async () => {
    const specialistNames = ["architecture_overview", "detect_changes", "find_references", "list_codebases", "trace_path"];
    await withProviderEnvSession({ SATORI_TOOL_PROFILE: "compact" }, async ({ session }) => {
        const listed = await session.request("tools/list");
        assert.deepEqual(toolNames(listed), [
            "call_graph", "continue_search", "file_outline", "manage_index", "read_file", "run_script", "search_codebase",
        ]);
        assert.match(session.instructions ?? "", /run_script.*chain related tool calls/);
        const description = listed.result?.tools?.find((tool) => tool.name === "run_script")?.description ?? "";
        for (const name of specialistNames) {
            assert.ok(description.includes(`tools.${name}(`));
            const direct = await session.request("tools/call", { name, arguments: {} });
            assert.equal(direct.result?.isError, true);
            assert.match(direct.result?.content?.[0]?.text ?? "", /within run_script/);
        }

        const nested = await session.request("tools/call", {
            name: "run_script",
            arguments: {
                code: `const names = ALL_TOOLS.filter(tool => tool.description && ${JSON.stringify(specialistNames)}.includes(tool.name)).map(tool => tool.name); return { names, codebases: await tools.list_codebases({}) };`,
            },
        });
        assert.equal(nested.result?.isError, undefined, JSON.stringify(nested));
        const result = parseToolPayload(nested);
        assert.deepEqual(result.names, specialistNames);
        assert.match(String(result.codebases), /No codebases are currently tracked/);
    }, "mcp");
});

test("direct stdio disables both advertisement and dispatch of run_script even with the compact profile set", async () => {
    await withProviderEnvSession({ SATORI_CODEMODE: "0", SATORI_TOOL_PROFILE: "compact" }, async ({ session }) => {
        assert.deepEqual(toolNames(await session.request("tools/list")),
            EXPECTED_TOOLS.filter((name) => name !== "run_script").sort());
        assert.doesNotMatch(session.instructions ?? "", /run_script/);
        const call = await session.request("tools/call", {
            name: "run_script",
            arguments: { code: "return 42;" },
        });
        assert.equal(call.result?.isError, true);
        assert.match(call.result?.content?.[0]?.text ?? "", /^Unknown tool: run_script/);
    }, "mcp");
});

test("configured provider env does not instantiate embedding or Milvus during startup or tools/list", async () => {
    await withProviderEnvSession({
        EMBEDDING_PROVIDER: "VoyageAI",
        VOYAGEAI_API_KEY: "pa-test",
        VECTOR_STORE_PROVIDER: "Milvus",
        MILVUS_ADDRESS: "localhost:19530",
    }, async ({ session, logs }) => {
        const response = await session.request("tools/list");
        assert.equal(response.error, undefined);
        const names = toolNames(response);
        assert.deepEqual(names, [...EXPECTED_TOOLS].sort());

        const joinedLogs = logs.join("\n");
        assert.doesNotMatch(joinedLogs, /\[EMBEDDING\] Creating/);
        assert.doesNotMatch(joinedLogs, /Connecting to Milvus/i);
    });
});

test("manage_index status works with empty provider env for an unindexed path", async () => {
    await withEmptyEnvSession(async (session, tempDir) => {
        const repoDir = path.join(tempDir, "repo");
        fs.mkdirSync(repoDir);

        const response = await session.request("tools/call", {
            name: "manage_index",
            arguments: {
                action: "status",
                path: repoDir,
            },
        });

        const payload = parseToolPayload(response);
        assert.equal(payload.status, "not_indexed");
        assert.equal(payload.reason, "not_indexed");
        assert.equal(payload.code, undefined);

        const nested = await session.request("tools/call", {
            name: "run_script",
            arguments: { code: `return await tools.manage_index({ action: "status", path: ${JSON.stringify(repoDir)} });` },
        });
        assert.equal(nested.result?.isError, undefined, JSON.stringify(nested));
        const nestedPayload = parseToolPayload(nested);
        assert.equal(nestedPayload.status, payload.status);
        assert.equal(nestedPayload.reason, payload.reason);
    });
});

test("production local tools receive the same runtime owner gate", async () => {
    const listCodebases = toolRegistry.list_codebases;
    const manageIndex = toolRegistry.manage_index;
    assert.ok(listCodebases);
    assert.ok(manageIndex);
    const originalListCodebasesExecute = listCodebases.execute;
    const originalManageIndexExecute = manageIndex.execute;
    let listCodebasesGate: ToolContext["runtimeOwnerGate"];
    let manageIndexGate: ToolContext["runtimeOwnerGate"];

    listCodebases.execute = async (args, ctx) => {
        listCodebasesGate = ctx.runtimeOwnerGate;
        return originalListCodebasesExecute(args, ctx);
    };
    manageIndex.execute = async (args, ctx) => {
        manageIndexGate = ctx.runtimeOwnerGate;
        return originalManageIndexExecute(args, ctx);
    };

    try {
        await withEmptyEnvSession(async (session, tempDir) => {
            const repoDir = path.join(tempDir, "repo");
            fs.mkdirSync(repoDir);

            await session.request("tools/call", {
                name: "list_codebases",
                arguments: {},
            });
            await session.request("tools/call", {
                name: "manage_index",
                arguments: {
                    action: "status",
                    path: repoDir,
                },
            });

            assert.ok(listCodebasesGate);
            assert.strictEqual(manageIndexGate, listCodebasesGate);
        });
    } finally {
        listCodebases.execute = originalListCodebasesExecute;
        manageIndex.execute = originalManageIndexExecute;
    }
});

test("manage_index create returns MISSING_PROVIDER_CONFIG with empty provider env", async () => {
    await withEmptyEnvSession(async (session, tempDir) => {
        const repoDir = path.join(tempDir, "repo");
        fs.mkdirSync(repoDir);

        const response = await session.request("tools/call", {
            name: "manage_index",
            arguments: {
                action: "create",
                path: repoDir,
            },
        });

        const payload = parseToolPayload(response);
        assert.equal(payload.status, "error");
        assert.equal(payload.reason, "missing_provider_config");
        assert.equal(payload.code, "MISSING_PROVIDER_CONFIG");
        assert.deepEqual(payload.hints?.setup?.missingEnv, ["VOYAGEAI_API_KEY"]);

        const toolsAfterError = await session.request("tools/list");
        assert.deepEqual(toolNames(toolsAfterError), [...EXPECTED_TOOLS].sort());
    });
});

test("search_codebase returns MISSING_PROVIDER_CONFIG with empty provider env", async () => {
    await withEmptyEnvSession(async (session, tempDir) => {
        const repoDir = path.join(tempDir, "repo");
        fs.mkdirSync(repoDir);

        const response = await session.request("tools/call", {
            name: "search_codebase",
            arguments: {
                path: repoDir,
                query: "authentication flow",
            },
        });

        const payload = parseToolPayload(response);
        assert.equal(payload.status, "not_ready");
        assert.equal(payload.reason, "missing_provider_config");
        assert.equal(payload.code, "MISSING_PROVIDER_CONFIG");
        assert.deepEqual(payload.results, []);
        assert.deepEqual(payload.hints?.setup?.missingEnv, ["VOYAGEAI_API_KEY"]);
    });
});

test("one MCP script call uses only allowed downstream tools and reuses its stdio client", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-script-stdio-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, "fixture.cjs");
    const log = path.join(directory, "requests");
    fs.writeFileSync(fixture, `
        const fs = require("node:fs");
        const input = require("node:readline").createInterface({ input: process.stdin });
        const log = process.argv[2];
        let calls = 0;
        input.on("line", (line) => {
            const { id, method, params } = JSON.parse(line);
            if (id === undefined) return;
            fs.appendFileSync(log, method + "\\n");
            const result = method === "initialize"
                ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
                : { content: [], structuredContent: { value: params.arguments.value * 2, calls: ++calls, secret: Boolean(process.env.VOYAGEAI_API_KEY) } };
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
        });
        input.on("close", () => fs.appendFileSync(log, "closed\\n"));
    `);
    const configPath = path.join(directory, "servers.json");
    fs.writeFileSync(configPath, JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: [fixture, log], allowedTools: ["double.value"] } },
    }));
    await withProviderEnvSession({
        SATORI_CODEMODE_MCP_CONFIG: configPath,
        VOYAGEAI_API_KEY: "fixture-secret",
    }, async ({ session }) => {
        const response = await session.request("tools/call", {
            name: "run_script",
            arguments: { code: `
                const first = await tools["fixture__double.value"]({value: 3});
                const second = await tools["fixture__double.value"]({value: first.value});
                let denied = false;
                try { await tools.fixture__undeclared({}); } catch { denied = true; }
                return { ...second, denied };
            ` },
        });
        assert.equal(response.result?.isError, undefined, JSON.stringify(response));
        assert.deepEqual(parseToolPayload(response), { value: 12, calls: 2, secret: false, denied: true });
        assert.equal(fs.readFileSync(log, "utf8"), "initialize\ntools/call\ntools/call\nclosed\n");
    });
});
