import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    Context,
    createLanguageAnalysisService,
    resetSharedRuntimeNavigationStoreForTests,
    resolveNavigationSidecarRoot,
} from '@zokizuan/satori-core';
import type {
    CollectionDetails,
    Embedding,
    EmbeddingVector,
    HybridSearchOptions,
    HybridSearchRequest,
    HybridSearchResult,
    SearchOptions,
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
import { MutationLeaseCoordinator } from './mutation-lease.js';

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
    target: {
        file: string;
        span: { startLine: number; endLine: number };
        symbolId?: string;
    };
    displayLabel: string;
    navigation: { graph: string; callerSearchTerm?: string };
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
        return 'VoyageAI';
    }
}

class InMemoryVectorDatabase implements VectorDatabase {
    readonly collections = new Map<string, Map<string, VectorDocument>>();
    payloadCountQueryCount = 0;
    markerQueryCount = 0;
    hasCollectionCount = 0;

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
        this.hasCollectionCount += 1;
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
        if (filterExpr.includes('__satori_index_completion_marker_v1__')) {
            this.markerQueryCount += 1;
        }
        if (
            filterExpr === 'fileExtension != ".satori_meta"'
            && outputFields.length === 1
            && outputFields[0] === 'id'
            && limit > 1
        ) {
            this.payloadCountQueryCount += 1;
        }
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
        && (result as SearchGroup).target?.file === relativePath
        && String((result as SearchGroup).displayLabel || '').includes(symbolName)
    );
    assert.ok(match, `expected grouped result for ${relativePath}:${symbolName}`);
    return match;
}

test('cached exact search cannot survive direct collection deletion', async () => {
    await withTempState(async ({ repoPath, stateRoot }) => {
        fs.writeFileSync(
            path.join(repoPath, 'src', 'owner.ts'),
            'export function cachedOwner() { return true; }\n',
            'utf8',
        );
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            languageAnalyzer: createLanguageAnalysisService(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.indexCodebase(repoPath);
        const receipt = await context.resolveProvenGeneration(repoPath);
        assert.ok(receipt);
        const syncManager = {
            getPreparedReadObservation: () => ({ freshnessEpoch: 1 }),
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-06-18T00:00:00.000Z',
                thresholdMs: 180000,
            }),
            touchWatchedCodebase: async () => undefined,
        } as unknown as SyncManager;
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(stateRoot, 'leases'),
            ownerId: 'cached-search-test',
        });
        const handlers = new ToolHandlers(
            context,
            createSnapshotManager(repoPath),
            syncManager,
            receipt!.marker.fingerprint,
            CAPABILITIES,
            () => Date.parse('2026-06-18T00:00:00.000Z'),
            undefined,
            null,
            undefined,
            undefined,
            null,
            coordinator,
        );
        const coreEvidence = await context.getIndexCompletionMarkerForValidation(repoPath);
        assert.equal(coreEvidence.status, 'valid_v2', JSON.stringify(coreEvidence));
        const directProof = await (handlers as unknown as {
            validateCompletionProof: (root: string) => Promise<Record<string, unknown>>;
        }).validateCompletionProof(repoPath);
        assert.equal(directProof.outcome, 'valid', JSON.stringify(directProof));
        const first = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'cachedOwner',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        }));
        assert.equal(first.status, 'ok', JSON.stringify(first));

        await vectorDatabase.dropCollection(receipt!.collectionName);
        const second = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'cachedOwner',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        }));
        assert.notEqual(second.status, 'ok');
    });
});

