import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import type { IndexFingerprint, IndexOperationPhase, IndexOperationReceipt } from '../config.js';
import type { ManageIndexResponseEnvelope } from './manage-types.js';
import type { RuntimeOwnerMutationGate } from './runtime-owner.js';
import { MutationLeaseCoordinator, type RootMutationLease } from './mutation-lease.js';

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
type ToolHandlersWithManageIndexingHost = {
    manageIndexingHandlers: {
        host: {
            rebuildCallGraphForIndex(codebasePath: string): Promise<void>;
        };
    };
};
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
    if (typeof payload !== 'string') {
        assert.fail('Expected manage_index response text.');
    }
    return JSON.parse(payload) as ManageIndexResponseEnvelope;
}

function createReceiptHarness() {
    let latestOperation: IndexOperationReceipt | undefined;
    const persistedPhases: IndexOperationPhase[] = [];
    let startCalls = 0;

    return {
        persistedPhases,
        get startCalls() {
            return startCalls;
        },
        get latestOperation() {
            return latestOperation ? structuredClone(latestOperation) : undefined;
        },
        snapshotMethods: {
            startOperation(lease: RootMutationLease): IndexOperationReceipt {
                startCalls += 1;
                latestOperation = {
                    id: lease.operationId,
                    action: lease.action,
                    canonicalRoot: lease.canonicalRoot,
                    generation: lease.generation,
                    acceptedAt: lease.acquiredAt,
                    phase: 'accepted',
                    lastDurableTransitionAt: lease.acquiredAt,
                    runtimeFingerprint: RUNTIME_FINGERPRINT,
                    writer: {
                        ownerId: lease.ownerId,
                        pid: lease.pid,
                        satoriVersion: 'test',
                    },
                };
                return structuredClone(latestOperation);
            },
            transitionOperation(lease: RootMutationLease, phase: IndexOperationPhase): IndexOperationReceipt {
                assert.equal(latestOperation?.id, lease.operationId);
                latestOperation = {
                    ...latestOperation,
                    phase,
                    lastDurableTransitionAt: new Date().toISOString(),
                } as IndexOperationReceipt;
                return structuredClone(latestOperation);
            },
            getLatestOperation(): IndexOperationReceipt | undefined {
                return latestOperation ? structuredClone(latestOperation) : undefined;
            },
            saveCodebaseSnapshot(): boolean {
                if (latestOperation) {
                    persistedPhases.push(latestOperation.phase);
                }
                return true;
            },
        },
    };
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
            message: [
                'Index mutation is blocked: this runtime pid=111 satori@4.11.14 conflicts with 1 other live Satori MCP runtime(s).',
                'Conflicting owners: pid=4242 satori@4.10.0 differs on Satori package version.',
                'MCP tools do not kill processes.',
                'Stop those clients (or only if they are orphaned Satori MCP servers: kill 4242), leave a single Satori version/config running, then retry create/reindex/sync/clear.',
            ].join(' '),
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

function createMutationReadyHandlers(
    repoPath: string,
    gate: RuntimeOwnerMutationGate,
    counters: MutationCounters,
    mutationLeaseCoordinator?: MutationLeaseCoordinator,
): ToolHandlers {
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
        gate,
        mutationLeaseCoordinator,
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
        assert.match(envelope.humanText, /conflicts with|multiple Satori runtimes|blocked/i);
        assert.match(envelope.humanText, /pid=4242/);
        assert.match(envelope.humanText, /satori@4\.10\.0/);
        assert.equal((envelope.hints?.runtimeOwners as RuntimeOwnerHint | undefined)?.[0]?.pid, 4242);
        assert.match(String(envelope.hints?.nextStep), /Stop conflicting Satori MCP process|pid=4242/i);
        assert.equal(Array.isArray(envelope.hints?.nextSteps), true);
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

test('handleClearIndex blocks before destructive clear when another process holds the root lease', async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), 'lease-state');
        const processes = new Map([
            [101, { pid: 101, processStartTime: 'first' }],
            [202, { pid: 202, processStartTime: 'second' }],
        ]);
        const processInspector = {
            inspect(pid: number) {
                return processes.get(pid) ?? null;
            },
        };
        const owner = new MutationLeaseCoordinator({
            stateDir,
            ownerId: 'first-owner',
            currentProcess: processes.get(101),
            processInspector,
        });
        const contender = new MutationLeaseCoordinator({
            stateDir,
            ownerId: 'second-owner',
            currentProcess: processes.get(202),
            processInspector,
        });
        assert.equal(owner.acquire(repoPath, 'create').acquired, true);

        const counters: MutationCounters = {};
        const gate: RuntimeOwnerMutationGate = { checkMutation: () => ({ blocked: false }) };
        const handlers = createMutationReadyHandlers(repoPath, gate, counters, contender);
        const envelope = parseManageEnvelope(await handlers.handleClearIndex({ path: repoPath }));

        assert.equal(envelope.status, 'blocked');
        assert.equal(envelope.reason, 'mutation_in_progress');
        assert.equal(envelope.operation, undefined);
        assert.equal((envelope.hints?.activeMutation as { ownerId?: string } | undefined)?.ownerId, 'first-owner');
        assert.equal(counters.clearIndexCalls ?? 0, 0);
        assert.equal(envelope.operation, undefined);
    });
});

