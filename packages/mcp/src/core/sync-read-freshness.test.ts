import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SyncManager } from "./sync.js";
import { buildFreshnessWarningCodes, WARNING_CODES } from "./warnings.js";

test("read freshness acknowledges only watcher events proven by a matching complete source observation", async () => {
    const root = "/repo";
    const checkpointObservation = "checkpoint-observation";
    const publication = {
        publicationId: "publication-1",
        publication: {
            status: "complete",
            canonicalRoot: root,
            policy: {},
        },
    };

    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: checkpointObservation,
            publicationId: "publication-1",
        }),
        getCurrentPublicationSourceObservation: () => checkpointObservation,
        compareSourceObservationToFreshnessCheckpoint: async () => ({
            status: "matches",
            changedFiles: [],
        }),
    };

    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        updateCurrentOperation: () => {
            throw new Error("not used");
        },
    };

    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: mutationRuntime as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, {
            observedEventEpoch: number;
            comparedThroughEventEpoch: number;
            latestEpochByReason: Map<string, number>;
            coverage: string;
        }>;
    };

    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 1,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 1]]),
        coverage: "ready",
    });

    const decision = await manager.assessReadFreshness(root, 60_000, {
        preparedPublication: publication as never,
    });

    assert.deepEqual(decision.sourceFreshness, {
        state: "verified",
        reason: "watcher_continuity",
    });
    assert.equal(internal.watcherObservations.get(root)?.comparedThroughEventEpoch, 1);
});

test("read freshness leaves a watcher event pending when it arrives during source comparison", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    let comparisonStarted!: () => void;
    const started = new Promise<void>((resolve) => { comparisonStarted = resolve; });
    let finishComparison!: () => void;
    const comparisonFinished = new Promise<void>((resolve) => { finishComparison = resolve; });
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: "publication-1",
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareSourceObservationToFreshnessCheckpoint: async () => {
            comparisonStarted();
            await comparisonFinished;
            return { status: "matches", changedFiles: [] };
        },
    };
    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        updateCurrentOperation: () => { throw new Error("not used"); },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: mutationRuntime as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, {
            observedEventEpoch: number;
            comparedThroughEventEpoch: number;
            latestEpochByReason: Map<string, number>;
            coverage: string;
        }>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 1,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 1]]),
        coverage: "ready",
    });

    const decisionPromise = manager.assessReadFreshness(root, 60_000, {
        preparedPublication: publication as never,
    });
    await started;
    assert.equal(manager.recordWatcherEvent(root, "source_changed"), 2);
    finishComparison();
    const decision = await decisionPromise;

    assert.deepEqual(decision.sourceFreshness, {
        state: "unverified",
        reason: "watcher_event_pending",
    });
    assert.equal(internal.watcherObservations.get(root)?.comparedThroughEventEpoch, 1);
    assert.equal(manager.getWatcherObservation(root).pending, true);
});

test("external sync completion reaches the watcher-owning manager and closes a gap only through the epoch captured before the worker started", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-2",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-after-sync",
            publicationId: "publication-2",
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-after-sync",
    };
    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        updateCurrentOperation: () => { throw new Error("not used"); },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: mutationRuntime as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, {
            observedEventEpoch: number;
            comparedThroughEventEpoch: number;
            latestEpochByReason: Map<string, number>;
            coverage: string;
            coverageGapSinceEpoch?: number;
        }>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    // A watcher restart (for example around a cancelled reindex) left a gap.
    internal.watcherObservations.set(root, {
        observedEventEpoch: 2,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 2]]),
        coverage: "ready",
        coverageGapSinceEpoch: 1,
    });
    assert.equal(manager.getPreparedReadObservation(root).available, false);

    // manage_index sync uses the provider-free manager, which owns no watcher.
    const localManager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: mutationRuntime as never,
        externalSyncFlightSource: (codebasePath) => manager.captureExternalSyncFlight(codebasePath),
    });

    const firstFlight = localManager.captureExternalSyncFlight(root);
    assert.equal(manager.recordWatcherEvent(root, "source_changed"), 3);
    await firstFlight.complete();

    const afterFirst = manager.getPreparedReadObservation(root);
    assert.equal(afterFirst.available, false);
    assert.equal(afterFirst.available ? undefined : afterFirst.reason, "watcher_event_pending");
    assert.equal(manager.getWatcherObservation(root).coverageGapSinceEpoch, undefined);

    await localManager.captureExternalSyncFlight(root).complete();

    const afterSecond = manager.getPreparedReadObservation(root);
    assert.equal(afterSecond.available, true);
    assert.equal(afterSecond.available ? afterSecond.observation.checkpointObservation : undefined, "checkpoint-after-sync");
});

