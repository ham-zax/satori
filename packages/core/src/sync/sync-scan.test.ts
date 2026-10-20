import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ignore from 'ignore';
import {
    observeSynchronizerPath,
    runBoundedWorkers,
    scanSynchronizerState,
    type SynchronizerScanContext,
} from './sync-scan';
import type { FileStatSignature } from './sync-scan';

const SPARSE_ANCHOR_BYTES = 256 * 1024 * 1024;

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'satori-sync-scan-'));
    try {
        await fn(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

/** Sparse anchor: first 8 KiB are 'a', the rest are zeros. Fast to create, slow to hash. */
function writeSparseAnchor(filePath: string, bytes = SPARSE_ANCHOR_BYTES): void {
    const fd = fs.openSync(filePath, 'w');
    try {
        fs.writeSync(fd, Buffer.alloc(8192, 'a'));
        fs.ftruncateSync(fd, bytes);
    } finally {
        fs.closeSync(fd);
    }
}

function makeContext(
    rootDir: string,
    options: {
        ignorePatterns?: string[];
        extensions?: string[];
        forceFullHash?: boolean;
        hashConcurrency?: number;
        additionalObservablePaths?: ReadonlySet<string>;
        previousHashes?: Map<string, string>;
        previousStats?: Map<string, FileStatSignature>;
    } = {},
): SynchronizerScanContext {
    const matcher = ignore();
    matcher.add(options.ignorePatterns ?? []);
    return {
        rootDir,
        ignoreMatcher: matcher,
        supportedExtensions: options.extensions ?? ['.ts'],
        forceFullHash: options.forceFullHash ?? true,
        hashConcurrency: options.hashConcurrency ?? 4,
        additionalObservablePaths: options.additionalObservablePaths,
        previousHashes: options.previousHashes ?? new Map(),
        previousStats: options.previousStats ?? new Map(),
    };
}

test('runBoundedWorkers enforces the concurrency bound deterministically', async () => {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const gates: Array<() => void> = [];

    const promise = runBoundedWorkers(3, 7, async (index) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        completed += 1;
        return index * 2;
    });

    // The first three workers start synchronously and park on their gates.
    assert.equal(peak, 3);
    assert.equal(active, 3);
    assert.equal(gates.length, 3);

    // Releasing one gate lets that worker finish and immediately claim the next
    // item, so the in-flight count returns to the bound before any further work.
    gates.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, 1);
    assert.equal(active, 3);
    assert.equal(gates.length, 3);
    assert.equal(peak, 3);

    while (gates.length > 0) {
        gates.shift()!();
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(await promise, [0, 2, 4, 6, 8, 10, 12]);
    assert.equal(completed, 7);
    assert.equal(peak, 3);
});

test('runBoundedWorkers preserves order and works below and above the bound', async () => {
    assert.deepEqual(
        await runBoundedWorkers(1, 3, async (index) => index),
        [0, 1, 2],
    );
    assert.deepEqual(
        await runBoundedWorkers(10, 3, async (index) => index),
        [0, 1, 2],
    );
    await assert.rejects(
        () => runBoundedWorkers(2, 3, async (index) => {
            if (index === 1) throw new Error('worker failed');
            return index;
        }),
        /worker failed/,
    );
});

test('scanSynchronizerState returns complete immutable scan results', async () => {
    await withTempDir(async (rootDir) => {
        fs.mkdirSync(path.join(rootDir, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(rootDir, 'a.ts'), 'export const a = 1;\n', 'utf8');
        fs.writeFileSync(path.join(rootDir, 'nested', 'b.ts'), 'export const b = 2;\n', 'utf8');
        fs.writeFileSync(path.join(rootDir, 'ignored.txt'), 'not indexed\n', 'utf8');

        const previousHashes = new Map([['stale.ts', 'old-hash']]);
        const previousStats = new Map([['stale.ts', { size: 1, mtimeMs: 1, ctimeMs: 1 }]]);
        const output = await scanSynchronizerState(makeContext(rootDir, {
            previousHashes,
            previousStats,
        }));

        assert.equal(output.hashedCount, 2);
        assert.equal(output.partialScan, false);
        assert.deepEqual(output.unscannedDirPrefixes, []);
        assert.equal(output.unreadableFiles.size, 0);
        assert.deepEqual(
            [...output.fileHashes.keys()].sort(),
            ['a.ts', 'nested/b.ts'],
        );
        assert.equal(output.fileHashes.get('a.ts'), sha256('export const a = 1;\n'));
        assert.equal(output.fileHashes.get('nested/b.ts'), sha256('export const b = 2;\n'));
        // The scan never mutates the caller's previous evidence.
        assert.equal(previousHashes.has('stale.ts'), true);
        // Results are fresh maps, not aliases of the context evidence.
        assert.notEqual(output.fileHashes, previousHashes);
    });
});

test('scanSynchronizerState honors the ignore matcher and skips symlinks', async () => {
    await withTempDir(async (rootDir) => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-scan-outside-'));
        try {
            fs.writeFileSync(path.join(rootDir, 'keep.ts'), 'export const keep = true;\n', 'utf8');
            fs.writeFileSync(path.join(rootDir, 'skip.ts'), 'export const skip = true;\n', 'utf8');
            fs.writeFileSync(path.join(outside, 'external.ts'), 'export const external = true;\n', 'utf8');
            let linked = false;
            try {
                fs.symlinkSync(path.join(outside, 'external.ts'), path.join(rootDir, 'linked.ts'));
                linked = true;
            } catch {
                // Platform without symlink support: nothing to skip via symlink.
            }

            const output = await scanSynchronizerState(makeContext(rootDir, {
                ignorePatterns: ['skip.ts'],
            }));
            assert.deepEqual([...output.fileHashes.keys()].sort(), ['keep.ts']);
            if (linked) {
                assert.equal(output.fileHashes.has('linked.ts'), false);
            }
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

test('scanSynchronizerState reuses cached evidence and honors forceFullHash', async () => {
    await withTempDir(async (rootDir) => {
        fs.writeFileSync(path.join(rootDir, 'a.ts'), 'export const a = 1;\n', 'utf8');
        fs.writeFileSync(path.join(rootDir, 'b.ts'), 'export const b = 2;\n', 'utf8');

        const first = await scanSynchronizerState(makeContext(rootDir, { forceFullHash: true }));
        assert.equal(first.hashedCount, 2);

        const second = await scanSynchronizerState(makeContext(rootDir, {
            forceFullHash: false,
            previousHashes: new Map(first.fileHashes),
            previousStats: new Map(first.fileStats),
        }));
        assert.equal(second.hashedCount, 0);
        assert.deepEqual(second.fileHashes, first.fileHashes);

        const third = await scanSynchronizerState(makeContext(rootDir, {
            forceFullHash: true,
            previousHashes: new Map(first.fileHashes),
            previousStats: new Map(first.fileStats),
        }));
        assert.equal(third.hashedCount, 2);
    });
});

test('scanSynchronizerState preserves previous evidence for unreadable paths', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('cannot simulate unreadable paths as root');
        return;
    }
    await withTempDir(async (rootDir) => {
        fs.writeFileSync(path.join(rootDir, 'ok.ts'), 'export const ok = true;\n', 'utf8');
        const secretPath = path.join(rootDir, 'secret.ts');
        fs.writeFileSync(secretPath, 'export const secret = 1;\n', 'utf8');
        fs.chmodSync(secretPath, 0o000);

        const output = await scanSynchronizerState(makeContext(rootDir, {
            previousHashes: new Map([['secret.ts', 'previous-hash']]),
            previousStats: new Map([['secret.ts', { size: 21, mtimeMs: 21, ctimeMs: 21 }]]),
        }));

        assert.equal(output.partialScan, true);
        assert.equal(output.unreadableFiles.has('secret.ts'), true);
        // Unreadable files keep their last-known evidence instead of vanishing.
        assert.equal(output.fileHashes.get('secret.ts'), 'previous-hash');
        assert.deepEqual(output.fileStats.get('secret.ts'), { size: 21, mtimeMs: 21, ctimeMs: 21 });
        assert.equal(output.fileHashes.has('ok.ts'), true);
    });
});

test('scanSynchronizerState records unreadable files that fail the index-policy probe', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        t.skip('cannot simulate unreadable paths as root');
        return;
    }
    await withTempDir(async (rootDir) => {
        fs.writeFileSync(path.join(rootDir, 'ok.ts'), 'export const ok = true;\n', 'utf8');
        // An unknown extension triggers the shebang probe; a large .js triggers the large-asset probe.
        fs.writeFileSync(path.join(rootDir, 'notes.custom'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(path.join(rootDir, 'bundle.js'), 'x'.repeat(200 * 1024), 'utf8');
        fs.chmodSync(path.join(rootDir, 'notes.custom'), 0o000);
        fs.chmodSync(path.join(rootDir, 'bundle.js'), 0o000);

        const output = await scanSynchronizerState(makeContext(rootDir, {
            extensions: ['.ts', '.js'],
            previousHashes: new Map([['bundle.js', 'previous-hash']]),
            previousStats: new Map([['bundle.js', { size: 1, mtimeMs: 1, ctimeMs: 1 }]]),
        }));

        assert.equal(output.partialScan, true);
        assert.equal(output.unreadableFiles.has('notes.custom'), true);
        assert.equal(output.unreadableFiles.has('bundle.js'), true);
        assert.equal(output.fileHashes.get('bundle.js'), 'previous-hash');
        assert.equal(output.fileHashes.has('ok.ts'), true);
    });
});

for (const code of ['EACCES', 'ENOENT']) {
    test(`policy-probe ${code} preserves evidence while other files scan`, async (t) => {
        await withTempDir(async (rootDir) => {
            fs.writeFileSync(path.join(rootDir, 'ok.ts'), 'export const ok = true;\n');
            fs.writeFileSync(path.join(rootDir, 'notes.custom'), '#!/usr/bin/env node\nconsole.log(1);\n');
            fs.writeFileSync(path.join(rootDir, 'bundle.js'), `// bundle\n${'x'.repeat(200 * 1024)}`);
            const baseline = await scanSynchronizerState(makeContext(rootDir, { extensions: ['.ts', '.js'] }));
            const targets = ['notes.custom', 'bundle.js'];
            const originalOpen = fs.promises.open;
            t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof originalOpen>) => {
                if (targets.some((target) => args[0] === path.join(rootDir, target))) {
                    throw Object.assign(new Error(`injected ${code}`), { code });
                }
                return originalOpen(...args);
            });
            const output = await scanSynchronizerState(makeContext(rootDir, {
                extensions: ['.ts', '.js'],
                previousHashes: new Map(baseline.fileHashes),
                previousStats: new Map(baseline.fileStats),
            }));
            assert.equal(output.partialScan, true);
            assert.deepEqual([...output.unreadableFiles].sort(), targets.sort());
            for (const target of targets) {
                assert.ok(baseline.fileHashes.has(target));
                assert.equal(output.fileHashes.get(target), baseline.fileHashes.get(target));
                assert.deepEqual(output.fileStats.get(target), baseline.fileStats.get(target));
            }
            assert.equal(output.fileHashes.get('ok.ts'), baseline.fileHashes.get('ok.ts'));
        });
    });
}

test('bounded hashing preserves complete hashes for empty, one-byte, and multi-chunk sources', async () => {
    await withTempDir(async (rootDir) => {
        const files = new Map([
            ['empty.ts', ''],
            ['one.ts', 'x'],
            ['chunks.ts', 'x'.repeat(128 * 1024) + 'z'],
        ]);
        for (const [file, content] of files) fs.writeFileSync(path.join(rootDir, file), content);
        const context = makeContext(rootDir);
        const scanned = await scanSynchronizerState(context);
        assert.deepEqual(scanned.fileHashes, new Map([...files].map(([file, content]) => [file, sha256(content)])));
        for (const [file, content] of files) {
            const observed = await observeSynchronizerPath(context, file);
            assert.equal(observed.kind, 'indexed');
            assert.equal(observed.hash, sha256(content));
        }
    });
});

test('observeSynchronizerPath reads at most one byte past the observed size of a growing file', async () => {
    await withTempDir(async (rootDir) => {
        const targetPath = path.join(rootDir, 'grow.ts');
        const original = 'export const grow = 1;\n';
        fs.writeFileSync(targetPath, original, 'utf8');

        // createHash runs after the size was observed and before the stream opens,
        // so growing the file here models a writer racing the hash read.
        const realCreateHash = crypto.createHash;
        let hashedBytes = 0;
        let grew = false;
        (crypto as { createHash: typeof crypto.createHash }).createHash = ((algorithm: string) => {
            const hasher = realCreateHash(algorithm);
            if (!grew) {
                grew = true;
                fs.appendFileSync(targetPath, 'y'.repeat(8 * 1024 * 1024));
            }
            const update = hasher.update.bind(hasher) as (chunk: Buffer) => crypto.Hash;
            hasher.update = ((chunk: Buffer) => {
                hashedBytes += chunk.length;
                return update(chunk);
            }) as typeof hasher.update;
            return hasher;
        }) as typeof crypto.createHash;
        try {
            await assert.rejects(
                () => observeSynchronizerPath(makeContext(rootDir), 'grow.ts'),
                /File changed while being hashed/,
            );
        } finally {
            (crypto as { createHash: typeof crypto.createHash }).createHash = realCreateHash;
        }
        assert.equal(grew, true);
        assert.ok(hashedBytes <= Buffer.byteLength(original) + 1, `hashed ${hashedBytes} bytes`);
    });
});

test('scanSynchronizerState bounds concurrent hashing to hashConcurrency', async () => {
    await withTempDir(async (rootDir) => {
        writeSparseAnchor(path.join(rootDir, 'anchor.ts'));
        fs.writeFileSync(path.join(rootDir, 'target.ts'), 'export const target = 1;\n', 'utf8');

        // With hashConcurrency=1 the sparse anchor is hashed first (sorted order),
        // so target.ts is not opened until the anchor hash finishes. Deleting it
        // during that window must land it in unreadableFiles, never in the results.
        const scanPromise = scanSynchronizerState(makeContext(rootDir, {
            hashConcurrency: 1,
            additionalObservablePaths: new Set(['anchor.ts']),
        }));
        await sleep(25);
        fs.rmSync(path.join(rootDir, 'target.ts'));

        const output = await scanPromise;
        assert.equal(output.fileHashes.has('target.ts'), false);
        assert.equal(output.unreadableFiles.has('target.ts'), true);
        assert.equal(output.fileHashes.has('anchor.ts'), true);
    });
});

test('scanSynchronizerState persists the signature of the bytes it hashed', async () => {
    await withTempDir(async (rootDir) => {
        writeSparseAnchor(path.join(rootDir, 'anchor.ts'));
        const targetPath = path.join(rootDir, 'target.ts');
        fs.writeFileSync(targetPath, 'export const target = 1;\n', 'utf8');

        // The anchor occupies the single hash worker; rewriting target.ts during
        // that window changes it between the scan-time stat and the hash open.
        const scanPromise = scanSynchronizerState(makeContext(rootDir, {
            hashConcurrency: 1,
            additionalObservablePaths: new Set(['anchor.ts']),
        }));
        await sleep(25);
        fs.writeFileSync(targetPath, 'export const target = 2;\n', 'utf8');
        const output = await scanPromise;

        const current = fs.statSync(targetPath);
        const expectedSignature: FileStatSignature = {
            size: current.size,
            mtimeMs: Number(current.mtimeMs),
            ctimeMs: Number(current.ctimeMs),
        };
        assert.equal(output.fileHashes.get('target.ts'), sha256('export const target = 2;\n'));
        assert.deepEqual(output.fileStats.get('target.ts'), expectedSignature);
    });
});

test('scanSynchronizerState reapplies the index policy to the descriptor it hashes', async () => {
    const previousMaxBytes = process.env.SATORI_ALL_TEXT_MAX_BYTES;
    process.env.SATORI_ALL_TEXT_MAX_BYTES = '32';
    try {
        await withTempDir(async (rootDir) => {
            writeSparseAnchor(path.join(rootDir, 'anchor.ts'));
            const notesPath = path.join(rootDir, 'notes.unknown');
            fs.writeFileSync(notesPath, 'changed text\n', 'utf8');

            // The anchor occupies the single hash worker; growing notes.unknown
            // beyond the text limit during that window must re-run the policy
            // against the opened descriptor and drop the file.
            const scanPromise = scanSynchronizerState(makeContext(rootDir, {
                hashConcurrency: 1,
                extensions: ['.ts', '<all-text>'],
                additionalObservablePaths: new Set(['anchor.ts']),
            }));
            await sleep(25);
            fs.writeFileSync(notesPath, 'x'.repeat(64), 'utf8');
            const output = await scanPromise;

            assert.equal(output.fileHashes.has('notes.unknown'), false);
            assert.equal(output.fileStats.has('notes.unknown'), false);
        });
    } finally {
        if (previousMaxBytes === undefined) delete process.env.SATORI_ALL_TEXT_MAX_BYTES;
        else process.env.SATORI_ALL_TEXT_MAX_BYTES = previousMaxBytes;
    }
});

test('observeSynchronizerPath classifies explicit paths', async () => {
    await withTempDir(async (rootDir) => {
        const context = makeContext(rootDir, { ignorePatterns: ['ignored.ts'] });
        const absent = await observeSynchronizerPath(context, 'missing.ts');
        assert.equal(absent.kind, 'absent');

        fs.writeFileSync(path.join(rootDir, 'present.ts'), 'export const present = true;\n', 'utf8');
        const indexed = await observeSynchronizerPath(context, 'present.ts');
        assert.equal(indexed.kind, 'indexed');
        assert.equal(indexed.hash, sha256('export const present = true;\n'));

        fs.writeFileSync(path.join(rootDir, 'ignored.ts'), 'export const ignored = true;\n', 'utf8');
        const ignored = await observeSynchronizerPath(context, 'ignored.ts');
        assert.equal(ignored.kind, 'not_indexable');

        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-scan-outside-'));
        try {
            fs.writeFileSync(path.join(outside, 'external.ts'), 'export const external = true;\n', 'utf8');
            try {
                fs.symlinkSync(path.join(outside, 'external.ts'), path.join(rootDir, 'linked.ts'));
            } catch {
                return;
            }
            const linked = await observeSynchronizerPath(context, 'linked.ts');
            assert.equal(linked.kind, 'not_indexable');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});

test('observeSynchronizerPath reports a path below a regular file as absent', async () => {
    await withTempDir(async (rootDir) => {
        fs.writeFileSync(path.join(rootDir, 'file.txt'), 'plain\n', 'utf8');
        const observed = await observeSynchronizerPath(makeContext(rootDir), 'file.txt/a.ts');
        assert.equal(observed.kind, 'absent');
    });
});

test('observeSynchronizerPath does not index a path below a symlinked directory', async (t) => {
    await withTempDir(async (rootDir) => {
        fs.mkdirSync(path.join(rootDir, 'real'));
        fs.writeFileSync(path.join(rootDir, 'real', 'a.ts'), 'export const a = 1;\n', 'utf8');
        try {
            fs.symlinkSync(path.join(rootDir, 'real'), path.join(rootDir, 'link'), 'dir');
        } catch {
            t.skip('directory symlinks are unavailable on this platform');
            return;
        }
        const context = makeContext(rootDir);
        assert.equal((await observeSynchronizerPath(context, 'real/a.ts')).kind, 'indexed');
        assert.equal((await observeSynchronizerPath(context, 'link/a.ts')).kind, 'not_indexable');
        // Matches the scan, which never descends into the symlinked directory.
        const scanned = await scanSynchronizerState(context);
        assert.deepEqual([...scanned.fileHashes.keys()], ['real/a.ts']);
    });
});
