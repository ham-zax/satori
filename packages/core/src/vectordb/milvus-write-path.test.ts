import assert from 'node:assert/strict';
import test from 'node:test';
import { MilvusRestfulVectorDatabase } from './milvus-restful-vectordb.js';
import { MilvusVectorDatabase } from './milvus-vectordb.js';
import { fromLegacyMilvusControlRow, toLegacyMilvusControlDocument } from './milvus-control-record.js';
import type { IndexedVectorDocument, VectorControlRecord } from './types.js';

const documents: IndexedVectorDocument[] = [{
    document: {
        id: 'chunk-1',
        content: 'const owner = true;',
        vector: [0.1, 0.2],
        relativePath: 'src/owner.ts',
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        metadata: { language: 'typescript' },
    },
    projections: {
        embeddingText: 'embedding projection',
        lexicalText: 'lexical projection',
        embeddingVersion: 'embedding_projection_v1',
        lexicalVersion: 'lexical_projection_v1',
    },
}];

const controlRecord: VectorControlRecord = {
    id: '__control__',
    kind: 'test_control',
    metadata: {
        value: 'control metadata',
    },
};

test('Milvus control-row translation round-trips generic metadata without requiring a fingerprint', () => {
    const document = toLegacyMilvusControlDocument(controlRecord, 2);
    const decoded = fromLegacyMilvusControlRow({
        id: document.id,
        metadata: JSON.stringify(document.metadata),
    }, document.id);

    assert.deepEqual(document.vector, [0, 0]);
    assert.deepEqual(decoded, controlRecord);
});

test('Milvus control-row translation remains compatible with legacy metadata-kind rows', () => {
    assert.deepEqual(fromLegacyMilvusControlRow({
        id: '__legacy_control__',
        metadata: JSON.stringify({ kind: 'legacy_control', value: 'legacy metadata' }),
    }, '__legacy_control__'), {
        id: '__legacy_control__',
        kind: 'legacy_control',
        metadata: { kind: 'legacy_control', value: 'legacy metadata' },
    });
});

test('Milvus control-row translation rejects its reserved transport metadata key', () => {
    assert.throws(() => toLegacyMilvusControlDocument({
        id: '__control__',
        kind: 'test_control',
        metadata: { __satoriControlKind: 'logical-value' },
    }, 2), /reserved key/);
});

test('Milvus gRPC searchable write does not perform a non-gating collection load-state check', async () => {
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

        await MilvusVectorDatabase.prototype.writeDocuments.call(
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

test('Milvus gRPC writes control records through the separate control boundary', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const target = {
        config: { vectorDimension: 2 },
        upsertDocuments: async (collectionName: string, data: Array<Record<string, unknown>>) => {
            calls.push({ collection_name: collectionName, data });
        },
    };

    await MilvusVectorDatabase.prototype.insertControl.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
        controlRecord,
    );

    assert.equal(calls.length, 1);
    const row = (calls[0]?.data as Array<Record<string, unknown>>)[0];
    assert.equal(row?.id, '__control__');
    assert.deepEqual(row?.vector, [0, 0]);
    assert.equal(row?.fileExtension, '.satori_meta');
    assert.match(String(row?.metadata), /"__satoriControlKind":"test_control"/);
});

test('Milvus gRPC reads and deletes control records through the separate control boundary', async () => {
    const deleted: string[][] = [];
    const target = {
        queryRows: async () => [{
            id: '__control__',
            metadata: '{"__satoriControlKind":"test_control","value":"control metadata"}',
        }],
        deleteRows: async (_collectionName: string, ids: string[]) => {
            deleted.push(ids);
        },
    };

    const record = await MilvusVectorDatabase.prototype.getControl.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
        '__control__',
    );
    await MilvusVectorDatabase.prototype.deleteControl.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
        '__control__',
    );

    assert.deepEqual(record, {
        id: '__control__',
        kind: 'test_control',
        metadata: { value: 'control metadata' },
    });
    assert.deepEqual(deleted, [['__control__']]);
});

