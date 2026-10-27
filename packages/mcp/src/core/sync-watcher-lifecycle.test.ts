import assert from "node:assert/strict";
import * as fs from "fs";
import test, { type TestContext } from "node:test";

import chokidar from "chokidar";

import { SyncManager } from "./sync.js";

const root = "/repo";
const publication = {
    publicationId: "publication-1",
    publication: { canonicalRoot: root },
};

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

class FakeWatcher {
    public closeCount = 0;

    constructor(private readonly onClose?: () => Promise<void>) {}

    public on(): this {
        return this;
    }

    public async close(): Promise<void> {
        this.closeCount += 1;
        await this.onClose?.();
    }
}

type SyncInternals = {
    watcherModeStarted: boolean;
    watchers: Map<string, FakeWatcher>;
    watcherIgnoreMatchers: Map<string, unknown>;
    watcherCandidatePolicies: Map<string, { policyHash: string; effectiveIgnorePatterns: readonly string[] }>;
    buildIgnoreMatcherForCodebase(
        codebasePath: string,
        effectiveIgnorePatterns?: readonly string[],
    ): Promise<unknown>;
};

function createFixture(
    t: TestContext,
    options: { onClose?: () => Promise<void>; onRelease?: (root: string) => Promise<void> } = {},
) {
    const watchers: FakeWatcher[] = [];
    const context = {
        listCurrentPublications: () => [publication],
        getCurrentPublication: () => publication,
        getActiveIgnorePatterns: () => [],
    };
    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        getActiveMutation: () => undefined,
        updateCurrentOperation: () => { throw new Error("not used"); },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: mutationRuntime as never,
        ...(options.onRelease ? { syncWorkerWarmup: {
            prepare: () => {}, take: () => undefined, release: options.onRelease,
        } } : {}),
    });
    const internal = manager as unknown as SyncInternals;
    t.mock.method(fs.promises, "stat", async () => ({ isDirectory: () => true } as never));
    t.mock.method(chokidar, "watch", () => {
        const watcher = new FakeWatcher(options.onClose);
        watchers.push(watcher);
        return watcher as never;
    });
    return { manager, internal, watchers };
}

test("unwatch closes the watcher before releasing standby and waits for its drain", async (t) => {
    const closeStarted = deferred();
    const closeGate = deferred();
    const releaseStarted = deferred();
    const releaseGate = deferred();
    const events: string[] = [];
    const { manager } = createFixture(t, {
        onClose: async () => { events.push('close'); closeStarted.resolve(); await closeGate.promise; },
        onRelease: async (releasedRoot) => { events.push(`release:${releasedRoot}`); releaseStarted.resolve(); await releaseGate.promise; },
    });
    await manager.startWatcherMode();
    let finished = false;
    const unwatching = manager.unwatchCodebase(root).then(() => { finished = true; });
    await closeStarted.promise;
    const beforeClose = [...events];
    closeGate.resolve();
    await releaseStarted.promise;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const beforeRelease = finished;
    releaseGate.resolve();
    await unwatching;
    assert.deepEqual(beforeClose, ['close']);
    assert.equal(beforeRelease, false);
    assert.deepEqual(events, ['close', `release:${root}`]);
});

test("stop drains standby release after watcher close", async (t) => {
    const gate = deferred();
    const started = deferred();
    const { manager, watchers } = createFixture(t, {
        onRelease: async () => { started.resolve(); await gate.promise; },
    });
    await manager.startWatcherMode();
    let finished = false;
    const stopping = manager.stopWatcherMode().then(() => { finished = true; });
    const called = await Promise.race([started.promise.then(() => true), stopping.then(() => false)]);
    const beforeRelease = finished;
    gate.resolve();
    await stopping;
    assert.equal(called, true);
    assert.equal(beforeRelease, false);
    assert.equal(watchers[0].closeCount, 1);
});

test("stop joins a standby release already owned by unwatch", async (t) => {
    const gate = deferred();
    const started = deferred();
    const { manager } = createFixture(t, {
        onRelease: async () => { started.resolve(); await gate.promise; },
    });
    await manager.startWatcherMode();
    const unwatching = manager.unwatchCodebase(root);
    await started.promise;
    let stopped = false;
    const stopping = manager.stopWatcherMode().then(() => { stopped = true; });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const beforeRelease = stopped;
    gate.resolve();
    await Promise.all([unwatching, stopping]);
    assert.equal(beforeRelease, false);
});

