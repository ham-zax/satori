import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnapshotManager } from './snapshot.js';
import { IndexFingerprint, type IndexOperationReceipt } from '../config.js';
import type { RootMutationLease } from './mutation-lease.js';

type SnapshotPrivateAccess = {
    shouldBreakStaleLock(lockPath: string): boolean;
    sleepSync(ms: number): boolean;
    acquireSnapshotLock(): { fd: number; path: string } | null;
    refreshDerivedState(): void;
    isValidCodebaseInfoShape(value: unknown): boolean;
};
type SnapshotDirtyView = { isDirty: boolean };
type IndexedInfoView = { indexedFiles?: number; ignoreRulesVersion?: number };
type IndexingInfoView = { indexingPercentage?: number };

const FINGERPRINT_A: IndexFingerprint = {
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

const FINGERPRINT_B: IndexFingerprint = {
    embeddingProvider: 'OpenAI',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimension: 1536,
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

test('SnapshotManager rejects invalid lifecycle counts and progress during shape validation', () => {
    const manager = new SnapshotManager(FINGERPRINT_A) as unknown as SnapshotPrivateAccess;
    const lastUpdated = '2026-07-12T00:00:00.000Z';
    const invalid = [
        { status: 'indexing', indexingPercentage: -1, lastUpdated },
        { status: 'indexing', indexingPercentage: 101, lastUpdated },
        { status: 'indexed', indexedFiles: -1, totalChunks: 1, indexStatus: 'completed', lastUpdated },
        { status: 'indexed', indexedFiles: 1.5, totalChunks: 1, indexStatus: 'completed', lastUpdated },
        { status: 'indexed', indexedFiles: 1, totalChunks: Number.MAX_SAFE_INTEGER + 1, indexStatus: 'completed', lastUpdated },
        { status: 'sync_completed', added: 0, removed: -1, modified: 0, totalChanges: 0, lastUpdated },
        { status: 'sync_completed', added: 0, removed: 0, modified: 0.5, totalChanges: 0, lastUpdated },
        { status: 'sync_completed', added: 2, removed: 3, modified: 4, totalChanges: 1, lastUpdated },
    ];

    for (const value of invalid) {
        assert.equal(manager.isValidCodebaseInfoShape(value), false);
    }
    assert.equal(manager.isValidCodebaseInfoShape({
        status: 'indexing',
        indexingPercentage: 42.5,
        lastUpdated,
    }), true);
});

test('setCodebaseSyncCompleted rejects partially supplied or invalid completion proof', () => {
    const manager = new SnapshotManager(FINGERPRINT_A);
    const codebase = '/tmp/satori-partial-sync-proof';
    manager.setCodebaseIndexed(codebase, {
        indexedFiles: 1,
        totalChunks: 2,
        status: 'completed',
    }, FINGERPRINT_A, 'verified', 'collection-a');

    assert.throws(() => manager.setCodebaseSyncCompleted(codebase, {
        added: 0,
        removed: 0,
        modified: 1,
        indexedFiles: -1,
        totalChunks: 3,
        indexStatus: 'completed',
    }), /completion proof/i);
    assert.throws(() => manager.setCodebaseSyncCompleted(codebase, {
        added: 0,
        removed: 0,
        modified: 1,
        indexedFiles: 1,
    }), /completion proof/i);
});

function operationReceipt(
    codebasePath: string,
    generation: number,
    phase: IndexOperationReceipt['phase'] = 'accepted',
): IndexOperationReceipt {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, generation)).toISOString();
    return {
        id: `operation-${generation}`,
        action: 'create',
        canonicalRoot: codebasePath,
        generation,
        acceptedAt: timestamp,
        phase,
        lastDurableTransitionAt: timestamp,
        runtimeFingerprint: FINGERPRINT_A,
        writer: {
            ownerId: 'test-owner',
            pid: process.pid,
            satoriVersion: '4.11.17',
        },
    };
}

function operationLease(codebasePath: string, generation = 1): RootMutationLease {
    const receipt = operationReceipt(codebasePath, generation);
    return {
        canonicalRoot: codebasePath,
        generation,
        operationId: receipt.id,
        action: receipt.action,
        ownerId: receipt.writer.ownerId,
        pid: receipt.writer.pid,
        acquiredAt: receipt.acceptedAt,
    };
}

function withTempHome<T>(fn: (homeDir: string) => T): T {
    const prevHome = process.env.HOME;
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-test-'));
    process.env.HOME = tempHome;
    process.env.SATORI_STATE_ROOT = path.join(tempHome, '.satori');
    try {
        return fn(tempHome);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
}

function snapshotPathsFor(homeDir: string): { dir: string; file: string; lock: string } {
    const dir = path.join(homeDir, '.satori');
    const file = path.join(dir, 'mcp-codebase-snapshot.json');
    const lock = `${file}.lock`;
    return { dir, file, lock };
}

test('SnapshotManager stores its authority under SATORI_STATE_ROOT', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        manager.saveCodebaseSnapshot();

        assert.equal(fs.existsSync(snapshotPathsFor(homeDir).file), true);
    });
});

test('v2 snapshot migrates to v3 and first access hard-blocks assumed_v2 entries', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo');
        fs.mkdirSync(codebase, { recursive: true });

        const snapshotDir = path.join(homeDir, '.satori');
        fs.mkdirSync(snapshotDir, { recursive: true });
        const snapshotFile = path.join(snapshotDir, 'mcp-codebase-snapshot.json');

        fs.writeFileSync(snapshotFile, JSON.stringify({
            formatVersion: 'v2',
            codebases: {
                [codebase]: {
                    status: 'indexed',
                    indexedFiles: 10,
                    totalChunks: 40,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString()
                }
            },
            lastUpdated: new Date().toISOString()
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.loadCodebaseSnapshot();

        const migrated = manager.getCodebaseInfo(codebase);
        assert.ok(migrated);
        assert.equal(migrated?.status, 'indexed');
        assert.equal(migrated?.fingerprintSource, 'assumed_v2');

        const gate = manager.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.changed, true);
        assert.equal(gate.reason, 'legacy_unverified_fingerprint');

        const updated = manager.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'requires_reindex');
    });
});

test('fingerprint mismatch does not persistently downgrade searchable entry', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 12,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_B);
        reader.loadCodebaseSnapshot();

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.changed, false);
        assert.equal(gate.reason, 'fingerprint_mismatch');

        const updated = reader.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'indexed');
    });
});

