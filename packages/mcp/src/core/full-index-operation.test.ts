import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
    computeIndexPolicyControlSignature,
    createIndexMutationPort,
    FileSynchronizer,
    IndexPolicyPublicationError,
    observeIndexPolicyInputs,
} from "@zokizuan/satori-core";
import type {
    IndexCompletionMarkerDocument,
    IndexMutationPortDependencies,
    IndexPolicyPublicationReceipt,
} from "@zokizuan/satori-core";
import {
    FullIndexOperation,
    type FullIndexOperationHost,
} from "./full-index-operation.js";
import type {
    IndexFingerprint,
    IndexOperationPhase,
    IndexOperationReceipt,
} from "../config.js";
import {
    MutationLeaseCoordinator,
    type RootMutationLease,
} from "./mutation-lease.js";
import type {
    CandidateWatcherPolicy,
    FullIndexSourceHandoffBarrierInput,
    FullIndexSourceHandoffInput,
    WatcherBootstrapCapture,
} from "./sync.js";

type PublishedPolicyBinding = {
    collectionName: string;
    navigation:
        | { status: "not_bound" }
        | { status: "sealed"; generationId: string; sealHash: string };
    publication?: {
        activationId: string;
        sourceCheckpoint?: unknown;
        graph?: unknown;
        receipt?: unknown;
    };
};

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: "VoyageAI",
    embeddingModel: "voyage-code-3",
    embeddingDimension: 1024,
    embeddingArtifactDigest: null,
    embeddingNormalizationPolicy: "provider_output_v1",
    vectorStoreProvider: "Milvus",
    schemaVersion: "hybrid_v3",
    parserVersion: "parser-v1",
    extractorVersion: "extractor-v1",
    relationshipVersion: "relationships-v1",
    embeddingProjectionVersion: "embedding-projection-v1",
    lexicalProjectionVersion: "lexical-projection-v1",
};

const DEFAULT_INDEX_SOURCE = "export const value = 1;\n";

function sourceHashes(sources: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
    return new Map(Object.entries(sources).map(([relativePath, content]) => [
        relativePath,
        crypto.createHash("sha256").update(content).digest("hex"),
    ]));
}

function completedIndexResult(
    sources: Readonly<Record<string, string>> = { "index.ts": DEFAULT_INDEX_SOURCE },
    options: { totalChunks?: number } = {},
) {
    return {
        indexedFiles: Object.keys(sources).length,
        totalChunks: options.totalChunks ?? Object.keys(sources).length,
        status: "completed" as const,
        indexedFileHashes: sourceHashes(sources),
    };
}

