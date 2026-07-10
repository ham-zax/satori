import * as fs from "fs";
import * as crypto from "node:crypto";
import {
    COLLECTION_LIMIT_MESSAGE,
    Context,
    deleteCollectionWithVerification,
    RemoteCollectionDeletePendingError,
} from "@zokizuan/satori-core";
import type { SnapshotManager } from "./snapshot.js";
import type { SyncManager } from "./sync.js";
import type { ManageIndexAction } from "./manage-types.js";
import type { CompletionProofValidationResult } from "./completion-proof.js";
import {
    classifyVectorBackendError,
    type VectorBackendDiagnostic,
} from "./backend-diagnostics.js";
import type { IndexFingerprint } from "../config.js";
import { absolutePathOrRaw, requireAbsoluteFilesystemPath, trackCodebasePath } from "../utils.js";
import type { ReindexPreflightResult } from "./working-tree-state.js";
import type { RuntimeOwnerMutationAction } from "./runtime-owner.js";

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

function isMatchingVerifiedFingerprint(info: Record<string, unknown> | undefined, runtimeFingerprint: IndexFingerprint): IndexFingerprint | undefined {
    if (info?.fingerprintSource !== "verified") {
        return undefined;
    }
    const fingerprint = info.indexFingerprint;
    if (!fingerprint || typeof fingerprint !== "object") {
        return undefined;
    }
    const record = fingerprint as Record<string, unknown>;
    const matches = record.embeddingProvider === runtimeFingerprint.embeddingProvider
        && record.embeddingModel === runtimeFingerprint.embeddingModel
        && Number(record.embeddingDimension) === Number(runtimeFingerprint.embeddingDimension)
        && record.vectorStoreProvider === runtimeFingerprint.vectorStoreProvider
        && record.schemaVersion === runtimeFingerprint.schemaVersion;
    return matches ? fingerprint as IndexFingerprint : undefined;
}

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
        action: RuntimeOwnerMutationAction,
        codebasePath: string,
    ): Promise<ToolTextResponse | null>;
    recoverStaleIndexingStateIfNeeded(codebasePath: string): Promise<void>;
    getSnapshotIndexingCodebases(): string[];
    getSnapshotCodebaseInfo(codebasePath: string): Record<string, unknown> | undefined;
    getSnapshotIndexedCodebases(): string[];
    buildManageActionBlockedMessage(
        codebasePath: string,
        action: Extract<RuntimeOwnerMutationAction, "create" | "reindex" | "repair">,
    ): string;
    buildCreateHint(codebasePath: string): Record<string, unknown>;
    buildStatusHint(codebasePath: string): Record<string, unknown>;
    getManageRetryAfterMs(): number;
    buildIndexingMetadata(codebasePath: string): Record<string, unknown> | undefined;
    buildReindexInstruction(codebasePath: string, detail?: string): string;
    buildManageRequiresReindexHints(codebasePath: string): Record<string, unknown>;
    validateCompletionProof(codebasePath: string): Promise<CompletionProofValidationResult>;
    recoverIndexedSnapshotFromCompletionProof(
        codebasePath: string,
        proof: CompletionProofValidationResult,
    ): Promise<boolean>;
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
    pruneIndexedCollectionFamily(codebasePath: string, keepCollectionName: string): Promise<string[]>;
    pruneUnprovenStagedCollectionFamily(codebasePath: string): Promise<string[]>;
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

    private isStagedCollectionName(collectionName: string | undefined): collectionName is string {
        return typeof collectionName === "string" && collectionName.includes("__gen_");
    }

    private async cleanupFailedStagedCollection(codebasePath: string, collectionName: string | undefined): Promise<void> {
        if (!this.isStagedCollectionName(collectionName)) {
            return;
        }
        try {
            await deleteCollectionWithVerification(this.host.context.getVectorStore(), collectionName);
            console.log(`[BACKGROUND-INDEX] Cleaned failed staged collection '${collectionName}' for '${codebasePath}'.`);
        } catch (cleanupError) {
            console.warn(`[BACKGROUND-INDEX] Failed to clean staged collection '${collectionName}' after indexing failure for '${codebasePath}': ${formatUnknownError(cleanupError)}`);
        }
    }

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
            const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
            if (!absolutePathResult.ok) {
                return this.host.manageResponse(
                    manageAction,
                    codebasePath,
                    "error",
                    absolutePathResult.message,
                    preflightOptions,
                );
            }
            const absolutePath = absolutePathResult.absolutePath;

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
                if (await this.host.recoverIndexedSnapshotFromCompletionProof(absolutePath, proof)) {
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
                const prunedStagedCollections = await this.host.pruneUnprovenStagedCollectionFamily(absolutePath);
                if (prunedStagedCollections.length > 0) {
                    console.log(`[INDEX-VALIDATION] 🧹 Removed ${prunedStagedCollections.length} unproven staged collection(s): ${prunedStagedCollections.join(", ")}`);
                }

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
                `Started background indexing for codebase '${absolutePath}'.${pathInfo}${dropSummaryLine}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. Search and navigation are blocked until indexing completes. Poll manage_index with {"action":"status","path":"${absolutePath}"} (or wait for completion); do not search for partial results while status is indexing.`,
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
                return this.host.manageVectorBackendResponse(manageAction, absolutePathOrRaw(codebasePath), vectorBackendDiagnostic, humanText);
            }
            return this.host.manageResponse(
                manageAction,
                absolutePathOrRaw(codebasePath),
                "error",
                `Error starting indexing: ${formatUnknownError(error)}`,
                preflightOptions,
            );
        }
    }

    public async handleReindexCodebase(args: ReindexCodebaseArgs): Promise<ToolTextResponse> {
        const { path: codebasePath, customExtensions, ignorePatterns, zillizDropCollection, allowUnnecessaryReindex } = args;
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("reindex", codebasePath, "error", absolutePathResult.message);
        }
        const absolutePath = absolutePathResult.absolutePath;
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

    public async handleRepairIndex(args: Record<string, unknown>): Promise<ToolTextResponse> {
        const codebasePath = args.path;
        if (typeof codebasePath !== "string" || codebasePath.trim().length === 0) {
            return this.host.manageResponse(
                "repair",
                "",
                "error",
                "Error: Path is required."
            );
        }

        let absolutePath = codebasePath;
        try {
            const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
            if (!absolutePathResult.ok) {
                return this.host.manageResponse("repair", codebasePath, "error", absolutePathResult.message);
            }
            absolutePath = absolutePathResult.absolutePath;

            if (!fs.existsSync(absolutePath)) {
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "error",
                    `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                );
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "error",
                    `Error: Path '${absolutePath}' is not a directory`
                );
            }

            const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked("repair", absolutePath);
            if (runtimeOwnerConflict) {
                return runtimeOwnerConflict;
            }

            if (this.host.getSnapshotIndexingCodebases().includes(absolutePath)) {
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "not_ready",
                    this.host.buildManageActionBlockedMessage(absolutePath, "repair"),
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

            const snapshotInfo = this.host.getSnapshotCodebaseInfo(absolutePath);
            const trustedFingerprint = isMatchingVerifiedFingerprint(snapshotInfo, this.host.runtimeFingerprint);
            const preferredCollectionName = typeof snapshotInfo?.collectionName === "string"
                ? snapshotInfo.collectionName.trim()
                : "";
            const result = await this.host.context.repairIndex(absolutePath, {
                trustedFingerprint,
                ...(preferredCollectionName ? { preferredCollectionName } : {}),
            });

            if (result.status === "ok") {
                await this.host.rebuildCallGraphForIndex(absolutePath);
                await this.host.touchWatchedCodebase(absolutePath);

                const stats = {
                    indexedFiles: result.indexedFiles || 0,
                    totalChunks: result.totalChunks || 0,
                    status: "completed" as const
                };
                this.host.snapshotManager.setCodebaseIndexed(
                    absolutePath,
                    stats,
                    this.host.runtimeFingerprint,
                    "verified",
                    result.collectionName
                );
                const trackedRelativePaths = (result as { trackedRelativePaths?: unknown }).trackedRelativePaths;
                this.host.snapshotManager.setCodebaseIndexManifest(
                    absolutePath,
                    Array.isArray(trackedRelativePaths)
                        ? trackedRelativePaths.filter((entry): entry is string => typeof entry === "string")
                        : this.host.getContextTrackedRelativePaths(absolutePath)
                );
                this.host.setIndexingStats(stats);
                this.host.saveSnapshotIfSupported();

                const warningsArray = Array.isArray(result.warnings) ? result.warnings : [];
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "ok",
                    result.message,
                    {
                        warnings: warningsArray,
                    }
                );
            } else if (result.status === "requires_reindex") {
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "requires_reindex",
                    result.message,
                    {
                        reason: "requires_reindex",
                        hints: this.host.buildManageRequiresReindexHints(absolutePath),
                    }
                );
            } else {
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "blocked",
                    result.message,
                    {
                        reason: result.reason || "needs_create",
                        hints: {
                            create: this.host.buildCreateHint(absolutePath),
                            missingCount: result.missingCount,
                        }
                    }
                );
            }

        } catch (error: unknown) {
            console.error("Error in handleRepairIndex:", error);
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                return this.host.manageVectorBackendResponse("repair", absolutePath, vectorBackendDiagnostic);
            }
            return this.host.manageResponse(
                "repair",
                absolutePath,
                "error",
                `Error performing repair: ${formatUnknownError(error)}`
            );
        }
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, writeCollectionName?: string): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0;
        let targetCollectionName: string | undefined;

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            targetCollectionName = typeof writeCollectionName === "string" && writeCollectionName.trim().length > 0
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

            try {
                const droppedCollections = await this.host.pruneIndexedCollectionFamily(absolutePath, targetCollectionName);
                if (droppedCollections.length > 0) {
                    console.log(`[BACKGROUND-INDEX] 🧹 Retired ${droppedCollections.length} superseded collection(s): ${droppedCollections.join(", ")}`);
                }
            } catch (pruneError) {
                console.warn(`[BACKGROUND-INDEX] Failed to retire superseded generations for '${absolutePath}': ${formatUnknownError(pruneError)}`);
            }

            // indexStatus is carried on stats (completed | limit_reached). limit_reached remains
            // searchable only when core wrote a completion marker for partial vector proof;
            // navigation still fails closed via indexStatus checks (partial_index_navigation_unavailable).
            this.host.snapshotManager.setCodebaseIndexed(absolutePath, stats, this.host.runtimeFingerprint, "verified", targetCollectionName);
            this.host.snapshotManager.setCodebaseIndexManifest(absolutePath, this.host.getContextTrackedRelativePaths(absolutePath));
            this.host.setIndexingStats({ indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks });
            await this.host.syncManager.recordCurrentIgnoreControlSignature(absolutePath);

            this.host.saveSnapshotIfSupported();
            // Full navigation rebuild only for completed indexes; partial indexes have no registry seal.
            if (stats.status === "completed") {
                await this.host.rebuildCallGraphForIndex(absolutePath);
            }
            await this.host.touchWatchedCodebase(absolutePath);

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

            let errorMessage = formatUnknownError(error);
            if (isCollectionLimitError(error)) {
                errorMessage = await this.host.buildCollectionLimitMessage(absolutePath);
            }

            try {
                await this.host.clearIndexCompletionMarker(absolutePath);
            } catch (clearError) {
                console.warn(`[BACKGROUND-INDEX] Failed to clear completion marker after indexing error for '${absolutePath}': ${formatUnknownError(clearError)}`);
            }
            await this.cleanupFailedStagedCollection(absolutePath, targetCollectionName);

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
