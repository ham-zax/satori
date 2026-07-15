import assert from 'node:assert/strict';
import test from 'node:test';
import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb.js';
import { MilvusVectorDatabase } from './milvus-vectordb.js';
import type { VectorDocument } from './types.js';

const documents: VectorDocument[] = [{
    id: 'chunk-1',
    content: 'const owner = true;',
    vector: [0.1, 0.2],
    relativePath: 'src/owner.ts',
    startLine: 1,
    endLine: 1,
    fileExtension: '.ts',
    metadata: { language: 'typescript' },
}];

for (const method of ['insert', 'insertHybrid'] as const) {
    test(`Milvus gRPC ${method} does not perform a non-gating collection load-state check`, async () => {
        const calls: Array<Record<string, unknown>> = [];
        const target = {
            ensureLoaded: async () => {
                throw new Error('write path must not inspect collection load state');
            },
            getBackendInfo: () => ({ provider: 'milvus', transport: 'grpc' }),
            upsertDocuments: async (collectionName: string, data: Array<Record<string, unknown>>) => {
                calls.push({ collection_name: collectionName, data });
            },
        };

        await MilvusVectorDatabase.prototype[method].call(
            target as unknown as MilvusVectorDatabase,
            'collection-v1',
            documents,
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.collection_name, 'collection-v1');
        assert.deepEqual(calls[0]?.data, [{
            id: 'chunk-1',
            content: 'const owner = true;',
            vector: [0.1, 0.2],
            relativePath: 'src/owner.ts',
            startLine: 1,
            endLine: 1,
            fileExtension: '.ts',
            metadata: '{"language":"typescript"}',
        }]);
    });
}

test('Milvus gRPC idempotent write retries a dropped connection with a fresh client', async () => {
    const calls: string[] = [];
    const staleClient = {
        upsert: async () => {
            calls.push('stale_upsert');
            throw Object.assign(new Error('14 UNAVAILABLE: Connection dropped'), { code: 14 });
        },
        closeConnection: async () => {
            calls.push('stale_close');
        },
    };
    const freshClient = {
        upsert: async () => {
            calls.push('fresh_upsert');
        },
        closeConnection: async () => {
            calls.push('fresh_close');
        },
    };
    const clients = [staleClient, freshClient];
    const target = {
        writeClient: null as typeof staleClient | null,
        ensureInitialized: async () => undefined,
        createWriteClient: () => {
            const client = clients.shift();
            if (!client) throw new Error('unexpected write-client creation');
            return client;
        },
        discardWriteClient: async (client: typeof staleClient) => {
            target.writeClient = null;
            await client.closeConnection();
        },
    };
    const upsertDocuments = (
        MilvusVectorDatabase.prototype as unknown as {
            upsertDocuments(
                collectionName: string,
                data: Array<Record<string, unknown>>,
            ): Promise<void>;
        }
    ).upsertDocuments;

    await upsertDocuments.call(target, 'collection-v1', [{ id: 'chunk-1' }]);

    assert.deepEqual(calls, ['stale_upsert', 'stale_close', 'fresh_upsert']);
    assert.equal(target.writeClient, freshClient);
});

test('Milvus gRPC bounds database writes without replaying completed sub-batches', async () => {
    const writtenIds: string[][] = [];
    const client = {
        upsert: async (request: { data: Array<{ id: string }> }) => {
            writtenIds.push(request.data.map((row) => row.id));
        },
        closeConnection: async () => undefined,
    };
    const target = {
        writeClient: null as typeof client | null,
        ensureInitialized: async () => undefined,
        createWriteClient: () => client,
        discardWriteClient: async () => {
            throw new Error('healthy client must not be discarded');
        },
    };
    const upsertDocuments = (
        MilvusVectorDatabase.prototype as unknown as {
            upsertDocuments(
                collectionName: string,
                data: Array<{ id: string }>,
            ): Promise<void>;
        }
    ).upsertDocuments;
    const rows = Array.from({ length: 60 }, (_, index) => ({ id: `chunk-${index}` }));

    await upsertDocuments.call(target, 'collection-v1', rows);

    assert.deepEqual(writtenIds.map((ids) => ids.length), [25, 25, 10]);
    assert.deepEqual(writtenIds.flat(), rows.map((row) => row.id));
});

