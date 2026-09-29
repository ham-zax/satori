import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileSynchronizer } from './synchronizer';

test('synchronizer keeps built-in denylisted files untracked despite re-include rules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-ignore-'));
    try {
        fs.mkdirSync(path.join(root, 'vendor'));
        fs.writeFileSync(path.join(root, 'vendor', 'x.min.js'), 'var a = 1;\n');
        fs.writeFileSync(path.join(root, 'vendor', 'y.js'), 'var b = 2;\n');
        const synchronizer = new FileSynchronizer(
            root,
            ['*.min.js', '!vendor/x.min.js'],
            ['.js'],
        );
        await (await synchronizer.prepareChanges()).commit();
        assert.deepEqual(synchronizer.getTrackedRelativePaths(), ['vendor/y.js']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
