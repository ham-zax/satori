import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CliError } from "./errors.js";
import { isExecutedDirectlyForPaths, runCli } from "./index.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SERVER_ENTRY = path.resolve(PACKAGE_ROOT, "..", "mcp", "src", "index.ts");
const RUN_LIVE_SERVER_SMOKE = process.env.SATORI_RUN_LIVE_SERVER_SMOKE === "1";
const BLOCK_LANCEDB_NATIVE_FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "test-fixtures",
    "block-lancedb-native.cjs",
);

function captureIo() {
    let stdout = "";
    let stderr = "";
    return {
        writeStdout: (text: string) => {
            stdout += text;
        },
        writeStderr: (text: string) => {
            stderr += text;
        },
        read: () => ({ stdout, stderr }),
    };
}

function createMockSession(mode: "normal" | "envelope" | "timeout_error" | "manage_wait" | "manage_initial_error" | "manage_initial_blocked" = "normal") {
    let statusPolls = 0;
    return {
        async listTools() {
            return {
                tools: [
                    {
                        name: "manage_index",
                        description: "manage",
                        inputSchema: {
                            type: "object",
                            properties: {
                                action: { type: "string", enum: ["create", "reindex", "status"] },
                                path: { type: "string" }
                            },
                            required: ["action", "path"]
                        }
                    },
                    {
                        name: "search_codebase",
                        description: "search",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: { type: "string" },
                                query: { type: "string" },
                                debug: { type: "boolean" }
                            },
                            required: ["path", "query"]
                        }
                    }
                ]
            };
        },
        async callTool(name: string, args: Record<string, unknown>) {
            if (mode === "timeout_error" && name === "search_codebase") {
                throw new CliError("E_CALL_TIMEOUT", "Timed out after 200ms while calling tools/call for 'search_codebase'.", 3);
            }
            if (mode === "envelope") {
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify({ status: "not_ready", reason: "indexing" }) }]
                };
            }
            if (mode === "manage_wait" && name === "manage_index") {
                if (args.action === "create" || args.action === "reindex") {
                    return { isError: false, content: [{ type: "text", text: "started indexing" }] };
                }
                if (args.action === "status") {
                    statusPolls += 1;
                    if (statusPolls < 3) {
                        return { isError: false, content: [{ type: "text", text: "🔄 Codebase '/repo' is currently being indexed." }] };
                    }
                    return { isError: false, content: [{ type: "text", text: `✅ Codebase '/repo' is fully indexed and ready for search. polls=${statusPolls}` }] };
                }
            }
            if (mode === "manage_initial_error" && name === "manage_index" && (args.action === "create" || args.action === "reindex")) {
                return { isError: true, content: [{ type: "text", text: "create failed immediately" }] };
            }
            if (mode === "manage_initial_blocked" && name === "manage_index") {
                if (args.action === "create" || args.action === "reindex") {
                    return {
                        isError: false,
                        content: [{ type: "text", text: JSON.stringify({ status: "not_ready", reason: "indexing" }) }]
                    };
                }
                if (args.action === "status") {
                    return { isError: false, content: [{ type: "text", text: "POLLED_STATUS_SHOULD_NOT_HAPPEN" }] };
                }
            }
            return {
                isError: false,
                content: [{ type: "text", text: JSON.stringify({ status: "ok", tool: name, args }) }]
            };
        },
        async close() {
            return;
        }
    };
}

function fakeInstallRuntimeCommand(homeDir: string) {
    return {
        command: process.execPath,
        args: [path.join(homeDir, ".satori", "mcp-runtime", "fake", "node_modules", "@zokizuan", "satori-mcp", "dist", "index.js")],
    };
}

test("runCli tools list succeeds and emits JSON to stdout", async () => {
    const io = captureIo();

    const exitCode = await runCli(["tools", "list"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("normal"),
        startupTimeoutMs: 10000,
        callTimeoutMs: 10000,
    });

    const { stdout } = io.read();
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout);
    const toolNames = parsed.tools.map((tool: { name: string }) => tool.name);
    assert.equal(toolNames.includes("manage_index"), true);
    assert.equal(toolNames.includes("search_codebase"), true);
});

