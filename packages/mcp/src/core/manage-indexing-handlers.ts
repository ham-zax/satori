import * as fs from "fs";
import { fileURLToPath } from "node:url";
import {
    COLLECTION_LIMIT_MESSAGE,
    Context,
    RemoteCollectionDeletePendingError,
    type CustomIndexPolicyUpdate,
} from "@zokizuan/satori-core";
import type { SyncManager } from "./sync.js";
import type { ManageIndexAction } from "./manage-types.js";
import type { CompletionProofValidationResult } from "./completion-proof.js";
import {
    classifyVectorBackendError,
    type VectorBackendDiagnostic,
} from "./backend-diagnostics.js";
import { absolutePathOrRaw, requireAbsoluteFilesystemPath, trackCodebasePath } from "../utils.js";
import type { ReindexPreflightResult } from "./working-tree-state.js";
import type { RuntimeOwnerMutationAction } from "./runtime-owner.js";
import type { ZillizCollectionDropResult } from "./vector-backend-maintenance.js";
import {
    RootMutationInProgressError,
    RootMutationRuntime,
    formatRootMutationBlockedMessage,
    type MutationOperationPhase,
    type RootMutationExecution,
    type RootMutationOperation,
    type RootMutationStart,
} from "@zokizuan/satori-core/integration";
import {
    FullIndexOperation,
    type FullIndexCandidateResult,
    type FullIndexCandidateRunner,
} from "./full-index-operation.js";
import { spawnSupervisedMutationWorker } from "../server/mutation-worker-supervisor.js";

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
    mutationRuntime: RootMutationRuntime;
    syncManager: SyncManager;
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
    buildManageActionBlockedMessage(
        codebasePath: string,
        action: Extract<RuntimeOwnerMutationAction, "create" | "reindex">,
    ): string;
    buildCreateHint(codebasePath: string): Record<string, unknown>;
    buildReindexHint(codebasePath: string): Record<string, unknown>;
    buildStatusHint(codebasePath: string): Record<string, unknown>;
    getManageRetryAfterMs(): number;
    buildIndexingMetadata(codebasePath: string): Record<string, unknown> | undefined;
    buildReindexInstruction(codebasePath: string, detail?: string): string;
    buildManageRequiresReindexHints(codebasePath: string): Record<string, unknown>;
    validateCompletionProof(codebasePath: string): Promise<CompletionProofValidationResult>;
    probeLocalSearchCollectionState(codebasePath: string): Promise<{
        state: "ready" | "missing" | "unknown";
        collectionName?: string;
    }>;
    isZillizBackend(): boolean;
    dropZillizCollectionForCreate(collectionName: string): Promise<ZillizCollectionDropResult>;
    buildCollectionLimitMessage(codebasePath: string): Promise<string>;
    manageVectorBackendResponse(
        action: ManageIndexAction,
        path: string,
        diagnostic: VectorBackendDiagnostic,
        humanText?: string,
        operation?: RootMutationOperation,
    ): ToolTextResponse;
    touchWatchedCodebase(codebasePath: string): Promise<void>;
    loadIndexProfileForCodebase(codebasePath: string): IndexProfileView;
    getContextActiveIgnorePatterns(codebasePath: string): string[];
    getContextIndexedExtensions(codebasePath: string): string[];
    canonicalizeCodebasePath(codebasePath: string): string;
    setIndexingStats(stats: { indexedFiles: number; totalChunks: number } | null): void;
    evaluateReindexPreflight(codebasePath: string): ReindexPreflightResult;
    assertIndexMutationCapabilities(): void;
    ownDetachedMutationCompletion(completion: Promise<void>): void;
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

const FULL_INDEX_NO_PROGRESS_TIMEOUT_MS = 30 * 60 * 1000;

function resolveMutationIndexWorkerPath(): string {
    const built = fileURLToPath(new URL("../server/mutation-index-worker.js", import.meta.url));
    if (fs.existsSync(built)) return built;
    return fileURLToPath(new URL("../server/mutation-index-worker.ts", import.meta.url));
}

