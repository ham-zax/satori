import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    Context,
    EMBEDDING_PROJECTION_VERSION,
    Embedding,
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION,
    LANGUAGE_PARSER_VERSION,
    LEXICAL_PROJECTION_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
} from '@zokizuan/satori-core';
import type {
    EmbeddingVector,
    DenseCandidateRequest,
    LexicalCandidateRequest,
    VectorDatabase,
    VectorCandidate,
    VectorControlRecord,
    VectorDocument,
    VectorDocumentQuery,
    VectorFilter,
    IndexedVectorDocument,
    IndexCompletionMarkerDocument,
    SemanticSearchRequest
} from '@zokizuan/satori-core';
import {
    getCompletionMarkerReader,
    validateCompletionProof,
} from './completion-proof.js';

class FakeEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 4;
    }

    async embedQuery(_text: string): Promise<EmbeddingVector> {
        return { vector: [0.1, 0.2, 0.3, 0.4], dimension: 4 };
    }

    async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [0.1, 0.2, 0.3, 0.4], dimension: 4 }));
    }

    getDimension(): number {
        return 4;
    }

    getProvider(): string {
        return 'VoyageAI';
    }
}

function createInMemoryVectorDb(options?: { hybridResults?: VectorCandidate[]; vectorResults?: VectorCandidate[] }) {
    const byCollection = new Map<string, Map<string, VectorDocument>>();
    let lastDenseRequest: DenseCandidateRequest | undefined;
    let lastDenseCollectionName: string | undefined;
    let lastLexicalRequest: LexicalCandidateRequest | undefined;
    let lastLexicalCollectionName: string | undefined;

    const ensureCollection = (collectionName: string): Map<string, VectorDocument> => {
        if (!byCollection.has(collectionName)) {
            byCollection.set(collectionName, new Map());
        }
        return byCollection.get(collectionName)!;
    };

    const matchesFilter = (document: VectorDocument, filter?: VectorFilter): boolean => {
        if (!filter) return true;
        if (filter.kind === 'and') return filter.operands.every((operand) => matchesFilter(document, operand));
        const value = document[filter.field];
        if (filter.kind === 'in') return filter.values.includes(value as string);
        return filter.operator === 'eq' ? value === filter.value : value !== filter.value;
    };

    const db = {
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
        async writeDocuments(
            collectionName: string,
            documents: Array<IndexedVectorDocument | VectorDocument>,
        ) {
            const collection = ensureCollection(collectionName);
            for (const input of documents) {
                const doc = 'projections' in input ? input.document : input;
                collection.set(doc.id, doc);
            }
        },
        async seedDocuments(
            collectionName: string,
            documents: Array<IndexedVectorDocument | VectorDocument>,
        ) {
            const collection = ensureCollection(collectionName);
            for (const input of documents) {
                const doc = 'projections' in input ? input.document : input;
                collection.set(doc.id, doc);
            }
        },
        async insertControl(collectionName: string, record: VectorControlRecord) {
            ensureCollection(collectionName).set(record.id, {
                id: record.id,
                vector: [],
                content: '',
                relativePath: '.__satori__/control.json',
                startLine: 0,
                endLine: 0,
                fileExtension: '.satori_meta',
                metadata: { ...record.metadata, kind: record.kind },
            });
        },
        async getControl(collectionName: string, id: string): Promise<VectorControlRecord | null> {
            const document = byCollection.get(collectionName)?.get(id);
            return document ? {
                id,
                kind: typeof document.metadata.kind === 'string' ? document.metadata.kind : '',
                metadata: { ...document.metadata },
            } : null;
        },
        async deleteControl(collectionName: string, id: string) {
            byCollection.get(collectionName)?.delete(id);
        },
        async retrieveDense(collectionName, request: DenseCandidateRequest): Promise<VectorCandidate[]> {
            lastDenseCollectionName = collectionName;
            lastDenseRequest = request;
            const results = request.minimumScore === undefined
                ? options?.hybridResults || options?.vectorResults || []
                : options?.vectorResults || [];
            if (request.minimumScore === undefined) {
                return results;
            }
            return results.filter((result) => result.score >= request.minimumScore!);
        },
        async retrieveLexical(collectionName, request: LexicalCandidateRequest): Promise<VectorCandidate[]> {
            lastLexicalCollectionName = collectionName;
            lastLexicalRequest = request;
            return options?.hybridResults || [];
        },
        async deleteDocuments(collectionName, ids) {
            const collection = ensureCollection(collectionName);
            for (const id of ids) {
                collection.delete(id);
            }
        },
        async queryDocuments(collectionName, request: VectorDocumentQuery) {
            const collection = ensureCollection(collectionName);
            const values = Array.from(collection.values())
                .filter((document) => document.fileExtension !== INDEX_COMPLETION_MARKER_FILE_EXTENSION)
                .filter((document) => matchesFilter(document, request.filter));

            const rows = values.slice(0, request.limit ?? values.length).map((doc) => {
                const row: Record<string, unknown> = {};
                for (const field of request.fields) {
                    if (field === 'id') row.id = doc.id;
                    if (field === 'metadata') row.metadata = JSON.stringify(doc.metadata || {});
                }
                return row;
            });
            return rows;
        },
        async countDocuments(collectionName, filter?: VectorFilter) {
            return Array.from(ensureCollection(collectionName).values())
                .filter((document) => document.fileExtension !== INDEX_COMPLETION_MARKER_FILE_EXTENSION)
                .filter((document) => matchesFilter(document, filter))
                .length;
        },
        async checkCollectionLimit() {
            return true;
        }
    } satisfies VectorDatabase;

    return {
        db,
        getLastDenseRequest: () => lastDenseRequest,
        getLastDenseCollectionName: () => lastDenseCollectionName,
        getLastLexicalRequest: () => lastLexicalRequest,
        getLastLexicalCollectionName: () => lastLexicalCollectionName,
    };
}

