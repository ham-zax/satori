import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { compareContractStrings } from '../utils/compare-contract-strings';
import {
    FileSynchronizer,
    SynchronizerCheckpointPublicationError,
} from './synchronizer';

function checkpointOptions(checkpointIdentity: string) {
    return {
        checkpointIdentity,
        checkpointAuthority: {
            collectionName: checkpointIdentity,
            markerRunId: `run_${checkpointIdentity}`,
            indexPolicyHash: 'a'.repeat(64),
        },
    };
}

test('FileSynchronizer keeps Merkle checkpoints inside SATORI_STATE_ROOT', () => {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-state-root-'));
    const codebaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-codebase-'));
    process.env.SATORI_STATE_ROOT = stateRoot;
    try {
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(codebaseRoot);
        assert.equal(path.dirname(snapshotPath), path.join(stateRoot, 'merkle'));
        assert.equal(snapshotPath.startsWith(path.join(os.homedir(), '.satori')), false);
    } finally {
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(stateRoot, { recursive: true, force: true });
        fs.rmSync(codebaseRoot, { recursive: true, force: true });
    }
});

test('FileSynchronizer rejects a checkpoint identity owned by another collection', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-owner-mismatch-'));
    try {
        assert.throws(
            () => new FileSynchronizer(tempRepo, [], ['.ts'], {
                checkpointIdentity: 'generation-a',
                checkpointAuthority: {
                    collectionName: 'generation-b',
                    markerRunId: 'run_generation_b',
                    indexPolicyHash: 'a'.repeat(64),
                },
            }),
            /Checkpoint identity must match its collection authority/i,
        );
    } finally {
        fs.rmSync(tempRepo, { recursive: true, force: true });
    }
});

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

