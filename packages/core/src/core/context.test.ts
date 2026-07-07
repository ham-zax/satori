import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from './context';
import { resolveNavigationSqlitePath, SQLiteNavigationStore, validateNavigationStoreParity } from '../navigation';
import { clearSymbolRegistrySidecar, readRelationshipSidecar, readSymbolRegistrySidecar } from '../symbols';
import type { SymbolRecord, SymbolRegistryManifestFile } from '../symbols';
import type { Embedding, EmbeddingVector } from '../embedding';
import { AstCodeSplitter } from '../splitter';
import type { Splitter } from '../splitter';
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

class TestEmbedding implements Embedding {
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

class RecordingSplitter implements Splitter {
    public readonly splitCalls: string[] = [];
    private readonly delegate = new AstCodeSplitter(2500, 300);

    async split(code: string, language: string, filePath?: string) {
        if (filePath) {
            this.splitCalls.push(filePath);
        }
        return this.delegate.split(code, language, filePath);
    }

    setChunkSize(chunkSize: number): void {
        this.delegate.setChunkSize(chunkSize);
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.delegate.setChunkOverlap(chunkOverlap);
    }

    reset(): void {
        this.splitCalls.length = 0;
    }
}

class ThrowingSplitter implements Splitter {
    async split(): Promise<never> {
        throw new Error('split failed after marker cleanup');
    }

    setChunkSize(): void {}

    setChunkOverlap(): void {}
}

type ProcessFileListResult = {
    processedFiles: number;
    totalChunks: number;
    status: 'completed' | 'limit_reached';
    symbolRecords: SymbolRecord[];
    symbolManifestFiles: SymbolRegistryManifestFile[];
};

type ContextWithProcessFileList = Context & {
    processFileList: (...args: unknown[]) => Promise<ProcessFileListResult>;
};

class InMemoryVectorDatabase implements VectorDatabase {
    readonly collections = new Map<string, Map<string, VectorDocument>>();

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
        const collection = this.collections.get(collectionName);
        for (const id of ids) {
            collection?.delete(id);
        }
    }