test('pure fingerprint access gate reports legacy and missing evidence without mutating lifecycle state', () => {
    withTempHome((homeDir) => {
        const legacyCodebase = path.join(homeDir, 'repo-legacy-pure');
        const missingCodebase = path.join(homeDir, 'repo-missing-pure');
        fs.mkdirSync(legacyCodebase, { recursive: true });
        fs.mkdirSync(missingCodebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [legacyCodebase]: {
                    status: 'indexed',
                    indexedFiles: 1,
                    totalChunks: 1,
                    indexStatus: 'completed',
                    fingerprintSource: 'assumed_v2',
                    indexFingerprint: FINGERPRINT_A,
                    lastUpdated: new Date().toISOString(),
                },
                [missingCodebase]: {
                    status: 'indexed',
                    indexedFiles: 1,
                    totalChunks: 1,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString(),
                },
            },
            lastUpdated: new Date().toISOString(),
        }, null, 2));

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const legacyGate = reader.ensureFingerprintCompatibilityOnAccess(legacyCodebase, { mutate: false });
        const missingGate = reader.ensureFingerprintCompatibilityOnAccess(missingCodebase, { mutate: false });

        assert.deepEqual(
            { allowed: legacyGate.allowed, changed: legacyGate.changed, reason: legacyGate.reason },
            { allowed: false, changed: false, reason: 'legacy_unverified_fingerprint' },
        );
        assert.deepEqual(
            { allowed: missingGate.allowed, changed: missingGate.changed, reason: missingGate.reason },
            { allowed: false, changed: false, reason: 'missing_fingerprint' },
        );
        assert.equal(reader.getCodebaseInfo(legacyCodebase)?.status, 'indexed');
        assert.equal(reader.getCodebaseInfo(missingCodebase)?.status, 'indexed');
    });
});

test('snapshot persists committed collection name across indexed and sync states', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-collection-name');
        fs.mkdirSync(codebase, { recursive: true });
        const collectionName = 'hybrid_code_chunks_committed';

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 12,
            status: 'completed'
        }, FINGERPRINT_A, 'verified', collectionName);
        writer.setCodebaseSyncCompleted(codebase, { added: 1, removed: 0, modified: 0 });
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);

        assert.equal(info?.collectionName, collectionName);
        assert.equal(reader.getCodebaseCollectionName(codebase), collectionName);
    });
});

test('fingerprint mismatch remains runtime-local across save/load', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-persisted-mismatch');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 12,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const transitioningReader = new SnapshotManager(FINGERPRINT_B);
        transitioningReader.loadCodebaseSnapshot();
        const transition = transitioningReader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(transition.allowed, false);
        assert.equal(transition.changed, false);
        assert.equal(transition.reason, 'fingerprint_mismatch');
        assert.match(transition.message || '', /Index fingerprint mismatch/);
        transitioningReader.saveCodebaseSnapshot();

        const persistedReader = new SnapshotManager(FINGERPRINT_B);
        persistedReader.loadCodebaseSnapshot();
        const persistedGate = persistedReader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(persistedGate.allowed, false);
        assert.equal(persistedGate.changed, false);
        assert.equal(persistedGate.reason, 'fingerprint_mismatch');
        assert.equal(persistedGate.message, transition.message);

        const persistedInfo = persistedReader.getCodebaseInfo(codebase);
        assert.ok(persistedInfo);
        if (persistedInfo.status !== 'indexed') {
            assert.fail(`Expected indexed, received ${persistedInfo.status}`);
        }
        assert.equal(persistedInfo.reindexReason, undefined);
    });
});

test('matching runtime recovers stale fingerprint-mismatch requires_reindex entry', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-recover-mismatch');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 12,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.setCodebaseRequiresReindex(codebase, 'fingerprint_mismatch', 'Index fingerprint mismatch.');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, true);
        assert.equal(gate.changed, true);

        const recovered = reader.getCodebaseInfo(codebase);
        assert.ok(recovered);
        if (recovered.status !== 'sync_completed') {
            assert.fail(`Expected sync_completed, received ${recovered.status}`);
        }
        assert.equal(recovered.indexFingerprint?.embeddingModel, FINGERPRINT_A.embeddingModel);
        assert.equal(recovered.added, 0);
        assert.equal(recovered.modified, 0);
    });
});

test('pure fingerprint access gate keeps a resolved mismatch blocked for lifecycle recovery', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-resolved-mismatch-pure');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 12,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        writer.setCodebaseRequiresReindex(codebase, 'fingerprint_mismatch', 'Index fingerprint mismatch.');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase, { mutate: false });

        assert.equal(gate.allowed, false);
        assert.equal(gate.changed, false);
        assert.equal(gate.reason, 'fingerprint_mismatch');
        assert.equal(reader.getCodebaseInfo(codebase)?.status, 'requires_reindex');
    });
});

test('navigation recovery failure reason and message persist after save/load', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-navigation-recovery');
        fs.mkdirSync(codebase, { recursive: true });
        const message = 'Navigation recovery failed after ignore-rule reconciliation; full reindex is required.';

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 4,
            totalChunks: 16,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.setCodebaseRequiresReindex(codebase, 'navigation_recovery_failed', message);
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        if (info.status !== 'requires_reindex') {
            assert.fail(`Expected requires_reindex, received ${info.status}`);
        }
        assert.equal(info.reindexReason, 'navigation_recovery_failed');
        assert.equal(info.message, message);

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.changed, false);
        assert.equal(gate.reason, 'navigation_recovery_failed');
        assert.equal(gate.message, message);
    });
});

test('existing requires_reindex reason and custom message persist after save/load', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-existing-reindex');
        fs.mkdirSync(codebase, { recursive: true });
        const message = 'Snapshot was intentionally blocked before process restart.';

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseRequiresReindex(codebase, 'missing_fingerprint', message);
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();

        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        if (info.status !== 'requires_reindex') {
            assert.fail(`Expected requires_reindex, received ${info.status}`);
        }
        assert.equal(info.reindexReason, 'missing_fingerprint');
        assert.equal(info.message, message);

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.changed, false);
        assert.equal(gate.reason, 'missing_fingerprint');
        assert.equal(gate.message, message);
    });
});

test('snapshot merge lets newer searchable recovery replace older requires_reindex', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-recovered');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebase]: {
                    status: 'requires_reindex',
                    reindexReason: 'navigation_recovery_failed',
                    message: 'Older recovery failure.',
                    lastUpdated: '2026-01-01T00:00:00.000Z',
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                }
            },
            lastUpdated: '2026-01-01T00:00:00.000Z'
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 4,
            totalChunks: 12,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        manager.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info.status, 'indexed');
    });
});

test('snapshot merge lets newer requires_reindex replace older searchable state', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-blocked');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebase]: {
                    status: 'indexed',
                    indexedFiles: 3,
                    totalChunks: 9,
                    indexStatus: 'completed',
                    lastUpdated: '2026-01-01T00:00:00.000Z',
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                }
            },
            lastUpdated: '2026-01-01T00:00:00.000Z'
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseRequiresReindex(
            codebase,
            'navigation_recovery_failed',
            'Newer recovery failure.'
        );
        manager.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info.status, 'requires_reindex');
        if (info.status === 'requires_reindex') {
            assert.equal(info.reindexReason, 'navigation_recovery_failed');
        }
    });
});

