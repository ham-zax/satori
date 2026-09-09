import {
    compareContractStrings,
    type PublicationNavigationStatus,
    type PublicationRef,
} from "@zokizuan/satori-core";
import type { CallGraphDirection, CallGraphSymbolRef } from "./search-types.js";
import type { FreshnessDecision } from "./sync.js";
import type {
    CompletionProofReason,
    CompletionProofValidationResult,
} from "./completion-proof.js";
import type { ManageIndexAction } from "./manage-types.js";
import type {
    AutomaticReindexReason,
    AutomaticReindexScheduleResult,
} from "./index-maintenance-coordinator.js";
import type {
    SearchGroupBy,
    SearchResultMode,
    SearchScope,
} from "./search-constants.js";
import type {
    CallGraphResponseEnvelope,
    FileOutlineResponseEnvelope,
    IndexingFailureMetadata,
    SearchRecommendedNextAction,
    SearchResponseEnvelope,
} from "./search-types.js";
import { SEARCH_RESPONSE_FORMAT_VERSION } from "./search-types.js";

type CodebaseStatus = "indexed" | "indexing";

export type TrackedCodebaseInfo = Record<string, unknown> & {
    status: CodebaseStatus;
    lastUpdated?: string;
    indexStatus?: unknown;
    indexedFiles?: unknown;
    totalChunks?: unknown;
    added?: unknown;
    removed?: unknown;
    modified?: unknown;
    errorMessage?: unknown;
    lastAttemptedPercentage?: unknown;
};

export type TrackedRootEntry = {
    path: string;
    info: TrackedCodebaseInfo;
};

export type CompletionProbeDebugHint = {
    ok: false;
    reason: "probe_failed";
    message: string;
    action: string;
};

type SearchContext = {
    path: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    resultMode: SearchResultMode;
    limit: number;
};

type CallGraphContext = {
    path: string;
    symbolRef: CallGraphSymbolRef;
    direction: CallGraphDirection;
    depth: number;
    limit: number;
};

export type TrackedRootIndexingOperation = {
    action: "create" | "reindex" | "sync";
    phase: string;
    generation: number;
};

export type TrackedRootReadinessState =
    | {
        state: "ready";
        root: TrackedRootEntry;
        navigationAuthorityMode: "canonical_v4";
        proofDebugHint?: CompletionProbeDebugHint;
        publication: PublicationRef;
        navigationStatus: PublicationNavigationStatus;
        freshnessDecision?: FreshnessDecision;
    }
    | { state: "requires_reindex"; codebasePath: string; message?: string }
    | {
        state: "indexing";
        codebasePath: string;
        operation?: TrackedRootIndexingOperation;
        searchableGenerationAvailable: boolean;
        searchableRead?: Extract<TrackedRootReadinessState, { state: "ready" }>;
    }
    | { state: "index_failed"; codebasePath: string; info: TrackedCodebaseInfo }
    | { state: "not_indexed" }
    | { state: "stale_local"; codebasePath: string; reason: CompletionProofReason }
    | { state: "missing_collection"; codebasePath: string; collectionName?: string; proofDebugHint?: CompletionProbeDebugHint };

export type TrackedRootReadinessHost = {
    onReadinessPhase?(phase: ReadinessPhase, durationMs: number): void;
    isPathWithinCodebase(targetPath: string, rootPath: string): boolean;
    listTrackedRoots(): TrackedRootEntry[];
    getIndexingOperation?(codebasePath: string): TrackedRootIndexingOperation | undefined;
    hasSearchableGeneration?(codebasePath: string): boolean;
    validateCompletionProof(codebasePath: string): Promise<CompletionProofValidationResult>;
    probeLocalSearchCollectionState(codebasePath: string): Promise<{
        state: "ready" | "missing" | "unknown";
        collectionName?: string;
    }>;
    buildCreateHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildReindexHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildStatusHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildManageIndexRecommendedAction(action: ManageIndexAction, codebasePath: string, rationale: string): SearchRecommendedNextAction;
    buildStaleLocalMessage(codebasePath: string, requestedPath: string, reason: CompletionProofReason): string;
    requestAutomaticReindex?(
        codebasePath: string,
        reason: AutomaticReindexReason,
    ): Promise<AutomaticReindexScheduleResult>;
};

export type ReadinessPhase =
    | "tracked_root_resolution"
    | "completion_proof"
    | "collection_probe";

