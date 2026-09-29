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
import type { PublicationLease, PublicationRef } from '@satori-code/core';

function publicationRef(
    root: string,
    id: string,
    collectionName: string,
    policyHash: string,
    totalChunks = 1,
): PublicationRef {
    return {
        id,
        publication: {
            version: 2,
            packageOwnership: false,
            id,
            canonicalRoot: root,
            createdAt: '2026-08-15T00:00:00.000Z',
            status: 'complete',
            policy: {
                profile: 'default',
                customExtensions: [],
                customIgnorePatterns: [],
                fileBasedIgnorePatterns: [],
                supportedExtensions: ['.ts'],
                effectiveIgnorePatterns: [],
                policyHash,
                controlSignature: `control-${id}`,
            },
            format: {
                indexFormatVersion: 'hybrid_v3',
                embeddingIdentity: 'test-embedding',
                relationshipVersion: 'relationship-v1',
            },
            vector: { collectionName, indexedFiles: 1, totalChunks },
            navigation: { relativeRoot: 'navigation' },
        },
    };
}

test('parallel searches execute concurrently against pinned publication during active sync (FrontDoor)', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-concurrent-reads-'));
    const preparedRead = {
        state: 'ready' as const,
        root: { path: tempRoot, info: { status: 'indexed' as const } },
        proofDebugHint: undefined,
        publication: publicationRef(tempRoot, 'publication-15', 'col_gen_15', 'pol-15'),
        navigationStatus: 'valid' as const,
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
        assessSearchFreshness: async () => {
            throw new Error('assessSearchFreshness should not be invoked during stale-while-sync');
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
                assert.equal(res.freshnessDecision.servedPublicationId, 'publication-15');
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
                    servedPublicationId: 'publication-15',
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

        const publicationN = publicationRef(tempRoot, 'publication-n', 'col_gen_n', 'pol-n', 10);
        const publicationN1 = publicationRef(tempRoot, 'publication-n1', 'col_gen_n1', 'pol-n1', 12);

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
            capabilities,
            runtimeFingerprint: { schemaVersion: "hybrid-v1" } as any,
            reranker: null,
            gitignoreForceReloadEveryN: 1000,
        });

        const toolResponseBuilders = new ToolResponseBuilders({
            buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
            buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
            buildReindexHint: () => ({ tool: 'manage_index', args: { action: 'reindex', path: tempRoot } }),
            buildSyncHint: () => ({ tool: 'manage_index', args: { action: 'sync', path: tempRoot } }),
            buildStatusHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            buildStaleLocalMessage: () => '',
            buildIndexingMetadata: () => ({ formatVersion: 'test' } as any),
            buildCompatibilityDiagnostics: () => ({ status: 'valid' } as any),
            buildRuntimeMismatchHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            isRuntimeFingerprintMismatch: () => false,
            summarizeFingerprint: () => 'fp',
        } as any);

        coordinator = new SearchRequestCoordinator({
            readiness: {
                touchWatchedCodebaseBestEffort: async () => {},
                assessReadFreshness: async () => ({
                    mode: 'read_only',
                    checkedAt: new Date().toISOString(),
                    thresholdMs: 0,
                    sourceFreshness: { state: 'verified', reason: 'watcher_continuity' },
                }),
                prepareTrackedRootReadWithObservation: async (): Promise<any> => {
                    const isN = currentGeneration === 'N';
                    const publication = isN ? publicationN : publicationN1;
                    const ready = {
                        state: 'ready' as const,
                        root: { path: tempRoot, info: { status: 'indexed' as const } },
                        proofDebugHint: undefined,
                        publication,
                        navigationStatus: 'valid' as const,
                        navigationAuthorityMode: 'canonical_v4' as const,
                    };
                    return isN
                        ? {
                            state: 'indexing' as const,
                            codebasePath: tempRoot,
                            operation: { action: 'sync' as const, generation: 16, phase: 'writing' },
                            searchableGenerationAvailable: true,
                            searchableRead: ready,
                        }
                        : ready;
                },
                loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: false }),
                getWatcherObservation: () => ({ coverage: 'ready', available: true, snapshot: 'watch' } as any),
                getChangedFilesForCodebase: () => ({ available: true, files: new Set() }),
                getTrackedRootReadiness: () => ({} as any),
                isPartialIndexNavigationUnavailable: () => false,
                getIndexingOperationForReadiness: () => undefined,
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
                buildRelationshipBackedCallGraph: async () => null,
                buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
                buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
                sanitizeIndexedRelativeFilePath: (f) => f,
            },
            preparedRead: {
                loadPreparedNavigationManifest: async (): Promise<any> => ({ status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }),
                getPreparedAuthorityObservation: () => currentAuthorityObservation,
                getPublicationNavigationAddress: (publication) => ({
                    publicationId: publication.id,
                    navigationRoot: path.join(tempRoot, '.navigation', publication.id),
                }),
                seedPreparedRead: () => {},
                evictPreparedRead: () => {},
                loadPreparedNavigationCompatibility: async (): Promise<any> => ({ status: 'incompatible', reason: 'unsupported', rootPath: tempRoot, registry: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }, relationships: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot } }),
                getCachedPreparedRead: async (): Promise<any> => ({ status: 'miss', reason: 'cold_initial' }),
                acquirePublicationLease: (_codebasePath, publicationId) => {
                    const publication = publicationId === undefined
                        ? (currentGeneration === 'N+1' ? publicationN1 : publicationN)
                        : (publicationId === publicationN1.id ? publicationN1 : publicationN);
                    const leaseId = 'lease-' + Math.random();
                    activeLeases.add(leaseId);
                    return {
                        ...publication,
                        release: () => activeLeases.delete(leaseId),
                    } satisfies PublicationLease;
                },
                isPublicationLeaseAdmitted: async () => true,
                isPublicationAdmitted: async () => true,
                getPublicationNavigationStatus: async () => 'valid',
            },
            freshness: {
                inspectSourceFreshnessCheckpoint: async () => ({} as any),
                compareAllSourceToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourceObservationToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourcePathsToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
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
                semanticSearchInPublication: async (publication) => {
                    const collectionName = publication.publication.vector.collectionName;
                    if (collectionName === 'col_gen_n') {
                        boundCollectionsForA.push(collectionName);
                        searchAInFlightResolve();
                        await releaseSearchA;
                    } else if (collectionName === 'col_gen_n1') {
                        boundCollectionsForB.push(collectionName);
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

        const publicationN = publicationRef(tempRoot, 'publication-n', 'col_gen_n', 'pol-n', 10);
        const publicationN1 = publicationRef(tempRoot, 'publication-n1', 'col_gen_n1', 'pol-n1', 12);

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
            capabilities,
            runtimeFingerprint: { schemaVersion: "hybrid-v1" } as any,
            reranker: null,
            gitignoreForceReloadEveryN: 1000,
        });

        const toolResponseBuilders = new ToolResponseBuilders({
            buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
            buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
            buildReindexHint: () => ({ tool: 'manage_index', args: { action: 'reindex', path: tempRoot } }),
            buildSyncHint: () => ({ tool: 'manage_index', args: { action: 'sync', path: tempRoot } }),
            buildStatusHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            buildStaleLocalMessage: () => '',
            buildIndexingMetadata: () => ({ formatVersion: 'test' } as any),
            buildCompatibilityDiagnostics: () => ({ status: 'valid' } as any),
            buildRuntimeMismatchHint: () => ({ tool: 'manage_index', args: { action: 'status', path: tempRoot } }),
            isRuntimeFingerprintMismatch: () => false,
            summarizeFingerprint: () => 'fp',
        } as any);

        coordinator = new SearchRequestCoordinator({
            readiness: {
                touchWatchedCodebaseBestEffort: async () => {},
                assessReadFreshness: async () => ({
                    mode: 'read_only',
                    checkedAt: new Date().toISOString(),
                    thresholdMs: 0,
                    sourceFreshness: { state: 'verified', reason: 'watcher_continuity' },
                }),
                prepareTrackedRootReadWithObservation: async (): Promise<any> => {
                    const isN = currentGeneration === 'N';
                    const publication = isN ? publicationN : publicationN1;
                    const ready = {
                        state: 'ready' as const,
                        root: { path: tempRoot, info: { status: 'indexed' as const } },
                        proofDebugHint: undefined,
                        publication,
                        navigationStatus: 'valid' as const,
                        navigationAuthorityMode: 'canonical_v4' as const,
                    };
                    return isN
                        ? {
                            state: 'indexing' as const,
                            codebasePath: tempRoot,
                            operation: { action: 'sync' as const, generation: 11, phase: 'writing' },
                            searchableGenerationAvailable: true,
                            searchableRead: ready,
                        }
                        : ready;
                },
                loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: false }),
                getWatcherObservation: () => ({ coverage: 'ready', available: true, snapshot: 'watch' } as any),
                getChangedFilesForCodebase: () => ({ available: true, files: new Set() }),
                getTrackedRootReadiness: () => ({} as any),
                isPartialIndexNavigationUnavailable: () => false,
                getIndexingOperationForReadiness: () => undefined,
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
                buildRelationshipBackedCallGraph: async () => null,
                buildManageIndexRecommendedAction: () => ({ action: 'none', label: '' } as any),
                buildCreateHint: () => ({ tool: 'manage_index', args: { action: 'create', path: tempRoot } }),
                sanitizeIndexedRelativeFilePath: (f) => f,
            },
            preparedRead: {
                loadPreparedNavigationManifest: async (): Promise<any> => ({ status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }),
                getPreparedAuthorityObservation: () => currentAuthorityObservation,
                getPublicationNavigationAddress: (publication) => ({
                    publicationId: publication.id,
                    navigationRoot: path.join(tempRoot, '.navigation', publication.id),
                }),
                seedPreparedRead: () => {},
                evictPreparedRead: () => {},
                loadPreparedNavigationCompatibility: async (): Promise<any> => ({ status: 'incompatible', reason: 'unsupported', rootPath: tempRoot, registry: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot }, relationships: { status: 'unavailable', reason: 'unsupported', rootPath: tempRoot } }),
                getCachedPreparedRead: async (): Promise<any> => ({ status: 'miss', reason: 'cold_initial' }),
                acquirePublicationLease: (_codebasePath, publicationId) => {
                    const publication = publicationId === undefined
                        ? (currentGeneration === 'N+1' ? publicationN1 : publicationN)
                        : (publicationId === publicationN1.id ? publicationN1 : publicationN);
                    return { ...publication, release: () => undefined } satisfies PublicationLease;
                },
                isPublicationLeaseAdmitted: async () => true,
                isPublicationAdmitted: async () => true,
                getPublicationNavigationStatus: async () => 'valid',
            },
            freshness: {
                inspectSourceFreshnessCheckpoint: async () => ({} as any),
                compareAllSourceToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourceObservationToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
                compareSourcePathsToFreshnessCheckpoint: async () => ({ status: 'matches', changedFiles: [] } as any),
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
                semanticSearchInPublication: async (publication) => {
                    servedCollections.push(publication.publication.vector.collectionName);
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