function resolveCollectionName(codebasePath: string): string {
    const digest = crypto.createHash("md5").update(path.resolve(codebasePath)).digest("hex").slice(0, 8);
    return `hybrid_code_chunks_${digest}`;
}

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-mcp-full-index-op-"));
    const repoPath = path.join(tempDir, "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "index.ts"), DEFAULT_INDEX_SOURCE);
    return fn(repoPath).finally(async () => {
        await FileSynchronizer.deleteSnapshot(repoPath);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function buildMarker(
    codebasePath: string,
    overrides: {
        indexedFiles?: number;
        totalChunks?: number;
        indexStatus?: string;
        indexPolicyHash?: string;
        runId?: string;
        navigation?: {
            status: string;
            generationId?: string;
            symbolRegistryManifestHash?: string;
            relationshipManifestHash?: string;
            sealHash?: string;
        };
    } = {},
) {
    return {
        kind: 'satori_index_completion_v3' as const,
        codebasePath,
        fingerprint: RUNTIME_FINGERPRINT,
        indexedFiles: overrides.indexedFiles ?? 1,
        totalChunks: overrides.totalChunks ?? 1,
        completedAt: new Date(0).toISOString(),
        runId: overrides.runId ?? 'test-run',
        indexPolicyHash: overrides.indexPolicyHash ?? 'a'.repeat(64),
        indexStatus: (overrides.indexStatus ?? 'completed') as "completed" | "limit_reached",
        navigation: (overrides.navigation ?? {
            status: 'sealed' as const,
            generationId: 'candidate-generation',
            symbolRegistryManifestHash: 'manifest-hash',
            relationshipManifestHash: 'relationship-manifest-hash',
            sealHash: 'navigation-seal-hash',
        }) as IndexCompletionMarkerDocument["navigation"],
    };
}

function createFullIndexHarness(
    existingCollections: Set<string> = new Set(),
    options: {
        mutationLeaseCoordinator?: MutationLeaseCoordinator;
        indexCodebase?: (
            codebasePath: string,
            progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
            forceReindex?: boolean,
            mutationOptions?: {
                assertMutationCurrent?: () => void;
                publishMutation?: (publish: () => void) => void;
            },
        ) => Promise<{
            indexedFiles: number;
            totalChunks: number;
            status: "completed" | "limit_reached";
            indexedFileHashes: ReadonlyMap<string, string>;
        }>;
        beforeHasCollection?: (collectionName: string) => void;
        touchWatchedCodebase?: (
            codebasePath: string,
            candidatePolicy?: CandidateWatcherPolicy,
        ) => Promise<void>;
        captureWatcherBootstrap?: (
            codebasePath: string,
            candidatePolicyHash: string,
        ) => WatcherBootstrapCapture | undefined;
        beginFullIndexSourceHandoff?: (
            codebasePath: string,
            input: FullIndexSourceHandoffBarrierInput,
            mutationLease?: RootMutationLease,
        ) => void;
        rejectFullIndexSourceHandoff?: (
            codebasePath: string,
            input: FullIndexSourceHandoffBarrierInput,
            mutationLease?: RootMutationLease,
        ) => boolean;
        completeFullIndexSourceHandoff?: (
            codebasePath: string,
            input: FullIndexSourceHandoffInput,
            mutationLease?: RootMutationLease,
        ) => Promise<boolean>;
        restoreActiveWatcherPolicy?: (
            codebasePath: string,
            candidatePolicyHash: string,
        ) => Promise<boolean>;
        unwatchCodebase?: (codebasePath: string) => Promise<void>;
        rebuildCallGraphForIndex?: () => Promise<void>;
        publishNavigationCandidate?: (candidate: { generationId: string }) => Promise<void>;
        pruneIndexedCollectionFamily?: (keepCollectionName: string) => Promise<string[]>;
        previousIndexedInfo?: Record<string, unknown>;
        initialCustomExtensions?: string[];
        initialCustomIgnorePatterns?: string[];
        failPolicyPublicationAfterCommit?: boolean;
        omitPolicyPublicationDocumentDigest?: boolean;
        policyPublicationDocumentDigest?: string;
        legacyRollback?: boolean;
        proveVectorGenerationError?: Error;
        recordCurrentIgnoreControlSignature?: (observedSignature?: string) => Promise<void>;
        captureOperationPhases?: boolean;
        startBackgroundIndexing?: (
            codebasePath: string,
            forceReindex: boolean,
            writeCollectionName?: string,
            mutationLease?: RootMutationLease,
        ) => Promise<void> | void;
    } = {},
) {
    const droppedCollections: string[] = [];
    const failedSnapshots: Array<{ path: string; errorMessage: string; progress?: number }> = [];
    const indexingProgress: number[] = [];
    const publicationEvents: string[] = [];
    const authorityEvents: string[] = [];
    const clearedExpectedDocumentDigests: Array<string | undefined> = [];
    let publishedCustomExtensions = [...(options.initialCustomExtensions ?? [])];
    let publishedCustomIgnorePatterns = [...(options.initialCustomIgnorePatterns ?? [])];
    let standardPolicyResolutionCalls = 0;
    let reindexPolicyResolutionCalls = 0;
    let indexedSnapshots = 0;
    let registeredSynchronizers = 0;
    let completionMarkerClearCalls = 0;
    let publishedPolicyCollection: string | null = null;
    let publishedPolicyHash: string | null = null;
    let publishedPolicyControlSignature: string | null = null;
    let publishedPolicyDocumentDigest: string | null = null;
    let publishedPolicyBinding: PublishedPolicyBinding | null = null;
    let publishedMarker: ReturnType<typeof buildMarker> | null = null;
    let publishedMarkerCollection: string | null = null;
    let navigationPublished = false;
    let lifecycle: "indexing" | "indexed" | "indexfailed" = "indexing";
    let latestOperation: IndexOperationReceipt | undefined;
    const publishedSnapshots: Array<{ status: string; collectionName?: string }> = [];
    const resolvedPolicyObservations: Array<{
        policyHash: string;
        fileBasedIgnorePatterns: string[];
        controlSignature: string;
    }> = [];

    const vectorStore = {
        hasCollection: async (collectionName: string) => {
            options.beforeHasCollection?.(collectionName);
            return existingCollections.has(collectionName);
        },
        dropCollection: async (collectionName: string) => {
            droppedCollections.push(collectionName);
            existingCollections.delete(collectionName);
        },
    };

    const indexMutationPort = createIndexMutationPort({
        checkCollectionLimit: async () => true,
        deleteCollectionWithVerification: async (
            collectionName: string,
            deleteOptions?: { beforeDropAttempt?: () => void },
        ) => {
            if (!await vectorStore.hasCollection(collectionName)) {
                return { collectionName, attempts: 0, verifiedAbsent: true };
            }
            deleteOptions?.beforeDropAttempt?.();
            await vectorStore.dropCollection(collectionName);
            return { collectionName, attempts: 1, verifiedAbsent: true };
        },
        prepareIndexCollection: async (
            codebasePath: string,
            binding: { generation: number; operationId: string; collectionName: string },
            assertMutationCurrent?: () => void,
        ) => {
            assertMutationCurrent?.();
            existingCollections.add(binding.collectionName);
            return Object.freeze({
                canonicalRoot: path.resolve(codebasePath),
                collectionName: binding.collectionName,
                generation: binding.generation,
                operationId: binding.operationId,
            });
        },
        discardPreparedIndexCollection: () => undefined,
        indexCompletionMarkersEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
        resolveIndexPolicyForCodebase: async (_root: string, update: { customExtensions?: string[]; customIgnorePatterns?: string[] } = {}) => {
            standardPolicyResolutionCalls += 1;
            const observed = await observeIndexPolicyInputs(path.resolve(_root));
            const customIgnorePatterns = update.customIgnorePatterns ?? publishedCustomIgnorePatterns;
            const policy = {
                canonicalRoot: path.resolve(_root),
                profile: observed.profileConfig.profile,
                customExtensions: update.customExtensions ?? publishedCustomExtensions,
                customIgnorePatterns,
                supportedExtensions: ['.ts', ...(update.customExtensions ?? publishedCustomExtensions)],
                fileBasedIgnorePatterns: [...observed.fileBasedIgnorePatterns],
                effectiveIgnorePatterns: [...customIgnorePatterns, ...observed.fileBasedIgnorePatterns],
                policyHash: crypto.createHash('sha256').update(JSON.stringify({
                    update,
                    profile: observed.profileConfig.profile,
                    fileBasedIgnorePatterns: observed.fileBasedIgnorePatterns,
                })).digest('hex'),
                controlSignature: observed.controlSignature,
            };
            resolvedPolicyObservations.push({
                policyHash: policy.policyHash,
                fileBasedIgnorePatterns: [...policy.fileBasedIgnorePatterns],
                controlSignature: policy.controlSignature,
            });
            return policy;
        },
        resolveIndexPolicyForReindex: async (_root: string, update: { customExtensions?: string[]; customIgnorePatterns?: string[] } = {}) => {
            reindexPolicyResolutionCalls += 1;
            const observed = await observeIndexPolicyInputs(path.resolve(_root));
            const customIgnorePatterns = update.customIgnorePatterns ?? [];
            const policy = {
                canonicalRoot: path.resolve(_root),
                profile: observed.profileConfig.profile,
                customExtensions: update.customExtensions ?? [],
                customIgnorePatterns,
                supportedExtensions: ['.ts', ...(update.customExtensions ?? [])],
                fileBasedIgnorePatterns: [...observed.fileBasedIgnorePatterns],
                effectiveIgnorePatterns: [...customIgnorePatterns, ...observed.fileBasedIgnorePatterns],
                policyHash: crypto.createHash('sha256').update(JSON.stringify({
                    update,
                    profile: observed.profileConfig.profile,
                    fileBasedIgnorePatterns: observed.fileBasedIgnorePatterns,
                })).digest('hex'),
                controlSignature: observed.controlSignature,
            };
            resolvedPolicyObservations.push({
                policyHash: policy.policyHash,
                fileBasedIgnorePatterns: [...policy.fileBasedIgnorePatterns],
                controlSignature: policy.controlSignature,
            });
            return policy;
        },
        isObservedIndexPolicyControlSignatureCurrent: async (policy: { canonicalRoot: string; controlSignature: string }) => (
            await computeIndexPolicyControlSignature(policy.canonicalRoot)
        ) === policy.controlSignature,
        publishResolvedIndexPolicy: (
            policy: { canonicalRoot: string; policyHash: string; controlSignature?: string; customExtensions: string[]; customIgnorePatterns: string[] },
            binding: PublishedPolicyBinding,
            publishMutation?: (publish: () => void) => void,
        ) => {
            const receipt = {
                status: 'committed' as const,
                operation: 'publish' as const,
                canonicalRoot: policy.canonicalRoot,
                ...(options.omitPolicyPublicationDocumentDigest
                    ? {}
                    : { documentDigest: options.policyPublicationDocumentDigest ?? 'a'.repeat(64) }),
                policyHash: policy.policyHash,
                collectionName: binding.collectionName,
                navigation: { ...binding.navigation },
                ...(binding.publication ? { publication: structuredClone(binding.publication) } : {}),
            } as Extract<IndexPolicyPublicationReceipt, { operation: 'publish' }>;
            const publish = () => {
                publishedCustomExtensions = [...policy.customExtensions];
                publishedCustomIgnorePatterns = [...policy.customIgnorePatterns];
                publishedPolicyCollection = binding.collectionName;
                publishedPolicyHash = policy.policyHash;
                publishedPolicyControlSignature = policy.controlSignature ?? null;
                publishedPolicyDocumentDigest = receipt.documentDigest ?? null;
                publishedPolicyBinding = structuredClone(binding);
                publicationEvents.push('policy:publish');
            };
            if (publishMutation) {
                publishMutation(publish);
            } else {
                publish();
            }
            if (options.failPolicyPublicationAfterCommit) {
                throw new IndexPolicyPublicationError(
                    'policy committed before acknowledgement failed',
                    receipt,
                    new Error('publication wrapper rejected receipt'),
                );
            }
            return receipt;
        },
        captureDurableIndexAuthority: () => {
            authorityEvents.push('capture');
            return {
                canonicalRoot: '/test/repo',
                policyDocument: { content: '{"legacyPolicy":true}', digest: 'b'.repeat(64) },
                navigationPointer: { content: '{"legacyPointer":true}', digest: 'c'.repeat(64) },
                testPolicy: {
                    customExtensions: [...publishedCustomExtensions],
                    customIgnorePatterns: [...publishedCustomIgnorePatterns],
                },
            };
        },
        restoreDurableIndexAuthority: async (snapshot: { testPolicy?: { customExtensions: string[]; customIgnorePatterns: string[] } }) => {
            authorityEvents.push('restore');
            publishedCustomExtensions = [...(snapshot.testPolicy?.customExtensions ?? [])];
            publishedCustomIgnorePatterns = [...(snapshot.testPolicy?.customIgnorePatterns ?? [])];
        },
        registerSynchronizer: () => {
            registeredSynchronizers += 1;
        },
        describeEmbeddingProvider: () => ({
            provider: "VoyageAI",
            dimension: 1024,
        }),
        indexCodebase: async (...args: Parameters<NonNullable<typeof options.indexCodebase>>) => {
            const indexOptions = args[3] as { writeCollectionName?: string } | undefined;
            if (indexOptions?.writeCollectionName) {
                existingCollections.add(indexOptions.writeCollectionName);
            }
            const result = options.indexCodebase
                ? await options.indexCodebase(...args)
                : await Promise.reject(new Error("boom after staged collection create"));
            return result.status === "completed"
                ? {
                    ...result,
                    navigationCandidate: {
                        rootPath: "/tmp/navigation",
                        normalizedRootPath: args[0],
                        manifestHash: "manifest-hash",
                        relationshipManifestHash: "relationship-manifest-hash",
                        generationId: "candidate-generation",
                        fileShardCount: 1,
                        symbolCount: 1,
                        relationshipCount: 0,
                        relationshipFileShardCount: 1,
                    },
                }
                : result;
        },
        publishCompletedIndexMarker: async (_path: string, _files: number, _chunks: number, _collection: string, status: string, _guard?: unknown, _candidate?: unknown, policyHash?: string, runId?: string) => {
            publishedMarkerCollection = _collection;
            publishedMarker = buildMarker("repo", {
                indexedFiles: _files,
                totalChunks: _chunks,
                indexStatus: status,
                indexPolicyHash: policyHash ?? 'a'.repeat(64),
                runId: runId ?? 'run_candidate',
                navigation: status === "completed"
                    ? {
                        status: "sealed",
                        generationId: "candidate-generation",
                        symbolRegistryManifestHash: "manifest-hash",
                        relationshipManifestHash: "relationship-manifest-hash",
                        sealHash: "navigation-seal-hash",
                    }
                    : { status: "not_bound" },
            });
            publicationEvents.push(`marker:${status}`);
        },
        publishNavigationCandidate: async (candidate: { generationId: string }) => {
            publicationEvents.push(`navigation:publish:${candidate.generationId}`);
            await options.publishNavigationCandidate?.(candidate);
            navigationPublished = true;
        },
        discardNavigationCandidate: async (candidate: { generationId: string }) => {
            publicationEvents.push(`navigation:discard:${candidate.generationId}`);
        },
        proveVectorGeneration: async (root: string) => {
            if (
                publishedMarker
                && publishedMarkerCollection
                && publishedPolicyCollection === publishedMarkerCollection
                && publishedPolicyHash === publishedMarker.indexPolicyHash
            ) {
                return {
                    collectionName: publishedMarkerCollection,
                    marker: publishedMarker,
                    policyDocumentDigest: publishedPolicyDocumentDigest ?? 'a'.repeat(64),
                    policy: {
                        canonicalRoot: path.resolve(root),
                        profile: 'default' as const,
                        customExtensions: [...publishedCustomExtensions],
                        customIgnorePatterns: [...publishedCustomIgnorePatterns],
                        fileBasedIgnorePatterns: [],
                        supportedExtensions: ['.ts', ...publishedCustomExtensions],
                        effectiveIgnorePatterns: [...publishedCustomIgnorePatterns],
                        policyHash: publishedPolicyHash,
                        ...(publishedPolicyControlSignature
                            ? { controlSignature: publishedPolicyControlSignature }
                            : {}),
                    },
                };
            }
            if (options.proveVectorGenerationError) throw options.proveVectorGenerationError;
            if (!options.previousIndexedInfo || typeof options.previousIndexedInfo.collectionName !== 'string') return null;
            return {
                collectionName: options.previousIndexedInfo.collectionName,
                marker: buildMarker('repo', {
                    indexedFiles: Number(options.previousIndexedInfo.indexedFiles ?? 0),
                    totalChunks: Number(options.previousIndexedInfo.totalChunks ?? 0),
                    indexStatus: 'completed' as const,
                }),
                policy: {
                    canonicalRoot: path.resolve(root),
                    profile: 'default' as const,
                    customExtensions: [...publishedCustomExtensions],
                    customIgnorePatterns: [...publishedCustomIgnorePatterns],
                    fileBasedIgnorePatterns: [],
                    supportedExtensions: ['.ts', ...publishedCustomExtensions],
                    effectiveIgnorePatterns: [...publishedCustomIgnorePatterns],
                    policyHash: 'policy-hash',
                },
            };
        },
        proveIndexedGeneration: async (root: string) => {
            if (!navigationPublished) return null;
            return indexMutationPort.proveVectorGeneration(root);
        },
    } as unknown as IndexMutationPortDependencies);

    const host: FullIndexOperationHost = {
        indexMutationPort,
        snapshotManager: {
            setCodebaseIndexing: (_codebasePath: string, progress: number) => {
                lifecycle = "indexing";
                indexingProgress.push(progress);
            },
            setCodebaseIndexFailed: (codebasePath: string, errorMessage: string, progress?: number) => {
                lifecycle = "indexfailed";
                failedSnapshots.push({ path: codebasePath, errorMessage, progress });
            },
            setCodebaseIndexed: (_path: string, stats: { status: string }, _fingerprint?: unknown, _source?: unknown, collectionName?: string) => {
                lifecycle = "indexed";
                indexedSnapshots += 1;
                publishedSnapshots.push({ status: stats.status, collectionName });
            },
            setCodebaseIndexManifest: () => undefined,
            setCodebaseCallGraphSidecar: () => undefined,
            ...(options.captureOperationPhases ? {
                getLatestOperation: () => latestOperation,
                startOperation: (lease: RootMutationLease) => {
                    latestOperation = {
                        id: lease.operationId,
                        action: lease.action,
                        canonicalRoot: lease.canonicalRoot,
                        generation: lease.generation,
                        acceptedAt: lease.acquiredAt,
                        phase: "accepted",
                        lastDurableTransitionAt: lease.acquiredAt,
                        runtimeFingerprint: RUNTIME_FINGERPRINT,
                        writer: {
                            ownerId: lease.ownerId,
                            pid: lease.pid,
                            satoriVersion: "test",
                        },
                    };
                    return latestOperation;
                },
                transitionOperation: (lease: RootMutationLease, phase: IndexOperationPhase) => {
                    if (!latestOperation) {
                        latestOperation = {
                            id: lease.operationId,
                            action: lease.action,
                            canonicalRoot: lease.canonicalRoot,
                            generation: lease.generation,
                            acceptedAt: lease.acquiredAt,
                            phase,
                            lastDurableTransitionAt: new Date().toISOString(),
                            runtimeFingerprint: RUNTIME_FINGERPRINT,
                            writer: {
                                ownerId: lease.ownerId,
                                pid: lease.pid,
                                satoriVersion: "test",
                            },
                        };
                    } else {
                        latestOperation = {
                            ...latestOperation,
                            phase,
                            lastDurableTransitionAt: new Date().toISOString(),
                        };
                    }
                    return latestOperation;
                },
                saveCodebaseSnapshot: () => true,
            } : {}),
        } as unknown as FullIndexOperationHost["snapshotManager"],
        syncManager: {
            recordCurrentIgnoreControlSignature: options.recordCurrentIgnoreControlSignature
                ?? (async () => undefined),
            recordObservedIgnoreControlSignature: async (
                _codebasePath: string,
                observedSignature: string,
            ) => options.recordCurrentIgnoreControlSignature?.(observedSignature),
            touchWatchedCodebase: async (
                codebasePath: string,
                candidatePolicy?: CandidateWatcherPolicy,
            ) => options.touchWatchedCodebase?.(codebasePath, candidatePolicy),
            captureWatcherBootstrap: (
                codebasePath: string,
                candidatePolicyHash: string,
            ) => options.captureWatcherBootstrap?.(codebasePath, candidatePolicyHash),
            beginFullIndexSourceHandoff: (
                codebasePath: string,
                input: FullIndexSourceHandoffBarrierInput,
                mutationLease?: RootMutationLease,
            ) => options.beginFullIndexSourceHandoff?.(codebasePath, input, mutationLease),
            rejectFullIndexSourceHandoff: (
                codebasePath: string,
                input: FullIndexSourceHandoffBarrierInput,
                mutationLease?: RootMutationLease,
            ) => options.rejectFullIndexSourceHandoff?.(codebasePath, input, mutationLease) ?? true,
            completeFullIndexSourceHandoff: async (
                codebasePath: string,
                input: FullIndexSourceHandoffInput,
                mutationLease?: RootMutationLease,
            ) => options.completeFullIndexSourceHandoff?.(
                codebasePath,
                input,
                mutationLease,
            ) ?? false,
            restoreActiveWatcherPolicy: async (
                codebasePath: string,
                candidatePolicyHash: string,
            ) => options.restoreActiveWatcherPolicy?.(
                codebasePath,
                candidatePolicyHash,
            ) ?? true,
            unwatchCodebase: async (codebasePath: string) => options.unwatchCodebase?.(codebasePath),
        } as unknown as FullIndexOperationHost["syncManager"],
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        resolveCollectionName,
        getSnapshotCodebaseInfo: () => options.previousIndexedInfo,
        pruneIndexedCollectionFamily: async (_codebasePath: string, keepCollectionName: string) =>
            options.pruneIndexedCollectionFamily?.(keepCollectionName) ?? [],
        getContextTrackedRelativePaths: () => [],
        setIndexingStats: () => undefined,
        rebuildCallGraphForIndex: options.rebuildCallGraphForIndex ?? (async () => undefined),
        saveSnapshotIfSupported: () => undefined,
        clearIndexCompletionMarker: async () => {
            completionMarkerClearCalls += 1;
        },
        getSnapshotIndexingProgress: () => 42,
        buildCollectionLimitMessage: async () => "collection limit",
        mutationLeaseCoordinator: options.mutationLeaseCoordinator,
        ...(options.startBackgroundIndexing ? {
            startBackgroundIndexing: options.startBackgroundIndexing,
        } : {}),
    };

    const operation = new FullIndexOperation(host);

    return {
        droppedCollections,
        failedSnapshots,
        indexingProgress,
        get lifecycle() {
            return lifecycle;
        },
        get latestOperation() {
            return latestOperation;
        },
        get indexedSnapshots() {
            return indexedSnapshots;
        },
        get registeredSynchronizers() {
            return registeredSynchronizers;
        },
        get completionMarkerClearCalls() {
            return completionMarkerClearCalls;
        },
        get publishedMarker() {
            return publishedMarker;
        },
        get publishedPolicyBinding() {
            return publishedPolicyBinding;
        },
        get reindexPolicyResolutionCalls() {
            return reindexPolicyResolutionCalls;
        },
        get standardPolicyResolutionCalls() {
            return standardPolicyResolutionCalls;
        },
        publishedSnapshots,
        resolvedPolicyObservations,
        publicationEvents,
        authorityEvents,
        clearedExpectedDocumentDigests,
        get publishedCustomExtensions() {
            return publishedCustomExtensions;
        },
        get publishedCustomIgnorePatterns() {
            return publishedCustomIgnorePatterns;
        },
        host,
        operation,
    };
}

test("background worker leaves lease release to its launcher", async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), "lease-state");
        const currentProcess = { pid: 101, processStartTime: "start-101" };
        const coordinator = new MutationLeaseCoordinator({
            stateDir,
            ownerId: "owner-a",
            currentProcess,
            processInspector: {
                inspect: (pid) => pid === currentProcess.pid ? currentProcess : null,
            },
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let finishIndexing!: (value: ReturnType<typeof completedIndexResult>) => void;
        const indexing = new Promise<ReturnType<typeof completedIndexResult>>((resolve) => {
            finishIndexing = resolve;
        });
        let signalIndexStarted!: () => void;
        const indexStarted = new Promise<void>((resolve) => {
            signalIndexStarted = resolve;
        });
        let indexPublicationRan = false;
        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: (_path, _progress, _force, mutationOptions) => {
                assert.equal(typeof mutationOptions?.assertMutationCurrent, "function");
                assert.equal(typeof mutationOptions?.publishMutation, "function");
                mutationOptions?.publishMutation?.(() => {
                    indexPublicationRan = true;
                });
                signalIndexStarted();
                return indexing;
            },
        });

        const background = harness.operation.run({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
        });
        await indexStarted;
        assert.equal(coordinator.isCurrent(acquired.lease), true);
        assert.equal(indexPublicationRan, true);

        finishIndexing(completedIndexResult());
        await background;
        assert.equal(coordinator.isCurrent(acquired.lease), true);
        coordinator.release(acquired.lease);
    });
});

