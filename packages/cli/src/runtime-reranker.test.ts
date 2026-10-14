import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { CliError } from "./errors.js";
import { buildLauncherScript, parseManagedLauncherDescriptor } from "./managed-launcher-script.mjs";
import { executeInstallCommand as executeInstallCommandProduction } from "./install.js";
import { executeManagedRerankerCommand, formatRerankerText } from "./runtime-reranker.js";
import type { InstallCommandOptions } from "./install-contracts.js";
import { POTION_DIMENSION, POTION_MODEL_ID } from "./local-runtime-contract.js";
import { runCli } from "./index.js";
import { promptHiddenApiKey, resolveVoyageApiKey } from "./voyage-api-key.js";

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
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: POTION_MODEL_ID,
        EMBEDDING_OUTPUT_DIMENSION: String(POTION_DIMENSION),
        POTION_HELPER_PATH: path.join(homeDir, ".satori", "potion", "satori-potion"),
        POTION_MODEL_PATH: path.join(homeDir, ".satori", "potion", "model"),
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
        },
        potionAssetsRoot: path.join(homeDir, ".satori", "potion"),
        potionModelPath: path.join(homeDir, ".satori", "potion", "model"),
        packageSpecifier: `@satori-code/mcp@${VERSION}`,
        execFileSyncImpl: installRuntimePackageStub as never,
        platform: "linux",
        architecture: "x64",
        preflightDependencies: {
            fetchImpl,
            probeLanceDb: async () => undefined,
            probeCandidateRuntime: async () => undefined,
            verifyPotionRuntime: async () => {},
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

test("interactive Voyage switch saves a private key file, preserves other lines, and verifies with the key", async () => {
    await withTempHome(async (homeDir) => {
        writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        const envPath = path.join(homeDir, ".satori", ".env");
        const otherLines = "# Local settings\r\nOTHER_SETTING=keep=this\r\n\r\nVOYAGEAI_API_KEY=\r\n";
        fs.writeFileSync(envPath, otherLines, { mode: 0o644 });
        fs.chmodSync(envPath, 0o644);
        const originalInode = fs.statSync(envPath).ino;
        const calls: Array<{ input: string; init?: RequestInit }> = [];
        let prompts = 0;
        let output = "";
        const options = {
            ...optionsFor(homeDir, responseFetch(200, "{}", calls)),
            env: {},
            isInteractive: true,
            promptApiKey: async () => { prompts += 1; return API_KEY; },
            writeMessage: (message: string) => { output += message; },
        };
        const result = await executeManagedRerankerCommand({ operation: "use", provider: "voyage", purge: false }, options);

        assert.equal(prompts, 1);
        assert.equal(result.status, "changed");
        assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
        assert.notEqual(fs.statSync(envPath).ino, originalInode, "atomic replacement must create a new inode");
        assert.equal(fs.readFileSync(envPath, "utf8"), otherLines.replace("VOYAGEAI_API_KEY=\r", `VOYAGEAI_API_KEY=${API_KEY}`));
        assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, `Bearer ${API_KEY}`);
        assert.match(output, /paid API.*20 of 28 questions.*LateOn did so for 13/);
        assert.ok(output.includes(envPath));
        assert.equal((output + formatRerankerText(result) + JSON.stringify(result)).includes(API_KEY), false);
        assert.equal(fs.readFileSync(launcherPath(homeDir), "utf8").includes(API_KEY), false);
        assert.equal(fs.readdirSync(path.dirname(envPath)).some((name) => name.endsWith(".tmp")), false);
    });
});

test("empty Voyage key input cancels without changing the launcher or env file", async () => {
    await withTempHome(async (homeDir) => {
        const launcher = writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        const launcherBytes = fs.readFileSync(launcher);
        const envPath = path.join(homeDir, ".satori", ".env");
        for (const existingContent of [null, "OTHER_SETTING=keep\nVOYAGEAI_API_KEY=\n"]) {
            if (existingContent !== null) {
                fs.writeFileSync(envPath, existingContent, { mode: 0o644 });
                fs.chmodSync(envPath, 0o644);
            }
            const options = {
                ...optionsFor(homeDir, (async () => { throw new Error("must not verify on cancellation"); }) as typeof fetch),
                env: {},
                isInteractive: true,
                promptApiKey: async () => "   ",
                writeMessage: () => {},
            };
            const result = await executeManagedRerankerCommand({ operation: "use", provider: "voyage", purge: false }, options);
            assert.equal(result.status, "cancelled");
            assert.equal(result.restartRequired, false);
            assert.match(formatRerankerText(result), /switch cancelled/);
            assert.deepEqual(fs.readFileSync(launcher), launcherBytes);
            if (existingContent === null) assert.equal(fs.existsSync(envPath), false);
            else {
                assert.equal(fs.readFileSync(envPath, "utf8"), existingContent);
                assert.equal(fs.statSync(envPath).mode & 0o777, 0o644);
            }
        }
    });
});