const TEST_POLICY_HASH = 'a'.repeat(64);
const ORPHAN_POLICY_HASH = 'b'.repeat(64);
const STAGED_POLICY_HASH = 'c'.repeat(64);

function buildMarker(indexPolicyHash = TEST_POLICY_HASH): IndexCompletionMarkerDocument {
    return {
        kind: 'satori_index_completion_v3',
        codebasePath: '/repo/app',
        fingerprint: {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'VoyageAI',
            embeddingDimension: 4,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'hybrid_v3',
            parserVersion: LANGUAGE_PARSER_VERSION,
            extractorVersion: SYMBOL_EXTRACTOR_VERSION,
            relationshipVersion: RELATIONSHIP_BUILDER_VERSION,
            embeddingProjectionVersion: EMBEDDING_PROJECTION_VERSION,
            lexicalProjectionVersion: LEXICAL_PROJECTION_VERSION,
        },
        indexedFiles: 169,
        totalChunks: 1,
        completedAt: '2026-02-27T23:57:10.000Z',
        runId: 'run_20260227',
        indexPolicyHash,
        indexStatus: 'completed',
        navigation: { status: 'not_bound' },
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
    const codebasePath = '/repo/completion-marker-lifecycle';
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createHybridCollection(collectionName, 4);
    await db.seedDocuments(collectionName, [buildChunkDoc('lifecycle_chunk', 'src/runtime.ts')]);

    await context.writeIndexCompletionMarker(codebasePath, {
        ...buildMarker(policy.policyHash),
        codebasePath,
        indexedFiles: 1,
        totalChunks: 1,
    });
    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(marker);
    assert.equal(marker?.kind, 'satori_index_completion_v3');
    assert.equal(marker?.runId, 'run_20260227');

    await context.clearIndexCompletionMarker(codebasePath);
    const afterClear = await context.getIndexCompletionMarker(codebasePath);
    assert.equal(afterClear, null);
});

test('Context-backed completion proof requires reindex for a stored v1 marker', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/completion-legacy-v1';
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createHybridCollection(collectionName, 4);
    await db.seedDocuments(collectionName, [
        buildChunkDoc('legacy_chunk', 'src/legacy.ts'),
        {
            id: INDEX_COMPLETION_MARKER_DOC_ID,
            vector: [0, 0, 0, 0],
            content: 'legacy marker',
            relativePath: '.__satori__/index_completion_marker.json',
            startLine: 0,
            endLine: 0,
            fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
            metadata: {
                kind: 'satori_index_completion_v1',
                codebasePath,
            },
        },
    ]);

    const result = await validateCompletionProof({
        codebasePath,
        getIndexCompletionMarker: getCompletionMarkerReader(context),
    });

    assert.deepEqual(result, {
        outcome: 'stale_local',
        reason: 'requires_reindex',
    });
});

