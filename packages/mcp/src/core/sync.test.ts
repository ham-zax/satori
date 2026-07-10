import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncManager, SyncOperationError } from './sync.js';
import {
    MutationLeaseCoordinator,
    type MutationLeaseProcessSnapshot,
    type RootMutationLease,
} from './mutation-lease.js';
import type { IndexFingerprint, IndexOperationReceipt } from '../config.js';

type CodebaseStatus = 'indexed' | 'indexing' | 'indexfailed' | 'sync_completed' | 'requires_reindex' | 'not_found';
type SyncContext = ConstructorParameters<typeof SyncManager>[0];
type SyncSnapshotManager = ConstructorParameters<typeof SyncManager>[1];
type SyncManagerTestAccess = {
    watcherModeStarted: boolean;
    watchers: Map<string, { close: () => Promise<void> | void }>;
    debounceTimers: Map<string, NodeJS.Timeout>;
    watcherIgnoreMatchers: Map<string, unknown>;
    shouldIgnoreWatchPath(codebasePath: string, filePath: string): boolean;
    isIgnoreRuleControlFile(relativePath: string): boolean;
    touchWatchedCodebase(codebasePath: string): Promise<void>;
    unwatchCodebase(codebasePath: string): Promise<void>;
};

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-test-'));
}

function createSnapshot(statusByPath: Map<string, CodebaseStatus>) {
    const indexManifestByPath = new Map<string, string[]>();
    const ignoreRulesVersionByPath = new Map<string, number>();
    const ignoreControlSignatureByPath = new Map<string, string>();
    const requiresReindexByPath = new Map<string, { reason: string; message?: string }>();
    const receiptHistory: IndexOperationReceipt[] = [];
    let latestOperation: IndexOperationReceipt | undefined;
    const runtimeFingerprint: IndexFingerprint = {
        embeddingProvider: 'VoyageAI',
        embeddingModel: 'voyage-code-3',
        embeddingDimension: 1024,
        vectorStoreProvider: 'Milvus',
        schemaVersion: 'hybrid_v3',
    };

    return {
        getCodebaseStatus(codebasePath: string): CodebaseStatus {
            return statusByPath.get(codebasePath) || 'not_found';
        },
        getIndexedCodebases(): string[] {
            return Array.from(statusByPath.entries())
                .filter(([, status]) => status === 'indexed' || status === 'sync_completed')
                .map(([p]) => p);
        },
        setCodebaseSyncCompleted() { },
        setCodebaseIndexManifest(codebasePath: string, indexedPaths: string[]) {
            indexManifestByPath.set(codebasePath, indexedPaths.slice());
        },
        getCodebaseIndexedPaths(codebasePath: string): string[] {
            return indexManifestByPath.get(codebasePath)?.slice() || [];
        },
        setCodebaseIgnoreRulesVersion(codebasePath: string, version: number) {
            ignoreRulesVersionByPath.set(codebasePath, version);
        },
        getCodebaseIgnoreRulesVersion(codebasePath: string): number | undefined {
            return ignoreRulesVersionByPath.get(codebasePath);
        },
        setCodebaseIgnoreControlSignature(codebasePath: string, signature: string) {
            ignoreControlSignatureByPath.set(codebasePath, signature);
        },
        getCodebaseIgnoreControlSignature(codebasePath: string): string | undefined {
            return ignoreControlSignatureByPath.get(codebasePath);
        },
        getCodebaseRequiresReindex(codebasePath: string) {
            return requiresReindexByPath.get(codebasePath);
        },
        setCodebaseRequiresReindex(codebasePath: string, reason: string, message?: string) {
            statusByPath.set(codebasePath, 'requires_reindex');
            requiresReindexByPath.set(codebasePath, { reason, message });
        },
        startOperation(lease: RootMutationLease): IndexOperationReceipt {
            latestOperation = {
                id: lease.operationId,
                action: lease.action,
                canonicalRoot: lease.canonicalRoot,
                generation: lease.generation,
                acceptedAt: lease.acquiredAt,
                phase: 'accepted',
                lastDurableTransitionAt: lease.acquiredAt,
                runtimeFingerprint,
                writer: {
                    ownerId: lease.ownerId,
                    pid: lease.pid,
                    satoriVersion: 'test',
                },
            };
            return structuredClone(latestOperation);
        },
        transitionOperation(lease: RootMutationLease, phase: IndexOperationReceipt['phase']): IndexOperationReceipt {
            assert.equal(latestOperation?.id, lease.operationId);
            latestOperation = {
                ...latestOperation!,
                phase,
                lastDurableTransitionAt: new Date().toISOString(),
            };
            return structuredClone(latestOperation);
        },
        getLatestOperation(): IndexOperationReceipt | undefined {
            return latestOperation ? structuredClone(latestOperation) : undefined;
        },
        getReceiptHistory(): IndexOperationReceipt[] {
            return structuredClone(receiptHistory);
        },
        saveCodebaseSnapshot() {
            if (latestOperation) {
                receiptHistory.push(structuredClone(latestOperation));
            }
            return true;
        },
        removeIndexedCodebase(codebasePath: string) {
            statusByPath.delete(codebasePath);
            indexManifestByPath.delete(codebasePath);
            ignoreRulesVersionByPath.delete(codebasePath);
            ignoreControlSignatureByPath.delete(codebasePath);
            requiresReindexByPath.delete(codebasePath);
        }
    };
}

