import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CallToolResult, ListToolsResult } from "./client.js";
import type { DoctorResult } from "./doctor.js";
import { CliError } from "./errors.js";
import { isExecutedDirectlyForPaths, runCli } from "./index.js";
import { CliUpgradeDelegationStartError } from "./upgrade.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PACKAGE_VERSION = (
    JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
).version;
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

interface MockCliSession {
    listTools(): Promise<ListToolsResult>;
    callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
    close(): Promise<void>;
}

function createMockSession(mode: "normal" | "envelope" | "timeout_error" | "manage_wait" | "manage_initial_error" | "manage_initial_blocked" = "normal"): MockCliSession {
    let statusPolls = 0;
    return {
        async listTools(): Promise<ListToolsResult> {
            return {
                tools: [
                    {
                        name: "manage_index",
                        description: "manage",
                        inputSchema: {
                            type: "object" as const,
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
                            type: "object" as const,
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
        async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
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
                    if (statusPolls === 1) {
                        return { isError: false, content: [{ type: "text", text: "🔄 Codebase '/repo' is currently being indexed." }] };
                    }
                    if (statusPolls === 2) {
                        return {
                            isError: false,
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    status: "not_ready",
                                    reason: "indexing",
                                    operation: { phase: "completed" },
                                }),
                            }],
                        };
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

test("runCli defaults to human help and preserves structured help on request", async () => {
    const io = captureIo();
    const exitCode = await runCli([], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        diagnosticsPath: null,
    });

    assert.equal(exitCode, 0);
    assert.match(io.read().stdout, /^Satori\n[\s\S]*Get started:\n {2}satori install --client all/m);
    assert.doesNotMatch(io.read().stdout, /satori-cli|legacy/i);
    assert.equal(io.read().stderr, "");

    const jsonIo = captureIo();
    const jsonExitCode = await runCli(["--format", "json", "--help"], {
        writeStdout: jsonIo.writeStdout,
        writeStderr: jsonIo.writeStderr,
        diagnosticsPath: null,
    });
    assert.equal(jsonExitCode, 0);
    const help = JSON.parse(jsonIo.read().stdout);
    assert.equal(help.usage, "satori <command>");
    assert.equal("legacyAlias" in help, false);
});

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

test("runCli tool commands use the installed managed launcher by default", async () => {
    const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-managed-cli-home-"));
    const managedLauncherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const io = captureIo();
    let observedCommand: string | undefined;
    let observedArgs: string[] | undefined;

    try {
        fs.mkdirSync(path.dirname(managedLauncherPath), { recursive: true });
        fs.writeFileSync(managedLauncherPath, "// fixture managed launcher\n");

        const exitCode = await runCli(["tools", "list"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { ...process.env, HOME: homeDir },
            connectSession: async (options) => {
                observedCommand = options.command;
                observedArgs = options.args;
                return createMockSession("normal");
            },
            startupTimeoutMs: 10000,
            callTimeoutMs: 10000,
        });

        assert.equal(exitCode, 0);
        assert.equal(observedCommand, process.execPath);
        assert.deepEqual(observedArgs, [managedLauncherPath]);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
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

test("runCli install updates config and emits a quiet human summary", async () => {
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
            installPostflightRunner: async ({ homeDir: verifiedHome, writeStderr }) => {
                assert.equal(verifiedHome, homeDir);
                writeStderr("[MCP] noisy startup detail\n");
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

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 0);
        assert.match(stdout, /^Satori installed/m);
        assert.match(stdout, /Runtime: Connected/);
        assert.match(stdout, /Client: Codex/);
        assert.match(stdout, /Verification: passed \(1 check\)/);
        assert.match(stdout, /Restart Codex to load Satori/);
        assert.equal(stderr, "");
        assert.doesNotMatch(stdout, /noisy startup detail|runtimeEnvironment|configPath/);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli upgrade updates the global CLI before delegating runtime activation", async () => {
    const io = captureIo();
    let runtimeUpgradeCalls = 0;
    let delegated = false;
    const exitCode = await runCli(["upgrade"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        diagnosticsPath: null,
        env: { HOME: "/home/test" },
        invokedScriptPath: "/global/bin/satori",
        upgradeTargetResolver: () => ({
            cliPackageSpecifier: "@zokizuan/satori-cli@99.0.0",
            cliVersion: "99.0.0",
            mcpPackageSpecifier: "@zokizuan/satori-mcp@99.0.0",
            mcpVersion: "99.0.0",
            coreVersion: "99.0.0",
        }),
        globalCliUpgradeRunner: (input) => {
            delegated = true;
            assert.equal(input.currentCliVersion, CLI_PACKAGE_VERSION);
            assert.equal(input.invokedScriptPath, "/global/bin/satori");
            assert.deepEqual(input.delegatedArgs, ["upgrade"]);
            return 0;
        },
        managedRuntimeUpgradeRunner: async () => {
            runtimeUpgradeCalls += 1;
            throw new Error("old CLI must not activate a newer runtime");
        },
    });

    assert.equal(exitCode, 0);
    assert.equal(delegated, true);
    assert.equal(runtimeUpgradeCalls, 0);
    assert.deepEqual(io.read(), {
        stdout: "",
        stderr: [
            "Checking latest Satori release...",
            `Updating CLI ${CLI_PACKAGE_VERSION} → 99.0.0...`,
            "",
        ].join("\n"),
    });
});

test("runCli upgrade reports the complete CLI, MCP, and Core result", async () => {
    const io = captureIo();
    const exitCode = await runCli(["upgrade"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        diagnosticsPath: null,
        env: {
            HOME: "/home/test",
            SATORI_UPGRADE_DELEGATED_TARGET: CLI_PACKAGE_VERSION,
            SATORI_UPGRADE_FROM_CLI_VERSION: "1.2.0",
        },
        upgradeTargetResolver: () => ({
            cliPackageSpecifier: `@zokizuan/satori-cli@${CLI_PACKAGE_VERSION}`,
            cliVersion: CLI_PACKAGE_VERSION,
            mcpPackageSpecifier: "@zokizuan/satori-mcp@6.2.0",
            mcpVersion: "6.2.0",
            coreVersion: "3.1.0",
        }),
        managedRuntimeUpgradeRunner: async (_target, options) => {
            options.onUpgradeProgress?.("installing");
            options.onUpgradeProgress?.("verifying");
            options.onUpgradeProgress?.("activating");
            return {
                action: "upgrade",
                status: "upgraded",
                fromMcpVersion: "6.1.0",
                toMcpVersion: "6.2.0",
                fromCoreVersion: "3.0.0",
                toCoreVersion: "3.1.0",
                packageSpecifier: "@zokizuan/satori-mcp@6.2.0",
                configuredClients: ["codex"],
                restartRequired: true,
            };
        },
    });

    assert.equal(exitCode, 0);
    const output = io.read();
    assert.match(output.stdout, /^Satori upgraded/m);
    assert.match(output.stdout, new RegExp(`CLI: 1\\.2\\.0 → ${CLI_PACKAGE_VERSION.replace(/\./g, "\\.")}`));
    assert.match(output.stdout, /MCP runtime: 6\.1\.0 → 6\.2\.0/);
    assert.match(output.stdout, /Core: 3\.0\.0 → 3\.1\.0/);
    assert.match(output.stdout, /Restart Codex/);
    assert.equal(output.stderr, [
        "Checking latest Satori release...",
        "Installing MCP 6.2.0 and Core 3.1.0...",
        "Verifying candidate runtime...",
        "Activating verified runtime...",
        "",
    ].join("\n"));
});

test("runCli reports a completed CLI update separately when runtime activation fails", async () => {
    const io = captureIo();
    const exitCode = await runCli(["--format", "json", "upgrade"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        diagnosticsPath: null,
        env: {
            HOME: "/home/test",
            SATORI_UPGRADE_DELEGATED_TARGET: CLI_PACKAGE_VERSION,
            SATORI_UPGRADE_FROM_CLI_VERSION: "1.2.0",
        },
        upgradeTargetResolver: () => ({
            cliPackageSpecifier: `@zokizuan/satori-cli@${CLI_PACKAGE_VERSION}`,
            cliVersion: CLI_PACKAGE_VERSION,
            mcpPackageSpecifier: "@zokizuan/satori-mcp@6.2.0",
            mcpVersion: "6.2.0",
            coreVersion: "3.1.0",
        }),
        managedRuntimeUpgradeRunner: async () => {
            throw new CliError("E_INSTALL_PREFLIGHT", "candidate runtime rejected", 1);
        },
    });

    assert.equal(exitCode, 1);
    const output = io.read();
    const receipt = JSON.parse(output.stdout);
    assert.equal(receipt.action, "upgrade");
    assert.equal(receipt.status, "error");
    assert.equal(receipt.cliUpgrade, "completed");
    assert.equal(receipt.runtimeUpgrade, "failed");
    assert.equal(receipt.launcherChanged, false);
    assert.equal(receipt.fromCliVersion, "1.2.0");
    assert.equal(receipt.toCliVersion, CLI_PACKAGE_VERSION);
    assert.equal(receipt.error.token, "E_INSTALL_PREFLIGHT");
    assert.doesNotMatch(output.stderr, /Checking latest|Installing MCP|Verifying candidate|Activating verified/);
    assert.match(output.stderr, /CLI .* is installed.*managed launcher remains unchanged/s);
});

test("runCli reports the installed CLI version when delegated upgrade cannot start", async () => {
    const io = captureIo();
    const exitCode = await runCli(["--format", "json", "upgrade"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        diagnosticsPath: null,
        env: { HOME: "/home/test" },
        upgradeTargetResolver: () => ({
            cliPackageSpecifier: "@zokizuan/satori-cli@1.4.0",
            cliVersion: "1.4.0",
            mcpPackageSpecifier: "@zokizuan/satori-mcp@6.3.0",
            mcpVersion: "6.3.0",
            coreVersion: "3.2.0",
        }),
        globalCliUpgradeRunner: () => {
            throw new CliUpgradeDelegationStartError(
                CLI_PACKAGE_VERSION,
                "1.4.0",
                "Global CLI updated to 1.4.0, but the upgraded command could not start: EAGAIN",
            );
        },
    });

    assert.equal(exitCode, 1);
    const output = io.read();
    const receipt = JSON.parse(output.stdout);
    assert.equal(receipt.action, "upgrade");
    assert.equal(receipt.status, "error");
    assert.equal(receipt.cliUpgrade, "completed");
    assert.equal(receipt.runtimeUpgrade, "failed");
    assert.equal(receipt.launcherChanged, false);
    assert.equal(receipt.fromCliVersion, CLI_PACKAGE_VERSION);
    assert.equal(receipt.toCliVersion, "1.4.0");
    assert.equal(receipt.error.token, "E_UPGRADE");
    assert.match(receipt.error.message, /CLI updated to 1\.4\.0.*could not start.*EAGAIN/s);
    assert.match(output.stderr, /E_UPGRADE Global CLI updated to 1\.4\.0.*could not start.*EAGAIN/s);
});

test("runCli update alias preserves the structured upgrade receipt", async () => {
    const io = captureIo();
    const exitCode = await runCli(["--format", "json", "update"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        diagnosticsPath: null,
        env: { HOME: "/home/test" },
        upgradeTargetResolver: () => ({
            cliPackageSpecifier: `@zokizuan/satori-cli@${CLI_PACKAGE_VERSION}`,
            cliVersion: CLI_PACKAGE_VERSION,
            mcpPackageSpecifier: "@zokizuan/satori-mcp@6.2.0",
            mcpVersion: "6.2.0",
            coreVersion: "3.1.0",
        }),
        managedRuntimeUpgradeRunner: async () => ({
            action: "upgrade",
            status: "up_to_date",
            fromMcpVersion: "6.2.0",
            toMcpVersion: "6.2.0",
            fromCoreVersion: "3.1.0",
            toCoreVersion: "3.1.0",
            packageSpecifier: "@zokizuan/satori-mcp@6.2.0",
            configuredClients: [],
            restartRequired: false,
        }),
    });

    assert.equal(exitCode, 0);
    const result = JSON.parse(io.read().stdout);
    assert.equal(result.action, "upgrade");
    assert.equal(result.status, "up_to_date");
    assert.equal(result.fromCliVersion, CLI_PACKAGE_VERSION);
    assert.equal(result.toCliVersion, CLI_PACKAGE_VERSION);
});

test("runCli install preserves the structured receipt when JSON is requested", async () => {
    const homeDir = fs.mkdtempSync(path.join(PACKAGE_ROOT, ".tmp-install-json-home-"));
    const io = captureIo();

    try {
        const exitCode = await runCli(["--format", "json", "install", "--client", "codex"], {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            env: { ...process.env, HOME: homeDir },
            installabilityVerifier: () => "@zokizuan/satori-mcp@4.4.1",
            installPreflightRunner: async () => ({
                runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "offline" }),
            }),
            installRuntimeCommand: fakeInstallRuntimeCommand(homeDir),
            installPostflightRunner: async () => ({
                status: "ok",
                checks: [{ name: "launcher", status: "ok", message: "verified" }],
            }),
        });

        assert.equal(exitCode, 0);
        const parsed = JSON.parse(io.read().stdout);
        assert.equal(parsed.action, "install");
        assert.equal(parsed.client, "codex");
        assert.equal(parsed.postflight.status, "ok");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runCli install dry-run performs no package, LanceDB, Ollama, or filesystem work", async () => {
    for (const commandArgv of [
        ["install", "--client", "all", "--dry-run"],
        ["install", "--client", "all", "--runtime", "voyage", "--dry-run"],
        ["install", "--runtime", "offline", "--ollama-model", "nomic-embed-text", "--dry-run"],
    ]) {
        const argv = ["--format", "json", ...commandArgv];
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
            const result = JSON.parse(io.read().stdout);
            if (!commandArgv.includes("--runtime") && !commandArgv.includes("--ollama-model")) {
                assert.equal(result.runtime, "offline");
            }
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

test("runCli doctor defaults to a human summary without starting an MCP session", async () => {
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
                { name: "milvus_address", status: "error", message: "MILVUS_ADDRESS is required." },
                {
                    name: "npm_package_access",
                    status: "warning",
                    message: "Could not verify npm package access: npm error E404\nnpm error log: /private/npm.log",
                },
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

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 1);
    assert.match(stdout, /^Satori Doctor/m);
    assert.match(stdout, /1 problem · 1 warning · 1 check passed/);
    assert.match(stdout, /Milvus address/);
    assert.match(stdout, /configured Satori MCP package could not be verified/);
    assert.match(stdout, /Set MILVUS_ADDRESS/);
    assert.doesNotMatch(stdout, /localDiagnostics|Node is supported|npm error|private\/npm/);
    assert.throws(() => JSON.parse(stdout));
    assert.equal(stderr, "");
});

test("runCli doctor renders configured client runtimes instead of one global default", async () => {
    const io = captureIo();
    const exitCode = await runCli(["doctor"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        doctorRunner: () => ({
            status: "ok",
            packageVersions: [],
            packageVersionNote: "independent package versions",
            checks: [
                { name: "client_runtime_codex", status: "ok", message: "Codex: offline · Potion / potion-code · LanceDB." },
                { name: "client_runtime_opencode", status: "ok", message: "OpenCode: connected · VoyageAI / voyage-code-3 · Milvus." },
                { name: "embedding_provider_env", status: "ok", message: "Configured client credentials are present." },
            ],
            nextSteps: [],
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
    assert.match(stdout, /Configured runtimes:/);
    assert.match(stdout, /Codex: offline · Potion/);
    assert.match(stdout, /OpenCode: connected · VoyageAI/);
    assert.doesNotMatch(stdout, /Selected runtime:/);
    assert.match(stdout, /1 check passed/);
    assert.equal(stderr, "");
});

test("runCli doctor preserves complete JSON output through both explicit forms", async () => {
    for (const argv of [["doctor", "--json"], ["--format", "json", "doctor"]]) {
        const io = captureIo();
        const exitCode = await runCli(argv, {
            writeStdout: io.writeStdout,
            writeStderr: io.writeStderr,
            doctorRunner: () => ({
                status: "error",
                packageVersions: [],
                packageVersionNote: "independent package versions",
                checks: [{ name: "milvus_address", status: "error", message: "MILVUS_ADDRESS is required." }],
                nextSteps: ["Set MILVUS_ADDRESS."],
                localDiagnostics: {
                    schemaVersion: "v1", storage: "local_only",
                    privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
                    eventsRead: 3, malformedEventsSkipped: 0, totalDurationMs: 0,
                    toolCalls: [], warningCodes: [], fallbackUses: 0, lifecycleOutcomes: [],
                    recovery: { attempts: 0, successes: 0 },
                },
            }),
        });

        const { stdout, stderr } = io.read();
        assert.equal(exitCode, 1);
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.status, "error");
        assert.equal(parsed.checks[0].name, "milvus_address");
        assert.equal(parsed.localDiagnostics.eventsRead, 3);
        assert.equal(stderr, "");
    }
});

test("runCli doctor reports stale MCP clients independently without changing JSON checks", async () => {
    const result: DoctorResult = {
        status: "error" as const,
        packageVersions: [],
        packageVersionNote: "independent package versions",
        checks: [{
            name: "managed_client_configuration",
            status: "error" as const,
            message: "codex config does not point exactly to the managed launcher. opencode config does not point exactly to the managed launcher.",
        }],
        nextSteps: [
            "Rerun satori install for each stale configured MCP client, then restart it.",
            "Restart your MCP client after changing Satori environment variables.",
        ],
        localDiagnostics: {
            schemaVersion: "v1", storage: "local_only",
            privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
            eventsRead: 0, malformedEventsSkipped: 0, totalDurationMs: 0,
            toolCalls: [], warningCodes: [], fallbackUses: 0, lifecycleOutcomes: [],
            recovery: { attempts: 0, successes: 0 },
        },
    };
    const humanIo = captureIo();
    await runCli(["doctor"], {
        writeStdout: humanIo.writeStdout,
        writeStderr: humanIo.writeStderr,
        doctorRunner: () => result,
    });
    const human = humanIo.read().stdout;
    assert.match(human, /2 problems/);
    assert.match(human, /Codex configuration/);
    assert.match(human, /OpenCode configuration/);
    assert.match(human, /install --client codex/);
    assert.match(human, /install --client opencode/);
    assert.doesNotMatch(human, /each stale configured MCP client/);

    const jsonIo = captureIo();
    await runCli(["doctor", "--json"], {
        writeStdout: jsonIo.writeStdout,
        writeStderr: jsonIo.writeStderr,
        doctorRunner: () => result,
    });
    const json = JSON.parse(jsonIo.read().stdout);
    assert.equal(json.checks.length, 1);
    assert.equal(json.checks[0].name, "managed_client_configuration");
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

test("runCli doctor text mode hides sensitive diagnostic details", async () => {
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
                {
                    name: "mutation_leases",
                    status: "warning",
                    message: "Mutation lease states: active=0, abandoned=1; abandoned=[root=/private/repo action=create operation=88bea106-5ead-44fa-a478-9a7783032076 generation=2961 pid=117361].",
                }
            ],
            nextSteps: ["Retry the intended manage_index action after verifying the abandoned operation."],
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
    assert.match(stdout, /An abandoned indexing operation was found/);
    assert.doesNotMatch(stdout, /private\/repo|88bea106|2961|117361|Local diagnostics/);
    assert.equal(stderr, "");
});

test("runCli doctor verbose mode includes complete support details", async () => {
    const io = captureIo();
    const exitCode = await runCli(["doctor", "--verbose"], {
        writeStdout: io.writeStdout,
        writeStderr: io.writeStderr,
        doctorRunner: () => ({
            status: "warning",
            packageVersions: [
                { name: "@zokizuan/satori-cli", version: "1.0.0", source: "/private/npm/package.json" },
            ],
            packageVersionNote: "independent package versions",
            checks: [{
                name: "mutation_leases",
                status: "warning",
                message: "abandoned root=/private/repo operation=88bea106-5ead-44fa-a478-9a7783032076",
            }],
            nextSteps: [],
            localDiagnostics: {
                schemaVersion: "v1", storage: "local_only",
                privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
                eventsRead: 2, malformedEventsSkipped: 0, totalDurationMs: 3921,
                toolCalls: [], warningCodes: [], fallbackUses: 0, lifecycleOutcomes: [],
                recovery: { attempts: 0, successes: 0 },
            },
        }),
    });

    const { stdout, stderr } = io.read();
    assert.equal(exitCode, 0);
    assert.match(stdout, /private\/repo/);
    assert.match(stdout, /88bea106-5ead-44fa-a478-9a7783032076/);
    assert.match(stdout, /Package sources/);
    assert.match(stdout, /Local diagnostics/);
    assert.match(stdout, /"totalDurationMs": 3921/);
    assert.equal(stderr, "");
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
        const exitCode = await runCli(["--format", "json", "uninstall", "--client", "claude", "--dry-run"], {
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

test("runCli keeps its owned session alive until manage_index create completes", async () => {
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
    assert.equal(stdout.includes("started indexing"), false);
    assert.equal(stdout.includes("fully indexed"), true);
    assert.equal(stdout.includes("polls=3"), true);
});

test("runCli does not let a low per-call timeout destroy an active managed index", async () => {
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
    assert.equal(stdout.includes("started indexing"), false);
    assert.equal(stdout.includes("fully indexed"), true);
    assert.equal(stdout.includes("polls=3"), true);
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
