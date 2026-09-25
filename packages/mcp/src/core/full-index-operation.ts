import {
    COLLECTION_LIMIT_MESSAGE,
    Context,
    deleteCollectionWithVerification,
    type CustomIndexPolicyUpdate,
    type IndexCodebaseResult,
    type ObservedResolvedIndexPolicy,
} from "@zokizuan/satori-core";
import type { SyncManager, WatcherBootstrapCapture } from "./sync.js";
import {
    RootMutationCancelledError,
    RootMutationRuntime,
    type MutationOperationPhase,
} from "@zokizuan/satori-core/integration";

export interface FullIndexOperationInput {
    readonly codebasePath: string;
    readonly forceReindex: boolean;
    readonly policyUpdate?: CustomIndexPolicyUpdate;
}

export type FullIndexCandidateResult = Pick<
    IndexCodebaseResult,
    "indexedFiles" | "totalChunks" | "status" | "collectionName" | "publication"
>;

export type FullIndexCandidateRunner = (input: Readonly<{
    codebasePath: string;
    forceReindex: boolean;
    indexPolicy: ObservedResolvedIndexPolicy;
    deferPartialPublication: boolean;
    onProgress: (progress: {
        phase: string;
        current: number;
        total: number;
        percentage: number;
    }) => void;
}>) => Promise<FullIndexCandidateResult>;

export interface FullIndexOperationHost {
    readonly context: Context;
    readonly mutationRuntime: RootMutationRuntime;
    readonly syncManager: SyncManager;
    readonly setIndexingStats: (stats: { indexedFiles: number; totalChunks: number } | null) => void;
    readonly buildCollectionLimitMessage: (codebasePath: string) => Promise<string>;
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

export class FullIndexOperation {
    constructor(
        private readonly host: FullIndexOperationHost,
        private readonly candidateRunner?: FullIndexCandidateRunner,
    ) {}

    private runCandidate(input: Parameters<FullIndexCandidateRunner>[0]): Promise<FullIndexCandidateResult> {
        if (this.candidateRunner) {
            return this.candidateRunner(input);
        }
        return this.host.context.indexCodebase(
            input.codebasePath,
            input.onProgress,
            input.forceReindex,
            {
                deferPartialPublication: input.deferPartialPublication,
                indexPolicy: input.indexPolicy,
            },
        );
    }

    public async cleanupUnpublishedCandidateCollection(
        codebasePath: string,
        collectionName: string | undefined,
    ): Promise<void> {
        if (!collectionName) return;
        try {
            this.host.mutationRuntime.assertCurrent(codebasePath);
            await deleteCollectionWithVerification(this.host.context.getVectorStore(), collectionName, {
                beforeDropAttempt: () => this.host.mutationRuntime.assertCurrent(codebasePath),
            });
            console.log(`[BACKGROUND-INDEX] Cleaned unpublished candidate collection '${collectionName}' for '${codebasePath}'.`);
        } catch (cleanupError) {
            this.host.mutationRuntime.assertCurrent(codebasePath);
            console.warn(
                `[BACKGROUND-INDEX] Failed to clean unpublished candidate collection '${collectionName}' after indexing failure for '${codebasePath}': ${formatUnknownError(cleanupError)}`,
            );
        }
    }

