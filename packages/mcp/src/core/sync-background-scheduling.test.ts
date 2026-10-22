import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import test, { type TestContext } from "node:test";

import chokidar from "chokidar";

import { SyncManager } from "./sync.js";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

class FakeWatcher extends EventEmitter {
    public async close(): Promise<void> {}
}

async function createFixture(t: TestContext, options: {
    roots?: string[];
    watchEnabled?: boolean;
    prepare?: () => Promise<void>;
    execute?: (root: string, call: number) => Promise<{ mode: string; errorMessage?: string }>;
} = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const roots = options.roots ?? ["/repo"];
    const publications = roots.map((root) => ({
        publicationId: `publication-${root}`,
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    }));
    const watchers = new Map<string, FakeWatcher>();
    const ignored = new Map<string, (watchPath: string) => boolean>();
    const calls: string[] = [];
    const context = {
        listCurrentPublications: () => publications,
        getCurrentPublication: (root: string) => publications.find(({ publication }) => publication.canonicalRoot === root),
        getActiveIgnorePatterns: () => ["ignored/**"],
        inspectSourceFreshnessCheckpoint: async (root: string) => {
            await options.prepare?.();
            return { status: "valid", observationToken: "source-1", publicationId: `publication-${root}` };
        },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: options.watchEnabled !== false,
        mutationRuntime: {
            assertCurrent: () => {},
            getCurrentOperation: () => undefined,
            getActiveMutation: () => undefined,
        } as never,
    });
    const internal = manager as unknown as {
        backgroundSyncFlight: Promise<void> | null;
        computeIgnoreControlSignature(root: string): Promise<string>;
        runIgnoreReconcile(...args: unknown[]): Promise<unknown>;
        syncCodebase(root: string): Promise<unknown>;
    };
    t.mock.method(fs.promises, "stat", async () => ({ isDirectory: () => true } as never));
    t.mock.method(chokidar, "watch", (root: string, watchOptions: { ignored: (watchPath: string) => boolean }) => {
        const watcher = new FakeWatcher();
        watchers.set(root, watcher);
        ignored.set(root, watchOptions.ignored);
        return watcher as never;
    });
    t.mock.method(internal, "computeIgnoreControlSignature", async () => "control-1");
    t.mock.method(internal, "syncCodebase", async (root: string) => {
        calls.push(root);
        return await options.execute?.(root, calls.length) ?? { mode: "synced" };
    });
    await manager.startWatcherMode();
    for (const watcher of watchers.values()) watcher.emit("ready");
    manager.startBackgroundSync();
    t.after(async () => { await manager.stopAndDrainLifecycle(); });
    const advance = async (milliseconds: number) => {
        t.mock.timers.tick(milliseconds);
        await settle();
    };
    const change = (root = roots[0], relativePath = "src/file.ts") => {
        const watchPath = `${root}/${relativePath}`;
        if (!ignored.get(root)?.(watchPath)) watchers.get(root)?.emit("change", watchPath);
    };
    return { manager, internal, calls, publications, watchers, change, advance };
}

test("watcher events debounce one global pass after two quiet seconds", async (t) => {
    const { calls, change, advance, manager } = await createFixture(t);
    change();
    await advance(1_000);
    change();
    await advance(1_999);
    assert.deepEqual(calls, []);
    await advance(1);
    assert.deepEqual(calls, ["/repo"]);
    assert.equal(manager.getWatcherObservation("/repo").pending, false);
    await advance(10_000);
    assert.equal(calls.length, 1);
});

test("continuous watcher events force a pass at ten seconds", async (t) => {
    const { calls, change, advance } = await createFixture(t);
    change();
    for (let second = 1; second < 10; second += 1) {
        await advance(1_000);
        change();
    }
    await advance(999);
    assert.equal(calls.length, 0);
    await advance(1);
    assert.equal(calls.length, 1);
});

