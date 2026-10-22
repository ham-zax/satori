import assert from "node:assert/strict";
import test from "node:test";

import { SyncManager } from "./sync.js";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

test("concurrent freshness preparation installs one sync owner before dispatch", async (t) => {
    const root = "/repo";
    const preparation = deferred();
    const bothPreparing = deferred();
    const dispatched = deferred();
    const completion = deferred();
    const publication = { publicationId: "publication-1", publication: { status: "complete", canonicalRoot: root, policy: {} } };
    let preparations = 0;
    let syncCalls = 0;
    const manager = new SyncManager({
        listCurrentPublications: () => [publication],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => {
            preparations += 1;
            if (preparations <= 2) {
                if (preparations === 2) bothPreparing.resolve();
                await preparation.promise;
            }
            return { status: "valid", observationToken: "source-1", publicationId: "publication-1" };
        },
    } as never, { mutationRuntime: { assertCurrent: () => {} } as never });
    const internal = manager as unknown as {
        activeSyncs: Map<string, Promise<unknown>>;
        freshnessEpochs: Map<string, number>;
        syncCodebase(root: string): Promise<unknown>;
    };
    const stats = { added: 1, removed: 2, modified: 3 };
    const operation = { id: "operation-1" };
    let ownerAtDispatch: Promise<unknown> | undefined;
    t.mock.method(internal, "syncCodebase", async () => {
        syncCalls += 1;
        ownerAtDispatch = internal.activeSyncs.get(root);
        dispatched.resolve();
        await completion.promise;
        return { mode: "synced", stats, operation };
    });

    const first = manager.ensureFreshness(root, 0, { skipIgnoreControlCheck: true });
    const second = manager.ensureFreshness(root, 0, { skipIgnoreControlCheck: true });
    await bothPreparing.promise;
    preparation.resolve();
    await dispatched.promise;
    const currentOwner = internal.activeSyncs.get(root);
    const third = manager.ensureFreshness(root, 0, { skipIgnoreControlCheck: true });
    completion.resolve();
    const decisions = await Promise.all([first, second, third]);

    assert.equal(syncCalls, 1, "two calls released from preparation share one execution");
    assert.ok(ownerAtDispatch, "the map owns the promise before sync dispatch starts");
    assert.equal(currentOwner, ownerAtDispatch, "another caller does not replace the active owner");
    assert.deepEqual(decisions.map(({ mode }) => mode), ["synced", "coalesced", "coalesced"]);
    for (const decision of decisions) {
        assert.deepEqual(decision.stats, stats);
        assert.equal(decision.operation, operation);
    }
    assert.equal(internal.activeSyncs.size, 0);
    assert.equal(internal.freshnessEpochs.get(root), 2, "one start and one finish invalidate freshness");

    const failure = new Error("injected sync failure");
    const failureStarted = deferred();
    const rejectSync = deferred();
    let failingDispatches = 0;
    t.mock.method(internal, "syncCodebase", async () => {
        failingDispatches += 1;
        failureStarted.resolve();
        await rejectSync.promise;
        throw failure;
    });
    const failingCalls = Promise.allSettled([
        manager.ensureFreshness(root, 0, { skipIgnoreControlCheck: true }),
        manager.ensureFreshness(root, 0, { skipIgnoreControlCheck: true }),
    ]);
    await failureStarted.promise;
    rejectSync.resolve();
    const failures = await failingCalls;
    assert.equal(failingDispatches, 1, "failing callers share their execution");
    for (const result of failures) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.equal(result.reason, failure);
    }
    assert.equal(internal.activeSyncs.size, 0, "failure releases the promise owner");

    t.mock.method(internal, "syncCodebase", async () => ({ mode: "synced", stats, operation }));
    assert.equal((await manager.ensureFreshness(root, 0, { skipIgnoreControlCheck: true })).mode, "synced");
    assert.equal(internal.activeSyncs.size, 0, "retry completes with no stale owner");
});
