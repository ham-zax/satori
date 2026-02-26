import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCodebaseTool } from './search_codebase.js';
import { CapabilityResolver } from '../core/capabilities.js';
import { ContextMcpConfig } from '../config.js';
import { ToolContext } from './types.js';

function buildConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: 'test',
        version: '1.0.0',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        encoderOutputDimension: 1024,
        voyageKey: 'voyage-key',
        milvusEndpoint: 'https://example.zilliz.com',
        milvusApiToken: 'token',
        rankerModel: 'rerank-2.5',
        ...overrides,
    };
}

function captureTelemetry(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (chunk: any, ...args: any[]) => {
        const text = String(chunk);
        if (text.includes('[TELEMETRY]')) {
            lines.push(text.trim());
        }
        return originalWrite(chunk, ...args);
    };

    return run().finally(() => {
        (process.stderr.write as any) = originalWrite;
    }).then(() => lines);
}

test('search_codebase emits telemetry with diagnostics from handler meta', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'ok',
                        path: '/repo',
                        query: 'auth',
                        scope: 'runtime',
                        groupBy: 'symbol',
                        resultMode: 'grouped',
                        limit: 10,
                        freshnessDecision: { mode: 'skipped_recent' },
                        results: [{ kind: 'group', groupId: 'sym_auth', file: 'src/auth.ts' }]
                    })
                }],
                meta: {
                    searchDiagnostics: {
                        resultsBeforeFilter: 5,
                        resultsAfterFilter: 1,
                        excludedByIgnore: 4,
                        freshnessMode: 'skipped_recent'
                    }
                }
            })
        }
    } as unknown as ToolContext;

    const telemetry = await captureTelemetry(async () => {
        const response = await searchCodebaseTool.execute({
            path: '/repo',
            query: 'auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10,
            debug: false
        }, ctx);

        assert.equal(response.isError, undefined);
    });

    assert.equal(telemetry.length, 1);
    const payload = JSON.parse(telemetry[0].replace(/^\[TELEMETRY\]\s*/, ''));
    assert.equal(payload.event, 'search_executed');
    assert.equal(payload.reranker_attempted, false);
    assert.equal(payload.reranker_used, false);
    assert.equal(payload.results_before_filter, 5);
    assert.equal(payload.results_after_filter, 1);
    assert.equal(payload.results_returned, 1);
    assert.equal(payload.excluded_by_ignore, 4);
    assert.equal(payload.freshness_mode, 'skipped_recent');
});

test('search_codebase telemetry reports reranker_used when handler diagnostics indicate rerank applied', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'ok',
                        path: '/repo',
                        query: 'auth',
                        scope: 'runtime',
                        groupBy: 'symbol',
                        resultMode: 'grouped',
                        limit: 10,
                        freshnessDecision: { mode: 'skipped_recent' },
                        results: [{ kind: 'group', groupId: 'sym_auth', file: 'src/auth.ts' }]
                    })
                }],
                meta: {
                    searchDiagnostics: {
                        resultsBeforeFilter: 3,
                        resultsAfterFilter: 1,
                        excludedByIgnore: 2,
                        freshnessMode: 'skipped_recent',
                        rerankerAttempted: true,
                        rerankerUsed: true
                    }
                }
            })
        }
    } as unknown as ToolContext;

    const telemetry = await captureTelemetry(async () => {
        const response = await searchCodebaseTool.execute({
            path: '/repo',
            query: 'auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        }, ctx);

        assert.equal(response.isError, undefined);
    });

    assert.equal(telemetry.length, 1);
    const payload = JSON.parse(telemetry[0].replace(/^\[TELEMETRY\]\s*/, ''));
    assert.equal(payload.reranker_attempted, true);
    assert.equal(payload.reranker_used, true);
});

test('search_codebase falls back to parsed JSON response for telemetry diagnostics', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'ok',
                        path: '/repo',
                        query: 'token',
                        scope: 'docs',
                        groupBy: 'file',
                        resultMode: 'raw',
                        limit: 20,
                        freshnessDecision: { mode: 'synced' },
                        results: [
                            { kind: 'chunk', file: 'docs/auth.md' },
                            { kind: 'chunk', file: 'docs/token.md' }
                        ]
                    })
                }]
            })
        }
    } as unknown as ToolContext;

    const telemetry = await captureTelemetry(async () => {
        const response = await searchCodebaseTool.execute({
            path: '/repo',
            query: 'token',
            scope: 'docs',
            resultMode: 'raw',
            groupBy: 'file',
            limit: 20,
            debug: true
        }, ctx);

        assert.equal(response.isError, undefined);
    });

    assert.equal(telemetry.length, 1);
    const payload = JSON.parse(telemetry[0].replace(/^\[TELEMETRY\]\s*/, ''));
    assert.equal(payload.results_before_filter, 2);
    assert.equal(payload.results_after_filter, 2);
    assert.equal(payload.results_returned, 2);
    assert.equal(payload.freshness_mode, 'synced');
});

test('search_codebase returns validation error for invalid arguments', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{ type: 'text', text: 'should not run' }]
            })
        }
    } as unknown as ToolContext;

    const response = await searchCodebaseTool.execute({
        path: '/repo',
        query: '',
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Invalid arguments for 'search_codebase'/);
});
