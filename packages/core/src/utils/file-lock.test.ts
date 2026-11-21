import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    claimAndUnlinkStaleFileLock,
    publishAtomicFileLock,
    removeOwnedFileLockIfUnchanged,
} from './file-lock';

test('publishAtomicFileLock publishes complete content and removeOwnedFileLockIfUnchanged verifies inode', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-file-lock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, 'test.lock');

    const first = publishAtomicFileLock(lockPath, '{"owner":"first"}\n');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"owner":"first"}\n');
    assert.throws(() => publishAtomicFileLock(lockPath, '{"owner":"second"}\n'), { code: 'EEXIST' });

    // Replace lockPath with a different inode carrying identical content.
    fs.renameSync(lockPath, `${lockPath}.displaced`);
    fs.writeFileSync(lockPath, '{"owner":"first"}\n');
    assert.equal(removeOwnedFileLockIfUnchanged(lockPath, first), false);
    assert.equal(fs.existsSync(lockPath), true);

    const replacementStat = fs.lstatSync(lockPath);
    assert.equal(removeOwnedFileLockIfUnchanged(lockPath, replacementStat), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(removeOwnedFileLockIfUnchanged(lockPath, replacementStat), false);
});

test('claimAndUnlinkStaleFileLock backs off on replacement or concurrent peer claim', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-file-lock-stale-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lockPath = path.join(dir, 'test.lock');

    // Replacement during stale inspection is preserved.
    fs.writeFileSync(lockPath, '{"pid":999999}');
    const replaced = claimAndUnlinkStaleFileLock(lockPath, () => {
        fs.renameSync(lockPath, `${lockPath}.old`);
        fs.writeFileSync(lockPath, '{"pid":123,"owner":"new"}');
        return true;
    });
    assert.equal(replaced, false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"pid":123,"owner":"new"}');

    // Concurrent peer hard-link claim (nlink > 2) causes backoff.
    fs.linkSync(lockPath, `${lockPath}.peer`);
    const contested = claimAndUnlinkStaleFileLock(lockPath, () => true);
    assert.equal(contested, false);
    assert.equal(fs.existsSync(lockPath), true);
    fs.unlinkSync(`${lockPath}.peer`);

    // Uncontested stale lock is reclaimed and no stale-claim artifact remains.
    assert.equal(claimAndUnlinkStaleFileLock(lockPath, () => true), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(
        fs.readdirSync(dir).filter((name) => name.includes('.stale-claim')),
        [],
    );
});