test('cached exact search downgrades navigation after direct symbol shard deletion', async () => {
    await withTempState(async ({ repoPath, stateRoot }) => {
        fs.writeFileSync(
            path.join(repoPath, 'src', 'owner.ts'),
            'export function cachedShardOwner() { return true; }\n',
            'utf8',
        );
        const vectorDatabase = new InMemoryVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            languageAnalyzer: createLanguageAnalysisService(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.indexCodebase(repoPath);
        const receipt = await context.resolveProvenGeneration(repoPath);
        assert.ok(receipt?.navigation);
        vectorDatabase.payloadCountQueryCount = 0;
        const syncManager = {
            getPreparedReadObservation: () => ({ freshnessEpoch: 1 }),
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-06-18T00:00:00.000Z',
                thresholdMs: 180000,
            }),
            touchWatchedCodebase: async () => undefined,
        } as unknown as SyncManager;
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(stateRoot, 'leases'),
            ownerId: 'cached-shard-search-test',
        });
        const handlers = new ToolHandlers(
            context,
            createSnapshotManager(repoPath),
            syncManager,
            receipt!.marker.fingerprint,
            CAPABILITIES,
            () => Date.parse('2026-06-18T00:00:00.000Z'),
            undefined,
            null,
            undefined,
            undefined,
            null,
            coordinator,
        );
        const first = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'cachedShardOwner',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        }));
        assert.equal(first.status, 'ok', JSON.stringify(first));
        assert.ok(vectorDatabase.payloadCountQueryCount > 0);
        const coldPayloadCountQueries = vectorDatabase.payloadCountQueryCount;

        const originalReadFileSync = fs.readFileSync;
        let navigationShardReads = 0;
        fs.readFileSync = ((targetPath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
            if (
                typeof targetPath === 'string'
                && targetPath.includes(`${path.sep}generations${path.sep}`)
                && targetPath.includes(`${path.sep}by-file${path.sep}`)
            ) {
                navigationShardReads += 1;
            }
            return (originalReadFileSync as (...readArgs: unknown[]) => unknown)(targetPath, ...args);
        }) as typeof fs.readFileSync;
        let warm: JsonObject;
        try {
            warm = parsePayload(await handlers.handleSearchCode({
                path: repoPath,
                query: 'cachedShardOwner',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
            }));
        } finally {
            fs.readFileSync = originalReadFileSync;
        }
        assert.equal(warm.status, 'ok', JSON.stringify(warm));
        assert.equal(vectorDatabase.payloadCountQueryCount, coldPayloadCountQueries);
        assert.equal(navigationShardReads, 0);

        const mutation = coordinator.acquire(repoPath, 'sync');
        assert.equal(mutation.acquired, true);
        const duringMutation = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'cachedShardOwner',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        }));
        assert.equal(duringMutation.status, 'not_ready', JSON.stringify(duringMutation));
        assert.equal(duringMutation.reason, 'indexing');
        if (mutation.acquired) coordinator.release(mutation.lease);
        const afterMutationGenerationChange = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'cachedShardOwner',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        }));
        assert.equal(afterMutationGenerationChange.status, 'ok', JSON.stringify(afterMutationGenerationChange));
        assert.ok(vectorDatabase.payloadCountQueryCount > coldPayloadCountQueries);

        const semantic = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'where does the runtime decide whether an owner is cached',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        }));
        assert.equal(semantic.status, 'ok', JSON.stringify(semantic));
        const semanticPayloadCountQueries = vectorDatabase.payloadCountQueryCount;
        const semanticMarkerQueries = vectorDatabase.markerQueryCount;
        const semanticCollectionProbes = vectorDatabase.hasCollectionCount;
        const warmSemantic = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'where does the runtime decide whether an owner is cached',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        }));
        assert.equal(warmSemantic.status, 'ok', JSON.stringify(warmSemantic));
        assert.equal(vectorDatabase.payloadCountQueryCount, semanticPayloadCountQueries);
        assert.equal(vectorDatabase.markerQueryCount - semanticMarkerQueries, 1);
        assert.equal(vectorDatabase.hasCollectionCount - semanticCollectionProbes, 1);

        const generationRoot = path.join(
            resolveNavigationSidecarRoot(stateRoot, repoPath),
            'generations',
            receipt!.navigation!.generationId,
        );
        const symbolIndex = JSON.parse(fs.readFileSync(path.join(generationRoot, 'symbols', 'index.json'), 'utf8')) as {
            files: Array<{ shardPath: string }>;
        };
        assert.ok(symbolIndex.files[0]?.shardPath);
        fs.rmSync(path.join(generationRoot, symbolIndex.files[0]!.shardPath));

        const degraded = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'cachedShardOwner',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'ranking',
        }));
        assert.equal(degraded.status, 'ok', JSON.stringify(degraded));
        assert.equal(vectorDatabase.payloadCountQueryCount, semanticPayloadCountQueries);
        assert.notEqual(degraded.results?.[0]?.navigation?.graph, 'ready');
        assert.equal(degraded.results?.[0]?.target?.symbolId, undefined);
        assert.ok(
            Array.isArray(degraded.warnings)
            && degraded.warnings.some((warning) => warning?.code === 'NAVIGATION_REPAIR_REQUIRED'),
            JSON.stringify(degraded),
        );
        assert.equal(degraded.hints?.debugSearch?.exactRegistry?.reason, 'navigation_unavailable');
    });
});

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
            languageAnalyzer: createLanguageAnalysisService(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(repoPath);
        await context.indexCodebase(repoPath);
        context.getActiveIndexedCollectionName = async () => context.resolveCollectionName(repoPath);

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
            validateCompletionProof: () => Promise<Record<string, unknown>>;
        };
        testHandlers.validateCompletionProof = async () => {
            const receipt = await context.proveIndexedGeneration(repoPath);
            assert.ok(receipt);
            return {
                outcome: 'valid',
                marker: receipt.marker,
                collectionName: receipt.collectionName,
                vectorReceipt: receipt,
                generationReceipt: receipt,
                navigationStatus: 'valid',
            };
        };
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
        assert.equal(typeof newLoginGroup.target.symbolId, 'string');
        assert.notEqual(newLoginGroup.target.symbolId, oldSymbolInstanceId);
        assert.equal(newLoginGroup.navigation.graph, 'ready');
        assert.equal(JSON.stringify(newLoginGroup).includes(oldSymbolInstanceId), false);

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
        assert.equal(newLoginSymbol.symbolId, newLoginGroup.target.symbolId);

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
            symbolIdExact: newLoginGroup.target.symbolId,
        }));
        assert.equal(newExactOutline.status, 'ok');
        const newExactSymbols = (newExactOutline.outline as { symbols?: OutlineSymbol[] }).symbols || [];
        assert.equal(newExactSymbols[0]?.symbolId, newLoginGroup.target.symbolId);

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
                symbolId: newLoginGroup.target.symbolId,
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
            symbolRef: newLoginGroup.target,
            direction: 'both',
            depth: 1,
            limit: 10,
        }));
        assert.equal(newCallGraph.status, 'ok');
        assert.equal(JSON.stringify(newCallGraph).includes(oldSymbolInstanceId), false);
        const newCallGraphNodes = newCallGraph.nodes as Array<{ symbolId?: string }> | undefined;
        assert.ok(Array.isArray(newCallGraphNodes));
        assert.equal(
            newCallGraphNodes.some((node) => node.symbolId === newLoginGroup.target.symbolId),
            true,
        );
    });
});

