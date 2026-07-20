import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { connectCliMcpSession } from "./client.js";
import {
    executeInstallCommand as executeInstallCommandProduction,
    inspectManagedClientConfigurations,
    type InstallCommandInput,
    type InstallCommandOptions,
} from "./install.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POSTFLIGHT_MCP_RUNTIME_FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "test-fixtures",
    "postflight-mcp-runtime.mjs",
);
const PACKAGE_JSON = JSON.parse(
    fs.readFileSync(path.resolve(PACKAGE_ROOT, "..", "mcp", "package.json"), "utf8")
) as { name: string; version: string; bin?: Record<string, string> };
const EXPECTED_PACKAGE_SPECIFIER = `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}`;

function executeInstallCommand(
    command: InstallCommandInput,
    options: InstallCommandOptions = {},
) {
    return executeInstallCommandProduction(command, {
        preflightRunner: async () => ({
            runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
        }),
        preflightDependencies: {
            probeCandidateRuntime: async () => {},
        },
        ...options,
    });
}

function fakeRuntimeCommand(homeDir: string) {
    return {
        command: process.execPath,
        args: [
            path.join(
                homeDir,
                ".satori",
                "mcp-runtime",
                "@zokizuan-satori-mcp-4.11.2",
                "node_modules",
                "@zokizuan",
                "satori-mcp",
                "dist",
                "index.js"
            )
        ],
    };
}

function fakeClientCommand(homeDir: string) {
    return {
        command: process.execPath,
        args: [path.join(homeDir, ".satori", "bin", "satori-mcp.js")],
    };
}

function launcherPath(homeDir: string): string {
    return path.join(homeDir, ".satori", "bin", "satori-mcp.js");
}

function installOptions(homeDir: string) {
    return {
        homeDir,
        runtimeCommand: fakeRuntimeCommand(homeDir),
    };
}

async function withTempRepo(run: (repoDir: string) => void | Promise<void>): Promise<void> {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-profile-repo-"));
    try {
        await run(repoDir);
    } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
}

async function withTempHome(run: (homeDir: string) => void | Promise<void>): Promise<void> {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-install-"));
    try {
        await run(homeDir);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
}

function readFile(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
}

function isProcessLive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessLive(pid)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !isProcessLive(pid);
}

function readChildPid(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for managed runtime child PID.")), 5_000);
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            const match = stdout.match(/SATORI_TEST_CHILD_PID=(\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(Number(match[1]));
            }
        });
    });
}

async function assertLauncherReapsChild(
    homeDir: string,
    signal: "SIGINT" | "SIGTERM",
    options: { ignoreSignal?: boolean; shutdownGraceMs?: number } = {},
): Promise<void> {
    const ignoreSignal = options.ignoreSignal === true;
    const runtimeCode = [
        'console.log(`SATORI_TEST_CHILD_PID=${process.pid}`);',
        ignoreSignal
            ? `process.on(${JSON.stringify(signal)}, () => {});`
            : `process.on(${JSON.stringify(signal)}, () => process.exit(0));`,
        "setInterval(() => {}, 1_000);",
    ].join("");

    if (options.shutdownGraceMs !== undefined) {
        // Bypass install so tests can inject a short grace without changing production defaults.
        const { buildLauncherScript } = await import("./managed-launcher-script.mjs");
        fs.mkdirSync(path.dirname(launcherPath(homeDir)), { recursive: true });
        fs.writeFileSync(launcherPath(homeDir), buildLauncherScript({
            command: process.execPath,
            args: ["-e", runtimeCode],
            shutdownGraceMs: options.shutdownGraceMs,
        }), "utf8");
        fs.chmodSync(launcherPath(homeDir), 0o755);
    } else {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            runtimeCommand: { command: process.execPath, args: ["-e", runtimeCode] },
        });
    }

    const launcher = spawn(process.execPath, [launcherPath(homeDir)], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    let childPid: number | undefined;
    try {
        childPid = await readChildPid(launcher);
        launcher.kill(signal);
        const [, exitSignal] = await once(launcher, "exit") as [number | null, NodeJS.Signals | null];
        assert.equal(exitSignal, signal);
        assert.equal(isProcessLive(childPid), false, `runtime child ${childPid} survived launcher ${signal}`);
    } finally {
        if (childPid && isProcessLive(childPid)) {
            process.kill(childPid, "SIGKILL");
        }
        if (launcher.exitCode === null && launcher.signalCode === null) {
            launcher.kill("SIGKILL");
        }
    }
}

function extractCodexGuidanceCommand(content: string): string {
    const document = JSON.parse(content) as {
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const command = document.hooks?.SessionStart
        ?.flatMap((entry) => entry.hooks ?? [])
        .map((hook) => hook.command)
        .find((value): value is string => typeof value === "string" && value.includes("satori-codex-guidance."));
    assert.ok(command, "expected managed Codex guidance hook command");
    return command;
}

function runGuidanceCommand(command: string, cwd: string, runtimeDir: string): string {
    return execFileSync("sh", ["-c", command], {
        cwd,
        env: {
            ...process.env,
            XDG_RUNTIME_DIR: runtimeDir,
        },
        encoding: "utf8",
    });
}

function installRuntimePackageStub(
    relativeEntry: string,
    expectedSpecifier = EXPECTED_PACKAGE_SPECIFIER,
    installedVersion = expectedSpecifier.slice(expectedSpecifier.lastIndexOf("@") + 1),
) {
    return (command: string, args: string[]) => {
        assert.equal(command, "npm");
        const prefixIndex = args.indexOf("--prefix");
        assert.notEqual(prefixIndex, -1);
        const runtimeRoot = args[prefixIndex + 1];
        assert.equal(typeof runtimeRoot, "string");
        const packageIndex = args.indexOf(expectedSpecifier);
        assert.notEqual(packageIndex, -1);
        assert.equal(args[packageIndex - 1], "--");
        const packageRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
        const entryPath = path.join(packageRoot, relativeEntry);
        fs.mkdirSync(path.dirname(entryPath), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: installedVersion,
            bin: {
                satori: relativeEntry,
            },
        }, null, 2), "utf8");
        fs.writeFileSync(entryPath, "#!/usr/bin/env node\n", "utf8");
        return "";
    };
}

function brokenRuntimePackageStub(
    expectedSpecifier: string,
    startedMarkerPath: string,
    installedPrefixes: string[],
) {
    const install = installRuntimePackageStub("dist/broken-runtime.mjs", expectedSpecifier);
    return (command: string, args: string[]) => {
        const result = install(command, args);
        const prefix = args[args.indexOf("--prefix") + 1];
        installedPrefixes.push(prefix);
        fs.writeFileSync(
            path.join(prefix, "node_modules", "@zokizuan", "satori-mcp", "dist", "broken-runtime.mjs"),
            [
                'import fs from "node:fs";',
                `fs.writeFileSync(${JSON.stringify(startedMarkerPath)}, "started\\n", "utf8");`,
                'throw new Error("candidate startup failed");',
                "",
            ].join("\n"),
            "utf8",
        );
        return result;
    };
}