export class TrackedRootReadiness {
    constructor(private readonly host: TrackedRootReadinessHost) {}

    private measurePhase<T>(
        phase: ReadinessPhase,
        run: () => T,
        onPhase?: (phase: ReadinessPhase, durationMs: number) => void,
    ): T {
        const startedAt = performance.now();
        try {
            return run();
        } finally {
            const durationMs = Math.max(0, performance.now() - startedAt);
            this.host.onReadinessPhase?.(phase, durationMs);
            onPhase?.(phase, durationMs);
        }
    }

    private async measureAsyncPhase<T>(
        phase: ReadinessPhase,
        run: () => Promise<T>,
        onPhase?: (phase: ReadinessPhase, durationMs: number) => void,
    ): Promise<T> {
        const startedAt = performance.now();
        try {
            return await run();
        } finally {
            const durationMs = Math.max(0, performance.now() - startedAt);
            this.host.onReadinessPhase?.(phase, durationMs);
            onPhase?.(phase, durationMs);
        }
    }

    public resolveTrackedRoot(
        absolutePath: string,
        statuses: CodebaseStatus[],
    ): TrackedRootEntry | null {
        const statusSet = new Set(statuses);
        const matches = this.host.listTrackedRoots()
            .filter((entry) => (
                statusSet.has(entry.info.status)
                && this.host.isPathWithinCodebase(absolutePath, entry.path)
            ))
            .sort((a, b) => b.path.length - a.path.length || compareContractStrings(a.path, b.path));
        return matches[0] ?? null;
    }

    public buildMissingLocalCollectionMessage(codebasePath: string, requestedPath: string, collectionName?: string): string {
        const requestedPathDetail = requestedPath !== codebasePath
            ? ` Requested path: '${requestedPath}'.`
            : "";
        const collectionDetail = collectionName
            ? ` Vector collection is missing from the configured vector backend ('${collectionName}').`
            : " Vector collection is missing from the configured vector backend.";
        return `Codebase '${codebasePath}' has a current Publication whose configured vector collection is unavailable.${collectionDetail}${requestedPathDetail} Automatic maintenance did not recover this state; use manage_index with {"action":"reindex","path":"${codebasePath}"} as the explicit recovery override.`;
    }

    public buildMissingLocalCollectionSearchPayload(
        codebasePath: string,
        searchContext: SearchContext,
        collectionName?: string,
    ): SearchResponseEnvelope {
        return {
            formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
            status: "not_indexed",
            reason: "not_indexed",
            codebasePath,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            message: this.buildMissingLocalCollectionMessage(codebasePath, searchContext.path, collectionName),
            recommendedNextAction: this.host.buildManageIndexRecommendedAction(
                "reindex",
                codebasePath,
                "Rebuild the current Publication because its configured vector collection is unavailable.",
            ),
            hints: {
                reindex: this.host.buildReindexHint(codebasePath),
            },
            results: [],
        } as SearchResponseEnvelope;
    }

    private buildIndexingFailureMetadata(info: TrackedCodebaseInfo): IndexingFailureMetadata {
        return {
            errorMessage: typeof info.errorMessage === "string" ? info.errorMessage : null,
            lastAttemptedPercentage: typeof info.lastAttemptedPercentage === "number" && Number.isFinite(info.lastAttemptedPercentage)
                ? Number(info.lastAttemptedPercentage)
                : null,
            lastUpdated: typeof info.lastUpdated === "string" ? info.lastUpdated : null,
        };
    }

    private buildIndexFailedMessage(codebasePath: string, requestedPath: string, info: TrackedCodebaseInfo): string {
        const failure = this.buildIndexingFailureMetadata(info);
        const requestedPathDetail = requestedPath !== codebasePath
            ? ` Requested path: '${requestedPath}'.`
            : "";
        const errorDetail = failure.errorMessage
            ? ` Error: ${failure.errorMessage}`
            : " Error: unknown indexing failure.";
        const progressDetail = failure.lastAttemptedPercentage !== null
            ? ` Failed at: ${failure.lastAttemptedPercentage.toFixed(1)}% progress.`
            : "";
        const updatedDetail = failure.lastUpdated
            ? ` Failed at: ${failure.lastUpdated}.`
            : "";
        return `Codebase '${codebasePath}' has a failed indexing attempt.${requestedPathDetail}${errorDetail}${progressDetail}${updatedDetail} Satori will not serve semantic results from an unproven partial index. Run manage_index with {"action":"create","path":"${codebasePath}"} to restart indexing for this failed state.`;
    }

