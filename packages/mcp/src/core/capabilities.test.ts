import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityResolver } from './capabilities.js';
import { ContextMcpConfig } from '../config.js';

function baseConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: 'test',
        version: '1.0.0',
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
});