test("FullIndexOperation.launch() executes scanning, indexing, publication, and terminal lease release", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "full-index-op-leases"),
            ownerId: "full-index-op-owner",
        });
        let releaseCalls = 0;
        const originalRelease = coordinator.release.bind(coordinator);
        coordinator.release = (lease) => {
            releaseCalls += 1;
            return originalRelease(lease);
        };

        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let workerFinishedResolve!: () => void;
        const workerFinished = new Promise<void>((resolve) => {
            workerFinishedResolve = resolve;
        });

        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            captureOperationPhases: true,
            indexCodebase: async () => completedIndexResult(),
            startBackgroundIndexing: async (codebasePath, forceReindex, writeCollectionName, mutationLease) => {
                try {
                    const op = new FullIndexOperation(harness.host);
                    return await op.run({
                        codebasePath,
                        forceReindex,
                        writeCollectionName,
                        mutationLease,
                    });
                } finally {
                    workerFinishedResolve();
                }
            },
        });

        harness.operation.launch({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
        });

        await workerFinished;
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(harness.lifecycle, "indexed");
        assert.equal(harness.indexedSnapshots, 1);
        assert.equal(harness.failedSnapshots.length, 0);
        assert.equal(harness.latestOperation?.phase, "completed");
        assert.equal(coordinator.getActiveLease(repoPath), undefined);
        assert.equal(releaseCalls, 1);
    });
});

