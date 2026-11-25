import assert from "node:assert/strict";
import test from "node:test";
import type { RootMutationExecution, RootMutationOperation } from "@satori-code/core/integration";
import { ManageIndexingHandlers, failedIndexOperationForReadiness } from "./manage-indexing-handlers.js";

function operation(overrides: Partial<RootMutationOperation>): RootMutationOperation {
    return {
        id: "op-1",
        canonicalRoot: "/repo",
        action: "create",
        generation: 1,
        phase: "failed",
        acceptedAt: "2026-09-30T00:00:00.000Z",
        updatedAt: "2026-09-30T00:05:00.000Z",
        ...overrides,
    } as RootMutationOperation;
}

test("a no-progress watchdog cancellation reports a failed index, not a missing one", () => {
    const failed = failedIndexOperationForReadiness(operation({
        phase: "cancelled",
        cancelReason: "full_index_no_progress_timeout",
        progress: 88,
    }));
    assert.equal(failed?.progress, 88);
    assert.match(failed?.error ?? "", /no progress for 30 minutes/);
});

test("failed create and reindex operations keep their own error", () => {
    for (const action of ["create", "reindex"] as const) {
        assert.equal(failedIndexOperationForReadiness(operation({ action, error: "boom" }))?.error, "boom");
    }
});

test("caller cancellation, completion and non-index actions are not failures", () => {
    assert.equal(failedIndexOperationForReadiness(operation({ phase: "cancelled", cancelReason: "user_requested" })), undefined);
    assert.equal(failedIndexOperationForReadiness(operation({ phase: "completed" })), undefined);
    assert.equal(failedIndexOperationForReadiness(operation({ action: "sync", error: "boom" })), undefined);
    assert.equal(failedIndexOperationForReadiness(undefined), undefined);
});

test("createSupervisedCandidateRunner reclaims idle host memory before planning and checks cancellation", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const handlers = new ManageIndexingHandlers({
        reclaimIdleMemoryForMutation: async () => {
            events.push("reclaim_started");
            controller.abort(new Error("cancelled_during_reclaim"));
            events.push("reclaim_finished");
        },
    } as unknown as ConstructorParameters<typeof ManageIndexingHandlers>[0]);
    const createRunner = (handlers as unknown as {
        createSupervisedCandidateRunner: (
            execution: RootMutationExecution,
            action: "create" | "reindex",
        ) => (input: {
            codebasePath: string;
            forceReindex: boolean;
            indexPolicy: unknown;
            deferPartialPublication: boolean;
            onSourceScanCompleted: () => void;
            onProgress: (progress: unknown) => void;
        }) => Promise<unknown>;
    }).createSupervisedCandidateRunner.bind(handlers);

    const runner = createRunner({
        id: "op-reclaim-test",
        signal: controller.signal,
    } as unknown as RootMutationExecution, "create");

    await assert.rejects(
        runner({
            codebasePath: "/repo",
            forceReindex: false,
            indexPolicy: {},
            deferPartialPublication: false,
            onSourceScanCompleted: () => undefined,
            onProgress: () => undefined,
        }),
        /cancelled_during_reclaim/,
    );
    assert.deepEqual(events, ["reclaim_started", "reclaim_finished"]);
});