test('v3 snapshot load preserves missing tracked paths for cleanup', () => {
    withTempHome((homeDir) => {
        const missingCodebase = path.join(homeDir, 'repo-deleted-before-clear');
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [missingCodebase]: {
                    status: 'indexed',
                    indexedFiles: 2,
                    totalChunks: 6,
                    indexStatus: 'completed',
                    lastUpdated: '2026-01-01T00:00:00.000Z',
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                }
            },
            lastUpdated: '2026-01-01T00:00:00.000Z'
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.loadCodebaseSnapshot();

        const info = manager.getCodebaseInfo(missingCodebase);
        assert.ok(info);
        assert.equal(info.status, 'indexed');
        assert.deepEqual(manager.getIndexedCodebases(), [missingCodebase]);

        manager.removeCodebaseCompletely(missingCodebase);
        manager.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseInfo(missingCodebase), undefined);
        assert.deepEqual(reader.getIndexedCodebases(), []);
    });
});

test('missing fingerprint reason and message persist after transition save/load', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-missing-fingerprint');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebase]: {
                    status: 'indexed',
                    indexedFiles: 3,
                    totalChunks: 9,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString()
                }
            },
            lastUpdated: new Date().toISOString()
        }, null, 2));

        const transitioningReader = new SnapshotManager(FINGERPRINT_A);
        transitioningReader.loadCodebaseSnapshot();
        const transition = transitioningReader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(transition.allowed, false);
        assert.equal(transition.changed, true);
        assert.equal(transition.reason, 'missing_fingerprint');
        assert.match(transition.message || '', /no fingerprint metadata/);
        transitioningReader.saveCodebaseSnapshot();

        const persistedReader = new SnapshotManager(FINGERPRINT_A);
        persistedReader.loadCodebaseSnapshot();
        const persistedGate = persistedReader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(persistedGate.allowed, false);
        assert.equal(persistedGate.changed, false);
        assert.equal(persistedGate.reason, 'missing_fingerprint');
        assert.equal(persistedGate.message, transition.message);

        const info = persistedReader.getCodebaseInfo(codebase);
        assert.ok(info);
        if (info.status !== 'requires_reindex') {
            assert.fail(`Expected requires_reindex, received ${info.status}`);
        }
        assert.equal(info.reindexReason, 'missing_fingerprint');
        assert.equal(info.message, transition.message);
    });
});

test('limit_reached index status persists after save/load', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-limit-reached');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 25,
            totalChunks: 100,
            status: 'limit_reached'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        if (info.status !== 'indexed') {
            assert.fail(`Expected indexed, received ${info.status}`);
        }
        assert.equal(info.indexStatus, 'limit_reached');
        assert.equal(info.indexedFiles, 25);
        assert.equal(info.totalChunks, 100);

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, true);
        assert.equal(gate.changed, false);
    });
});

test('legacy schemaVersion v2 fingerprint mismatch stays runtime-local under v3 runtime', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo');
        fs.mkdirSync(codebase, { recursive: true });

        const legacyFingerprint = {
            ...FINGERPRINT_A,
            schemaVersion: 'hybrid_v2'
        } as unknown as IndexFingerprint;

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 5,
            totalChunks: 20,
            status: 'completed'
        }, legacyFingerprint, 'verified');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.changed, false);
        assert.equal(gate.reason, 'fingerprint_mismatch');

        const updated = reader.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'indexed');
    });
});

test('saveCodebaseSnapshot merges persisted snapshot entries to avoid cross-process drops', () => {
    withTempHome((homeDir) => {
        const codebaseA = path.join(homeDir, 'repo-a');
        const codebaseB = path.join(homeDir, 'repo-b');
        fs.mkdirSync(codebaseA, { recursive: true });
        fs.mkdirSync(codebaseB, { recursive: true });

        const managerA = new SnapshotManager(FINGERPRINT_A);
        managerA.setCodebaseIndexed(codebaseA, {
            indexedFiles: 3,
            totalChunks: 8,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        managerA.saveCodebaseSnapshot();

        // Simulate a second process with stale in-memory state.
        const managerB = new SnapshotManager(FINGERPRINT_A);
        managerB.setCodebaseIndexed(codebaseB, {
            indexedFiles: 4,
            totalChunks: 12,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        managerB.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const all = reader.getAllCodebases().map((entry) => entry.path).sort();
        assert.deepEqual(all, [codebaseA, codebaseB].sort());
    });
});

test('latest operation receipt persists without requiring a codebase lifecycle entry', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-only');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        const receipt = operationReceipt(codebase, 1);
        writer.setLatestOperation(codebase, receipt);
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.deepEqual(reader.getLatestOperation(codebase), receipt);
        assert.equal(reader.getCodebaseInfo(codebase), undefined);
    });
});

test('durable operation observation bypasses a stale process cache and validates runtime identity', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-observation');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setLatestOperation(codebase, operationReceipt(codebase, 1, 'writing'));
        assert.equal(writer.saveCodebaseSnapshot(), true);

        const staleReader = new SnapshotManager(FINGERPRINT_A);
        staleReader.loadCodebaseSnapshot();
        assert.equal(staleReader.getLatestOperation(codebase)?.phase, 'writing');

        writer.setLatestOperation(codebase, operationReceipt(codebase, 1, 'completed'));
        assert.equal(writer.saveCodebaseSnapshot(), true);

        assert.equal(staleReader.getLatestOperation(codebase)?.phase, 'writing');
        const completed = staleReader.observeDurableLatestOperation(codebase);
        assert.equal(completed?.phase, 'completed');
        assert.equal(
            staleReader.operationMatchesRuntimeFingerprint(completed!),
            true,
        );
        assert.equal(
            staleReader.operationMatchesRuntimeFingerprint({
                ...completed!,
                runtimeFingerprint: FINGERPRINT_B,
            }),
            false,
        );
    });
});

test('operation transitions reject phase regression and terminal rewrites', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-transitions');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        const lease = operationLease(codebase);

        manager.startOperation(lease);
        manager.transitionOperation(lease, 'writing');
        assert.throws(() => manager.transitionOperation(lease, 'scanning'), /cannot regress/);
        manager.transitionOperation(lease, 'completed');
        assert.throws(() => manager.transitionOperation(lease, 'failed'), /already terminal/);
        assert.equal(manager.transitionOperation(lease, 'completed').phase, 'completed');
    });
});

test('failed operation commit rolls back the receipt and lifecycle mutation', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-rollback');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        assert.equal(manager.saveCodebaseSnapshot(), true);

        const lease = operationLease(codebase);
        const originalSave = manager.saveCodebaseSnapshot.bind(manager);
        manager.saveCodebaseSnapshot = () => false;
        assert.throws(() => manager.commitOperationPhase(lease, 'accepted', () => {
            manager.setCodebaseIndexing(codebase, 0);
        }), /Failed to persist operation phase 'accepted'/);
        manager.saveCodebaseSnapshot = originalSave;

        assert.equal(manager.getCodebaseStatus(codebase), 'indexed');
        assert.equal(manager.getLatestOperation(codebase), undefined);
        assert.equal(manager.saveCodebaseSnapshot(), true);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseStatus(codebase), 'indexed');
        assert.equal(reader.getLatestOperation(codebase), undefined);
    });
});