test('handleClearIndex persists one clear receipt before clearing and keeps it after lifecycle removal', async () => {
    await withTempRepo(async (repoPath) => {
        let currentInfo: IndexingInfo | IndexedInfo | undefined = {
            status: 'indexing',
            indexingPercentage: 98,
            lastUpdated: '2026-02-27T23:57:03.000Z',
        };
        const receipts = createReceiptHarness();
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'clear-receipt-leases'),
            ownerId: 'clear-receipt-owner',
        });
        let clearCalls = 0;

        const context = {
            getIndexCompletionMarker: async () => ({
                kind: 'satori_index_completion_v1',
                codebasePath: repoPath,
                fingerprint: RUNTIME_FINGERPRINT,
                indexedFiles: 1,
                totalChunks: 2,
                completedAt: '2026-02-27T23:57:10.000Z',
                runId: 'clear-recovery-run',
            }),
            clearIndex: async () => {
                assert.ok(receipts.persistedPhases.includes('accepted'));
                assert.equal(receipts.latestOperation?.action, 'clear');
                clearCalls += 1;
            },
            resolveCollectionName: () => 'test_collection',
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => currentInfo ? [{ path: repoPath, info: currentInfo }] : [],
            getIndexingCodebases: () => currentInfo?.status === 'indexing' ? [repoPath] : [],
            getIndexedCodebases: () => currentInfo?.status === 'indexed' ? [repoPath] : [],
            getCodebaseStatus: () => currentInfo?.status ?? 'not_found',
            getCodebaseInfo: () => currentInfo,
            getIndexingProgress: () => currentInfo?.status === 'indexing' ? currentInfo.indexingPercentage : undefined,
            setCodebaseIndexed: (_path: string, stats: { indexedFiles: number; totalChunks: number }, indexFingerprint: IndexFingerprint) => {
                currentInfo = {
                    status: 'indexed',
                    indexedFiles: stats.indexedFiles,
                    totalChunks: stats.totalChunks,
                    indexStatus: 'completed',
                    indexFingerprint,
                    fingerprintSource: 'verified',
                    lastUpdated: new Date().toISOString(),
                };
            },
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            markCodebaseCleared: () => { currentInfo = undefined; },
            ...receipts.snapshotMethods,
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            getWatchDebounceMs: () => 2000,
            unwatchCodebase: async () => undefined,
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            null,
            coordinator,
        );

        const clearEnvelope = parseManageEnvelope(await handlers.handleClearIndex({ path: repoPath }));
        assert.equal(clearCalls, 1);
        assert.equal(receipts.startCalls, 1);
        assert.deepEqual(receipts.persistedPhases, ['accepted', 'accepted', 'writing', 'completed']);
        assert.equal(clearEnvelope.status, 'ok');
        assert.equal(clearEnvelope.operation?.action, 'clear');
        assert.equal(clearEnvelope.operation?.phase, 'completed');

        const statusEnvelope = parseManageEnvelope(await handlers.handleGetIndexingStatus({ path: repoPath }));
        assert.equal(statusEnvelope.status, 'not_indexed');
        assert.deepEqual(statusEnvelope.operation, clearEnvelope.operation);
    });
});

