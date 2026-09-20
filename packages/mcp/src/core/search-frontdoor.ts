import * as fs from "fs";
import * as path from "path";
import type { PublicationNavigationStatus, PublicationRef } from "@zokizuan/satori-core";
import { DEFAULT_MANAGE_RETRY_AFTER_MS } from "../config.js";
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
import { buildFreshnessWarningCodes } from "./warnings.js";
import type {
    CompletionProbeDebugHint,
    TrackedRootReadiness,
    TrackedRootEntry,
    TrackedRootIndexingOperation,
    TrackedRootReadinessState,
} from "./tracked-root-readiness.js";

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
    publication: PublicationRef;
    navigationStatus: PublicationNavigationStatus;
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
    preparePostFreshnessTrackedRootRead: (
        absolutePath: string,
        reason: Extract<
            SearchReadinessInvalidationReason,
            "freshness_unchanged" | "freshness_changed" | "observation_unavailable" | "observation_changed"
        >,
    ) => Promise<TrackedRootReadinessState>;
    assessSearchFreshness: (
        effectiveRoot: string,
        preparedRead?: Extract<TrackedRootReadinessState, { state: "ready" }>,
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
        action: "create" | "reindex" | "sync" | "status",
        codebasePath: string,
        rationale: string,
    ) => SearchRecommendedNextAction;
    buildCreateHint: (codebasePath: string) => { tool: string; args: { action: string; path: string } };
    buildStaleLocalMessage: (codebasePath: string, requestedPath: string, reason: CompletionProofReason) => string;
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

function buildReadinessWarnings(
    host: SearchFrontDoorHost,
    state: Extract<TrackedRootReadinessState, { state: "ready" }>,
): string[] {
    return [
        ...(host.isPartialIndexNavigationUnavailable(state.root.info)
            ? [...host.partialIndexWarnings]
            : []),
        ...(state.navigationStatus !== "valid" && state.navigationStatus !== "not_bound"
            ? ["NAVIGATION_REINDEX_REQUIRED"]
            : []),
    ];
}