test('failed lifecycle mutation commit rolls back state before a later save', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-lifecycle-rollback');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexing(codebase, 42);
        assert.equal(manager.saveCodebaseSnapshot(), true);

        const originalSave = manager.saveCodebaseSnapshot.bind(manager);
        manager.saveCodebaseSnapshot = () => false;
        assert.equal(manager.commitCodebaseLifecycleMutation(() => {
            manager.setCodebaseIndexFailed(codebase, 'recovery rejected', 42);
        }), false);
        manager.saveCodebaseSnapshot = originalSave;

        assert.equal(manager.getCodebaseStatus(codebase), 'indexing');
        assert.equal(manager.getIndexingProgress(codebase), 42);
        assert.equal(manager.saveCodebaseSnapshot(), true);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseStatus(codebase), 'indexing');
        assert.equal(reader.getIndexingProgress(codebase), 42);
    });
});

test('lifecycle mutation commit rolls back when the final fence rejects publication', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-lifecycle-fence-rollback');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexing(codebase, 17);
        assert.equal(manager.saveCodebaseSnapshot(), true);
        let checks = 0;

        assert.throws(() => manager.commitCodebaseLifecycleMutation(() => {
            manager.setCodebaseIndexFailed(codebase, 'lease lost', 17);
        }, () => {
            checks += 1;
            if (checks === 2) {
                throw new Error('lease lost before lifecycle publication');
            }
        }), /lease lost before lifecycle publication/);

        assert.equal(checks, 2);
        assert.equal(manager.getCodebaseStatus(codebase), 'indexing');
        assert.equal(manager.getIndexingProgress(codebase), 17);
    });
});

test('operation commit rejects a stale local generation before lifecycle mutation', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-local-authority');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setLatestOperation(codebase, operationReceipt(codebase, 2, 'writing'));
        let mutated = false;

        assert.throws(() => manager.commitOperationPhase(operationLease(codebase, 1), 'accepted', () => {
            mutated = true;
        }), /did not become durable/);

        assert.equal(mutated, false);
        assert.deepEqual(manager.getLatestOperation(codebase), operationReceipt(codebase, 2, 'writing'));
    });
});

test('operation commit rejects when a newer disk generation wins the save merge', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-disk-authority');
        fs.mkdirSync(codebase, { recursive: true });
        const stale = new SnapshotManager(FINGERPRINT_A);
        const current = new SnapshotManager(FINGERPRINT_A);
        current.setLatestOperation(codebase, operationReceipt(codebase, 2, 'writing'));
        assert.equal(current.saveCodebaseSnapshot(), true);

        assert.throws(
            () => stale.commitOperationPhase(operationLease(codebase, 1), 'accepted'),
            /did not become durable/,
        );
        assert.deepEqual(stale.getLatestOperation(codebase), operationReceipt(codebase, 2, 'writing'));
    });
});

test('operation commit rejects when a forward disk phase wins the save merge', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-disk-phase');
        fs.mkdirSync(codebase, { recursive: true });
        const stale = new SnapshotManager(FINGERPRINT_A);
        const current = new SnapshotManager(FINGERPRINT_A);
        current.setLatestOperation(codebase, operationReceipt(codebase, 1, 'writing'));
        assert.equal(current.saveCodebaseSnapshot(), true);

        assert.throws(
            () => stale.commitOperationPhase(operationLease(codebase, 1), 'accepted'),
            /did not become durable/,
        );
        assert.equal(stale.getLatestOperation(codebase)?.phase, 'writing');
    });
});

test('operation commit runs its lease fence again while holding the snapshot lock', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-final-fence');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        const lease = operationLease(codebase);
        let checks = 0;

        assert.throws(() => manager.commitOperationPhase(lease, 'accepted', undefined, () => {
            checks += 1;
            if (checks === 2) {
                throw new Error('lease lost before snapshot publication');
            }
        }), /lease lost before snapshot publication/);

        assert.equal(checks, 2);
        assert.equal(manager.getLatestOperation(codebase), undefined);
        assert.equal(fs.existsSync(snapshotPathsFor(homeDir).file), false);
    });
});

test('snapshot merge prefers higher operation generation over a newer stale timestamp', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-fence');
        fs.mkdirSync(codebase, { recursive: true });

        const staleWriter = new SnapshotManager(FINGERPRINT_A);
        staleWriter.setCodebaseIndexing(codebase, 90);
        staleWriter.setLatestOperation(codebase, {
            ...operationReceipt(codebase, 1),
            lastDurableTransitionAt: '2030-01-01T00:00:00.000Z',
        });

        const currentWriter = new SnapshotManager(FINGERPRINT_A);
        currentWriter.setCodebaseIndexed(codebase, {
            indexedFiles: 4,
            totalChunks: 12,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        currentWriter.setLatestOperation(codebase, operationReceipt(codebase, 2, 'completed'));
        currentWriter.saveCodebaseSnapshot();

        staleWriter.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseInfo(codebase)?.status, 'indexed');
        assert.equal(reader.getLatestOperation(codebase)?.generation, 2);
        assert.equal(reader.getLatestOperation(codebase)?.phase, 'completed');
    });
});

test('snapshot merge keeps forward phase authority and rejects conflicting terminal outcomes', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-operation-phase-fence');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setLatestOperation(codebase, operationReceipt(codebase, 1, 'completed'));
        writer.saveCodebaseSnapshot();

        const stale = new SnapshotManager(FINGERPRINT_A);
        stale.setLatestOperation(codebase, {
            ...operationReceipt(codebase, 1, 'writing'),
            lastDurableTransitionAt: '2030-01-01T00:00:00.000Z',
        });
        assert.equal(stale.saveCodebaseSnapshot(), true);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getLatestOperation(codebase)?.phase, 'completed');

        const conflicting = new SnapshotManager(FINGERPRINT_A);
        conflicting.setLatestOperation(codebase, operationReceipt(codebase, 1, 'failed'));
        assert.equal(conflicting.saveCodebaseSnapshot(), false);
        reader.refreshFromDiskIfChanged();
        assert.equal(reader.getLatestOperation(codebase)?.phase, 'completed');
    });
});

test('stale clear cannot delete lifecycle state owned by a newer operation generation', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-stale-clear');
        fs.mkdirSync(codebase, { recursive: true });

        const staleClearer = new SnapshotManager(FINGERPRINT_A);
        staleClearer.setCodebaseIndexed(codebase, { indexedFiles: 1, totalChunks: 2, status: 'completed' }, FINGERPRINT_A);
        staleClearer.setLatestOperation(codebase, operationReceipt(codebase, 1, 'completed'));
        staleClearer.saveCodebaseSnapshot();

        const currentWriter = new SnapshotManager(FINGERPRINT_A);
        currentWriter.loadCodebaseSnapshot();
        currentWriter.setCodebaseIndexed(codebase, { indexedFiles: 3, totalChunks: 6, status: 'completed' }, FINGERPRINT_A);
        currentWriter.setLatestOperation(codebase, operationReceipt(codebase, 2, 'completed'));
        currentWriter.saveCodebaseSnapshot();

        staleClearer.markCodebaseCleared(codebase, 'stale-collection');
        staleClearer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseInfo(codebase)?.status, 'indexed');
        assert.equal(reader.getLatestOperation(codebase)?.generation, 2);
        assert.equal(reader.isCodebaseCleared(codebase), false);
    });
});