test("FullIndexOperation.launch() catches detached worker rejection, persists failure, and releases lease", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "rejection-leases"),
            ownerId: "rejection-owner",
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let releaseCalls = 0;
        const originalRelease = coordinator.release.bind(coordinator);
        coordinator.release = (lease) => {
            releaseCalls += 1;
            return originalRelease(lease);
        };

        let rejectWorker!: (err: Error) => void;
        const workerPromise = new Promise<void>((_resolve, reject) => {
            rejectWorker = reject;
        });

        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            captureOperationPhases: true,
            startBackgroundIndexing: () => workerPromise,
        });

        harness.operation.launch({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
        });

        assert.equal(releaseCalls, 0);
        assert.ok(coordinator.getActiveLease(repoPath));

        rejectWorker(new Error("simulated detached background failure"));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(harness.lifecycle, "indexfailed");
        assert.equal(harness.failedSnapshots.length, 1);
        assert.match(harness.failedSnapshots[0].errorMessage, /simulated detached background failure/);
        assert.equal(coordinator.getActiveLease(repoPath), undefined);
        assert.equal(releaseCalls, 1);
    });
});

test("background full-index aborts and fails closed when lease is preempted during indexing", async () => {
    await withTempRepo(async (repoPath) => {
        const stateDir = path.join(path.dirname(repoPath), "lease-preempt-leases");
        const processes = new Map<number, { pid: number; processStartTime?: string }>([
            [101, { pid: 101, processStartTime: "start-101" }],
        ]);
        const processInspector = {
            inspect: (pid: number) => processes.get(pid) ?? null,
        };
        const coordinator = new MutationLeaseCoordinator({
            stateDir,
            ownerId: "lease-preempt-owner",
            currentProcess: { pid: 101, processStartTime: "start-101" },
            processInspector,
        });

        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            captureOperationPhases: true,
            indexCodebase: async (_path, _progress, _force, mutationOptions) => {
                processes.delete(101);
                processes.set(202, { pid: 202, processStartTime: "start-202" });
                const otherCoordinator = new MutationLeaseCoordinator({
                    stateDir,
                    ownerId: "preempting-owner",
                    currentProcess: { pid: 202, processStartTime: "start-202" },
                    processInspector,
                });
                const preemptAcquired = otherCoordinator.acquire(repoPath, "repair");
                assert.equal(preemptAcquired.acquired, true);

                mutationOptions?.assertMutationCurrent?.();
                return completedIndexResult();
            },
        });

        await harness.operation.run({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
        });

        assert.equal(harness.indexedSnapshots, 0);
        assert.notEqual(harness.latestOperation?.phase, "completed");
    });
});

