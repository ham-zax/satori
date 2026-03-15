import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

const CAPABILITIES = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-watchers-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function createMutableSnapshot(repoPath: string, initialStatus: 'not_found' | 'indexed' | 'indexing' = 'indexed') {
    let currentStatus = initialStatus;
    let removedCompletely = 0;
    let saveCalls = 0;

    return {
        get saveCalls() {
            return saveCalls;
        },
        get removedCompletely() {
            return removedCompletely;
        },
        getAllCodebases: () => currentStatus === 'not_found'
            ? []
            : [{ path: repoPath, info: { status: currentStatus, lastUpdated: '2026-03-16T00:00:00.000Z' } }],
        getIndexedCodebases: () => currentStatus === 'indexed' ? [repoPath] : [],
        getIndexingCodebases: () => currentStatus === 'indexing' ? [repoPath] : [],
        getCodebaseStatus: () => currentStatus,
        getCodebaseInfo: () => currentStatus === 'not_found'
            ? undefined
            : { status: currentStatus, lastUpdated: '2026-03-16T00:00:00.000Z' },
        getCodebaseCallGraphSidecar: () => ({ version: 'v3' }),
        getIndexingProgress: () => currentStatus === 'indexing' ? 0 : undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        setCodebaseIndexing: () => {
            currentStatus = 'indexing';
        },
        setCodebaseIndexed: () => {
            currentStatus = 'indexed';
        },
        setCodebaseIndexManifest: () => undefined,
        removeCodebaseCompletely: () => {
            removedCompletely += 1;
            currentStatus = 'not_found';
        },
        saveCodebaseSnapshot: () => {
            saveCalls += 1;
        },
        setCodebaseIndexFailed: () => undefined,
    } as any;
}

function createWatchRecorder() {
    const touched: string[] = [];
    const unwatched: string[] = [];
    return {
        touched,
        unwatched,
        syncManager: {
            ensureFreshness: async () => ({
                mode: 'synced',
                checkedAt: new Date('2026-03-16T00:00:00.000Z').toISOString(),
                thresholdMs: 0,
                stats: { added: 0, removed: 0, modified: 0 }
            }),
            getWatchDebounceMs: () => 2000,
            touchWatchedCodebase: async (codebasePath: string) => {
                touched.push(codebasePath);
            },
            unwatchCodebase: async (codebasePath: string) => {
                unwatched.push(codebasePath);
            }
        } as any
    };
}

function parsePayload(response: any): any {
    const text = response?.content?.[0]?.text;
    assert.equal(typeof text, 'string');
    return JSON.parse(text);
}

test('handleIndexCodebase touches the watch list when create starts successfully', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshot = createMutableSnapshot(repoPath, 'not_found');
        const watch = createWatchRecorder();
        const context = {
            getVectorStore: () => ({ checkCollectionLimit: async () => true }),
            addCustomExtensions: () => undefined,
            addCustomIgnorePatterns: () => undefined,
            clearIndexCompletionMarker: async () => undefined,
        } as any;

        const handlers = new ToolHandlers(context, snapshot, watch.syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).startBackgroundIndexing = () => undefined;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const payload = parsePayload(response);

        assert.equal(payload.status, 'ok');
        assert.deepEqual(watch.touched, [repoPath]);
        assert.deepEqual(watch.unwatched, []);
    });
});

test('handleReindexCodebase touches the watch list when reindex starts successfully', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshot = createMutableSnapshot(repoPath, 'indexed');
        const watch = createWatchRecorder();
        const context = {
            getVectorStore: () => ({ checkCollectionLimit: async () => true }),
            addCustomExtensions: () => undefined,
            addCustomIgnorePatterns: () => undefined,
            clearIndexCompletionMarker: async () => undefined,
        } as any;

        const handlers = new ToolHandlers(context, snapshot, watch.syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).evaluateReindexPreflight = () => ({
            outcome: 'reindex_required',
            warnings: [],
            confidence: 'high'
        });
        (handlers as any).clearAllCollectionsForForceReindex = async () => [];
        (handlers as any).startBackgroundIndexing = () => undefined;
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleReindexCodebase({ path: repoPath });
        const payload = parsePayload(response);

        assert.equal(payload.action, 'reindex');
        assert.equal(payload.status, 'ok');
        assert.deepEqual(watch.touched, [repoPath]);
    });
});

