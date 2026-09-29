import test from "node:test";
import { parseCliArgs } from "./args.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { connectCliMcpSession } from "./client.js";
import { CliError } from "./errors.js";
import {
    executeInstallCommand as executeInstallCommandProduction,
    executeManagedRuntimeUpgrade,
    createInstallPlan,
    inspectManagedClientConfigurations,
    type InstallCommandInput,
    type InstallCommandOptions,
} from "./install.js";
import {
    buildLauncherScript,
    parseManagedLauncherDescriptor,
} from "./managed-launcher-script.mjs";
import {
    LATEON_FIXTURE_ARTIFACTS,
    writeLateOnAcquisitionFixture,
    writeLateOnModelDirectory,
} from "./test-fixtures/lateon-fixture.js";
import { plannedCbmExtendedDirectory } from "./cbm-extractor-store.js";
import { planInstallRuntimeEnvironment } from "./install-preflight.js";
import { loadAcquisitionAuthority } from "./lateon-model-store.js";
import { formatInstallText } from "./install-format.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POTION_ASSETS_ROOT = path.resolve(PACKAGE_ROOT, "../mcp/assets/potion/linux-x64");
const POSTFLIGHT_MCP_RUNTIME_FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "test-fixtures",
    "postflight-mcp-runtime.mjs",
);
const PACKAGE_JSON = JSON.parse(
    fs.readFileSync(path.resolve(PACKAGE_ROOT, "..", "mcp", "package.json"), "utf8")
) as { name: string; version: string; bin?: Record<string, string> };
const CORE_PACKAGE_JSON = JSON.parse(
    fs.readFileSync(path.resolve(PACKAGE_ROOT, "..", "core", "package.json"), "utf8")
) as { name: string; version: string; dependencies?: Record<string, string> };
const EXPECTED_PACKAGE_SPECIFIER = `${PACKAGE_JSON.name}@${PACKAGE_JSON.version}`;
const EXPECTED_OXC_BINDING_SPECIFIER = `@oxc-parser/binding-linux-x64-gnu@${CORE_PACKAGE_JSON.dependencies?.["oxc-parser"]}`;

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
        potionModelPath: path.join(POTION_ASSETS_ROOT, "model"),
        modelRetryDelaysMs: [],
        lateOnAuthorityLoader: loadAcquisitionAuthority,
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
                "@satori-code-mcp-4.11.2",
                "node_modules",
                "@satori-code",
                "mcp",
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

function installRuntimePackageStub(
    relativeEntry: string,
    expectedSpecifier = EXPECTED_PACKAGE_SPECIFIER,
    installedVersion = expectedSpecifier.slice(expectedSpecifier.lastIndexOf("@") + 1),
    installedCoreVersion = CORE_PACKAGE_JSON.version,
    writeCorePackage = true,
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
        assert.notEqual(args.indexOf("--omit=optional"), -1);
        assert.notEqual(args.indexOf(EXPECTED_OXC_BINDING_SPECIFIER), -1);
        const packageRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
        const entryPath = path.join(packageRoot, relativeEntry);
        fs.mkdirSync(path.dirname(entryPath), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@satori-code/mcp",
            version: installedVersion,
            bin: {
                satori: relativeEntry,
            },
        }, null, 2), "utf8");
        fs.writeFileSync(entryPath, "#!/usr/bin/env node\n", "utf8");
        if (writeCorePackage) {
            const corePackageRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "core");
            fs.mkdirSync(corePackageRoot, { recursive: true });
            fs.writeFileSync(path.join(corePackageRoot, "package.json"), JSON.stringify({
                name: "@satori-code/core",
                version: installedCoreVersion,
                exports: {
                    "./package.json": "./package.json",
                },
            }, null, 2), "utf8");
        }
        writeLateOnAcquisitionFixture(packageRoot);
        return "";
    };
}

function installRuntimePackageWithPreflightCore(
    relativeEntry: string,
    expectedSpecifier: string,
    installedVersion: string,
    installedCoreVersion: string,
) {
    const install = installRuntimePackageStub(
        relativeEntry,
        expectedSpecifier,
        installedVersion,
        installedCoreVersion,
    );
    return (command: string, args: string[]) => {
        const result = install(command, args);
        const runtimeRoot = args[args.indexOf("--prefix") + 1]!;
        const corePackageRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "core");
        const packageJsonPath = path.join(corePackageRoot, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
        packageJson.exports = {
            ".": "./index.mjs",
            "./package.json": "./package.json",
        };
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf8");
        fs.writeFileSync(path.join(corePackageRoot, "index.mjs"), [
            "export async function restoreVerifiedOwnerExecutableBit() {}",
            "export const PotionEmbedding = { async create() { return { async close() {} }; } };",
            "export async function resolveOllamaModelIdentity({ model }) {",
            "  return {",
            "    configuredModel: model,",
            "    resolvedModel: `${model}:latest`,",
            `    artifactDigest: ${JSON.stringify(`sha256:${"a".repeat(64)}`)},`,
            "    artifactSize: 42,",
            "    dimension: 768,",
            "  };",
            "}",
            "",
        ].join("\n"), "utf8");
        return result;
    };
}

test("Oxc native target resolution failure leaves no candidate runtime directory", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-oxc-resolution-failure-"));
    const runtimeRoot = path.join(homeDir, ".satori", "mcp-runtime", "@satori-code-mcp@6.8.1");
    let installCalls = 0;
    try {
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: false,
                runtime: "voyage",
                vectorStore: "Milvus",
            }, {
                homeDir,
                env: {
                    VECTOR_STORE_PROVIDER: "Milvus",
                    MILVUS_ADDRESS: "localhost:19530",
                },
                packageSpecifier: "@satori-code/mcp@6.8.1",
                platform: "linux",
                architecture: "s390x",
                execFileSyncImpl: (() => {
                    installCalls += 1;
                    return "";
                }) as never,
            }),
            /unsupported on linux\/s390x\/gnu/,
        );
        assert.equal(installCalls, 0);
        assert.equal(fs.existsSync(runtimeRoot), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("LanceDB native target resolution failure leaves no candidate runtime directory", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-resolution-failure-"));
    const runtimeRoot = path.join(homeDir, ".satori", "mcp-runtime", "@satori-code-mcp@6.8.1");
    let installCalls = 0;
    try {
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: false,
                runtime: "voyage",
                vectorStore: "LanceDB",
            }, {
                homeDir,
                env: {},
                packageSpecifier: "@satori-code/mcp@6.8.1",
                platform: "linux",
                architecture: "s390x",
                execFileSyncImpl: (() => {
                    installCalls += 1;
                    return "";
                }) as never,
            }),
            /LanceDB managed runtime is unsupported on linux\/s390x\/gnu/,
        );
        assert.equal(installCalls, 0);
        assert.equal(fs.existsSync(runtimeRoot), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

function brokenRuntimePackageStub(
    expectedSpecifier: string,
    startedMarkerPath: string,
    installedPrefixes: string[],
) {
    const install = installRuntimePackageStub("dist/broken-runtime.mjs", expectedSpecifier);
    return (command: string, args: string[]) => {
        assert.equal(
            args.some((argument) => argument.startsWith("@lancedb/lancedb-")),
            false,
        );
        const result = install(command, args);
        const prefix = args[args.indexOf("--prefix") + 1];
        installedPrefixes.push(prefix);
        fs.writeFileSync(
            path.join(prefix, "node_modules", "@satori-code", "mcp", "dist", "broken-runtime.mjs"),
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

const UPGRADE_TARGET = {
    cliPackageSpecifier: "@satori-code/cli@1.3.0",
    cliVersion: "1.3.0",
    mcpPackageSpecifier: "@satori-code/mcp@6.2.0",
    mcpVersion: "6.2.0",
    coreVersion: "3.1.0",
} as const;

async function installUpgradeSourceRuntime(
    homeDir: string,
    managedEnvironment: Readonly<Record<string, string>>,
    options: {
        mcpVersion?: string;
        coreVersion?: string;
    } = {},
): Promise<void> {
    const mcpVersion = options.mcpVersion ?? "6.1.0";
    const coreVersion = options.coreVersion ?? "3.0.0";
    const packageSpecifier = `@satori-code/mcp@${mcpVersion}`;
    await executeInstallCommand({
        kind: "install",
        client: "codex",
        runtime: "voyage",
        dryRun: false,
    }, {
        homeDir,
        packageSpecifier,
        execFileSyncImpl: installRuntimePackageStub(
            "dist/source-runtime.mjs",
            packageSpecifier,
            mcpVersion,
            coreVersion,
        ) as never,
        preflightRunner: async () => ({
            runtimeEnvironment: managedEnvironment,
        }),
    });
}

function writeCorePackage(packageRoot: string, version: string): void {
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@satori-code/core",
        version,
        exports: {
            "./package.json": "./package.json",
        },
    }, null, 2), "utf8");
}

async function runOfflineUpgradeWithProductionPreflight(
    homeDir: string,
    embeddingProvider: "Potion" | "Ollama",
): Promise<Readonly<Record<string, string>>> {
    await installUpgradeSourceRuntime(homeDir, {
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: embeddingProvider,
        SATORI_RERANKER_PROVIDER: "none",
        ...(embeddingProvider === "Ollama" ? { OLLAMA_MODEL: "nomic-embed-text" } : {}),
    });

    const result = await executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
        homeDir,
        env: {},
        platform: "linux",
        architecture: "x64",
        potionAssetsRoot: POTION_ASSETS_ROOT,
        potionModelPath: path.join(POTION_ASSETS_ROOT, "model"),
        execFileSyncImpl: installRuntimePackageWithPreflightCore(
            "dist/target-runtime.mjs",
            UPGRADE_TARGET.mcpPackageSpecifier,
            UPGRADE_TARGET.mcpVersion,
            UPGRADE_TARGET.coreVersion,
        ) as never,
        preflightDependencies: {
            probeLanceDb: async () => {},
            probeCandidateRuntime: async () => {},
        },
    });

    assert.equal(result.status, "upgraded");
    return parseManagedLauncherDescriptor(readFile(launcherPath(homeDir))).managedEnv;
}

test("managed Potion upgrade uses the staged Core preflight verifier", async () => {
    await withTempHome(async (homeDir) => {
        const environment = await runOfflineUpgradeWithProductionPreflight(homeDir, "Potion");
        assert.equal(environment.EMBEDDING_PROVIDER, "Potion");
    });
});

test("managed Ollama upgrade uses the staged Core identity resolver", async () => {
    await withTempHome(async (homeDir) => {
        const environment = await runOfflineUpgradeWithProductionPreflight(homeDir, "Ollama");
        assert.equal(environment.EMBEDDING_PROVIDER, "Ollama");
        assert.equal(environment.OLLAMA_MODEL, "nomic-embed-text:latest");
    });
});

