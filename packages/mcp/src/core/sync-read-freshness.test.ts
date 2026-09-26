import assert from "node:assert/strict";
import test from "node:test";

import { SyncManager } from "./sync.js";

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
