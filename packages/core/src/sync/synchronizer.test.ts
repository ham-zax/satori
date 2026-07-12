import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { FileSynchronizer } from './synchronizer';

function createDirectorySymlinkOrSkip(t: TestContext, target: string, linkPath: string): boolean {
    try {
        fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
        return true;
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
            t.skip(`Directory symlinks are unavailable on this platform: ${code}`);
            return false;
        }
        throw error;
    }
}

function createFileSymlinkOrSkip(t: TestContext, target: string, linkPath: string): boolean {
    try {
        fs.symlinkSync(target, linkPath);
        return true;
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
            t.skip(`File symlinks are unavailable on this platform: ${code}`);
            return false;
        }
        throw error;
    }
}

// F-D2: snapshot JSON array order must use compareContractStrings, not localeCompare.
test('FileSynchronizer snapshot JSON key order is independent of String.prototype.localeCompare', async () => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-snap-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-snap-repo-'));

    try {
        process.env.HOME = tempHome;
        const names = [
            'å.ts',
            'z.ts',
            'A.ts',
            'a.ts',
            'file-2.ts',
            'file-10.ts',
            'café.ts',
            'cafe.ts',
        ];
        for (const name of names) {
            fs.writeFileSync(path.join(tempRepo, name), `export const x = '${name}';\n`, 'utf8');
        }

        const syncA = new FileSynchronizer(tempRepo, [], ['.ts']);
        await syncA.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        const baselineRaw = fs.readFileSync(snapshotPath, 'utf8');
        const baseline = JSON.parse(baselineRaw) as { fileHashes: Array<[string, string]> };
        const baselineKeys = baseline.fileHashes.map(([relPath]) => relPath);
        const expectedKeys = [...names].sort(compareContractStrings);
        assert.deepEqual(baselineKeys, expectedKeys);

        fs.unlinkSync(snapshotPath);

        const original = String.prototype.localeCompare;
        String.prototype.localeCompare = function patchedLocaleCompare(that: string): number {
            if (String(this) === that) {
                return 0;
            }
            return String(this) < that ? 1 : -1;
        };

        try {
            const syncB = new FileSynchronizer(tempRepo, [], ['.ts']);
            await syncB.initialize();
            const poisonedRaw = fs.readFileSync(snapshotPath, 'utf8');
            const poisoned = JSON.parse(poisonedRaw) as { fileHashes: Array<[string, string]> };
            assert.deepEqual(
                poisoned.fileHashes.map(([relPath]) => relPath),
                baselineKeys,
                'snapshot fileHashes order must not depend on String.prototype.localeCompare',
            );
            assert.equal(poisonedRaw, baselineRaw);
        } finally {
            String.prototype.localeCompare = original;
        }
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer does not track files through an external directory symlink', async (t) => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-link-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-link-repo-'));
    const tempOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-link-outside-'));

    try {
        process.env.HOME = tempHome;
        fs.writeFileSync(path.join(tempRepo, 'local.ts'), 'export const local = true;\n', 'utf8');
        fs.writeFileSync(path.join(tempOutside, 'secret.ts'), 'export const secret = true;\n', 'utf8');
        if (!createDirectorySymlinkOrSkip(t, tempOutside, path.join(tempRepo, 'linked'))) {
            return;
        }

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();

        assert.deepEqual(synchronizer.getTrackedRelativePaths(), ['local.ts']);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempOutside, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer does not recurse through a directory symlink cycle', async (t) => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-cycle-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-cycle-repo-'));

    try {
        process.env.HOME = tempHome;
        const nestedDir = path.join(tempRepo, 'nested');
        fs.mkdirSync(nestedDir);
        fs.writeFileSync(path.join(tempRepo, 'root.ts'), 'export const root = true;\n', 'utf8');
        fs.writeFileSync(path.join(nestedDir, 'child.ts'), 'export const child = true;\n', 'utf8');
        if (!createDirectorySymlinkOrSkip(t, tempRepo, path.join(nestedDir, 'loop'))) {
            return;
        }

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();

        assert.deepEqual(synchronizer.getTrackedRelativePaths(), ['nested/child.ts', 'root.ts']);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer does not track content through a file symlink to an external path', async (t) => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-filelink-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-filelink-repo-'));
    const tempOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-filelink-outside-'));

    try {
        process.env.HOME = tempHome;
        fs.writeFileSync(path.join(tempRepo, 'local.ts'), 'export const local = true;\n', 'utf8');
        const outsideFile = path.join(tempOutside, 'secret.ts');
        fs.writeFileSync(outsideFile, 'export const secret = true;\n', 'utf8');
        if (!createFileSymlinkOrSkip(t, outsideFile, path.join(tempRepo, 'linked.ts'))) {
            return;
        }

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();

        assert.deepEqual(synchronizer.getTrackedRelativePaths(), ['local.ts']);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempOutside, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer refuses to hash when a scanned path becomes a symlink before open', async (t) => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-toctou-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-toctou-repo-'));
    const tempOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-toctou-outside-'));

    try {
        process.env.HOME = tempHome;
        const localPath = path.join(tempRepo, 'local.ts');
        fs.writeFileSync(localPath, 'export const local = true;\n', 'utf8');
        const outsideFile = path.join(tempOutside, 'secret.ts');
        fs.writeFileSync(outsideFile, 'export const secret = "leaked";\n', 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        // Replace the regular file with an external symlink after construction / before scan+hash.
        fs.rmSync(localPath);
        if (!createFileSymlinkOrSkip(t, outsideFile, localPath)) {
            return;
        }

        await synchronizer.initialize();
        assert.deepEqual(synchronizer.getTrackedRelativePaths(), []);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempOutside, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer does not index content when a parent directory is replaced with an outside symlink', async (t) => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-parent-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-parent-repo-'));
    const tempOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-parent-out-'));

    try {
        process.env.HOME = tempHome;
        const nested = path.join(tempRepo, 'nested');
        fs.mkdirSync(nested);
        fs.writeFileSync(path.join(tempRepo, 'root.ts'), 'export const root = true;\n', 'utf8');
        fs.writeFileSync(path.join(nested, 'child.ts'), 'export const child = "inside";\n', 'utf8');
        fs.writeFileSync(path.join(tempOutside, 'child.ts'), 'export const child = "SECRET_LEAK";\n', 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();
        assert.deepEqual(synchronizer.getTrackedRelativePaths(), ['nested/child.ts', 'root.ts']);
        const insideHash = synchronizer.getFileHash('nested/child.ts');
        assert.ok(insideHash);

        // Replace the parent directory with an outside symlink. A follow-stat open
        // would hash SECRET_LEAK; root-bound open must refuse the escape.
        fs.rmSync(nested, { recursive: true, force: true });
        if (!createDirectorySymlinkOrSkip(t, tempOutside, nested)) {
            return;
        }

        const changes = await synchronizer.prepareChanges();
        await changes.commit();

        assert.deepEqual(synchronizer.getTrackedRelativePaths(), ['root.ts']);
        assert.equal(synchronizer.getFileHash('nested/child.ts'), undefined);
        assert.equal(
            synchronizer.getFileHash('nested/child.ts') === insideHash,
            false,
        );
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempOutside, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer persists the descriptor signature from the bytes it hashed', async () => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-stable-observation-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-stable-observation-repo-'));

    try {
        process.env.HOME = tempHome;
        const sourcePath = path.join(tempRepo, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();

        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
        const mutable = synchronizer as unknown as {
            hashFileBytes(filePath: string): Promise<unknown>;
        };
        const originalHash = mutable.hashFileBytes.bind(mutable);
        let replaced = false;
        mutable.hashFileBytes = async (filePath: string) => {
            if (!replaced) {
                replaced = true;
                fs.writeFileSync(sourcePath, 'export const value = 300;\n', 'utf8');
            }
            return originalHash(filePath);
        };

        const changed = await synchronizer.prepareChanges();
        await changed.commit();
        const settled = await synchronizer.prepareChanges();

        assert.equal(settled.changes.hashedCount, 0);
        assert.deepEqual(settled.changes.modified, []);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer reapplies index policy to the descriptor it hashes', async () => {
    const prevHome = process.env.HOME;
    const prevMaxBytes = process.env.SATORI_ALL_TEXT_MAX_BYTES;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-descriptor-policy-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-descriptor-policy-repo-'));

    try {
        process.env.HOME = tempHome;
        process.env.SATORI_ALL_TEXT_MAX_BYTES = '32';
        const sourcePath = path.join(tempRepo, 'notes.unknown');
        fs.writeFileSync(sourcePath, 'small text\n', 'utf8');
        const synchronizer = new FileSynchronizer(tempRepo, [], ['<all-text>']);
        await synchronizer.initialize();
        assert.ok(synchronizer.getFileHash('notes.unknown'));

        fs.writeFileSync(sourcePath, 'changed text\n', 'utf8');
        const mutable = synchronizer as unknown as {
            hashFileBytes(filePath: string): Promise<unknown>;
        };
        const originalHash = mutable.hashFileBytes.bind(mutable);
        let replaced = false;
        mutable.hashFileBytes = async (filePath: string) => {
            if (!replaced) {
                replaced = true;
                fs.writeFileSync(sourcePath, 'x'.repeat(64), 'utf8');
            }
            return originalHash(filePath);
        };

        const prepared = await synchronizer.prepareChanges();
        assert.deepEqual(prepared.changes.removed, ['notes.unknown']);
        await prepared.commit();
        assert.equal(synchronizer.getFileHash('notes.unknown'), undefined);
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevMaxBytes === undefined) delete process.env.SATORI_ALL_TEXT_MAX_BYTES;
        else process.env.SATORI_ALL_TEXT_MAX_BYTES = prevMaxBytes;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer rejects corrupt current-format snapshots', async (t) => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-corrupt-snapshot-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-corrupt-snapshot-repo-'));

    try {
        process.env.HOME = tempHome;
        fs.writeFileSync(path.join(tempRepo, 'source.ts'), 'export const value = 1;\n', 'utf8');
        await new FileSynchronizer(tempRepo, [], ['.ts']).initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        const baseline = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
        const cases: Array<[string, (snapshot: Record<string, unknown>) => void]> = [
            ['malformed hash', (snapshot) => {
                snapshot.fileHashes = [['source.ts', 'not-a-sha256']];
            }],
            ['duplicate normalized path', (snapshot) => {
                const entries = snapshot.fileHashes as unknown[];
                snapshot.fileHashes = [...entries, entries[0]];
            }],
            ['negative size', (snapshot) => {
                const entries = structuredClone(snapshot.fileStats) as Array<[string, Record<string, unknown>]>;
                entries[0][1].size = -1;
                snapshot.fileStats = entries;
            }],
            ['mismatched hash and stat keys', (snapshot) => {
                snapshot.fileStats = [];
            }],
            ['incorrect Merkle root', (snapshot) => {
                snapshot.merkleRoot = '0'.repeat(64);
            }],
            ['invalid full-hash counter', (snapshot) => {
                snapshot.fullHashCounter = -1;
            }],
        ];

        for (const [label, mutate] of cases) {
            await t.test(label, async () => {
                const corrupted = structuredClone(baseline);
                mutate(corrupted);
                fs.writeFileSync(snapshotPath, JSON.stringify(corrupted), 'utf8');
                await assert.rejects(
                    () => new FileSynchronizer(tempRepo, [], ['.ts']).initialize(),
                    /invalid current-format snapshot/i,
                );
            });
        }
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer serializes prepared commits and rejects a stale change set', async () => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-commit-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-commit-repo-'));

    try {
        process.env.HOME = tempHome;
        const sourcePath = path.join(tempRepo, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();
        const committedHash = synchronizer.getFileHash('source.ts');
        assert.ok(committedHash);
        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');

        const first = await synchronizer.prepareChanges();
        const stale = await synchronizer.prepareChanges();
        assert.equal(synchronizer.getFileHash('source.ts'), committedHash);
        const commits = await Promise.allSettled([first.commit(), stale.commit()]);

        assert.equal(commits[0].status, 'fulfilled');
        assert.equal(commits[1].status, 'rejected');
        if (commits[1].status === 'rejected') {
            assert.match(String(commits[1].reason), /Cannot commit stale prepared changes/);
        }
        assert.notEqual(synchronizer.getFileHash('source.ts'), committedHash);

        fs.writeFileSync(sourcePath, 'export const value = 3;\n', 'utf8');
        const duplicate = await synchronizer.prepareChanges();
        const duplicateCommit = duplicate.commit();
        assert.equal(duplicate.commit(), duplicateCommit);
        await duplicateCommit;
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer does not publish a prepared checkpoint after mutation lease loss', async () => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-fenced-commit-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-fenced-commit-repo-'));

    try {
        process.env.HOME = tempHome;
        const sourcePath = path.join(tempRepo, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        const baselineSnapshot = fs.readFileSync(snapshotPath, 'utf8');
        const baselineHash = synchronizer.getFileHash('source.ts');

        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
        const prepared = await synchronizer.prepareChanges();
        await assert.rejects(
            () => prepared.commit(() => {
                throw new Error('mutation lease lost');
            }),
            /mutation lease lost/,
        );

        assert.equal(fs.readFileSync(snapshotPath, 'utf8'), baselineSnapshot);
        assert.equal(synchronizer.getFileHash('source.ts'), baselineHash);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer publishes the snapshot and in-memory checkpoint inside one mutation fence', async () => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-atomic-commit-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-atomic-commit-repo-'));

    try {
        process.env.HOME = tempHome;
        const sourcePath = path.join(tempRepo, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        const baselineSnapshot = fs.readFileSync(snapshotPath, 'utf8');
        const baselineHash = synchronizer.getFileHash('source.ts');

        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
        const prepared = await synchronizer.prepareChanges();
        let fenceCalls = 0;
        await prepared.commit(
            () => undefined,
            (publish) => {
                fenceCalls += 1;
                assert.equal(fs.readFileSync(snapshotPath, 'utf8'), baselineSnapshot);
                assert.equal(synchronizer.getFileHash('source.ts'), baselineHash);
                publish();
                assert.notEqual(fs.readFileSync(snapshotPath, 'utf8'), baselineSnapshot);
                assert.notEqual(synchronizer.getFileHash('source.ts'), baselineHash);
            },
        );

        assert.equal(fenceCalls, 1);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer requires publication callbacks to invoke publish exactly once', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-publication-home-'));
    try {
        process.env.HOME = tempHome;
        for (const mode of ['zero', 'double'] as const) {
            const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), `satori-sync-publication-${mode}-`));
            try {
                const sourcePath = path.join(tempRepo, 'source.ts');
                fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
                const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
                await synchronizer.initialize();
                fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
                const prepared = await synchronizer.prepareChanges();
                await assert.rejects(
                    () => prepared.commit(
                        () => undefined,
                        (publish) => {
                            if (mode === 'double') {
                                publish();
                                publish();
                            }
                        },
                    ),
                    mode === 'zero' ? /without publishing/ : /more than once/,
                );
            } finally {
                fs.rmSync(tempRepo, { recursive: true, force: true });
            }
        }
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});
