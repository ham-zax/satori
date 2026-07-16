import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityResolver } from "../core/capabilities.js";
import { CallGraphSidecarManager } from "../core/call-graph.js";
import { SnapshotManager } from "../core/snapshot.js";
import { buildRuntimeIndexFingerprint, ContextMcpConfig } from "../config.js";
import type { ToolContext } from "../tools/types.js";
import {
    createLocalOnlyContext,
    ProviderRuntime,
    resolveConfiguredEmbeddingDimension,
    startProviderSyncLifecycle,
} from "./provider-runtime.js";
import {
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
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-4-large",
        encoderOutputDimension: 1024,
        readFileMaxLines: 1000,
        watchSyncEnabled: false,
        watchDebounceMs: 5000,
        ...overrides,
    };
}

function createRuntime(config: ContextMcpConfig): ProviderRuntime {
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
    });
}

test("embedding/vector operations require provider key and MILVUS_ADDRESS", () => {
    const cases: Array<{ config: ContextMcpConfig; expected: string[] }> = [
        { config: baseConfig({ encoderProvider: "VoyageAI", voyageKey: undefined }), expected: ["VOYAGEAI_API_KEY", "MILVUS_ADDRESS"] },
        { config: baseConfig({ encoderProvider: "OpenAI", encoderModel: "text-embedding-3-small", openaiKey: undefined }), expected: ["OPENAI_API_KEY", "MILVUS_ADDRESS"] },
        { config: baseConfig({ encoderProvider: "Gemini", encoderModel: "gemini-embedding-001", geminiKey: undefined }), expected: ["GEMINI_API_KEY", "MILVUS_ADDRESS"] },
        { config: baseConfig({ encoderProvider: "Ollama", encoderModel: "nomic-embed-text" }), expected: ["MILVUS_ADDRESS"] },
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

test("vector-only context preserves the configured embedding model fingerprint", () => {
    const config = baseConfig({
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-code-3",
    });
    const context = createLocalOnlyContext(config);
    const fingerprint = (
        context as unknown as {
            buildIndexCompletionFingerprint(): { embeddingModel: string };
        }
    ).buildIndexCompletionFingerprint();

    assert.equal(fingerprint.embeddingModel, "voyage-code-3");
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