test('handleClearIndex returns a failed receipt when the destructive clear fails', async () => {
    await withTempRepo(async (repoPath) => {
        const receipts = createReceiptHarness();
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'clear-failure-receipt-leases'),
            ownerId: 'clear-failure-owner',
        });
        const info: IndexedInfo = {
            status: 'indexed',
            indexedFiles: 1,
            totalChunks: 2,
            indexStatus: 'completed',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified',
            lastUpdated: new Date().toISOString(),
        };
        const context = {
            clearIndex: async () => { throw new Error('clear failed'); },
            resolveCollectionName: () => 'test_collection',
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => info,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            ...receipts.snapshotMethods,
        } as unknown as HandlerSnapshotManager;
        const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            null,
            coordinator,
        );

        const envelope = parseManageEnvelope(await handlers.handleClearIndex({ path: repoPath }));
        assert.equal(envelope.status, 'error');
        assert.equal(envelope.operation?.action, 'clear');
        assert.equal(envelope.operation?.phase, 'failed');
        assert.deepEqual(receipts.persistedPhases, ['accepted', 'writing', 'failed']);
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

// FLC-08: limit_reached is searchable-with-warnings, not "fully indexed".
test('handleGetIndexingStatus reports partial limit_reached instead of fully indexed', async () => {
    await withTempRepo(async (repoPath) => {
        const info = {
            status: 'indexed' as const,
            indexedFiles: 12,
            totalChunks: 450000,
            indexStatus: 'limit_reached' as const,
            lastUpdated: '2026-02-28T08:00:00.000Z',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified' as const,
        };
        const context = {
            getIndexCompletionMarker: async () => ({
                kind: 'satori_index_completion_v1',
                codebasePath: repoPath,
                fingerprint: RUNTIME_FINGERPRINT,
                indexedFiles: 12,
                totalChunks: 450000,
                completedAt: '2026-02-28T08:00:00.000Z',
                runId: 'partial-run',
            }),
            getVectorStore: () => ({
                hasCollection: async () => true,
            }),
            resolveCollectionName: () => 'hybrid_code_chunks_test',
            hasIndexedCollection: async () => true,
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => info,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined,
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            getWatchDebounceMs: () => 2000,
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'status');
        assert.equal(envelope.status, 'ok');
        assert.match(envelope.humanText, /partially indexed \(limit_reached\)/i);
        assert.match(envelope.humanText, /file_outline\/call_graph are unavailable/i);
        assert.doesNotMatch(envelope.humanText, /fully indexed and ready for search/i);
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
        const receipts = createReceiptHarness();
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'stale-recovery-receipt-leases'),
            ownerId: 'stale-recovery-owner',
        });

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
            ...receipts.snapshotMethods,
        } as unknown as HandlerSnapshotManager;

        const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            null,
            coordinator,
        );

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assert.equal(envelope.status, 'error');
        const text = envelope.humanText;

        assert.equal(markerCalls, 1);
        assert.equal(failedCalls, 1);
        assert.equal(receipts.startCalls, 1);
        assert.deepEqual(receipts.persistedPhases, ['accepted', 'proving', 'failed']);
        assert.equal(envelope.operation?.action, 'repair');
        assert.equal(envelope.operation?.phase, 'failed');
        assert.match(text, /indexing failed/i);
        assert.match(text, /Interrupted indexing detected without completion marker proof/i);
    });
});