test("an event during a held pass stays pending and schedules one follow-up", async (t) => {
    const completion = deferred();
    const { calls, change, advance, manager } = await createFixture(t, {
        execute: async (_root, call) => {
            if (call === 1) await completion.promise;
            return { mode: "synced" };
        },
    });
    change();
    await advance(2_000);
    assert.equal(calls.length, 1);
    change();
    await advance(30_000);
    assert.equal(calls.length, 1, "a held automatic pass never overlaps another pass");
    completion.resolve();
    await settle();
    assert.equal(manager.getWatcherObservation("/repo").pending, true);
    await advance(1_999);
    assert.equal(calls.length, 1);
    await advance(1);
    assert.equal(calls.length, 2);
    assert.equal(manager.getWatcherObservation("/repo").pending, false);
    await advance(10_000);
    assert.equal(calls.length, 2);
});

test("multiple dirty roots execute sequentially in the existing global pass", async (t) => {
    const completion = deferred();
    let active = 0;
    let peak = 0;
    const { calls, change, advance } = await createFixture(t, {
        roots: ["/repo-a", "/repo-b"],
        execute: async (_root, call) => {
            active += 1;
            peak = Math.max(peak, active);
            if (call === 1) await completion.promise;
            active -= 1;
            return { mode: "synced" };
        },
    });
    change("/repo-a");
    change("/repo-b");
    await advance(2_000);
    assert.deepEqual(calls, ["/repo-a"]);
    completion.resolve();
    await settle();
    assert.deepEqual(calls, ["/repo-a", "/repo-b"]);
    assert.equal(peak, 1);
});

test("an automatic pass coalesces with an active writer and retains its later event", async (t) => {
    const completion = deferred();
    const { calls, change, advance, manager } = await createFixture(t, {
        execute: async (_root, call) => {
            if (call === 1) await completion.promise;
            return { mode: "synced" };
        },
    });
    const explicit = manager.ensureFreshness("/repo", 0, { skipIgnoreControlCheck: true });
    await settle();
    assert.equal(calls.length, 1);
    change();
    await advance(2_000);
    assert.equal(calls.length, 1);
    assert.equal(manager.getActiveLifecycleOperationCount(), 1);
    completion.resolve();
    await explicit;
    await settle();
    assert.equal(manager.getWatcherObservation("/repo").pending, true);
    await advance(2_000);
    assert.equal(calls.length, 2);
    assert.equal(manager.getWatcherObservation("/repo").pending, false);
});

test("read freshness returns the completed publication while an automatic writer stays held", async (t) => {
    const completion = deferred();
    const { calls, change, advance, manager, publications } = await createFixture(t, {
        execute: async () => { await completion.promise; return { mode: "synced" }; },
    });
    change();
    await advance(2_000);
    let readFinished = false;
    const read = manager.assessReadFreshness("/repo", 60_000, {
        preparedPublication: publications[0] as never,
    }).then((decision) => { readFinished = true; return decision; });
    await settle();
    assert.equal(readFinished, true, "read assessment never joins the automatic writer");
    assert.equal((await read).mode, "read_only");
    assert.equal(manager.getActiveLifecycleOperationCount(), 1);
    assert.equal(calls.length, 1);
    completion.resolve();
    await settle();
});

test("stop joins the admitted root and prevents later roots in that automatic pass", async (t) => {
    const completion = deferred();
    const { calls, change, advance, manager } = await createFixture(t, {
        roots: ["/repo-a", "/repo-b"],
        execute: async () => { await completion.promise; return { mode: "synced" }; },
    });
    change("/repo-a");
    change("/repo-b");
    await advance(2_000);
    const stopping = manager.stopAndDrainLifecycle();
    completion.resolve();
    await stopping;
    assert.deepEqual(calls, ["/repo-a"]);
    await advance(200_000);
    assert.deepEqual(calls, ["/repo-a"]);
});

