import * as fs from "fs";
import * as path from "path";
import { DEFAULT_MANAGE_RETRY_AFTER_MS } from "../config.js";
import type { TrackedRootIndexingOperation } from "./tracked-root-readiness.js";
import { requireAbsoluteFilesystemPath, trackCodebasePath } from "../utils.js";
import type { CompletionProofReason } from "./completion-proof.js";
import type {
    SearchRecommendedNextAction,
    SearchReadinessInvalidationReason,
    SearchRequestInput,
    SearchResponseEnvelope,
} from "./search-types.js";
import { SEARCH_RESPONSE_FORMAT_VERSION } from "./search-types.js";
import type { FreshnessDecision } from "./sync.js";
import { WARNING_CODES } from "./warnings.js";
import type {
    CompletionProbeDebugHint,
    TrackedRootReadiness,
    TrackedRootEntry,
    TrackedRootReadinessState,
} from "./tracked-root-readiness.js";
import type { ProvenGenerationReceipt, ProvenVectorGenerationReceipt } from "@zokizuan/satori-core";

type SearchFrontDoorContext = Pick<
    SearchRequestInput,
    "path" | "query" | "scope" | "groupBy" | "resultMode" | "limit"
>;

type SearchFrontDoorSearchContext = Omit<SearchFrontDoorContext, "path"> & { path: string };

export type SearchFrontDoorReady = {
    kind: "ready";
    absolutePath: string;
    effectiveRoot: string;
    searchableRoot: TrackedRootEntry;
    freshnessDecision: FreshnessDecision;
    partialIndexSearchWarnings: string[];
    proofDebugHint?: CompletionProbeDebugHint;
    vectorReceipt?: ProvenVectorGenerationReceipt;
    generationReceipt?: ProvenGenerationReceipt;
    navigationStatus?: "valid" | "not_bound" | "missing" | "incompatible" | "corrupt" | "unverified";
    preparedObservation?: string;
};

export type SearchFrontDoorBlocked = {
    kind: "blocked";
    payload: SearchResponseEnvelope;
    isError?: boolean;
};

export type SearchFrontDoorOutcome = SearchFrontDoorReady | SearchFrontDoorBlocked;

export type SearchFrontDoorHost = {
    trackedRootReadiness: Pick<
        TrackedRootReadiness,
        "buildIndexFailedSearchPayload" | "buildMissingLocalCollectionSearchPayload"
    >;
    prepareInitialTrackedRootRead: (absolutePath: string) => Promise<TrackedRootReadinessState>;
    waitForSearchableSync?: (codebasePath: string, timeoutMs: number) => Promise<boolean>;
    preparePostFreshnessTrackedRootRead: (
        absolutePath: string,
        reason: Extract<
            SearchReadinessInvalidationReason,
            "freshness_changed" | "observation_unavailable" | "observation_changed"
        >,
    ) => Promise<TrackedRootReadinessState>;
    getPreparedReadObservation?: (canonicalRoot: string) => string | null;
    ensureSearchFreshness: (
        effectiveRoot: string,
        preparedRead?: Extract<TrackedRootReadinessState, { state: 'ready' }>,
    ) => Promise<FreshnessDecision>;
    noteFreshnessMode: (mode: FreshnessDecision["mode"]) => void;
    buildInvalidSearchRequestPayload: (
        searchContext: SearchFrontDoorSearchContext,
        message: string,
        status?: SearchResponseEnvelope["status"],
        reason?: SearchResponseEnvelope["reason"],
    ) => SearchResponseEnvelope;
    buildRequiresReindexPayload: (
        codebasePath: string,
        detail: string | undefined,
        searchContext: SearchFrontDoorSearchContext,
    ) => SearchResponseEnvelope;
    buildNotReadySearchPayload: (
        codebasePath: string,
        searchContext: SearchFrontDoorSearchContext,
    ) => SearchResponseEnvelope;
    buildFreshnessBlockedSearchPayload: (
        codebasePath: string,
        freshnessDecision: FreshnessDecision,
        searchContext: SearchFrontDoorSearchContext,
    ) => SearchResponseEnvelope | null;
    getIndexingOperation?: (codebasePath: string) => TrackedRootIndexingOperation | undefined;
    buildManageIndexRecommendedAction: (
        action: "create" | "reindex" | "sync" | "status" | "repair",
        codebasePath: string,
        rationale: string,
    ) => SearchRecommendedNextAction;
    buildCreateHint: (codebasePath: string) => { tool: string; args: { action: string; path: string } };
    buildSyncHint: (codebasePath: string) => { tool: string; args: { action: string; path: string } };
    buildRepairHint: (codebasePath: string) => { tool: string; args: { action: string; path: string } };
    buildStaleLocalHint: (codebasePath: string, reason: CompletionProofReason) => Record<string, unknown>;
    buildStaleLocalMessage: (codebasePath: string, requestedPath: string, reason: CompletionProofReason) => string;
    canSyncStaleLocal: (codebasePath: string, reason: CompletionProofReason) => boolean;
    withProofDebugHint: <T extends object>(payload: T, proofDebugHint?: CompletionProbeDebugHint) => T;
    isPartialIndexNavigationUnavailable: (info: unknown) => boolean;
    partialIndexWarnings: readonly string[];
};