test('Context-backed completion proof reports invalid v3 generation evidence before unrelated v1 evidence', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/completion-invalid-v2-precedence';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const legacyCollectionName = `${familyCollectionName}__gen_legacy`;
    await db.createHybridCollection(familyCollectionName, 4);
    await db.createHybridCollection(legacyCollectionName, 4);
    await db.seedDocuments(familyCollectionName, [
        buildChunkDoc('invalid_current_chunk', 'src/current.ts'),
        {
            id: INDEX_COMPLETION_MARKER_DOC_ID,
            vector: [0, 0, 0, 0],
            content: 'invalid current marker',
            relativePath: '.__satori__/index_completion_marker.json',
            startLine: 0,
            endLine: 0,
            fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
            metadata: {
                ...buildMarker(),
                codebasePath,
                totalChunks: 2,
            },
        },
    ]);
    await db.seedDocuments(legacyCollectionName, [{
        id: INDEX_COMPLETION_MARKER_DOC_ID,
        vector: [0, 0, 0, 0],
        content: 'legacy marker',
        relativePath: '.__satori__/index_completion_marker.json',
        startLine: 0,
        endLine: 0,
        fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
        metadata: {
            kind: 'satori_index_completion_v1',
            codebasePath,
        },
    }]);

    const result = await validateCompletionProof({
        codebasePath,
        getIndexCompletionMarker: getCompletionMarkerReader(context),
    });

    assert.deepEqual(result, {
        outcome: 'stale_local',
        reason: 'invalid_payload',
    });
});

test('Context-backed completion proof does not let an orphan staged v3 mask the base legacy marker', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/completion-orphan-invalid-v2';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const orphanCollectionName = `${familyCollectionName}__gen_orphan`;
    await db.createHybridCollection(familyCollectionName, 4);
    await db.createHybridCollection(orphanCollectionName, 4);
    await db.seedDocuments(familyCollectionName, [{
        id: INDEX_COMPLETION_MARKER_DOC_ID,
        vector: [0, 0, 0, 0],
        content: 'legacy marker',
        relativePath: '.__satori__/index_completion_marker.json',
        startLine: 0,
        endLine: 0,
        fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
        metadata: {
            kind: 'satori_index_completion_v1',
            codebasePath,
        },
    }]);
    await db.seedDocuments(orphanCollectionName, [{
        id: INDEX_COMPLETION_MARKER_DOC_ID,
        vector: [0, 0, 0, 0],
        content: 'orphan invalid marker',
        relativePath: '.__satori__/index_completion_marker.json',
        startLine: 0,
        endLine: 0,
        fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
        metadata: {
            ...buildMarker(),
            indexedFiles: 'invalid',
        },
    }]);

    const result = await validateCompletionProof({
        codebasePath,
        getIndexCompletionMarker: getCompletionMarkerReader(context),
    });

    assert.deepEqual(result, {
        outcome: 'stale_local',
        reason: 'requires_reindex',
    });
});

