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
    IndexCompletionMarkerDocument,
    SemanticSearchRequest
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

function createInMemoryVectorDb(options?: { hybridResults?: HybridSearchResult[]; vectorResults?: VectorSearchResult[] }) {
    const byCollection = new Map<string, Map<string, VectorDocument>>();
    let lastHybridFilterExpr: string | undefined;
    let lastHybridOptions: HybridSearchOptions | undefined;
    let lastHybridCollectionName: string | undefined;
    let lastSearchOptions: SearchOptions | undefined;
    let lastSearchCollectionName: string | undefined;

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
        async search(collectionName, _queryVector, searchOptions?: SearchOptions): Promise<VectorSearchResult[]> {
            lastSearchCollectionName = collectionName;
            lastSearchOptions = searchOptions;
            const results = options?.vectorResults || [];
            if (searchOptions?.threshold === undefined) {
                return results;
            }
            return results.filter((result) => result.score >= searchOptions.threshold!);
        },
        async hybridSearch() {
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

    return {
        db: {
            ...db,
            async hybridSearch(collectionName: string, _searchRequests: HybridSearchRequest[], hybridOptions?: HybridSearchOptions): Promise<HybridSearchResult[]> {
                lastHybridCollectionName = collectionName;
                lastHybridFilterExpr = hybridOptions?.filterExpr;
                lastHybridOptions = hybridOptions;
                const results = options?.hybridResults || [];
                if (hybridOptions?.threshold === undefined) {
                    return results;
                }
                return results.filter((result) => result.score >= hybridOptions.threshold!);
            }
        } satisfies VectorDatabase,
        getLastHybridFilterExpr: () => lastHybridFilterExpr,
        getLastHybridOptions: () => lastHybridOptions,
        getLastHybridCollectionName: () => lastHybridCollectionName,
        getLastSearchOptions: () => lastSearchOptions,
        getLastSearchCollectionName: () => lastSearchCollectionName
    };
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

function buildMarkerDoc(marker: IndexCompletionMarkerDocument): VectorDocument {
    return {
        id: INDEX_COMPLETION_MARKER_DOC_ID,
        vector: [0, 0, 0, 0],
        content: 'marker',
        relativePath: '.__satori__/index_completion_marker.json',
        startLine: 0,
        endLine: 0,
        fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
        metadata: marker
    };
}

function buildChunkDoc(id: string, relativePath: string): VectorDocument {
    return {
        id,
        vector: [0.1, 0.2, 0.3, 0.4],
        content: `chunk:${id}`,
        relativePath,
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        metadata: {
            language: 'typescript'
        }
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
    await db.insertHybrid(collectionName, [buildChunkDoc('lifecycle_chunk', 'src/runtime.ts')]);

    await context.writeIndexCompletionMarker(codebasePath, {
        ...buildMarker(),
        indexedFiles: 0,
        totalChunks: 0,
    });
    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(marker);
    assert.equal(marker?.kind, 'satori_index_completion_v1');
    assert.equal(marker?.runId, 'run_20260227');

    await context.clearIndexCompletionMarker(codebasePath);
    const afterClear = await context.getIndexCompletionMarker(codebasePath);
    assert.equal(afterClear, null);
});

test('Context getIndexCompletionMarker selects the newest proven staged generation in a family', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const olderCollectionName = `${familyCollectionName}__gen_older`;
    const newerCollectionName = `${familyCollectionName}__gen_newer`;

    await db.createHybridCollection(olderCollectionName, 4);
    await db.insertHybrid(olderCollectionName, [
        buildChunkDoc('older_chunk', 'src/older.ts'),
        buildMarkerDoc({
            ...buildMarker(),
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: 'run_older'
        })
    ]);

    await db.createHybridCollection(newerCollectionName, 4);
    await db.insertHybrid(newerCollectionName, [
        buildChunkDoc('newer_chunk', 'src/newer.ts'),
        buildMarkerDoc({
            ...buildMarker(),
            completedAt: '2026-02-28T23:57:10.000Z',
            runId: 'run_newer'
        })
    ]);

    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(marker);
    assert.equal(marker?.runId, 'run_newer');
    assert.equal(marker?.completedAt, '2026-02-28T23:57:10.000Z');
});

test('Context getIndexCompletionMarker ignores a newer marker-only staged generation with missing payload', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const provenCollectionName = `${familyCollectionName}__gen_proven`;
    const markerOnlyCollectionName = `${familyCollectionName}__gen_marker_only`;

    await db.createHybridCollection(provenCollectionName, 4);
    await db.insertHybrid(provenCollectionName, [
        buildChunkDoc('proven_chunk', 'src/proven.ts'),
        buildMarkerDoc({
            ...buildMarker(),
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: 'run_proven'
        })
    ]);

    await db.createHybridCollection(markerOnlyCollectionName, 4);
    await db.insertHybrid(markerOnlyCollectionName, [
        buildMarkerDoc({
            ...buildMarker(),
            completedAt: '2026-02-28T23:57:10.000Z',
            runId: 'run_marker_only',
            totalChunks: 728
        })
    ]);

    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(marker);
    assert.equal(marker?.runId, 'run_proven');
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

    await db.insertHybrid(collectionName, [
        buildChunkDoc('filter_chunk', 'src/runtime.ts'),
        buildMarkerDoc(buildMarker())
    ]);

    await context.semanticSearch({
        codebasePath,
        query: 'runtime symbol',
        topK: 8,
        retrievalMode: 'hybrid',
        filterExpr: 'fileExtension in [".ts"]',
        scorePolicy: { kind: 'topk_only' }
    });

    const filterExpr = getLastHybridFilterExpr();
    assert.ok(filterExpr);
    assert.match(filterExpr!, /fileExtension in \["\.ts"\]/);
    assert.match(filterExpr!, /fileExtension != "\.satori_meta"/);
});

