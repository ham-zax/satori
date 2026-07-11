import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import { SnapshotManager } from './snapshot.js';

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type ToolHandlersTestOverrides = {
    startBackgroundIndexing: (codebasePath: string, forceReindex: boolean, writeCollectionName?: string) => Promise<void> | void;
};
type RuntimeMismatchHint = { indexedFingerprint?: string };
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

function warningCodes(payload: { warnings?: Array<string | { code?: string }> }): string[] {
    return (payload.warnings || [])
        .map((warning) => typeof warning === 'string' ? warning : warning.code)
        .filter((code): code is string => typeof code === 'string');
}

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-index-state-stability-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), 'export function run() { return true; }\n');
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function withTempHome<T>(fn: (homeDir: string) => Promise<T> | T): Promise<T> | T {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-index-state-home-'));
    const run = async () => await fn(tempHome);
    return run().finally(() => {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempHome, { recursive: true, force: true });
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

test('handleSearchCode keeps status ok when completion-proof probe fails', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => baseSearchResult(),
            getIndexCompletionMarker: async () => {
                throw new Error('marker backend unavailable');
            }
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseInfo: () => undefined
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES, () => Date.parse('2026-02-28T08:01:00.000Z'));

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

test('handleSearchCode warns when returning results from a partial limit_reached index', async () => {
    await withTempRepo(async (repoPath) => {
        const info = {
            status: 'indexed',
            indexStatus: 'limit_reached',
            indexedFiles: 1,
            totalChunks: 1,
            lastUpdated: '2026-02-28T08:00:00.000Z'
        };
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => baseSearchResult(),
            getIndexCompletionMarker: async () => buildMarker(repoPath)
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseInfo: () => info,
            getCodebaseStatus: () => 'indexed'
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES, () => Date.parse('2026-02-28T08:01:00.000Z'));

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
        assert.ok(Array.isArray(payload.results));
        assert.ok(payload.results.length > 0);
        assert.ok(Array.isArray(payload.warnings));
        assert.ok(warningCodes(payload).includes('SEARCH_PARTIAL_INDEX:limit_reached'));
        assert.ok(warningCodes(payload).includes('SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE'));

        const rawResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'run',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 5
        });
        const rawPayload = JSON.parse(rawResponse.content[0]?.text || '{}');
        assert.equal(rawPayload.status, 'ok');
        assert.equal(rawPayload.resultMode, 'raw');
        assert.ok(Array.isArray(rawPayload.results));
        assert.ok(rawPayload.results.length > 0);
        assert.ok(warningCodes(rawPayload).includes('SEARCH_PARTIAL_INDEX:limit_reached'));
        assert.ok(warningCodes(rawPayload).includes('SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE'));
    });
});

test('handleSearchCode returns stale-local not_indexed when completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => baseSearchResult(),
            getIndexCompletionMarker: async () => null
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseInfo: () => undefined
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;
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
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.equal(payload.recommendedNextAction?.args?.action, 'repair');
        assert.equal(payload.recommendedNextAction?.args?.path, repoPath);
    });
});

test('handleSearchCode reruns tracked-root readiness after freshness before returning results', async () => {
    await withTempRepo(async (repoPath) => {
        let markerCalls = 0;
        let ensureFreshnessCalls = 0;
        let semanticSearchCalls = 0;

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                semanticSearchCalls += 1;
                return baseSearchResult();
            },
            getIndexCompletionMarker: async () => {
                markerCalls += 1;
                return markerCalls === 1 ? buildMarker(repoPath) : null;
            }
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return {
                    mode: 'skipped_recent',
                    checkedAt: '2026-02-28T08:00:00.000Z',
                    thresholdMs: 180000
                };
            }
        } as unknown as HandlerSyncManager;
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
        assert.equal(ensureFreshnessCalls, 1);
        assert.equal(markerCalls, 2);
        assert.equal(semanticSearchCalls, 0);
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
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getCodebaseStatus: () => 'indexed'
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;
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
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.equal(payload.recommendedNextAction?.args?.action, 'reindex');
        assert.equal(payload.recommendedNextAction?.args?.path, repoPath);
    });
});