function parseFullIndexWorkerResult(
    value: Readonly<Record<string, unknown>> | undefined,
): FullIndexCandidateResult {
    if (!value) {
        throw new Error("Mutation index worker completed without a result.");
    }
    const indexedFiles = value.indexedFiles;
    const totalChunks = value.totalChunks;
    const status = value.status;
    const collectionName = value.collectionName;
    const publication = value.publication;
    if (!Number.isSafeInteger(indexedFiles) || (indexedFiles as number) < 0) {
        throw new Error("Mutation index worker result has invalid indexedFiles.");
    }
    if (!Number.isSafeInteger(totalChunks) || (totalChunks as number) < 0) {
        throw new Error("Mutation index worker result has invalid totalChunks.");
    }
    if (status !== "completed" && status !== "limit_reached") {
        throw new Error("Mutation index worker result has invalid status.");
    }
    if (typeof collectionName !== "string" || collectionName.length === 0) {
        throw new Error("Mutation index worker result has invalid collectionName.");
    }
    if (!publication || typeof publication !== "object" || Array.isArray(publication)) {
        throw new Error("Mutation index worker result has invalid publication.");
    }
    const publicationRecord = publication as Record<string, unknown>;
    if (typeof publicationRecord.id !== "string" || publicationRecord.id.length === 0) {
        throw new Error("Mutation index worker result has invalid publication id.");
    }
    if (publicationRecord.status !== "staged" && publicationRecord.status !== "activated") {
        throw new Error("Mutation index worker result has invalid publication status.");
    }
    return {
        indexedFiles: indexedFiles as number,
        totalChunks: totalChunks as number,
        status,
        collectionName,
        publication: {
            id: publicationRecord.id,
            status: publicationRecord.status,
        },
    };
}

export class ManageIndexingHandlers {
    constructor(private readonly host: ManageIndexingHandlersHost) {}

    private createSupervisedCandidateRunner(
        execution: RootMutationExecution,
        action: "create" | "reindex",
    ): FullIndexCandidateRunner {
        return async (input) => {
            let completedResult: Readonly<Record<string, unknown>> | undefined;
            const worker = spawnSupervisedMutationWorker({
                operationId: execution.id,
                workerPath: resolveMutationIndexWorkerPath(),
                workerArgs: [JSON.stringify({
                    path: input.codebasePath,
                    action,
                    forceReindex: input.forceReindex,
                    indexPolicy: input.indexPolicy,
                    deferPartialPublication: input.deferPartialPublication,
                })],
                signal: execution.signal,
                noProgressTimeoutMs: FULL_INDEX_NO_PROGRESS_TIMEOUT_MS,
                onHeartbeat: () => {
                    const operation = this.host.mutationRuntime.getCurrentOperation(input.codebasePath);
                    if (
                        operation?.id === execution.id
                        && operation.phase !== "completed"
                        && operation.phase !== "failed"
                        && operation.phase !== "blocked"
                        && operation.phase !== "cancelled"
                    ) {
                        execution.heartbeat();
                    }
                },
                onProgress: (progress) => {
                    const percentage = progress.progress ?? 0;
                    input.onProgress({
                        phase: progress.phase ?? "writing",
                        current: percentage,
                        total: 100,
                        percentage,
                    });
                },
                onNoProgress: () => {
                    this.host.mutationRuntime.requestCancellation(
                        execution.id,
                        "full_index_no_progress_timeout",
                    );
                },
                onCompleted: (result) => {
                    completedResult = result;
                },
            });

            try {
                await worker.ready;
                if (execution.signal.aborted) {
                    throw execution.signal.reason ?? new Error("Full index cancelled before executor binding.");
                }
                execution.bindExecutor(worker.executor);
                worker.start();
            } catch (error) {
                worker.requestCancellation("full_index_startup_failed");
                await worker.completion.catch(() => undefined);
                throw error;
            }

            try {
                await worker.completion;
            } catch (error) {
                if (execution.signal.aborted) {
                    throw execution.signal.reason ?? error;
                }
                throw error;
            }
            return parseFullIndexWorkerResult(completedResult);
        };
    }

    public async handleIndexCodebase(args: IndexCodebaseArgs): Promise<ToolTextResponse> {
        return this.handleIndexCodebaseInternal(args);
    }