test("install writes managed Codex config and the canonical Satori skill without AGENTS guidance", async () => {
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
        assert.equal(result.results[0]?.skillChanged, true);
        assert.equal(result.results[0]?.skillPath, path.join(homeDir, ".agents", "skills", "satori"));
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
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "AGENTS.md")), false);
        const skill = readFile(path.join(homeDir, ".agents", "skills", "satori", "SKILL.md"));
        assert.equal(skill.startsWith("---\nname: satori\n"), true);
        assert.equal(skill.includes("satori-managed-skill"), true);
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
            packageSpecifier: "@satori-code/mcp@1.0.0-test",
            execFileSyncImpl: installRuntimePackageStub("dist/old-runtime.mjs", "@satori-code/mcp@1.0.0-test") as never,
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
                packageSpecifier: "@satori-code/mcp@2.0.0-test",
                execFileSyncImpl: installRuntimePackageStub("dist/new-runtime.mjs", "@satori-code/mcp@2.0.0-test") as never,
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
        const oldSpecifier = "@satori-code/mcp@1.0.0-test";
        const newSpecifier = "@satori-code/mcp@2.0.0-test";
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
        const requestedSpecifier = "@satori-code/mcp@2.0.0-test";
        const stableRoot = path.join(
            homeDir,
            ".satori",
            "mcp-runtime",
            "@satori-code-mcp@2.0.0-test",
        );
        const stalePackageRoot = path.join(stableRoot, "node_modules", "@satori-code", "mcp");
        fs.mkdirSync(path.join(stalePackageRoot, "dist"), { recursive: true });
        fs.writeFileSync(path.join(stalePackageRoot, "package.json"), JSON.stringify({
            name: "@satori-code/mcp",
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
        assert.equal(fs.existsSync(stableRoot), false);
    });
});

test("runtime reuse never treats a package tag as a resolved immutable version", async () => {
    await withTempHome(async (homeDir) => {
        const requestedSpecifier = "@satori-code/mcp@latest";
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
        const oldSpecifier = "@satori-code/mcp@1.0.0-test";
        const newSpecifier = "@satori-code/mcp@2.0.0-test";
        const installedPrefixes: string[] = [];
        const preflightEntries: string[] = [];
        const installVersion = (entry: string, specifier: string) => {
            const install = installRuntimePackageStub(entry, specifier);
            return ((command: string, args: string[]) => {
                assert.equal(
                    args.some((argument) => (
                        argument === "@lancedb/lancedb-linux-x64-gnu@0.31.0"
                    )),
                    true,
                );
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
        assert.equal(fs.existsSync(oldRuntimeRoot), false);
    });
});

test("managed runtime upgrade replaces MCP and Core without rewriting client configuration", async () => {
    await withTempHome(async (homeDir) => {
        const oldSpecifier = "@satori-code/mcp@6.1.0";
        const newSpecifier = "@satori-code/mcp@6.2.0";
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: oldSpecifier,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/old-runtime.mjs",
                oldSpecifier,
                "6.1.0",
                "3.0.0",
            ) as never,
        });
        const codexConfigPath = path.join(homeDir, ".codex", "config.toml");
        const originalConfig = readFile(codexConfigPath);
        const originalLauncher = readFile(launcherPath(homeDir));
        let candidateProbes = 0;
        const progressPhases: string[] = [];

        const result = await executeManagedRuntimeUpgrade({
            cliPackageSpecifier: "@satori-code/cli@1.3.0",
            cliVersion: "1.3.0",
            mcpPackageSpecifier: newSpecifier,
            mcpVersion: "6.2.0",
            coreVersion: "3.1.0",
        }, {
            homeDir,
            env: { VECTOR_STORE_PROVIDER: "LanceDB" },
            packageSpecifier: newSpecifier,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/new-runtime.mjs",
                newSpecifier,
                "6.2.0",
                "3.1.0",
            ) as never,
            preflightRunner: async (input) => {
                assert.equal(input.runtime, "voyage");
                return {
                    runtimeEnvironment: Object.freeze({
                        SATORI_RUNTIME_PROFILE: "connected",
                        VECTOR_STORE_PROVIDER: "LanceDB",
                    }),
                };
            },
            preflightDependencies: {
                probeCandidateRuntime: async ({ expectedVersion }) => {
                    candidateProbes += 1;
                    assert.equal(expectedVersion, "6.2.0");
                },
            },
            onUpgradeProgress: (phase) => {
                progressPhases.push(phase);
            },
        });

        assert.equal(result.status, "upgraded");
        assert.equal(result.fromMcpVersion, "6.1.0");
        assert.equal(result.toMcpVersion, "6.2.0");
        assert.equal(result.fromCoreVersion, "3.0.0");
        assert.equal(result.toCoreVersion, "3.1.0");
        assert.deepEqual(result.configuredClients, ["codex"]);
        assert.equal(candidateProbes, 1);
        assert.deepEqual(progressPhases, ["installing", "verifying", "activating"]);
        assert.equal(readFile(codexConfigPath), originalConfig);
        assert.notEqual(readFile(launcherPath(homeDir)), originalLauncher);
        assert.match(readFile(launcherPath(homeDir)), /new-runtime\.mjs/);
    });
});

test("failed managed runtime upgrade preserves the previous launcher and removes its candidate", async () => {
    await withTempHome(async (homeDir) => {
        const oldSpecifier = "@satori-code/mcp@6.1.0";
        const newSpecifier = "@satori-code/mcp@6.2.0";
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: oldSpecifier,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/old-runtime.mjs",
                oldSpecifier,
                "6.1.0",
                "3.0.0",
            ) as never,
        });
        const originalLauncher = readFile(launcherPath(homeDir));
        const candidateRoot = path.join(
            homeDir,
            ".satori",
            "mcp-runtime",
            "@satori-code-mcp@6.2.0",
        );

        await assert.rejects(
            executeManagedRuntimeUpgrade({
                cliPackageSpecifier: "@satori-code/cli@1.3.0",
                cliVersion: "1.3.0",
                mcpPackageSpecifier: newSpecifier,
                mcpVersion: "6.2.0",
                coreVersion: "3.1.0",
            }, {
                homeDir,
                env: { VECTOR_STORE_PROVIDER: "LanceDB" },
                execFileSyncImpl: installRuntimePackageStub(
                    "dist/new-runtime.mjs",
                    newSpecifier,
                    "6.2.0",
                    "3.1.0",
                ) as never,
                preflightRunner: async () => {
                    throw new Error("candidate rejected");
                },
                preflightDependencies: {
                    probeCandidateRuntime: async () => {},
                },
            }),
            /candidate rejected/,
        );

        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
        assert.equal(fs.existsSync(candidateRoot), false);
    });
});

test("managed runtime upgrade refuses to overwrite a launcher changed during preflight", async () => {
    await withTempHome(async (homeDir) => {
        const oldSpecifier = "@satori-code/mcp@6.1.0";
        const newSpecifier = "@satori-code/mcp@6.2.0";
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: oldSpecifier,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/old-runtime.mjs",
                oldSpecifier,
                "6.1.0",
                "3.0.0",
            ) as never,
        });
        const concurrentLauncher = "# concurrent launcher replacement\n";

        await assert.rejects(
            executeManagedRuntimeUpgrade({
                cliPackageSpecifier: "@satori-code/cli@1.3.0",
                cliVersion: "1.3.0",
                mcpPackageSpecifier: newSpecifier,
                mcpVersion: "6.2.0",
                coreVersion: "3.1.0",
            }, {
                homeDir,
                env: { VECTOR_STORE_PROVIDER: "LanceDB" },
                execFileSyncImpl: installRuntimePackageStub(
                    "dist/new-runtime.mjs",
                    newSpecifier,
                    "6.2.0",
                    "3.1.0",
                ) as never,
                preflightRunner: async () => {
                    fs.writeFileSync(launcherPath(homeDir), concurrentLauncher, "utf8");
                    return {
                        runtimeEnvironment: Object.freeze({
                            SATORI_RUNTIME_PROFILE: "connected",
                            VECTOR_STORE_PROVIDER: "LanceDB",
                        }),
                    };
                },
                preflightDependencies: {
                    probeCandidateRuntime: async () => {},
                },
            }),
            /changed after the installation plan was created/,
        );

        assert.equal(readFile(launcherPath(homeDir)), concurrentLauncher);
    });
});

test("managed runtime upgrade is a no-op when both MCP and Core are current", async () => {
    await withTempHome(async (homeDir) => {
        const currentSpecifier = "@satori-code/mcp@6.2.0";
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: currentSpecifier,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/current-runtime.mjs",
                currentSpecifier,
                "6.2.0",
                "3.1.0",
            ) as never,
        });
        const originalLauncher = readFile(launcherPath(homeDir));

        const result = await executeManagedRuntimeUpgrade({
            cliPackageSpecifier: "@satori-code/cli@1.3.0",
            cliVersion: "1.3.0",
            mcpPackageSpecifier: currentSpecifier,
            mcpVersion: "6.2.0",
            coreVersion: "3.1.0",
        }, {
            homeDir,
            execFileSyncImpl: (() => {
                throw new Error("up-to-date runtime must not install");
            }) as never,
            preflightRunner: async () => {
                throw new Error("up-to-date runtime must not preflight");
            },
        });

        assert.equal(result.status, "up_to_date");
        assert.equal(result.restartRequired, false);
        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
    });
});

test("managed runtime upgrade replaces a current legacy closure without the slim manifest", async () => {
    await withTempHome(async (homeDir) => {
        const currentSpecifier = "@satori-code/mcp@6.2.0";
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            runtime: "voyage",
            dryRun: false,
        }, {
            homeDir,
            packageSpecifier: currentSpecifier,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/legacy-runtime.mjs",
                currentSpecifier,
                "6.2.0",
                "3.1.0",
            ) as never,
        });
        const legacyRoot = path.join(
            homeDir,
            ".satori",
            "mcp-runtime",
            "@satori-code-mcp@6.2.0",
        );
        fs.rmSync(path.join(legacyRoot, ".satori-runtime-closure.json"));
        const installedPrefixes: string[] = [];
        const install = installRuntimePackageStub(
            "dist/slim-runtime.mjs",
            currentSpecifier,
            "6.2.0",
            "3.1.0",
        );

        const result = await executeManagedRuntimeUpgrade({
            cliPackageSpecifier: "@satori-code/cli@1.3.0",
            cliVersion: "1.3.0",
            mcpPackageSpecifier: currentSpecifier,
            mcpVersion: "6.2.0",
            coreVersion: "3.1.0",
        }, {
            homeDir,
            execFileSyncImpl: ((command: string, args: string[]) => {
                installedPrefixes.push(args[args.indexOf("--prefix") + 1]);
                return install(command, args);
            }) as never,
            preflightRunner: async () => ({
                runtimeEnvironment: Object.freeze({
                    SATORI_RUNTIME_PROFILE: "connected",
                    VECTOR_STORE_PROVIDER: "LanceDB",
                }),
            }),
            preflightDependencies: {
                probeCandidateRuntime: async () => {},
            },
        });

        assert.equal(result.status, "upgraded");
        assert.equal(result.restartRequired, true);
        assert.equal(installedPrefixes.length, 1);
        assert.notEqual(installedPrefixes[0], legacyRoot);
        assert.equal(fs.existsSync(legacyRoot), false);
        assert.equal(
            fs.existsSync(path.join(installedPrefixes[0], ".satori-runtime-closure.json")),
            true,
        );
    });
});