test("read freshness reports an index snapshot, not unverified, until live tracking starts", async () => {
    const root = "/repo";
    const observation = "checkpoint-observation";
    const publication = {
        publicationId: "publication-3",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: observation,
            publicationId: "publication-3",
        }),
        getCurrentPublicationSourceObservation: () => observation,
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: { assertCurrent: () => {}, getCurrentOperation: () => undefined } as never,
    });
    const assess = () => manager.assessReadFreshness(root, 60_000, {
        preparedPublication: publication as never,
    });

    // A navigation-first session reads before any provider-backed call starts the watcher.
    const notStarted = await assess();
    assert.deepEqual(notStarted.sourceFreshness, {
        state: "index_snapshot",
        reason: "watcher_manager_not_started",
    });
    assert.deepEqual(buildFreshnessWarningCodes(notStarted), [
        WARNING_CODES.SOURCE_SERVED_FROM_INDEX_SNAPSHOT,
    ]);

    // A watcher that should be running but is not stays a real unverified state.
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    const inactive = await assess();
    assert.deepEqual(inactive.sourceFreshness, {
        state: "unverified",
        reason: "root_watcher_not_active",
    });
    assert.deepEqual(buildFreshnessWarningCodes(inactive), []);
});

test("periodic freshness skips a root whose full-index handoff just completed", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satori-handoff-fresh-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    const context = {
        listCurrentPublications: () => [publication],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: "publication-1",
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
    };
    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        updateCurrentOperation: () => { throw new Error("not used"); },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: false,
        mutationRuntime: mutationRuntime as never,
    });
    const internal = manager as unknown as {
        sourceObservationState: { completeHandoff: () => Promise<boolean> };
        syncCodebase: () => Promise<never>;
    };
    internal.sourceObservationState.completeHandoff = async () => true;
    let syncs = 0;
    internal.syncCodebase = async () => {
        syncs += 1;
        throw new Error("periodic pass must not sync a just-published root");
    };

    assert.equal(await manager.completeFullIndexSourceHandoff(root, {} as never), true);
    await manager.handleSyncIndex();

    assert.equal(syncs, 0);
});

test("periodic freshness skips a root that a read just proved unchanged with a full source comparison", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "satori-full-compare-fresh-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    const context = {
        listCurrentPublications: () => [publication],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: "publication-1",
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareAllSourceToFreshnessCheckpoint: async () => ({ status: "matches" }),
    };
    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        updateCurrentOperation: () => { throw new Error("not used"); },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: mutationRuntime as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, {
            observedEventEpoch: number;
            comparedThroughEventEpoch: number;
            latestEpochByReason: Map<string, number>;
            coverage: string;
            coverageGapSinceEpoch?: number;
        }>;
        syncCodebase: () => Promise<never>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    // A server restart leaves the startup coverage gap open.
    internal.watcherObservations.set(root, {
        observedEventEpoch: 0,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map(),
        coverage: "ready",
        coverageGapSinceEpoch: 0,
    });
    let syncs = 0;
    internal.syncCodebase = async () => {
        syncs += 1;
        throw new Error("periodic pass must not sync a root a read just proved unchanged");
    };

    await manager.assessReadFreshness(root, 60_000, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
    });
    assert.equal(manager.getWatcherObservation(root).coverageGapSinceEpoch, undefined);
    await manager.handleSyncIndex();

    assert.equal(syncs, 0);
});

test("a differing full source comparison reports its changed paths to the read", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: "publication-1",
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareAllSourceToFreshnessCheckpoint: async () => ({
            status: "differs",
            changedPaths: ["src/committed.ts", "src/removed.ts"],
        }),
    };
    const mutationRuntime = {
        assertCurrent: () => {},
        getCurrentOperation: () => undefined,
        updateCurrentOperation: () => { throw new Error("not used"); },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: false,
        mutationRuntime: mutationRuntime as never,
    });
    const reported: string[][] = [];

    const decision = await manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
        onSourceChangedPaths: (paths) => reported.push([...paths]),
    });

    assert.equal(decision.mode, "read_only");
    assert.deepEqual(decision.sourceFreshness, { state: "changed", reason: "full_source_comparison" });
    assert.deepEqual(reported, [["src/committed.ts", "src/removed.ts"]]);
});

