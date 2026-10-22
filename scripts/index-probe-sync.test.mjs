import test from 'node:test';
import assert from 'node:assert/strict';
import { requestCleanupSync } from './perf/index-probe-sync.mjs';

const accepted = { status: 'ok' };
const blocked = (id = 'watcher', action = 'sync') => ({
    status: 'blocked', reason: 'mutation_in_progress', hints: { activeMutation: { id, action } },
});

function scenario(responses, operations, waitTimeoutMs = 1000) {
    let time = 0;
    const events = [];
    return {
        events,
        run: () => requestCleanupSync({
            requestSync: async () => {
                events.push('sync');
                assert.ok(responses.length, 'unexpected sync request');
                return responses.shift();
            },
            currentOperation: async () => {
                assert.ok(operations.length, 'unexpected status request');
                const operation = operations.shift();
                events.push(operation?.phase ?? 'missing');
                return operation;
            },
            waitTimeoutMs,
            now: () => time,
            sleep: async (ms) => { time += ms; },
        }),
    };
}

test('cleanup requests a new sync after watcher sync completes', async () => {
    const check = scenario([blocked(), accepted], [
        { id: 'watcher', phase: 'writing' },
        { id: 'watcher', phase: 'publishing' },
        { id: 'watcher', phase: 'completed' },
    ]);
    assert.equal(await check.run(), accepted);
    assert.deepEqual(check.events, ['sync', 'writing', 'publishing', 'completed', 'sync']);
});

test('cleanup waits again when terminal status precedes lease release', async () => {
    const check = scenario([blocked(), blocked(), accepted], [
        { id: 'watcher', phase: 'completed' },
        { id: 'watcher', phase: 'completed' },
    ]);
    assert.equal(await check.run(), accepted);
    assert.deepEqual(check.events, ['sync', 'completed', 'sync', 'completed', 'sync']);
});

test('cleanup follows another sync that wins the next lease', async () => {
    const check = scenario([blocked(), blocked('next'), accepted], [
        { id: 'next', phase: 'writing' },
        { id: 'next', phase: 'completed' },
    ]);
    assert.equal(await check.run(), accepted);
    assert.deepEqual(check.events, ['sync', 'writing', 'sync', 'completed', 'sync']);
});

test('cleanup retries after each terminal phase or missing operation', async () => {
    for (const phase of ['completed', 'failed', 'cancelled', 'blocked', undefined]) {
        const check = scenario([blocked(), accepted], [phase ? { id: 'watcher', phase } : undefined]);
        assert.equal(await check.run(), accepted);
        assert.equal(check.events.filter((event) => event === 'sync').length, 2);
    }
});

test('cleanup returns unrelated refusals without waiting or retrying', async () => {
    for (const response of [
        accepted,
        { status: 'error' },
        { ...blocked(), reason: 'runtime_owner_conflict' },
        blocked('other', 'reindex'),
        blocked('other', 'clear'),
        blocked(undefined, 'create'),
        { status: 'blocked', reason: 'mutation_in_progress' },
        blocked(''),
    ]) {
        const check = scenario([response], []);
        assert.equal(await check.run(), response);
        assert.deepEqual(check.events, ['sync']);
    }
});

test('cleanup times out while a sync stays active', async () => {
    const check = scenario([blocked()], [{ id: 'watcher', phase: 'writing' }], 200);
    await assert.rejects(check.run(), /cleanup sync remained blocked for 200 ms/);
    assert.deepEqual(check.events, ['sync', 'writing']);
});

test('cleanup shares one deadline across repeated lease conflicts', async () => {
    const check = scenario([blocked(), blocked()], [{ id: 'watcher', phase: 'completed' }], 200);
    await assert.rejects(check.run(), /cleanup sync remained blocked for 200 ms/);
    assert.deepEqual(check.events, ['sync', 'completed', 'sync']);
});

test('cleanup rejects a missing budget instead of waiting forever', async () => {
    for (const waitTimeoutMs of [undefined, 0, -1, Number.NaN]) {
        let synced = 0;
        await assert.rejects(requestCleanupSync({
            requestSync: async () => {
                synced += 1;
                return accepted;
            },
            currentOperation: async () => assert.fail('must not poll without a budget'),
            waitTimeoutMs,
        }), /requires a positive waitTimeoutMs/);
        assert.equal(synced, 0);
    }
});
