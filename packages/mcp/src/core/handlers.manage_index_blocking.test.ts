import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    } as any;

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
    } as any;

    const syncManager = {
        getWatchDebounceMs: () => 2000
    } as any;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
    return handlers;
}

function parseManageEnvelope(response: any): ManageIndexResponseEnvelope {
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

test('handleIndexCodebase returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assertBlockedEnvelope(envelope, repoPath, 'create');
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

test('handleClearIndex returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleClearIndex({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        assertBlockedEnvelope(envelope, repoPath, 'clear');
    });
});

test('handleGetIndexingStatus recovers stale indexing state to failed when completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        let currentInfo: any = {
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
        } as any;

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
        } as any;

        const syncManager = { getWatchDebounceMs: () => 2000 } as any;
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

test('recent indexing state does not trigger stale-index recovery probes', async () => {
    await withTempRepo(async (repoPath) => {
        const recent = new Date().toISOString();
        let markerCalls = 0;

        const context = {
            getIndexCompletionMarker: async () => {
                markerCalls += 1;
                return null;
            }
        } as any;

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
        } as any;

        const syncManager = { getWatchDebounceMs: () => 2000 } as any;
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
        } as any;

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
        } as any;

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
        } as any;

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
        const context = {} as any;

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
        } as any;

        const syncManager = {
            getWatchDebounceMs: () => 2000,
            ensureFreshness: async () => ({
                mode: 'ignore_reload_failed',
                checkedAt: new Date().toISOString(),
                thresholdMs: 0,
                errorMessage: 'ignore_reload_failed',
                fallbackSyncExecuted: true
            })
        } as any;

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
        const context = {} as any;

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
        } as any;

        const syncManager = {
            getWatchDebounceMs: () => 2000,
            ensureFreshness: async () => ({
                mode: 'coalesced',
                checkedAt: new Date().toISOString(),
                thresholdMs: 0,
                errorMessage: 'ignore_reload_failed',
                fallbackSyncExecuted: true
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleSyncCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);
        const text = envelope.humanText;

        assert.equal(envelope.status, 'error');
        assert.match(text, /coalesced in-flight reconcile failed/i);
        assert.match(text, /Fallback incremental sync was executed/i);
    });
});
