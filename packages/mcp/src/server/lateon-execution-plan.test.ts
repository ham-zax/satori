import assert from "node:assert/strict";
import test from "node:test";
import { planLateOnExecution } from "./lateon-execution-plan.js";

const GIB = 1024 * 1024 * 1024;

test("LateOn execution plan adapts sessions and threads to the host's CPUs", () => {
    const plans = [1, 2, 4, 6, 8, 12, 16, 24, 32, 64].map((logicalCpus) => {
        const plan = planLateOnExecution({ logicalCpus, availableMemoryBytes: 64 * GIB });
        return `${logicalCpus}: ${plan.encoderSessions}x${plan.intraOpThreads}`;
    });
    assert.deepEqual(plans, [
        "1: 1x1",
        "2: 2x1",
        "4: 4x1",
        "6: 4x1",
        "8: 4x2",
        "12: 4x2",
        "16: 4x2",
        "24: 6x2",
        "32: 8x2",
        "64: 8x2",
    ]);
});

test("LateOn execution plan trades sessions for threads when free memory is short", () => {
    assert.deepEqual(
        planLateOnExecution({ logicalCpus: 16, availableMemoryBytes: 2 * GIB }),
        { encoderSessions: 2, intraOpThreads: 4 },
    );
    assert.deepEqual(
        planLateOnExecution({ logicalCpus: 16, availableMemoryBytes: 0.5 * GIB }),
        { encoderSessions: 1, intraOpThreads: 4 },
    );
});

test("LateOn execution plan falls back to one single-threaded session for unusable host readings", () => {
    for (const logicalCpus of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.deepEqual(
            planLateOnExecution({ logicalCpus, availableMemoryBytes: 64 * GIB }),
            { encoderSessions: 1, intraOpThreads: 1 },
        );
    }
});
