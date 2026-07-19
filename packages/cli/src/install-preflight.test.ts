import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeInstallCommand, type InstallCommandInput } from "./install.js";
import {
    probeLanceDbRuntime,
    probeManagedRuntimeCandidate,
    runInstallPreflight,
    verifyBundledPotionRuntime,
} from "./install-preflight.js";
import { buildLauncherScript, parseManagedLauncherEnvironment } from "./managed-launcher-script.mjs";

const DIGEST = "b".repeat(64);
const POTION_ASSETS_ROOT = fileURLToPath(new URL("../../mcp/assets/potion/linux-x64/", import.meta.url));

function installRuntimeWithProbeMarker(markerPath: string) {
    return ((_command: string, args: string[]) => {
        const prefixIndex = args.indexOf("--prefix");
        assert.notEqual(prefixIndex, -1);
        const runtimeRoot = args[prefixIndex + 1];
        assert.ok(runtimeRoot);
        const mcpRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
        const coreRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-core");
        fs.mkdirSync(path.join(mcpRoot, "dist"), { recursive: true });
        fs.mkdirSync(coreRoot, { recursive: true });
        fs.writeFileSync(path.join(mcpRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "0.0.0-exact-runtime-test",
            bin: { satori: "dist/index.js" },
        }), "utf8");
        fs.writeFileSync(path.join(mcpRoot, "dist", "index.js"), "", "utf8");
        fs.writeFileSync(path.join(coreRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            type: "module",
            exports: { "./lancedb": "./lancedb.mjs" },
        }), "utf8");
        fs.writeFileSync(path.join(coreRoot, "lancedb.mjs"), `
import fs from "node:fs";
export class LanceDbVectorDatabase {
  constructor(config) { fs.appendFileSync(${JSON.stringify(markerPath)}, config.databasePath + "\\n"); }
  async createHybridCollection() {}
  async writeDocuments() {}
  async finalizeCollectionForSearch() {}
  async retrieveDense() { return [{ document: { id: "preflight_document" } }]; }
  async retrieveLexical() { return [{ document: { id: "preflight_document" } }]; }
  async dropCollection() {}
  async listCollections() { return []; }
  async close() {}
}
`, "utf8");
        return "";
    }) as never;
}

