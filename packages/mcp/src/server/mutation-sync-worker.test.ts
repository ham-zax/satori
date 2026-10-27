import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnSupervisedMutationWorker } from './mutation-worker-supervisor.js';

test('standby compares start configuration with the configuration used to construct its provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-bootstrap-'));
    const wrapper = path.join(root, 'worker.cjs');
    const calls = path.join(root, 'calls');
    const prewarmed = path.join(root, 'prewarmed');
    const providerPath = fileURLToPath(new URL('./provider-runtime.ts', import.meta.url));
    const workerPath = fileURLToPath(new URL('./mutation-sync-worker.ts', import.meta.url));
    fs.writeFileSync(wrapper, `
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
(async () => {
    const { ProviderRuntime } = await import(pathToFileURL(${JSON.stringify(providerPath)}).href);
    ProviderRuntime.prototype.requireToolContext = async function () {
        fs.appendFileSync(${JSON.stringify(calls)}, this.readFileMaxLines + '\\n');
        process.env.READ_FILE_MAX_LINES = '200';
        return { context: { prewarmSyncNavigationState: async () => {
            fs.writeFileSync(${JSON.stringify(prewarmed)}, ''); return true;
        } } };
    };
    ProviderRuntime.prototype.shutdown = async function () {};
    await import(pathToFileURL(${JSON.stringify(workerPath)}).href);
})().catch(error => { console.error(error); process.exit(1); });
`);
    const worker = spawnSupervisedMutationWorker({
        operationId: 'bootstrap-regression', workerPath: wrapper,
        workerArgs: [JSON.stringify({ path: root })],
        env: { HOME: root, SATORI_STATE_ROOT: path.join(root, 'state'), READ_FILE_MAX_LINES: '100',
            EMBEDDING_PROVIDER: 'OpenAI', VECTOR_STORE_PROVIDER: 'LanceDB' },
    });
    try {
        const deadline = Date.now() + 10_000;
        while (!fs.existsSync(prewarmed)) {
            if (Date.now() >= deadline) throw new Error('Worker did not finish prewarming.');
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        await worker.ready;
        worker.start();
        // The fixture has no mutation lease; the real worker exits after its bootstrap decision.
        await worker.completion.catch(() => undefined);
        assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['100', '200']);
    } finally {
        worker.requestCancellation('test cleanup');
        await worker.completion.catch(() => undefined);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
