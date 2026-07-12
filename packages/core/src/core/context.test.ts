import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from './context';
import type { RepairProof } from './repair-proof';
import type { RelationshipAnalysisEvidence } from '../relationships';
import { resolveNavigationSqlitePath, SQLiteNavigationStore, validateNavigationStoreParity } from '../navigation';
import { clearSymbolRegistrySidecar, readRelationshipSidecar, readSymbolRegistrySidecar } from '../symbols';
import type { SymbolRecord, SymbolRegistryManifestFile } from '../symbols';
import { Embedding } from '../embedding';
import type { EmbeddingVector } from '../embedding';
import {
    createLanguageAnalysisService,
    LANGUAGE_PARSER_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
    type CodeChunk,
    type LanguageAnalysisInput,
    type LanguageAnalysisPort,
} from '../language-analysis';
import type {
    CollectionDetails,
    HybridSearchOptions,
    HybridSearchRequest,
    HybridSearchResult,
    IndexCompletionFingerprint,
    SearchOptions,
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
} from '../vectordb';
import {
    INDEX_COMPLETION_MARKER_DOC_ID,
    INDEX_COMPLETION_MARKER_FILE_EXTENSION as COMPLETION_MARKER_EXTENSION,
} from '../vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    async detectDimension(): Promise<number> {
        return 4;
    }

    async embed(text: string): Promise<EmbeddingVector> {
        return {
            vector: [text.length % 3, text.length % 5, text.length % 7, 1],
            dimension: 4,
        };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embed(text)));
    }

    getDimension(): number {
        return 4;
    }

    getProvider(): string {
        return 'TestEmbedding';
    }
}

class NamedTestEmbedding extends TestEmbedding {
    constructor(private readonly providerName: string) {
        super();
    }

    getProvider(): string {
        return this.providerName;
    }
}

class RecordingAnalyzer implements LanguageAnalysisPort {
    public readonly analyzeCalls: string[] = [];
    private readonly delegate = createLanguageAnalysisService({ chunkSize: 2500, chunkOverlap: 300 });

    async analyze(input: LanguageAnalysisInput) {
        this.analyzeCalls.push(input.relativePath);
        return this.delegate.analyze(input);
    }

    reset(): void {
        this.analyzeCalls.length = 0;
    }

    getDescription(): string { return this.delegate.getDescription(); }

    getStrategyForLanguage(language: string) { return this.delegate.getStrategyForLanguage(language); }
}

class ThrowingAnalyzer implements LanguageAnalysisPort {
    async analyze(): Promise<never> {
        throw new Error('analysis failed after marker cleanup');
    }

    getDescription(): string { return 'throwing analyzer'; }

    getStrategyForLanguage() { return { backend: 'bounded_text' as const, structural: false }; }
}

type ProcessFileListResult = {
    processedFiles: number;
    totalChunks: number;
    status: 'completed' | 'limit_reached';
    symbolRecords: SymbolRecord[];
    symbolManifestFiles: SymbolRegistryManifestFile[];
};

type ContextWithProcessFileList = {
    processFileList: (...args: unknown[]) => Promise<ProcessFileListResult>;
};

type ContextWithDeleteFileChunks = {
    deleteFileChunks: (collectionName: string, relativePath: string) => Promise<void>;
};

type ContextWithExpectedChunks = {
    getExpectedChunksAndSymbols: (...args: unknown[]) => Promise<unknown>;
};

type ContextWithNavigationArtifactBuilder = {
    buildNavigationArtifactsForFiles: (...args: unknown[]) => Promise<{
        symbolManifestFiles: SymbolRegistryManifestFile[];
    }>;
};

type ContextWithNavigationPublisher = {
    writeSymbolRegistryForCompletedIndex(
        codebasePath: string,
        symbolRecords: SymbolRecord[],
        symbolManifestFiles: SymbolRegistryManifestFile[],
        assertMutationCurrent?: () => void,
        suppliedAnalysisByFile?: Map<string, RelationshipAnalysisEvidence>,
        publishMutation?: (publish: () => void) => void,
    ): Promise<void>;
};

type ContextWithProcessChunkBatch = {
    processChunkBatch(
        chunks: Array<{ chunk: CodeChunk; relativePath: string; fileChunkIndex: number }>,
        codebasePath: string,
        collectionName: string,
        assertMutationCurrent?: () => void,
    ): Promise<void>;
};

class InMemoryVectorDatabase implements VectorDatabase {
    readonly collections = new Map<string, Map<string, VectorDocument>>();
    readonly queryCalls: Array<{ collectionName: string; filter: string; outputFields: string[] }> = [];
    readonly mutationCalls: Array<
        'payload_insert' | 'payload_delete' | 'marker_insert' | 'marker_delete'
    > = [];

    private listDocuments(collectionName: string, filterExpr?: string): VectorDocument[] {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            return [];
        }
        let documents = Array.from(collection.values());
        if ((filterExpr || '').includes('fileExtension != ".satori_meta"')) {
            documents = documents.filter((document) => document.fileExtension !== '.satori_meta');
        }
        const idMatch = /^id == "(.+)"$/.exec(filterExpr || '');
        if (idMatch?.[1]) {
            documents = documents.filter((document) => document.id === idMatch[1]);
        }
        const idInMatch = /^id in \[(.*)\]$/.exec(filterExpr || '');
        if (idInMatch?.[1]) {
            const ids = new Set(
                [...idInMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
                    .map((match) => match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
            );
            documents = documents.filter((document) => ids.has(document.id));
        }
        const relativePathMatch = /^relativePath == "(.+)"$/.exec(filterExpr || '');
        if (relativePathMatch?.[1]) {
            documents = documents.filter((document) => document.relativePath === relativePathMatch[1]);
        }
        return documents;
    }

    async createCollection(collectionName: string): Promise<void> {
        this.collections.set(collectionName, new Map());
    }

    async createHybridCollection(collectionName: string): Promise<void> {
        this.collections.set(collectionName, new Map());
    }

    async dropCollection(collectionName: string): Promise<void> {
        this.collections.delete(collectionName);
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        return this.collections.has(collectionName);
    }

    async listCollections(): Promise<string[]> {
        return Array.from(this.collections.keys());
    }

    async listCollectionDetails(): Promise<CollectionDetails[]> {
        return Array.from(this.collections.keys()).map((name) => ({ name }));
    }

    async insert(collectionName: string, documents: VectorDocument[]): Promise<void> {
        this.mutationCalls.push(
            documents.every((document) => document.id === INDEX_COMPLETION_MARKER_DOC_ID)
                ? 'marker_insert'
                : 'payload_insert',
        );
        const collection = this.collections.get(collectionName);
        if (!collection) {
            throw new Error(`Collection not found: ${collectionName}`);
        }
        for (const document of documents) {
            collection.set(document.id, document);
        }
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void> {
        await this.insert(collectionName, documents);
    }

    async search(collectionName: string, _queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        return this.listDocuments(collectionName, options?.filterExpr)
            .slice(0, options?.topK ?? 1000)
            .map((document, index) => ({ document, score: 1 - (index / 1000) }));
    }

    async hybridSearch(collectionName: string, _searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]> {
        return this.listDocuments(collectionName, options?.filterExpr)
            .slice(0, options?.limit ?? 1000)
            .map((document, index) => ({ document, score: 1 - (index / 1000) }));
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        this.mutationCalls.push(
            ids.every((id) => id === INDEX_COMPLETION_MARKER_DOC_ID)
                ? 'marker_delete'
                : 'payload_delete',
        );
        const collection = this.collections.get(collectionName);
        for (const id of ids) {
            collection?.delete(id);
        }
    }

    async query(collectionName: string, _filter: string, outputFields: string[], limit: number = 1000): Promise<Record<string, unknown>[]> {
        this.queryCalls.push({ collectionName, filter: _filter, outputFields });
        return this.listDocuments(collectionName, _filter).slice(0, limit).map((document) => {
            const row: Record<string, unknown> = {};
            for (const field of outputFields) {
                row[field] = (document as unknown as Record<string, unknown>)[field];
            }
            return row;
        });
    }

    async checkCollectionLimit(): Promise<boolean> {
        return true;
    }
}

class MarkerObservingVectorDatabase extends InMemoryVectorDatabase {
    readonly payloadMutationMarkerPresence: boolean[] = [];

    async delete(collectionName: string, ids: string[]): Promise<void> {
        if (ids.some((id) => id !== INDEX_COMPLETION_MARKER_DOC_ID)) {
            this.payloadMutationMarkerPresence.push(
                this.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID) === true,
            );
        }
        await super.delete(collectionName, ids);
    }
}

class CountingTestEmbedding extends TestEmbedding {
    embedCalls = 0;