test('stale create cannot remove a clear tombstone owned by a newer generation', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-stale-create');
        fs.mkdirSync(codebase, { recursive: true });

        const staleCreator = new SnapshotManager(FINGERPRINT_A);
        staleCreator.setCodebaseIndexed(codebase, { indexedFiles: 1, totalChunks: 2, status: 'completed' }, FINGERPRINT_A);
        staleCreator.setLatestOperation(codebase, operationReceipt(codebase, 1, 'completed'));
        staleCreator.saveCodebaseSnapshot();

        const currentClearer = new SnapshotManager(FINGERPRINT_A);
        currentClearer.loadCodebaseSnapshot();
        currentClearer.setLatestOperation(codebase, {
            ...operationReceipt(codebase, 2, 'completed'),
            action: 'clear',
        });
        currentClearer.markCodebaseCleared(codebase, 'current-collection');
        currentClearer.saveCodebaseSnapshot();

        staleCreator.setCodebaseIndexed(codebase, { indexedFiles: 9, totalChunks: 18, status: 'completed' }, FINGERPRINT_A);
        staleCreator.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseInfo(codebase), undefined);
        assert.equal(reader.getLatestOperation(codebase)?.generation, 2);
        assert.equal(reader.isCodebaseCleared(codebase, 'current-collection'), true);
    });
});

test('malformed operation refresh preserves prior state and does not rewrite disk', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-malformed-operation');
        fs.mkdirSync(codebase, { recursive: true });
        const { file } = snapshotPathsFor(homeDir);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.setCodebaseIndexed(codebase, { indexedFiles: 1, totalChunks: 2, status: 'completed' }, FINGERPRINT_A);
        reader.setLatestOperation(codebase, operationReceipt(codebase, 1, 'completed'));
        reader.saveCodebaseSnapshot();
        reader.loadCodebaseSnapshot();

        const malformed = JSON.stringify({
            formatVersion: 'v3',
            codebases: {},
            latestOperations: { [codebase]: { generation: 2 } },
            lastUpdated: new Date().toISOString(),
        }, null, 2);
        fs.writeFileSync(file, malformed);

        assert.equal(reader.refreshFromDiskIfChanged(), false);
        assert.equal(reader.getCodebaseInfo(codebase)?.status, 'indexed');
        assert.equal(reader.getLatestOperation(codebase)?.generation, 1);
        assert.equal(fs.readFileSync(file, 'utf8'), malformed);
    });
});

test('malformed persisted operation blocks save without rewriting disk', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-malformed-operation-save');
        fs.mkdirSync(codebase, { recursive: true });
        const { file } = snapshotPathsFor(homeDir);
        const malformed = JSON.stringify({
            formatVersion: 'v3',
            codebases: {},
            latestOperations: { [codebase]: { generation: 2 } },
            lastUpdated: new Date().toISOString(),
        }, null, 2);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, malformed);

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setLatestOperation(codebase, operationReceipt(codebase, 3));
        assert.equal(writer.saveCodebaseSnapshot(), false);
        assert.equal(fs.readFileSync(file, 'utf8'), malformed);
    });
});

test('saveCodebaseSnapshot honors explicit removals via tombstones', () => {
    withTempHome((homeDir) => {
        const codebaseA = path.join(homeDir, 'repo-a');
        fs.mkdirSync(codebaseA, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebaseA, {
            indexedFiles: 5,
            totalChunks: 10,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        // Simulate explicit delete in another process that may not have loaded latest state.
        const remover = new SnapshotManager(FINGERPRINT_A);
        remover.removeCodebaseCompletely(codebaseA);
        remover.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const all = reader.getAllCodebases().map((entry) => entry.path);
        assert.equal(all.includes(codebaseA), false);
    });
});

test('refreshFromDiskIfChanged reloads persisted snapshot entries from another process', () => {
    withTempHome((homeDir) => {
        const codebaseA = path.join(homeDir, 'repo-a');
        const codebaseB = path.join(homeDir, 'repo-b');
        fs.mkdirSync(codebaseA, { recursive: true });
        fs.mkdirSync(codebaseB, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebaseA, {
            indexedFiles: 3,
            totalChunks: 8,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.deepEqual(reader.getAllCodebases().map((entry) => entry.path), [codebaseA]);

        const otherProcess = new SnapshotManager(FINGERPRINT_A);
        otherProcess.loadCodebaseSnapshot();
        otherProcess.setCodebaseRequiresReindex(codebaseB, 'missing_fingerprint', 'other process update');
        otherProcess.saveCodebaseSnapshot();

        const refreshed = reader.refreshFromDiskIfChanged();
        assert.equal(refreshed, true);

        const all = reader.getAllCodebases().map((entry) => entry.path).sort();
        assert.deepEqual(all, [codebaseA, codebaseB].sort());
        assert.equal(reader.getCodebaseInfo(codebaseB)?.status, 'requires_reindex');
    });
});

test('refreshFromDiskIfChanged does not migrate an older snapshot during a read', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-current');
        fs.mkdirSync(codebase, { recursive: true });
        const { file } = snapshotPathsFor(homeDir);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        reader.saveCodebaseSnapshot();
        reader.loadCodebaseSnapshot();

        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v2',
            codebases: {},
            lastUpdated: new Date().toISOString(),
        }, null, 2));

        assert.equal(reader.refreshFromDiskIfChanged(), false);
        assert.equal(reader.getCodebaseInfo(codebase)?.status, 'indexed');
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).formatVersion, 'v2');
        assert.match(reader.getSnapshotCorruptionWarning()?.message || '', /requires current v3 format/);
    });
});

test('refreshFromDiskIfChanged preserves the last valid state when current snapshot is corrupt', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-current');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        reader.saveCodebaseSnapshot();
        reader.loadCodebaseSnapshot();

        fs.writeFileSync(file, '{ corrupt json');

        assert.equal(reader.refreshFromDiskIfChanged(), false);
        assert.equal(reader.getCodebaseInfo(codebase)?.status, 'indexed');
        assert.equal(fs.readFileSync(file, 'utf8'), '{ corrupt json');
        assert.equal(
            fs.readdirSync(dir).some((name) => name.startsWith('mcp-codebase-snapshot.json.corrupt-')),
            false,
        );
        assert.equal(reader.getSnapshotCorruptionWarning()?.quarantinedPath, undefined);
    });
});

test('setCodebaseSyncCompleted respects explicit fingerprintSource override', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-sync');
        fs.mkdirSync(codebase, { recursive: true });

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 2,
            totalChunks: 5,
            status: 'completed'
        }, FINGERPRINT_A, 'assumed_v2');

        manager.setCodebaseSyncCompleted(codebase, {
            added: 1,
            removed: 0,
            modified: 1,
            indexedFiles: 3,
            totalChunks: 7,
            indexStatus: 'completed',
        }, FINGERPRINT_A, 'verified');
        const updated = manager.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'sync_completed');
        assert.equal(updated?.fingerprintSource, 'verified');
        if (updated?.status !== 'sync_completed') {
            assert.fail(`Expected sync_completed, received ${updated?.status}`);
        }
        assert.equal(updated.indexedFiles, 3);
        assert.equal(updated.totalChunks, 7);
        assert.equal(updated.indexStatus, 'completed');
    });
});

