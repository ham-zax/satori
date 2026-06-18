import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    AstCodeSplitter,
    Context,
    resetSharedRuntimeNavigationStoreForTests,
} from '@zokizuan/satori-core';
import type {
    CollectionDetails,
    Embedding,
    EmbeddingVector,
    HybridSearchOptions,
    HybridSearchRequest,
    HybridSearchResult,
    SearchOptions,
    Splitter,
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
} from '@zokizuan/satori-core';
import { readFileTool } from '../tools/read_file.js';
import type { ToolContext } from '../tools/types.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import { ToolHandlers } from './handlers.js';
import type { SnapshotManager } from './snapshot.js';
import type { SyncManager } from './sync.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
};

const CAPABILITIES = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

type JsonObject = Record<string, unknown>;

type OutlineSymbol = {
    symbolId: string;
    symbolLabel?: string;
};

type SearchGroup = {
    file?: string;
    symbolId?: string;
    symbolInstanceId?: string;
    symbolLabel?: string | null;
    callGraphHint?: {
        symbolRef?: {
            file: string;
            symbolId: string;
            symbolLabel?: string;
        };
    };
    nextActions?: unknown;
};

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

class TestSplitter implements Splitter {
    private readonly delegate = new AstCodeSplitter(2500, 300);

    async split(code: string, language: string, filePath?: string) {
        return this.delegate.split(code, language, filePath);
    }

    setChunkSize(chunkSize: number): void {
        this.delegate.setChunkSize(chunkSize);
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.delegate.setChunkOverlap(chunkOverlap);
    }
}

class InMemoryVectorDatabase implements VectorDatabase {
    readonly collections = new Map<string, Map<string, VectorDocument>>();

    private listDocuments(collectionName: string, filterExpr?: string): VectorDocument[] {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            return [];
        }
        let documents = Array.from(collection.values());
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

