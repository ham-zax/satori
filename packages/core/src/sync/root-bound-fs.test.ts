import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    assertDescriptorBoundIndexingSupported,
    descriptorPathInsideRoot,
    isRealPathInsideRoot,
    openDirectoryInsideRoot,
    openRegularFileInsideRoot,
    openRegularFileInsideRootNoFollow,
    readFileHandleExactly,
    resolveInsideRoot,
    verifyStableFileObservation,
} from './root-bound-fs';

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

test('isRealPathInsideRoot requires a path-separator boundary', () => {
    assert.equal(isRealPathInsideRoot('/tmp/foo', '/tmp/foo'), true);
    assert.equal(isRealPathInsideRoot('/tmp/foo/bar', '/tmp/foo'), true);
    assert.equal(isRealPathInsideRoot('/tmp/foobar', '/tmp/foo'), false);
    assert.equal(isRealPathInsideRoot('/tmp/fo', '/tmp/foo'), false);
    assert.equal(isRealPathInsideRoot('/other/foo', '/tmp/foo'), false);
});

test('resolveInsideRoot rejects intermediate directory symlink escape', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-root-bound-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-root-bound-out-'));
    try {
        const nested = path.join(root, 'nested');
        fs.mkdirSync(nested);
        fs.writeFileSync(path.join(nested, 'file.ts'), 'export const inside = true;\n', 'utf8');
        fs.writeFileSync(path.join(outside, 'file.ts'), 'export const secret = "leaked";\n', 'utf8');

        const logicalFile = path.join(root, 'nested', 'file.ts');
        assert.equal(await resolveInsideRoot(logicalFile, root), path.resolve(logicalFile));

        fs.rmSync(nested, { recursive: true, force: true });
        if (!createDirectorySymlinkOrSkip(t, outside, nested)) {
            return;
        }

        assert.equal(await resolveInsideRoot(logicalFile, root), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('openRegularFileInsideRoot rejects intermediate directory symlink escape', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-open-bound-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-open-bound-out-'));
    try {
        const nested = path.join(root, 'nested');
        fs.mkdirSync(nested);
        const logicalFile = path.join(nested, 'file.ts');
        fs.writeFileSync(logicalFile, 'export const inside = true;\n', 'utf8');
        fs.writeFileSync(path.join(outside, 'file.ts'), 'export const secret = "leaked";\n', 'utf8');

        const okHandle = await openRegularFileInsideRoot(logicalFile, root);
        await okHandle.close();

        fs.rmSync(nested, { recursive: true, force: true });
        if (!createDirectorySymlinkOrSkip(t, outside, nested)) {
            return;
        }

        await assert.rejects(
            () => openRegularFileInsideRoot(logicalFile, root),
            /escapes indexed root|unreadable/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('openRegularFileInsideRoot rejects final-component file symlink escape', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-open-filelink-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-open-filelink-out-'));
    try {
        const outsideFile = path.join(outside, 'secret.ts');
        fs.writeFileSync(outsideFile, 'export const secret = "leaked";\n', 'utf8');
        const linkPath = path.join(root, 'linked.ts');
        if (!createFileSymlinkOrSkip(t, outsideFile, linkPath)) {
            return;
        }

        await assert.rejects(
            () => openRegularFileInsideRoot(linkPath, root),
            /escapes indexed root|unreadable|non-regular/,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('openRegularFileInsideRootNoFollow rejects a final-component symlink inside the root', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-open-nofollow-root-'));
    try {
        const targetPath = path.join(root, 'actual.ignore');
        const linkPath = path.join(root, '.gitignore');
        fs.writeFileSync(targetPath, 'generated/**\n', 'utf8');
        if (!createFileSymlinkOrSkip(t, targetPath, linkPath)) {
            return;
        }

        await assert.rejects(
            () => openRegularFileInsideRootNoFollow(linkPath, root),
            /symbolic-link|too many levels of symbolic links/i,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('openRegularFileInsideRootNoFollow has an explicit platform capability contract for ordinary files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-open-nofollow-capability-'));
    const filePath = path.join(root, '.gitignore');
    try {
        fs.writeFileSync(filePath, 'generated/**\n', 'utf8');
        if (process.platform !== 'linux') {
            await assert.rejects(
                () => openRegularFileInsideRootNoFollow(filePath, root),
                /descriptor-bound root validation is unavailable.*unsupported/i,
            );
            return;
        }
        const handle = await openRegularFileInsideRootNoFollow(filePath, root);
        try {
            assert.equal((await handle.stat()).isFile(), true);
        } finally {
            await handle.close();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('descriptor-bound indexing capability is preflighted explicitly', () => {
    if (process.platform === 'linux') {
        assert.doesNotThrow(() => assertDescriptorBoundIndexingSupported());
        return;
    }
    assert.throws(
        () => assertDescriptorBoundIndexingSupported(),
        /descriptor-bound root validation is unavailable.*unsupported/i,
    );
});

test('verifyStableFileObservation rejects pathname replacement after descriptor read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-stable-observation-root-'));
    const filePath = path.join(root, '.gitignore');
    const replacementPath = path.join(root, 'replacement.ignore');
    fs.writeFileSync(filePath, 'private/**\n', 'utf8');
    fs.writeFileSync(replacementPath, 'generated/*\n', 'utf8');
    const handle = await openRegularFileInsideRootNoFollow(filePath, root);
    try {
        const before = await handle.stat();
        await readFileHandleExactly(handle, before.size);
        fs.renameSync(replacementPath, filePath);

        await assert.rejects(
            () => verifyStableFileObservation(handle, filePath, root, before, {
                rejectFinalSymlink: true,
            }),
            /file changed while being read|path was replaced while being read/i,
        );
    } finally {
        await handle.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('descriptorPathInsideRoot rejects an already-open outside file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-fd-bound-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-fd-bound-out-'));
    const outsideFile = path.join(outside, 'secret.ts');
    fs.writeFileSync(outsideFile, 'export const secret = "leaked";\n', 'utf8');

    const handle = await fsp.open(outsideFile, fs.constants.O_RDONLY);
    try {
        await assert.rejects(
            () => descriptorPathInsideRoot(handle, root),
            /descriptor escapes indexed root/,
        );
    } finally {
        await handle.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('readFileHandleExactly rejects growth beyond the observed descriptor size', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-fd-exact-read-'));
    const filePath = path.join(root, 'source.ts');
    fs.writeFileSync(filePath, 'abc', 'utf8');
    const handle = await fsp.open(filePath, fs.constants.O_RDONLY);
    try {
        fs.appendFileSync(filePath, 'def', 'utf8');
        await assert.rejects(
            () => readFileHandleExactly(handle, 3),
            /grew beyond the observed size/,
        );
    } finally {
        await handle.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readFileHandleExactly rejects a short descriptor read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-fd-short-read-'));
    const filePath = path.join(root, 'source.ts');
    fs.writeFileSync(filePath, 'abc', 'utf8');
    const handle = await fsp.open(filePath, fs.constants.O_RDONLY);
    try {
        await assert.rejects(
            () => readFileHandleExactly(handle, 4),
            /does not match the observed size/,
        );
    } finally {
        await handle.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('openDirectoryInsideRoot keeps enumeration bound when its pathname becomes an outside symlink', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-dir-bound-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-dir-bound-out-'));
    const nested = path.join(root, 'nested');
    const moved = path.join(root, 'moved');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'inside.ts'), 'export const inside = true;\n', 'utf8');
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = "leaked";\n', 'utf8');

    const opened = await openDirectoryInsideRoot(nested, root);
    try {
        fs.renameSync(nested, moved);
        if (!createDirectorySymlinkOrSkip(t, outside, nested)) {
            return;
        }

        const entries = await fsp.readdir(opened.descriptorPath, { withFileTypes: true });
        assert.deepEqual(entries.map((entry) => entry.name), ['inside.ts']);
    } finally {
        await opened.handle.close();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
