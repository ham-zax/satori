import * as crypto from "node:crypto";
import {
    COLLECTION_LIMIT_MESSAGE,
    IndexPolicyPublicationError,
    SynchronizerCheckpointPublicationError,
    isStagedGenerationCollectionName,
} from "@zokizuan/satori-core";
import {
    defaultSemanticLanguageRegistry,
} from "@zokizuan/satori-core/semantic";
import type {
    CanonicalPublicationBinding,
    CustomIndexPolicyUpdate,
    DurableIndexAuthoritySnapshot,
    IndexMutationPort,
    PreparedIndexCollectionReceipt,
    ProvenVectorGenerationReceipt,
    ObservedResolvedIndexPolicy,
    SourceFreshnessCheckpointAuthority,
    SourceFreshnessCheckpointEvidence,
    StagedNavigationSidecarGeneration,
    PreparedFileChangeSet,
    StagedSourceFreshnessCheckpoint,
    FileSynchronizer as FileSynchronizerType,
} from "@zokizuan/satori-core";
import type { SnapshotManager } from "./snapshot.js";
import type { SyncManager, WatcherBootstrapCapture } from "./sync.js";
import {
    indexFingerprintsEqual,
    parseIndexFingerprint,
    type IndexFingerprint,
    type IndexOperationPhase,
    type CallGraphSidecarInfo,
} from "../config.js";
import {
    MutationLeaseCoordinator,
    type RootMutationLease,
} from "./mutation-lease.js";

export interface FullIndexOperationInput {
    readonly codebasePath: string;
    readonly forceReindex: boolean;
    readonly writeCollectionName?: string;
    readonly mutationLease?: RootMutationLease;
    readonly previousIndexedInfo?: Record<string, unknown>;
    readonly policyUpdate?: CustomIndexPolicyUpdate;
    readonly preparedCollectionReceipt?: PreparedIndexCollectionReceipt;
}

export interface FullIndexOperationHost {
    readonly mutationLeaseCoordinator?: MutationLeaseCoordinator | null;
    readonly indexMutationPort: IndexMutationPort;
    readonly snapshotManager: SnapshotManager;
    readonly syncManager: SyncManager;
    readonly runtimeFingerprint: IndexFingerprint;
    readonly saveSnapshotIfSupported: () => void;
    readonly getSnapshotCodebaseInfo: (codebasePath: string) => Record<string, unknown> | undefined;
    readonly resolveCollectionName: (codebasePath: string) => string;
    readonly clearIndexCompletionMarker: (codebasePath: string, assertMutationCurrent?: () => void) => Promise<void>;
    readonly setIndexingStats: (stats: { indexedFiles: number; totalChunks: number } | null) => void;
    readonly rebuildCallGraphForIndex: (
        codebasePath: string,
        assertMutationCurrent?: () => void,
        effectiveIgnorePatterns?: readonly string[],
    ) => Promise<void>;
    readonly getContextTrackedRelativePaths: (codebasePath: string) => string[];
    readonly pruneIndexedCollectionFamily: (
        codebasePath: string,
        activeCollectionName: string,
        assertMutationCurrent?: () => void,
    ) => Promise<string[]>;
    readonly buildCollectionLimitMessage: (codebasePath: string) => Promise<string>;
    readonly getSnapshotIndexingProgress: (codebasePath: string) => number | undefined;
    readonly startBackgroundIndexing?: (
        codebasePath: string,
        forceReindex: boolean,
        writeCollectionName?: string,
        mutationLease?: RootMutationLease,
        previousIndexedInfo?: Record<string, unknown>,
        policyUpdate?: CustomIndexPolicyUpdate,
        preparedCollectionReceipt?: PreparedIndexCollectionReceipt,
    ) => Promise<void> | void;
}

function formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return String(error);
}

function isCollectionLimitError(error: unknown): boolean {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    if (error instanceof Error && error.message.includes(COLLECTION_LIMIT_MESSAGE)) {
        return true;
    }
    return false;
}

function assertCheckpointMatchesIndexedSources(
    indexedFiles: number,
    indexedFileHashes: ReadonlyMap<string, string>,
    checkpoint: PreparedFileChangeSet,
    isAuxiliaryPath?: (filePath: string) => boolean,
): void {
    if (indexedFileHashes.size !== indexedFiles) {
        throw new Error(
            `Completed full index source coverage is inconsistent: ${indexedFiles} indexed files but ${indexedFileHashes.size} source identities.`,
        );
    }
    if (!checkpoint.changes.fullHashRun) {
        throw new Error("Full index source checkpoint did not hash every selected file; refusing to publish candidate authority.");
    }
    if (checkpoint.changes.partialScan) {
        throw new Error("Full index source checkpoint was incomplete; refusing to publish source freshness.");
    }
    const searchableCheckpointFileHashes = isAuxiliaryPath
        ? new Map([...checkpoint.fileHashes.entries()].filter(([f]) => !isAuxiliaryPath(f)))
        : checkpoint.fileHashes;

    if (indexedFileHashes.size !== searchableCheckpointFileHashes.size) {
        throw new Error(
            `Full index source changed while indexing (indexed ${indexedFileHashes.size} files, observed ${searchableCheckpointFileHashes.size} searchable files, ${checkpoint.fileHashes.size} total observed); retry reindex.`,
        );
    }
    for (const [relativePath, indexedHash] of indexedFileHashes) {
        if (searchableCheckpointFileHashes.get(relativePath) !== indexedHash) {
            throw new Error(`Full index source changed while indexing at '${relativePath}'; retry reindex.`);
        }
    }
}

