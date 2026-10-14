import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { MutationExecutorStillActiveError, MutationLeaseCoordinator } from './root-mutation-coordinator';
import { RootMutationRuntime } from './root-mutation-runtime';

test('the last operation retains its indexing budget hint after runtime restart', async (t) => {
    const { root, stateDir } = fixture(t);
    const memoryBudget = { budgetMb: 2048, hint: 'Memory budget 2.0 GiB: TypeScript projects run one at a time.' };
    const runtime = new RootMutationRuntime({ stateDir });
    await runtime.run(root, 'create', () => {
        runtime.recordIndexingMemoryBudget(root, memoryBudget);
        assert.deepEqual(runtime.getCurrentOperation(root)?.memoryBudget, memoryBudget);
        runtime.updateCurrentOperation(root, 'completed', { progress: 100 });
    });
    const restarted = new RootMutationRuntime({ stateDir });
    assert.deepEqual(restarted.getOperation(root)?.memoryBudget, memoryBudget);
});

function fixture(t: TestContext): { root: string; stateDir: string; statePath: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mutation-receipt-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'repo');
    fs.mkdirSync(root);
    const canonicalRoot = fs.realpathSync(root);
    const stateDir = path.join(directory, 'leases');
    return {
        root,
        stateDir,
        statePath: path.join(stateDir, `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`),
    };
}

test('failed lock owner write closes the descriptor and removes the incomplete lock', (t) => {
    const { root, stateDir, statePath } = fixture(t);
    const lockPath = statePath.replace(/\.json$/, '.lock');
    const coordinator = new MutationLeaseCoordinator({ stateDir });
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    const failure = Object.assign(new Error('injected lock ENOSPC'), { code: 'ENOSPC' });
    let lockDescriptor: number | undefined;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
        const descriptor = originalOpen(...args);
        if (args[0] === lockPath) lockDescriptor = descriptor;
        return descriptor;
    });
    t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
        if (args[0] === lockDescriptor) throw failure;
        return originalWrite(...args);
    });
    try {
        assert.throws(() => coordinator.acquire(root, 'create'), (error) => error === failure);
        assert.ok(lockDescriptor !== undefined);
        assert.throws(() => fs.fstatSync(lockDescriptor!), { code: 'EBADF' });
        assert.equal(fs.existsSync(lockPath), false);
        t.mock.restoreAll();
        const acquired = coordinator.acquire(root, 'create');
        assert.ok(acquired.acquired);
        coordinator.release(acquired.lease);
    } finally {
        // The failing baseline must not leak the injected descriptor either.
        if (lockDescriptor !== undefined) {
            try { fs.closeSync(lockDescriptor); } catch { /* Already closed. */ }
        }
    }
});

test('malformed locks are reclaimable only after the lock wait interval', (t) => {
    const { stateDir, statePath } = fixture(t);
    const lockPath = statePath.replace(/\.json$/, '.lock');
    fs.mkdirSync(stateDir);
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const coordinator = new MutationLeaseCoordinator({ stateDir, lockWaitMs: 2_000 });
    const internals = coordinator as unknown as { shouldBreakLock(lockPath: string): boolean };
    for (const content of ['', '{"pid":', '{}', '{"pid":"invalid"}']) {
        fs.writeFileSync(lockPath, content);
        fs.utimesSync(lockPath, new Date(now), new Date(now));
        assert.equal(internals.shouldBreakLock(lockPath), false, 'fresh malformed lock stays protected');
        fs.utimesSync(lockPath, new Date(now - 2_001), new Date(now - 2_001));
        assert.equal(internals.shouldBreakLock(lockPath), true, 'stale malformed lock is reclaimable');
    }
});

for (const action of ['create', 'reindex'] as const) {
    test(`released failed ${action} remains available through a restarted runtime`, async (t) => {
        const { root, stateDir } = fixture(t);
        const runtime = new RootMutationRuntime({ stateDir });
        await assert.rejects(runtime.run(root, action, (execution) => {
            execution.update('writing', { progress: 42 });
            execution.update('failed', { error: 'collection write failed' });
            throw new Error('collection write failed');
        }), /collection write failed/);
        const failed = runtime.getOperation(root);
        assert.equal(failed?.action, action);
        assert.equal(failed?.phase, 'failed');
        assert.equal(failed?.progress, 42);
        assert.equal(failed?.error, 'collection write failed');

        const restarted = new RootMutationRuntime({ stateDir });
        assert.deepEqual(restarted.getOperation(root), failed);
        assert.equal(restarted.getActiveMutation(root), undefined);
        await restarted.run(root, action, (execution) => {
            assert.equal(new RootMutationRuntime({ stateDir }).getOperation(root), undefined);
            assert.equal(runtime.getOperation(root), undefined);
            execution.update('completed', { progress: 100 });
        });
        assert.equal(new RootMutationRuntime({ stateDir }).getOperation(root)?.phase, 'completed');
    });
}