test('Milvus gRPC excludes control rows from every retrieval operation', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const target = {
        ensureInitialized: async () => undefined,
        ensureLoaded: async () => undefined,
        client: {
            search: async (request: Record<string, unknown>) => {
                requests.push(request);
                return { results: [] };
            },
        },
    };
    await MilvusVectorDatabase.prototype.retrieveDense.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
        {
            vector: [0.1, 0.2],
            limit: 5,
            filter: {
                kind: 'comparison',
                field: 'relativePath',
                operator: 'eq',
                value: 'src/owner.ts',
            },
        },
    );
    await MilvusVectorDatabase.prototype.retrieveLexical.call(
        target as unknown as MilvusVectorDatabase,
        'collection-v1',
        { query: 'owner', limit: 5 },
    );

    assert.equal(
        requests[0]?.expr,
        '(relativePath == "src/owner.ts") and (fileExtension != ".satori_meta")',
    );
    assert.equal(requests[1]?.expr, 'fileExtension != ".satori_meta"');
});

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
    const metrics = MilvusVectorDatabase.prototype.getWriteMetricsSnapshot.call(
        target as unknown as MilvusVectorDatabase,
    );
    assert.equal(metrics.providerRequestCount, 2);
    assert.equal(metrics.retryCount, 1);
    assert.deepEqual(metrics.recentAttempts.map((attempt) => attempt.flushReason), [
        'logical_write_end',
        'retry',
    ]);
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
        writeBatchMaxRows: 100,
        writeBatchMaxBytes: null,
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
    const rows = Array.from({ length: 220 }, (_, index) => ({ id: `chunk-${index}` }));

    await upsertDocuments.call(target, 'collection-v1', rows);

    assert.deepEqual(writtenIds.map((ids) => ids.length), [100, 100, 20]);
    assert.deepEqual(writtenIds.flat(), rows.map((row) => row.id));
    const metrics = MilvusVectorDatabase.prototype.getWriteMetricsSnapshot.call(
        target as unknown as MilvusVectorDatabase,
    );
    assert.equal(metrics.providerRequestCount, 3);
    assert.equal(metrics.retryCount, 0);
    assert.equal(metrics.submittedRows, 220);
    assert.equal(metrics.submittedBytes, [rows.slice(0, 100), rows.slice(100, 200), rows.slice(200)]
        .reduce((total, batch) => total + Buffer.byteLength(JSON.stringify(batch), 'utf8'), 0));
    assert.equal(metrics.rowLimit, 100);
    assert.equal(metrics.byteLimit, null);
    assert.deepEqual(metrics.recentAttempts.map((attempt) => ({
        sequence: attempt.sequence,
        rows: attempt.rows,
        flushReason: attempt.flushReason,
    })), [
        { sequence: 1, rows: 100, flushReason: 'row_limit' },
        { sequence: 2, rows: 100, flushReason: 'row_limit' },
        { sequence: 3, rows: 20, flushReason: 'logical_write_end' },
    ]);
    assert.deepEqual(metrics.recentAttempts.map((attempt) => attempt.bytes), [
        Buffer.byteLength(JSON.stringify(rows.slice(0, 100)), 'utf8'),
        Buffer.byteLength(JSON.stringify(rows.slice(100, 200)), 'utf8'),
        Buffer.byteLength(JSON.stringify(rows.slice(200)), 'utf8'),
    ]);
    assert.ok(metrics.durationMs >= 0);
});

