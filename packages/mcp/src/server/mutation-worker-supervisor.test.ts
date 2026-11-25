import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSupervisedMutationWorker } from './mutation-worker-supervisor.js';

function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds} ms.`)), milliseconds);
        }),
    ]).finally(() => clearTimeout(timer));
}

test('unexpected worker signal remains visible in the supervised failure', { skip: process.platform !== 'linux' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-signal-'));
    const workerPath = path.join(root, 'worker.cjs');
    fs.writeFileSync(workerPath, `
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
setInterval(() => undefined, 1000);
`);
    try {
        const worker = spawnSupervisedMutationWorker({ operationId: 'signal-fixture', workerPath });
        await worker.ready;
        process.kill(worker.executor.pid, 'SIGKILL');
        await assert.rejects(worker.completion, /without a terminal operation message \(signal SIGKILL\)/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('completed worker cannot be cancelled by the execution watchdog while terminal shutdown is bounded', { skip: process.platform !== 'linux' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-completed-live-'));
    const workerPath = path.join(root, 'worker.cjs');
    fs.writeFileSync(workerPath, `
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', (message) => {
    if (message.type !== 'mutation_worker_start') return;
    process.send({ type: 'mutation_worker_completed', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
    setInterval(() => undefined, 1000);
});
`);
    let noProgressCount = 0;
    try {
        let completedCount = 0;
        const worker = spawnSupervisedMutationWorker({
            operationId: 'completed-live-fixture',
            workerPath,
            noProgressTimeoutMs: 25,
            cancelGraceMs: 20,
            terminalShutdownTimeoutMs: 40,
            onNoProgress: () => noProgressCount += 1,
            onCompleted: () => completedCount += 1,
        });
        await worker.ready;
        worker.start();
        await withDeadline(worker.completion, 2_000);
        assert.equal(completedCount, 1);
        assert.equal(noProgressCount, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('terminal worker failure is preserved while terminal shutdown is bounded', { skip: process.platform !== 'linux' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-failed-live-'));
    const workerPath = path.join(root, 'worker.cjs');
    fs.writeFileSync(workerPath, `
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', (message) => {
    if (message.type !== 'mutation_worker_start') return;
    process.send({ type: 'mutation_worker_failed', operationId: process.env.SATORI_MUTATION_OPERATION_ID, error: 'fixture indexing failure' });
    setInterval(() => undefined, 1000);
});
`);
    let noProgressCount = 0;
    try {
        const worker = spawnSupervisedMutationWorker({
            operationId: 'failed-live-fixture',
            workerPath,
            noProgressTimeoutMs: 25,
            cancelGraceMs: 20,
            terminalShutdownTimeoutMs: 40,
            onNoProgress: () => noProgressCount += 1,
        });
        await worker.ready;
        worker.start();
        await assert.rejects(
            withDeadline(worker.completion, 2_000),
            /fixture indexing failure/,
        );
        assert.equal(noProgressCount, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('worker stdout is routed away from the supervisor protocol stdout', { skip: process.platform !== 'linux' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-stdio-'));
    const workerPath = path.join(root, 'worker.cjs');
    const harnessPath = path.join(root, 'harness.mjs');
    fs.writeFileSync(workerPath, `
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', (message) => {
    if (message.type !== 'mutation_worker_start') return;
    console.log('MUTATION_WORKER_STDOUT_MARKER');
    process.send({ type: 'mutation_worker_completed', operationId: process.env.SATORI_MUTATION_OPERATION_ID }, () => process.exit(0));
});
`);
    try {
        const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
        const supervisorUrl = new URL('./mutation-worker-supervisor.ts', import.meta.url).href;
        fs.writeFileSync(harnessPath, `
import { spawnSupervisedMutationWorker } from ${JSON.stringify(supervisorUrl)};
const worker = spawnSupervisedMutationWorker({ operationId: 'stdio-fixture', workerPath: ${JSON.stringify(workerPath)} });
await worker.ready;
worker.start();
await worker.completion;
process.stdout.write('SUPERVISOR_DONE\\n');
`);
        const result = spawnSync(process.execPath, [
            '--import', 'tsx',
            harnessPath,
        ], {
            cwd: repositoryRoot,
            encoding: 'utf8',
            timeout: 5_000,
        });
        assert.equal(result.error, undefined, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'SUPERVISOR_DONE\n');
        assert.match(result.stderr, /MUTATION_WORKER_STDOUT_MARKER/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('memory budget progress survives the mutation worker IPC boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-budget-'));
    const workerPath = path.join(root, 'worker.cjs');
    const memoryBudget = { budgetMb: 2048, hint: 'Memory budget 2.0 GiB: TypeScript projects run one at a time.' };
    fs.writeFileSync(workerPath, `
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', (message) => {
    if (message.type !== 'mutation_worker_start') return;
    process.send({ type: 'mutation_worker_progress', operationId: process.env.SATORI_MUTATION_OPERATION_ID,
        sequence: 1, phase: 'writing', progress: 50, memoryBudget: ${JSON.stringify(memoryBudget)} });
    process.send({ type: 'mutation_worker_completed', operationId: process.env.SATORI_MUTATION_OPERATION_ID }, () => process.exit(0));
});
`);
    let received: unknown;
    try {
        const worker = spawnSupervisedMutationWorker({ operationId: 'budget-fixture', workerPath,
            onProgress: (progress) => { received = progress.memoryBudget; } });
        await worker.ready;
        worker.start();
        await worker.completion;
        assert.deepEqual(received, memoryBudget);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('start binds the requested operation id in the worker runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-bound-'));
    const workerPath = path.join(root, 'worker.cjs');
    const runtimePath = fileURLToPath(new URL('./mutation-worker-supervisor.ts', import.meta.url));
    fs.writeFileSync(workerPath, `
