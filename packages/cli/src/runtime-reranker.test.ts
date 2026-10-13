import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliError } from "./errors.js";
import { buildLauncherScript, parseManagedLauncherDescriptor } from "./managed-launcher-script.mjs";
import { executeInstallCommand as executeInstallCommandProduction } from "./install.js";
import { executeManagedRerankerCommand, formatRerankerText } from "./runtime-reranker.js";
import type { InstallCommandOptions } from "./install-contracts.js";

const VERSION = "1.0.0";
const API_KEY = "test-voyage-secret";
const LATEON_PROFILE = "lateon_offline_quality_projection_v6_d128_v1";

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-reranker-test-"));
    return run(homeDir).finally(() => fs.rmSync(homeDir, { recursive: true, force: true }));
}

function writeRuntimePackages(runtimeRoot: string): string {
    const packageRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "mcp");
    const coreRoot = path.join(runtimeRoot, "node_modules", "@satori-code", "core");
    fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    fs.mkdirSync(coreRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@satori-code/mcp",
        version: VERSION,
        bin: { satori: "dist/index.js" },
        dependencies: { "@satori-code/core": VERSION },
    }), "utf8");
    fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "", "utf8");
    fs.writeFileSync(path.join(coreRoot, "package.json"), JSON.stringify({
        name: "@satori-code/core",
        version: VERSION,
    }), "utf8");
    return path.join(packageRoot, "dist", "index.js");
}

function launcherPath(homeDir: string): string {
    return path.join(homeDir, ".satori", "bin", "satori-mcp.js");
}

function writeLauncher(
    homeDir: string,
    managedEnv: Readonly<Record<string, string>>,
): string {
    const runtimeRoot = path.join(homeDir, ".satori", "mcp-runtime", `@satori-code-mcp@${VERSION}`);
    const runtimeEntry = writeRuntimePackages(runtimeRoot);
    const filePath = launcherPath(homeDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buildLauncherScript({
        command: process.execPath,
        args: [runtimeEntry],
        managedEnv,
        managedLauncherPath: filePath,
    }), "utf8");
    return filePath;
}

function baseManagedEnvironment(homeDir: string): Record<string, string> {
    return {
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: path.join(homeDir, "lancedb"),
        EMBEDDING_PROVIDER: "Ollama",
        EMBEDDING_MODEL: "nomic-embed-text:latest",
        EMBEDDING_OUTPUT_DIMENSION: "768",
        OLLAMA_HOST: "http://localhost:11434",
        SATORI_RERANKER_PROVIDER: "none",
    };
}

function installRuntimePackageStub(_command: string, args: string[]): string {
    const prefixIndex = args.indexOf("--prefix");
    assert.notEqual(prefixIndex, -1);
    const runtimeRoot = args[prefixIndex + 1];
    assert.ok(runtimeRoot);
    const packageSpecifier = args.find((argument) => argument.startsWith("@satori-code/mcp@"));
    assert.ok(packageSpecifier);
    const version = packageSpecifier.slice(packageSpecifier.lastIndexOf("@") + 1);
    const entry = writeRuntimePackages(runtimeRoot);
    const packageRoot = path.dirname(path.dirname(entry));
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    packageJson.version = version;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson), "utf8");
    return "";
}

function optionsFor(
    homeDir: string,
    fetchImpl: typeof fetch,
    apiKey = API_KEY,
): InstallCommandOptions {
    return {
        homeDir,
        env: {
            VOYAGEAI_API_KEY: apiKey,
            OLLAMA_HOST: "http://localhost:11434",
        },
        packageSpecifier: `@satori-code/mcp@${VERSION}`,
        execFileSyncImpl: installRuntimePackageStub as never,
        platform: "linux",
        architecture: "x64",
        preflightDependencies: {
            fetchImpl,
            probeLanceDb: async () => undefined,
            probeCandidateRuntime: async () => undefined,
            resolveOllamaIdentity: async ({ model }) => Object.freeze({
                configuredModel: model,
                resolvedModel: "nomic-embed-text:latest",
                artifactDigest: "a".repeat(64),
                artifactSize: 1024,
                dimension: 768,
            }),
        },
        terminateRunner: async () => ({
            action: "terminate",
            status: "not_running",
            stateRoot: path.join(homeDir, ".satori"),
            terminated: [],
            staleRecordCount: 0,
            unverifiedRecordCount: 0,
        }),
    };
}

function responseFetch(status: number, body: string, calls: Array<{ input: string; init?: RequestInit }>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ input: String(input), init });
        return new Response(body, { status });
    }) as typeof fetch;
}

function readManagedEnvironment(filePath: string): Readonly<Record<string, string>> {
    return parseManagedLauncherDescriptor(fs.readFileSync(filePath, "utf8")).managedEnv;
}

