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

test('handleGetIndexingStatus includes active writer evidence on requires_reindex', async () => {
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
            assert.equal(payload.status, 'requires_reindex');
            assert.deepEqual(payload.hints?.activeMutation, activeResult.lease);
            assert.match(payload.humanText, /Active mutation: sync/);
            assert.equal(payload.hints?.activeMutation?.expiresAt, undefined);
        } finally {
            activeOwner.release(activeResult.lease);
        }
    });
});
