import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-index-state-stability-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), 'export function run() { return true; }\n');
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function buildMarker(repoPath: string, fingerprint: IndexFingerprint = RUNTIME_FINGERPRINT) {
    return {
        kind: 'satori_index_completion_v1',
        codebasePath: repoPath,
        fingerprint,
        indexedFiles: 169,
        totalChunks: 728,
        completedAt: '2026-02-28T08:00:00.000Z',
        runId: 'run_test'
    };
}

function baseSearchResult() {
    return [{
        content: 'export function run() { return true; }',
        relativePath: 'src/runtime.ts',
        startLine: 1,
        endLine: 1,
        language: 'typescript',
        score: 0.99,
        indexedAt: '2026-02-28T08:00:00.000Z',
        symbolId: 'sym_runtime_run',
        symbolLabel: 'function run()'
    }];
}

test('handleSearchCode does not call cloud reconcile and keeps status ok when marker probe fails', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => baseSearchResult(),
            getIndexCompletionMarker: async () => {
                throw new Error('marker backend unavailable');
            }
        } as any;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseInfo: () => undefined
        } as any;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES, () => Date.parse('2026-02-28T08:01:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {
            throw new Error('foreground reconcile must not run');
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'run',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.debugProofCheck?.reason, 'probe_failed');
    });
});

test('handleSearchCode returns stale-local not_indexed when completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => baseSearchResult(),
            getIndexCompletionMarker: async () => null
        } as any;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseInfo: () => undefined
        } as any;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'run',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.equal(payload.hints?.staleLocal?.completionProof, 'missing_marker_doc');
        assert.equal(payload.hints?.create?.args?.path, repoPath);
    });
});

test('handleSearchCode maps completion proof fingerprint mismatch to requires_reindex', async () => {
    await withTempRepo(async (repoPath) => {
        const mismatchedFingerprint: IndexFingerprint = {
            ...RUNTIME_FINGERPRINT,
            schemaVersion: 'dense_v3'
        };
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => baseSearchResult(),
            getIndexCompletionMarker: async () => buildMarker(repoPath, mismatchedFingerprint)
        } as any;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getCodebaseStatus: () => 'indexed'
        } as any;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'run',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'requires_reindex');
        assert.equal(payload.hints?.reindex?.args?.path, repoPath);
    });
});

test('handleFileOutline returns stale-local not_indexed when completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getIndexCompletionMarker: async () => null
        } as any;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => undefined
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {
            throw new Error('foreground reconcile must not run');
        };

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.equal(payload.hints?.staleLocal?.completionProof, 'missing_marker_doc');
    });
});

test('handleCallGraph returns stale-local not_indexed when completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getIndexCompletionMarker: async () => null
        } as any;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => undefined
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {
            throw new Error('foreground reconcile must not run');
        };

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: { file: 'src/runtime.ts', symbolId: 'sym_runtime_run' },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.equal(payload.hints?.staleLocal?.completionProof, 'missing_marker_doc');
    });
});

test('handleGetIndexingStatus reports stale local indexed snapshot as not indexed', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getIndexCompletionMarker: async () => null
        } as any;
        const snapshotManager = {
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 169,
                totalChunks: 728,
                indexStatus: 'completed',
                lastUpdated: '2026-02-28T08:00:00.000Z'
            })
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const text = response.content[0]?.text || '';
        assert.match(text, /is not indexed/i);
        assert.match(text, /completion proof is missing or invalid/i);
        assert.match(text, /reason: missing_marker_doc/i);
    });
});

test('handleGetIndexingStatus keeps indexed status when marker probe fails', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getIndexCompletionMarker: async () => {
                throw new Error('probe down');
            }
        } as any;
        const snapshotManager = {
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseStatus: () => 'indexed',
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 169,
                totalChunks: 728,
                indexStatus: 'completed',
                lastUpdated: '2026-02-28T08:00:00.000Z'
            })
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const text = response.content[0]?.text || '';
        assert.match(text, /fully indexed and ready for search/i);
        assert.match(text, /probe_failed/i);
    });
});

test('handleIndexCodebase create proceeds when snapshot is indexed but completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        let startedBackgroundIndexing = false;
        const context = {
            getVectorStore: () => ({
                checkCollectionLimit: async () => true
            }),
            getIndexCompletionMarker: async () => null,
            addCustomExtensions: () => undefined,
            addCustomIgnorePatterns: () => undefined,
            clearIndexCompletionMarker: async () => undefined
        } as any;
        const snapshotManager = {
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            setCodebaseIndexing: () => undefined,
            saveCodebaseSnapshot: () => undefined
        } as any;
        const syncManager = {
            unregisterCodebaseWatcher: async () => undefined
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).startBackgroundIndexing = async () => {
            startedBackgroundIndexing = true;
        };
        (handlers as any).syncIndexedCodebasesFromCloud = async () => {
            throw new Error('foreground reconcile must not run');
        };

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        assert.equal(response.isError, undefined);
        assert.match(response.content[0]?.text || '', /Started background indexing/i);
        assert.equal(startedBackgroundIndexing, true);
    });
});
