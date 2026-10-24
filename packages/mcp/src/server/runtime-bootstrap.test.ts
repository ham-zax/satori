import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
    EMBEDDING_NORMALIZATION_POLICY_VERSION,
    POTION_DIMENSION,
    POTION_SEMANTIC_VERSION,
    POTION_MODEL_ID,
    envManager,
} from '@satori-code/core';
import {
    createMcpConfig,
    resolveRerankerProvider,
    resolveMcpRuntimeBootstrap,
    type ContextMcpConfig,
} from '../config.js';

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

test('implicit MILVUS_ADDRESS provider selection fails with the single fix', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'MILVUS_ADDRESS',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'EMBEDDING_MODEL',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        for (const key of keys) delete process.env[key];
        Object.assign(process.env, {
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: '/tmp/satori-removed-env',
            EMBEDDING_MODEL: 'voyage-code-3',
        });
        assert.equal(createMcpConfig().encoderModel, 'voyage-code-3');

        delete process.env.VECTOR_STORE_PROVIDER;
        process.env.MILVUS_ADDRESS = 'localhost:19530';
        assert.throws(createMcpConfig, /MILVUS_ADDRESS no longer selects Milvus; set VECTOR_STORE_PROVIDER=Milvus/);

        process.env.VECTOR_STORE_PROVIDER = 'Milvus';
        assert.equal(createMcpConfig().vectorStoreProvider, 'Milvus');
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
    const resolved = await resolveMcpRuntimeBootstrap(config());

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

test('offline config selects the shared LateOn model without machine-speed overrides', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'POTION_HELPER_PATH',
        'POTION_MODEL_PATH',
        'SATORI_RERANKER_PROVIDER',
        'SATORI_LATEON_MODEL_PATH',
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
        });

        const parsed = createMcpConfig();
        assert.equal(parsed.rerankerProvider, 'lateon');
        assert.equal(parsed.lateOnModelPath, '/opt/satori/models/lateon-code-edge');
        assert.equal(parsed.lateOnProfileId, 'lateon_offline_quality_projection_v6_d128_v1');
        assert.equal(parsed.lateOnActivationPolicy, 'lateon_context_v6_d128_owner_default_v1');
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('LateOn config selects the current profile and rejects any other profile or policy', () => {
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
        });

        delete process.env.SATORI_LATEON_PROFILE;
        const current = createMcpConfig();
        assert.equal(
            current.lateOnProfileId,
            'lateon_offline_quality_projection_v6_d128_v1',
        );
        assert.equal(current.lateOnActivationPolicy, 'lateon_context_v6_d128_owner_default_v1');

        process.env.SATORI_LATEON_PROFILE = 'lateon_offline_quality_projection_v6_d128_v1';
        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'lateon_context_v6_d128_owner_default_v1';
        assert.equal(
            createMcpConfig().lateOnActivationPolicy,
            'lateon_context_v6_d128_owner_default_v1',
        );

        // Any profile or policy other than the current one is rejected.
        process.env.SATORI_LATEON_PROFILE = 'lateon_offline_quality_projection_v4_d32_v1';
        delete process.env.SATORI_LATEON_ACTIVATION_POLICY;
        assert.throws(
            createMcpConfig,
            /Invalid SATORI_LATEON_PROFILE 'lateon_offline_quality_projection_v4_d32_v1'[\s\S]*lateon_offline_quality_projection_v6_d128_v1; reinstall is required/,
        );

        process.env.SATORI_LATEON_PROFILE = 'lateon_offline_quality_projection_v6_d128_v1';
        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'lateon_context_v4_d32_owner_default_v1';
        assert.throws(
            createMcpConfig,
            /Invalid SATORI_LATEON_ACTIVATION_POLICY 'lateon_context_v4_d32_owner_default_v1'[\s\S]*lateon_context_v6_d128_owner_default_v1; reinstall is required/,
        );

        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'untrusted_policy_v1';
        assert.throws(createMcpConfig, /Invalid SATORI_LATEON_ACTIVATION_POLICY/);
        delete process.env.SATORI_LATEON_ACTIVATION_POLICY;

        // The activation policy is LateOn-only; other providers ignore it.
        process.env.SATORI_RERANKER_PROVIDER = 'none';
        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'lateon_context_v6_d128_owner_default_v1';
        assert.equal(createMcpConfig().lateOnActivationPolicy, undefined);
        process.env.SATORI_LATEON_ACTIVATION_POLICY = 'untrusted_policy_v1';
        assert.equal(createMcpConfig().lateOnActivationPolicy, undefined);
        delete process.env.SATORI_LATEON_ACTIVATION_POLICY;
        process.env.SATORI_RERANKER_PROVIDER = 'lateon';

        process.env.SATORI_LATEON_PROFILE = 'lateon_projection_v2_d50_unknown';
        assert.throws(createMcpConfig, /Invalid SATORI_LATEON_PROFILE/);
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