function buildSearchContext(input: SearchFrontDoorContext, absolutePath: string): SearchFrontDoorSearchContext {
    return {
        path: absolutePath,
        query: input.query,
        scope: input.scope,
        groupBy: input.groupBy,
        resultMode: input.resultMode,
        limit: input.limit,
    };
}

function buildPartialIndexWarnings(host: SearchFrontDoorHost, root: TrackedRootEntry): string[] {
    return host.isPartialIndexNavigationUnavailable(root.info)
        ? [...host.partialIndexWarnings]
        : [];
}

function buildReadinessWarnings(
    host: SearchFrontDoorHost,
    state: Extract<TrackedRootReadinessState, { state: "ready" }>,
): string[] {
    return [
        ...buildPartialIndexWarnings(host, state.root),
        ...(state.navigationStatus !== "valid" && state.navigationStatus !== "not_bound"
            ? ["NAVIGATION_REPAIR_REQUIRED"]
            : []),
    ];
}

function freshnessDecisionPreservesAuthority(decision: FreshnessDecision): boolean {
    return decision.mode === 'skipped_recent'
        || decision.mode === 'skipped_source_unchanged';
}

function buildBlockedReadinessPayload(
    state: TrackedRootReadinessState,
    searchContext: SearchFrontDoorSearchContext,
    host: SearchFrontDoorHost,
): SearchResponseEnvelope | null {
    if (state.state === "ready") {
        return null;
    }

    if (state.state === "requires_reindex") {
        return host.buildRequiresReindexPayload(state.codebasePath, state.message, searchContext);
    }

    if (state.state === "indexing") {
        const payload = host.buildNotReadySearchPayload(state.codebasePath, searchContext);
        return {
            ...payload,
            retryAfterMs: DEFAULT_MANAGE_RETRY_AFTER_MS,
            ...(state.operation ? { indexingOperation: { ...state.operation } } : {}),
        };
    }

    if (state.state === "index_failed") {
        return host.trackedRootReadiness.buildIndexFailedSearchPayload(state.codebasePath, searchContext, state.info);
    }

    if (state.state === "not_indexed") {
        return {
            formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
            status: "not_indexed",
            reason: "not_indexed",
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            limit: searchContext.limit,
            resultMode: searchContext.resultMode,
            message: `Codebase '${searchContext.path}' (or any parent) is not indexed.`,
            recommendedNextAction: host.buildManageIndexRecommendedAction(
                "create",
                searchContext.path,
                "Create an index for this codebase before retrying search.",
            ),
            hints: {
                create: host.buildCreateHint(searchContext.path),
            },
            results: [],
        } as SearchResponseEnvelope;
    }

    if (state.state === "stale_local") {
        const preferSync = host.canSyncStaleLocal(state.codebasePath, state.reason);
        const preferRepair = !preferSync && state.reason === "missing_marker_doc";
        const action = preferSync ? "sync" : preferRepair ? "repair" : "create";
        return {
            formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
            status: "not_indexed",
            reason: "not_indexed",
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            limit: searchContext.limit,
            resultMode: searchContext.resultMode,
            message: host.buildStaleLocalMessage(state.codebasePath, searchContext.path, state.reason),
            recommendedNextAction: host.buildManageIndexRecommendedAction(
                action,
                state.codebasePath,
                preferSync
                    ? "Run incremental sync; the local snapshot proves the committed collection and can restore the missing completion marker."
                    : preferRepair
                    ? "Repair local readiness because completion marker proof is missing and no syncable snapshot collection is available."
                    : "Create a fresh index because local readiness metadata is stale.",
            ),
            hints: {
                ...(preferSync ? { sync: host.buildSyncHint(state.codebasePath) } : {}),
                ...(preferRepair ? { repair: host.buildRepairHint(state.codebasePath) } : {}),
                create: host.buildCreateHint(state.codebasePath),
                staleLocal: host.buildStaleLocalHint(state.codebasePath, state.reason),
            },
            results: [],
        } as SearchResponseEnvelope;
    }

    return host.withProofDebugHint(
        host.trackedRootReadiness.buildMissingLocalCollectionSearchPayload(
            state.codebasePath,
            searchContext,
            state.collectionName,
        ),
        state.proofDebugHint,
    );
}