test("install writes managed Codex config block and copies packaged skill", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(codexConfigPath, 'model = "gpt-5"\n', "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.client, "codex");
        assert.equal(result.results[0]?.status, "updated");
        assert.equal(result.results[0]?.skillsChanged, true);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(result.results[0]?.guidanceHookChanged, false);
        assert.equal(result.results[0]?.guidanceHookPath, path.join(homeDir, ".codex", "hooks.json"));
        assert.equal(result.results[0]?.instructionsPath, path.join(homeDir, ".codex", "AGENTS.md"));
        const content = readFile(codexConfigPath);
        assert.equal(content.includes("[mcp_servers.satori]"), true);
        assert.equal(content.includes(`command = "${process.execPath.replace(/\\/g, "\\\\")}"`), true);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(content.includes("env_vars = ["), true);
        assert.equal(content.includes("\"VOYAGEAI_API_KEY\""), true);
        assert.equal(content.includes("\"EMBEDDING_OUTPUT_DIMENSION\""), true);
        assert.equal(content.includes("\"MILVUS_ADDRESS\""), true);
        assert.equal(content.includes("# Runtime selection is installer-owned by ~/.satori/bin/satori-mcp.js."), true);
        assert.equal(content.includes("# [mcp_servers.satori.env]"), false);
        assert.equal(content.includes("voyage-code-3"), false);
        assert.equal(content.includes("node_modules"), false);
        assert.equal(content.includes("dist/index.js"), false);
        assert.equal(content.includes('command = "npx"'), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
        assert.equal(content.includes(EXPECTED_PACKAGE_SPECIFIER), false);
        assert.equal(content.includes("# >>> satori-cli managed codex guidance hook start >>>"), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "hooks.json")), false);
        assert.equal(fs.existsSync(launcherPath(homeDir)), true);
        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes('require("node:child_process")'), true);
        assert.equal(launcher.includes("import { spawn }"), false);
        assert.equal(launcher.includes("node_modules"), true);
        assert.equal(launcher.includes("dist/index.js"), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), true);
        const codexInstructions = readFile(path.join(homeDir, ".codex", "AGENTS.md"));
        assert.equal(codexInstructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(codexInstructions.includes("Satori MCP is available"), true);
        assert.equal(codexInstructions.includes("known paths, exact literals"), true);
        assert.equal(codexInstructions.includes("Obtain explicit user approval before `create` or `reindex`"), true);
        assert.equal(codexInstructions.includes("Start with plain-English behavior or ownership queries"), true);
        assert.equal(codexInstructions.includes("recommendedNextAction"), true);
        assert.equal(codexInstructions.includes("warnings[].action"), true);
        assert.equal(codexInstructions.includes("canonical `target`"), true);
        assert.equal(codexInstructions.includes("navigation.graph=\"ready\""), true);
        assert.equal(codexInstructions.includes("navigationFallback"), false);
        assert.equal(codexInstructions.includes("Do not treat call_graph inbound results as sole authority"), true);
        const codexSkill = readFile(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md"));
        assert.equal(codexSkill.includes("plain-English semantic code discovery"), true);
        assert.equal(codexSkill.includes("recommendedNextAction"), true);
        assert.equal(codexSkill.includes("warnings[]"), true);
        assert.equal(codexSkill.includes('navigation.inbound="verify"'), true);
        assert.equal(codexSkill.includes("callerSearchTerm"), true);
        assert.equal(codexSkill.includes("callGraphHint"), false);
        assert.equal(codexSkill.includes("Do not treat call_graph inbound results as sole authority"), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori-search")), false);
    });
});

test("install writes the actual installed runtime bin path into the stable launcher", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
            execFileSyncImpl: installRuntimePackageStub("custom/server.mjs") as never,
        });

        const content = readFile(codexConfigPath);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(content.includes("custom/server.mjs"), false);
        assert.equal(content.includes("dist/index.js"), false);
        assert.equal(content.includes('command = "npx"'), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes("custom/server.mjs"), true);
    });
});

test("managed package installation completes before reading mutable client config", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, 'model = "before-package-install"\n', "utf8");
        const installRuntime = installRuntimePackageStub("custom/server.mjs");
        const execFileSyncImpl = ((command: string, args: string[]) => {
            const result = installRuntime(command, args);
            fs.writeFileSync(configPath, 'model = "changed-during-package-install"\n', "utf8");
            return result;
        }) as never;

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
            execFileSyncImpl,
        });

        const content = readFile(configPath);
        assert.match(content, /model = "changed-during-package-install"/);
        assert.equal(fs.existsSync(launcherPath(homeDir)), true);
    });
});

test("failed runtime upgrade leaves the previous launcher target unchanged", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: "@zokizuan/satori-mcp@1.0.0-test",
            execFileSyncImpl: installRuntimePackageStub("dist/old-runtime.mjs", "@zokizuan/satori-mcp@1.0.0-test") as never,
        });
        const originalLauncher = readFile(launcherPath(homeDir));
        assert.match(originalLauncher, /old-runtime\.mjs/);

        await assert.rejects(
            executeInstallCommandProduction({
                kind: "install",
                client: "codex",
                runtime: "voyage",
                dryRun: false,
            }, {
                homeDir,
                packageSpecifier: "@zokizuan/satori-mcp@2.0.0-test",
                execFileSyncImpl: installRuntimePackageStub("dist/new-runtime.mjs", "@zokizuan/satori-mcp@2.0.0-test") as never,
                preflightRunner: async () => {
                    throw new Error("staged runtime rejected");
                },
            }),
            /Runtime preflight failed: staged runtime rejected/,
        );

        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
    });
});

test("Milvus upgrade starts the candidate and preserves the old install when startup fails", async () => {
    await withTempHome(async (homeDir) => {
        const oldSpecifier = "@zokizuan/satori-mcp@1.0.0-test";
        const newSpecifier = "@zokizuan/satori-mcp@2.0.0-test";
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            vectorStore: "Milvus",
            dryRun: false,
        }, {
            homeDir,
            env: { VECTOR_STORE_PROVIDER: "Milvus", MILVUS_ADDRESS: "https://milvus.example.test" },
            packageSpecifier: oldSpecifier,
            execFileSyncImpl: installRuntimePackageStub("dist/old-runtime.mjs", oldSpecifier) as never,
        });
        const originalLauncher = readFile(launcherPath(homeDir));
        const configPath = path.join(homeDir, ".codex", "config.toml");
        const originalConfig = readFile(configPath);
        const startedMarkerPath = path.join(homeDir, "candidate-started");
        const installedPrefixes: string[] = [];

        await assert.rejects(
            executeInstallCommandProduction({
                kind: "install",
                client: "codex",
                runtime: "voyage",
                vectorStore: "Milvus",
                dryRun: false,
            }, {
                homeDir,
                env: { VECTOR_STORE_PROVIDER: "Milvus", MILVUS_ADDRESS: "https://milvus.example.test" },
                packageSpecifier: newSpecifier,
                execFileSyncImpl: brokenRuntimePackageStub(
                    newSpecifier,
                    startedMarkerPath,
                    installedPrefixes,
                ) as never,
            }),
            /Candidate runtime preflight failed/,
        );

        assert.equal(fs.existsSync(startedMarkerPath), true);
        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
        assert.equal(readFile(configPath), originalConfig);
        assert.equal(installedPrefixes.length, 1);
        assert.equal(fs.existsSync(installedPrefixes[0]), false);
    });
});