test('MCP direct navigation fails closed for dirty files until search freshness syncs', async () => {
    await withTempState(async ({ repoPath, stateRoot }) => {
        const relativePath = 'src/runtime.ts';
        const filePath = path.join(repoPath, relativePath);

        fs.writeFileSync(filePath, 'export function run() {\n  return true;\n}\n', 'utf8');

        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase: new InMemoryVectorDatabase(),
            languageAnalyzer: createLanguageAnalysisService(),
            symbolRegistryStateRoot: stateRoot,
        });
        await context.recreateSynchronizerForCodebase(repoPath);
        await context.indexCodebase(repoPath);
        context.getActiveIndexedCollectionName = async () => context.resolveCollectionName(repoPath);

        let ensureFreshnessCalls = 0;
        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
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
            validateCompletionProof: () => Promise<Record<string, unknown>>;
        };
        testHandlers.validateCompletionProof = async () => {
            const receipt = await context.proveIndexedGeneration(repoPath);
            assert.ok(receipt);
            return {
                outcome: 'valid',
                marker: receipt.marker,
                collectionName: receipt.collectionName,
                vectorReceipt: receipt,
                generationReceipt: receipt,
                navigationStatus: 'valid',
            };
        };
        const initialOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: relativePath,
        }));
        assert.equal(initialOutline.status, 'ok');
        const oldRunSymbol = findSymbol(initialOutline, 'run');
        const oldSymbolInstanceId = oldRunSymbol.symbolId;

        fs.writeFileSync(filePath, 'export function runFresh() {\n  return false;\n}\n', 'utf8');

        const staleExactOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: relativePath,
            resolveMode: 'exact',
            symbolIdExact: oldSymbolInstanceId,
        }));
        assert.equal(staleExactOutline.status, 'requires_reindex');
        assert.equal(staleExactOutline.reason, 'stale_symbol_ref');
        assert.equal(ensureFreshnessCalls, 0);

        const staleReadResponse = await readFileTool.execute({
            path: filePath,
            open_symbol: {
                symbolId: oldSymbolInstanceId,
            },
        }, createToolContext(repoPath, handlers));
        assert.equal(staleReadResponse.isError, true);
        const staleReadPayload = parsePayload(staleReadResponse);
        assert.equal(staleReadPayload.status, 'requires_reindex');
        assert.equal(staleReadPayload.reason, 'stale_symbol_ref');
        assert.equal(JSON.stringify(staleReadPayload).includes('return false'), false);
        assert.equal(ensureFreshnessCalls, 0);

        const staleCallGraph = parsePayload(await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: relativePath,
                symbolId: oldSymbolInstanceId,
            },
            direction: 'both',
            depth: 1,
            limit: 10,
        }));
        assert.equal(staleCallGraph.status, 'not_found');
        assert.equal(staleCallGraph.reason, 'stale_symbol_ref');
        assert.equal(staleCallGraph.supported, false);
        assert.equal(ensureFreshnessCalls, 0);

        const searchPayload = parsePayload(await handlers.handleSearchCode({
            path: repoPath,
            query: 'runFresh',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10,
        }));
        assert.equal(searchPayload.status, 'ok');
        assert.equal(ensureFreshnessCalls, 1);
        assert.equal(JSON.stringify(searchPayload).includes(oldSymbolInstanceId), false);

        const freshGroup = findSearchGroup(searchPayload, relativePath, 'runFresh');
        assert.equal(typeof freshGroup.target.symbolId, 'string');
        assert.notEqual(freshGroup.target.symbolId, oldSymbolInstanceId);

        const freshExactOutline = parsePayload(await handlers.handleFileOutline({
            path: repoPath,
            file: relativePath,
            resolveMode: 'exact',
            symbolIdExact: freshGroup.target.symbolId,
        }));
        assert.equal(freshExactOutline.status, 'ok');
        const freshExactSymbols = (freshExactOutline.outline as { symbols?: OutlineSymbol[] }).symbols || [];
        assert.equal(freshExactSymbols[0]?.symbolId, freshGroup.target.symbolId);
    });
});
