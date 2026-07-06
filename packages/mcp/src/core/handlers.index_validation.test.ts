import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { COLLECTION_LIMIT_MESSAGE, RemoteCollectionDeletePendingError } from '@zokizuan/satori-core';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import type { ManageIndexResponseEnvelope } from './manage-types.js';

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

type BackendProvider = 'zilliz' | 'milvus';
type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type ToolTextResponse = { content?: Array<{ text?: string }> };
type BackendHintView = {
    retryable?: boolean;
    nextSteps?: string[];
};
type ToolHandlersTestOverrides = {
    startBackgroundIndexing: (codebasePath: string, forceReindex: boolean, writeCollectionName?: string) => void | Promise<void>;
};

interface ValidationHarnessOptions {
    checkCollectionLimitImpl: () => Promise<boolean>;
    backendProvider?: BackendProvider;
    collectionDetails?: Array<{ name: string; createdAt?: string }>;
    metadataByCollection?: Record<string, { codebasePath?: string }>;
    snapshotCodebases?: Array<{ path: string; info: { lastUpdated: string; status?: string } }>;
    hasIndexedCollectionImpl?: (codebasePath: string) => Promise<boolean>;
    hasCollectionImpl?: (collectionName: string) => Promise<boolean>;
    dropCollectionImpl?: (collectionName: string) => Promise<void>;
    omitStagedCollectionResolver?: boolean;
}

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-index-validation-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function resolveCollectionName(codebasePath: string): string {
    const normalized = path.resolve(codebasePath);
    const digest = crypto.createHash('md5').update(normalized).digest('hex').slice(0, 8);
    return `hybrid_code_chunks_${digest}`;
}

function createHandlersForValidation(options: ValidationHarnessOptions): {
    handlers: ToolHandlers;
    droppedCollections: string[];
    snapshotEvents: { removed: string[]; indexing: string[]; saved: number };
} {
    const droppedCollections: string[] = [];
    const snapshotEvents = { removed: [] as string[], indexing: [] as string[], saved: 0 };
    const backendProvider = options.backendProvider || 'milvus';
    const collectionDetails = options.collectionDetails || [];
    const metadataByCollection = options.metadataByCollection || {};
    const snapshotCodebases = options.snapshotCodebases || [];

    const vectorStore = {
        checkCollectionLimit: options.checkCollectionLimitImpl,
        getBackendInfo: () => ({ provider: backendProvider, transport: 'grpc' as const, address: 'in03.example.cloud.zilliz.com' }),
        listCollectionDetails: async () => collectionDetails,
        listCollections: async () => collectionDetails.map((detail) => detail.name),
        query: async (collectionName: string) => {
            const metadata = metadataByCollection[collectionName];
            if (!metadata?.codebasePath) {
                return [];
            }

            return [{ metadata: JSON.stringify({ codebasePath: metadata.codebasePath }) }];
        },
        hasCollection: async (collectionName: string) => {
            if (options.hasCollectionImpl) {
                return options.hasCollectionImpl(collectionName);
            }
            return collectionDetails.some((detail) => detail.name === collectionName);
        },
        dropCollection: async (collectionName: string) => {
            droppedCollections.push(collectionName);
            if (options.dropCollectionImpl) {
                await options.dropCollectionImpl(collectionName);
            }
        }
    };

    const context = {
        hasIndexedCollection: async (codebasePath: string) => {
            if (options.hasIndexedCollectionImpl) {
                return options.hasIndexedCollectionImpl(codebasePath);
            }
            return false;
        },
        getVectorStore: () => vectorStore,
        resolveCollectionName,
        ...(!options.omitStagedCollectionResolver ? {
            resolveStagedCollectionName: (codebasePath: string, generationId: string) =>
                `${resolveCollectionName(codebasePath)}__gen_${generationId}`,
        } : {}),
        addCustomExtensions: () => undefined,
        addCustomIgnorePatterns: () => undefined,
        clearIndex: async () => undefined,
    } as unknown as HandlerContext;

    const snapshotManager = {
        getIndexingCodebases: () => [],
        getCodebaseInfo: () => undefined,
        getIndexedCodebases: () => [],
        getCodebaseStatus: () => 'not_found',
        removeCodebaseCompletely: (codebasePath: string) => {
            snapshotEvents.removed.push(codebasePath);
        },
        setCodebaseIndexing: (codebasePath: string) => {
            snapshotEvents.indexing.push(codebasePath);
        },
        saveCodebaseSnapshot: () => {
            snapshotEvents.saved += 1;
        },
        getAllCodebases: () => snapshotCodebases,
    } as unknown as HandlerSnapshotManager;

    const syncManager = {
        unregisterCodebaseWatcher: async () => undefined,
    } as unknown as HandlerSyncManager;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
    (handlers as unknown as ToolHandlersTestOverrides).startBackgroundIndexing = async () => undefined;
    return { handlers, droppedCollections, snapshotEvents };
}