    public buildIndexFailedSearchPayload(
        codebasePath: string,
        searchContext: SearchContext,
        info: TrackedCodebaseInfo,
    ): SearchResponseEnvelope {
        return {
            formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
            status: "not_indexed",
            reason: "index_failed",
            codebasePath,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            message: this.buildIndexFailedMessage(codebasePath, searchContext.path, info),
            indexingFailure: this.buildIndexingFailureMetadata(info),
            recommendedNextAction: this.host.buildManageIndexRecommendedAction(
                "create",
                codebasePath,
                "Restart indexing because the previous attempt failed before a current Publication became readable.",
            ),
            hints: {
                create: this.host.buildCreateHint(codebasePath),
                status: this.host.buildStatusHint(codebasePath),
            },
            results: [],
        } as SearchResponseEnvelope;
    }

    public buildIndexFailedFileOutlinePayload(
        codebasePath: string,
        requestedPath: string,
        file: string,
        info: TrackedCodebaseInfo,
    ): FileOutlineResponseEnvelope {
        return {
            status: "not_indexed",
            reason: "index_failed",
            path: requestedPath,
            codebaseRoot: codebasePath,
            file,
            outline: null,
            hasMore: false,
            message: this.buildIndexFailedMessage(codebasePath, requestedPath, info),
            indexingFailure: this.buildIndexingFailureMetadata(info),
            hints: {
                create: this.host.buildCreateHint(codebasePath),
                status: this.host.buildStatusHint(codebasePath),
            },
        } as FileOutlineResponseEnvelope;
    }

    public buildIndexFailedCallGraphPayload(
        codebasePath: string,
        context: CallGraphContext,
        info: TrackedCodebaseInfo,
    ): CallGraphResponseEnvelope {
        return {
            status: "not_indexed",
            supported: false,
            reason: "index_failed",
            path: context.path,
            codebaseRoot: codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            message: this.buildIndexFailedMessage(codebasePath, context.path, info),
            indexingFailure: this.buildIndexingFailureMetadata(info),
            hints: {
                create: this.host.buildCreateHint(codebasePath),
                status: this.host.buildStatusHint(codebasePath),
            },
        };
    }

    public buildMissingLocalCollectionFileOutlinePayload(
        codebasePath: string,
        requestedPath: string,
        file: string,
        collectionName?: string,
    ): FileOutlineResponseEnvelope {
        return {
            status: "not_indexed",
            reason: "not_indexed",
            path: requestedPath,
            file,
            outline: null,
            hasMore: false,
            message: this.buildMissingLocalCollectionMessage(codebasePath, requestedPath, collectionName),
            hints: {
                reindex: this.host.buildReindexHint(codebasePath),
            },
        };
    }

    public buildMissingLocalCollectionCallGraphPayload(
        codebasePath: string,
        context: CallGraphContext,
        collectionName?: string,
    ): CallGraphResponseEnvelope {
        return {
            status: "not_indexed",
            supported: false,
            reason: "not_indexed",
            path: context.path,
            codebaseRoot: codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            message: this.buildMissingLocalCollectionMessage(codebasePath, context.path, collectionName),
            hints: {
                reindex: this.host.buildReindexHint(codebasePath),
            },
        };
    }

    public async prepareTrackedRootForRead(
        absolutePath: string,
        accessMode: "semantic" | "navigation" = "semantic",
        onPhase?: (phase: ReadinessPhase, durationMs: number) => void,
    ): Promise<TrackedRootReadinessState> {
        const { searchableRoot, indexingRoot } = this.measurePhase(
            "tracked_root_resolution",
            () => ({
                searchableRoot: this.resolveTrackedRoot(absolutePath, ["indexed"]),
                indexingRoot: this.resolveTrackedRoot(absolutePath, ["indexing"]),
            }),
            onPhase,
        );

        if (!searchableRoot && indexingRoot) {
            const operation = this.host.getIndexingOperation?.(indexingRoot.path);
            const searchableGenerationAvailable =
                this.host.hasSearchableGeneration?.(indexingRoot.path) ?? false;
            let searchableRead: Extract<TrackedRootReadinessState, { state: "ready" }> | undefined;
            if (searchableGenerationAvailable && operation?.action === "sync") {
                const evaluated = await this.evaluateRootReadiness(indexingRoot, accessMode, onPhase);
                if (evaluated.state === "ready") {
                    searchableRead = evaluated;
                }
            }
            return {
                state: "indexing",
                codebasePath: indexingRoot.path,
                ...(operation ? { operation } : {}),
                searchableGenerationAvailable,
                ...(searchableRead ? { searchableRead } : {}),
            };
        }

        if (!searchableRoot) {
            return {
                state: "not_indexed",
            };
        }

        return this.evaluateRootReadiness(searchableRoot, accessMode, onPhase);
    }