function createContext() {
    let calls = 0;
    return {
        get calls() {
            return calls;
        },
        getActiveIgnorePatterns() {
            return ['node_modules/**', 'dist/**', '.git/**'];
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reindexByChange() {
            calls += 1;
            return { added: 0, removed: 0, modified: 0 };
        }
    };
}

test('watch-triggered sync is dropped for non-searchable statuses', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexing']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as unknown as SyncManagerTestAccess).watcherModeStarted = true;
    manager.scheduleWatcherSync(codebasePath, 'watch_event');
    await wait(80);

    assert.equal(context.calls, 0);
    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness clears core index artifacts when an indexed path is deleted', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    let clearCalls = 0;
    let reindexCalls = 0;
    const clearedPaths: string[] = [];

    const context = {
        getActiveIgnorePatterns() {
            return ['node_modules/**'];
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async clearIndex(pathToClear: string) {
            clearCalls += 1;
            clearedPaths.push(pathToClear);
        },
        async reindexByChange() {
            reindexCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        },
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    fs.rmSync(codebasePath, { recursive: true, force: true });
    const decision = await manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });

    assert.equal(decision.mode, 'skipped_missing_path');
    assert.equal(clearCalls, 1);
    assert.deepEqual(clearedPaths, [codebasePath]);
    assert.equal(reindexCalls, 0);
    assert.equal(statusByPath.has(codebasePath), false);

    await manager.stopWatcherMode();
});

test('ensureFreshness does not mutate while another process owns the root lease', async () => {
    const codebasePath = createTempDir();
    const stateDir = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshotManager = createSnapshot(statusByPath);
    const processes = new Map<number, MutationLeaseProcessSnapshot>([
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
    assert.equal(owner.acquire(codebasePath, 'create').acquired, true);

    const context = createContext();
    const manager = new SyncManager(
        context as unknown as SyncContext,
        snapshotManager as unknown as SyncSnapshotManager,
        { watchEnabled: false, mutationLeaseCoordinator: contender },
    );
    const decision = await manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });

    assert.equal(decision.mode, 'skipped_mutation_in_progress');
    assert.equal(decision.activeMutation?.ownerId, 'first-owner');
    assert.equal(context.calls, 0);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
});

test('coalesced sync callers receive the same durable completed receipt', async () => {
    const codebasePath = createTempDir();
    const stateDir = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
        releaseSync = resolve;
    });
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        syncStarted = resolve;
    });
    const context = {
        async reindexByChange() {
            syncStarted();
            await syncGate;
            return { added: 1, removed: 0, modified: 0, changedFiles: ['src/new.ts'] };
        },
    };
    const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: 'sync-owner' });
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
        mutationLeaseCoordinator: coordinator,
    });

    const first = manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });
    await started;
    const second = manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });
    assert.deepEqual(snapshot.getReceiptHistory().map((receipt) => receipt.phase), ['accepted', 'writing']);
    releaseSync();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.mode, 'synced');
    assert.equal(secondDecision.mode, 'coalesced');
    assert.equal(firstDecision.operation?.phase, 'completed');
    assert.equal(secondDecision.operation?.id, firstDecision.operation?.id);
    assert.equal(coordinator.getActiveLease(codebasePath), undefined);

    fs.rmSync(codebasePath, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
});

test('sync failure persists and throws the exact failed receipt before lease release', async () => {
    const codebasePath = createTempDir();
    const stateDir = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    const coordinator = new MutationLeaseCoordinator({ stateDir, ownerId: 'sync-owner' });
    const manager = new SyncManager({
        async reindexByChange() {
            throw new Error('sync exploded');
        },
    } as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
        mutationLeaseCoordinator: coordinator,
    });

    await assert.rejects(
        manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true }),
        (error: unknown) => {
            assert.ok(error instanceof SyncOperationError);
            assert.equal(error.operation?.phase, 'failed');
            assert.equal(error.operation?.id, snapshot.getLatestOperation()?.id);
            return true;
        },
    );
    assert.equal(snapshot.getLatestOperation()?.phase, 'failed');
    assert.equal(coordinator.getActiveLease(codebasePath), undefined);

    fs.rmSync(codebasePath, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
});

