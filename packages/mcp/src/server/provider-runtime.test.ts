import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityResolver } from "../core/capabilities.js";
import { SearchContinuationCoordinator } from "../core/handlers.js";
import { CallGraphSidecarManager } from "../core/call-graph.js";
import { SnapshotManager } from "../core/snapshot.js";
import {
    buildRuntimeIndexFingerprint,
    ContextMcpConfig,
    parseIndexFingerprint,
    resolveVectorStoreConfig,
} from "../config.js";
import type { ToolContext } from "../tools/types.js";
import {
    createLocalOnlyContext,
    ProviderRuntime,
    resolveConfiguredEmbeddingDimension,
    startProviderSyncLifecycle,
} from "./provider-runtime.js";
import {
    Embedding,
    EMBEDDING_PROJECTION_VERSION,
    LANGUAGE_PARSER_VERSION,
    LEXICAL_PROJECTION_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
} from "@zokizuan/satori-core";

function baseConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: "test",
        version: "1.0.0",
        executionProfile: "connected",
        networkPolicy: { kind: "remote-allowed" },
        vectorStoreProvider: "Milvus",
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-4-large",
        encoderOutputDimension: 1024,
        readFileMaxLines: 1000,
        watchSyncEnabled: false,
        watchDebounceMs: 5000,
        ...overrides,
    };
}

function createRuntime(
    config: ContextMcpConfig,
    searchContinuationCoordinator?: SearchContinuationCoordinator,
): ProviderRuntime {
    const runtimeFingerprint = buildRuntimeIndexFingerprint(config, resolveConfiguredEmbeddingDimension(config));
    return new ProviderRuntime({
        config,
        snapshotManager: new SnapshotManager(runtimeFingerprint),
        runtimeFingerprint,
        capabilities: new CapabilityResolver(config),
        readFileMaxLines: 1000,
        watchSyncEnabled: false,
        watchDebounceMs: 5000,
        callGraphManager: new CallGraphSidecarManager(runtimeFingerprint),
        searchContinuationCoordinator,
    });
}

test("embedding/vector operations require provider key and MILVUS_ADDRESS", () => {
    const cases: Array<{ config: ContextMcpConfig; expected: string[] }> = [
        { config: baseConfig({ encoderProvider: "VoyageAI", voyageKey: undefined }), expected: ["VOYAGEAI_API_KEY", "MILVUS_ADDRESS"] },
        { config: baseConfig({ encoderProvider: "OpenAI", encoderModel: "text-embedding-3-small", openaiKey: undefined }), expected: ["OPENAI_API_KEY", "MILVUS_ADDRESS"] },
        { config: baseConfig({ encoderProvider: "Gemini", encoderModel: "gemini-embedding-001", geminiKey: undefined }), expected: ["GEMINI_API_KEY", "MILVUS_ADDRESS"] },
        { config: baseConfig({ encoderProvider: "Ollama", encoderModel: "nomic-embed-text" }), expected: ["MILVUS_ADDRESS"] },
        { config: baseConfig({ encoderProvider: "Potion", encoderModel: "pinned-potion" }), expected: ["POTION_HELPER_PATH", "POTION_MODEL_PATH", "MILVUS_ADDRESS"] },
    ];

    for (const item of cases) {
        const issue = createRuntime(item.config).validate("embedding_vector");
        assert.deepEqual(issue?.missingEnv, item.expected);
    }
});

test("runtime fingerprint seals analysis and projection versions", () => {
    const fingerprint = buildRuntimeIndexFingerprint(baseConfig(), 1024);
    assert.equal(fingerprint.parserVersion, LANGUAGE_PARSER_VERSION);
    assert.equal(fingerprint.extractorVersion, SYMBOL_EXTRACTOR_VERSION);
    assert.equal(fingerprint.relationshipVersion, RELATIONSHIP_BUILDER_VERSION);
    assert.equal(fingerprint.embeddingProjectionVersion, EMBEDDING_PROJECTION_VERSION);
    assert.equal(fingerprint.lexicalProjectionVersion, LEXICAL_PROJECTION_VERSION);
});