const { pathToFileURL } = require('node:url');
import(pathToFileURL(${JSON.stringify(runtimePath)}).href).then(({ createMutationWorkerRuntime }) => {
    const runtime = createMutationWorkerRuntime();
    runtime.started.then(() => runtime.complete({ bound: runtime.boundOperationId() }));
});
`);
    try {
        for (const bound of ['bound-op', undefined]) {
            let result: Readonly<Record<string, unknown>> | undefined;
            const worker = spawnSupervisedMutationWorker({
                operationId: 'spawn-op', workerPath, onCompleted: (value) => { result = value; },
            });
            await worker.ready;
            assert.throws(() => worker.start('  '), /boundOperationId/);
            worker.start(bound);
            await withDeadline(worker.completion, 5_000);
            assert.deepEqual(result, { bound: bound ?? 'spawn-op' });
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('start omits the bound operation id when none is supplied', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-message-'));
    const workerPath = path.join(root, 'worker.cjs');
    fs.writeFileSync(workerPath, `
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', message => {
    if (message.type === 'mutation_worker_start') {
        process.send({ type: 'mutation_worker_completed', operationId: message.operationId, result: { message } });
        process.disconnect();
    }
});
`);
    try {
        let result: Readonly<Record<string, unknown>> | undefined;
        const worker = spawnSupervisedMutationWorker({ operationId: 'spawn-op', workerPath,
            onCompleted: value => { result = value; } });
        await worker.ready;
        worker.start();
        await withDeadline(worker.completion, 5_000);
        assert.deepEqual(result, { message: { type: 'mutation_worker_start', operationId: 'spawn-op' } });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('clean exit with a dying descendant inside cleanExitDrainMs resolves without containment violation', { skip: process.platform !== 'linux' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-clean-drain-'));
    const workerPath = path.join(root, 'worker.cjs');
    const descendantPidPath = path.join(root, 'descendant.pid');
    fs.writeFileSync(workerPath, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', (message) => {
    if (message.type !== 'mutation_worker_start') return;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));
    process.send({ type: 'mutation_worker_completed', operationId: message.operationId }, () => process.exit(0));
});
`);
    try {
        let completed = false;
        const worker = spawnSupervisedMutationWorker({
            operationId: 'clean-drain-fixture',
            workerPath,
            cleanExitDrainMs: 500,
            onCompleted: () => { completed = true; },
        });
        await worker.ready;
        worker.start();
        await withDeadline(worker.completion, 5_000);
        assert.equal(completed, true);
        const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
        assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('clean exit with a leaked descendant past cleanExitDrainMs fails closed with containment violation', { skip: process.platform !== 'linux' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-clean-leak-'));
    const workerPath = path.join(root, 'worker.cjs');
    const descendantPidPath = path.join(root, 'descendant.pid');
    fs.writeFileSync(workerPath, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', (message) => {
    if (message.type !== 'mutation_worker_start') return;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));
    process.send({ type: 'mutation_worker_completed', operationId: message.operationId }, () => process.exit(0));
});
`);
    try {
        let completed = false;
        const worker = spawnSupervisedMutationWorker({
            operationId: 'clean-leak-fixture',
            workerPath,
            cleanExitDrainMs: 40,
            onCompleted: () => { completed = true; },
        });
        await worker.ready;
        worker.start();
        await assert.rejects(
            withDeadline(worker.completion, 5_000),
            /Mutation worker exited while descendants were still live \(exit code 0\)/,
        );
        assert.equal(completed, false);
        const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
        assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('non-zero exit with a short-lived descendant immediately flags containment violation without drain', { skip: process.platform !== 'linux' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-worker-nonzero-leak-'));
    const workerPath = path.join(root, 'worker.cjs');
    const descendantPidPath = path.join(root, 'descendant.pid');
    fs.writeFileSync(workerPath, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
process.send({ type: 'mutation_worker_ready', operationId: process.env.SATORI_MUTATION_OPERATION_ID });
process.on('message', (message) => {
    if (message.type !== 'mutation_worker_start') return;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 250)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(child.pid));
    process.exit(7);
});
`);
    try {
        const startedAt = Date.now();
        const worker = spawnSupervisedMutationWorker({
            operationId: 'nonzero-leak-fixture',
            workerPath,
            cleanExitDrainMs: 2_000,
        });
        await worker.ready;
        worker.start();
        await assert.rejects(
            withDeadline(worker.completion, 5_000),
            /Mutation worker exited while descendants were still live \(exit code 7\)/,
        );
        assert.ok(Date.now() - startedAt < 1_000);
        const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
        assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