test('setIndexedFileCount updates snapshot entry immutably', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-files');
        fs.mkdirSync(codebase, { recursive: true });

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 4,
            totalChunks: 20,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');

        const before = manager.getCodebaseInfo(codebase);
        assert.ok(before);
        assert.equal(before?.status, 'indexed');

        manager.setIndexedFileCount(codebase, 9);
        const after = manager.getCodebaseInfo(codebase);
        assert.ok(after);
        assert.equal(after?.status, 'indexed');
        assert.equal(after?.indexedFiles, 9);
        assert.equal((before as IndexedInfoView).indexedFiles, 4);
        assert.notEqual(before, after);
    });
});

test('stale lock with live pid is not breakable', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
        const staleDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A);
        assert.equal((manager as unknown as SnapshotPrivateAccess).shouldBreakStaleLock(lock), false);
    });
});

test('stale lock with dead pid is breakable', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }));
        const staleDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A);
        assert.equal((manager as unknown as SnapshotPrivateAccess).shouldBreakStaleLock(lock), true);
    });
});

test('metadata-less stale lock is not breakable at normal stale threshold', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, '');
        const staleDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A);
        assert.equal((manager as unknown as SnapshotPrivateAccess).shouldBreakStaleLock(lock), false);
    });
});

test('metadata-less very stale lock is breakable', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, '');
        const staleDate = new Date(Date.now() - 6 * 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A);
        assert.equal((manager as unknown as SnapshotPrivateAccess).shouldBreakStaleLock(lock), true);
    });
});

test('lock retry exits without spin when sleep path is unavailable', () => {
    withTempHome((homeDir) => {
        const { dir, file, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ formatVersion: 'v3', codebases: {}, lastUpdated: new Date().toISOString() }));
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));

        const manager = new SnapshotManager(FINGERPRINT_A) as unknown as SnapshotPrivateAccess;
        let sleepCalls = 0;
        manager.sleepSync = () => {
            sleepCalls += 1;
            return false;
        };

        const lockHandle = manager.acquireSnapshotLock();
        assert.equal(lockHandle, null);
        assert.equal(sleepCalls, 1);
    });
});

test('stale-lock break path exits cleanly when wait path is unavailable', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }));
        const staleDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A) as unknown as SnapshotPrivateAccess;
        let sleepCalls = 0;
        manager.sleepSync = () => {
            sleepCalls += 1;
            return false;
        };

        const lockHandle = manager.acquireSnapshotLock();
        assert.equal(lockHandle, null);
        assert.equal(sleepCalls, 1);
    });
});

test('stale indexing entry does not outrank fresh lower progress indexing state', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-stale-indexing');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });

        const staleTimestamp = new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebase]: {
                    status: 'indexing',
                    indexingPercentage: 80,
                    lastUpdated: staleTimestamp,
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                }
            },
            lastUpdated: staleTimestamp
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexing(codebase, 0);
        manager.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info?.status, 'indexing');
        assert.equal((info as IndexingInfoView).indexingPercentage, 0);
    });
});

test('merge precedence keeps local indexing over newer searchable disk state', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-precedence');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 4,
            totalChunks: 11,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexing(codebase, 80);
        manager.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info?.status, 'indexing');
        assert.equal((info as IndexingInfoView).indexingPercentage, 80);
    });
});

test('stale persisted indexing does not clobber local indexed recovery on save', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-recovery-precedence');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });

        const staleTimestamp = new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebase]: {
                    status: 'indexing',
                    indexingPercentage: 98,
                    lastUpdated: staleTimestamp,
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                }
            },
            lastUpdated: staleTimestamp
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.loadCodebaseSnapshot();
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 10,
            totalChunks: 20,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        manager.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info?.status, 'indexed');
    });
});

test('persisted indexing older than local recovered indexed does not clobber transition before stale cutoff', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-recovery-recent-precedence');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });

        const indexingTimestamp = new Date(Date.now() - (3 * 60 * 1000)).toISOString();
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebase]: {
                    status: 'indexing',
                    indexingPercentage: 98,
                    lastUpdated: indexingTimestamp,
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                }
            },
            lastUpdated: indexingTimestamp
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.loadCodebaseSnapshot();
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 12,
            totalChunks: 30,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        manager.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info?.status, 'indexed');
    });
});

test('malformed indexFingerprint entries are skipped during v3 load', () => {
    withTempHome((homeDir) => {
        const codebaseGood = path.join(homeDir, 'repo-good-fp');
        const codebaseBad = path.join(homeDir, 'repo-bad-fp');
        fs.mkdirSync(codebaseGood, { recursive: true });
        fs.mkdirSync(codebaseBad, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebaseGood]: {
                    status: 'indexed',
                    indexedFiles: 2,
                    totalChunks: 5,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString(),
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                },
                [codebaseBad]: {
                    status: 'indexed',
                    indexedFiles: 3,
                    totalChunks: 7,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString(),
                    indexFingerprint: { embeddingProvider: 'VoyageAI' },
                    fingerprintSource: 'verified'
                }
            },
            lastUpdated: new Date().toISOString()
        }, null, 2));

        const loader = new SnapshotManager(FINGERPRINT_A);
        loader.loadCodebaseSnapshot();
        const all = loader.getAllCodebases().map((entry) => entry.path).sort();
        assert.deepEqual(all, [codebaseGood]);
    });
});

test('save merge path tolerates malformed persisted snapshots that are not v1/v2/v3', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-merge-safe');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(5));

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 2,
            totalChunks: 4,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info?.status, 'indexed');
    });
});

test('loadCodebaseSnapshot does not force-save clean v3 snapshots', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-clean-v3');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 3,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const loader = new SnapshotManager(FINGERPRINT_A);
        loader.saveCodebaseSnapshot = () => {
            throw new Error('unexpected save for clean v3 load');
        };

        loader.loadCodebaseSnapshot();
        const loaded = loader.getCodebaseInfo(codebase);
        assert.ok(loaded);
        assert.equal(loaded?.status, 'indexed');
    });
});

test('loadCodebaseSnapshot triggers persistence for migrated v2 snapshot', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-v2');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v2',
            codebases: {
                [codebase]: {
                    status: 'indexed',
                    indexedFiles: 1,
                    totalChunks: 2,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString()
                }
            },
            lastUpdated: new Date().toISOString()
        }, null, 2));

        const loader = new SnapshotManager(FINGERPRINT_A);
        let persisted = false;
        loader.saveCodebaseSnapshot = (forceWrite = false) => {
            persisted = forceWrite === true;
            return true;
        };
        loader.loadCodebaseSnapshot();
        assert.equal(persisted, true);
    });
});