function createDifferingComparisonManager() {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    let checkpointPublicationId = "publication-1";
    let comparisonCalls = 0;
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: checkpointPublicationId,
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareSourceObservationToFreshnessCheckpoint: async () => {
            comparisonCalls += 1;
            return { status: "differs" };
        },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: {
            assertCurrent: () => {},
            getCurrentOperation: () => undefined,
            updateCurrentOperation: () => { throw new Error("not used"); },
        } as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, unknown>;
        setWatcherCoverage(root: string, coverage: string): void;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 1,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 1]]),
        coverage: "ready",
    });
    return {
        root,
        manager,
        internal,
        assess: () => manager.assessReadFreshness(root, 60_000, { preparedPublication: publication as never }),
        comparisonCalls: () => comparisonCalls,
        setCheckpointPublication: (id: string) => { checkpointPublicationId = id; },
    };
}

test("read freshness reuses a differing source comparison until a watcher event arrives", async () => {
    const harness = createDifferingComparisonManager();
    const first = await harness.assess();
    await harness.assess();
    const third = await harness.assess();
    assert.equal(harness.comparisonCalls(), 1);
    assert.deepEqual(third.sourceFreshness, first.sourceFreshness, "reuse keeps the same decision");
    assert.equal(harness.manager.getWatcherObservation(harness.root).pending, true);

    harness.manager.recordWatcherEvent(harness.root, "source_changed");
    await harness.assess();
    assert.equal(harness.comparisonCalls(), 2);
});

test("read freshness compares again after a watcher restart or a new checkpoint", async () => {
    const restarted = createDifferingComparisonManager();
    await restarted.assess();
    // Events between a restart and `ready` are unobserved and bump no epoch.
    restarted.internal.setWatcherCoverage(restarted.root, "starting");
    restarted.internal.setWatcherCoverage(restarted.root, "ready");
    await restarted.assess();
    assert.equal(restarted.comparisonCalls(), 2);

    const republished = createDifferingComparisonManager();
    await republished.assess();
    republished.setCheckpointPublication("publication-2");
    await republished.assess();
    assert.equal(republished.comparisonCalls(), 2);
});

test("fullSourceComparison prefers stat-reusing observation once without duplicating pending-watcher scans", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    let observationCalls = 0;
    let fullHashCalls = 0;
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: "publication-1",
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareSourceObservationToFreshnessCheckpoint: async () => {
            observationCalls += 1;
            return { status: "matches" };
        },
        compareAllSourceToFreshnessCheckpoint: async () => {
            fullHashCalls += 1;
            return { status: "matches" };
        },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: {
            assertCurrent: () => {},
            getCurrentOperation: () => undefined,
            updateCurrentOperation: () => { throw new Error("not used"); },
        } as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, unknown>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "starting");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 0,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map(),
        coverage: "starting",
        coverageGapSinceEpoch: 0,
    });

    const decision = await manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
    });

    assert.equal(observationCalls, 1, "must run one stat-reusing scan, not two scans");
    assert.equal(fullHashCalls, 0, "must not force full-file re-hashing when observation comparison is available");
    assert.equal(decision.mode, "skipped_source_unchanged");
    assert.deepEqual(decision.sourceFreshness, {
        state: "index_snapshot",
        reason: "watcher_starting",
    });
});

test("fullSourceComparison coalesces concurrent calls for the same epoch and splits after a new watcher event", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    let comparisonCalls = 0;
    let inspectCalls = 0;
    let secondInspectDone!: () => void;
    const secondReadyToJoin = new Promise<void>((resolve) => { secondInspectDone = resolve; });
    let firstStarted!: () => void;
    const firstInFlight = new Promise<void>((resolve) => { firstStarted = resolve; });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => {
            inspectCalls += 1;
            if (inspectCalls === 2) {
                // Signal right after second caller's checkpoint check resolves so it joins the in-flight comparison.
                queueMicrotask(secondInspectDone);
            }
            return {
                status: "valid",
                observationToken: "checkpoint-observation",
                publicationId: "publication-1",
            };
        },
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareSourceObservationToFreshnessCheckpoint: async () => {
            comparisonCalls += 1;
            if (comparisonCalls === 1) {
                firstStarted();
                await gate;
            }
            return { status: "matches" };
        },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: {
            assertCurrent: () => {},
            getCurrentOperation: () => undefined,
            updateCurrentOperation: () => { throw new Error("not used"); },
        } as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, unknown>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 1,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 1]]),
        coverage: "ready",
    });

    const firstPromise = manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
    });
    await firstInFlight;
    const secondPromise = manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
    });
    await secondReadyToJoin;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(comparisonCalls, 1, "concurrent caller on same epoch must coalesce");

    // A new watcher event advances flightEpoch, so a third caller must not join the stale flight.
    assert.equal(manager.recordWatcherEvent(root, "source_changed"), 2);
    const thirdPromise = manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
    });

    releaseFirst();
    const [first, second, third] = await Promise.all([firstPromise, secondPromise, thirdPromise]);
    assert.equal(comparisonCalls, 2);
    assert.equal(first.mode, "skipped_source_unchanged");
    assert.equal(second.mode, "skipped_source_unchanged");
    assert.deepEqual(third.sourceFreshness, {
        state: "verified",
        reason: "full_source_comparison",
    });
});

