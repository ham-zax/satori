import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
    EMBEDDING_NORMALIZATION_POLICY_VERSION,
    POTION_DIMENSION,
    POTION_SEMANTIC_VERSION,
    POTION_MODEL_ID,
} from '@zokizuan/satori-core';
import {
    createMcpConfig,
    indexFingerprintsEqual,
    parseIndexFingerprint,
    resolveMcpRuntimeBootstrap,
    type ContextMcpConfig,
} from '../config.js';

const DIGEST = 'a'.repeat(64);

test('offline static config preserves the installer-resolved Ollama dimension', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'OLLAMA_MODEL',
        'OLLAMA_MODEL_DIGEST',
        'OLLAMA_HOST',
        'EMBEDDING_OUTPUT_DIMENSION',
    ] as const;
    const backup = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        process.env.SATORI_RUNTIME_PROFILE = 'offline';
        process.env.VECTOR_STORE_PROVIDER = 'LanceDB';
        process.env.LANCEDB_PATH = '/opt/satori/lancedb';
        process.env.EMBEDDING_PROVIDER = 'Ollama';
        process.env.OLLAMA_MODEL = 'nomic-embed-text';
        process.env.OLLAMA_MODEL_DIGEST = 'a'.repeat(64);
        process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
        process.env.EMBEDDING_OUTPUT_DIMENSION = '768';

        const parsed = createMcpConfig();
        assert.equal(parsed.encoderProvider, 'Ollama');
        assert.equal(parsed.encoderOutputDimension, 768);
    } finally {
        for (const key of keys) {
            if (backup[key] === undefined) delete process.env[key];
            else process.env[key] = backup[key];
        }
    }
});

test('Potion static config defaults EMBEDDING_OUTPUT_DIMENSION to 256', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'POTION_HELPER_PATH',
        'POTION_MODEL_PATH',
        'EMBEDDING_OUTPUT_DIMENSION',
    ] as const;
    const backup = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        process.env.SATORI_RUNTIME_PROFILE = 'offline';
        process.env.VECTOR_STORE_PROVIDER = 'LanceDB';
        process.env.LANCEDB_PATH = '/opt/satori/lancedb';
        process.env.EMBEDDING_PROVIDER = 'Potion';
        process.env.POTION_HELPER_PATH = '/opt/satori/potion-helper';
        process.env.POTION_MODEL_PATH = '/opt/satori/potion-model';

        const parsed = createMcpConfig();
        assert.equal(parsed.encoderProvider, 'Potion');
        assert.equal(parsed.encoderModel, POTION_MODEL_ID);
        assert.equal(parsed.encoderOutputDimension, POTION_DIMENSION);
    } finally {
        for (const key of keys) {
            if (backup[key] === undefined) delete process.env[key];
            else process.env[key] = backup[key];
        }
    }
});

test('offline bootstrap preserves recorded Ollama dimension', async () => {
    const recorded = config({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        encoderProvider: 'Ollama',
        encoderModel: 'nomic-embed-text',
        ollamaEncoderModel: 'nomic-embed-text',
        ollamaModelDigest: DIGEST,
        ollamaEndpoint: 'http://127.0.0.1:11434',
        encoderOutputDimension: 768,
    });

    const resolved = await resolveMcpRuntimeBootstrap(recorded, {
        resolveOllamaIdentity: async () => Object.freeze({
            configuredModel: 'nomic-embed-text',
            resolvedModel: 'nomic-embed-text:latest',
            artifactDigest: DIGEST,
            artifactSize: 42,
            dimension: 768,
        }),
    });

    assert.equal(resolved.runtimeFingerprint.embeddingDimension, 768);
    assert.equal(resolved.runtimeFingerprint.embeddingModel, 'nomic-embed-text:latest');
    assert.equal(resolved.runtimeFingerprint.embeddingArtifactDigest, DIGEST);
    assert.equal(
        resolved.runtimeFingerprint.embeddingNormalizationPolicy,
        EMBEDDING_NORMALIZATION_POLICY_VERSION,
    );
});

test('retired reranker application mode fails clearly before MCP configuration is built', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'SATORI_RERANK_APPLICATION_MODE',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, {
            SATORI_RUNTIME_PROFILE: 'offline',
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: '/tmp/satori-rerank-mode',
            EMBEDDING_PROVIDER: 'Potion',
            POTION_HELPER_PATH: '/opt/satori/potion-helper',
            POTION_MODEL_PATH: '/opt/satori/potion-model',
            SATORI_RERANK_APPLICATION_MODE: 'legacy_rrf',
        });
        assert.throws(
            () => createMcpConfig(),
            /SATORI_RERANK_APPLICATION_MODE has been removed/,
        );
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