test("install preflight loads LanceDB from the installed MCP runtime", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-exact-runtime-preflight-"));
    const markerPath = path.join(homeDir, "managed-core-probe.log");
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-exact-runtime-test",
            execFileSyncImpl: installRuntimeWithProbeMarker(markerPath),
            preflightDependencies: {
                probeCandidateRuntime: async () => {},
            },
        });

        const constructedPaths = fs.readFileSync(markerPath, "utf8").trim().split("\n");
        assert.equal(constructedPaths.length >= 2, true);
        assert.equal(constructedPaths.every((candidate) => candidate.startsWith(homeDir)), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("candidate preflight proves initialization, version, and the canonical tool surface", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-candidate-runtime-preflight-"));
    const runtimeEntry = path.join(homeDir, "candidate.mjs");
    try {
        fs.writeFileSync(runtimeEntry, `
import readline from "node:readline";
const tools = ${JSON.stringify([
            "manage_index",
            "search_codebase",
            "continue_search",
            "call_graph",
            "file_outline",
            "read_file",
            "list_codebases",
        ])};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "satori", version: "9.8.7-test" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, {
      tools: tools.map((name) => ({
        name,
        description: "candidate fixture",
        inputSchema: { type: "object", properties: {} },
      })),
    });
  }
});
`, "utf8");

        await probeManagedRuntimeCandidate({
            runtimeCommand: { command: process.execPath, args: [runtimeEntry] },
            runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
            inheritedEnvironment: {},
            homeDir,
            expectedVersion: "9.8.7-test",
        });
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("Voyage install preflight proves and pins the default LanceDB and Voyage identity", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-voyage-preflight-"));
    const probedPaths: string[] = [];
    try {
        const result = await runInstallPreflight({
            runtime: "voyage",
            homeDir,
            env: {},
        }, {
            probeLanceDb: async (databasePath) => {
                probedPaths.push(databasePath);
            },
        });

        assert.deepEqual(probedPaths, [path.join(homeDir, ".satori", "vector", "lancedb")]);
        assert.deepEqual(result.runtimeEnvironment, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, ".satori", "vector", "lancedb"),
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "voyage-code-3",
            EMBEDDING_OUTPUT_DIMENSION: "1024",
        });
        assert.equal(Object.isFrozen(result.runtimeEnvironment), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected Milvus selection skips LanceDB and ignores irrelevant LanceDB path state", async () => {
    let lanceDbProbeCalls = 0;
    const result = await runInstallPreflight({
        runtime: "voyage",
        homeDir: "/tmp/satori-connected-milvus",
        env: {
            VECTOR_STORE_PROVIDER: "Milvus",
            MILVUS_ADDRESS: "https://milvus.example.test",
            LANCEDB_PATH: "relative/stale/value",
            EMBEDDING_PROVIDER: "OpenAI",
        },
    }, {
        probeLanceDb: async () => {
            lanceDbProbeCalls += 1;
        },
    });

    assert.equal(lanceDbProbeCalls, 0);
    assert.deepEqual(result.runtimeEnvironment, {
        SATORI_RUNTIME_PROFILE: "connected",
        VECTOR_STORE_PROVIDER: "Milvus",
        EMBEDDING_PROVIDER: "VoyageAI",
        EMBEDDING_MODEL: "voyage-code-3",
        EMBEDDING_OUTPUT_DIMENSION: "1024",
    });
});

test("managed connected launcher pins the Milvus backend that passed preflight", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-milvus-install-"));
    const externalEnvironment = {
        VECTOR_STORE_PROVIDER: "Milvus",
        MILVUS_ADDRESS: "https://milvus.example.test",
        EMBEDDING_PROVIDER: "OpenAI",
    };
    let lanceDbProbeCalls = 0;
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: externalEnvironment,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async () => {
                    lanceDbProbeCalls += 1;
                },
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        );
        assert.equal(lanceDbProbeCalls, 0);
        assert.deepEqual(launcherEnvironment, {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "Milvus",
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "voyage-code-3",
            EMBEDDING_OUTPUT_DIMENSION: "1024",
        });
        assert.equal({ ...externalEnvironment, ...launcherEnvironment }.VECTOR_STORE_PROVIDER, "Milvus");
        assert.equal({ ...externalEnvironment, ...launcherEnvironment }.EMBEDDING_PROVIDER, "VoyageAI");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("offline install preflight records resolved local model identity", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-preflight-"));
    try {
        const result = await runInstallPreflight({
            runtime: "offline",
            homeDir,
            env: { OLLAMA_HOST: "http://localhost:11434" },
            ollamaModel: "nomic-embed-text",
        }, {
            probeLanceDb: async () => undefined,
            resolveOllamaIdentity: async ({ model, host }) => {
                assert.equal(model, "nomic-embed-text");
                assert.equal(host, "http://localhost:11434");
                return Object.freeze({
                    configuredModel: model,
                    resolvedModel: "nomic-embed-text:latest",
                    artifactDigest: DIGEST,
                    artifactSize: 42,
                    dimension: 768,
                });
            },
        });

        assert.equal(result.runtimeEnvironment.SATORI_RUNTIME_PROFILE, "offline");
        assert.equal(result.runtimeEnvironment.EMBEDDING_PROVIDER, "Ollama");
        assert.equal(result.runtimeEnvironment.OLLAMA_MODEL, "nomic-embed-text:latest");
        assert.equal(result.runtimeEnvironment.OLLAMA_MODEL_DIGEST, DIGEST);
        assert.equal(result.runtimeEnvironment.EMBEDDING_OUTPUT_DIMENSION, "768");
        assert.equal(result.ollamaIdentity?.dimension, 768);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("offline install defaults to the checksum-verified bundled Potion runtime", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-potion-preflight-"));
    try {
        const result = await runInstallPreflight({
            runtime: "offline",
            homeDir,
            env: {},
            potionAssetsRoot: POTION_ASSETS_ROOT,
            platform: "linux",
            architecture: "x64",
        }, {
            probeLanceDb: async () => undefined,
        });

        assert.deepEqual(result.runtimeEnvironment, {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, ".satori", "vector", "lancedb"),
            EMBEDDING_PROVIDER: "Potion",
            EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
            EMBEDDING_OUTPUT_DIMENSION: "256",
            POTION_HELPER_PATH: path.join(POTION_ASSETS_ROOT, "satori-potion"),
            POTION_MODEL_PATH: path.join(POTION_ASSETS_ROOT, "model"),
            POTION_REQUEST_TIMEOUT_MS: "5000",
        });
        await verifyBundledPotionRuntime(POTION_ASSETS_ROOT);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("bundled Potion verification rejects a modified provenance manifest", async () => {
    const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-potion-manifest-"));
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(POTION_ASSETS_ROOT, "manifest.json"), "utf8"));
        manifest.helper.rustToolchain = "untrusted-toolchain";
        fs.writeFileSync(path.join(assetsRoot, "manifest.json"), JSON.stringify(manifest), "utf8");
        await assert.rejects(
            verifyBundledPotionRuntime(assetsRoot),
            /missing, invalid, or untrusted/,
        );
    } finally {
        fs.rmSync(assetsRoot, { recursive: true, force: true });
    }
});

test("new offline install persists the verified Potion identity in the managed launcher", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-potion-install-"));
    try {
        await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            potionAssetsRoot: POTION_ASSETS_ROOT,
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async () => undefined,
            },
        });

        const launcherEnvironment = parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        );
        assert.equal(launcherEnvironment.EMBEDDING_PROVIDER, "Potion");
        assert.equal(launcherEnvironment.EMBEDDING_OUTPUT_DIMENSION, "256");
        assert.equal(launcherEnvironment.POTION_HELPER_PATH, path.join(POTION_ASSETS_ROOT, "satori-potion"));
        assert.equal(launcherEnvironment.POTION_MODEL_PATH, path.join(POTION_ASSETS_ROOT, "model"));
        assert.equal(launcherEnvironment.OLLAMA_MODEL, undefined);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("Potion default fails before artifact verification on unsupported platforms", async () => {
    let verificationCalls = 0;
    await assert.rejects(
        runInstallPreflight({
            runtime: "offline",
            homeDir: "/tmp/satori-potion-unsupported",
            env: {},
            potionAssetsRoot: "/tmp/potion-assets",
            platform: "darwin",
            architecture: "arm64",
        }, {
            probeLanceDb: async () => undefined,
            verifyPotionRuntime: async () => { verificationCalls += 1; },
        }),
        /supports Linux x64/,
    );
    assert.equal(verificationCalls, 0);
});