test("background full-index detects source drift before commit and fails closed", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "source-drift-leases"),
            ownerId: "source-drift-owner",
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            captureOperationPhases: true,
            indexCodebase: async () => {
                fs.writeFileSync(path.join(repoPath, "index.ts"), "export const drifted = 2;\n");
                return completedIndexResult();
            },
        });

        await harness.operation.run({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
        });

        assert.equal(harness.indexedSnapshots, 0);
        assert.equal(harness.failedSnapshots.length, 1);
        assert.match(harness.failedSnapshots[0].errorMessage, /Source observation changed|Full index source changed/);
    });
});

test("background full-index handles auxiliary module files (go.mod) in checkpoint while vector-indexing searchable sources only", async () => {
    await withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, "main.go"), "package main\n");
        fs.writeFileSync(path.join(repoPath, "go.mod"), "module example.com/test\n\ngo 1.22\n");
        fs.rmSync(path.join(repoPath, "index.ts"), { force: true });

        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "aux-test-leases"),
            ownerId: "aux-test-owner",
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            captureOperationPhases: true,
            indexCodebase: async () => {
                // Vector indexing processes main.go only, leaving go.mod to auxiliary semantics
                return completedIndexResult({ "main.go": "package main\n" });
            },
        });

        await harness.operation.run({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
            policyUpdate: { customExtensions: [".go"] },
        });

        assert.equal(harness.indexedSnapshots, 1);
        assert.equal(harness.failedSnapshots.length, 0);
        assert.equal(harness.latestOperation?.phase, "completed");
    });
});

