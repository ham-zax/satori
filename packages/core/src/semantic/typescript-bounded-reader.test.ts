import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTypeScriptFileBytes, TypeScriptReadLimitError } from './typescript-bounded-reader';

test('bounded reads accept the byte boundary and reject stat-known oversize without reading', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-read-bound-'));
    const file = path.join(root, 'data.json');
    try {
        fs.writeFileSync(file, 'x'.repeat(64));
        assert.equal(readTypeScriptFileBytes(file, 64).length, 64);
        const read = t.mock.method(fs, 'readSync');
        assert.throws(() => readTypeScriptFileBytes(file, 63), TypeScriptReadLimitError);
        assert.equal(read.mock.callCount(), 0);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('bounded reads stop at the overflow sentinel if a file grows after stat', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-read-growth-'));
    const file = path.join(root, 'data.json');
    fs.writeFileSync(file, 'x'.repeat(1024));
    try {
        const stat = fs.fstatSync;
        t.mock.method(fs, 'fstatSync', (fd: number) => Object.assign(stat(fd), { size: 0 }));
        const read = fs.readSync;
        let bytes = 0;
        t.mock.method(fs, 'readSync', (...args: unknown[]) => {
            const count = Reflect.apply(read, fs, args) as number;
            bytes += count;
            return count;
        });
        const close = t.mock.method(fs, 'closeSync');
        assert.throws(() => readTypeScriptFileBytes(file, 64), TypeScriptReadLimitError);
        assert.equal(bytes, 65);
        assert.equal(close.mock.callCount(), 1);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