test("unsupported Potion platform fails before managed package installation", async () => {
    let installCalls = 0;
    await assert.rejects(executeInstallCommand({
        kind: "install",
        client: "codex",
        dryRun: false,
        runtime: "offline",
    }, {
        homeDir: "/tmp/satori-potion-unsupported-install",
        env: {},
        packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
        platform: "darwin",
        architecture: "arm64",
        execFileSyncImpl: (() => {
            installCalls += 1;
            return "";
        }) as never,
    }), /supports Linux x64/);
    assert.equal(installCalls, 0);
});

test("the real LanceDB preflight proves FTS and dense reads after reopen", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-preflight-"));
    try {
        await probeLanceDbRuntime(path.join(homeDir, ".satori", "vector", "lancedb"), {
            loadLanceDb: async () => {
                const { LanceDbVectorDatabase } = await import("../../core/src/vectordb/lancedb-vectordb.js");
                return { LanceDbVectorDatabase };
            },
        });
        assert.equal(fs.existsSync(path.join(homeDir, ".satori")), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("LanceDB preflight rejects unsafe exact target paths without loading native code", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-path-shape-"));
    const filePath = path.join(homeDir, "lancedb");
    const symlinkPath = path.join(homeDir, "lancedb-link");
    fs.writeFileSync(filePath, "not a database", "utf8");
    fs.symlinkSync(homeDir, symlinkPath);
    let nativeLoads = 0;
    const dependencies = {
        loadLanceDb: async () => {
            nativeLoads += 1;
            throw new Error("native loader must not run");
        },
    };
    try {
        await assert.rejects(probeLanceDbRuntime(filePath, dependencies), /must be a directory/);
        await assert.rejects(probeLanceDbRuntime(symlinkPath, dependencies), /must not be a symbolic link/);
        assert.equal(nativeLoads, 0);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("LanceDB capability operations run on the configured target filesystem", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-target-filesystem-"));
    const databasePath = path.join(homeDir, ".satori", "vector", "lancedb");
    const constructedPaths: string[] = [];
    class FakeLanceDb {
        constructor(config: { databasePath: string }) {
            constructedPaths.push(config.databasePath);
        }
        async createHybridCollection() {}
        async writeDocuments() {}
        async finalizeCollectionForSearch() {}
        async retrieveDense() { return [{ document: { id: "preflight_document" } }]; }
        async retrieveLexical() { return [{ document: { id: "preflight_document" } }]; }
        async dropCollection() {}
        async listCollections() { return []; }
        async close() {}
    }
    try {
        await probeLanceDbRuntime(databasePath, {
            loadLanceDb: async () => ({ LanceDbVectorDatabase: FakeLanceDb }) as never,
        });
        assert.equal(constructedPaths.length, 2);
        assert.equal(constructedPaths.every((candidate) => candidate.startsWith(`${homeDir}${path.sep}`)), true);
        assert.equal(constructedPaths.every((candidate) => path.basename(candidate).startsWith(".satori-install-preflight-")), true);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("an existing LanceDB target is inspected but never contains the synthetic probe database", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lancedb-existing-target-"));
    const databasePath = path.join(homeDir, "lancedb");
    fs.mkdirSync(databasePath);
    const constructedPaths: string[] = [];
    class FakeLanceDb {
        constructor(config: { databasePath: string }) {
            constructedPaths.push(config.databasePath);
        }
        async createHybridCollection() {}
        async writeDocuments() {}
        async finalizeCollectionForSearch() {}
        async retrieveDense() { return [{ document: { id: "preflight_document" } }]; }
        async retrieveLexical() { return [{ document: { id: "preflight_document" } }]; }
        async dropCollection() {}
        async listCollections() { return []; }
        async close() {}
    }
    try {
        await probeLanceDbRuntime(databasePath, {
            loadLanceDb: async () => ({ LanceDbVectorDatabase: FakeLanceDb }) as never,
        });
        assert.equal(constructedPaths.length, 3);
        assert.equal(constructedPaths[2], databasePath);
        assert.equal(constructedPaths.slice(0, 2).every((candidate) => (
            path.dirname(candidate) === homeDir
            && !candidate.startsWith(`${databasePath}${path.sep}`)
        )), true);
        assert.deepEqual(fs.readdirSync(databasePath), []);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

for (const currentPath of [undefined, ""] as const) {
test(`connected reinstall preserves a managed custom LanceDB path when the shell supplies ${currentPath === undefined ? "no value" : "an empty value"}`, async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-path-reinstall-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const databasePath = path.join(homeDir, "custom", "lancedb");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: databasePath,
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "voyage-code-3",
            EMBEDDING_OUTPUT_DIMENSION: "1024",
        },
    }), "utf8");
    const probedPaths: string[] = [];
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: currentPath === undefined ? {} : { LANCEDB_PATH: currentPath },
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/new-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async (candidate) => { probedPaths.push(candidate); },
            },
        });

        assert.deepEqual(probedPaths, [databasePath]);
        assert.equal(result.runtimeEnvironment?.LANCEDB_PATH, databasePath);
        assert.equal(parseManagedLauncherEnvironment(
            fs.readFileSync(launcherPath, "utf8"),
        ).LANCEDB_PATH, databasePath);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});
}

for (const currentValues of [
    {},
    { LANCEDB_PATH: "", OLLAMA_HOST: "   " },
] as const) {
test(`offline reinstall preserves managed LanceDB and Ollama endpoints with ${"LANCEDB_PATH" in currentValues ? "blank" : "absent"} shell values`, async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-path-reinstall-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const databasePath = path.join(homeDir, "custom", "offline-lancedb");
    const ollamaHost = "http://localhost:11435";
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: databasePath,
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: "nomic-embed-text:latest",
            OLLAMA_MODEL_DIGEST: DIGEST,
            EMBEDDING_OUTPUT_DIMENSION: "768",
            OLLAMA_HOST: ollamaHost,
        },
    }), "utf8");
    const probedPaths: string[] = [];
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            ollamaModel: "nomic-embed-text",
        }, {
            homeDir,
            env: currentValues,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/new-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async (candidate) => { probedPaths.push(candidate); },
                resolveOllamaIdentity: async ({ host }) => {
                    assert.equal(host, ollamaHost);
                    return Object.freeze({
                        configuredModel: "nomic-embed-text",
                        resolvedModel: "nomic-embed-text:latest",
                        artifactDigest: DIGEST,
                        artifactSize: 42,
                        dimension: 768,
                    });
                },
            },
        });

        assert.deepEqual(probedPaths, [databasePath]);
        assert.equal(result.runtimeEnvironment?.LANCEDB_PATH, databasePath);
        assert.equal(result.runtimeEnvironment?.OLLAMA_HOST, ollamaHost);
        const launcherEnvironment = parseManagedLauncherEnvironment(fs.readFileSync(launcherPath, "utf8"));
        assert.equal(launcherEnvironment.LANCEDB_PATH, databasePath);
        assert.equal(launcherEnvironment.OLLAMA_HOST, ollamaHost);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});
}

