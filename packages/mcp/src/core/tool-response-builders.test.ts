import test from "node:test";
import assert from "node:assert/strict";
import type { IndexOperationReceipt } from "../config.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";

const receipt: IndexOperationReceipt = {
    id: "operation-7",
    action: "create",
    canonicalRoot: "/repo",
    generation: 7,
    acceptedAt: "2026-07-10T00:00:00.000Z",
    phase: "scanning",
    lastDurableTransitionAt: "2026-07-10T00:00:01.000Z",
    runtimeFingerprint: {
        embeddingProvider: "VoyageAI",
        embeddingModel: "voyage-code-3",
        embeddingDimension: 1024,
        vectorStoreProvider: "Milvus",
        schemaVersion: "hybrid_v3",
    },
    writer: { ownerId: "writer", pid: 42, satoriVersion: "test" },
};

const builders = new ToolResponseBuilders({} as ConstructorParameters<typeof ToolResponseBuilders>[0]);

test("manage response includes the supplied durable operation receipt", () => {
    const envelope = builders.buildManageResponseEnvelope("status", "/repo", "ok", "ready", { operation: receipt });

    assert.equal(envelope.action, "status");
    assert.deepEqual(envelope.operation, receipt);
    assert.equal(envelope.operation?.action, "create");
});

test("manage response omits operation when no durable receipt exists", () => {
    const envelope = builders.buildManageResponseEnvelope("create", "/repo", "blocked", "busy");

    assert.equal("operation" in envelope, false);
});