test('handleGetIndexingStatus does not recover stale indexing state owned by a live writer', async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), 'mutation-leases');
        const activeOwner = new MutationLeaseCoordinator({ stateDir, ownerId: 'active-owner' });
        const statusCoordinator = new MutationLeaseCoordinator({ stateDir, ownerId: 'status-owner' });
        const activeResult = activeOwner.acquire(repoPath, 'create');
        assert.equal(activeResult.acquired, true);
        if (!activeResult.acquired) return;
        let markerCalls = 0;
        let failedCalls = 0;
        let saveCalls = 0;
        let startOperationCalls = 0;

        try {
            const currentInfo: IndexingInfo = {
                status: 'indexing',
                indexingPercentage: 98,
                lastUpdated: '2026-02-27T23:57:03.000Z'
            };
            const context = {
                getIndexCompletionMarker: async () => {
                    markerCalls += 1;
                    return null;
                }
            } as unknown as HandlerContext;
            const snapshotManager = {
                getAllCodebases: () => [{ path: repoPath, info: currentInfo }],
                getIndexingCodebases: () => [repoPath],
                getIndexedCodebases: () => [],
                getCodebaseStatus: () => 'indexing',
                getCodebaseInfo: () => currentInfo,
                getIndexingProgress: () => currentInfo.indexingPercentage,
                setCodebaseIndexFailed: () => { failedCalls += 1; },
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
                startOperation: () => {
                    startOperationCalls += 1;
                    throw new Error('contended recovery must not start a receipt');
                },
                getLatestOperation: () => undefined,
                saveCodebaseSnapshot: () => { saveCalls += 1; }
            } as unknown as HandlerSnapshotManager;
            const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
            const handlers = new ToolHandlers(
                context,
                snapshotManager,
                syncManager,
                RUNTIME_FINGERPRINT,
                CAPABILITIES,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                null,
                statusCoordinator,
            );

            const envelope = parseManageEnvelope(await handlers.handleGetIndexingStatus({ path: repoPath }));
            assert.equal(envelope.status, 'not_ready');
            assert.equal(envelope.reason, 'indexing');
            assert.equal(markerCalls, 0);
            assert.equal(failedCalls, 0);
            assert.equal(saveCalls, 0);
            assert.equal(startOperationCalls, 0);
            assert.equal(envelope.operation, undefined);
            assert.deepEqual(envelope.hints?.activeMutation, activeResult.lease);
            assert.match(envelope.humanText, /Active mutation: create/);
        } finally {
            activeOwner.release(activeResult.lease);
        }
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
        const receipts = createReceiptHarness();
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'stale-promotion-receipt-leases'),
            ownerId: 'stale-promotion-owner',
        });

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
            ...receipts.snapshotMethods,
        } as unknown as HandlerSnapshotManager;

        const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            null,
            coordinator,
        );

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.status, 'requires_reindex');
        assert.equal(envelope.reason, 'requires_reindex');
        assert.equal(markerCalls, 1);
        assert.equal(setIndexedCalls, 1);
        assert.equal(receipts.startCalls, 1);
        assert.deepEqual(receipts.persistedPhases, ['accepted', 'proving', 'publishing', 'completed']);
        assert.equal(envelope.operation?.action, 'repair');
        assert.equal(envelope.operation?.phase, 'completed');
        assert.match(envelope.humanText || '', /restart Satori with VoyageAI\/voyage-code-3\/1024\/Milvus\/hybrid_v3/i);
        assert.equal((envelope.hints?.runtimeMismatch as RuntimeMismatchHint | undefined)?.indexedFingerprint, 'VoyageAI/voyage-code-3/1024/Milvus/hybrid_v3/parser=legacy/extractor=legacy/relationship=legacy');
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

test('exclusive create lease supersedes recent abandoned indexing without waiting for grace', async () => {
    await withTempRepo(async (repoPath) => {
        const recent = new Date().toISOString();
        let markerCalls = 0;
        let failedCalls = 0;
        let currentInfo: IndexingInfo | IndexFailedInfo = {
            status: 'indexing',
            indexingPercentage: 37,
            lastUpdated: recent,
        };
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'exclusive-create-recovery-leases'),
            ownerId: 'exclusive-create-owner',
        });
        const context = {
            getIndexCompletionMarker: async () => {
                markerCalls += 1;
                return null;
            },
            getCollectionList: async () => [],
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
                    lastUpdated: new Date().toISOString(),
                };
            },
            setCodebaseIndexing: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => true,
            startOperation: () => undefined,
            transitionOperation: () => undefined,
            commitOperationPhase: (
                _lease: RootMutationLease,
                _phase: IndexOperationPhase,
                mutateSnapshot?: () => void,
            ) => {
                mutateSnapshot?.();
                return undefined;
            },
            getLatestOperation: () => undefined,
        } as unknown as HandlerSnapshotManager;
        const syncManager = { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            null,
            coordinator,
        );

        // After exclusive acquisition, recovery must run immediately (not wait 2 minutes).
        // Kickoff may still fail later for other reasons; prove recovery side effects here.
        await handlers.handleIndexCodebase({ path: repoPath });
        assert.ok(markerCalls >= 1);
        assert.equal(failedCalls, 1);
        assert.equal(currentInfo.status, 'indexfailed');
    });
});