test('terminal receipt is published only when the bound executor is quiescent', (t) => {
    const { root, stateDir } = fixture(t);
    const live = new Set([101, 202]);
    const options = {
        stateDir,
        currentProcess: { pid: 101, processStartTime: 'parent' },
        processInspector: { inspect: (pid: number) => live.has(pid) ? { pid, processStartTime: String(pid) } : null },
    };
    const coordinator = new MutationLeaseCoordinator(options);
    const acquired = coordinator.acquire(root, 'create');
    assert.ok(acquired.acquired);
    const lease = coordinator.bindExecutor(acquired.lease, { pid: 202 });
    const failed = coordinator.updateOperation(lease, 'failed', { error: 'worker failure' });
    assert.throws(() => coordinator.release(lease), MutationExecutorStillActiveError);
    assert.equal(new MutationLeaseCoordinator(options).getOperation(root), undefined);
    assert.ok(coordinator.isCurrent(lease));
    live.delete(202);
    assert.equal(coordinator.release(lease), true);
    assert.deepEqual(new MutationLeaseCoordinator(options).getOperation(root), failed);
    const next = coordinator.acquire(root, 'reindex');
    assert.ok(next.acquired);
    assert.equal(coordinator.release(lease), false);
    assert.ok(coordinator.isCurrent(next.lease));
    assert.equal(new MutationLeaseCoordinator(options).getOperation(root), undefined);
    coordinator.release(next.lease);
});

test('durable terminal receipt rejects malformed data and mismatched ownership', async (t) => {
    const { root, stateDir, statePath } = fixture(t);
    const runtime = new RootMutationRuntime({ stateDir });
    await runtime.run(root, 'create', (execution) => execution.update('failed', { progress: 7, error: 'failed' }));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const receipt = runtime.getOperation(root);
    assert.ok(receipt);
    for (const update of [
        { canonicalRoot: `${root}-other` },
        { generation: receipt.generation + 1 },
        { phase: 'writing' },
        { action: 'unknown' },
        { id: 5 },
        { progress: 101 },
        { error: false },
        { acceptedAt: null },
        { updatedAt: null },
        { heartbeatAt: false },
        { cancelReason: false },
    ]) {
        fs.writeFileSync(statePath, JSON.stringify({ ...state, terminalOperation: { ...receipt, ...update } }));
        assert.throws(() => new RootMutationRuntime({ stateDir }).getOperation(root), /Invalid mutation terminal operation/);
    }
    fs.writeFileSync(statePath, JSON.stringify({ ...state, terminalOperation: undefined }));
    assert.equal(new RootMutationRuntime({ stateDir }).getOperation(root), undefined);
    await new RootMutationRuntime({ stateDir }).run(root, 'reindex', () => undefined);
});

test('lease state honours SATORI_STATE_ROOT when no stateDir is given', (t) => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-fake-home-'));
    const configuredRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-configured-state-'));
    const rootBase = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lease-root-'));
    const previousHome = process.env.HOME;
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.HOME = fakeHome;
    process.env.SATORI_STATE_ROOT = configuredRoot;
    t.after(() => {
        if (previousHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = previousHome;
        }
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(fakeHome, { recursive: true, force: true });
        fs.rmSync(configuredRoot, { recursive: true, force: true });
        fs.rmSync(rootBase, { recursive: true, force: true });
    });
    const root = path.join(rootBase, 'repo');
    fs.mkdirSync(root);
    const coordinator = new MutationLeaseCoordinator();
    const acquired = coordinator.acquire(root, 'create');
    assert.ok(acquired.acquired);
    assert.equal(coordinator.release(acquired.lease), true);
    const canonicalRoot = fs.realpathSync(root);
    const leaseFile = path.join(
        configuredRoot,
        'runtime',
        'mutation-leases',
        `${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}.json`,
    );
    assert.ok(fs.existsSync(leaseFile), `expected lease file at ${leaseFile}`);
    assert.deepEqual(fs.readdirSync(fakeHome), []);
});

for (const phase of ['release', 'stale', 'write-failure'] as const) {
    test(`root mutex preserves a replacement lock during ${phase}`, (t) => {
        const { root, stateDir, statePath } = fixture(t);
        const lockPath = statePath.replace(/\.json$/, '.lock');
        const displaced = `${lockPath}.displaced`;
        const replacement = '{"pid":123,"processStartTime":"replacement"}';
        const failure = new Error('injected owner write failure');
        const replace = () => {
            fs.renameSync(lockPath, displaced);
            fs.writeFileSync(lockPath, replacement);
        };
        const coordinator = new MutationLeaseCoordinator({ stateDir, lockWaitMs: 0, currentProcess: { pid: process.pid },
            processInspector: { inspect: () => { replace(); return null; } },
        });
        const internals = coordinator as unknown as { withRootLock<T>(root: string, fn: () => T): T };
        fs.mkdirSync(stateDir);
        if (phase === 'stale') {
            fs.writeFileSync(lockPath, '{"pid":123}');
            const now = Date.now();
            let calls = 0;
            t.mock.method(Date, 'now', () => now + (calls++ < 2 ? 0 : 1));
            assert.throws(() => internals.withRootLock(root, () => assert.fail('must not acquire replacement')), /Timed out/);
        } else if (phase === 'write-failure') {
            const originalWrite = fs.writeFileSync;
            t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
                if (typeof args[0] === 'number') { replace(); throw failure; }
                return originalWrite(...args);
            });
            assert.throws(() => internals.withRootLock(root, () => assert.fail('write failed')), (error) => error === failure);
        } else {
            internals.withRootLock(root, replace);
        }
        assert.equal(fs.readFileSync(lockPath, 'utf8'), replacement);
    });
}