test("managed runtime upgrade preserves each supported runtime selection and rejects unknown profiles", async () => {
    const cases = [
        {
            name: "offline Potion",
            managedEnvironment: {
                SATORI_RUNTIME_PROFILE: "offline",
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: "/managed/potion-lance",
                EMBEDDING_PROVIDER: "Potion",
            },
            inheritedEnvironment: {},
            expected: {
                runtime: "offline",
                vectorStore: "LanceDB",
                ollamaModel: undefined,
                lancedbPath: "/managed/potion-lance",
            },
        },
        {
            name: "offline Ollama",
            managedEnvironment: {
                SATORI_RUNTIME_PROFILE: "offline",
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: "/managed/ollama-lance",
                EMBEDDING_PROVIDER: "Ollama",
                OLLAMA_MODEL: "nomic-embed-text",
                OLLAMA_HOST: "http://127.0.0.1:11434",
            },
            inheritedEnvironment: {},
            expected: {
                runtime: "offline",
                vectorStore: "LanceDB",
                ollamaModel: "nomic-embed-text",
                lancedbPath: "/managed/ollama-lance",
            },
        },
        {
            name: "connected Milvus",
            managedEnvironment: {
                SATORI_RUNTIME_PROFILE: "connected",
                VECTOR_STORE_PROVIDER: "Milvus",
                EMBEDDING_PROVIDER: "VoyageAI",
            },
            inheritedEnvironment: {
                MILVUS_ADDRESS: "https://milvus.example.test",
            },
            expected: {
                runtime: "voyage",
                vectorStore: "Milvus",
                ollamaModel: undefined,
                lancedbPath: undefined,
            },
        },
        {
            name: "legacy connected launcher without a profile",
            managedEnvironment: {
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: "/managed/legacy-lance",
                EMBEDDING_PROVIDER: "VoyageAI",
            },
            inheritedEnvironment: {},
            expected: {
                runtime: "voyage",
                vectorStore: "LanceDB",
                ollamaModel: undefined,
                lancedbPath: "/managed/legacy-lance",
            },
        },
    ] as const;

    for (const fixture of cases) {
        await withTempHome(async (homeDir) => {
            await installUpgradeSourceRuntime(homeDir, fixture.managedEnvironment);
            writeLateOnModelDirectory(path.join(homeDir, "lateon-model"), LATEON_FIXTURE_ARTIFACTS);
            let observedSelection: {
                runtime: string;
                vectorStore?: string;
                ollamaModel?: string;
                lancedbPath?: string;
            } | undefined;

            await executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
                homeDir,
                env: fixture.inheritedEnvironment,
                lateOnModelPath: path.join(homeDir, "lateon-model"),
                platform: "linux",
                architecture: "x64",
                potionModelPath: path.join(POTION_ASSETS_ROOT, "model"),
                lateOnAuthorityLoader: loadAcquisitionAuthority,
                execFileSyncImpl: installRuntimePackageStub(
                    "dist/target-runtime.mjs",
                    UPGRADE_TARGET.mcpPackageSpecifier,
                    UPGRADE_TARGET.mcpVersion,
                    UPGRADE_TARGET.coreVersion,
                ) as never,
                preflightRunner: async (input) => {
                    observedSelection = {
                        runtime: input.runtime,
                        vectorStore: input.vectorStore,
                        ollamaModel: input.ollamaModel,
                        lancedbPath: input.env.LANCEDB_PATH,
                    };
                    return {
                        runtimeEnvironment: Object.freeze({
                            SATORI_RUNTIME_PROFILE: input.runtime === "offline" ? "offline" : "connected",
                            VECTOR_STORE_PROVIDER: input.vectorStore ?? "LanceDB",
                        }),
                    };
                },
                preflightDependencies: {
                    probeCandidateRuntime: async () => {},
                },
            });

            assert.deepEqual(observedSelection, fixture.expected, fixture.name);
        });
    }

    await withTempHome(async (homeDir) => {
        await installUpgradeSourceRuntime(homeDir, {
            SATORI_RUNTIME_PROFILE: "experimental",
            VECTOR_STORE_PROVIDER: "LanceDB",
        });
        const originalLauncher = readFile(launcherPath(homeDir));
        await assert.rejects(
            executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
                homeDir,
                execFileSyncImpl: (() => {
                    throw new Error("unknown profile must fail before installation");
                }) as never,
            }),
            /unsupported SATORI_RUNTIME_PROFILE=experimental/,
        );
        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
    });
});

test("managed runtime upgrade acquisition failure leaves the managed installation byte-identical", async () => {
    await withTempHome(async (homeDir) => {
        await installUpgradeSourceRuntime(homeDir, {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, "lancedb"),
            EMBEDDING_PROVIDER: "Potion",
            SATORI_RERANKER_PROVIDER: "lateon",
            SATORI_LATEON_PROFILE: "lateon_offline_quality_projection_v5_d32_v1",
        });
        const originalLauncher = readFile(launcherPath(homeDir));
        const originalConfig = readFile(path.join(homeDir, ".codex", "config.toml"));

        await assert.rejects(
            executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
                homeDir,
                env: {},
                platform: "linux",
                architecture: "x64",
                potionModelPath: path.join(POTION_ASSETS_ROOT, "model"),
                modelRetryDelaysMs: [],
                lateOnAuthorityLoader: loadAcquisitionAuthority,
                fetchImpl: (async () => {
                    throw new Error("network down");
                }) as typeof fetch,
                execFileSyncImpl: installRuntimePackageStub(
                    "dist/target-runtime.mjs",
                    UPGRADE_TARGET.mcpPackageSpecifier,
                    UPGRADE_TARGET.mcpVersion,
                    UPGRADE_TARGET.coreVersion,
                ) as never,
                preflightRunner: async () => ({
                    runtimeEnvironment: Object.freeze({}),
                }),
            }),
            /LateOn D32 model preflight failed: .*network down/,
        );

        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
        assert.equal(readFile(path.join(homeDir, ".codex", "config.toml")), originalConfig);
        const modelsLateonDir = path.join(homeDir, ".satori", "models", "lateon");
        if (fs.existsSync(modelsLateonDir)) {
            assert.deepEqual(
                // Resumable staging may remain; no unverified model is ever published.
                fs.readdirSync(modelsLateonDir).filter((name) => !name.startsWith(".")),
                [],
            );
        }
    });
});

test("legacy no-provider upgrade defaults to LateOn D32", async () => {
    await withTempHome(async (homeDir) => {
        await installUpgradeSourceRuntime(homeDir, {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, "lancedb"),
            EMBEDDING_PROVIDER: "Potion",
        });
        let observedReranker: string | undefined;
        let observedProfile: string | undefined;
        let observedPolicy: string | undefined;
        const fetchImpl = (async (input: string | URL | Request) => {
            const name = String(input).slice(String(input).lastIndexOf("/") + 1);
            return new Response(
                name === "model.onnx"
                    ? LATEON_FIXTURE_ARTIFACTS["model.onnx"]
                    : LATEON_FIXTURE_ARTIFACTS["tokenizer.json"],
                { status: 200 },
            );
        }) as typeof fetch;

        await executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
            homeDir,
            env: {},
            platform: "linux",
            architecture: "x64",
            potionModelPath: path.join(POTION_ASSETS_ROOT, "model"),
            lateOnAuthorityLoader: loadAcquisitionAuthority,
            fetchImpl,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/target-runtime.mjs",
                UPGRADE_TARGET.mcpPackageSpecifier,
                UPGRADE_TARGET.mcpVersion,
                UPGRADE_TARGET.coreVersion,
            ) as never,
            preflightDependencies: {
                probeCandidateRuntime: async () => {},
            },
            preflightRunner: async (input) => {
                observedReranker = input.reranker;
                observedProfile = input.lateOnProfileId;
                observedPolicy = input.lateOnActivationPolicy;
                return {
                    runtimeEnvironment: Object.freeze({
                        SATORI_RUNTIME_PROFILE: "offline",
                        VECTOR_STORE_PROVIDER: "LanceDB",
                        EMBEDDING_PROVIDER: "Potion",
                        SATORI_RERANKER_PROVIDER: input.reranker ?? "",
                        SATORI_LATEON_MODEL_PATH: input.lateOnModelPath ?? "",
                        SATORI_LATEON_PROFILE: input.lateOnProfileId ?? "",
                        SATORI_LATEON_ACTIVATION_POLICY: input.lateOnActivationPolicy ?? "", 
                    }),
                };
            },
        });

        assert.equal(observedReranker, "lateon");
        assert.equal(observedProfile, "lateon_offline_quality_projection_v5_d32_v1");
        assert.equal(observedPolicy, "lateon_context_v5_d32_owner_default_v1");
        const launcherEnvironment = parseManagedLauncherDescriptor(readFile(launcherPath(homeDir))).managedEnv;
        assert.equal(launcherEnvironment.SATORI_RERANKER_PROVIDER, "lateon");
        assert.equal(
            launcherEnvironment.SATORI_LATEON_PROFILE,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
        assert.equal(
            launcherEnvironment.SATORI_LATEON_ACTIVATION_POLICY,
            "lateon_context_v5_d32_owner_default_v1",
        );
    });
});

test("managed runtime upgrade rejects Core resolved outside the owned runtime", async () => {
    await withTempHome(async (homeDir) => {
        await installUpgradeSourceRuntime(homeDir, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
        });
        const descriptor = parseManagedLauncherDescriptor(readFile(launcherPath(homeDir)));
        const runtimeEntry = descriptor.args[0];
        const runtimeRoot = path.resolve(
            runtimeEntry,
            "..",
            "..",
            "..",
            "..",
            "..",
        );
        fs.rmSync(
            path.join(runtimeRoot, "node_modules", "@satori-code", "core"),
            { recursive: true, force: true },
        );
        writeCorePackage(
            path.join(homeDir, "node_modules", "@satori-code", "core"),
            "3.0.0",
        );

        await assert.rejects(
            executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
                homeDir,
                execFileSyncImpl: (() => {
                    throw new Error("invalid current closure must fail before installation");
                }) as never,
            }),
            /runtime package identity is incomplete/,
        );
    });

    await withTempHome(async (homeDir) => {
        await installUpgradeSourceRuntime(homeDir, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
        });
        const originalLauncher = readFile(launcherPath(homeDir));
        writeCorePackage(
            path.join(homeDir, "node_modules", "@satori-code", "core"),
            UPGRADE_TARGET.coreVersion,
        );
        let preflightCalls = 0;

        await assert.rejects(
            executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
                homeDir,
                execFileSyncImpl: installRuntimePackageStub(
                    "dist/target-runtime.mjs",
                    UPGRADE_TARGET.mcpPackageSpecifier,
                    UPGRADE_TARGET.mcpVersion,
                    UPGRADE_TARGET.coreVersion,
                    false,
                ) as never,
                preflightRunner: async () => {
                    preflightCalls += 1;
                    throw new Error("out-of-root Core must fail before preflight");
                },
            }),
            /missing a usable entry/,
        );

        assert.equal(preflightCalls, 0);
        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
    });
});

