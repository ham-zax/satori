import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import { MutationLeaseCoordinator } from './mutation-lease.js';

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
    executionProfile: 'connected',
    networkPolicy: { kind: 'remote-allowed' },
    vectorStoreProvider: 'Milvus',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type StatusPayload = {
    message: string;
    humanText: string;
};

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-status-handler-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

test('handleGetIndexingStatus includes fingerprint diagnostics for requires_reindex status', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedFingerprint: IndexFingerprint = {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-lite',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'dense_v3'
        };

        const context = {} as unknown as HandlerContext;
        const snapshotManager = {
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseStatus: () => 'requires_reindex',
            getCodebaseInfo: () => ({
                status: 'requires_reindex',
                message: 'Legacy fingerprint mismatch.',
                lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                indexFingerprint: indexedFingerprint,
                fingerprintSource: 'verified',
                reindexReason: 'fingerprint_mismatch'
            })
        } as unknown as HandlerSnapshotManager;
        const syncManager = {} as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleGetIndexingStatus({ path: repoPath, detail: 'diagnostics' });
        const text = response.content[0]?.text || '';

        assert.match(text, /restart Satori with VoyageAI\/voyage-4-lite\/1024\/Milvus\/dense_v3/i);
        assert.match(text, /Runtime fingerprint: VoyageAI\/voyage-4-large\/1024\/Milvus\/hybrid_v3/i);
        assert.match(text, /Indexed fingerprint: VoyageAI\/voyage-4-lite\/1024\/Milvus\/dense_v3/i);
        assert.match(text, /Fingerprint source: verified/i);
        assert.match(text, /Reindex reason: fingerprint_mismatch/i);
    });
});

test('handleGetIndexingStatus keeps rich humanText but emits compact machine JSON and message', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedFingerprint: IndexFingerprint = {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-lite',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'dense_v3'
        };

        const context = {} as unknown as HandlerContext;
        const snapshotManager = {
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseStatus: () => 'requires_reindex',
            getCodebaseInfo: () => ({
                status: 'requires_reindex',
                message: 'Legacy fingerprint mismatch.',
                lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                indexFingerprint: indexedFingerprint,
                fingerprintSource: 'verified',
                reindexReason: 'fingerprint_mismatch'
            })
        } as unknown as HandlerSnapshotManager;
        const syncManager = {} as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleGetIndexingStatus({ path: repoPath, detail: 'diagnostics' });
        const rawText = response.content[0]?.text || '';
        const payload = JSON.parse(rawText) as StatusPayload;

        assert.doesNotMatch(rawText, /\n\s+"/);
        assert.equal(payload.message.includes('\n'), false);
        assert.ok(payload.humanText.length > payload.message.length);
        assert.match(payload.message, /Legacy fingerprint mismatch/i);
        assert.doesNotMatch(payload.message, /Runtime fingerprint/i);
        assert.match(payload.humanText, /restart Satori with VoyageAI\/voyage-4-lite\/1024\/Milvus\/dense_v3/i);
        assert.match(payload.humanText, /Runtime fingerprint: VoyageAI\/voyage-4-large\/1024\/Milvus\/hybrid_v3/i);
        assert.match(payload.humanText, /Indexed fingerprint: VoyageAI\/voyage-4-lite\/1024\/Milvus\/dense_v3/i);
    });
});

test('handleGetIndexingStatus includes fingerprint diagnostics when access gate blocks', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedFingerprint: IndexFingerprint = {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-large',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'dense_v3'
        };

        const context = {} as unknown as HandlerContext;
        const snapshotManager = {
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: false,
                changed: false,
                message: 'Legacy v2 index detected.'
            }),
            getCodebaseStatus: () => 'requires_reindex',
            getCodebaseInfo: () => ({
                status: 'requires_reindex',
                message: 'Legacy v2 index detected.',
                lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                indexFingerprint: indexedFingerprint,
                fingerprintSource: 'assumed_v2',
                reindexReason: 'legacy_unverified_fingerprint'
            })
        } as unknown as HandlerSnapshotManager;
        const syncManager = {} as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleGetIndexingStatus({ path: repoPath, detail: 'diagnostics' });
        const text = response.content[0]?.text || '';

        assert.match(text, /Legacy v2 index detected/i);
        assert.match(text, /Runtime fingerprint: VoyageAI\/voyage-4-large\/1024\/Milvus\/hybrid_v3/i);
        assert.match(text, /Indexed fingerprint: VoyageAI\/voyage-4-large\/1024\/Milvus\/dense_v3/i);
        assert.match(text, /Fingerprint source: assumed_v2/i);
        assert.match(text, /Reindex reason: legacy_unverified_fingerprint/i);
    });
});

test('handleGetIndexingStatus prioritizes a live sync lease over previous requires_reindex state', async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), 'mutation-leases');
        const activeOwner = new MutationLeaseCoordinator({ stateDir, ownerId: 'active-owner' });
        const statusCoordinator = new MutationLeaseCoordinator({ stateDir, ownerId: 'status-owner' });
        const activeResult = activeOwner.acquire(repoPath, 'sync');
        assert.equal(activeResult.acquired, true);
        if (!activeResult.acquired) return;

        try {
            const snapshotManager = {
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
                getCodebaseStatus: () => 'requires_reindex',
                getCodebaseInfo: () => ({
                    status: 'requires_reindex',
                    message: 'Legacy fingerprint mismatch.',
                    lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    indexFingerprint: RUNTIME_FINGERPRINT,
                    fingerprintSource: 'verified',
                    reindexReason: 'fingerprint_mismatch'
                })
            } as unknown as HandlerSnapshotManager;
            const handlers = new ToolHandlers(
                {} as unknown as HandlerContext,
                snapshotManager,
                {} as unknown as HandlerSyncManager,
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

            const response = await handlers.handleGetIndexingStatus({ path: repoPath });
            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'not_ready');
            assert.equal(payload.reason, 'indexing');
            assert.deepEqual(payload.hints?.activeMutation, activeResult.lease);
            assert.match(payload.humanText, /being synchronized/i);
            assert.equal(payload.hints?.activeMutation?.expiresAt, undefined);
        } finally {
            activeOwner.release(activeResult.lease);
        }
    });
});

