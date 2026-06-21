import * as fs from "fs";
import * as crypto from "node:crypto";
import {
    COLLECTION_LIMIT_MESSAGE,
    Context,
    IndexCompletionMarkerDocument,
    RemoteCollectionDeletePendingError,
} from "@zokizuan/satori-core";
import type { SnapshotManager } from "./snapshot.js";
import type { SyncManager } from "./sync.js";
import { ManageIndexAction } from "./manage-types.js";
import type { CompletionProofValidationResult } from "./completion-proof.js";
import {
    classifyVectorBackendError,
    type VectorBackendDiagnostic,
} from "./backend-diagnostics.js";
import type { IndexFingerprint } from "../config.js";
import { ensureAbsolutePath, trackCodebasePath } from "../utils.js";
import type { ReindexPreflightResult } from "./working-tree-state.js";

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type IndexCodebaseArgs = {
    path: string;
    force?: boolean;
    customExtensions?: unknown;
    ignorePatterns?: unknown;
    zillizDropCollection?: unknown;
    __reindexPreflight?: ReindexPreflightResult;
};

type ReindexCodebaseArgs = {
    path: string;
    customExtensions?: unknown;
    ignorePatterns?: unknown;
    zillizDropCollection?: unknown;
    allowUnnecessaryReindex?: boolean;
};

type IndexProfileView = {
    profile: string;
    configPath?: string;
};

type ManageIndexingHandlersHost = {
    context: Context;
    snapshotManager: SnapshotManager;
    syncManager: SyncManager;
    runtimeFingerprint: IndexFingerprint;
    startBackgroundIndexing?: (
        codebasePath: string,
        forceReindex: boolean,
        writeCollectionName?: string,
    ) => Promise<void> | void;
    manageResponse(
        action: ManageIndexAction | "reindex",
        path: string,
        status: string,
        message: string,
        options?: Record<string, unknown>,
    ): ToolTextResponse;
    buildRuntimeOwnerConflictResponseIfBlocked(
        action: ManageIndexAction | "reindex",
        codebasePath: string,
    ): Promise<ToolTextResponse | null>;
    recoverStaleIndexingStateIfNeeded(codebasePath: string): Promise<void>;
    getSnapshotIndexingCodebases(): string[];
    getSnapshotCodebaseInfo(codebasePath: string): Record<string, unknown> | undefined;
    getSnapshotIndexedCodebases(): string[];
    buildManageActionBlockedMessage(codebasePath: string, action: "create" | "reindex"): string;
    buildStatusHint(codebasePath: string): Record<string, unknown>;
    getManageRetryAfterMs(): number;
    buildIndexingMetadata(codebasePath: string): Record<string, unknown> | undefined;
    buildReindexInstruction(codebasePath: string, detail?: string): string;
    buildManageRequiresReindexHints(codebasePath: string): Record<string, unknown>;
    validateCompletionProof(codebasePath: string): Promise<CompletionProofValidationResult>;
    recoverIndexedSnapshotFromCompletionProof(
        codebasePath: string,
        proof: CompletionProofValidationResult,
    ): boolean;
    isZillizBackend(): boolean;
    resolveCollectionName(codebasePath: string): string;
    dropZillizCollectionForCreate(collectionName: string): Promise<{ droppedCodebasePath?: string }>;
    resolveStagedCollectionName(codebasePath: string, generationId: string): string;
    buildCollectionLimitMessage(codebasePath: string): Promise<string>;
    manageVectorBackendResponse(
        action: ManageIndexAction,
        path: string,
        diagnostic: VectorBackendDiagnostic,
        humanText?: string,
    ): ToolTextResponse;
    saveSnapshotIfSupported(): void;
    touchWatchedCodebase(codebasePath: string): Promise<void>;
    setWriteCollectionOverride(codebasePath: string, collectionName: string | null): void;
    loadIndexProfileForCodebase(codebasePath: string): IndexProfileView;
    getContextActiveIgnorePatterns(codebasePath: string): string[];
    getContextIndexedExtensions(codebasePath: string): string[];
    canonicalizeCodebasePath(codebasePath: string): string;
    writeIndexCompletionMarker(codebasePath: string, marker: IndexCompletionMarkerDocument): Promise<void>;
    pruneIndexedCollectionFamily(codebasePath: string, keepCollectionName: string): Promise<string[]>;
    getContextTrackedRelativePaths(codebasePath: string): string[];
    setIndexingStats(stats: { indexedFiles: number; totalChunks: number } | null): void;
    rebuildCallGraphForIndex(codebasePath: string): Promise<void>;
    getSnapshotIndexingProgress(codebasePath: string): number | undefined;
    clearIndexCompletionMarker(codebasePath: string): Promise<void>;
    evaluateReindexPreflight(codebasePath: string): ReindexPreflightResult;
};