for (const failure of ["throw", "reported"] as const) {
    test(`${failure} sync failures retain pending edits without a two-second retry loop`, async (t) => {
        let failing = true;
        const { calls, change, advance, manager } = await createFixture(t, {
            execute: async () => {
                if (!failing) return { mode: "synced" };
                if (failure === "throw") throw new Error("injected persistent failure");
                return { mode: "synced", errorMessage: "injected persistent failure" };
            },
        });
        change();
        await advance(2_000);
        assert.equal(calls.length, 1);
        for (let step = 0; step < 30; step += 1) {
            change();
            await advance(2_000);
        }
        assert.equal(calls.length, 1, "later edits do not bypass a failed root's retry delay");
        assert.equal(manager.getWatcherObservation("/repo").pending, true);
        await advance(119_999);
        assert.equal(calls.length, 1);
        failing = false;
        await advance(1);
        assert.equal(calls.length, 2, "the periodic retry recovers the failed root");
        assert.equal(manager.getWatcherObservation("/repo").pending, false);
        change();
        await advance(2_000);
        assert.equal(calls.length, 3, "successful recovery restores prompt catch-up");
    });
}

test("a failing root does not slow healthy roots or retry when their watcher events arrive", async (t) => {
    const { calls, change, advance, manager } = await createFixture(t, {
        roots: ["/repo-a", "/repo-b"],
        execute: async (root) => {
            if (root === "/repo-a") throw new Error("injected root failure");
            return { mode: "synced" };
        },
    });
    change("/repo-a");
    change("/repo-b");
    await advance(2_000);
    assert.deepEqual(calls, ["/repo-a", "/repo-b"]);
    for (let edit = 0; edit < 3; edit += 1) {
        change("/repo-b");
        await advance(2_000);
    }
    assert.equal(calls.filter(root => root === "/repo-a").length, 1);
    assert.equal(calls.filter(root => root === "/repo-b").length, 4);
    assert.equal(manager.getWatcherObservation("/repo-a").pending, true);
    assert.equal(manager.getWatcherObservation("/repo-b").pending, false);
});

test("a successful explicit sync clears automatic failure cooldown", async (t) => {
    let failing = true;
    const { calls, change, advance, manager } = await createFixture(t, {
        execute: async () => {
            if (failing) throw new Error("injected root failure");
            return { mode: "synced" };
        },
    });
    change();
    await advance(2_000);
    failing = false;
    assert.equal((await manager.ensureFreshness("/repo", 0, { skipIgnoreControlCheck: true })).mode, "synced");
    change();
    await advance(2_000);
    assert.equal(calls.length, 3);
    assert.equal(manager.getWatcherObservation("/repo").pending, false);
});

test("a busy root keeps its event pending and retries no sooner than two seconds", async (t) => {
    const { calls, change, advance, manager } = await createFixture(t, {
        execute: async (_root, call) => ({ mode: call === 1 ? "skipped_mutation_in_progress" : "synced" }),
    });
    change();
    await advance(2_000);
    assert.equal(calls.length, 1);
    assert.equal(manager.getWatcherObservation("/repo").pending, true);
    await advance(1_999);
    assert.equal(calls.length, 1);
    await advance(1);
    assert.equal(calls.length, 2);
    assert.equal(manager.getWatcherObservation("/repo").pending, false);
});

for (const failure of ["throw", "reported"] as const) {
    test(`${failure} failure after stop does not restore cooldown on restart`, async (t) => {
        const completion = deferred();
        const { manager, calls, change, advance, watchers } = await createFixture(t, {
            execute: async (_root, call) => {
                if (call !== 1) return { mode: "synced" };
                await completion.promise;
                if (failure === "throw") throw new Error("injected shutdown failure");
                return { mode: "synced", errorMessage: "injected shutdown failure" };
            },
        });
        change();
        await advance(2_000);
        assert.equal(calls.length, 1);
        const stopping = manager.stopAndDrainLifecycle();
        await settle();
        completion.resolve();
        await stopping;
        await manager.startWatcherMode();
        for (const watcher of watchers.values()) watcher.emit("ready");
        manager.startBackgroundSync();
        change();
        await advance(2_000);
        assert.equal(calls.length, 2, "an admitted failure cannot recreate stopped scheduler state");
        assert.equal(manager.getWatcherObservation("/repo").pending, false);
    });
}