test("non-TTY Voyage switch without a key names the variable and env file without prompting", async () => {
    await withTempHome(async (homeDir) => {
        const launcher = writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        const launcherBytes = fs.readFileSync(launcher);
        const options = {
            ...optionsFor(homeDir, (async () => { throw new Error("must not verify without a key"); }) as typeof fetch),
            env: {},
            isInteractive: false,
            promptApiKey: async () => { throw new Error("must not prompt without a TTY"); },
            writeMessage: () => {},
        };
        await assert.rejects(
            executeManagedRerankerCommand({ operation: "use", provider: "voyage", noVerify: true, purge: false }, options),
            (error: unknown) => {
                assert.ok(error instanceof CliError);
                assert.match(error.message, /VOYAGEAI_API_KEY/);
                assert.ok(error.message.includes(path.join(homeDir, ".satori", ".env")));
                assert.match(error.message, /terminal/i);
                return true;
            },
        );
        assert.deepEqual(fs.readFileSync(launcher), launcherBytes);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori", ".env")), false);
    });
});

test("existing environment or env-file Voyage keys skip prompting with process env taking precedence", async () => {
    await withTempHome(async (homeDir) => {
        const envPath = path.join(homeDir, ".satori", ".env");
        for (const useProcessEnv of [true, false]) {
            writeLauncher(homeDir, baseManagedEnvironment(homeDir));
            const fileKey = "test-voyage-file-secret";
            const content = `# Existing key\n VOYAGEAI_API_KEY=${fileKey}\nOTHER=keep\n`;
            fs.writeFileSync(envPath, content);
            const calls: Array<{ input: string; init?: RequestInit }> = [];
            let output = "";
            const options = {
                ...optionsFor(homeDir, responseFetch(200, "{}", calls)),
                env: useProcessEnv ? { VOYAGEAI_API_KEY: API_KEY } : {},
                isInteractive: useProcessEnv,
                promptApiKey: async () => { throw new Error("existing key must skip prompt"); },
                writeMessage: (message: string) => { output += message; },
            };
            const result = await executeManagedRerankerCommand({ operation: "use", provider: "voyage", purge: false }, options);
            assert.equal(result.status, "changed");
            assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, `Bearer ${useProcessEnv ? API_KEY : fileKey}`);
            assert.equal(fs.readFileSync(envPath, "utf8"), content);
            assert.equal((output + formatRerankerText(result) + JSON.stringify(result)).includes(API_KEY), false);
            assert.equal((output + formatRerankerText(result) + JSON.stringify(result)).includes(fileKey), false);
        }
    });
});

test("first Voyage key save creates a private directory and env file", async () => {
    await withTempHome(async (homeDir) => {
        let output = "";
        const key = await resolveVoyageApiKey(homeDir, {}, {
            isInteractive: true,
            promptApiKey: async () => API_KEY,
            writeMessage: (message) => { output += message; },
        });
        assert.equal(key, API_KEY);
        assert.equal(fs.statSync(path.join(homeDir, ".satori")).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(homeDir, ".satori", ".env")).mode & 0o777, 0o600);
        assert.equal(output.includes(API_KEY), false);
    });
});

test("hidden readline input restores raw mode after Enter, Ctrl+C, and EOF", async () => {
    for (const [inputBytes, expected] of [[`${API_KEY}\r`, API_KEY], ["\x03", ""], ["\x04", ""]]) {
        const input = new PassThrough() as PassThrough & { setRawMode: (enabled: boolean) => void; isRaw: boolean };
        const rawModes: boolean[] = [];
        input.isRaw = false;
        input.setRawMode = (enabled) => { input.isRaw = enabled; rawModes.push(enabled); };
        const result = promptHiddenApiKey(input);
        input.write(inputBytes);
        assert.equal(await result, expected);
        assert.deepEqual(rawModes, [true, false]);
        input.destroy();
    }
});

