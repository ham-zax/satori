import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSearchFrontDoor, type SearchFrontDoorHost } from './search-frontdoor.js';
import { SearchRequestCoordinator } from './search-request-coordinator.js';
import { SearchQuerySupport } from './search-query-support.js';
import { CapabilityResolver } from './capabilities.js';
import { ToolResponseBuilders } from './tool-response-builders.js';
import { buildGroupedSearchEnvelope } from './search-response-envelopes.js';
import type { SearchResponseCommonInput } from './search-response-envelopes.js';
import { SEARCH_RESPONSE_FORMAT_VERSION } from './search-types.js';

test('parallel searches execute concurrently against pinned publication during active sync (FrontDoor)', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-concurrent-reads-'));
    const preparedRead = {
        state: 'ready' as const,
        codebasePath: tempRoot,
        collectionName: 'col_gen_15',
        manifestHash: 'man-15',
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        proofDebugHint: undefined,
        vectorReceipt: { collectionName: 'col_gen_15', marker: { runId: 'run-15' } },
        generationReceipt: { marker: { runId: 'run-15' } },
        navigationStatus: 'valid' as const,
        preparedObservation: 'obs-15',
        navigationAuthorityMode: 'canonical_v4' as const,
    };

    let concurrentReadsObserved = 0;
    let maxConcurrentReads = 0;

    const host = {
        prepareInitialTrackedRootRead: async () => {
            concurrentReadsObserved += 1;
            maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReadsObserved);
            // Simulate realistic async read latency
            await new Promise((resolve) => setTimeout(resolve, 20));
            concurrentReadsObserved -= 1;
            return {
                state: 'indexing' as const,
                codebasePath: tempRoot,
                operation: { action: 'sync' as const, generation: 16, phase: 'writing', id: 'op-16' },
                searchableGenerationAvailable: true,
                searchableRead: preparedRead,
            };
        },
        getPreparedReadObservation: () => 'obs-15',
        ensureSearchFreshness: async () => {
            throw new Error('ensureSearchFreshness should not be invoked during stale-while-sync');
        },
        noteFreshnessMode: () => undefined,
        buildFreshnessBlockedSearchPayload: () => null,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
        canSyncStaleLocal: () => false,
        buildBlockedReadinessPayload: () => null,
        trackedRootReadiness: {
            buildMissingLocalCollectionSearchPayload: () => ({}),
            buildIndexFailedSearchPayload: () => ({}),
        },
    } as unknown as SearchFrontDoorHost;

    try {
        const queries = [
            'aws credential validation',
            'git commit walking',
            'entropy regex prefilter',
            'archive decompression zip',
            'source manager memory lease',
        ];

        const results = await Promise.all(
            queries.map((query) => runSearchFrontDoor({
                path: tempRoot,
                query,
                scope: 'runtime',
                groupBy: 'symbol',
                resultMode: 'grouped',
                limit: 5,
            }, host)),
        );

        assert.equal(results.length, 5);
        assert.ok(maxConcurrentReads >= 2, `Expected concurrent execution, observed max concurrency: ${maxConcurrentReads}`);

        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            assert.equal(res.kind, 'ready', `Query ${i} should be ready`);
            if (res.kind === 'ready') {
                assert.equal(res.freshnessDecision.mode, 'served_previous_generation');
                assert.equal(res.freshnessDecision.servedCollection, 'col_gen_15');
                assert.equal(res.freshnessDecision.servedRunId, 'run-15');
                assert.deepEqual(res.freshnessDecision.pendingOperation, { action: 'sync', generation: 16 });

                // Construct envelope and verify metadata
                const commonInput: SearchResponseCommonInput = {
                    absolutePath: tempRoot,
                    codebaseRoot: tempRoot,
                    query: queries[i],
                    scope: 'runtime',
                    groupBy: 'symbol',
                    limit: 5,
                    freshnessDecision: res.freshnessDecision,
                    freshnessSummary: {
                        syncMode: res.freshnessDecision.mode,
                        lastSyncAt: '2026-08-15T00:00:00Z',
                        changedFileCount: 0,
                        gitDirtyFilesConsidered: false,
                        changedFilesBoostApplied: false,
                        changedFilesBoostSkippedForLargeChangeSet: false,
                    },
                    warnings: [],
                    debugMode: 'none',
                };

                const envelope = buildGroupedSearchEnvelope({
                    ...commonInput,
                    results: [],
                });
                assert.equal(envelope.status, 'ok');
                assert.equal(envelope.formatVersion, SEARCH_RESPONSE_FORMAT_VERSION);
                assert.deepEqual(envelope.freshness, {
                    state: 'sync_in_progress',
                    servedCollection: 'col_gen_15',
                    servedRunId: 'run-15',
                    pendingOperation: { action: 'sync', generation: 16 },
                });
            }
        }
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('SearchRequestCoordinator preserves pinned reader A on Gen N across Gen N+1 activation while B binds Gen N+1', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mvcc-race-'));
    let coordinator: SearchRequestCoordinator | undefined;
    try {
        fs.writeFileSync(path.join(tempRoot, 'main.ts'), 'export const a = 1;\n');

        const genNReceipt = {
            collectionName: 'col_gen_n',
            marker: {
                runId: 'run-n',
                totalChunks: 10,
                indexPolicyHash: 'pol-n',
                navigation: { status: 'sealed' as const, generationId: 'nav-n', sealHash: 'seal-n', navigationSealHash: 'seal-n', symbolRegistryManifestHash: 'sym-n' },
            },
            policy: { canonicalRoot: tempRoot, policyHash: 'pol-n' },
            policyDocumentDigest: 'digest-n',
            exactPayloadCount: 10,
            observations: { profileFileToken: null, policyFileToken: 'tok-n' },
        };

        const genN1Receipt = {
            collectionName: 'col_gen_n1',
            marker: {
                runId: 'run-n1',
                totalChunks: 12,
                indexPolicyHash: 'pol-n1',
                navigation: { status: 'sealed' as const, generationId: 'nav-n1', sealHash: 'seal-n1', navigationSealHash: 'seal-n1', symbolRegistryManifestHash: 'sym-n1' },
            },
            policy: { canonicalRoot: tempRoot, policyHash: 'pol-n1' },
            policyDocumentDigest: 'digest-n1',
            exactPayloadCount: 12,
            observations: { profileFileToken: null, policyFileToken: 'tok-n1' },
        };

        let currentGeneration = 'N';
        let currentAuthorityObservation = 'obs-n';

        const boundCollectionsForA: string[] = [];
        const boundCollectionsForB: string[] = [];
        let unpinnedSemanticSearchCalls = 0;

        let searchAInFlightResolve!: () => void;
        const searchAInFlight = new Promise<void>((resolve) => {
            searchAInFlightResolve = resolve;
        });

        let releaseSearchAResolve!: () => void;
        const releaseSearchA = new Promise<void>((resolve) => {
            releaseSearchAResolve = resolve;
        });

        const activeLeases = new Set<string>();

        const capabilities = new CapabilityResolver({
            name: 'test',
            version: '1.0.0',
            stateRoot: tempRoot,
            executionProfile: 'connected',
            networkPolicy: { kind: 'local-only' },
            vectorStoreProvider: 'LanceDB',
            encoderProvider: 'VoyageAI',
            encoderModel: 'voyage-4-large',
            encoderOutputDimension: 1024,
            rankerModel: undefined,
        } as any);

        const support = new SearchQuerySupport({
            normalizeSearchPath: (value) => value,
            hasPathSegment: () => false,
            isGeneratedPath: () => false,
            isTestPath: () => false,
            isFixturePath: () => false,
            isDocPath: () => false,
            getContextActiveIgnorePatterns: () => [],
            getContextTrackedRelativePaths: () => [],
            classifyPathCategory: () => "core",
            shouldIncludeCategoryInScope: () => true,
            getSyncWatchDebounceMs: () => 0,
            capabilities,
            runtimeFingerprint: { schemaVersion: "hybrid-v1" } as any,
            reranker: null,
            gitignoreForceReloadEveryN: 1000,
        });

        const toolResponseBuilders = new ToolResponseBuilders({
            buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
            buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
            buildReindexHint: () => ({ tool: 'manage_index', args: { action: 'reindex', path: tempRoot } }),
            buildRepairHint: () => ({ tool: 'manage_index', args: { action: 'repair', path: tempRoot } }),
            buildSyncHint: () => ({ tool: 'manage_index', args: { action: 'sync', path: tempRoot } }),
            buildStatusHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            buildStaleLocalHint: () => ({}),
            buildStaleLocalMessage: () => '',
            buildIndexingMetadata: () => ({ formatVersion: 'test' } as any),
            buildCompatibilityDiagnostics: () => ({ status: 'valid' } as any),
            buildRuntimeMismatchHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            isRuntimeFingerprintMismatch: () => false,
            summarizeFingerprint: () => 'fp',
        });

        coordinator = new SearchRequestCoordinator({
            readiness: {
                touchWatchedCodebaseBestEffort: async () => {},
                ensureFreshness: async () => ({
                    mode: currentGeneration === 'N' ? 'served_previous_generation' : 'synced',
                    checkedAt: new Date().toISOString(),
                    thresholdMs: 0,
                    servedCollection: currentGeneration === 'N' ? 'col_gen_n' : undefined,
                    servedRunId: currentGeneration === 'N' ? 'run-n' : undefined,
                }),
                prepareTrackedRootReadWithObservation: async (): Promise<any> => {
                    const isN = currentGeneration === 'N';
                    const receipt = isN ? genNReceipt : genN1Receipt;
                    const obs = isN ? 'obs-n' : 'obs-n1';
                    if (isN) {
                        return {
                            state: 'indexing' as const,
                            codebasePath: tempRoot,
                            operation: { action: 'sync' as const, generation: 16, phase: 'writing', id: 'op-16' },
                            searchableGenerationAvailable: true,
                            searchableRead: {
                                state: 'ready' as const,
                                codebasePath: tempRoot,
                                collectionName: receipt.collectionName,
                                manifestHash: 'man-' + receipt.collectionName,
                                root: { path: tempRoot, info: { status: 'indexed' as const } },
                                proofDebugHint: undefined,
                                vectorReceipt: receipt,
                                generationReceipt: receipt,
                                navigationStatus: 'valid' as const,
                                preparedObservation: obs,
                                navigationAuthorityMode: 'canonical_v4' as const,
                            },
                        };
                    }
                    return {
                        state: 'ready' as const,
                        codebasePath: tempRoot,
                        collectionName: receipt.collectionName,
                        manifestHash: 'man-' + receipt.collectionName,
                        root: { path: tempRoot, info: { status: 'indexed' as const } },
                        proofDebugHint: undefined,
                        vectorReceipt: receipt,
                        generationReceipt: receipt,
                        navigationStatus: 'valid' as const,
                        preparedObservation: obs,
                        navigationAuthorityMode: 'canonical_v4' as const,
                    };
                },
                loadRegistryValidatedCallGraphSidecar: async () => ({ relationshipReady: false }),
                getWatcherObservation: () => ({ coverage: 'ready', available: true, snapshot: 'watch' } as any),
                getChangedFilesForCodebase: () => ({ available: true, files: new Set() }),
                waitForSearchableSync: async () => true,
                getTrackedRootReadiness: () => ({} as any),
                isPartialIndexNavigationUnavailable: () => false,
                getIndexingOperationForReadiness: () => undefined,
                canSyncStaleLocal: () => false,
                probeLocalSearchCollectionState: async () => ({ state: 'ready' }),
            },
            hints: {
                stringifyToolJson: (p) => JSON.stringify(p),
                getToolResponseBuilders: () => toolResponseBuilders,
                getSearchNavigationHelpers: () => ({
                    now: () => Date.now(),
                    sanitizeIndexedRelativeFilePath: (f: string) => f,
                    isCallGraphLanguageSupported: () => false,
                    getOutlineStatusForLanguage: () => 'valid' as any,
                }),
                buildGeneratedArtifactsVerificationHint: () => undefined,
                buildChangedCodeDebug: async () => undefined,
                withProofDebugHint: (p) => p,
                buildSyncHint: () => ({ tool: 'manage_index', args: { action: 'sync', path: tempRoot } }),
                buildStaleLocalMessage: () => '',
                buildStaleLocalHint: () => ({}),
                buildRepairHint: () => ({ tool: 'manage_index', args: { action: 'repair', path: tempRoot } }),
                buildRelationshipBackedCallGraph: async () => null,
                buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
                buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
                sanitizeIndexedRelativeFilePath: (f) => f,
            },
            preparedRead: {
                loadPreparedNavigationManifest: async (): Promise<any> => ({ status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }),
                getPreparedReadCacheObservation: () => ({
                    observation: currentAuthorityObservation,
                    sourceObservation: currentAuthorityObservation,
                }),
                getPreparedAuthorityObservation: () => currentAuthorityObservation,
                seedPreparedRead: () => {},
                evictPreparedRead: () => {},
                loadPreparedNavigationCompatibility: async (): Promise<any> => ({ status: 'incompatible', reason: 'unsupported', rootPath: tempRoot, registry: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }, relationships: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot } }),
                getCachedPreparedRead: async (): Promise<any> => ({ status: 'miss', reason: 'cold_initial' }),
                acquirePublicationReadLease: async () => {
                    const leaseId = 'lease-' + Math.random();
                    activeLeases.add(leaseId);
                    return () => {
                        activeLeases.delete(leaseId);
                    };
                },
            },
            freshness: {
                getSourceFreshnessPort: () => undefined,
                inspectSourceFreshnessCheckpoint: async () => ({} as any),
                compareAllSourceToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourceObservationToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourcePathsToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                getPreparedGenerationRevalidator: () => undefined,
            },
            environment: {
                now: () => Date.now(),
                getCapabilities: () => capabilities,
                getReadFileMaxBytes: () => 100000,
                parseIndexedAtMs: () => Date.now(),
                getEmbeddingProviderName: () => 'test-encoder',
                semanticSearch: async () => {
                    unpinnedSemanticSearchCalls += 1;
                    return [];
                },
                semanticSearchInProvenGeneration: async (receipt) => {
                    if (receipt.collectionName === 'col_gen_n') {
                        boundCollectionsForA.push(receipt.collectionName);
                        searchAInFlightResolve();
                        await releaseSearchA;
                    } else if (receipt.collectionName === 'col_gen_n1') {
                        boundCollectionsForB.push(receipt.collectionName);
                    }
                    return [];
                },
            },
        }, support, null);

        // 1. Start Search A on Gen N
        const searchAPromise = coordinator.attempt({
            path: tempRoot,
            query: 'query for A',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        });

        // 2. Wait until Search A has acquired its lease and entered semanticSearch on Gen N
        await searchAInFlight;
        assert.equal(activeLeases.size, 1, 'Search A must hold active read lease during search');

        // 3. Switch prepared authority to Gen N+1 (simulating sync activation)
        currentGeneration = 'N+1';
        currentAuthorityObservation = 'obs-n1';

        // 4. Start Search B and verify it completes against Gen N+1
        const searchBResult = await coordinator.attempt({
            path: tempRoot,
            query: 'query for B',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        });

        // 5. Release Search A
        releaseSearchAResolve();
        const searchAResult = await searchAPromise;
        assert.equal(activeLeases.size, 0, 'All read leases must be released after searches complete');

        // 6. Assertions
        assert.ok(boundCollectionsForA.length > 0);
        assert.ok(boundCollectionsForA.every((c) => c === 'col_gen_n'));
        assert.ok(boundCollectionsForB.length > 0);
        assert.ok(boundCollectionsForB.every((c) => c === 'col_gen_n1'));
        assert.equal(unpinnedSemanticSearchCalls, 0);

        const aEnvelope = JSON.parse(searchAResult.content[0]!.text);
        const bEnvelope = JSON.parse(searchBResult.content[0]!.text);
        assert.equal(aEnvelope.status, 'ok');
        assert.equal(bEnvelope.status, 'ok');
        assert.equal(aEnvelope.freshness?.servedCollection, 'col_gen_n');
        assert.equal(aEnvelope.freshness?.state, 'sync_in_progress');
    } finally {
        coordinator?.releaseContinuationOwnership();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('coordinator characterization: five parallel stale reads stay pinned across simulated activation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-product-char-'));
    let coordinator: SearchRequestCoordinator | undefined;
    try {
        fs.writeFileSync(path.join(tempRoot, 'main.ts'), 'export const x = 1;\n');

        const genNReceipt = {
            collectionName: 'col_gen_n',
            marker: { runId: 'run-n', generation: 10 },
        };
        const genN1Receipt = {
            collectionName: 'col_gen_n1',
            marker: { runId: 'run-n1', generation: 11 },
        };

        let currentGeneration = 'N';
        let currentAuthorityObservation = 'obs-n';
        const servedCollections: string[] = [];
        let unpinnedSemanticSearchCalls = 0;

        const capabilities = new CapabilityResolver({
            name: 'test',
            version: '1.0.0',
            stateRoot: tempRoot,
            executionProfile: 'connected',
            networkPolicy: { kind: 'local-only' },
            vectorStoreProvider: 'LanceDB',
            encoderProvider: 'VoyageAI',
            encoderModel: 'voyage-4-large',
            encoderOutputDimension: 1024,
            rankerModel: undefined,
        } as any);

        const support = new SearchQuerySupport({
            normalizeSearchPath: (value) => value,
            hasPathSegment: () => false,
            isGeneratedPath: () => false,
            isTestPath: () => false,
            isFixturePath: () => false,
            isDocPath: () => false,
            getContextActiveIgnorePatterns: () => [],
            getContextTrackedRelativePaths: () => [],
            classifyPathCategory: () => "core",
            shouldIncludeCategoryInScope: () => true,
            getSyncWatchDebounceMs: () => 0,
            capabilities,
            runtimeFingerprint: { schemaVersion: "hybrid-v1" } as any,
            reranker: null,
            gitignoreForceReloadEveryN: 1000,
        });

        const toolResponseBuilders = new ToolResponseBuilders({
            buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
            buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
            buildReindexHint: () => ({ tool: 'manage_index', args: { action: 'reindex', path: tempRoot } }),
            buildRepairHint: () => ({ tool: 'manage_index', args: { action: 'repair', path: tempRoot } }),
            buildSyncHint: () => ({ tool: 'manage_index', args: { action: 'sync', path: tempRoot } }),
            buildStatusHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            buildStaleLocalHint: () => ({}),
            buildStaleLocalMessage: () => '',
            buildIndexingMetadata: () => ({ formatVersion: 'test' } as any),
            buildCompatibilityDiagnostics: () => ({ status: 'valid' } as any),
            buildRuntimeMismatchHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            isRuntimeFingerprintMismatch: () => false,
            summarizeFingerprint: () => 'fp',
        });

        coordinator = new SearchRequestCoordinator({
            readiness: {
                touchWatchedCodebaseBestEffort: async () => {},
                ensureFreshness: async () => ({
                    mode: currentGeneration === 'N' ? 'served_previous_generation' : 'synced',
                    checkedAt: new Date().toISOString(),
                    thresholdMs: 0,
                    servedCollection: currentGeneration === 'N' ? 'col_gen_n' : undefined,
                    servedRunId: currentGeneration === 'N' ? 'run-n' : undefined,
                }),
                prepareTrackedRootReadWithObservation: async (): Promise<any> => {
                    const isN = currentGeneration === 'N';
                    const receipt = isN ? genNReceipt : genN1Receipt;
                    const obs = isN ? 'obs-n' : 'obs-n1';
                    if (isN) {
                        return {
                            state: 'indexing' as const,
                            codebasePath: tempRoot,
                            operation: { action: 'sync' as const, generation: 11, phase: 'writing', id: 'op-11' },
                            searchableGenerationAvailable: true,
                            searchableRead: {
                                state: 'ready' as const,
                                codebasePath: tempRoot,
                                collectionName: receipt.collectionName,
                                manifestHash: 'man-' + receipt.collectionName,
                                root: { path: tempRoot, info: { status: 'indexed' as const } },
                                proofDebugHint: undefined,
                                vectorReceipt: receipt,
                                generationReceipt: receipt,
                                navigationStatus: 'valid' as const,
                                preparedObservation: obs,
                                navigationAuthorityMode: 'canonical_v4' as const,
                            },
                        };
                    }
                    return {
                        state: 'ready' as const,
                        codebasePath: tempRoot,
                        collectionName: receipt.collectionName,
                        manifestHash: 'man-' + receipt.collectionName,
                        root: { path: tempRoot, info: { status: 'indexed' as const } },
                        proofDebugHint: undefined,
                        vectorReceipt: receipt,
                        generationReceipt: receipt,
                        navigationStatus: 'valid' as const,
                        preparedObservation: obs,
                        navigationAuthorityMode: 'canonical_v4' as const,
                    };
                },
                loadRegistryValidatedCallGraphSidecar: async () => ({ relationshipReady: false }),
                getWatcherObservation: () => ({ coverage: 'ready', available: true, snapshot: 'watch' } as any),
                getChangedFilesForCodebase: () => ({ available: true, files: new Set() }),
                waitForSearchableSync: async () => true,
                getTrackedRootReadiness: () => ({} as any),
                isPartialIndexNavigationUnavailable: () => false,
                getIndexingOperationForReadiness: () => undefined,
                canSyncStaleLocal: () => false,
                probeLocalSearchCollectionState: async () => ({ state: 'ready' }),
            },
            hints: {
                stringifyToolJson: (p) => JSON.stringify(p),
                getToolResponseBuilders: () => toolResponseBuilders,
                getSearchNavigationHelpers: () => ({
                    now: () => Date.now(),
                    sanitizeIndexedRelativeFilePath: (f: string) => f,
                    isCallGraphLanguageSupported: () => false,
                    getOutlineStatusForLanguage: () => 'valid' as any,
                }),
                buildGeneratedArtifactsVerificationHint: () => undefined,
                buildChangedCodeDebug: async () => undefined,
                withProofDebugHint: (p) => p,
                buildSyncHint: () => ({ tool: 'manage_index', args: { action: 'sync', path: tempRoot } }),
                buildStaleLocalMessage: () => '',
                buildStaleLocalHint: () => ({}),
                buildRepairHint: () => ({ tool: 'manage_index', args: { action: 'repair', path: tempRoot } }),
                buildRelationshipBackedCallGraph: async () => null,
                buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
                buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
                sanitizeIndexedRelativeFilePath: (f) => f,
            },
            preparedRead: {
                loadPreparedNavigationManifest: async (): Promise<any> => ({ status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }),
                getPreparedReadCacheObservation: () => ({
                    observation: currentAuthorityObservation,
                    sourceObservation: currentAuthorityObservation,
                }),
                getPreparedAuthorityObservation: () => currentAuthorityObservation,
                seedPreparedRead: () => {},
                evictPreparedRead: () => {},
                loadPreparedNavigationCompatibility: async (): Promise<any> => ({ status: 'incompatible', reason: 'unsupported', rootPath: tempRoot, registry: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }, relationships: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot } }),
                getCachedPreparedRead: async (): Promise<any> => ({ status: 'miss', reason: 'cold_initial' }),
                acquirePublicationReadLease: async () => () => {},
            },
            freshness: {
                getSourceFreshnessPort: () => undefined,
                inspectSourceFreshnessCheckpoint: async () => ({} as any),
                compareAllSourceToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourceObservationToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourcePathsToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                getPreparedGenerationRevalidator: () => undefined,
            },
            environment: {
                now: () => Date.now(),
                getCapabilities: () => capabilities,
                getReadFileMaxBytes: () => 100000,
                parseIndexedAtMs: () => Date.now(),
                getEmbeddingProviderName: () => 'test-encoder',
                semanticSearch: async () => {
                    unpinnedSemanticSearchCalls += 1;
                    return [];
                },
                semanticSearchInProvenGeneration: async (receipt) => {
                    servedCollections.push(receipt.collectionName);
                    return [];
                },
            },
        }, support, null);

        // 1. Hold real sync in writing: fire 5 parallel searches without settle or sleep ritual
        const queries = [
            'database connection pool',
            'http request handler middleware',
            'token bucket rate limiter',
            'bloom filter membership',
            'lru cache eviction policy',
        ];

        const results = await Promise.all(
            queries.map((q) => coordinator!.attempt({
                path: tempRoot,
                query: q,
                scope: 'runtime',
                groupBy: 'symbol',
                resultMode: 'grouped',
                limit: 5,
            })),
        );

        // Require: 5/5 responses, 0 x -32001, 0 x not_ready, each response identifies old immutable publication + pending sync
        assert.equal(results.length, 5);
        for (let i = 0; i < 5; i++) {
            const res = results[i];
            assert.ok(res.content && res.content.length > 0);
            assert.equal(res.isError, undefined);
            const envelope = JSON.parse(res.content[0]!.text);
            assert.equal(envelope.status, 'ok', `Query '${queries[i]}' must return status ok`);
            assert.equal(envelope.freshness?.state, 'sync_in_progress');
            assert.equal(envelope.freshness?.servedCollection, 'col_gen_n');
            assert.deepEqual(envelope.freshness?.pendingOperation, { action: 'sync', generation: 11 });
        }
        assert.equal(unpinnedSemanticSearchCalls, 0);
        assert.ok(servedCollections.length >= 5);
        assert.ok(servedCollections.slice(0, 10).every((c) => c === 'col_gen_n'));

        // 2. Activate Generation N+1
        currentGeneration = 'N+1';
        currentAuthorityObservation = 'obs-n1';

        // 3. New requests immediately use new publication
        const nextResult = await coordinator.attempt({
            path: tempRoot,
            query: 'new search after activation',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
        });

        const nextEnvelope = JSON.parse(nextResult.content[0]!.text);
        assert.equal(nextEnvelope.status, 'ok');
        assert.equal(servedCollections[servedCollections.length - 1], 'col_gen_n1');
    } finally {
        coordinator?.releaseContinuationOwnership();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