test("runtime reuse requires the exact requested package identity", async () => {
    await withTempHome(async (homeDir) => {
        const requestedSpecifier = "@zokizuan/satori-mcp@2.0.0-test";
        const stableRoot = path.join(
            homeDir,
            ".satori",
            "mcp-runtime",
            "@zokizuan-satori-mcp@2.0.0-test",
        );
        const stalePackageRoot = path.join(stableRoot, "node_modules", "@zokizuan", "satori-mcp");
        fs.mkdirSync(path.join(stalePackageRoot, "dist"), { recursive: true });
        fs.writeFileSync(path.join(stalePackageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "1.0.0-test",
            bin: { satori: "dist/stale-runtime.mjs" },
        }), "utf8");
        fs.writeFileSync(path.join(stalePackageRoot, "dist", "stale-runtime.mjs"), "", "utf8");
        const installedPrefixes: string[] = [];
        const install = installRuntimePackageStub("dist/new-runtime.mjs", requestedSpecifier);

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: requestedSpecifier,
            execFileSyncImpl: ((command: string, args: string[]) => {
                installedPrefixes.push(args[args.indexOf("--prefix") + 1]);
                return install(command, args);
            }) as never,
        });

        assert.equal(installedPrefixes.length, 1);
        assert.notEqual(installedPrefixes[0], stableRoot);
        assert.match(readFile(launcherPath(homeDir)), /new-runtime\.mjs/);
        assert.equal(fs.existsSync(path.join(stalePackageRoot, "dist", "stale-runtime.mjs")), true);
    });
});

test("runtime reuse never treats a package tag as a resolved immutable version", async () => {
    await withTempHome(async (homeDir) => {
        const requestedSpecifier = "@zokizuan/satori-mcp@latest";
        const installedPrefixes: string[] = [];
        const installVersion = (installedVersion: string) => {
            const install = installRuntimePackageStub(
                "dist/runtime.mjs",
                requestedSpecifier,
                installedVersion,
            );
            return ((command: string, args: string[]) => {
                installedPrefixes.push(args[args.indexOf("--prefix") + 1]);
                return install(command, args);
            }) as never;
        };

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: requestedSpecifier,
            execFileSyncImpl: installVersion("1.0.0"),
        });
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: requestedSpecifier,
            execFileSyncImpl: installVersion("2.0.0"),
        });

        assert.equal(installedPrefixes.length, 2);
        assert.notEqual(installedPrefixes[0], installedPrefixes[1]);
        const launcher = readFile(launcherPath(homeDir));
        assert.match(launcher, new RegExp(installedPrefixes[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
});

test("successful runtime upgrade switches the launcher only after candidate preflight", async () => {
    await withTempHome(async (homeDir) => {
        const oldSpecifier = "@zokizuan/satori-mcp@1.0.0-test";
        const newSpecifier = "@zokizuan/satori-mcp@2.0.0-test";
        const installedPrefixes: string[] = [];
        const preflightEntries: string[] = [];
        const installVersion = (entry: string, specifier: string) => {
            const install = installRuntimePackageStub(entry, specifier);
            return ((command: string, args: string[]) => {
                installedPrefixes.push(args[args.indexOf("--prefix") + 1]);
                return install(command, args);
            }) as never;
        };

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: oldSpecifier,
            execFileSyncImpl: installVersion("dist/old-runtime.mjs", oldSpecifier),
        });
        const oldRuntimeRoot = installedPrefixes[0];

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: newSpecifier,
            execFileSyncImpl: installVersion("dist/new-runtime.mjs", newSpecifier),
            preflightDependencies: {
                probeCandidateRuntime: async ({ runtimeCommand, expectedVersion }) => {
                    preflightEntries.push(runtimeCommand.args[0]);
                    assert.equal(expectedVersion, "2.0.0-test");
                    assert.match(runtimeCommand.args[0], /new-runtime\.mjs$/);
                },
            },
        });

        assert.equal(installedPrefixes.length, 2);
        assert.notEqual(installedPrefixes[0], installedPrefixes[1]);
        assert.equal(preflightEntries.length, 1);
        assert.match(readFile(launcherPath(homeDir)), /new-runtime\.mjs/);
        assert.equal(fs.existsSync(oldRuntimeRoot), true);
    });
});

test("managed launcher forwards termination signals and reaps its runtime child", {
    skip: process.platform === "win32" ? "POSIX signal forwarding is not observable on Windows" : false,
}, async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-launcher-signal-"));
        try {
            await assertLauncherReapsChild(homeDir, signal);
        } finally {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    }
});

