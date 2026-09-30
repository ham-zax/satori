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
