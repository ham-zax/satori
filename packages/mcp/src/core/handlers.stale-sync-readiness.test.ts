import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import type { IndexFingerprint } from '../config.js';
import {
    MutationLeaseCoordinator,
    type RootMutationLease,
} from './mutation-lease.js';
import type {
    ReadinessPhase,
    TrackedRootReadinessState,
} from './tracked-root-readiness.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    embeddingArtifactDigest: null,
    embeddingNormalizationPolicy: 'provider_output_v1',
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
    parserVersion: 'parser-v1',
    extractorVersion: 'extractor-v1',
    relationshipVersion: 'relationships-v1',
    embeddingProjectionVersion: 'embedding-projection-v1',
    lexicalProjectionVersion: 'lexical-projection-v1',
};

const CAPABILITIES = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
    stateRoot: path.join(os.tmpdir(), 'satori-stale-sync-readiness-capabilities'),
    executionProfile: 'connected',
    networkPolicy: { kind: 'remote-allowed' },
    vectorStoreProvider: 'Milvus',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];

type PrivateHandlers = {
    trackedRootReadiness: {
        prepareTrackedRootForRead(
            absolutePath: string,
            accessMode: 'semantic' | 'navigation',
            onPhase?: (phase: ReadinessPhase, durationMs: number) => void,
            options?: { observePreparedRead?: (root: string) => string | null },
        ): Promise<TrackedRootReadinessState>;
    };
    prepareTrackedRootReadWithObservation(
        absolutePath: string,
        onPhase: (phase: ReadinessPhase, durationMs: number) => void,
        accessMode?: 'semantic' | 'navigation',
    ): Promise<TrackedRootReadinessState>;
};

function withTempRepo<T>(fn: (repoPath: string, stateDir: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-stale-sync-readiness-'));
    const repoPath = path.join(tempDir, 'repo');
    const stateDir = path.join(tempDir, 'mutation-leases');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath, stateDir).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function readyState(repoPath: string): Extract<TrackedRootReadinessState, { state: 'ready' }> {
    return {
        state: 'ready',
        root: {
            path: repoPath,
            info: {
                status: 'sync_completed',
                lastUpdated: '2026-08-15T00:00:00.000Z',
            },
        },
        navigationAuthorityMode: 'canonical_v4',
        vectorReceipt: {
            canonicalRoot: repoPath,
            collectionName: 'col_gen_n',
            marker: {
                kind: 'satori_index_completion_v3',
                codebasePath: repoPath,
                fingerprint: RUNTIME_FINGERPRINT,
                indexedFiles: 1,
                totalChunks: 1,
                completedAt: '2026-08-15T00:00:00.000Z',
                runId: 'run-n',
                indexPolicyHash: 'a'.repeat(64),
                indexStatus: 'completed',
                navigation: { status: 'not_bound' },
            },
        } as never,
        navigationStatus: 'not_bound',
    };
}

function buildHandlers(
    repoPath: string,
    coordinator: MutationLeaseCoordinator,
    lease: RootMutationLease,
    operationAction: 'create' | 'reindex' | 'sync' | 'repair' = 'sync',
): ToolHandlers {
    const snapshotManager = {
        getLatestOperation: () => ({
            id: lease.operationId,
            action: operationAction,
            canonicalRoot: repoPath,
            generation: lease.generation,
            acceptedAt: lease.acquiredAt,
            phase: 'writing',
            lastDurableTransitionAt: lease.acquiredAt,
            runtimeFingerprint: RUNTIME_FINGERPRINT,
            writer: {
                ownerId: lease.ownerId,
                pid: lease.pid,
                satoriVersion: 'test',
            },
        }),
    } as unknown as HandlerSnapshotManager;

    return new ToolHandlers(
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
        coordinator,
    );
}

test('matching active sync lease preserves the proven searchable read for stale-while-sync', async () => {
    await withTempRepo(async (repoPath, stateDir) => {
        const activeOwner = new MutationLeaseCoordinator({ stateDir, ownerId: 'sync-owner' });
        const readerCoordinator = new MutationLeaseCoordinator({ stateDir, ownerId: 'reader-owner' });
        const acquired = activeOwner.acquire(repoPath, 'sync');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        try {
            const handlers = buildHandlers(repoPath, readerCoordinator, acquired.lease);
            const privateHandlers = handlers as unknown as PrivateHandlers;
            const provenRead = readyState(repoPath);
            privateHandlers.trackedRootReadiness = {
                prepareTrackedRootForRead: async () => provenRead,
            };

            const state = await privateHandlers.prepareTrackedRootReadWithObservation(
                repoPath,
                () => undefined,
            );

            assert.equal(state.state, 'indexing');
            if (state.state !== 'indexing') return;
            assert.equal(state.operation?.action, 'sync');
            assert.equal(state.operation?.generation, acquired.lease.generation);
            assert.equal(state.searchableGenerationAvailable, true);
            assert.equal(state.searchableRead, provenRead);
            assert.equal(state.searchableRead?.vectorReceipt?.collectionName, 'col_gen_n');
        } finally {
            activeOwner.release(acquired.lease);
        }
    });
});

test('non-sync active mutation remains fail-closed and does not expose stale searchable proof', async () => {
    await withTempRepo(async (repoPath, stateDir) => {
        const activeOwner = new MutationLeaseCoordinator({ stateDir, ownerId: 'reindex-owner' });
        const readerCoordinator = new MutationLeaseCoordinator({ stateDir, ownerId: 'reader-owner' });
        const acquired = activeOwner.acquire(repoPath, 'reindex');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        try {
            const handlers = buildHandlers(repoPath, readerCoordinator, acquired.lease, 'reindex');
            const privateHandlers = handlers as unknown as PrivateHandlers;
            privateHandlers.trackedRootReadiness = {
                prepareTrackedRootForRead: async () => readyState(repoPath),
            };

            const state = await privateHandlers.prepareTrackedRootReadWithObservation(
                repoPath,
                () => undefined,
            );

            assert.equal(state.state, 'indexing');
            if (state.state !== 'indexing') return;
            assert.equal(state.operation?.action, 'reindex');
            assert.equal(state.searchableRead, undefined);
        } finally {
            activeOwner.release(acquired.lease);
        }
    });
});