    async embed(text: string): Promise<EmbeddingVector> {
        this.embedCalls++;
        return super.embed(text);
    }
}

function testIndexFingerprint(
    overrides: Partial<IndexCompletionFingerprint> = {},
): IndexCompletionFingerprint {
    return {
        embeddingProvider: 'TestEmbedding',
        embeddingModel: 'TestEmbedding',
        embeddingDimension: 4,
        vectorStoreProvider: 'Milvus',
        schemaVersion: 'hybrid_v3',
        parserVersion: LANGUAGE_PARSER_VERSION,
        extractorVersion: SYMBOL_EXTRACTOR_VERSION,
        relationshipVersion: RELATIONSHIP_BUILDER_VERSION,
        ...overrides,
    };
}

test('Context blocks vector insertion when the mutation guard fails after embedding', async () => {
    const vectorDatabase = new InMemoryVectorDatabase();
    const context = new Context({
        embedding: new TestEmbedding(),
        vectorDatabase,
    }) as unknown as ContextWithProcessChunkBatch;
    const chunk: CodeChunk = {
        content: 'export const value = 1;',
        metadata: {
            startLine: 1,
            endLine: 1,
            language: 'typescript',
            filePath: '/repo/value.ts',
        },
    };

    await assert.rejects(
        () => context.processChunkBatch([{ chunk, relativePath: 'value.ts', fileChunkIndex: 0 }], '/repo', 'chunks', () => {
            throw new Error('mutation lease lost');
        }),
        /mutation lease lost/,
    );

    assert.deepEqual(vectorDatabase.mutationCalls, []);
});

test('Context blocks completion marker insertion when the mutation guard fails', async () => {
    const vectorDatabase = new InMemoryVectorDatabase();
    const context = new Context({
        embedding: new TestEmbedding(),
        vectorDatabase,
    });
    const codebasePath = '/repo';
    const collectionName = context.resolveCollectionName(codebasePath);
    await vectorDatabase.createHybridCollection(collectionName);

    await assert.rejects(
        () => context.writeIndexCompletionMarker(codebasePath, {
            kind: 'satori_index_completion_v1',
            codebasePath,
            fingerprint: testIndexFingerprint(),
            indexedFiles: 1,
            totalChunks: 1,
            completedAt: '2026-07-10T00:00:00.000Z',
            runId: 'guard-test',
        }, undefined, () => {
            throw new Error('mutation lease lost');
        }),
        /mutation lease lost/,
    );

    assert.deepEqual(vectorDatabase.mutationCalls, []);
});

test('Context.deleteFileChunks escapes relative paths as Milvus string literals', async () => {
    const vectorDatabase = new InMemoryVectorDatabase();
    const context = new Context({
        embedding: new TestEmbedding(),
        vectorDatabase,
    }) as unknown as ContextWithDeleteFileChunks;

    await context.deleteFileChunks('chunks', 'src/quote"and\\slash.ts');

    assert.deepEqual(vectorDatabase.queryCalls, [{
        collectionName: 'chunks',
        filter: 'relativePath == "src/quote\\"and\\\\slash.ts"',
        outputFields: ['id'],
    }]);
});

async function readTrustedFingerprint(context: Context, codebasePath: string): Promise<IndexCompletionFingerprint> {
    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(marker);
    return marker.fingerprint;
}

function verifiedSnapshotEvidence(fingerprint: IndexCompletionFingerprint) {
    return {
        status: 'verified' as const,
        basis: 'verified_snapshot_fingerprint',
        fingerprint,
    };
}

function buildCompletionMarkerDoc(input: {
    codebasePath: string;
    runId: string;
    totalChunks?: number;
    indexStatus?: 'completed' | 'limit_reached';
}): VectorDocument {
    return {
        id: INDEX_COMPLETION_MARKER_DOC_ID,
        vector: [0, 0, 0, 0],
        content: 'marker',
        relativePath: '.__satori__/index_completion_marker.json',
        startLine: 0,
        endLine: 0,
        fileExtension: COMPLETION_MARKER_EXTENSION,
        metadata: {
            kind: 'satori_index_completion_v1',
            codebasePath: input.codebasePath,
            fingerprint: testIndexFingerprint(),
            indexedFiles: 1,
            totalChunks: input.totalChunks ?? 1,
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: input.runId,
            indexStatus: input.indexStatus ?? 'completed',
        },
    };
}

function buildChunkDoc(id: string, relativePath = 'src/runtime.ts'): VectorDocument {
    return {
        id,
        vector: [0.1, 0.2, 0.3, 0.4],
        content: `chunk:${id}`,
        relativePath,
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        metadata: {},
    };
}

test('Context.semanticSearch does not embed or search an unproven collection', async () => {
    const vectorDatabase = new InMemoryVectorDatabase();
    const embedding = new CountingTestEmbedding();
    const context = new Context({ embedding, vectorDatabase });
    const codebasePath = '/repo/unproven';
    const collectionName = context.resolveCollectionName(codebasePath);
    await vectorDatabase.createHybridCollection(collectionName);
    await vectorDatabase.insertHybrid(collectionName, [buildChunkDoc('unproven')]);

    const results = await context.semanticSearch({
        codebasePath,
        query: 'runtime',
        retrievalMode: 'hybrid',
        scorePolicy: { kind: 'topk_only' },
    });

    assert.deepEqual(results, []);
    assert.equal(embedding.embedCalls, 0);
});

test('Context active collection resolution requires exact completion-marker payload counts', async (t) => {
    const cases = [
        { label: 'missing payload row', markerChunks: 2, payloadChunks: 1, indexStatus: 'completed' as const },
        { label: 'unexpected payload row', markerChunks: 1, payloadChunks: 2, indexStatus: 'completed' as const },
        { label: 'partial marker mismatch', markerChunks: 2, payloadChunks: 1, indexStatus: 'limit_reached' as const },
        { label: 'zero marker with stale payload', markerChunks: 0, payloadChunks: 1, indexStatus: 'completed' as const },
    ];

    for (const input of cases) {
        await t.test(input.label, async () => {
            const vectorDatabase = new InMemoryVectorDatabase();
            const context = new Context({ embedding: new TestEmbedding(), vectorDatabase });
            const codebasePath = `/repo/payload-count/${input.label.replace(/ /g, '-')}`;
            const collectionName = context.resolveCollectionName(codebasePath);
            await vectorDatabase.createHybridCollection(collectionName);
            await vectorDatabase.insertHybrid(collectionName, [
                ...Array.from({ length: input.payloadChunks }, (_, index) => buildChunkDoc(`payload-${index}`)),
                buildCompletionMarkerDoc({
                    codebasePath,
                    runId: `run-${input.label}`,
                    totalChunks: input.markerChunks,
                    indexStatus: input.indexStatus,
                }),
            ]);

            assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
        });
    }
});

test('Context active collection resolution rejects runtime fingerprint mismatches', async (t) => {
    const mismatches: Array<[string, Partial<IndexCompletionFingerprint>]> = [
        ['embedding dimension', { embeddingDimension: 8 }],
        ['schema version', { schemaVersion: 'dense_v3' }],
        ['parser version', { parserVersion: 'parser-mismatch' }],
        ['relationship version', { relationshipVersion: 'relationship-mismatch' }],
    ];

    for (const [label, fingerprintOverride] of mismatches) {
        await t.test(label, async () => {
            const vectorDatabase = new InMemoryVectorDatabase();
            const context = new Context({ embedding: new TestEmbedding(), vectorDatabase });
            const codebasePath = `/repo/fingerprint/${label.replace(/ /g, '-')}`;
            const collectionName = context.resolveCollectionName(codebasePath);
            await vectorDatabase.createHybridCollection(collectionName);
            await vectorDatabase.insertHybrid(collectionName, [buildChunkDoc('payload')]);
            await context.writeIndexCompletionMarker(codebasePath, {
                kind: 'satori_index_completion_v1',
                codebasePath,
                fingerprint: testIndexFingerprint(fingerprintOverride),
                indexedFiles: 1,
                totalChunks: 1,
                completedAt: '2026-07-12T00:00:00.000Z',
                runId: `mismatch-${label}`,
                indexStatus: 'completed',
            }, collectionName);

            assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
        });
    }
});

test('Context.indexCodebase replaces stale payload for deleted and zero-file repositories', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-full-reconcile-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const firstPath = path.join(codebasePath, 'first.ts');
    const secondPath = path.join(codebasePath, 'second.ts');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(firstPath, 'export const first = true;\n', 'utf8');
        fs.writeFileSync(secondPath, 'export const second = true;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.indexCodebase(codebasePath);
        fs.rmSync(secondPath);
        await context.indexCodebase(codebasePath, undefined, false);

        const collectionName = context.resolveCollectionName(codebasePath);
        const afterDeletion = Array.from(vectorDatabase.collections.get(collectionName)?.values() ?? [])
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION);
        assert.equal(afterDeletion.some((document) => document.relativePath === 'second.ts'), false);
        assert.equal(afterDeletion.some((document) => document.relativePath === 'first.ts'), true);

        fs.rmSync(firstPath);
        await context.indexCodebase(codebasePath, undefined, false);
        const afterZeroFiles = Array.from(vectorDatabase.collections.get(collectionName)?.values() ?? [])
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION);
        assert.deepEqual(afterZeroFiles, []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange withdraws and republishes completion proof by default', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-default-marker-maintenance-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'runtime.ts');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, 'export const runtime = 1;\n', 'utf8');
        const vectorDatabase = new MarkerObservingVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const previousMarker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(previousMarker);

        fs.writeFileSync(sourcePath, 'export const runtime = 2;\n', 'utf8');
        await context.reindexByChange(codebasePath);

        const nextMarker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(nextMarker);
        assert.notEqual(nextMarker.runId, previousMarker.runId);
        assert.deepEqual(vectorDatabase.payloadMutationMarkerPresence, [false]);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange publishes completion proof only after the synchronizer checkpoint', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-marker-after-checkpoint-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'runtime.ts');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, 'export const runtime = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const updatedContent = 'export const runtime = 2;\n';
        const expectedHash = crypto.createHash('sha256').update(updatedContent, 'utf8').digest('hex');
        const insertHybrid = vectorDatabase.insertHybrid.bind(vectorDatabase);
        let observedMarkerPublication = false;
        vectorDatabase.insertHybrid = async (collectionName, documents) => {
            if (documents.some((document) => document.id === INDEX_COMPLETION_MARKER_DOC_ID)) {
                const synchronizer = context.getActiveSynchronizers().get(context.resolveCollectionName(codebasePath));
                assert.equal(synchronizer?.getFileHash('runtime.ts'), expectedHash);
                observedMarkerPublication = true;
            }
            await insertHybrid(collectionName, documents);
        };

        fs.writeFileSync(sourcePath, updatedContent, 'utf8');
        await context.reindexByChange(codebasePath);

        assert.equal(observedMarkerPublication, true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange refuses publication when exact post-sync payload proof fails', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-exact-proof-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'runtime.ts');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, 'export const runtime = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const contextWithProcessFileList = context as unknown as ContextWithProcessFileList;
        const originalProcessFileList = contextWithProcessFileList.processFileList.bind(contextWithProcessFileList);
        contextWithProcessFileList.processFileList = async (...args: unknown[]) => {
            const result = await originalProcessFileList(...args);
            const collectionName = context.resolveCollectionName(codebasePath);
            await vectorDatabase.insertHybrid(collectionName, [buildChunkDoc('unexpected-post-sync-payload')]);
            return result;
        };

        fs.writeFileSync(sourcePath, 'export const runtime = 2;\n', 'utf8');
        await assert.rejects(
            () => context.reindexByChange(codebasePath),
            /expected \d+ chunks but observed \d+/,
        );
        assert.equal(await context.getIndexCompletionMarker(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange removes stale payload for a newly added source path', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-added-stale-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const runtimePath = path.join(codebasePath, 'runtime.ts');
    const addedPath = path.join(codebasePath, 'future.ts');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(runtimePath, 'export const runtime = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const collectionName = context.resolveCollectionName(codebasePath);
        const previousMarker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(previousMarker);
        await vectorDatabase.insertHybrid(collectionName, [
            buildChunkDoc('stale-future-row', 'future.ts'),
        ]);
        await context.writeIndexCompletionMarker(codebasePath, {
            ...previousMarker,
            totalChunks: previousMarker.totalChunks + 1,
            runId: 'marker-with-stale-future-row',
        }, collectionName);

        fs.writeFileSync(addedPath, 'export const future = true;\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);

        assert.equal(result.added, 1);
        assert.ok(await context.getIndexCompletionMarker(codebasePath));
        assert.equal(
            vectorDatabase.collections.get(collectionName)?.has('stale-future-row'),
            false,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context chunk identity distinguishes identical same-line chunks', async () => {
    const vectorDatabase = new InMemoryVectorDatabase();
    const context = new Context({
        embedding: new TestEmbedding(),
        vectorDatabase,
    }) as unknown as ContextWithProcessChunkBatch;
    await vectorDatabase.createHybridCollection('chunks');
    const chunk: CodeChunk = {
        content: 'same();',
        metadata: {
            startLine: 1,
            endLine: 1,
            language: 'typescript',
            filePath: 'generated.ts',
        },
    };

    await context.processChunkBatch([
        { chunk: structuredClone(chunk), relativePath: 'generated.ts', fileChunkIndex: 0 },
        { chunk: structuredClone(chunk), relativePath: 'generated.ts', fileChunkIndex: 1 },
    ], '/repo', 'chunks');

    assert.equal(vectorDatabase.collections.get('chunks')?.size, 2);
});

test('Context.resolveStagedCollectionName normalizes staged generation ids to backend-safe underscores', () => {
    const context = new Context({
        embedding: new TestEmbedding(),
        vectorDatabase: new InMemoryVectorDatabase(),
    });

    const stagedName = context.resolveStagedCollectionName(
        '/home/hamza/repo/promptready_extension',
        'run_f1a58f3d-6096-41e3-971c-870112e40210',
    );

    assert.match(stagedName, /^hybrid_code_chunks_[0-9a-f]{8}__gen_run_[A-Za-z0-9_]+$/);
    assert.equal(stagedName.includes('-'), false);
    assert.equal(
        stagedName.endsWith('run_f1a58f3d_6096_41e3_971c_870112e40210'),
        true,
    );
});

test('Context.pruneUnprovenStagedCollectionFamily removes failed staged generations only', async () => {
    const vectorDatabase = new InMemoryVectorDatabase();
    const context = new Context({
        embedding: new TestEmbedding(),
        vectorDatabase,
    });
    const codebasePath = '/repo/app';
    const familyCollectionName = context.resolveCollectionName(codebasePath);
    const failedStagedCollectionName = `${familyCollectionName}__gen_failed`;
    const markerOnlyCollectionName = `${familyCollectionName}__gen_marker_only`;
    const inProgressStagedCollectionName = `${familyCollectionName}__gen_in_progress`;
    const provenStagedCollectionName = `${familyCollectionName}__gen_ready`;

    await vectorDatabase.createHybridCollection(familyCollectionName);
    await vectorDatabase.createHybridCollection(failedStagedCollectionName);
    await vectorDatabase.createHybridCollection(markerOnlyCollectionName);
    await vectorDatabase.insertHybrid(markerOnlyCollectionName, [
        buildCompletionMarkerDoc({ codebasePath, runId: 'run_marker_only', totalChunks: 5 }),
    ]);
    await vectorDatabase.createHybridCollection(inProgressStagedCollectionName);
    await vectorDatabase.insertHybrid(inProgressStagedCollectionName, [
        buildChunkDoc('in_progress_chunk'),
    ]);
    await vectorDatabase.createHybridCollection(provenStagedCollectionName);
    await vectorDatabase.insertHybrid(provenStagedCollectionName, [
        buildChunkDoc('ready_chunk'),
        buildCompletionMarkerDoc({ codebasePath, runId: 'run_ready' }),
    ]);

    const dropped = await context.pruneUnprovenStagedCollectionFamily(codebasePath);

    assert.deepEqual(dropped, [failedStagedCollectionName, markerOnlyCollectionName].sort());
    assert.deepEqual(
        (await vectorDatabase.listCollections()).sort(),
        [familyCollectionName, inProgressStagedCollectionName, provenStagedCollectionName].sort(),
    );
});

test('Context.indexCodebase clears stale completion marker before rebuilding navigation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-stale-marker-'));
    try {
        const repoPath = path.join(tempRoot, 'repo');
        await fs.promises.mkdir(repoPath, { recursive: true });
        await fs.promises.writeFile(path.join(repoPath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            languageAnalyzer: new ThrowingAnalyzer(),
        });
        const collectionName = context.resolveCollectionName(repoPath);

        await vectorDatabase.createHybridCollection(collectionName);
        await vectorDatabase.insertHybrid(collectionName, [buildChunkDoc('old_ready_chunk')]);
        await context.writeIndexCompletionMarker(repoPath, {
            kind: 'satori_index_completion_v1',
            codebasePath: path.resolve(repoPath),
            fingerprint: testIndexFingerprint(),
            indexedFiles: 1,
            totalChunks: 1,
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: 'old_ready_marker',
        });
        assert.ok(await context.getIndexCompletionMarker(repoPath));

        await assert.rejects(
            () => context.indexCodebase(repoPath),
            /analysis failed after marker cleanup/,
        );
        assert.equal(await context.getIndexCompletionMarker(repoPath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context fails clearly without OPENAI_API_KEY when no embedding is provided', () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
        assert.throws(
            () => new Context({ vectorDatabase: new InMemoryVectorDatabase() }),
            /OPENAI_API_KEY is required/
        );
    } finally {
        if (previousOpenAiApiKey === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else {
            process.env.OPENAI_API_KEY = previousOpenAiApiKey;
        }
    }
});

test('Context.getIgnorePatternsFromFile preserves gitignore-significant spaces', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ignore-parser-'));
    const ignorePath = path.join(tempDir, '.gitignore');

    try {
        fs.writeFileSync(
            ignorePath,
            [
                '# comment',
                '',
                'foo\\ ',
                ' leading.ts',
                ' #literal-leading-space-comment.ts',
                'bar.ts',
            ].join('\r\n'),
            'utf8'
        );

        const patterns = await Context.getIgnorePatternsFromFile(ignorePath);

        assert.deepEqual(patterns, [
            'foo\\ ',
            ' leading.ts',
            ' #literal-leading-space-comment.ts',
            'bar.ts',
        ]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Context.indexCodebase writes a compatible symbol registry sidecar for completed full indexes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, [
            'export function normalize(input: string) {',
            '  return input.trim();',
            '}',
            '',
            'export class AuthService {',
            '  async login(input: string) {',
            '    return normalize(input);',
            '  }',
            '}',
        ].join('\n'), 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        const result = await context.indexCodebase(codebasePath);
        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.status, 'completed');
        assert.equal(sidecar.status, 'ok');
        assert.equal(sidecar.registry?.manifest.files.length, 1);
        assert.equal(sidecar.registry?.symbolsByFile.get('src/auth.ts')?.some((symbol) => symbol.kind === 'file'), true);
        assert.equal(sidecar.registry?.symbolsByLabel.get('class AuthService')?.[0]?.qualifiedName, 'AuthService');

        const documents = Array.from(vectorDatabase.collections.values())
            .flatMap((collection) => Array.from(collection.values()))
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION);
        assert.ok(documents.length > 0);
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolKey === 'string'));
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolInstanceId === 'string'));
        assert.ok(documents.some((document) => document.metadata.symbolKind === 'method'));

        assert.ok(sidecar.manifestHash);
        const relationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: codebasePath,
            expectedSymbolRegistryManifestHash: sidecar.manifestHash,
        });