test('handleSearchCode fails closed when the configured vector backend collection is missing', async () => {
    await withTempRepo(async (repoPath) => {
        let semanticSearchCalls = 0;
        let ensureFreshnessCalls = 0;
        let unwatchCalls = 0;
        let removedCodebasePath: string | null = null;
        let saveCalls = 0;

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({
                hasCollection: async () => false
            }),
            resolveCollectionName: () => 'satori_repo_missing_collection',
            semanticSearch: async () => {
                semanticSearchCalls += 1;
                return baseSearchResult();
            },
            getIndexCompletionMarker: async () => buildMarker(repoPath)
        } as unknown as HandlerContext;

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: '2026-02-28T08:00:00.000Z',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            removeCodebaseCompletely: (codebasePath: string) => {
                removedCodebasePath = codebasePath;
            },
            saveCodebaseSnapshot: () => {
                saveCalls += 1;
            }
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return {
                    mode: 'skipped_recent',
                    checkedAt: '2026-02-28T08:00:00.000Z',
                    thresholdMs: 180000
                };
            },
            unwatchCodebase: async () => {
                unwatchCalls += 1;
            }
        } as unknown as HandlerSyncManager;

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
        assert.match(payload.message, /vector collection is missing from the configured vector backend/i);
        assert.equal(payload.hints?.create?.args?.path, repoPath);
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.equal(payload.recommendedNextAction?.args?.action, 'create');
        assert.equal(payload.recommendedNextAction?.args?.path, repoPath);
        assert.equal(semanticSearchCalls, 0);
        assert.equal(ensureFreshnessCalls, 0);
        assert.equal(removedCodebasePath, null);
        assert.equal(saveCalls, 0);
        assert.equal(unwatchCalls, 0);
    });
});

test('handleSearchCode does not enter freshness sync when completion-proof probe fails and the configured vector backend collection is missing', async () => {
    await withTempRepo(async (repoPath) => {
        let ensureFreshnessCalls = 0;

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({
                hasCollection: async () => false
            }),
            resolveCollectionName: () => 'satori_repo_missing_collection',
            semanticSearch: async () => baseSearchResult(),
            getIndexCompletionMarker: async () => {
                throw new Error('marker backend unavailable');
            }
        } as unknown as HandlerContext;

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: '2026-02-28T08:00:00.000Z',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            removeCodebaseCompletely: () => undefined,
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return {
                    mode: 'skipped_recent',
                    checkedAt: '2026-02-28T08:00:00.000Z',
                    thresholdMs: 180000
                };
            },
            unwatchCodebase: async () => undefined
        } as unknown as HandlerSyncManager;

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
        assert.equal(ensureFreshnessCalls, 0);
        assert.equal(payload.hints?.debugProofCheck?.reason, 'probe_failed');
    });
});

test('handleSearchCode does not clear snapshot readiness when vector collection probing throws', async () => {
    await withTempRepo(async (repoPath) => {
        let semanticSearchCalls = 0;
        let ensureFreshnessCalls = 0;
        let removedCodebasePath: string | null = null;
        let saveCalls = 0;
        let unwatchCalls = 0;

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({
                hasCollection: async () => {
                    throw new Error('backend probe unavailable');
                }
            }),
            resolveCollectionName: () => 'satori_repo_probe_error',
            semanticSearch: async () => {
                semanticSearchCalls += 1;
                return baseSearchResult();
            },
            getIndexCompletionMarker: async () => buildMarker(repoPath)
        } as unknown as HandlerContext;

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: '2026-02-28T08:00:00.000Z',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            removeCodebaseCompletely: (codebasePath: string) => {
                removedCodebasePath = codebasePath;
            },
            saveCodebaseSnapshot: () => {
                saveCalls += 1;
            }
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return {
                    mode: 'skipped_recent',
                    checkedAt: '2026-02-28T08:00:00.000Z',
                    thresholdMs: 180000
                };
            },
            unwatchCodebase: async () => {
                unwatchCalls += 1;
            }
        } as unknown as HandlerSyncManager;

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
        assert.equal(payload.status, 'ok');
        assert.ok(semanticSearchCalls > 0);
        assert.equal(ensureFreshnessCalls, 1);
        assert.equal(removedCodebasePath, null);
        assert.equal(saveCalls, 0);
        assert.equal(unwatchCalls, 0);
    });
});