export async function runSearchFrontDoor(
    input: SearchFrontDoorContext,
    host: SearchFrontDoorHost,
): Promise<SearchFrontDoorOutcome> {
    const absolutePathResult = requireAbsoluteFilesystemPath(input.path, "path");
    if (!absolutePathResult.ok) {
        const searchContext = buildSearchContext(input, absolutePathResult.path);
        return {
            kind: "blocked",
            payload: host.buildInvalidSearchRequestPayload(
                searchContext,
                absolutePathResult.message,
                "not_indexed",
                "not_indexed",
            ),
            isError: true,
        };
    }
    const absolutePath = absolutePathResult.absolutePath;
    const searchContext = buildSearchContext(input, absolutePath);

    if (!fs.existsSync(absolutePath)) {
        return {
            kind: "blocked",
            payload: host.buildInvalidSearchRequestPayload(
                searchContext,
                `Path '${absolutePath}' does not exist. search_codebase requires an existing directory root or subdirectory.`,
                "not_indexed",
                "not_indexed",
            ),
            isError: true,
        };
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) {
        return {
            kind: "blocked",
            payload: host.buildInvalidSearchRequestPayload(
                searchContext,
                `Path '${absolutePath}' is not a directory. search_codebase requires a directory root or subdirectory.`,
                "not_indexed",
                "not_indexed",
            ),
            isError: true,
        };
    }

    trackCodebasePath(absolutePath);

    let trackedRootState = await host.prepareInitialTrackedRootRead(absolutePath);
    let activeSyncServingPrevious = false;
    let servedCollection: string | undefined;
    let servedRunId: string | undefined;
    let servedGenerationId: string | undefined;
    let pendingSyncOperation: { action: string; generation: number } | undefined;

    if (
        trackedRootState.state === "indexing"
        && trackedRootState.operation?.action === "sync"
        && trackedRootState.searchableGenerationAvailable
        && trackedRootState.searchableRead
        && trackedRootState.searchableRead.vectorReceipt !== undefined
    ) {
        // Stale-while-sync: serve the proven readable generation immediately without blocking
        activeSyncServingPrevious = true;
        const readable = trackedRootState.searchableRead;
        servedCollection = readable.vectorReceipt?.collectionName;
        servedRunId = readable.vectorReceipt?.marker?.runId ?? readable.generationReceipt?.marker?.runId;
        servedGenerationId = readable.sourceBackedNavigationBinding?.generationId
            ?? (readable.generationReceipt?.navigation && typeof readable.generationReceipt.navigation === 'object' && 'generationId' in readable.generationReceipt.navigation
                ? (readable.generationReceipt.navigation as { generationId?: string }).generationId
                : undefined);
        if (trackedRootState.operation) {
            pendingSyncOperation = {
                action: trackedRootState.operation.action,
                generation: trackedRootState.operation.generation,
            };
        }
        trackedRootState = trackedRootState.searchableRead;
    } else if (
        trackedRootState.state === "indexing"
        && trackedRootState.operation?.action === "sync"
        && trackedRootState.searchableGenerationAvailable
        && host.waitForSearchableSync
    ) {
        const synced = await host.waitForSearchableSync(
            trackedRootState.codebasePath,
            DEFAULT_MANAGE_RETRY_AFTER_MS,
        );
        if (synced) {
            trackedRootState = await host.prepareInitialTrackedRootRead(absolutePath);
        }
    }
    const canSyncInitialStaleLocal = trackedRootState.state === "stale_local"
        && host.canSyncStaleLocal(trackedRootState.codebasePath, trackedRootState.reason);
    if (!canSyncInitialStaleLocal) {
        const blockedReadinessPayload = buildBlockedReadinessPayload(trackedRootState, searchContext, host);
        if (blockedReadinessPayload) {
            return {
                kind: "blocked",
                payload: blockedReadinessPayload,
            };
        }
    }
    if (trackedRootState.state !== "ready" && !canSyncInitialStaleLocal) {
        throw new Error(`Unexpected non-ready tracked root state after readiness gating: ${trackedRootState.state}`);
    }

    let searchableRoot = trackedRootState.state === "ready" ? trackedRootState.root : null;
    let effectiveRoot = searchableRoot?.path || (trackedRootState.state === "stale_local" ? trackedRootState.codebasePath : absolutePath);
    let proofDebugHint = trackedRootState.state === "ready" ? trackedRootState.proofDebugHint : undefined;
    let partialIndexSearchWarnings = trackedRootState.state === "ready"
        ? buildReadinessWarnings(host, trackedRootState)
        : [];
    let vectorReceipt = trackedRootState.state === "ready" ? trackedRootState.vectorReceipt : undefined;
    let generationReceipt = trackedRootState.state === "ready" ? trackedRootState.generationReceipt : undefined;
    let navigationStatus = trackedRootState.state === "ready" ? trackedRootState.navigationStatus : undefined;

    for (let freshnessAttempt = 0; freshnessAttempt < 2; freshnessAttempt += 1) {
        const freshnessRoot = effectiveRoot;
        const observationBeforeFreshness = host.getPreparedReadObservation?.(freshnessRoot) ?? null;
        const freshnessDecision: FreshnessDecision = activeSyncServingPrevious
            ? {
                mode: "served_previous_generation",
                checkedAt: new Date().toISOString(),
                thresholdMs: 0,
                ...(servedCollection ? { servedCollection } : {}),
                ...(servedRunId ? { servedRunId } : {}),
                ...(servedGenerationId ? { servedGenerationId } : {}),
                ...(pendingSyncOperation ? { pendingOperation: pendingSyncOperation } : {}),
            }
            : await host.ensureSearchFreshness(
                freshnessRoot,
                trackedRootState.state === 'ready' ? trackedRootState : undefined,
            );
        host.noteFreshnessMode(freshnessDecision.mode);

        const observationAfterFreshness = host.getPreparedReadObservation?.(freshnessRoot) ?? null;
        const canReuseInitialReadiness = (freshnessAttempt === 0
            && trackedRootState.state === "ready"
            && freshnessDecisionPreservesAuthority(freshnessDecision)
            && observationBeforeFreshness !== null
            && trackedRootState.preparedObservation === observationBeforeFreshness
            && observationBeforeFreshness === observationAfterFreshness)
            || (activeSyncServingPrevious && trackedRootState.state === "ready");
        const postFreshnessRootState = canReuseInitialReadiness
            ? trackedRootState
            : await host.preparePostFreshnessTrackedRootRead(
                absolutePath,
                observationBeforeFreshness === null
                    ? "observation_unavailable"
                    : observationBeforeFreshness !== observationAfterFreshness
                        ? "observation_changed"
                        : "freshness_changed",
            );
        const readinessBlockedPayload = buildBlockedReadinessPayload(postFreshnessRootState, searchContext, host);
        if (readinessBlockedPayload) {
            return { kind: "blocked", payload: readinessBlockedPayload };
        }
        if (postFreshnessRootState.state !== "ready") {
            throw new Error(`Unexpected non-ready tracked root state after freshness gating: ${postFreshnessRootState.state}`);
        }

        const observedRoot = postFreshnessRootState.root.path || absolutePath;
        if (path.resolve(observedRoot) !== path.resolve(freshnessRoot)) {
            if (freshnessAttempt === 1) {
                throw new Error("Tracked root identity changed repeatedly during search freshness validation.");
            }
            searchableRoot = postFreshnessRootState.root;
            effectiveRoot = observedRoot;
            proofDebugHint = postFreshnessRootState.proofDebugHint;
            vectorReceipt = postFreshnessRootState.vectorReceipt;
            generationReceipt = postFreshnessRootState.generationReceipt;
            navigationStatus = postFreshnessRootState.navigationStatus;
            partialIndexSearchWarnings = buildReadinessWarnings(host, postFreshnessRootState);
            continue;
        }

        const freshnessBlockedPayload = host.buildFreshnessBlockedSearchPayload(
            freshnessRoot,
            freshnessDecision,
            searchContext,
        );
        if (freshnessBlockedPayload) {
            if (
                freshnessBlockedPayload.status === "not_ready"
                && freshnessBlockedPayload.reason === "indexing"
            ) {
                const operation = host.getIndexingOperation?.(freshnessRoot);
                return {
                    kind: "blocked",
                    payload: {
                        ...freshnessBlockedPayload,
                        retryAfterMs: freshnessBlockedPayload.retryAfterMs
                            ?? DEFAULT_MANAGE_RETRY_AFTER_MS,
                        ...(operation ? { indexingOperation: { ...operation } } : {}),
                    },
                };
            }
            return { kind: "blocked", payload: freshnessBlockedPayload };
        }

        searchableRoot = postFreshnessRootState.root;
        effectiveRoot = observedRoot;
        proofDebugHint = postFreshnessRootState.proofDebugHint;
        vectorReceipt = postFreshnessRootState.vectorReceipt;
        generationReceipt = postFreshnessRootState.generationReceipt;
        navigationStatus = postFreshnessRootState.navigationStatus;
        partialIndexSearchWarnings = buildReadinessWarnings(host, postFreshnessRootState);
        if (freshnessDecision.mode === "skipped_source_checkpoint_unavailable") {
            partialIndexSearchWarnings = [
                ...partialIndexSearchWarnings,
                WARNING_CODES.SOURCE_FRESHNESS_CHECKPOINT_UNAVAILABLE,
            ];
        }
        return {
            kind: "ready",
            absolutePath,
            effectiveRoot,
            searchableRoot,
            freshnessDecision,
            partialIndexSearchWarnings,
            proofDebugHint,
            vectorReceipt,
            generationReceipt,
            navigationStatus,
            preparedObservation: postFreshnessRootState.preparedObservation,
        };
    }

    throw new Error("Tracked root identity changed repeatedly during search freshness validation.");
}