        assert.equal(relationships.status, 'ok');
        assert.deepEqual([...new Set(relationships.records?.map((record) => record.type))].sort(), ['CALLS', 'EXPORTS']);
        const callRecord = relationships.records?.find((record) => record.type === 'CALLS');
        assert.equal(callRecord?.file, 'src/auth.ts');
        assert.equal(callRecord?.confidence, 'high');
        assert.equal(fs.existsSync(resolveNavigationSqlitePath(stateRoot, codebasePath)), true);

        const parity = await validateNavigationStoreParity({
            stateRoot,
            normalizedRootPath: codebasePath,
            candidateStore: new SQLiteNavigationStore(),
        });
        assert.equal(parity.ok, true);
        assert.deepEqual(parity.mismatches, []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context navigation publication fails closed when relationship evidence cannot be completed', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-navigation-evidence-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const relativePath = 'src/auth.ts';
    const content = 'export const auth = true;\n';

    try {
        fs.mkdirSync(path.join(codebasePath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(codebasePath, relativePath), content, 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            languageAnalyzer: new ThrowingAnalyzer(),
            symbolRegistryStateRoot: stateRoot,
        });

        await assert.rejects(
            () => (context as unknown as ContextWithNavigationPublisher).writeSymbolRegistryForCompletedIndex(
                codebasePath,
                [],
                [{
                    path: relativePath,
                    hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
                    language: 'typescript',
                    symbolCount: 0,
                }],
                undefined,
                new Map(),
            ),
            /analysis failed after marker cleanup/,
        );

        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(sidecar.status, 'missing');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context advances a complete navigation generation through the supplied mutation publisher', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-navigation-publisher-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const relativePath = 'src/auth.ts';

    try {
        fs.mkdirSync(path.join(codebasePath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(codebasePath, relativePath), 'export const auth = true;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });
        let publicationCalls = 0;

        await (context as unknown as ContextWithNavigationPublisher).writeSymbolRegistryForCompletedIndex(
            codebasePath,
            [],
            [{ path: relativePath, hash: 'hash-auth', language: 'typescript', symbolCount: 0 }],
            undefined,
            new Map([[relativePath, { moduleBindings: [], callSites: [] }]]),
            (publish) => {
                publicationCalls += 1;
                publish();
            },
        );

        assert.equal(publicationCalls, 1);
        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(sidecar.status, 'ok');
        assert.equal(sidecar.registry?.manifest.files[0]?.path, relativePath);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.clearIndex removes navigation sidecars and sqlite cache', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-clear-navigation-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, [
            'export function normalize(input: string) {',
            '  return input.trim();',
            '}',
        ].join('\n'), 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        const result = await context.indexCodebase(codebasePath);
        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.status, 'completed');
        assert.equal(registry.status, 'ok');
        assert.equal(fs.existsSync(resolveNavigationSqlitePath(stateRoot, codebasePath)), true);
        assert.equal(await vectorDatabase.hasCollection(context.resolveCollectionName(codebasePath)), true);

        const relationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: codebasePath,
            expectedSymbolRegistryManifestHash: registry.manifestHash,
        });
        assert.equal(relationships.status, 'ok');

        await context.clearIndex(codebasePath);

        const clearedRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        const clearedRelationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: codebasePath,
            expectedSymbolRegistryManifestHash: registry.manifestHash,
        });

        assert.equal(await vectorDatabase.hasCollection(context.resolveCollectionName(codebasePath)), false);
        assert.equal(clearedRegistry.status, 'missing');
        assert.equal(clearedRelationships.status, 'missing');
        assert.equal(fs.existsSync(resolveNavigationSqlitePath(stateRoot, codebasePath)), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.processFileList returns symbol records, manifest files, and completion status in production code', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-process-file-list-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await vectorDatabase.createHybridCollection(context.resolveCollectionName(codebasePath));

        const processFileListContext = context as unknown as ContextWithProcessFileList;
        const result = await processFileListContext.processFileList([sourcePath], codebasePath);

        assert.equal(result.status, 'completed');
        assert.equal(result.processedFiles, 1);
        assert.ok(result.totalChunks > 0);
        assert.ok(result.symbolRecords.length > 0);
        assert.equal(result.symbolManifestFiles.length, 1);
        assert.equal(result.symbolManifestFiles[0]?.path, 'src/auth.ts');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context persists its canonical relative path instead of analyzer chunk metadata', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-trusted-chunk-path-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'owned.ts');
    const maliciousAnalyzer: LanguageAnalysisPort = {
        async analyze() {
            return {
                backend: 'oxc' as const,
                structuralStatus: 'complete' as const,
                symbols: [],
                moduleBindings: [],
                callSites: [],
                chunks: [
                    {
                        content: 'export const owned = true;',
                        metadata: Object.freeze({
                            startLine: 1,
                            endLine: 1,
                            language: 'typescript',
                            filePath: '../../redirect.ts',
                        }),
                    },
                    {
                        content: 'export const second = true;',
                        metadata: Object.freeze({
                            startLine: 1,
                            endLine: 1,
                            language: 'typescript',
                            filePath: path.join(tempRoot, 'absolute-redirect.ts'),
                        }),
                    },
                ],
            };
        },
        getDescription: () => 'adversarial metadata analyzer',
        getStrategyForLanguage: () => ({ backend: 'oxc' as const, structural: true }),
    };

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const owned = true;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            languageAnalyzer: maliciousAnalyzer,
        });
        const collectionName = context.resolveCollectionName(codebasePath);
        await vectorDatabase.createHybridCollection(collectionName);

        const expected = await context.getExpectedChunksAndSymbols([sourcePath], codebasePath);
        assert.ok(expected.expectedChunks.length > 0);
        assert.ok(expected.expectedChunks.every((chunk) => chunk.relativePath === 'src/owned.ts'));

        const navigation = await (context as unknown as ContextWithNavigationArtifactBuilder)
            .buildNavigationArtifactsForFiles([sourcePath], codebasePath);
        assert.deepEqual(
            navigation.symbolManifestFiles.map((file) => file.path),
            ['src/owned.ts'],
        );

        await (context as unknown as ContextWithProcessFileList)
            .processFileList([sourcePath], codebasePath);

        const documents = [...(vectorDatabase.collections.get(collectionName)?.values() ?? [])];
        assert.ok(documents.length > 0);
        assert.ok(documents.every((document) => document.relativePath === 'src/owned.ts'));
        assert.ok(documents.every((document) => document.fileExtension === '.ts'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.indexCodebase attaches Go extractor owner metadata in production indexing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-go-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'svc.go');

    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, [
            'package svc',
            '',
            'func add(a, b int) int {',
            '  return a + b',
            '}',
            '',
        ].join('\n'), 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        const result = await context.indexCodebase(codebasePath);
        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.status, 'completed');
        assert.equal(sidecar.status, 'ok');
        if (sidecar.status !== 'ok') {
            return;
        }

        const add = sidecar.registry.symbolsByFile
            .get('svc.go')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'add');
        assert.ok(add);
        assert.equal(add?.language, 'go');
        assert.equal(add?.label, 'function add');

        const documents = Array.from(vectorDatabase.collections.values())
            .flatMap((collection) => Array.from(collection.values()))
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION)
            .filter((document) => document.relativePath === 'svc.go');
        assert.ok(documents.length > 0);
        assert.ok(documents.some((document) => document.metadata.ownerSymbolInstanceId === add?.symbolInstanceId));
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolKey === 'string'));
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolInstanceId === 'string'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.indexCodebase attaches Rust extractor owner metadata in production indexing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-rust-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'stack.rs');

    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, [
            'pub struct Stack { value: i32 }',
            '',
            'impl Stack {',
            '  pub fn push(&mut self, value: i32) {',
            '    self.value = value;',
            '  }',
            '}',
            '',
        ].join('\n'), 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        const result = await context.indexCodebase(codebasePath);
        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.status, 'completed');
        assert.equal(sidecar.status, 'ok');
        if (sidecar.status !== 'ok') {
            return;
        }

        const rustSymbols = sidecar.registry.symbolsByFile.get('stack.rs') || [];
        const stack = rustSymbols.find((symbol) => symbol.kind === 'type' && symbol.name === 'Stack');
        const push = rustSymbols.find((symbol) => symbol.kind === 'method' && symbol.name === 'push');
        assert.ok(stack);
        assert.ok(push);
        assert.equal(stack?.language, 'rust');
        assert.equal(push?.language, 'rust');
        assert.equal(stack?.label, 'struct Stack');
        assert.equal(push?.label, 'method push');
        assert.equal(push?.qualifiedName, 'Stack.push');
        const rustSymbolInstanceIds = new Set(rustSymbols.map((symbol) => symbol.symbolInstanceId));

        const documents = Array.from(vectorDatabase.collections.values())
            .flatMap((collection) => Array.from(collection.values()))
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION)
            .filter((document) => document.relativePath === 'stack.rs');
        assert.ok(documents.length > 0);
        assert.ok(documents.some((document) =>
            document.metadata.ownerSymbolInstanceId === stack?.symbolInstanceId ||
            document.metadata.ownerSymbolInstanceId === push?.symbolInstanceId
        ));
        assert.ok(documents.every((document) => rustSymbolInstanceIds.has(String(document.metadata.ownerSymbolInstanceId))));
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolKey === 'string'));
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolInstanceId === 'string'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

