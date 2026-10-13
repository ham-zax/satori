import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CapabilityResolver } from './capabilities.js';
import { ContextMcpConfig } from '../config.js';

function baseConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: 'test',
        version: '1.0.0',
        stateRoot: path.join(os.tmpdir(), 'satori-test-state-root'),
        executionProfile: 'connected',
        networkPolicy: { kind: 'remote-allowed' },
        vectorStoreProvider: 'Milvus',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        encoderOutputDimension: 1024,
        milvusEndpoint: 'https://example.zilliz.com',
        milvusApiToken: 'token',
        voyageKey: 'voyage-key',
        rankerModel: 'rerank-2.5',
        ...overrides,
    };
}

test('capability resolver enables default rerank on fast profile with reranker capability', () => {
    const resolver = new CapabilityResolver(baseConfig());

    assert.equal(resolver.hasReranker(), true);
    assert.equal(resolver.getPerformanceProfile(), 'fast');
    assert.equal(resolver.getDefaultRerankEnabled(), true);
    assert.equal(resolver.getDefaultSearchLimit(), 20);
});

test('capability resolver disables default rerank when reranker capability is missing', () => {
    const resolver = new CapabilityResolver(baseConfig({ voyageKey: undefined }));

    assert.equal(resolver.hasReranker(), false);
    assert.equal(resolver.getDefaultRerankEnabled(), false);
});

test('capability resolver disables default rerank on slow profile', () => {
    const resolver = new CapabilityResolver(baseConfig({
        encoderProvider: 'Ollama',
        voyageKey: 'voyage-key'
    }));

    assert.equal(resolver.getPerformanceProfile(), 'slow');
    assert.equal(resolver.getDefaultRerankEnabled(), false);
    assert.equal(resolver.getDefaultSearchLimit(), 10);
});

test('offline policy disables cloud reranking even when credentials remain configured', () => {
    const resolver = new CapabilityResolver(baseConfig({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        encoderProvider: 'Ollama',
        encoderModel: 'nomic-embed-text',
        voyageKey: 'retained-cloud-key',
    }));

    assert.equal(resolver.hasReranker(), false);
    assert.equal(resolver.getDefaultRerankEnabled(), false);
});

test('capability resolver recognizes explicit Voyage reranking under local-only policy', () => {
    const resolver = new CapabilityResolver(baseConfig({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        encoderProvider: 'Potion',
        encoderModel: 'pinned-potion',
        rerankerProvider: 'voyage',
        voyageKey: 'explicit-voyage-key',
    }));

    assert.equal(resolver.hasReranker(), true);
});

test('Potion is a slow local embedding capability without cloud reranking', () => {
    const resolver = new CapabilityResolver(baseConfig({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        encoderProvider: 'Potion',
        encoderModel: 'pinned-potion',
        voyageKey: 'retained-cloud-key',
    }));

    assert.equal(resolver.getEmbeddingLocality(), 'local');
    assert.equal(resolver.getPerformanceProfile(), 'slow');
    assert.equal(resolver.hasReranker(), false);
    assert.equal(resolver.getMaxSearchResultTotal(), Number.MAX_SAFE_INTEGER);
    assert.equal(resolver.getMaxFrozenSearchResults(), 200);
    assert.equal(resolver.getMaxSearchPageSize(), 200);
    assert.equal(resolver.getMaxSearchLimit(), Number.MAX_SAFE_INTEGER);
});

test('qualified LateOn enables local reranking without cloud credentials', () => {
    const resolver = new CapabilityResolver(baseConfig({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        encoderProvider: 'Potion',
        encoderModel: 'pinned-potion',
        voyageKey: undefined,
        rerankerProvider: 'lateon',
        lateOnModelPath: '/opt/satori/models/lateon-code-edge',
    }));

    assert.equal(resolver.getPerformanceProfile(), 'slow');
    assert.equal(resolver.hasReranker(), true);
    assert.equal(resolver.getDefaultRerankEnabled(), true);
});

test('capability resolver does not treat token-only Milvus config as vector-ready', () => {
    const resolver = new CapabilityResolver(baseConfig({
        milvusEndpoint: undefined,
        milvusApiToken: 'token-only',
    }));

    assert.equal(resolver.hasVectorStore(), false);
});

test('capability resolver treats a resolved LanceDB path as vector-ready without Milvus', () => {
    const resolver = new CapabilityResolver(baseConfig({
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        milvusEndpoint: undefined,
        milvusApiToken: undefined,
    }));

    assert.equal(resolver.hasVectorStore(), true);
});