test('Milvus gRPC does not retain a failed client after retry exhaustion', async () => {
    const discarded: number[] = [];
    const clients = Array.from({ length: 3 }, (_, index) => ({
        upsert: async () => {
            throw Object.assign(new Error('14 UNAVAILABLE: Connection dropped'), { code: 14 });
        },
        closeConnection: async () => {
            discarded.push(index);
        },
    }));
    const target = {
        writeClient: null as (typeof clients)[number] | null,
        ensureInitialized: async () => undefined,
        createWriteClient: () => {
            const client = clients.shift();
            if (!client) throw new Error('unexpected write-client creation');
            return client;
        },
        discardWriteClient: async (client: (typeof clients)[number]) => {
            target.writeClient = null;
            await client.closeConnection();
        },
    };
    const upsertDocuments = (
        MilvusVectorDatabase.prototype as unknown as {
            upsertDocuments(
                collectionName: string,
                data: Array<Record<string, unknown>>,
            ): Promise<void>;
        }
    ).upsertDocuments;

    await assert.rejects(
        upsertDocuments.call(target, 'collection-v1', [{ id: 'chunk-1' }]),
        /UNAVAILABLE/,
    );

    assert.deepEqual(discarded, [0, 1, 2]);
    assert.equal(target.writeClient, null);
});

test('Milvus hybrid creation defers index construction and loading until finalization', async () => {
    const events: string[] = [];
    const target = {
        ensureInitialized: async () => undefined,
        client: {
            createCollection: async () => {
                events.push('create_collection');
            },
            createIndex: async (request: { field_name: string }) => {
                events.push(`create_index:${request.field_name}`);
            },
            describeCollection: async () => {
                events.push('describe_collection');
            },
        },
        waitForIndexReady: async (_collectionName: string, fieldName: string) => {
            events.push(`index_ready:${fieldName}`);
        },
        loadCollectionWithRetry: async () => {
            events.push('load_collection');
        },
    };

    await MilvusVectorDatabase.prototype.createHybridCollection.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
        1024,
        'test collection',
        { deferIndexBuild: true },
    );
    assert.deepEqual(events, ['create_collection']);

    await MilvusVectorDatabase.prototype.finalizeCollectionForSearch.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
    );
    assert.deepEqual(events, [
        'create_collection',
        'create_index:vector',
        'index_ready:vector',
        'create_index:sparse_vector',
        'index_ready:sparse_vector',
        'load_collection',
        'describe_collection',
    ]);
});

for (const method of ['insert', 'insertHybrid'] as const) {
    test(`Milvus REST ${method} does not perform a non-gating collection load-state check`, async () => {
        const calls: Array<{ endpoint: string; method: string; body: Record<string, unknown> }> = [];
        let initializationChecks = 0;
        const target = {
            ensureInitialized: async () => {
                initializationChecks += 1;
            },
            ensureLoaded: async () => {
                throw new Error('write path must not inspect collection load state');
            },
            config: { database: 'default' },
            makeRequest: async (endpoint: string, requestMethod: string, body: Record<string, unknown>) => {
                calls.push({ endpoint, method: requestMethod, body });
                return { code: 0 };
            },
        };

        await MilvusRestfulVectorDatabase.prototype[method].call(
            target as unknown as MilvusRestfulVectorDatabase,
            'collection-v1',
            documents,
        );

        assert.equal(initializationChecks, 1);
        assert.deepEqual(calls, [{
            endpoint: '/entities/insert',
            method: 'POST',
            body: {
                collectionName: 'collection-v1',
                dbName: 'default',
                data: [{
                    id: 'chunk-1',
                    content: 'const owner = true;',
                    vector: [0.1, 0.2],
                    relativePath: 'src/owner.ts',
                    startLine: 1,
                    endLine: 1,
                    fileExtension: '.ts',
                    metadata: '{"language":"typescript"}',
                }],
            },
        }]);
    });
}