test("managed runtime upgrade repairs an older Core but refuses to downgrade a newer Core", async () => {
    await withTempHome(async (homeDir) => {
        await installUpgradeSourceRuntime(homeDir, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
        }, {
            mcpVersion: UPGRADE_TARGET.mcpVersion,
            coreVersion: "3.0.0",
        });

        const result = await executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
            homeDir,
            execFileSyncImpl: installRuntimePackageStub(
                "dist/repaired-runtime.mjs",
                UPGRADE_TARGET.mcpPackageSpecifier,
                UPGRADE_TARGET.mcpVersion,
                UPGRADE_TARGET.coreVersion,
            ) as never,
            preflightRunner: async () => ({
                runtimeEnvironment: Object.freeze({
                    SATORI_RUNTIME_PROFILE: "connected",
                    VECTOR_STORE_PROVIDER: "LanceDB",
                }),
            }),
            preflightDependencies: {
                probeCandidateRuntime: async () => {},
            },
        });

        assert.equal(result.status, "upgraded");
        assert.equal(result.fromMcpVersion, UPGRADE_TARGET.mcpVersion);
        assert.equal(result.fromCoreVersion, "3.0.0");
        assert.match(readFile(launcherPath(homeDir)), /repaired-runtime\.mjs/);
    });

    await withTempHome(async (homeDir) => {
        await installUpgradeSourceRuntime(homeDir, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
        }, {
            mcpVersion: UPGRADE_TARGET.mcpVersion,
            coreVersion: "3.2.0",
        });
        const originalLauncher = readFile(launcherPath(homeDir));

        await assert.rejects(
            executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
                homeDir,
                execFileSyncImpl: (() => {
                    throw new Error("Core downgrade must fail before installation");
                }) as never,
            }),
            /Installed Core 3\.2\.0 is newer.*refusing to downgrade/,
        );
        assert.equal(readFile(launcherPath(homeDir)), originalLauncher);
    });
});

test("managed runtime upgrade rejects launcher command shapes it does not own", async () => {
    const invalidDescriptors = [
        {
            command: process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh",
            extraArgs: [] as string[],
        },
        {
            command: process.execPath,
            extraArgs: ["--unexpected"],
        },
    ];

    for (const invalid of invalidDescriptors) {
        await withTempHome(async (homeDir) => {
            await installUpgradeSourceRuntime(homeDir, {
                SATORI_RUNTIME_PROFILE: "connected",
                VECTOR_STORE_PROVIDER: "LanceDB",
            });
            const descriptor = parseManagedLauncherDescriptor(readFile(launcherPath(homeDir)));
            const invalidLauncher = buildLauncherScript({
                command: invalid.command,
                args: [...descriptor.args, ...invalid.extraArgs],
                managedEnv: descriptor.managedEnv,
            });
            fs.writeFileSync(launcherPath(homeDir), invalidLauncher, "utf8");

            await assert.rejects(
                executeManagedRuntimeUpgrade(UPGRADE_TARGET, {
                    homeDir,
                    execFileSyncImpl: (() => {
                        throw new Error("invalid launcher must fail before installation");
                    }) as never,
                }),
                /unsupported command shape/,
            );
            assert.equal(readFile(launcherPath(homeDir)), invalidLauncher);
        });
    }
});