function parseManageEnvelope(response: ToolTextResponse): ManageIndexResponseEnvelope {
    const payload = response?.content?.[0]?.text;
    assert.equal(typeof payload, 'string');
    return JSON.parse(payload) as ManageIndexResponseEnvelope;
}

test('handleIndexCodebase returns Zilliz eviction guidance with free-tier reason and agent instructions', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => false,
            collectionDetails: [
                { name: 'hybrid_code_chunks_old11111', createdAt: '2026-01-10T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_mid22222', createdAt: '2026-02-10T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_new33333', createdAt: '2026-02-20T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_new44444', createdAt: '2026-02-24T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_new55555', createdAt: '2026-02-25T10:00:00.000Z' },
            ],
            metadataByCollection: {
                hybrid_code_chunks_old11111: { codebasePath: '/repo/oldest' },
                hybrid_code_chunks_mid22222: { codebasePath: '/repo/mid' },
                hybrid_code_chunks_new33333: { codebasePath: '/repo/newer' },
                hybrid_code_chunks_new44444: { codebasePath: '/repo/newest-1' },
                hybrid_code_chunks_new55555: { codebasePath: '/repo/newest-2' },
            }
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        const text = envelope.humanText;

        assert.match(text, /Reason: The connected Zilliz cluster has no remaining collection slots/i);
        assert.match(text, /Current Satori-managed collections \(oldest -> newest\):/i);
        assert.match(text, /\[oldest\]/i);
        assert.match(text, /\[newest\]/i);
        assert.match(text, /manage_index \{"action":"create","path":".*","zillizDropCollection":"<collection_name>"\}/i);
        assert.match(text, /Agent instructions:/i);
        assert.match(text, /Do not auto-delete without explicit user confirmation/i);
    });
});

test('handleIndexCodebase ordering falls back to snapshot lastUpdated when collection createdAt is unreliable', async () => {
    await withTempRepo(async (repoPath) => {
        const tradingCollection = 'hybrid_code_chunks_trade1234';
        const promptReadyCollection = 'hybrid_code_chunks_prompt5678';

        const { handlers } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => false,
            collectionDetails: [
                { name: tradingCollection, createdAt: '1970-01-01T01:52:39.000Z' },
                { name: promptReadyCollection, createdAt: '1970-01-01T01:52:39.000Z' },
            ],
            metadataByCollection: {
                [tradingCollection]: { codebasePath: '/home/hamza/repo/tradingview_ratio' },
                [promptReadyCollection]: { codebasePath: '/home/hamza/repo/promptready_extension' },
            },
            snapshotCodebases: [
                {
                    path: '/home/hamza/repo/tradingview_ratio',
                    info: { lastUpdated: '2026-02-10T10:00:00.000Z', status: 'indexed' }
                },
                {
                    path: '/home/hamza/repo/promptready_extension',
                    info: { lastUpdated: '2026-02-26T07:15:35.000Z', status: 'sync_completed' }
                },
            ]
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        const text = envelope.humanText;

        const tradingIndex = text.indexOf(tradingCollection);
        const promptReadyIndex = text.indexOf(promptReadyCollection);
        assert.ok(tradingIndex >= 0, 'expected trading collection to be listed');
        assert.ok(promptReadyIndex >= 0, 'expected promptready collection to be listed');
        assert.ok(
            tradingIndex < promptReadyIndex,
            'expected trading collection to appear before promptready collection (older snapshot fallback)'
        );
        assert.match(text, new RegExp(`1\\. ${tradingCollection} \\[oldest\\]`));
        assert.match(text, new RegExp(`2\\. ${promptReadyCollection} \\[newest\\]`));
    });
});