test("fullSourceComparison reuses differing changedPaths until watcher event, restart, or new publication", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    let checkpointPublicationId = "publication-1";
    let comparisonCalls = 0;
    let currentPaths = ["src/a.ts", "src/b.ts"];
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: checkpointPublicationId,
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareSourceObservationToFreshnessCheckpoint: async () => {
            comparisonCalls += 1;
            return { status: "differs", changedPaths: currentPaths };
        },
    };
    const manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: {
            assertCurrent: () => {},
            getCurrentOperation: () => undefined,
            updateCurrentOperation: () => { throw new Error("not used"); },
        } as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, unknown>;
        setWatcherCoverage(root: string, coverage: string): void;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 1,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 1]]),
        coverage: "ready",
    });

    const reported: string[][] = [];
    const run = () => manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
        onSourceChangedPaths: (paths) => reported.push([...paths]),
    });

    const first = await run();
    const second = await run();
    assert.equal(comparisonCalls, 1, "second full comparison on same ready epoch must reuse differing result");
    assert.deepEqual(first.sourceFreshness, { state: "changed", reason: "full_source_comparison" });
    assert.deepEqual(second.sourceFreshness, first.sourceFreshness);
    assert.deepEqual(reported, [["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"]]);

    // Witness invalidation 1: watcher event
    currentPaths = ["src/a.ts", "src/c.ts"];
    manager.recordWatcherEvent(root, "source_changed");
    await run();
    assert.equal(comparisonCalls, 2);
    assert.deepEqual(reported[2], ["src/a.ts", "src/c.ts"]);

    // Witness invalidation 2: watcher restart
    internal.setWatcherCoverage(root, "starting");
    internal.setWatcherCoverage(root, "ready");
    await run();
    assert.equal(comparisonCalls, 3);

    // Witness invalidation 3: new checkpoint publication
    checkpointPublicationId = "publication-2";
    await run();
    assert.equal(comparisonCalls, 4);
});

test("assessReadFreshness rechecks differingComparison and snapshots fresh epoch after watcher event during checkpoint inspection", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    let manager!: SyncManager;
    let triggerEventInCheckpoint = false;
    let comparisonCalls = 0;
    let comparisonResult: { status: "differs"; changedPaths: string[] } | { status: "matches" } = {
        status: "differs",
        changedPaths: ["src/a.ts"],
    };
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => {
            if (triggerEventInCheckpoint) {
                triggerEventInCheckpoint = false;
                assert.equal(manager.recordWatcherEvent(root, "source_changed"), 2);
            }
            return {
                status: "valid",
                observationToken: "checkpoint-observation",
                publicationId: "publication-1",
            };
        },
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareSourceObservationToFreshnessCheckpoint: async () => {
            comparisonCalls += 1;
            return comparisonResult;
        },
    };
    manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: {
            assertCurrent: () => {},
            getCurrentOperation: () => undefined,
            updateCurrentOperation: () => { throw new Error("not used"); },
        } as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, {
            observedEventEpoch: number;
            comparedThroughEventEpoch: number;
            latestEpochByReason: Map<string, number>;
            coverage: string;
            differingComparison?: {
                publicationId: string;
                comparedEventEpoch: number;
                changedPaths?: readonly string[];
            };
        }>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 1,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 1]]),
        coverage: "ready",
    });

    // Populate differingComparison at epoch 1.
    const first = await manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
    });
    assert.equal(comparisonCalls, 1);
    assert.deepEqual(first.sourceFreshness, { state: "unverified", reason: "watcher_event_pending" });
    assert.equal(internal.watcherObservations.get(root)?.differingComparison?.comparedEventEpoch, 1);

    // Watcher event arrives during checkpoint inspection: must invalidate epoch-1 cache
    // and run with fresh epoch 2 so a match covers epoch 2 completely.
    triggerEventInCheckpoint = true;
    comparisonResult = { status: "matches" };
    const second = await manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
    });
    assert.equal(comparisonCalls, 2);
    assert.equal(manager.getWatcherObservation(root).observedEventEpoch, 2);
    assert.equal(manager.getWatcherObservation(root).comparedThroughEventEpoch, 2);
    assert.equal(manager.getWatcherObservation(root).pending, false);
    assert.deepEqual(second.sourceFreshness, { state: "verified", reason: "watcher_continuity" });
});

