import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import type { ManageIndexResponseEnvelope } from './manage-types.js';
import type { RuntimeOwnerMutationGate } from './runtime-owner.js';

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type ToolTextResponse = { content?: Array<{ text?: string }> };
type MutationCounters = {
    collectionLimitCalls?: number;
    setIndexingCalls?: number;
    ensureFreshnessCalls?: number;
    clearIndexCalls?: number;
};
type RuntimeOwnerHint = Array<{ pid?: number }>;
type BackendHint = { nextSteps: string[] };
type RuntimeMismatchHint = { indexedFingerprint?: string };
type IndexingInfo = { status: 'indexing'; indexingPercentage: number; lastUpdated: string };
type IndexFailedInfo = { status: 'indexfailed'; errorMessage: string; lastAttemptedPercentage?: number; lastUpdated: string };
type IndexedInfo = {
    status: 'indexed';
    indexedFiles: number;
    totalChunks: number;
    indexStatus: 'completed';
    indexFingerprint?: IndexFingerprint;
    fingerprintSource?: 'verified';
    lastUpdated: string;
};

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-manage-blocking-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function createHandlers(repoPath: string): ToolHandlers {
    const context = {
        clearIndex: async () => undefined,
        reindexByChange: async () => ({ added: 0, removed: 0, modified: 0 })
    } as unknown as HandlerContext;

    const snapshotManager = {
        getAllCodebases: () => [{ path: repoPath, info: { status: 'indexing' } }],
        getIndexingCodebases: () => [repoPath],
        getIndexedCodebases: () => [],
        getCodebaseStatus: () => 'indexing',
        getCodebaseInfo: () => ({
            status: 'indexing',
            indexingPercentage: 37,
            lastUpdated: '2026-02-27T23:57:03.000Z'
        }),
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined
    } as unknown as HandlerSnapshotManager;

    const syncManager = {
        getWatchDebounceMs: () => 120000
    } as unknown as HandlerSyncManager;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
    return handlers;
}

function parseManageEnvelope(response: ToolTextResponse): ManageIndexResponseEnvelope {
    const payload = response?.content?.[0]?.text;
    assert.equal(typeof payload, 'string');
    return JSON.parse(payload) as ManageIndexResponseEnvelope;
}

function assertBlockedEnvelope(envelope: ManageIndexResponseEnvelope, repoPath: string, action: 'create' | 'sync' | 'clear') {
    assert.equal(envelope.action, action);
    assert.equal(envelope.path, repoPath);
    assert.equal(envelope.status, 'not_ready');
    assert.equal(envelope.reason, 'indexing');
    assert.deepEqual(envelope.hints?.status, {
        tool: 'manage_index',
        args: { action: 'status', path: repoPath }
    });
    assert.equal(envelope.hints?.retryAfterMs, 2000);
    const text = envelope.humanText || '';
    assert.match(text, new RegExp(`action='${action}'`));
    assert.match(text, /reason=indexing/);
    assert.match(text, /retryAfterMs=2000/);
}

function runtimeOwnerConflictGate(): RuntimeOwnerMutationGate {
    return {
        checkMutation: async () => ({
            blocked: true,
            reason: 'runtime_owner_conflict',
            message: 'Index mutation is blocked because multiple Satori runtimes with different fingerprints/configs are active.',
            conflictingOwners: [{
                ownerId: 'other-owner',
                pid: 4242,
                ppid: 1,
                cmd: 'node /tmp/satori.js',
                cwd: '/tmp',
                startedAt: '2026-06-18T00:00:00.000Z',
                lastSeenAt: '2026-06-18T00:01:00.000Z',
                satoriVersion: '4.10.0',
                runtimeOwnerIdentityHash: 'different',
                configSource: 'env',
                conflictReasons: ['satoriVersion'],
            }]
        })
    };
}

