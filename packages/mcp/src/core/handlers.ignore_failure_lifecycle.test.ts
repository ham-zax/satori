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
import { SyncManager } from './sync.js';

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

type MutableCodebaseInfo = {
    status: 'indexed' | 'sync_completed' | 'indexing' | 'requires_reindex';
    indexStatus: 'completed';
    reindexReason?: string;
    message?: string;
    lastUpdated?: string;
    ignoreRulesVersion?: number;
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
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-ignore-failure-lifecycle-'));
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

function createMutableSnapshotManager(repoPath: string): {
    snapshotManager: SnapshotManager;
    info: MutableCodebaseInfo;
} {
    const info: MutableCodebaseInfo = {
        status: 'indexed',
        indexStatus: 'completed',
    };
    let indexedPaths: string[] = [];
    let ignoreControlSignature: string | undefined;

    const snapshotManager = {
        getAllCodebases: () => [{ path: repoPath, info }],
        getIndexedCodebases: () => (
            info.status === 'indexed' || info.status === 'sync_completed'
                ? [repoPath]
                : []
        ),
        getIndexingCodebases: () => [],
        getCodebaseInfo: () => info,
        getCodebaseStatus: () => info.status,
        getCodebaseCallGraphSidecar: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined,
        setCodebaseIndexManifest: (_codebasePath: string, paths: string[]) => {
            indexedPaths = paths.slice();
        },
        getCodebaseIndexedPaths: () => indexedPaths.slice(),
        setCodebaseIgnoreControlSignature: (_codebasePath: string, signature: string) => {
            ignoreControlSignature = signature;
        },
        getCodebaseIgnoreControlSignature: () => ignoreControlSignature,
        setCodebaseIgnoreRulesVersion: (_codebasePath: string, version: number) => {
            info.ignoreRulesVersion = version;
        },
        setCodebaseRequiresReindex: (_codebasePath: string, reason: string, message: string) => {
            info.status = 'requires_reindex';
            info.reindexReason = reason;
            info.message = message;
            info.lastUpdated = '2026-06-18T00:00:00.000Z';
        },
        setCodebaseSyncCompleted: () => {
            info.status = 'sync_completed';
        },
    } as unknown as SnapshotManager;

    return { snapshotManager, info };
}

function createToolContext(snapshotManager: SnapshotManager, syncManager: SyncManager, handlers: ToolHandlers): ToolContext {
    return {
        readFileMaxLines: 1000,
        snapshotManager,
        syncManager,
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

test('MCP handlers fail closed after ignore reconciliation deletes indexed paths and sync recovery fails', async () => {
    await withTempState(async ({ repoPath, stateRoot }) => {
        const ignoredRelativePath = 'src/ignored.ts';
        const callerRelativePath = 'src/caller.ts';
        const keepRelativePath = 'src/keep.ts';
        const ignoredFilePath = path.join(repoPath, ignoredRelativePath);
        const callerFilePath = path.join(repoPath, callerRelativePath);
        const keepFilePath = path.join(repoPath, keepRelativePath);

        fs.writeFileSync(ignoredFilePath, 'export function ignoredLogin() {\n  return true;\n}\n', 'utf8');
        fs.writeFileSync(
            callerFilePath,
            "import { ignoredLogin } from './ignored';\nexport function runIgnoredLogin() {\n  return ignoredLogin();\n}\n",
            'utf8',
        );
        fs.writeFileSync(keepFilePath, 'export function keepAlive() {\n  return true;\n}\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            codeSplitter: new TestSplitter(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(repoPath);
        await context.indexCodebase(repoPath);

        const { snapshotManager, info } = createMutableSnapshotManager(repoPath);
        snapshotManager.setCodebaseIndexManifest?.(repoPath, context.getTrackedRelativePaths(repoPath));
        const syncManager = new SyncManager(context, snapshotManager, {
            watchEnabled: true,
            watchDebounceMs: 20,
            now: () => Date.parse('2026-06-18T00:00:00.000Z'),
        });
        await syncManager.recordCurrentIgnoreControlSignature(repoPath);

        const handlers = new ToolHandlers(
            context,
            snapshotManager,
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
            file: ignoredRelativePath,
        }));
        assert.equal(initialOutline.status, 'ok');
        const ignoredSymbol = findSymbol(initialOutline, 'ignoredLogin');
        const oldSymbolInstanceId = ignoredSymbol.symbolId;

        fs.writeFileSync(path.join(repoPath, '.satoriignore'), `${ignoredRelativePath}\n`, 'utf8');

        let forcedSyncCalls = 0;
        const originalReindexByChange = context.reindexByChange.bind(context);
        (context as unknown as {
            reindexByChange: (codebasePath: string) => ReturnType<Context['reindexByChange']>;
        }).reindexByChange = async () => {
            forcedSyncCalls += 1;
            throw new Error('forced sync recovery failure');
        };

        try {
            const triggerSearchPayload = parsePayload(await handlers.handleSearchCode({
                path: repoPath,
                query: 'ignoredLogin',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 10,
            }));
            assert.equal(forcedSyncCalls, 2);
            assert.equal(info.status, 'requires_reindex');
            assert.equal(info.reindexReason, 'navigation_recovery_failed');
            assert.match(info.message || '', /Ignore-rule reconciliation deleted indexed paths/);
            assert.equal(snapshotManager.getCodebaseIndexedPaths?.(repoPath).includes(ignoredRelativePath), false);
            assert.equal(triggerSearchPayload.freshnessDecision && (triggerSearchPayload.freshnessDecision as JsonObject).mode, 'ignore_reload_failed');
            assert.equal(JSON.stringify(triggerSearchPayload).includes(oldSymbolInstanceId), false);

            const triggerResults = triggerSearchPayload.results;
            assert.ok(Array.isArray(triggerResults), 'expected search results array');
            assert.equal(
                triggerResults.some((result) =>
                    typeof result === 'object'
                    && result !== null
                    && (result as { file?: string }).file === ignoredRelativePath
                ),
                false,
            );

            const blockedSearchPayload = parsePayload(await handlers.handleSearchCode({
                path: repoPath,
                query: 'ignoredLogin',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 10,
            }));
            assert.equal(blockedSearchPayload.status, 'requires_reindex');
            assert.equal(blockedSearchPayload.reason, 'requires_reindex');
            assert.equal(JSON.stringify(blockedSearchPayload).includes(oldSymbolInstanceId), false);

            const staleOutline = parsePayload(await handlers.handleFileOutline({
                path: repoPath,
                file: ignoredRelativePath,
            }));
            assert.equal(staleOutline.status, 'requires_reindex');
            assert.equal(staleOutline.outline, null);
            assert.equal(JSON.stringify(staleOutline).includes(oldSymbolInstanceId), false);

            const staleExactOutline = parsePayload(await handlers.handleFileOutline({
                path: repoPath,
                file: ignoredRelativePath,
                resolveMode: 'exact',
                symbolIdExact: oldSymbolInstanceId,
            }));
            assert.equal(staleExactOutline.status, 'requires_reindex');
            assert.equal(staleExactOutline.outline, null);

            const toolContext = createToolContext(snapshotManager, syncManager, handlers);
            const staleReadResponse = await readFileTool.execute({
                path: ignoredFilePath,
                open_symbol: {
                    symbolId: oldSymbolInstanceId,
                },
            }, toolContext);
            assert.equal(staleReadResponse.isError, true);
            const staleReadPayload = parsePayload(staleReadResponse);
            assert.equal(staleReadPayload.status, 'requires_reindex');
            assert.doesNotMatch(staleReadResponse.content[0]?.text || '', /export function ignoredLogin/);

            const staleCallGraph = parsePayload(await handlers.handleCallGraph({
                path: repoPath,
                symbolRef: {
                    file: ignoredRelativePath,
                    symbolId: oldSymbolInstanceId,
                },
                direction: 'both',
                depth: 1,
                limit: 10,
            }));
            assert.equal(staleCallGraph.status, 'requires_reindex');
            assert.equal(staleCallGraph.supported, false);
            assert.equal(staleCallGraph.reason, 'requires_reindex');
            assert.equal(Array.isArray(staleCallGraph.nodes) ? staleCallGraph.nodes.length : -1, 0);
            assert.equal(Array.isArray(staleCallGraph.edges) ? staleCallGraph.edges.length : -1, 0);
            assert.equal(JSON.stringify((staleCallGraph.hints as JsonObject | undefined) || {}).includes(oldSymbolInstanceId), false);
        } finally {
            (context as unknown as {
                reindexByChange: (codebasePath: string) => ReturnType<Context['reindexByChange']>;
            }).reindexByChange = originalReindexByChange;
            await syncManager.stopWatcherMode();
        }
    });
});
