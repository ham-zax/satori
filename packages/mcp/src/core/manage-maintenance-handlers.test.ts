import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { ManageMaintenanceHandlers } from "./manage-maintenance-handlers.js";
import { TrackedRootReadiness } from "./tracked-root-readiness.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";

function response(
    action: string,
    path: string,
    status: string,
    message: string,
    options: Record<string, unknown> = {},
) {
    return {
        content: [{
            type: "text" as const,
            text: JSON.stringify({ action, path, status, message, ...options }),
        }],
    };
}

test("status distinguishes readable indexes from source parity while sync remains pending", async () => {
    for (const state of ["verified", "unverified", "changed", "index_snapshot", "partial"] as const) {
        const root = os.tmpdir();
        const sourceFreshness = { state, reason: state === "unverified" ? "sync_active" : "test" };
        const operation = state === "unverified" ? {
            id: "sync-op", action: "sync", canonicalRoot: root, generation: 2,
            acceptedAt: new Date(0).toISOString(), phase: "preflight", progress: 0,
            pid: 100, executorPid: 200, executorProcessGroupId: 200,
        } : undefined;
        const builders = new ToolResponseBuilders({} as never);
        const handler = new ManageMaintenanceHandlers({
            mutationRuntime: { getActiveMutation: () => operation, getOperation: () => operation },
            prepareStatusTrackedRootRead: async () => ({
                state: "ready", root: { path: root }, navigationStatus: "valid",
                publication: {
                    id: "published-1",
                    publication: {
                        status: state === "partial" ? "partial" : "complete",
                        createdAt: new Date(0).toISOString(),
                        vector: { indexedFiles: 1, totalChunks: 2, collectionName: "collection" },
                        policy: { policyHash: "policy" },
                    },
                },
            }),
            context: { inspectSourceFreshnessCheckpoint: async () => ({ status: "valid" }) },
            syncManager: { assessReadFreshness: async () => ({ sourceFreshness }) },
            acquirePublicationLease: () => undefined,
            readPublicationSymbolRegistry: async () => undefined,
            buildSyncHint: () => ({ tool: "manage_index", args: { action: "sync", path: root } }),
            manageResponse: (...args: Parameters<ToolResponseBuilders["buildManageResponseEnvelope"]>) => ({
                content: [{ type: "text", text: JSON.stringify(builders.buildManageResponseEnvelope(...args)) }],
            }),
        } as never);
        const result = await handler.handleGetIndexingStatus({ path: root });
        const payload = JSON.parse(result.content[0]?.text ?? "{}");
        assert.equal(payload.status, "ok", payload.humanText);
        if (state === "partial") {
            assert.match(payload.message, /partially indexed/);
            assert.match(payload.humanText, /Search may return incomplete results/);
        } else {
            assert.match(payload.message, /complete readable index/);
            assert.ok(payload.message.includes(`source parity: ${state}`));
            assert.deepEqual(payload.sourceFreshness, sourceFreshness);
        }
        if (state === "unverified") {
            assert.ok(!(payload.warnings ?? []).includes("SOURCE_FRESHNESS_UNVERIFIED"));
            assert.equal(payload.pendingSync.operationId, "sync-op");
            assert.match(payload.humanText, /Current source parity is unverified/);
        }
        if (state === "changed") {
            assert.ok(payload.warnings.includes("SOURCE_CHANGES_PENDING"));
        }
        if (state === "index_snapshot") {
            assert.ok(payload.warnings.includes("SOURCE_SERVED_FROM_INDEX_SNAPSHOT"));
        }
    }
});