test('Milvus gRPC deterministically bounds writes by serialized bytes before the row ceiling', async () => {
    const writtenBatches: Array<Array<{ id: string; content: string }>> = [];
    const client = {
        upsert: async (request: { data: Array<{ id: string; content: string }> }) => {
            writtenBatches.push(request.data);
        },
        closeConnection: async () => undefined,
    };
    const rows = Array.from({ length: 5 }, (_, index) => ({
        id: `chunk-${index}`,
        content: `${index}`.repeat(20),
    }));
    const maxBytes = Buffer.byteLength(JSON.stringify(rows.slice(0, 2)), 'utf8');
    const target = {
        writeClient: null as typeof client | null,
        writeBatchMaxRows: 1_000,
        writeBatchMaxBytes: maxBytes,
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
                data: Array<{ id: string; content: string }>,
            ): Promise<void>;
        }
    ).upsertDocuments;

    await upsertDocuments.call(target, 'collection-v1', rows);

    assert.deepEqual(writtenBatches.map((batch) => batch.length), [2, 2, 1]);
    assert.deepEqual(writtenBatches.flat(), rows);
    assert.ok(writtenBatches.every((batch) => (
        Buffer.byteLength(JSON.stringify(batch), 'utf8') <= maxBytes
    )));
    const metrics = MilvusVectorDatabase.prototype.getWriteMetricsSnapshot.call(
        target as unknown as MilvusVectorDatabase,
    );
    assert.equal(metrics.rowLimit, 1_000);
    assert.equal(metrics.byteLimit, maxBytes);
    assert.deepEqual(metrics.recentAttempts.map((attempt) => attempt.flushReason), [
        'byte_limit',
        'byte_limit',
        'logical_write_end',
    ]);
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

test('Milvus REST searchable write does not perform a non-gating collection load-state check', async () => {
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

        await MilvusRestfulVectorDatabase.prototype.writeDocuments.call(
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

test('Milvus REST writes control records through the separate control boundary', async () => {
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const target = {
        ensureInitialized: async () => undefined,
        config: { database: 'default', vectorDimension: 2 },
        makeRequest: async (endpoint: string, _method: string, body: Record<string, unknown>) => {
            calls.push({ endpoint, body });
            return { code: 0 };
        },
    };

    await MilvusRestfulVectorDatabase.prototype.insertControl.call(
        target as unknown as MilvusRestfulVectorDatabase,
        'collection-v1',
        controlRecord,
    );

    assert.equal(calls[0]?.endpoint, '/entities/insert');
    const rows = calls[0]?.body.data as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.id, '__control__');
    assert.deepEqual(rows[0]?.vector, [0, 0]);
    assert.equal(rows[0]?.fileExtension, '.satori_meta');
});

test('Milvus REST reads and deletes control records through the separate control boundary', async () => {
    const deleted: string[][] = [];
    const target = {
        queryRows: async () => [{
            id: '__control__',
            metadata: { __satoriControlKind: 'test_control', value: 'control metadata' },
        }],
        deleteRows: async (_collectionName: string, ids: string[]) => {
            deleted.push(ids);
        },
    };

    const record = await MilvusRestfulVectorDatabase.prototype.getControl.call(
        target as unknown as MilvusRestfulVectorDatabase,
        'collection-v1',
        '__control__',
    );
    await MilvusRestfulVectorDatabase.prototype.deleteControl.call(
        target as unknown as MilvusRestfulVectorDatabase,
        'collection-v1',
        '__control__',
    );

    assert.deepEqual(record, controlRecord);
    assert.deepEqual(deleted, [['__control__']]);
});

test('Milvus REST excludes control rows from every retrieval operation', async () => {
    const requests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    const target = {
        ensureInitialized: async () => undefined,
        ensureLoaded: async () => undefined,
        config: { database: 'default' },
        makeRequest: async (endpoint: string, _method: string, body: Record<string, unknown>) => {
            requests.push({ endpoint, body });
            return { code: 0, data: [] };
        },
    };
    await MilvusRestfulVectorDatabase.prototype.retrieveDense.call(
        target as unknown as MilvusRestfulVectorDatabase,
        'collection-v1',
        {
            vector: [0.1, 0.2],
            limit: 5,
            filter: {
                kind: 'comparison',
                field: 'relativePath',
                operator: 'eq',
                value: 'src/owner.ts',
            },
        },
    );
    await MilvusRestfulVectorDatabase.prototype.retrieveLexical.call(
        target as unknown as MilvusRestfulVectorDatabase,
        'collection-v1',
        { query: 'owner', limit: 5 },
    );

    assert.equal(
        requests[0]?.body.filter,
        '(relativePath == "src/owner.ts") and (fileExtension != ".satori_meta")',
    );
    assert.equal(requests[1]?.body.filter, 'fileExtension != ".satori_meta"');
});
