import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileSynchronizer } = require('../../packages/core/dist/sync/synchronizer.js');

function getSnapshotPath(codebasePath) {
  return FileSynchronizer.getSnapshotPathForCodebase(codebasePath);
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

function isNormalizedRelPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.includes('//')
    && !value.startsWith('./')
    && !value.startsWith('/')
    && !value.includes('/./')
    && !value.split('/').includes('..')
    && !value.endsWith('/');
}

test('integration: snapshot identity parity across path variants and deleteSnapshot SSOT', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const value = 1;\n',
  });

  const variants = [
    codebasePath,
    `${codebasePath}${path.sep}`,
    path.resolve(codebasePath, '.'),
    path.resolve(codebasePath, '..', path.basename(codebasePath)),
  ];

  const symlinkPath = `${codebasePath}-symlink`;
  let hasSymlinkVariant = false;
  try {
    fs.symlinkSync(codebasePath, symlinkPath, 'dir');
    variants.push(symlinkPath);
    hasSymlinkVariant = true;
  } catch {
    // Symlink creation may be restricted on some environments.
  }

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const snapshotPaths = new Set(variants.map((candidate) => getSnapshotPath(candidate)));
    assert.equal(snapshotPaths.size, 1);

    const firstSynchronizer = new FileSynchronizer(variants[0], []);
    await firstSynchronizer.initialize();
    const firstRun = await firstSynchronizer.checkForChanges();
    assert.deepEqual(firstRun.added, []);
    assert.deepEqual(firstRun.removed, []);
    assert.deepEqual(firstRun.modified, []);
    assert.equal(firstRun.hashedCount, 0);

    for (const variant of variants) {
      const synchronizer = new FileSynchronizer(variant, []);
      await synchronizer.initialize();
      const result = await synchronizer.checkForChanges();
      assert.deepEqual(result.added, []);
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.modified, []);
      assert.equal(result.hashedCount, 0);
    }

    const snapshotPath = getSnapshotPath(variants[0]);
    assert.equal(fs.existsSync(snapshotPath), true);
    await FileSynchronizer.deleteSnapshot(variants[variants.length - 1]);
    assert.equal(fs.existsSync(snapshotPath), false);
  } finally {
    if (hasSymlinkVariant) {
      fs.rmSync(symlinkPath, { recursive: true, force: true });
    }
    await cleanupCodebase(codebasePath);
  }
});

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
    assert.equal(baseline.partialScan, false);

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

test('integration: true file removals are detected deterministically', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/remove-me.ts': 'export const removeMe = true;\n',
    'src/keep.ts': 'export const keep = true;\n',
  });

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const synchronizer = new FileSynchronizer(codebasePath, []);
    await synchronizer.initialize();
    await synchronizer.checkForChanges();

    fs.rmSync(path.join(codebasePath, 'src/remove-me.ts'));
    const delta = await synchronizer.checkForChanges();
    assert.deepEqual(delta.removed, ['src/remove-me.ts']);
    assert.ok(!delta.modified.includes('src/remove-me.ts'));
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

test('integration: unreadable file hash-fail triggers partial scan and preserves prior file state', async () => {
  if (process.platform === 'win32') {
    return;
  }

  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/locked.ts': 'export const locked = true;\n',
    'src/readable.ts': 'export const readable = true;\n',
  });

  const lockedFile = path.join(codebasePath, 'src/locked.ts');

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);

    const synchronizer = new FileSynchronizer(codebasePath, []);
    await synchronizer.initialize();
    await synchronizer.checkForChanges();

    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(lockedFile, next, next);
    fs.chmodSync(lockedFile, 0o000);

    const partial = await synchronizer.checkForChanges();
    assert.equal(partial.partialScan, true);
    assert.ok(!partial.removed.includes('src/locked.ts'));
    assert.ok(!partial.modified.includes('src/locked.ts'));

    fs.chmodSync(lockedFile, 0o644);
    const restored = await synchronizer.checkForChanges();
    assert.ok(!restored.added.includes('src/locked.ts'));
    assert.ok(!restored.removed.includes('src/locked.ts'));
  } finally {
    if (fs.existsSync(lockedFile)) {
      fs.chmodSync(lockedFile, 0o644);
    }
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

test('integration: normalization SSOT applies to snapshot keys and diff outputs including backslashes', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const main = true;\n',
    'a/b.ts': 'export const nested = true;\n',
    'a/c/d.ts': 'export const deep = true;\n',
  });

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);
    const snapshotPath = getSnapshotPath(codebasePath);
    await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });

    const normalizationFixtures = [
      { raw: './src\\main.ts', expected: 'src/main.ts' },
      { raw: 'a//b.ts', expected: 'a/b.ts' },
      { raw: './a//c\\d.ts', expected: 'a/c/d.ts' },
    ];
    const rejectedFixtures = [
      '../escape.ts',
      'a/../escape.ts',
    ];

    const dirtySnapshot = {
      snapshotVersion: 2,
      fileHashes: [
        ...normalizationFixtures.map(({ raw, expected }) => [raw, `hash-${expected}`]),
        ...rejectedFixtures.map((raw) => [raw, `hash-rejected-${raw}`]),
      ],
      fileStats: [
        ...normalizationFixtures.map(({ raw }) => [raw, { size: 1, mtimeMs: 0, ctimeMs: 0 }]),
        ...rejectedFixtures.map((raw) => [raw, { size: 1, mtimeMs: 0, ctimeMs: 0 }]),
      ],
      merkleRoot: '',
      partialScan: false,
      unscannedDirPrefixes: ['a//', './a/b', '../bad'],
      fullHashCounter: 0,
    };

    await fsp.writeFile(snapshotPath, JSON.stringify(dirtySnapshot), 'utf8');

    const synchronizer = new FileSynchronizer(codebasePath, []);
    await synchronizer.initialize();
    const changes = await synchronizer.checkForChanges();

    for (const relPath of [...changes.added, ...changes.removed, ...changes.modified]) {
      assert.equal(isNormalizedRelPath(relPath), true);
    }

    const persistedSnapshot = await readSnapshot(codebasePath);
    const persistedKeys = persistedSnapshot.fileHashes.map(([key]) => key);
    assert.ok(persistedKeys.every((key) => isNormalizedRelPath(key)));
    assert.ok(!persistedKeys.some((key) => key.includes('//')));
    assert.ok(!persistedKeys.some((key) => key.includes('..')));
    assert.ok(!persistedKeys.some((key) => key.includes('\\')));
    for (const { expected } of normalizationFixtures) {
      assert.ok(persistedKeys.includes(expected));
    }
    assert.ok(!persistedKeys.some((key) => key.includes('escape.ts')));
  } finally {
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

test('integration: prefix normalization and compression are deterministic', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const main = true;\n',
  });

  try {
    await FileSynchronizer.deleteSnapshot(codebasePath);
    const synchronizer = new FileSynchronizer(codebasePath, []);
    const compressed = synchronizer.normalizeAndCompressPrefixes(new Set(['a', 'a/', 'a//', 'a/b', 'ab', 'a/b/c']));
    assert.deepEqual(compressed, ['a', 'ab']);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});
