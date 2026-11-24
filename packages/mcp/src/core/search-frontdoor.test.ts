import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MANAGE_RETRY_AFTER_MS } from "../config.js";
import { runSearchFrontDoor, type SearchFrontDoorHost } from "./search-frontdoor.js";
import { SEARCH_RESPONSE_FORMAT_VERSION, type SearchResponseEnvelope } from "./search-types.js";
import type { FreshnessDecision } from "./sync.js";
import type { TrackedRootReadinessState } from "./tracked-root-readiness.js";

function buildReadyState(codebasePath: string, publicationId = "publication-1", collectionName = "collection-1"): Extract<TrackedRootReadinessState, { state: "ready" }> {
    return {
        state: "ready",
        root: { path: codebasePath, info: { status: "indexed" } },
        navigationStatus: "valid",
        publication: {
            id: publicationId,
            publication: {
                vector: { collectionName },
            },
        } as never,
    };
}

function buildFrontDoorHost(
    codebasePath: string,
    initialState: TrackedRootReadinessState,
): SearchFrontDoorHost {
    return {
        trackedRootReadiness: {
            buildIndexFailedSearchPayload: () => {
                throw new Error("unexpected index_failed state");
            },
            buildMissingLocalCollectionSearchPayload: () => {
                throw new Error("unexpected missing_collection state");
            },
        },
        prepareInitialTrackedRootRead: async () => initialState,
        preparePostFreshnessTrackedRootRead: async () => initialState,
        assessSearchFreshness: async () => ({
            mode: "read_only",
            checkedAt: new Date(0).toISOString(),
            thresholdMs: 5000,
            sourceFreshness: { state: "verified", reason: "watcher_continuity" },
        }) satisfies FreshnessDecision,
        noteFreshnessMode: () => {},
        buildInvalidSearchRequestPayload: () => {
            throw new Error("unexpected invalid request payload");
        },
        buildRequiresReindexPayload: () => {
            throw new Error("unexpected requires_reindex payload");
        },
        buildNotReadySearchPayload: (root, searchContext) => ({
            formatVersion: SEARCH_RESPONSE_FORMAT_VERSION,
            status: "not_ready",
            reason: "indexing",
            retryAfterMs: DEFAULT_MANAGE_RETRY_AFTER_MS,
            codebasePath: root,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            message: `Codebase '${root}' is currently indexing. Do not sleep or poll in a loop (including manage_index status): read entry files (for example with read_file) or search with rg/grep while indexing runs in the background, then retry search_codebase after ${DEFAULT_MANAGE_RETRY_AFTER_MS}ms.`,
            results: [],
        }) as unknown as SearchResponseEnvelope,
        buildFreshnessBlockedSearchPayload: () => null,
        buildManageIndexRecommendedAction: () => {
            throw new Error("unexpected recommended action");
        },
        buildCreateHint: () => ({ tool: "manage_index", args: { action: "create", path: codebasePath } }),
        buildStaleLocalMessage: () => "",
        withProofDebugHint: (payload) => payload,
        isPartialIndexNavigationUnavailable: () => false,
        partialIndexWarnings: [],
    };
}

test("runSearchFrontDoor serves a proven compatible previous Publication during background reindex", async (t) => {
    const codebasePath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-frontdoor-reindex-"));
    t.after(() => fs.rmSync(codebasePath, { recursive: true, force: true }));

    const ready = buildReadyState(codebasePath, "publication-prev", "collection-prev");
    const host = buildFrontDoorHost(codebasePath, {
        state: "indexing",
        codebasePath,
        operation: { action: "reindex", phase: "embedding", generation: 4 },
        searchableGenerationAvailable: true,
        searchableRead: ready,
    });

    const outcome = await runSearchFrontDoor({
        path: codebasePath,
        query: "find owner",
        scope: "runtime",
        groupBy: "symbol",
        resultMode: "grouped",
        limit: 5,
    }, host);

    assert.equal(outcome.kind, "ready");
    if (outcome.kind !== "ready") return;
    assert.equal(outcome.effectiveRoot, codebasePath);
    assert.equal(outcome.publication.id, "publication-prev");
    assert.equal(outcome.freshnessDecision.mode, "served_previous_generation");
    assert.equal(outcome.freshnessDecision.servedPublicationId, "publication-prev");
    assert.equal(outcome.freshnessDecision.servedCollection, "collection-prev");
    assert.deepEqual(outcome.freshnessDecision.pendingOperation, { action: "reindex", generation: 4 });
});

test("runSearchFrontDoor blocks with anti-poll recovery guidance during incompatible reindex and initial create", async (t) => {
    const codebasePath = fs.mkdtempSync(path.join(os.tmpdir(), "satori-frontdoor-block-"));
    t.after(() => fs.rmSync(codebasePath, { recursive: true, force: true }));

    const input = {
        path: codebasePath,
        query: "find owner",
        scope: "runtime" as const,
        groupBy: "symbol" as const,
        resultMode: "grouped" as const,
        limit: 5,
    };

    const incompatibleReindex = await runSearchFrontDoor(input, buildFrontDoorHost(codebasePath, {
        state: "indexing",
        codebasePath,
        operation: { action: "reindex", phase: "vector", generation: 3 },
        searchableGenerationAvailable: true,
    }));
    assert.equal(incompatibleReindex.kind, "blocked");
    if (incompatibleReindex.kind === "blocked") {
        assert.equal(incompatibleReindex.payload.status, "not_ready");
        assert.equal(incompatibleReindex.payload.reason, "indexing");
        assert.equal(incompatibleReindex.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.equal(incompatibleReindex.payload.indexingOperation?.action, "reindex");
        assert.match(incompatibleReindex.payload.message ?? "", /Do not sleep or poll in a loop/);
    }

    const initialCreate = await runSearchFrontDoor(input, buildFrontDoorHost(codebasePath, {
        state: "indexing",
        codebasePath,
        operation: { action: "create", phase: "scanning", generation: 1 },
        searchableGenerationAvailable: false,
    }));
    assert.equal(initialCreate.kind, "blocked");
    if (initialCreate.kind === "blocked") {
        assert.equal(initialCreate.payload.status, "not_ready");
        assert.equal(initialCreate.payload.reason, "indexing");
        assert.equal(initialCreate.payload.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        assert.equal(initialCreate.payload.indexingOperation?.action, "create");
    }
});