test("Voyage verification rejection after prompting keeps the launcher and redacts the saved key", async () => {
    await withTempHome(async (homeDir) => {
        const launcher = writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        const originalBytes = fs.readFileSync(launcher);
        let output = "";
        const options = {
            ...optionsFor(homeDir, responseFetch(401, `Rejected ${API_KEY}`, [])),
            env: {},
            isInteractive: true,
            promptApiKey: async () => API_KEY,
            writeMessage: (message: string) => { output += message; },
        };
        await assert.rejects(
            executeManagedRerankerCommand({ operation: "use", provider: "voyage", purge: false }, options),
            (error: unknown) => {
                assert.ok(error instanceof CliError);
                assert.match(error.message, /Rejected \[redacted\]/);
                assert.equal((error.message + output).includes(API_KEY), false);
                return true;
            },
        );
        assert.deepEqual(fs.readFileSync(launcher), originalBytes);
        assert.equal(fs.statSync(path.join(homeDir, ".satori", ".env")).mode & 0o777, 0o600);
    });
});

test("plain reranker in a terminal lists switch commands while JSON keeps the status shape", async () => {
    await withTempHome(async (homeDir) => {
        writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        let stdout = "";
        let stderr = "";
        const options = {
            env: { HOME: homeDir },
            stdoutIsTTY: true,
            writeStdout: (text: string) => { stdout += text; },
            writeStderr: (text: string) => { stderr += text; },
        };
        assert.equal(await runCli(["reranker"], options), 0, stderr);
        assert.match(stdout, /Reranker: none \(disabled\)/);
        assert.match(stdout, /reranker use voyage {2}Voyage/);
        assert.match(stdout, /reranker use lateon/);
        assert.match(stdout, /reranker disable/);
        stdout = "";
        assert.equal(await runCli(["reranker", "--format", "json"], options), 0, stderr);
        assert.deepEqual(JSON.parse(stdout), await executeManagedRerankerCommand({ operation: "status", purge: false }, { homeDir, env: {} }));
        assert.equal(stderr, "");
    });
});

test("CLI prompt cancellation leaves JSON parseable and does not expose the key", async () => {
    await withTempHome(async (homeDir) => {
        const launcher = writeLauncher(homeDir, baseManagedEnvironment(homeDir));
        const originalBytes = fs.readFileSync(launcher);
        let stdout = "";
        let stderr = "";
        let prompts = 0;
        const input = new PassThrough() as unknown as NodeJS.ReadStream;
        input.isTTY = true;
        const exit = await runCli(["reranker", "use", "voyage", "--format", "json"], {
            env: { HOME: homeDir },
            stdin: input,
            stdoutIsTTY: true,
            promptVoyageApiKey: async () => { prompts += 1; return ""; },
            writeStdout: (text) => { stdout += text; },
            writeStderr: (text) => { stderr += text; },
        });
        assert.equal(exit, 0);
        assert.equal(prompts, 1);
        assert.equal(JSON.parse(stdout).status, "cancelled");
        assert.match(stderr, /paid API/);
        assert.match(stderr, /hidden; Enter to cancel/);
        assert.deepEqual(fs.readFileSync(launcher), originalBytes);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori", ".env")), false);
        input.destroy();
    });
});

test("managed launcher child resolves its Voyage key from the saved env file through MCP configuration", async () => {
    await withTempHome(async (homeDir) => {
        writeLauncher(homeDir, { ...baseManagedEnvironment(homeDir), SATORI_RERANKER_PROVIDER: "voyage" });
        await resolveVoyageApiKey(homeDir, {}, { isInteractive: true, promptApiKey: async () => API_KEY, writeMessage: () => {} });
        const descriptor = parseManagedLauncherDescriptor(fs.readFileSync(launcherPath(homeDir), "utf8"));
        const runtimeEntry = descriptor.args[0];
        const serverDir = path.join(path.dirname(runtimeEntry), "server");
        fs.mkdirSync(serverDir, { recursive: true });
        // Exercise the direct launcher branch with the real MCP/Core config reader, without starting services.
        fs.writeFileSync(path.join(serverDir, "shared-runtime-identity.js"), "exports.isSharedOfflineRuntimeEligible = () => false;\n");
        const configUrl = new URL("../../mcp/dist/config.js", import.meta.url).href;
        fs.writeFileSync(runtimeEntry, `import(${JSON.stringify(configUrl)}).then(({ createMcpConfig }) => {
            const config = createMcpConfig();
            console.log(JSON.stringify({ provider: config.rerankerProvider, keyFromFile: config.voyageKey === ${JSON.stringify(API_KEY)} }));
        });\n`);
        const child = spawnSync(process.execPath, [launcherPath(homeDir)], {
            env: { HOME: homeDir, PATH: process.env.PATH },
            input: "",
            encoding: "utf8",
            timeout: 10_000,
        });
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), { provider: "voyage", keyFromFile: true });
        assert.equal((child.stdout + child.stderr).includes(API_KEY), false);
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