test('handleFileOutline returns stale-local not_indexed when completion marker is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getIndexCompletionMarker: async () => null
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => undefined
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => undefined
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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

test('handleFileOutline returns not_indexed when search collection readiness is gone locally', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({
                hasCollection: async () => false
            }),
            resolveCollectionName: () => 'satori_repo_missing_collection',
            getIndexCompletionMarker: async () => buildMarker(repoPath)
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => undefined,
            removeCodebaseCompletely: () => undefined,
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            unwatchCodebase: async () => undefined
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.match(payload.message, /vector collection is missing from the configured vector backend/i);
        assert.equal(payload.hints?.create?.args?.path, repoPath);
    });
});

test('handleCallGraph returns not_indexed when search collection readiness is gone locally', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({
                hasCollection: async () => false
            }),
            resolveCollectionName: () => 'satori_repo_missing_collection',
            getIndexCompletionMarker: async () => buildMarker(repoPath)
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: { status: 'indexed' } }],
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => undefined,
            removeCodebaseCompletely: () => undefined,
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            unwatchCodebase: async () => undefined
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        assert.match(payload.message, /vector collection is missing from the configured vector backend/i);
        assert.equal(payload.hints?.create?.args?.path, repoPath);
    });
});

test('handlers refresh persisted snapshot state before serving read paths', async () => {
    await withTempHome(async (homeDir) => {
        process.env.HOME = homeDir;
        const repoPath = path.join(homeDir, 'repo');
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), 'export function run() { return true; }\n');

        const writer = new SnapshotManager(RUNTIME_FINGERPRINT);
        writer.setCodebaseIndexed(repoPath, {
            indexedFiles: 1,
            totalChunks: 1,
            status: 'completed'
        }, RUNTIME_FINGERPRINT, 'verified');
        writer.saveCodebaseSnapshot();

        const staleReader = new SnapshotManager(RUNTIME_FINGERPRINT);
        staleReader.loadCodebaseSnapshot();

        const otherProcess = new SnapshotManager(RUNTIME_FINGERPRINT);
        otherProcess.loadCodebaseSnapshot();
        otherProcess.setCodebaseRequiresReindex(repoPath, 'navigation_recovery_failed', 'other process blocked this root');
        otherProcess.saveCodebaseSnapshot();

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => baseSearchResult()
        } as unknown as HandlerContext;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: '2026-02-28T08:00:00.000Z',
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, staleReader, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        assert.match(payload.message, /other process blocked this root/i);
    });
});

test('handleGetIndexingStatus reports stale local indexed snapshot as not indexed', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getIndexCompletionMarker: async () => null
        } as unknown as HandlerContext;
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const text = response.content[0]?.text || '';
        assert.match(text, /stale local index metadata/i);
        assert.match(text, /completion proof is missing or invalid/i);
        assert.match(text, /reason: missing_marker_doc/i);
    });
});

test('handleGetIndexingStatus returns not_indexed when search collection readiness is gone locally', async () => {
    await withTempRepo(async (repoPath) => {
        let removedCodebasePath: string | null = null;
        let saveCalls = 0;
        let unwatchCalls = 0;

        const context = {
            getVectorStore: () => ({
                hasCollection: async () => false
            }),
            resolveCollectionName: () => 'satori_repo_missing_collection',
            getIndexCompletionMarker: async () => buildMarker(repoPath)
        } as unknown as HandlerContext;
        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: '2026-02-28T08:00:00.000Z',
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            removeCodebaseCompletely: (codebasePath: string) => {
                removedCodebasePath = codebasePath;
            },
            saveCodebaseSnapshot: () => {
                saveCalls += 1;
            }
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            unwatchCodebase: async () => {
                unwatchCalls += 1;
            }
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const payload = JSON.parse(response.content[0]?.text || '{}');

        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.match(payload.humanText || '', /vector collection is missing from the configured vector backend/i);
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
        assert.equal(removedCodebasePath, null);
        assert.equal(saveCalls, 0);
        assert.equal(unwatchCalls, 0);
    });
});