test('malformed v3 entries are skipped without dropping valid entries', () => {
    withTempHome((homeDir) => {
        const codebaseGood = path.join(homeDir, 'repo-good');
        const codebaseBad = path.join(homeDir, 'repo-bad');
        fs.mkdirSync(codebaseGood, { recursive: true });
        fs.mkdirSync(codebaseBad, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: {
                [codebaseGood]: {
                    status: 'indexed',
                    indexedFiles: 2,
                    totalChunks: 5,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString(),
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified'
                },
                [codebaseBad]: {
                    status: 'indexed',
                    indexedFiles: 'two'
                }
            },
            lastUpdated: new Date().toISOString()
        }, null, 2));

        const loader = new SnapshotManager(FINGERPRINT_A);
        loader.loadCodebaseSnapshot();
        const all = loader.getAllCodebases().map((entry) => entry.path).sort();
        assert.deepEqual(all, [codebaseGood]);
    });
});

test('corrupt snapshot is quarantined for diagnostics', () => {
    withTempHome((homeDir) => {
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, '{ this is invalid json');

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.loadCodebaseSnapshot();
        const files = fs.readdirSync(dir);
        const quarantined = files.some((name) => name.startsWith('mcp-codebase-snapshot.json.corrupt-'));
        assert.equal(quarantined, true);
        assert.equal(manager.getAllCodebases().length, 0);
        assert.equal(typeof manager.getSnapshotCorruptionWarning()?.quarantinedPath, 'string');

        const restarted = new SnapshotManager(FINGERPRINT_A);
        restarted.loadCodebaseSnapshot();
        assert.equal(typeof restarted.getSnapshotCorruptionWarning()?.quarantinedPath, 'string');
    });
});

test('corrupt snapshot reload preserves loaded runtime state and can save it back', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-preserved');
        fs.mkdirSync(codebase, { recursive: true });
        const { file } = snapshotPathsFor(homeDir);

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 2,
            totalChunks: 5,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        manager.saveCodebaseSnapshot();

        fs.writeFileSync(file, '{ this is invalid json');
        manager.loadCodebaseSnapshot();

        assert.equal(manager.getAllCodebases().length, 1);
        assert.equal(manager.getCodebaseInfo(codebase)?.status, 'indexed');
        assert.equal(typeof manager.getSnapshotCorruptionWarning()?.quarantinedPath, 'string');

        manager.saveCodebaseSnapshot();
        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();

        assert.equal(reader.getCodebaseInfo(codebase)?.status, 'indexed');
        assert.equal(reader.getSnapshotCorruptionWarning(), undefined);
    });
});

test('metadata-only setters skip derived-state refresh and keep derived fields', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-meta');
        fs.mkdirSync(codebase, { recursive: true });

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 6,
            totalChunks: 15,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');

        let refreshCalls = 0;
        (manager as unknown as SnapshotPrivateAccess).refreshDerivedState = () => {
            refreshCalls += 1;
        };

        manager.setCodebaseCallGraphSidecar(codebase, {
            version: 'v3',
            sidecarPath: '/tmp/sidecar',
            builtAt: new Date().toISOString(),
            nodeCount: 1,
            edgeCount: 1,
            noteCount: 0,
            fingerprint: FINGERPRINT_A
        });
        manager.setCodebaseIndexManifest(codebase, ['src/a.ts']);
        manager.setCodebaseIgnoreRulesVersion(codebase, 2);
        manager.setCodebaseIgnoreControlSignature(codebase, 'sig');

        const info = manager.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info?.status, 'indexed');
        assert.equal((info as IndexedInfoView).indexedFiles, 6);
        assert.equal(refreshCalls, 0);
    });
});

test('metadata-only changes are persisted on next save without changing indexed membership', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-meta-persist');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 9,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        const beforeIndexed = writer.getIndexedCodebases();

        writer.setCodebaseIgnoreControlSignature(codebase, 'sig-v1');
        writer.setCodebaseIndexManifest(codebase, ['src/main.ts']);
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const afterIndexed = reader.getIndexedCodebases();
        assert.deepEqual(afterIndexed, beforeIndexed);

        const info = reader.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal(info?.ignoreControlSignature, 'sig-v1');
        assert.deepEqual(info?.indexManifest?.indexedPaths, ['src/main.ts']);
    });
});

test('clear tombstones persist and are removed when codebase is indexed again', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-tombstone');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.markCodebaseCleared(codebase, 'hybrid_code_chunks_deadbeef');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.isCodebaseCleared(codebase), true);

        reader.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        assert.equal(reader.isCodebaseCleared(codebase), false);
    });
});

test('markCodebaseCleared removes existing codebase entry and scopes tombstone to collection', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-cleared-entry');
        fs.mkdirSync(codebase, { recursive: true });

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');

        manager.markCodebaseCleared(codebase, 'hybrid_code_chunks_deadbeef');

        assert.equal(manager.getCodebaseInfo(codebase), undefined);
        assert.equal(manager.getCodebaseCollectionName(codebase), undefined);
        assert.equal(manager.isCodebaseCleared(codebase, 'hybrid_code_chunks_deadbeef'), true);
        assert.equal(manager.isCodebaseCleared(codebase, 'hybrid_code_chunks_newvalid'), false);

        manager.saveCodebaseSnapshot();
        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseCollectionName(codebase), undefined);
    });
});

test('negative ignore rules version is rejected', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-ignore');
        fs.mkdirSync(codebase, { recursive: true });

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 2,
            totalChunks: 4,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        manager.setCodebaseIgnoreRulesVersion(codebase, 3);
        manager.setCodebaseIgnoreRulesVersion(codebase, -1);

        const info = manager.getCodebaseInfo(codebase);
        assert.ok(info);
        assert.equal((info as IndexedInfoView).ignoreRulesVersion, 3);
    });
});

test('dirty flag remains true when save is skipped due to lock contention', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-dirty');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        (manager as unknown as SnapshotPrivateAccess).sleepSync = () => false;
        manager.saveCodebaseSnapshot();
        assert.equal((manager as unknown as SnapshotDirtyView).isDirty, true);
    });
});

test('commitCodebaseCallGraphSidecar fences with beforeCommit and rolls back on fence failure', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-call-graph-fence');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 2,
            totalChunks: 4,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        manager.saveCodebaseSnapshot();

        const previous = manager.getCodebaseInfo(codebase)?.callGraphSidecar;
        const nextSidecar = {
            version: 'v3' as const,
            sidecarPath: path.join(homeDir, 'call-graph.json'),
            builtAt: new Date().toISOString(),
            nodeCount: 3,
            edgeCount: 1,
            noteCount: 0,
            fingerprint: FINGERPRINT_A,
        };

        assert.throws(
            () => manager.commitCodebaseCallGraphSidecar(codebase, nextSidecar, () => {
                throw new Error('lease lost under snapshot lock');
            }),
            /lease lost under snapshot lock/,
        );

        assert.equal(manager.getCodebaseInfo(codebase)?.callGraphSidecar, previous);
        assert.equal((manager as unknown as SnapshotDirtyView).isDirty, false);

        assert.equal(manager.commitCodebaseCallGraphSidecar(codebase, nextSidecar), true);
        assert.equal(manager.getCodebaseInfo(codebase)?.callGraphSidecar?.nodeCount, 3);
    });
});