test('VOYAGEAI_RERANKER_MODEL is passed through as typed; unset or blank uses the core default', () => {
    const keys = [
        'SATORI_RUNTIME_PROFILE',
        'VECTOR_STORE_PROVIDER',
        'LANCEDB_PATH',
        'EMBEDDING_PROVIDER',
        'POTION_HELPER_PATH',
        'POTION_MODEL_PATH',
        'VOYAGEAI_RERANKER_MODEL',
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
        });

        process.env.VOYAGEAI_RERANKER_MODEL = 'rerank-9-test';
        assert.equal(createMcpConfig().rankerModel, 'rerank-9-test');

        process.env.VOYAGEAI_RERANKER_MODEL = '  rerank-9-test  ';
        assert.equal(createMcpConfig().rankerModel, 'rerank-9-test');

        delete process.env.VOYAGEAI_RERANKER_MODEL;
        assert.equal(createMcpConfig().rankerModel, 'rerank-3-lite');

        process.env.VOYAGEAI_RERANKER_MODEL = '   ';
        assert.equal(createMcpConfig().rankerModel, 'rerank-3-lite');
    } finally {
        for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

const OFFLINE_VOYAGE_CONFIG_ENV_KEYS = [
    'SATORI_RUNTIME_PROFILE',
    'VECTOR_STORE_PROVIDER',
    'LANCEDB_PATH',
    'EMBEDDING_PROVIDER',
    'EMBEDDING_MODEL',
    'EMBEDDING_OUTPUT_DIMENSION',
    'POTION_HELPER_PATH',
    'POTION_MODEL_PATH',
    'SATORI_RERANKER_PROVIDER',
    'SATORI_LATEON_MODEL_PATH',
    'SATORI_LATEON_PROFILE',
    'SATORI_LATEON_ACTIVATION_POLICY',
    'VOYAGEAI_API_KEY',
    'SATORI_RERANK_APPLICATION_MODE',
] as const;

type OfflineVoyageConfigEnvKey = (typeof OFFLINE_VOYAGE_CONFIG_ENV_KEYS)[number];

function withOfflinePotionConfig(
    overrides: Partial<Record<OfflineVoyageConfigEnvKey, string>>,
    run: () => void,
): void {
    const previous = Object.fromEntries(
        OFFLINE_VOYAGE_CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    const originalGet = envManager.get;
    try {
        envManager.get = (name) => process.env[name];
        for (const key of OFFLINE_VOYAGE_CONFIG_ENV_KEYS) delete process.env[key];
        Object.assign(process.env, {
            SATORI_RUNTIME_PROFILE: 'offline',
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: '/tmp/satori-lancedb',
            EMBEDDING_PROVIDER: 'Potion',
            POTION_HELPER_PATH: '/opt/satori/potion-helper',
            POTION_MODEL_PATH: '/opt/satori/potion-model',
        }, overrides);
        run();
    } finally {
        envManager.get = originalGet;
        for (const key of OFFLINE_VOYAGE_CONFIG_ENV_KEYS) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test('offline config accepts explicitly selected Voyage reranking when the key is present', () => {
    withOfflinePotionConfig({
        SATORI_RERANKER_PROVIDER: 'voyage',
        VOYAGEAI_API_KEY: 'test-voyage-key',
    }, () => {
        const parsed = createMcpConfig();

        assert.equal(parsed.rerankerProvider, 'voyage');
        assert.equal(resolveRerankerProvider(parsed), 'voyage');
    });
});

test('offline config ignores a leftover LateOn activation policy for Voyage reranking', () => {
    withOfflinePotionConfig({
        SATORI_RERANKER_PROVIDER: 'voyage',
        VOYAGEAI_API_KEY: 'test-voyage-key',
        SATORI_LATEON_MODEL_PATH: '/opt/satori/models/lateon-code-edge',
        SATORI_LATEON_PROFILE: 'lateon_offline_quality_projection_v6_d128_v1',
        SATORI_LATEON_ACTIVATION_POLICY: 'lateon_context_v6_d128_owner_default_v1',
    }, () => {
        const parsed = createMcpConfig();

        assert.equal(parsed.rerankerProvider, 'voyage');
        assert.equal(parsed.lateOnActivationPolicy, undefined);
    });
});

test('offline config does not infer Voyage reranking from an API key', () => {
    withOfflinePotionConfig({ VOYAGEAI_API_KEY: 'test-voyage-key' }, () => {
        const parsed = createMcpConfig();

        assert.ok(parsed.rerankerProvider === 'none' || parsed.rerankerProvider === 'lateon');
        assert.notEqual(resolveRerankerProvider(parsed), 'voyage');
    });
});

test('offline config requires a Voyage API key when Voyage is explicitly selected', () => {
    withOfflinePotionConfig({ SATORI_RERANKER_PROVIDER: 'voyage' }, () => {
        assert.throws(
            createMcpConfig,
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(
                    error.message,
                    'SATORI_RERANKER_PROVIDER=voyage requires VOYAGEAI_API_KEY.',
                );
                return true;
            },
        );
    });
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