test("offline reinstall without a model preserves an existing managed Ollama selection", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-ollama-preserve-"));
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/old-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            LANCEDB_PATH: path.join(homeDir, "lancedb"),
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: "nomic-embed-text:latest",
            OLLAMA_MODEL_DIGEST: DIGEST,
            EMBEDDING_OUTPUT_DIMENSION: "768",
            OLLAMA_HOST: "http://localhost:11434",
        },
    }), "utf8");
    let selectedModel: string | undefined;
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
        }, {
            homeDir,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/new-runtime.js"] },
            preflightRunner: async (input) => {
                selectedModel = input.ollamaModel;
                return {
                    runtimeEnvironment: Object.freeze({
                        SATORI_RUNTIME_PROFILE: "offline",
                        VECTOR_STORE_PROVIDER: "LanceDB",
                        EMBEDDING_PROVIDER: "Ollama",
                        OLLAMA_MODEL: input.ollamaModel || "",
                        OLLAMA_MODEL_DIGEST: DIGEST,
                    }),
                };
            },
        });

        assert.equal(selectedModel, "nomic-embed-text:latest");
        assert.equal(result.runtimeEnvironment?.EMBEDDING_PROVIDER, "Ollama");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("new Potion offline install rejects a conflicting ambient provider", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-potion-conflict-"));
    try {
        await assert.rejects(executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "offline",
        }, {
            homeDir,
            env: { EMBEDDING_PROVIDER: "VoyageAI" },
        }), /conflicts with the Potion offline installation selection/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected reinstall reads a literal Milvus selection from Codex config", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-client-selection-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
        "[mcp_servers.satori.env]",
        'VECTOR_STORE_PROVIDER = "Milvus"',
        'MILVUS_ADDRESS = "https://milvus.example.test"',
        "",
    ].join("\n"), "utf8");
    let lanceDbProbeCalls = 0;
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            env: {},
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightDependencies: {
                probeLanceDb: async () => {
                    lanceDbProbeCalls += 1;
                },
            },
        });

        assert.equal(lanceDbProbeCalls, 0);
        assert.equal(result.runtimeEnvironment?.VECTOR_STORE_PROVIDER, "Milvus");
        assert.equal(parseManagedLauncherEnvironment(
            fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8"),
        ).VECTOR_STORE_PROVIDER, "Milvus");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected reinstall rejects launcher and client backend disagreement", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-selection-conflict-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(configPath, [
        "[mcp_servers.satori.env]",
        'VECTOR_STORE_PROVIDER = "Milvus"',
        "",
    ].join("\n"), "utf8");
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/satori-runtime.js"],
        managedEnv: {
            SATORI_RUNTIME_PROFILE: "connected",
            VECTOR_STORE_PROVIDER: "LanceDB",
        },
    }), "utf8");
    try {
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: true,
                runtime: "voyage",
            }, { homeDir, env: {} }),
            /installer environment, managed launcher, and configured Satori clients disagree/,
        );
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("connected backend discovery includes configured clients outside --client", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-global-client-selection-"));
    const claudePath = path.join(homeDir, ".claude.json");
    fs.writeFileSync(claudePath, JSON.stringify({
        mcpServers: {
            satori: {
                command: "node",
                args: ["/tmp/satori.js"],
                env: { VECTOR_STORE_PROVIDER: "Milvus" },
            },
        },
    }), "utf8");
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: true,
            runtime: "voyage",
        }, { homeDir, env: {} });
        assert.equal(result.runtimeEnvironment?.VECTOR_STORE_PROVIDER, "Milvus");
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("ambient backend values cannot suppress launcher and client disagreement", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-connected-ambient-conflict-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(configPath, [
        "[mcp_servers.satori.env]",
        'VECTOR_STORE_PROVIDER = "Milvus"',
        "",
    ].join("\n"), "utf8");
    fs.writeFileSync(launcherPath, buildLauncherScript({
        command: process.execPath,
        args: ["/tmp/satori-runtime.js"],
        managedEnv: { VECTOR_STORE_PROVIDER: "LanceDB" },
    }), "utf8");
    try {
        for (const value of ["LanceDB", "Milvus"] as const) {
            await assert.rejects(executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: true,
                runtime: "voyage",
            }, {
                homeDir,
                env: { VECTOR_STORE_PROVIDER: value },
            }), /installer environment, managed launcher, and configured Satori clients disagree/);
        }
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("programmatic offline installs reject a contradictory Milvus backend", async () => {
    const command = {
        kind: "install",
        client: "codex",
        dryRun: true,
        runtime: "offline",
        vectorStore: "Milvus",
        ollamaModel: "nomic-embed-text",
    } as unknown as InstallCommandInput;
    await assert.rejects(
        executeInstallCommand(command, { homeDir: "/tmp/satori-offline-invalid", env: {} }),
        /Offline install requires --vector-store lancedb/,
    );
});