function createMutationReadyHandlers(repoPath: string, gate: RuntimeOwnerMutationGate, counters: MutationCounters): ToolHandlers {
    const context = {
        getVectorStore: () => ({
            checkCollectionLimit: async () => {
                counters.collectionLimitCalls = (counters.collectionLimitCalls ?? 0) + 1;
                return true;
            }
        }),
        clearIndex: async () => {
            counters.clearIndexCalls = (counters.clearIndexCalls ?? 0) + 1;
        },
        resolveCollectionName: () => 'test_collection',
    } as unknown as HandlerContext;

    const snapshotManager = {
        getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
        getIndexingCodebases: () => [],
        getIndexedCodebases: () => [repoPath],
        getCodebaseStatus: () => 'indexed',
        getCodebaseInfo: () => ({
            status: 'indexed',
            indexedFiles: 1,
            totalChunks: 1,
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString()
        }),
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        removeCodebaseCompletely: () => undefined,
        saveCodebaseSnapshot: () => undefined,
        setCodebaseIndexing: () => {
            counters.setIndexingCalls = (counters.setIndexingCalls ?? 0) + 1;
        },
        markCodebaseCleared: () => undefined,
    } as unknown as HandlerSnapshotManager;

    const syncManager = {
        getWatchDebounceMs: () => 2000,
        ensureFreshness: async () => {
            counters.ensureFreshnessCalls = (counters.ensureFreshnessCalls ?? 0) + 1;
            return { mode: 'synced', checkedAt: new Date().toISOString(), thresholdMs: 0, stats: { added: 0, removed: 0, modified: 0 } };
        },
        unwatchCodebase: async () => undefined,
    } as unknown as HandlerSyncManager;

    return new ToolHandlers(
        context,
        snapshotManager,
        syncManager,
        RUNTIME_FINGERPRINT,
        CAPABILITIES,
        () => Date.now(),
        undefined,
        null,
        undefined,
        undefined,
        gate
    );
}

test('handleIndexCodebase returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assertBlockedEnvelope(envelope, repoPath, 'create');
    });
});

test('handleIndexCodebase blocks create before mutation when runtime owners conflict', async () => {
    await withTempRepo(async (repoPath) => {
        const counters: MutationCounters = {};
        const handlers = createMutationReadyHandlers(repoPath, runtimeOwnerConflictGate(), counters);

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'create');
        assert.equal(envelope.status, 'blocked');
        assert.equal(envelope.reason, 'runtime_owner_conflict');
        assert.match(envelope.humanText, /multiple Satori runtimes/i);
        assert.equal((envelope.hints?.runtimeOwners as RuntimeOwnerHint | undefined)?.[0]?.pid, 4242);
        assert.match(String(envelope.hints?.nextStep), /Restart all Satori MCP clients/i);
        assert.equal(counters.collectionLimitCalls ?? 0, 0);
        assert.equal(counters.setIndexingCalls ?? 0, 0);
    });
});

test('handleReindexCodebase blocks before preflight and force cleanup when runtime owners conflict', async () => {
    await withTempRepo(async (repoPath) => {
        const counters: MutationCounters = {};
        const handlers = createMutationReadyHandlers(repoPath, runtimeOwnerConflictGate(), counters);

        const response = await handlers.handleReindexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'reindex');
        assert.equal(envelope.status, 'blocked');
        assert.equal(envelope.reason, 'runtime_owner_conflict');
        assert.equal(counters.collectionLimitCalls ?? 0, 0);
        assert.equal(counters.setIndexingCalls ?? 0, 0);
    });
});

test('handleSyncCodebase returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleSyncCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assertBlockedEnvelope(envelope, repoPath, 'sync');
    });
});

test('handleSyncCodebase blocks before freshness mutation when runtime owners conflict', async () => {
    await withTempRepo(async (repoPath) => {
        const counters: MutationCounters = {};
        const handlers = createMutationReadyHandlers(repoPath, runtimeOwnerConflictGate(), counters);

        const response = await handlers.handleSyncCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'sync');
        assert.equal(envelope.status, 'blocked');
        assert.equal(envelope.reason, 'runtime_owner_conflict');
        assert.equal(counters.ensureFreshnessCalls ?? 0, 0);
    });
});

test('handleClearIndex returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleClearIndex({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assertBlockedEnvelope(envelope, repoPath, 'clear');
    });
});

test('handleClearIndex blocks before destructive clear when runtime owners conflict', async () => {
    await withTempRepo(async (repoPath) => {
        const counters: MutationCounters = {};
        const handlers = createMutationReadyHandlers(repoPath, runtimeOwnerConflictGate(), counters);

        const response = await handlers.handleClearIndex({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'clear');
        assert.equal(envelope.status, 'blocked');
        assert.equal(envelope.reason, 'runtime_owner_conflict');
        assert.equal(counters.clearIndexCalls ?? 0, 0);
    });
});

test('handleGetIndexingStatus does not consult runtime owner mutation gate', async () => {
    await withTempRepo(async (repoPath) => {
        const counters = {};
        const gate: RuntimeOwnerMutationGate = {
            checkMutation: async () => {
                throw new Error('status must not use mutation gate');
            }
        };
        const handlers = createMutationReadyHandlers(repoPath, gate, counters);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'status');
        assert.notEqual(envelope.reason, 'runtime_owner_conflict');
    });
});