function readAllFiles(root: string): string {
    if (!fs.existsSync(root)) return "";
    return fs.readdirSync(root, { withFileTypes: true }).map((entry) => {
        const filePath = path.join(root, entry.name);
        return entry.isDirectory() ? readAllFiles(filePath) : fs.readFileSync(filePath).toString("utf8");
    }).join("\n");
}

test("reranker use verifies Voyage before activation and preserves the launcher and secret on rejection", async () => {
    await withTempHome(async (homeDir) => {
        const originalLauncher = writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        const originalBytes = fs.readFileSync(originalLauncher);
        const providerMessage = "Model rerank-unknown is not supported. Supported models are ['rerank-3', 'rerank-3-lite'].";
        const calls: Array<{ input: string; init?: RequestInit }> = [];

        await assert.rejects(
            executeManagedRerankerCommand({
                operation: "use",
                provider: "voyage",
                model: "rerank-unknown",
                purge: false,
            }, optionsFor(homeDir, responseFetch(400, providerMessage, calls))),
            (error: unknown) => {
                assert.ok(error instanceof CliError);
                assert.equal(error.message, `VoyageAI Rerank API error (400): ${providerMessage}`);
                assert.equal(error.message.includes(API_KEY), false);
                return true;
            },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.input, "https://api.voyageai.com/v1/rerank");
        assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, `Bearer ${API_KEY}`);
        assert.deepEqual(fs.readFileSync(originalLauncher), originalBytes);
        assert.equal(readAllFiles(homeDir).includes(API_KEY), false);
    });
});

test("reranker use writes the selected Voyage model and reports an unchanged repeat", async () => {
    await withTempHome(async (homeDir) => {
        writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        const calls: Array<{ input: string; init?: RequestInit }> = [];
        const options = optionsFor(homeDir, responseFetch(200, "{}", calls));
        const first = await executeManagedRerankerCommand({
            operation: "use",
            provider: "voyage",
            model: "rerank-3",
            purge: false,
        }, options);
        const second = await executeManagedRerankerCommand({
            operation: "use",
            provider: "voyage",
            model: "rerank-3",
            purge: false,
        }, options);

        assert.equal(first.status, "changed");
        assert.equal(first.reranker, "voyage");
        assert.equal(first.model, "rerank-3");
        assert.equal(first.network, "remote");
        assert.equal(second.status, "unchanged");
        assert.equal(calls.length, 1);
        assert.equal(readManagedEnvironment(launcherPath(homeDir)).VOYAGEAI_RERANKER_MODEL, "rerank-3");
    });
});

test("reranker use without a model selects the provider table default over the launcher's model", async () => {
    await withTempHome(async (homeDir) => {
        const environment = {
            ...baseManagedEnvironment(homeDir),
            SATORI_RERANKER_PROVIDER: "voyage",
            VOYAGEAI_RERANKER_MODEL: "rerank-3",
        };
        writeLauncher(homeDir, environment);
        const calls: Array<{ input: string; init?: RequestInit }> = [];
        const result = await executeManagedRerankerCommand({
            operation: "use",
            provider: "voyage",
            purge: false,
        }, optionsFor(homeDir, responseFetch(200, "{}", calls)));

        assert.equal(result.status, "changed");
        assert.equal(result.model, "rerank-3-lite");
        assert.equal(readManagedEnvironment(launcherPath(homeDir)).VOYAGEAI_RERANKER_MODEL, "rerank-3-lite");
        const request = JSON.parse(String(calls[0]?.init?.body)) as { model: string; documents: string[]; query: string };
        assert.equal(request.model, "rerank-3-lite");
        assert.equal(request.documents.length, 1);
        assert.ok(request.query.length > 0);
    });
});

test("reranker use --no-verify skips the Voyage call", async () => {
    await withTempHome(async (homeDir) => {
        writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        let calls = 0;
        const result = await executeManagedRerankerCommand({
            operation: "use",
            provider: "voyage",
            model: "rerank-3",
            noVerify: true,
            purge: false,
        }, optionsFor(homeDir, (async () => {
            calls += 1;
            throw new Error("fetch must not be called");
        }) as typeof fetch));

        assert.equal(result.status, "changed");
        assert.equal(calls, 0);
        assert.equal(readManagedEnvironment(launcherPath(homeDir)).VOYAGEAI_RERANKER_MODEL, "rerank-3");
    });
});