function config(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: 'test',
        version: '1.0.0',
        stateRoot: path.join(os.tmpdir(), 'satori-test-state-root'),
        executionProfile: 'connected',
        networkPolicy: { kind: 'remote-allowed' },
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-code-3',
        encoderOutputDimension: 1024,
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        ...overrides,
    };
}

test('connected cloud bootstrap resolves without local model I/O', async () => {
    let identityCalls = 0;
    const resolved = await resolveMcpRuntimeBootstrap(config(), {
        async resolveOllamaIdentity() {
            identityCalls += 1;
            throw new Error('must not run');
        },
    });

    assert.equal(identityCalls, 0);
    assert.equal(resolved.runtimeFingerprint.embeddingArtifactDigest, null);
    assert.equal(
        resolved.runtimeFingerprint.embeddingNormalizationPolicy,
        EMBEDDING_NORMALIZATION_POLICY_VERSION,
    );
});

test('Potion bootstrap seals the frozen L1 inference identity', async () => {
    const resolved = await resolveMcpRuntimeBootstrap(config({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        encoderProvider: 'Potion',
        encoderModel: POTION_MODEL_ID,
        encoderOutputDimension: POTION_DIMENSION,
        potionHelperPath: '/opt/satori/potion-helper',
        potionModelPath: '/opt/satori/potion-model',
    }));

    assert.equal(resolved.config.embeddingArtifactDigest, undefined);
    assert.equal(resolved.runtimeFingerprint.embeddingProvider, 'Potion');
    assert.equal(
        resolved.runtimeFingerprint.embeddingModel,
        `${POTION_MODEL_ID}+${POTION_SEMANTIC_VERSION}`,
    );
    assert.equal(resolved.runtimeFingerprint.embeddingDimension, POTION_DIMENSION);
    assert.equal(resolved.runtimeFingerprint.embeddingArtifactDigest, null);
    assert.deepEqual(
        parseIndexFingerprint(resolved.runtimeFingerprint),
        resolved.runtimeFingerprint,
    );
    assert.equal(indexFingerprintsEqual({
        ...resolved.runtimeFingerprint,
        embeddingArtifactDigest: 'b'.repeat(64),
    }, resolved.runtimeFingerprint), false);
});