test("cancel accepts a supervised reindex executor and never force-unlocks", async () => {
    const cancellations: Array<{ operationId: string; reason?: string }> = [];
    const activeMutation = {
        id: "op-reindex",
        action: "reindex",
        canonicalRoot: "/repo",
        generation: 3,
        pid: 100,
        acceptedAt: new Date(0).toISOString(),
        executorPid: 200,
        executorProcessGroupId: 200,
    };
    const handler = new ManageMaintenanceHandlers({
        mutationRuntime: {
            getActiveMutation: () => activeMutation,
            requestCancellation: (operationId: string, reason?: string) => {
                cancellations.push({ operationId, reason });
                return true;
            },
            getOperation: () => ({
                id: activeMutation.id,
                action: activeMutation.action,
                canonicalRoot: activeMutation.canonicalRoot,
                generation: activeMutation.generation,
                acceptedAt: activeMutation.acceptedAt,
                phase: "cancelling",
                updatedAt: activeMutation.acceptedAt,
                heartbeatAt: activeMutation.acceptedAt,
                progressAt: activeMutation.acceptedAt,
            }),
        },
        manageResponse: response,
        buildStatusHint: () => ({ tool: "manage_index", args: { action: "status", path: "/repo" } }),
    } as never);

    const result = await handler.handleCancelOperation({
        path: "/repo",
        operationId: activeMutation.id,
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    assert.deepEqual(cancellations, [{
        operationId: activeMutation.id,
        reason: "requested_by_manage_index",
    }]);
    assert.equal(payload.status, "ok");
    assert.match(payload.message, /reindex operation/);
    assert.match(payload.message, /lease remains held/i);
    assert.equal("pendingSync" in payload, false);
});

test("cancel refuses a create mutation that has no bound supervised executor", async () => {
    let cancellationRequested = false;
    const activeMutation = {
        id: "op-create",
        action: "create",
        canonicalRoot: "/repo",
        generation: 4,
        pid: 100,
        acceptedAt: new Date(0).toISOString(),
    };
    const handler = new ManageMaintenanceHandlers({
        mutationRuntime: {
            getActiveMutation: () => activeMutation,
            requestCancellation: () => {
                cancellationRequested = true;
                return true;
            },
        },
        manageResponse: response,
        buildStatusHint: () => ({ tool: "manage_index", args: { action: "status", path: "/repo" } }),
    } as never);

    const result = await handler.handleCancelOperation({
        path: "/repo",
        operationId: activeMutation.id,
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    assert.equal(cancellationRequested, false);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.reason, "operation_not_cancellable");
    assert.match(payload.message, /No force-unlock was attempted/);
});

test("status after a failed create reports the failure instead of telling the caller to create", async () => {
    const root = os.tmpdir();
    const failedOperation = {
        id: "op-create",
        action: "create",
        canonicalRoot: root,
        generation: 1,
        acceptedAt: new Date(0).toISOString(),
        phase: "failed",
        updatedAt: new Date(1).toISOString(),
        error: "boom",
    };
    const readiness = new TrackedRootReadiness({
        isPathWithinCodebase: () => false,
        listTrackedRoots: () => [],
        getFailedIndexOperation: () => ({ error: failedOperation.error, updatedAt: failedOperation.updatedAt }),
    } as never);
    const handler = new ManageMaintenanceHandlers({
        mutationRuntime: {
            getOperation: () => failedOperation,
            getActiveMutation: () => undefined,
        },
        prepareStatusTrackedRootRead: (absolutePath: string) => readiness.prepareTrackedRootForRead(absolutePath),
        manageResponse: response,
        buildCompatibilityStatusLines: () => "",
        buildCreateHint: (path: string) => ({ tool: "manage_index", args: { action: "create", path } }),
    } as never);

    const result = await handler.handleGetIndexingStatus({ path: root });
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    assert.equal(payload.status, "error");
    assert.match(payload.message, /indexing failed/);
    assert.match(payload.message, /boom/);
    assert.equal(payload.hints?.create, undefined);
    assert.doesNotMatch(JSON.stringify(payload), /is not indexed/);
});

test("status rereads when the operation turns terminal during the read", async () => {
    const root = os.tmpdir();
    const syncOperation = (phase: string) => ({
        id: "sync-op", action: "sync", canonicalRoot: root, generation: 2,
        acceptedAt: new Date(0).toISOString(), phase, progress: phase === "completed" ? 100 : 50,
    });
    let operation = syncOperation("writing");
    let indexedFiles = 1;
    let sourceFreshness = { state: "unverified", reason: "watcher_event_pending" };
    const builders = new ToolResponseBuilders({} as never);
    const handler = new ManageMaintenanceHandlers({
        mutationRuntime: { getActiveMutation: () => undefined, getOperation: () => operation },
        prepareStatusTrackedRootRead: async () => ({
            state: "ready", root: { path: root }, navigationStatus: "valid",
            publication: {
                id: `published-${indexedFiles}`,
                publication: {
                    status: "complete",
                    createdAt: new Date(0).toISOString(),
                    vector: { indexedFiles, totalChunks: 2, collectionName: "collection" },
                    policy: { policyHash: "policy" },
                },
            },
        }),
        context: { inspectSourceFreshnessCheckpoint: async () => ({ status: "valid" }) },
        syncManager: {
            assessReadFreshness: async () => {
                const observed = sourceFreshness;
                // The sync activates its Publication, covers the watcher event and
                // completes after this read observed the older state.
                if (operation.phase !== "completed") {
                    indexedFiles = 2;
                    sourceFreshness = { state: "verified", reason: "watcher_continuity" };
                    operation = syncOperation("completed");
                }
                return { sourceFreshness: observed };
            },
        },
        acquirePublicationLease: () => undefined,
        readPublicationSymbolRegistry: async () => undefined,
        buildSyncHint: () => ({ tool: "manage_index", args: { action: "sync", path: root } }),
        manageResponse: (...args: Parameters<ToolResponseBuilders["buildManageResponseEnvelope"]>) => ({
            content: [{ type: "text", text: JSON.stringify(builders.buildManageResponseEnvelope(...args)) }],
        }),
    } as never);
    const payload = JSON.parse((await handler.handleGetIndexingStatus({ path: root })).content[0]?.text ?? "{}");
    assert.equal(payload.operation.phase, "completed");
    assert.equal(payload.publication.publicationId, "published-2");
    assert.deepEqual(payload.sourceFreshness, { state: "verified", reason: "watcher_continuity" });
});