test("install rejects a Voyage model before writing the launcher or client configuration", async () => {
    await withTempHome(async (homeDir) => {
        const apiKey = "install-test-voyage-secret";
        const providerMessage = "Model invalid-name is not supported by Voyage.";
        const calls: Array<{ input: string; init?: RequestInit }> = [];
        const options = optionsFor(homeDir, responseFetch(400, providerMessage, calls), apiKey);

        await assert.rejects(
            executeInstallCommandProduction({
                kind: "install",
                client: "codex",
                dryRun: false,
                runtime: "offline",
                ollamaModel: "nomic-embed-text",
                reranker: "voyage",
            }, options),
            (error: unknown) => {
                assert.ok(error instanceof CliError);
                assert.equal(error.message, `VoyageAI Rerank API error (400): ${providerMessage}`);
                assert.equal(error.message.includes(apiKey), false);
                return true;
            },
        );

        assert.equal(calls.length, 1);
        assert.equal(fs.existsSync(launcherPath(homeDir)), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "config.toml")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori", "mcp-runtime", `@satori-code-mcp@${VERSION}`)), false);
        assert.equal(readAllFiles(homeDir).includes(apiKey), false);
    });
});

test("install --no-verify skips the Voyage check without persisting the API key", async () => {
    await withTempHome(async (homeDir) => {
        const apiKey = "install-no-verify-voyage-secret";
        let calls = 0;
        const options = optionsFor(homeDir, (async () => {
            calls += 1;
            throw new Error("fetch must not be called");
        }) as typeof fetch, apiKey);

        await executeInstallCommandProduction({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            ollamaModel: "nomic-embed-text",
            reranker: "voyage",
            noVerify: true,
        }, options);

        assert.equal(calls, 0);
        assert.equal(fs.existsSync(launcherPath(homeDir)), true);
        assert.equal(readAllFiles(homeDir).includes(apiKey), false);
        assert.equal(readManagedEnvironment(launcherPath(homeDir)).VOYAGEAI_RERANKER_MODEL, "rerank-3-lite");
    });
});

test("reranker status reports the provider and model for every provider", async () => {
    await withTempHome(async (homeDir) => {
        const lateOnPath = path.join(homeDir, ".satori", "models", "lateon", "current");
        const cases = [
            {
                name: "lateon",
                environment: {
                    ...baseManagedEnvironment(homeDir),
                    SATORI_RERANKER_PROVIDER: "lateon",
                    SATORI_LATEON_MODEL_PATH: lateOnPath,
                    SATORI_LATEON_PROFILE: LATEON_PROFILE,
                },
                expected: `Satori reranker\n\nReranker: LateOn (enabled)\nModel: ${lateOnPath}\n`,
            },
            {
                name: "voyage",
                environment: {
                    ...baseManagedEnvironment(homeDir),
                    SATORI_RERANKER_PROVIDER: "voyage",
                    VOYAGEAI_RERANKER_MODEL: "rerank-3",
                },
                expected: "Satori reranker\n\nReranker: Voyage\nModel: rerank-3\nOnline: search queries and code excerpts are sent to Voyage.\n",
            },
            {
                name: "none",
                environment: {
                    ...baseManagedEnvironment(homeDir),
                    SATORI_RERANKER_PROVIDER: "none",
                },
                expected: "Satori reranker\n\nReranker: none (disabled)\n",
            },
        ];

        for (const item of cases) {
            writeLauncher(homeDir, item.environment);
            const result = await executeManagedRerankerCommand({ operation: "status", purge: false }, {
                homeDir,
                env: { VOYAGEAI_API_KEY: "" },
            });
            assert.equal(formatRerankerText(result), item.expected, item.name);
        }
    });
});

test("reranker status does not infer LateOn from a model path when the provider is absent", async () => {
    await withTempHome(async (homeDir) => {
        const environment = baseManagedEnvironment(homeDir);
        delete environment.SATORI_RERANKER_PROVIDER;
        environment.SATORI_LATEON_MODEL_PATH = path.join(homeDir, ".satori", "models", "lateon", "current");
        writeLauncher(homeDir, environment);

        const result = await executeManagedRerankerCommand({ operation: "status", purge: false }, {
            homeDir,
            env: { VOYAGEAI_API_KEY: "" },
        });

        assert.equal(result.reranker, "none");
        assert.equal(formatRerankerText(result), "Satori reranker\n\nReranker: none (disabled)\n");
    });
});

test("reranker status reads a Voyage provider from a connected launcher", async () => {
    await withTempHome(async (homeDir) => {
        writeLauncher(homeDir, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
            SATORI_RERANKER_PROVIDER: "voyage",
            VOYAGEAI_RERANKER_MODEL: "rerank-3-lite",
        });
        const result = await executeManagedRerankerCommand({ operation: "status", purge: false }, {
            homeDir,
            env: { VOYAGEAI_API_KEY: "" },
        });
        assert.equal(result.reranker, "voyage");
        assert.equal(result.model, "rerank-3-lite");
        assert.equal(result.network, "remote");
        assert.equal(formatRerankerText(result), "Satori reranker\n\nReranker: Voyage\nModel: rerank-3-lite\nOnline: search queries and code excerpts are sent to Voyage.\n");
    });
});