test('handleGetIndexingStatus keeps indexed status when marker probe fails', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getIndexCompletionMarker: async () => {
                throw new Error('probe down');
            }
        } as unknown as HandlerContext;
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const text = response.content[0]?.text || '';
        assert.match(text, /fully indexed and ready for search/i);
        assert.match(text, /probe_failed/i);
    });
});

test('handleGetIndexingStatus preserves getIndexCompletionMarker receiver binding', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            marker: buildMarker(repoPath),
            async getIndexCompletionMarker(codebasePath: string) {
                assert.equal(this, context);
                assert.equal(codebasePath, repoPath);
                return this.marker;
            }
        } as unknown as HandlerContext;
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const text = response.content[0]?.text || '';
        assert.match(text, /fully indexed and ready for search/i);
        assert.doesNotMatch(text, /probe_failed/i);
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
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            setCodebaseIndexing: () => undefined,
            saveCodebaseSnapshot: () => undefined
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            unregisterCodebaseWatcher: async () => undefined
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as unknown as ToolHandlersTestOverrides).startBackgroundIndexing = async () => {
            startedBackgroundIndexing = true;
        };

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        assert.equal(response.isError, undefined);
        assert.match(response.content[0]?.text || '', /Started background indexing/i);
        assert.equal(startedBackgroundIndexing, true);
    });
});

test('handleIndexCodebase recovers marker-backed mismatch without restarting indexing when snapshot is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedFingerprint: IndexFingerprint = {
            ...RUNTIME_FINGERPRINT,
            embeddingModel: 'voyage-code-3'
        };
        let currentInfo: IndexedInfo | undefined = undefined;
        let startedBackgroundIndexing = false;
        let collectionLimitCalls = 0;
        let setIndexedCalls = 0;
        let saveCalls = 0;

        const context = {
            getVectorStore: () => ({
                checkCollectionLimit: async () => {
                    collectionLimitCalls += 1;
                    return true;
                }
            }),
            getIndexCompletionMarker: async () => ({
                kind: 'satori_index_completion_v1',
                codebasePath: repoPath,
                fingerprint: indexedFingerprint,
                indexedFiles: 169,
                totalChunks: 728,
                completedAt: '2026-02-28T08:00:00.000Z',
                runId: 'run_test'
            }),
            addCustomExtensions: () => undefined,
            addCustomIgnorePatterns: () => undefined,
            clearIndexCompletionMarker: async () => undefined
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => currentInfo,
            getIndexedCodebases: () => [],
            getCodebaseStatus: () => 'not_found',
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
            setCodebaseIndexing: () => undefined,
            saveCodebaseSnapshot: () => {
                saveCalls += 1;
            }
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            unregisterCodebaseWatcher: async () => undefined
        } as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as unknown as ToolHandlersTestOverrides).startBackgroundIndexing = async () => {
            startedBackgroundIndexing = true;
        };

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const payload = JSON.parse(response.content[0]?.text || '{}');

        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'requires_reindex');
        assert.match(payload.humanText || '', /restart Satori with VoyageAI\/voyage-code-3\/1024\/Milvus\/hybrid_v3/i);
        assert.equal((payload.hints?.runtimeMismatch as RuntimeMismatchHint | undefined)?.indexedFingerprint, 'VoyageAI/voyage-code-3/1024/Milvus/hybrid_v3/parser=legacy/extractor=legacy/relationship=legacy');
        assert.equal(startedBackgroundIndexing, false);
        assert.equal(collectionLimitCalls, 0);
        assert.equal(setIndexedCalls, 1);
        assert.equal(saveCalls, 1);
    });
});