    async hybridSearch(
        collectionName: string,
        _searchRequests: HybridSearchRequest[],
        options?: HybridSearchOptions,
    ): Promise<HybridSearchResult[]> {
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

    async query(
        collectionName: string,
        filterExpr: string,
        outputFields: string[],
        limit: number = 1000,
    ): Promise<Record<string, unknown>[]> {
        return this.listDocuments(collectionName, filterExpr).slice(0, limit).map((document) => {
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

async function withTempState<T>(fn: (input: { repoPath: string; stateRoot: string }) => Promise<T>): Promise<T> {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-rename-lifecycle-'));
    const repoPath = path.join(tempRoot, 'repo');
    const stateRoot = path.join(tempRoot, 'state');
    process.env.SATORI_STATE_ROOT = stateRoot;
    resetSharedRuntimeNavigationStoreForTests();

    try {
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        return await fn({ repoPath, stateRoot });
    } finally {
        resetSharedRuntimeNavigationStoreForTests();
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

function parsePayload(response: { content?: Array<{ text?: string }> }): JsonObject {
    return JSON.parse(response.content?.[0]?.text || '{}') as JsonObject;
}

function createSnapshotManager(repoPath: string): SnapshotManager {
    const info = { status: 'indexed', indexStatus: 'completed' };
    return {
        getAllCodebases: () => [{ path: repoPath, info }],
        getIndexedCodebases: () => [repoPath],
        getIndexingCodebases: () => [],
        getCodebaseInfo: () => info,
        getCodebaseStatus: () => info.status,
        getCodebaseCallGraphSidecar: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined,
    } as unknown as SnapshotManager;
}

function createToolContext(repoPath: string, handlers: ToolHandlers): ToolContext {
    return {
        readFileMaxLines: 1000,
        snapshotManager: createSnapshotManager(repoPath),
        syncManager: {
            touchWatchedCodebase: async () => undefined,
        },
        toolHandlers: handlers,
    } as unknown as ToolContext;
}

function findSymbol(outlinePayload: JsonObject, symbolName: string): OutlineSymbol {
    const outline = outlinePayload.outline as { symbols?: unknown } | undefined;
    const symbols = outline?.symbols;
    assert.ok(Array.isArray(symbols), 'expected outline symbols');
    const match = symbols.find((symbol): symbol is OutlineSymbol =>
        typeof symbol === 'object'
        && symbol !== null
        && typeof (symbol as OutlineSymbol).symbolId === 'string'
        && String((symbol as OutlineSymbol).symbolLabel || '').includes(symbolName)
    );
    assert.ok(match, `expected symbol label containing ${symbolName}`);
    return match;
}

function findSearchGroup(searchPayload: JsonObject, relativePath: string, symbolName: string): SearchGroup {
    const results = searchPayload.results;
    assert.ok(Array.isArray(results), 'expected grouped search results');
    const match = results.find((result): result is SearchGroup =>
        typeof result === 'object'
        && result !== null
        && (result as SearchGroup).file === relativePath
        && String((result as SearchGroup).symbolLabel || '').includes(symbolName)
    );
    assert.ok(match, `expected grouped result for ${relativePath}:${symbolName}`);
    return match;
}

test('MCP handlers reject stale rename symbols and publish new navigation after incremental sync', async () => {
    await withTempState(async ({ repoPath, stateRoot }) => {
        const oldRelativePath = 'src/old.ts';
        const newRelativePath = 'src/new.ts';
        const callerRelativePath = 'src/caller.ts';
        const oldFilePath = path.join(repoPath, oldRelativePath);
        const newFilePath = path.join(repoPath, newRelativePath);
        const callerFilePath = path.join(repoPath, callerRelativePath);

        fs.writeFileSync(oldFilePath, 'export function login() {\n  return true;\n}\n', 'utf8');
        fs.writeFileSync(
            callerFilePath,
            "import { login } from './old';\nexport function run() {\n  return login();\n}\n",
            'utf8',
        );

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            codeSplitter: new TestSplitter(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(repoPath);
        await context.indexCodebase(repoPath);

        let syncTriggered = false;
        const syncManager = {
            ensureFreshness: async () => {
                syncTriggered = true;
                const stats = await context.reindexByChange(repoPath);
                return {
                    mode: 'synced',
                    checkedAt: '2026-06-18T00:00:00.000Z',
                    thresholdMs: 180000,
                    stats,
                };
            },
            touchWatchedCodebase: async () => undefined,
        } as unknown as SyncManager;
        const handlers = new ToolHandlers(
            context,
            createSnapshotManager(repoPath),
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-06-18T00:00:00.000Z'),
        );
        const testHandlers = handlers as unknown as {
            syncIndexedCodebasesFromCloud: () => Promise<void>;
            validateCompletionProof: () => Promise<{ outcome: 'ok' }>;
        };
        testHandlers.syncIndexedCodebasesFromCloud = async () => undefined;
        testHandlers.validateCompletionProof = async () => ({ outcome: 'ok' });

        const initialOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: oldRelativePath,
        }));
        assert.equal(initialOutline.status, 'ok');
        const oldLoginSymbol = findSymbol(initialOutline, 'login');
        const oldSymbolInstanceId = oldLoginSymbol.symbolId;

        fs.renameSync(oldFilePath, newFilePath);
        fs.writeFileSync(
            callerFilePath,
            "import { login } from './new';\nexport function run() {\n  return login();\n}\n",
            'utf8',
        );

        const searchPayload = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'login',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10,
        }));
        assert.equal(searchPayload.status, 'ok');
        assert.equal(syncTriggered, true);
        assert.equal(JSON.stringify(searchPayload).includes(oldSymbolInstanceId), false);

        const newLoginGroup = findSearchGroup(searchPayload, newRelativePath, 'login');
        assert.equal(typeof newLoginGroup.symbolId, 'string');
        assert.equal(newLoginGroup.symbolId, newLoginGroup.symbolInstanceId);
        assert.notEqual(newLoginGroup.symbolId, oldSymbolInstanceId);
        assert.equal(newLoginGroup.callGraphHint?.symbolRef?.symbolId, newLoginGroup.symbolId);
        assert.equal(JSON.stringify(newLoginGroup.callGraphHint).includes(oldSymbolInstanceId), false);
        assert.equal(JSON.stringify(newLoginGroup.nextActions || {}).includes(oldSymbolInstanceId), false);

        const oldOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: oldRelativePath,
        }));
        assert.equal(oldOutline.status, 'not_found');

        const newOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: newRelativePath,
        }));
        assert.equal(newOutline.status, 'ok');
        const newLoginSymbol = findSymbol(newOutline, 'login');
        assert.equal(newLoginSymbol.symbolId, newLoginGroup.symbolId);

        const oldExactOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: newRelativePath,
            resolveMode: 'exact',
            symbolIdExact: oldSymbolInstanceId,
        }));
        assert.equal(oldExactOutline.status, 'not_found');

        const newExactOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: newRelativePath,
            resolveMode: 'exact',
            symbolIdExact: newLoginGroup.symbolId,
        }));
        assert.equal(newExactOutline.status, 'ok');
        const newExactSymbols = (newExactOutline.outline as { symbols?: OutlineSymbol[] }).symbols || [];
        assert.equal(newExactSymbols[0]?.symbolId, newLoginGroup.symbolId);

        const toolContext = createToolContext(repoPath, handlers);
        const oldReadResponse = await readFileTool.execute({
            path: newFilePath,
            open_symbol: {
                symbolId: oldSymbolInstanceId,
            },
        }, toolContext);
        assert.equal(oldReadResponse.isError, true);
        const oldReadPayload = parsePayload(oldReadResponse);
        assert.equal(oldReadPayload.status, 'not_found');

        const newReadResponse = await readFileTool.execute({
            path: newFilePath,
            open_symbol: {
                symbolId: newLoginGroup.symbolId,
            },
        }, toolContext);
        assert.equal(newReadResponse.isError, undefined);
        assert.match(newReadResponse.content[0]?.text || '', /export function login/);
        assert.doesNotMatch(newReadResponse.content[0]?.text || '', /from '\.\/old'/);

        const oldCallGraph = parsePayload(await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: oldRelativePath,
                symbolId: oldSymbolInstanceId,
            },
            direction: 'both',
            depth: 1,
            limit: 10,
        }));
        assert.equal(oldCallGraph.status, 'not_found');
        assert.equal(oldCallGraph.supported, false);
        assert.equal(oldCallGraph.reason, 'missing_symbol');

        const newCallGraph = parsePayload(await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: newLoginGroup.callGraphHint.symbolRef,
            direction: 'both',
            depth: 1,
            limit: 10,
        }));
        assert.equal(newCallGraph.status, 'ok');
        assert.equal(JSON.stringify(newCallGraph).includes(oldSymbolInstanceId), false);
        const newCallGraphNodes = newCallGraph.nodes as Array<{ symbolId?: string }> | undefined;
        assert.ok(Array.isArray(newCallGraphNodes));
        assert.equal(
            newCallGraphNodes.some((node) => node.symbolId === newLoginGroup.symbolId),
            true,
        );
    });
});