class IndexPolicyControlDriftError extends Error {
    readonly code = 'index_policy_changed';

    constructor(codebasePath: string) {
        super(`index_policy_changed: Repository index-policy controls changed while indexing '${codebasePath}'.`);
        this.name = 'IndexPolicyControlDriftError';
    }
}

export class FullIndexOperation {
    constructor(private readonly host: FullIndexOperationHost) {}

    private isStagedCollectionName(collectionName: string | undefined): collectionName is string {
        return typeof collectionName === "string" && isStagedGenerationCollectionName(collectionName);
    }

    public async cleanupFailedStagedCollection(
        codebasePath: string,
        collectionName: string | undefined,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        if (!this.isStagedCollectionName(collectionName)) {
            return;
        }
        try {
            await this.host.indexMutationPort.deleteCollectionWithVerification(collectionName, {
                beforeDropAttempt: assertMutationCurrent,
            });
            console.log(`[BACKGROUND-INDEX] Cleaned failed staged collection '${collectionName}' for '${codebasePath}'.`);
        } catch (cleanupError) {
            assertMutationCurrent?.();
            console.warn(
                `[BACKGROUND-INDEX] Failed to clean staged collection '${collectionName}' after indexing failure for '${codebasePath}': ${formatUnknownError(cleanupError)}`,
            );
        }
    }

    public launch(input: FullIndexOperationInput): void {
        const startBackgroundIndexing = this.host.startBackgroundIndexing
            ?? ((
                codebasePath: string,
                forceReindex: boolean,
                writeCollectionName?: string,
                mutationLease?: RootMutationLease,
                previousIndexedInfo?: Record<string, unknown>,
                policyUpdate?: CustomIndexPolicyUpdate,
                preparedCollectionReceipt?: PreparedIndexCollectionReceipt,
            ) => this.run({
                codebasePath,
                forceReindex,
                writeCollectionName,
                mutationLease,
                previousIndexedInfo,
                policyUpdate,
                preparedCollectionReceipt,
            }));

        const backgroundIndexing = startBackgroundIndexing(
            input.codebasePath,
            input.forceReindex,
            input.writeCollectionName,
            input.mutationLease,
            input.previousIndexedInfo,
            input.policyUpdate,
            input.preparedCollectionReceipt,
        );

        const launchedLease = input.mutationLease;
        const absolutePath = input.codebasePath;

        void Promise.resolve(backgroundIndexing)
            .catch((backgroundError: unknown) => {
                console.error(`[BACKGROUND-INDEX] Detached worker rejected for '${absolutePath}':`, backgroundError);
                if (
                    launchedLease
                    && this.host.mutationLeaseCoordinator?.isCurrent(launchedLease)
                ) {
                    try {
                        this.persistDetachedFailure(absolutePath, launchedLease, backgroundError);
                    } catch (receiptError) {
                        console.error(`[BACKGROUND-INDEX] Failed to persist detached worker failure for '${absolutePath}':`, receiptError);
                    }
                }
            })
            .finally(() => {
                if (launchedLease) {
                    this.host.mutationLeaseCoordinator?.release(launchedLease);
                }
            });
    }

    private persistDetachedFailure(
        absolutePath: string,
        lease: RootMutationLease,
        backgroundError: unknown,
    ): void {
        const snapshotManager = this.host.snapshotManager;
        if (!snapshotManager) {
            return;
        }

        const mutateSnapshot = () => {
            snapshotManager.setCodebaseIndexFailed(
                absolutePath,
                formatUnknownError(backgroundError),
                this.host.getSnapshotIndexingProgress(absolutePath),
            );
        };

        if (typeof snapshotManager.commitOperationPhase === "function") {
            snapshotManager.commitOperationPhase(
                lease,
                "failed",
                mutateSnapshot,
                () => this.host.mutationLeaseCoordinator?.assertCurrent(lease),
            );
        } else if (typeof snapshotManager.transitionOperation === "function") {
            snapshotManager.transitionOperation(lease, "failed");
            mutateSnapshot();
            if (snapshotManager.saveCodebaseSnapshot() === false) {
                console.error(`[BACKGROUND-INDEX] Failed to persist failed receipt for '${absolutePath}'.`);
            }
        } else {
            mutateSnapshot();
            this.host.saveSnapshotIfSupported();
        }
    }

