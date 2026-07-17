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
    request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcResponse>;
    close: () => Promise<void>;
};

type JsonRpcResponse = {
    id?: unknown;
    error?: unknown;
    result?: {
        content?: Array<{ type?: string; text?: string }>;
        tools?: Array<{ name: string }>;
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
    "call_graph",
    "file_outline",
    "read_file",
    "list_codebases",
];

const PROVIDER_ENV_KEYS = [
    "EMBEDDING_PROVIDER",
    "OPENAI_API_KEY",
    "VOYAGEAI_API_KEY",
    "GEMINI_API_KEY",
    "MILVUS_ADDRESS",
    "MILVUS_TOKEN",
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
            }, 1000);
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
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

test("production MCP start invokes recovery without local-only background sync or watcher", async () => {
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
        }, async ({ logs }) => {
            assert.equal(logs.filter((line) => line.includes("[STARTUP] Verifying interrupted indexing state")).length, 1);
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

test("production CLI start invokes recovery only", async () => {
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
        }, async ({ logs }) => {
            assert.equal(logs.filter((line) => line.includes("[STARTUP] Verifying interrupted indexing state")).length, 1);
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
    return JSON.parse(text) as ToolPayload;
}

function toolNames(response: JsonRpcResponse): string[] {
    return (response.result?.tools || []).map((tool) => tool.name).sort();
}

test("empty provider env still handshakes and lists exactly the six MCP tools", async () => {
    await withEmptyEnvSession(async (session) => {
        const response = await session.request("tools/list");
        assert.equal(response.error, undefined);
        const names = toolNames(response);
        assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
    });
});

test("configured provider env does not instantiate embedding or Milvus during startup or tools/list", async () => {
    await withProviderEnvSession({
        EMBEDDING_PROVIDER: "VoyageAI",
        VOYAGEAI_API_KEY: "pa-test",
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
