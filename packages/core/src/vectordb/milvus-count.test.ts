import assert from 'node:assert/strict';
import test from 'node:test';

import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb';
import { MilvusVectorDatabase } from './milvus-vectordb';

type CountTarget = {
    query: (
        collectionName: string,
        filter: string,
        outputFields: string[],
        limit?: number,
    ) => Promise<Array<Record<string, unknown>>>;
};

test('Milvus count requests the aggregate field without imposing a row limit', async () => {
    const calls: unknown[][] = [];
    const target: CountTarget = {
        query: async (...args) => {
            calls.push(args);
            return [{ 'count(*)': '42' }];
        },
    };

    const count = await MilvusVectorDatabase.prototype.count.call(
        target as unknown as MilvusVectorDatabase,
        'chunks',
        'fileExtension != ".satori_meta"',
    );

    assert.equal(count, 42);
    assert.deepEqual(calls, [[
        'chunks',
        'fileExtension != ".satori_meta"',
        ['count(*)'],
    ]]);
});

test('Milvus REST count requests one aggregate result row', async () => {
    const calls: unknown[][] = [];
    const target: CountTarget = {
        query: async (...args) => {
            calls.push(args);
            return [{ count: 7 }];
        },
    };

    const count = await MilvusRestfulVectorDatabase.prototype.count.call(
        target as unknown as MilvusRestfulVectorDatabase,
        'chunks',
        'fileExtension != ".satori_meta"',
    );

    assert.equal(count, 7);
    assert.deepEqual(calls, [[
        'chunks',
        'fileExtension != ".satori_meta"',
        ['count(*)'],
        1,
    ]]);
});

test('Milvus count adapters reject malformed aggregate results', async () => {
    const target: CountTarget = {
        query: async () => [{ 'count(*)': '1.5' }],
    };

    await assert.rejects(
        () => MilvusVectorDatabase.prototype.count.call(
            target as unknown as MilvusVectorDatabase,
            'chunks',
            '',
        ),
        /invalid row count/,
    );
    await assert.rejects(
        () => MilvusRestfulVectorDatabase.prototype.count.call(
            target as unknown as MilvusRestfulVectorDatabase,
            'chunks',
            '',
        ),
        /invalid row count/,
    );
});

test('Milvus collection deletion uses the bounded remote-mutation deadline', async () => {
    const calls: unknown[] = [];
    const target = {
        ensureInitialized: async () => undefined,
        client: {
            dropCollection: async (request: unknown) => {
                calls.push(request);
            },
        },
    };

    await MilvusVectorDatabase.prototype.dropCollection.call(
        target as unknown as MilvusVectorDatabase,
        'temporary_collection',
    );

    assert.deepEqual(calls, [{
        collection_name: 'temporary_collection',
        timeout: 120_000,
    }]);
});