test('ensureFreshness does not persist a missing ignore baseline while another process owns the root lease', async () => {
    const codebasePath = createTempDir();
    const stateDir = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshotManager = createSnapshot(statusByPath);
    let signatureWrites = 0;
    const setSignature = snapshotManager.setCodebaseIgnoreControlSignature.bind(snapshotManager);
    snapshotManager.setCodebaseIgnoreControlSignature = (root: string, signature: string) => {
        signatureWrites += 1;
        setSignature(root, signature);
    };
    const processes = new Map<number, MutationLeaseProcessSnapshot>([
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
    assert.equal(owner.acquire(codebasePath, 'create').acquired, true);

    const context = createContext();
    const manager = new SyncManager(
        context as unknown as SyncContext,
        snapshotManager as unknown as SyncSnapshotManager,
        { watchEnabled: false, mutationLeaseCoordinator: contender },
    );
    const decision = await manager.ensureFreshness(codebasePath, 0);

    assert.equal(decision.mode, 'skipped_mutation_in_progress');
    assert.equal(signatureWrites, 0);
    assert.equal(snapshotManager.getCodebaseIgnoreControlSignature(codebasePath), undefined);
    assert.equal(context.calls, 0);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
});

test('ensureFreshness does not treat mutation lease loss as a missing root', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshotManager = createSnapshot(statusByPath);
    let assertions = 0;
    let clearCalls = 0;
    const lease = {
        canonicalRoot: codebasePath,
        generation: 1,
        operationId: 'operation',
        action: 'sync' as const,
        ownerId: 'owner',
        pid: process.pid,
        acquiredAt: new Date(0).toISOString(),
    };
    const mutationLeaseCoordinator = {
        assertCurrent() {
            assertions += 1;
            if (assertions === 2) {
                throw new Error('lease_lost');
            }
        },
        release() {
            return false;
        },
    };
    const context = {
        ...createContext(),
        async clearIndex() {
            clearCalls += 1;
        },
    };
    const manager = new SyncManager(
        context as unknown as SyncContext,
        snapshotManager as unknown as SyncSnapshotManager,
        {
            watchEnabled: false,
            mutationLeaseCoordinator: mutationLeaseCoordinator as unknown as MutationLeaseCoordinator,
        },
    );

    await assert.rejects(
        manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true, mutationLease: lease }),
        /lease_lost/,
    );
    assert.equal(clearCalls, 0);
    assert.equal(snapshotManager.getCodebaseStatus(codebasePath), 'indexed');

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness passes trusted snapshot collection to incremental sync', async () => {
    const codebasePath = createTempDir();
    const committedCollection = 'hybrid_code_chunks_committed';
    let receivedOptions: unknown;
    let persistedCollection: string | undefined;

    const context = {
        getActiveIgnorePatterns() {
            return ['node_modules/**'];
        },
        hasSynchronizerForCodebase() {
            return true;
        },
        async reindexByChange(_path: string, _progress: unknown, options: unknown) {
            receivedOptions = options;
            return { added: 1, removed: 0, modified: 0, changedFiles: ['src/new.ts'], collectionName: committedCollection };
        },
        getTrackedRelativePaths() {
            return ['src/new.ts'];
        }
    };
    const snapshot = {
        getCodebaseStatus: () => 'indexed',
        getCodebaseCollectionName: () => committedCollection,
        getCodebaseIgnoreControlSignature: () => 'current',
        setCodebaseIndexManifest() {},
        setCodebaseSyncCompleted(_path: string, _stats: unknown, _fingerprint: unknown, _source: unknown, collectionName?: string) {
            persistedCollection = collectionName;
        },
        saveCodebaseSnapshot() {},
        setCodebaseIgnoreControlSignature() {},
    };

    fs.writeFileSync(path.join(codebasePath, '.gitignore'), '', 'utf8');
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });

    assert.equal(decision.mode, 'synced');
    assert.deepEqual(receivedOptions, {
        targetCollectionName: committedCollection,
        maintainCompletionMarker: true,
    });
    assert.equal(persistedCollection, committedCollection);
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness persists collection resolved by incremental sync for legacy snapshots', async () => {
    const codebasePath = createTempDir();
    const resolvedCollection = 'hybrid_code_chunks_resolved';
    let receivedOptions: unknown;
    let persistedCollection: string | undefined;

    const context = {
        getActiveIgnorePatterns() {
            return ['node_modules/**'];
        },
        hasSynchronizerForCodebase() {
            return true;
        },
        async reindexByChange(_path: string, _progress: unknown, options: unknown) {
            receivedOptions = options;
            return { added: 0, removed: 0, modified: 0, changedFiles: [], collectionName: resolvedCollection };
        },
        getTrackedRelativePaths() {
            return ['src/existing.ts'];
        }
    };
    const snapshot = {
        getCodebaseStatus: () => 'indexed',
        getCodebaseCollectionName: () => undefined,
        getCodebaseIgnoreControlSignature: () => 'current',
        setCodebaseIndexManifest() {},
        setCodebaseSyncCompleted(_path: string, _stats: unknown, _fingerprint: unknown, _source: unknown, collectionName?: string) {
            persistedCollection = collectionName;
        },
        saveCodebaseSnapshot() {},
        setCodebaseIgnoreControlSignature() {},
    };

    fs.writeFileSync(path.join(codebasePath, '.gitignore'), '', 'utf8');
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 0, { skipIgnoreControlCheck: true });

    assert.equal(decision.mode, 'synced');
    assert.deepEqual(receivedOptions, { maintainCompletionMarker: true });
    assert.equal(persistedCollection, resolvedCollection);
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness treats satori.toml as an index-policy control file', async () => {
    const codebasePath = createTempDir();
    fs.writeFileSync(path.join(codebasePath, 'satori.toml'), '[index]\nprofile = "minimal"\n', 'utf8');
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIgnoreControlSignature(codebasePath, 'stale-signature');
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/app.ts']);

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 60000);

    assert.equal(decision.mode, 'reconciled_ignore_change');
    assert.equal(context.calls, 1);
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('watch-triggered sync coalesces burst changes into one sync', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as unknown as SyncManagerTestAccess).watcherModeStarted = true;
    manager.scheduleWatcherSync(codebasePath, 'watch_event');
    manager.scheduleWatcherSync(codebasePath, 'watch_event');
    manager.scheduleWatcherSync(codebasePath, 'watch_event');
    await wait(120);

    assert.equal(context.calls, 1);
    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('stopWatcherMode closes active watchers and clears timers', async () => {
    const context = createContext();
    const snapshot = createSnapshot(new Map());
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as unknown as SyncManagerTestAccess).watcherModeStarted = true;
    let closeCalls = 0;
    const fakeWatcher = {
        close: async () => {
            closeCalls += 1;
        }
    };

    const timer = setTimeout(() => { }, 2000);
    (manager as unknown as SyncManagerTestAccess).watchers.set('/tmp/repo', fakeWatcher);
    (manager as unknown as SyncManagerTestAccess).debounceTimers.set('/tmp/repo', timer);

    await manager.stopWatcherMode();

    assert.equal(closeCalls, 1);
    assert.equal((manager as unknown as SyncManagerTestAccess).watchers.size, 0);
    assert.equal((manager as unknown as SyncManagerTestAccess).debounceTimers.size, 0);
});