test("ENOSPC shutdown drains standby release", async (t) => {
    const gate = deferred();
    const started = deferred();
    const { manager, internal } = createFixture(t, {
        onRelease: async () => { started.resolve(); await gate.promise; },
    });
    internal.watcherModeStarted = true;
    t.mock.method(chokidar, "watch", () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); });
    const touching = manager.touchWatchedCodebase(root);
    const called = await Promise.race([started.promise.then(() => true), touching.then(() => false)]);
    gate.resolve();
    await touching;
    assert.equal(called, true);
    assert.equal(internal.watcherModeStarted, false);
});

function gateMatcher(
    t: TestContext,
    manager: SyncManager,
    gate: Promise<void>,
    onStart: (patterns: readonly string[] | undefined) => void,
    onlyFirst = false,
): void {
    const internal = manager as unknown as SyncInternals;
    const original = internal.buildIgnoreMatcherForCodebase.bind(manager);
    let calls = 0;
    t.mock.method(internal, "buildIgnoreMatcherForCodebase", async (codebasePath: string, patterns?: readonly string[]) => {
        calls += 1;
        onStart(patterns);
        if (!onlyFirst || calls === 1) {
            await gate;
        }
        return original(codebasePath, patterns);
    });
}

test("simultaneous same-root touches create one watcher", async (t) => {
    const { manager, internal, watchers } = createFixture(t);
    internal.watcherModeStarted = true;
    const matcherGate = deferred<void>();
    const matcherStarted = deferred<void>();
    const secondRegistrationAttempt = deferred<void>();
    gateMatcher(t, manager, matcherGate.promise, () => matcherStarted.resolve());
    const register = manager.registerCodebaseWatcher.bind(manager);
    let registrationAttempts = 0;
    t.mock.method(manager, "registerCodebaseWatcher", async (codebasePath: string) => {
        registrationAttempts += 1;
        if (registrationAttempts === 2) secondRegistrationAttempt.resolve();
        await register(codebasePath);
    });

    const first = manager.touchWatchedCodebase(root);
    await matcherStarted.promise;
    const second = manager.touchWatchedCodebase(root);
    await secondRegistrationAttempt.promise;
    matcherGate.resolve();
    await Promise.all([first, second]);

    assert.equal(watchers.length, 1, "one watcher is created for concurrent same-root requests");
});

test("stop joins and cancels a registration blocked while building its matcher", async (t) => {
    const { manager, internal, watchers } = createFixture(t);
    internal.watcherModeStarted = true;
    const matcherGate = deferred<void>();
    const matcherStarted = deferred<void>();
    let matcherAttempts = 0;
    gateMatcher(t, manager, matcherGate.promise, () => {
        matcherAttempts += 1;
        matcherStarted.resolve();
    });

    const registration = manager.registerCodebaseWatcher(root);
    await matcherStarted.promise;
    const waiter = manager.registerCodebaseWatcher(root);
    const stopping = manager.stopWatcherMode();
    matcherGate.resolve();
    await Promise.all([registration, waiter, stopping]);

    assert.equal(watchers.length, 0, "a cancelled registration never creates a late watcher");
    assert.equal(matcherAttempts, 1, "a waiter does not restart registration after watcher mode stops");
    assert.equal(internal.watchers.has(root), false);
    assert.equal(internal.watcherIgnoreMatchers.has(root), false);
});

test("unwatch joins and cancels a registration blocked while building its matcher", async (t) => {
    const { manager, internal, watchers } = createFixture(t);
    internal.watcherModeStarted = true;
    const matcherGate = deferred<void>();
    const matcherStarted = deferred<void>();
    let matcherAttempts = 0;
    gateMatcher(t, manager, matcherGate.promise, () => {
        matcherAttempts += 1;
        matcherStarted.resolve();
    });

    const registration = manager.registerCodebaseWatcher(root);
    await matcherStarted.promise;
    const waiter = manager.registerCodebaseWatcher(root);
    const unwatching = manager.unwatchCodebase(root);
    matcherGate.resolve();
    await Promise.all([registration, waiter, unwatching]);

    assert.equal(watchers.length, 0, "unwatch prevents a late watcher from being installed");
    assert.equal(matcherAttempts, 1, "a waiter does not restart a root removed from the watch list");
    assert.equal(internal.watchers.has(root), false);
    assert.equal(internal.watcherIgnoreMatchers.has(root), false);
});

