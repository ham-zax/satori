import assert from 'node:assert/strict';
import test from 'node:test';
import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb.js';
import { MilvusVectorDatabase } from './milvus-vectordb.js';

test('Milvus gRPC sparse search sends one BM25 request without dense data', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const target = {
        ensureInitialized: async () => undefined,
        ensureLoaded: async () => undefined,
        client: {
            search: async (request: Record<string, unknown>) => {
                calls.push(request);
                return {
                    results: [{
                        id: 'chunk-1',
                        content: 'SOURCE_CHECKPOINT_MISSING',
                        relativePath: 'src/checkpoint.ts',
                        startLine: 3,
                        endLine: 3,
                        fileExtension: '.ts',
                        metadata: '{"language":"typescript"}',
                        score: 0.91,
                    }],
                };
            },
        },
    };

    const results = await MilvusVectorDatabase.prototype.sparseSearch.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
        'SOURCE_CHECKPOINT_MISSING',
        { topK: 7, dropRatioSearch: 0.15, filterExpr: 'fileExtension != ".satori_meta"' },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
        collection_name: 'collection-v1',
        data: ['SOURCE_CHECKPOINT_MISSING'],
        anns_field: 'sparse_vector',
        limit: 7,
        metric_type: 'BM25',
        params: { drop_ratio_search: 0.15 },
        output_fields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
        expr: 'fileExtension != ".satori_meta"',
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.document.relativePath, 'src/checkpoint.ts');
    assert.equal(results[0]?.score, 0.91);
});

test('Milvus REST sparse search sends one BM25 request through the search endpoint', async () => {
    const calls: Array<{ endpoint: string; method: string; body: Record<string, unknown> }> = [];
    const target = {
        ensureInitialized: async () => undefined,
        ensureLoaded: async () => undefined,
        config: { database: 'default' },
        makeRequest: async (endpoint: string, method: string, body: Record<string, unknown>) => {
            calls.push({ endpoint, method, body });
            return {
                code: 0,
                data: [{
                    id: 'chunk-1',
                    content: 'SOURCE_CHECKPOINT_MISSING',
                    relativePath: 'src/checkpoint.ts',
                    startLine: 3,
                    endLine: 3,
                    fileExtension: '.ts',
                    metadata: '{"language":"typescript"}',
                    distance: 0.91,
                }],
            };
        },
    };

    const results = await MilvusRestfulVectorDatabase.prototype.sparseSearch.call(
        target as unknown as MilvusRestfulVectorDatabase,
        'collection-v1',
        'SOURCE_CHECKPOINT_MISSING',
        { topK: 7, dropRatioSearch: 0.15, filterExpr: 'fileExtension != ".satori_meta"' },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endpoint, '/entities/search');
    assert.equal(calls[0]?.method, 'POST');
    assert.deepEqual(calls[0]?.body, {
        collectionName: 'collection-v1',
        dbName: 'default',
        data: ['SOURCE_CHECKPOINT_MISSING'],
        annsField: 'sparse_vector',
        limit: 7,
        outputFields: ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'],
        searchParams: {
            metricType: 'BM25',
            params: { drop_ratio_search: 0.15 },
        },
        filter: 'fileExtension != ".satori_meta"',
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.document.relativePath, 'src/checkpoint.ts');
    assert.equal(results[0]?.score, 0.91);
});
