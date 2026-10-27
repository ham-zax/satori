import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SyncWorkerStandby } from './supervised-sync-worker.js';

async function waitFor(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

function absent(pid: number): boolean {
    try { process.kill(-pid, 0); return false; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
    }
}

async function fixture(run: (standby: SyncWorkerStandby, pids: () => number[], root: string) => Promise<void>, delayed = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-standby-'));
    const workerPath = path.join(root, 'worker.cjs');
    const pidFile = path.join(root, 'pids');
    fs.writeFileSync(workerPath, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('SIGUSR1', () => process.exit(0));
process.on('message', message => {
    if (message.type === 'mutation_worker_cancel') {
        fs.writeFileSync(${JSON.stringify(path.join(root, 'cancelled-'))} + process.pid, '');
        if (!${delayed}) process.exit(0);
    }
});
fs.writeFileSync(${JSON.stringify(path.join(root, 'ready-'))} + process.pid, '');
setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(root, 'exit'))})) process.exit(0); }, 10);
`);
    const standby = new SyncWorkerStandby({ workerPath });
    const pids = () => fs.existsSync(pidFile)
        ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number)
        : [];
    const cleanup = async () => {
        if (delayed) for (const pid of pids()) {
            try { process.kill(pid, 'SIGUSR1'); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
        }
        await standby.close();
        for (const pid of pids()) await waitFor(() => absent(pid), `group ${pid} to exit`);
        fs.rmSync(root, { recursive: true, force: true });
    };
    try { await run(standby, pids, root); }
    finally { await cleanup(); }
}

test('release and repeated close drain an already discarded worker', async () => fixture(async (standby, pids, root) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'standby');
    const [pid] = pids();
    await waitFor(() => fs.existsSync(path.join(root, `ready-${pid}`)), 'worker ready');
    let released = false;
    let closed = 0;
    const release = Promise.resolve(standby.release('a')).then(() => { released = true; });
    await waitFor(() => fs.existsSync(path.join(root, `cancelled-${pid}`)), 'cancellation');
    const close1 = standby.close().then(() => { closed++; });
    const close2 = standby.close().then(() => { closed++; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const snapshot = { released, closed, alive: !absent(pid) };
    process.kill(pid, 'SIGUSR1');
    await Promise.all([release, close1, close2]);
    assert.deepEqual(snapshot, { released: false, closed: 0, alive: true });
    assert.equal(absent(pid), true);
}, true));

test('replacement waits for the retiring group and starts only the latest root', async () => fixture(async (standby, pids, root) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'first standby');
    const [first] = pids();
    await waitFor(() => fs.existsSync(path.join(root, `ready-${first}`)), 'worker ready');
    standby.prepare('b');
    standby.prepare('c');
    await waitFor(() => fs.existsSync(path.join(root, `cancelled-${first}`)), 'first cancellation');
    const premature = standby.take('c');
    if (premature) premature.worker.requestCancellation('test cleanup');
    const countBeforeExit = pids().length;
    process.kill(first, 'SIGUSR1');
    if (premature) {
        await waitFor(() => fs.existsSync(path.join(root, `ready-${premature.worker.executor.pid}`)), 'premature worker ready');
        process.kill(premature.worker.executor.pid, 'SIGUSR1');
        await premature.worker.completion.catch(() => undefined);
    }
    assert.equal(premature, undefined);
    assert.equal(countBeforeExit, 1);
    await waitFor(() => pids().length === 2, 'latest replacement');
    assert.equal(standby.take('b'), undefined);
    const latest = standby.take('c');
    assert.ok(latest);
    latest.worker.requestCancellation('test cleanup');
    await waitFor(() => fs.existsSync(path.join(root, `cancelled-${pids()[1]}`)), 'latest cancellation');
    process.kill(pids()[1], 'SIGUSR1');
    await latest.worker.completion.catch(() => undefined);
}, true));

test('release cancels a pending matching root while draining the old root', async () => fixture(async (standby, pids, root) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'first standby');
    const [first] = pids();
    await waitFor(() => fs.existsSync(path.join(root, `ready-${first}`)), 'worker ready');
    standby.prepare('b');
    await waitFor(() => fs.existsSync(path.join(root, `cancelled-${first}`)), 'first cancellation');
    await standby.release('b');
    let drained = false;
    const draining = Promise.resolve(standby.release('a')).then(() => { drained = true; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const snapshot = { drained, pending: standby.take('b') };
    if (snapshot.pending) snapshot.pending.worker.requestCancellation('test cleanup');
    process.kill(first, 'SIGUSR1');
    if (snapshot.pending) {
        await waitFor(() => fs.existsSync(path.join(root, `cancelled-${snapshot.pending!.worker.executor.pid}`)), 'pending cleanup');
        process.kill(snapshot.pending.worker.executor.pid, 'SIGUSR1');
        await snapshot.pending.worker.completion.catch(() => undefined);
    }
    await draining;
    assert.equal(snapshot.drained, false);
    assert.equal(snapshot.pending, undefined);
    assert.equal(pids().length, 1);
}, true));

test('close clears a pending replacement and drains the retiring group', async () => fixture(async (standby, pids, root) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'first standby');
    const [first] = pids();
    await waitFor(() => fs.existsSync(path.join(root, `ready-${first}`)), 'worker ready');
    standby.prepare('b');
    await waitFor(() => fs.existsSync(path.join(root, `cancelled-${first}`)), 'first cancellation');
    let closed = false;
    const closing = standby.close().then(() => { closed = true; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const beforeExit = closed;
    process.kill(first, 'SIGUSR1');
    for (const pid of pids().slice(1)) {
        await waitFor(() => fs.existsSync(path.join(root, `cancelled-${pid}`)), 'replacement cancellation');
        process.kill(pid, 'SIGUSR1');
    }
    await closing;
    assert.equal(beforeExit, false);
    assert.equal(pids().length, 1);
    assert.equal(standby.take('b'), undefined);
}, true));

test('release stops only the matching root', async () => fixture(async (standby, pids) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'standby');
    const [pid] = pids();
    standby.release('b');
    assert.equal(absent(pid), false);
    standby.release('a');
    await waitFor(() => absent(pid), 'released group');
}));

test('preparing another root replaces the standby', async () => fixture(async (standby, pids) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'first standby');
    const [first] = pids();
    standby.prepare('b');
    await waitFor(() => pids().length === 2 && absent(first), 'replacement');
    assert.equal(absent(pids()[1]), false);
}));

test('preparing the same root reuses the live standby', async () => fixture(async (standby, pids) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'standby');
    standby.prepare('a');
    const taken = standby.take('a');
    assert.ok(taken);
    assert.equal(taken.worker.executor.pid, pids()[0]);
    assert.equal(pids().length, 1);
    taken.worker.requestCancellation('test cleanup');
    await taken.worker.completion.catch(() => undefined);
}));

test('close stops the standby and prevents later preparation', async () => fixture(async (standby, pids) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'standby');
    const [pid] = pids();
    await standby.close();
    assert.equal(absent(pid), true);
    standby.prepare('b');
    assert.equal(standby.take('b'), undefined);
    assert.equal(pids().length, 1);
}));

test('take transfers a live standby once and rejects other roots', async () => fixture(async (standby, pids) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'standby');
    assert.equal(standby.take('b'), undefined);
    const taken = standby.take('a');
    assert.ok(taken);
    assert.equal(taken.worker.executor.pid, pids()[0]);
    assert.equal(standby.take('a'), undefined);
    taken.worker.requestCancellation('test cleanup');
    await taken.worker.completion.catch(() => undefined);
}));

test('take rejects a standby that exited on its own', async () => fixture(async (standby, pids, root) => {
    standby.prepare('a');
    await waitFor(() => pids().length === 1, 'standby');
    fs.writeFileSync(path.join(root, 'exit'), '');
    await waitFor(() => absent(pids()[0]), 'exited standby');
    assert.equal(standby.take('a'), undefined);
}));