test("managed launcher force-kills a child that ignores SIGTERM after grace", {
    skip: process.platform === "win32" ? "POSIX signal forwarding is not observable on Windows" : false,
}, async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-launcher-force-"));
    try {
        await assertLauncherReapsChild(homeDir, "SIGTERM", {
            ignoreSignal: true,
            shutdownGraceMs: 200,
        });
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("default managed launcher preserves time for cooperative shutdown", {
    skip: process.platform === "win32" ? "POSIX signal forwarding is not observable on Windows" : false,
    timeout: 15_000,
}, async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-launcher-slow-shutdown-"));
    const markerPath = path.join(homeDir, "shutdown-complete");
    const runtimeCode = [
        'const fs = require("node:fs");',
        'console.log(`SATORI_TEST_CHILD_PID=${process.pid}`);',
        `process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(markerPath)}, "ok"); process.exit(0); }, 1_500));`,
        "setInterval(() => {}, 1_000);",
    ].join("");

    try {
        const { buildLauncherScript } = await import("./managed-launcher-script.mjs");
        fs.mkdirSync(path.dirname(launcherPath(homeDir)), { recursive: true });
        fs.writeFileSync(launcherPath(homeDir), buildLauncherScript({
            command: process.execPath,
            args: ["-e", runtimeCode],
        }), "utf8");
        fs.chmodSync(launcherPath(homeDir), 0o755);

        const launcher = spawn(process.execPath, [launcherPath(homeDir)], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        const childPid = await readChildPid(launcher);
        launcher.kill("SIGTERM");
        const [, exitSignal] = await once(launcher, "exit") as [number | null, NodeJS.Signals | null];
        assert.equal(exitSignal, "SIGTERM");
        assert.equal(fs.readFileSync(markerPath, "utf8"), "ok");
        assert.equal(isProcessLive(childPid), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("default managed launcher reaps non-cooperative runtime through CliMcpSession.close()", {
    skip: process.platform === "win32" ? "POSIX signal reaping is not observable on Windows" : false,
    // SDK close path is ~4s (EOF wait + SIGTERM wait) before SIGKILL; stay above that full path.
    timeout: 30_000,
}, async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-session-close-reap-"));
    const pidFile = path.join(homeDir, "runtime.pid");
    let runtimePid: number | undefined;
    let session: Awaited<ReturnType<typeof connectCliMcpSession>> | undefined;

    try {
        const { buildLauncherScript } = await import("./managed-launcher-script.mjs");
        fs.mkdirSync(path.dirname(launcherPath(homeDir)), { recursive: true });
        // Exercise the production default rather than the short unit-test override.
        fs.writeFileSync(launcherPath(homeDir), buildLauncherScript({
            command: process.execPath,
            args: [POSTFLIGHT_MCP_RUNTIME_FIXTURE],
        }), "utf8");
        fs.chmodSync(launcherPath(homeDir), 0o755);

        session = await connectCliMcpSession({
            command: process.execPath,
            args: [launcherPath(homeDir)],
            env: {
                SATORI_TEST_PID_FILE: pidFile,
            },
            startupTimeoutMs: 10_000,
            callTimeoutMs: 5_000,
            writeStderr: () => {},
        });

        const listed = await session.listTools();
        assert.equal(
            Array.isArray(listed.tools) && listed.tools.some((tool) => tool.name === "list_codebases"),
            true,
            "expected tools/list to succeed against the fixture runtime",
        );

        const pidText = fs.readFileSync(pidFile, "utf8").trim();
        runtimePid = Number(pidText);
        assert.equal(Number.isInteger(runtimePid) && runtimePid > 0, true, `invalid runtime pid from fixture: ${pidText}`);
        assert.equal(isProcessLive(runtimePid), true, `runtime child ${runtimePid} should be live before session close`);

        await session.close();
        session = undefined;

        // Bounded poll after real SDK close ordering; child must not survive session close.
        const reaped = await waitForProcessExit(runtimePid, 6_000);
        assert.equal(reaped, true, `runtime child ${runtimePid} survived CliMcpSession.close()`);
    } finally {
        if (session) {
            try {
                await session.close();
            } catch {
                // Best-effort cleanup.
            }
        }
        if (runtimePid !== undefined && isProcessLive(runtimePid)) {
            try {
                process.kill(runtimePid, "SIGKILL");
            } catch {
                // Ignore races where the child exits before forced kill.
            }
        }
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("managed launcher closes the real postflight runtime on stdin EOF and unregisters its owner", {
    timeout: 30_000,
}, async (t) => {
    const runtimeEntry = path.resolve(PACKAGE_ROOT, "..", "mcp", "dist", "index.js");
    if (!fs.existsSync(runtimeEntry)) {
        t.skip("built MCP runtime is required");
        return;
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-real-postflight-close-"));
    const ownersPath = path.join(homeDir, ".satori", "runtime", "owners.json");
    let runtimePid: number | undefined;
    let session: Awaited<ReturnType<typeof connectCliMcpSession>> | undefined;
    try {
        const { buildLauncherScript } = await import("./managed-launcher-script.mjs");
        fs.mkdirSync(path.dirname(launcherPath(homeDir)), { recursive: true });
        fs.writeFileSync(launcherPath(homeDir), buildLauncherScript({
            command: process.execPath,
            args: [runtimeEntry],
        }), "utf8");
        fs.chmodSync(launcherPath(homeDir), 0o755);

        session = await connectCliMcpSession({
            command: process.execPath,
            args: [launcherPath(homeDir)],
            env: {
                HOME: homeDir,
                SATORI_RUN_MODE: "postflight",
            },
            startupTimeoutMs: 10_000,
            callTimeoutMs: 5_000,
            writeStderr: () => {},
        });
        const owners = JSON.parse(fs.readFileSync(ownersPath, "utf8")) as {
            owners: Array<{ pid: number }>;
        };
        assert.equal(owners.owners.length, 1);
        runtimePid = owners.owners[0].pid;
        assert.equal(isProcessLive(runtimePid), true);

        await session.close();
        session = undefined;

        assert.equal(await waitForProcessExit(runtimePid, 3_000), true);
        const remaining = JSON.parse(fs.readFileSync(ownersPath, "utf8")) as { owners: unknown[] };
        assert.deepEqual(remaining.owners, []);
    } finally {
        if (session) {
            await session.close();
        }
        if (runtimePid !== undefined && isProcessLive(runtimePid)) {
            process.kill(runtimePid, "SIGKILL");
        }
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("install launcher embeds shared SIGKILL grace path", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));
        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes("SIGKILL"), true);
        assert.equal(launcher.includes("shutdownGraceMs"), true);
        assert.equal(launcher.includes("forwardShutdown"), true);
    });
});

// F-OP-02: install result must surface the managed package specifier used.
test("install result includes packageSpecifier used for managed runtime", async () => {
    await withTempHome(async (homeDir) => {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: true,
        }, {
            homeDir,
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
        });

        assert.equal(result.action, "install");
        assert.equal(result.packageSpecifier, EXPECTED_PACKAGE_SPECIFIER);
        assert.match(String(result.packageSpecifier), /@zokizuan\/satori-mcp@/);
    });
});

test("managed MCP package exposes a single satori bin for npx package execution", async () => {
    assert.deepEqual(PACKAGE_JSON.bin, {
        satori: "dist/index.js",
    });
});

test("packaged Satori skill assets stay identical across CLI and MCP packages", async () => {
    const cliSkill = readFile(path.join(PACKAGE_ROOT, "assets", "skills", "satori", "SKILL.md"));
    const mcpSkill = readFile(path.join(PACKAGE_ROOT, "..", "mcp", "assets", "skills", "satori", "SKILL.md"));

    assert.equal(cliSkill, mcpSkill);
});

test("install is idempotent for managed Codex config", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const second = await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        assert.equal(second.results[0]?.configChanged, false);
        assert.equal(second.results[0]?.skillsChanged, false);
        assert.equal(second.results[0]?.instructionsChanged, false);
        assert.equal(second.results[0]?.status, "unchanged");
    });
});

test("install replaces only the managed Codex AGENTS block and preserves user content", async () => {
    await withTempHome(async (homeDir) => {
        const agentsPath = path.join(homeDir, ".codex", "AGENTS.md");
        fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
        fs.writeFileSync(agentsPath, [
            "# User Rules",
            "Keep this introduction.",
            "",
            "<!-- satori-mcp:start -->",
            "# Old Satori Instructions",
            "old exact-only guidance",
            "<!-- satori-mcp:end -->",
            "",
            "## Local Notes",
            "Keep this footer.",
            "",
        ].join("\n"), "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const content = readFile(agentsPath);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(content.includes("Keep this introduction."), true);
        assert.equal(content.includes("Keep this footer."), true);
        assert.equal(content.includes("old exact-only guidance"), false);
        assert.equal(content.includes("Satori MCP is available"), true);
        assert.equal(content.match(/<!-- satori-mcp:start -->/g)?.length, 1);
        assert.equal(content.match(/<!-- satori-mcp:end -->/g)?.length, 1);
    });
});

test("install replaces an existing managed Codex block", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "# >>> satori-cli managed satori start >>>",
                "[mcp_servers.satori]",
                'command = "old-managed-satori"',
                'args = ["old"]',
                "startup_timeout_ms = 180000",
                "# <<< satori-cli managed satori end <<<",
                "",
                "# >>> satori-cli optional satori env template >>>",
                "# [mcp_servers.satori.env]",
                "# SATORI_RUNTIME_PROFILE = \"connected\"",
                "# EMBEDDING_PROVIDER = \"VoyageAI\"",
                "# <<< satori-cli optional satori env template <<<",
                "",
            ].join("\n"),
            "utf8"
        );

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const content = readFile(codexConfigPath);
        assert.equal(content.includes(`command = "${process.execPath.replace(/\\/g, "\\\\")}"`), true);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(content.includes("env_vars = ["), true);
        assert.equal(content.includes("\"VOYAGEAI_API_KEY\""), true);
        assert.equal(content.includes("\"MILVUS_ADDRESS\""), true);
        assert.equal(content.includes("# Runtime selection is installer-owned by ~/.satori/bin/satori-mcp.js."), true);
        assert.equal(content.includes("# >>> satori-cli optional satori env template >>>"), false);
        assert.equal(content.includes("VoyageAI"), false);
        assert.equal(content.includes("node_modules"), false);
        assert.equal(content.includes("old-managed-satori"), false);
        assert.equal(content.includes("startup_timeout_ms"), false);
    });
});