test("background full-index fails closed when indexed searchable source hash differs from checkpoint", async () => {
    await withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, "main.go"), "package main\n");
        fs.writeFileSync(path.join(repoPath, "go.mod"), "module example.com/test\n\ngo 1.22\n");
        fs.rmSync(path.join(repoPath, "index.ts"), { force: true });

        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "aux-diff-leases"),
            ownerId: "aux-diff-owner",
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            captureOperationPhases: true,
            indexCodebase: async () => {
                // Vector index returned a different hash for main.go
                return completedIndexResult({ "main.go": "package main // modified\n" });
            },
        });

        await harness.operation.run({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
            policyUpdate: { customExtensions: [".go"] },
        });

        assert.equal(harness.indexedSnapshots, 0);
        assert.equal(harness.failedSnapshots.length, 1);
        assert.match(harness.failedSnapshots[0].errorMessage, /Full index source changed/);
    });
});

test("background indexing treats candidate watcher setup as best effort before indexing", async () => {
    await withTempRepo(async (repoPath) => {
        const harness = createFullIndexHarness(new Set(), {
            indexCodebase: async () => completedIndexResult(),
            touchWatchedCodebase: async () => {
                throw new Error("watcher touch failed");
            },
        });

        await harness.operation.run({ codebasePath: repoPath, forceReindex: false });

        assert.equal(harness.indexedSnapshots, 1);
        assert.equal(harness.failedSnapshots.length, 0);
        assert.deepEqual(harness.publicationEvents, [
            "marker:completed",
            "policy:publish",
            "navigation:publish:candidate-generation",
        ]);
    });
});