test("fullSourceComparison rechecks differingComparison and snapshots fresh epoch after watcher event during exact path comparison", async () => {
    const root = "/repo";
    const publication = {
        publicationId: "publication-1",
        publication: { status: "complete", canonicalRoot: root, policy: {} },
    };
    let manager!: SyncManager;
    let triggerEventInExactComparison = false;
    let fullComparisonCalls = 0;
    let currentPaths = ["src/a.ts"];
    const context = {
        listCurrentPublications: () => [],
        getCurrentPublication: () => publication,
        inspectSourceFreshnessCheckpoint: async () => ({
            status: "valid",
            observationToken: "checkpoint-observation",
            publicationId: "publication-1",
        }),
        getCurrentPublicationSourceObservation: () => "checkpoint-observation",
        compareSourcePathsToFreshnessCheckpoint: async () => {
            if (triggerEventInExactComparison) {
                triggerEventInExactComparison = false;
                assert.equal(manager.recordWatcherEvent(root, "source_changed"), 2);
            }
            return { status: "matches" };
        },
        compareSourceObservationToFreshnessCheckpoint: async () => {
            fullComparisonCalls += 1;
            return { status: "differs", changedPaths: currentPaths };
        },
    };
    manager = new SyncManager(context as never, {
        watchEnabled: true,
        mutationRuntime: {
            assertCurrent: () => {},
            getCurrentOperation: () => undefined,
            updateCurrentOperation: () => { throw new Error("not used"); },
        } as never,
    });
    const internal = manager as unknown as {
        watcherModeStarted: boolean;
        watchedCodebases: Set<string>;
        watchers: Map<string, unknown>;
        watcherLifecycleStates: Map<string, string>;
        watcherObservations: Map<string, {
            observedEventEpoch: number;
            comparedThroughEventEpoch: number;
            latestEpochByReason: Map<string, number>;
            coverage: string;
            differingComparison?: {
                publicationId: string;
                comparedEventEpoch: number;
                changedPaths?: readonly string[];
            };
        }>;
    };
    internal.watcherModeStarted = true;
    internal.watchedCodebases.add(root);
    internal.watchers.set(root, {});
    internal.watcherLifecycleStates.set(root, "ready");
    internal.watcherObservations.set(root, {
        observedEventEpoch: 1,
        comparedThroughEventEpoch: 0,
        latestEpochByReason: new Map([["source_changed", 1]]),
        coverage: "ready",
    });

    const reported: string[][] = [];
    const run = () => manager.assessReadFreshness(root, 0, {
        preparedPublication: publication as never,
        fullSourceComparison: true,
        exactSourceComparisonPaths: ["src/other.ts"],
        onSourceChangedPaths: (paths) => reported.push([...paths]),
    });

    // Seed differingComparison at epoch 1.
    await run();
    assert.equal(fullComparisonCalls, 1);
    assert.equal(internal.watcherObservations.get(root)?.differingComparison?.comparedEventEpoch, 1);
    assert.deepEqual(reported, [["src/a.ts"]]);

    // Watcher event arrives while exact-path comparison is in flight:
    // must invalidate epoch-1 differingComparison and snapshot epoch 2 for fullSourceComparison.
    triggerEventInExactComparison = true;
    currentPaths = ["src/a.ts", "src/b.ts"];
    await run();
    assert.equal(fullComparisonCalls, 2);
    assert.equal(internal.watcherObservations.get(root)?.differingComparison?.comparedEventEpoch, 2);
    assert.deepEqual(reported[1], ["src/a.ts", "src/b.ts"]);

    // Subsequent call at epoch 2 with no new event reuses the epoch-2 differingComparison.
    await run();
    assert.equal(fullComparisonCalls, 2);
    assert.deepEqual(reported[2], ["src/a.ts", "src/b.ts"]);
});