test('handleSyncCodebase returns vector backend diagnostics when freshness sync hits stopped cluster', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {} as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({ status: 'indexed' }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => {
                throw new Error('16 UNAUTHENTICATED: The action is unavailable under current cluster status STOPPED.');
            },
            getWatchDebounceMs: () => 2000
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleSyncCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.action, 'sync');
        assert.equal(envelope.path, repoPath);
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.reason, 'vector_backend_unavailable');
        assert.equal(envelope.code, 'ZILLIZ_CLUSTER_STOPPED');
        const backendHint = envelope.hints?.backend as BackendHint | undefined;
        assert.ok(backendHint);
        assert.match(backendHint.nextSteps.join(' '), /Resume the Zilliz Cloud cluster/);
    });
});

test('handleGetIndexingStatus recovers stale indexing state to failed when completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        let currentInfo: IndexingInfo | IndexFailedInfo = {
            status: 'indexing',
            indexingPercentage: 98,
            lastUpdated: '2026-02-27T23:57:03.000Z'
        };
        let markerCalls = 0;
        let failedCalls = 0;
        let saveCalls = 0;

        const context = {
            getIndexCompletionMarker: async () => {
                markerCalls += 1;
                return null;
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: currentInfo }],
            getIndexingCodebases: () => currentInfo.status === 'indexing' ? [repoPath] : [],
            getIndexedCodebases: () => [],
            getCodebaseStatus: () => currentInfo.status,
            getCodebaseInfo: () => currentInfo,
            getIndexingProgress: () => currentInfo.status === 'indexing' ? currentInfo.indexingPercentage : undefined,
            setCodebaseIndexFailed: (_path: string, errorMessage: string, lastAttemptedPercentage?: number) => {
                failedCalls += 1;
                currentInfo = {
                    status: 'indexfailed',
                    errorMessage,
                    lastAttemptedPercentage,
                    lastUpdated: new Date().toISOString()
                };
            },
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => { saveCalls += 1; }
        } as unknown as HandlerSnapshotManager;

        const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        const text = envelope.humanText;

        assert.equal(markerCalls, 1);
        assert.equal(failedCalls, 1);
        assert.equal(saveCalls, 1);
        assert.match(text, /indexing failed/i);
        assert.match(text, /Interrupted indexing detected without completion marker proof/i);
    });
});

test('handleGetIndexingStatus recovers stale indexing mismatch to requires_reindex with restart guidance', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedFingerprint: IndexFingerprint = {
            ...RUNTIME_FINGERPRINT,
            embeddingModel: 'voyage-code-3'
        };
        let currentInfo: IndexingInfo | IndexedInfo = {
            status: 'indexing',
            indexingPercentage: 0,
            lastUpdated: '2026-02-27T23:57:03.000Z'
        };
        let markerCalls = 0;
        let setIndexedCalls = 0;
        let saveCalls = 0;

        const context = {
            getIndexCompletionMarker: async () => {
                markerCalls += 1;
                return {
                    kind: 'satori_index_completion_v1',
                    codebasePath: repoPath,
                    fingerprint: indexedFingerprint,
                    indexedFiles: 169,
                    totalChunks: 728,
                    completedAt: '2026-02-27T23:57:10.000Z',
                    runId: 'run_test'
                };
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: currentInfo }],
            getIndexingCodebases: () => currentInfo.status === 'indexing' ? [repoPath] : [],
            getIndexedCodebases: () => currentInfo.status === 'indexed' ? [repoPath] : [],
            getCodebaseStatus: () => currentInfo.status,
            getCodebaseInfo: () => currentInfo,
            getIndexingProgress: () => currentInfo.status === 'indexing' ? currentInfo.indexingPercentage : undefined,
            setCodebaseIndexed: (_path: string, stats: { indexedFiles: number; totalChunks: number }, indexFingerprint: IndexFingerprint) => {
                setIndexedCalls += 1;
                currentInfo = {
                    status: 'indexed',
                    indexedFiles: stats.indexedFiles,
                    totalChunks: stats.totalChunks,
                    indexStatus: 'completed',
                    indexFingerprint,
                    fingerprintSource: 'verified',
                    lastUpdated: new Date().toISOString()
                };
            },
            ensureFingerprintCompatibilityOnAccess: () => {
                if (currentInfo.status === 'indexed') {
                    return {
                        allowed: false,
                        changed: false,
                        reason: 'fingerprint_mismatch',
                        message: `Index fingerprint mismatch. Indexed with ${indexedFingerprint.embeddingProvider}/${indexedFingerprint.embeddingModel}/${indexedFingerprint.embeddingDimension}/${indexedFingerprint.vectorStoreProvider}/${indexedFingerprint.schemaVersion}, current runtime is ${RUNTIME_FINGERPRINT.embeddingProvider}/${RUNTIME_FINGERPRINT.embeddingModel}/${RUNTIME_FINGERPRINT.embeddingDimension}/${RUNTIME_FINGERPRINT.vectorStoreProvider}/${RUNTIME_FINGERPRINT.schemaVersion}.`
                    };
                }
                return { allowed: true, changed: false };
            },
            saveCodebaseSnapshot: () => { saveCalls += 1; }
        } as unknown as HandlerSnapshotManager;

        const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.status, 'requires_reindex');
        assert.equal(envelope.reason, 'requires_reindex');
        assert.equal(markerCalls, 1);
        assert.equal(setIndexedCalls, 1);
        assert.equal(saveCalls, 1);
        assert.match(envelope.humanText || '', /restart Satori with VoyageAI\/voyage-code-3\/1024\/Milvus\/hybrid_v3/i);
        assert.equal((envelope.hints?.runtimeMismatch as RuntimeMismatchHint | undefined)?.indexedFingerprint, 'VoyageAI/voyage-code-3/1024/Milvus/hybrid_v3');
    });
});