for (const fixture of [
    {
        language: 'java',
        file: 'Service.java',
        source: 'class Service {\n  int run() {\n    return 1;\n  }\n}\n',
        target: { kind: 'method', name: 'run', qualifiedName: 'Service.run' },
    },
    {
        language: 'csharp',
        file: 'Service.cs',
        source: 'class Service {\n  int Run() {\n    return 1;\n  }\n}\n',
        target: { kind: 'method', name: 'Run', qualifiedName: 'Service.Run' },
    },
    {
        language: 'cpp',
        file: 'service.cpp',
        source: 'class Service {\n};\nint run() {\n  return 1;\n}\n',
        target: { kind: 'function', name: 'run', qualifiedName: 'run' },
    },
    {
        language: 'scala',
        file: 'Service.scala',
        source: 'class Service {\n  def run(): Int = {\n    1\n  }\n}\n',
        target: { kind: 'function', name: 'run', qualifiedName: 'Service.run' },
    },
] as const) {
    test(`Context.indexCodebase attaches ${fixture.language} symbol owner metadata`, async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `satori-context-${fixture.language}-symbols-`));
        const stateRoot = path.join(tempRoot, 'state');
        const codebasePath = path.join(tempRoot, 'repo');
        const sourcePath = path.join(codebasePath, fixture.file);

        try {
            fs.mkdirSync(codebasePath, { recursive: true });
            fs.writeFileSync(sourcePath, fixture.source, 'utf8');

            const vectorDatabase = new InMemoryVectorDatabase();
            const context = new Context({
                embedding: new TestEmbedding(),
                vectorDatabase,
                symbolRegistryStateRoot: stateRoot,
            });

            const result = await context.indexCodebase(codebasePath);
            const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

            assert.equal(result.status, 'completed');
            assert.equal(sidecar.status, 'ok');
            if (sidecar.status !== 'ok') return;

            const target = (sidecar.registry.symbolsByFile.get(fixture.file) || []).find((symbol) => (
                symbol.kind === fixture.target.kind
                && symbol.name === fixture.target.name
                && symbol.qualifiedName === fixture.target.qualifiedName
            ));
            assert.ok(target);
            assert.equal(target?.language, fixture.language);

            const documents = Array.from(vectorDatabase.collections.values())
                .flatMap((collection) => Array.from(collection.values()))
                .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION)
                .filter((document) => document.relativePath === fixture.file);
            assert.ok(documents.some((document) => document.metadata.ownerSymbolInstanceId === target?.symbolInstanceId));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
}