test("managed runtime upgrade requires an existing managed installation", async () => {
    await withTempHome(async (homeDir) => {
        await assert.rejects(
            executeManagedRuntimeUpgrade({
                cliPackageSpecifier: "@satori-code/cli@1.3.0",
                cliVersion: "1.3.0",
                mcpPackageSpecifier: "@satori-code/mcp@6.2.0",
                mcpVersion: "6.2.0",
                coreVersion: "3.1.0",
            }, { homeDir }),
            /Run `npx -y @satori-code\/cli@latest install --client all` first/,
        );
        assert.deepEqual(fs.readdirSync(homeDir), []);
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
        `process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(markerPath)}, "ok"); process.exit(0); }, 1_500));`,
        'console.log(`SATORI_TEST_CHILD_PID=${process.pid}`);',
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
    const ownersPath = path.join(homeDir, ".satori", "runtime-owner", "owners.json");
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

test("managed offline launchers attach independent sessions to one shared runtime host", {
    skip: process.platform !== "linux" || process.arch !== "x64"
        ? "shared offline runtime is supported on Linux x64"
        : false,
    timeout: 30_000,
}, async (t) => {
    const runtimeEntry = path.resolve(PACKAGE_ROOT, "..", "mcp", "dist", "index.js");
    if (!fs.existsSync(runtimeEntry)) {
        t.skip("built MCP runtime is required");
        return;
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-shared-host-"));
    const runtimeDirectory = path.join(homeDir, "runtime");
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    const stateRoot = path.join(homeDir, ".satori");
    const managedEnv = {
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: path.join(stateRoot, "vector", "lancedb"),
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: path.join(homeDir, "potion-helper"),
        POTION_MODEL_PATH: path.join(homeDir, "potion-model"),
        POTION_REQUEST_TIMEOUT_MS: "5000",
        MCP_ENABLE_WATCHER: "false",
    };
    let first: Awaited<ReturnType<typeof connectCliMcpSession>> | undefined;
    let second: Awaited<ReturnType<typeof connectCliMcpSession>> | undefined;
    let replacement: Awaited<ReturnType<typeof connectCliMcpSession>> | undefined;
    let replacementSecond: Awaited<ReturnType<typeof connectCliMcpSession>> | undefined;
    let hostPid: number | undefined;
    try {
        fs.mkdirSync(path.dirname(launcherPath(homeDir)), { recursive: true });
        fs.writeFileSync(launcherPath(homeDir), buildLauncherScript({
            command: process.execPath,
            args: [runtimeEntry],
            managedEnv,
        }), "utf8");
        fs.chmodSync(launcherPath(homeDir), 0o755);
        const clientEnv = {
            HOME: homeDir,
            SATORI_STATE_ROOT: stateRoot,
            XDG_RUNTIME_DIR: runtimeDirectory,
        };
        [first, second] = await Promise.all([
            connectCliMcpSession({
                command: process.execPath,
                args: [launcherPath(homeDir)],
                env: clientEnv,
                startupTimeoutMs: 15_000,
                callTimeoutMs: 5_000,
                writeStderr: () => {},
            }),
            connectCliMcpSession({
                command: process.execPath,
                args: [launcherPath(homeDir)],
                env: clientEnv,
                startupTimeoutMs: 15_000,
                callTimeoutMs: 5_000,
                writeStderr: () => {},
            }),
        ]);

        assert.equal((await first.listTools()).tools.length, 11);
        assert.equal((await second.listTools()).tools.length, 11);
        assert.notEqual(first.launcherPid, second.launcherPid);

        const metadataRoot = path.join(stateRoot, "runtime-host");
        const identities = fs.readdirSync(metadataRoot);
        assert.equal(identities.length, 1);
        const metadata = JSON.parse(fs.readFileSync(
            path.join(metadataRoot, identities[0]!, "host.json"),
            "utf8",
        )) as { hostPid: number };
        hostPid = metadata.hostPid;
        assert.equal(isProcessLive(hostPid), true);

        await first.close();
        first = undefined;
        assert.equal((await second.listTools()).tools.length, 11);
        await second.close();
        second = undefined;

        process.kill(hostPid, "SIGKILL");
        assert.equal(await waitForProcessExit(hostPid, 5_000), true);

        [replacement, replacementSecond] = await Promise.all([
            connectCliMcpSession({
                command: process.execPath,
                args: [launcherPath(homeDir)],
                env: clientEnv,
                startupTimeoutMs: 15_000,
                callTimeoutMs: 5_000,
                writeStderr: () => {},
            }),
            connectCliMcpSession({
                command: process.execPath,
                args: [launcherPath(homeDir)],
                env: clientEnv,
                startupTimeoutMs: 15_000,
                callTimeoutMs: 5_000,
                writeStderr: () => {},
            }),
        ]);
        assert.equal((await replacement.listTools()).tools.length, 11);
        assert.equal((await replacementSecond.listTools()).tools.length, 11);
        const replacementMetadata = JSON.parse(fs.readFileSync(
            path.join(metadataRoot, identities[0]!, "host.json"),
            "utf8",
        )) as { hostPid: number };
        assert.notEqual(replacementMetadata.hostPid, hostPid);
        hostPid = replacementMetadata.hostPid;
        await replacement.close();
        replacement = undefined;
        await replacementSecond.close();
        replacementSecond = undefined;
        process.kill(hostPid, "SIGTERM");
        assert.equal(await waitForProcessExit(hostPid, 5_000), true);
    } finally {
        await first?.close();
        await second?.close();
        await replacement?.close();
        await replacementSecond?.close();
        if (hostPid !== undefined && isProcessLive(hostPid)) {
            process.kill(hostPid, "SIGKILL");
        }
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("eligible shared launcher failure does not execute a direct runtime fallback", {
    skip: process.platform !== "linux" || process.arch !== "x64"
        ? "shared offline runtime is supported on Linux x64"
        : false,
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-shared-fail-closed-"));
    try {
        const markerPath = path.join(root, "direct-runtime-ran");
        const runtimeEntry = path.join(root, "runtime", "dist", "index.js");
        fs.mkdirSync(path.dirname(runtimeEntry), { recursive: true });
        fs.writeFileSync(runtimeEntry, `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`);
        const launcher = path.join(root, "launcher.js");
        fs.writeFileSync(launcher, buildLauncherScript({
            command: process.execPath,
            args: [runtimeEntry],
            managedEnv: {
                SATORI_RUNTIME_PROFILE: "offline",
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: path.join(root, "lancedb"),
                EMBEDDING_PROVIDER: "Potion",
                EMBEDDING_MODEL: "potion-test",
                EMBEDDING_OUTPUT_DIMENSION: "256",
                POTION_HELPER_PATH: path.join(root, "helper"),
                POTION_MODEL_PATH: path.join(root, "model"),
                POTION_REQUEST_TIMEOUT_MS: "5000",
            },
        }));

        assert.throws(() => execFileSync(process.execPath, [launcher], {
            env: {
                ...process.env,
                HOME: root,
                SATORI_STATE_ROOT: path.join(root, "state"),
            },
            stdio: "pipe",
        }));
        assert.equal(fs.existsSync(markerPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("managed offline Ollama launcher preserves the direct runtime lifecycle", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-cli-ollama-direct-"));
    try {
        const sourceIdentityModule = path.resolve(
            PACKAGE_ROOT,
            "..",
            "mcp",
            "dist",
            "server",
            "shared-runtime-identity.js",
        );
        if (!fs.existsSync(sourceIdentityModule)) {
            t.skip("built MCP shared-runtime identity module is required");
            return;
        }
        const runtimeEntry = path.join(root, "runtime.cjs");
        const markerPath = path.join(root, "direct-runtime-ran");
        const serverDirectory = path.join(root, "server");
        fs.mkdirSync(serverDirectory);
        fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
        fs.copyFileSync(
            sourceIdentityModule,
            path.join(serverDirectory, "shared-runtime-identity.js"),
        );
        fs.copyFileSync(
            path.resolve(PACKAGE_ROOT, "..", "mcp", "dist", "server", "lateon-reranker-protocol.js"),
            path.join(serverDirectory, "lateon-reranker-protocol.js"),
        );
        fs.cpSync(
            path.resolve(PACKAGE_ROOT, "..", "mcp", "dist", "core"),
            path.join(root, "core"),
            { recursive: true },
        );
        fs.symlinkSync(
            path.resolve(PACKAGE_ROOT, "..", "mcp", "node_modules"),
            path.join(root, "node_modules"),
            "dir",
        );
        const contractAssetDirectory = path.join(root, "assets", "lateon");
        fs.mkdirSync(contractAssetDirectory, { recursive: true });
        fs.copyFileSync(
            path.resolve(PACKAGE_ROOT, "..", "mcp", "assets", "lateon", "rerank-request-contract-v1.json"),
            path.join(contractAssetDirectory, "rerank-request-contract-v1.json"),
        );
        fs.writeFileSync(
            runtimeEntry,
            `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`,
        );
        const launcher = path.join(root, "launcher.cjs");
        fs.writeFileSync(launcher, buildLauncherScript({
            command: process.execPath,
            args: [runtimeEntry],
            managedEnv: {
                SATORI_RUNTIME_PROFILE: "offline",
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: path.join(root, "lancedb"),
                EMBEDDING_PROVIDER: "Ollama",
                EMBEDDING_MODEL: "nomic-embed-text",
            },
        }));

        execFileSync(process.execPath, [launcher], { stdio: "pipe" });
        assert.equal(fs.readFileSync(markerPath, "utf8"), "ran");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
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
        assert.match(String(result.packageSpecifier), /@satori-code\/mcp@/);
    });
});

test("managed MCP package exposes a single satori bin for npx package execution", async () => {
    assert.deepEqual(PACKAGE_JSON.bin, {
        satori: "dist/index.js",
    });
});

test("CLI package exposes the primary and compatibility commands", () => {
    const cliPackage = JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    assert.deepEqual(cliPackage.bin, {
        satori: "dist/index.js",
        "satori-cli": "dist/index.js",
    });
});

test("CLI package ships the one canonical Satori skill", () => {
    const cliPackage = JSON.parse(
        fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { files?: string[] };
    assert.equal(cliPackage.files?.includes("assets/skills/**/SKILL.md"), true);
    assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, "assets", "skills", "satori", "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, "..", "mcp", "assets", "skills")), false);
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
        assert.equal(second.results[0]?.skillChanged, false);
        assert.equal(second.results[0]?.status, "unchanged");
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
    });
});

test("uninstall removes an existing managed Codex block", async () => {
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
                `command = "${process.execPath.replace(/\\/g, "\\\\")}"`,
                `args = ["${launcherPath(homeDir).replace(/\\/g, "\\\\")}"]`,
                "# <<< satori-cli managed satori end <<<",
                "",
            ].join("\n"),
            "utf8"
        );

        const result = await executeInstallCommand({
            kind: "uninstall",
            client: "codex",
            dryRun: false,
        }, { homeDir });

        const content = readFile(codexConfigPath);
        assert.equal(result.results[0]?.status, "updated");
        assert.equal(content.includes("[mcp_servers.satori]"), false);
        assert.equal(content.includes(launcherPath(homeDir).replace(/\\/g, "\\\\")), false);
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

test("install links the Claude skill directory to the canonical skill", async () => {
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
        const canonicalSkill = path.join(homeDir, ".agents", "skills", "satori");
        assert.equal(fs.lstatSync(path.join(skillsDir, "satori")).isSymbolicLink(), true);
        assert.equal(fs.realpathSync(path.join(skillsDir, "satori")), fs.realpathSync(canonicalSkill));
        assert.equal(readFile(path.join(skillsDir, "satori", "SKILL.md")).includes("satori-managed-skill"), true);
        assert.equal(fs.existsSync(path.join(skillsDir, "custom-skill", "SKILL.md")), true);

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
        // A single-client uninstall keeps the shared copy other agents may load.
        assert.equal(fs.existsSync(path.join(canonicalSkill, "SKILL.md")), true);
    });
});

// A copy from a release that predates the ownership marker, exactly as that installer wrote it.
test("a real directory at a skill link path is unmanaged: install refuses and uninstall leaves it", async () => {
    await withTempHome(async (homeDir) => {
        const linkPath = path.join(homeDir, ".claude", "skills", "satori");
        fs.mkdirSync(linkPath, { recursive: true });
        const skillFile = path.join(linkPath, "SKILL.md");
        fs.writeFileSync(skillFile, readFile(path.join(PACKAGE_ROOT, "assets", "skills", "satori", "SKILL.md")), "utf8");

        await assert.rejects(
            executeInstallCommand({ kind: "install", client: "claude", runtime: "voyage", dryRun: false }, installOptions(homeDir)),
            /not managed by Satori\. Remove it manually/,
        );
        await executeInstallCommand({ kind: "uninstall", client: "claude", dryRun: false }, { homeDir });
        assert.equal(fs.existsSync(skillFile), true);
    });
});

test("canonical skill is never overwritten unless Satori owns it and is removed by a full uninstall", async () => {
    await withTempHome(async (homeDir) => {
        const skillFile = path.join(homeDir, ".agents", "skills", "satori", "SKILL.md");
        fs.mkdirSync(path.dirname(skillFile), { recursive: true });
        fs.writeFileSync(skillFile, "# my own satori notes\n", "utf8");

        await assert.rejects(
            executeInstallCommand({ kind: "install", client: "codex", runtime: "voyage", dryRun: false }, installOptions(homeDir)),
            /Refusing to overwrite unmanaged skill/,
        );
        assert.equal(readFile(skillFile), "# my own satori notes\n");

        fs.rmSync(skillFile);
        await executeInstallCommand({ kind: "install", client: "all", runtime: "voyage", dryRun: false }, installOptions(homeDir));
        assert.equal(readFile(skillFile).includes("satori-managed-skill"), true);

        await executeInstallCommand({ kind: "uninstall", client: "all", dryRun: false }, { homeDir });
        assert.equal(fs.existsSync(path.dirname(skillFile)), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".claude", "skills", "satori")), false);
    });
});

test("uninstall --purge stops servers and deletes all Satori data; a dry run only lists it", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand({ kind: "install", client: "codex", runtime: "voyage", dryRun: false }, installOptions(homeDir));
        const satoriRoot = path.join(homeDir, ".satori");
        fs.mkdirSync(path.join(satoriRoot, "models", "potion"), { recursive: true });

        const preview = await executeInstallCommand({ kind: "uninstall", client: "all", dryRun: true, purge: true }, { homeDir });
        assert.deepEqual(preview.purgedPaths, [satoriRoot]);
        assert.equal(fs.existsSync(satoriRoot), true);

        let terminated = 0;
        const result = await executeInstallCommand({ kind: "uninstall", client: "all", dryRun: false, purge: true }, {
            homeDir,
            terminateRunner: async () => {
                terminated += 1;
                return { status: "terminated" } as never;
            },
        });
        assert.equal(terminated, 1);
        assert.deepEqual(result.purgedPaths, [satoriRoot]);
        assert.equal(fs.existsSync(satoriRoot), false);
        assert.equal(readFile(path.join(homeDir, ".codex", "config.toml")).includes("[mcp_servers.satori]"), false);
    });
    assert.throws(() => parseCliArgs(["uninstall", "--client", "codex", "--purge"]), /--purge removes Satori for every client/);
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

test("install writes OpenCode JSONC config and the canonical skill", async () => {
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
        assert.equal(result.results[0]?.skillChanged, true);
        assert.equal(result.results[0]?.skillPath, path.join(homeDir, ".agents", "skills", "satori"));
        const content = readFile(configPath);
        assert.equal(content.includes("// keep this comment"), true);
        assert.equal(content.includes("\"existing\""), true);
        assert.equal(content.includes("\"satori\""), true);
        assert.equal(content.includes(launcherPath(homeDir)), true);
        assert.equal(content.includes("\"environment\""), true);
        assert.equal(content.includes("\"VOYAGEAI_API_KEY\": \"{env:VOYAGEAI_API_KEY}\""), true);
        assert.equal(content.includes("\"SATORI_RUNTIME_PROFILE\""), false);
        assert.equal(content.includes("\"EMBEDDING_OUTPUT_DIMENSION\""), false);
        assert.equal(content.includes("\"SATORI_LATEON_PROFILE\""), false);
        assert.equal(content.includes("\"MILVUS_ADDRESS\": \"{env:MILVUS_ADDRESS}\""), true);
        assert.equal(content.includes("node_modules"), false);

        assert.equal(fs.existsSync(path.join(homeDir, ".config", "opencode", "AGENTS.md")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".agents", "skills", "satori", "SKILL.md")), true);
    });
});

test("install --client agy writes the managed entry, preserves other servers, and is idempotent", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const other = { command: "other-server", args: ["--flag"], env: { A: "1" } };
        fs.writeFileSync(configPath, `${JSON.stringify({ theme: "dark", mcpServers: { other } }, null, 2)}\n`, "utf8");
        const desktopConfigPath = path.join(homeDir, ".gemini", "antigravity", "mcp_config.json");
        fs.mkdirSync(path.dirname(desktopConfigPath), { recursive: true });
        fs.writeFileSync(desktopConfigPath, "{}\n", "utf8");

        const command = { kind: "install", client: "agy", runtime: "voyage", dryRun: false } as const;
        const first = await executeInstallCommand(command, installOptions(homeDir));
        assert.equal(first.results.length, 1);
        assert.equal(first.results[0]?.client, "agy");
        assert.equal(first.results[0]?.status, "updated");

        const written = JSON.parse(readFile(configPath));
        assert.equal(written.theme, "dark");
        assert.deepEqual(written.mcpServers.other, other);
        assert.deepEqual(written.mcpServers.satori, {
            command: process.execPath,
            args: [launcherPath(homeDir)],
            disabled: false,
        });
        assert.equal(readFile(desktopConfigPath), "{}\n");
        assert.equal(fs.existsSync(path.join(homeDir, ".agents", "skills", "satori", "SKILL.md")), true);
        // Without a ~/.gemini/skills directory, agy gets a link to the canonical skill.
        assert.equal(
            fs.realpathSync(path.join(homeDir, ".gemini", "skills", "satori")),
            fs.realpathSync(path.join(homeDir, ".agents", "skills", "satori")),
        );

        const before = readFile(configPath);
        const second = await executeInstallCommand(command, installOptions(homeDir));
        assert.equal(second.results[0]?.status, "unchanged");
        assert.equal(readFile(configPath), before);
    });
});