test('FileSynchronizer preserves canonical whitespace-bearing file identities', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-spaced-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-spaced-repo-'));
    const relativePath = ' source.ts';

    try {
        process.env.HOME = tempHome;
        fs.writeFileSync(path.join(tempRepo, relativePath), 'export const value = true;\n', 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();

        assert.deepEqual(synchronizer.getTrackedRelativePaths(), [relativePath]);
        assert.equal(synchronizer.getFileHash(relativePath)?.length, 64);
        assert.equal(synchronizer.getFileHash(relativePath.trim()), undefined);
    } finally {
        if (previousHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = previousHome;
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

test('FileSynchronizer reports a durable checkpoint when publication acknowledgement throws after rename', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-committed-error-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-committed-error-repo-'));

    try {
        process.env.HOME = tempHome;
        const sourcePath = path.join(tempRepo, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        const baselineSnapshot = fs.readFileSync(snapshotPath, 'utf8');

        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
        const prepared = await synchronizer.prepareChanges();
        const error = await prepared.commit(
            () => undefined,
            (publish) => {
                publish();
                throw new Error('acknowledgement failed');
            },
        ).then(
            () => undefined,
            (failure: unknown) => failure,
        );

        assert.ok(error instanceof SynchronizerCheckpointPublicationError);
        assert.equal(error.committed, true);
        assert.equal(error.receipt.status, 'committed');
        assert.equal(error.receipt.merkleRoot.length, 64);
        assert.match(error.message, /acknowledgement failed/);
        assert.notEqual(fs.readFileSync(snapshotPath, 'utf8'), baselineSnapshot);
        assert.equal(synchronizer.getFileHash('source.ts'), prepared.fileHashes.get('source.ts'));

        const restarted = new FileSynchronizer(tempRepo, [], ['.ts']);
        await restarted.initialize();
        const pending = await restarted.prepareChanges();
        assert.deepEqual(pending.changes.modified, []);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer can defer a full-index baseline until the candidate is published', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-deferred-baseline-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-deferred-baseline-repo-'));

    try {
        process.env.HOME = tempHome;
        fs.writeFileSync(path.join(tempRepo, 'source.ts'), 'export const value = 1;\n', 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize(undefined, undefined, { deferSnapshotPublication: true });
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        assert.equal(fs.existsSync(snapshotPath), false);

        const prepared = await synchronizer.prepareChanges();
        await assert.rejects(
            () => prepared.commit(() => {
                throw new Error('mutation lease lost');
            }),
            /mutation lease lost/,
        );
        assert.equal(fs.existsSync(snapshotPath), false);

        const retry = await synchronizer.prepareChanges();
        await retry.commit();
        assert.equal(fs.existsSync(snapshotPath), true);
        assert.equal(synchronizer.getFileHash('source.ts')?.length, 64);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer defers legacy snapshot replacement until a prepared checkpoint commits', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-deferred-legacy-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-deferred-legacy-repo-'));

    try {
        process.env.HOME = tempHome;
        fs.writeFileSync(path.join(tempRepo, 'source.ts'), 'export const value = 1;\n', 'utf8');
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        const legacySnapshot = JSON.stringify({
            snapshotVersion: 1,
            fileHashes: [['source.ts', '0'.repeat(64)]],
            merkleRoot: '0'.repeat(64),
        });
        fs.writeFileSync(snapshotPath, legacySnapshot, 'utf8');

        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize(undefined, undefined, { deferSnapshotPublication: true });
        assert.equal(fs.readFileSync(snapshotPath, 'utf8'), legacySnapshot);

        const prepared = await synchronizer.prepareChanges();
        const receipt = await prepared.commit();
        assert.equal(receipt.status, 'committed');
        const current = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as { snapshotVersion?: number };
        assert.equal(current.snapshotVersion, 2);

        const restarted = new FileSynchronizer(tempRepo, [], ['.ts']);
        await restarted.initialize();
        const pending = await restarted.prepareChanges();
        assert.deepEqual(pending.changes.modified, []);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
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

test('FileSynchronizer isolates authoritative checkpoints by generation and refuses a missing selected checkpoint', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-generation-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-generation-repo-'));

    try {
        process.env.HOME = tempHome;
        fs.writeFileSync(path.join(tempRepo, 'source.ts'), 'export const value = 1;\n', 'utf8');
        const firstCollection = 'hybrid_code_chunks_test__gen_first';
        const secondCollection = 'hybrid_code_chunks_test__gen_second';
        const first = new FileSynchronizer(tempRepo, [], ['.ts'], checkpointOptions(firstCollection));
        await first.initialize(undefined, undefined, { deferSnapshotPublication: true });
        await (await first.prepareChanges({ forceFullHash: true })).commit();

        const firstPath = FileSynchronizer.getSnapshotPathForGeneration(tempRepo, firstCollection);
        const secondPath = FileSynchronizer.getSnapshotPathForGeneration(tempRepo, secondCollection);
        assert.equal(fs.existsSync(firstPath), true);
        assert.equal(fs.existsSync(secondPath), false);

        const reopened = new FileSynchronizer(tempRepo, [], ['.ts'], checkpointOptions(firstCollection));
        await reopened.initialize(undefined, undefined, { requireExistingCheckpoint: true });
        const fresh = await reopened.prepareChanges({ forceFullHash: true });
        assert.deepEqual(fresh.changes.modified, []);
        const validEvidence = await reopened.inspectOwnedSnapshot();
        assert.equal(validEvidence.status, 'valid');
        if (validEvidence.status === 'valid') {
            const observation = JSON.parse(validEvidence.observationToken) as {
                documentDigest?: string;
            };
            const persisted = JSON.parse(fs.readFileSync(firstPath, 'utf8')) as {
                documentDigest?: string;
            };
            assert.equal(observation.documentDigest, persisted.documentDigest);
            assert.equal(reopened.getOwnedSnapshotObservationToken(), validEvidence.observationToken);
        }

        const originalCheckpoint = fs.readFileSync(firstPath, 'utf8');
        fs.writeFileSync(firstPath, '{"snapshotVersion":3}', 'utf8');
        const corruptEvidence = await reopened.inspectOwnedSnapshot();
        assert.equal(corruptEvidence.status, 'corrupt');
        fs.writeFileSync(firstPath, originalCheckpoint, 'utf8');

        await assert.rejects(
            () => reopened.deleteOwnedSnapshot(
                () => undefined,
                () => {
                    throw new Error('lease lost before checkpoint cleanup');
                },
            ),
            /lease lost before checkpoint cleanup/,
        );
        assert.equal(fs.existsSync(firstPath), true);

        const migratableCheckpoint = JSON.parse(originalCheckpoint) as Record<string, unknown>;
        migratableCheckpoint.fileStats = [];
        delete migratableCheckpoint.documentDigest;
        migratableCheckpoint.documentDigest = crypto.createHash('sha256')
            .update(JSON.stringify(migratableCheckpoint))
            .digest('hex');
        const migratableBytes = JSON.stringify(migratableCheckpoint);
        fs.writeFileSync(firstPath, migratableBytes, 'utf8');
        const strictReopen = new FileSynchronizer(tempRepo, [], ['.ts'], checkpointOptions(firstCollection));
        await assert.rejects(
            () => strictReopen.initialize(undefined, undefined, { requireExistingCheckpoint: true }),
            /fileHashes and fileStats must contain identical path sets/,
        );
        assert.equal(fs.readFileSync(firstPath, 'utf8'), migratableBytes);
        fs.writeFileSync(firstPath, originalCheckpoint, 'utf8');

        const missing = new FileSynchronizer(tempRepo, [], ['.ts'], checkpointOptions(secondCollection));
        await assert.rejects(
            () => missing.initialize(undefined, undefined, { requireExistingCheckpoint: true }),
            /Authoritative generation checkpoint is missing/,
        );
        assert.equal(fs.existsSync(secondPath), false);

        await FileSynchronizer.deleteSnapshot(tempRepo);
        assert.equal(fs.existsSync(firstPath), false);
        const missingEvidence = await reopened.inspectOwnedSnapshot();
        assert.equal(missingEvidence.status, 'missing');
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer forceFullHash hashes every selected source despite unchanged metadata', async () => {
    const previousHome = process.env.HOME;
    const previousInterval = process.env.SATORI_SYNC_FULL_HASH_EVERY_N;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-force-hash-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-force-hash-repo-'));

    try {
        process.env.HOME = tempHome;
        process.env.SATORI_SYNC_FULL_HASH_EVERY_N = '1000';
        fs.writeFileSync(path.join(tempRepo, 'one.ts'), 'export const one = 1;\n', 'utf8');
        fs.writeFileSync(path.join(tempRepo, 'two.ts'), 'export const two = 2;\n', 'utf8');
        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();

        const optimized = await synchronizer.prepareChanges();
        assert.equal(optimized.changes.fullHashRun, false);
        assert.equal(optimized.changes.hashedCount, 0);

        const exact = await synchronizer.prepareChanges({ forceFullHash: true });
        assert.equal(exact.changes.fullHashRun, true);
        assert.equal(exact.changes.hashedCount, 2);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousInterval === undefined) delete process.env.SATORI_SYNC_FULL_HASH_EVERY_N;
        else process.env.SATORI_SYNC_FULL_HASH_EVERY_N = previousInterval;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});

test('FileSynchronizer compares explicit paths to its owned checkpoint without advancing it', async () => {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-path-compare-state-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-path-compare-repo-'));
    process.env.SATORI_STATE_ROOT = stateRoot;
    try {
        const sourcePath = path.join(tempRepo, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
        const synchronizer = new FileSynchronizer(
            tempRepo,
            [],
            ['.ts'],
            checkpointOptions('path_compare_generation'),
        );
        await synchronizer.initialize(undefined, undefined, { deferSnapshotPublication: true });
        await (await synchronizer.prepareChanges({ forceFullHash: true })).commit();
        const checkpointObservation = synchronizer.getOwnedSnapshotObservationToken();

        assert.deepEqual(
            await synchronizer.comparePathsToOwnedCheckpoint(['source.ts']),
            { status: 'matches' },
        );
        assert.equal(synchronizer.getOwnedSnapshotObservationToken(), checkpointObservation);

        fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
        assert.deepEqual(
            await synchronizer.comparePathsToOwnedCheckpoint(['source.ts']),
            { status: 'differs' },
        );

        fs.rmSync(sourcePath);
        assert.deepEqual(
            await synchronizer.comparePathsToOwnedCheckpoint(['source.ts']),
            { status: 'differs' },
        );

        fs.writeFileSync(path.join(tempRepo, 'added.ts'), 'export const added = true;\n', 'utf8');
        assert.deepEqual(
            await synchronizer.comparePathsToOwnedCheckpoint(['added.ts']),
            { status: 'differs' },
        );
        assert.equal(synchronizer.getOwnedSnapshotObservationToken(), checkpointObservation);
    } finally {
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test('FileSynchronizer exact path comparison fails closed on source or checkpoint drift', async () => {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-path-race-state-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-path-race-repo-'));
    process.env.SATORI_STATE_ROOT = stateRoot;
    try {
        const sourcePath = path.join(tempRepo, 'source.ts');
        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
        const collectionName = 'path_race_generation';
        const synchronizer = new FileSynchronizer(
            tempRepo,
            [],
            ['.ts'],
            checkpointOptions(collectionName),
        );
        await synchronizer.initialize(undefined, undefined, { deferSnapshotPublication: true });
        await (await synchronizer.prepareChanges({ forceFullHash: true })).commit();

        const mutable = synchronizer as unknown as {
            observeExactPath(relativePath: string): Promise<unknown>;
        };
        const observeExactPath = mutable.observeExactPath.bind(mutable);
        let observations = 0;
        mutable.observeExactPath = async (relativePath: string) => {
            observations += 1;
            if (observations === 2) {
                fs.writeFileSync(sourcePath, 'export const value = 2;\n', 'utf8');
            }
            return observeExactPath(relativePath);
        };
        assert.deepEqual(
            await synchronizer.comparePathsToOwnedCheckpoint(['source.ts']),
            { status: 'unavailable' },
        );

        fs.writeFileSync(sourcePath, 'export const value = 1;\n', 'utf8');
        observations = 0;
        mutable.observeExactPath = async (relativePath: string) => {
            observations += 1;
            const observation = await observeExactPath(relativePath);
            if (observations === 1) {
                fs.appendFileSync(
                    FileSynchronizer.getSnapshotPathForGeneration(tempRepo, collectionName),
                    '\n',
                    'utf8',
                );
            }
            return observation;
        };
        assert.deepEqual(
            await synchronizer.comparePathsToOwnedCheckpoint(['source.ts']),
            { status: 'unavailable' },
        );
    } finally {
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
});

test('FileSynchronizer rejects a prepared publication after its source observation changes', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-observation-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-observation-repo-'));
    try {
        process.env.HOME = tempHome;
        const sourcePath = path.join(tempRepo, 'owner.ts');
        fs.writeFileSync(sourcePath, 'export const owner = 1;\n', 'utf8');
        const synchronizer = new FileSynchronizer(tempRepo, [], ['.ts']);
        await synchronizer.initialize();

        fs.writeFileSync(sourcePath, 'export const owner = 2;\n', 'utf8');
        const prepared = await synchronizer.prepareChanges();
        await prepared.assertSourceObservationCurrent();

        fs.writeFileSync(sourcePath, 'export const owner = 3;\n', 'utf8');
        await assert.rejects(
            () => prepared.assertSourceObservationCurrent(),
            /source observation changed while the candidate publication was being prepared/i,
        );
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});
