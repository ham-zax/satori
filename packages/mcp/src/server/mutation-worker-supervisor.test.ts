import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSupervisedMutationWorker } from './mutation-worker-supervisor.js';

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
