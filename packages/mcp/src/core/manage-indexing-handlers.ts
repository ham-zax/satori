import * as fs from "fs";
import * as crypto from "node:crypto";
import {
    COLLECTION_LIMIT_MESSAGE,
    Context,
    deleteCollectionWithVerification,
    IndexPolicyPublicationError,
    RemoteCollectionDeletePendingError,
    SynchronizerCheckpointPublicationError,
} from "@zokizuan/satori-core";
import type {
    CustomIndexPolicyUpdate,
    RepairProof,
    RepairSnapshotEvidence,
    ResolvedIndexPolicy,
} from "@zokizuan/satori-core";
import type { SnapshotManager } from "./snapshot.js";
import type { SyncManager } from "./sync.js";
import type { ManageIndexAction } from "./manage-types.js";
import type { CompletionProofValidationResult } from "./completion-proof.js";
import {
    classifyVectorBackendError,
    type VectorBackendDiagnostic,
} from "./backend-diagnostics.js";
import {
    indexFingerprintsEqual,
    parseIndexFingerprint,
    type IndexFingerprint,
    type IndexOperationPhase,
    type IndexOperationReceipt,
    type CallGraphSidecarInfo,
} from "../config.js";
import { absolutePathOrRaw, requireAbsoluteFilesystemPath, trackCodebasePath } from "../utils.js";
import type { ReindexPreflightResult } from "./working-tree-state.js";
import type { RuntimeOwnerMutationAction } from "./runtime-owner.js";
import type { ZillizCollectionDropResult } from "./vector-backend-maintenance.js";
import {
    MutationLeaseCoordinator,
    formatMutationLeaseBlockedMessage,
    type RootMutationLease,
} from "./mutation-lease.js";

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