test('handleIndexCodebase keeps generic limit message for non-Zilliz backend', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers } = createHandlersForValidation({
            backendProvider: 'milvus',
            checkCollectionLimitImpl: async () => false,
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.humanText, COLLECTION_LIMIT_MESSAGE);
    });
});

test('handleIndexCodebase supports explicit zillizDropCollection for user-selected eviction', async () => {
    await withTempRepo(async (repoPath) => {
        const existingCollections = new Set<string>(['hybrid_code_chunks_deadbeef']);
        const { handlers, droppedCollections } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            collectionDetails: [
                { name: 'hybrid_code_chunks_deadbeef', createdAt: '2026-01-01T00:00:00.000Z' }
            ],
            metadataByCollection: {
                hybrid_code_chunks_deadbeef: { codebasePath: '/repo/stale' }
            },
            hasCollectionImpl: async (collectionName) => existingCollections.has(collectionName),
            dropCollectionImpl: async (collectionName) => {
                existingCollections.delete(collectionName);
            },
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            zillizDropCollection: 'hybrid_code_chunks_deadbeef'
        });

        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'ok');
        const text = envelope.humanText;
        assert.match(text, /Dropped Zilliz collection 'hybrid_code_chunks_deadbeef'/i);
        assert.equal(droppedCollections.length, 1);
        assert.equal(droppedCollections[0], 'hybrid_code_chunks_deadbeef');
    });
});

test('handleIndexCodebase retries explicit zillizDropCollection until deletion is verified absent', async () => {
    await withTempRepo(async (repoPath) => {
        const existingCollections = new Set<string>(['hybrid_code_chunks_deadbeef']);
        let dropAttempts = 0;
        const { handlers, snapshotEvents } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            collectionDetails: [
                { name: 'hybrid_code_chunks_deadbeef', createdAt: '2026-01-01T00:00:00.000Z' }
            ],
            metadataByCollection: {
                hybrid_code_chunks_deadbeef: { codebasePath: '/repo/stale' }
            },
            hasCollectionImpl: async (collectionName) => existingCollections.has(collectionName),
            dropCollectionImpl: async (collectionName) => {
                dropAttempts += 1;
                if (dropAttempts < 3) {
                    throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
                }
                existingCollections.delete(collectionName);
            }
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            zillizDropCollection: 'hybrid_code_chunks_deadbeef'
        });

        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'ok');
        assert.equal(dropAttempts, 3);
        assert.deepEqual(snapshotEvents.removed, ['/repo/stale']);
    });
});

test('handleIndexCodebase keeps local state when explicit zillizDropCollection remains pending remotely', async () => {
    await withTempRepo(async (repoPath) => {
        const existingCollections = new Set<string>(['hybrid_code_chunks_deadbeef']);
        const { handlers, snapshotEvents } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            collectionDetails: [
                { name: 'hybrid_code_chunks_deadbeef', createdAt: '2026-01-01T00:00:00.000Z' }
            ],
            metadataByCollection: {
                hybrid_code_chunks_deadbeef: { codebasePath: '/repo/stale' }
            },
            hasCollectionImpl: async (collectionName) => existingCollections.has(collectionName),
            dropCollectionImpl: async () => {
                throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
            }
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            zillizDropCollection: 'hybrid_code_chunks_deadbeef'
        });

        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.reason, 'remote_delete_pending');
        assert.match(envelope.humanText, /remote deletion is still pending/i);
        assert.deepEqual(snapshotEvents.removed, []);
        assert.deepEqual(snapshotEvents.indexing, []);
    });
});

