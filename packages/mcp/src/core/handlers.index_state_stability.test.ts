import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import { SnapshotManager } from './snapshot.js';
import {
    MutationLeaseCoordinator,
    type RootMutationLease,
} from './mutation-lease.js';

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type ToolHandlersTestOverrides = {
    startBackgroundIndexing: (codebasePath: string, forceReindex: boolean, writeCollectionName?: string) => Promise<void> | void;
    probeLocalSearchCollectionState: (codebasePath: string) => Promise<{
        state: 'ready' | 'missing' | 'unknown';
        collectionName?: string;
    }>;
    extractIndexedRecoveryFromCompletionProof: (proof: unknown) => {
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' };
        indexFingerprint: IndexFingerprint;
    } | null;
    saveSnapshotIfSupported: () => void;
    recoverIndexedSnapshotFromCompletionProof: (
        codebasePath: string,
        proof: unknown,
        lease: RootMutationLease,
    ) => Promise<boolean>;
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
    schemaVersion: 'hybrid_v3',
    parserVersion: 'parser-v1',
    extractorVersion: 'extractor-v1',
    relationshipVersion: 'relationships-v1',
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

function preparedCollectionCapabilities() {
    let writeCollectionOverride: string | null = null;
    let preparedReceipt: object | null = null;
    return {
        setWriteCollectionOverride: (_codebasePath: string, collectionName: string | null) => {
            writeCollectionOverride = collectionName;
        },
        prepareIndexCollection: async (
            codebasePath: string,
            binding: { generation: number; operationId: string },
            assertMutationCurrent?: () => void,
        ) => {
            assertMutationCurrent?.();
            assert.ok(writeCollectionOverride, 'Expected a staged write collection before preparation.');
            preparedReceipt = Object.freeze({
                canonicalRoot: path.resolve(codebasePath),
                collectionName: writeCollectionOverride,
                generation: binding.generation,
                operationId: binding.operationId,
            });
            return preparedReceipt;
        },
        discardPreparedIndexCollection: (receipt: object) => {
            if (receipt === preparedReceipt) {
                preparedReceipt = null;
            }
        },
    };
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
        kind: 'satori_index_completion_v3',
        codebasePath: repoPath,
        fingerprint,
        indexedFiles: 169,
        totalChunks: 728,
        completedAt: '2026-02-28T08:00:00.000Z',
        runId: 'run_test',
        indexPolicyHash: 'a'.repeat(64),
        indexStatus: 'completed',
        navigation: { status: 'not_bound' },
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

test('local collection readiness does not trust snapshot or deterministic collection existence', async () => {
    await withTempRepo(async (repoPath) => {
        let hasCollectionCalls = 0;
        const context = {
            getActiveIndexedCollectionName: async () => null,
            resolveCollectionName: () => 'raw_base_collection',
            getVectorStore: () => ({
                hasCollection: async () => {
                    hasCollectionCalls += 1;
                    return true;
                },
            }),
        } as unknown as HandlerContext;
        const snapshotManager = {
            getCodebaseCollectionName: () => 'stale_snapshot_collection',
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );

        const state = await (handlers as unknown as ToolHandlersTestOverrides)
            .probeLocalSearchCollectionState(repoPath);

        assert.deepEqual(state, { state: 'missing' });
        assert.equal(hasCollectionCalls, 0);
    });
});

test('completion-proof snapshot recovery preserves partial status and full fingerprint', () => {
    const fingerprint: IndexFingerprint = {
        ...RUNTIME_FINGERPRINT,
        parserVersion: 'parser-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationships-v1',
    };
    const handlers = new ToolHandlers(
        {} as HandlerContext,
        {} as HandlerSnapshotManager,
        {} as HandlerSyncManager,
        RUNTIME_FINGERPRINT,
        CAPABILITIES,
    );

    const recovered = (handlers as unknown as ToolHandlersTestOverrides)
        .extractIndexedRecoveryFromCompletionProof({
            outcome: 'fingerprint_mismatch',
            reason: 'fingerprint_mismatch',
            marker: {
                ...buildMarker('/repo/a', fingerprint),
                indexStatus: 'limit_reached',
            },
        });

    assert.deepEqual(recovered, {
        stats: {
            indexedFiles: 169,
            totalChunks: 728,
            status: 'limit_reached',
        },
        indexFingerprint: fingerprint,
    });
});

test('snapshot persistence failure is not reported as success', () => {
    const handlers = new ToolHandlers(
        {} as HandlerContext,
        { saveCodebaseSnapshot: () => false } as unknown as HandlerSnapshotManager,
        {} as HandlerSyncManager,
        RUNTIME_FINGERPRINT,
        CAPABILITIES,
    );

    assert.throws(
        () => (handlers as unknown as ToolHandlersTestOverrides).saveSnapshotIfSupported(),
        /Failed to persist snapshot/,
    );
});

test('completion-proof recovery is fenced and rolls back when lifecycle persistence fails', async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'completion-proof-recovery-leases'),
            ownerId: 'completion-proof-recovery',
        });
        const acquired = coordinator.acquire(repoPath, 'create');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let currentInfo: IndexedInfo | undefined;
        let commitCalls = 0;
        const context = {
            getActiveIndexedCollectionName: async () => 'proven_collection',
        } as unknown as HandlerContext;
        const snapshotManager = {
            setCodebaseIndexed: (
                _codebasePath: string,
                stats: { indexedFiles: number; totalChunks: number; status: 'completed' },
                indexFingerprint: IndexFingerprint,
            ) => {
                currentInfo = {
                    status: 'indexed',
                    indexedFiles: stats.indexedFiles,
                    totalChunks: stats.totalChunks,
                    indexStatus: stats.status,
                    indexFingerprint,
                    fingerprintSource: 'verified',
                    lastUpdated: new Date().toISOString(),
                };
            },
            commitCodebaseLifecycleMutation: (mutate: () => void, beforeCommit?: () => void) => {
                commitCalls += 1;
                beforeCommit?.();
                const previous = currentInfo;
                mutate();
                currentInfo = previous;
                return false;
            },
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as HandlerSyncManager,
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

        await assert.rejects(
            () => (handlers as unknown as ToolHandlersTestOverrides)
                .recoverIndexedSnapshotFromCompletionProof(
                    repoPath,
                    { outcome: 'valid', marker: buildMarker(repoPath) },
                    acquired.lease,
                ),
            /Failed to persist completion-proof recovery/i,
        );
        assert.equal(commitCalls, 1);
        assert.equal(currentInfo, undefined);
        assert.equal(coordinator.isCurrent(acquired.lease), true);
        coordinator.release(acquired.lease);
    });
});

