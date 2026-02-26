import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileSynchronizer } = require('../../packages/core/dist/sync/synchronizer.js');

function trimTrailingSeparators(inputPath) {
  const parsedRoot = path.parse(inputPath).root;
  if (inputPath === parsedRoot) {
    return inputPath;
  }
  return inputPath.replace(/[\\/]+$/, '');
}

function canonicalizeCodebasePath(codebasePath) {
  const resolved = path.resolve(codebasePath);
  try {
    const realPath = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
    return trimTrailingSeparators(path.normalize(realPath));
  } catch {
    return trimTrailingSeparators(path.normalize(resolved));
  }
}

function getSnapshotPath(codebasePath) {
  const canonicalPath = canonicalizeCodebasePath(codebasePath);
  const hash = crypto.createHash('md5').update(canonicalPath).digest('hex');
  return path.join(os.homedir(), '.satori', 'merkle', `${hash}.json`);
}

function createTempCodebase(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-integration-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(absolutePath, content);
    } else {
      fs.writeFileSync(absolutePath, content, 'utf8');
    }
  }
  return root;
}

async function readSnapshot(codebasePath) {
  const snapshotPath = getSnapshotPath(codebasePath);
  const data = await fsp.readFile(snapshotPath, 'utf8');
  return JSON.parse(data);
}

async function cleanupCodebase(codebasePath) {
  await FileSynchronizer.deleteSnapshot(codebasePath);
  fs.rmSync(codebasePath, { recursive: true, force: true });
}

function resetSyncEnv() {
  process.env.SATORI_SYNC_FULL_HASH_EVERY_N = '0';
  delete process.env.SATORI_SYNC_HASH_CONCURRENCY;
}

test('integration: unchanged files do not rehash and touch-only changes settle', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const value = 1;\n',
  });

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const synchronizer = new FileSynchronizer(codebasePath, []);
    await synchronizer.initialize();

    const baseline = await synchronizer.checkForChanges();
    assert.deepEqual(baseline.added, []);
    assert.deepEqual(baseline.removed, []);
    assert.deepEqual(baseline.modified, []);
    assert.equal(baseline.hashedCount, 0);

    const filePath = path.join(codebasePath, 'src/main.ts');
    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(filePath, next, next);

    const touched = await synchronizer.checkForChanges();
    assert.deepEqual(touched.added, []);
    assert.deepEqual(touched.removed, []);
    assert.deepEqual(touched.modified, []);
    assert.equal(touched.hashedCount, 1);

    const settled = await synchronizer.checkForChanges();
    assert.deepEqual(settled.added, []);
    assert.deepEqual(settled.removed, []);
    assert.deepEqual(settled.modified, []);
    assert.equal(settled.hashedCount, 0);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: restart preserves snapshot baseline and still detects pending modifications', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const version = 1;\\n',
  });

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const firstSynchronizer = new FileSynchronizer(codebasePath, []);
    await firstSynchronizer.initialize();
    await firstSynchronizer.checkForChanges();

    const servicePath = path.join(codebasePath, 'src/service.ts');
    fs.writeFileSync(servicePath, 'export const version = 2;\\n', 'utf8');
    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(servicePath, next, next);

    const restartedSynchronizer = new FileSynchronizer(codebasePath, []);
    await restartedSynchronizer.initialize();
    const delta = await restartedSynchronizer.checkForChanges();

    assert.deepEqual(delta.modified, ['src/service.ts']);
    assert.equal(delta.hashedCount, 1);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: binary files are hashed as bytes and modifications are detected', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'assets/blob.bin': Buffer.from([0xff, 0x00, 0x7f, 0x12, 0x34, 0xab]),
  });

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const synchronizer = new FileSynchronizer(codebasePath, []);
    await synchronizer.initialize();

    const first = await synchronizer.checkForChanges();
    assert.equal(first.hashedCount, 0);

    const binaryPath = path.join(codebasePath, 'assets/blob.bin');
    fs.writeFileSync(binaryPath, Buffer.from([0xff, 0x00, 0x7f, 0x12, 0x34, 0xac]));
    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(binaryPath, next, next);

    const changed = await synchronizer.checkForChanges();
    assert.deepEqual(changed.modified, ['assets/blob.bin']);
    assert.equal(changed.hashedCount, 1);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: unreadable directory triggers partial scan and preserves prior state', async () => {
  if (process.platform === 'win32') {
    return;
  }

  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/readable.ts': 'export const readable = true;\n',
    'subdir/locked.ts': 'export const locked = true;\n',
  });

  const lockedDir = path.join(codebasePath, 'subdir');

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const synchronizer = new FileSynchronizer(codebasePath, []);
    await synchronizer.initialize();

    const baseline = await synchronizer.checkForChanges();
    assert.equal(baseline.partialScan, false);

    const snapshotBefore = await readSnapshot(codebasePath);

    fs.chmodSync(lockedDir, 0o000);
    const partial = await synchronizer.checkForChanges();

    assert.equal(partial.partialScan, true);
    assert.deepEqual(partial.unscannedDirPrefixes, ['subdir']);
    assert.ok(!partial.removed.includes('subdir/locked.ts'));

    const snapshotAfter = await readSnapshot(codebasePath);
    assert.equal(snapshotAfter.partialScan, true);
    assert.deepEqual(snapshotAfter.unscannedDirPrefixes, ['subdir']);
    assert.equal(snapshotAfter.merkleRoot, snapshotBefore.merkleRoot);
  } finally {
    fs.chmodSync(lockedDir, 0o755);
    await cleanupCodebase(codebasePath);
  }
});

test('integration: segment-safe prefix handling does not preserve sibling directories', async () => {
  if (process.platform === 'win32') {
    return;
  }

  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'a/one.ts': 'export const one = 1;\n',
    'ab/two.ts': 'export const two = 2;\n',
  });

  const unreadableDir = path.join(codebasePath, 'a');

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const synchronizer = new FileSynchronizer(codebasePath, []);
    await synchronizer.initialize();
    await synchronizer.checkForChanges();

    fs.rmSync(path.join(codebasePath, 'ab/two.ts'));
    fs.chmodSync(unreadableDir, 0o000);

    const changes = await synchronizer.checkForChanges();

    assert.equal(changes.partialScan, true);
    assert.deepEqual(changes.unscannedDirPrefixes, ['a']);
    assert.ok(changes.removed.includes('ab/two.ts'));
    assert.ok(!changes.removed.includes('a/one.ts'));
  } finally {
    fs.chmodSync(unreadableDir, 0o755);
    await cleanupCodebase(codebasePath);
  }
});