test('Context.indexCodebase degrades malformed Go source to synthesized file-owner metadata', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-go-malformed-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'broken.go');

    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, 'package svc\nfunc broken( {\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        const result = await context.indexCodebase(codebasePath);
        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.status, 'completed');
        assert.equal(sidecar.status, 'ok');
        if (sidecar.status !== 'ok') {
            return;
        }

        const fileSymbols = sidecar.registry.symbolsByFile.get('broken.go') || [];
        assert.deepEqual(fileSymbols.map((symbol) => symbol.kind), ['file']);
        const fileOwner = fileSymbols[0];
        assert.ok(fileOwner);

        const documents = Array.from(vectorDatabase.collections.values())
            .flatMap((collection) => Array.from(collection.values()))
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION)
            .filter((document) => document.relativePath === 'broken.go');
        assert.ok(documents.length > 0);
        assert.ok(documents.every((document) => document.metadata.ownerSymbolInstanceId === fileOwner?.symbolInstanceId));
        assert.ok(documents.every((document) => document.metadata.symbolKind === 'file'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.indexCodebase uses filename-aware language routing for symbol registry files', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-filenames-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const dockerfilePath = path.join(codebasePath, 'Dockerfile');

    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(dockerfilePath, 'FROM node:24\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
            customExtensions: ['Dockerfile'],
        });

        await context.indexCodebase(codebasePath);
        const sidecar = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(sidecar.status, 'ok');
        assert.equal(sidecar.registry?.manifest.files[0].path, 'Dockerfile');
        assert.equal(sidecar.registry?.manifest.files[0].language, 'dockerfile');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange rebuilds navigation sidecars when tracked files change', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        assert.equal((await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath })).status, 'ok');

        const updatedContent = 'export const auth = false;\n';
        fs.writeFileSync(sourcePath, updatedContent, 'utf8');
        const result = await context.reindexByChange(codebasePath);
        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.modified, 1);
        assert.equal(registry.status, 'ok');
        if (registry.status !== 'ok') {
            return;
        }

        const expectedHash = crypto.createHash('sha256').update(updatedContent, 'utf8').digest('hex');
        assert.equal(registry.registry.manifest.files.length, 1);
        assert.equal(registry.registry.manifest.files[0]?.path, 'src/auth.ts');
        assert.equal(registry.registry.manifest.files[0]?.hash, expectedHash);
        const ownerIds = new Set(
            registry.registry.symbolsByFile
                .get('src/auth.ts')
                ?.map((symbol) => symbol.symbolInstanceId) || []
        );
        const documents = Array.from(vectorDatabase.collections.values())
            .flatMap((collection) => Array.from(collection.values()))
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION)
            .filter((document) => document.relativePath === 'src/auth.ts');
        assert.ok(documents.length > 0);
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolKey === 'string'));
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolInstanceId === 'string'));
        assert.ok(documents.every((document) => ownerIds.has(document.metadata.ownerSymbolInstanceId as string)));

        const relationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: codebasePath,
            expectedSymbolRegistryManifestHash: registry.manifestHash,
        });
        assert.equal(relationships.status, 'ok');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange writes changed chunks to the active staged collection', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-staged-target-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const stableCollection = context.resolveCollectionName(codebasePath);
        const stagedCollection = context.resolveStagedCollectionName(codebasePath, 'ready');
        const stableDocs = vectorDatabase.collections.get(stableCollection);
        assert.ok(stableDocs);
        vectorDatabase.collections.set(stagedCollection, new Map(stableDocs));
        await vectorDatabase.dropCollection(stableCollection);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), stagedCollection);

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);
        const stagedDocs = Array.from(vectorDatabase.collections.get(stagedCollection)?.values() || [])
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION);

        assert.equal(result.modified, 1);
        assert.equal(await vectorDatabase.hasCollection(stableCollection), false);
        assert.ok(stagedDocs.some((document) => document.content.includes('auth = false')));
        assert.equal(stagedDocs.some((document) => document.content.includes('auth = true')), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange restores missing completion marker in trusted target collection', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-marker-restore-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'runtime.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function runtime() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const collectionName = context.resolveCollectionName(codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);
        assert.equal(await context.getIndexCompletionMarker(codebasePath), null);

        const result = await context.reindexByChange(codebasePath, undefined, {
            targetCollectionName: collectionName,
            maintainCompletionMarker: true,
        });

        const marker = await context.getIndexCompletionMarker(codebasePath);
        assert.equal(result.added, 0);
        assert.equal(result.removed, 0);
        assert.equal(result.modified, 0);
        assert.equal(result.collectionName, collectionName);
        assert.ok(marker);
        assert.equal(marker.indexedFiles, 1);
        assert.equal(marker.totalChunks > 0, true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange rebuilds missing navigation sidecars before no-change marker restore', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-marker-nav-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'runtime.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function runtime() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const collectionName = context.resolveCollectionName(codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);
        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        const result = await context.reindexByChange(codebasePath, undefined, {
            targetCollectionName: collectionName,
            maintainCompletionMarker: true,
        });
        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.added, 0);
        assert.ok(await context.getIndexCompletionMarker(codebasePath));
        assert.equal(registry.status, 'ok');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange normal no-change sync with existing marker does not run exact payload proof', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-marker-no-proof-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'runtime.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function runtime() { return true; }\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        assert.ok(await context.getIndexCompletionMarker(codebasePath));

        const proofContext = context as unknown as ContextWithExpectedChunks;
        proofContext.getExpectedChunksAndSymbols = async () => {
            throw new Error('exact payload proof should not run');
        };

        const result = await context.reindexByChange(codebasePath, undefined, {
            targetCollectionName: context.resolveCollectionName(codebasePath),
            maintainCompletionMarker: true,
        });

        assert.equal(result.added, 0);
        assert.equal(result.modified, 0);
        assert.equal(result.removed, 0);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange refuses marker restore when an expected vector row is missing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-marker-missing-row-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'runtime.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function runtime() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const collectionName = context.resolveCollectionName(codebasePath);
        const documents = vectorDatabase.collections.get(collectionName);
        assert.ok(documents);
        const missingId = Array.from(documents.keys()).find(id => id !== INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(missingId);
        documents.delete(missingId);
        await context.clearIndexCompletionMarker(codebasePath);

        await assert.rejects(
            () => context.reindexByChange(codebasePath, undefined, {
                targetCollectionName: collectionName,
                maintainCompletionMarker: true,
            }),
            /expected chunk\(s\) are missing/
        );
        assert.equal(vectorDatabase.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange refuses marker restore when extra remote rows exist', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-marker-extra-row-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'runtime.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function runtime() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const collectionName = context.resolveCollectionName(codebasePath);
        await vectorDatabase.insertHybrid(collectionName, [buildChunkDoc('stale_extra_chunk')]);
        await context.clearIndexCompletionMarker(codebasePath);

        await assert.rejects(
            () => context.reindexByChange(codebasePath, undefined, {
                targetCollectionName: collectionName,
                maintainCompletionMarker: true,
            }),
            /stale remote chunk/
        );
        assert.equal(vectorDatabase.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange marker-maintaining sync refuses to create a fresh collection implicitly', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-marker-no-collection-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'runtime.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function runtime() { return true; }\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);

        await assert.rejects(
            () => context.reindexByChange(codebasePath, undefined, { maintainCompletionMarker: true }),
            /no existing collection could be resolved/
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange reuses unchanged file symbols while retargeting cross-file relationships', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-delta-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const authPath = path.join(codebasePath, 'src', 'auth.ts');
    const callerPath = path.join(codebasePath, 'src', 'caller.ts');
    const unrelatedPath = path.join(codebasePath, 'src', 'unrelated.ts');

    try {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, 'export function login() { return true; }\n', 'utf8');
        fs.writeFileSync(
            callerPath,
            "import { login } from './auth';\nexport function run() { return login(); }\n",
            'utf8',
        );
        fs.writeFileSync(unrelatedPath, 'export function unrelated() { return true; }\n', 'utf8');

        const analyzer = new RecordingAnalyzer();
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            languageAnalyzer: analyzer,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const initialRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(initialRegistry.status, 'ok');
        if (initialRegistry.status !== 'ok') {
            return;
        }

        const initialAuthSymbol = initialRegistry.registry.symbolsByFile
            .get('src/auth.ts')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'login');
        const initialCallerSymbol = initialRegistry.registry.symbolsByFile
            .get('src/caller.ts')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');
        assert.ok(initialAuthSymbol);
        assert.ok(initialCallerSymbol);
        if (!initialAuthSymbol || !initialCallerSymbol) {
            return;
        }

        const initialRelationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: codebasePath,
            expectedSymbolRegistryManifestHash: initialRegistry.manifestHash,
        });
        assert.equal(initialRelationships.status, 'ok');
        if (initialRelationships.status !== 'ok') {
            return;
        }

        const initialCallRecord = initialRelationships.records.find((record) =>
            record.type === 'CALLS'
            && record.file === 'src/caller.ts'
            && record.sourceInstanceId === initialCallerSymbol.symbolInstanceId
        );
        assert.ok(initialCallRecord);
        assert.equal(initialCallRecord?.targetInstanceId, initialAuthSymbol.symbolInstanceId);

        analyzer.reset();
        fs.writeFileSync(authPath, 'export function login() { return false; }\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);
        assert.equal(result.modified, 1);

        const analyzedRelativePaths = analyzer.analyzeCalls
            .sort((a, b) => a.localeCompare(b));
        assert.deepEqual(analyzedRelativePaths, [
            'src/auth.ts',
        ]);

        const nextRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(nextRegistry.status, 'ok');
        if (nextRegistry.status !== 'ok') {
            return;
        }

        const nextAuthSymbol = nextRegistry.registry.symbolsByFile
            .get('src/auth.ts')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'login');
        const nextCallerSymbol = nextRegistry.registry.symbolsByFile
            .get('src/caller.ts')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');
        assert.ok(nextAuthSymbol);
        assert.ok(nextCallerSymbol);
        if (!nextAuthSymbol || !nextCallerSymbol) {
            return;
        }

        assert.notEqual(nextAuthSymbol.symbolInstanceId, initialAuthSymbol.symbolInstanceId);
        assert.equal(nextCallerSymbol.symbolInstanceId, initialCallerSymbol.symbolInstanceId);

        const nextRelationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: codebasePath,
            expectedSymbolRegistryManifestHash: nextRegistry.manifestHash,
        });
        assert.equal(nextRelationships.status, 'ok');
        if (nextRelationships.status !== 'ok') {
            return;
        }

        const nextCallRecord = nextRelationships.records.find((record) =>
            record.type === 'CALLS'
            && record.file === 'src/caller.ts'
            && record.sourceInstanceId === nextCallerSymbol.symbolInstanceId
        );
        assert.ok(nextCallRecord);
        assert.equal(nextCallRecord?.targetInstanceId, nextAuthSymbol.symbolInstanceId);
        assert.notEqual(nextCallRecord?.targetInstanceId, initialCallRecord?.targetInstanceId);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange removes renamed-file navigation and publishes new symbol ownership', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-rename-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const oldPath = path.join(codebasePath, 'src', 'old.ts');
    const newPath = path.join(codebasePath, 'src', 'new.ts');
    const callerPath = path.join(codebasePath, 'src', 'caller.ts');

    try {
        fs.mkdirSync(path.dirname(oldPath), { recursive: true });
        fs.writeFileSync(oldPath, 'export function login() { return true; }\n', 'utf8');
        fs.writeFileSync(
            callerPath,
            "import { login } from './old';\nexport function run() { return login(); }\n",
            'utf8',
        );

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const initialRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(initialRegistry.status, 'ok');
        if (initialRegistry.status !== 'ok') {
            return;
        }

        const initialLoginSymbol = initialRegistry.registry.symbolsByFile
            .get('src/old.ts')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'login');
        assert.ok(initialLoginSymbol);
        if (!initialLoginSymbol) {
            return;
        }

        fs.renameSync(oldPath, newPath);
        fs.writeFileSync(
            callerPath,
            "import { login } from './new';\nexport function run() { return login(); }\n",
            'utf8',
        );

        const result = await context.reindexByChange(codebasePath);
        assert.equal(result.added, 1);
        assert.equal(result.removed, 1);
        assert.equal(result.modified, 1);
        assert.deepEqual([...result.changedFiles].sort(), ['src/caller.ts', 'src/new.ts', 'src/old.ts']);

        const nextRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(nextRegistry.status, 'ok');
        if (nextRegistry.status !== 'ok') {
            return;
        }

        assert.equal(nextRegistry.registry.manifest.files.some((file) => file.path === 'src/old.ts'), false);
        assert.equal(nextRegistry.registry.symbolsByFile.has('src/old.ts'), false);
        assert.equal(nextRegistry.registry.symbolsByInstanceId.has(initialLoginSymbol.symbolInstanceId), false);

        const nextLoginSymbol = nextRegistry.registry.symbolsByFile
            .get('src/new.ts')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'login');
        const nextCallerSymbol = nextRegistry.registry.symbolsByFile
            .get('src/caller.ts')
            ?.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');
        assert.ok(nextLoginSymbol);
        assert.ok(nextCallerSymbol);
        if (!nextLoginSymbol || !nextCallerSymbol) {
            return;
        }
        assert.notEqual(nextLoginSymbol.symbolInstanceId, initialLoginSymbol.symbolInstanceId);

        const nextRelationships = await readRelationshipSidecar({
            stateRoot,
            normalizedRootPath: codebasePath,
            expectedSymbolRegistryManifestHash: nextRegistry.manifestHash,
        });
        assert.equal(nextRelationships.status, 'ok');
        if (nextRelationships.status !== 'ok') {
            return;
        }

        assert.equal(nextRelationships.records.some((record) =>
            record.file === 'src/old.ts'
            || record.sourceInstanceId === initialLoginSymbol.symbolInstanceId
            || record.targetInstanceId === initialLoginSymbol.symbolInstanceId
            || record.targetPath === 'src/old.ts'
        ), false);

        const nextCallRecord = nextRelationships.records.find((record) =>
            record.type === 'CALLS'
            && record.file === 'src/caller.ts'
            && record.sourceInstanceId === nextCallerSymbol.symbolInstanceId
        );
        assert.ok(nextCallRecord);
        assert.equal(nextCallRecord?.targetInstanceId, nextLoginSymbol.symbolInstanceId);

        const searchResults = await context.semanticSearch({
            codebasePath,
            query: 'login',
            topK: 50,
            retrievalMode: 'hybrid',
            scorePolicy: { kind: 'topk_only' },
        });
        assert.equal(searchResults.some((result) => result.relativePath === 'src/old.ts'), false);
        assert.equal(searchResults.some((result) => result.ownerSymbolInstanceId === initialLoginSymbol.symbolInstanceId), false);
        assert.ok(searchResults.some((result) =>
            result.relativePath === 'src/new.ts'
            && result.ownerSymbolInstanceId === nextLoginSymbol.symbolInstanceId
        ));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