    private async scheduleAutomaticReindex(
        codebasePath: string,
        reason: AutomaticReindexReason,
    ): Promise<Extract<TrackedRootReadinessState, { state: "indexing" }> | null> {
        if (!this.host.requestAutomaticReindex) return null;
        try {
            const scheduled = await this.host.requestAutomaticReindex(codebasePath, reason);
            if (scheduled.outcome !== "started" && scheduled.outcome !== "coalesced") {
                return null;
            }
            const operation = this.host.getIndexingOperation?.(codebasePath);
            return {
                state: "indexing",
                codebasePath,
                ...(operation ? { operation } : {}),
                searchableGenerationAvailable: this.host.hasSearchableGeneration?.(codebasePath) ?? false,
            };
        } catch {
            return null;
        }
    }

    private async evaluateRootReadiness(
        targetRoot: TrackedRootEntry,
        accessMode: "semantic" | "navigation",
        onPhase?: (phase: ReadinessPhase, durationMs: number) => void,
    ): Promise<TrackedRootReadinessState> {
        const effectiveRoot = targetRoot.path;
        const navigationAuthorityMode: Extract<
            TrackedRootReadinessState,
            { state: "ready" }
        >["navigationAuthorityMode"] = "canonical_v4";

        const completionProof = await this.measureAsyncPhase(
            "completion_proof",
            () => this.host.validateCompletionProof(effectiveRoot),
            onPhase,
        );
        if (completionProof.outcome === "policy_incompatible") {
            if (completionProof.reason === "runtime_policy_incompatible") {
                const indexing = await this.scheduleAutomaticReindex(
                    effectiveRoot,
                    "runtime_policy_incompatible",
                );
                if (indexing) return indexing;
            }
            return {
                state: "requires_reindex",
                codebasePath: effectiveRoot,
                message: "The accepted index policy is incompatible with the repository's current runtime policy inputs.",
            };
        }
        if (completionProof.outcome === "stale_local") {
            if (completionProof.reason === "requires_reindex") {
                const indexing = await this.scheduleAutomaticReindex(effectiveRoot, "requires_reindex");
                if (indexing) return indexing;
                return {
                    state: "requires_reindex",
                    codebasePath: effectiveRoot,
                    message: "The current Publication requires a fresh reindex for this runtime.",
                };
            }
            return {
                state: "stale_local",
                codebasePath: effectiveRoot,
                reason: completionProof.reason || "missing_publication",
            };
        }

        if (
            completionProof.outcome !== "valid"
            || !completionProof.publication
            || !completionProof.navigationStatus
        ) {
            return {
                state: "stale_local",
                codebasePath: effectiveRoot,
                reason: completionProof.reason ?? "probe_failed",
            };
        }

        if (
            accessMode === "navigation"
            && (completionProof.navigationStatus === "missing"
                || completionProof.navigationStatus === "incompatible")
        ) {
            const indexing = await this.scheduleAutomaticReindex(
                effectiveRoot,
                "navigation_reindex_required",
            );
            if (indexing) return indexing;
        }

        const collectionName = completionProof.publication.publication.vector.collectionName;
        const collectionState = await this.measureAsyncPhase(
            "collection_probe",
            () => this.host.probeLocalSearchCollectionState(effectiveRoot),
            onPhase,
        );
        if (collectionState.state === "missing") {
            const indexing = await this.scheduleAutomaticReindex(
                effectiveRoot,
                "missing_collection",
            );
            if (indexing) return indexing;
            return {
                state: "missing_collection",
                codebasePath: effectiveRoot,
                collectionName: collectionState.collectionName ?? collectionName,
            };
        }

        return {
            state: "ready",
            root: targetRoot,
            navigationAuthorityMode,
            publication: completionProof.publication,
            navigationStatus: completionProof.navigationStatus,
        };
    }
}