test('v3 object maps reject arrays instead of accepting them as empty records', () => {
    withTempHome((homeDir) => {
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            formatVersion: 'v3',
            codebases: [],
            clearTombstones: {},
            latestOperations: [],
            lastUpdated: new Date().toISOString(),
        }));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.loadCodebaseSnapshot();

        assert.equal(manager.getAllCodebases().length, 0);
        assert.equal(typeof manager.getSnapshotCorruptionWarning()?.quarantinedPath, 'string');
    });
});

test('metadata-only save cannot attach stale lifecycle metadata after the same operation completed', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-metadata-lifecycle');
        fs.mkdirSync(codebase, { recursive: true });

        const seed = new SnapshotManager(FINGERPRINT_A);
        seed.setCodebaseIndexing(codebase, 25);
        seed.setLatestOperation(codebase, operationReceipt(codebase, 1, 'scanning'));
        assert.equal(seed.saveCodebaseSnapshot(), true);

        const staleMetadataWriter = new SnapshotManager(FINGERPRINT_A);
        staleMetadataWriter.loadCodebaseSnapshot();

        const lifecycleWriter = new SnapshotManager(FINGERPRINT_A);
        lifecycleWriter.loadCodebaseSnapshot();
        lifecycleWriter.setCodebaseIndexed(codebase, {
            indexedFiles: 4,
            totalChunks: 12,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        lifecycleWriter.setLatestOperation(codebase, operationReceipt(codebase, 1, 'completed'));
        assert.equal(lifecycleWriter.saveCodebaseSnapshot(), true);

        staleMetadataWriter.setCodebaseIgnoreControlSignature(codebase, 'metadata-from-stale-reader');
        assert.equal(staleMetadataWriter.saveCodebaseSnapshot(), true);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseStatus(codebase), 'indexed');
        assert.equal(reader.getLatestOperation(codebase)?.phase, 'completed');
        assert.equal(reader.getCodebaseInfo(codebase)?.ignoreControlSignature, undefined);
    });
});

test('metadata-only save retains call-graph metadata for the unchanged lifecycle generation', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-current-metadata');
        fs.mkdirSync(codebase, { recursive: true });

        const seed = new SnapshotManager(FINGERPRINT_A);
        seed.setCodebaseIndexed(codebase, {
            indexedFiles: 2,
            totalChunks: 4,
            status: 'completed',
        }, FINGERPRINT_A, 'verified', 'collection-a');
        assert.equal(seed.saveCodebaseSnapshot(), true);

        const metadataWriter = new SnapshotManager(FINGERPRINT_A);
        metadataWriter.loadCodebaseSnapshot();
        metadataWriter.setCodebaseCallGraphSidecar(codebase, {
            version: 'v3',
            sidecarPath: path.join(homeDir, 'call-graph.json'),
            builtAt: new Date().toISOString(),
            nodeCount: 3,
            edgeCount: 1,
            noteCount: 0,
            fingerprint: FINGERPRINT_A,
        });
        assert.equal(metadataWriter.saveCodebaseSnapshot(), true);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        assert.equal(reader.getCodebaseInfo(codebase)?.callGraphSidecar?.nodeCount, 3);
        assert.equal(reader.getCodebaseInfo(codebase)?.collectionName, 'collection-a');
    });
});

test('metadata-only merge preserves concurrent disk metadata and overlays only the changed field', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-metadata-overlay');
        fs.mkdirSync(codebase, { recursive: true });

        const seed = new SnapshotManager(FINGERPRINT_A);
        seed.setCodebaseIndexed(codebase, {
            indexedFiles: 2,
            totalChunks: 6,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        assert.equal(seed.saveCodebaseSnapshot(), true);

        const manifestWriter = new SnapshotManager(FINGERPRINT_A);
        manifestWriter.loadCodebaseSnapshot();
        const ignoreWriter = new SnapshotManager(FINGERPRINT_A);
        ignoreWriter.loadCodebaseSnapshot();

        manifestWriter.setCodebaseIndexManifest(codebase, ['src/main.ts']);
        assert.equal(manifestWriter.saveCodebaseSnapshot(), true);
        ignoreWriter.setCodebaseIgnoreControlSignature(codebase, 'ignore-v2');
        assert.equal(ignoreWriter.saveCodebaseSnapshot(), true);

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();
        const info = reader.getCodebaseInfo(codebase);
        assert.deepEqual(info?.indexManifest?.indexedPaths, ['src/main.ts']);
        assert.equal(info?.ignoreControlSignature, 'ignore-v2');
        assert.equal(info?.status, 'indexed');
    });
});

test('quarantine does not move a valid replacement written after the failed read', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-quarantine-replacement');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, file } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, '{ invalid snapshot');

        const replacement = {
            formatVersion: 'v3',
            codebases: {
                [codebase]: {
                    status: 'indexed',
                    indexedFiles: 1,
                    totalChunks: 2,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString(),
                    indexFingerprint: FINGERPRINT_A,
                    fingerprintSource: 'verified',
                },
            },
            clearTombstones: {},
            latestOperations: {},
            lastUpdated: new Date().toISOString(),
        };
        const manager = new SnapshotManager(FINGERPRINT_A);
        const privateManager = manager as unknown as SnapshotPrivateAccess;
        const acquire = privateManager.acquireSnapshotLock.bind(manager);
        let replaced = false;
        privateManager.acquireSnapshotLock = () => {
            if (!replaced) {
                replaced = true;
                fs.writeFileSync(file, JSON.stringify(replacement, null, 2));
            }
            return acquire();
        };

        manager.loadCodebaseSnapshot();

        assert.equal(manager.getCodebaseStatus(codebase), 'indexed');
        assert.equal(manager.getSnapshotCorruptionWarning(), undefined);
        assert.equal(
            fs.readdirSync(dir).some((name) => name.startsWith('mcp-codebase-snapshot.json.corrupt-')),
            false,
        );
    });
});

test('snapshot getters return clones instead of mutable internal records', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-cloned-getters');
        fs.mkdirSync(codebase, { recursive: true });
        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 9,
            status: 'completed',
        }, FINGERPRINT_A, 'verified');
        manager.setCodebaseIndexManifest(codebase, ['src/original.ts']);

        const direct = manager.getCodebaseInfo(codebase) as unknown as {
            status: string;
            indexManifest?: { indexedPaths: string[] };
        };
        direct.status = 'indexfailed';
        direct.indexManifest?.indexedPaths.push('src/injected.ts');

        const listed = manager.getAllCodebases()[0].info as unknown as {
            indexManifest?: { indexedPaths: string[] };
        };
        listed.indexManifest?.indexedPaths.push('src/list-injected.ts');

        assert.equal(manager.getCodebaseStatus(codebase), 'indexed');
        assert.deepEqual(manager.getCodebaseIndexedPaths(codebase), ['src/original.ts']);
    });
});
