import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnSupervisedMutationWorker } from './mutation-worker-supervisor.js';

test('standby defers provider bootstrap and navigation preload until start', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-bootstrap-'));
    const wrapper = path.join(root, 'worker.cjs');
    const calls = path.join(root, 'calls');
    const providerPath = fileURLToPath(new URL('./provider-runtime.ts', import.meta.url));
    const workerPath = fileURLToPath(new URL('./mutation-sync-worker.ts', import.meta.url));
    fs.writeFileSync(wrapper, `
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
(async () => {
    const { ProviderRuntime } = await import(pathToFileURL(${JSON.stringify(providerPath)}).href);
    ProviderRuntime.prototype.requireToolContext = async function () {
        fs.appendFileSync(${JSON.stringify(calls)}, this.readFileMaxLines + '\\n');
        return { context: { prewarmSyncNavigationState: async () => {
            throw new Error('standby must not prewarm navigation state');
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
        await worker.ready;
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(fs.existsSync(calls), false, 'idle standby must not bootstrap ProviderRuntime before start');
        worker.start();
        // The fixture has no mutation lease; the real worker exits after bootstrapping its provider.
        await worker.completion.catch(() => undefined);
        assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['100']);
    } finally {
        worker.requestCancellation('test cleanup');
        await worker.completion.catch(() => undefined);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