    public async run(input: FullIndexOperationInput): Promise<void> {
        const {
            codebasePath,
            forceReindex,
            policyUpdate = {},
        } = input;

        const absolutePath = codebasePath;
        this.host.mutationRuntime.assertCurrent(absolutePath);
        let targetCollectionName: string | undefined;
        let candidatePolicy: ObservedResolvedIndexPolicy | null = null;
        let candidatePublicationId = this.host.mutationRuntime.getCurrentOperation(absolutePath)?.id;
        let watcherBootstrapCapture: WatcherBootstrapCapture | undefined;
        let candidatePublicationActivated = false;
        let publishedIndexStats: {
            indexedFiles: number;
            totalChunks: number;
            status: "completed" | "limit_reached";
        } | null = null;

        const publishBackgroundPhase = (
            phase: MutationOperationPhase,
            update: { progress?: number; error?: string } = {},
        ): void => {
            this.host.mutationRuntime.updateCurrentOperation(absolutePath, phase, update);
        };

        const previousPublication = this.host.context.getCurrentPublication(absolutePath);
        const previousCompleteGeneration = previousPublication?.publication.status === "complete"
            ? {
                collectionName: previousPublication.publication.vector.collectionName,
                indexedFiles: previousPublication.publication.vector.indexedFiles,
                totalChunks: previousPublication.publication.vector.totalChunks,
            }
            : null;

        const rejectCandidateSourceHandoff = (): boolean => {
            if (!candidatePolicy || !candidatePublicationId) return false;
            return this.host.syncManager.rejectFullIndexSourceHandoff(
                absolutePath,
                { publicationId: candidatePublicationId },
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
            this.host.mutationRuntime.assertCurrent(absolutePath);
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);
            if (forceReindex) {
                console.log("[BACKGROUND-INDEX] ℹ️  Force reindex mode - Core will build a staged publication before retiring the previous proven collection.");
            }

            candidatePolicy = forceReindex
                ? await this.host.context.resolveIndexPolicyForReindex(absolutePath, policyUpdate)
                : await this.host.context.resolveIndexPolicyForCodebase(absolutePath, policyUpdate);
            console.log(`[BACKGROUND-INDEX] Using observed index profile '${candidatePolicy.profile}'.`);
            if (candidatePublicationId) {
                this.host.syncManager.beginFullIndexSourceHandoff(
                    absolutePath,
                    { publicationId: candidatePublicationId },
                );
            }
            try {
                await this.host.syncManager.touchWatchedCodebase(absolutePath, {
                    policyHash: candidatePolicy.policyHash,
                    effectiveIgnorePatterns: candidatePolicy.effectiveIgnorePatterns,
                });
            } catch (watcherError) {
                console.warn(`[BACKGROUND-INDEX] Failed to establish candidate watcher for '${absolutePath}': ${formatUnknownError(watcherError)}`);
            }

            const embedding = this.host.context.getEmbeddingEngine();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embedding.getProvider()} with dimension: ${embedding.getDimension()}`);
            console.log("[BACKGROUND-INDEX] 🚀 Core is constructing the full publication candidate...");
            const stats = await this.runCandidate({
                codebasePath: absolutePath,
                forceReindex,
                indexPolicy: candidatePolicy,
                deferPartialPublication: previousCompleteGeneration !== null,
                onProgress: (progress) => {
                    this.host.mutationRuntime.assertCurrent(absolutePath);
                    const publicProgress = Math.min(progress.percentage, 99);
                    publishBackgroundPhase("writing", { progress: publicProgress });
                    console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
                },
            });
            targetCollectionName = stats.collectionName;
            candidatePublicationId = stats.publication.id;
            candidatePublicationActivated = stats.publication.status === "activated";
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
            }
            console.log(`[BACKGROUND-INDEX] ✅ Core candidate construction completed. Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}, publication=${stats.publication.status}`);
            publishBackgroundPhase("proving");

            if (stats.status === "limit_reached" && previousCompleteGeneration) {
                if (candidatePublicationActivated) {
                    throw new Error(`Partial candidate for '${absolutePath}' activated despite preserve-current lifecycle policy.`);
                }
                await this.cleanupUnpublishedCandidateCollection(absolutePath, targetCollectionName);
                this.host.mutationRuntime.assertCurrent(absolutePath);
                publishBackgroundPhase("failed", {
                    progress: 99,
                    error: "The replacement candidate reached an indexing resource limit; the previous complete Publication remains current.",
                });
                this.host.setIndexingStats({
                    indexedFiles: previousCompleteGeneration.indexedFiles,
                    totalChunks: previousCompleteGeneration.totalChunks,
                });
                await restoreActiveWatcherAfterRejectedCandidate();
                console.warn(`[BACKGROUND-INDEX] Candidate for '${absolutePath}' reached an indexing resource limit; preserved previous complete collection '${previousCompleteGeneration.collectionName}'.`);
                return;
            }

            if (!candidatePublicationActivated) {
                throw new Error(`Core candidate for '${absolutePath}' returned without activating its publication.`);
            }

            publishBackgroundPhase("publishing");
            if (stats.status === "completed") {
                const publication = this.host.context.getCurrentPublication(absolutePath);
                if (
                    !publication
                    || publication.id !== stats.publication.id
                    || publication.publication.vector.collectionName !== targetCollectionName
                    || publication.publication.vector.totalChunks !== stats.totalChunks
                ) {
                    throw new Error(`Activated Core publication for '${absolutePath}' is not the expected completed vector generation.`);
                }
                if (watcherBootstrapCapture) {
                    const sourceEvidence = await this.host.context.inspectSourceFreshnessCheckpoint(
                        absolutePath,
                        publication,
                    );
                    if (sourceEvidence.status === "valid") {
                        const sourceHandoffCompleted = await this.host.syncManager.completeFullIndexSourceHandoff(
                            absolutePath,
                            {
                                capture: watcherBootstrapCapture,
                                publicationId: stats.publication.id,
                                checkpointObservation: sourceEvidence.observationToken,
                            },
                        );
                        if (!sourceHandoffCompleted) {
                            console.warn(`[BACKGROUND-INDEX] Completed publication for '${absolutePath}' is durable, but current source observation remains unverified.`);
                        }
                    } else {
                        console.warn(`[BACKGROUND-INDEX] Completed publication for '${absolutePath}' has no readable current source checkpoint for watcher handoff.`);
                    }
                }
            } else {
                rejectCandidateSourceHandoff();
            }
            this.host.mutationRuntime.assertCurrent(absolutePath);
            publishBackgroundPhase("completed", { progress: 100 });
            this.host.setIndexingStats({ indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks });

            let message = `Background indexing completed for '${absolutePath}'.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === "limit_reached") {
                message += "\n⚠️  Warning: Indexing stopped because an indexing resource limit was reached."
                    + " Search may return incomplete results with SEARCH_PARTIAL_INDEX warnings."
                    + " file_outline/call_graph are unavailable until a full reindex completes successfully."
                    + " This is not a fully complete index.";
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);
        } catch (error: unknown) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            if (!this.host.mutationRuntime.isCurrent(absolutePath)) {
                console.error(`[BACKGROUND-INDEX] Refusing stale terminal transition for '${absolutePath}' after Core mutation scope loss.`);
                return;
            }

            const committedIndexStats = publishedIndexStats;
            if (candidatePublicationActivated && committedIndexStats && targetCollectionName) {
                console.error(
                    `[BACKGROUND-INDEX] Core publication for '${absolutePath}' activated before lifecycle acknowledgement failed; retaining the activated generation.`,
                );
                try {
                    publishBackgroundPhase("completed", { progress: 100 });
                    this.host.setIndexingStats({
                        indexedFiles: committedIndexStats.indexedFiles,
                        totalChunks: committedIndexStats.totalChunks,
                    });
                } catch (operationError) {
                    console.error(
                        `[BACKGROUND-INDEX] Failed to publish live completion state for activated Publication '${absolutePath}': ${formatUnknownError(operationError)}`,
                    );
                }
                return;
            }

            const cancelled = error instanceof RootMutationCancelledError;
            let errorMessage = formatUnknownError(error);
            if (isCollectionLimitError(error)) {
                errorMessage = await this.host.buildCollectionLimitMessage(absolutePath);
            }

            if (targetCollectionName) {
                try {
                    await this.cleanupUnpublishedCandidateCollection(absolutePath, targetCollectionName);
                } catch (cleanupError) {
                    if (!this.host.mutationRuntime.isCurrent(absolutePath)) {
                        console.error(`[BACKGROUND-INDEX] Refusing stale cleanup and terminal transition for '${absolutePath}' after Core mutation scope loss.`);
                        return;
                    }
                    throw cleanupError;
                }
            }
            this.host.mutationRuntime.assertCurrent(absolutePath);
            await restoreActiveWatcherAfterRejectedCandidate();

            if (cancelled) {
                console.warn(`[BACKGROUND-INDEX] Indexing cancelled for ${absolutePath}: ${errorMessage}`);
                throw error;
            }

            try {
                publishBackgroundPhase("failed", { error: errorMessage });
            } catch (operationError) {
                console.error(`[BACKGROUND-INDEX] Failed to publish live terminal failure for '${absolutePath}': ${formatUnknownError(operationError)}`);
            }
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }
}