    public async run(input: FullIndexOperationInput): Promise<void> {
        const {
            codebasePath,
            forceReindex,
            writeCollectionName,
            mutationLease,
            previousIndexedInfo,
            policyUpdate = {},
            preparedCollectionReceipt,
        } = input;

        const absolutePath = codebasePath;
        let lastSaveTime = 0;
        let targetCollectionName: string | undefined;
        let navigationCandidate: StagedNavigationSidecarGeneration | undefined;
        let candidatePolicy: ObservedResolvedIndexPolicy | null = null;
        let candidatePolicyPublished = false;
        let candidateAuthorityForRollback: DurableIndexAuthoritySnapshot | null = null;
        let expectedCandidateAuthority: ProvenVectorGenerationReceipt | null = null;
        let candidateMarkerRunId: string | undefined;
        let candidateMarkerPublicationStarted = false;
        let writingReceiptPublished = false;
        let fullIndexCheckpoint: PreparedFileChangeSet | undefined;
        let stagedCheckpoint: StagedSourceFreshnessCheckpoint | undefined;
        let fullIndexSynchronizer: FileSynchronizerType | undefined;
        let fullIndexCheckpointEvidence:
            | Extract<SourceFreshnessCheckpointEvidence, { status: "valid" }>
            | undefined;
        let watcherBootstrapCapture: WatcherBootstrapCapture | undefined;
        let fullIndexCheckpointCommitted = false;
        let candidateAuthorityCommitted = false;
        let publishedIndexStats: {
            indexedFiles: number;
            totalChunks: number;
            status: "completed" | "limit_reached";
        } | null = null;

        const assertMutationCurrent = mutationLease
            ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease)
            : undefined;
        const publishMutation = mutationLease
            ? (publish: () => void) => {
                if (!this.host.mutationLeaseCoordinator) {
                    throw new Error(`Cannot publish index state for '${absolutePath}' without a mutation lease coordinator.`);
                }
                this.host.mutationLeaseCoordinator.publishWhileCurrent(mutationLease, publish);
            }
            : undefined;

