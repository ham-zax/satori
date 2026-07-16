import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    Context,
    createLanguageAnalysisService,
    FileSynchronizer,
    resetSharedRuntimeNavigationStoreForTests,
    resolveNavigationSidecarRoot,
} from '@zokizuan/satori-core';
import type {
    CollectionDetails,
    DenseCandidateRequest,
    Embedding,
    EmbeddingVector,
    IndexedVectorDocument,
    LexicalCandidateRequest,
    VectorCandidate,
    VectorControlRecord,
    VectorDatabase,
    VectorDocument,
    VectorDocumentQuery,
    VectorFilter,
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

    async embedQuery(text: string): Promise<EmbeddingVector> {
        return {
            vector: [text.length % 3, text.length % 5, text.length % 7, 1],
            dimension: 4,
        };
    }

    async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((text) => this.embedQuery(text)));
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
    controlReadCount = 0;
    hasCollectionCount = 0;

    private listDocuments(collectionName: string, filter?: VectorFilter): VectorDocument[] {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            return [];
        }
        const matches = (document: VectorDocument, candidate?: VectorFilter): boolean => {
            if (!candidate) return true;
            if (candidate.kind === 'and') return candidate.operands.every((operand) => matches(document, operand));
            const value = document[candidate.field];
            if (candidate.kind === 'in') return candidate.values.includes(value as string);
            return candidate.operator === 'eq' ? value === candidate.value : value !== candidate.value;
        };
        return Array.from(collection.values())
            .filter((document) => document.fileExtension !== '.satori_meta')
            .filter((document) => matches(document, filter));
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

    private async storeDocuments(
        collectionName: string,
        documents: Array<IndexedVectorDocument | VectorDocument>,
    ): Promise<void> {
        const collection = this.collections.get(collectionName);
        if (!collection) {
            throw new Error(`Collection not found: ${collectionName}`);
        }
        for (const input of documents) {
            const document = 'projections' in input ? input.document : input;
            collection.set(document.id, document);
        }
    }

    async writeDocuments(collectionName: string, documents: IndexedVectorDocument[]): Promise<void> {
        await this.storeDocuments(collectionName, documents);
    }

    async insertControl(collectionName: string, record: VectorControlRecord): Promise<void> {
        await this.storeDocuments(collectionName, [{
            id: record.id,
            vector: [],
            content: '',
            relativePath: '.__satori__/control.json',
            startLine: 0,
            endLine: 0,
            fileExtension: '.satori_meta',
            metadata: { ...record.metadata, kind: record.kind },
        }]);
    }

    async getControl(collectionName: string, id: string): Promise<VectorControlRecord | null> {
        this.controlReadCount += 1;
        const document = this.collections.get(collectionName)?.get(id);
        return document ? {
            id,
            kind: typeof document.metadata.kind === 'string' ? document.metadata.kind : '',
            metadata: { ...document.metadata },
        } : null;
    }

    async deleteControl(collectionName: string, id: string): Promise<void> {
        await this.deleteDocuments(collectionName, [id]);
    }

    async retrieveDense(collectionName: string, request: DenseCandidateRequest): Promise<VectorCandidate[]> {
        return this.listDocuments(collectionName, request.filter)
            .slice(0, request.limit)
            .map((document, index) => ({ document, score: 1 - (index / 1000) }));
    }

    async retrieveLexical(collectionName: string, request: LexicalCandidateRequest): Promise<VectorCandidate[]> {
        return this.listDocuments(collectionName, request.filter)
            .slice(0, request.limit)
            .map((document, index) => ({ document, score: 1 - (index / 1000) }));
    }

    async deleteDocuments(collectionName: string, ids: string[]): Promise<void> {
        const collection = this.collections.get(collectionName);
        for (const id of ids) {
            collection?.delete(id);
        }
    }

    async queryDocuments(collectionName: string, request: VectorDocumentQuery): Promise<Record<string, unknown>[]> {
        if (
            request.filter === undefined
            && request.fields.length === 1
            && request.fields[0] === 'id'
            && (request.limit ?? 1000) > 1
        ) {
            this.payloadCountQueryCount += 1;
        }
        return this.listDocuments(collectionName, request.filter).slice(0, request.limit ?? 1000).map((document) => {
            const row: Record<string, unknown> = {};
            for (const field of request.fields) {
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

function createSnapshotManager(repoPath: string): SnapshotManager {
    const info = { status: 'indexed', indexStatus: 'completed' };
    // Only the codebase root is tracked. Unrestricted getters make nested file paths
    // look like roots and break prepared-generation identity comparisons.
    const isTrackedRoot = (codebasePath: string): boolean => codebasePath === repoPath;
    return {
        getAllCodebases: () => [{ path: repoPath, info }],
        getIndexedCodebases: () => [repoPath],
        getIndexingCodebases: () => [],
        getCodebaseInfo: (codebasePath: string) => (isTrackedRoot(codebasePath) ? info : undefined),
        getCodebaseStatus: (codebasePath: string) => (
            isTrackedRoot(codebasePath) ? info.status : 'not_found'
        ),
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
            getPreparedReadObservation: () => ({
                available: false as const,
                reason: 'watcher_manager_not_started' as const,
                freshnessEpoch: 1,
            }),
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
        assert.equal(coreEvidence.status, 'valid_v3', JSON.stringify(coreEvidence));
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
            getPreparedReadObservation: () => ({
                available: false as const,
                reason: 'watcher_manager_not_started' as const,
                freshnessEpoch: 1,
            }),
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
        const semanticControlReads = vectorDatabase.controlReadCount;
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
        // One warm-receipt check precedes search and one authority check seals the split hybrid read.
        assert.equal(vectorDatabase.controlReadCount - semanticControlReads, 2);
        assert.equal(vectorDatabase.hasCollectionCount - semanticCollectionProbes, 2);

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
        await publishCurrentAuthorityCheckpoint(context, repoPath);
        context.getActiveIndexedCollectionName = async () => context.resolveCollectionName(repoPath);

        let syncTriggered = false;
        const syncManager = {
            getPreparedReadObservation: () => ({
                available: false,
                reason: 'watcher_manager_not_started',
                freshnessEpoch: 1,
            }),
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
        // Prepared-generation identity requires a mutation lease observer; without it exact
        // opens collapse to NAVIGATION_UNAVAILABLE even under a proven generation receipt.
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(stateRoot, 'leases'),
            ownerId: 'rename-lifecycle-test',
        });
        const handlers = new ToolHandlers(
            context,
            createSnapshotManager(repoPath),
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-06-18T00:00:00.000Z'),
            undefined,
            null,
            undefined,
            undefined,
            null,
            coordinator,
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
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: oldSymbolInstanceId,
                context: { preset: 'implementation' },
            },
        }, toolContext);
        assert.equal(oldReadResponse.isError, true);
        const oldReadPayload = parsePayload(oldReadResponse);
        assert.equal(oldReadPayload.formatVersion, 2);
        assert.equal(oldReadPayload.kind, 'symbol_context');
        assert.equal(oldReadPayload.status, 'error');
        // Valid prepared authority + missing identity → structured symbol miss, not authority collapse.
        assert.equal(oldReadPayload.code, 'SYMBOL_NOT_FOUND');
        assert.equal(oldReadPayload.reason, 'symbol_not_found');

        const newReadResponse = await readFileTool.execute({
            path: newFilePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: newLoginGroup.target.symbolId,
                context: { preset: 'implementation' },
            },
        }, toolContext);
        assert.equal(newReadResponse.isError, undefined);
        const newReadPayload = parsePayload(newReadResponse);
        assert.equal(newReadPayload.formatVersion, 2);
        assert.equal(newReadPayload.kind, 'symbol_context');
        assert.equal(newReadPayload.status, 'ok');
        assert.equal(newReadPayload.symbol?.symbolId, newLoginGroup.target.symbolId);
        assert.match(JSON.stringify(newReadPayload.source), /export function login/);
        assert.doesNotMatch(JSON.stringify(newReadPayload.source), /from '\.\/old'/);

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
        await publishCurrentAuthorityCheckpoint(context, repoPath);
        context.getActiveIndexedCollectionName = async () => context.resolveCollectionName(repoPath);

        let ensureFreshnessCalls = 0;
        const syncManager = {
            getPreparedReadObservation: () => ({
                available: false,
                reason: 'watcher_manager_not_started',
                freshnessEpoch: 1,
            }),
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
        // Lease observer is required for prepared-generation identity on exact opens.
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(stateRoot, 'leases'),
            ownerId: 'dirty-navigation-lifecycle-test',
        });
        const handlers = new ToolHandlers(
            context,
            createSnapshotManager(repoPath),
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-06-18T00:00:00.000Z'),
            undefined,
            null,
            undefined,
            undefined,
            null,
            coordinator,
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

        // Known current identity under valid prepared authority returns bounded symbol_context.
        const currentReadResponse = await readFileTool.execute({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: oldSymbolInstanceId,
                context: { preset: 'implementation' },
            },
        }, createToolContext(repoPath, handlers));
        assert.equal(currentReadResponse.isError, undefined);
        const currentReadPayload = parsePayload(currentReadResponse);
        assert.equal(currentReadPayload.formatVersion, 2);
        assert.equal(currentReadPayload.kind, 'symbol_context');
        assert.equal(currentReadPayload.status, 'ok');
        assert.equal(currentReadPayload.symbol?.symbolId, oldSymbolInstanceId);

        // Missing identity under the same valid authority is a structured symbol miss.
        const missingReadResponse = await readFileTool.execute({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: 'sym_missing_under_valid_authority',
                context: { preset: 'implementation' },
            },
        }, createToolContext(repoPath, handlers));
        assert.equal(missingReadResponse.isError, true);
        const missingReadPayload = parsePayload(missingReadResponse);
        assert.equal(missingReadPayload.formatVersion, 2);
        assert.equal(missingReadPayload.kind, 'symbol_context');
        assert.equal(missingReadPayload.status, 'error');
        assert.equal(missingReadPayload.code, 'SYMBOL_NOT_FOUND');

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

        // The prepared registry still owns the old identity, but the renamed current source
        // cannot validate its span. Preserve identity while withholding stale source bytes.
        const staleReadResponse = await readFileTool.execute({
            path: filePath,
            mode: 'plain',
            open_symbol: {
                contractVersion: 2,
                symbolId: oldSymbolInstanceId,
                context: { preset: 'implementation' },
            },
        }, createToolContext(repoPath, handlers));
        assert.equal(staleReadResponse.isError, undefined);
        const staleReadPayload = parsePayload(staleReadResponse);
        assert.equal(staleReadPayload.formatVersion, 2);
        assert.equal(staleReadPayload.kind, 'symbol_context');
        assert.equal(staleReadPayload.status, 'ok');
        assert.equal(
            (staleReadPayload.symbol as { symbolId?: string } | undefined)?.symbolId,
            oldSymbolInstanceId,
        );
        const staleSource = staleReadPayload.source as {
            status?: string;
            mode?: string;
            completeSymbolReturned?: boolean;
            excerpts?: unknown[];
            omittedRanges?: unknown[];
            truncated?: boolean;
            emptyReason?: string;
        };
        assert.equal(staleSource.status, 'unavailable');
        assert.equal(staleSource.mode, 'bounded');
        assert.equal(staleSource.completeSymbolReturned, false);
        assert.deepEqual(staleSource.excerpts, []);
        assert.deepEqual(staleSource.omittedRanges, []);
        assert.equal(staleSource.truncated, true);
        assert.equal(staleSource.emptyReason, 'current_symbol_span_unavailable');
        assert.deepEqual(
            (staleReadPayload.authority as {
                source?: { freshness?: string; spanResolution?: string };
            } | undefined)?.source,
            {
                freshness: 'current_at_final_observation',
                spanResolution: 'unavailable',
            },
        );
        assert.equal(JSON.stringify(staleReadPayload).includes('runFresh'), false);
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
