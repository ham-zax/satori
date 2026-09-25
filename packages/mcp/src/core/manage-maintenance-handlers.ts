import * as fs from "fs";
import { fileURLToPath } from "node:url";
import {
    COLLECTION_LIMIT_MESSAGE,
    RemoteCollectionDeletePendingError,
    computeSymbolQualitySummaryFromSidecarRead,
    formatSymbolQualityMarker,
    readSymbolRegistrySidecar,
    resolveLanguageCapabilityEvidence,
    unknownSymbolQualitySummary,
    type Context,
    type PublicationLease,
    type PublicationRef,
    type LanguageCapabilityEvidenceSummary,
    type SymbolQualitySummary,
} from "@zokizuan/satori-core";
import {
    type SourceFreshnessAssessment,
    type SyncManager,
} from "./sync.js";
import type {
    CompletionProbeDebugHint,
    TrackedRootReadiness,
    TrackedRootReadinessState,
} from "./tracked-root-readiness.js";
import { WARNING_CODES, type WarningCode } from "./warnings.js";
import {
    classifyVectorBackendError,
    type VectorBackendDiagnostic,
} from "./backend-diagnostics.js";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import {
    MutationWorkerCancelledError,
    spawnSupervisedMutationWorker,
} from "../server/mutation-worker-supervisor.js";
import type {
    ManageIndexAction,
    ManageIndexReason,
    ManageIndexStatus,
    ManageIndexStatusDetail,
    ManagePendingSync,
    ManageStructuralCoverage,
} from "./manage-types.js";
import {
    formatRuntimeOwnersStatusLine,
    type RuntimeOwnerMutationAction,
    type RuntimeOwnersSummary,
} from "./runtime-owner.js";
import {
    RootMutationInProgressError,
    RootMutationRuntime,
    formatRootMutationBlockedMessage,
    type MutationOperationPhase,
    type RootMutationActivity,
    type RootMutationExecution,
    type RootMutationOperation,
} from "@zokizuan/satori-core/integration";

type ToolArgs = Record<string, unknown>;

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type ManageMaintenanceHandlersHost = {
    context: Pick<Context, "clearIndex" | "getCurrentPublication" | "listCurrentPublications" | "inspectSourceFreshnessCheckpoint">;
    mutationRuntime: RootMutationRuntime;
    syncManager: Pick<SyncManager, "assessReadFreshness">;
    trackedRootReadiness: Pick<
        TrackedRootReadiness,
        "buildMissingLocalCollectionMessage" | "prepareTrackedRootForRead"
    >;
    prepareStatusTrackedRootRead(absolutePath: string): Promise<TrackedRootReadinessState>;
    acquirePublicationLease(codebasePath: string): PublicationLease | undefined;
    isPublicationAdmitted(publication: PublicationRef): Promise<boolean>;
    getPublicationNavigationAddress(publication: PublicationRef): {
        publicationId: string;
        navigationRoot: string;
    } | null;
    buildRuntimeOwnerConflictResponseIfBlocked(
        action: Extract<RuntimeOwnerMutationAction, "clear" | "sync">,
        codebasePath: string,
    ): Promise<ToolTextResponse | null>;
    manageResponse(
        action: ManageIndexAction | string,
        path: string,
        status: ManageIndexStatus | string,
        message: string,
        options?: Record<string, unknown>,
    ): ToolTextResponse;
    buildCreateHint(codebasePath: string): Record<string, unknown>;
    buildManageActionBlockedMessage(
        codebasePath: string,
        action: Extract<RuntimeOwnerMutationAction, "clear" | "sync">,
    ): string;
    buildStatusHint(codebasePath: string): Record<string, unknown>;
    getManageRetryAfterMs(): number;
    buildIndexingMetadata(codebasePath: string): Record<string, unknown> | undefined;
    clearIndexingStats(): void;
    unwatchCodebase(codebasePath: string): Promise<void>;
    buildReindexInstruction(codebasePath: string, detail?: string): string;
    buildCompatibilityStatusLines(codebasePath: string): string;
    buildManageRequiresReindexHints(codebasePath: string): Record<string, unknown>;
    buildSyncHint(codebasePath: string): Record<string, unknown>;
    collectPublicationGarbageAfterSync(codebasePath: string): Promise<string[]>;
    ownDetachedMutationCompletion(completion: Promise<void>): void;
    buildStaleLocalHint(codebasePath: string, reason: string): Record<string, unknown>;
    buildStaleLocalMessage(codebasePath: string, requestedPath: string, reason: string): string;
    buildReindexHint(codebasePath: string): Record<string, unknown>;
    manageVectorBackendResponse(
        action: string,
        path: string,
        diagnostic: VectorBackendDiagnostic,
        humanText?: string,
        operation?: RootMutationOperation,
    ): ToolTextResponse;
    /** Optional live MCP runtime owner summary for status diagnostics. */
    getLiveOwnersSummary?(): Promise<RuntimeOwnersSummary | null> | RuntimeOwnersSummary | null;
};