test("install reads mutable client configuration after awaited preflight", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-install-preflight-race-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'model = "before"\n', "utf8");
    let releasePreflight!: () => void;
    const preflightPending = new Promise<void>((resolve) => {
        releasePreflight = resolve;
    });
    try {
        const installation = executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "voyage",
        }, {
            homeDir,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightRunner: async () => {
                await preflightPending;
                return {
                    runtimeEnvironment: Object.freeze({ SATORI_RUNTIME_PROFILE: "connected" }),
                };
            },
        });
        fs.writeFileSync(configPath, 'model = "changed-during-preflight"\n', "utf8");
        releasePreflight();
        await installation;

        assert.match(fs.readFileSync(configPath, "utf8"), /changed-during-preflight/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("rejected runtime preflight leaves managed client files byte-for-byte unchanged", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-rejected-preflight-"));
    const configPath = path.join(homeDir, ".codex", "config.toml");
    const original = 'model = "gpt-5"\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original, "utf8");
    try {
        await assert.rejects(
            executeInstallCommand({
                kind: "install",
                client: "codex",
                dryRun: false,
                runtime: "voyage",
            }, {
                homeDir,
                packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
                runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
                preflightRunner: async () => {
                    throw new Error("native load rejected");
                },
            }),
            /native load rejected/,
        );
        assert.equal(fs.readFileSync(configPath, "utf8"), original);
        assert.equal(fs.existsSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js")), false);
        assert.equal(fs.existsSync(path.join(homeDir, ".codex", "skills", "satori")), false);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("successful offline install persists its non-secret identity in the shared launcher", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-offline-install-"));
    try {
        const result = await executeInstallCommand({
            kind: "install",
            client: "codex",
            dryRun: false,
            runtime: "offline",
            ollamaModel: "nomic-embed-text",
        }, {
            homeDir,
            packageSpecifier: "@zokizuan/satori-mcp@0.0.0-test",
            runtimeCommand: { command: process.execPath, args: ["/tmp/satori-runtime.js"] },
            preflightRunner: async () => ({
                runtimeEnvironment: Object.freeze({
                    SATORI_RUNTIME_PROFILE: "offline",
                    VECTOR_STORE_PROVIDER: "LanceDB",
                    EMBEDDING_PROVIDER: "Ollama",
                    OLLAMA_MODEL: "nomic-embed-text:latest",
                    OLLAMA_MODEL_DIGEST: DIGEST,
                }),
            }),
        });

        const launcher = fs.readFileSync(path.join(homeDir, ".satori", "bin", "satori-mcp.js"), "utf8");
        assert.match(launcher, /"SATORI_RUNTIME_PROFILE":"offline"/);
        assert.match(launcher, new RegExp(`"OLLAMA_MODEL_DIGEST":"${DIGEST}"`));
        assert.match(launcher, /env: \{ \.\.\.process\.env, \.\.\.managedEnv \}/);
        assert.equal(result.runtime, "offline");
        assert.equal(result.runtimeEnvironment?.OLLAMA_MODEL_DIGEST, DIGEST);
        assert.doesNotMatch(launcher, /VOYAGEAI_API_KEY/);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});