test('handleIndexCodebase force reindex stages into a new generation without eager cleanup', async () => {
    await withTempRepo(async (repoPath) => {
        const resolvedCollection = resolveCollectionName(repoPath);
        const hash = resolvedCollection.split('_').pop()!;
        const legacyCollection = `code_chunks_${hash}`;
        const modernCollection = `hybrid_code_chunks_${hash}`;
        const existingCollections = new Set<string>([legacyCollection, modernCollection]);

        const { handlers, droppedCollections, snapshotEvents } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            collectionDetails: [
                { name: legacyCollection, createdAt: '2026-01-01T00:00:00.000Z' },
                { name: modernCollection, createdAt: '2026-01-02T00:00:00.000Z' },
                { name: 'hybrid_code_chunks_unrelated', createdAt: '2026-01-03T00:00:00.000Z' },
            ],
            hasCollectionImpl: async (collectionName) => existingCollections.has(collectionName),
            dropCollectionImpl: async (collectionName) => {
                existingCollections.delete(collectionName);
            },
        });
        let startedArgs: [string, boolean, string | undefined] | null = null;
        (handlers as unknown as ToolHandlersTestOverrides).startBackgroundIndexing = async (
            codebasePath: string,
            forceReindex: boolean,
            stagedCollectionName?: string
        ) => {
            startedArgs = [codebasePath, forceReindex, stagedCollectionName];
        };

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            force: true
        });

        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'ok');
        assert.match(envelope.humanText, /Started background indexing/i);
        assert.ok(startedArgs);
        assert.deepEqual(startedArgs?.slice(0, 2), [repoPath, true]);
        assert.match(String(startedArgs?.[2] || ''), new RegExp(`^${modernCollection}__gen_run_`));
        assert.deepEqual(droppedCollections, []);
        assert.deepEqual(snapshotEvents.removed, []);
    });
});

test('handleIndexCodebase fallback staged collection names stay backend-safe when no context resolver is provided', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            omitStagedCollectionResolver: true,
        });
        let startedArgs: [string, boolean, string | undefined] | null = null;
        (handlers as unknown as ToolHandlersTestOverrides).startBackgroundIndexing = async (
            codebasePath: string,
            forceReindex: boolean,
            stagedCollectionName?: string
        ) => {
            startedArgs = [codebasePath, forceReindex, stagedCollectionName];
        };

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            force: true,
        });

        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'ok');
        assert.ok(startedArgs);
        assert.match(String(startedArgs?.[2] || ''), /^hybrid_code_chunks_[0-9a-f]{8}__gen_run_[A-Za-z0-9_]+$/);
        assert.equal(String(startedArgs?.[2] || '').includes('-'), false);
    });
});

test('handleIndexCodebase force reindex does not attempt remote cleanup before staged kickoff', async () => {
    await withTempRepo(async (repoPath) => {
        const resolvedCollection = resolveCollectionName(repoPath);
        const hash = resolvedCollection.split('_').pop()!;
        const legacyCollection = `code_chunks_${hash}`;
        const modernCollection = `hybrid_code_chunks_${hash}`;
        const existingCollections = new Set<string>([legacyCollection, modernCollection]);

        const { handlers, droppedCollections, snapshotEvents } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            collectionDetails: [
                { name: legacyCollection, createdAt: '2026-01-01T00:00:00.000Z' },
                { name: modernCollection, createdAt: '2026-01-02T00:00:00.000Z' },
            ],
            hasCollectionImpl: async (collectionName) => existingCollections.has(collectionName),
            dropCollectionImpl: async (collectionName) => {
                throw new Error(`dropCollection should not be called during staged kickoff (${collectionName})`);
            },
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            force: true
        });

        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'ok');
        assert.match(envelope.humanText, /Started background indexing/i);
        assert.deepEqual(droppedCollections, []);
        assert.deepEqual(snapshotEvents.removed, []);
        assert.deepEqual(snapshotEvents.indexing, [repoPath]);
    });
});

