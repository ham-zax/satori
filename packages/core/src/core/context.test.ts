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
    SearchOptions,
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
} from '../vectordb';
import { INDEX_COMPLETION_MARKER_FILE_EXTENSION as COMPLETION_MARKER_EXTENSION } from '../vectordb';

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