test("touches joining a cancelled registration deduplicate its replacement", async (t) => {
    const { manager, internal, watchers } = createFixture(t);
    internal.watcherModeStarted = true;
    const matcherGate = deferred<void>();
    const matcherStarted = deferred<void>();
    let matcherAttempts = 0;
    gateMatcher(t, manager, matcherGate.promise, () => {
        matcherAttempts += 1;
        if (matcherAttempts === 1) matcherStarted.resolve();
    }, true);

    const first = manager.touchWatchedCodebase(root);
    await matcherStarted.promise;
    const unwatching = manager.unwatchCodebase(root);
    const firstLaterTouch = manager.touchWatchedCodebase(root);
    const secondLaterTouch = manager.touchWatchedCodebase(root);
    matcherGate.resolve();
    await Promise.all([first, unwatching, firstLaterTouch, secondLaterTouch]);

    assert.equal(matcherAttempts, 2, "cancelled waiters share one replacement matcher build");
    assert.equal(watchers.length, 1, "the later touches install exactly one replacement watcher");
    assert.equal(internal.watchers.get(root), watchers[0]);
});

test("policy replacement cancels a pending watcher and admits the replacement", async (t) => {
    const { manager, internal, watchers } = createFixture(t);
    internal.watcherModeStarted = true;
    const matcherGate = deferred<void>();
    const firstMatcherStarted = deferred<void>();
    const matcherPatterns: (readonly string[] | undefined)[] = [];
    gateMatcher(t, manager, matcherGate.promise, (patterns) => {
        matcherPatterns.push(patterns);
        if (matcherPatterns.length === 1) firstMatcherStarted.resolve();
    }, true);

    const first = manager.touchWatchedCodebase(root, {
        policyHash: "first",
        effectiveIgnorePatterns: ["first-pattern"],
    });
    await firstMatcherStarted.promise;
    const replacement = manager.touchWatchedCodebase(root, {
        policyHash: "second",
        effectiveIgnorePatterns: ["second-pattern"],
    });
    matcherGate.resolve();
    await Promise.all([first, replacement]);

    assert.equal(watchers.length, 1, "only the replacement registration creates a watcher");
    assert.deepEqual(matcherPatterns, [["first-pattern"], ["second-pattern"]]);
    assert.equal(internal.watcherCandidatePolicies.get(root)?.policyHash, "second");
});

test("stop then start creates a fresh watcher and closes the previous one once", async (t) => {
    const { manager, internal, watchers } = createFixture(t);

    await manager.startWatcherMode();
    assert.equal(watchers.length, 1);
    await manager.stopWatcherMode();
    assert.equal(watchers[0]?.closeCount, 1);
    assert.equal(internal.watchers.has(root), false);

    await manager.startWatcherMode();
    assert.equal(watchers.length, 2);
    assert.equal(internal.watchers.get(root), watchers[1]);
});

test("stop joins an in-flight close already owned by unwatch", async (t) => {
    const closeStarted = deferred<void>();
    const closeGate = deferred<void>();
    const { manager, watchers } = createFixture(t, {
        onClose: async () => {
            closeStarted.resolve();
            await closeGate.promise;
        },
    });
    await manager.startWatcherMode();
    const unwatching = manager.unwatchCodebase(root);
    await closeStarted.promise;
    let stopCompleted = false;
    const stopping = manager.stopWatcherMode().then(() => { stopCompleted = true; });
    for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
    }
    const stopJoinedClose = !stopCompleted;
    closeGate.resolve();
    await Promise.all([unwatching, stopping]);

    assert.equal(stopJoinedClose, true, "stop remains pending until the owned close settles");
    assert.equal(watchers[0]?.closeCount, 1, "racing lifecycle calls close the watcher once");
});

test("ENOSPC during watcher creation recovers without joining its own registration", async (t) => {
    const { manager, internal } = createFixture(t);
    internal.watcherModeStarted = true;
    const error = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    t.mock.method(chokidar, "watch", () => { throw error; });

    await manager.registerCodebaseWatcher(root);

    assert.equal(internal.watcherModeStarted, false);
    assert.equal(internal.watchers.has(root), false);
    assert.equal(internal.watcherIgnoreMatchers.has(root), false);
});