test("install preserves user-owned Codex env values outside the managed block", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                "# >>> satori-cli managed satori start >>>",
                "[mcp_servers.satori]",
                'command = "old-managed-satori"',
                'args = ["old"]',
                "# <<< satori-cli managed satori end <<<",
                "",
                "[mcp_servers.satori.env]",
                'VOYAGEAI_API_KEY = "direct-key"',
                'MILVUS_TOKEN = "direct-token"',
                "",
            ].join("\n"),
            "utf8"
        );

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const content = readFile(codexConfigPath);
        assert.equal(content.includes('VOYAGEAI_API_KEY = "direct-key"'), true);
        assert.equal(content.includes('MILVUS_TOKEN = "direct-token"'), true);
        assert.equal(content.includes("# >>> satori-cli optional satori env template >>>"), false);
    });
});

test("install adds the opt-in Codex guidance hook to hooks.json and preserves user hooks", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        const hooksPath = path.join(homeDir, ".codex", "hooks.json");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(codexConfigPath, 'model = "gpt-5"\n', "utf8");
        fs.writeFileSync(hooksPath, JSON.stringify({
            hooks: {
                SessionStart: [{
                    matcher: "startup",
                    hooks: [{ type: "command", command: 'echo "user hook"', timeout: 3 }],
                }],
            },
        }, null, 2), "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
            installGuidanceHook: true,
        }, installOptions(homeDir));

        const content = readFile(codexConfigPath);
        const hooks = readFile(hooksPath);
        assert.equal(result.results[0]?.guidanceHookPath, hooksPath);
        assert.equal(result.results[0]?.guidanceHookChanged, true);
        assert.equal(content.includes("[[hooks.SessionStart]]"), false);
        assert.equal(content.includes("satori-codex-guidance"), false);
        assert.equal(hooks.includes("Satori MCP is available"), true);
        assert.equal(hooks.includes("native tools may be simpler"), true);
        assert.equal(hooks.includes("satori-codex-guidance"), true);
        assert.equal(hooks.includes('echo \\"user hook\\"'), true);
        assert.equal(extractCodexGuidanceCommand(hooks).startsWith("sh -lc "), true);
        assert.equal(fs.statSync(hooksPath).mode & 0o777, 0o600);
    });
});

test("managed Codex guidance hook command suppresses duplicate prints per working directory", async () => {
    await withTempHome(async (homeDir) => {
        const runtimeDir = path.join(homeDir, "runtime");
        const repoA = path.join(homeDir, "repo-a");
        const repoB = path.join(homeDir, "repo-b");
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.mkdirSync(repoA, { recursive: true });
        fs.mkdirSync(repoB, { recursive: true });

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
            installGuidanceHook: true,
        }, installOptions(homeDir));

        const command = extractCodexGuidanceCommand(readFile(path.join(homeDir, ".codex", "hooks.json")));
        assert.match(runGuidanceCommand(command, repoA, runtimeDir), /Satori MCP is available/);
        assert.equal(runGuidanceCommand(command, repoA, runtimeDir), "");
        assert.match(runGuidanceCommand(command, repoB, runtimeDir), /Satori MCP is available/);

        const uid = execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
        const stampDir = path.join(runtimeDir, `satori-codex-guidance.${uid}`);
        assert.equal(fs.statSync(stampDir).isDirectory(), true);
        assert.equal(fs.statSync(stampDir).mode & 0o777, 0o700);
    });
});

test("install migrates a legacy inline Codex guidance hook to hooks.json", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                "# >>> satori-cli managed codex guidance hook start >>>",
                "[[hooks.SessionStart]]",
                'matcher = "startup"',
                "",
                "[[hooks.SessionStart.hooks]]",
                'type = "command"',
                'command = \'echo "old satori guidance"\'',
                "# <<< satori-cli managed codex guidance hook end <<<",
                "",
            ].join("\n"),
            "utf8"
        );

        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const content = readFile(codexConfigPath);
        const hooks = readFile(path.join(homeDir, ".codex", "hooks.json"));
        assert.equal(content.includes("old satori guidance"), false);
        assert.equal(content.includes("satori-cli managed codex guidance hook start"), false);
        assert.equal(hooks.includes("Satori MCP is available"), true);
        assert.equal(hooks.includes("satori-codex-guidance"), true);
    });
});

test("install refreshes an existing managed hooks.json entry without duplicating it", async () => {
    await withTempHome(async (homeDir) => {
        const hooksPath = path.join(homeDir, ".codex", "hooks.json");
        fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
        fs.writeFileSync(hooksPath, JSON.stringify({
            hooks: {
                SessionStart: [{
                    matcher: "startup|resume|clear|compact",
                    hooks: [{
                        type: "command",
                        command: 'sh -lc \'mkdir -p "${XDG_RUNTIME_DIR:-/tmp}/satori-codex-guidance.${uid}"; echo old\'',
                        timeout: 1,
                    }],
                }],
            },
        }, null, 2), "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const content = readFile(hooksPath);
        assert.equal(result.results[0]?.guidanceHookChanged, true);
        assert.equal(content.includes("echo old"), false);
        assert.equal(content.match(/satori-codex-guidance\./g)?.length, 1);
        assert.equal(content.includes('"timeout": 5'), true);
    });
});

test("uninstall removes an existing managed Codex block", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        const agentsPath = path.join(homeDir, ".codex", "AGENTS.md");
        const skillPath = path.join(homeDir, ".codex", "skills", "satori", "SKILL.md");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "# >>> satori-cli managed satori start >>>",
                "[mcp_servers.satori]",
                `command = "${process.execPath.replace(/\\/g, "\\\\")}"`,
                `args = ["${launcherPath(homeDir).replace(/\\/g, "\\\\")}"]`,
                "# <<< satori-cli managed satori end <<<",
                "",
            ].join("\n"),
            "utf8"
        );
        fs.writeFileSync(skillPath, "# Managed Satori Skill\n", "utf8");
        fs.writeFileSync(agentsPath, [
            "# User Rules",
            "",
            "<!-- satori-mcp:start -->",
            "# Managed Satori",
            "<!-- satori-mcp:end -->",
            "",
            "Keep this local note.",
            "",
        ].join("\n"), "utf8");

        const result = await executeInstallCommand({
            kind: "uninstall",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        const content = readFile(codexConfigPath);
        const instructions = readFile(agentsPath);
        assert.equal(result.results[0]?.skillsChanged, true);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(content.includes("[mcp_servers.satori]"), false);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), false);
        assert.equal(fs.existsSync(path.dirname(skillPath)), false);
        assert.equal(instructions.includes("<!-- satori-mcp:start -->"), false);
        assert.equal(instructions.includes("Keep this local note."), true);
    });
});