test("agy install accepts the hand-made managed entry and keeps ~/.gemini/skills aliased to the canonical dir", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            mcpServers: { satori: { args: [launcherPath(homeDir)], command: process.execPath, disabled: false } },
        }), "utf8");
        const canonicalRoot = path.join(homeDir, ".agents", "skills");
        fs.mkdirSync(canonicalRoot, { recursive: true });
        fs.symlinkSync(canonicalRoot, path.join(homeDir, ".gemini", "skills"));

        const command = { kind: "install", client: "agy", runtime: "voyage", dryRun: false } as const;
        await executeInstallCommand(command, installOptions(homeDir));
        const canonicalSkill = path.join(canonicalRoot, "satori");
        assert.equal(fs.lstatSync(canonicalSkill).isDirectory(), true);
        assert.equal(fs.existsSync(path.join(canonicalSkill, "SKILL.md")), true);
        assert.deepEqual(JSON.parse(readFile(configPath)).mcpServers.satori, {
            command: process.execPath,
            args: [launcherPath(homeDir)],
            disabled: false,
        });

        // Uninstalling agy alone must not delete the canonical skill it shares through the alias.
        await executeInstallCommand({ ...command, kind: "uninstall" }, installOptions(homeDir));
        assert.equal(fs.existsSync(path.join(canonicalSkill, "SKILL.md")), true);
    });
});

test("uninstall --client agy removes only the Satori entry and a Satori-owned skill link", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const other = { command: "other-server", args: [] };
        fs.writeFileSync(configPath, JSON.stringify({ keep: 1, mcpServers: { other } }), "utf8");
        await executeInstallCommand(
            { kind: "install", client: "agy", runtime: "voyage", dryRun: false },
            installOptions(homeDir),
        );
        const linkPath = path.join(homeDir, ".gemini", "skills", "satori");
        assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);

        const result = await executeInstallCommand(
            { kind: "uninstall", client: "agy", dryRun: false },
            installOptions(homeDir),
        );
        assert.equal(result.results[0]?.client, "agy");
        assert.deepEqual(JSON.parse(readFile(configPath)), { keep: 1, mcpServers: { other } });
        assert.equal(fs.existsSync(linkPath), false);
        // The canonical skill belongs to every client; only --client all removes it.
        assert.equal(fs.existsSync(path.join(homeDir, ".agents", "skills", "satori", "SKILL.md")), true);
    });
});

test("agy install and uninstall refuse an unmanaged satori entry", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const content = JSON.stringify({ mcpServers: { satori: { command: "custom", args: ["x"] } } });
        fs.writeFileSync(configPath, content, "utf8");
        for (const kind of ["install", "uninstall"] as const) {
            await assert.rejects(
                executeInstallCommand(
                    kind === "install"
                        ? { kind, client: "agy", runtime: "voyage", dryRun: false }
                        : { kind, client: "agy", dryRun: false },
                    installOptions(homeDir),
                ),
                /unmanaged Satori config/,
            );
        }
        assert.equal(readFile(configPath), content);
    });
});

test("agy dry-run lists its config path and skill link for install and uninstall", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        const preview = await executeInstallCommand(
            { kind: "install", client: "agy", runtime: "voyage", dryRun: true },
            installOptions(homeDir),
        );
        assert.deepEqual(preview.plannedChanges, [
            { kind: "launcher", path: launcherPath(homeDir) },
            { kind: "client-config", client: "agy", path: configPath },
            { kind: "skill", client: "agy", path: path.join(homeDir, ".agents", "skills", "satori") },
            { kind: "skill-link", client: "agy", path: path.join(homeDir, ".gemini", "skills", "satori") },
        ]);
        assert.deepEqual(snapshotTree(homeDir), []);

        await executeInstallCommand(
            { kind: "install", client: "agy", runtime: "voyage", dryRun: false },
            installOptions(homeDir),
        );
        const removal = await executeInstallCommand(
            { kind: "uninstall", client: "agy", dryRun: true },
            installOptions(homeDir),
        );
        assert.deepEqual(
            removal.plannedChanges?.map((change) => [change.kind, change.path]),
            [
                ["client-config", configPath],
                ["skill-link", path.join(homeDir, ".gemini", "skills", "satori")],
            ],
        );
    });
});

test("skill-link handling never replaces or removes a real directory it did not write", async () => {
    for (const [client, linkParts] of [
        ["agy", [".gemini", "skills", "satori"]],
        ["claude", [".claude", "skills", "satori"]],
    ] as const) {
        await withTempHome(async (homeDir) => {
            const linkPath = path.join(homeDir, ...linkParts);
            const notes = path.join(linkPath, "my-notes.txt");
            fs.mkdirSync(linkPath, { recursive: true });
            fs.writeFileSync(notes, "keep me\n", "utf8");

            await assert.rejects(
                executeInstallCommand(
                    { kind: "install", client, runtime: "voyage", dryRun: false },
                    installOptions(homeDir),
                ),
                /not managed by Satori/,
                client,
            );
            assert.equal(readFile(notes), "keep me\n", client);

            await executeInstallCommand({ kind: "uninstall", client, dryRun: false }, installOptions(homeDir));
            assert.equal(readFile(notes), "keep me\n", client);
        });
    }
});

test("skill-link handling leaves a user-authored SKILL.md, or a marked copy with extra files, alone", async () => {
    const marked = readFile(path.join(PACKAGE_ROOT, "assets", "skills", "satori", "SKILL.md"));
    const cases = [
        { name: "user-authored SKILL.md", files: { "SKILL.md": "# my own satori notes\n" } },
        { name: "marked copy plus user file", files: { "SKILL.md": marked, "my-notes.txt": "keep me\n" } },
    ];
    for (const client of ["agy", "claude"] as const) {
        const linkParts = client === "agy" ? [".gemini", "skills", "satori"] : [".claude", "skills", "satori"];
        for (const { name, files } of cases) {
            await withTempHome(async (homeDir) => {
                const linkPath = path.join(homeDir, ...linkParts);
                fs.mkdirSync(linkPath, { recursive: true });
                for (const [file, content] of Object.entries(files)) {
                    fs.writeFileSync(path.join(linkPath, file), content, "utf8");
                }
                const snapshot = () => Object.keys(files).map((file) => readFile(path.join(linkPath, file)));
                const expected = snapshot();
                const label = `${client}: ${name}`;

                await assert.rejects(
                    executeInstallCommand({ kind: "install", client, runtime: "voyage", dryRun: false }, installOptions(homeDir)),
                    /not managed by Satori/,
                    label,
                );
                assert.deepEqual(snapshot(), expected, label);
                await executeInstallCommand({ kind: "uninstall", client, dryRun: false }, installOptions(homeDir));
                assert.deepEqual(snapshot(), expected, label);
            });
        }
    }
});

test("a symlinked HOME spelling of this home's launcher stays Satori-managed", async () => {
    for (const client of ["agy", "claude"] as const) {
        for (const entryUsesAlias of [true, false]) {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-home-alias-"));
            try {
                const realHome = path.join(root, "home");
                const aliasHome = path.join(root, "alias");
                fs.mkdirSync(realHome);
                fs.symlinkSync(realHome, aliasHome);
                // The command runs with one spelling; the entry was written with the other.
                const commandHome = entryUsesAlias ? realHome : aliasHome;
                const entryHome = entryUsesAlias ? aliasHome : realHome;
                const configPath = path.join(commandHome, ...(client === "agy" ? [".gemini", "config", "mcp_config.json"] : [".claude.json"]));
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                const entryLauncher = launcherPath(entryHome);
                assert.equal(fs.existsSync(entryLauncher), false);
                fs.writeFileSync(configPath, JSON.stringify({
                    mcpServers: { satori: { command: process.execPath, args: [entryLauncher] } },
                }), "utf8");
                const label = `${client} alias=${entryUsesAlias}`;

                assert.equal(inspectManagedClientConfigurations(commandHome)[0]?.usesManagedLauncher, true, label);
                await executeInstallCommand(
                    { kind: "install", client, runtime: "voyage", dryRun: false },
                    installOptions(commandHome),
                );
                await executeInstallCommand({ kind: "uninstall", client, dryRun: false }, installOptions(commandHome));
                const remaining = JSON.parse(readFile(configPath)).mcpServers;
                assert.equal(remaining?.satori, undefined, label);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        }
    }
});

test("an entry pointing at another home's launcher is not Satori-managed for this home", async () => {
    const foreign = "/other-home/.satori/bin/satori-mcp.js";
    const cases = [
        { client: "agy", file: [".gemini", "config", "mcp_config.json"], entry: { command: "node", args: [foreign], extra: true }, read: (c: any) => c.mcpServers.satori },
        { client: "claude", file: [".claude.json"], entry: { type: "stdio", command: "node", args: [foreign], extra: true }, read: (c: any) => c.mcpServers.satori },
        { client: "opencode", file: [".config", "opencode", "opencode.json"], entry: { type: "local", command: ["node", foreign], extra: true }, read: (c: any) => c.mcp.satori },
    ] as const;
    for (const { client, file, entry, read } of cases) {
        await withTempHome(async (homeDir) => {
            const configPath = path.join(homeDir, ...file);
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            const original = JSON.stringify(client === "opencode" ? { mcp: { satori: entry } } : { mcpServers: { satori: entry } });
            fs.writeFileSync(configPath, original, "utf8");

            await assert.rejects(
                executeInstallCommand({ kind: "install", client, runtime: "voyage", dryRun: false }, installOptions(homeDir)),
                /unmanaged Satori config/,
                client,
            );
            await assert.rejects(
                executeInstallCommand({ kind: "uninstall", client, dryRun: false }, installOptions(homeDir)),
                /unmanaged Satori config/,
                client,
            );
            assert.equal(readFile(configPath), original, client);
            assert.deepEqual(read(JSON.parse(original)), entry);
            const proof = inspectManagedClientConfigurations(homeDir).find((candidate) => candidate.client === client);
            assert.equal(proof?.usesManagedLauncher, false, client);
            assert.equal(proof?.status, "error", client);
        });
    }
});

test("doctor inspection reports a disabled agy entry as not ok", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand(
            { kind: "install", client: "agy", runtime: "voyage", dryRun: false },
            installOptions(homeDir),
        );
        const configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        const config = JSON.parse(readFile(configPath));
        config.mcpServers.satori.disabled = true;
        fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

        const proof = inspectManagedClientConfigurations(homeDir)[0];
        assert.equal(proof.client, "agy");
        assert.equal(proof.status, "error");
        assert.match(proof.message, /disabled/);
        assert.match(proof.message, /install --client agy|"disabled"/);
    });
});

test("agy install treats a symlink chain to a missing canonical skills dir like the direct alias", async () => {
    await withTempHome(async (homeDir) => {
        const gemini = path.join(homeDir, ".gemini");
        fs.mkdirSync(gemini, { recursive: true });
        fs.symlinkSync(path.join(homeDir, ".agents", "skills"), path.join(gemini, "skills-hop"));
        fs.symlinkSync(path.join(gemini, "skills-hop"), path.join(gemini, "skills"));

        const result = await executeInstallCommand(
            { kind: "install", client: "agy", runtime: "voyage", dryRun: false },
            installOptions(homeDir),
        );
        assert.equal(result.results[0]?.status, "updated");
        const canonical = path.join(homeDir, ".agents", "skills", "satori");
        assert.equal(fs.lstatSync(canonical).isDirectory(), true);
        assert.equal(fs.existsSync(path.join(canonical, "SKILL.md")), true);
    });
});

