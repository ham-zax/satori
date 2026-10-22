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
    assert.deepEqual(buildFreshnessWarningCodes(inactive), [
        WARNING_CODES.SOURCE_FRESHNESS_UNVERIFIED,
    ]);
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
