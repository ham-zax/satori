import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Context, IndexPolicyPublicationError } from './context';
import type { RepairProof } from './repair-proof';
import type { RelationshipAnalysisEvidence } from '../relationships';
import { resolveNavigationSqlitePath, SQLiteNavigationStore, validateNavigationStoreParity } from '../navigation';
import { clearSymbolRegistrySidecar, readRelationshipSidecar, readSymbolRegistrySidecar } from '../symbols';
import { resolveNavigationSidecarRoot } from '../symbols/sidecar';
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
import { FileSynchronizer } from '../sync/synchronizer';

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

type ContextWithGetCodeFiles = {
    getCodeFiles: (codebasePath: string) => Promise<string[]>;
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

function unboundPolicyBinding(collectionName: string) {
    return {
        collectionName,
        navigation: { status: 'not_bound' as const },
    };
}

function sealedPolicyBinding(
    collectionName: string,
    navigation: { generationId: string; navigationSealHash: string },
) {
    return {
        collectionName,
        navigation: {
            status: 'sealed' as const,
            generationId: navigation.generationId,
            sealHash: navigation.navigationSealHash,
        },
    };
}

async function publishCurrentAuthorityCheckpoint(
    context: Context,
    codebasePath: string,
): Promise<void> {
    const collectionName = await context.getActiveIndexedCollectionName(codebasePath);
    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(collectionName);
    assert.ok(marker);

    const synchronizer = new FileSynchronizer(
        codebasePath,
        context.getActiveIgnorePatterns(codebasePath),
        context.getIndexedExtensionsForCodebase(codebasePath),
        {
            checkpointIdentity: collectionName,
            checkpointAuthority: {
                collectionName,
                markerRunId: marker.runId,
                indexPolicyHash: marker.indexPolicyHash,
            },
        },
    );
    await synchronizer.initialize();
    context.registerSynchronizer(context.resolveCollectionName(codebasePath), synchronizer);
}

class InMemoryVectorDatabase implements VectorDatabase {
    readonly collections = new Map<string, Map<string, VectorDocument>>();
    readonly queryCalls: Array<{ collectionName: string; filter: string; outputFields: string[] }> = [];
    listCollectionsCalls = 0;
    queryHook?: (call: { collectionName: string; filter: string; outputFields: string[] }) => void | Promise<void>;
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
        this.listCollectionsCalls += 1;
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
        const call = { collectionName, filter: _filter, outputFields };
        this.queryCalls.push(call);
        const rows = this.listDocuments(collectionName, _filter).slice(0, limit).map((document) => {
            const row: Record<string, unknown> = {};
            for (const field of outputFields) {
                row[field] = (document as unknown as Record<string, unknown>)[field];
            }
            return row;
        });
        await this.queryHook?.(call);
        return rows;
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
            kind: 'satori_index_completion_v2',
            codebasePath,
            fingerprint: testIndexFingerprint(),
            indexedFiles: 1,
            totalChunks: 1,
            completedAt: '2026-07-10T00:00:00.000Z',
            runId: 'guard-test',
            indexPolicyHash: 'test-policy',
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
            kind: 'satori_index_completion_v2',
            codebasePath: input.codebasePath,
            fingerprint: testIndexFingerprint(),
            indexedFiles: 1,
            totalChunks: input.totalChunks ?? 1,
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: input.runId,
            indexPolicyHash: 'test-policy',
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

test('Context semantic search diagnostics omit query text and vector samples', async () => {
    const vectorDatabase = new InMemoryVectorDatabase();
    const context = new Context({ embedding: new TestEmbedding(), vectorDatabase });
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
    try {
        await context.semanticSearch({
            codebasePath: '/repo/private-query',
            query: 'SECRET_QUERY_TEXT_93847',
            retrievalMode: 'hybrid',
            scorePolicy: { kind: 'topk_only' },
        });
    } finally {
        console.log = originalLog;
    }

    const output = messages.join('\n');
    assert.doesNotMatch(output, /SECRET_QUERY_TEXT_93847/);
    assert.doesNotMatch(output, /First 5 embedding values/i);
    assert.match(output, /query_length=/);
    assert.doesNotMatch(output, /query_hash=|sha256=/);
    assert.match(output, /request_id=/);
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
                kind: 'satori_index_completion_v2',
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
        const previousMarker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(previousMarker);

        fs.writeFileSync(sourcePath, 'export const runtime = 2;\n', 'utf8');
        const progress: Array<{ current: number; total: number; percentage: number }> = [];
        await context.reindexByChange(codebasePath, (entry) => progress.push(entry));

        const nextMarker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(nextMarker);
        assert.notEqual(nextMarker.runId, previousMarker.runId);
        assert.deepEqual(vectorDatabase.payloadMutationMarkerPresence, [false]);
        assert.ok(progress.every((entry) => entry.current <= entry.total));
        assert.ok(progress.every((entry) => entry.percentage >= 0 && entry.percentage <= 100));
        assert.deepEqual(progress.map((entry) => entry.percentage), [...progress.map((entry) => entry.percentage)].sort((a, b) => a - b));
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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

test('Context bounds invalid and oversized embedding batch sizes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-batch-size-'));
    const sourcePath = path.join(tempRoot, 'many.ts');
    const previousBatchSize = process.env.EMBEDDING_BATCH_SIZE;
    const analyzer: LanguageAnalysisPort = {
        analyze: async () => ({
            chunks: Array.from({ length: 1005 }, (_, index) => ({
                content: `chunk-${index}`,
                metadata: { startLine: 1, endLine: 1, language: 'typescript', filePath: 'many.ts' },
            })),
            symbols: [],
            moduleBindings: [],
            callSites: [],
            backend: 'bounded_text',
            structuralStatus: 'recovered',
            structuralReason: 'unsupported_language',
        }),
        getDescription: () => 'many chunks',
        getStrategyForLanguage: () => ({ backend: 'bounded_text', structural: false }),
    };
    try {
        fs.writeFileSync(sourcePath, 'source', 'utf8');
        for (const testCase of [
            { raw: 'abc', expected: [...Array(10).fill(100), 5] },
            { raw: '0', expected: [...Array(10).fill(100), 5] },
            { raw: '-1', expected: [...Array(10).fill(100), 5] },
            { raw: '1001', expected: [1000, 5] },
        ]) {
            const observedBatchSizes: number[] = [];
            class RecordingBatchEmbedding extends TestEmbedding {
                async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
                    observedBatchSizes.push(texts.length);
                    return super.embedBatch(texts);
                }
            }
            process.env.EMBEDDING_BATCH_SIZE = testCase.raw;
            const vectorDatabase = new InMemoryVectorDatabase();
            await vectorDatabase.createHybridCollection('chunks');
            const context = new Context({
                embedding: new RecordingBatchEmbedding(),
                vectorDatabase,
                languageAnalyzer: analyzer,
            }) as unknown as ContextWithProcessFileList;

            await context.processFileList([sourcePath], tempRoot, undefined, 'chunks');

            assert.deepEqual(observedBatchSizes, testCase.expected, testCase.raw);
        }
    } finally {
        if (previousBatchSize === undefined) delete process.env.EMBEDDING_BATCH_SIZE;
        else process.env.EMBEDDING_BATCH_SIZE = previousBatchSize;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context full-index traversal returns contract-sorted relative paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-traversal-order-'));
    try {
        for (const relativePath of ['z.ts', 'A.ts', 'nested/b.ts', 'nested/a.ts']) {
            const absolutePath = path.join(root, relativePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, 'export const value = true;\n', 'utf8');
        }
        const context = new Context({ embedding: new TestEmbedding(), vectorDatabase: new InMemoryVectorDatabase() }) as unknown as ContextWithGetCodeFiles;
        const files = await context.getCodeFiles(root);
        assert.deepEqual(files.map((file) => path.relative(root, file).replace(/\\/g, '/')), [
            'A.ts',
            'nested/a.ts',
            'nested/b.ts',
            'z.ts',
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Context full-index processing rejects a discovered path replaced by an outside-root symlink', async (t) => {
    if (process.platform !== 'linux') {
        t.skip('descriptor-bound root validation is Linux-only');
        return;
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-root-bound-index-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'secret.ts');
    const outsidePath = path.join(tempRoot, 'outside.ts');
    const analyzer = new RecordingAnalyzer();
    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, 'export const safe = true;\n', 'utf8');
        fs.writeFileSync(outsidePath, 'EXTERNAL_SECRET_SHOULD_NOT_BE_INDEXED\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            languageAnalyzer: analyzer,
        }) as unknown as ContextWithProcessFileList;

        fs.rmSync(sourcePath);
        fs.symlinkSync(outsidePath, sourcePath);
        await assert.rejects(
            () => context.processFileList([sourcePath], codebasePath, undefined, 'chunks'),
            /escapes indexed root|outside|unreadable/i,
        );
        assert.deepEqual(analyzer.analyzeCalls, []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context rejects malformed embedding batches before vector insertion', async () => {
    const invalidResults: Array<{ name: string; result: unknown }> = [
        { name: 'short', result: [] },
        { name: 'extra', result: [{ vector: [0, 0, 0, 0], dimension: 4 }, { vector: [0, 0, 0, 0], dimension: 4 }] },
        { name: 'wrong dimension', result: [{ vector: [0, 0], dimension: 2 }] },
        { name: 'non-array vector', result: [{ vector: 'bad', dimension: 4 }] },
        { name: 'NaN vector', result: [{ vector: [0, 0, Number.NaN, 0], dimension: 4 }] },
        { name: 'infinite vector', result: [{ vector: [0, 0, Number.POSITIVE_INFINITY, 0], dimension: 4 }] },
    ];
    const chunk: CodeChunk = {
        content: 'value',
        metadata: { startLine: 1, endLine: 1, language: 'typescript', filePath: 'value.ts' },
    };

    for (const invalid of invalidResults) {
        const vectorDatabase = new InMemoryVectorDatabase();
        await vectorDatabase.createHybridCollection('chunks');
        class InvalidEmbedding extends TestEmbedding {
            async embedBatch(): Promise<EmbeddingVector[]> {
                return invalid.result as EmbeddingVector[];
            }
        }
        const context = new Context({ embedding: new InvalidEmbedding(), vectorDatabase }) as unknown as ContextWithProcessChunkBatch;
        await assert.rejects(
            () => context.processChunkBatch([{ chunk, relativePath: 'value.ts', fileChunkIndex: 0 }], '/repo', 'chunks'),
            new RegExp('Embedding batch|embedding', 'i'),
            invalid.name,
        );
        assert.equal(vectorDatabase.collections.get('chunks')?.size, 0, invalid.name);
    }
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
            kind: 'satori_index_completion_v3',
            codebasePath: path.resolve(repoPath),
            fingerprint: testIndexFingerprint(),
            indexedFiles: 1,
            totalChunks: 1,
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: 'old_ready_marker',
            indexPolicyHash: 'a'.repeat(64),
            indexStatus: 'completed',
            navigation: { status: 'not_bound' },
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
        assert.equal(
            result.indexedFileHashes.get('src/auth.ts'),
            crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
        );
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
    const content = 'export const auth = true;\n';

    try {
        fs.mkdirSync(path.join(codebasePath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(codebasePath, relativePath), content, 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
        });
        let publicationCalls = 0;

        await (context as unknown as ContextWithNavigationPublisher).writeSymbolRegistryForCompletedIndex(
            codebasePath,
            [],
            [{ path: relativePath, hash: crypto.createHash('sha256').update(content, 'utf8').digest('hex'), language: 'typescript', symbolCount: 0 }],
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
        target: { kind: 'method', name: 'run', qualifiedName: 'Service.run' },
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

test('Context custom index policy preserves omitted fields, supports explicit reset, and survives restart', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-root-policy-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const rootA = path.join(tempRoot, 'repo-a');
    const rootB = path.join(tempRoot, 'repo-b');

    try {
        fs.mkdirSync(rootA, { recursive: true });
        fs.mkdirSync(rootB, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });

        const initialPolicy = await context.resolveIndexPolicyForCodebase(rootA, {
            customExtensions: ['.foo'],
            customIgnorePatterns: ['private/**'],
        });
        context.publishResolvedIndexPolicy(initialPolicy, {
            collectionName: 'generation-a',
            navigation: { status: 'not_bound' },
        });

        const ignoreOnly = await context.resolveIndexPolicyForCodebase(rootA, {
            customIgnorePatterns: ['generated/**'],
        });
        assert.deepEqual(ignoreOnly.customExtensions, ['.foo']);
        context.publishResolvedIndexPolicy(ignoreOnly, {
            collectionName: 'generation-b',
            navigation: { status: 'not_bound' },
        });

        const extensionOnly = await context.resolveIndexPolicyForCodebase(rootA, {
            customExtensions: ['.foo', '.bar'],
        });
        assert.deepEqual(extensionOnly.customIgnorePatterns, ['generated/**']);
        context.publishResolvedIndexPolicy(extensionOnly, {
            collectionName: 'generation-c',
            navigation: { status: 'not_bound' },
        });

        const resetIgnores = await context.resolveIndexPolicyForCodebase(rootA, {
            customIgnorePatterns: [],
        });
        assert.deepEqual(resetIgnores.customExtensions, ['.foo', '.bar']);
        assert.deepEqual(resetIgnores.customIgnorePatterns, []);
        context.publishResolvedIndexPolicy(resetIgnores, {
            collectionName: 'generation-d',
            navigation: { status: 'not_bound' },
        });

        assert.equal(context.getIndexedExtensionsForCodebase(rootA).includes('.foo'), true);
        assert.equal(context.getIndexedExtensionsForCodebase(rootB).includes('.foo'), false);
        assert.equal(context.getIndexedExtensionsForCodebase(rootA).includes('.bar'), true);
        assert.equal(context.getActiveIgnorePatterns(rootA).includes('private/**'), false);
        assert.equal(context.getActiveIgnorePatterns(rootB).includes('private/**'), false);

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        assert.equal(restarted.getIndexedExtensionsForCodebase(rootA).includes('.foo'), true);
        assert.equal(restarted.getIndexedExtensionsForCodebase(rootA).includes('.bar'), true);
        assert.equal(restarted.getActiveIgnorePatterns(rootA).includes('private/**'), false);
        assert.equal(restarted.getIndexedExtensionsForCodebase(rootB).includes('.foo'), false);
        assert.equal(restarted.getActiveIgnorePatterns(rootB).includes('private/**'), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context publishes and reloads the exact root ignore-file policy', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-ignore-policy-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, '.gitignore'), 'generated/**\n!important.ts\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
        assert.deepEqual(policy.fileBasedIgnorePatterns, ['generated/**', '!important.ts']);
        context.publishResolvedIndexPolicy(policy, {
            collectionName: 'generation-a',
            navigation: { status: 'not_bound' },
        });
        assert.equal(context.getActiveIgnorePatterns(codebasePath).includes('generated/**'), true);

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        assert.equal(restarted.getActiveIgnorePatterns(codebasePath).includes('generated/**'), true);
        assert.equal(restarted.getActiveIgnorePatterns(codebasePath).includes('!important.ts'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context preserves ordered duplicate ignore rules around negation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-ignore-order-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(
            path.join(codebasePath, '.gitignore'),
            'generated/**\n!generated/keep.ts\ngenerated/**\n',
            'utf8',
        );
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });

        const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
        assert.deepEqual(policy.fileBasedIgnorePatterns, [
            'generated/**',
            '!generated/keep.ts',
            'generated/**',
        ]);
        context.publishResolvedIndexPolicy(policy, {
            collectionName: 'generation-a',
            navigation: { status: 'not_bound' },
        });

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        assert.deepEqual(restarted.getActiveIgnorePatterns(codebasePath).slice(-3), [
            'generated/**',
            '!generated/keep.ts',
            'generated/**',
        ]);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context reloads policy published by another Context instance', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-reload-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const first = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const second = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const initial = await first.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['private/**'],
        });
        first.publishResolvedIndexPolicy(initial, {
            collectionName: 'generation-a',
            navigation: { status: 'not_bound' },
        });
        assert.equal(second.getActiveIgnorePatterns(codebasePath).includes('private/**'), true);

        const replacement = await first.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });
        first.publishResolvedIndexPolicy(replacement, {
            collectionName: 'generation-b',
            navigation: { status: 'not_bound' },
        });

        assert.equal(second.getActiveIgnorePatterns(codebasePath).includes('private/**'), false);
        assert.equal(second.getActiveIgnorePatterns(codebasePath).includes('generated/**'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context resolves a newly published profile policy on the first active-generation read', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-profile-reload-'));
    const stateRoot = path.join(tempRoot, 'state');
    const policyRoot = path.join(stateRoot, 'policies');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const longLived = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: policyRoot,
        });
        assert.equal(longLived.getIndexedExtensionsForCodebase(codebasePath).includes('.toml'), true);

        fs.writeFileSync(path.join(codebasePath, 'satori.toml'), '[index]\nprofile = "minimal"\n', 'utf8');
        const publisher = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: policyRoot,
        });
        const policy = await publisher.resolveIndexPolicyForCodebase(codebasePath);
        await publisher.indexCodebase(codebasePath, undefined, false, { indexPolicy: policy });
        const navigation = await publisher.getCurrentNavigationGeneration(codebasePath);
        assert.ok(navigation);
        publisher.publishResolvedIndexPolicy(
            policy,
            sealedPolicyBinding(publisher.resolveCollectionName(codebasePath), navigation),
        );

        assert.equal(
            await longLived.getActiveIndexedCollectionName(codebasePath),
            publisher.resolveCollectionName(codebasePath),
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context keeps durable and runtime policy consistent when the publication wrapper throws after publish', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-receipt-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const previous = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['private/**'],
        });
        context.publishResolvedIndexPolicy(previous, {
            collectionName: 'generation-a',
            navigation: { status: 'not_bound' },
        });
        const candidate = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });

        assert.throws(
            () => context.publishResolvedIndexPolicy(
                candidate,
                { collectionName: 'generation-b', navigation: { status: 'not_bound' } },
                (publish) => {
                    publish();
                    throw new Error('lease wrapper rejected publication receipt');
                },
            ),
            (error: unknown) => {
                assert.ok(error instanceof IndexPolicyPublicationError);
                assert.equal(error.committed, true);
                assert.equal(error.receipt.status, 'committed');
                assert.equal(error.receipt.operation, 'publish');
                assert.equal(error.receipt.collectionName, 'generation-b');
                assert.deepEqual(error.receipt.navigation, { status: 'not_bound' });
                return true;
            },
        );
        assert.equal(context.getActiveIgnorePatterns(codebasePath).includes('private/**'), false);
        assert.equal(context.getActiveIgnorePatterns(codebasePath).includes('generated/**'), true);

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        assert.equal(restarted.getActiveIgnorePatterns(codebasePath).includes('private/**'), false);
        assert.equal(restarted.getActiveIgnorePatterns(codebasePath).includes('generated/**'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context direct indexing treats a matching committed policy receipt as successful publication', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-direct-committed-policy-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        const originalPublish = context.publishResolvedIndexPolicy.bind(context);
        context.publishResolvedIndexPolicy = ((policy, binding) => originalPublish(
            policy,
            binding,
            (publish) => {
                publish();
                throw new Error('receipt acknowledgement failed');
            },
        )) as typeof context.publishResolvedIndexPolicy;

        const result = await context.indexCodebase(codebasePath);
        const proven = await context.resolveProvenGeneration(codebasePath);

        assert.equal(result.status, 'completed');
        assert.equal(proven?.collectionName, context.resolveCollectionName(codebasePath));
        assert.equal(proven?.marker.indexStatus, 'completed');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context direct indexing preserves the committed publication error when generation reproof throws', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-direct-committed-reproof-error-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        const originalPublish = context.publishResolvedIndexPolicy.bind(context);
        context.publishResolvedIndexPolicy = ((policy, binding) => originalPublish(
            policy,
            binding,
            (publish) => {
                publish();
                throw new Error('receipt acknowledgement failed');
            },
        )) as typeof context.publishResolvedIndexPolicy;
        context.resolveProvenGeneration = async () => {
            throw new Error('generation reproof failed');
        };

        await assert.rejects(
            () => context.indexCodebase(codebasePath),
            (error: unknown) => {
                assert.ok(error instanceof IndexPolicyPublicationError);
                assert.match(error.message, /receipt acknowledgement failed/);
                assert.doesNotMatch(error.message, /generation reproof failed/);
                return true;
            },
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context incremental sync clears its mutation target after a matching committed policy receipt', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-committed-policy-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'runtime.ts');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
        const originalPublish = context.publishResolvedIndexPolicy.bind(context);
        context.publishResolvedIndexPolicy = ((policy, binding) => originalPublish(
            policy,
            binding,
            (publish) => {
                publish();
                throw new Error('receipt acknowledgement failed');
            },
        )) as typeof context.publishResolvedIndexPolicy;

        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);
        const privateContext = context as unknown as {
            synchronizerMutationTargets: Map<string, string>;
        };

        assert.equal(result.modified, 1);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), context.resolveCollectionName(codebasePath));
        assert.equal(privateContext.synchronizerMutationTargets.has(context.resolveCollectionName(codebasePath)), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context policy removal reports a committed receipt when its wrapper throws after publish', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-clear-receipt-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });
        const publishReceipt = context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));
        assert.equal(publishReceipt.operation, 'publish');

        assert.throws(
            () => context.clearPublishedIndexPolicy(codebasePath, (publish) => {
                publish();
                throw new Error('lease wrapper rejected removal receipt');
            }, publishReceipt.documentDigest),
            (error: unknown) => {
                assert.ok(error instanceof IndexPolicyPublicationError);
                assert.equal(error.committed, true);
                assert.equal(error.receipt.status, 'committed');
                assert.equal(error.receipt.operation, 'clear');
                assert.equal(error.receipt.previousDocumentDigest !== null, true);
                return true;
            },
        );
        assert.equal(context.getActiveIgnorePatterns(codebasePath).includes('generated/**'), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context policy removal reports a committed receipt when runtime reconciliation fails after removal', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-clear-runtime-failure-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
        const publishReceipt = context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(policy.canonicalRoot).digest('hex')}.json`,
        );
        const privateContext = context as unknown as {
            clearResolvedIndexPolicyRuntime(root: string): void;
        };
        privateContext.clearResolvedIndexPolicyRuntime = () => {
            throw new Error('runtime reconciliation failed');
        };

        assert.throws(
            () => context.clearPublishedIndexPolicy(
                codebasePath,
                (publish) => publish(),
                publishReceipt.operation === 'publish' ? publishReceipt.documentDigest : '',
            ),
            (error: unknown) => {
                assert.ok(error instanceof IndexPolicyPublicationError);
                assert.equal(error.committed, true);
                assert.equal(error.receipt.operation, 'clear');
                assert.match(error.message, /runtime reconciliation failed/);
                return true;
            },
        );
        assert.equal(fs.existsSync(policyPath), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context policy removal rejects a concurrently replaced document', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-clear-exact-digest-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const first = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const second = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const initialPolicy = await first.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['initial/**'],
        });
        const initialReceipt = first.publishResolvedIndexPolicy(initialPolicy, unboundPolicyBinding('generation-a'));
        const replacementPolicy = await second.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['replacement/**'],
        });
        assert.throws(() => first.clearPublishedIndexPolicy(codebasePath, (publish) => {
            const replacementReceipt = second.publishResolvedIndexPolicy(
                replacementPolicy,
                unboundPolicyBinding('generation-b'),
            );
            assert.equal(replacementReceipt.operation, 'publish');
            publish();
        }, initialReceipt.operation === 'publish' ? initialReceipt.documentDigest : ''), /changed before removal/i);

        const fresh = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const activePolicy = await fresh.resolveIndexPolicyForCodebase(codebasePath);
        assert.equal(activePolicy.policyHash, replacementPolicy.policyHash);
        assert.equal(fresh.getActiveIgnorePatterns(codebasePath).includes('replacement/**'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context policy removal compares the expected digest with the document actually tombstoned', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-clear-post-rename-digest-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const replacementPolicyRoot = path.join(tempRoot, 'replacement-policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const initialPolicy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['initial/**'],
        });
        const initialReceipt = context.publishResolvedIndexPolicy(initialPolicy, unboundPolicyBinding('generation-a'));
        assert.equal(initialReceipt.operation, 'publish');

        const replacementWriter = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: replacementPolicyRoot,
        });
        const replacementPolicy = await replacementWriter.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['replacement/**'],
        });
        replacementWriter.publishResolvedIndexPolicy(replacementPolicy, unboundPolicyBinding('generation-b'));
        const policyKey = `${crypto.createHash('sha256').update(initialPolicy.canonicalRoot).digest('hex')}.json`;
        const policyPath = path.join(policyRoot, policyKey);
        const replacementDocument = fs.readFileSync(path.join(replacementPolicyRoot, policyKey));
        const originalRenameSync = fs.renameSync;
        let injectedReplacement = false;
        fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
            originalRenameSync(source, destination);
            if (
                String(source) === policyPath
                && String(destination).startsWith(`${policyPath}.removed-`)
            ) {
                fs.writeFileSync(destination, replacementDocument);
                injectedReplacement = true;
            }
        }) as typeof fs.renameSync;
        try {
            assert.throws(
                () => context.clearPublishedIndexPolicy(
                    codebasePath,
                    (publish) => publish(),
                    initialReceipt.documentDigest,
                ),
                /changed before removal/i,
            );
        } finally {
            fs.renameSync = originalRenameSync;
        }

        assert.equal(injectedReplacement, true);
        const fresh = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const durablePolicy = await fresh.resolveIndexPolicyForCodebase(codebasePath);
        assert.equal(durablePolicy.policyHash, replacementPolicy.policyHash);
        assert.equal(fresh.getActiveIgnorePatterns(codebasePath).includes('replacement/**'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context serializes direct publish and compare-clear through the same Core policy lock', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-core-lock-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const first = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const second = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const initialPolicy = await first.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['initial/**'],
        });
        const initialReceipt = first.publishResolvedIndexPolicy(initialPolicy, unboundPolicyBinding('generation-a'));
        assert.equal(initialReceipt.operation, 'publish');
        const replacementPolicy = await second.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['replacement/**'],
        });
        const privateFirst = first as unknown as {
            withIndexPolicyMutationLock<T>(canonicalRoot: string, operation: () => T): T;
        };

        privateFirst.withIndexPolicyMutationLock(initialPolicy.canonicalRoot, () => {
            assert.throws(
                () => second.publishResolvedIndexPolicy(replacementPolicy, unboundPolicyBinding('generation-b')),
                /policy mutation lock is already held/i,
            );
            assert.throws(
                () => second.clearPublishedIndexPolicy(
                    codebasePath,
                    (publish) => publish(),
                    initialReceipt.documentDigest,
                ),
                /policy mutation lock is already held/i,
            );
        });

        const fresh = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const durablePolicy = await fresh.resolveIndexPolicyForCodebase(codebasePath);
        assert.equal(durablePolicy.policyHash, initialPolicy.policyHash);
        assert.equal(fresh.getActiveIgnorePatterns(codebasePath).includes('initial/**'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context recovers a policy mutation lock abandoned by a crashed child process', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-dead-lock-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.mkdirSync(policyRoot, { recursive: true });
        const canonicalRoot = fs.realpathSync.native(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const lockPath = `${policyPath}.mutation.lock`;
        const child = spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs');
            const raw = fs.readFileSync('/proc/self/stat', 'utf8');
            const close = raw.lastIndexOf(')');
            const fields = raw.slice(close + 2).trim().split(/\\s+/);
            fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({
                pid: process.pid,
                processStartTime: fields[19],
                ownerToken: 'crashed-child-owner',
                acquiredAt: new Date().toISOString(),
            }));
        `], { encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(fs.existsSync(lockPath), true);

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });
        const receipt = context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));

        assert.equal(receipt.operation, 'publish');
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context preserves a compare-clear tombstone when mismatch restoration fails', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-restore-failure-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });
        context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));
        const canonicalRoot = fs.realpathSync.native(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const originalRenameSync = fs.renameSync;
        fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike) => {
            if (String(source).startsWith(`${policyPath}.removed-`) && String(destination) === policyPath) {
                const error = new Error('injected restore failure') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            }
            return originalRenameSync(source, destination);
        }) as typeof fs.renameSync;
        try {
            assert.throws(
                () => context.clearPublishedIndexPolicy(
                    codebasePath,
                    (publish) => publish(),
                    '0'.repeat(64),
                ),
                /injected restore failure|tombstone/i,
            );
        } finally {
            fs.renameSync = originalRenameSync;
        }

        assert.equal(fs.existsSync(policyPath), false);
        assert.equal(
            fs.readdirSync(policyRoot).some((entry) => entry.startsWith(`${path.basename(policyPath)}.removed-`)),
            true,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context preserves both policy documents when mismatch restoration finds an occupied target', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-restore-conflict-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const replacementRoot = path.join(tempRoot, 'replacement');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({ embedding: new TestEmbedding(), vectorDatabase: new InMemoryVectorDatabase(), indexPolicyStateRoot: policyRoot });
        const initialPolicy = await context.resolveIndexPolicyForCodebase(codebasePath, { customIgnorePatterns: ['initial/**'] });
        context.publishResolvedIndexPolicy(initialPolicy, unboundPolicyBinding('generation-a'));
        const replacement = new Context({ embedding: new TestEmbedding(), vectorDatabase: new InMemoryVectorDatabase(), indexPolicyStateRoot: replacementRoot });
        const replacementPolicy = await replacement.resolveIndexPolicyForCodebase(codebasePath, { customIgnorePatterns: ['replacement/**'] });
        replacement.publishResolvedIndexPolicy(replacementPolicy, unboundPolicyBinding('generation-b'));
        const policyKey = `${crypto.createHash('sha256').update(initialPolicy.canonicalRoot).digest('hex')}.json`;
        const policyPath = path.join(policyRoot, policyKey);
        const replacementBytes = fs.readFileSync(path.join(replacementRoot, policyKey));
        const originalExistsSync = fs.existsSync;
        let injectedTarget = false;
        fs.existsSync = ((candidate: fs.PathLike) => {
            if (
                String(candidate) === policyPath
                && !injectedTarget
                && fs.readdirSync(policyRoot).some((entry) => entry.startsWith(`${policyKey}.removed-`))
            ) {
                fs.writeFileSync(policyPath, replacementBytes);
                injectedTarget = true;
            }
            return originalExistsSync(candidate);
        }) as typeof fs.existsSync;
        try {
            assert.throws(
                () => context.clearPublishedIndexPolicy(codebasePath, (publish) => publish(), '0'.repeat(64)),
                /preserved conflicting tombstone/i,
            );
        } finally {
            fs.existsSync = originalExistsSync;
        }

        assert.equal(injectedTarget, true);
        assert.equal(fs.existsSync(policyPath), true);
        assert.equal(fs.readdirSync(policyRoot).some((entry) => entry.startsWith(`${policyKey}.removed-`)), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context restores one valid pending policy tombstone before the next publication', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-pending-recovery-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({ embedding: new TestEmbedding(), vectorDatabase: new InMemoryVectorDatabase(), indexPolicyStateRoot: policyRoot });
        const initialPolicy = await context.resolveIndexPolicyForCodebase(codebasePath, { customIgnorePatterns: ['initial/**'] });
        context.publishResolvedIndexPolicy(initialPolicy, unboundPolicyBinding('generation-a'));
        const policyPath = path.join(policyRoot, `${crypto.createHash('sha256').update(initialPolicy.canonicalRoot).digest('hex')}.json`);
        const pendingPath = `${policyPath}.removed-crashed-writer`;
        fs.renameSync(policyPath, pendingPath);

        const replacementPolicy = await context.resolveIndexPolicyForCodebase(codebasePath, { customIgnorePatterns: ['replacement/**'] });
        context.publishResolvedIndexPolicy(replacementPolicy, unboundPolicyBinding('generation-b'));

        assert.equal(fs.existsSync(policyPath), true);
        assert.equal(fs.existsSync(pendingPath), false);
        const fresh = new Context({ embedding: new TestEmbedding(), vectorDatabase: new InMemoryVectorDatabase(), indexPolicyStateRoot: policyRoot });
        assert.equal((await fresh.resolveIndexPolicyForCodebase(codebasePath)).policyHash, replacementPolicy.policyHash);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context recovers a policy lock whose PID was reused by another process identity', async () => {
    if (process.platform !== 'linux') return;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-pid-reuse-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.mkdirSync(policyRoot, { recursive: true });
        const canonicalRoot = fs.realpathSync.native(codebasePath);
        const policyPath = path.join(policyRoot, `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`);
        fs.writeFileSync(`${policyPath}.mutation.lock`, JSON.stringify({
            pid: process.pid,
            processStartTime: 'different-process-start',
            ownerToken: 'reused-pid-owner',
            acquiredAt: new Date().toISOString(),
        }));
        const context = new Context({ embedding: new TestEmbedding(), vectorDatabase: new InMemoryVectorDatabase(), indexPolicyStateRoot: policyRoot });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
        assert.equal(context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a')).operation, 'publish');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context clearIndex leaves runtime policy authority intact when the policy lock is unavailable', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-clear-policy-lock-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });
        context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));
        const canonicalRoot = fs.realpathSync.native(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const lockPath = `${policyPath}.mutation.lock`;
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: process.pid,
            ownerToken: 'live-test-owner',
            acquiredAt: new Date().toISOString(),
        }));

        await assert.rejects(() => context.clearIndex(codebasePath), /policy mutation lock/i);
        assert.equal(fs.existsSync(policyPath), true);
        assert.equal(context.getActiveIgnorePatterns(codebasePath).includes('generated/**'), true);
        const runtimeState = context as unknown as {
            publishedResolvedPoliciesByCodebase: Map<string, unknown>;
            publishedPolicyBindingsByCodebase: Map<string, unknown>;
        };
        assert.equal(runtimeState.publishedResolvedPoliciesByCodebase.has(canonicalRoot), true);
        assert.equal(runtimeState.publishedPolicyBindingsByCodebase.has(canonicalRoot), true);
        fs.rmSync(lockPath, { force: true });
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context policy removal reconciles runtime state after removing a malformed document', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-clear-malformed-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });
        context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(policy.canonicalRoot).digest('hex')}.json`,
        );
        fs.writeFileSync(policyPath, '{"documentDigest":"invalid"}\n', 'utf8');

        assert.throws(
            () => context.forceClearPublishedIndexPolicy(codebasePath, (publish) => publish()),
            (error: unknown) => error instanceof IndexPolicyPublicationError && error.committed,
        );
        assert.equal(fs.existsSync(policyPath), false);
        const runtimeState = context as unknown as {
            publishedResolvedPoliciesByCodebase: Map<string, unknown>;
            publishedPolicyBindingsByCodebase: Map<string, unknown>;
            runtimeCustomIgnorePatternsByCodebase: Map<string, unknown>;
            policyRuntimeCompatibilityByCodebase: Map<string, unknown>;
        };
        assert.equal(runtimeState.publishedResolvedPoliciesByCodebase.has(policy.canonicalRoot), false);
        assert.equal(runtimeState.publishedPolicyBindingsByCodebase.has(policy.canonicalRoot), false);
        assert.equal(runtimeState.runtimeCustomIgnorePatternsByCodebase.has(policy.canonicalRoot), false);
        assert.equal(runtimeState.policyRuntimeCompatibilityByCodebase.has(policy.canonicalRoot), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context fenced policy publication removes orphaned removal tombstones', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-tombstone-cleanup-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
        });
        const initialPolicy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['initial/**'],
        });
        context.publishResolvedIndexPolicy(initialPolicy, unboundPolicyBinding('generation-a'));
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(initialPolicy.canonicalRoot).digest('hex')}.json`,
        );
        const orphanedTombstone = `${policyPath}.removed-dead-test`;
        fs.copyFileSync(policyPath, orphanedTombstone);

        const replacementPolicy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['replacement/**'],
        });
        context.publishResolvedIndexPolicy(
            replacementPolicy,
            unboundPolicyBinding('generation-b'),
            (publish) => publish(),
        );

        assert.equal(fs.existsSync(orphanedTombstone), false);
        assert.equal(fs.existsSync(policyPath), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation rejects a missing policy-bound collection instead of falling back to base', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-validation-missing-bound-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);
        const proven = await context.resolveProvenGeneration(codebasePath);
        assert.ok(proven);
        context.publishResolvedIndexPolicy(
            proven.policy,
            sealedPolicyBinding(
                context.resolveStagedCollectionName(codebasePath, 'missing'),
                proven.navigation,
            ),
        );

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'invalid_v3' },
        );
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation rejects a markerless policy-bound collection instead of falling back to base', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-validation-markerless-bound-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);
        const proven = await context.resolveProvenGeneration(codebasePath);
        assert.ok(proven);
        const markerlessCollection = context.resolveStagedCollectionName(codebasePath, 'markerless');
        await vectorDatabase.createHybridCollection(markerlessCollection, 4);
        context.publishResolvedIndexPolicy(
            proven.policy,
            sealedPolicyBinding(markerlessCollection, proven.navigation),
        );

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'invalid_v3' },
        );
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation rejects runtime-incompatible profile authority', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-validation-profile-drift-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);
        fs.writeFileSync(
            path.join(codebasePath, 'satori.toml'),
            '[index]\nprofile = "minimal"\n',
            'utf8',
        );

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'runtime_policy_incompatible' },
        );
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation preserves vector authority when navigation is missing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-validation-navigation-missing-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);
        fs.rmSync(path.join(resolveNavigationSidecarRoot(navigationStateRoot, codebasePath), 'current.json'));

        const evidence = await context.getIndexCompletionMarkerForValidation(codebasePath);
        assert.equal(evidence.status, 'valid_v3');
        if (evidence.status === 'valid_v3') {
            assert.equal(evidence.navigationProof.status, 'missing');
            assert.equal(evidence.generationReceipt, undefined);
        }
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation propagates transient and unavailable payload probes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-validation-probe-failed-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);
        vectorDatabase.queryHook = (call) => {
            if (call.filter.includes('fileExtension != ".satori_meta"')) {
                throw new Error('temporary count failure');
            }
        };
        await assert.rejects(
            () => context.getIndexCompletionMarkerForValidation(codebasePath),
            /temporary count failure/,
        );

        vectorDatabase.queryHook = undefined;
        const collectionName = context.resolveCollectionName(codebasePath);
        const markerDocument = vectorDatabase.collections.get(collectionName)?.get(INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(markerDocument && typeof markerDocument.metadata === 'object');
        (markerDocument!.metadata as Record<string, unknown>).totalChunks = 16384;
        await assert.rejects(
            () => context.getIndexCompletionMarkerForValidation(codebasePath),
            /Exact indexed payload count is unavailable/,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation preserves vector authority when navigation manifests are corrupt', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-validation-navigation-corrupt-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);
        const receipt = await context.proveIndexedGeneration(codebasePath);
        assert.ok(receipt?.navigation);
        const generationRoot = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, codebasePath),
            'generations',
            receipt!.navigation!.generationId,
        );
        fs.writeFileSync(path.join(generationRoot, 'relationships', 'manifest.json'), '{', 'utf8');

        const evidence = await context.getIndexCompletionMarkerForValidation(codebasePath);
        assert.equal(evidence.status, 'valid_v3');
        if (evidence.status === 'valid_v3') {
            assert.equal(evidence.navigationProof.status, 'corrupt');
            assert.equal(evidence.generationReceipt, undefined);
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context refuses a retired v2 marker under durable v3 authority without mutating canonical policy or pointer', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-validation-bound-v2-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const policyRoot = path.join(tempRoot, 'policies');
        const navigationRoot = path.join(tempRoot, 'navigation');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: navigationRoot,
        });
        await context.indexCodebase(codebasePath);
        const collectionName = context.resolveCollectionName(codebasePath);
        const marker = vectorDatabase.collections.get(collectionName)?.get(INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(marker && typeof marker.metadata === 'object');
        const trustedFingerprint = structuredClone(
            (marker.metadata as { fingerprint: IndexCompletionFingerprint }).fingerprint,
        );
        marker.metadata = {
            ...(marker.metadata as Record<string, unknown>),
            kind: 'satori_index_completion_v2',
        };
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(fs.realpathSync(codebasePath)).digest('hex')}.json`,
        );
        const pointerPath = path.join(resolveNavigationSidecarRoot(navigationRoot, codebasePath), 'current.json');
        const markerBefore = structuredClone(marker.metadata);
        const policyBefore = fs.readFileSync(policyPath, 'utf8');
        const pointerBefore = fs.readFileSync(pointerPath, 'utf8');

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'requires_reindex' },
        );
        const repair = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });
        assert.equal(repair.status, 'requires_reindex');
        assert.deepEqual(marker.metadata, markerBefore);
        assert.equal(fs.readFileSync(policyPath, 'utf8'), policyBefore);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context does not overwrite a newer policy publication when an older publication wrapper throws', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-stale-rollback-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const first = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const second = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const previous = await first.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['previous/**'],
        });
        first.publishResolvedIndexPolicy(previous, unboundPolicyBinding('generation-a'));
        const staleCandidate = await first.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['stale/**'],
        });
        const newer = await second.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['newer/**'],
        });

        assert.throws(
            () => first.publishResolvedIndexPolicy(
                staleCandidate,
                unboundPolicyBinding('generation-b'),
                (publish) => {
                    publish();
                    second.publishResolvedIndexPolicy(newer, unboundPolicyBinding('generation-c'));
                    throw new Error('stale publication receipt rejected');
                },
            ),
            /stale publication receipt rejected/,
        );

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        assert.equal(restarted.getActiveIgnorePatterns(codebasePath).includes('newer/**'), true);
        assert.equal(restarted.getActiveIgnorePatterns(codebasePath).includes('previous/**'), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context reuses the compiled ignore matcher while the durable policy is unchanged', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-cache-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['generated/**'],
        });
        context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));

        const privateContext = context as unknown as {
            getIgnoreMatcherForCodebase(root: string): ReturnType<typeof import('ignore').default>;
        };
        const firstMatcher = privateContext.getIgnoreMatcherForCodebase(codebasePath);
        const secondMatcher = privateContext.getIgnoreMatcherForCodebase(codebasePath);
        assert.equal(secondMatcher, firstMatcher);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context treats changed runtime policy inputs as reindexable compatibility drift', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-runtime-drift-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const publisher = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
            ignorePatterns: ['old-runtime/**'],
        });
        const accepted = await publisher.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['custom/**'],
        });
        publisher.publishResolvedIndexPolicy(accepted, unboundPolicyBinding('generation-a'));

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
            ignorePatterns: ['new-runtime/**'],
        });
        const replacement = await restarted.resolveIndexPolicyForCodebase(codebasePath);
        assert.equal(replacement.customIgnorePatterns.includes('custom/**'), true);
        assert.equal(replacement.effectiveIgnorePatterns.includes('new-runtime/**'), true);
        assert.equal(replacement.effectiveIgnorePatterns.includes('old-runtime/**'), false);
        assert.notEqual(replacement.policyHash, accepted.policyHash);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context invalidates and cannot republish an accepted generation after same-process runtime policy drift', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-same-process-drift-'));
    const policyRoot = path.join(tempRoot, 'policy-state');
    const navigationRoot = path.join(tempRoot, 'navigation-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: navigationRoot,
            ignorePatterns: ['old-runtime/**'],
        });
        const accepted = await context.resolveIndexPolicyForCodebase(codebasePath);
        await context.indexCodebase(codebasePath, undefined, false, { indexPolicy: accepted });
        const collectionName = context.resolveCollectionName(codebasePath);
        const navigation = await context.getCurrentNavigationGeneration(codebasePath);
        assert.ok(navigation);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), collectionName);

        context.updateIgnorePatterns(['new-runtime/**']);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);

        context.publishResolvedIndexPolicy(
            accepted,
            sealedPolicyBinding(collectionName, navigation),
        );
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: navigationRoot,
            ignorePatterns: ['new-runtime/**'],
        });
        assert.equal(await restarted.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context invalidates an accepted generation after a same-process repository profile reload', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-profile-drift-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), context.resolveCollectionName(codebasePath));

        fs.writeFileSync(path.join(codebasePath, 'satori.toml'), '[index]\nprofile = "minimal"\n', 'utf8');
        context.loadIndexProfileForCodebase(codebasePath);

        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange fails before mutation after external repository profile drift', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-profile-drift-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'runtime.ts');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        fs.writeFileSync(
            path.join(codebasePath, 'satori.toml'),
            '[index]\nprofile = "minimal"\n',
            'utf8',
        );
        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');

        let payloadMutationAttempted = false;
        const privateContext = context as unknown as ContextWithDeleteFileChunks;
        const originalDelete = privateContext.deleteFileChunks.bind(context);
        privateContext.deleteFileChunks = async (...args) => {
            payloadMutationAttempted = true;
            return originalDelete(...args);
        };

        await assert.rejects(
            () => context.reindexByChange(codebasePath),
            /runtime-compatible sealed index policy/i,
        );
        assert.equal(payloadMutationAttempted, false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange requires readable sealed policy authority before mutating an accepted generation', async (t) => {
    const cases: Array<{
        name: string;
        corrupt(policyPath: string): void;
        expectedError: RegExp;
    }> = [
        {
            name: 'deleted durable policy',
            corrupt: (policyPath) => fs.rmSync(policyPath, { force: true }),
            expectedError: /no runtime-compatible sealed index policy/i,
        },
        {
            name: 'malformed durable policy JSON',
            corrupt: (policyPath) => fs.writeFileSync(policyPath, '{malformed', 'utf8'),
            expectedError: /Malformed custom index policy/i,
        },
        {
            name: 'invalid durable policy digest',
            corrupt: (policyPath) => {
                const document = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
                fs.writeFileSync(policyPath, JSON.stringify({ ...document, documentDigest: '0'.repeat(64) }), 'utf8');
            },
            expectedError: /document digest is invalid/i,
        },
    ];

    for (const testCase of cases) {
        await t.test(testCase.name, async () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-sealed-policy-'));
            const codebasePath = path.join(tempRoot, 'repo');
            const sourcePath = path.join(codebasePath, 'runtime.ts');
            const policyRoot = path.join(tempRoot, 'policies');
            try {
                fs.mkdirSync(codebasePath, { recursive: true });
                fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
                const vectorDatabase = new InMemoryVectorDatabase();
                const context = new Context({
                    embedding: new TestEmbedding(),
                    vectorDatabase,
                    indexPolicyStateRoot: policyRoot,
                    symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
                });
                await context.recreateSynchronizerForCodebase(codebasePath);
                await context.indexCodebase(codebasePath);
                const canonicalRoot = fs.realpathSync.native(codebasePath);
                const policyPath = path.join(
                    policyRoot,
                    `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
                );
                testCase.corrupt(policyPath);
                fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
                vectorDatabase.mutationCalls.length = 0;

                await assert.rejects(
                    () => context.reindexByChange(codebasePath),
                    testCase.expectedError,
                );
                assert.deepEqual(vectorDatabase.mutationCalls, []);
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });
    }
});

test('Context ignore policy rejects an outside-root ignore-file symlink', async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-ignore-link-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const outsidePath = path.join(tempRoot, 'outside-ignore');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(outsidePath, 'outside-secret-pattern\n', 'utf8');
        try {
            fs.symlinkSync(outsidePath, path.join(codebasePath, '.gitignore'));
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
                t.skip(`File symlinks are unavailable on this platform: ${code}`);
                return;
            }
            throw error;
        }
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
        });
        await assert.rejects(
            () => context.resolveIndexPolicyForCodebase(codebasePath),
            /ignore file.*symbolic link/i,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context resolves the repository index profile without caller ordering', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-profile-policy-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'satori.toml'), '[index]\nprofile = "all-text"\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
        assert.equal(policy.profile, 'all-text');
        assert.equal(policy.supportedExtensions.includes('<all-text>'), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context rejects a corrupted current-format custom index policy', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-corrupt-'));
    const stateRoot = path.join(tempRoot, 'policy-state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customExtensions: ['.foo'],
        });
        context.publishResolvedIndexPolicy(policy, unboundPolicyBinding('generation-a'));

        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            stateRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const document = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(policyPath, JSON.stringify({ ...document, customExtensions: ['.tampered'] }), 'utf8');

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: stateRoot,
        });
        assert.throws(
            () => restarted.getIndexedExtensionsForCodebase(codebasePath),
            /Malformed custom index policy.*digest is invalid/i,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context active collection resolution rejects a different published index policy', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-marker-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);
        assert.ok(await context.getActiveIndexedCollectionName(codebasePath));

        const changedPolicy = await context.resolveIndexPolicyForCodebase(codebasePath, {
            customIgnorePatterns: ['runtime.ts'],
        });
        context.publishResolvedIndexPolicy(changedPolicy, unboundPolicyBinding('different-generation'));

        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context active collection resolution requires the durable policy document after restart', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-policy-required-'));
    const stateRoot = path.join(tempRoot, 'state');
    const policyRoot = path.join(stateRoot, 'policies');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: policyRoot,
        });
        await context.indexCodebase(codebasePath);
        const acceptedPolicy = await context.resolveIndexPolicyForCodebase(codebasePath);
        const navigation = await context.getCurrentNavigationGeneration(codebasePath);
        assert.ok(navigation);
        context.publishResolvedIndexPolicy(
            acceptedPolicy,
            sealedPolicyBinding(context.resolveCollectionName(codebasePath), navigation),
        );
        assert.ok(await context.getActiveIndexedCollectionName(codebasePath));

        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(fs.realpathSync(codebasePath)).digest('hex')}.json`,
        );
        fs.rmSync(policyPath);
        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: policyRoot,
        });
        assert.equal(await restarted.getActiveIndexedCollectionName(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context proven generation returns the sealed policy after ignore-file changes and restart', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-proven-policy-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        fs.writeFileSync(path.join(codebasePath, '.gitignore'), 'private/**\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);
        const acceptedPolicy = await context.resolveIndexPolicyForCodebase(codebasePath);
        const acceptedNavigation = await context.getCurrentNavigationGeneration(codebasePath);
        assert.ok(acceptedNavigation);
        context.publishResolvedIndexPolicy(
            acceptedPolicy,
            sealedPolicyBinding(context.resolveCollectionName(codebasePath), acceptedNavigation),
        );

        const initial = await context.resolveProvenGeneration(codebasePath);
        assert.ok(initial);
        assert.deepEqual(initial?.policy.fileBasedIgnorePatterns, ['private/**']);
        const initialPolicyHash = initial?.policy.policyHash;

        fs.writeFileSync(path.join(codebasePath, '.gitignore'), 'generated/**\n', 'utf8');
        const unchanged = await context.resolveProvenGeneration(codebasePath);
        assert.equal(unchanged?.policy.policyHash, initialPolicyHash);
        assert.deepEqual(unchanged?.policy.fileBasedIgnorePatterns, ['private/**']);

        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        const afterRestart = await restarted.resolveProvenGeneration(codebasePath);
        assert.equal(afterRestart?.policy.policyHash, initialPolicyHash);
        assert.deepEqual(afterRestart?.policy.fileBasedIgnorePatterns, ['private/**']);
        assert.equal(afterRestart?.navigation?.generationId, initial?.navigation?.generationId);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context sealed generation proof avoids family scans and revalidates a prior receipt exactly', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-proven-receipt-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);

        vectorDatabase.listCollectionsCalls = 0;
        vectorDatabase.queryCalls.length = 0;
        const first = await context.proveIndexedGeneration(codebasePath);
        assert.ok(first);
        const authorityObservation = context.getIndexAuthorityObservation(codebasePath);
        assert.ok(authorityObservation);
        assert.match(first.policyDocumentDigest, /^[a-f0-9]{64}$/);
        assert.equal(first.exactPayloadCount, first.marker.totalChunks);
        assert.equal(vectorDatabase.listCollectionsCalls, 0);
        assert.equal(
            vectorDatabase.queryCalls.filter((call) => call.filter.includes(`id == \"${INDEX_COMPLETION_MARKER_DOC_ID}\"`)).length,
            2,
        );
        assert.equal(
            vectorDatabase.queryCalls.filter((call) => call.filter.includes('fileExtension != \".satori_meta\"')).length,
            1,
        );

        vectorDatabase.listCollectionsCalls = 0;
        vectorDatabase.queryCalls.length = 0;
        const second = await context.proveIndexedGeneration(codebasePath, first);
        assert.ok(second);
        assert.equal(second.marker.runId, first.marker.runId);
        assert.equal(second.policyDocumentDigest, first.policyDocumentDigest);
        assert.deepEqual(second.observations, first.observations);
        assert.equal(context.getIndexAuthorityObservation(codebasePath), authorityObservation);
        assert.equal(vectorDatabase.listCollectionsCalls, 0);
        assert.equal(
            vectorDatabase.queryCalls.filter((call) => call.filter.includes(`id == \"${INDEX_COMPLETION_MARKER_DOC_ID}\"`)).length,
            2,
        );
        assert.equal(
            vectorDatabase.queryCalls.filter((call) => call.filter.includes('fileExtension != \".satori_meta\"')).length,
            1,
        );
        vectorDatabase.queryCalls.length = 0;
        const warm = await context.revalidateProvenGeneration(codebasePath, second);
        assert.ok(warm);
        assert.equal(
            vectorDatabase.queryCalls.filter((call) => call.filter.includes(`id == \"${INDEX_COMPLETION_MARKER_DOC_ID}\"`)).length,
            1,
        );
        assert.equal(
            vectorDatabase.queryCalls.filter((call) => call.filter.includes('fileExtension != \".satori_meta\"')).length,
            0,
        );
        assert.equal(await context.revalidateProvenGeneration(codebasePath, {
            ...second,
            exactPayloadCount: second.exactPayloadCount + 1,
        }), null);
        const normalized = await context.revalidateProvenGeneration(codebasePath, {
            ...second,
            policy: { ...second.policy, customExtensions: ['.forged'] },
        });
        assert.ok(normalized);
        assert.deepEqual(normalized.policy.customExtensions, second.policy.customExtensions);
        assert.notEqual(normalized.observations, second.observations);
        const validationEvidence = await context.getIndexCompletionMarkerForValidation(codebasePath);
        assert.equal(validationEvidence.status, 'valid_v3');
        if (validationEvidence.status === 'valid_v3') {
            assert.equal(validationEvidence.collectionName, first.collectionName);
            assert.equal(validationEvidence.navigationProof.status, 'valid');
        }
        await vectorDatabase.dropCollection(second.collectionName);
        assert.equal(await context.revalidateProvenGeneration(codebasePath, second), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context warm generation revalidation observes in-place navigation seal changes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-navigation-observation-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export function value() { return 1; }\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);
        const receipt = await context.proveIndexedGeneration(codebasePath);
        assert.ok(receipt?.navigation);
        const sealPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, codebasePath),
            'generations',
            receipt!.navigation!.generationId,
            'seal.json',
        );
        fs.appendFileSync(sealPath, '\n', 'utf8');

        assert.equal(await context.revalidateProvenGeneration(codebasePath, receipt!), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation preserves vector proof but rejects a tampered navigation seal', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-seal-tamper-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export function value() { return 1; }\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);
        const receipt = await context.proveIndexedGeneration(codebasePath);
        assert.ok(receipt?.navigation);
        const sealPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, codebasePath),
            'generations',
            receipt!.navigation!.generationId,
            'seal.json',
        );
        const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(sealPath, JSON.stringify({ ...seal, artifactSetHash: '0'.repeat(64) }), 'utf8');

        assert.equal(await context.proveIndexedGeneration(codebasePath), null);
        const evidence = await context.getIndexCompletionMarkerForValidation(codebasePath);
        assert.equal(evidence.status, 'valid_v3');
        if (evidence.status === 'valid_v3') {
            assert.equal(evidence.navigationProof.status, 'incompatible');
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completion validation requires reindex for a legacy navigation pointer under v3 authority', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-legacy-pointer-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);

        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, codebasePath),
            'current.json',
        );
        const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
        pointer.schemaVersion = 'navigation_current_v2';
        const pointerBefore = JSON.stringify(pointer);
        fs.writeFileSync(pointerPath, pointerBefore, 'utf8');
        const marker = vectorDatabase.collections
            .get(context.resolveCollectionName(codebasePath))
            ?.get(INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(marker && typeof marker.metadata === 'object');
        const trustedFingerprint = structuredClone(
            (marker.metadata as { fingerprint: IndexCompletionFingerprint }).fingerprint,
        );

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'requires_reindex' },
        );
        const repair = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });
        assert.equal(repair.status, 'requires_reindex');
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context refuses unsupported future navigation authority without overwriting it during repair', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-future-pointer-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);

        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, codebasePath),
            'current.json',
        );
        const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
        pointer.schemaVersion = 'navigation_current_v4';
        const futurePointerBytes = JSON.stringify(pointer);
        fs.writeFileSync(pointerPath, futurePointerBytes, 'utf8');
        const markerDocument = vectorDatabase.collections
            .get(context.resolveCollectionName(codebasePath))
            ?.get(INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(markerDocument && typeof markerDocument.metadata === 'object');
        const trustedFingerprint = structuredClone(
            (markerDocument.metadata as { fingerprint: IndexCompletionFingerprint }).fingerprint,
        );

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'unsupported_authority' },
        );
        const repair = await context.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });
        assert.equal(repair.status, 'requires_reindex');
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), futurePointerBytes);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context distinguishes unsupported future marker and policy schemas without mutating them', async (t) => {
    for (const component of ['marker', 'policy'] as const) {
        await t.test(component, async () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `satori-context-future-${component}-`));
            const codebasePath = path.join(tempRoot, 'repo');
            const policyRoot = path.join(tempRoot, 'policies');
            try {
                fs.mkdirSync(codebasePath, { recursive: true });
                fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
                const vectorDatabase = new InMemoryVectorDatabase();
                const context = new Context({
                    embedding: new TestEmbedding(),
                    vectorDatabase,
                    indexPolicyStateRoot: policyRoot,
                    symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
                });
                await context.indexCodebase(codebasePath);
                const collectionName = context.resolveCollectionName(codebasePath);
                const markerDocument = vectorDatabase.collections
                    .get(collectionName)
                    ?.get(INDEX_COMPLETION_MARKER_DOC_ID);
                assert.ok(markerDocument && typeof markerDocument.metadata === 'object');
                const trustedFingerprint = structuredClone(
                    (markerDocument.metadata as { fingerprint: IndexCompletionFingerprint }).fingerprint,
                );
                const policyPath = path.join(
                    policyRoot,
                    `${crypto.createHash('sha256').update(fs.realpathSync(codebasePath)).digest('hex')}.json`,
                );

                if (component === 'marker') {
                    markerDocument.metadata = {
                        ...(markerDocument.metadata as Record<string, unknown>),
                        kind: 'satori_index_completion_v4',
                    };
                } else {
                    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
                    fs.writeFileSync(policyPath, JSON.stringify({
                        ...policy,
                        schemaVersion: 'satori_index_policy_v4',
                    }), 'utf8');
                }
                const markerBefore = structuredClone(markerDocument.metadata);
                const policyBefore = fs.readFileSync(policyPath, 'utf8');

                assert.deepEqual(
                    await context.getIndexCompletionMarkerForValidation(codebasePath),
                    { status: 'unsupported_authority' },
                );
                const repair = await context.repairIndex(codebasePath, {
                    snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
                });
                assert.equal(repair.status, 'requires_reindex');
                assert.deepEqual(markerDocument.metadata, markerBefore);
                assert.equal(fs.readFileSync(policyPath, 'utf8'), policyBefore);
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });
    }
});

test('Context completion validation classifies malformed durable policy authority deterministically', async (t) => {
    for (const corruption of ['malformed_json', 'invalid_digest'] as const) {
        await t.test(corruption, async () => {
            const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `satori-context-policy-${corruption}-`));
            const codebasePath = path.join(tempRoot, 'repo');
            const policyRoot = path.join(tempRoot, 'policies');
            try {
                fs.mkdirSync(codebasePath, { recursive: true });
                fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
                const context = new Context({
                    embedding: new TestEmbedding(),
                    vectorDatabase: new InMemoryVectorDatabase(),
                    indexPolicyStateRoot: policyRoot,
                    symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
                });
                await context.indexCodebase(codebasePath);
                const canonicalRoot = fs.realpathSync(codebasePath);
                const policyPath = path.join(
                    policyRoot,
                    `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
                );
                if (corruption === 'malformed_json') {
                    fs.writeFileSync(policyPath, '{', 'utf8');
                } else {
                    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
                    fs.writeFileSync(policyPath, JSON.stringify({ ...policy, documentDigest: '0'.repeat(64) }), 'utf8');
                }

                assert.deepEqual(
                    await context.getIndexCompletionMarkerForValidation(codebasePath),
                    { status: 'policy_authority_invalid' },
                );
            } finally {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });
    }
});

test('Context completion validation classifies malformed repository profile authority deterministically', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-profile-authority-'));
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);
        fs.writeFileSync(path.join(codebasePath, 'satori.toml'), '[index]\nprofile = "invalid"\n', 'utf8');

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'policy_authority_invalid' },
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context keeps vector retrieval usable but rejects strict proof when no navigation generation is bound', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-vector-only-generation-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const vectorOnlyValue = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);
        const policy = await context.resolveIndexPolicyForCodebase(codebasePath);
        const collectionName = context.resolveCollectionName(codebasePath);
        const markerDocument = vectorDatabase.collections.get(collectionName)?.get(INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(markerDocument && typeof markerDocument.metadata === 'object');
        (markerDocument.metadata as Record<string, unknown>).navigation = { status: 'not_bound' };
        context.publishResolvedIndexPolicy(policy, unboundPolicyBinding(collectionName));

        const vectorReceipt = await context.proveVectorGeneration(codebasePath);
        assert.ok(vectorReceipt);
        assert.equal(await context.proveIndexedGeneration(codebasePath), null);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), null);

        vectorDatabase.queryCalls.length = 0;
        const results = await context.semanticSearchInProvenGeneration(vectorReceipt!, {
            codebasePath,
            query: 'vectorOnlyValue',
            topK: 5,
            retrievalMode: 'dense',
            scorePolicy: { kind: 'topk_only' },
        });
        assert.ok(results.length > 0);
        assert.equal(
            vectorDatabase.queryCalls.filter((call) => call.filter.includes(`id == \"${INDEX_COMPLETION_MARKER_DOC_ID}\"`)).length,
            0,
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context completes an interrupted two-file durable authority restoration on startup', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-authority-restore-recovery-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const navigationStateRoot = path.join(tempRoot, 'navigation-state');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, canonicalRoot),
            'current.json',
        );
        fs.mkdirSync(path.dirname(policyPath), { recursive: true });
        fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
        const desired = ['{"legacyPolicy":true}\n', '{"legacyPointer":true}\n'];
        const candidate = ['{"candidatePolicy":true}\n', '{"candidatePointer":true}\n'];
        fs.writeFileSync(policyPath, candidate[0]!, 'utf8');
        fs.writeFileSync(pointerPath, candidate[1]!, 'utf8');

        const id = crypto.randomUUID();
        const entries = [policyPath, pointerPath].map((targetPath, index) => ({
            targetPath,
            temporaryPath: `${targetPath}.restore-${id}`,
            displacedPath: `${targetPath}.rollback-${id}`,
            content: desired[index]!,
            digest: crypto.createHash('sha256').update(desired[index]!, 'utf8').digest('hex'),
            expectedDigest: crypto.createHash('sha256').update(candidate[index]!, 'utf8').digest('hex'),
        }));
        for (const entry of entries) fs.writeFileSync(entry.temporaryPath, entry.content, 'utf8');
        fs.renameSync(policyPath, entries[0]!.displacedPath);
        const journalRoot = path.join(policyRoot, 'restore-transactions');
        fs.mkdirSync(journalRoot, { recursive: true });
        fs.writeFileSync(path.join(journalRoot, `${id}.json`), JSON.stringify({
            schemaVersion: 1,
            id,
            canonicalRoot,
            phase: 'swapping',
            nextEntry: 0,
            mutationOwner: { ownerId: 'owner-a', generation: 7, operationId: 'operation-a' },
            entries,
        }), 'utf8');

        new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: navigationStateRoot,
            durableAuthorityRecoveryPublisher: (_root, _owner, publish) => {
                publish();
                return true;
            },
        });

        assert.equal(fs.readFileSync(policyPath, 'utf8'), desired[0]);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), desired[1]);
        assert.deepEqual(fs.readdirSync(journalRoot), []);
        for (const entry of entries) {
            assert.equal(fs.existsSync(entry.temporaryPath), false);
            assert.equal(fs.existsSync(entry.displacedPath), false);
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context fails closed and leaves authority untouched when recovery cannot acquire a fence', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-authority-restore-live-owner-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const navigationStateRoot = path.join(tempRoot, 'navigation-state');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, canonicalRoot),
            'current.json',
        );
        fs.mkdirSync(path.dirname(policyPath), { recursive: true });
        fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
        const candidate = ['{"candidatePolicy":true}\n', '{"candidatePointer":true}\n'];
        const desired = ['{"previousPolicy":true}\n', '{"previousPointer":true}\n'];
        fs.writeFileSync(policyPath, candidate[0]!, 'utf8');
        fs.writeFileSync(pointerPath, candidate[1]!, 'utf8');

        const id = crypto.randomUUID();
        const entries = [policyPath, pointerPath].map((targetPath, index) => ({
            targetPath,
            temporaryPath: `${targetPath}.restore-${id}`,
            displacedPath: `${targetPath}.rollback-${id}`,
            content: desired[index]!,
            digest: crypto.createHash('sha256').update(desired[index]!, 'utf8').digest('hex'),
            expectedDigest: crypto.createHash('sha256').update(candidate[index]!, 'utf8').digest('hex'),
        }));
        for (const entry of entries) fs.writeFileSync(entry.temporaryPath, entry.content, 'utf8');
        const journalRoot = path.join(policyRoot, 'restore-transactions');
        fs.mkdirSync(journalRoot, { recursive: true });
        const journalPath = path.join(journalRoot, `${id}.json`);
        fs.writeFileSync(journalPath, JSON.stringify({
            schemaVersion: 1,
            id,
            canonicalRoot,
            phase: 'prepared',
            nextEntry: 0,
            mutationOwner: { ownerId: 'live-owner', generation: 4, operationId: crypto.randomUUID() },
            entries,
        }), 'utf8');

        let recoveryAttempts = 0;
        assert.throws(
            () => new Context({
                embedding: new TestEmbedding(),
                vectorDatabase: new InMemoryVectorDatabase(),
                indexPolicyStateRoot: policyRoot,
                symbolRegistryStateRoot: navigationStateRoot,
                durableAuthorityRecoveryPublisher: () => {
                    recoveryAttempts += 1;
                    return false;
                },
            }),
            /could not acquire the mutation fence/i,
        );

        assert.equal(recoveryAttempts, 1);
        assert.equal(fs.readFileSync(policyPath, 'utf8'), candidate[0]);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), candidate[1]);
        assert.equal(fs.existsSync(journalPath), true);
        for (const entry of entries) assert.equal(fs.existsSync(entry.temporaryPath), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context fails closed without a recovery publisher when an authority restoration is pending', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-authority-restore-no-publisher-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const navigationStateRoot = path.join(tempRoot, 'navigation-state');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, canonicalRoot),
            'current.json',
        );
        fs.mkdirSync(path.dirname(policyPath), { recursive: true });
        fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
        const current = ['{"policy":true}\n', '{"pointer":true}\n'];
        fs.writeFileSync(policyPath, current[0]!, 'utf8');
        fs.writeFileSync(pointerPath, current[1]!, 'utf8');

        const id = crypto.randomUUID();
        const entries = [policyPath, pointerPath].map((targetPath, index) => ({
            targetPath,
            temporaryPath: `${targetPath}.restore-${id}`,
            displacedPath: `${targetPath}.rollback-${id}`,
            content: current[index]!,
            digest: crypto.createHash('sha256').update(current[index]!, 'utf8').digest('hex'),
            expectedDigest: crypto.createHash('sha256').update(current[index]!, 'utf8').digest('hex'),
        }));
        for (const entry of entries) fs.writeFileSync(entry.temporaryPath, entry.content, 'utf8');
        const journalRoot = path.join(policyRoot, 'restore-transactions');
        fs.mkdirSync(journalRoot, { recursive: true });
        const journalPath = path.join(journalRoot, `${id}.json`);
        fs.writeFileSync(journalPath, JSON.stringify({
            schemaVersion: 1,
            id,
            canonicalRoot,
            phase: 'prepared',
            nextEntry: 0,
            entries,
        }), 'utf8');

        assert.throws(
            () => new Context({
                embedding: new TestEmbedding(),
                vectorDatabase: new InMemoryVectorDatabase(),
                indexPolicyStateRoot: policyRoot,
                symbolRegistryStateRoot: navigationStateRoot,
            }),
            /no fenced recovery publisher is configured/i,
        );
        assert.equal(fs.readFileSync(policyPath, 'utf8'), current[0]);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), current[1]);
        assert.equal(fs.existsSync(journalPath), true);
        for (const entry of entries) assert.equal(fs.existsSync(entry.temporaryPath), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context rejects restore journals whose auxiliary paths escape owned authority paths', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-authority-restore-path-safety-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const navigationStateRoot = path.join(tempRoot, 'navigation-state');
    const externalSentinel = path.join(tempRoot, 'external-sentinel.txt');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, canonicalRoot),
            'current.json',
        );
        fs.mkdirSync(path.dirname(policyPath), { recursive: true });
        fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
        fs.writeFileSync(policyPath, '{"policy":true}\n', 'utf8');
        fs.writeFileSync(pointerPath, '{"pointer":true}\n', 'utf8');
        fs.writeFileSync(externalSentinel, 'preserve me', 'utf8');

        const id = crypto.randomUUID();
        const entries = [policyPath, pointerPath].map((targetPath, index) => {
            const content = index === 0 ? '{"policy":true}\n' : '{"pointer":true}\n';
            return {
                targetPath,
                temporaryPath: index === 0 ? externalSentinel : `${targetPath}.restore-${id}`,
                displacedPath: `${targetPath}.rollback-${id}`,
                content,
                digest: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
                expectedDigest: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
            };
        });
        const journalRoot = path.join(policyRoot, 'restore-transactions');
        fs.mkdirSync(journalRoot, { recursive: true });
        fs.writeFileSync(path.join(journalRoot, `${id}.json`), JSON.stringify({
            schemaVersion: 1,
            id,
            canonicalRoot,
            phase: 'committed',
            nextEntry: 2,
            entries,
        }), 'utf8');

        assert.throws(
            () => new Context({
                embedding: new TestEmbedding(),
                vectorDatabase: new InMemoryVectorDatabase(),
                indexPolicyStateRoot: policyRoot,
                symbolRegistryStateRoot: navigationStateRoot,
                durableAuthorityRecoveryPublisher: (_root, _owner, publish) => {
                    publish();
                    return true;
                },
            }),
            /invalid entry/i,
        );
        assert.equal(fs.readFileSync(externalSentinel, 'utf8'), 'preserve me');
        assert.equal(fs.readFileSync(policyPath, 'utf8'), '{"policy":true}\n');
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), '{"pointer":true}\n');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context refuses stale durable rollback after current authority changes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-authority-restore-cas-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const stateRoot = path.join(tempRoot, 'state');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: stateRoot,
        });
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(fs.realpathSync(codebasePath)).digest('hex')}.json`,
        );
        const pointerPath = path.join(resolveNavigationSidecarRoot(stateRoot, codebasePath), 'current.json');
        fs.mkdirSync(path.dirname(policyPath), { recursive: true });
        fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
        fs.writeFileSync(policyPath, '{"previous":true}\n', 'utf8');
        fs.writeFileSync(pointerPath, '{"previous":true}\n', 'utf8');
        const previous = context.captureDurableIndexAuthority(codebasePath);
        fs.writeFileSync(policyPath, '{"candidate":true}\n', 'utf8');
        fs.writeFileSync(pointerPath, '{"candidate":true}\n', 'utf8');
        const candidate = context.captureDurableIndexAuthority(codebasePath);
        fs.writeFileSync(policyPath, '{"newer":true}\n', 'utf8');

        await assert.rejects(
            context.restoreDurableIndexAuthority(previous, (publish) => publish(), candidate),
            /changed after rollback capture/i,
        );
        assert.equal(fs.readFileSync(policyPath, 'utf8'), '{"newer":true}\n');
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), '{"candidate":true}\n');
        assert.deepEqual(fs.readdirSync(path.join(policyRoot, 'restore-transactions')), []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context restores retired durable authority bytes without promoting them', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-legacy-authority-rollback-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);

        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, canonicalRoot),
            'current.json',
        );
        const currentPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
        const currentPolicyNavigation = currentPolicy.navigation as {
            status: 'sealed';
            generationId: string;
        };
        const legacyPolicyPayload = {
            schemaVersion: 'satori_index_policy_v2',
            canonicalRoot,
            customExtensions: currentPolicy.customExtensions,
            customIgnorePatterns: currentPolicy.customIgnorePatterns,
            fileBasedIgnorePatterns: currentPolicy.fileBasedIgnorePatterns,
            profile: currentPolicy.profile,
            supportedExtensions: currentPolicy.supportedExtensions,
            effectiveIgnorePatterns: currentPolicy.effectiveIgnorePatterns,
            policyHash: currentPolicy.policyHash,
            collectionName: context.resolveCollectionName(codebasePath),
            navigationGenerationId: currentPolicyNavigation.generationId,
        };
        const legacyPolicy = {
            ...legacyPolicyPayload,
            documentDigest: crypto.createHash('sha256')
                .update(JSON.stringify(legacyPolicyPayload), 'utf8')
                .digest('hex'),
        };
        const legacyPointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
        legacyPointer.schemaVersion = 'navigation_current_v2';
        delete legacyPointer.navigationSealHash;
        const collectionName = context.resolveCollectionName(codebasePath);
        const markerDocument = vectorDatabase.collections.get(collectionName)?.get(INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(markerDocument && typeof markerDocument.metadata === 'object');
        const trustedFingerprint = structuredClone(
            (markerDocument.metadata as { fingerprint: IndexCompletionFingerprint }).fingerprint,
        );
        const legacyMarker = markerDocument.metadata as Record<string, unknown>;
        const markerNavigation = legacyMarker.navigation as {
            status: 'sealed';
            generationId: string;
            symbolRegistryManifestHash: string;
            relationshipManifestHash: string;
            sealHash: string;
        };
        legacyMarker.kind = 'satori_index_completion_v2';
        legacyMarker.navigationGenerationId = markerNavigation.generationId;
        legacyMarker.symbolRegistryManifestHash = markerNavigation.symbolRegistryManifestHash;
        legacyMarker.relationshipManifestHash = markerNavigation.relationshipManifestHash;
        delete legacyMarker.navigation;
        const legacyPolicyBytes = JSON.stringify(legacyPolicy);
        const legacyPointerBytes = `${JSON.stringify(legacyPointer, null, 2)}\n`;
        fs.writeFileSync(policyPath, legacyPolicyBytes, 'utf8');
        fs.writeFileSync(pointerPath, legacyPointerBytes, 'utf8');

        const snapshot = context.captureDurableIndexAuthority(codebasePath);
        fs.writeFileSync(policyPath, '{"candidate":true}\n', 'utf8');
        fs.writeFileSync(pointerPath, '{"candidate":true}\n', 'utf8');
        const candidateAuthority = context.captureDurableIndexAuthority(codebasePath);

        const restore = await context.restoreDurableIndexAuthority(
            snapshot,
            (publish) => publish(),
            candidateAuthority,
        );

        assert.deepEqual(restore, { status: 'restored_requires_reindex' });
        assert.equal(fs.readFileSync(policyPath, 'utf8'), legacyPolicyBytes);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), legacyPointerBytes);
        await assert.rejects(
            context.resolveIndexPolicyForCodebase(codebasePath),
            /index policy v2 requires reindex/i,
        );
        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'requires_reindex' },
        );
        assert.equal(fs.existsSync(resolveNavigationSqlitePath(navigationStateRoot, canonicalRoot)), false);
        const restarted = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await assert.rejects(
            restarted.resolveIndexPolicyForCodebase(codebasePath),
            /index policy v2 requires reindex/i,
        );
        await assert.rejects(
            restarted.proveVectorGeneration(codebasePath),
            /index policy v2 requires reindex/i,
        );
        await assert.rejects(
            restarted.proveIndexedGeneration(codebasePath),
            /index policy v2 requires reindex/i,
        );
        assert.deepEqual(
            await restarted.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'requires_reindex' },
        );

        const repair = await restarted.repairIndex(codebasePath, {
            snapshotEvidence: verifiedSnapshotEvidence(trustedFingerprint),
        });
        assert.equal(repair.status, 'requires_reindex');
        assert.equal(fs.readFileSync(policyPath, 'utf8'), legacyPolicyBytes);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), legacyPointerBytes);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context acknowledges committed restoration of unsupported policy authority', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-future-authority-rollback-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    const navigationStateRoot = path.join(tempRoot, 'navigation');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: navigationStateRoot,
        });
        await context.indexCodebase(codebasePath);

        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const pointerPath = path.join(
            resolveNavigationSidecarRoot(navigationStateRoot, canonicalRoot),
            'current.json',
        );
        const futurePolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
        futurePolicy.schemaVersion = 'satori_index_policy_v4';
        const futurePolicyBytes = `${JSON.stringify(futurePolicy, null, 2)}\n`;
        const currentPointerBytes = fs.readFileSync(pointerPath, 'utf8');
        fs.writeFileSync(policyPath, futurePolicyBytes, 'utf8');
        const snapshot = context.captureDurableIndexAuthority(codebasePath);

        fs.writeFileSync(policyPath, '{"candidate":true}\n', 'utf8');
        fs.writeFileSync(pointerPath, '{"candidate":true}\n', 'utf8');
        const candidateAuthority = context.captureDurableIndexAuthority(codebasePath);

        const restore = await context.restoreDurableIndexAuthority(
            snapshot,
            (publish) => publish(),
            candidateAuthority,
        );

        assert.deepEqual(restore, { status: 'restored_unsupported_authority' });
        assert.equal(fs.readFileSync(policyPath, 'utf8'), futurePolicyBytes);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), currentPointerBytes);
        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'unsupported_authority' },
        );
        assert.equal(fs.existsSync(resolveNavigationSqlitePath(navigationStateRoot, canonicalRoot)), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context requires reindex for a coherent pre-seal tuple without mutating it', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-legacy-authority-inspection-'));
    const stateRoot = path.join(tempRoot, 'state');
    const policyRoot = path.join(stateRoot, 'policies');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: stateRoot,
        });
        await context.indexCodebase(codebasePath);

        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const pointerPath = path.join(resolveNavigationSidecarRoot(stateRoot, canonicalRoot), 'current.json');
        const collectionName = context.resolveCollectionName(codebasePath);
        const markerDocument = vectorDatabase.collections.get(collectionName)?.get(INDEX_COMPLETION_MARKER_DOC_ID);
        assert.ok(markerDocument && typeof markerDocument.metadata === 'object');

        const currentMarker = structuredClone(markerDocument.metadata) as Record<string, unknown>;
        const markerNavigation = currentMarker.navigation as {
            status: 'sealed';
            generationId: string;
            symbolRegistryManifestHash: string;
            relationshipManifestHash: string;
            sealHash: string;
        };
        markerDocument.metadata = {
            ...currentMarker,
            kind: 'satori_index_completion_v2',
            navigationGenerationId: markerNavigation.generationId,
            symbolRegistryManifestHash: markerNavigation.symbolRegistryManifestHash,
            relationshipManifestHash: markerNavigation.relationshipManifestHash,
        };
        delete (markerDocument.metadata as Record<string, unknown>).navigation;

        const currentPolicy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
        const policyNavigation = currentPolicy.navigation as { status: 'sealed'; generationId: string };
        const legacyPolicyPayload = {
            schemaVersion: 'satori_index_policy_v2',
            canonicalRoot,
            customExtensions: currentPolicy.customExtensions,
            customIgnorePatterns: currentPolicy.customIgnorePatterns,
            fileBasedIgnorePatterns: currentPolicy.fileBasedIgnorePatterns,
            profile: currentPolicy.profile,
            supportedExtensions: currentPolicy.supportedExtensions,
            effectiveIgnorePatterns: currentPolicy.effectiveIgnorePatterns,
            policyHash: currentPolicy.policyHash,
            collectionName,
            navigationGenerationId: policyNavigation.generationId,
        };
        fs.writeFileSync(policyPath, JSON.stringify({
            ...legacyPolicyPayload,
            documentDigest: crypto.createHash('sha256')
                .update(JSON.stringify(legacyPolicyPayload), 'utf8')
                .digest('hex'),
        }), 'utf8');

        const legacyPointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
        legacyPointer.schemaVersion = 'navigation_current_v2';
        delete legacyPointer.navigationSealHash;
        const legacyPointerBytes = JSON.stringify(legacyPointer);
        const legacyPolicyBytes = fs.readFileSync(policyPath, 'utf8');
        const legacyMarker = structuredClone(markerDocument.metadata);
        fs.writeFileSync(pointerPath, legacyPointerBytes, 'utf8');

        assert.deepEqual(
            await context.getIndexCompletionMarkerForValidation(codebasePath),
            { status: 'requires_reindex' },
        );
        assert.equal(fs.readFileSync(policyPath, 'utf8'), legacyPolicyBytes);
        assert.equal(fs.readFileSync(pointerPath, 'utf8'), legacyPointerBytes);
        assert.deepEqual(markerDocument.metadata, legacyMarker);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context resolves an explicit reindex policy from current inputs without admitting retired policy bytes', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-fresh-reindex-policy-'));
    const codebasePath = path.join(tempRoot, 'repo');
    const policyRoot = path.join(tempRoot, 'policies');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        fs.writeFileSync(path.join(codebasePath, 'satori.toml'), '[index]\nprofile = "minimal"\n', 'utf8');
        fs.writeFileSync(path.join(codebasePath, '.satoriignore'), 'generated/**\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: policyRoot,
            symbolRegistryStateRoot: path.join(tempRoot, 'navigation'),
        });
        await context.indexCodebase(codebasePath);

        const canonicalRoot = fs.realpathSync(codebasePath);
        const policyPath = path.join(
            policyRoot,
            `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
        );
        const legacyPolicyBytes = JSON.stringify({
            schemaVersion: 'satori_index_policy_v2',
            canonicalRoot,
            customExtensions: ['.legacy'],
            customIgnorePatterns: ['legacy/**'],
            fileBasedIgnorePatterns: [],
            profile: 'default',
            supportedExtensions: ['.legacy'],
            effectiveIgnorePatterns: ['legacy/**'],
            policyHash: 'a'.repeat(64),
            collectionName: context.resolveCollectionName(codebasePath),
            navigationGenerationId: 'legacy-generation',
            documentDigest: 'b'.repeat(64),
        });
        fs.writeFileSync(policyPath, legacyPolicyBytes, 'utf8');

        await assert.rejects(
            context.resolveIndexPolicyForCodebase(codebasePath),
            /index policy v2 requires reindex/i,
        );
        const candidate = await context.resolveIndexPolicyForReindex(codebasePath, {
            customExtensions: ['.fresh'],
            customIgnorePatterns: ['manual/**'],
        });

        assert.equal(candidate.profile, 'minimal');
        assert.deepEqual(candidate.customExtensions, ['.fresh']);
        assert.deepEqual(candidate.customIgnorePatterns, ['manual/**']);
        assert.ok(candidate.fileBasedIgnorePatterns.includes('generated/**'));
        assert.ok(candidate.supportedExtensions.includes('.fresh'));
        assert.equal(candidate.supportedExtensions.includes('.legacy'), false);
        assert.ok(candidate.effectiveIgnorePatterns.includes('manual/**'));
        assert.ok(candidate.effectiveIgnorePatterns.includes('generated/**'));
        assert.equal(candidate.effectiveIgnorePatterns.includes('legacy/**'), false);
        assert.equal(fs.readFileSync(policyPath, 'utf8'), legacyPolicyBytes);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context prior generation receipt fails closed on profile policy and navigation observation drift', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-proven-receipt-drift-'));
    const stateRoot = path.join(tempRoot, 'state');
    const policyRoot = path.join(stateRoot, 'policies');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: policyRoot,
        });
        await context.indexCodebase(codebasePath);
        const receipt = await context.proveIndexedGeneration(codebasePath);
        assert.ok(receipt);
        const initialAuthorityObservation = context.getIndexAuthorityObservation(codebasePath);
        assert.ok(initialAuthorityObservation);

        fs.writeFileSync(path.join(codebasePath, 'satori.toml'), '[index]\nprofile = "minimal"\n', 'utf8');
        assert.notEqual(context.getIndexAuthorityObservation(codebasePath), initialAuthorityObservation);
        assert.equal(await context.proveIndexedGeneration(codebasePath, receipt), null);
        fs.rmSync(path.join(codebasePath, 'satori.toml'));

        const restored = await context.proveIndexedGeneration(codebasePath);
        assert.ok(restored);
        context.publishResolvedIndexPolicy(
            restored.policy,
            sealedPolicyBinding(
                context.resolveStagedCollectionName(codebasePath, 'replacement'),
                restored.navigation,
            ),
        );
        assert.notEqual(context.getIndexAuthorityObservation(codebasePath), initialAuthorityObservation);
        assert.equal(await context.proveIndexedGeneration(codebasePath, restored), null);

        context.publishResolvedIndexPolicy(
            restored.policy,
            sealedPolicyBinding(restored.collectionName, restored.navigation),
        );
        const rebound = await context.proveIndexedGeneration(codebasePath);
        assert.ok(rebound?.navigation);
        const currentPath = path.join(resolveNavigationSidecarRoot(stateRoot, codebasePath), 'current.json');
        const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(currentPath, JSON.stringify({
            ...current,
            symbolRegistryManifestHash: `${String(current.symbolRegistryManifestHash)}-changed`,
        }), 'utf8');
        assert.notEqual(context.getIndexAuthorityObservation(codebasePath), initialAuthorityObservation);
        assert.equal(await context.proveIndexedGeneration(codebasePath, rebound), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context navigation authority observation changes when a bound manifest is modified in place', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-navigation-manifest-observation-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);
        const receipt = await context.proveIndexedGeneration(codebasePath);
        assert.ok(receipt?.navigation);
        const initialObservation = context.getIndexAuthorityObservation(codebasePath);
        assert.ok(initialObservation);

        const relationshipManifestPath = path.join(
            resolveNavigationSidecarRoot(stateRoot, codebasePath),
            'generations',
            receipt!.navigation!.generationId,
            'relationships',
            'manifest.json',
        );
        fs.appendFileSync(relationshipManifestPath, ' ', 'utf8');

        assert.notEqual(context.getIndexAuthorityObservation(codebasePath), initialObservation);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context proven generation rejects a navigation pointer changed after active resolution', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-proven-race-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);
        const acceptedPolicy = await context.resolveIndexPolicyForCodebase(codebasePath);
        const acceptedNavigation = await context.getCurrentNavigationGeneration(codebasePath);
        assert.ok(acceptedNavigation);
        context.publishResolvedIndexPolicy(
            acceptedPolicy,
            sealedPolicyBinding(context.resolveCollectionName(codebasePath), acceptedNavigation),
        );
        assert.ok(await context.resolveProvenGeneration(codebasePath));

        let rebound = false;
        vectorDatabase.queryHook = (call) => {
            if (!rebound && call.filter.includes('fileExtension != ".satori_meta"')) {
                rebound = true;
                const currentPath = path.join(
                    resolveNavigationSidecarRoot(stateRoot, codebasePath),
                    'current.json',
                );
                const current = JSON.parse(fs.readFileSync(currentPath, 'utf8')) as Record<string, unknown>;
                fs.writeFileSync(currentPath, JSON.stringify({
                    ...current,
                    generationId: `${String(current.generationId)}-rebound`,
                }), 'utf8');
            }
        };

        assert.equal(await context.resolveProvenGeneration(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context proven generation rejects a same-hash policy rebound to another collection', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-proven-policy-race-'));
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    try {
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'runtime.ts'), 'export const value = 1;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);
        const acceptedPolicy = await context.resolveIndexPolicyForCodebase(codebasePath);
        const navigation = await context.getCurrentNavigationGeneration(codebasePath);
        assert.ok(navigation);
        context.publishResolvedIndexPolicy(
            acceptedPolicy,
            sealedPolicyBinding(context.resolveCollectionName(codebasePath), navigation),
        );

        let rebound = false;
        vectorDatabase.queryHook = (call) => {
            if (!rebound && call.filter.includes(`id == "${INDEX_COMPLETION_MARKER_DOC_ID}"`)) {
                rebound = true;
                context.publishResolvedIndexPolicy(
                    acceptedPolicy,
                    sealedPolicyBinding(
                        `${context.resolveCollectionName(codebasePath)}__gen_rebound`,
                        navigation,
                    ),
                );
            }
        };

        assert.equal(await context.resolveProvenGeneration(codebasePath), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context rejects a resolved index policy from another root before indexing mutates either root', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-cross-root-policy-'));
    const stateRoot = path.join(tempRoot, 'state');
    const firstRoot = path.join(tempRoot, 'first');
    const secondRoot = path.join(tempRoot, 'second');
    try {
        fs.mkdirSync(firstRoot, { recursive: true });
        fs.mkdirSync(secondRoot, { recursive: true });
        fs.writeFileSync(path.join(firstRoot, 'first.ts'), 'export const first = true;\n', 'utf8');
        fs.writeFileSync(path.join(secondRoot, 'second.ts'), 'export const second = true;\n', 'utf8');
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        const firstPolicy = await context.resolveIndexPolicyForCodebase(firstRoot, {
            customIgnorePatterns: ['private/**'],
        });

        await assert.rejects(
            context.indexCodebase(secondRoot, undefined, false, { indexPolicy: firstPolicy }),
            /Resolved index policy belongs to .*first.* not .*second/i,
        );

        assert.equal(await vectorDatabase.hasCollection(context.resolveCollectionName(firstRoot)), false);
        assert.equal(await vectorDatabase.hasCollection(context.resolveCollectionName(secondRoot)), false);
        assert.equal(context.getActiveIgnorePatterns(firstRoot).includes('private/**'), false);
        assert.equal(context.getActiveIgnorePatterns(secondRoot).includes('private/**'), false);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context rejects a resolved index policy from another root when rebuilding expected chunks', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-cross-root-repair-policy-'));
    const firstRoot = path.join(tempRoot, 'first');
    const secondRoot = path.join(tempRoot, 'second');
    const secondFile = path.join(secondRoot, 'second.ts');
    try {
        fs.mkdirSync(firstRoot, { recursive: true });
        fs.mkdirSync(secondRoot, { recursive: true });
        fs.writeFileSync(secondFile, 'export const second = true;\n', 'utf8');
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            indexPolicyStateRoot: path.join(tempRoot, 'policies'),
        });
        const firstPolicy = await context.resolveIndexPolicyForCodebase(firstRoot);

        await assert.rejects(
            context.getExpectedChunksAndSymbols([secondFile], secondRoot, firstPolicy),
            /Resolved index policy belongs to .*first.* not .*second/i,
        );
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        const stableGeneration = await context.resolveProvenGeneration(codebasePath);
        assert.ok(stableGeneration);

        const stableCollection = context.resolveCollectionName(codebasePath);
        const stagedCollection = context.resolveStagedCollectionName(codebasePath, 'ready');
        const stableDocs = vectorDatabase.collections.get(stableCollection);
        assert.ok(stableDocs);
        vectorDatabase.collections.set(stagedCollection, new Map(stableDocs));
        await vectorDatabase.dropCollection(stableCollection);
        context.publishResolvedIndexPolicy(stableGeneration.policy, {
            collectionName: stagedCollection,
            navigation: stableGeneration.marker.navigation.status === 'sealed'
                ? {
                    status: 'sealed',
                    generationId: stableGeneration.marker.navigation.generationId,
                    sealHash: stableGeneration.marker.navigation.sealHash,
                }
                : { status: 'not_bound' },
        });
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), stagedCollection);
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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

test('Context.reindexByChange restores a missing marker with its checkpoint-bound custom policy hash', async () => {
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
            customExtensions: ['.satori-test'],
        });

        await context.recreateSynchronizerForCodebase(codebasePath);
        await context.indexCodebase(codebasePath);
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

        const collectionName = context.resolveCollectionName(codebasePath);
        const originalMarker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(originalMarker);
        const expectedPolicyHash = originalMarker.indexPolicyHash;
        await context.clearIndexCompletionMarker(codebasePath);
        assert.equal(await context.getIndexCompletionMarker(codebasePath), null);

        const internalContext = context as unknown as {
            buildIndexPolicyHash(codebasePath: string): string;
        };
        internalContext.buildIndexPolicyHash = () => 'f'.repeat(64);

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
        assert.equal(marker.indexPolicyHash, expectedPolicyHash);
        const checkpoint = JSON.parse(fs.readFileSync(
            FileSynchronizer.getSnapshotPathForGeneration(codebasePath, collectionName),
            'utf8',
        )) as { indexPolicyHash?: string };
        assert.equal(checkpoint.indexPolicyHash, expectedPolicyHash);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        const nextLoginResult = searchResults.find((result) =>
            result.relativePath === 'src/new.ts'
            && result.ownerSymbolInstanceId === nextLoginSymbol.symbolInstanceId
        );
        assert.ok(nextLoginResult);
        assert.equal(nextLoginResult?.startByte, nextLoginSymbol.span.startByte);
        assert.equal(nextLoginResult?.endByte, nextLoginSymbol.span.endByte);
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

        const progress: Array<{ phase: string; percentage: number }> = [];
        const stats = await context.indexCodebase(codebasePath, (entry) => progress.push(entry));
        const collectionName = context.resolveCollectionName(codebasePath);
        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(stats.status, 'limit_reached');
        assert.equal(vectorDatabase.collections.get(collectionName)?.has(INDEX_COMPLETION_MARKER_DOC_ID), true);
        assert.equal(registry.status, 'missing');
        const marker = await context.getIndexCompletionMarker(codebasePath);
        assert.ok(marker);
        assert.equal(marker?.kind, 'satori_index_completion_v3');
        assert.equal(marker?.indexStatus, 'limit_reached');
        assert.deepEqual(marker?.navigation, { status: 'not_bound' });
        assert.equal(progress.at(-1)?.phase, 'Indexing stopped at chunk limit');
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);
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
        const baselineCollection = await baselineContext.getActiveIndexedCollectionName(codebasePath);
        assert.ok(baselineCollection);
        const baselineMarker = await baselineContext.getIndexCompletionMarker(codebasePath);
        assert.ok(baselineMarker);
        const authorityCheckpoint = new FileSynchronizer(
            codebasePath,
            baselineContext.getActiveIgnorePatterns(codebasePath),
            baselineContext.getIndexedExtensionsForCodebase(codebasePath),
            {
                checkpointIdentity: baselineCollection,
                checkpointAuthority: {
                    collectionName: baselineCollection,
                    markerRunId: baselineMarker.runId,
                    indexPolicyHash: baselineMarker.indexPolicyHash,
                },
            },
        );
        await authorityCheckpoint.initialize();

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

test('Context.reindexByChange replaces a root-global synchronizer before authoritative mutation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-authority-switch-'));
    const previousHome = process.env.HOME;
    const tempHome = path.join(tempRoot, 'home');
    const stateRoot = path.join(tempRoot, 'state');
    const codebasePath = path.join(tempRoot, 'repo');
    const sourcePath = path.join(codebasePath, 'src', 'auth.ts');

    try {
        fs.mkdirSync(tempHome, { recursive: true });
        process.env.HOME = tempHome;
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
        const activeCollection = await baselineContext.getActiveIndexedCollectionName(codebasePath);
        assert.ok(activeCollection);
        const activeMarker = await baselineContext.getIndexCompletionMarker(codebasePath);
        assert.ok(activeMarker);

        const activeCheckpoint = new FileSynchronizer(
            codebasePath,
            baselineContext.getActiveIgnorePatterns(codebasePath),
            baselineContext.getIndexedExtensionsForCodebase(codebasePath),
            {
                checkpointIdentity: activeCollection,
                checkpointAuthority: {
                    collectionName: activeCollection,
                    markerRunId: activeMarker.runId,
                    indexPolicyHash: activeMarker.indexPolicyHash,
                },
            },
        );
        await activeCheckpoint.initialize();
        const activeCheckpointPath = FileSynchronizer.getSnapshotPathForGeneration(
            codebasePath,
            activeCollection,
        );
        const previousCheckpointBytes = fs.readFileSync(activeCheckpointPath, 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
        });
        const rootGlobalSynchronizer = new FileSynchronizer(
            codebasePath,
            context.getActiveIgnorePatterns(codebasePath),
            context.getIndexedExtensionsForCodebase(codebasePath),
        );
        await rootGlobalSynchronizer.initialize();
        context.registerSynchronizer(context.resolveCollectionName(codebasePath), rootGlobalSynchronizer);

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);

        assert.equal(result.modified, 1);
        const registered = context.getActiveSynchronizers().get(context.resolveCollectionName(codebasePath));
        assert.ok(registered);
        assert.equal(registered.ownsCheckpointIdentity(activeCollection), true);

        fs.writeFileSync(activeCheckpointPath, previousCheckpointBytes, 'utf8');
        const replayedCheckpoint = await context.inspectSourceFreshnessCheckpoint(codebasePath);
        assert.equal(replayedCheckpoint.status, 'corrupt');
        if (replayedCheckpoint.status === 'corrupt') {
            assert.match(replayedCheckpoint.message, /does not belong to the active completion marker/);
        }
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.recreateSynchronizerForCodebase rejects authority replacement while loading a checkpoint', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-sync-recreate-race-'));
    const previousHome = process.env.HOME;
    const tempHome = path.join(tempRoot, 'home');
    const codebasePath = path.join(tempRoot, 'repo');

    try {
        fs.mkdirSync(tempHome, { recursive: true });
        process.env.HOME = tempHome;
        fs.mkdirSync(codebasePath, { recursive: true });
        fs.writeFileSync(path.join(codebasePath, 'index.ts'), 'export const value = 1;\n', 'utf8');

        const firstCollection = 'hybrid_code_chunks_race__gen_first';
        const checkpoint = new FileSynchronizer(codebasePath, [], ['.ts'], {
            checkpointIdentity: firstCollection,
            checkpointAuthority: {
                collectionName: firstCollection,
                markerRunId: 'run_first',
                indexPolicyHash: 'a'.repeat(64),
            },
        });
        await checkpoint.initialize();

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            symbolRegistryStateRoot: path.join(tempRoot, 'state'),
        });
        let proofCalls = 0;
        (context as unknown as {
            proveIndexedGeneration: () => Promise<unknown>;
        }).proveIndexedGeneration = async () => {
            proofCalls += 1;
            return {
                collectionName: proofCalls === 1 ? firstCollection : 'hybrid_code_chunks_race__gen_second',
                policyDocumentDigest: 'a'.repeat(64),
                marker: {
                    runId: 'run_first',
                    indexPolicyHash: 'a'.repeat(64),
                },
            };
        };

        await assert.rejects(
            () => context.recreateSynchronizerForCodebase(
                codebasePath,
                undefined,
                undefined,
                { requireAuthorityCheckpoint: true },
            ),
            /indexed authority changed while its checkpoint was loading/,
        );
        assert.equal(proofCalls, 2);
        assert.equal(context.hasSynchronizerForCodebase(codebasePath), false);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
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
        await publishCurrentAuthorityCheckpoint(context, codebasePath);

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
        const originalPublish = context.publishResolvedIndexPolicy.bind(context);
        context.publishResolvedIndexPolicy = ((policy, binding) => originalPublish(
            policy,
            binding,
            (publish) => {
                publish();
                throw new Error('receipt acknowledgement failed');
            },
        )) as typeof context.publishResolvedIndexPolicy;
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
                kind: 'satori_index_completion_v2',
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

test('Context.repairIndex refreshes repository profile before trusting sealed policy compatibility', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-context-repair-profile-refresh-'));
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
            indexPolicyStateRoot: path.join(stateRoot, 'policies'),
        });
        await context.indexCodebase(codebasePath);
        await clearSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        fs.writeFileSync(
            path.join(codebasePath, 'satori.toml'),
            '[index]\nprofile = "minimal"\n',
            'utf8',
        );

        const result = await context.repairIndex(codebasePath);

        assert.equal(result.status, 'requires_reindex');
        assert.equal(result.reason, 'requires_reindex');
        assert.equal(result.proof.marker.basis, 'sealed_policy_unavailable');
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
                kind: 'satori_index_completion_v3',
                codebasePath,
                fingerprint: {
                    embeddingProvider: 'MismatchedProvider',
                    embeddingModel: 'mismatched-model',
                    embeddingDimension: 9999,
                    vectorStoreProvider: 'Milvus',
                    schemaVersion: 'dense_v3',
                    parserVersion: LANGUAGE_PARSER_VERSION,
                    extractorVersion: SYMBOL_EXTRACTOR_VERSION,
                    relationshipVersion: RELATIONSHIP_BUILDER_VERSION,
                },
                indexedFiles: 1,
                totalChunks: 1,
                completedAt: new Date().toISOString(),
                runId: 'mismatched-run-id',
                indexPolicyHash: 'a'.repeat(64),
                indexStatus: 'completed',
                navigation: { status: 'not_bound' },
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
