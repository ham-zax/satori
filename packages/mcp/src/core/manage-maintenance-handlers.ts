import * as fs from "fs";
import {
    COLLECTION_LIMIT_MESSAGE,
    RemoteCollectionDeletePendingError,
    formatSymbolQualityMarker,
    resolveSymbolQualitySummary,
    type Context,
    type SymbolQualitySummary,
} from "@zokizuan/satori-core";
import type { SnapshotCorruptionWarning, SnapshotManager } from "./snapshot.js";
import type { SyncManager } from "./sync.js";
import type {
    CompletionProbeDebugHint,
    TrackedRootReadiness,
} from "./tracked-root-readiness.js";
import { WARNING_CODES, type WarningCode } from "./warnings.js";
import {
    classifyVectorBackendError,
    type VectorBackendDiagnostic,
} from "./backend-diagnostics.js";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import {
    formatRuntimeOwnersStatusLine,
    type RuntimeOwnersSummary,
} from "./runtime-owner.js";

type ToolArgs = Record<string, unknown>;

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type ManageIndexStatus =
    | "ok"
    | "error"
    | "not_ready"
    | "not_indexed"
    | "blocked"
    | "requires_reindex";

type ManageIndexReason =
    | "indexing"
    | "not_indexed"
    | "requires_reindex"
    | "unnecessary_reindex_ignore_only"
    | "remote_delete_pending"
    | "backend_timeout"
    | "needs_create";