test("uninstall removes managed Codex guidance hook and preserves user hooks", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
            installGuidanceHook: true,
        }, installOptions(homeDir));
        const hooksPath = path.join(homeDir, ".codex", "hooks.json");
        const document = JSON.parse(readFile(hooksPath));
        document.hooks.SessionStart.push({
            matcher: "startup",
            hooks: [{ type: "command", command: 'echo "user hook"', timeout: 3 }],
        });
        fs.writeFileSync(hooksPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

        const result = await executeInstallCommand({
            kind: "uninstall",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        const content = readFile(hooksPath);
        assert.equal(result.results[0]?.guidanceHookChanged, true);
        assert.equal(content.includes("satori-codex-guidance"), false);
        assert.equal(content.includes('echo \\"user hook\\"'), true);
    });
});

test("install refuses to overwrite unmanaged Codex Satori sections", async () => {
    await withTempHome(async (homeDir) => {
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
        fs.writeFileSync(
            codexConfigPath,
            [
                'model = "gpt-5"',
                "",
                "[mcp_servers.satori]",
                'command = "node"',
                'args = ["/custom/satori.js"]',
                "",
            ].join("\n"),
            "utf8"
        );

        await assert.rejects(
            () => executeInstallCommand({
                kind: "install",
                client: "codex",
            runtime: "voyage",
                dryRun: false,
            }, installOptions(homeDir)),
            /Refusing to overwrite unmanaged Satori config/
        );
    });
});

test("install merges Claude JSON config and uninstall removes only Satori-owned entry and skills", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        const skillsDir = path.join(homeDir, ".claude", "skills");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.mkdirSync(path.join(skillsDir, "custom-skill"), { recursive: true });
        fs.writeFileSync(path.join(skillsDir, "custom-skill", "SKILL.md"), "# custom\n", "utf8");
        fs.writeFileSync(configPath, JSON.stringify({
            projects: {
                "/tmp/example": {
                    allowedTools: ["Read"],
                },
            },
            mcpServers: {
                existing: {
                    command: "npx",
                    args: ["-y", "@example/other-server@latest"],
                }
            }
        }, null, 2), "utf8");

        await executeInstallCommand({
            kind: "install",
            client: "claude",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(configPath));
        assert.deepEqual(installed.projects["/tmp/example"].allowedTools, ["Read"]);
        assert.equal(installed.mcpServers.existing.command, "npx");
        assert.equal(installed.mcpServers.satori.type, "stdio");
        assert.equal(installed.mcpServers.satori.command, process.execPath);
        assert.deepEqual(installed.mcpServers.satori.args, fakeClientCommand(homeDir).args);
        // Omit unset provider keys so empty ${VAR:-} defaults cannot override host env with "".
        assert.equal(installed.mcpServers.satori.env, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori, "timeout"), false);
        assert.equal(fs.existsSync(path.join(skillsDir, "satori", "SKILL.md")), true);

        const uninstall = await executeInstallCommand({
            kind: "uninstall",
            client: "claude",
            dryRun: false,
        }, { homeDir });

        assert.equal(uninstall.results[0]?.status, "updated");
        const removed = JSON.parse(readFile(configPath));
        assert.equal(Boolean(removed.mcpServers.satori), false);
        assert.equal(removed.mcpServers.existing.command, "npx");
        assert.equal(fs.existsSync(path.join(skillsDir, "custom-skill", "SKILL.md")), true);
        assert.equal(fs.existsSync(path.join(skillsDir, "satori")), false);
    });
});

test("install preserves direct Claude Satori env values on reinstall", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcpServers: {
                satori: {
                    command: process.execPath,
                    args: [launcherPath(homeDir)],
                    timeout: 120000,
                    env: {
                        VOYAGEAI_API_KEY: "direct-key",
                        MILVUS_TOKEN: "direct-token",
                    },
                },
            },
        }, null, 2), "utf8");

        await executeInstallCommand({
            kind: "install",
            client: "claude",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(configPath));
        assert.equal(installed.mcpServers.satori.env.VOYAGEAI_API_KEY, "direct-key");
        assert.equal(installed.mcpServers.satori.env.MILVUS_TOKEN, "direct-token");
        // Unset keys are omitted (not rewritten as empty-defaulting ${VAR:-}).
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori.env, "EMBEDDING_OUTPUT_DIMENSION"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori, "timeout"), false);
    });
});

test("install strips empty-defaulting Claude env expansions on reinstall", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcpServers: {
                satori: {
                    command: process.execPath,
                    args: [launcherPath(homeDir)],
                    env: {
                        VOYAGEAI_API_KEY: "${VOYAGEAI_API_KEY:-}",
                        MILVUS_ADDRESS: "${MILVUS_ADDRESS:-}",
                        EMBEDDING_PROVIDER: "VoyageAI",
                    },
                },
            },
        }, null, 2), "utf8");

        await executeInstallCommand({
            kind: "install",
            client: "claude",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(configPath));
        assert.equal(installed.mcpServers.satori.env.EMBEDDING_PROVIDER, "VoyageAI");
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori.env, "VOYAGEAI_API_KEY"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(installed.mcpServers.satori.env, "MILVUS_ADDRESS"), false);
    });
});

test("install refuses to overwrite unmanaged Claude Satori entries", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcpServers: {
                satori: {
                    command: "node",
                    args: ["/custom/satori.js"],
                    timeout: 180000,
                }
            }
        }, null, 2), "utf8");

        await assert.rejects(
            () => executeInstallCommand({
                kind: "install",
                client: "claude",
            runtime: "voyage",
                dryRun: false,
            }, installOptions(homeDir)),
            /Refusing to overwrite unmanaged Satori config/
        );
    });
});

test("uninstall refuses to remove unmanaged Claude Satori entries", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const original = JSON.stringify({
            mcpServers: {
                satori: {
                    command: "node",
                    args: ["/custom/satori.js"],
                    timeout: 180000,
                }
            }
        }, null, 2);
        fs.writeFileSync(configPath, original, "utf8");

        await assert.rejects(
            () => executeInstallCommand({
                kind: "uninstall",
                client: "claude",
                dryRun: false,
            }, { homeDir }),
            /Refusing to remove unmanaged Satori config/
        );

        assert.equal(readFile(configPath).trim(), original.trim());
    });
});