test('watch filter allowlists root ignore controls and hidden supported files', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    const shouldIgnore = (manager as unknown as SyncManagerTestAccess).shouldIgnoreWatchPath(
        codebasePath,
        path.join(codebasePath, '.satoriignore')
    );
    assert.equal(shouldIgnore, false);

    const shouldIgnoreRootGitIgnore = (manager as unknown as SyncManagerTestAccess).shouldIgnoreWatchPath(
        codebasePath,
        path.join(codebasePath, '.gitignore')
    );
    assert.equal(shouldIgnoreRootGitIgnore, false);

    const shouldIgnoreHiddenSupportedFile = (manager as unknown as SyncManagerTestAccess).shouldIgnoreWatchPath(
        codebasePath,
        path.join(codebasePath, '.hidden/runtime.ts')
    );
    assert.equal(shouldIgnoreHiddenSupportedFile, false);

    assert.equal((manager as unknown as SyncManagerTestAccess).isIgnoreRuleControlFile('.gitignore'), true);
    assert.equal((manager as unknown as SyncManagerTestAccess).isIgnoreRuleControlFile('.satoriignore'), true);
    assert.equal((manager as unknown as SyncManagerTestAccess).isIgnoreRuleControlFile('nested/.gitignore'), false);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness baselines missing ignore signature only when no manifest or synchronizer exists', async () => {
    const codebasePath = createTempDir();
    fs.writeFileSync(path.join(codebasePath, '.satoriignore'), 'dist/**\n', 'utf8');

    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    let syncCalls = 0;
    let reloadCalls = 0;

    const context = {
        getActiveIgnorePatterns() {
            return ['node_modules/**'];
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            reloadCalls += 1;
            return ['node_modules/**', 'dist/**'];
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 60_000);
    assert.equal(decision.mode, 'synced');
    assert.equal(syncCalls, 1);
    assert.equal(reloadCalls, 0);
    assert.equal(typeof snapshot.getCodebaseIgnoreControlSignature(codebasePath), 'string');

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness marks requires_reindex when incremental navigation recovery fails', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    let syncCalls = 0;

    const context = {
        getActiveIgnorePatterns() {
            return ['node_modules/**'];
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reindexByChange() {
            syncCalls += 1;
            return {
                added: 1,
                removed: 0,
                modified: 0,
                changedFiles: ['src/new.go'],
                navigationRecovery: 'failed',
            };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 0);

    assert.equal(syncCalls, 1);
    assert.equal(decision.mode, 'skipped_requires_reindex');
    assert.equal(statusByPath.get(codebasePath), 'requires_reindex');
    assert.equal(snapshot.getCodebaseRequiresReindex(codebasePath)?.reason, 'navigation_recovery_failed');

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness reconciles missing ignore signature when an indexed manifest exists', async () => {
    const codebasePath = createTempDir();
    fs.writeFileSync(path.join(codebasePath, '.satoriignore'), 'src/ignored.ts\n', 'utf8');

    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/ignored.ts']);

    let activePatterns: string[] = [];
    let trackedPaths = ['src/keep.ts', 'src/ignored.ts'];
    let reloadCalls = 0;
    let syncCalls = 0;
    const deletedPaths: string[][] = [];

    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            reloadCalls += 1;
            activePatterns = ['src/ignored.ts'];
            trackedPaths = ['src/keep.ts'];
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        getTrackedRelativePaths() {
            return trackedPaths.slice();
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 60_000);
    assert.equal(decision.mode, 'reconciled_ignore_change');
    assert.equal(decision.deletedFiles, 1);
    assert.equal(reloadCalls, 1);
    assert.equal(syncCalls, 1);
    assert.deepEqual(deletedPaths, [['src/ignored.ts']]);
    assert.equal(typeof snapshot.getCodebaseIgnoreControlSignature(codebasePath), 'string');

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('recordCurrentIgnoreControlSignature persists the current root ignore signature', async () => {
    const codebasePath = createTempDir();
    fs.writeFileSync(path.join(codebasePath, '.gitignore'), 'dist/**\n', 'utf8');

    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    const context = createContext();

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    await manager.recordCurrentIgnoreControlSignature(codebasePath);

    const signature = snapshot.getCodebaseIgnoreControlSignature(codebasePath);
    assert.equal(typeof signature, 'string');
    assert.match(signature || '', /^v1:/);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness does not baseline ignore control signature for non-searchable states', async () => {
    const codebasePath = createTempDir();
    fs.writeFileSync(path.join(codebasePath, '.satoriignore'), 'dist/**\n', 'utf8');

    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'requires_reindex']]);
    const snapshot = createSnapshot(statusByPath);
    const context = createContext();

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 60_000);
    assert.equal(decision.mode, 'skipped_requires_reindex');
    assert.equal(snapshot.getCodebaseIgnoreControlSignature(codebasePath), undefined);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness returns skipped_indexing for actively indexing codebases', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexing']]);
    const snapshot = createSnapshot(statusByPath);
    const context = createContext();

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    const decision = await manager.ensureFreshness(codebasePath, 60_000);
    assert.equal(decision.mode, 'skipped_indexing');
    assert.equal(context.calls, 0);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness detects ignore control signature changes and reconciles before skipped_recent', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/ignored.ts']);

    let activePatterns: string[] = [];
    let trackedPaths = ['src/keep.ts', 'src/ignored.ts'];
    let syncCalls = 0;
    const deletedPaths: string[][] = [];

    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            activePatterns = ['src/ignored.ts'];
            trackedPaths = ['src/keep.ts'];
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        getTrackedRelativePaths() {
            return trackedPaths.slice();
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    await manager.recordCurrentIgnoreControlSignature(codebasePath);
    const baseline = await manager.ensureFreshness(codebasePath, 0);
    assert.equal(baseline.mode, 'synced');
    const baselineSignature = snapshot.getCodebaseIgnoreControlSignature(codebasePath);
    assert.equal(typeof baselineSignature, 'string');
    assert.equal(syncCalls, 1);

    fs.writeFileSync(path.join(codebasePath, '.satoriignore'), 'src/ignored.ts\n', 'utf8');

    const decision = await manager.ensureFreshness(codebasePath, 60_000);
    assert.equal(decision.mode, 'reconciled_ignore_change');
    assert.equal(decision.deletedFiles, 1);
    assert.deepEqual(deletedPaths, [['src/ignored.ts']]);
    assert.equal(syncCalls, 2);

    const updatedSignature = snapshot.getCodebaseIgnoreControlSignature(codebasePath);
    assert.equal(typeof updatedSignature, 'string');
    assert.notEqual(updatedSignature, baselineSignature);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness detects same-size ignore control content changes with unchanged mtime', async () => {
    const codebasePath = createTempDir();
    const ignorePath = path.join(codebasePath, '.satoriignore');
    const fixedTime = new Date('2026-03-16T12:00:00.000Z');
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/b.ts']);

    fs.writeFileSync(ignorePath, 'src/a.ts\n', 'utf8');
    fs.utimesSync(ignorePath, fixedTime, fixedTime);

    let activePatterns = ['src/a.ts'];
    let trackedPaths = ['src/keep.ts', 'src/b.ts'];
    let syncCalls = 0;
    const deletedPaths: string[][] = [];

    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            activePatterns = fs.readFileSync(ignorePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
            trackedPaths = ['src/keep.ts'];
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        getTrackedRelativePaths() {
            return trackedPaths.slice();
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    await manager.recordCurrentIgnoreControlSignature(codebasePath);
    const baseline = await manager.ensureFreshness(codebasePath, 0);
    assert.equal(baseline.mode, 'synced');
    const baselineSignature = snapshot.getCodebaseIgnoreControlSignature(codebasePath);
    assert.equal(typeof baselineSignature, 'string');
    assert.equal(syncCalls, 1);

    fs.writeFileSync(ignorePath, 'src/b.ts\n', 'utf8');
    fs.utimesSync(ignorePath, fixedTime, fixedTime);

    const decision = await manager.ensureFreshness(codebasePath, 60_000);
    assert.equal(decision.mode, 'reconciled_ignore_change');
    assert.equal(decision.deletedFiles, 1);
    assert.deepEqual(deletedPaths, [['src/b.ts']]);
    assert.equal(syncCalls, 2);
    assert.notEqual(snapshot.getCodebaseIgnoreControlSignature(codebasePath), baselineSignature);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness coalesces non-watcher ignore signature reconciles while one is in flight', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/ignored.ts']);

    let activePatterns: string[] = [];
    let trackedPaths = ['src/keep.ts', 'src/ignored.ts'];
    let reloadCalls = 0;
    let syncCalls = 0;
    const deletedPaths: string[][] = [];

    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            reloadCalls += 1;
            activePatterns = ['src/ignored.ts'];
            trackedPaths = ['src/keep.ts'];
            await wait(40);
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        getTrackedRelativePaths() {
            return trackedPaths.slice();
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: false,
    });

    await manager.recordCurrentIgnoreControlSignature(codebasePath);
    const baseline = await manager.ensureFreshness(codebasePath, 0);
    assert.equal(baseline.mode, 'synced');
    assert.equal(syncCalls, 1);

    fs.writeFileSync(path.join(codebasePath, '.satoriignore'), 'src/ignored.ts\n', 'utf8');
    const p1 = manager.ensureFreshness(codebasePath, 60_000);
    await wait(5);
    const p2 = manager.ensureFreshness(codebasePath, 60_000);

    const first = await p1;
    const second = await p2;

    assert.equal(first.mode, 'reconciled_ignore_change');
    assert.equal(second.mode, 'coalesced');
    assert.equal(reloadCalls, 1);
    assert.equal(syncCalls, 2);
    assert.deepEqual(deletedPaths, [['src/ignored.ts']]);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ignore-change reconciliation deletes newly ignored indexed paths and forces sync', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);

    let activePatterns = ['dist/**'];
    let syncCalls = 0;
    const deletedPaths: string[][] = [];

    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/ignored.ts']);

    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            activePatterns = ['dist/**', 'src/ignored.ts'];
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        getTrackedRelativePaths() {
            return ['src/keep.ts', 'src/new.ts'];
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 1, removed: 0, modified: 0, changedFiles: ['src/new.ts'] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    const decision = await manager.ensureFreshness(codebasePath, 0, {
        reason: 'ignore_change',
        coalescedEdits: 2,
    });

    assert.equal(decision.mode, 'reconciled_ignore_change');
    assert.equal(decision.deletedFiles, 1);
    assert.equal(decision.newlyIgnoredFiles, 1);
    assert.equal(decision.addedFiles, 1);
    assert.equal(decision.coalescedEdits, 2);
    assert.equal(decision.ignoreRulesVersion, 1);
    assert.equal(syncCalls, 1);
    assert.deepEqual(deletedPaths, [['src/ignored.ts']]);
    assert.deepEqual(snapshot.getCodebaseIndexedPaths(codebasePath), ['src/keep.ts', 'src/new.ts']);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ignore-change reconciliation marks requires_reindex when sync fails after deleting ignored indexed paths', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);

    let activePatterns = ['dist/**'];
    let syncCalls = 0;
    const deletedPaths: string[][] = [];

    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/ignored.ts']);

    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            activePatterns = ['dist/**', 'src/ignored.ts'];
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        getTrackedRelativePaths() {
            return ['src/keep.ts'];
        },
        async reindexByChange() {
            syncCalls += 1;
            throw new Error('forced sync failure');
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    const decision = await manager.ensureFreshness(codebasePath, 0, {
        reason: 'ignore_change',
        coalescedEdits: 1,
    });

    assert.equal(decision.mode, 'ignore_reload_failed');
    assert.equal(decision.fallbackSyncExecuted, false);
    assert.equal(syncCalls, 2);
    assert.deepEqual(deletedPaths, [['src/ignored.ts']]);
    assert.equal(statusByPath.get(codebasePath), 'requires_reindex');
    assert.equal(snapshot.getCodebaseRequiresReindex(codebasePath)?.reason, 'navigation_recovery_failed');
    assert.match(snapshot.getCodebaseRequiresReindex(codebasePath)?.message || '', /Ignore-rule reconciliation/);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ignore-change reconcile uses manifest paths captured before reload even when post-reload synchronizer excludes them', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);

    let activePatterns = ['dist/**'];
    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/ignored.ts']);

    const deletedPaths: string[][] = [];
    let syncCalls = 0;
    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return true;
        },
        async reloadIgnoreRulesForCodebase() {
            activePatterns = ['dist/**', 'src/ignored.ts'];
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        getTrackedRelativePaths() {
            // Post-reload view no longer includes ignored file; reconcile must still delete it from manifest.
            return ['src/keep.ts'];
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        },
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    const decision = await manager.ensureFreshness(codebasePath, 0, {
        reason: 'ignore_change',
        coalescedEdits: 1,
    });

    assert.equal(decision.mode, 'reconciled_ignore_change');
    assert.equal(decision.deletedFiles, 1);
    assert.deepEqual(deletedPaths, [['src/ignored.ts']]);
    assert.equal(syncCalls, 1);
    assert.deepEqual(snapshot.getCodebaseIndexedPaths(codebasePath), ['src/keep.ts']);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ignore-change reconciliation runs after in-flight sync and is not skipped by freshness window', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);

    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/a.ts']);

    let syncCalls = 0;
    let releaseFirstSync: () => void = () => {
        assert.fail('First sync gate was not initialized.');
    };
    const firstSyncGate = new Promise<void>((resolve) => {
        releaseFirstSync = resolve;
    });

    const context = {
        getActiveIgnorePatterns() {
            return [];
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            return [];
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths() {
            return 0;
        },
        getTrackedRelativePaths() {
            return ['src/a.ts'];
        },
        async reindexByChange() {
            syncCalls += 1;
            if (syncCalls === 1) {
                await firstSyncGate;
            }
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    await manager.recordCurrentIgnoreControlSignature(codebasePath);
    const inFlightSync = manager.ensureFreshness(codebasePath, 0);
    await wait(20);

    const ignoreDecisionPromise = manager.ensureFreshness(codebasePath, 60_000, {
        reason: 'ignore_change',
        coalescedEdits: 1,
    });

    await wait(20);
    assert.equal(syncCalls, 1);

    releaseFirstSync();
    await inFlightSync;

    const ignoreDecision = await ignoreDecisionPromise;
    assert.equal(ignoreDecision.mode, 'reconciled_ignore_change');
    assert.equal(syncCalls, 2);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ignore-change returns ignore_reload_failed with fallback sync when manifest and synchronizer are missing', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);

    let syncCalls = 0;
    const context = {
        getActiveIgnorePatterns() {
            return [];
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            return [];
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    const decision = await manager.ensureFreshness(codebasePath, 0, {
        reason: 'ignore_change',
        coalescedEdits: 1,
    });

    assert.equal(decision.mode, 'ignore_reload_failed');
    assert.equal(decision.fallbackSyncExecuted, true);
    assert.equal(syncCalls, 1);
    assert.match(String(decision.errorMessage), /missing_manifest_and_synchronizer/);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('watch-triggered ignore_rules_changed event runs reconcile path', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const snapshot = createSnapshot(statusByPath);
    snapshot.setCodebaseIndexManifest(codebasePath, ['src/keep.ts', 'src/ignored.ts']);

    let activePatterns = ['dist/**'];
    let syncCalls = 0;
    const deletedPaths: string[][] = [];
    const context = {
        getActiveIgnorePatterns() {
            return activePatterns;
        },
        hasSynchronizerForCodebase() {
            return false;
        },
        async reloadIgnoreRulesForCodebase() {
            activePatterns = ['dist/**', 'src/ignored.ts'];
            return activePatterns;
        },
        async recreateSynchronizerForCodebase() {
            return;
        },
        async deleteIndexedPathsByRelativePaths(_codebasePath: string, relativePaths: string[]) {
            deletedPaths.push(relativePaths.slice());
            return relativePaths.length;
        },
        getTrackedRelativePaths() {
            return ['src/keep.ts'];
        },
        async reindexByChange() {
            syncCalls += 1;
            return { added: 0, removed: 0, modified: 0, changedFiles: [] };
        }
    };

    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as unknown as SyncManagerTestAccess).watcherModeStarted = true;
    manager.scheduleWatcherSync(codebasePath, 'ignore_rules_changed');
    await wait(100);

    assert.equal(syncCalls, 1);
    assert.deepEqual(deletedPaths, [['src/ignored.ts']]);
    assert.equal(snapshot.getCodebaseIgnoreRulesVersion(codebasePath), 1);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('registering watcher does not increment ignore rules version', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as unknown as SyncManagerTestAccess).watcherModeStarted = true;
    await manager.registerCodebaseWatcher(codebasePath);
    assert.equal(snapshot.getCodebaseIgnoreRulesVersion(codebasePath), undefined);

    await manager.unregisterCodebaseWatcher(codebasePath);
    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('registering watcher contains ignore matcher failures', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });
    const access = manager as unknown as SyncManagerTestAccess & {
        buildIgnoreMatcherForCodebase(codebasePath: string): Promise<unknown>;
    };

    access.watcherModeStarted = true;
    access.buildIgnoreMatcherForCodebase = async () => {
        throw new Error('invalid ignore matcher');
    };

    await manager.registerCodebaseWatcher(codebasePath);

    assert.equal(access.watchers.has(codebasePath), false);
    assert.equal(access.watcherIgnoreMatchers.has(codebasePath), false);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('startWatcherMode does not automatically watch every indexed codebase from snapshot state', async () => {
    const codebasePathA = createTempDir();
    const codebasePathB = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([
        [codebasePathA, 'indexed'],
        [codebasePathB, 'sync_completed'],
    ]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    await manager.startWatcherMode();

    assert.equal((manager as unknown as SyncManagerTestAccess).watchers.size, 0);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePathA, { recursive: true, force: true });
    fs.rmSync(codebasePathB, { recursive: true, force: true });
});

test('touchWatchedCodebase registers only explicitly touched codebases and unwatchCodebase removes them', async () => {
    const codebasePathA = createTempDir();
    const codebasePathB = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([
        [codebasePathA, 'indexed'],
        [codebasePathB, 'indexed'],
    ]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as unknown as SyncContext, snapshot as unknown as SyncSnapshotManager, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    await manager.startWatcherMode();
    await (manager as unknown as SyncManagerTestAccess).touchWatchedCodebase(codebasePathA);

    assert.equal((manager as unknown as SyncManagerTestAccess).watchers.has(codebasePathA), true);
    assert.equal((manager as unknown as SyncManagerTestAccess).watchers.has(codebasePathB), false);

    await (manager as unknown as SyncManagerTestAccess).touchWatchedCodebase(codebasePathB);
    assert.equal((manager as unknown as SyncManagerTestAccess).watchers.has(codebasePathB), true);

    await (manager as unknown as SyncManagerTestAccess).unwatchCodebase(codebasePathA);
    assert.equal((manager as unknown as SyncManagerTestAccess).watchers.has(codebasePathA), false);
    assert.equal((manager as unknown as SyncManagerTestAccess).watchers.has(codebasePathB), true);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePathA, { recursive: true, force: true });
    fs.rmSync(codebasePathB, { recursive: true, force: true });
});
