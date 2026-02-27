import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncManager } from './sync.js';

type CodebaseStatus = 'indexed' | 'indexing' | 'indexfailed' | 'sync_completed' | 'requires_reindex' | 'not_found';

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
        saveCodebaseSnapshot() { },
        removeIndexedCodebase(codebasePath: string) {
            statusByPath.delete(codebasePath);
            indexManifestByPath.delete(codebasePath);
            ignoreRulesVersionByPath.delete(codebasePath);
            ignoreControlSignatureByPath.delete(codebasePath);
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
    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as any).watcherModeStarted = true;
    manager.scheduleWatcherSync(codebasePath, 'watch_event');
    await wait(80);

    assert.equal(context.calls, 0);
    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('watch-triggered sync coalesces burst changes into one sync', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as any).watcherModeStarted = true;
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
    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as any).watcherModeStarted = true;
    let closeCalls = 0;
    const fakeWatcher = {
        close: async () => {
            closeCalls += 1;
        }
    };

    const timer = setTimeout(() => { }, 2000);
    (manager as any).watchers.set('/tmp/repo', fakeWatcher);
    (manager as any).debounceTimers.set('/tmp/repo', timer);

    await manager.stopWatcherMode();

    assert.equal(closeCalls, 1);
    assert.equal((manager as any).watchers.size, 0);
    assert.equal((manager as any).debounceTimers.size, 0);
});

test('watch filter allowlists .satoriignore', async () => {
    const codebasePath = createTempDir();
    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'indexed']]);
    const context = createContext();
    const snapshot = createSnapshot(statusByPath);
    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    const shouldIgnore = (manager as any).shouldIgnoreWatchPath(
        codebasePath,
        path.join(codebasePath, '.satoriignore')
    );
    assert.equal(shouldIgnore, false);

    const shouldIgnoreRootGitIgnore = (manager as any).shouldIgnoreWatchPath(
        codebasePath,
        path.join(codebasePath, '.gitignore')
    );
    assert.equal(shouldIgnoreRootGitIgnore, false);

    const shouldIgnoreNestedGitIgnore = (manager as any).shouldIgnoreWatchPath(
        codebasePath,
        path.join(codebasePath, 'nested/.gitignore')
    );
    assert.equal(shouldIgnoreNestedGitIgnore, true);

    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});

test('ensureFreshness baselines ignore control signature without forcing reconcile on first run', async () => {
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

    const manager = new SyncManager(context as any, snapshot as any, {
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

test('ensureFreshness does not baseline ignore control signature for non-searchable states', async () => {
    const codebasePath = createTempDir();
    fs.writeFileSync(path.join(codebasePath, '.satoriignore'), 'dist/**\n', 'utf8');

    const statusByPath = new Map<string, CodebaseStatus>([[codebasePath, 'requires_reindex']]);
    const snapshot = createSnapshot(statusByPath);
    const context = createContext();

    const manager = new SyncManager(context as any, snapshot as any, {
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

    const manager = new SyncManager(context as any, snapshot as any, {
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

    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: false,
    });

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

    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: false,
    });

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

    const manager = new SyncManager(context as any, snapshot as any, {
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

    const manager = new SyncManager(context as any, snapshot as any, {
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
    let releaseFirstSync: (() => void) | null = null;
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

    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    const inFlightSync = manager.ensureFreshness(codebasePath, 0);
    await wait(20);

    const ignoreDecisionPromise = manager.ensureFreshness(codebasePath, 60_000, {
        reason: 'ignore_change',
        coalescedEdits: 1,
    });

    await wait(20);
    assert.equal(syncCalls, 1);

    if (releaseFirstSync) {
        releaseFirstSync();
    }
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

    const manager = new SyncManager(context as any, snapshot as any, {
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

    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as any).watcherModeStarted = true;
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
    const manager = new SyncManager(context as any, snapshot as any, {
        watchEnabled: true,
        watchDebounceMs: 20,
    });

    (manager as any).watcherModeStarted = true;
    await manager.registerCodebaseWatcher(codebasePath);
    assert.equal(snapshot.getCodebaseIgnoreRulesVersion(codebasePath), undefined);

    await manager.unregisterCodebaseWatcher(codebasePath);
    await manager.stopWatcherMode();
    fs.rmSync(codebasePath, { recursive: true, force: true });
});