test('recent indexing state does not trigger stale-index recovery probes', async () => {
    await withTempRepo(async (repoPath) => {
        const recent = new Date().toISOString();
        let markerCalls = 0;

        const context = {
            getIndexCompletionMarker: async () => {
                markerCalls += 1;
                return null;
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexing' } }],
            getIndexingCodebases: () => [repoPath],
            getIndexedCodebases: () => [],
            getCodebaseStatus: () => 'indexing',
            getCodebaseInfo: () => ({
                status: 'indexing',
                indexingPercentage: 37,
                lastUpdated: recent
            }),
            getIndexingProgress: () => 37,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;

        const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assertBlockedEnvelope(envelope, repoPath, 'create');
        assert.equal(markerCalls, 0);
    });
});

test('handleSyncCodebase routes through ensureFreshness and does not call raw reindexByChange', async () => {
    await withTempRepo(async (repoPath) => {
        let rawReindexCalls = 0;
        let freshnessCalls = 0;
        let observedThreshold: number | null = null;

        const context = {
            reindexByChange: async () => {
                rawReindexCalls += 1;
                return { added: 9, removed: 9, modified: 9, changedFiles: [] };
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 10,
                totalChunks: 20,
                indexStatus: 'completed',
                lastUpdated: new Date().toISOString()
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            getWatchDebounceMs: () => 2000,
            ensureFreshness: async (_path: string, thresholdMs: number) => {
                freshnessCalls += 1;
                observedThreshold = thresholdMs;
                return {
                    mode: 'synced',
                    checkedAt: new Date().toISOString(),
                    thresholdMs,
                    stats: { added: 1, removed: 0, modified: 1 }
                };
            }
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleSyncCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        const text = envelope.humanText;

        assert.equal(envelope.status, 'ok');
        assert.equal(rawReindexCalls, 0);
        assert.equal(freshnessCalls, 1);
        assert.equal(observedThreshold, 0);
        assert.match(text, /Incremental sync completed/i);
        assert.match(text, /\+ 1 file\(s\) added/i);
        assert.match(text, /~ 1 file\(s\) modified/i);
    });
});

test('handleSyncCodebase surfaces ignore reconcile failure from ensureFreshness', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {} as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 10,
                totalChunks: 20,
                indexStatus: 'completed',
                lastUpdated: new Date().toISOString()
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            getWatchDebounceMs: () => 2000,
            ensureFreshness: async () => ({
                mode: 'ignore_reload_failed',
                checkedAt: new Date().toISOString(),
                thresholdMs: 0,
                errorMessage: 'ignore_reload_failed',
                fallbackSyncExecuted: true
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleSyncCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        const text = envelope.humanText;

        assert.equal(envelope.status, 'error');
        assert.match(text, /ignore-rule reconciliation failed/i);
        assert.match(text, /Fallback incremental sync was executed/i);
    });
});

test('handleSyncCodebase surfaces coalesced in-flight reconcile failure from ensureFreshness', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {} as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 10,
                totalChunks: 20,
                indexStatus: 'completed',
                lastUpdated: new Date().toISOString()
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            getWatchDebounceMs: () => 2000,
            ensureFreshness: async () => ({
                mode: 'coalesced',
                checkedAt: new Date().toISOString(),
                thresholdMs: 0,
                errorMessage: 'ignore_reload_failed',
                fallbackSyncExecuted: true
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleSyncCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        const text = envelope.humanText;

        assert.equal(envelope.status, 'error');
        assert.match(text, /coalesced in-flight reconcile failed/i);
        assert.match(text, /Fallback incremental sync was executed/i);
    });
});