function collectErrorFragments(
    value: unknown,
    output: string[],
    visited: Set<unknown>,
    depth = 0,
): void {
    if (value === null || value === undefined || depth > 4 || output.length >= 8) {
        return;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
            output.push(trimmed);
        }
        return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        output.push(String(value));
        return;
    }
    if (value instanceof Error) {
        collectErrorFragments(value.message, output, visited, depth + 1);
        collectErrorFragments((value as Error & { cause?: unknown }).cause, output, visited, depth + 1);
        return;
    }
    if (typeof value !== "object") {
        return;
    }
    if (visited.has(value)) {
        return;
    }
    visited.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            collectErrorFragments(item, output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["message", "reason", "detail", "details", "error", "msg", "code", "error_code"]) {
        if (key in record) {
            collectErrorFragments(record[key], output, visited, depth + 1);
            if (output.length >= 8) {
                return;
            }
        }
    }
    for (const nestedValue of Object.values(record)) {
        collectErrorFragments(nestedValue, output, visited, depth + 1);
        if (output.length >= 8) {
            return;
        }
    }
}

function formatUnknownError(error: unknown): string {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return COLLECTION_LIMIT_MESSAGE;
    }
    const fragments: string[] = [];
    collectErrorFragments(error, fragments, new Set());
    const deduped = Array.from(new Set(fragments.map((fragment) => fragment.trim()).filter(Boolean)));
    if (deduped.length > 0) {
        return deduped.slice(0, 3).join(" | ");
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function formatActiveMutationStatusLine(activity: RootMutationActivity): string {
    const executor = activity.executorPid !== undefined
        ? ` executorPid=${activity.executorPid}${activity.executorProcessGroupId !== undefined ? ` executorProcessGroupId=${activity.executorProcessGroupId}` : ""}`
        : "";
    return `Active mutation: ${activity.action} operation=${activity.id} generation=${activity.generation} pid=${activity.pid}${executor} acquiredAt=${activity.acceptedAt}`;
}

// Sync emits real progress per changed file and after measured Publication phases.
// This is a quiet-window deadline, not a total-runtime ceiling; heartbeats do not reset it.
const SYNC_NO_PROGRESS_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_OPERATION_PHASES = new Set<MutationOperationPhase>([
    "completed",
    "failed",
    "blocked",
    "cancelled",
]);

function resolveMutationSyncWorkerPath(): string {
    const built = fileURLToPath(new URL("../server/mutation-sync-worker.js", import.meta.url));
    if (fs.existsSync(built)) return built;
    return fileURLToPath(new URL("../server/mutation-sync-worker.ts", import.meta.url));
}

function pendingSyncProjection(
    operation: RootMutationOperation | undefined,
    activity: RootMutationActivity | undefined,
): ManagePendingSync | undefined {
    if (!operation || operation.action !== "sync") return undefined;
    return {
        operationId: operation.id,
        generation: operation.generation,
        phase: operation.phase,
        ...(operation.progress !== undefined ? { progress: operation.progress } : {}),
        ...(operation.heartbeatAt ? { heartbeatAt: operation.heartbeatAt } : {}),
        ...(operation.progressAt ? { progressAt: operation.progressAt } : {}),
        ...(operation.cancelRequestedAt ? { cancelRequestedAt: operation.cancelRequestedAt } : {}),
        ...(operation.cancelReason ? { cancelReason: operation.cancelReason } : {}),
        ...(activity?.executorPid !== undefined ? { executorPid: activity.executorPid } : {}),
        ...(activity?.executorProcessGroupId !== undefined
            ? { executorProcessGroupId: activity.executorProcessGroupId }
            : {}),
    };
}

function sourceFreshnessLine(sourceFreshness: SourceFreshnessAssessment): string {
    switch (sourceFreshness.state) {
        case "verified":
            return `Current source parity is verified (${sourceFreshness.reason}).`;
        case "changed":
            return `Current source differs from this completed Publication (${sourceFreshness.reason}); the published generation remains readable while maintenance is pending.`;
        case "unverified":
            return `Current source parity is unverified (${sourceFreshness.reason}); the completed Publication remains readable and can be refreshed explicitly when current-source parity matters.`;
    }
}

export class ManageMaintenanceHandlers {
    constructor(private readonly host: ManageMaintenanceHandlersHost) {}

    public async handleClearIndex(args: ToolArgs): Promise<ToolTextResponse> {
        const codebasePath = typeof args.path === "string" ? args.path : "";
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("clear", codebasePath, "error", absolutePathResult.message);
        }
        const absolutePath = absolutePathResult.absolutePath;
        if (fs.existsSync(absolutePath) && !fs.statSync(absolutePath).isDirectory()) {
            return this.host.manageResponse("clear", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
        }

        const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked("clear", absolutePath);
        if (runtimeOwnerConflict) return runtimeOwnerConflict;

        try {
            return await this.host.mutationRuntime.run(absolutePath, "clear", async () => {
                let lastOperation = this.host.mutationRuntime.getCurrentOperation(absolutePath);
                let publicationAuthorityCleared = false;
                const updateOperation = (
                    phase: MutationOperationPhase,
                    update: { progress?: number; error?: string } = {},
                ): RootMutationOperation => {
                    lastOperation = this.host.mutationRuntime.updateCurrentOperation(absolutePath, phase, update);
                    return lastOperation;
                };

                try {
                    console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);
                    updateOperation("writing", { progress: 0 });
                    await this.host.context.clearIndex(absolutePath, (progress) => {
                        if (progress.phase === "Removing index data...") publicationAuthorityCleared = true;
                        const progressValue = Number.isFinite(progress.percentage)
                            ? Math.max(0, Math.min(99, progress.percentage))
                            : undefined;
                        if (progressValue !== undefined) updateOperation("writing", { progress: progressValue });
                    });
                    publicationAuthorityCleared = true;
                    updateOperation("completed", { progress: 100 });
                    this.host.clearIndexingStats();
                    await this.host.unwatchCodebase(absolutePath);

                    let resultText = `Successfully cleared codebase '${absolutePath}'`;
                    const remainingIndexed = this.host.context.listCurrentPublications().length;
                    if (remainingIndexed > 0) {
                        resultText += `\n${remainingIndexed} other indexed codebase(s) remain`;
                    }
                    return this.host.manageResponse(
                        "clear",
                        absolutePath,
                        "ok",
                        resultText,
                        lastOperation ? { operation: lastOperation } : undefined,
                    );
                } catch (error: unknown) {
                    const detail = formatUnknownError(error);
                    if (this.host.mutationRuntime.isCurrent(absolutePath)) {
                        try {
                            updateOperation("failed", { error: detail });
                        } catch (operationError) {
                            console.error("Failed to publish terminal clear operation state:", operationError);
                        }
                    }
                    if (error instanceof RemoteCollectionDeletePendingError) {
                        const errorMsg = `Publication authority has already been cleared for ${absolutePath}. Remote vector cleanup is still pending; residual physical cleanup can be retried with manage_index clear. Details: ${detail}`;
                        return this.host.manageResponse("clear", absolutePath, "error", errorMsg, {
                            reason: "remote_delete_pending",
                            hints: {
                                retry: this.host.buildStatusHint(absolutePath),
                                clear: { tool: "manage_index", args: { action: "clear", path: absolutePath } },
                            },
                            ...(lastOperation ? { operation: lastOperation } : {}),
                        });
                    }
                    const errorMsg = publicationAuthorityCleared
                        ? `Publication authority has already been cleared for ${absolutePath}, but post-clear physical/runtime cleanup failed before completion. Residual cleanup can be retried with manage_index clear. Details: ${detail}`
                        : `Failed to clear ${absolutePath} before Publication authority removal completed: ${detail}`;
                    if (detail === COLLECTION_LIMIT_MESSAGE || detail.includes(COLLECTION_LIMIT_MESSAGE)) {
                        return this.host.manageResponse("clear", absolutePath, "error", COLLECTION_LIMIT_MESSAGE, lastOperation ? { operation: lastOperation } : undefined);
                    }
                    return this.host.manageResponse(
                        "clear",
                        absolutePath,
                        "error",
                        errorMsg,
                        lastOperation ? { operation: lastOperation } : undefined,
                    );
                }
            });
        } catch (error) {
            if (error instanceof RootMutationInProgressError) {
                return this.host.manageResponse(
                    "clear",
                    absolutePath,
                    "blocked",
                    formatRootMutationBlockedMessage(error.activeMutation),
                    {
                        reason: "mutation_in_progress",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            activeMutation: error.activeMutation,
                        },
                    },
                );
            }
            throw error;
        }
    }

    public async handleGetIndexingStatus(args: ToolArgs): Promise<ToolTextResponse> {
        const codebasePath = typeof args.path === "string" ? args.path : "";
        const requestedDetail = args.detail;
        const detail: ManageIndexStatusDetail = requestedDetail === "capabilities"
            || requestedDetail === "diagnostics"
            || requestedDetail === "full"
            ? requestedDetail
            : "summary";
        const includeCapabilities = detail === "capabilities" || detail === "full";
        const includeDiagnostics = detail === "diagnostics" || detail === "full";
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("status", codebasePath, "error", absolutePathResult.message, { detail });
        }
        const requestedPath = absolutePathResult.absolutePath;

        try {
            const absolutePath = requestedPath;

            const latestOperation = this.host.mutationRuntime.getOperation(absolutePath);

            if (!fs.existsSync(absolutePath)) {
                return this.host.manageResponse("status", absolutePath, "error", `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`, {
                    detail,
                    ...(latestOperation ? { operation: latestOperation } : {}),
                });
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.host.manageResponse("status", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`, { detail });
            }

            const liveMutation = this.host.mutationRuntime.getActiveMutation(absolutePath);
            const preparedTrackedRootState = await this.host.prepareStatusTrackedRootRead(absolutePath);
            const trackedRootState = preparedTrackedRootState.state === "indexing"
                && liveMutation?.action === "sync"
                && preparedTrackedRootState.searchableGenerationAvailable
                && preparedTrackedRootState.searchableRead
                ? preparedTrackedRootState.searchableRead
                : preparedTrackedRootState;
            if (trackedRootState.state === "requires_reindex") {
                const operation = this.host.mutationRuntime.getOperation(trackedRootState.codebasePath);
                const statusMessage = this.host.buildReindexInstruction(trackedRootState.codebasePath, trackedRootState.message);
                const compatibilityStatus = includeDiagnostics
                    ? this.host.buildCompatibilityStatusLines(trackedRootState.codebasePath)
                    : "";
                const activeMutation = this.host.mutationRuntime.getActiveMutation(trackedRootState.codebasePath);
                const activeMutationLine = activeMutation ? `\n${formatActiveMutationStatusLine(activeMutation)}` : "";
                const pathInfo = codebasePath !== trackedRootState.codebasePath
                    ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${trackedRootState.codebasePath}'`
                    : "";
                return this.host.manageResponse(
                    "status",
                    trackedRootState.codebasePath,
                    "requires_reindex",
                    statusMessage + compatibilityStatus + activeMutationLine + pathInfo,
                    {
                        detail,
                        reason: "requires_reindex",
                        hints: {
                            ...this.host.buildManageRequiresReindexHints(trackedRootState.codebasePath),
                            ...(activeMutation ? { activeMutation } : {}),
                        },
                        ...(operation ? { operation } : {}),
                    },
                );
            }

            const sourceCheckpointEvidence = trackedRootState.state === "ready"
                && trackedRootState.publication.publication.status === "complete"
                ? await this.host.context.inspectSourceFreshnessCheckpoint(
                    trackedRootState.root.path,
                    trackedRootState.publication,
                )
                : null;
            let sourceFreshness: SourceFreshnessAssessment | undefined;
            if (
                trackedRootState.state === "ready"
                && trackedRootState.publication.publication.status === "complete"
            ) {
                const freshnessDecision = await this.host.syncManager.assessReadFreshness(
                    trackedRootState.root.path,
                    0,
                    { preparedPublication: trackedRootState.publication },
                );
                sourceFreshness = freshnessDecision.sourceFreshness;
            }

            let statusMessage = "";
            let envelopePath = absolutePath;
            let envelopeStatus: ManageIndexStatus = "ok";
            let envelopeReason: ManageIndexReason | undefined;
            let envelopeHints: Record<string, unknown> | undefined;
            let proofDebugHint: CompletionProbeDebugHint | undefined;
            let envelopeMessage: string | undefined;

            if (trackedRootState.state === "not_indexed") {
                envelopeStatus = "not_indexed";
                envelopeReason = "not_indexed";
                envelopeHints = { create: this.host.buildCreateHint(absolutePath) };
                statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Call manage_index with {"action":"create","path":"${absolutePath}"} to index it first.`;
            } else if (trackedRootState.state === "stale_local") {
                envelopePath = trackedRootState.codebasePath;
                envelopeStatus = "requires_reindex";
                envelopeReason = "requires_reindex";
                envelopeHints = {
                    reindex: this.host.buildReindexHint(trackedRootState.codebasePath),
                    staleLocal: this.host.buildStaleLocalHint(trackedRootState.codebasePath, trackedRootState.reason),
                };
                statusMessage = `❌ ${this.host.buildStaleLocalMessage(trackedRootState.codebasePath, absolutePath, trackedRootState.reason)} Run manage_index with {"action":"reindex","path":"${trackedRootState.codebasePath}"} to establish fresh authoritative state.`;
            } else if (trackedRootState.state === "missing_collection") {
                envelopePath = trackedRootState.codebasePath;
                envelopeStatus = "not_indexed";
                envelopeReason = "not_indexed";
                envelopeHints = { create: this.host.buildCreateHint(trackedRootState.codebasePath) };
                statusMessage = `❌ ${this.host.trackedRootReadiness.buildMissingLocalCollectionMessage(
                    trackedRootState.codebasePath,
                    absolutePath,
                    trackedRootState.collectionName,
                )}`;
                proofDebugHint = trackedRootState.proofDebugHint;
            } else if (trackedRootState.state === "indexing") {
                envelopePath = trackedRootState.codebasePath;
                envelopeStatus = "not_ready";
                envelopeReason = "indexing";
                envelopeHints = {
                    status: this.host.buildStatusHint(trackedRootState.codebasePath),
                    retryAfterMs: this.host.getManageRetryAfterMs(),
                    indexing: this.host.buildIndexingMetadata(trackedRootState.codebasePath),
                };
                const activeMutation = this.host.mutationRuntime.getActiveMutation(trackedRootState.codebasePath);
                const operation = activeMutation
                    ? this.host.mutationRuntime.getOperation(trackedRootState.codebasePath)
                    : undefined;
                if (operation?.progress !== undefined) {
                    statusMessage = `🔄 Codebase '${trackedRootState.codebasePath}' is currently being indexed. Progress: ${operation.progress.toFixed(1)}%`;
                    if (operation.progress < 10) {
                        statusMessage += " (Preparing and scanning files...)";
                    } else if (operation.progress < 100) {
                        statusMessage += " (Processing files and generating embeddings...)";
                    }
                    statusMessage += `\n🕐 Last updated: ${new Date(operation.updatedAt).toLocaleString()}`;
                } else {
                    statusMessage = `🔄 Codebase '${trackedRootState.codebasePath}' is currently being indexed.`;
                }
            } else if (trackedRootState.state === "index_failed") {
                envelopePath = trackedRootState.codebasePath;
                envelopeStatus = "error";
                const failedInfo = trackedRootState.info;
                if (typeof failedInfo.errorMessage === "string") {
                    statusMessage = `❌ Codebase '${trackedRootState.codebasePath}' indexing failed.`;
                    statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                    envelopeMessage = `Codebase '${trackedRootState.codebasePath}' indexing failed: ${failedInfo.errorMessage}`;
                    if (typeof failedInfo.lastAttemptedPercentage === "number" && Number.isFinite(failedInfo.lastAttemptedPercentage)) {
                        statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                    }
                    if (typeof failedInfo.lastUpdated === "string") {
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                    }
                    statusMessage += `\n💡 Retry with manage_index action='create'.`;
                } else {
                    statusMessage = `❌ Codebase '${trackedRootState.codebasePath}' indexing failed. You can retry indexing.`;
                }
            } else {
                envelopePath = trackedRootState.root.path;
                proofDebugHint = trackedRootState.proofDebugHint;
                const publication = trackedRootState.publication.publication;
                const isPartial = publication.status === "partial";
                statusMessage = isPartial
                    ? `⚠️ Codebase '${trackedRootState.root.path}' is partially indexed (limit_reached).`
                    : `✅ Codebase '${trackedRootState.root.path}' is fully indexed and ready for search.`;
                statusMessage += `\n📊 Statistics: ${publication.vector.indexedFiles} files, ${publication.vector.totalChunks} chunks`;
                statusMessage += `\n📅 Status: ${isPartial ? "limit_reached" : "completed"}`;
                if (isPartial) {
                    statusMessage += `\nSearch may return incomplete results; file_outline/call_graph are unavailable until a full reindex completes.`;
                }
                statusMessage += `\n🕐 Published: ${new Date(publication.createdAt).toLocaleString()}`;
            }

            if (trackedRootState.state === "ready" && sourceFreshness) {
                envelopeHints = {
                    ...(envelopeHints || {}),
                    sourceFreshness: {
                        status: sourceFreshness.state,
                        reason: sourceFreshness.reason,
                        ...(sourceFreshness.state !== "verified"
                            ? { maintenance: this.host.buildSyncHint(trackedRootState.root.path) }
                            : {}),
                    },
                };
                statusMessage += `\n🔎 ${sourceFreshnessLine(sourceFreshness)}`;
            }

            const warnings: WarningCode[] = [];
            if (sourceFreshness?.state === "changed") {
                warnings.push(WARNING_CODES.SOURCE_CHANGES_PENDING);
            } else if (sourceFreshness?.state === "unverified") {
                warnings.push(WARNING_CODES.SOURCE_FRESHNESS_UNVERIFIED);
            }
            if (proofDebugHint) {
                statusMessage += `\n⚠️ Completion proof check is temporarily unavailable (probe_failed); keeping local status.`;
                warnings.push(WARNING_CODES.IGNORE_POLICY_PROBE_FAILED);
            }
            if (
                trackedRootState.state === "ready"
                && trackedRootState.navigationStatus
                && trackedRootState.navigationStatus !== "valid"
                && trackedRootState.navigationStatus !== "not_bound"
            ) {
                warnings.push(WARNING_CODES.NAVIGATION_REINDEX_REQUIRED);
                envelopeHints = {
                    ...(envelopeHints || {}),
                    reindex: this.host.buildReindexHint(trackedRootState.root.path),
                    navigation: {
                        status: trackedRootState.navigationStatus,
                        action: "Run manage_index reindex to rebuild authoritative local navigation.",
                    },
                };
                statusMessage += `\n⚠️ Local navigation is ${trackedRootState.navigationStatus}; vector search remains proven, but authoritative symbol navigation requires manage_index reindex.`;
            }
            if (sourceCheckpointEvidence && sourceCheckpointEvidence.status !== "valid") {
                envelopeHints = {
                    ...(envelopeHints || {}),
                    reindex: this.host.buildReindexHint(trackedRootState.state === "ready" ? trackedRootState.root.path : envelopePath),
                    sourceFreshness: {
                        status: sourceCheckpointEvidence.status,
                        action: "Run manage_index reindex to restore a source-bound incremental-sync baseline.",
                    },
                };
                statusMessage += `\n⚠️ Source freshness checkpoint is ${sourceCheckpointEvidence.status}; proven vector search remains available, but incremental sync is disabled until reindex.`;
            }

            // F9: observed symbol quality from registry (not parser-cause diagnosis).
            let symbolQuality: SymbolQualitySummary | undefined;
            let languageCapabilities: LanguageCapabilityEvidenceSummary | undefined;
            let structuralCoverage: ManageStructuralCoverage | undefined;
            // Attach observed quality for lifecycle statuses that refer to a real root path.
            if (envelopeStatus === "ok" || envelopeStatus === "not_ready" || envelopeStatus === "not_indexed") {
                const lease = trackedRootState.state === 'ready'
                    ? this.host.acquirePublicationLease(envelopePath)
                    : undefined;
                const leaseMatchesReadiness = Boolean(
                    lease
                    && trackedRootState.state === 'ready'
                    && lease.id === trackedRootState.publication.id
                    && await this.host.isPublicationAdmitted(lease)
                );
                const navigation = leaseMatchesReadiness && lease
                    ? this.host.getPublicationNavigationAddress(lease)
                    : null;
                try {
                    const registryRead = navigation
                        ? await readSymbolRegistrySidecar({
                            normalizedRootPath: envelopePath,
                            publicationId: navigation.publicationId,
                            navigationRoot: navigation.navigationRoot,
                        })
                        : undefined;
                    const evidenceAvailability: SymbolQualitySummary['evidenceAvailability'] =
                        trackedRootState.state === 'ready'
                            && trackedRootState.navigationStatus === 'valid'
                            && registryRead?.status === 'ok'
                            ? 'ready'
                            : !registryRead || registryRead.status === 'missing'
                                ? 'missing'
                                : 'unverified';
                    symbolQuality = registryRead
                        ? {
                            ...computeSymbolQualitySummaryFromSidecarRead(registryRead),
                            evidenceAvailability,
                        }
                        : {
                            ...unknownSymbolQualitySummary('Observed symbol quality unavailable (Publication navigation missing).'),
                            evidenceAvailability,
                        };
                    if (includeCapabilities && registryRead && navigation) {
                        languageCapabilities = await resolveLanguageCapabilityEvidence({
                            normalizedRootPath: envelopePath,
                            searchable: envelopeStatus === "ok" && evidenceAvailability === 'ready',
                            publicationId: navigation.publicationId,
                            navigationRoot: navigation.navigationRoot,
                            registryRead,
                        });
                        if (registryRead.status === "ok" && registryRead.registry) {
                            const structuralLanguages = new Set(
                                languageCapabilities.languages
                                    .filter((entry) => (
                                        entry.declaredClaim !== "search_only"
                                        && entry.declaredClaim !== "undeclared"
                                    ))
                                    .map((entry) => entry.language),
                            );
                            const eligibleFiles = registryRead.registry.manifest.files.filter((file) => (
                                structuralLanguages.has(file.language.trim().toLowerCase())
                            ));
                            const gapFiles = eligibleFiles
                                .filter((file) => file.definitionStatus === "structural_unavailable")
                                .sort((left, right) => left.path.localeCompare(right.path));
                            const disclosedGaps = gapFiles.slice(0, 50).map((file) => ({
                                path: file.path,
                                language: file.language,
                                reason: "structural_evidence_unavailable" as const,
                            }));
                            structuralCoverage = {
                                basis: "symbol_registry_manifest",
                                status: gapFiles.length > 0 ? "degraded" : "ready",
                                eligibleFileCount: eligibleFiles.length,
                                gapFileCount: gapFiles.length,
                                gaps: disclosedGaps,
                                omittedGapCount: Math.max(0, gapFiles.length - disclosedGaps.length),
                            };
                        }
                    }
                    if (envelopeStatus === "ok") {
                        const observedSymbolQuality = symbolQuality;
                        if (observedSymbolQuality) {
                            statusMessage += `\n🧭 ${formatSymbolQualityMarker(observedSymbolQuality)}: ${observedSymbolQuality.message}`;
                        }
                    }
                } finally {
                    lease?.release();
                }
            }

            const pathInfo = codebasePath !== envelopePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${envelopePath}'`
                : "";
            const compatibilityStatus = includeDiagnostics
                ? this.host.buildCompatibilityStatusLines(envelopePath)
                : "";
            let runtimeOwnersLine = "";
            if (includeDiagnostics && typeof this.host.getLiveOwnersSummary === "function") {
                try {
                    const ownersSummary = await this.host.getLiveOwnersSummary();
                    if (ownersSummary) {
                        runtimeOwnersLine = `\n👥 ${formatRuntimeOwnersStatusLine(ownersSummary)}`;
                        envelopeHints = {
                            ...(envelopeHints || {}),
                            runtimeOwners: ownersSummary,
                        };
                    }
                } catch {
                    // Diagnostic only; never fail status on owner registry issues.
                }
            }

            const activeMutation = this.host.mutationRuntime.getActiveMutation(envelopePath);
            const activeMutationLine = activeMutation ? `\n${formatActiveMutationStatusLine(activeMutation)}` : "";
            if (activeMutation) {
                envelopeHints = {
                    ...(envelopeHints || {}),
                    activeMutation,
                };
            }

            const operation = this.host.mutationRuntime.getOperation(envelopePath);
            const pendingSync = activeMutation?.action === "sync"
                ? pendingSyncProjection(operation, activeMutation)
                : undefined;
            if (pendingSync) {
                statusMessage += `\n🔄 Background sync is pending: operation=${pendingSync.operationId} phase=${pendingSync.phase}${pendingSync.progress !== undefined ? ` progress=${pendingSync.progress}%` : ""}. The completed Publication above remains the readable generation until replacement activation.`;
            }
            const publication = trackedRootState.state === "ready"
                ? {
                    publicationId: trackedRootState.publication.id,
                    collectionName: trackedRootState.publication.publication.vector.collectionName,
                    policyHash: trackedRootState.publication.publication.policy.policyHash,
                }
                : undefined;

            return this.host.manageResponse(
                "status",
                envelopePath,
                envelopeStatus,
                statusMessage + compatibilityStatus + pathInfo + runtimeOwnersLine + activeMutationLine,
                {
                    detail,
                    reason: envelopeReason,
                    hints: envelopeHints,
                    warnings,
                    ...(symbolQuality ? {
                        symbolQuality: includeCapabilities
                            ? symbolQuality
                            : {
                                status: symbolQuality.status,
                                basis: symbolQuality.basis,
                                message: symbolQuality.message,
                                evidenceAvailability: symbolQuality.evidenceAvailability,
                            },
                    } : {}),
                    ...(languageCapabilities ? { languageCapabilities } : {}),
                    ...(structuralCoverage ? { structuralCoverage } : {}),
                    ...(operation ? { operation } : {}),
                    ...(publication ? { publication } : {}),
                    ...(sourceFreshness ? { sourceFreshness } : {}),
                    ...(pendingSync ? { pendingSync } : {}),
                    ...(envelopeMessage ? { message: envelopeMessage } : {}),
                },
            );
        } catch (error: unknown) {
            return this.host.manageResponse("status", requestedPath, "error", `Error getting indexing status: ${formatUnknownError(error)}`, { detail });
        }
    }

    public async handleSyncCodebase(
        args: ToolArgs,
        requestSignal?: AbortSignal,
    ): Promise<ToolTextResponse> {
        const codebasePath = typeof args.path === "string" ? args.path : "";
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("sync", codebasePath, "error", absolutePathResult.message);
        }
        const requestedPath = absolutePathResult.absolutePath;

        try {
            const absolutePath = requestedPath;
            if (!fs.existsSync(absolutePath)) {
                return this.host.manageResponse("sync", absolutePath, "error", `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`);
            }
            if (!fs.statSync(absolutePath).isDirectory()) {
                return this.host.manageResponse("sync", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
            }

            const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked("sync", absolutePath);
            if (runtimeOwnerConflict) return runtimeOwnerConflict;

            const currentPublication = this.host.context.getCurrentPublication(absolutePath);
            if (!currentPublication) {
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "not_indexed",
                    `Codebase '${absolutePath}' has no completed Publication to refresh.`,
                    {
                        reason: "not_indexed",
                        hints: { create: this.host.buildCreateHint(absolutePath) },
                    },
                );
            }
            if (currentPublication.publication.status !== "complete") {
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "requires_reindex",
                    this.host.buildReindexInstruction(
                        absolutePath,
                        "The current Publication is partial; incremental sync requires a complete Publication baseline.",
                    ),
                    {
                        reason: "requires_reindex",
                        hints: {
                            reindex: this.host.buildReindexHint(absolutePath),
                            status: this.host.buildStatusHint(absolutePath),
                        },
                    },
                );
            }

            const mutation = this.host.mutationRuntime.start(
                absolutePath,
                "sync",
                async (execution: RootMutationExecution) => {
                    execution.update("preflight", { progress: 0 });
                    let requestedTerminalPhase: "completed" | "blocked" | undefined;
                    let requestedTerminalProgress: number | undefined;
                    let boundActivity: RootMutationActivity | undefined;
                    const worker = spawnSupervisedMutationWorker({
                        operationId: execution.id,
                        workerPath: resolveMutationSyncWorkerPath(),
                        workerArgs: [JSON.stringify({ path: absolutePath })],
                        signal: execution.signal,
                        noProgressTimeoutMs: SYNC_NO_PROGRESS_TIMEOUT_MS,
                        onHeartbeat: () => {
                            const operation = this.host.mutationRuntime.getCurrentOperation(absolutePath);
                            if (
                                operation?.id === execution.id
                                && !TERMINAL_OPERATION_PHASES.has(operation.phase)
                            ) {
                                execution.heartbeat();
                            }
                        },
                        onProgress: (progress) => {
                            if (progress.phase && TERMINAL_OPERATION_PHASES.has(progress.phase)) {
                                if (progress.phase === "completed" || progress.phase === "blocked") {
                                    requestedTerminalPhase = progress.phase;
                                    requestedTerminalProgress = progress.progress;
                                }
                                return;
                            }
                            const operation = this.host.mutationRuntime.getCurrentOperation(absolutePath);
                            if (
                                !operation
                                || operation.id !== execution.id
                                || operation.phase === "cancelling"
                                || TERMINAL_OPERATION_PHASES.has(operation.phase)
                            ) {
                                return;
                            }
                            execution.update(
                                progress.phase ?? operation.phase,
                                progress.progress !== undefined ? { progress: progress.progress } : {},
                            );
                        },
                        onNoProgress: () => {
                            this.host.mutationRuntime.requestCancellation(
                                execution.id,
                                "sync_no_progress_timeout",
                            );
                        },
                    });

                    try {
                        await worker.ready;
                        if (execution.signal.aborted) {
                            throw execution.signal.reason ?? new Error("Sync cancelled before executor binding.");
                        }
                        boundActivity = execution.bindExecutor(worker.executor);
                        worker.start();
                    } catch (error) {
                        worker.requestCancellation("sync_startup_failed");
                        await worker.completion.catch(() => undefined);
                        throw error;
                    }

                    const operation = this.host.mutationRuntime.getCurrentOperation(absolutePath);
                    const publication = {
                        publicationId: currentPublication.id,
                        collectionName: currentPublication.publication.vector.collectionName,
                        policyHash: currentPublication.publication.policy.policyHash,
                    };
                    const response = this.host.manageResponse(
                        "sync",
                        absolutePath,
                        "ok",
                        `Accepted background sync for '${absolutePath}'. The current completed Publication remains available to search and navigation while the replacement is prepared. Use manage_index status to observe operation '${execution.id}'.`,
                        {
                            hints: {
                                status: this.host.buildStatusHint(absolutePath),
                                cancel: {
                                    tool: "manage_index",
                                    args: {
                                        action: "cancel",
                                        path: absolutePath,
                                        operationId: execution.id,
                                    },
                                },
                            },
                            ...(operation ? { operation } : {}),
                            publication,
                            pendingSync: pendingSyncProjection(operation, boundActivity),
                        },
                    );

                    return {
                        response,
                        completion: (async () => {
                            try {
                                await worker.completion;
                                if (!this.host.mutationRuntime.isCurrent(absolutePath)) return;

                                await this.host.collectPublicationGarbageAfterSync(absolutePath);
                                if (!this.host.mutationRuntime.isCurrent(absolutePath)) return;

                                const currentOperation = this.host.mutationRuntime.getCurrentOperation(absolutePath);
                                if (
                                    currentOperation?.id === execution.id
                                    && currentOperation.phase !== "cancelling"
                                    && !TERMINAL_OPERATION_PHASES.has(currentOperation.phase)
                                ) {
                                    execution.update(
                                        requestedTerminalPhase ?? "completed",
                                        requestedTerminalProgress !== undefined
                                            ? { progress: requestedTerminalProgress }
                                            : requestedTerminalPhase === "blocked"
                                                ? {}
                                                : { progress: 100 },
                                    );
                                }
                            } catch (error) {
                                if (this.host.mutationRuntime.isCurrent(absolutePath)) {
                                    const currentOperation = this.host.mutationRuntime.getCurrentOperation(absolutePath);
                                    if (
                                        currentOperation?.id === execution.id
                                        && !TERMINAL_OPERATION_PHASES.has(currentOperation.phase)
                                    ) {
                                        if (error instanceof MutationWorkerCancelledError) {
                                            execution.update("cancelled");
                                        } else {
                                            execution.update("failed", { error: formatUnknownError(error) });
                                        }
                                    }
                                }
                                throw error;
                            }
                        })(),
                    };
                },
                { signal: requestSignal },
            );

            this.host.ownDetachedMutationCompletion(mutation.completion);
            const postSyncMaintenance = mutation.completion.then(
                async () => {
                    const terminal = this.host.mutationRuntime.getOperation(absolutePath);
                    if (terminal?.id !== mutation.operationId || terminal.phase !== "blocked") return;
                    try {
                        await this.host.trackedRootReadiness.prepareTrackedRootForRead(absolutePath);
                    } catch (error) {
                        console.warn(
                            `[SYNC] Post-sync automatic maintenance check failed for '${absolutePath}': ${formatUnknownError(error)}`,
                        );
                    }
                },
                () => undefined,
            );
            this.host.ownDetachedMutationCompletion(postSyncMaintenance);
            void mutation.completion.catch((error: unknown) => {
                console.error(`[SYNC] Detached supervised sync rejected for '${absolutePath}':`, error);
            });
            try {
                return await mutation.started;
            } catch (error) {
                if (error instanceof RootMutationInProgressError) {
                    return this.host.manageResponse(
                        "sync",
                        absolutePath,
                        "blocked",
                        formatRootMutationBlockedMessage(error.activeMutation),
                        {
                            reason: "mutation_in_progress",
                            hints: {
                                status: this.host.buildStatusHint(absolutePath),
                                activeMutation: error.activeMutation,
                            },
                        },
                    );
                }
                throw error;
            }
        } catch (error: unknown) {
            console.error("[SYNC] Error starting supervised sync:", error);
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                return this.host.manageVectorBackendResponse("sync", requestedPath, vectorBackendDiagnostic);
            }
            return this.host.manageResponse(
                "sync",
                requestedPath,
                "error",
                `Error starting sync: ${formatUnknownError(error)}`,
            );
        }
    }

    public async handleCancelOperation(args: ToolArgs): Promise<ToolTextResponse> {
        const codebasePath = typeof args.path === "string" ? args.path : "";
        const operationId = typeof args.operationId === "string" ? args.operationId.trim() : "";
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("cancel", codebasePath, "error", absolutePathResult.message);
        }
        const absolutePath = absolutePathResult.absolutePath;
        if (!operationId) {
            return this.host.manageResponse(
                "cancel",
                absolutePath,
                "error",
                "operationId is required for exact cancellation.",
            );
        }

        const activeMutation = this.host.mutationRuntime.getActiveMutation(absolutePath);
        if (!activeMutation || activeMutation.id !== operationId) {
            return this.host.manageResponse(
                "cancel",
                absolutePath,
                "blocked",
                `Operation '${operationId}' is not the live mutation for '${absolutePath}'. No cancellation was sent.`,
                {
                    reason: "operation_not_live",
                    hints: {
                        ...(activeMutation ? { activeMutation } : {}),
                        status: this.host.buildStatusHint(absolutePath),
                    },
                },
            );
        }
        const supervisedAction = activeMutation.action === "sync"
            || activeMutation.action === "create"
            || activeMutation.action === "reindex";
        const hasBoundExecutor = activeMutation.executorPid !== undefined
            && activeMutation.executorProcessGroupId !== undefined;
        if (!supervisedAction || !hasBoundExecutor) {
            return this.host.manageResponse(
                "cancel",
                absolutePath,
                "blocked",
                `Operation '${operationId}' is a live '${activeMutation.action}' mutation without a cancellable supervised executor. No force-unlock was attempted.`,
                {
                    reason: "operation_not_cancellable",
                    hints: { activeMutation },
                },
            );
        }

        const accepted = this.host.mutationRuntime.requestCancellation(
            operationId,
            "requested_by_manage_index",
        );
        if (!accepted) {
            return this.host.manageResponse(
                "cancel",
                absolutePath,
                "blocked",
                `Operation '${operationId}' is no longer live. No cancellation was sent.`,
                {
                    reason: "operation_not_live",
                    hints: { status: this.host.buildStatusHint(absolutePath) },
                },
            );
        }

        const operation = this.host.mutationRuntime.getOperation(absolutePath);
        const currentActivity = this.host.mutationRuntime.getActiveMutation(absolutePath);
        return this.host.manageResponse(
            "cancel",
            absolutePath,
            "ok",
            `Cancellation was requested for ${activeMutation.action} operation '${operationId}'. The writer lease remains held until the supervised executor process tree is proven quiescent.`,
            {
                reason: "cancellation_requested",
                ...(operation ? { operation } : {}),
                hints: {
                    status: this.host.buildStatusHint(absolutePath),
                    ...(currentActivity ? { activeMutation: currentActivity } : {}),
                },
                ...(activeMutation.action === "sync"
                    ? { pendingSync: pendingSyncProjection(operation, currentActivity) }
                    : {}),
            },
        );
    }
}