// FLC-08: full index stop at limit_reached still seals partial vector proof (marker) without complete navigation.
test('Context.indexCodebase limit_reached writes completion marker without symbol registry', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-index-limit-reached-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);

        const contextWithProcessFileList = context as unknown as ContextWithProcessFileList;
        const originalProcessFileList = contextWithProcessFileList.processFileList.bind(contextWithProcessFileList);
        contextWithProcessFileList.processFileList = async (...args: unknown[]) => {
            const result = await originalProcessFileList(...args);
            return {
                ...result,
                status: 'limit_reached',
            };
        };

        const stats = await context.indexCodebase(codebasePath);
        const collectionName = context.resolveCollectionName(codebasePath);
        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(stats.status, 'limit_reached');
        assert.equal(vectorDatabase.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID), true);
        assert.equal(registry.status, 'missing');
        const marker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(marker);
        assert.equal(marker?.kind, 'satori_index_completion_v1');
        assert.equal(marker?.indexStatus, 'limit_reached');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange clears navigation sidecars when changed-file indexing stops early', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-limit-reached-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        assert.equal((await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath })).status, 'ok');

        const contextWithProcessFileList = context as unknown as ContextWithProcessFileList;
        const originalProcessFileList = contextWithProcessFileList.processFileList.bind(contextWithProcessFileList);
        contextWithProcessFileList.processFileList = async (...args: unknown[]) => {
            const result = await originalProcessFileList(...args);
            return {
                ...result,
                status: 'limit_reached',
            };
        };

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);
        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.modified, 1);
        assert.equal(result.navigationRecovery, 'failed');
        assert.equal(registry.status, 'missing');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange marker-maintaining partial sync clears old marker and does not rewrite it', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-limit-marker-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const collectionName = context.resolveCollectionName(codebasePath);
        assert.equal(vectorDatabase.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID), true);

        const contextWithProcessFileList = context as unknown as ContextWithProcessFileList;
        const originalProcessFileList = contextWithProcessFileList.processFileList.bind(contextWithProcessFileList);
        contextWithProcessFileList.processFileList = async (...args: unknown[]) => {
            const result = await originalProcessFileList(...args);
            return { ...result, status: 'limit_reached' };
        };

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        const result = await context.reindexByChange(codebasePath, undefined, {
            targetCollectionName: collectionName,
            maintainCompletionMarker: true,
        });

        assert.equal(result.modified, 1);
        assert.equal(result.navigationRecovery, 'failed');
        assert.equal(vectorDatabase.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange clears incomplete navigation when a changed file produces no replacement metadata', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-no-replacement-symbols-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const authPath = path.join(codebasePath, 'src', 'auth.ts');
    const callerPath = path.join(codebasePath, 'src', 'caller.ts');

    try {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, 'export function login() { return true; }\n', 'utf8');
        fs.writeFileSync(callerPath, 'export function run() { return true; }\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const initialRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(initialRegistry.status, 'ok');
        if (initialRegistry.status !== 'ok') {
            return;
        }
        assert.ok(initialRegistry.registry.symbolsByFile.get('src/auth.ts'));
        assert.ok(initialRegistry.registry.symbolsByFile.get('src/caller.ts'));

        const contextWithProcessFileList = context as unknown as ContextWithProcessFileList;
        contextWithProcessFileList.processFileList = async () => ({
            processedFiles: 0,
            totalChunks: 0,
            status: 'completed',
            symbolRecords: [],
            symbolManifestFiles: [],
        });

        fs.writeFileSync(authPath, 'export function login() { return false; }\n', 'utf8');
        await assert.rejects(
            () => context.reindexByChange(codebasePath),
            /synchronizer tracks 2 files but navigation seals 1/,
        );
        const nextRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(await context.getIndexCompletionMarker(codebasePath), null);
        assert.equal(nextRegistry.status, 'missing');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange rebuilds navigation sidecars when no compatible registry exists before sync', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-no-registry-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal((await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath })).status, 'missing');

        fs.writeFileSync(sourcePath, 'export function auth() { return false; }\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);
        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.modified, 1);
        assert.equal(result.navigationRecovery, 'rebuilt');
        assert.equal(registry.status, 'ok');
        if (registry.status !== 'ok') {
            return;
        }

        assert.equal(registry.registry.manifest.files.length, 1);
        assert.equal(registry.registry.manifest.files[0]?.path, 'src/auth.ts');
        assert.ok(registry.registry.symbolsByFile.get('src/auth.ts')?.some((symbol) => symbol.name === 'auth'));

        const documents = Array.from(vectorDatabase.collections.values())
            .flatMap((collection) => Array.from(collection.values()))
            .filter((document) => document.fileExtension !== COMPLETION_MARKER_EXTENSION)
            .filter((document) => document.relativePath === 'src/auth.ts');
        assert.ok(documents.length > 0);
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolKey === 'string'));
        assert.ok(documents.every((document) => typeof document.metadata.ownerSymbolInstanceId === 'string'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange marker-maintaining sync does not rewrite marker when navigation recovery fails', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-nav-fail-marker-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const collectionName = context.resolveCollectionName(codebasePath);
        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        const failingContext = context as unknown as {
            rebuildNavigationArtifacts: (codebasePath: string) => Promise<void>;
        };
        failingContext.rebuildNavigationArtifacts = async () => {
            throw new Error('forced navigation rebuild failure');
        };

        fs.writeFileSync(sourcePath, 'export function auth() { return false; }\n', 'utf8');
        const result = await context.reindexByChange(codebasePath, undefined, {
            targetCollectionName: collectionName,
            maintainCompletionMarker: true,
        });

        assert.equal(result.modified, 1);
        assert.equal(result.navigationRecovery, 'failed');
        assert.equal(vectorDatabase.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange retains the filesystem delta for retry when incremental sync throws', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-exception-clears-sidecars-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        assert.equal((await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath })).status, 'ok');
        assert.ok(await context.getIndexCompletionMarker(codebasePath));

        const failingContext = context as unknown as ContextWithDeleteFileChunks;
        const deleteFileChunks = failingContext.deleteFileChunks.bind(context);
        failingContext.deleteFileChunks = async () => {
            throw new Error('synthetic incremental sync failure');
        };

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        await assert.rejects(
            () => context.reindexByChange(codebasePath),
            /synthetic incremental sync failure/,
        );
        assert.equal((context as unknown as { reindexByChangeQueues: Map<string, Promise<void>> }).reindexByChangeQueues.size, 0);

        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(registry.status, 'missing');
        assert.equal(await context.getIndexCompletionMarker(codebasePath), null);

        failingContext.deleteFileChunks = deleteFileChunks;
        const retry = await context.reindexByChange(codebasePath);
        assert.equal(retry.modified, 1);
        assert.deepEqual(retry.changedFiles, ['src/auth.ts']);

        const settled = await context.reindexByChange(codebasePath);
        assert.equal(settled.modified, 0);
        assert.deepEqual(settled.changedFiles, []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange retries the exact staged mutation target after marker withdrawal', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-staged-sync-retry-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        const stagedCollection = context.resolveStagedCollectionName(codebasePath, 'retry-stage');
        context.setWriteCollectionOverride(codebasePath, stagedCollection);
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), stagedCollection);

        const failingContext = context as unknown as ContextWithDeleteFileChunks;
        const deleteFileChunks = failingContext.deleteFileChunks.bind(context);
        failingContext.deleteFileChunks = async () => {
            throw new Error('synthetic staged sync failure');
        };

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        await assert.rejects(
            () => context.reindexByChange(codebasePath),
            /synthetic staged sync failure/,
        );
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);

        failingContext.deleteFileChunks = deleteFileChunks;
        const retry = await context.reindexByChange(codebasePath);
        assert.equal(retry.collectionName, stagedCollection);
        assert.equal(retry.modified, 1);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), stagedCollection);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange serializes concurrent syncs with an existing synchronizer', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-serialized-existing-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        vectorDatabase.mutationCalls.length = 0;

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        const [first, second] = await Promise.all([
            context.reindexByChange(codebasePath),
            context.reindexByChange(`${codebasePath}${path.sep}`),
        ]);

        assert.equal(first.modified, 1);
        assert.equal(second.modified, 0);
        assert.deepEqual(first.changedFiles, ['src/auth.ts']);
        assert.deepEqual(second.changedFiles, []);
        assert.deepEqual(vectorDatabase.mutationCalls, [
            'marker_delete',
            'payload_delete',
            'payload_insert',
            'marker_insert',
        ]);
        assert.equal((context as unknown as { reindexByChangeQueues: Map<string, Promise<void>> }).reindexByChangeQueues.size, 0);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange serializes first-use synchronizer creation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-serialized-first-use-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const baselineContext = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await baselineContext.recreateSynchronizerForCodebase(codebasePath);
        await baselineContext.indexCodebase(codebasePath);

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        assert.equal(context.hasSynchronizerForCodebase(codebasePath), false);
        vectorDatabase.mutationCalls.length = 0;

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        const [first, second] = await Promise.all([
            context.reindexByChange(codebasePath),
            context.reindexByChange(`${codebasePath}${path.sep}`),
        ]);

        assert.equal(first.modified, 1);
        assert.equal(second.modified, 0);
        assert.deepEqual(first.changedFiles, ['src/auth.ts']);
        assert.deepEqual(second.changedFiles, []);
        assert.deepEqual(vectorDatabase.mutationCalls, [
            'marker_delete',
            'payload_delete',
            'payload_insert',
            'marker_insert',
        ]);
        assert.equal(context.getActiveSynchronizers().size, 1);
        assert.equal((context as unknown as { reindexByChangeQueues: Map<string, Promise<void>> }).reindexByChangeQueues.size, 0);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.writeSymbolRegistryForCompletedIndex removes stale sqlite cache when import fails', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sqlite-import-failure-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const auth = true;\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, codebasePath);
        assert.equal(fs.existsSync(sqlitePath), true);
        fs.rmSync(sqlitePath, { force: true });
        fs.mkdirSync(sqlitePath, { recursive: true });

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);

        assert.equal(result.modified, 1);
        assert.equal(fs.existsSync(sqlitePath), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex recommends create only when no related collection exists', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-no-collection-'));
    const codebasePath = path.join(tempRoot, 'repo');

    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: path.join(tempRoot, 'state'),
        });

        const result = await context.repairIndex(codebasePath);

        assert.equal(result.status, 'blocked');
        assert.equal(result.reason, 'needs_create');
        assert.equal(result.proof.collection.status, 'missing');
        assert.equal(result.proof.collection.basis, 'no_related_collection');
        assert.equal(result.proof.payload.status, 'not_checked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex requires reindex when multiple staged collections lack snapshot authority', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-multiple-staged-'));
    const codebasePath = path.join(tempRoot, 'repo');

    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: path.join(tempRoot, 'state'),
        });
        vectorDatabase.collections.set(context.resolveStagedCollectionName(codebasePath, 'one'), new Map());
        vectorDatabase.collections.set(context.resolveStagedCollectionName(codebasePath, 'two'), new Map());

        const result = await context.repairIndex(codebasePath);

        assert.equal(result.status, 'requires_reindex');
        assert.equal(result.reason, 'requires_reindex');
        assert.equal(result.proof.collection.status, 'failed');
        assert.equal(result.proof.collection.basis, 'multiple_staged_collections');
        assert.equal(result.proof.collection.observedCount, 2);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex requires reindex when the snapshot-selected collection is missing but a related collection exists', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-missing-snapshot-collection-'));
    const codebasePath = path.join(tempRoot, 'repo');

    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: path.join(tempRoot, 'state'),
        });
        const existingCollection = context.resolveStagedCollectionName(codebasePath, 'existing');
        const missingCollection = context.resolveStagedCollectionName(codebasePath, 'missing');
        vectorDatabase.collections.set(existingCollection, new Map());

        const result = await context.repairIndex(codebasePath, {
            preferredCollectionName: missingCollection,
        });

        assert.equal(result.status, 'requires_reindex');
        assert.equal(result.reason, 'requires_reindex');
        assert.equal(result.proof.collection.status, 'failed');
        assert.equal(result.proof.collection.basis, 'snapshot_collection_missing_from_family');
        assert.equal(result.proof.collection.observedCount, 1);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex missing_marker_doc + complete collection repairs marker and sidecars without embedding chunk writes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-ok-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();

        let throwOnEmbed = false;
        const embedding = new (class extends TestEmbedding {
            async embed(text: string) {
                if (throwOnEmbed) throw new Error('embedding should not be called during repair');
                return super.embed(text);
            }
            async embedBatch(texts: string[]) {
                if (throwOnEmbed) throw new Error('embedding should not be called during repair');
                return super.embedBatch(texts);
            }
        })();

        const context = new Context({
            embedding,
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        // 1. Initial complete index to create the vector data
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const trustedFingerprint = await readTrustedFingerprint(context, codebasePath);

        // 2. Clear the completion marker and navigation sidecars to simulate stale state
        await context.clearIndexCompletionMarker(codebasePath);
        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        const sqlitePath = resolveNavigationSqlitePath(stateRoot, codebasePath);
        assert.equal(fs.existsSync(sqlitePath), false);

        // 3. Run repairIndex
        throwOnEmbed = true;
        const repairResult = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });
        assert.equal(repairResult.status, 'ok');
        assert.match(repairResult.message, /readiness repaired/i);
        assert.equal(repairResult.proof.collection.status, 'matched');
        assert.equal(repairResult.proof.snapshot.status, 'matched');
        assert.equal(repairResult.proof.marker.status, 'missing');
        assert.equal(repairResult.proof.fingerprint.status, 'matched');
        assert.equal(repairResult.proof.payload.status, 'matched');
        assert.equal(repairResult.proof.staleRemoteChunks.status, 'matched');
        assert.equal(repairResult.proof.navigation.status, 'matched');

        // 4. Verify marker and sidecars are rebuilt
        const activeCollection = await context.getActiveIndexedCollectionName(codebasePath);
        assert.ok(activeCollection);
        assert.equal(fs.existsSync(sqlitePath), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex missing marker refuses to forge current fingerprint over unproven vectors', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-missing-marker-fingerprint-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const originalContext = new Context({
            embedding: new NamedTestEmbedding('EmbeddingA'),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await originalContext.recreateSynchronizerForCodebase(codebasePath);
        await originalContext.indexCodebase(codebasePath);
        const originalFingerprint = await readTrustedFingerprint(originalContext, codebasePath);
        await originalContext.clearIndexCompletionMarker(codebasePath);

        const upgradedContext = new Context({
            embedding: new NamedTestEmbedding('EmbeddingB'),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        const repairResult = await upgradedContext.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(originalFingerprint),
        });

        assert.equal(repairResult.status, 'requires_reindex');
        assert.equal(repairResult.reason, 'requires_reindex');
        assert.match(repairResult.message, /cannot prove vector provenance|runtime fingerprint/i);
        assert.equal(repairResult.proof.collection.status, 'matched');
        assert.equal(repairResult.proof.marker.status, 'missing');
        assert.equal(repairResult.proof.snapshot.status, 'failed');
        assert.equal(repairResult.proof.fingerprint.status, 'failed');
        assert.equal(repairResult.proof.payload.status, 'not_checked');
        assert.equal(await upgradedContext.getIndexCompletionMarker(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex reports a malformed completion marker as failed evidence', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-malformed-marker-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const fingerprint = await readTrustedFingerprint(context, codebasePath);
        const collectionName = context.resolveCollectionName(codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);
        await vectorDatabase.insert(collectionName, [{
            id: INDEX_COMPLETION_MARKER_DOC_ID,
            vector: [],
            content: 'malformed marker',
            relativePath: '.__satori__/index_completion_marker.json',
            startLine: 0,
            endLine: 0,
            fileExtension: '.satori_meta',
            metadata: {
                kind: 'satori_index_completion_v1',
                codebasePath: path.join(tempRoot, 'wrong-root'),
            },
        }]);
        const mutationCountBeforeRepair = vectorDatabase.mutationCalls.length;

        const result = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(fingerprint),
        });

        assert.equal(result.status, 'requires_reindex');
        assert.equal(result.reason, 'requires_reindex');
        assert.equal(result.proof.marker.status, 'failed');
        assert.equal(result.proof.marker.basis, 'malformed_completion_marker');
        assert.equal(result.proof.fingerprint.status, 'matched');
        assert.equal(vectorDatabase.mutationCalls.length, mutationCountBeforeRepair);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex publishes partial proof before a backend payload probe fails', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-backend-proof-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const fingerprint = await readTrustedFingerprint(context, codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);

        const originalQuery = vectorDatabase.query.bind(vectorDatabase);
        vectorDatabase.query = async (collectionName, filter, outputFields, limit) => {
            if (filter.startsWith('id in [')) {
                throw new Error('milvus connection closed during payload proof');
            }
            return originalQuery(collectionName, filter, outputFields, limit);
        };
        const proofUpdates: RepairProof[] = [];

        await assert.rejects(
            context.repairIndex(codebasePath, {
                snapshotEvidence: verifiedSnapshotEvidence(fingerprint),
                onProofUpdate: (proof) => {
                    proofUpdates.push(proof);
                },
            }),
            /connection closed/i,
        );
        const partialProof = proofUpdates.at(-1);
        assert.equal(partialProof?.collection.status, 'matched');
        assert.equal(partialProof?.snapshot.status, 'matched');
        assert.equal(partialProof?.marker.status, 'missing');
        assert.equal(partialProof?.fingerprint.status, 'matched');
        assert.equal(partialProof?.payload.status, 'not_checked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex blocks when deleted source leaves extra remote chunks', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-extra-deleted-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const authPath = path.join(codebasePath, 'src', 'auth.ts');
    const oldPath = path.join(codebasePath, 'src', 'old.ts');

    try {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, 'export function auth() { return true; }\n', 'utf8');
        fs.writeFileSync(oldPath, 'export function old() { return false; }\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const trustedFingerprint = await readTrustedFingerprint(context, codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);
        fs.rmSync(oldPath);

        const repairResult = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });

        assert.equal(repairResult.status, 'requires_reindex');
        assert.equal(repairResult.reason, 'requires_reindex');
        assert.match(repairResult.message, /stale remote chunk/i);
        assert.equal(repairResult.proof.payload.status, 'failed');
        assert.ok((repairResult.proof.staleRemoteChunks.extraCount || 0) > 0);
        assert.equal(repairResult.proof.staleRemoteChunks.status, 'failed');
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex blocks zero-file repair when remote chunks remain', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-zero-extra-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const trustedFingerprint = await readTrustedFingerprint(context, codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);
        fs.rmSync(sourcePath);

        const repairResult = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });

        assert.equal(repairResult.status, 'requires_reindex');
        assert.equal(repairResult.reason, 'requires_reindex');
        assert.match(repairResult.message, /no indexable files/i);
        assert.equal(repairResult.proof.payload.status, 'failed');
        assert.equal(repairResult.proof.staleRemoteChunks.status, 'failed');
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex writes the completion marker to the staged collection it verified', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-staged-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const trustedFingerprint = await readTrustedFingerprint(context, codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);

        const stableCollection = context.resolveCollectionName(codebasePath);
        const stagedCollection = context.resolveStagedCollectionName(codebasePath, 'repair_regression');
        const stableDocs = vectorDatabase.collections.get(stableCollection);
        assert.ok(stableDocs);
        vectorDatabase.collections.set(stagedCollection, new Map(stableDocs));
        vectorDatabase.collections.delete(stableCollection);

        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        const repairResult = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });

        assert.equal(repairResult.status, 'ok');
        assert.equal(vectorDatabase.collections.has(stableCollection), false);
        assert.equal(vectorDatabase.collections.get(stagedCollection)?.has(INDEX_COMPLETION_MARKER_DOC_ID), true);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), stagedCollection);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex uses the snapshot-selected staged collection when multiple generations exist', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-preferred-stage-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const trustedFingerprint = await readTrustedFingerprint(context, codebasePath);
        const stableCollection = context.resolveCollectionName(codebasePath);
        const stableDocs = vectorDatabase.collections.get(stableCollection);
        assert.ok(stableDocs);

        const selectedCollection = context.resolveStagedCollectionName(codebasePath, 'selected');
        const staleCollection = context.resolveStagedCollectionName(codebasePath, 'stale');
        vectorDatabase.collections.set(selectedCollection, new Map(stableDocs));
        vectorDatabase.collections.set(staleCollection, new Map(stableDocs));
        vectorDatabase.collections.get(staleCollection)?.set('stale-extra', {
            id: 'stale-extra',
            vector: [],
            content: 'stale',
            relativePath: 'deleted.ts',
            startLine: 1,
            endLine: 1,
            fileExtension: '.ts',
            metadata: {},
        });
        vectorDatabase.collections.delete(stableCollection);

        const repairResult = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
            preferredCollectionName: selectedCollection,
        });

        assert.equal(repairResult.status, 'ok');
        assert.equal(repairResult.collectionName, selectedCollection);
        assert.equal(vectorDatabase.collections.get(selectedCollection)?.has(INDEX_COMPLETION_MARKER_DOC_ID), true);
        assert.equal(vectorDatabase.collections.get(staleCollection)?.has('stale-extra'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex requires reindex when exact payload equality exceeds the query ceiling', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-query-limit-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const fingerprint = await readTrustedFingerprint(context, codebasePath);
        await context.clearIndexCompletionMarker(codebasePath);

        const expectedChunks = Array.from({ length: 16384 }, (_, index) => ({
            id: `expected-${index}`,
            relativePath: 'src/auth.ts',
            startLine: 1,
            endLine: 1,
            content: 'chunk',
            language: 'typescript',
            chunkIndex: index,
        }));
        const proofContext = context as unknown as ContextWithExpectedChunks;
        proofContext.getExpectedChunksAndSymbols = async () => ({
            expectedChunks,
            symbolRecords: [],
            symbolManifestFiles: [],
        });
        const originalQuery = vectorDatabase.query.bind(vectorDatabase);
        vectorDatabase.query = async (collectionName, filter, outputFields, limit) => {
            const idInMatch = /^id in \[(.*)\]$/.exec(filter);
            if (idInMatch?.[1]) {
                return [...idInMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g)]
                    .slice(0, limit)
                    .map((match) => ({ id: match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') }));
            }
            return originalQuery(collectionName, filter, outputFields, limit);
        };

        const result = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(fingerprint),
        });

        assert.equal(result.status, 'requires_reindex');
        assert.equal(result.reason, 'requires_reindex');
        assert.equal(result.proof.payload.status, 'unproven');
        assert.equal(result.proof.payload.basis, 'exact_payload_query_limit_exceeded');
        assert.equal(result.proof.payload.expectedCount, 16384);
        assert.equal(result.proof.staleRemoteChunks.status, 'unproven');
        assert.equal(result.proof.staleRemoteChunks.basis, 'exact_payload_query_limit_exceeded');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex missing_marker_doc + missing expected chunk requires reindex with structured proof', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-missing-chunk-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        // 1. Initial complete index
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        const trustedFingerprint = await readTrustedFingerprint(context, codebasePath);

        // 2. Delete all chunks from vector database manually to simulate incomplete/missing chunk rows
        const collectionName = context.resolveCollectionName(codebasePath);
        const documents = vectorDatabase.collections.get(collectionName);
        assert.ok(documents);
        for (const id of Array.from(documents.keys())) {
            if (id !== INDEX_COMPLETION_MARKER_DOC_ID) {
                documents.delete(id);
            }
        }

        // Clear completion marker
        await context.clearIndexCompletionMarker(codebasePath);

        // 3. Run repairIndex - coverage failure requires a full rebuild.
        const repairResult = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });
        assert.equal(repairResult.status, 'requires_reindex');
        assert.equal(repairResult.reason, 'requires_reindex');
        assert.ok(repairResult.missingCount && repairResult.missingCount > 0);
        assert.equal(repairResult.proof.payload.status, 'failed');
        assert.ok((repairResult.proof.payload.missingCount || 0) > 0);
        assert.equal(repairResult.proof.staleRemoteChunks.status, 'not_checked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex valid marker + missing symbol registry rebuilds navigation only and preserves vector rows', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-missing-registry-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        // 1. Initial complete index
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        // Record vector document IDs before repair
        const collectionName = context.resolveCollectionName(codebasePath);
        const docsMap = vectorDatabase.collections.get(collectionName);
        assert.ok(docsMap);
        const chunkIdsBefore = Array.from(docsMap.keys()).filter(id => id !== INDEX_COMPLETION_MARKER_DOC_ID);

        // 2. Delete symbol registry directories (stale local)
        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        const sqlitePath = resolveNavigationSqlitePath(stateRoot, codebasePath);
        assert.equal(fs.existsSync(sqlitePath), false);

        // 3. Run repairIndex
        const repairResult = await context.repairIndex(codebasePath);
        assert.equal(repairResult.status, 'ok');

        // 4. Verify symbol registry SQLite is rebuilt and vector rows are preserved
        assert.equal(fs.existsSync(sqlitePath), true);
        const chunkIdsAfter = Array.from(docsMap.keys()).filter(id => id !== INDEX_COMPLETION_MARKER_DOC_ID);
        assert.deepEqual(chunkIdsAfter.sort(), chunkIdsBefore.sort());
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex fingerprint mismatch returns requires_reindex, not repair', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-fingerprint-mismatch-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export function auth() { return true; }\n', 'utf8');

        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });

        // 1. Initial complete index
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);

        // 2. Override completion marker with mismatched fingerprint
        const collectionName = context.resolveCollectionName(codebasePath);
        const mismatchedMarkerDoc: VectorDocument = {
            id: INDEX_COMPLETION_MARKER_DOC_ID,
            vector: Array(1024).fill(0),
            content: 'marker',
            relativePath: '.__satori__/index_completion_marker.json',
            startLine: 0,
            endLine: 0,
            fileExtension: '.satori_meta',
            metadata: {
                kind: 'satori_index_completion_v1',
                codebasePath,
                fingerprint: {
                    embeddingProvider: 'MismatchedProvider',
                    embeddingModel: 'mismatched-model',
                    embeddingDimension: 9999,
                    vectorStoreProvider: 'Milvus',
                    schemaVersion: 'dense_v3',
                },
                indexedFiles: 1,
                totalChunks: 1,
                completedAt: new Date().toISOString(),
                runId: 'mismatched-run-id',
            }
        };
        await vectorDatabase.insert(collectionName, [mismatchedMarkerDoc]);

        // 3. Run repairIndex - should return requires_reindex
        const repairResult = await context.repairIndex(codebasePath);
        assert.equal(repairResult.status, 'requires_reindex');
        assert.equal(repairResult.reason, 'requires_reindex');
        assert.match(repairResult.message, /incompatible with the current runtime/i);
        assert.equal(repairResult.proof.marker.status, 'failed');
        assert.equal(repairResult.proof.fingerprint.status, 'failed');
        assert.equal(repairResult.proof.payload.status, 'not_checked');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