test("doctor inspection recognizes the agy entry and detects stale wiring", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand(
            { kind: "install", client: "agy", runtime: "voyage", dryRun: false },
            installOptions(homeDir),
        );
        const proofs = inspectManagedClientConfigurations(homeDir);
        assert.deepEqual(proofs.map((proof) => [proof.client, proof.status, proof.usesManagedLauncher]), [
            ["agy", "ok", true],
        ]);
        assert.match(proofs[0].message, /^agy config points to /);

        const configPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
        const config = JSON.parse(readFile(configPath));
        config.mcpServers.satori.command = "/stale/node";
        fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
        assert.equal(inspectManagedClientConfigurations(homeDir)[0]?.status, "error");
    });
});

test("OpenCode install removes stale launcher-owned runtime identity while preserving pass-through environment", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify({
            mcp: {
                satori: {
                    enabled: true,
                    type: "local",
                    command: [process.execPath, launcherPath(homeDir)],
                    environment: {
                        SATORI_RUNTIME_PROFILE: "offline",
                        EMBEDDING_PROVIDER: "Potion",
                        SATORI_RERANKER_PROVIDER: "lateon",
                        SATORI_LATEON_PROFILE: "lateon_offline_quality_projection_v5_d32_v1",
                        SATORI_LATEON_ACTIVATION_POLICY: "lateon_context_v5_d32_owner_default_v1",
                        VOYAGEAI_API_KEY: "{env:VOYAGEAI_API_KEY}",
                    },
                },
            },
        }, null, 2)}\n`, "utf8");

        await executeInstallCommand({
            kind: "install",
            client: "opencode",
            runtime: "voyage",
            dryRun: false,
        }, installOptions(homeDir));

        const environment = JSON.parse(readFile(configPath)).mcp.satori.environment;
        assert.equal(environment.SATORI_RUNTIME_PROFILE, undefined);
        assert.equal(environment.EMBEDDING_PROVIDER, undefined);
        assert.equal(environment.SATORI_RERANKER_PROVIDER, undefined);
        assert.equal(environment.SATORI_LATEON_PROFILE, undefined);
        assert.equal(environment.SATORI_LATEON_ACTIVATION_POLICY, undefined);
        assert.equal(environment.VOYAGEAI_API_KEY, "{env:VOYAGEAI_API_KEY}");
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

        assert.deepEqual(result.results.map((entry) => entry.client), ["codex", "claude", "opencode", "agy"]);
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
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "AGENTS.md")), false);
        const canonicalSkill = path.join(homeDir, ".agents", "skills", "satori");
        assert.equal(readFile(path.join(canonicalSkill, "SKILL.md")).includes("satori-managed-skill"), true);

        const claudeConfig = JSON.parse(readFile(path.join(homeDir, ".claude.json")));
        assert.equal(claudeConfig.mcpServers.satori.type, "stdio");
        assert.equal(claudeConfig.mcpServers.satori.command, process.execPath);
        assert.deepEqual(claudeConfig.mcpServers.satori.args, fakeClientCommand(homeDir).args);
        assert.equal(claudeConfig.mcpServers.satori.env, undefined);
        assert.equal(Object.prototype.hasOwnProperty.call(claudeConfig.mcpServers.satori, "timeout"), false);
        assert.equal(JSON.stringify(claudeConfig.mcpServers.satori).includes("node_modules"), false);
        assert.equal(fs.realpathSync(path.join(homeDir, ".claude", "skills", "satori")), fs.realpathSync(canonicalSkill));

        const opencodeConfig = JSON.parse(readFile(path.join(homeDir, ".config", "opencode", "opencode.json")));
        assert.equal(opencodeConfig.mcp.satori.enabled, true);
        assert.equal(opencodeConfig.mcp.satori.type, "local");
        assert.deepEqual(opencodeConfig.mcp.satori.command, [process.execPath, launcherPath(homeDir)]);
        assert.equal(opencodeConfig.mcp.satori.environment.VOYAGEAI_API_KEY, "{env:VOYAGEAI_API_KEY}");
        assert.equal(opencodeConfig.mcp.satori.environment.EMBEDDING_OUTPUT_DIMENSION, undefined);
        assert.equal(opencodeConfig.mcp.satori.environment.MILVUS_ADDRESS, "{env:MILVUS_ADDRESS}");
        assert.equal(JSON.stringify(opencodeConfig.mcp.satori).includes("node_modules"), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".config", "opencode", "AGENTS.md")), false);
    });
});

test("install plan mutation records are frozen after planning", async () => {
    await withTempHome(async (homeDir) => {
        const plan = createInstallPlan({
            kind: "install",
            client: "claude",
            runtime: "voyage",
            dryRun: true,
        }, installOptions(homeDir));

        assert.equal(Object.isFrozen(plan), true);
        assert.equal(Object.isFrozen(plan.options), true);
        assert.equal(Object.isFrozen(plan.prepared), true);
        assert.equal(Object.isFrozen(plan.profileMutation), true);
        for (const entry of plan.prepared) {
            assert.equal(Object.isFrozen(entry), true);
            assert.equal(Object.isFrozen(entry.configMutation), true);
            assert.equal(Object.isFrozen(entry.companionMutations), true);
            for (const companion of entry.companionMutations) {
                assert.equal(Object.isFrozen(companion), true);
            }
            assert.throws(() => { entry.configMutation.changed = false; }, TypeError);
            assert.throws(() => { entry.configMutation.apply = () => {}; }, TypeError);
            for (const companion of entry.companionMutations) {
                assert.throws(() => { companion.changed = false; }, TypeError);
            }
        }
        assert.throws(() => { plan.profileMutation.changed = false; }, TypeError);
    });
});

test("auto client selection uses client markers and PATH executables", async () => {
    await withTempHome(async (homeDir) => {
        const plan = (env: NodeJS.ProcessEnv) => createInstallPlan({
            kind: "install",
            client: "auto",
            runtime: "voyage",
            dryRun: true,
        }, {
            ...installOptions(homeDir),
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
            env,
        });

        assert.deepEqual(plan({ PATH: "" }).prepared.map((entry) => entry.target.client), []);

        fs.mkdirSync(path.join(homeDir, ".config", "opencode"), { recursive: true });
        assert.deepEqual(plan({ PATH: "" }).prepared.map((entry) => entry.target.client), ["opencode"]);

        const binDir = path.join(homeDir, ".local", "bin");
        const codexPath = path.join(binDir, "codex");
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(codexPath, "#!/bin/sh\n", "utf8");
        fs.chmodSync(codexPath, 0o755);
        assert.deepEqual(
            plan({ PATH: binDir }).prepared.map((entry) => entry.target.client),
            ["codex", "opencode"],
        );

        // agy is opt-in: neither its binary nor its config directory adds it to auto.
        const agyPath = path.join(binDir, "agy");
        fs.writeFileSync(agyPath, "#!/bin/sh\n", "utf8");
        fs.chmodSync(agyPath, 0o755);
        fs.mkdirSync(path.join(homeDir, ".gemini", "config"), { recursive: true });
        assert.deepEqual(
            plan({ PATH: binDir }).prepared.map((entry) => entry.target.client),
            ["codex", "opencode"],
        );
    });
});

test("auto client selection honors documented client config roots", async () => {
    await withTempHome(async (homeDir) => {
        const codexHome = path.join(homeDir, "codex-home");
        const claudeConfigDir = path.join(homeDir, "claude-config");
        const opencodeConfig = path.join(homeDir, "opencode", "config.json");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.mkdirSync(claudeConfigDir, { recursive: true });
        fs.mkdirSync(path.dirname(opencodeConfig), { recursive: true });
        fs.writeFileSync(opencodeConfig, "{}\n", "utf8");

        const plan = createInstallPlan({
            kind: "install",
            client: "auto",
            runtime: "voyage",
            dryRun: true,
        }, {
            ...installOptions(homeDir),
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
            env: {
                PATH: "",
                CODEX_HOME: "~/codex-home",
                CLAUDE_CONFIG_DIR: "~/claude-config",
                OPENCODE_CONFIG: "~/opencode/config.json",
            },
        });

        assert.deepEqual(
            plan.prepared.map((entry) => [entry.target.client, entry.target.configPath]),
            [
                ["codex", path.join(codexHome, "config.toml")],
                ["claude", path.join(claudeConfigDir, ".claude.json")],
                ["opencode", opencodeConfig],
            ],
        );

        const relativeConfigPlan = createInstallPlan({
            kind: "install",
            client: "auto",
            runtime: "voyage",
            dryRun: true,
        }, {
            ...installOptions(homeDir),
            packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
            env: {
                PATH: "",
                OPENCODE_CONFIG: "missing-opencode-config.json",
            },
        });
        assert.deepEqual(relativeConfigPlan.prepared.map((entry) => entry.target.client), []);
    });
});

test("OpenCode custom configuration paths receive no instruction files", async () => {
    await withTempHome(async (homeDir) => {
        const globalConfigDir = path.join(homeDir, ".config", "opencode");
        const customConfig = path.join(homeDir, "profiles", "opencode.json");
        fs.mkdirSync(path.dirname(customConfig), { recursive: true });
        fs.writeFileSync(customConfig, "{}\n", "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "auto",
            runtime: "voyage",
            dryRun: false,
        }, {
            ...installOptions(homeDir),
            env: { PATH: "", OPENCODE_CONFIG: customConfig },
        });

        assert.deepEqual(result.results.map((entry) => entry.client), ["opencode"]);
        assert.equal(fs.existsSync(customConfig), true);
        assert.equal(fs.existsSync(path.join(globalConfigDir, "AGENTS.md")), false);
        assert.equal(fs.existsSync(path.join(path.dirname(customConfig), "AGENTS.md")), false);
    });

    await withTempHome(async (homeDir) => {
        const globalConfigDir = path.join(homeDir, ".config", "opencode");
        const customConfigDir = path.join(homeDir, "opencode-directory");
        fs.mkdirSync(customConfigDir, { recursive: true });

        const result = await executeInstallCommand({
            kind: "install",
            client: "auto",
            runtime: "voyage",
            dryRun: false,
        }, {
            ...installOptions(homeDir),
            env: { PATH: "", OPENCODE_CONFIG_DIR: customConfigDir },
        });

        assert.deepEqual(result.results.map((entry) => entry.client), ["opencode"]);
        assert.equal(fs.existsSync(path.join(globalConfigDir, "opencode.json")), true);
        assert.equal(fs.existsSync(path.join(globalConfigDir, "AGENTS.md")), false);
        assert.equal(fs.existsSync(path.join(customConfigDir, "opencode.json")), false);
        assert.equal(fs.existsSync(path.join(customConfigDir, "AGENTS.md")), false);
    });

    await withTempHome(async (homeDir) => {
        const globalConfigDir = path.join(homeDir, ".config", "opencode");
        const customConfig = path.join(homeDir, "profiles", "opencode.json");
        const customConfigDir = path.join(homeDir, "opencode-directory");
        fs.mkdirSync(path.dirname(customConfig), { recursive: true });
        fs.mkdirSync(customConfigDir, { recursive: true });
        fs.writeFileSync(customConfig, "{}\n", "utf8");

        const result = await executeInstallCommand({
            kind: "install",
            client: "auto",
            runtime: "voyage",
            dryRun: false,
        }, {
            ...installOptions(homeDir),
            env: {
                PATH: "",
                OPENCODE_CONFIG: customConfig,
                OPENCODE_CONFIG_DIR: customConfigDir,
            },
        });

        assert.deepEqual(result.results.map((entry) => entry.client), ["opencode"]);
        assert.equal(fs.existsSync(customConfig), true);
        assert.equal(fs.existsSync(path.join(globalConfigDir, "opencode.json")), false);
        assert.equal(fs.existsSync(path.join(globalConfigDir, "AGENTS.md")), false);
        assert.equal(fs.existsSync(path.join(customConfigDir, "AGENTS.md")), false);
    });
});

test("auto install fails before runtime, model, preflight, or launcher work when no clients are detected", async () => {
    await withTempHome(async (homeDir) => {
        let runtimeInstallCalls = 0;
        let modelAcquisitionCalls = 0;
        let preflightCalls = 0;

        await assert.rejects(
            () => executeInstallCommandProduction({
                kind: "install",
                client: "auto",
                runtime: "offline",
                dryRun: false,
            }, {
                homeDir,
                packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
                env: { PATH: "" },
                execFileSyncImpl: (() => {
                    runtimeInstallCalls += 1;
                    throw new Error("runtime install must not run");
                }) as typeof execFileSync,
                potionModelPath: path.join(POTION_ASSETS_ROOT, "model"),
                lateOnAuthorityLoader: (() => {
                    modelAcquisitionCalls += 1;
                    throw new Error("model acquisition must not run");
                }),
                preflightRunner: async () => {
                    preflightCalls += 1;
                    throw new Error("preflight must not run");
                },
            }),
            (error: unknown) => error instanceof CliError
                && error.token === "E_NO_CLIENTS_DETECTED"
                && error.message.includes("npx -y @satori-code/cli@latest install --client all"),
        );

        assert.equal(runtimeInstallCalls, 0);
        assert.equal(modelAcquisitionCalls, 0);
        assert.equal(preflightCalls, 0);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori")), false);
    });
});

test("auto install revalidates client detection after preflight and removes its candidate runtime", async () => {
    await withTempHome(async (homeDir) => {
        const codexRoot = path.join(homeDir, ".codex");
        fs.mkdirSync(codexRoot, { recursive: true });
        const installRuntime = installRuntimePackageStub("dist/candidate-runtime.mjs");
        let candidateRuntimeRoot: string | undefined;
        let preflightCalls = 0;

        await assert.rejects(
            () => executeInstallCommandProduction({
                kind: "install",
                client: "auto",
                runtime: "voyage",
                vectorStore: "LanceDB",
                dryRun: false,
            }, {
                homeDir,
                packageSpecifier: EXPECTED_PACKAGE_SPECIFIER,
                env: { PATH: "" },
                execFileSyncImpl: ((command: string, args: string[]) => {
                    const prefixIndex = args.indexOf("--prefix");
                    const runtimeRoot = args[prefixIndex + 1];
                    assert.equal(typeof runtimeRoot, "string");
                    candidateRuntimeRoot = runtimeRoot;
                    return installRuntime(command, args);
                }) as never,
                preflightRunner: async () => {
                    preflightCalls += 1;
                    fs.rmSync(codexRoot, { recursive: true, force: true });
                    return {
                        runtimeEnvironment: Object.freeze({
                            SATORI_RUNTIME_PROFILE: "connected",
                            VECTOR_STORE_PROVIDER: "LanceDB",
                        }),
                    };
                },
                preflightDependencies: {
                    probeCandidateRuntime: async () => {},
                },
            }),
            (error: unknown) => error instanceof CliError
                && error.token === "E_NO_CLIENTS_DETECTED"
                && error.message.includes("npx -y @satori-code/cli@latest install --client all"),
        );

        assert.equal(preflightCalls, 1);
        assert.ok(candidateRuntimeRoot, "expected a candidate runtime to be installed");
        assert.equal(fs.existsSync(candidateRuntimeRoot), false);
        assert.equal(fs.existsSync(launcherPath(homeDir)), false);
        assert.equal(fs.existsSync(path.join(codexRoot, "config.toml")), false);
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
        assert.deepEqual(healthy.map((proof) => proof.client), ["codex", "claude", "opencode", "agy"]);
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
        assert.equal(stale.filter((proof) => proof.status === "ok").length, 3);
    });
});

test("managed client inspection preserves unknown runtime authority for malformed config", async () => {
    await withTempHome(async (homeDir) => {
        const configPath = path.join(homeDir, ".config", "opencode", "opencode.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, '{"mcp":{"satori":', "utf8");

        const proofs = inspectManagedClientConfigurations(homeDir, {
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "shell-model-must-not-be-attributed",
        });
        assert.equal(proofs.length, 1);
        assert.equal(proofs[0].client, "opencode");
        assert.equal(proofs[0].status, "error");
        assert.equal(proofs[0].usesManagedLauncher, undefined);
        assert.equal(proofs[0].runtimeEnvironment, undefined);
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

test("uninstall removes managed OpenCode config and leaves AGENTS.md alone", async () => {
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
        const notes = "<!-- satori-mcp:start -->\n# Old Satori\n<!-- satori-mcp:end -->\n\n# User Notes\n";
        fs.writeFileSync(instructionsPath, notes, "utf8");

        await executeInstallCommand({
            kind: "uninstall",
            client: "opencode",
            dryRun: false,
        }, { homeDir });

        const removed = JSON.parse(readFile(configPath));
        assert.equal(Boolean(removed.mcp?.satori), false);
        assert.equal(readFile(instructionsPath), notes);
    });
});

test("install preserves direct OpenCode pass-through environment values on reinstall", async () => {
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
        assert.equal(installed.mcp.satori.environment.EMBEDDING_OUTPUT_DIMENSION, undefined);
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

        assert.equal(result.results.length, 4);
        assert.equal(result.results.every((entry) => entry.dryRun), true);
        assert.equal(fs.existsSync(path.join(homeDir, ".gemini", "config", "mcp_config.json")), false);
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
                packageSpecifier: "@satori-code/mcp@0.0.0-test",
                runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            }),
            (error: unknown) => {
                assert.equal((error as { token?: string }).token, "E_INSTALL_PARTIAL");
                const message = error instanceof Error ? error.message : String(error);
                assert.equal(message.includes(`managed launcher at ${launcherPath(homeDir)}`), true);
                assert.equal(message.includes(`repository profile at ${path.join(repoDir, "satori.toml")}`), true);
                assert.equal(message.includes(`while applying codex client configuration at ${path.join(homeDir, ".codex", "config.toml")}`), true);
                assert.match(message, /Not yet applied: codex skill at/);
                assert.match(message, /correct the error and rerun the same command/);
                return true;
            },
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
    }
});

function snapshotTree(root: string): string[] {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .map((entry) => path.join(entry.parentPath, entry.name))
        .sort();
}

test("install --dry-run lists the same paths a real install writes and changes nothing", async () => {
    await withTempHome(async (homeDir) => {
        const command = { kind: "install", client: "codex", runtime: "voyage" } as const;
        const preview = await executeInstallCommand({ ...command, dryRun: true }, installOptions(homeDir));
        assert.deepEqual(snapshotTree(homeDir), []);

        const expected = [
            { kind: "launcher", path: launcherPath(homeDir) },
            { kind: "client-config", client: "codex", path: path.join(homeDir, ".codex", "config.toml") },
            { kind: "skill", client: "codex", path: path.join(homeDir, ".agents", "skills", "satori") },
        ];
        assert.deepEqual(preview.plannedChanges, expected);

        const applied = await executeInstallCommand({ ...command, dryRun: false }, installOptions(homeDir));
        assert.equal(applied.plannedChanges, undefined);
        for (const change of expected) {
            assert.equal(fs.existsSync(change.path), true, change.path);
        }

        const text = formatInstallText(preview);
        assert.match(text, /^Would create or modify:$/m);
        assert.match(text, new RegExp(`Managed launcher\\s+${launcherPath(homeDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(text, /Codex configuration\s+\S+config\.toml/);
        assert.match(text, /Shared skill\s+\S+skills\/satori/);
    });
});