test('Context semanticSearch uses the active staged generation when the base family collection is absent', async () => {
    const hybridResults: HybridSearchResult[] = [{
        document: buildChunkDoc('chunk_runtime', 'src/runtime.ts'),
        score: 0.91
    }];
    const { db, getLastHybridCollectionName } = createInMemoryVectorDb({ hybridResults });
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const stagedCollectionName = `${familyCollectionName}__gen_ready`;

    await db.createHybridCollection(stagedCollectionName, 4);
    await db.insertHybrid(stagedCollectionName, [
        buildChunkDoc('ready_chunk', 'src/runtime.ts'),
        buildMarkerDoc({
            ...buildMarker(),
            completedAt: '2026-02-28T23:57:10.000Z',
            runId: 'run_ready'
        })
    ]);

    const results = await context.semanticSearch({
        codebasePath,
        query: 'runtime symbol',
        topK: 8,
        retrievalMode: 'hybrid',
        scorePolicy: { kind: 'topk_only' }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.relativePath, 'src/runtime.ts');
    assert.equal(getLastHybridCollectionName(), stagedCollectionName);
});

test('Context clearIndex removes every collection in the family, including staged generations', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const stagedCollectionName = `${familyCollectionName}__gen_ready`;

    await db.createHybridCollection(familyCollectionName, 4);
    await db.createHybridCollection(stagedCollectionName, 4);

    await context.clearIndex(codebasePath);

    assert.deepEqual((await db.listCollections()).sort(), []);
});

