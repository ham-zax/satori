import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { MutationExecutorStillActiveError, MutationLeaseCoordinator } from './root-mutation-coordinator';
import { RootMutationRuntime } from './root-mutation-runtime';

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