function buildBlockedReadinessPayload(
    state: TrackedRootReadinessState,
    searchContext: SearchFrontDoorSearchContext,
    host: SearchFrontDoorHost,
): SearchResponseEnvelope | null {
    if (state.state === "ready") return null;
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
            hints: { create: host.buildCreateHint(searchContext.path) },
            results: [],
        } as SearchResponseEnvelope;
    }
    if (state.state === "stale_local") {
        return host.buildRequiresReindexPayload(
            state.codebasePath,
            host.buildStaleLocalMessage(state.codebasePath, searchContext.path, state.reason),
            searchContext,
        );
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

function readyResult(
    state: Extract<TrackedRootReadinessState, { state: "ready" }>,
    absolutePath: string,
    freshnessDecision: FreshnessDecision,
    host: SearchFrontDoorHost,
): SearchFrontDoorReady {
    return {
        kind: "ready",
        absolutePath,
        effectiveRoot: state.root.path,
        searchableRoot: state.root,
        freshnessDecision,
        partialIndexSearchWarnings: [
            ...buildReadinessWarnings(host, state),
            ...buildFreshnessWarningCodes(freshnessDecision),
        ],
        proofDebugHint: state.proofDebugHint,
        publication: state.publication,
        navigationStatus: state.navigationStatus,
    };
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
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
        return {
            kind: "blocked",
            payload: host.buildInvalidSearchRequestPayload(
                searchContext,
                `Path '${absolutePath}' must be an existing directory.`,
                "not_indexed",
                "not_indexed",
            ),
            isError: true,
        };
    }
    trackCodebasePath(absolutePath);

    const servePreviousGeneration = (
        readable: Extract<TrackedRootReadinessState, { state: "ready" }>,
        operation: TrackedRootIndexingOperation | undefined,
    ): SearchFrontDoorReady | null => {
        if (operation?.action !== "sync") return null;
        const freshnessDecision: FreshnessDecision = {
            mode: "served_previous_generation",
            checkedAt: new Date().toISOString(),
            thresholdMs: 0,
            servedCollection: readable.publication.publication.vector.collectionName,
            servedPublicationId: readable.publication.id,
            pendingOperation: {
                action: operation.action,
                generation: operation.generation,
            },
        };
        host.noteFreshnessMode(freshnessDecision.mode);
        return readyResult(readable, absolutePath, freshnessDecision, host);
    };

    let state = await host.prepareInitialTrackedRootRead(absolutePath);
    if (state.state === "ready") {
        const previousGeneration = servePreviousGeneration(
            state,
            host.getIndexingOperation?.(state.root.path),
        );
        if (previousGeneration) return previousGeneration;
    }
    if (
        state.state === "indexing"
        && state.searchableGenerationAvailable
        && state.searchableRead
    ) {
        const previousGeneration = servePreviousGeneration(state.searchableRead, state.operation);
        if (previousGeneration) return previousGeneration;
    }
    const blocked = buildBlockedReadinessPayload(state, searchContext, host);
    if (blocked) return { kind: "blocked", payload: blocked };
    if (state.state !== "ready") throw new Error(`Unexpected readiness state: ${state.state}`);

    const initialRoot = state.root.path;
    const freshnessDecision = await host.assessSearchFreshness(initialRoot, state);
    host.noteFreshnessMode(freshnessDecision.mode);
    const freshnessBlocked = host.buildFreshnessBlockedSearchPayload(initialRoot, freshnessDecision, searchContext);
    if (freshnessBlocked && freshnessDecision.mode !== "skipped_requires_reindex") {
        if (freshnessBlocked.status === "not_ready" && freshnessBlocked.reason === "indexing") {
            const operation = host.getIndexingOperation?.(initialRoot);
            return {
                kind: "blocked",
                payload: {
                    ...freshnessBlocked,
                    retryAfterMs: freshnessBlocked.retryAfterMs ?? DEFAULT_MANAGE_RETRY_AFTER_MS,
                    ...(operation ? { indexingOperation: { ...operation } } : {}),
                },
            };
        }
        return { kind: "blocked", payload: freshnessBlocked };
    }

    const freshnessPreservesPreparedPublication = (
        freshnessDecision.mode === "skipped_recent"
        || freshnessDecision.mode === "skipped_source_unchanged"
        || freshnessDecision.mode === "skipped_source_checkpoint_unavailable"
        || freshnessDecision.mode === "read_only"
    );
    const postFreshness = await host.preparePostFreshnessTrackedRootRead(
        absolutePath,
        freshnessPreservesPreparedPublication ? "freshness_unchanged" : "freshness_changed",
    );
    if (postFreshness.state === "ready") {
        if (path.resolve(postFreshness.root.path) !== path.resolve(initialRoot)) {
            throw new Error("Tracked root identity changed during search freshness validation.");
        }
        const previousGeneration = servePreviousGeneration(
            postFreshness,
            host.getIndexingOperation?.(postFreshness.root.path),
        );
        if (previousGeneration) return previousGeneration;
    }
    if (
        postFreshness.state === "indexing"
        && postFreshness.searchableGenerationAvailable
        && postFreshness.searchableRead
    ) {
        if (path.resolve(postFreshness.searchableRead.root.path) !== path.resolve(initialRoot)) {
            throw new Error("Tracked root identity changed during search freshness validation.");
        }
        const previousGeneration = servePreviousGeneration(
            postFreshness.searchableRead,
            postFreshness.operation,
        );
        if (previousGeneration) return previousGeneration;
    }
    const postBlocked = buildBlockedReadinessPayload(postFreshness, searchContext, host);
    if (postBlocked) return { kind: "blocked", payload: postBlocked };
    if (freshnessBlocked) return { kind: "blocked", payload: freshnessBlocked };
    if (postFreshness.state !== "ready") {
        throw new Error(`Unexpected post-freshness readiness state: ${postFreshness.state}`);
    }
    if (path.resolve(postFreshness.root.path) !== path.resolve(initialRoot)) {
        throw new Error("Tracked root identity changed during search freshness validation.");
    }

    return readyResult(postFreshness, absolutePath, freshnessDecision, host);
}
