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