test('startup recovery skips live writers and does not unfence lifecycle publication', async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), 'startup-recovery-leases');
        const activeOwner = new MutationLeaseCoordinator({ stateDir, ownerId: 'live-writer' });
        const startupOwner = new MutationLeaseCoordinator({ stateDir, ownerId: 'startup-owner' });
        const active = activeOwner.acquire(repoPath, 'create');
        assert.equal(active.acquired, true);
        if (!active.acquired) {
            return;
        }
        let markerCalls = 0;
        let failedCalls = 0;
        let saveCalls = 0;
        const currentInfo: IndexingInfo = {
            status: 'indexing',
            indexingPercentage: 50,
            lastUpdated: '2026-02-27T23:57:03.000Z',
        };
        try {
            const context = {
                getIndexCompletionMarker: async () => {
                    markerCalls += 1;
                    return null;
                },
            } as unknown as HandlerContext;
            const snapshotManager = {
                getAllCodebases: () => [{ path: repoPath, info: currentInfo }],
                getIndexingCodebases: () => [repoPath],
                getIndexedCodebases: () => [],
                getCodebaseStatus: () => 'indexing',
                getCodebaseInfo: () => currentInfo,
                getIndexingProgress: () => currentInfo.indexingPercentage,
                setCodebaseIndexFailed: () => { failedCalls += 1; },
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
                saveCodebaseSnapshot: () => { saveCalls += 1; return true; },
            } as unknown as HandlerSnapshotManager;
            const handlers = new ToolHandlers(
                context,
                snapshotManager,
                { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager,
                RUNTIME_FINGERPRINT,
                CAPABILITIES,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                null,
                startupOwner,
            );

            await handlers.recoverInterruptedIndexingAtStartup();
            assert.equal(markerCalls, 0);
            assert.equal(failedCalls, 0);
            assert.equal(saveCalls, 0);
            assert.equal(currentInfo.status, 'indexing');
        } finally {
            activeOwner.release(active.lease);
        }
    });
});

test('startup recovery fences abandoned indexing when no live writer holds the lease', async () => {
    await withTempRepo(async (repoPath) => {
        const receiptHarness = createReceiptHarness();
        let markerCalls = 0;
        let failedCalls = 0;
        let currentInfo: IndexingInfo | IndexFailedInfo = {
            status: 'indexing',
            indexingPercentage: 12,
            lastUpdated: new Date().toISOString(),
        };
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'startup-fenced-recovery-leases'),
            ownerId: 'startup-recovery-owner',
        });
        const context = {
            getIndexCompletionMarker: async () => {
                markerCalls += 1;
                return null;
            },
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
                    lastUpdated: new Date().toISOString(),
                };
            },
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            ...receiptHarness.snapshotMethods,
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            { getWatchDebounceMs: () => 2000 } as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            null,
            coordinator,
        );

        await handlers.recoverInterruptedIndexingAtStartup();
        assert.equal(markerCalls, 1);
        assert.equal(failedCalls, 1);
        assert.equal(currentInfo.status, 'indexfailed');
        assert.equal(coordinator.getActiveLease(repoPath), undefined);
        assert.equal(receiptHarness.startCalls, 1);
        assert.deepEqual(receiptHarness.persistedPhases, ['accepted', 'proving', 'failed']);
        assert.equal(receiptHarness.latestOperation?.action, 'repair');
        assert.equal(receiptHarness.latestOperation?.phase, 'failed');
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
        assert.deepEqual(envelope.syncStats, { added: 1, removed: 0, modified: 1 });
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