test('Context-backed completion proof does not let a valid unbound staged v3 mask the base legacy marker', async () => {
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/completion-orphan-valid-v2';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const orphanCollectionName = `${familyCollectionName}__gen_orphan_valid`;
    await db.createHybridCollection(familyCollectionName, 4);
    await db.createHybridCollection(orphanCollectionName, 4);
    await db.seedDocuments(familyCollectionName, [{
        id: INDEX_COMPLETION_MARKER_DOC_ID,
        vector: [0, 0, 0, 0],
        content: 'legacy marker',
        relativePath: '.__satori__/index_completion_marker.json',
        startLine: 0,
        endLine: 0,
        fileExtension: INDEX_COMPLETION_MARKER_FILE_EXTENSION,
        metadata: {
            kind: 'satori_index_completion_v1',
            codebasePath,
        },
    }]);
    await db.seedDocuments(orphanCollectionName, [
        buildChunkDoc('orphan_chunk', 'src/orphan.ts'),
        buildMarkerDoc({
            ...buildMarker(ORPHAN_POLICY_HASH),
            completedAt: '2026-07-12T00:00:00.000Z',
            runId: 'run_orphan_valid',
        }),
    ]);

    const result = await validateCompletionProof({
        codebasePath,
        getIndexCompletionMarker: getCompletionMarkerReader(context),
    });

    assert.deepEqual(result, {
        outcome: 'stale_local',
        reason: 'requires_reindex',
    });
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
    await db.seedDocuments(olderCollectionName, [
        buildChunkDoc('older_chunk', 'src/older.ts'),
        buildMarkerDoc({
            ...buildMarker(),
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: 'run_older'
        })
    ]);

    await db.createHybridCollection(newerCollectionName, 4);
    await db.seedDocuments(newerCollectionName, [
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

test('Context-backed validation prefers a base v3 generation over a newer unbound staged v3', async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-completion-bound-base-'));
    const { db } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
        indexPolicyStateRoot: stateRoot,
    });
    const codebasePath = '/repo/completion-bound-base-v2';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const stagedCollectionName = `${familyCollectionName}__gen_newer_unbound`;
    await db.createHybridCollection(familyCollectionName, 4);
    await db.createHybridCollection(stagedCollectionName, 4);
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
    await db.seedDocuments(familyCollectionName, [
        buildChunkDoc('base_chunk', 'src/base.ts'),
        buildMarkerDoc({
            ...buildMarker(policy.policyHash),
            codebasePath,
            runId: 'run_base_authoritative',
        }),
    ]);
    await db.seedDocuments(stagedCollectionName, [
        buildChunkDoc('staged_chunk', 'src/staged.ts'),
        buildMarkerDoc({
            ...buildMarker(STAGED_POLICY_HASH),
            completedAt: '2026-07-12T00:00:00.000Z',
            runId: 'run_staged_newer',
        }),
    ]);
    context.publishResolvedIndexPolicy(policy, {
        collectionName: familyCollectionName,
        navigation: { status: 'not_bound' },
    });

    try {
        const evidence = await context.getIndexCompletionMarkerForValidation(codebasePath);

        assert.equal(evidence.status, 'valid_v3');
        assert.equal(evidence.status === 'valid_v3' ? evidence.marker.runId : null, 'run_base_authoritative');
    } finally {
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test('Context-backed completion proof reports runtime policy incompatibility after profile drift', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-completion-profile-drift-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const { db } = createInMemoryVectorDb();
        const context = new Context({
            embedding: new FakeEmbedding(),
            vectorDatabase: db,
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);
        fs.writeFileSync(
            path.join(codebasePath, 'satori.toml'),
            '[index]\nprofile = "minimal"\n',
            'utf8',
        );

        const result = await validateCompletionProof({
            codebasePath,
            getIndexCompletionMarker: getCompletionMarkerReader(context),
        });

        assert.deepEqual(result, {
            outcome: 'policy_incompatible',
            reason: 'runtime_policy_incompatible',
        });
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
    await db.seedDocuments(provenCollectionName, [
        buildChunkDoc('proven_chunk', 'src/proven.ts'),
        buildMarkerDoc({
            ...buildMarker(),
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: 'run_proven'
        })
    ]);

    await db.createHybridCollection(markerOnlyCollectionName, 4);
    await db.seedDocuments(markerOnlyCollectionName, [
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

test('Context semanticSearch forwards backend-neutral filters without storage syntax', async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-completion-filter-policy-'));
    t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
    const { db, getLastDenseRequest, getLastLexicalRequest } = createInMemoryVectorDb();
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
        indexPolicyStateRoot: stateRoot,
    });
    const codebasePath = '/repo/app';
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createHybridCollection(collectionName, 4);

    await db.seedDocuments(collectionName, [
        buildChunkDoc('filter_chunk', 'src/runtime.ts'),
        buildMarkerDoc(buildMarker(policy.policyHash))
    ]);
    context.publishResolvedIndexPolicy(policy, {
        collectionName,
        navigation: { status: 'not_bound' },
    });

    await context.semanticSearch({
        codebasePath,
        query: 'runtime symbol',
        topK: 8,
        retrievalMode: 'hybrid',
        filter: {
            kind: 'in',
            field: 'fileExtension',
            values: ['.ts'],
        },
        scorePolicy: { kind: 'topk_only' }
    });

    const expectedFilter = {
        kind: 'in',
        field: 'fileExtension',
        values: ['.ts'],
    } as const;
    assert.deepEqual(getLastDenseRequest()?.filter, expectedFilter);
    assert.deepEqual(getLastLexicalRequest()?.filter, expectedFilter);
});

test('Context semanticSearch uses the active staged generation when the base family collection is absent', async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-completion-active-policy-'));
    t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
    const hybridResults: VectorCandidate[] = [{
        document: buildChunkDoc('chunk_runtime', 'src/runtime.ts'),
        score: 0.91
    }];
    const { db, getLastDenseCollectionName, getLastLexicalCollectionName } = createInMemoryVectorDb({ hybridResults });
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
        indexPolicyStateRoot: stateRoot,
    });
    const codebasePath = '/repo/app';
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const stagedCollectionName = `${familyCollectionName}__gen_ready`;

    await db.createHybridCollection(stagedCollectionName, 4);
    await db.seedDocuments(stagedCollectionName, [
        buildChunkDoc('ready_chunk', 'src/runtime.ts'),
        buildMarkerDoc({
            ...buildMarker(policy.policyHash),
            completedAt: '2026-02-28T23:57:10.000Z',
            runId: 'run_ready'
        })
    ]);
    context.publishResolvedIndexPolicy(policy, {
        collectionName: stagedCollectionName,
        navigation: { status: 'not_bound' },
    });

    const results = await context.semanticSearch({
        codebasePath,
        query: 'runtime symbol',
        topK: 8,
        retrievalMode: 'hybrid',
        scorePolicy: { kind: 'topk_only' }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.relativePath, 'src/runtime.ts');
    assert.equal(getLastDenseCollectionName(), stagedCollectionName);
    assert.equal(getLastLexicalCollectionName(), stagedCollectionName);
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
    const hybridResults: VectorCandidate[] = [{
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
    const { db, getLastDenseRequest, getLastLexicalRequest } = createInMemoryVectorDb({ hybridResults });
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createHybridCollection(collectionName, 4);
    await db.seedDocuments(collectionName, [
        buildChunkDoc('hybrid_chunk', 'src/runtime.ts'),
        buildMarkerDoc(buildMarker(policy.policyHash))
    ]);
    context.publishResolvedIndexPolicy(policy, {
        collectionName,
        navigation: { status: 'not_bound' },
    });

    const results = await context.semanticSearch({
        codebasePath,
        query: 'hurst',
        topK: 8,
        retrievalMode: 'hybrid',
        scorePolicy: { kind: 'topk_only' }
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.relativePath, 'src/python/core/regime/hurst_gate.py');
    assert.equal(getLastDenseRequest()?.minimumScore, undefined);
    assert.equal(getLastDenseRequest()?.limit, 8);
    assert.equal(getLastLexicalRequest()?.limit, 8);
});

test('Context semanticSearch request preserves dense thresholds and returns dense score metadata', async () => {
    const vectorResults: VectorCandidate[] = [
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
    const { db, getLastDenseRequest } = createInMemoryVectorDb({ vectorResults });
    const context = new Context({
        embedding: new FakeEmbedding(),
        vectorDatabase: db,
    });
    const codebasePath = '/repo/app';
    const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
    const collectionName = context.resolveCollectionName(codebasePath);
    await db.createCollection(collectionName, 4);
    await db.seedDocuments(collectionName, [
        buildChunkDoc('dense_chunk', 'src/core/high.ts'),
        buildMarkerDoc(buildMarker(policy.policyHash))
    ]);
    context.publishResolvedIndexPolicy(policy, {
        collectionName,
        navigation: { status: 'not_bound' },
    });

    const request: SemanticSearchRequest = {
        codebasePath,
        query: 'dense query',
        topK: 8,
        retrievalMode: 'dense',
        scorePolicy: { kind: 'dense_similarity_min', min: 0.6 }
    };

    const results = await context.semanticSearch(request);

    assert.equal(getLastDenseRequest()?.minimumScore, 0.6);
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