test('handleGetIndexingStatus gates on a live sync lease regardless of operation receipt state', async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), 'live-sync-status-leases');
        const activeOwner = new MutationLeaseCoordinator({ stateDir, ownerId: 'live-sync-owner' });
        const statusCoordinator = new MutationLeaseCoordinator({ stateDir, ownerId: 'status-owner' });
        const activeResult = activeOwner.acquire(repoPath, 'sync');
        assert.equal(activeResult.acquired, true);
        if (!activeResult.acquired) return;

        let markerProbes = 0;
        const matchingOperation = {
            id: activeResult.lease.operationId,
            action: 'sync' as const,
            canonicalRoot: activeResult.lease.canonicalRoot,
            generation: activeResult.lease.generation,
            acceptedAt: activeResult.lease.acquiredAt,
            phase: 'writing' as const,
            lastDurableTransitionAt: activeResult.lease.acquiredAt,
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            writer: {
                ownerId: activeResult.lease.ownerId,
                pid: activeResult.lease.pid,
                satoriVersion: 'test',
            },
        };
        let currentOperation: typeof matchingOperation | undefined = matchingOperation;
        const snapshotManager = {
            getLatestOperation: () => currentOperation,
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 1,
                totalChunks: 1,
                indexStatus: 'completed',
                indexFingerprint: RUNTIME_FINGERPRINT,
                fingerprintSource: 'verified',
            }),
        } as unknown as HandlerSnapshotManager;
        const context = {
            getIndexCompletionMarker: async () => {
                markerProbes += 1;
                throw new Error('withdrawn marker must not be classified during a live sync');
            },
        } as unknown as HandlerContext;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as unknown as HandlerSyncManager,
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

        try {
            for (const receipt of [
                matchingOperation,
                undefined,
                { ...matchingOperation, id: 'stale-operation' },
                { ...matchingOperation, phase: 'completed' as const },
            ]) {
                currentOperation = receipt;
                const response = await handlers.handleGetIndexingStatus({ path: repoPath });
                const payload = JSON.parse(response.content[0]?.text || '{}');
                assert.equal(payload.status, 'not_ready');
                assert.equal(payload.reason, 'indexing');
                assert.deepEqual(payload.hints.activeMutation, activeResult.lease);
                assert.equal(payload.hints.create, undefined);
                assert.match(payload.humanText, /being synchronized/i);
                if (receipt?.id === activeResult.lease.operationId) {
                    assert.equal(payload.operation.phase, receipt.phase);
                } else {
                    assert.equal(payload.operation, undefined);
                }
            }
            assert.equal(markerProbes, 0);
        } finally {
            activeOwner.release(activeResult.lease);
        }
    });
});

test('handleGetIndexingStatus preserves vector readiness while exposing a missing source checkpoint', async () => {
    await withTempRepo(async (repoPath) => {
        const collectionName = 'hybrid_code_chunks_checkpoint_status';
        const info = {
            status: 'indexed' as const,
            indexedFiles: 1,
            totalChunks: 2,
            indexStatus: 'completed' as const,
            lastUpdated: new Date('2026-07-14T00:00:00.000Z').toISOString(),
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified' as const,
        };
        const context = {
            inspectSourceFreshnessCheckpoint: async (_path: string, identity?: string) => {
                assert.equal(identity, collectionName);
                return { status: 'missing' as const, message: 'checkpoint missing' };
            },
        } as unknown as HandlerContext;
        const snapshotManager = {
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => info,
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );
        const access = handlers as unknown as {
            trackedRootReadiness: {
                prepareTrackedRootForRead: (path: string) => Promise<unknown>;
            };
        };
        access.trackedRootReadiness.prepareTrackedRootForRead = async () => ({
            state: 'ready',
            root: { path: repoPath, info },
            vectorReceipt: {
                collectionName,
                marker: {
                    indexStatus: 'completed',
                    runId: 'marker-run-checkpoint-status',
                    indexPolicyHash: 'a'.repeat(64),
                },
                policyDocumentDigest: 'b'.repeat(64),
            },
            navigationStatus: 'valid',
        });

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const payload = JSON.parse(response.content[0]?.text || '{}') as {
            status?: string;
            humanText?: string;
            hints?: Record<string, unknown>;
            publication?: {
                collectionName: string;
                markerRunId: string;
                indexPolicyHash: string;
                policyDocumentDigest: string;
            };
        };

        assert.equal(payload.status, 'ok');
        assert.match(payload.humanText || '', /fully indexed and ready for search/i);
        assert.match(payload.humanText || '', /source freshness checkpoint is missing/i);
        assert.match(payload.humanText || '', /incremental sync is disabled until reindex/i);
        assert.equal((payload.hints?.sourceFreshness as { status?: string } | undefined)?.status, 'missing');
        assert.ok(payload.hints?.reindex);
        assert.equal(payload.hints?.create, undefined);
        assert.deepEqual(payload.publication, {
            collectionName,
            markerRunId: 'marker-run-checkpoint-status',
            indexPolicyHash: 'a'.repeat(64),
            policyDocumentDigest: 'b'.repeat(64),
        });
    });
});
