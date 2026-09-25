import assert from "node:assert/strict";
import test from "node:test";
import { ManageMaintenanceHandlers } from "./manage-maintenance-handlers.js";

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