const COLLECTION_LIMIT_PATTERNS = [
    /exceeded the limit number of collections/i,
    /collection limit/i,
    /too many collections/i,
    /quota.*collection/i,
];

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

function isCollectionLimitError(error: unknown): boolean {
    if (error === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    const message = formatUnknownError(error);
    if (message === COLLECTION_LIMIT_MESSAGE) {
        return true;
    }
    return COLLECTION_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

function isBackendTimeoutError(error: unknown): boolean {
    const message = formatUnknownError(error);
    return /DEADLINE_EXCEEDED|deadline exceeded|timeout|timed out/i.test(message);
}

export class ManageIndexingHandlers {
    constructor(private readonly host: ManageIndexingHandlersHost) {}

    public async handleIndexCodebase(args: IndexCodebaseArgs): Promise<ToolTextResponse> {
        const { path: codebasePath, force, customExtensions, ignorePatterns, zillizDropCollection } = args;
        const forceReindex = force || false;
        const manageAction: ManageIndexAction = forceReindex ? "reindex" : "create";
        const internalPreflight = forceReindex ? args.__reindexPreflight : undefined;
        const preflightOptions = internalPreflight
            ? { warnings: internalPreflight.warnings, preflight: internalPreflight }
            : {};
        const customFileExtensions = Array.isArray(customExtensions)
            ? customExtensions.filter((extension): extension is string => typeof extension === "string")
            : [];
        const customIgnorePatterns = Array.isArray(ignorePatterns)
            ? ignorePatterns.filter((pattern): pattern is string => typeof pattern === "string")
            : [];
        const requestedDropCollection = typeof zillizDropCollection === "string" ? zillizDropCollection.trim() : undefined;
        let dropSummaryLine = "";

        try {
            const absolutePath = ensureAbsolutePath(codebasePath);

            if (!fs.existsSync(absolutePath)) {
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "error",
                    `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`,
                    preflightOptions,
                );
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "error",
                    `Error: Path '${absolutePath}' is not a directory`,
                    preflightOptions,
                );
            }

            const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked(manageAction, absolutePath);
            if (runtimeOwnerConflict) {
                return runtimeOwnerConflict;
            }

            await this.host.recoverStaleIndexingStateIfNeeded(absolutePath);

            if (this.host.getSnapshotIndexingCodebases().includes(absolutePath)) {
                const blockedAction: "create" | "reindex" = forceReindex ? "reindex" : "create";
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "not_ready",
                    this.host.buildManageActionBlockedMessage(absolutePath, blockedAction),
                    {
                        ...preflightOptions,
                        reason: "indexing",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            retryAfterMs: this.host.getManageRetryAfterMs(),
                            indexing: this.host.buildIndexingMetadata(absolutePath),
                        },
                    },
                );
            }

            const existingInfo = this.host.getSnapshotCodebaseInfo(absolutePath);
            if (!forceReindex && existingInfo?.status === "requires_reindex") {
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "requires_reindex",
                    this.host.buildReindexInstruction(
                        absolutePath,
                        typeof existingInfo.message === "string" ? existingInfo.message : undefined,
                    ),
                    {
                        ...preflightOptions,
                        reason: "requires_reindex",
                        hints: this.host.buildManageRequiresReindexHints(absolutePath),
                    },
                );
            }

            const isIndexedInSnapshot = this.host.getSnapshotIndexedCodebases().includes(absolutePath);
            if (!forceReindex && !isIndexedInSnapshot) {
                const proof = await this.host.validateCompletionProof(absolutePath);
                if (this.host.recoverIndexedSnapshotFromCompletionProof(absolutePath, proof)) {
                    if (proof.outcome === "fingerprint_mismatch") {
                        return this.host.manageResponse(
                            manageAction,
                            absolutePath,
                            "requires_reindex",
                            this.host.buildReindexInstruction(
                                absolutePath,
                                "Recovered local readiness from completion marker proof, but the current runtime fingerprint does not match the existing index.",
                            ),
                            {
                                ...preflightOptions,
                                reason: "requires_reindex",
                                hints: this.host.buildManageRequiresReindexHints(absolutePath),
                            },
                        );
                    }

                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "blocked",
                        `Codebase '${absolutePath}' is already indexed. Local readiness was recovered from completion marker proof.\n\nTo update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.\nTo force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`,
                        preflightOptions,
                    );
                }
            }

            if (!forceReindex && isIndexedInSnapshot) {
                const proof = await this.host.validateCompletionProof(absolutePath);
                if (proof.outcome === "valid") {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "blocked",
                        `Codebase '${absolutePath}' is already indexed.\n\nTo update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.\nTo force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`,
                    );
                }
                console.warn(`[INDEX-VALIDATION] Snapshot reports indexed for '${absolutePath}', but completion proof is '${proof.reason || proof.outcome}'. Treating as not_indexed and continuing create flow.`);
            }

            if (requestedDropCollection) {
                if (!this.host.isZillizBackend()) {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        "Error: zillizDropCollection is only supported when connected to a Zilliz Cloud backend.",
                        preflightOptions,
                    );
                }

                const targetCollectionName = this.host.resolveCollectionName(absolutePath);
                if (requestedDropCollection === targetCollectionName) {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Error: zillizDropCollection cannot target '${targetCollectionName}' for this same codebase create flow. Use {"action":"create","path":"${absolutePath}","force":true} for reindexing this codebase.`,
                        preflightOptions,
                    );
                }

                let dropResult: { droppedCodebasePath?: string };
                try {
                    dropResult = await this.host.dropZillizCollectionForCreate(requestedDropCollection);
                } catch (error) {
                    if (error instanceof RemoteCollectionDeletePendingError) {
                        return this.host.manageResponse(
                            manageAction,
                            absolutePath,
                            "error",
                            `Zilliz collection '${requestedDropCollection}' remote deletion is still pending. Local index state was not changed. Retry after the backend has converged. Details: ${formatUnknownError(error)}`,
                            {
                                ...preflightOptions,
                                reason: "remote_delete_pending",
                                hints: {
                                    retry: {
                                        tool: "manage_index",
                                        args: { action: manageAction, path: absolutePath, zillizDropCollection: requestedDropCollection },
                                    },
                                },
                            },
                        );
                    }
                    throw error;
                }
                dropSummaryLine += dropResult.droppedCodebasePath
                    ? `\nDropped Zilliz collection '${requestedDropCollection}' (mapped codebase: '${dropResult.droppedCodebasePath}').`
                    : `\nDropped Zilliz collection '${requestedDropCollection}'.`;
            }

            const stagedCollectionName = this.host.resolveStagedCollectionName(absolutePath, `run_${crypto.randomUUID()}`);

            try {
                console.log("[INDEX-VALIDATION] 🔍 Validating collection creation capability");
                const canCreateCollection = await this.host.context.getVectorStore().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);
                    const guidanceMessage = await this.host.buildCollectionLimitMessage(absolutePath);
                    return this.host.manageResponse(manageAction, absolutePath, "error", guidanceMessage, preflightOptions);
                }

                console.log("[INDEX-VALIDATION] ✅  Collection creation validation completed");
            } catch (validationError: unknown) {
                console.error("[INDEX-VALIDATION] ❌ Collection creation validation failed:", validationError);
                if (isCollectionLimitError(validationError)) {
                    const guidanceMessage = await this.host.buildCollectionLimitMessage(absolutePath);
                    return this.host.manageResponse(manageAction, absolutePath, "error", guidanceMessage, preflightOptions);
                }

                if (validationError instanceof RemoteCollectionDeletePendingError) {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Zilliz/Milvus validation collection deletion is still pending. Local index state was not changed. Retry after the backend has converged. Details: ${formatUnknownError(validationError)}`,
                        {
                            ...preflightOptions,
                            reason: "remote_delete_pending",
                            hints: {
                                retry: {
                                    tool: "manage_index",
                                    args: { action: manageAction, path: absolutePath },
                                },
                            },
                        },
                    );
                }

                const vectorBackendDiagnostic = classifyVectorBackendError(validationError);
                if (vectorBackendDiagnostic) {
                    return this.host.manageVectorBackendResponse(manageAction, absolutePath, vectorBackendDiagnostic);
                }

                const validationMessage = formatUnknownError(validationError);
                const backendTimeout = isBackendTimeoutError(validationError);
                const timeoutOptions = backendTimeout
                    ? {
                        ...preflightOptions,
                        reason: "backend_timeout",
                        hints: {
                            retry: {
                                tool: "manage_index",
                                args: { action: manageAction, path: absolutePath },
                            },
                        },
                    }
                    : preflightOptions;
                const validationText = backendTimeout
                    ? `Backend timeout while validating Zilliz/Milvus collection creation for '${absolutePath}'. The repo path is valid and local index state was not changed. This is retryable/operator-actionable: check backend availability or network latency, then retry manage_index action='${manageAction}'. Details: ${validationMessage}`
                    : `Error validating collection creation: ${validationMessage}`;
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "error",
                    validationText,
                    timeoutOptions,
                );
            }

            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(", ")}`);
                this.host.context.addCustomExtensions(customFileExtensions);
            }

            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(", ")}`);
                this.host.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            const failedInfo = this.host.getSnapshotCodebaseInfo(absolutePath);
            if (failedInfo?.status === "indexfailed") {
                const previousError = typeof failedInfo.errorMessage === "string" ? failedInfo.errorMessage : "Unknown error";
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${previousError}`);
            }

            this.host.snapshotManager.setCodebaseIndexing(absolutePath, 0);
            this.host.saveSnapshotIfSupported();

            trackCodebasePath(absolutePath);
            await this.host.touchWatchedCodebase(absolutePath);

            const startBackgroundIndexing = this.host.startBackgroundIndexing
                ?? this.startBackgroundIndexing.bind(this);
            void startBackgroundIndexing(absolutePath, forceReindex, stagedCollectionName);

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : "";
            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(", ")}`
                : "";
            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(", ")}`
                : "";

            return this.host.manageResponse(
                manageAction,
                absolutePath,
                "ok",
                `Started background indexing for codebase '${absolutePath}'.${pathInfo}${dropSummaryLine}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`,
                preflightOptions,
            );
        } catch (error: unknown) {
            console.error("Error in handleIndexCodebase:", error);
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                const errorMessage = formatUnknownError(error);
                const preservesLocalState = errorMessage.includes("Force reindex cleanup failed before local state changes");
                const humanText = preservesLocalState
                    ? `${vectorBackendDiagnostic.message} ${errorMessage}`
                    : vectorBackendDiagnostic.message;
                return this.host.manageVectorBackendResponse(manageAction, ensureAbsolutePath(codebasePath), vectorBackendDiagnostic, humanText);
            }
            return this.host.manageResponse(
                manageAction,
                ensureAbsolutePath(codebasePath),
                "error",
                `Error starting indexing: ${formatUnknownError(error)}`,
                preflightOptions,
            );
        }
    }

    public async handleReindexCodebase(args: ReindexCodebaseArgs): Promise<ToolTextResponse> {
        const { path: codebasePath, customExtensions, ignorePatterns, zillizDropCollection, allowUnnecessaryReindex } = args;
        const absolutePath = ensureAbsolutePath(codebasePath);
        const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked("reindex", absolutePath);
        if (runtimeOwnerConflict) {
            return runtimeOwnerConflict;
        }
        const preflight = this.host.evaluateReindexPreflight(absolutePath);

        if (preflight.outcome === "reindex_unnecessary_ignore_only" && allowUnnecessaryReindex !== true) {
            return this.host.manageResponse(
                "reindex",
                absolutePath,
                "blocked",
                `Reindex preflight blocked for '${absolutePath}': only ignore/index-policy control changes were detected. Use manage_index with {"action":"sync","path":"${absolutePath}"} for immediate convergence.`,
                {
                    reason: "unnecessary_reindex_ignore_only",
                    warnings: preflight.warnings,
                    preflight,
                    hints: {
                        sync: {
                            tool: "manage_index",
                            args: { action: "sync", path: absolutePath },
                        },
                        overrideReindex: {
                            tool: "manage_index",
                            args: { action: "reindex", path: absolutePath, allowUnnecessaryReindex: true },
                        },
                    },
                },
            );
        }

        const forwardedPreflight = preflight.outcome === "unknown" || preflight.outcome === "probe_failed"
            ? preflight
            : undefined;
        return this.handleIndexCodebase({
            path: codebasePath,
            force: true,
            customExtensions,
            ignorePatterns,
            zillizDropCollection,
            __reindexPreflight: forwardedPreflight,
        });
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, writeCollectionName?: string): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0;

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            const targetCollectionName = typeof writeCollectionName === "string" && writeCollectionName.trim().length > 0
                ? writeCollectionName
                : this.host.resolveCollectionName(absolutePath);
            this.host.setWriteCollectionOverride(absolutePath, targetCollectionName);

            if (forceReindex) {
                console.log("[BACKGROUND-INDEX] ℹ️  Force reindex mode - building a staged generation before retiring the previous proven collection.");
            }

            const profileConfig = this.host.loadIndexProfileForCodebase(absolutePath);
            console.log(`[BACKGROUND-INDEX] Using index profile '${profileConfig.profile}'${profileConfig.configPath ? ` from ${profileConfig.configPath}` : " (default)"}`);

            await this.host.context.loadResolvedIgnorePatterns(absolutePath);

            const { FileSynchronizer } = await import("@zokizuan/satori-core");
            const ignorePatterns = this.host.getContextActiveIgnorePatterns(absolutePath);
            const supportedExtensions = this.host.getContextIndexedExtensions(absolutePath);
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(", ")}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns, supportedExtensions);
            await synchronizer.initialize();

            await this.host.context.ensureCollectionPrepared(absolutePath);
            this.host.context.registerSynchronizer(this.host.resolveCollectionName(absolutePath), synchronizer);

            console.log(`[BACKGROUND-INDEX] Starting indexing for: ${absolutePath}`);

            const encoderEngine = this.host.context.getEmbeddingEngine();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${encoderEngine.getProvider()} with dimension: ${encoderEngine.getDimension()}`);

            console.log("[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...");
            const stats = await this.host.context.indexCodebase(absolutePath, (progress) => {
                this.host.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) {
                    this.host.saveSnapshotIfSupported();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            });
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            await this.host.writeIndexCompletionMarker(absolutePath, {
                kind: "satori_index_completion_v1",
                codebasePath: this.host.canonicalizeCodebasePath(absolutePath),
                fingerprint: this.host.runtimeFingerprint,
                indexedFiles: stats.indexedFiles,
                totalChunks: stats.totalChunks,
                completedAt: new Date().toISOString(),
                runId: `run_${crypto.randomUUID()}`,
            });

            try {
                const droppedCollections = await this.host.pruneIndexedCollectionFamily(absolutePath, targetCollectionName);
                if (droppedCollections.length > 0) {
                    console.log(`[BACKGROUND-INDEX] 🧹 Retired ${droppedCollections.length} superseded collection(s): ${droppedCollections.join(", ")}`);
                }
            } catch (pruneError) {
                console.warn(`[BACKGROUND-INDEX] Failed to retire superseded generations for '${absolutePath}': ${formatUnknownError(pruneError)}`);
            }

            this.host.snapshotManager.setCodebaseIndexed(absolutePath, stats, this.host.runtimeFingerprint, "verified");
            this.host.snapshotManager.setCodebaseIndexManifest(absolutePath, this.host.getContextTrackedRelativePaths(absolutePath));
            this.host.setIndexingStats({ indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks });
            await this.host.syncManager.recordCurrentIgnoreControlSignature(absolutePath);

            this.host.saveSnapshotIfSupported();
            await this.host.rebuildCallGraphForIndex(absolutePath);
            await this.host.touchWatchedCodebase(absolutePath);

            let message = `Background indexing completed for '${absolutePath}'.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === "limit_reached") {
                message += "\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.";
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);
        } catch (error: unknown) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            let errorMessage = formatUnknownError(error);
            if (isCollectionLimitError(error)) {
                errorMessage = await this.host.buildCollectionLimitMessage(absolutePath);
            }

            try {
                await this.host.clearIndexCompletionMarker(absolutePath);
            } catch (clearError) {
                console.warn(`[BACKGROUND-INDEX] Failed to clear completion marker after indexing error for '${absolutePath}': ${formatUnknownError(clearError)}`);
            }

            this.host.snapshotManager.setCodebaseIndexFailed(
                absolutePath,
                errorMessage,
                this.host.getSnapshotIndexingProgress(absolutePath),
            );
            this.host.saveSnapshotIfSupported();
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        } finally {
            this.host.setWriteCollectionOverride(absolutePath, null);
        }
    }
}
