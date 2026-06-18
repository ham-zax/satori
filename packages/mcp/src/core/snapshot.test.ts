import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnapshotManager } from './snapshot.js';
import { IndexFingerprint } from '../config.js';

const FINGERPRINT_A: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

const FINGERPRINT_B: IndexFingerprint = {
    embeddingProvider: 'OpenAI',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimension: 1536,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

function withTempHome<T>(fn: (homeDir: string) => T): T {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-test-'));
    process.env.HOME = tempHome;
    try {
        return fn(tempHome);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
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

test('fingerprint mismatch transitions searchable entry to requires_reindex', () => {
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
        assert.equal(gate.reason, 'fingerprint_mismatch');

        const updated = reader.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'requires_reindex');
    });
});

test('fingerprint mismatch reason and message persist after transition save/load', () => {
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
        assert.equal(transition.changed, true);
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
        if (persistedInfo.status !== 'requires_reindex') {
            assert.fail(`Expected requires_reindex, received ${persistedInfo.status}`);
        }
        assert.equal(persistedInfo.reindexReason, 'fingerprint_mismatch');
        assert.equal(persistedInfo.message, transition.message);
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

test('legacy schemaVersion v2 fingerprint transitions entry to requires_reindex under v3 runtime', () => {
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
        assert.equal(gate.reason, 'fingerprint_mismatch');

        const updated = reader.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'requires_reindex');
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

        manager.setCodebaseSyncCompleted(codebase, { added: 1, removed: 0, modified: 1 }, FINGERPRINT_A, 'verified');
        const updated = manager.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'sync_completed');
        assert.equal(updated?.fingerprintSource, 'verified');
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
        assert.equal((before as any).indexedFiles, 4);
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

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
        assert.equal(manager.shouldBreakStaleLock(lock), false);
    });
});

test('stale lock with dead pid is breakable', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }));
        const staleDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
        assert.equal(manager.shouldBreakStaleLock(lock), true);
    });
});

test('metadata-less stale lock is not breakable at normal stale threshold', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, '');
        const staleDate = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
        assert.equal(manager.shouldBreakStaleLock(lock), false);
    });
});

test('metadata-less very stale lock is breakable', () => {
    withTempHome((homeDir) => {
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, '');
        const staleDate = new Date(Date.now() - 6 * 60_000);
        fs.utimesSync(lock, staleDate, staleDate);

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
        assert.equal(manager.shouldBreakStaleLock(lock), true);
    });
});

test('lock retry exits without spin when sleep path is unavailable', () => {
    withTempHome((homeDir) => {
        const { dir, file, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ formatVersion: 'v3', codebases: {}, lastUpdated: new Date().toISOString() }));
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
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

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
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
        assert.equal((info as any).indexingPercentage, 0);
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
        assert.equal((info as any).indexingPercentage, 80);
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

        const loader = new SnapshotManager(FINGERPRINT_A) as any;
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

        const loader = new SnapshotManager(FINGERPRINT_A) as any;
        let persisted = false;
        loader.saveCodebaseSnapshot = (forceWrite = false) => {
            persisted = forceWrite === true;
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
    });
});

test('metadata-only setters skip derived-state refresh and keep derived fields', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-meta');
        fs.mkdirSync(codebase, { recursive: true });

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 6,
            totalChunks: 15,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');

        let refreshCalls = 0;
        manager.refreshDerivedState = () => {
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
        assert.equal((info as any).indexedFiles, 6);
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
        assert.equal(manager.isCodebaseCleared(codebase, 'hybrid_code_chunks_deadbeef'), true);
        assert.equal(manager.isCodebaseCleared(codebase, 'hybrid_code_chunks_newvalid'), false);
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
        assert.equal((info as any).ignoreRulesVersion, 3);
    });
});

test('dirty flag remains true when save is skipped due to lock contention', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo-dirty');
        fs.mkdirSync(codebase, { recursive: true });
        const { dir, lock } = snapshotPathsFor(homeDir);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));

        const manager = new SnapshotManager(FINGERPRINT_A) as any;
        manager.setCodebaseIndexed(codebase, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        manager.sleepSync = () => false;
        manager.saveCodebaseSnapshot();
        assert.equal(manager.isDirty, true);
    });
});