test("install --dry-run includes the managed runtime package when it would be installed", async () => {
    await withTempHome(async (homeDir) => {
        const preview = await executeInstallCommand(
            { kind: "install", client: "codex", runtime: "voyage", dryRun: true },
            { homeDir, packageSpecifier: EXPECTED_PACKAGE_SPECIFIER },
        );
        assert.equal(preview.plannedChanges?.[0]?.kind, "runtime");
        assert.equal(preview.plannedChanges?.[0]?.path.startsWith(path.join(homeDir, ".satori", "mcp-runtime")), true);
        assert.deepEqual(snapshotTree(homeDir), []);
    });
});

test("install --dry-run omits the runtime and launcher steps a real install would reuse", async () => {
    await withTempHome(async (homeDir) => {
        const command = { kind: "install", client: "codex", runtime: "voyage" } as const;
        const options = { homeDir, packageSpecifier: EXPECTED_PACKAGE_SPECIFIER };
        await executeInstallCommand({ ...command, dryRun: false }, {
            ...options,
            execFileSyncImpl: installRuntimePackageStub("custom/server.mjs") as never,
            // Same launcher environment a real run resolves once the CBM pack is present.
            cbmExtendedPath: plannedCbmExtendedDirectory(homeDir),
            preflightRunner: async (input) => ({ runtimeEnvironment: planInstallRuntimeEnvironment(input) }),
        });
        const before = snapshotTree(homeDir);
        const noNpm = (() => {
            throw new Error("dry-run must not run npm");
        }) as never;

        const unchanged = await executeInstallCommand({ ...command, dryRun: true }, {
            ...options,
            execFileSyncImpl: noNpm,
        });
        assert.deepEqual(unchanged.plannedChanges, []);
        assert.deepEqual(snapshotTree(homeDir), before);

        fs.rmSync(launcherPath(homeDir));
        const missingLauncher = await executeInstallCommand({ ...command, dryRun: true }, {
            ...options,
            execFileSyncImpl: noNpm,
        });
        assert.deepEqual(missingLauncher.plannedChanges, [{ kind: "launcher", path: launcherPath(homeDir) }]);
    });
});

test("uninstall --dry-run says it would remove or modify the paths it lists", async () => {
    await withTempHome(async (homeDir) => {
        await executeInstallCommand({ kind: "install", client: "codex", runtime: "voyage", dryRun: false }, installOptions(homeDir));
        const before = snapshotTree(homeDir);

        const preview = await executeInstallCommand({ kind: "uninstall", client: "all", dryRun: true }, { homeDir });
        assert.deepEqual(snapshotTree(homeDir), before);
        assert.deepEqual(
            preview.plannedChanges?.map((change) => change.kind),
            ["client-config", "skill"],
        );
        const text = formatInstallText(preview);
        assert.match(text, /^Would remove or modify:$/m);
        assert.doesNotMatch(text, /Would create or modify:/);
        assert.match(text, /Codex configuration\s+\S+config\.toml/);

        const nothing = await executeInstallCommand({ kind: "uninstall", client: "claude", dryRun: true }, { homeDir });
        assert.match(formatInstallText(nothing), /No files would change\./);
    });
});