    private async handleIndexCodebaseInternal(
        args: IndexCodebaseArgs,
        preparedCanonicalRoot?: string,
        onMutationStarted?: (mutation: RootMutationStart<ToolTextResponse>) => void,
    ): Promise<ToolTextResponse> {
        const { path: codebasePath, force, customExtensions, ignorePatterns, zillizDropCollection } = args;
        const forceReindex = force || false;
        const mutationAction: "create" | "reindex" = forceReindex ? "reindex" : "create";
        const manageAction: ManageIndexAction = mutationAction;
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
        let canonicalRoot = preparedCanonicalRoot;

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
            if (!fs.statSync(absolutePath).isDirectory()) {
                return this.host.manageResponse(
                    manageAction,
                    absolutePath,
                    "error",
                    `Error: Path '${absolutePath}' is not a directory`,
                    preflightOptions,
                );
            }

            const runtimeOwnerConflict = await this.host.buildRuntimeOwnerConflictResponseIfBlocked(manageAction, absolutePath);
            if (runtimeOwnerConflict) return runtimeOwnerConflict;
            this.host.assertIndexMutationCapabilities();

            const mutation = this.host.mutationRuntime.start(absolutePath, mutationAction, async (execution) => {
                let dropSummaryLine = "";
                let lastOperation = this.host.mutationRuntime.getCurrentOperation(absolutePath);
                const transitionOperation = (
                    phase: MutationOperationPhase,
                    update: { progress?: number; error?: string } = {},
                ): RootMutationOperation => {
                    lastOperation = this.host.mutationRuntime.updateCurrentOperation(absolutePath, phase, update);
                    return lastOperation;
                };
                const operationOptions = (phase: MutationOperationPhase, options: Record<string, unknown> = {}) => ({
                    ...options,
                    operation: transitionOperation(phase),
                });

                try {
                    const existingPublication = this.host.context.getCurrentPublication(absolutePath);
                    if (!forceReindex && existingPublication) {
                        const proof = await this.host.validateCompletionProof(absolutePath);
                        if (proof.outcome === "policy_incompatible" || (
                            proof.outcome === "stale_local"
                            && proof.reason !== "missing_publication"
                        )) {
                            return this.host.manageResponse(
                                manageAction,
                                absolutePath,
                                "requires_reindex",
                                this.host.buildReindexInstruction(
                                    absolutePath,
                                    proof.reason === "requires_reindex"
                                        ? "The current Publication requires a fresh reindex for this runtime."
                                        : "The accepted index policy or Publication format is incompatible with this runtime.",
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
                            `Codebase '${absolutePath}' is already indexed.\n\nTo update incrementally with recent changes: call manage_index with {"action":"sync","path":"${absolutePath}"}.\nTo force rebuild from scratch: call manage_index with {"action":"create","path":"${absolutePath}","force":true}.`,
                            operationOptions("blocked", preflightOptions),
                        );
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
                        const currentCollectionName = existingPublication?.publication.vector.collectionName;
                        if (requestedDropCollection === currentCollectionName) {
                            return this.host.manageResponse(
                                manageAction,
                                absolutePath,
                                "error",
                                `Error: zillizDropCollection cannot target the current Publication collection '${currentCollectionName}' for this codebase. Use {"action":"create","path":"${absolutePath}","force":true} to build the replacement before historical GC retires the prior Publication.`,
                                operationOptions("failed", preflightOptions),
                            );
                        }

                        let dropResult: ZillizCollectionDropResult;
                        try {
                            dropResult = await this.host.dropZillizCollectionForCreate(requestedDropCollection);
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
                                formatRootMutationBlockedMessage(dropResult.activeMutation),
                                operationOptions("blocked", {
                                    ...preflightOptions,
                                    reason: "mutation_in_progress",
                                    hints: {
                                        status: this.host.buildStatusHint(dropResult.activeMutation.canonicalRoot),
                                        activeMutation: dropResult.activeMutation,
                                    },
                                }),
                            );
                        }
                        if (dropResult.status === "unmapped") {
                            return this.host.manageResponse(
                                manageAction,
                                absolutePath,
                                "error",
                                `Refused to drop Zilliz collection '${requestedDropCollection}' because its owning codebase root could not be proven from a current Publication or remote collection metadata. No remote or local index state was changed.`,
                                operationOptions("blocked", preflightOptions),
                            );
                        }
                        dropSummaryLine += dropResult.droppedCodebasePath
                            ? `\nDropped Zilliz collection '${requestedDropCollection}' (mapped codebase: '${dropResult.droppedCodebasePath}').`
                            : `\nDropped Zilliz collection '${requestedDropCollection}'.`;
                    }

                    this.host.mutationRuntime.assertCurrent(absolutePath);
                    const operation = transitionOperation("scanning", { progress: 0 });
                    trackCodebasePath(absolutePath);
                    await this.host.touchWatchedCodebase(absolutePath);
                    this.host.mutationRuntime.assertCurrent(absolutePath);

                    const fullIndexOperation = new FullIndexOperation(
                        this.host,
                        this.createSupervisedCandidateRunner(execution, mutationAction),
                    );
                    const pathInfo = codebasePath !== absolutePath
                        ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                        : "";
                    const extensionInfo = customFileExtensions.length > 0
                        ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(", ")}`
                        : "";
                    const ignoreInfo = customIgnorePatterns.length > 0
                        ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(", ")}`
                        : "";
                    const response = this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "ok",
                        `Started background indexing for codebase '${absolutePath}'.${pathInfo}${dropSummaryLine}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. Search and navigation are blocked until indexing completes. Poll manage_index with {"action":"status","path":"${absolutePath}"} (or wait for completion); do not search for partial results while status is indexing.`,
                        { ...preflightOptions, operation },
                    );
                    return {
                        response,
                        completion: fullIndexOperation.run({
                            codebasePath: absolutePath,
                            forceReindex,
                            policyUpdate,
                        }),
                    };
                } catch (error: unknown) {
                    console.error("Error in handleIndexCodebase:", error);
                    let operation = this.host.mutationRuntime.getCurrentOperation(absolutePath) ?? lastOperation;
                    if (
                        this.host.mutationRuntime.isCurrent(absolutePath)
                        && operation
                        && operation.phase !== "completed"
                        && operation.phase !== "failed"
                        && operation.phase !== "blocked"
                    ) {
                        try {
                            operation = transitionOperation("failed", { error: formatUnknownError(error) });
                        } catch (operationError) {
                            console.error("Failed to publish terminal live operation state:", operationError);
                        }
                    }
                    const vectorBackendDiagnostic = classifyVectorBackendError(error);
                    if (vectorBackendDiagnostic) {
                        const errorMessage = formatUnknownError(error);
                        const preservesLocalState = errorMessage.includes("Force reindex cleanup failed before local state changes");
                        const humanText = preservesLocalState
                            ? `${vectorBackendDiagnostic.message} ${errorMessage}`
                            : vectorBackendDiagnostic.message;
                        return this.host.manageVectorBackendResponse(
                            manageAction,
                            absolutePath,
                            vectorBackendDiagnostic,
                            humanText,
                            operation,
                        );
                    }
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "error",
                        `Error starting indexing: ${formatUnknownError(error)}`,
                        { ...preflightOptions, ...(operation ? { operation } : {}) },
                    );
                }
            });

            onMutationStarted?.(mutation);
            this.host.ownDetachedMutationCompletion(mutation.completion);
            void mutation.completion.catch((error: unknown) => {
                console.error(`[BACKGROUND-INDEX] Detached Core mutation rejected for '${absolutePath}':`, error);
            });
            try {
                return await mutation.started;
            } catch (error) {
                if (error instanceof RootMutationInProgressError) {
                    return this.host.manageResponse(
                        manageAction,
                        absolutePath,
                        "blocked",
                        formatRootMutationBlockedMessage(error.activeMutation),
                        {
                            ...preflightOptions,
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
            console.error("Error in handleIndexCodebase:", error);
            const failurePath = canonicalRoot ?? absolutePathOrRaw(codebasePath);
            const vectorBackendDiagnostic = classifyVectorBackendError(error);
            if (vectorBackendDiagnostic) {
                return this.host.manageVectorBackendResponse(manageAction, failurePath, vectorBackendDiagnostic);
            }
            return this.host.manageResponse(
                manageAction,
                failurePath,
                "error",
                `Error starting indexing: ${formatUnknownError(error)}`,
                preflightOptions,
            );
        }
    }

    public async startAutomaticCreate(codebasePath: string) {
        // Opening an already indexed workspace must not replace its operation
        // receipt or trigger a rebuild. Compatibility repair has its own owner.
        if (this.host.context.getCurrentPublication(codebasePath)) {
            return Object.freeze({ accepted: false, operationId: "", completion: null });
        }
        return this.startAutomaticIndex(codebasePath, false);
    }

    public startAutomaticReindex(codebasePath: string) {
        return this.startAutomaticIndex(codebasePath, true);
    }

    private async startAutomaticIndex(codebasePath: string, force: boolean): Promise<Readonly<{
        accepted: boolean;
        operationId: string;
        completion: Promise<void> | null;
    }>> {
        const currentPolicy = this.host.context.getCurrentPublication(codebasePath)?.publication.policy;
        let mutationStart: RootMutationStart<ToolTextResponse> | undefined;
        const response = await this.handleIndexCodebaseInternal(
            {
                path: codebasePath,
                force,
                ...(currentPolicy
                    ? {
                        customExtensions: [...currentPolicy.customExtensions],
                        ignorePatterns: [...currentPolicy.customIgnorePatterns],
                    }
                    : {}),
            },
            undefined,
            (mutation) => {
                mutationStart = mutation;
            },
        );
        let accepted = false;
        try {
            const payload = JSON.parse(response.content[0]?.text ?? "{}") as { status?: unknown };
            accepted = payload.status === "ok";
        } catch {
            accepted = false;
        }
        if (!force && !accepted) {
            throw new Error(response.content[0]?.text ?? "Automatic workspace indexing was not accepted.");
        }
        return Object.freeze({
            accepted,
            operationId: mutationStart?.operationId ?? "",
            completion: mutationStart?.completion ?? null,
        });
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
        const [preflight, currentProof, collectionState] = await Promise.all([
            Promise.resolve(this.host.evaluateReindexPreflight(absolutePath)),
            this.host.validateCompletionProof(absolutePath),
            this.host.probeLocalSearchCollectionState(absolutePath),
        ]);
        const currentPublicationFullyReady = currentProof.outcome === "valid"
            && currentProof.navigationStatus === "valid"
            && collectionState.state === "ready";

        if (
            preflight.outcome === "reindex_unnecessary_ignore_only"
            && currentPublicationFullyReady
            && allowUnnecessaryReindex !== true
        ) {
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


}