        const persistBackgroundPhase = (phase: IndexOperationPhase, mutateSnapshot?: () => void): void => {
            if (!mutationLease) {
                mutateSnapshot?.();
                return;
            }
            if (
                typeof this.host.snapshotManager.getLatestOperation !== "function"
                || typeof this.host.snapshotManager.startOperation !== "function"
                || typeof this.host.snapshotManager.transitionOperation !== "function"
            ) {
                mutateSnapshot?.();
                if (mutateSnapshot) {
                    this.host.saveSnapshotIfSupported();
                }
                return;
            }
            this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            const current = this.host.snapshotManager.getLatestOperation(absolutePath);
            if (!current || current.id !== mutationLease.operationId || current.generation !== mutationLease.generation) {
                this.host.snapshotManager.startOperation(mutationLease);
            }
            if (typeof this.host.snapshotManager.commitOperationPhase === "function") {
                this.host.snapshotManager.commitOperationPhase(
                    mutationLease,
                    phase,
                    mutateSnapshot,
                    () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!),
                );
            } else {
                this.host.snapshotManager.transitionOperation(mutationLease, phase);
                mutateSnapshot?.();
                if (this.host.snapshotManager.saveCodebaseSnapshot() === false) {
                    throw new Error(`Failed to persist operation phase '${phase}' for '${absolutePath}'.`);
                }
            }
        };

        const previousInfo = (previousIndexedInfo ?? this.host.getSnapshotCodebaseInfo(absolutePath)) as Record<string, unknown> | undefined;
        const previousFingerprint = parseIndexFingerprint(previousInfo?.indexFingerprint);
        const previousCollectionName = typeof previousInfo?.collectionName === "string"
            ? previousInfo.collectionName.trim()
            : "";
        const previousIndexedFiles = previousInfo?.indexedFiles;
        const previousTotalChunks = previousInfo?.totalChunks;
        const previousAuthority = this.host.indexMutationPort.captureDurableIndexAuthority(absolutePath);
        let previousCompleteGeneration = previousInfo?.indexStatus === "completed"
            && previousInfo?.fingerprintSource === "verified"
            && previousFingerprint !== null
            && indexFingerprintsEqual(previousFingerprint, this.host.runtimeFingerprint)
            && previousCollectionName.length > 0
            && Number.isSafeInteger(previousIndexedFiles)
            && Number(previousIndexedFiles) >= 0
            && Number.isSafeInteger(previousTotalChunks)
            && Number(previousTotalChunks) >= 0
            ? {
                collectionName: previousCollectionName,
                fingerprint: previousFingerprint,
                indexedFiles: Number(previousIndexedFiles),
                totalChunks: Number(previousTotalChunks),
                indexedPaths: Array.isArray((previousInfo?.indexManifest as Record<string, unknown> | undefined)?.indexedPaths)
                    ? ((previousInfo?.indexManifest as Record<string, unknown>).indexedPaths as unknown[])
                        .filter((entry): entry is string => typeof entry === "string")
                    : undefined,
                callGraphSidecar: previousInfo?.callGraphSidecar as CallGraphSidecarInfo | undefined,
            }
            : null;

        if (previousCompleteGeneration) {
            try {
                const provenGeneration = await this.host.indexMutationPort.proveVectorGeneration(absolutePath);
                if (
                    provenGeneration?.collectionName !== previousCompleteGeneration.collectionName
                    || provenGeneration.marker.indexStatus === "limit_reached"
                    || provenGeneration.marker.indexedFiles !== previousCompleteGeneration.indexedFiles
                    || provenGeneration.marker.totalChunks !== previousCompleteGeneration.totalChunks
                ) {
                    previousCompleteGeneration = null;
                }
            } catch (error) {
                if (!forceReindex) throw error;
                console.warn(
                    `[BACKGROUND-INDEX] Previous generation cannot be preserved during explicit reindex for '${absolutePath}': ${formatUnknownError(error)}`,
                );
                previousCompleteGeneration = null;
            }
        }

        const rejectCandidateSourceHandoff = (): boolean => {
            if (!candidatePolicy || !candidateMarkerRunId) return false;
            return this.host.syncManager.rejectFullIndexSourceHandoff(
                absolutePath,
                {
                    candidatePolicyHash: candidatePolicy.policyHash,
                    markerRunId: candidateMarkerRunId,
                },
                mutationLease,
            );
        };
        const restoreActiveWatcherAfterRejectedCandidate = async (): Promise<void> => {
            if (!candidatePolicy) return;
            try {
                rejectCandidateSourceHandoff();
                if (previousCompleteGeneration) {
                    await this.host.syncManager.restoreActiveWatcherPolicy(
                        absolutePath,
                        candidatePolicy.policyHash,
                    );
                } else {
                    await this.host.syncManager.unwatchCodebase(absolutePath);
                }
            } catch (watcherError) {
                console.warn(`[BACKGROUND-INDEX] Failed to reject candidate watcher policy for '${absolutePath}': ${formatUnknownError(watcherError)}`);
            }
        };

        try {
            for (const [capability, implementation] of [
                ["publishCompletedIndexMarker", this.host.indexMutationPort.publishCompletedIndexMarker],
                ["publishNavigationCandidate", this.host.indexMutationPort.publishNavigationCandidate],
                ["discardNavigationCandidate", this.host.indexMutationPort.discardNavigationCandidate],
            ] as const) {
                if (typeof implementation !== "function") {
                    throw new Error(`Missing required staged-index capability: Context.${capability}.`);
                }
            }
            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            }
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            targetCollectionName = typeof writeCollectionName === "string" && writeCollectionName.trim().length > 0
                ? writeCollectionName
                : this.host.resolveCollectionName(absolutePath);

            if (forceReindex) {
                console.log("[BACKGROUND-INDEX] ℹ️  Force reindex mode - building a staged generation before retiring the previous proven collection.");
            }

            candidatePolicy = forceReindex
                ? await this.host.indexMutationPort.resolveIndexPolicyForReindex(absolutePath, policyUpdate)
                : await this.host.indexMutationPort.resolveIndexPolicyForCodebase(absolutePath, policyUpdate);
            console.log(`[BACKGROUND-INDEX] Using observed index profile '${candidatePolicy.profile}'.`);
            candidateMarkerRunId = crypto.randomUUID();
            this.host.syncManager.beginFullIndexSourceHandoff(
                absolutePath,
                {
                    candidatePolicyHash: candidatePolicy.policyHash,
                    markerRunId: candidateMarkerRunId,
                },
                mutationLease,
            );
            try {
                await this.host.syncManager.touchWatchedCodebase(absolutePath, {
                    policyHash: candidatePolicy.policyHash,
                    effectiveIgnorePatterns: candidatePolicy.effectiveIgnorePatterns,
                });
            } catch (watcherError) {
                console.warn(`[BACKGROUND-INDEX] Failed to establish candidate watcher for '${absolutePath}': ${formatUnknownError(watcherError)}`);
            }
            const { FileSynchronizer } = await import("@zokizuan/satori-core");
            const ignorePatterns = candidatePolicy.effectiveIgnorePatterns;
            const supportedExtensions = candidatePolicy.supportedExtensions;
            console.log(`[BACKGROUND-INDEX] Using ${ignorePatterns.length} effective ignore patterns (policy=${candidatePolicy.policyHash.slice(0, 12)}).`);
            const candidateAuthority: SourceFreshnessCheckpointAuthority = {
                collectionName: targetCollectionName,
                markerRunId: candidateMarkerRunId,
                indexPolicyHash: candidatePolicy.policyHash,
            };
            const synchronizer = new FileSynchronizer(
                absolutePath,
                ignorePatterns,
                supportedExtensions,
                {
                    checkpointIdentity: targetCollectionName,
                    checkpointAuthority: candidateAuthority,
                },
            );
            fullIndexSynchronizer = synchronizer;
            await synchronizer.initialize(
                assertMutationCurrent,
                publishMutation,
                { deferSnapshotPublication: true },
            );
            fullIndexCheckpoint = await synchronizer.prepareChanges({ forceFullHash: true });

            console.log(`[BACKGROUND-INDEX] Starting indexing for: ${absolutePath}`);

            const encoderDescription = this.host.indexMutationPort.describeEmbeddingProvider();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${encoderDescription.provider} with dimension: ${encoderDescription.dimension}`);

            console.log("[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...");
            if (preparedCollectionReceipt && !mutationLease) {
                throw new Error('Prepared index collection receipt requires its mutation lease.');
            }
            const stats = await this.host.indexMutationPort.indexCodebase(absolutePath, (progress) => {
                if (mutationLease) {
                    this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
                }
                const publicProgress = Math.min(progress.percentage, 99);
                this.host.snapshotManager.setCodebaseIndexing(absolutePath, publicProgress);

                if (!writingReceiptPublished) {
                    persistBackgroundPhase("writing");
                    writingReceiptPublished = true;
                }

                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) {
                    this.host.saveSnapshotIfSupported();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, false, {
                assertMutationCurrent,
                publishMutation,
                deferFullIndexPublication: true,
                indexPolicy: candidatePolicy,
                writeCollectionName: targetCollectionName,
                preparedChanges: fullIndexCheckpoint,
                ...(preparedCollectionReceipt && mutationLease ? {
                    preparedCollectionReceipt,
                    preparedCollectionBinding: {
                        generation: mutationLease.generation,
                        operationId: mutationLease.operationId,
                        collectionName: targetCollectionName,
                    },
                } : {}),
            });
            navigationCandidate = stats.navigationCandidate;
            publishedIndexStats = {
                indexedFiles: stats.indexedFiles,
                totalChunks: stats.totalChunks,
                status: stats.status,
            };
            if (stats.status === "completed") {
                watcherBootstrapCapture = this.host.syncManager.captureWatcherBootstrap(
                    absolutePath,
                    candidatePolicy.policyHash,
                );
                assertCheckpointMatchesIndexedSources(
                    stats.indexedFiles,
                    stats.indexedFileHashes,
                    fullIndexCheckpoint,
                    (f) => defaultSemanticLanguageRegistry.isAuxiliaryPath(f),
                );
                stagedCheckpoint = await fullIndexCheckpoint.stageCheckpoint(candidateAuthority, assertMutationCurrent);
                const checkpointEvidence = await synchronizer.inspectOwnedSnapshot();
                if (checkpointEvidence.status !== "valid") {
                    throw new Error(
                        `Full index checkpoint for '${absolutePath}' could not be read after staging: ${checkpointEvidence.message}`,
                    );
                }
                fullIndexCheckpointEvidence = checkpointEvidence;
            }
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);
            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            }
            persistBackgroundPhase("proving");

            if (!await this.host.indexMutationPort.isObservedIndexPolicyControlSignatureCurrent(candidatePolicy)) {
                throw new IndexPolicyControlDriftError(absolutePath);
            }

            if (stats.status === "limit_reached" && previousCompleteGeneration) {
                const assertMutationCurrent = mutationLease
                    ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!)
                    : undefined;
                await this.host.clearIndexCompletionMarker(absolutePath, assertMutationCurrent);
                await this.cleanupFailedStagedCollection(absolutePath, targetCollectionName, assertMutationCurrent);
                assertMutationCurrent?.();
                persistBackgroundPhase("failed", () => {
                    this.host.snapshotManager.setCodebaseIndexed(
                        absolutePath,
                        {
                            indexedFiles: previousCompleteGeneration.indexedFiles,
                            totalChunks: previousCompleteGeneration.totalChunks,
                            status: "completed",
                        },
                        previousCompleteGeneration.fingerprint,
                        "verified",
                        previousCompleteGeneration.collectionName,
                        false,
                    );
                    if (previousCompleteGeneration.callGraphSidecar) {
                        this.host.snapshotManager.setCodebaseCallGraphSidecar(
                            absolutePath,
                            previousCompleteGeneration.callGraphSidecar,
                        );
                    }
                    if (previousCompleteGeneration.indexedPaths) {
                        this.host.snapshotManager.setCodebaseIndexManifest(
                            absolutePath,
                            previousCompleteGeneration.indexedPaths,
                        );
                    }
                });
                if (!mutationLease) {
                    this.host.saveSnapshotIfSupported();
                }
                this.host.setIndexingStats({
                    indexedFiles: previousCompleteGeneration.indexedFiles,
                    totalChunks: previousCompleteGeneration.totalChunks,
                });
                await restoreActiveWatcherAfterRejectedCandidate();
                console.warn(`[BACKGROUND-INDEX] Candidate for '${absolutePath}' reached the chunk limit; preserved previous complete collection '${previousCompleteGeneration.collectionName}'.`);
                return;
            }

            if (stats.status === "limit_reached") {
                rejectCandidateSourceHandoff();
                this.host.indexMutationPort.publishResolvedIndexPolicy(
                    candidatePolicy,
                    {
                        collectionName: targetCollectionName,
                        navigation: { status: 'not_bound' },
                    },
                    publishMutation,
                );
                candidatePolicyPublished = true;
                candidateAuthorityForRollback = this.host.indexMutationPort.captureDurableIndexAuthority(absolutePath);
                candidateMarkerPublicationStarted = true;
                await this.host.indexMutationPort.publishCompletedIndexMarker(
                    absolutePath,
                    stats.indexedFiles,
                    stats.totalChunks,
                    targetCollectionName,
                    "limit_reached",
                    assertMutationCurrent,
                    undefined,
                    candidatePolicy.policyHash,
                    candidateMarkerRunId,
                );
            }

            persistBackgroundPhase("publishing");
            if (stats.status === "completed") {
                await this.host.rebuildCallGraphForIndex(
                    absolutePath,
                    mutationLease
                        ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!)
                        : undefined,
                    candidatePolicy.effectiveIgnorePatterns,
                );
                if (!stats.navigationCandidate) {
                    throw new Error(`Completed index candidate for '${absolutePath}' did not produce a navigation generation.`);
                }
                if (!await this.host.indexMutationPort.isObservedIndexPolicyControlSignatureCurrent(candidatePolicy)) {
                    throw new IndexPolicyControlDriftError(absolutePath);
                }
                await this.host.indexMutationPort.publishCompletedIndexMarker(
                    absolutePath,
                    stats.indexedFiles,
                    stats.totalChunks,
                    targetCollectionName,
                    "completed",
                    assertMutationCurrent,
                    stats.navigationCandidate,
                    candidatePolicy.policyHash,
                    candidateMarkerRunId,
                );
            }
            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            }
            if (stats.status === "completed" && stats.navigationCandidate) {
                if (!fullIndexCheckpointEvidence || !candidateMarkerRunId || !fullIndexCheckpoint) {
                    throw new Error(
                        `Completed index candidate for '${absolutePath}' has no exact source-checkpoint authority.`,
                    );
                }
                await fullIndexCheckpoint.assertSourceObservationCurrent();
                if (mutationLease) {
                    this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
                }
                assertMutationCurrent?.();
                const activationId = crypto.randomUUID();
                const publicationAuthority = mutationLease ?? {
                    ownerId: "core-internal",
                    generation: 1,
                    operationId: activationId,
                };
                const publication: CanonicalPublicationBinding = {
                    activationId,
                    sourceCheckpoint: {
                        collectionName: targetCollectionName,
                        markerRunId: candidateMarkerRunId,
                        indexPolicyHash: candidatePolicy.policyHash,
                        merkleRoot: fullIndexCheckpointEvidence.merkleRoot,
                        documentDigest: fullIndexCheckpointEvidence.documentDigest,
                    },
                    graph: {
                        kind: "relationship_manifest_v2",
                        manifestHash: stats.navigationCandidate.relationshipManifestHash,
                    },
                    receipt: {
                        ownerId: publicationAuthority.ownerId,
                        generation: publicationAuthority.generation,
                        operationId: publicationAuthority.operationId,
                    },
                };
                this.host.indexMutationPort.publishResolvedIndexPolicy(
                    candidatePolicy,
                    {
                        collectionName: targetCollectionName,
                        navigation: {
                            status: 'sealed',
                            generationId: stats.navigationCandidate.generationId,
                            sealHash: stats.navigationCandidate.navigationSealHash,
                        },
                        publication,
                    },
                    publishMutation,
                );
                candidatePolicyPublished = true;
                candidateAuthorityForRollback = this.host.indexMutationPort.captureDurableIndexAuthority(absolutePath);
                expectedCandidateAuthority = await this.host.indexMutationPort.proveVectorGeneration(absolutePath);
                if (
                    expectedCandidateAuthority?.collectionName !== targetCollectionName
                    || expectedCandidateAuthority.marker.indexStatus !== "completed"
                    || expectedCandidateAuthority.marker.indexedFiles !== stats.indexedFiles
                    || expectedCandidateAuthority.marker.totalChunks !== stats.totalChunks
                    || expectedCandidateAuthority.marker.indexPolicyHash !== candidatePolicy.policyHash
                    || expectedCandidateAuthority.policy.controlSignature !== candidatePolicy.controlSignature
                ) {
                    throw new Error(`Candidate vector authority for '${absolutePath}' could not be proven before navigation publication.`);
                }
                await this.host.indexMutationPort.publishNavigationCandidate(
                    stats.navigationCandidate,
                    assertMutationCurrent,
                    publishMutation,
                );
                if (stagedCheckpoint) {
                    fullIndexCheckpoint.promoteStagedCheckpoint?.(stagedCheckpoint, candidateAuthority);
                    fullIndexCheckpointCommitted = true;
                }
                candidateAuthorityForRollback = this.host.indexMutationPort.captureDurableIndexAuthority(absolutePath);
                candidateAuthorityCommitted = true;
            }
            if (stats.status === "completed") {
                if (!fullIndexCheckpointCommitted) {
                    throw new Error(`Full index checkpoint was not committed for '${absolutePath}'.`);
                }
                this.host.indexMutationPort.registerSynchronizer(this.host.resolveCollectionName(absolutePath), synchronizer);
                if (
                    watcherBootstrapCapture
                    && fullIndexCheckpointEvidence
                    && expectedCandidateAuthority
                ) {
                    const sourceHandoffCompleted = await this.host.syncManager.completeFullIndexSourceHandoff(
                        absolutePath,
                        {
                            capture: watcherBootstrapCapture,
                            candidatePolicyHash: candidatePolicy.policyHash,
                            checkpointObservation: fullIndexCheckpointEvidence.observationToken,
                            provenGeneration: expectedCandidateAuthority,
                        },
                        mutationLease,
                    );
                    if (!sourceHandoffCompleted) {
                        console.warn(`[BACKGROUND-INDEX] Completed generation for '${absolutePath}' is durable, but current source observation remains unverified.`);
                    }
                }
            }
            if (stats.status === "completed") {
                await this.host.syncManager.recordObservedIgnoreControlSignature(
                    absolutePath,
                    candidatePolicy.controlSignature,
                    mutationLease,
                );
            }
            assertMutationCurrent?.();
            persistBackgroundPhase("completed", () => {
                this.host.snapshotManager.setCodebaseIndexed(absolutePath, stats, this.host.runtimeFingerprint, "verified", targetCollectionName);
                this.host.snapshotManager.setCodebaseIndexManifest(absolutePath, [...this.host.getContextTrackedRelativePaths(absolutePath)]);
            });
            if (!mutationLease) {
                this.host.saveSnapshotIfSupported();
            }
            this.host.setIndexingStats({ indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks });

            try {
                const droppedCollections = await this.host.pruneIndexedCollectionFamily(
                    absolutePath,
                    targetCollectionName,
                    mutationLease
                        ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!)
                        : undefined,
                );
                if (droppedCollections.length > 0) {
                    const { FileSynchronizer } = await import("@zokizuan/satori-core");
                    for (const droppedCollection of droppedCollections) {
                        assertMutationCurrent?.();
                        await FileSynchronizer.deleteSnapshotForGeneration(
                            absolutePath,
                            droppedCollection,
                            assertMutationCurrent,
                            publishMutation,
                        );
                    }
                    console.log(`[BACKGROUND-INDEX] 🧹 Retired ${droppedCollections.length} superseded collection(s): ${droppedCollections.join(", ")}`);
                }
            } catch (pruneError) {
                console.warn(`[BACKGROUND-INDEX] Failed to retire superseded generations for '${absolutePath}': ${formatUnknownError(pruneError)}`);
            }

            let message = `Background indexing completed for '${absolutePath}'.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === "limit_reached") {
                message += "\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached."
                    + " Search may return incomplete results with SEARCH_PARTIAL_INDEX warnings."
                    + " file_outline/call_graph are unavailable until a full reindex completes successfully."
                    + " This is not a fully complete index.";
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);
        } catch (error: unknown) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            if (error instanceof IndexPolicyPublicationError && error.committed) {
                console.error(
                    `[BACKGROUND-INDEX] Policy publication for '${absolutePath}' committed before acknowledgement failed; restoring the captured durable authority.`,
                );
                candidatePolicyPublished = true;
                candidateAuthorityForRollback = this.host.indexMutationPort.captureDurableIndexAuthority(absolutePath);
            }

            if (error instanceof SynchronizerCheckpointPublicationError && error.committed) {
                fullIndexCheckpointCommitted = true;
            }

            if (mutationLease && this.host.mutationLeaseCoordinator?.isCurrent(mutationLease) === false) {
                console.error(`[BACKGROUND-INDEX] Refusing stale terminal transition for '${absolutePath}' after mutation lease loss.`);
                return;
            }

            const committedIndexStats = publishedIndexStats;
            if (
                fullIndexCheckpointCommitted
                && !candidateAuthorityCommitted
                && committedIndexStats?.status === "completed"
                && targetCollectionName
                && expectedCandidateAuthority
            ) {
                try {
                    const provenCandidate = await this.host.indexMutationPort.proveIndexedGeneration(absolutePath);
                    candidateAuthorityCommitted = provenCandidate?.collectionName === targetCollectionName
                        && provenCandidate.policyDocumentDigest === expectedCandidateAuthority.policyDocumentDigest
                        && this.host.indexMutationPort.indexCompletionMarkersEqual(
                            provenCandidate.marker,
                            expectedCandidateAuthority.marker,
                        );
                } catch {
                    candidateAuthorityCommitted = false;
                }
            }
            if (fullIndexCheckpointCommitted && candidateAuthorityCommitted && committedIndexStats) {
                if (fullIndexSynchronizer) {
                    this.host.indexMutationPort.registerSynchronizer(
                        this.host.resolveCollectionName(absolutePath),
                        fullIndexSynchronizer,
                    );
                }
                console.error(
                    `[BACKGROUND-INDEX] Candidate authority and source checkpoint for '${absolutePath}' committed before lifecycle acknowledgement failed; retaining the committed generation.`,
                );
                try {
                    persistBackgroundPhase("completed", () => {
                        this.host.snapshotManager.setCodebaseIndexed(
                            absolutePath,
                            committedIndexStats,
                            this.host.runtimeFingerprint,
                            "verified",
                            targetCollectionName,
                        );
                        this.host.snapshotManager.setCodebaseIndexManifest(
                            absolutePath,
                            [...this.host.getContextTrackedRelativePaths(absolutePath)],
                        );
                    });
                    if (!mutationLease) {
                        this.host.saveSnapshotIfSupported();
                    }
                    this.host.setIndexingStats({
                        indexedFiles: committedIndexStats.indexedFiles,
                        totalChunks: committedIndexStats.totalChunks,
                    });
                } catch (acknowledgementError) {
                    console.error(
                        `[BACKGROUND-INDEX] Failed to persist completion acknowledgement for committed generation '${absolutePath}': ${formatUnknownError(acknowledgementError)}`,
                    );
                }
                return;
            }

            let errorMessage = formatUnknownError(error);
            if (isCollectionLimitError(error)) {
                errorMessage = await this.host.buildCollectionLimitMessage(absolutePath);
            }

            let candidateMarkerWithdrawn = !candidateMarkerPublicationStarted;
            if (candidateMarkerPublicationStarted) {
                try {
                    await this.host.clearIndexCompletionMarker(
                        absolutePath,
                        mutationLease
                            ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!)
                            : undefined,
                    );
                    candidateMarkerWithdrawn = true;
                } catch (clearError) {
                    console.warn(`[BACKGROUND-INDEX] Failed to clear completion marker after indexing error for '${absolutePath}': ${formatUnknownError(clearError)}`);
                }
            }
            if (stagedCheckpoint && !fullIndexCheckpointCommitted && targetCollectionName) {
                try {
                    const { FileSynchronizer } = await import("@zokizuan/satori-core");
                    await FileSynchronizer.deleteSnapshotForGeneration(
                        absolutePath,
                        targetCollectionName,
                        assertMutationCurrent,
                        publishMutation,
                    );
                } catch (stagedCheckpointError) {
                    console.warn(
                        `[BACKGROUND-INDEX] Failed to remove staged candidate checkpoint for '${absolutePath}': ${formatUnknownError(stagedCheckpointError)}`,
                    );
                }
            }
            if (candidateMarkerWithdrawn && fullIndexCheckpointCommitted && fullIndexSynchronizer) {
                try {
                    await fullIndexSynchronizer.deleteOwnedSnapshot(
                        assertMutationCurrent,
                        publishMutation,
                    );
                } catch (checkpointCleanupError) {
                    console.warn(
                        `[BACKGROUND-INDEX] Failed to remove unreferenced candidate checkpoint for '${absolutePath}': ${formatUnknownError(checkpointCleanupError)}`,
                    );
                }
            }
            if (preparedCollectionReceipt) {
                this.host.indexMutationPort.discardPreparedIndexCollection(preparedCollectionReceipt);
            }
            try {
                await this.cleanupFailedStagedCollection(absolutePath, targetCollectionName, assertMutationCurrent);
            } catch (cleanupError) {
                if (mutationLease && this.host.mutationLeaseCoordinator?.isCurrent(mutationLease) === false) {
                    console.error(`[BACKGROUND-INDEX] Refusing stale cleanup and terminal transition for '${absolutePath}' after mutation lease loss.`);
                    return;
                }
                throw cleanupError;
            }
            if (navigationCandidate) {
                try {
                    await this.host.indexMutationPort.discardNavigationCandidate(navigationCandidate, assertMutationCurrent);
                } catch (navigationCleanupError) {
                    console.warn(`[BACKGROUND-INDEX] Failed to discard navigation candidate '${navigationCandidate.generationId}': ${formatUnknownError(navigationCleanupError)}`);
                }
            }
            if (candidatePolicyPublished) {
                try {
                    if (!candidateAuthorityForRollback) {
                        throw new Error('Cannot restore durable index authority without captured candidate ownership evidence.');
                    }
                    if (!publishMutation) {
                        throw new Error('Cannot restore durable index authority without a current mutation fence.');
                    }
                    await this.host.indexMutationPort.restoreDurableIndexAuthority(
                        previousAuthority,
                        publishMutation,
                        candidateAuthorityForRollback,
                        mutationLease
                            ? {
                                ownerId: mutationLease.ownerId,
                                generation: mutationLease.generation,
                                operationId: mutationLease.operationId,
                            }
                            : undefined,
                    );
                } catch (policyRestoreError) {
                    console.error(`[BACKGROUND-INDEX] Failed to restore previous durable index authority for '${absolutePath}': ${formatUnknownError(policyRestoreError)}`);
                }
            }
            assertMutationCurrent?.();
            await restoreActiveWatcherAfterRejectedCandidate();

            try {
                persistBackgroundPhase("failed", () => {
                    if (previousCompleteGeneration) {
                        this.host.snapshotManager.setCodebaseIndexed(
                            absolutePath,
                            {
                                indexedFiles: previousCompleteGeneration.indexedFiles,
                                totalChunks: previousCompleteGeneration.totalChunks,
                                status: "completed",
                            },
                            previousCompleteGeneration.fingerprint,
                            "verified",
                            previousCompleteGeneration.collectionName,
                            false,
                        );
                        if (previousCompleteGeneration.callGraphSidecar) {
                            this.host.snapshotManager.setCodebaseCallGraphSidecar(
                                absolutePath,
                                previousCompleteGeneration.callGraphSidecar,
                            );
                        }
                        if (previousCompleteGeneration.indexedPaths) {
                            this.host.snapshotManager.setCodebaseIndexManifest(
                                absolutePath,
                                previousCompleteGeneration.indexedPaths,
                            );
                        }
                        return;
                    }
                    this.host.snapshotManager.setCodebaseIndexFailed(
                        absolutePath,
                        errorMessage,
                        this.host.getSnapshotIndexingProgress(absolutePath),
                    );
                });
                if (!mutationLease) {
                    this.host.saveSnapshotIfSupported();
                }
            } catch (snapshotError) {
                console.error(`[BACKGROUND-INDEX] Failed to persist terminal failure for '${absolutePath}': ${formatUnknownError(snapshotError)}`);
            }
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }
}