test('Context semanticSearch does not apply dense thresholds to hybrid RRF results', async () => {
    const hybridResults: HybridSearchResult[] = [{
        document: {
            id: 'chunk_hurst',
            vector: [],
            content: 'class HurstGateState:\n    pass',
            relativePath: 'src/python/core/regime/hurst_gate.py',
            startLine: 72,
            endLine: 73,
            fileExtension: '.py',
            metadata: {
                language: 'python',
                symbolLabel: 'class HurstGateState'
            }
        },
        score: 0.019
    }];
    const { db, getLastHybridOptions } = createInMemoryVectorDb({ hybridResults });
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createHybridCollection(collectionName, 4);
    await db.insertHybrid(collectionName, [
        buildChunkDoc('hybrid_chunk', 'src/runtime.ts'),
        buildMarkerDoc(buildMarker())
    ]);

    const results = await context.semanticSearch({
        codebasePath,
        query: 'hurst',
        topK: 8,
        retrievalMode: 'hybrid',
        scorePolicy: { kind: 'topk_only' }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.relativePath, 'src/python/core/regime/hurst_gate.py');
    assert.equal(getLastHybridOptions()?.threshold, undefined);
});

test('Context semanticSearch request preserves dense thresholds and returns dense score metadata', async () => {
    const vectorResults: VectorSearchResult[] = [
        {
            document: {
                id: 'chunk_high',
                vector: [0.1, 0.2, 0.3, 0.4],
                content: 'dense match',
                relativePath: 'src/core/high.ts',
                startLine: 10,
                endLine: 12,
                fileExtension: '.ts',
                metadata: { language: 'typescript' }
            },
            score: 0.82
        },
        {
            document: {
                id: 'chunk_low',
                vector: [0.1, 0.2, 0.3, 0.4],
                content: 'low dense match',
                relativePath: 'src/core/low.ts',
                startLine: 20,
                endLine: 22,
                fileExtension: '.ts',
                metadata: { language: 'typescript' }
            },
            score: 0.35
        }
    ];
    const { db, getLastSearchOptions } = createInMemoryVectorDb({ vectorResults });
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createCollection(collectionName, 4);
    await db.insert(collectionName, [
        buildChunkDoc('dense_chunk', 'src/core/high.ts'),
        buildMarkerDoc(buildMarker())
    ]);

    const request: SemanticSearchRequest = {
        codebasePath,
        query: 'dense query',
        topK: 8,
        retrievalMode: 'dense',
        scorePolicy: { kind: 'dense_similarity_min', min: 0.6 }
    };

    const results = await context.semanticSearch(request);

    assert.equal(getLastSearchOptions()?.threshold, 0.6);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.relativePath, 'src/core/high.ts');
    assert.equal(results[0]?.backendScoreKind, 'dense_similarity');
    assert.equal(results[0]?.backendScore, 0.82);
});

test('Context semanticSearch request rejects dense similarity thresholds for hybrid and lexical retrieval', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });

    const hybridRequest: SemanticSearchRequest = {
        codebasePath: '/repo/app',
        query: 'hurst',
        topK: 8,
        retrievalMode: 'hybrid',
        scorePolicy: { kind: 'dense_similarity_min', min: 0.3 }
    };
    await assert.rejects(
        () => context.semanticSearch(hybridRequest),
        /dense similarity threshold.*hybrid/i
    );

    const lexicalRequest: SemanticSearchRequest = {
        codebasePath: '/repo/app',
        query: 'HurstGateState',
        topK: 8,
        retrievalMode: 'lexical',
        scorePolicy: { kind: 'dense_similarity_min', min: 0.3 }
    };
    await assert.rejects(
        () => context.semanticSearch(lexicalRequest),
        /dense similarity threshold.*lexical/i
    );
});

test('Context semanticSearch rejects explicit hybrid and lexical retrieval when hybrid mode is disabled', async () => {
    const previousHybridMode = process.env.HYBRID_MODE;
    process.env.HYBRID_MODE = 'false';

    try {
        const { db } = createInMemoryVectorDb();
        const context = new Context({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
        });

        await assert.rejects(
            () => context.semanticSearch({
                codebasePath: '/repo/app',
                query: 'hurst',
                topK: 8,
                retrievalMode: 'hybrid',
                scorePolicy: { kind: 'topk_only' }
            }),
            /hybrid retrieval requires hybrid search support/i
        );

        await assert.rejects(
            () => context.semanticSearch({
                codebasePath: '/repo/app',
                query: 'HurstGateState',
                topK: 8,
                retrievalMode: 'lexical',
                scorePolicy: { kind: 'topk_only' }
            }),
            /lexical retrieval requires hybrid search support/i
        );
    } finally {
        if (previousHybridMode === undefined) {
            delete process.env.HYBRID_MODE;
        } else {
            process.env.HYBRID_MODE = previousHybridMode;
        }
    }
});

test('Context semanticSearch supports legacy positional arguments', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });

    const results = await context.semanticSearch('/repo/app', 'hurst', 8, 0.3);
    assert.deepEqual(results, []);
});