test("background indexing reserves public 100 percent until publication completes", async () => {
    await withTempRepo(async (repoPath) => {
        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "progress-publication-leases"),
            ownerId: "progress-publication-owner",
        });
        const acquired = coordinator.acquire(repoPath, "create");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;

        let publicationEnteredResolve!: () => void;
        let releasePublication!: () => void;
        const publicationEntered = new Promise<void>((resolve) => {
            publicationEnteredResolve = resolve;
        });
        const publicationBarrier = new Promise<void>((resolve) => {
            releasePublication = resolve;
        });
        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            captureOperationPhases: true,
            indexCodebase: async (_codebasePath, onProgress) => {
                onProgress?.({
                    phase: "writing",
                    current: 1,
                    total: 1,
                    percentage: 100,
                });
                return completedIndexResult();
            },
            publishNavigationCandidate: async () => {
                publicationEnteredResolve();
                await publicationBarrier;
            },
        });

        const worker = harness.operation.run({
            codebasePath: repoPath,
            forceReindex: false,
            mutationLease: acquired.lease,
        });
        try {
            await publicationEntered;

            assert.equal(harness.latestOperation?.phase, "publishing");
            assert.equal(harness.lifecycle, "indexing");
            assert.equal(harness.indexedSnapshots, 0);
            assert.equal(harness.indexingProgress.at(-1), 99);
        } finally {
            releasePublication();
            await worker;
            coordinator.release(acquired.lease);
        }

        assert.equal(harness.latestOperation?.phase, "completed");
        assert.equal(harness.lifecycle, "indexed");
        assert.equal(harness.indexedSnapshots, 1);
    });
});

