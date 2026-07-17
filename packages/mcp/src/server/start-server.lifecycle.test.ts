import test from "node:test";
import assert from "node:assert/strict";
import { runPostConnectStartupLifecycle } from "./start-server.js";

function createLifecycleDeps() {
    let verifyCalls = 0;
    const events: string[] = [];

    return {
        deps: {
            verifyCloudState: async () => {
                verifyCalls += 1;
                events.push("verify");
            },
            onVerifyCloudStateError: () => {
                events.push("verify_error");
            },
        },
        getCounts: () => ({
            verifyCalls,
            events: events.slice(),
        }),
    };
}

test("runPostConnectStartupLifecycle runs one-shot recovery but skips loops in cli mode", async () => {
    const { deps, getCounts } = createLifecycleDeps();

    await runPostConnectStartupLifecycle("cli", deps);

    const counts = getCounts();
    assert.equal(counts.verifyCalls, 1);
    assert.deepEqual(counts.events, ["verify"]);
});

test("runPostConnectStartupLifecycle performs no recovery or loops in postflight mode", async () => {
    const { deps, getCounts } = createLifecycleDeps();

    await runPostConnectStartupLifecycle("postflight", deps);

    assert.deepEqual(getCounts(), {
        verifyCalls: 0,
        events: [],
    });
});

test("runPostConnectStartupLifecycle recovers in mcp mode without starting local-only sync loops", async () => {
    const { deps, getCounts } = createLifecycleDeps();

    await runPostConnectStartupLifecycle("mcp", deps);

    const counts = getCounts();
    assert.equal(counts.verifyCalls, 1);
    assert.deepEqual(counts.events, ["verify"]);
});

test("runPostConnectStartupLifecycle handles cli recovery errors without starting loops", async () => {
    const { deps, getCounts } = createLifecycleDeps();
    deps.verifyCloudState = async () => {
        throw new Error("probe failure");
    };

    await runPostConnectStartupLifecycle("cli", deps);

    const counts = getCounts();
    assert.equal(counts.verifyCalls, 0);
    assert.deepEqual(counts.events, ["verify_error"]);
});