type ManageMaintenanceHandlersHost = {
    context: Pick<Context, "clearIndex">;
    snapshotManager: Pick<SnapshotManager, "removeCodebaseCompletely">;
    syncManager: Pick<SyncManager, "ensureFreshness">;
    trackedRootReadiness: Pick<
        TrackedRootReadiness,
        "prepareTrackedRootForRead" | "buildMissingLocalCollectionMessage"
    >;
    getSnapshotAllCodebases(): string[];
    getSnapshotIndexedCodebases(): string[];
    getSnapshotIndexingCodebases(): string[];
    getSnapshotCodebaseStatus(codebasePath: string): string;
    getSnapshotCodebaseInfo(codebasePath: string): Record<string, unknown> | undefined;
    getSnapshotCorruptionWarning(): SnapshotCorruptionWarning | undefined;
    buildRuntimeOwnerConflictResponseIfBlocked(action: "clear" | "sync", codebasePath: string): Promise<ToolTextResponse | null>;
    recoverStaleIndexingStateIfNeeded(codebasePath: string): Promise<void>;
    manageResponse(
        action: string,
        path: string,
        status: ManageIndexStatus | string,
        message: string,
        options?: Record<string, unknown>,
    ): ToolTextResponse;
    buildCreateHint(codebasePath: string): Record<string, unknown>;
    buildManageActionBlockedMessage(codebasePath: string, action: "clear" | "sync"): string;
    buildStatusHint(codebasePath: string): Record<string, unknown>;
    getManageRetryAfterMs(): number;
    buildIndexingMetadata(codebasePath: string): Record<string, unknown> | undefined;
    markCodebaseCleared(codebasePath: string, collectionName: string): void;
    resolveCollectionName(codebasePath: string): string;
    clearIndexingStats(): void;
    saveSnapshotIfSupported(): void;
    unwatchCodebase(codebasePath: string): Promise<void>;
    refreshSnapshotStateFromDisk(): void;
    buildReindexInstruction(codebasePath: string, detail?: string): string;
    buildCompatibilityStatusLines(codebasePath: string): string;
    buildManageRequiresReindexHints(codebasePath: string): Record<string, unknown>;
    buildSyncHint(codebasePath: string): Record<string, unknown>;
    buildStaleLocalHint(codebasePath: string, reason: string): Record<string, unknown>;
    buildStaleLocalMessage(codebasePath: string, requestedPath: string, reason: string): string;
    canSyncStaleLocal(codebasePath: string, reason: string): boolean;
    enforceFingerprintGate(codebasePath: string): { blockedResponse?: ToolTextResponse; message?: string };
    buildReindexHint(codebasePath: string): Record<string, unknown>;
    touchWatchedCodebase(codebasePath: string): Promise<void>;
    manageVectorBackendResponse(
        action: string,
        path: string,
        diagnostic: VectorBackendDiagnostic,
        humanText?: string,
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

export class ManageMaintenanceHandlers {
    constructor(private readonly host: ManageMaintenanceHandlersHost) {}

    public async handleClearIndex(args: ToolArgs): Promise<ToolTextResponse> {
        const codebasePath = typeof args.path === "string" ? args.path : "";
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("clear", codebasePath, "error", absolutePathResult.message);
        }
        const requestedPath = absolutePathResult.absolutePath;

        if (this.host.getSnapshotAllCodebases().length === 0) {
            return this.host.manageResponse(
                "clear",
                requestedPath,
                "not_indexed",
                "No codebases are currently tracked.",
                { reason: "not_indexed" },
            );
        }

        try {
            const absolutePath = requestedPath;
            const pathExists = fs.existsSync(absolutePath);

            if (pathExists) {
                const stat = fs.statSync(absolutePath);
                if (!stat.isDirectory()) {
                    return this.host.manageResponse("clear", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
                }
            }

            const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked("clear", absolutePath);
            if (runtimeOwnerConflict) {
                return runtimeOwnerConflict;
            }

            if (pathExists) {
                await this.host.recoverStaleIndexingStateIfNeeded(absolutePath);
            }

            const isIndexed = this.host.getSnapshotIndexedCodebases().includes(absolutePath);
            const isIndexing = this.host.getSnapshotIndexingCodebases().includes(absolutePath);
            const status = this.host.getSnapshotCodebaseStatus(absolutePath);
            const isRequiresReindex = status === "requires_reindex";

            if (!isIndexed && !isIndexing && !isRequiresReindex) {
                if (!pathExists) {
                    return this.host.manageResponse("clear", absolutePath, "error", `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`);
                }
                return this.host.manageResponse(
                    "clear",
                    absolutePath,
                    "not_indexed",
                    `Error: Codebase '${absolutePath}' is not indexed or being indexed.`,
                    {
                        reason: "not_indexed",
                        hints: {
                            create: this.host.buildCreateHint(absolutePath),
                        },
                    },
                );
            }

            if (isIndexing) {
                return this.host.manageResponse(
                    "clear",
                    absolutePath,
                    "not_ready",
                    this.host.buildManageActionBlockedMessage(absolutePath, "clear"),
                    {
                        reason: "indexing",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            retryAfterMs: this.host.getManageRetryAfterMs(),
                            indexing: this.host.buildIndexingMetadata(absolutePath),
                        },
                    },
                );
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            try {
                await this.host.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: unknown) {
                if (error instanceof RemoteCollectionDeletePendingError) {
                    const errorMsg = `Remote deletion is still pending for ${absolutePath}. Local index state was not changed. Details: ${formatUnknownError(error)}`;
                    console.error(`[CLEAR] ${errorMsg}`);
                    return this.host.manageResponse("clear", absolutePath, "error", errorMsg, {
                        reason: "remote_delete_pending",
                        hints: {
                            retry: this.host.buildStatusHint(absolutePath),
                            clear: { tool: "manage_index", args: { action: "clear", path: absolutePath } },
                        },
                    });
                }
                const errorMsg = `Failed to clear ${absolutePath}: ${formatUnknownError(error)}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return this.host.manageResponse("clear", absolutePath, "error", errorMsg);
            }

            this.host.snapshotManager.removeCodebaseCompletely(absolutePath);
            this.host.markCodebaseCleared(absolutePath, this.host.resolveCollectionName(absolutePath));
            this.host.clearIndexingStats();
            this.host.saveSnapshotIfSupported();
            await this.host.unwatchCodebase(absolutePath);

            let resultText = `Successfully cleared codebase '${absolutePath}'`;
            const remainingIndexed = this.host.getSnapshotIndexedCodebases().length;
            const remainingIndexing = this.host.getSnapshotIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return this.host.manageResponse("clear", absolutePath, "ok", resultText);
        } catch (error) {
            const errorMessage = typeof error === "string" ? error : (error instanceof Error ? error.message : String(error));
            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                return this.host.manageResponse("clear", requestedPath, "error", COLLECTION_LIMIT_MESSAGE);
            }
            return this.host.manageResponse("clear", requestedPath, "error", `Error clearing index: ${errorMessage}`);
        }
    }

    public async handleGetIndexingStatus(args: ToolArgs): Promise<ToolTextResponse> {
        const codebasePath = typeof args.path === "string" ? args.path : "";
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("status", codebasePath, "error", absolutePathResult.message);
        }
        const requestedPath = absolutePathResult.absolutePath;

        try {
            const absolutePath = requestedPath;

            if (!fs.existsSync(absolutePath)) {
                return this.host.manageResponse("status", absolutePath, "error", `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`);
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.host.manageResponse("status", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
            }

            this.host.refreshSnapshotStateFromDisk();
            const snapshotCorruptionWarning = this.host.getSnapshotCorruptionWarning();
            await this.host.recoverStaleIndexingStateIfNeeded(absolutePath);

            const trackedRootState = await this.host.trackedRootReadiness.prepareTrackedRootForRead(absolutePath);
            if (trackedRootState.state === "requires_reindex") {
                const statusMessage = this.host.buildReindexInstruction(trackedRootState.codebasePath, trackedRootState.message);
                const compatibilityStatus = this.host.buildCompatibilityStatusLines(trackedRootState.codebasePath);
                const pathInfo = codebasePath !== trackedRootState.codebasePath
                    ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${trackedRootState.codebasePath}'`
                    : "";
                return this.host.manageResponse(
                    "status",
                    trackedRootState.codebasePath,
                    "requires_reindex",
                    statusMessage + compatibilityStatus + pathInfo,
                    {
                        reason: "requires_reindex",
                        hints: this.host.buildManageRequiresReindexHints(trackedRootState.codebasePath),
                    },
                );
            }

            let statusMessage = "";
            let envelopePath = absolutePath;
            let envelopeStatus: ManageIndexStatus = "ok";
            let envelopeReason: ManageIndexReason | undefined;
            let envelopeHints: Record<string, unknown> | undefined;
            let proofDebugHint: CompletionProbeDebugHint | undefined;

            if (trackedRootState.state === "not_indexed") {
                envelopeStatus = "not_indexed";
                envelopeReason = "not_indexed";
                envelopeHints = { create: this.host.buildCreateHint(absolutePath) };
                statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Call manage_index with {"action":"create","path":"${absolutePath}"} to index it first.`;
            } else if (trackedRootState.state === "stale_local") {
                envelopePath = trackedRootState.codebasePath;
                envelopeStatus = "not_indexed";
                envelopeReason = "not_indexed";
                const syncable = this.host.canSyncStaleLocal(trackedRootState.codebasePath, trackedRootState.reason);
                envelopeHints = {
                    ...(syncable ? { sync: this.host.buildSyncHint(trackedRootState.codebasePath) } : {}),
                    create: this.host.buildCreateHint(trackedRootState.codebasePath),
                    staleLocal: this.host.buildStaleLocalHint(trackedRootState.codebasePath, trackedRootState.reason),
                };
                const nextAction = syncable ? "sync" : trackedRootState.reason === "missing_marker_doc" ? "repair" : "create";
                const nextVerb = syncable ? "sync it" : nextAction === "repair" ? "repair it" : "create it";
                statusMessage = `❌ ${this.host.buildStaleLocalMessage(trackedRootState.codebasePath, absolutePath, trackedRootState.reason)} Run manage_index with {"action":"${nextAction}","path":"${trackedRootState.codebasePath}"} to ${nextVerb}.`;
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
                const info = this.host.getSnapshotCodebaseInfo(trackedRootState.codebasePath);
                if (info?.status === "indexing") {
                    const progressPercentage = typeof info.indexingPercentage === "number" && Number.isFinite(info.indexingPercentage)
                        ? info.indexingPercentage
                        : 0;
                    statusMessage = `🔄 Codebase '${trackedRootState.codebasePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;
                    if (progressPercentage < 10) {
                        statusMessage += " (Preparing and scanning files...)";
                    } else if (progressPercentage < 100) {
                        statusMessage += " (Processing files and generating embeddings...)";
                    }
                    if (typeof info.lastUpdated === "string") {
                        statusMessage += `\n🕐 Last updated: ${new Date(info.lastUpdated).toLocaleString()}`;
                    }
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
                const status = this.host.getSnapshotCodebaseStatus(trackedRootState.root.path);
                const info = trackedRootState.root.info || this.host.getSnapshotCodebaseInfo(trackedRootState.root.path);
                switch (status) {
                    case "indexed":
                        if (info?.status === "indexed" && info.indexStatus === "limit_reached") {
                            statusMessage = `⚠️ Codebase '${trackedRootState.root.path}' is partially indexed (limit_reached).`;
                            statusMessage += `\n📊 Statistics: ${info.indexedFiles} files, ${info.totalChunks} chunks`;
                            statusMessage += `\n📅 Status: ${info.indexStatus}`;
                            statusMessage += `\nSearch may return incomplete results; file_outline/call_graph are unavailable until a full reindex completes.`;
                            if (typeof info.lastUpdated === "string") {
                                statusMessage += `\n🕐 Last updated: ${new Date(info.lastUpdated).toLocaleString()}`;
                            }
                        } else if (info?.status === "indexed") {
                            statusMessage = `✅ Codebase '${trackedRootState.root.path}' is fully indexed and ready for search.`;
                            statusMessage += `\n📊 Statistics: ${info.indexedFiles} files, ${info.totalChunks} chunks`;
                            statusMessage += `\n📅 Status: ${info.indexStatus}`;
                            if (typeof info.lastUpdated === "string") {
                                statusMessage += `\n🕐 Last updated: ${new Date(info.lastUpdated).toLocaleString()}`;
                            }
                        } else {
                            statusMessage = `✅ Codebase '${trackedRootState.root.path}' is fully indexed and ready for search.`;
                        }
                        break;

                    case "sync_completed":
                        if (info?.status === "sync_completed") {
                            statusMessage = `🔄 Codebase '${trackedRootState.root.path}' sync completed.`;
                            statusMessage += `\n📊 Changes: +${info.added} added, -${info.removed} removed, ~${info.modified} modified`;
                            if (typeof info.lastUpdated === "string") {
                                statusMessage += `\n🕐 Last synced: ${new Date(info.lastUpdated).toLocaleString()}`;
                            }
                        } else {
                            statusMessage = `🔄 Codebase '${trackedRootState.root.path}' sync completed.`;
                        }
                        break;

                    case "not_found":
                    default:
                        envelopeStatus = "not_indexed";
                        envelopeReason = "not_indexed";
                        envelopeHints = { create: this.host.buildCreateHint(trackedRootState.root.path) };
                        statusMessage = `❌ Codebase '${trackedRootState.root.path}' is not indexed. Call manage_index with {"action":"create","path":"${trackedRootState.root.path}"} to index it first.`;
                        break;
                }
            }

            const warnings: WarningCode[] = [];
            if (proofDebugHint) {
                statusMessage += `\n⚠️ Completion proof check is temporarily unavailable (probe_failed); keeping local status.`;
                warnings.push(WARNING_CODES.IGNORE_POLICY_PROBE_FAILED);
            }

            // F9: observed symbol quality from registry (not parser-cause diagnosis).
            let symbolQuality: SymbolQualitySummary | undefined;
            // Attach observed quality for lifecycle statuses that refer to a real root path.
            if (envelopeStatus === "ok" || envelopeStatus === "not_ready" || envelopeStatus === "not_indexed") {
                symbolQuality = await resolveSymbolQualitySummary({
                    normalizedRootPath: envelopePath,
                });
                if (envelopeStatus === "ok") {
                    statusMessage += `\n🧭 ${formatSymbolQualityMarker(symbolQuality)}: ${symbolQuality.message}`;
                }
            }

            const pathInfo = codebasePath !== envelopePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${envelopePath}'`
                : "";
            const compatibilityStatus = this.host.buildCompatibilityStatusLines(envelopePath);
            const snapshotWarningText = snapshotCorruptionWarning
                ? `\nWARNING: Snapshot state was recovered after a corrupt snapshot was quarantined. Tracked codebases may be incomplete.`
                + `\nSnapshot path: ${snapshotCorruptionWarning.snapshotPath}`
                + (typeof snapshotCorruptionWarning.quarantinedPath === "string" ? `\nQuarantined snapshot: ${snapshotCorruptionWarning.quarantinedPath}` : "")
                + `\nReason: ${snapshotCorruptionWarning.message}`
                : "";
            if (snapshotCorruptionWarning) {
                envelopeHints = {
                    ...(envelopeHints || {}),
                    snapshotCorruption: snapshotCorruptionWarning,
                };
            }

            let runtimeOwnersLine = "";
            if (typeof this.host.getLiveOwnersSummary === "function") {
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

            return this.host.manageResponse(
                "status",
                envelopePath,
                envelopeStatus,
                statusMessage + compatibilityStatus + pathInfo + snapshotWarningText + runtimeOwnersLine,
                {
                    reason: envelopeReason,
                    hints: envelopeHints,
                    warnings,
                    ...(symbolQuality ? { symbolQuality } : {}),
                },
            );
        } catch (error: unknown) {
            return this.host.manageResponse("status", requestedPath, "error", `Error getting indexing status: ${formatUnknownError(error)}`);
        }
    }

    public async handleSyncCodebase(args: ToolArgs): Promise<ToolTextResponse> {
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

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.host.manageResponse("sync", absolutePath, "error", `Error: Path '${absolutePath}' is not a directory`);
            }

            const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked("sync", absolutePath);
            if (runtimeOwnerConflict) {
                return runtimeOwnerConflict;
            }

            await this.host.recoverStaleIndexingStateIfNeeded(absolutePath);

            const syncGate = this.host.enforceFingerprintGate(absolutePath);
            if (syncGate.blockedResponse) {
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "requires_reindex",
                    this.host.buildReindexInstruction(absolutePath, syncGate.message),
                    {
                        reason: "requires_reindex",
                        hints: {
                            reindex: this.host.buildReindexHint(absolutePath),
                            status: this.host.buildStatusHint(absolutePath),
                        },
                    },
                );
            }

            if (this.host.getSnapshotIndexingCodebases().includes(absolutePath)) {
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "not_ready",
                    this.host.buildManageActionBlockedMessage(absolutePath, "sync"),
                    {
                        reason: "indexing",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            retryAfterMs: this.host.getManageRetryAfterMs(),
                            indexing: this.host.buildIndexingMetadata(absolutePath),
                        },
                    },
                );
            }

            const isIndexed = this.host.getSnapshotIndexedCodebases().includes(absolutePath);
            if (!isIndexed) {
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "not_indexed",
                    `Error: Codebase '${absolutePath}' is not indexed. Call manage_index with {"action":"create","path":"${absolutePath}"} first.`,
                    {
                        reason: "not_indexed",
                        hints: {
                            create: this.host.buildCreateHint(absolutePath),
                        },
                    },
                );
            }

            console.log(`[SYNC] Manually triggering incremental sync for: ${absolutePath}`);
            const decision = await this.host.syncManager.ensureFreshness(absolutePath, 0);

            if (decision.mode === "ignore_reload_failed") {
                const fallbackLine = decision.fallbackSyncExecuted
                    ? "\nFallback incremental sync was executed, but ignore-rule reconciliation did not complete deterministically."
                    : "";
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "error",
                    `Error syncing codebase: ignore-rule reconciliation failed (${decision.errorMessage || "unknown_ignore_reload_error"}).${fallbackLine}`,
                );
            }

            if (decision.mode === "skipped_indexing") {
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "not_ready",
                    this.host.buildManageActionBlockedMessage(absolutePath, "sync"),
                    {
                        reason: "indexing",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            retryAfterMs: this.host.getManageRetryAfterMs(),
                            indexing: this.host.buildIndexingMetadata(absolutePath),
                        },
                    },
                );
            }

            if (decision.mode === "skipped_requires_reindex") {
                return this.host.manageResponse(
                    "sync",
                    absolutePath,
                    "requires_reindex",
                    this.host.buildReindexInstruction(absolutePath, "Sync blocked because this codebase requires reindex."),
                    {
                        reason: "requires_reindex",
                        hints: {
                            reindex: this.host.buildReindexHint(absolutePath),
                            status: this.host.buildStatusHint(absolutePath),
                        },
                    },
                );
            }

            if (decision.mode === "skipped_missing_path") {
                return this.host.manageResponse("sync", absolutePath, "error", `Error: Codebase path '${absolutePath}' no longer exists.`);
            }

            const added = decision.stats?.added ?? 0;
            const removed = decision.stats?.removed ?? 0;
            const modified = decision.stats?.modified ?? 0;
            const ignoredDeletes = decision.deletedFiles ?? 0;
            const totalChanges = added + removed + modified;

            if (decision.mode === "coalesced") {
                if (typeof decision.errorMessage === "string" && decision.errorMessage.trim().length > 0) {
                    const fallbackLine = decision.fallbackSyncExecuted
                        ? "\nFallback incremental sync was executed, but ignore-rule reconciliation did not complete deterministically."
                        : "";
                    return this.host.manageResponse(
                        "sync",
                        absolutePath,
                        "error",
                        `Error syncing codebase: coalesced in-flight reconcile failed (${decision.errorMessage}).${fallbackLine}`,
                    );
                }
                await this.host.touchWatchedCodebase(absolutePath);
                return this.host.manageResponse("sync", absolutePath, "ok", `🔄 Sync request coalesced for '${absolutePath}'. Reused in-flight sync result.`);
            }

            if (decision.mode === "reconciled_ignore_change") {
                if (totalChanges === 0 && ignoredDeletes === 0) {
                    await this.host.touchWatchedCodebase(absolutePath);
                    return this.host.manageResponse("sync", absolutePath, "ok", `✅ Ignore-rule reconciliation completed for '${absolutePath}'. No additional index changes were required.`);
                }

                const resultMessage =
                    `🔄 Incremental sync + ignore-rule reconciliation completed for '${absolutePath}'.\n\n` +
                    `📊 Sync changes:\n+ ${added} file(s) added\n- ${removed} file(s) removed\n~ ${modified} file(s) modified\n` +
                    `🧹 Ignored paths removed from index: ${ignoredDeletes}\n` +
                    `\nTotal changes: ${totalChanges + ignoredDeletes}`;
                console.log(`[SYNC] ✅ Sync+ignore reconcile completed: +${added}, -${removed}, ~${modified}, ignoredDeleted=${ignoredDeletes}`);
                await this.host.touchWatchedCodebase(absolutePath);
                return this.host.manageResponse("sync", absolutePath, "ok", resultMessage);
            }

            if (totalChanges === 0) {
                await this.host.touchWatchedCodebase(absolutePath);
                return this.host.manageResponse("sync", absolutePath, "ok", `✅ No changes detected for codebase '${absolutePath}'. Index is up to date.`);
            }

            const resultMessage = `🔄 Incremental sync completed for '${absolutePath}'.\n\n📊 Changes:\n+ ${added} file(s) added\n- ${removed} file(s) removed\n~ ${modified} file(s) modified\n\nTotal changes: ${totalChanges}`;
            console.log(`[SYNC] ✅ Sync completed: +${added}, -${removed}, ~${modified}`);
            await this.host.touchWatchedCodebase(absolutePath);
            return this.host.manageResponse("sync", absolutePath, "ok", resultMessage);
        } catch (error: unknown) {
            console.error("[SYNC] Error during sync:", error);
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                return this.host.manageVectorBackendResponse("sync", requestedPath, vectorBackendDiagnostic);
            }
            return this.host.manageResponse("sync", requestedPath, "error", `Error syncing codebase: ${formatUnknownError(error)}`);
        }
    }
}