test('handleIndexCodebase rejects zillizDropCollection for non-Zilliz backend', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers, droppedCollections } = createHandlersForValidation({
            backendProvider: 'milvus',
            checkCollectionLimitImpl: async () => true,
            hasCollectionImpl: async () => true,
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            zillizDropCollection: 'hybrid_code_chunks_deadbeef'
        });

        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        const text = envelope.humanText;
        assert.match(text, /only supported when connected to a Zilliz Cloud backend/i);
        assert.equal(droppedCollections.length, 0);
    });
});

test('handleIndexCodebase returns vector backend diagnostics for Zilliz validation auth failures', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => {
                throw {
                    code: 401,
                    reason: 'permission denied while creating collection',
                    details: {
                        message: 'token is invalid'
                    }
                };
            }
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.reason, 'vector_backend_unavailable');
        assert.equal(envelope.code, 'VECTOR_BACKEND_AUTH_FAILED');
        const backendHint = envelope.hints?.backend as BackendHintView | undefined;
        assert.equal(backendHint?.retryable, false);
        assert.match(envelope.humanText, /Vector backend authentication failed/i);
    });
});

test('handleIndexCodebase returns vector backend diagnostics for stopped Zilliz clusters', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers, snapshotEvents } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => {
                throw new Error('16 UNAUTHENTICATED: The action is unavailable under current cluster status STOPPED.');
            }
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.reason, 'vector_backend_unavailable');
        assert.equal(envelope.code, 'ZILLIZ_CLUSTER_STOPPED');
        const backendHint = envelope.hints?.backend as BackendHintView | undefined;
        assert.match((backendHint?.nextSteps || []).join(' '), /Resume the Zilliz Cloud cluster/);
        assert.deepEqual(snapshotEvents.removed, []);
        assert.deepEqual(snapshotEvents.indexing, []);
    });
});

test('handleIndexCodebase create validation timeout returns vector diagnostics and does not mutate local index state', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers, snapshotEvents } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => {
                throw new Error('4 DEADLINE_EXCEEDED: Deadline exceeded after 15.005s');
            }
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.reason, 'vector_backend_unavailable');
        assert.equal(envelope.code, 'VECTOR_BACKEND_TIMEOUT');
        const backendHint = envelope.hints?.backend as BackendHintView | undefined;
        assert.equal(backendHint?.retryable, true);
        assert.match(envelope.humanText, /Vector backend request timed out/i);
        assert.deepEqual(snapshotEvents.removed, []);
        assert.deepEqual(snapshotEvents.indexing, []);
    });
});

test('handleIndexCodebase create validation pending delete does not mutate local index state', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers, snapshotEvents } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => {
                throw new RemoteCollectionDeletePendingError(
                    'dummy_collection_validation',
                    3,
                    new Error('dropCollection returned successfully but collection still exists')
                );
            }
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.reason, 'remote_delete_pending');
        assert.match(envelope.humanText, /validation collection deletion is still pending/i);
        assert.match(envelope.humanText, /local index state was not changed/i);
        assert.deepEqual(envelope.hints?.retry, {
            tool: 'manage_index',
            args: { action: 'create', path: repoPath }
        });
        assert.deepEqual(snapshotEvents.removed, []);
        assert.deepEqual(snapshotEvents.indexing, []);
    });
});
