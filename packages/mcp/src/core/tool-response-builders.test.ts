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

test("manage response explains unknown preflight without changing its machine-readable shape", () => {
    const envelope = builders.buildManageResponseEnvelope("reindex", "/repo", "ok", "Started background indexing.", {
        preflight: {
            outcome: "unknown", confidence: "low", warnings: ["REINDEX_PREFLIGHT_UNKNOWN"],
            explanation: "Git reports no working-tree changes.",
        },
    });
    assert.equal(envelope.message, "Started background indexing.");
    assert.equal(envelope.humanText, "Started background indexing.\nPreflight: Git reports no working-tree changes.");
    assert.deepEqual(envelope.preflight, { outcome: "unknown", confidence: "low", probeFailed: false });
});

test("not-ready search payload tells agents to keep working instead of sleeping or polling", () => {
    const hostFor = (autoIndexing: boolean) => ({
        buildManageIndexRecommendedAction: (_action: string, _codebasePath: string, rationale: string) => ({
            tool: "manage_index",
            args: { action: "status", path: "/repo" },
            reason: rationale,
        }),
        buildStatusHint: () => ({ tool: "manage_index", args: { action: "status", path: "/repo" } }),
        buildIndexingMetadata: () => ({ progressPct: null, lastUpdated: null, phase: null, autoIndexing }),
    } as unknown as ToolResponseBuildersHost);
    const searchContext = {
        path: "/repo",
        query: "owner",
        scope: "runtime" as const,
        groupBy: "symbol" as const,
        resultMode: "grouped" as const,
        limit: 5,
    };

    for (const autoIndexing of [false, true]) {
        const builders = new ToolResponseBuilders(hostFor(autoIndexing));
        const envelope = builders.buildNotReadySearchPayload("/repo", searchContext);
        assert.equal(envelope.status, "not_ready");
        assert.equal(envelope.reason, "indexing");
        assert.equal(envelope.retryAfterMs, DEFAULT_MANAGE_RETRY_AFTER_MS);
        const message = envelope.message ?? "";
        assert.match(message, autoIndexing ? /auto-indexing/ : /currently indexing/);
        assert.match(message, /Do not sleep or poll in a loop/);
        assert.match(message, /manage_index status/);
        assert.match(message, /read entry files \(for example with read_file\)/);
        assert.match(message, /search with rg\/grep/);
        assert.match(message, new RegExp(`retry search_codebase after ${DEFAULT_MANAGE_RETRY_AFTER_MS}ms`));
        assert.match(envelope.recommendedNextAction?.reason ?? "", /Do not sleep or poll in a loop/);
        assert.match(envelope.recommendedNextAction?.reason ?? "", /read entry files \(for example with read_file\)/);
        assert.match(envelope.recommendedNextAction?.reason ?? "", /search with rg\/grep/);
        assert.match(envelope.recommendedNextAction?.reason ?? "", new RegExp(`retry search_codebase after ${DEFAULT_MANAGE_RETRY_AFTER_MS}ms`));
    }
});

test("not-ready search payload includes progress and phase details when available", () => {
    const builders = new ToolResponseBuilders({
        buildManageIndexRecommendedAction: (_action: string, _codebasePath: string, rationale: string) => ({
            tool: "manage_index",
            args: { action: "status", path: "/repo" },
            reason: rationale,
        }),
        buildStatusHint: () => ({ tool: "manage_index", args: { action: "status", path: "/repo" } }),
        buildIndexingMetadata: () => ({
            progressPct: 42,
            lastUpdated: "2026-11-24T00:00:00.000Z",
            phase: "embedding",
            autoIndexing: true,
        }),
    } as unknown as ToolResponseBuildersHost);

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
    assert.match(envelope.message ?? "", /42% complete, phase: embedding/);
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