test('Potion is selected only through explicit offline configuration', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'EMBEDDING_MODEL',
        'EMBEDDING_OUTPUT_DIMENSION',
        'POTION_HELPER_PATH',
        'POTION_MODEL_PATH',
        'POTION_REQUEST_TIMEOUT_MS',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, {
            SATORI_RUNTIME_PROFILE: 'offline',
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: '/tmp/satori-potion-experimental',
            EMBEDDING_PROVIDER: 'Potion',
            POTION_HELPER_PATH: '/opt/satori/potion-helper',
            POTION_MODEL_PATH: '/opt/satori/potion-model',
            POTION_REQUEST_TIMEOUT_MS: '7000',
        });

        const parsed = createMcpConfig();
        assert.equal(parsed.encoderProvider, 'Potion');
        assert.equal(parsed.encoderModel, POTION_MODEL_ID);
        assert.equal(parsed.encoderOutputDimension, POTION_DIMENSION);
        assert.equal(parsed.potionHelperPath, '/opt/satori/potion-helper');
        assert.equal(parsed.potionModelPath, '/opt/satori/potion-model');
        assert.equal(parsed.potionRequestTimeoutMs, 7000);
        process.env.POTION_REQUEST_TIMEOUT_MS = '300001';
        assert.throws(createMcpConfig, /must be between 1 and 300000/);
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('offline config selects a shared LateOn model with operator overrides', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'POTION_HELPER_PATH',
        'POTION_MODEL_PATH',
        'SATORI_RERANKER_PROVIDER',
        'SATORI_LATEON_MODEL_PATH',
        'SATORI_LATEON_REQUEST_DEADLINE_MS',
        'SATORI_LATEON_INTRA_OP_THREADS',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, {
            SATORI_RUNTIME_PROFILE: 'offline',
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: '/tmp/satori-lancedb',
            EMBEDDING_PROVIDER: 'Potion',
            POTION_HELPER_PATH: '/opt/satori/potion-helper',
            POTION_MODEL_PATH: '/opt/satori/potion-model',
            SATORI_RERANKER_PROVIDER: 'lateon',
            SATORI_LATEON_MODEL_PATH: '/opt/satori/models/lateon-code-edge',
            SATORI_LATEON_REQUEST_DEADLINE_MS: '3500',
            SATORI_LATEON_INTRA_OP_THREADS: '2',
        });

        const parsed = createMcpConfig();
        assert.equal(parsed.rerankerProvider, 'lateon');
        assert.equal(parsed.lateOnModelPath, '/opt/satori/models/lateon-code-edge');
        assert.equal(parsed.lateOnRequestDeadlineMs, 3500);
        assert.equal(parsed.lateOnIntraOpThreads, 2);
        assert.equal(parsed.lateOnProfileId, 'lateon_offline_quality_projection_v4_d32_v1');
        assert.equal(parsed.lateOnActivationPolicy, 'lateon_context_v4_d32_owner_default_v1');
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('LateOn config selects explicit D16 or D32 profiles with bounded operational overrides', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'POTION_HELPER_PATH',
        'POTION_MODEL_PATH',
        'SATORI_RERANKER_PROVIDER',
        'SATORI_LATEON_MODEL_PATH',
        'SATORI_LATEON_PROFILE',
        'SATORI_LATEON_ACTIVATION_POLICY',
        'SATORI_LATEON_REQUEST_DEADLINE_MS',
        'SATORI_LATEON_MAX_QUEUE_WAIT_MS',
        'SATORI_LATEON_RERANKER_STAGE_DEADLINE_MS',
        'SATORI_LATEON_MAX_ACTIVE_RERANKS',
        'SATORI_LATEON_MAX_QUEUED_RERANKS',
        'SATORI_LATEON_INTRA_OP_THREADS',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, {
            SATORI_RUNTIME_PROFILE: 'offline',
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: '/tmp/satori-lancedb',
            EMBEDDING_PROVIDER: 'Potion',
            POTION_HELPER_PATH: '/opt/satori/potion-helper',
            POTION_MODEL_PATH: '/opt/satori/potion-model',
            SATORI_RERANKER_PROVIDER: 'lateon',
            SATORI_LATEON_MODEL_PATH: '/opt/satori/models/lateon-code-edge',
            SATORI_LATEON_REQUEST_DEADLINE_MS: '1800',
            SATORI_LATEON_MAX_QUEUE_WAIT_MS: '200',
            SATORI_LATEON_RERANKER_STAGE_DEADLINE_MS: '2200',
            SATORI_LATEON_MAX_ACTIVE_RERANKS: '1',
            SATORI_LATEON_MAX_QUEUED_RERANKS: '0',
            SATORI_LATEON_INTRA_OP_THREADS: '1',
        });

        delete process.env.SATORI_LATEON_PROFILE;
        const current = createMcpConfig();
        assert.equal(
            current.lateOnProfileId,
            'lateon_offline_quality_projection_v4_d32_v1',
        );
        assert.equal(current.lateOnActivationPolicy, 'lateon_context_v4_d32_owner_default_v1');
        assert.equal(current.lateOnRequestDeadlineMs, 1800);
        assert.equal(current.lateOnMaximumQueueWaitMs, 200);
        assert.equal(current.lateOnRerankerStageDeadlineMs, 2200);
        assert.equal(current.lateOnMaximumActiveReranks, 1);
        assert.equal(current.lateOnMaximumQueuedReranks, 0);
        assert.equal(current.lateOnIntraOpThreads, 1);

        process.env.SATORI_LATEON_PROFILE = 'lateon_offline_quality_projection_v4_d32_v1';
        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'lateon_context_v4_d32_owner_default_v1';
        assert.equal(
            createMcpConfig().lateOnActivationPolicy,
            'lateon_context_v4_d32_owner_default_v1',
        );

        // Phase 9.1 — retired profiles are recognized but never execute.
        for (const retiredProfile of [
            'lateon_projection_v1_d16_legacy',
            'lateon_projection_v2_d16_v1',
            'lateon_offline_quality_projection_v2_d32_v2',
            'lateon_offline_quality_projection_v3_d32_v1',
            'lateon_offline_quality_projection_v3_d32_v2',
        ]) {
            process.env.SATORI_LATEON_PROFILE = retiredProfile;
            process.env.SATORI_LATEON_ACTIVATION_POLICY = undefined;
            delete process.env.SATORI_LATEON_ACTIVATION_POLICY;
            assert.throws(
                createMcpConfig,
                new RegExp(
                    `Unsupported SATORI_LATEON_PROFILE '${retiredProfile}'[\\s\\S]*satori upgrade[\\s\\S]*lateon_offline_quality_projection_v4_d32_v1`,
                ),
            );
        }

        // Retired activation policies are recognized but never execute.
        process.env.SATORI_LATEON_PROFILE = 'lateon_offline_quality_projection_v4_d32_v1';
        for (const retiredPolicy of [
            'lateon_d32_owner_default_v1',
            'lateon_context_v3_d32_owner_default_v1',
        ]) {
            process.env.SATORI_LATEON_ACTIVATION_POLICY = retiredPolicy;
            assert.throws(
                createMcpConfig,
                new RegExp(
                    `Unsupported SATORI_LATEON_ACTIVATION_POLICY '${retiredPolicy}'[\\s\\S]*satori upgrade[\\s\\S]*lateon_context_v4_d32_owner_default_v1`,
                ),
            );
        }

        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'untrusted_policy_v1';
        assert.throws(createMcpConfig, /Invalid SATORI_LATEON_ACTIVATION_POLICY/);
        delete process.env.SATORI_LATEON_ACTIVATION_POLICY;

        process.env.SATORI_RERANKER_PROVIDER = 'none';
        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'lateon_context_v4_d32_owner_default_v1';
        assert.throws(
            createMcpConfig,
            /SATORI_LATEON_ACTIVATION_POLICY requires SATORI_RERANKER_PROVIDER=lateon; received none/,
        );
        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'untrusted_policy_v1';
        assert.throws(createMcpConfig, /Invalid SATORI_LATEON_ACTIVATION_POLICY/);
        delete process.env.SATORI_LATEON_ACTIVATION_POLICY;
        process.env.SATORI_RERANKER_PROVIDER = 'lateon';

        process.env.SATORI_LATEON_PROFILE = 'lateon_projection_v2_d50_unknown';
        assert.throws(createMcpConfig, /Invalid SATORI_LATEON_PROFILE/);
        process.env.SATORI_LATEON_PROFILE = 'lateon_offline_quality_projection_v4_d32_v1';
        process.env.SATORI_LATEON_MAX_ACTIVE_RERANKS = '2';
        assert.throws(createMcpConfig, /must be 0 or 1/);
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('LateOn config fails closed for a missing or relative shared model path', () => {
    const keys = [
        'SATORI_RERANKER_PROVIDER',
        'SATORI_LATEON_MODEL_PATH',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        process.env.SATORI_RERANKER_PROVIDER = 'lateon';
        delete process.env.SATORI_LATEON_MODEL_PATH;
        assert.throws(createMcpConfig, /requires SATORI_LATEON_MODEL_PATH/);
        process.env.SATORI_LATEON_MODEL_PATH = 'relative/model';
        assert.throws(createMcpConfig, /must be absolute/);
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('Potion bootstrap rejects invalid model identity or dimension', async () => {
    await assert.rejects(
        resolveMcpRuntimeBootstrap(config({
            executionProfile: 'offline',
            networkPolicy: { kind: 'local-only' },
            encoderProvider: 'Potion',
            encoderModel: 'untrusted-potion-model',
            encoderOutputDimension: POTION_DIMENSION,
        })),
        /pinned model identity/,
    );
    await assert.rejects(
        resolveMcpRuntimeBootstrap(config({
            executionProfile: 'offline',
            networkPolicy: { kind: 'local-only' },
            encoderProvider: 'Potion',
            encoderModel: POTION_MODEL_ID,
            encoderOutputDimension: 512,
        })),
        /EMBEDDING_OUTPUT_DIMENSION=256/,
    );
});

test('offline bootstrap resolves model digest and dimension before fingerprinting', async () => {
    const resolved = await resolveMcpRuntimeBootstrap(config({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        encoderProvider: 'Ollama',
        encoderModel: 'nomic-embed-text',
        ollamaEncoderModel: 'nomic-embed-text',
        ollamaModelDigest: DIGEST,
        ollamaEndpoint: 'http://127.0.0.1:11434',
    }), {
        async resolveOllamaIdentity(input) {
            assert.deepEqual(input, {
                model: 'nomic-embed-text',
                host: 'http://127.0.0.1:11434',
            });
            return {
                configuredModel: 'nomic-embed-text',
                resolvedModel: 'nomic-embed-text:latest',
                artifactDigest: DIGEST,
                artifactSize: 100,
                dimension: 768,
            };
        },
    });

    assert.equal(resolved.config.encoderModel, 'nomic-embed-text:latest');
    assert.equal(resolved.config.encoderOutputDimension, 768);
    assert.equal(resolved.runtimeFingerprint.embeddingModel, 'nomic-embed-text:latest');
    assert.equal(resolved.runtimeFingerprint.embeddingArtifactDigest, DIGEST);
    assert.equal(resolved.runtimeFingerprint.embeddingDimension, 768);
});

test('offline postflight bootstrap uses the preflight-recorded identity without provider calls', async () => {
    let identityCalls = 0;
    const resolved = await resolveMcpRuntimeBootstrap(config({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        encoderProvider: 'Ollama',
        encoderModel: 'nomic-embed-text:latest',
        encoderOutputDimension: 768,
        ollamaEncoderModel: 'nomic-embed-text:latest',
        ollamaModelDigest: DIGEST,
        ollamaEndpoint: 'http://127.0.0.1:11434',
    }), {
        async resolveOllamaIdentity() {
            identityCalls += 1;
            throw new Error('postflight must not call Ollama');
        },
    }, { useRecordedOllamaIdentity: true });

    assert.equal(identityCalls, 0);
    assert.equal(resolved.runtimeFingerprint.embeddingModel, 'nomic-embed-text:latest');
    assert.equal(resolved.runtimeFingerprint.embeddingDimension, 768);
    assert.equal(resolved.runtimeFingerprint.embeddingArtifactDigest, DIGEST);
});

test('offline bootstrap rejects remote endpoints before model resolution', async () => {
    let identityCalls = 0;
    await assert.rejects(
        resolveMcpRuntimeBootstrap(config({
            executionProfile: 'offline',
            networkPolicy: { kind: 'local-only' },
            encoderProvider: 'Ollama',
            encoderModel: 'nomic-embed-text',
            ollamaModelDigest: DIGEST,
            ollamaEndpoint: 'https://ollama.example.com',
        }), {
            async resolveOllamaIdentity() {
                identityCalls += 1;
                throw new Error('must not run');
            },
        }),
        /loopback HTTP\(S\) endpoint/,
    );
    assert.equal(identityCalls, 0);
});

test('offline bootstrap rejects missing or changed installer-recorded digests', async () => {
    const offline = config({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        encoderProvider: 'Ollama',
        encoderModel: 'nomic-embed-text',
        ollamaEndpoint: 'http://localhost:11434',
    });

    await assert.rejects(
        resolveMcpRuntimeBootstrap(offline),
        /requires installer-recorded OLLAMA_MODEL_DIGEST/,
    );

    await assert.rejects(
        resolveMcpRuntimeBootstrap({ ...offline, ollamaModelDigest: 'b'.repeat(64) }, {
            async resolveOllamaIdentity() {
                return {
                    configuredModel: 'nomic-embed-text',
                    resolvedModel: 'nomic-embed-text:latest',
                    artifactDigest: DIGEST,
                    artifactSize: 100,
                    dimension: 768,
                };
            },
        }),
        /does not match the installed artifact/,
    );
});

test('offline bootstrap accepts a canonical sha256-prefixed recorded digest', async () => {
    const digest = 'a'.repeat(64);
    const result = await resolveMcpRuntimeBootstrap(config({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        encoderProvider: 'Ollama',
        encoderModel: 'nomic-embed-text',
        ollamaEncoderModel: 'nomic-embed-text',
        ollamaModelDigest: `sha256:${digest}`,
        ollamaEndpoint: 'http://127.0.0.1:11434',
    }), {
        resolveOllamaIdentity: async () => Object.freeze({
            configuredModel: 'nomic-embed-text',
            resolvedModel: 'nomic-embed-text:latest',
            artifactDigest: digest,
            artifactSize: 42,
            dimension: 768,
        }),
    });

    assert.equal(result.runtimeFingerprint.embeddingArtifactDigest, digest);
});