test("stopping background sync clears queued watcher timers", async (t) => {
    const { calls, change, advance, manager } = await createFixture(t);
    change();
    manager.stopBackgroundSync();
    change();
    await advance(200_000);
    assert.deepEqual(calls, []);
});

test("unwatch discards its queued watcher catch-up", async (t) => {
    const { calls, change, advance, manager } = await createFixture(t);
    change();
    await manager.unwatchCodebase("/repo");
    await advance(10_000);
    assert.deepEqual(calls, []);
});

test("watcher stop discards queued events and leaves periodic fallback", async (t) => {
    const { calls, change, advance, manager } = await createFixture(t);
    change();
    await manager.stopWatcherMode();
    await advance(10_000);
    assert.deepEqual(calls, []);
    await advance(170_000);
    assert.deepEqual(calls, ["/repo"]);
});

test("disabled watchers retain the five-second first and periodic fallback", async (t) => {
    const { calls, advance } = await createFixture(t, { watchEnabled: false });
    await advance(4_999);
    assert.deepEqual(calls, []);
    await advance(1);
    assert.equal(calls.length, 1);
    await advance(179_999);
    assert.equal(calls.length, 1);
    await advance(1);
    assert.equal(calls.length, 2);
});

test("watcher failure discards queued events and preserves periodic fallback", async (t) => {
    const { calls, watchers, change, advance } = await createFixture(t);
    change();
    watchers.get("/repo")?.emit("error", Object.assign(new Error("watch limit"), { code: "ENOSPC" }));
    await settle();
    await advance(10_000);
    assert.deepEqual(calls, []);
    await advance(170_000);
    assert.deepEqual(calls, ["/repo"]);
});

test("shutdown joins automatic preparation and completion before releasing ownership", async (t) => {
    const preparation = deferred();
    const completion = deferred();
    let preparing = false;
    const { calls, change, advance, manager } = await createFixture(t, {
        prepare: async () => { preparing = true; await preparation.promise; },
        execute: async () => { await completion.promise; return { mode: "synced" }; },
    });
    change();
    await advance(2_000);
    assert.equal(preparing, true);
    assert.equal(manager.getActiveLifecycleOperationCount(), 1);
    let drained = false;
    const stopping = manager.stopAndDrainLifecycle().then(() => { drained = true; });
    await settle();
    assert.equal(drained, false);
    preparation.resolve();
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(drained, false);
    completion.resolve();
    await stopping;
    assert.equal(manager.getActiveLifecycleOperationCount(), 0);
    await advance(200_000);
    assert.equal(calls.length, 1);
});

test("ignored paths schedule nothing and ignore controls retain reconciliation", async (t) => {
    const { calls, change, advance, manager, internal, publications } = await createFixture(t);
    change("/repo", "ignored/file.ts");
    await advance(3_000);
    assert.equal(manager.getWatcherObservation("/repo").observedEventEpoch, 0);
    assert.deepEqual(calls, []);
    Object.assign(publications[0].publication.policy, { controlSignature: "old-control" });
    let reconciles = 0;
    t.mock.method(internal, "runIgnoreReconcile", async () => {
        reconciles += 1;
        return { mode: "reconciled_ignore_change" };
    });
    change("/repo", "ignored/.gitignore");
    assert.equal(manager.getWatcherObservation("/repo").latestEpochByReason.ignore_rules_changed, 1);
    await advance(2_000);
    assert.equal(reconciles, 1);
    assert.deepEqual(calls, []);
    assert.equal(manager.getWatcherObservation("/repo").pending, false);
});