test("vector-store configuration defaults to LanceDB while preserving explicit Milvus", () => {
    assert.deepEqual(resolveVectorStoreConfig({ homeDir: "/home/test" }), {
        vectorStoreProvider: "LanceDB",
        lanceDbPath: path.resolve("/home/test/.satori/vector/lancedb"),
    });
    assert.deepEqual(resolveVectorStoreConfig({
        provider: "Milvus",
        homeDir: "/home/test",
    }), { vectorStoreProvider: "Milvus" });
    assert.deepEqual(resolveVectorStoreConfig({
        provider: "LanceDB",
        homeDir: "/home/test",
    }), {
        vectorStoreProvider: "LanceDB",
        lanceDbPath: path.resolve("/home/test/.satori/vector/lancedb"),
    });
    assert.throws(() => resolveVectorStoreConfig({
        provider: "LanceDB",
        lanceDbPath: "relative/database",
        homeDir: "/home/test",
    }), /must be absolute/);
    assert.throws(() => resolveVectorStoreConfig({
        provider: "Unknown",
        homeDir: "/home/test",
    }), /Invalid VECTOR_STORE_PROVIDER/);
});

test("LanceDB runtime selection seals backend identity without requiring Milvus", async (t) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-provider-lancedb-"));
    t.after(() => fs.rmSync(databasePath, { recursive: true, force: true }));
    const config = baseConfig({
        vectorStoreProvider: "LanceDB",
        lanceDbPath: databasePath,
        milvusEndpoint: undefined,
        milvusApiToken: undefined,
        embeddingArtifactDigest: "a".repeat(64),
    });
    const fingerprint = buildRuntimeIndexFingerprint(config, 1024);
    assert.equal(fingerprint.vectorStoreProvider, "LanceDB");
    assert.deepEqual(parseIndexFingerprint(fingerprint), fingerprint);

    const searchContinuationCoordinator = new SearchContinuationCoordinator();
    const runtime = createRuntime(config, searchContinuationCoordinator);
    assert.equal(runtime.validate("vector_only"), null);
    const toolContext = await runtime.requireToolContext("vector_only");
    assert.equal("ok" in toolContext, false);
    if ("ok" in toolContext) return;

    const vectorStore = toolContext.context.getVectorStore();
    assert.deepEqual(vectorStore.getBackendInfo?.(), {
        provider: "lancedb",
        transport: "embedded",
        address: databasePath,
    });
    await vectorStore.createCollection("runtime_probe", 2);
    assert.deepEqual(await vectorStore.listCollections(), ["runtime_probe"]);

    const contextFingerprint = (
        toolContext.context as unknown as {
            buildIndexCompletionFingerprint(): {
                vectorStoreProvider: string;
                embeddingArtifactDigest: string | null;
            };
        }
    ).buildIndexCompletionFingerprint();
    assert.equal(contextFingerprint.vectorStoreProvider, "LanceDB");
    assert.equal(contextFingerprint.embeddingArtifactDigest, "a".repeat(64));

    const stored = searchContinuationCoordinator.store(toolContext.toolHandlers, {
        value: {} as never,
        nextOffset: 0,
        nowMs: 0,
    });
    assert.equal(searchContinuationCoordinator.lookup(stored.handle, 1).status, "hit");

    await runtime.shutdown();
    assert.equal(
        searchContinuationCoordinator.lookup(stored.handle, 1).status,
        "owner_unavailable",
    );
    await assert.rejects(vectorStore.listCollections(), /closed/);
});

test("vector-only context preserves the configured embedding identity", () => {
    const config = baseConfig({
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-code-3",
        embeddingArtifactDigest: "b".repeat(64),
    });
    const context = createLocalOnlyContext(config);
    const fingerprint = (
        context as unknown as {
            buildIndexCompletionFingerprint(): {
                embeddingModel: string;
                embeddingArtifactDigest: string | null;
            };
        }
    ).buildIndexCompletionFingerprint();

    assert.equal(fingerprint.embeddingModel, "voyage-code-3");
    assert.equal(fingerprint.embeddingArtifactDigest, "b".repeat(64));
});

