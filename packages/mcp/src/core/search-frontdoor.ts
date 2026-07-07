import * as fs from "fs";
import { ensureAbsolutePath, trackCodebasePath } from "../utils.js";
import type { CompletionProofReason } from "./completion-proof.js";
import type {
    SearchRecommendedNextAction,
    SearchRequestInput,
    SearchResponseEnvelope,
} from "./search-types.js";
import type { FreshnessDecision } from "./sync.js";
import type {
    CompletionProbeDebugHint,
    TrackedRootReadiness,
    TrackedRootEntry,
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
    preparePostFreshnessTrackedRootRead: (absolutePath: string) => Promise<TrackedRootReadinessState>;
    ensureSearchFreshness: (effectiveRoot: string) => Promise<FreshnessDecision>;
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
    buildManageIndexRecommendedAction: (
        action: "create" | "reindex" | "sync" | "status" | "repair",
        codebasePath: string,
        rationale: string,
    ) => SearchRecommendedNextAction;
    buildCreateHint: (codebasePath: string) => { tool: string; args: { action: string; path: string } };
    buildRepairHint: (codebasePath: string) => { tool: string; args: { action: string; path: string } };
    buildStaleLocalHint: (codebasePath: string, reason: CompletionProofReason) => Record<string, unknown>;
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

function buildPartialIndexWarnings(host: SearchFrontDoorHost, root: TrackedRootEntry): string[] {
    return host.isPartialIndexNavigationUnavailable(root.info)
        ? [...host.partialIndexWarnings]
        : [];
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
        return host.buildNotReadySearchPayload(state.codebasePath, searchContext);
    }

    if (state.state === "index_failed") {
        return host.trackedRootReadiness.buildIndexFailedSearchPayload(state.codebasePath, searchContext, state.info);
    }

    if (state.state === "not_indexed") {
        return {
            status: "not_indexed",
            reason: "not_indexed",
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            limit: searchContext.limit,
            resultMode: searchContext.resultMode,
            freshnessDecision: null,
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
        const preferRepair = state.reason === "missing_marker_doc";
        return {
            status: "not_indexed",
            reason: "not_indexed",
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            limit: searchContext.limit,
            resultMode: searchContext.resultMode,
            freshnessDecision: null,
            message: host.buildStaleLocalMessage(state.codebasePath, searchContext.path, state.reason),
            recommendedNextAction: host.buildManageIndexRecommendedAction(
                preferRepair ? "repair" : "create",
                state.codebasePath,
                preferRepair
                    ? "Repair local readiness because completion marker proof is missing but vector rows may still be reusable."
                    : "Create a fresh index because local readiness metadata is stale.",
            ),
            hints: {
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
    const absolutePath = ensureAbsolutePath(input.path);
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

    const trackedRootState = await host.prepareInitialTrackedRootRead(absolutePath);
    const blockedReadinessPayload = buildBlockedReadinessPayload(trackedRootState, searchContext, host);
    if (blockedReadinessPayload) {
        return {
            kind: "blocked",
            payload: blockedReadinessPayload,
        };
    }
    if (trackedRootState.state !== "ready") {
        throw new Error(`Unexpected non-ready tracked root state after readiness gating: ${trackedRootState.state}`);
    }

    let searchableRoot = trackedRootState.root;
    let effectiveRoot = searchableRoot.path || absolutePath;
    let proofDebugHint = trackedRootState.proofDebugHint;
    let partialIndexSearchWarnings = buildPartialIndexWarnings(host, searchableRoot);

    const freshnessDecision = await host.ensureSearchFreshness(effectiveRoot);
    host.noteFreshnessMode(freshnessDecision.mode);
    const freshnessBlockedPayload = host.buildFreshnessBlockedSearchPayload(
        effectiveRoot,
        freshnessDecision,
        searchContext,
    );
    if (freshnessBlockedPayload) {
        return {
            kind: "blocked",
            payload: freshnessBlockedPayload,
        };
    }

    const postFreshnessTrackedRootState = await host.preparePostFreshnessTrackedRootRead(absolutePath);
    const postFreshnessBlockedPayload = buildBlockedReadinessPayload(postFreshnessTrackedRootState, searchContext, host);
    if (postFreshnessBlockedPayload) {
        return {
            kind: "blocked",
            payload: postFreshnessBlockedPayload,
        };
    }
    if (postFreshnessTrackedRootState.state !== "ready") {
        throw new Error(`Unexpected non-ready tracked root state after freshness gating: ${postFreshnessTrackedRootState.state}`);
    }

    searchableRoot = postFreshnessTrackedRootState.root;
    effectiveRoot = searchableRoot.path || absolutePath;
    proofDebugHint = postFreshnessTrackedRootState.proofDebugHint;
    partialIndexSearchWarnings = buildPartialIndexWarnings(host, searchableRoot);

    return {
        kind: "ready",
        absolutePath,
        effectiveRoot,
        searchableRoot,
        freshnessDecision,
        partialIndexSearchWarnings,
        proofDebugHint,
    };
}
