import test from "node:test";
import assert from "node:assert/strict";
import { runPostConnectStartupLifecycle } from "./start-server.js";

function createLifecycleDeps() {
    let verifyCalls = 0;
    let bgCalls = 0;
    let watcherCalls = 0;
    const events: string[] = [];

    return {
        deps: {
            watchSyncEnabled: true,
            verifyCloudState: async () => {
                verifyCalls += 1;
                events.push("verify");
            },
            onVerifyCloudStateError: () => {
                events.push("verify_error");
            },
            syncManager: {
                startBackgroundSync: () => {
                    bgCalls += 1;
                    events.push("bg");
                },
                startWatcherMode: async () => {
                    watcherCalls += 1;
                    events.push("watcher");
                }
            }
        },
        getCounts: () => ({
            verifyCalls,
            bgCalls,
            watcherCalls,
            events: events.slice(),
        }),
    };
}

test("runPostConnectStartupLifecycle skips startup loops and reconciliation in cli mode", async () => {
    const { deps, getCounts } = createLifecycleDeps();

    await runPostConnectStartupLifecycle("cli", deps);

    const counts = getCounts();
    assert.equal(counts.verifyCalls, 0);
    assert.equal(counts.bgCalls, 0);
    assert.equal(counts.watcherCalls, 0);
    assert.deepEqual(counts.events, []);
});

test("runPostConnectStartupLifecycle starts reconciliation and loops in mcp mode", async () => {
    const { deps, getCounts } = createLifecycleDeps();

    await runPostConnectStartupLifecycle("mcp", deps);

    const counts = getCounts();
    assert.equal(counts.verifyCalls, 1);
    assert.equal(counts.bgCalls, 1);
    assert.equal(counts.watcherCalls, 1);
});

