import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBEDDING_NORMALIZATION_POLICY_VERSION } from '@zokizuan/satori-core';
import {
    createMcpConfig,
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
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        Object.assign(process.env, {
            SATORI_RUNTIME_PROFILE: 'offline',
            VECTOR_STORE_PROVIDER: 'LanceDB',
            LANCEDB_PATH: '/tmp/satori-lancedb',
            EMBEDDING_PROVIDER: 'Ollama',
            OLLAMA_MODEL: 'nomic-embed-text:latest',
            OLLAMA_MODEL_DIGEST: DIGEST,
            OLLAMA_HOST: 'http://127.0.0.1:11434',
            EMBEDDING_OUTPUT_DIMENSION: '768',
        });
        assert.equal(createMcpConfig().encoderOutputDimension, 768);
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
