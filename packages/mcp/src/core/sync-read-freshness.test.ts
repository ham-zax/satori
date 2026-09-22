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