test('handleRepairIndex parses, executes, and rebuilds call graph on success', async () => {
    await withTempRepo(async (repoPath) => {
        let rebuildCallGraphCalled = false;

        const context = {
            repairIndex: async (codebasePath: string) => {
                assert.equal(codebasePath, repoPath);
                return {
                    status: 'ok',
                    message: 'readiness repaired',
                    indexedFiles: 5,
                    totalChunks: 10,
                    warnings: [],
                };
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 5,
                totalChunks: 10,
                indexStatus: 'completed',
                lastUpdated: new Date().toISOString()
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined,
            setCodebaseIndexed: () => undefined,
            setCodebaseIndexManifest: () => undefined,
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            getWatchDebounceMs: () => 2000,
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        // Mock rebuildCallGraphForIndex
        (handlers as unknown as ToolHandlersWithManageIndexingHost).manageIndexingHandlers.host.rebuildCallGraphForIndex = async (codebasePath: string) => {
            assert.equal(codebasePath, repoPath);
            rebuildCallGraphCalled = true;
        };

        const response = await handlers.handleRepairIndex({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.status, 'ok');
        assert.equal(envelope.action, 'repair');
        assert.match(envelope.message, /readiness repaired/i);
        assert.ok(rebuildCallGraphCalled);
    });
});

test('handleRepairIndex returns structured proof and reindex action when existing payload coverage fails', async () => {
    await withTempRepo(async (repoPath) => {
        const repairProof = {
            collection: { status: 'matched', basis: 'selected_active_collection' },
            snapshot: { status: 'matched', basis: 'verified_snapshot_fingerprint' },
            marker: { status: 'missing', basis: 'completion_marker_missing' },
            fingerprint: { status: 'matched', basis: 'verified_snapshot_fingerprint' },
            payload: { status: 'failed', expectedCount: 7, observedCount: 4, missingCount: 3 },
            staleRemoteChunks: { status: 'not_checked' },
            navigation: { status: 'not_checked' },
        } as const;
        const context = {
            repairIndex: async () => ({
                status: 'requires_reindex',
                reason: 'requires_reindex',
                message: 'Coverage verification failed',
                missingCount: 3,
                proof: repairProof,
            })
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'stale_local' } }],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [],
            getCodebaseStatus: () => 'stale_local',
            getCodebaseInfo: () => ({
                status: 'stale_local',
                lastUpdated: new Date().toISOString()
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            getWatchDebounceMs: () => 2000,
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleRepairIndex({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        const repairEnvelope = envelope as typeof envelope & {
            repairProof?: typeof repairProof;
        };
        assert.equal(envelope.status, 'requires_reindex');
        assert.equal(envelope.action, 'repair');
        assert.equal(envelope.reason, 'requires_reindex');
        assert.equal(repairEnvelope.repairProof?.payload.missingCount, 3);
        assert.deepEqual(envelope.hints?.nextAction, {
            tool: 'manage_index',
            args: { action: 'reindex', path: repoPath }
        });
    });
});

test('handleRepairIndex recommends create only when collection proof is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const repairProof = {
            collection: { status: 'missing', basis: 'no_related_collection', observedCount: 0 },
            snapshot: { status: 'missing', basis: 'snapshot_fingerprint_missing' },
            marker: { status: 'not_checked' },
            fingerprint: { status: 'not_checked' },
            payload: { status: 'not_checked' },
            staleRemoteChunks: { status: 'not_checked' },
            navigation: { status: 'not_checked' },
        } as const;
        const context = {
            repairIndex: async () => ({
                status: 'blocked',
                reason: 'needs_create',
                message: 'No existing collection found for this codebase family.',
                missingCount: 0,
                proof: repairProof,
            }),
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [],
            getCodebaseStatus: () => 'not_found',
            getCodebaseInfo: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            saveCodebaseSnapshot: () => undefined,
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            getWatchDebounceMs: () => 2000,
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const envelope = parseManageEnvelope(await handlers.handleRepairIndex({ path: repoPath }));

        assert.equal(envelope.status, 'blocked');
        assert.equal(envelope.reason, 'needs_create');
        assert.deepEqual(envelope.hints?.nextAction, {
            tool: 'manage_index',
            args: { action: 'create', path: repoPath },
        });
    });
});