test('completion-proof recovery refuses publication after lease loss during collection resolution', async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'completion-proof-lease-loss'),
            ownerId: 'completion-proof-recovery',
        });
        const acquired = coordinator.acquire(repoPath, 'create');
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let setIndexedCalls = 0;
        let commitCalls = 0;
        const context = {
            getActiveIndexedCollectionName: async () => {
                coordinator.release(acquired.lease);
                return 'proven_collection';
            },
        } as unknown as HandlerContext;
        const snapshotManager = {
            setCodebaseIndexed: () => { setIndexedCalls += 1; },
            commitCodebaseLifecycleMutation: () => {
                commitCalls += 1;
                return true;
            },
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as HandlerSyncManager,
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

        await assert.rejects(
            () => (handlers as unknown as ToolHandlersTestOverrides)
                .recoverIndexedSnapshotFromCompletionProof(
                    repoPath,
                    { outcome: 'valid', marker: buildMarker(repoPath) },
                    acquired.lease,
                ),
            /no longer current/i,
        );
        assert.equal(commitCalls, 0);
        assert.equal(setIndexedCalls, 0);
    });
});

test('handleIndexCodebase fails before lifecycle mutation when critical context capabilities are absent', async () => {
    await withTempRepo(async (repoPath) => {
        let setIndexingCalls = 0;
        let collectionLimitCalls = 0;
        const context = {
            getVectorStore: () => ({
                checkCollectionLimit: async () => {
                    collectionLimitCalls += 1;
                    return true;
                },
            }),
            getIndexCompletionMarker: async () => null,
            resolveCollectionName: () => 'base_collection',
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexingCodebases: () => [],
            getIndexedCodebases: () => [],
            getCodebaseStatus: () => 'not_found',
            getCodebaseInfo: () => undefined,
            setCodebaseIndexing: () => { setIndexingCalls += 1; },
            saveCodebaseSnapshot: () => true,
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const payload = JSON.parse(response.content[0]?.text || '{}');

        assert.equal(payload.status, 'error');
        assert.match(payload.humanText, /missing required mutation capability/i);
        assert.equal(setIndexingCalls, 0);
        assert.equal(collectionLimitCalls, 0);
    });
});

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
            getActiveIndexedCollectionName: async () => 'satori_repo_missing_collection',
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
            getActiveIndexedCollectionName: async () => 'satori_repo_missing_collection',
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
            getActiveIndexedCollectionName: async () => 'satori_repo_missing_collection',
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
            getActiveIndexedCollectionName: async () => 'satori_repo_missing_collection',
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
            getActiveIndexedCollectionName: async () => 'satori_repo_missing_collection',
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
            ...preparedCollectionCapabilities(),
            getVectorStore: () => ({
                checkCollectionLimit: async () => true
            }),
            getIndexCompletionMarker: async () => null,
            resolveCollectionName: () => 'base_collection',
            resolveStagedCollectionName: (_path: string, generation: string) => `base_collection__gen_${generation}`,
            getActiveIndexedCollectionName: async () => null,
            clearIndexCompletionMarker: async () => undefined,
            pruneIndexedCollectionFamily: async () => [],
            pruneUnprovenStagedCollectionFamily: async () => []
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => ({ status: 'indexed' }),
            getIndexedCodebases: () => [repoPath],
            getCodebaseStatus: () => 'indexed',
            setCodebaseIndexing: () => undefined,
            setCodebaseIndexFailed: () => undefined,
            setCodebaseIndexed: () => undefined,
            setCodebaseIndexManifest: () => undefined,
            saveCodebaseSnapshot: () => true,
            commitCodebaseLifecycleMutation: (mutate: () => void, beforeCommit?: () => void) => {
                beforeCommit?.();
                mutate();
                beforeCommit?.();
                return true;
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
            ...preparedCollectionCapabilities(),
            resolveCollectionName: () => 'proven_collection',
            resolveStagedCollectionName: (_codebasePath: string, generationId: string) => `proven_collection__gen_${generationId}`,
            pruneIndexedCollectionFamily: async () => [],
            pruneUnprovenStagedCollectionFamily: async () => [],
            getVectorStore: () => ({
                checkCollectionLimit: async () => {
                    collectionLimitCalls += 1;
                    return true;
                }
            }),
            getIndexCompletionMarker: async () => buildMarker(repoPath, indexedFingerprint),
            getActiveIndexedCollectionName: async () => 'proven_collection',
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
            setCodebaseIndexFailed: () => undefined,
            setCodebaseIndexManifest: () => undefined,
            saveCodebaseSnapshot: () => {
                saveCalls += 1;
            },
            commitCodebaseLifecycleMutation: (mutate: () => void, beforeCommit?: () => void) => {
                beforeCommit?.();
                mutate();
                saveCalls += 1;
                beforeCommit?.();
                return true;
            },
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            unregisterCodebaseWatcher: async () => undefined
        } as unknown as HandlerSyncManager;
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), 'leases'),
            ownerId: 'recovery-test',
        });
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
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
        (handlers as unknown as ToolHandlersTestOverrides).startBackgroundIndexing = async () => {
            startedBackgroundIndexing = true;
        };

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        const payload = JSON.parse(response.content[0]?.text || '{}');

        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'requires_reindex');
        assert.match(payload.humanText || '', /restart Satori with VoyageAI\/voyage-code-3\/1024\/Milvus\/hybrid_v3/i);
        assert.match(
            (payload.hints?.runtimeMismatch as RuntimeMismatchHint | undefined)?.indexedFingerprint || '',
            /^VoyageAI\/voyage-code-3\/1024\/Milvus\/hybrid_v3\/parser=[a-f0-9]{12}\/extractor=[a-f0-9]{12}\/relationship=[a-f0-9]{12}\/embedding_projection=legacy\/lexical_projection=legacy$/,
        );
        assert.equal(startedBackgroundIndexing, false);
        assert.equal(collectionLimitCalls, 0);
        assert.equal(setIndexedCalls, 1);
        assert.equal(saveCalls, 1);
    });
});
