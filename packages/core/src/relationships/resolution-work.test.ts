import assert from 'node:assert/strict';
import test from 'node:test';

import { drainResolutionWorkAsync, type RelationshipResolutionWork } from './resolution-work';

function* countingWork(totalCalls: number, onStep: (completedCalls: number) => void = () => undefined): RelationshipResolutionWork<number> {
    for (let completedCalls = 1; completedCalls <= totalCalls; completedCalls++) {
        onStep(completedCalls);
        yield { file: 'src/app.py', completedCalls, totalCalls };
    }
    return totalCalls;
}

test('the lease is checked once per yield, not once per resolved call', async () => {
    let checks = 0;
    const result = await drainResolutionWorkAsync(countingWork(1_000), { assertCurrent: () => { checks++; } });
    assert.equal(result, 1_000);
    // Start, at most one check per 64 calls plus the first and last progress, and the return.
    assert.ok(checks >= 3, `expected the start, yield and return checks, got ${checks}`);
    assert.ok(checks <= 2 + Math.ceil(1_000 / 64) + 2, `expected bounded checks, got ${checks}`);
});

test('a lease lost before the drain starts stops it before any call resolves', async () => {
    const lost = new Error('lease lost');
    let steps = 0;
    await assert.rejects(
        drainResolutionWorkAsync(countingWork(10, () => { steps++; }), { assertCurrent: () => { throw lost; } }),
        (error) => error === lost,
    );
    assert.equal(steps, 0);
});

test('a lease lost between yields is detected at the next yield and before the result returns', async () => {
    const lost = new Error('lease lost');
    for (const lostAtCall of [5, 200, 1_000]) {
        let current = true;
        let steps = 0;
        await assert.rejects(
            drainResolutionWorkAsync(countingWork(1_000, (completedCalls) => {
                steps = completedCalls;
                if (completedCalls === lostAtCall) current = false;
            }), { assertCurrent: () => { if (!current) throw lost; } }),
            (error) => error === lost,
            `lease lost at call ${lostAtCall}`,
        );
        assert.ok(steps - lostAtCall < 64, `detected ${steps - lostAtCall} calls late`);
    }
});

test('a lease lost after the last yield is detected before the result returns', async () => {
    const lost = new Error('lease lost');
    let current = true;
    function* endsEarly(): RelationshipResolutionWork<string> {
        // Work may finish below its reported total, so no final progress yield runs.
        for (let completedCalls = 1; completedCalls <= 10; completedCalls++) {
            if (completedCalls === 10) current = false;
            yield { file: 'src/app.py', completedCalls, totalCalls: 20 };
        }
        return 'unpublished';
    }
    await assert.rejects(
        drainResolutionWorkAsync(endsEarly(), { assertCurrent: () => { if (!current) throw lost; } }),
        (error) => error === lost,
    );
});
