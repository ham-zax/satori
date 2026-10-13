import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CapabilityResolver } from './capabilities.js';
import { ContextMcpConfig } from '../config.js';
import { SearchQuerySupport, type SearchQuerySupportHost } from './search-query-support.js';
import type { SearchQueryPlan } from './search-lexical-scoring.js';

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

test('capability resolver reports a cloud reranker and the cloud default limit', () => {
    const resolver = new CapabilityResolver(baseConfig());

    assert.equal(resolver.hasReranker(), true);
    assert.equal(resolver.getDefaultSearchLimit(), 20);
});

test('capability resolver reports no reranker without a Voyage key', () => {
    const resolver = new CapabilityResolver(baseConfig({ voyageKey: undefined }));

    assert.equal(resolver.hasReranker(), false);
});

test('local embeddings keep the smaller default limit and still use the resolved reranker', () => {
    const resolver = new CapabilityResolver(baseConfig({
        encoderProvider: 'Potion',
        voyageKey: 'voyage-key'
    }));

    assert.equal(resolver.getEmbeddingLocality(), 'local');
    assert.equal(resolver.hasReranker(), true);
    assert.equal(resolver.getDefaultSearchLimit(), 10);
});

test('offline policy disables cloud reranking even when credentials remain configured', () => {
    const resolver = new CapabilityResolver(baseConfig({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        encoderProvider: 'Potion',
        encoderModel: 'pinned-potion',
        voyageKey: 'retained-cloud-key',
    }));

    assert.equal(resolver.hasReranker(), false);
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

test('a search reranks when Voyage is explicitly selected with Potion embeddings', () => {
    const capabilities = new CapabilityResolver(baseConfig({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        encoderProvider: 'Potion',
        encoderModel: 'pinned-potion',
        rerankerProvider: 'voyage',
        voyageKey: 'explicit-voyage-key',
    }));
    const support = new SearchQuerySupport({ capabilities, reranker: {} } as unknown as SearchQuerySupportHost);

    const decision = support.resolveRerankDecision(
        'runtime',
        { rerankAllowed: true, exactMatchPinningEnabled: false } as unknown as SearchQueryPlan,
    );

    assert.equal(decision.enabled, true);
});

test('Potion is a local embedding capability without cloud reranking', () => {
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

    assert.equal(resolver.hasReranker(), true);
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