test("background reindex publishes an exact post-index source checkpoint with the new authority", async () => {
    await withTempRepo(async (repoPath) => {
        const sourcePath = path.join(repoPath, "index.ts");
        const staleSynchronizer = new FileSynchronizer(repoPath, [], [".ts"]);
        await staleSynchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(repoPath);
        const staleSnapshot = fs.readFileSync(snapshotPath, "utf8");
        fs.writeFileSync(sourcePath, "export const value = 2;\n", "utf8");

        const coordinator = new MutationLeaseCoordinator({
            stateDir: path.join(path.dirname(repoPath), "v4-full-index-leases"),
            ownerId: "v4-full-index-owner",
        });
        const acquired = coordinator.acquire(repoPath, "reindex");
        assert.equal(acquired.acquired, true);
        if (!acquired.acquired) return;
        const harness = createFullIndexHarness(new Set(), {
            mutationLeaseCoordinator: coordinator,
            indexCodebase: async () => completedIndexResult({ "index.ts": "export const value = 2;\n" }),
        });
        try {
            await harness.operation.run({
                codebasePath: repoPath,
                forceReindex: true,
                mutationLease: acquired.lease,
            });
        } finally {
            coordinator.release(acquired.lease);
        }

        const candidateCollection = resolveCollectionName(repoPath);
        const candidateSnapshotPath = FileSynchronizer.getSnapshotPathForGeneration(repoPath, candidateCollection);
        assert.equal(fs.readFileSync(snapshotPath, "utf8"), staleSnapshot);
        assert.equal(fs.existsSync(candidateSnapshotPath), true);
        const verifier = new FileSynchronizer(repoPath, [], [".ts"], {
            checkpointIdentity: candidateCollection,
            checkpointAuthority: {
                collectionName: candidateCollection,
                markerRunId: harness.publishedMarker?.runId ?? 'missing-run-id',
                indexPolicyHash: harness.publishedMarker?.indexPolicyHash ?? 'a'.repeat(64),
            },
        });
        await verifier.initialize();
        const verifiedChanges = await verifier.checkForChanges();
        assert.deepEqual(verifiedChanges.added, []);
        assert.deepEqual(verifiedChanges.removed, []);
        assert.deepEqual(verifiedChanges.modified, []);
    });
});

test("startBackgroundIndexing deletes failed staged collection", async () => {
    await withTempRepo(async (repoPath) => {
        const stagedCollection = `${resolveCollectionName(repoPath)}__gen_run_12345`;
        const existingCollections = new Set([stagedCollection]);
        const harness = createFullIndexHarness(existingCollections);

        await harness.operation.run({
            codebasePath: repoPath,
            forceReindex: false,
            writeCollectionName: stagedCollection,
        });

        assert.deepEqual(harness.droppedCollections, [stagedCollection]);
        assert.equal(existingCollections.has(stagedCollection), false);
    });
});

test("startBackgroundIndexing keeps stable collection after non-staged failure", async () => {
    await withTempRepo(async (repoPath) => {
        const stableCollection = resolveCollectionName(repoPath);
        const existingCollections = new Set([stableCollection]);
        const harness = createFullIndexHarness(existingCollections);

        await harness.operation.run({ codebasePath: repoPath, forceReindex: false });

        assert.deepEqual(harness.droppedCollections, []);
        assert.equal(existingCollections.has(stableCollection), true);
        assert.equal(harness.failedSnapshots.length, 1);
    });
});