function classifyRepairSnapshotEvidence(info: Record<string, unknown> | undefined): RepairSnapshotEvidence {
    const fingerprint = parseIndexFingerprint(info?.indexFingerprint);
    if (
        !fingerprint
        || !fingerprint.parserVersion
        || !fingerprint.extractorVersion
        || !fingerprint.relationshipVersion
    ) {
        return {
            status: "missing",
            basis: "snapshot_fingerprint_missing",
        };
    }
    if (info?.fingerprintSource !== "verified") {
        return {
            status: "unproven",
            basis: "snapshot_fingerprint_unverified",
            fingerprint: {
                ...fingerprint,
                parserVersion: fingerprint.parserVersion,
                extractorVersion: fingerprint.extractorVersion,
                relationshipVersion: fingerprint.relationshipVersion,
            },
        };
    }
    return {
        status: "verified",
        basis: "verified_snapshot_fingerprint",
        fingerprint: {
            ...fingerprint,
            parserVersion: fingerprint.parserVersion,
            extractorVersion: fingerprint.extractorVersion,
            relationshipVersion: fingerprint.relationshipVersion,
        },
    };
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
        mutationLease?: RootMutationLease,
        previousIndexedInfo?: Record<string, unknown>,
        policyUpdate?: CustomIndexPolicyUpdate,
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
    recoverStaleIndexingStateIfNeeded(
        codebasePath: string,
        existingLease?: RootMutationLease,
    ): Promise<RootMutationLease | undefined>;
    getSnapshotIndexingCodebases(): string[];
    getSnapshotCodebaseInfo(codebasePath: string): Record<string, unknown> | undefined;
    getSnapshotIndexedCodebases(): string[];
    buildManageActionBlockedMessage(
        codebasePath: string,
        action: Extract<RuntimeOwnerMutationAction, "create" | "reindex" | "repair">,
    ): string;
    buildCreateHint(codebasePath: string): Record<string, unknown>;
    buildReindexHint(codebasePath: string): Record<string, unknown>;
    buildStatusHint(codebasePath: string): Record<string, unknown>;
    getManageRetryAfterMs(): number;
    buildIndexingMetadata(codebasePath: string): Record<string, unknown> | undefined;
    buildReindexInstruction(codebasePath: string, detail?: string): string;
    buildManageRequiresReindexHints(codebasePath: string): Record<string, unknown>;
    validateCompletionProof(codebasePath: string): Promise<CompletionProofValidationResult>;
    recoverIndexedSnapshotFromCompletionProof(
        codebasePath: string,
        proof: CompletionProofValidationResult,
        lease: RootMutationLease,
    ): Promise<boolean>;
    isZillizBackend(): boolean;
    resolveCollectionName(codebasePath: string): string;
    dropZillizCollectionForCreate(
        collectionName: string,
        createLease?: RootMutationLease,
    ): Promise<ZillizCollectionDropResult>;
    resolveStagedCollectionName(codebasePath: string, generationId: string): string;
    buildCollectionLimitMessage(codebasePath: string): Promise<string>;
    manageVectorBackendResponse(
        action: ManageIndexAction,
        path: string,
        diagnostic: VectorBackendDiagnostic,
        humanText?: string,
        operation?: import("../config.js").IndexOperationReceipt,
        repairProof?: RepairProof,
    ): ToolTextResponse;
    saveSnapshotIfSupported(): void;
    touchWatchedCodebase(codebasePath: string): Promise<void>;
    setWriteCollectionOverride(codebasePath: string, collectionName: string | null): void;
    loadIndexProfileForCodebase(codebasePath: string): IndexProfileView;
    getContextActiveIgnorePatterns(codebasePath: string): string[];
    getContextIndexedExtensions(codebasePath: string): string[];
    canonicalizeCodebasePath(codebasePath: string): string;
    pruneIndexedCollectionFamily(codebasePath: string, keepCollectionName: string, assertMutationCurrent?: () => void): Promise<string[]>;
    pruneUnprovenStagedCollectionFamily(codebasePath: string, assertMutationCurrent?: () => void): Promise<string[]>;
    getContextTrackedRelativePaths(codebasePath: string): string[];
    setIndexingStats(stats: { indexedFiles: number; totalChunks: number } | null): void;
    rebuildCallGraphForIndex(
        codebasePath: string,
        assertMutationCurrent?: () => void,
        effectiveIgnorePatterns?: string[],
    ): Promise<void>;
    getSnapshotIndexingProgress(codebasePath: string): number | undefined;
    clearIndexCompletionMarker(codebasePath: string, assertMutationCurrent?: () => void): Promise<void>;
    evaluateReindexPreflight(codebasePath: string): ReindexPreflightResult;
    assertIndexMutationCapabilities(): void;
    mutationLeaseCoordinator: MutationLeaseCoordinator | null;
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

function assertCheckpointMatchesIndexedSources(
    indexedFiles: number,
    indexedFileHashes: ReadonlyMap<string, string>,
    checkpoint: import("@zokizuan/satori-core").PreparedFileChangeSet,
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
    if (indexedFileHashes.size !== checkpoint.fileHashes.size) {
        throw new Error(
            `Full index source changed while indexing (indexed ${indexedFileHashes.size} files, observed ${checkpoint.fileHashes.size}); retry reindex.`,
        );
    }
    for (const [relativePath, indexedHash] of indexedFileHashes) {
        if (checkpoint.fileHashes.get(relativePath) !== indexedHash) {
            throw new Error(`Full index source changed while indexing at '${relativePath}'; retry reindex.`);
        }
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

    private async cleanupFailedStagedCollection(
        codebasePath: string,
        collectionName: string | undefined,
        assertMutationCurrent?: () => void,
    ): Promise<void> {
        if (!this.isStagedCollectionName(collectionName)) {
            return;
        }
        try {
            await deleteCollectionWithVerification(this.host.context.getVectorStore(), collectionName, {
                beforeDropAttempt: assertMutationCurrent,
            });
            console.log(`[BACKGROUND-INDEX] Cleaned failed staged collection '${collectionName}' for '${codebasePath}'.`);
        } catch (cleanupError) {
            assertMutationCurrent?.();
            console.warn(`[BACKGROUND-INDEX] Failed to clean staged collection '${collectionName}' after indexing failure for '${codebasePath}': ${formatUnknownError(cleanupError)}`);
        }
    }

    public async handleIndexCodebase(args: IndexCodebaseArgs): Promise<ToolTextResponse> {
        return this.handleIndexCodebaseInternal(args);
    }

    private async handleIndexCodebaseInternal(
        args: IndexCodebaseArgs,
        preparedCanonicalRoot?: string,
    ): Promise<ToolTextResponse> {
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
        const policyUpdate: CustomIndexPolicyUpdate = {
            ...(Array.isArray(customExtensions) ? { customExtensions: customFileExtensions } : {}),
            ...(Array.isArray(ignorePatterns) ? { customIgnorePatterns } : {}),
        };
        const requestedDropCollection = typeof zillizDropCollection === "string" ? zillizDropCollection.trim() : undefined;
        let dropSummaryLine = "";
        let mutationLease: RootMutationLease | undefined;
        let leaseTransferred = false;
        let operationTerminal = false;
        let lastDurableOperation: IndexOperationReceipt | undefined;
        let canonicalRoot = preparedCanonicalRoot;
        let existingInfo: Record<string, unknown> | undefined;
        const transitionOperation = (phase: IndexOperationPhase, mutateSnapshot?: () => void) => {
            if (!mutationLease || typeof this.host.snapshotManager.transitionOperation !== "function") {
                mutateSnapshot?.();
                if (mutateSnapshot) {
                    this.host.saveSnapshotIfSupported();
                }
                operationTerminal = phase === "completed" || phase === "failed" || phase === "blocked";
                return undefined;
            }
            this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            const operation = typeof this.host.snapshotManager.commitOperationPhase === "function"
                ? this.host.snapshotManager.commitOperationPhase(
                    mutationLease,
                    phase,
                    mutateSnapshot,
                    () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!),
                )
                : (() => {
                    const next = this.host.snapshotManager.transitionOperation(mutationLease!, phase);
                    mutateSnapshot?.();
                    if (this.host.snapshotManager.saveCodebaseSnapshot() === false) {
                        throw new Error(`Failed to persist operation receipt for '${mutationLease!.canonicalRoot}'.`);
                    }
                    return next;
                })();
            lastDurableOperation = operation;
            operationTerminal = phase === "completed" || phase === "failed" || phase === "blocked";
            return operation;
        };
        const operationOptions = (phase: IndexOperationPhase, options: Record<string, unknown> = {}) => {
            const operation = transitionOperation(phase);
            return { ...options, ...(operation ? { operation } : {}) };
        };

        try {
            if (!canonicalRoot) {
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
                canonicalRoot = this.host.canonicalizeCodebasePath(absolutePathResult.absolutePath);
            }
            const absolutePath = canonicalRoot;

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

            this.host.assertIndexMutationCapabilities();

            const leaseResult = this.host.mutationLeaseCoordinator?.acquire(absolutePath, manageAction);
            if (leaseResult && !leaseResult.acquired) {
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "blocked",
                    formatMutationLeaseBlockedMessage(leaseResult.activeLease),
                    {
                        ...preflightOptions,
                        reason: "mutation_in_progress",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            activeMutation: leaseResult.activeLease,
                        },
                    },
                );
            }
            mutationLease = leaseResult?.lease;
            if (mutationLease) {
                if (typeof this.host.snapshotManager.startOperation === "function") {
                    const operation = typeof this.host.snapshotManager.commitOperationPhase === "function"
                        ? this.host.snapshotManager.commitOperationPhase(
                            mutationLease,
                            "accepted",
                            undefined,
                            () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!),
                        )
                        : this.host.snapshotManager.startOperation(mutationLease);
                    if (
                        typeof this.host.snapshotManager.commitOperationPhase !== "function"
                        && this.host.snapshotManager.saveCodebaseSnapshot() === false
                    ) {
                        throw new Error(`Failed to persist accepted operation receipt for '${mutationLease.canonicalRoot}'.`);
                    }
                    lastDurableOperation = operation;
                }
            }

            await this.host.recoverStaleIndexingStateIfNeeded(absolutePath, mutationLease);

            if (this.host.getSnapshotIndexingCodebases().includes(absolutePath)) {
                const blockedAction: "create" | "reindex" = forceReindex ? "reindex" : "create";
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "not_ready",
                    this.host.buildManageActionBlockedMessage(absolutePath, blockedAction),
                    operationOptions("blocked", {
                        ...preflightOptions,
                        reason: "indexing",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            retryAfterMs: this.host.getManageRetryAfterMs(),
                            indexing: this.host.buildIndexingMetadata(absolutePath),
                        },
                    }),
                );
            }

            existingInfo = this.host.getSnapshotCodebaseInfo(absolutePath);
            if (!forceReindex && existingInfo?.status === "requires_reindex") {
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "requires_reindex",
                    this.host.buildReindexInstruction(
                        absolutePath,
                        typeof existingInfo.message === "string" ? existingInfo.message : undefined,
                    ),
                    operationOptions("blocked", {
                        ...preflightOptions,
                        reason: "requires_reindex",
                        hints: this.host.buildManageRequiresReindexHints(absolutePath),
                    }),
                );
            }

            const isIndexedInSnapshot = this.host.getSnapshotIndexedCodebases().includes(absolutePath);
            if (!forceReindex && !isIndexedInSnapshot) {
                const proof = await this.host.validateCompletionProof(absolutePath);
                if (proof.outcome === "policy_incompatible") {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "requires_reindex",
                        this.host.buildReindexInstruction(
                            absolutePath,
                            "The accepted index policy is incompatible with the repository's current runtime policy inputs.",
                        ),
                        operationOptions("blocked", {
                            ...preflightOptions,
                            reason: "requires_reindex",
                            hints: this.host.buildManageRequiresReindexHints(absolutePath),
                        }),
                    );
                }
                if (
                    mutationLease
                    && await this.host.recoverIndexedSnapshotFromCompletionProof(
                        absolutePath,
                        proof,
                        mutationLease,
                    )
                ) {
                    if (proof.outcome === "fingerprint_mismatch") {
                        return this.host.manageResponse(
                            manageAction,
                            absolutePath,
                            "requires_reindex",
                            this.host.buildReindexInstruction(
                                absolutePath,
                                "Recovered local readiness from completion marker proof, but the current runtime fingerprint does not match the existing index.",
                            ),
                            operationOptions("blocked", {
                                ...preflightOptions,
                                reason: "requires_reindex",
                                hints: this.host.buildManageRequiresReindexHints(absolutePath),
                            }),
                        );
                    }

                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "blocked",
                        `Codebase '${absolutePath}' is already indexed. Local readiness was recovered from completion marker proof.\n\nTo update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.\nTo force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`,
                        operationOptions("blocked", preflightOptions),
                    );
                }
            }

            if (!forceReindex && isIndexedInSnapshot) {
                const proof = await this.host.validateCompletionProof(absolutePath);
                if (proof.outcome === "policy_incompatible") {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "requires_reindex",
                        this.host.buildReindexInstruction(
                            absolutePath,
                            "The accepted index policy is incompatible with the repository's current runtime policy inputs.",
                        ),
                        operationOptions("blocked", {
                            ...preflightOptions,
                            reason: "requires_reindex",
                            hints: this.host.buildManageRequiresReindexHints(absolutePath),
                        }),
                    );
                }
                if (proof.outcome === "valid") {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "blocked",
                        `Codebase '${absolutePath}' is already indexed.\n\nTo update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.\nTo force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`,
                        operationOptions("blocked", preflightOptions),
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
                        operationOptions("failed", preflightOptions),
                    );
                }

                const targetCollectionName = this.host.resolveCollectionName(absolutePath);
                if (requestedDropCollection === targetCollectionName) {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Error: zillizDropCollection cannot target '${targetCollectionName}' for this same codebase create flow. Use {"action":"create","path":"${absolutePath}","force":true} for reindexing this codebase.`,
                        operationOptions("failed", preflightOptions),
                    );
                }

                let dropResult: ZillizCollectionDropResult;
                try {
                    dropResult = await this.host.dropZillizCollectionForCreate(requestedDropCollection, mutationLease);
                } catch (error) {
                    if (error instanceof RemoteCollectionDeletePendingError) {
                        return this.host.manageResponse(
                            manageAction,
                            absolutePath,
                            "error",
                            `Zilliz collection '${requestedDropCollection}' remote deletion is still pending. Local index state was not changed. Retry after the backend has converged. Details: ${formatUnknownError(error)}`,
                            operationOptions("failed", {
                                ...preflightOptions,
                                reason: "remote_delete_pending",
                                hints: {
                                    retry: {
                                        tool: "manage_index",
                                        args: { action: manageAction, path: absolutePath, zillizDropCollection: requestedDropCollection },
                                    },
                                },
                            }),
                        );
                    }
                    throw error;
                }
                if (dropResult.status === "blocked") {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "blocked",
                        formatMutationLeaseBlockedMessage(dropResult.activeLease),
                        operationOptions("blocked", {
                            ...preflightOptions,
                            reason: "mutation_in_progress",
                            hints: {
                                status: this.host.buildStatusHint(dropResult.activeLease.canonicalRoot),
                                activeMutation: dropResult.activeLease,
                            },
                        }),
                    );
                }
                if (dropResult.status === "unmapped") {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Refused to drop Zilliz collection '${requestedDropCollection}' because its owning codebase root could not be proven from the local snapshot or remote collection metadata. No remote or local index state was changed.`,
                        operationOptions("blocked", preflightOptions),
                    );
                }
                dropSummaryLine += dropResult.droppedCodebasePath
                    ? `\nDropped Zilliz collection '${requestedDropCollection}' (mapped codebase: '${dropResult.droppedCodebasePath}').`
                    : `\nDropped Zilliz collection '${requestedDropCollection}'.`;
            }

            const stagedCollectionName = this.host.resolveStagedCollectionName(absolutePath, `run_${crypto.randomUUID()}`);

            try {
                const prunedStagedCollections = await this.host.pruneUnprovenStagedCollectionFamily(
                    absolutePath,
                    mutationLease
                        ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!)
                        : undefined,
                );
                if (prunedStagedCollections.length > 0) {
                    console.log(`[INDEX-VALIDATION] 🧹 Removed ${prunedStagedCollections.length} unproven staged collection(s): ${prunedStagedCollections.join(", ")}`);
                }

                console.log("[INDEX-VALIDATION] 🔍 Validating collection creation capability");
                const canCreateCollection = await this.host.context.getVectorStore().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);
                    const guidanceMessage = await this.host.buildCollectionLimitMessage(absolutePath);
                    return this.host.manageResponse(manageAction, absolutePath, "error", guidanceMessage, operationOptions("failed", preflightOptions));
                }

                console.log("[INDEX-VALIDATION] ✅  Collection creation validation completed");
            } catch (validationError: unknown) {
                console.error("[INDEX-VALIDATION] ❌ Collection creation validation failed:", validationError);
                if (isCollectionLimitError(validationError)) {
                    const guidanceMessage = await this.host.buildCollectionLimitMessage(absolutePath);
                    return this.host.manageResponse(manageAction, absolutePath, "error", guidanceMessage, operationOptions("failed", preflightOptions));
                }

                if (validationError instanceof RemoteCollectionDeletePendingError) {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Zilliz/Milvus validation collection deletion is still pending. Local index state was not changed. Retry after the backend has converged. Details: ${formatUnknownError(validationError)}`,
                        operationOptions("failed", {
                            ...preflightOptions,
                            reason: "remote_delete_pending",
                            hints: {
                                retry: {
                                    tool: "manage_index",
                                    args: { action: manageAction, path: absolutePath },
                                },
                            },
                        }),
                    );
                }

                const vectorBackendDiagnostic = classifyVectorBackendError(validationError);
                if (vectorBackendDiagnostic) {
                    const operation = transitionOperation("failed");
                    return this.host.manageVectorBackendResponse(manageAction, absolutePath, vectorBackendDiagnostic, undefined, operation);
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
                    operationOptions("failed", timeoutOptions),
                );
            }

            const failedInfo = this.host.getSnapshotCodebaseInfo(absolutePath);
            if (failedInfo?.status === "indexfailed") {
                const previousError = typeof failedInfo.errorMessage === "string" ? failedInfo.errorMessage : "Unknown error";
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${previousError}`);
            }

            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            }
            const operation = transitionOperation("scanning", () => {
                this.host.snapshotManager.setCodebaseIndexing(absolutePath, 0);
            });

            trackCodebasePath(absolutePath);
            await this.host.touchWatchedCodebase(absolutePath);
            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            }

            const startBackgroundIndexing = this.host.startBackgroundIndexing
                ?? this.startBackgroundIndexing.bind(this);
            const backgroundIndexing = startBackgroundIndexing(
                absolutePath,
                forceReindex,
                stagedCollectionName,
                mutationLease,
                existingInfo,
                policyUpdate,
            );
            leaseTransferred = mutationLease !== undefined;
            const launchedLease = mutationLease;
            void Promise.resolve(backgroundIndexing)
                .catch((backgroundError: unknown) => {
                    console.error(`[BACKGROUND-INDEX] Detached worker rejected for '${absolutePath}':`, backgroundError);
                    if (
                        launchedLease
                        && this.host.mutationLeaseCoordinator?.isCurrent(launchedLease)
                    ) {
                        try {
                            transitionOperation("failed", () => {
                                this.host.snapshotManager.setCodebaseIndexFailed(
                                    absolutePath,
                                    formatUnknownError(backgroundError),
                                    this.host.getSnapshotIndexingProgress(absolutePath),
                                );
                            });
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
                { ...preflightOptions, ...(operation ? { operation } : {}) },
            );
        } catch (error: unknown) {
            console.error("Error in handleIndexCodebase:", error);
            const failurePath = canonicalRoot ?? absolutePathOrRaw(codebasePath);
            const previousFingerprint = parseIndexFingerprint(existingInfo?.indexFingerprint);
            const previousCollectionName = typeof existingInfo?.collectionName === "string"
                ? existingInfo.collectionName.trim()
                : "";
            const previousIndexedFiles = existingInfo?.indexedFiles;
            const previousTotalChunks = existingInfo?.totalChunks;
            let restorePreviousLifecycle = false;
            if (
                forceReindex
                && previousCollectionName.length > 0
                && previousFingerprint
                && existingInfo?.fingerprintSource === "verified"
                && existingInfo?.indexStatus === "completed"
                && Number.isSafeInteger(previousIndexedFiles)
                && Number(previousIndexedFiles) >= 0
                && Number.isSafeInteger(previousTotalChunks)
                && Number(previousTotalChunks) >= 0
            ) {
                try {
                    const provenGeneration = await this.host.context.proveVectorGeneration(failurePath);
                    restorePreviousLifecycle = provenGeneration?.collectionName === previousCollectionName
                        && provenGeneration.marker.indexStatus !== "limit_reached"
                        && provenGeneration.marker.indexedFiles === Number(previousIndexedFiles)
                        && provenGeneration.marker.totalChunks === Number(previousTotalChunks)
                        && indexFingerprintsEqual(previousFingerprint, this.host.runtimeFingerprint);
                } catch {
                    restorePreviousLifecycle = false;
                }
            }
            const applyFailureLifecycle = (): void => {
                if (restorePreviousLifecycle && previousFingerprint) {
                    this.host.snapshotManager.setCodebaseIndexed(
                        failurePath,
                        {
                            indexedFiles: Number(previousIndexedFiles),
                            totalChunks: Number(previousTotalChunks),
                            status: "completed",
                        },
                        previousFingerprint,
                        "verified",
                        previousCollectionName,
                    );
                    return;
                }
                this.host.snapshotManager.setCodebaseIndexFailed(
                    failurePath,
                    formatUnknownError(error),
                    this.host.getSnapshotIndexingProgress(failurePath),
                );
            };
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                const errorMessage = formatUnknownError(error);
                const preservesLocalState = errorMessage.includes("Force reindex cleanup failed before local state changes");
                const humanText = preservesLocalState
                    ? `${vectorBackendDiagnostic.message} ${errorMessage}`
                    : vectorBackendDiagnostic.message;
                let operation;
                try {
                    operation = mutationLease && !operationTerminal && this.host.mutationLeaseCoordinator?.isCurrent(mutationLease)
                        ? transitionOperation("failed", applyFailureLifecycle)
                        : lastDurableOperation;
                } catch (receiptError) {
                    console.error("Failed to persist terminal operation receipt:", receiptError);
                    operation = lastDurableOperation;
                }
                return this.host.manageVectorBackendResponse(manageAction, failurePath, vectorBackendDiagnostic, humanText, operation);
            }
            let operation;
            try {
                operation = mutationLease && !operationTerminal && this.host.mutationLeaseCoordinator?.isCurrent(mutationLease)
                    ? transitionOperation("failed", applyFailureLifecycle)
                    : lastDurableOperation;
            } catch (receiptError) {
                console.error("Failed to persist terminal operation receipt:", receiptError);
                operation = lastDurableOperation;
            }
            return this.host.manageResponse(
                manageAction,
                failurePath,
                "error",
                `Error starting indexing: ${formatUnknownError(error)}`,
                { ...preflightOptions, ...(operation ? { operation } : {}) },
            );
        } finally {
            if (mutationLease && !leaseTransferred) {
                this.host.mutationLeaseCoordinator?.release(mutationLease);
            }
        }
    }

    public async handleReindexCodebase(args: ReindexCodebaseArgs): Promise<ToolTextResponse> {
        const { path: codebasePath, customExtensions, ignorePatterns, zillizDropCollection, allowUnnecessaryReindex } = args;
        const absolutePathResult = requireAbsoluteFilesystemPath(codebasePath, "path");
        if (!absolutePathResult.ok) {
            return this.host.manageResponse("reindex", codebasePath, "error", absolutePathResult.message);
        }
        let absolutePath: string;
        try {
            absolutePath = this.host.canonicalizeCodebasePath(absolutePathResult.absolutePath);
        } catch (error) {
            return this.host.manageResponse(
                "reindex",
                absolutePathResult.absolutePath,
                "error",
                `Error starting reindex: ${formatUnknownError(error)}`,
            );
        }
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
        return this.handleIndexCodebaseInternal({
            path: codebasePath,
            force: true,
            customExtensions,
            ignorePatterns,
            zillizDropCollection,
            __reindexPreflight: forwardedPreflight,
        }, absolutePath);
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
        let mutationLease: RootMutationLease | undefined;
        let operationTerminal = false;
        let lastDurableOperation: IndexOperationReceipt | undefined;
        let lastRepairProof: RepairProof | undefined;
        const persistOperation = (phase: IndexOperationPhase, mutateSnapshot?: () => void) => {
            if (!mutationLease) {
                mutateSnapshot?.();
                return undefined;
            }
            if (typeof this.host.snapshotManager.transitionOperation !== "function") {
                mutateSnapshot?.();
                return undefined;
            }
            this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            const operation = typeof this.host.snapshotManager.commitOperationPhase === "function"
                ? this.host.snapshotManager.commitOperationPhase(
                    mutationLease,
                    phase,
                    mutateSnapshot,
                    () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!),
                )
                : (() => {
                    const next = this.host.snapshotManager.transitionOperation(mutationLease!, phase);
                    mutateSnapshot?.();
                    if (this.host.snapshotManager.saveCodebaseSnapshot() === false) {
                        throw new Error(`Failed to persist repair operation receipt for '${absolutePath}'.`);
                    }
                    return next;
                })();
            lastDurableOperation = operation;
            operationTerminal = phase === "completed" || phase === "failed" || phase === "blocked";
            return operation;
        };
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

            const leaseResult = this.host.mutationLeaseCoordinator?.acquire(absolutePath, "repair");
            if (leaseResult && !leaseResult.acquired) {
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "blocked",
                    formatMutationLeaseBlockedMessage(leaseResult.activeLease),
                    {
                        reason: "mutation_in_progress",
                        hints: {
                            status: this.host.buildStatusHint(absolutePath),
                            activeMutation: leaseResult.activeLease,
                        },
                    },
                );
            }
            mutationLease = leaseResult?.lease;
            if (mutationLease && typeof this.host.snapshotManager.startOperation === "function") {
                const operation = typeof this.host.snapshotManager.commitOperationPhase === "function"
                    ? this.host.snapshotManager.commitOperationPhase(
                        mutationLease,
                        "accepted",
                        undefined,
                        () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!),
                    )
                    : this.host.snapshotManager.startOperation(mutationLease);
                if (
                    typeof this.host.snapshotManager.commitOperationPhase !== "function"
                    && this.host.snapshotManager.saveCodebaseSnapshot() === false
                ) {
                    throw new Error(`Failed to persist accepted repair operation receipt for '${absolutePath}'.`);
                }
                lastDurableOperation = operation;
            }

            // Exclusive lease holders may supersede abandoned indexing immediately.
            await this.host.recoverStaleIndexingStateIfNeeded(absolutePath, mutationLease);

            if (this.host.getSnapshotIndexingCodebases().includes(absolutePath)) {
                const operation = persistOperation("blocked");
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
                        ...(operation ? { operation } : {}),
                    },
                );
            }

            const snapshotInfo = this.host.getSnapshotCodebaseInfo(absolutePath);
            const snapshotEvidence = classifyRepairSnapshotEvidence(snapshotInfo);
            const preferredCollectionName = typeof snapshotInfo?.collectionName === "string"
                ? snapshotInfo.collectionName.trim()
                : "";
            persistOperation("proving");
            const result = await this.host.context.repairIndex(absolutePath, {
                snapshotEvidence,
                ...(preferredCollectionName ? { preferredCollectionName } : {}),
                onProofUpdate: (proof) => {
                    lastRepairProof = proof;
                },
                ...(mutationLease ? {
                    assertMutationCurrent: () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!),
                    publishMutation: (publish: () => void) => {
                        if (!this.host.mutationLeaseCoordinator) {
                            throw new Error(`Cannot publish repair state for '${absolutePath}' without a mutation lease coordinator.`);
                        }
                        this.host.mutationLeaseCoordinator.publishWhileCurrent(mutationLease!, publish);
                    },
                } : {}),
            });
            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            }
            lastRepairProof = result.proof;

            if (result.status === "ok") {
                const assertMutationCurrent = mutationLease
                    ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!)
                    : undefined;
                persistOperation("publishing");
                lastRepairProof = {
                    ...result.proof,
                    navigation: {
                        status: "unproven",
                        basis: "call_graph_rebuild_in_progress",
                    },
                };
                await this.host.rebuildCallGraphForIndex(absolutePath, assertMutationCurrent);
                assertMutationCurrent?.();
                lastRepairProof = {
                    ...result.proof,
                    navigation: {
                        status: "matched",
                        basis: "navigation_and_call_graph_rebuilt",
                    },
                };
                try {
                    await this.host.touchWatchedCodebase(absolutePath);
                } catch (watcherError) {
                    console.warn(`[REPAIR] Failed to refresh watcher for '${absolutePath}' after navigation proof: ${formatUnknownError(watcherError)}`);
                }
                assertMutationCurrent?.();

                const stats = {
                    indexedFiles: result.indexedFiles || 0,
                    totalChunks: result.totalChunks || 0,
                    status: "completed" as const
                };
                const trackedRelativePaths = (result as { trackedRelativePaths?: unknown }).trackedRelativePaths;
                const operation = persistOperation("completed", () => {
                    this.host.snapshotManager.setCodebaseIndexed(
                        absolutePath,
                        stats,
                        this.host.runtimeFingerprint,
                        "verified",
                        result.collectionName
                    );
                    this.host.snapshotManager.setCodebaseIndexManifest(
                        absolutePath,
                        Array.isArray(trackedRelativePaths)
                            ? trackedRelativePaths.filter((entry): entry is string => typeof entry === "string")
                            : this.host.getContextTrackedRelativePaths(absolutePath)
                    );
                });
                if (!operation) {
                    this.host.saveSnapshotIfSupported();
                }
                this.host.setIndexingStats(stats);

                const warningsArray = Array.isArray(result.warnings) ? result.warnings : [];
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "ok",
                    result.message,
                    {
                        warnings: warningsArray,
                        repairProof: lastRepairProof,
                        ...(operation ? { operation } : {}),
                    }
                );
            } else if (result.status === "requires_reindex") {
                const operation = persistOperation("blocked");
                const reindexHints = this.host.buildManageRequiresReindexHints(absolutePath);
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "requires_reindex",
                    result.message,
                    {
                        reason: "requires_reindex",
                        hints: {
                            ...reindexHints,
                            nextAction: this.host.buildReindexHint(absolutePath),
                        },
                        repairProof: result.proof,
                        ...(operation ? { operation } : {}),
                    }
                );
            } else {
                const operation = persistOperation("blocked");
                const createHint = this.host.buildCreateHint(absolutePath);
                return this.host.manageResponse(
                    "repair",
                    absolutePath,
                    "blocked",
                    result.message,
                    {
                        reason: result.reason || "needs_create",
                        hints: {
                            create: createHint,
                            nextAction: createHint,
                            missingCount: result.missingCount,
                        },
                        repairProof: result.proof,
                        ...(operation ? { operation } : {}),
                    }
                );
            }

        } catch (error: unknown) {
            console.error("Error in handleRepairIndex:", error);
            if (
                lastRepairProof?.navigation.basis === "call_graph_rebuild_in_progress"
            ) {
                lastRepairProof = {
                    ...lastRepairProof,
                    navigation: {
                        status: "failed",
                        basis: "navigation_publication_failed",
                    },
                };
            }
            let operation;
            try {
                operation = mutationLease && !operationTerminal && this.host.mutationLeaseCoordinator?.isCurrent(mutationLease)
                    ? persistOperation("failed")
                    : lastDurableOperation;
            } catch (receiptError) {
                console.error("Failed to persist terminal repair receipt:", receiptError);
                operation = lastDurableOperation;
            }
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                return this.host.manageVectorBackendResponse(
                    "repair",
                    absolutePath,
                    vectorBackendDiagnostic,
                    undefined,
                    operation,
                    lastRepairProof,
                );
            }
            return this.host.manageResponse(
                "repair",
                absolutePath,
                "error",
                `Error performing repair: ${formatUnknownError(error)}`,
                {
                    ...(operation ? { operation } : {}),
                    ...(lastRepairProof ? { repairProof: lastRepairProof } : {}),
                },
            );
        } finally {
            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.release(mutationLease);
            }
        }
    }

    private async startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        writeCollectionName?: string,
        mutationLease?: RootMutationLease,
        previousIndexedInfo?: Record<string, unknown>,
        policyUpdate: CustomIndexPolicyUpdate = {},
    ): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0;
        let targetCollectionName: string | undefined;
        let navigationCandidate: import("@zokizuan/satori-core").StagedNavigationSidecarGeneration | undefined;
        let candidatePolicy: ResolvedIndexPolicy | null = null;
        let candidatePolicyPublished = false;
        let candidateAuthorityForRollback: ReturnType<Context['captureDurableIndexAuthority']> | null = null;
        let expectedCandidateAuthority: Awaited<ReturnType<Context['proveVectorGeneration']>> = null;
        let candidateMarkerRunId: string | undefined;
        let candidateMarkerPublicationStarted = false;
        let writingReceiptPublished = false;
        let fullIndexCheckpoint: import("@zokizuan/satori-core").PreparedFileChangeSet | undefined;
        let fullIndexSynchronizer: import("@zokizuan/satori-core").FileSynchronizer | undefined;
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

        const previousInfo = previousIndexedInfo ?? this.host.getSnapshotCodebaseInfo(absolutePath);
        const previousFingerprint = parseIndexFingerprint(previousInfo?.indexFingerprint);
        const previousCollectionName = typeof previousInfo?.collectionName === "string"
            ? previousInfo.collectionName.trim()
            : "";
        const previousIndexedFiles = previousInfo?.indexedFiles;
        const previousTotalChunks = previousInfo?.totalChunks;
        const previousAuthority = this.host.context.captureDurableIndexAuthority(absolutePath);
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
                const provenGeneration = await this.host.context.proveVectorGeneration(absolutePath);
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

        try {
            for (const [capability, implementation] of [
                ["publishCompletedIndexMarker", this.host.context.publishCompletedIndexMarker],
                ["publishNavigationCandidate", this.host.context.publishNavigationCandidate],
                ["discardNavigationCandidate", this.host.context.discardNavigationCandidate],
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
            this.host.setWriteCollectionOverride(absolutePath, targetCollectionName);

            if (forceReindex) {
                console.log("[BACKGROUND-INDEX] ℹ️  Force reindex mode - building a staged generation before retiring the previous proven collection.");
            }

            const profileConfig = this.host.loadIndexProfileForCodebase(absolutePath);
            console.log(`[BACKGROUND-INDEX] Using index profile '${profileConfig.profile}'${profileConfig.configPath ? ` from ${profileConfig.configPath}` : " (default)"}`);

            candidatePolicy = forceReindex
                ? await this.host.context.resolveIndexPolicyForReindex(absolutePath, policyUpdate)
                : await this.host.context.resolveIndexPolicyForCodebase(absolutePath, policyUpdate);
            candidateMarkerRunId = crypto.randomUUID();
            const { FileSynchronizer } = await import("@zokizuan/satori-core");
            const ignorePatterns = candidatePolicy.effectiveIgnorePatterns;
            const supportedExtensions = candidatePolicy.supportedExtensions;
            console.log(`[BACKGROUND-INDEX] Using ${ignorePatterns.length} effective ignore patterns (policy=${candidatePolicy.policyHash.slice(0, 12)}).`);
            const synchronizer = new FileSynchronizer(
                absolutePath,
                ignorePatterns,
                supportedExtensions,
                {
                    checkpointIdentity: targetCollectionName,
                    checkpointAuthority: {
                        collectionName: targetCollectionName,
                        markerRunId: candidateMarkerRunId,
                        indexPolicyHash: candidatePolicy.policyHash,
                    },
                },
            );
            fullIndexSynchronizer = synchronizer;
            await synchronizer.initialize(
                assertMutationCurrent,
                publishMutation,
                { deferSnapshotPublication: true },
            );

            await this.host.context.ensureCollectionPrepared(
                absolutePath,
                mutationLease
                    ? () => this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease!)
                    : undefined,
            );

            console.log(`[BACKGROUND-INDEX] Starting indexing for: ${absolutePath}`);

            const encoderEngine = this.host.context.getEmbeddingEngine();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${encoderEngine.getProvider()} with dimension: ${encoderEngine.getDimension()}`);

            console.log("[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...");
            const stats = await this.host.context.indexCodebase(absolutePath, (progress) => {
                if (mutationLease) {
                    this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
                }
                this.host.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

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
            });
            navigationCandidate = stats.navigationCandidate;
            publishedIndexStats = {
                indexedFiles: stats.indexedFiles,
                totalChunks: stats.totalChunks,
                status: stats.status,
            };
            if (stats.status === "completed") {
                // The checkpoint is authoritative only when it describes the exact
                // source bytes consumed by this candidate generation.
                fullIndexCheckpoint = await synchronizer.prepareChanges({ forceFullHash: true });
                assertCheckpointMatchesIndexedSources(stats.indexedFiles, stats.indexedFileHashes, fullIndexCheckpoint);
                // Publish the candidate-scoped checkpoint before any canonical
                // authority selects its collection. A crash can now leave only
                // an unreferenced checkpoint, never new authority with an old
                // root-global freshness baseline.
                await fullIndexCheckpoint.commit(assertMutationCurrent, publishMutation);
                fullIndexCheckpointCommitted = true;
            }
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);
            if (mutationLease) {
                this.host.mutationLeaseCoordinator?.assertCurrent(mutationLease);
            }
            persistBackgroundPhase("proving");

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
                console.warn(`[BACKGROUND-INDEX] Candidate for '${absolutePath}' reached the chunk limit; preserved previous complete collection '${previousCompleteGeneration.collectionName}'.`);
                return;
            }

            if (stats.status === "limit_reached") {
                this.host.context.publishResolvedIndexPolicy(
                    candidatePolicy,
                    {
                        collectionName: targetCollectionName,
                        navigation: { status: 'not_bound' },
                    },
                    publishMutation,
                );
                candidatePolicyPublished = true;
                candidateAuthorityForRollback = this.host.context.captureDurableIndexAuthority(absolutePath);
                // From this point a lost acknowledgement can leave a remote marker,
                // so failure cleanup must attempt withdrawal even if publication throws.
                candidateMarkerPublicationStarted = true;
                await this.host.context.publishCompletedIndexMarker(
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
            // Full navigation rebuild only for completed indexes; partial indexes have no registry seal.
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
                // Seal vector proof first. Active resolution also requires the matching
                // navigation pointer, so the candidate remains unavailable until the
                // pointer publication below succeeds.
                await this.host.context.publishCompletedIndexMarker(
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
            try {
                await this.host.touchWatchedCodebase(absolutePath);
            } catch (watcherError) {
                console.warn(`[BACKGROUND-INDEX] Failed to refresh watcher for '${absolutePath}' after index proof: ${formatUnknownError(watcherError)}`);
            }
            if (stats.status === "completed" && stats.navigationCandidate) {
                this.host.context.publishResolvedIndexPolicy(
                    candidatePolicy,
                    {
                        collectionName: targetCollectionName,
                        navigation: {
                            status: 'sealed',
                            generationId: stats.navigationCandidate.generationId,
                            sealHash: stats.navigationCandidate.navigationSealHash,
                        },
                    },
                    publishMutation,
                );
                candidatePolicyPublished = true;
                candidateAuthorityForRollback = this.host.context.captureDurableIndexAuthority(absolutePath);
                expectedCandidateAuthority = await this.host.context.proveVectorGeneration(absolutePath);
                if (
                    expectedCandidateAuthority?.collectionName !== targetCollectionName
                    || expectedCandidateAuthority.marker.indexStatus !== "completed"
                    || expectedCandidateAuthority.marker.indexedFiles !== stats.indexedFiles
                    || expectedCandidateAuthority.marker.totalChunks !== stats.totalChunks
                    || expectedCandidateAuthority.marker.indexPolicyHash !== candidatePolicy.policyHash
                ) {
                    throw new Error(`Candidate vector authority for '${absolutePath}' could not be proven before navigation publication.`);
                }
                await this.host.context.publishNavigationCandidate(
                    stats.navigationCandidate,
                    assertMutationCurrent,
                    publishMutation,
                );
                candidateAuthorityForRollback = this.host.context.captureDurableIndexAuthority(absolutePath);
                candidateAuthorityCommitted = true;
            }
            if (stats.status === "completed") {
                if (!fullIndexCheckpointCommitted) {
                    throw new Error(`Full index checkpoint was not committed for '${absolutePath}'.`);
                }
                this.host.context.registerSynchronizer(this.host.resolveCollectionName(absolutePath), synchronizer);
            }
            if (stats.status === "completed") {
                await this.host.syncManager.recordCurrentIgnoreControlSignature(absolutePath, mutationLease);
            }
            assertMutationCurrent?.();
            persistBackgroundPhase("completed", () => {
                this.host.snapshotManager.setCodebaseIndexed(absolutePath, stats, this.host.runtimeFingerprint, "verified", targetCollectionName);
                this.host.snapshotManager.setCodebaseIndexManifest(absolutePath, this.host.getContextTrackedRelativePaths(absolutePath));
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
                candidateAuthorityForRollback = this.host.context.captureDurableIndexAuthority(absolutePath);
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
                    const provenCandidate = await this.host.context.proveIndexedGeneration(absolutePath);
                    candidateAuthorityCommitted = provenCandidate?.collectionName === targetCollectionName
                        && provenCandidate.policyDocumentDigest === expectedCandidateAuthority.policyDocumentDigest
                        && this.host.context.indexCompletionMarkersEqual(
                            provenCandidate.marker,
                            expectedCandidateAuthority.marker,
                        );
                } catch {
                    candidateAuthorityCommitted = false;
                }
            }
            if (fullIndexCheckpointCommitted && candidateAuthorityCommitted && committedIndexStats) {
                if (fullIndexSynchronizer) {
                    this.host.context.registerSynchronizer(
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
                            this.host.getContextTrackedRelativePaths(absolutePath),
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

            // If publication never started, there is no candidate marker to withdraw
            // and checkpoint cleanup is already safe. Once it starts, require a
            // successful withdrawal before deleting candidate checkpoint evidence.
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
                    await this.host.context.discardNavigationCandidate(navigationCandidate, assertMutationCurrent);
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
                    await this.host.context.restoreDurableIndexAuthority(
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
        } finally {
            this.host.setWriteCollectionOverride(absolutePath, null);
        }
    }
}