test("install writes OpenCode JSONC config and AGENTS instructions", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, [
            "{",
            "  // keep this comment",
            "  \"mcp\": {",
            "    \"existing\": {",
            "      \"enabled\": true,",
            "      \"type\": \"local\",",
            "      \"command\": [\"other-server\"]",
            "    }",
            "  }",
            "}",
            "",
        ].join("\n"), "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "opencode",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.client, "opencode");
        assert.equal(result.results[0]?.skillsChanged, false);
        assert.equal(result.results[0]?.instructionsChanged, true);
        assert.equal(result.results[0]?.instructionsPath, path.join(homeDir, ".config", "opencode", "AGENTS.md"));
        const content = readFile(configPath);
        assert.equal(content.includes("// keep this comment"), true);
        assert.equal(content.includes("\"existing\""), true);
        assert.equal(content.includes("\"satori\""), true);
        assert.equal(content.includes(launcherPath(homeDir)), true);
        assert.equal(content.includes("\"environment\""), true);
        assert.equal(content.includes("\"VOYAGEAI_API_KEY\": \"{env:VOYAGEAI_API_KEY}\""), true);
        assert.equal(content.includes("\"EMBEDDING_OUTPUT_DIMENSION\": \"{env:EMBEDDING_OUTPUT_DIMENSION}\""), true);
        assert.equal(content.includes("\"MILVUS_ADDRESS\": \"{env:MILVUS_ADDRESS}\""), true);
        assert.equal(content.includes("node_modules"), false);

        const instructions = readFile(path.join(homeDir, ".config", "opencode", "AGENTS.md"));
        assert.equal(instructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(instructions.includes("search_codebase"), true);
        assert.equal(instructions.includes("native tools remain appropriate for known paths and exact literals"), true);
        assert.equal(instructions.includes("obtain explicit user approval before reindexing"), true);
    });
});

test("install all smoke writes launcher-backed config for every supported client", async () => {
    await withTempHome(async (homeDir) => {
        const result = await executeInstallCommand({
            kind: "install",
            client: "all",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        assert.deepEqual(result.results.map((entry) => entry.client), ["codex", "claude", "opencode"]);
        assert.equal(result.results.every((entry) => entry.status === "updated"), true);

        const launcher = readFile(launcherPath(homeDir));
        assert.equal(launcher.includes('require("node:child_process")'), true);
        assert.equal(launcher.includes("node_modules"), true);
        assert.equal(launcher.includes("dist/index.js"), true);

        const codexConfig = readFile(path.join(homeDir, ".codex", "config.toml"));
        assert.equal(codexConfig.includes(`command = "${process.execPath.replace(/\\/g, "\\\\")}"`), true);
        assert.equal(codexConfig.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), true);
        assert.equal(codexConfig.includes("env_vars = ["), true);
        assert.equal(codexConfig.includes("\"VOYAGEAI_API_KEY\""), true);
        assert.equal(codexConfig.includes("\"EMBEDDING_OUTPUT_DIMENSION\""), true);
        assert.equal(codexConfig.includes("\"MILVUS_ADDRESS\""), true);
        assert.equal(codexConfig.includes("# Runtime selection is installer-owned by ~/.satori/bin/satori-mcp.js."), true);
        assert.equal(codexConfig.includes("# [mcp_servers.satori.env]"), false);
        assert.equal(codexConfig.includes('command = "npx"'), false);
        assert.equal(codexConfig.includes("startup_timeout_ms"), false);
        assert.equal(codexConfig.includes("node_modules"), false);
        assert.equal(codexConfig.includes("dist/index.js"), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), true);
        const codexInstructions = readFile(path.join(homeDir, ".codex", "AGENTS.md"));
        assert.equal(codexInstructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(codexInstructions.includes("Satori MCP is available"), true);
        assert.equal(codexInstructions.includes("recommendedNextAction"), true);
        assert.equal(codexInstructions.includes("warnings[].action"), true);
        assert.equal(codexInstructions.includes("navigation.graph=\"ready\""), true);
        assert.equal(codexInstructions.includes("Do not treat call_graph inbound results as sole authority"), true);

        const claudeConfig = JSON.parse(readFile(path.join(homeDir, ".claude.json")));
        assert.equal(claudeConfig.mcpServers.satori.type, "stdio");
        assert.equal(claudeConfig.mcpServers.satori.command, process.execPath);
        assert.deepEqual(claudeConfig.mcpServers.satori.args, fakeClientCommand(homeDir).args);
        assert.equal(claudeConfig.mcpServers.satori.env, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(claudeConfig.mcpServers.satori, "timeout"), false);
        assert.equal(JSON.stringify(claudeConfig.mcpServers.satori).includes("node_modules"), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude", "skills", "satori", "SKILL.md")), true);

        const opencodeConfig = JSON.parse(readFile(path.join(homeDir, ".config", "opencode", "opencode.json")));
        assert.equal(opencodeConfig.mcp.satori.enabled, true);
        assert.equal(opencodeConfig.mcp.satori.type, "local");
        assert.deepEqual(opencodeConfig.mcp.satori.command, [process.execPath, launcherPath(homeDir)]);
        assert.equal(opencodeConfig.mcp.satori.environment.VOYAGEAI_API_KEY, "{env:VOYAGEAI_API_KEY}");
        assert.equal(opencodeConfig.mcp.satori.environment.EMBEDDING_OUTPUT_DIMENSION, "{env:EMBEDDING_OUTPUT_DIMENSION}");
        assert.equal(opencodeConfig.mcp.satori.environment.MILVUS_ADDRESS, "{env:MILVUS_ADDRESS}");
        assert.equal(JSON.stringify(opencodeConfig.mcp.satori).includes("node_modules"), false);
        const opencodeInstructions = readFile(path.join(homeDir, ".config", "opencode", "AGENTS.md"));
        assert.equal(opencodeInstructions.includes("<!-- satori-mcp:start -->"), true);
        assert.equal(opencodeInstructions.includes("search_codebase"), true);
        assert.equal(opencodeInstructions.includes("recommendedNextAction"), true);
        assert.equal(opencodeInstructions.includes("warnings[].action"), true);
        assert.equal(opencodeInstructions.includes('navigation.inbound="verify"'), true);
        assert.equal(opencodeInstructions.includes("callerSearchTerm"), true);
    });
});

test("managed client inspection reuses installer parsers and reports stale wiring", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand({
            kind: "install",
            client: "all",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const healthy = inspectManagedClientConfigurations(homeDir, {
            VOYAGEAI_API_KEY: "pa-client-owned",
            MILVUS_ADDRESS: "localhost:19530",
        });
        assert.deepEqual(healthy.map((proof) => proof.client), ["codex", "claude", "opencode"]);
        assert.equal(healthy.every((proof) => proof.status === "ok"), true);
        assert.equal(healthy.every((proof) => proof.usesManagedLauncher === true), true);
        assert.equal(
            healthy.find((proof) => proof.client === "opencode")?.runtimeEnvironment?.VOYAGEAI_API_KEY,
            "pa-client-owned",
        );

        const claudePath = path.join(homeDir, ".claude.json");
        const claude = JSON.parse(fs.readFileSync(claudePath, "utf8")) as {
            mcpServers: { satori: { command: string } };
        };
        claude.mcpServers.satori.command = "/stale/node";
        fs.writeFileSync(claudePath, JSON.stringify(claude), "utf8");

        const stale = inspectManagedClientConfigurations(homeDir);
        assert.equal(stale.find((proof) => proof.client === "claude")?.status, "error");
        assert.equal(stale.filter((proof) => proof.status === "ok").length, 2);
    });
});

test("install --profile writes repo-local Satori config once for all clients", async () => {
    await withTempHome(async (homeDir) => {
        await withTempRepo(async (repoDir) => {
            const result = await executeInstallCommand({
                kind: "install",
                client: "all",
            runtime: "voyage",
                dryRun: false,
                profile: "minimal",
            }, {
                ...installOptions(homeDir),
                repoDir,
            });

            const configPath = path.join(repoDir, "satori.toml");
            assert.equal(result.profile, "minimal");
            assert.equal(result.profileConfigPath, configPath);
            assert.equal(result.profileConfigChanged, true);
            assert.equal(fs.existsSync(configPath), true);
            assert.equal(readFile(configPath), [
                "# Satori project config",
                "[index]",
                "profile = \"minimal\"",
                "",
            ].join("\n"));
        });
    });
});

test("install --profile updates existing repo config and preserves unrelated TOML", async () => {
    await withTempHome(async (homeDir) => {
        await withTempRepo(async (repoDir) => {
            const configPath = path.join(repoDir, "satori.toml");
            fs.writeFileSync(configPath, [
                "[project]",
                "name = \"demo\"",
                "",
                "[index]",
                "profile = \"all-text\"",
                "",
            ].join("\n"), "utf8");

            const result = await executeInstallCommand({
                kind: "install",
                client: "codex",
            runtime: "voyage",
                dryRun: false,
                profile: "minimal",
            }, {
                ...installOptions(homeDir),
                repoDir,
            });

            assert.equal(result.profileConfigChanged, true);
            assert.equal(readFile(configPath), [
                "[project]",
                "name = \"demo\"",
                "",
                "[index]",
                "profile = \"minimal\"",
                "",
            ].join("\n"));
        });
    });
});

test("uninstall removes managed OpenCode config and instruction block only", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        const instructionsPath = path.join(homeDir, ".config", "opencode", "AGENTS.md");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });

        await executeInstallCommand({
            kind: "install",
            client: "opencode",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));
        fs.writeFileSync(instructionsPath, `${readFile(instructionsPath)}\n# User Notes\n`, "utf8");

        await executeInstallCommand({
            kind: "uninstall",
            client: "opencode",
            dryRun: false,
        }, { homeDir });

        const removed = JSON.parse(readFile(configPath));
        assert.equal(Boolean(removed.mcp?.satori), false);
        const instructions = readFile(instructionsPath);
        assert.equal(instructions.includes("<!-- satori-mcp:start -->"), false);
        assert.equal(instructions.includes("# User Notes"), true);
    });
});

