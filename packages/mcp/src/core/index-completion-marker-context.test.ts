import test from 'node:test';
import assert from 'node:assert/strict';
import {
    Context,
    Embedding,
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION
} from '@zokizuan/satori-core';
import type {
    EmbeddingVector,
    VectorDatabase,
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
    IndexCompletionMarkerDocument
} from '@zokizuan/satori-core';

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 4;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        return { vector: [0.1, 0.2, 0.3, 0.4], dimension: 4 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [0.1, 0.2, 0.3, 0.4], dimension: 4 }));
    }

    getDimension(): number {
        return 4;
    }

    getProvider(): string {
        return 'VoyageAI';
    }
}

function createInMemoryVectorDb() {
    const byCollection = new Map<string, Map<string, VectorDocument>>();
    let lastHybridFilterExpr: string | undefined;

    const ensureCollection = (collectionName: string): Map<string, VectorDocument> => {
        if (!byCollection.has(collectionName)) {
            byCollection.set(collectionName, new Map());
        }
        return byCollection.get(collectionName)!;
    };

    const parseIdEqualsFilter = (filter: string): string | null => {
        const match = filter.match(/^\s*id\s*==\s*"([^"]+)"\s*$/);
        return match?.[1] || null;
    };

    const db: VectorDatabase = {
        async createCollection(collectionName) { ensureCollection(collectionName); },
        async createHybridCollection(collectionName) { ensureCollection(collectionName); },
        async dropCollection(collectionName) {
            byCollection.delete(collectionName);
        },
        async hasCollection(collectionName) {
            return byCollection.has(collectionName);
        },
        async listCollections() {
            return Array.from(byCollection.keys());
        },
        async insert(collectionName, documents) {
            const collection = ensureCollection(collectionName);
            for (const doc of documents) {
                collection.set(doc.id, doc);
            }
        },
        async insertHybrid(collectionName, documents) {
            const collection = ensureCollection(collectionName);
            for (const doc of documents) {
                collection.set(doc.id, doc);
            }
        },
        async search(_collectionName, _queryVector, _options?: SearchOptions): Promise<VectorSearchResult[]> {
            return [];
        },
        async hybridSearch(_collectionName, _searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]> {
            lastHybridFilterExpr = options?.filterExpr;
            return [];
        },
        async delete(collectionName, ids) {
            const collection = ensureCollection(collectionName);
            for (const id of ids) {
                collection.delete(id);
            }
        },
        async query(collectionName, filter, outputFields, limit) {
            const collection = ensureCollection(collectionName);
            const idEquals = parseIdEqualsFilter(filter);
            const values = idEquals
                ? Array.from(collection.values()).filter((doc) => doc.id === idEquals)
                : Array.from(collection.values());

            const rows = values.slice(0, limit ?? values.length).map((doc) => {
                const row: Record<string, unknown> = {};
                for (const field of outputFields) {
                    if (field === 'id') row.id = doc.id;
                    if (field === 'metadata') row.metadata = JSON.stringify(doc.metadata || {});
                }
                return row;
            });
            return rows;
        },
        async checkCollectionLimit() {
            return true;
        }
    };

    return { db, getLastHybridFilterExpr: () => lastHybridFilterExpr };
}

function buildMarker(): IndexCompletionMarkerDocument {
    return {
        kind: 'satori_index_completion_v1',
        codebasePath: '/repo/app',
        fingerprint: {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-large',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'hybrid_v3'
        },
        indexedFiles: 169,
        totalChunks: 728,
        completedAt: '2026-02-27T23:57:10.000Z',
        runId: 'run_20260227'
    };
}

test('Context marker lifecycle writes, reads, and clears completion marker doc', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createHybridCollection(collectionName, 4);

    await context.writeIndexCompletionMarker(codebasePath, buildMarker());
    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(marker);
    assert.equal(marker?.kind, 'satori_index_completion_v1');
    assert.equal(marker?.runId, 'run_20260227');

    await context.clearIndexCompletionMarker(codebasePath);
    const afterClear = await context.getIndexCompletionMarker(codebasePath);
    assert.equal(afterClear, null);
});

test('Context semanticSearch always excludes completion marker docs from query filter', async () => {
    const { db, getLastHybridFilterExpr } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createHybridCollection(collectionName, 4);

    await db.insertHybrid(collectionName, [{
        id: INDEX_COMPLETION_MARKER_DOC_ID,
        vector: [0, 0, 0, 0],
        content: 'marker',
        relativePath: '.__satori__/index_completion_marker.json',
        startLine: 0,
        endLine: 0,
        fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
        metadata: buildMarker()
    }]);

    await context.semanticSearch(
        codebasePath,
        'runtime symbol',
        8,
        0.5,
        'fileExtension in [".ts"]'
    );

    const filterExpr = getLastHybridFilterExpr();
    assert.ok(filterExpr);
    assert.match(filterExpr!, /fileExtension in \["\.ts"\]/);
    assert.match(filterExpr!, /fileExtension != "\.satori_meta"/);
});