    async query(collectionName: string, _filter: string, outputFields: string[], limit: number = 1000): Promise<Record<string, unknown>[]> {
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

async function readTrustedFingerprint(context: Context, codebasePath: string): Promise<IndexCompletionFingerprint> {
    const marker = await context.getIndexCompletionMarker(codebasePath);
    assert.ok(marker);
    return marker.fingerprint;
}

function buildCompletionMarkerDoc(input: {
    codebasePath: string;
    runId: string;
    totalChunks?: number;
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
            fingerprint: {
                embeddingProvider: 'TestEmbedding',
                embeddingModel: 'TestEmbedding',
                embeddingDimension: 4,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
            },
            indexedFiles: 1,
            totalChunks: input.totalChunks ?? 1,
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: input.runId,
        },
    };
}

function buildChunkDoc(id: string): VectorDocument {
    return {
        id,
        vector: [0.1, 0.2, 0.3, 0.4],
        content: `chunk:${id}`,
        relativePath: 'src/runtime.ts',
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        metadata: {},
    };
}

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
            codeSplitter: new ThrowingSplitter(),
        });
        const collectionName = context.resolveCollectionName(repoPath);

        await vectorDatabase.createHybridCollection(collectionName);
        await vectorDatabase.insertHybrid(collectionName, [buildChunkDoc('old_ready_chunk')]);
        await context.writeIndexCompletionMarker(repoPath, {
            kind: 'satori_index_completion_v1',
            codebasePath: path.resolve(repoPath),
            fingerprint: {
                embeddingProvider: 'TestEmbedding',
                embeddingModel: 'TestEmbedding',
                embeddingDimension: 4,
                vectorStoreProvider: 'Milvus',
                schemaVersion: 'hybrid_v3',
            },
            indexedFiles: 1,
            totalChunks: 1,
            completedAt: '2026-02-27T23:57:10.000Z',
            runId: 'old_ready_marker',
        });
        assert.ok(await context.getIndexCompletionMarker(repoPath));

        await assert.rejects(
            () => context.indexCodebase(repoPath),
            /split failed after marker cleanup/,
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

        const processFileListContext = context as ContextWithProcessFileList;
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
        assert.equal(stack?.label, 'type Stack');
        assert.equal(push?.label, 'method push');
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

    try {
        fs.mkdirSync(path.dirname(authPath), { recursive: true });
        fs.writeFileSync(authPath, 'export function login() { return true; }\n', 'utf8');
        fs.writeFileSync(
            callerPath,
            "import { login } from './auth';\nexport function run() { return login(); }\n",
            'utf8',
        );

        const splitter = new RecordingSplitter();
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            symbolRegistryStateRoot: stateRoot,
            codeSplitter: splitter,
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

        splitter.reset();
        fs.writeFileSync(authPath, 'export function login() { return false; }\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);
        assert.equal(result.modified, 1);

        const splitRelativePaths = splitter.splitCalls
            .map((filePath) => path.relative(codebasePath, filePath).replace(/\\/g, '/'))
            .sort((a, b) => a.localeCompare(b));
        assert.deepEqual(splitRelativePaths, ['src/auth.ts']);

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

        const contextWithProcessFileList = context as ContextWithProcessFileList;
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
        assert.equal(registry.status, 'missing');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.reindexByChange removes stale registry entries for modified paths even when the changed file produces no replacement navigation metadata', async () => {
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

        const contextWithProcessFileList = context as ContextWithProcessFileList;
        contextWithProcessFileList.processFileList = async () => ({
            processedFiles: 0,
            totalChunks: 0,
            status: 'completed',
            symbolRecords: [],
            symbolManifestFiles: [],
        });

        fs.writeFileSync(authPath, 'export function login() { return false; }\n', 'utf8');
        const result = await context.reindexByChange(codebasePath);
        const nextRegistry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });

        assert.equal(result.modified, 1);
        assert.equal(nextRegistry.status, 'ok');
        if (nextRegistry.status !== 'ok') {
            return;
        }

        assert.equal(nextRegistry.registry.manifest.files.some((file) => file.path === 'src/auth.ts'), false);
        assert.equal(nextRegistry.registry.symbolsByFile.has('src/auth.ts'), false);
        assert.equal(nextRegistry.registry.symbolsByFile.has('src/caller.ts'), true);
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

test('Context.reindexByChange clears navigation sidecars when incremental sync throws after reading the previous registry', async () => {
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

        const failingContext = context as Context & {
            deleteFileChunks: (collectionName: string, relativePath: string) => Promise<void>;
        };
        failingContext.deleteFileChunks = async () => {
            throw new Error('synthetic incremental sync failure');
        };

        fs.writeFileSync(sourcePath, 'export const auth = false;\n', 'utf8');
        await assert.rejects(
            () => context.reindexByChange(codebasePath),
            /synthetic incremental sync failure/,
        );

        const registry = await readSymbolRegistrySidecar({ stateRoot, normalizedRootPath: codebasePath });
        assert.equal(registry.status, 'missing');
        assert.equal(await context.getIndexCompletionMarker(codebasePath), null);
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
        const repairResult = await context.repairIndex(codebasePath, { trustedFingerprint });
        assert.equal(repairResult.status, 'ok');
        assert.match(repairResult.message, /readiness repaired/i);

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
            trustedFingerprint: originalFingerprint,
        });

        assert.equal(repairResult.status, 'requires_reindex');
        assert.equal(repairResult.reason, 'requires_reindex');
        assert.match(repairResult.message, /cannot prove vector provenance|runtime fingerprint/i);
        assert.equal(await upgradedContext.getIndexCompletionMarker(codebasePath), null);
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

        const repairResult = await context.repairIndex(codebasePath, { trustedFingerprint });

        assert.equal(repairResult.status, 'blocked');
        assert.equal(repairResult.reason, 'needs_create');
        assert.match(repairResult.message, /stale remote chunk/i);
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

        const repairResult = await context.repairIndex(codebasePath, { trustedFingerprint });

        assert.equal(repairResult.status, 'blocked');
        assert.equal(repairResult.reason, 'needs_create');
        assert.match(repairResult.message, /no indexable files/i);
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
        const repairResult = await context.repairIndex(codebasePath, { trustedFingerprint });

        assert.equal(repairResult.status, 'ok');
        assert.equal(vectorDatabase.collections.has(stableCollection), false);
        assert.equal(vectorDatabase.collections.get(stagedCollection)?.has(INDEX_COMPLETION_MARKER_DOC_ID), true);
        assert.equal(await context.getActiveIndexedCollectionName(codebasePath), stagedCollection);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('Context.repairIndex missing_marker_doc + missing expected chunk refuses with needs_create', async () => {
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

        // 3. Run repairIndex - should fail coverage verification and return blocked status
        const repairResult = await context.repairIndex(codebasePath, { trustedFingerprint });
        assert.equal(repairResult.status, 'blocked');
        assert.equal(repairResult.reason, 'needs_create');
        assert.ok(repairResult.missingCount && repairResult.missingCount > 0);
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
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