test("runCli fails with deterministic protocol error when session connection fails", async () => {
    const io = captureIo();

    const exitCode = await runCli(["tools", "list"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => {
            throw new Error("Connection closed");
        },
        startupTimeoutMs: 10000,
        callTimeoutMs: 10000,
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 3);
    assert.equal(stderr.includes("E_PROTOCOL_FAILURE"), true);
    assert.equal(stdout.trim().length, 0);
});

test("runCli treats structured non-ok envelope as tool error even when isError=false", async () => {
    const io = captureIo();

    const exitCode = await runCli(["search_codebase", "--path", "/repo", "--query", "auth"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("envelope"),
        startupTimeoutMs: 10000,
        callTimeoutMs: 10000,
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 1);
    assert.equal(stderr.includes("E_TOOL_ERROR"), true);
    assert.equal(stderr.includes("status=not_ready"), true);
    assert.equal(stderr.includes("reason=indexing"), true);
    const wrapped = JSON.parse(stdout);
    const compactEnvelope = wrapped.content[0].text;
    assert.equal(compactEnvelope, "{\"status\":\"not_ready\",\"reason\":\"indexing\"}");
    assert.doesNotMatch(compactEnvelope, /\n\s+"/);
});

test("runCli install updates config and emits the bounded postflight receipt", async () => {
    const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-install-home-"));
    const io = captureIo();

    try {
        const exitCode = await runCli(["install", "--client", "codex"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { ...process.env, HOME: homeDir },
            installabilityVerifier: () => "@zokizuan/satori-mcp@4.4.1",
            installPreflightRunner: async () => ({
                runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
            }),
            installRuntimeCommand: fakeInstallRuntimeCommand(homeDir),
            installPostflightRunner: async ({ homeDir: verifiedHome }) => {
                assert.equal(verifiedHome, homeDir);
                return {
                    status: "ok",
                    checks: [{ name: "launcher", status: "ok", message: "verified" }],
                };
            },
            serverCommand: process.execPath,
            serverArgs: ["/path/that/does/not/exist.mjs"],
            startupTimeoutMs: 100,
            callTimeoutMs: 100,
        });

        const { stdout } = io.read();
        assert.equal(exitCode, 0);
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.action, "install");
        assert.equal(parsed.client, "codex");
        assert.equal(parsed.postflight.status, "ok");
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli install dry-run performs no package, LanceDB, Ollama, or filesystem work", async () => {
    for (const argv of [
        ["install", "--client", "all", "--runtime", "voyage", "--dry-run"],
        ["install", "--runtime", "offline", "--ollama-model", "nomic-embed-text", "--dry-run"],
    ]) {
        const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-install-dry-run-home-"));
        const io = captureIo();
        let installabilityCalls = 0;
        let preflightCalls = 0;
        try {
            const before = fs.readdirSync(homeDir);
            const exitCode = await runCli(argv, {
                writeStdout: io.writeStdout,
                writeStderr: io.writeStderr,
                env: { ...process.env, HOME: homeDir },
                diagnosticsPath: null,
                installabilityVerifier: () => {
                    installabilityCalls += 1;
                    return "@zokizuan/satori-mcp@4.4.1";
                },
                installPreflightRunner: async () => {
                    preflightCalls += 1;
                    throw new Error("dry-run must not preflight");
                },
            });

            assert.equal(exitCode, 0);
            assert.equal(installabilityCalls, 0);
            assert.equal(preflightCalls, 0);
            assert.deepEqual(fs.readdirSync(homeDir), before);
            assert.equal(fs.existsSync(path.join(homeDir, ".satori", "vector")), false);
            assert.equal(fs.existsSync(path.join(homeDir, ".satori", "bin")), false);
            assert.equal(fs.existsSync(path.join(homeDir, ".codex")), false);
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    }
});

test("runCli connected dry-run rejects an invalid static vector-store selection", async () => {
    const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-install-dry-run-invalid-home-"));
    const io = captureIo();
    let preflightCalls = 0;
    try {
        const exitCode = await runCli(["install", "--runtime", "voyage", "--dry-run"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { HOME: homeDir, VECTOR_STORE_PROVIDER: "Typo" },
            diagnosticsPath: null,
            installPreflightRunner: async () => {
                preflightCalls += 1;
                throw new Error("dry-run must not preflight");
            },
        });

        assert.equal(exitCode, 2);
        assert.equal(preflightCalls, 0);
        const output = io.read();
        assert.match(`${output.stdout}\n${output.stderr}`, /VECTOR_STORE_PROVIDER must be Milvus or LanceDB/);
        assert.deepEqual(fs.readdirSync(homeDir), []);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("non-LanceDB CLI commands start when the native module is unavailable", () => {
    const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-no-lancedb-native-home-"));
    const indexUrl = pathToFileURL(path.join(PACKAGE_ROOT, "src", "index.ts")).href;
    const script = `
        const { runCli } = await import(${JSON.stringify(indexUrl)});
        const output = { writeStdout() {}, writeStderr() {}, diagnosticsPath: null, env: { HOME: ${JSON.stringify(homeDir)} } };
        if (await runCli(["help"], output) !== 0) process.exit(11);
        if (await runCli(["version"], output) !== 0) process.exit(12);
        if (await runCli(["uninstall", "--client", "codex", "--dry-run"], output) !== 0) process.exit(13);
        if (await runCli(["doctor"], {
            ...output,
            doctorRunner: async () => ({
                status: "warning",
                packageVersions: [],
                packageVersionNote: "test",
                checks: [],
                nextSteps: [],
                localDiagnostics: { eventsRead: 0 },
            }),
        }) !== 0) process.exit(14);
    `;
    try {
        const result = spawnSync(process.execPath, [
            "--require",
            BLOCK_LANCEDB_NATIVE_FIXTURE,
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            script,
        ], {
            cwd: path.resolve(PACKAGE_ROOT, "..", ".."),
            encoding: "utf8",
            env: { ...process.env, HOME: homeDir },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /SATORI_TEST_LANCEDB_NATIVE_UNAVAILABLE/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli doctor emits diagnostics without starting an MCP session", async () => {
    const io = captureIo();

    const exitCode = await runCli(["doctor"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        env: { ...process.env, VOYAGEAI_API_KEY: "", MILVUS_ADDRESS: "" },
        doctorRunner: ({ env }) => ({
            status: env.MILVUS_ADDRESS ? "ok" : "error",
            packageVersions: [
                { name: "@zokizuan/satori-cli", version: "0.0.0", source: "test" },
            ],
            packageVersionNote: "independent package versions",
            checks: [
                { name: "node_version", status: "ok", message: "Node is supported." },
                { name: "milvus_address", status: "error", message: "MILVUS_ADDRESS is required." }
            ],
            nextSteps: ["Set MILVUS_ADDRESS."],
            localDiagnostics: {
                schemaVersion: "v1", storage: "local_only",
                privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
                eventsRead: 0, malformedEventsSkipped: 0, totalDurationMs: 0,
                toolCalls: [], warningCodes: [], fallbackUses: 0, lifecycleOutcomes: [],
                recovery: { attempts: 0, successes: 0 },
            },
        }),
        connectSession: async () => {
            throw new Error("doctor should not connect to MCP");
        },
    });

    const { stdout } = io.read();
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.status, "error");
    assert.equal(parsed.checks[1].name, "milvus_address");
});

test("runCli records only privacy-safe local measurements for direct tool calls", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-diagnostics-home-"));
    const io = captureIo();
    try {
        const exitCode = await runCli([
            "tool",
            "call",
            "search_codebase",
            "--args-json",
            JSON.stringify({ path: "/private/repository", query: "SecretOwner" }),
        ], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { HOME: homeDir },
            diagnosticsPath: path.join(homeDir, ".satori", "diagnostics", "events.jsonl"),
            nowMs: (() => {
                const values = [100, 125];
                return () => values.shift() ?? 125;
            })(),
            connectSession: async () => ({
                async listTools() { return { tools: [] }; },
                async callTool() {
                    return {
                        isError: false,
                        content: [{ type: "text", text: JSON.stringify({
                            status: "ok",
                            results: [{ file: "src/private.ts" }],
                            warnings: [{ code: "RERANKER_FAILED" }],
                        }) }],
                    };
                },
                async close() { return; },
            }),
        });

        assert.equal(exitCode, 0);
        const log = fs.readFileSync(path.join(homeDir, ".satori", "diagnostics", "events.jsonl"), "utf8");
        assert.match(log, /"durationMs":25/);
        assert.match(log, /RERANKER_FAILED/);
        assert.doesNotMatch(log, /private|SecretOwner|query|path|symbol/i);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli doctor text mode prints next steps to stderr", async () => {
    const io = captureIo();

    const exitCode = await runCli(["--format", "text", "doctor"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        env: { ...process.env },
        doctorRunner: () => ({
            status: "warning",
            packageVersions: [
                { name: "@zokizuan/satori-cli", version: "0.0.0", source: "test" },
            ],
            packageVersionNote: "independent package versions",
            checks: [
                { name: "milvus_token", status: "warning", message: "optional token missing" }
            ],
            nextSteps: ["Verify npm can access @zokizuan/satori-mcp from this machine."],
            localDiagnostics: {
                schemaVersion: "v1", storage: "local_only",
                privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
                eventsRead: 0, malformedEventsSkipped: 0, totalDurationMs: 0,
                toolCalls: [], warningCodes: [], fallbackUses: 0, lifecycleOutcomes: [],
                recovery: { attempts: 0, successes: 0 },
            },
        }),
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout).status, "warning");
    assert.equal(stderr.includes("satori-cli doctor status=warning"), true);
    assert.equal(stderr.includes("next: Verify npm can access"), true);
});

test("runCli install fails preflight with explicit package guidance before writing config", async () => {
    const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-install-preflight-home-"));
    const io = captureIo();

    try {
        const exitCode = await runCli(["install", "--client", "codex"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { ...process.env, HOME: homeDir },
            installabilityVerifier: () => {
                throw new Error("Cannot install @zokizuan/satori-mcp@4.4.1 because required dependency @zokizuan/satori-core@1.1.1 is not published on npm.");
            },
            startupTimeoutMs: 100,
            callTimeoutMs: 100,
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 3);
        assert.equal(stdout.trim(), "");
        assert.equal(stderr.includes("@zokizuan/satori-core@1.1.1 is not published on npm"), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli uninstall supports dry-run without writing files", async () => {
    const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-uninstall-home-"));
    const io = captureIo();

    try {
        const exitCode = await runCli(["uninstall", "--client", "claude", "--dry-run"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { ...process.env, HOME: homeDir },
            serverCommand: process.execPath,
            serverArgs: ["/path/that/does/not/exist.mjs"],
            startupTimeoutMs: 100,
            callTimeoutMs: 100,
        });

        const { stdout } = io.read();
        assert.equal(exitCode, 0);
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.action, "uninstall");
        assert.equal(parsed.client, "claude");
        assert.equal(parsed.dryRun, true);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude.json")), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli returns the initial manage_index create kickoff response without polling status", async () => {
    const io = captureIo();

    const exitCode = await runCli([
        "--call-timeout-ms",
        "10000",
        "manage_index",
        "--action",
        "create",
        "--path",
        "/repo"
    ], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("manage_wait"),
        startupTimeoutMs: 10000,
        callTimeoutMs: 10000,
    });

    const { stdout } = io.read();
    assert.equal(exitCode, 0);
    assert.equal(stdout.includes("started indexing"), true);
    assert.equal(stdout.includes("fully indexed"), false);
    assert.equal(stdout.includes("polls=3"), false);
});

test("runCli does not wait on manage_index create/reindex under low call-timeout overrides", async () => {
    const io = captureIo();

    const exitCode = await runCli([
        "--call-timeout-ms",
        "200",
        "manage_index",
        "--action",
        "create",
        "--path",
        "/repo"
    ], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("manage_wait"),
        startupTimeoutMs: 10_000,
        callTimeoutMs: 200,
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 0);
    assert.equal(stderr.includes("E_CALL_TIMEOUT"), false);
    assert.equal(stdout.includes("started indexing"), true);
    assert.equal(stdout.includes("fully indexed"), false);
    assert.equal(stdout.includes("polls=3"), false);
});

test("runCli emits deterministic JSON error payload for tool-call timeout instead of empty stdout", async () => {
    const io = captureIo();

    const exitCode = await runCli([
        "--call-timeout-ms",
        "200",
        "search_codebase",
        "--path",
        "/repo",
        "--query",
        "auth"
    ], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("timeout_error"),
        startupTimeoutMs: 10_000,
        callTimeoutMs: 200,
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 3);
    assert.equal(stderr.includes("E_CALL_TIMEOUT"), true);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed?.isError, true);
    assert.match(parsed?.content?.[0]?.text || "", /E_CALL_TIMEOUT/);
});

test("runCli forwards wrapper --debug to tool arguments instead of consuming it globally", async () => {
    const io = captureIo();

    const exitCode = await runCli(["search_codebase", "--path", "/repo", "--query", "auth", "--debug"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("normal"),
        startupTimeoutMs: 10000,
        callTimeoutMs: 10000,
    });

    const { stdout } = io.read();
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(stdout);
    const contentText = parsed?.content?.[0]?.text as string;
    const payload = JSON.parse(contentText);
    assert.equal(payload?.args?.debug, true);
});

test("runCli returns initial manage_index create error without polling status", async () => {
    const io = captureIo();

    const exitCode = await runCli(["manage_index", "--action", "create", "--path", "/repo"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("manage_initial_error"),
        startupTimeoutMs: 10000,
        callTimeoutMs: 10000,
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 1);
    assert.equal(stderr.includes("E_TOOL_ERROR"), true);
    assert.equal(stdout.includes("create failed immediately"), true);
});

test("runCli exits on initial manage_index blocked envelope without polling status", async () => {
    const io = captureIo();

    const exitCode = await runCli(["manage_index", "--action", "create", "--path", "/repo"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        connectSession: async () => createMockSession("manage_initial_blocked"),
        startupTimeoutMs: 10000,
        callTimeoutMs: 10000,
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 1);
    assert.equal(stderr.includes("E_TOOL_ERROR"), true);
    assert.equal(stderr.includes("status=not_ready"), true);
    assert.equal(stdout.includes("POLLED_STATUS_SHOULD_NOT_HAPPEN"), false);
});

if (RUN_LIVE_SERVER_SMOKE) {
    test("protocol smoke: real server in cli mode with default guard serves tools/list", { timeout: 60_000 }, async () => {
        const io = captureIo();

        const exitCode = await runCli(["tools", "list"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverCommand: process.execPath,
            serverArgs: ["--import", "tsx", SOURCE_SERVER_ENTRY],
            serverEnv: {
                EMBEDDING_PROVIDER: "Ollama",
                EMBEDDING_MODEL: "nomic-embed-text",
                OLLAMA_HOST: "http://127.0.0.1:11434",
                MILVUS_ADDRESS: "localhost:19530",
                MCP_ENABLE_WATCHER: "false",
                // Force default guard behavior in test regardless of parent env.
                SATORI_CLI_STDOUT_GUARD: "",
            },
            cwd: PACKAGE_ROOT,
            startupTimeoutMs: 30_000,
            callTimeoutMs: 30_000,
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 0);
        assert.equal(stderr.includes("E_PROTOCOL_FAILURE"), false);

        const parsed = JSON.parse(stdout) as { tools?: Array<{ name?: string }> };
        assert.equal(Array.isArray(parsed.tools), true);
        const toolNames = (parsed.tools || [])
            .map((tool) => tool?.name)
            .filter((name): name is string => typeof name === "string");
        assert.equal(toolNames.includes("manage_index"), true);
        assert.equal(toolNames.includes("search_codebase"), true);
    });

    test("runCli default server launch works when executing source cli entry", { timeout: 60_000 }, async () => {
        const io = captureIo();

        const exitCode = await runCli(["tools", "list"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            serverEnv: {
                EMBEDDING_PROVIDER: "Ollama",
                EMBEDDING_MODEL: "nomic-embed-text",
                OLLAMA_HOST: "http://127.0.0.1:11434",
                MILVUS_ADDRESS: "localhost:19530",
                MCP_ENABLE_WATCHER: "false",
                SATORI_CLI_STDOUT_GUARD: "",
            },
            cwd: PACKAGE_ROOT,
            startupTimeoutMs: 30_000,
            callTimeoutMs: 30_000,
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 0);
        assert.equal(stderr.includes("E_PROTOCOL_FAILURE"), false);

        const parsed = JSON.parse(stdout) as { tools?: Array<{ name?: string }> };
        assert.equal(Array.isArray(parsed.tools), true);
    });
}

test("isExecutedDirectlyForPaths treats symlinked bin path as direct execution", () => {
    const tempDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-cli-symlink-"));
    const realFilePath = path.join(tempDir, "real-entry.js");
    const symlinkPath = path.join(tempDir, "symlink-entry.js");
    fs.writeFileSync(realFilePath, "console.log('noop');", "utf8");
    fs.symlinkSync(realFilePath, symlinkPath);

    try {
        const moduleUrl = pathToFileURL(realFilePath).href;
        assert.equal(isExecutedDirectlyForPaths(moduleUrl, symlinkPath), true);
        assert.equal(isExecutedDirectlyForPaths(moduleUrl, path.join(tempDir, "different.js")), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