test("MILVUS_TOKEN is not a substitute for MILVUS_ADDRESS", () => {
    const issue = createRuntime(baseConfig({
        voyageKey: "pa-test",
        milvusEndpoint: undefined,
        milvusApiToken: "token-only",
    })).validate("embedding_vector");

    assert.deepEqual(issue?.missingEnv, ["MILVUS_ADDRESS"]);
});

test("clear only requires vector address, not embedding provider credentials", () => {
    const issue = createRuntime(baseConfig({
        voyageKey: undefined,
        milvusEndpoint: "localhost:19530",
    })).validate("vector_only");

    assert.equal(issue, null);
});

test("vector-only operations reuse an existing embedding-capable context", async () => {
    const runtime = createRuntime(baseConfig({
        voyageKey: "pa-test",
        milvusEndpoint: "localhost:19530",
    }));
    const embeddingContext = {} as ToolContext;
    const vectorContext = {} as ToolContext;
    const createdCapabilities: boolean[] = [];
    const runtimeInternals = runtime as unknown as {
        createRuntime(requireEmbedding: boolean): Promise<ToolContext>;
    };
    runtimeInternals.createRuntime = async (requireEmbedding) => {
        createdCapabilities.push(requireEmbedding);
        return requireEmbedding ? embeddingContext : vectorContext;
    };

    const searchContext = await runtime.requireToolContext("embedding_vector");
    const followUpReadContext = await runtime.requireToolContext("vector_only");

    assert.equal(searchContext, embeddingContext);
    assert.equal(followUpReadContext, searchContext);
    assert.deepEqual(createdCapabilities, [true]);
});

test("runtime shutdown closes each provider-owned embedding once", async () => {
    const runtime = createRuntime(baseConfig());
    let closeCalls = 0;
    const runtimeInternals = runtime as unknown as {
        activeEmbeddings: Set<Embedding>;
    };
    runtimeInternals.activeEmbeddings.add({
        close: async () => { closeCalls += 1; },
    } as Embedding);

    await runtime.shutdown();
    await runtime.shutdown();

    assert.equal(closeCalls, 1);
});

function createSyncLifecycle(options: { watcherStartError?: Error } = {}) {
    const calls: string[] = [];
    return {
        calls,
        syncManager: {
            startBackgroundSync: () => { calls.push("start_background"); },
            stopBackgroundSync: () => { calls.push("stop_background"); },
            startWatcherMode: async () => {
                calls.push("start_watcher");
                if (options.watcherStartError) throw options.watcherStartError;
            },
            stopWatcherMode: async () => { calls.push("stop_watcher"); },
        },
    };
}

test("provider-owned embedding runtime starts background sync and watcher mode", async () => {
    const lifecycle = createSyncLifecycle();

    await startProviderSyncLifecycle(lifecycle.syncManager, {
        enabled: true,
        embeddingCapable: true,
        watcherEnabled: true,
    });

    assert.deepEqual(lifecycle.calls, ["start_background", "start_watcher"]);
});

test("provider-owned vector-only runtime does not start an embedding-dependent sync lifecycle", async () => {
    const lifecycle = createSyncLifecycle();

    await startProviderSyncLifecycle(lifecycle.syncManager, {
        enabled: true,
        embeddingCapable: false,
        watcherEnabled: true,
    });

    assert.deepEqual(lifecycle.calls, []);
});

test("provider-owned CLI runtime does not start background sync or watchers", async () => {
    const lifecycle = createSyncLifecycle();

    await startProviderSyncLifecycle(lifecycle.syncManager, {
        enabled: false,
        embeddingCapable: true,
        watcherEnabled: true,
    });

    assert.deepEqual(lifecycle.calls, []);
});

test("provider lifecycle rolls back background sync when watcher startup fails", async () => {
    const watcherStartError = new Error("watcher startup failed");
    const lifecycle = createSyncLifecycle({ watcherStartError });

    await assert.rejects(
        startProviderSyncLifecycle(lifecycle.syncManager, {
            enabled: true,
            embeddingCapable: true,
            watcherEnabled: true,
        }),
        watcherStartError,
    );
    assert.deepEqual(lifecycle.calls, [
        "start_background",
        "start_watcher",
        "stop_background",
        "stop_watcher",
    ]);
});