test('handleSyncCodebase touches the watch list on success and handleClearIndex unwatches on clear', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshot = createMutableSnapshot(repoPath, 'indexed');
        const watch = createWatchRecorder();
        const context = {
            clearIndex: async () => undefined,
        } as any;

        const handlers = new ToolHandlers(context, snapshot, watch.syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const syncResponse = await handlers.handleSyncCodebase({ path: repoPath });
        const syncPayload = parsePayload(syncResponse);
        assert.equal(syncPayload.status, 'ok');
        assert.deepEqual(watch.touched, [repoPath]);

        const clearResponse = await handlers.handleClearIndex({ path: repoPath });
        const clearPayload = parsePayload(clearResponse);
        assert.equal(clearPayload.status, 'ok');
        assert.deepEqual(watch.unwatched, [repoPath]);
    });
});

test('handleSearchCode touches the watch list only for successful indexed-root search responses', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedSnapshot = createMutableSnapshot(repoPath, 'indexed');
        const indexedWatch = createWatchRecorder();
        const indexedContext = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => [{
                content: 'return true;',
                relativePath: 'src/auth.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.9,
                indexedAt: '2026-03-16T00:00:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            }]
        } as any;

        const indexedHandlers = new ToolHandlers(indexedContext, indexedSnapshot, indexedWatch.syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (indexedHandlers as any).validateCompletionProof = async () => ({ outcome: 'valid' });
        (indexedHandlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const okResponse = await indexedHandlers.handleSearchCode({
            path: repoPath,
            query: 'auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const okPayload = parsePayload(okResponse);
        assert.equal(okPayload.status, 'ok');
        assert.deepEqual(indexedWatch.touched, [repoPath]);

        const notIndexedSnapshot = createMutableSnapshot(repoPath, 'not_found');
        const notIndexedWatch = createWatchRecorder();
        const notIndexedHandlers = new ToolHandlers(indexedContext, notIndexedSnapshot, notIndexedWatch.syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (notIndexedHandlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const notIndexedResponse = await notIndexedHandlers.handleSearchCode({
            path: repoPath,
            query: 'auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const notIndexedPayload = parsePayload(notIndexedResponse);
        assert.equal(notIndexedPayload.status, 'not_indexed');
        assert.deepEqual(notIndexedWatch.touched, []);
    });
});

test('handleFileOutline and handleCallGraph touch the watch list for successful navigation responses', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'auth.ts');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export function auth() { return true; }\n', 'utf8');

        const snapshot = createMutableSnapshot(repoPath, 'indexed');
        const watch = createWatchRecorder();
        const context = {} as any;
        const callGraphManager = {
            loadSidecar: () => ({
                nodes: [{
                    symbolId: 'sym_auth',
                    symbolLabel: 'function auth()',
                    file: 'src/auth.ts',
                    span: { startLine: 1, endLine: 1 }
                }],
                edges: [],
                notes: []
            }),
            queryGraph: () => ({
                supported: true,
                nodes: [],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(
            context,
            snapshot,
            watch.syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            callGraphManager
        );
        (handlers as any).validateCompletionProof = async () => ({ outcome: 'valid' });
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const outlineResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/auth.ts'
        });
        const outlinePayload = parsePayload(outlineResponse);
        assert.equal(outlinePayload.status, 'ok');

        const graphResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/auth.ts',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()',
                span: { startLine: 1, endLine: 1 }
            },
            direction: 'both',
            depth: 1,
            limit: 5
        });
        const graphPayload = parsePayload(graphResponse);
        assert.equal(graphPayload.status, 'ok');

        assert.deepEqual(watch.touched, [repoPath, repoPath]);
    });
});
