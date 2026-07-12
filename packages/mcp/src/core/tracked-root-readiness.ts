import { compareContractStrings, type ProvenGenerationReceipt } from "@zokizuan/satori-core";
import type { CodebaseInfo } from "../config.js";
import type { CallGraphDirection, CallGraphSymbolRef } from "./call-graph.js";
import type {
    CompletionProofReason,
    CompletionProofValidationResult,
} from "./completion-proof.js";
import type { ManageIndexAction } from "./manage-types.js";
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

type CodebaseStatus = CodebaseInfo["status"];

type TrackedCodebaseInfo = Record<string, unknown> & {
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

export type TrackedRootReadinessState =
    | {
        state: "ready";
        root: TrackedRootEntry;
        proofDebugHint?: CompletionProbeDebugHint;
        generationReceipt?: ProvenGenerationReceipt;
        navigationStatus?: CompletionProofValidationResult['navigationStatus'];
        preparedObservation?: string;
    }
    | { state: "requires_reindex"; codebasePath: string; message?: string }
    | { state: "indexing"; codebasePath: string }
    | { state: "index_failed"; codebasePath: string; info: TrackedCodebaseInfo }
    | { state: "not_indexed" }
    | { state: "stale_local"; codebasePath: string; reason: CompletionProofReason }
    | { state: "missing_collection"; codebasePath: string; collectionName?: string; proofDebugHint?: CompletionProbeDebugHint };

export type TrackedRootReadinessHost = {
    onReadinessPhase?(phase: ReadinessPhase, durationMs: number): void;
    refreshSnapshotStateFromDisk(): void;
    isPathWithinCodebase(targetPath: string, rootPath: string): boolean;
    getTrackedRootEntryForPath(codebasePath: string): TrackedRootEntry | null;
    getMatchingBlockedRoot(absolutePath: string): { path: string; message?: string } | null;
    getSnapshotAllCodebases(): Array<{ path: string; info: CodebaseInfo }>;
    getSnapshotIndexedCodebases(): string[];
    getSnapshotIndexingCodebases(): string[];
    getSnapshotCodebaseInfo(codebasePath: string): TrackedCodebaseInfo | undefined;
    getSnapshotCodebaseStatus(codebasePath: string): CodebaseStatus | "not_found";
    enforceFingerprintGate(codebasePath: string): { blockedResponse?: unknown; message?: string; reason?: string };
    validateCompletionProof(codebasePath: string): Promise<CompletionProofValidationResult>;
    probeLocalSearchCollectionState(codebasePath: string): Promise<{
        state: "ready" | "missing" | "unknown";
        collectionName?: string;
    }>;
    buildCreateHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildStatusHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildManageIndexRecommendedAction(action: ManageIndexAction, codebasePath: string, rationale: string): SearchRecommendedNextAction;
    buildStaleLocalMessage(codebasePath: string, requestedPath: string, reason: CompletionProofReason): string;
};

export type ReadinessPhase =
    | "snapshot_reload"
    | "tracked_root_resolution"
    | "fingerprint_gate"
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

    private resolveTrackedRoot(
        absolutePath: string,
        statuses: CodebaseStatus[],
    ): TrackedRootEntry | null {
        const statusSet = new Set(statuses);
        const allEntries = this.host.getSnapshotAllCodebases();

        const mergedByPath = new Map<string, TrackedRootEntry>();
        for (const entry of allEntries) {
            if (!entry || typeof entry.path !== "string" || !entry.info) {
                continue;
            }
            mergedByPath.set(entry.path, { path: entry.path, info: entry.info as unknown as TrackedCodebaseInfo });
        }

        for (const codebasePath of this.host.getSnapshotIndexedCodebases()) {
            if (!mergedByPath.has(codebasePath)) {
                mergedByPath.set(codebasePath, { path: codebasePath, info: { status: "indexed", lastUpdated: new Date(0).toISOString() } });
            }
        }

        for (const codebasePath of this.host.getSnapshotIndexingCodebases()) {
            if (!mergedByPath.has(codebasePath)) {
                mergedByPath.set(codebasePath, { path: codebasePath, info: { status: "indexing", lastUpdated: new Date(0).toISOString() } });
            }
        }

        const directEntry = this.host.getTrackedRootEntryForPath(absolutePath);
        if (directEntry && !mergedByPath.has(directEntry.path)) {
            mergedByPath.set(directEntry.path, directEntry);
        }

        const matches = Array.from(mergedByPath.values())
            .filter((entry) => statusSet.has(entry.info.status) && this.host.isPathWithinCodebase(absolutePath, entry.path))
            .sort((a, b) => b.path.length - a.path.length || compareContractStrings(a.path, b.path));
        if (matches.length === 0) {
            return null;
        }
        return matches[0];
    }

    public buildMissingLocalCollectionMessage(codebasePath: string, requestedPath: string, collectionName?: string): string {
        const requestedPathDetail = requestedPath !== codebasePath
            ? ` Requested path: '${requestedPath}'.`
            : "";
        const collectionDetail = collectionName
            ? ` Vector collection is missing from the configured vector backend ('${collectionName}').`
            : " Vector collection is missing from the configured vector backend.";
        return `Codebase '${codebasePath}' has stale local index metadata.${collectionDetail}${requestedPathDetail} Read paths fail closed and will not rebuild implicitly. Run manage_index with {"action":"create","path":"${codebasePath}"} to restore local readiness.`;
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
            freshnessDecision: null,
            message: this.buildMissingLocalCollectionMessage(codebasePath, searchContext.path, collectionName),
            recommendedNextAction: this.host.buildManageIndexRecommendedAction(
                "create",
                codebasePath,
                "Restore index readiness because local metadata points at a missing configured vector backend collection.",
            ),
            hints: {
                create: this.host.buildCreateHint(codebasePath),
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
            freshnessDecision: null,
            message: this.buildIndexFailedMessage(codebasePath, searchContext.path, info),
            indexingFailure: this.buildIndexingFailureMetadata(info),
            recommendedNextAction: this.host.buildManageIndexRecommendedAction(
                "create",
                codebasePath,
                "Restart indexing because the previous attempt failed before completion marker proof.",
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
                create: this.host.buildCreateHint(codebasePath),
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
                create: this.host.buildCreateHint(codebasePath),
            },
        };
    }

    public async prepareTrackedRootForRead(
        absolutePath: string,
        accessMode: "semantic" | "navigation" = "semantic",
        onPhase?: (phase: ReadinessPhase, durationMs: number) => void,
    ): Promise<TrackedRootReadinessState> {
        this.measurePhase("snapshot_reload", () => this.host.refreshSnapshotStateFromDisk(), onPhase);

        const { blockedRoot, searchableRoot, indexingRoot, failedRoot } = this.measurePhase(
            "tracked_root_resolution",
            () => ({
                blockedRoot: this.host.getMatchingBlockedRoot(absolutePath),
                searchableRoot: this.resolveTrackedRoot(absolutePath, ["indexed", "sync_completed"]),
                indexingRoot: this.resolveTrackedRoot(absolutePath, ["indexing"]),
                failedRoot: this.resolveTrackedRoot(absolutePath, ["indexfailed"]),
            }),
            onPhase,
        );
        if (blockedRoot) {
            return {
                state: "requires_reindex",
                codebasePath: blockedRoot.path,
                message: blockedRoot.message,
            };
        }

        if (
            failedRoot
            && (!searchableRoot || failedRoot.path.length >= searchableRoot.path.length)
            && (!indexingRoot || failedRoot.path.length >= indexingRoot.path.length)
        ) {
            return {
                state: "index_failed",
                codebasePath: failedRoot.path,
                info: failedRoot.info,
            };
        }

        if (!searchableRoot && indexingRoot) {
            return {
                state: "indexing",
                codebasePath: indexingRoot.path,
            };
        }

        if (!searchableRoot) {
            return {
                state: "not_indexed",
            };
        }

        const effectiveRoot = searchableRoot.path;
        const gateResult = this.measurePhase(
            "fingerprint_gate",
            () => this.host.enforceFingerprintGate(effectiveRoot),
            onPhase,
        );
        if (gateResult.blockedResponse) {
            if (accessMode === "navigation" && gateResult.reason === "fingerprint_mismatch") {
                // Navigation sidecars are source-backed and can still be safe under a runtime-model mismatch.
            } else {
                return {
                    state: "requires_reindex",
                    codebasePath: effectiveRoot,
                    message: gateResult.message,
                };
            }
        }

        const completionProof = await this.measureAsyncPhase(
            "completion_proof",
            () => this.host.validateCompletionProof(effectiveRoot),
            onPhase,
        );
        if (completionProof.outcome === "policy_incompatible") {
            return {
                state: "requires_reindex",
                codebasePath: effectiveRoot,
                message: "The accepted index policy is incompatible with the repository's current runtime policy inputs.",
            };
        }
        if (completionProof.outcome === "fingerprint_mismatch") {
            if (accessMode === "navigation") {
                // Completion proof mismatch blocks semantic/vector search, not source-backed navigation.
            } else {
                return {
                    state: "requires_reindex",
                    codebasePath: effectiveRoot,
                    message: "Completion proof fingerprint does not match the current runtime fingerprint.",
                };
            }
        }

        if (completionProof.outcome === "stale_local") {
            return {
                state: "stale_local",
                codebasePath: effectiveRoot,
                reason: completionProof.reason || "missing_marker_doc",
            };
        }

        const proofDebugHint: CompletionProbeDebugHint | undefined = completionProof.outcome === "probe_failed"
            ? {
                ok: false,
                reason: "probe_failed",
                message: "Completion proof could not be checked, so readiness is based on the local snapshot state.",
                action: "If navigation looks stale or inconsistent, run manage_index status and then reindex only when the response asks for it.",
            }
            : undefined;

        const collectionState = completionProof.outcome === "valid" && completionProof.collectionName
            ? { state: "ready" as const, collectionName: completionProof.collectionName }
            : await this.measureAsyncPhase(
                "collection_probe",
                () => this.host.probeLocalSearchCollectionState(effectiveRoot),
                onPhase,
            );
        if (collectionState.state === "missing") {
            return {
                state: "missing_collection",
                codebasePath: effectiveRoot,
                collectionName: collectionState.collectionName,
                proofDebugHint,
            };
        }

        return {
            state: "ready",
            root: searchableRoot,
            proofDebugHint,
            ...(completionProof.generationReceipt ? { generationReceipt: completionProof.generationReceipt } : {}),
            ...(completionProof.navigationStatus ? { navigationStatus: completionProof.navigationStatus } : {}),
        };
    }
}