test("install preserves direct OpenCode Satori environment values on reinstall", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcp: {
                satori: {
                    enabled: true,
                    type: "local",
                    command: [process.execPath, launcherPath(homeDir)],
                    environment: {
                        VOYAGEAI_API_KEY: "direct-key",
                        MILVUS_TOKEN: "direct-token",
                    },
                },
            },
        }, null, 2), "utf8");

        await executeInstallCommand({
            kind: "install",
            client: "opencode",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const installed = JSON.parse(readFile(configPath));
        assert.equal(installed.mcp.satori.environment.VOYAGEAI_API_KEY, "direct-key");
        assert.equal(installed.mcp.satori.environment.MILVUS_TOKEN, "direct-token");
        assert.equal(installed.mcp.satori.environment.EMBEDDING_OUTPUT_DIMENSION, "{env:EMBEDDING_OUTPUT_DIMENSION}");
    });
});

test("install refuses to overwrite unmanaged OpenCode Satori entries", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcp: {
                satori: {
                    enabled: true,
                    type: "local",
                    command: ["node", "/custom/satori.js"],
                }
            }
        }, null, 2), "utf8");

        await assert.rejects(
            () => executeInstallCommand({
                kind: "install",
                client: "opencode",
            runtime: "voyage",
                dryRun: false,
            }, installOptions(homeDir)),
            /Refusing to overwrite unmanaged Satori config/
        );
    });
});

test("install all preflights every target before mutating any config", async () => {
    await withTempHome(async (homeDir) => {
        const claudeConfigPath = path.join(homeDir, ".claude.json");
        fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
        fs.writeFileSync(claudeConfigPath, "{ not valid json", "utf8");

        await assert.rejects(
            () => executeInstallCommand({
                kind: "install",
                client: "all",
            runtime: "voyage",
                dryRun: false,
            }, installOptions(homeDir)),
            /Failed to parse JSON config/
        );

        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), false);
    });
});

test("Codex-only install ignores malformed unrelated Claude config", async () => {
    await withTempHome(async (homeDir) => {
        fs.writeFileSync(path.join(homeDir, ".claude.json"), "{ not valid json", "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        assert.equal(result.results.length, 1);
        assert.equal(result.results[0]?.client, "codex");
        assert.equal(readFile(path.join(homeDir, ".claude.json")), "{ not valid json");
    });
});

test("reinstall rejects malformed installer-owned launcher identity", async () => {
    await withTempHome(async (homeDir) => {
        const managedLauncher = launcherPath(homeDir);
        fs.mkdirSync(path.dirname(managedLauncher), { recursive: true });
        fs.writeFileSync(managedLauncher, [
            "#!/usr/bin/env node",
            "const managedEnv = {not-json};",
            "",
        ].join("\n"), "utf8");

        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                runtime: "voyage",
                dryRun: true,
            }, installOptions(homeDir)),
            (error: unknown) => {
                assert.equal((error as { token?: string }).token, "E_MANAGED_RUNTIME_ENV_INVALID");
                assert.match(error instanceof Error ? error.message : String(error), /contains invalid runtime identity/);
                return true;
            },
        );
    });
});

test("dry-run reports install actions without writing files", async () => {
    await withTempHome(async (homeDir) => {
        const result = await executeInstallCommand({
            kind: "install",
            client: "all",
            runtime: "voyage",
            dryRun: true,
        }, installOptions(homeDir));

        assert.equal(result.results.length, 3);
        assert.equal(result.results.every((entry) => entry.dryRun), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude.json")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".config", "opencode", "opencode.json")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "AGENTS.md")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori", "SKILL.md")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude", "skills", "satori", "SKILL.md")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".config", "opencode", "AGENTS.md")), false);
        assert.equal(fs.existsSync(launcherPath(homeDir)), false);
    });
});

test("application failure reports completed and unattempted mutation paths", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-install-partial-home-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-install-partial-repo-"));
    fs.writeFileSync(path.join(homeDir, ".codex"), "blocks directory creation", "utf8");
    try {
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                runtime: "voyage",
                dryRun: false,
                profile: "minimal",
            }, {
                homeDir,
                repoDir,
                packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
                runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            }),
            (error: unknown) => {
                assert.equal((error as { token?: string }).token, "E_INSTALL_PARTIAL");
                const message = error instanceof Error ? error.message : String(error);
                assert.equal(message.includes(`managed launcher at ${launcherPath(homeDir)}`), true);
                assert.equal(message.includes(`repository profile at ${path.join(repoDir, "satori.toml")}`), true);
                assert.equal(message.includes(`while applying codex client configuration at ${path.join(homeDir, ".codex", "config.toml")}`), true);
                assert.match(message, /Not yet applied: codex skills at/);
                assert.match(message, /correct the error and rerun the same command/);
                return true;
            },
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
});
