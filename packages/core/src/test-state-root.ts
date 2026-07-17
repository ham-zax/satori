import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-core-test-state-'));
process.env.SATORI_STATE_ROOT = testStateRoot;

process.once('exit', () => {
    fs.rmSync(testStateRoot, { recursive: true, force: true });
});
