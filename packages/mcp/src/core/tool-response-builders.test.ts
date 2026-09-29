import test from "node:test";
import assert from "node:assert/strict";
import type { RootMutationOperation } from "@satori-code/core/integration";
import { DEFAULT_MANAGE_RETRY_AFTER_MS } from "../config.js";
import type { ToolResponseBuildersHost } from "./tool-response-builders.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";

const operation: RootMutationOperation = {
    id: "operation-7",
    action: "create",
    canonicalRoot: "/repo",
    generation: 7,
    acceptedAt: "2026-07-10T00:00:00.000Z",
    phase: "scanning",
    updatedAt: "2026-07-10T00:00:01.000Z",
};

const builders = new ToolResponseBuilders({} as ConstructorParameters<typeof ToolResponseBuilders>[0]);

test("not-ready search payload carries the deterministic indexing retry hint", () => {
    const host = {
        buildManageIndexRecommendedAction: () => ({
            tool: "manage_index",
            args: { action: "status", path: "/repo" },
            reason: "Check indexing progress before retrying search.",
        }),
        buildStatusHint: () => ({ tool: "manage_index", args: { action: "status", path: "/repo" } }),
        buildIndexingMetadata: () => ({ progressPct: null, lastUpdated: null, phase: null }),
    } as unknown as ToolResponseBuildersHost;
    const builders = new ToolResponseBuilders(host);
    const envelope = builders.buildNotReadySearchPayload("/repo", {
        path: "/repo",
        query: "owner",
        scope: "runtime",
        groupBy: "symbol",
        resultMode: "grouped",
        limit: 5,
    });
    assert.equal(envelope.status, "not_ready");
    assert.equal(envelope.reason, "indexing");
    assert.equal(envelope.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
});

test("manage response includes the supplied process-lifetime mutation operation", () => {
    const envelope = builders.buildManageResponseEnvelope("status", "/repo", "ok", "ready", { operation });

    assert.equal(envelope.action, "status");
    assert.deepEqual(envelope.operation, operation);
    assert.equal(envelope.operation?.action, "create");
});

test("manage response omits operation when no process-lifetime operation exists", () => {
    const envelope = builders.buildManageResponseEnvelope("create", "/repo", "blocked", "busy");

    assert.equal("operation" in envelope, false);
});

test("manage sync response includes structured change evidence only for sync", () => {
    const syncStats = { added: 1, removed: 2, modified: 3 };
    const sync = builders.buildManageResponseEnvelope("sync", "/repo", "ok", "done", { syncStats });
    assert.deepEqual(sync.syncStats, syncStats);

    const status = builders.buildManageResponseEnvelope("status", "/repo", "ok", "ready", { syncStats });
    assert.equal(status.syncStats, undefined);
});

test("manage status response preserves additive language capability evidence", () => {
    const languageCapabilities = {
        basis: "language_declarations_and_navigation_sidecars" as const,
        registryEvidence: "compatible" as const,
        relationshipEvidence: "missing" as const,
        languages: [],
    };
    const envelope = builders.buildManageResponseEnvelope("status", "/repo", "ok", "ready", {
        languageCapabilities,
    });

    assert.deepEqual(envelope.languageCapabilities, languageCapabilities);
});

test("manage status response echoes the selected detail projection", () => {
    const builders = new ToolResponseBuilders({} as never);
    const envelope = builders.buildManageResponseEnvelope(
        "status",
        "/repo",
        "ok",
        "indexed",
        { detail: "diagnostics" },
    );

    assert.equal(envelope.detail, "diagnostics");
});
