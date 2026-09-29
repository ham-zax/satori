import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileSynchronizer } = require('../../packages/core/dist/sync/synchronizer.js');
const {
  DEFAULT_IGNORE_PATTERNS,
  getSupportedExtensionsForIndexProfile
} = require('../../packages/core/dist/config/defaults.js');

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

function cleanupCodebase(codebasePath) {
  fs.rmSync(codebasePath, { recursive: true, force: true });
}

async function seedSynchronizer(codebasePath, ignorePatterns = [], supportedExtensions) {
  const synchronizer = new FileSynchronizer(codebasePath, ignorePatterns, supportedExtensions);
  const initial = await synchronizer.prepareChanges();
  await initial.commit();
  return synchronizer;
}

function resetSyncEnv() {
  process.env.SATORI_SYNC_FULL_HASH_EVERY_N = '0';
  delete process.env.SATORI_SYNC_HASH_CONCURRENCY;
}

test('integration: default profile tracks safe-broad source config scripts and extensionless files', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'scripts/check-version-freshness.mjs': 'export function checkVersionFreshness() { return true; }\n',
    'scripts/release-smoke.cjs': 'module.exports = function releaseSmoke() { return true; };\n',
    'scripts/release.sh': 'echo release\n',
    'config/app.toml': '[app]\nname = "demo"\n',
    'config/workflow.yaml': 'name: demo\n',
    'Dockerfile': 'FROM node:20\n',
    '.env': 'TOKEN=secret\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'public/app.min.js': 'function minified(){}\n',
    'assets/blob.bin': Buffer.from([0, 1, 2, 3]),
  });

  try {
    const synchronizer = await seedSynchronizer(codebasePath, DEFAULT_IGNORE_PATTERNS);
    const persistedKeys = synchronizer.getTrackedRelativePaths();

    assert.equal(persistedKeys.includes('scripts/check-version-freshness.mjs'), true);
    assert.equal(persistedKeys.includes('scripts/release-smoke.cjs'), true);
    assert.equal(persistedKeys.includes('scripts/release.sh'), true);
    assert.equal(persistedKeys.includes('config/app.toml'), true);
    assert.equal(persistedKeys.includes('config/workflow.yaml'), true);
    assert.equal(persistedKeys.includes('Dockerfile'), true);
    assert.equal(persistedKeys.includes('.env'), false);
    assert.equal(persistedKeys.includes('pnpm-lock.yaml'), false);
    assert.equal(persistedKeys.includes('public/app.min.js'), false);
    assert.equal(persistedKeys.includes('assets/blob.bin'), false);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: minimal profile excludes config and scripts but keeps code and docs', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/app.ts': 'export const app = true;\n',
    'README.md': '# Demo\n',
    'config/app.yaml': 'app:\n  name: demo\n',
    'scripts/release.zsh': 'echo release\n',
    // TOML and Bash are navigation languages, so minimal keeps them.
    'config/app.toml': '[app]\nname = "demo"\n',
    'scripts/release.sh': 'echo release\n',
  });

  try {
    const synchronizer = await seedSynchronizer(
      codebasePath,
      [],
      getSupportedExtensionsForIndexProfile('minimal')
    );
    const persistedKeys = synchronizer.getTrackedRelativePaths();

    assert.equal(persistedKeys.includes('src/app.ts'), true);
    assert.equal(persistedKeys.includes('README.md'), true);
    assert.equal(persistedKeys.includes('config/app.yaml'), false);
    assert.equal(persistedKeys.includes('scripts/release.zsh'), false);
    assert.equal(persistedKeys.includes('config/app.toml'), true);
    assert.equal(persistedKeys.includes('scripts/release.sh'), true);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: all-text profile tracks unknown UTF-8 text and rejects binary payloads', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'notes/domain.customext': 'domain specific text\n',
    'data/blob.custombin': Buffer.from([0, 159, 146, 150]),
  });

  try {
    const synchronizer = await seedSynchronizer(
      codebasePath,
      [],
      getSupportedExtensionsForIndexProfile('all-text')
    );
    const persistedKeys = synchronizer.getTrackedRelativePaths();

    assert.equal(persistedKeys.includes('notes/domain.customext'), true);
    assert.equal(persistedKeys.includes('data/blob.custombin'), false);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: Publication source checkpoints survive canonical path variants', async () => {
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
    const firstSynchronizer = await seedSynchronizer(variants[0], []);
    const checkpoint = firstSynchronizer.getSourceCheckpoint();

    for (const variant of variants) {
      const synchronizer = new FileSynchronizer(variant, [], undefined, { sourceCheckpoint: checkpoint });
      const prepared = await synchronizer.prepareChanges();
      assert.deepEqual(prepared.changes.added, []);
      assert.deepEqual(prepared.changes.removed, []);
      assert.deepEqual(prepared.changes.modified, []);
      assert.equal(prepared.changes.hashedCount, 0);
    }
  } finally {
    if (hasSymlinkVariant) {
      fs.rmSync(symlinkPath, { recursive: true, force: true });
    }
    cleanupCodebase(codebasePath);
  }
});

test('integration: unchanged files do not rehash and touch-only changes settle', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/main.ts': 'export const value = 1;\n',
  });

  try {
    const synchronizer = await seedSynchronizer(codebasePath, []);

    const baseline = await synchronizer.prepareChanges();
    assert.deepEqual(baseline.changes.added, []);
    assert.deepEqual(baseline.changes.removed, []);
    assert.deepEqual(baseline.changes.modified, []);
    assert.equal(baseline.changes.hashedCount, 0);

    const filePath = path.join(codebasePath, 'src/main.ts');
    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(filePath, next, next);

    const touched = await synchronizer.prepareChanges();
    assert.deepEqual(touched.changes.added, []);
    assert.deepEqual(touched.changes.removed, []);
    assert.deepEqual(touched.changes.modified, []);
    assert.equal(touched.changes.hashedCount, 1);
    await touched.commit();

    const settled = await synchronizer.prepareChanges();
    assert.deepEqual(settled.changes.added, []);
    assert.deepEqual(settled.changes.removed, []);
    assert.deepEqual(settled.changes.modified, []);
    assert.equal(settled.changes.hashedCount, 0);
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
    const synchronizer = await seedSynchronizer(codebasePath, []);

    fs.rmSync(path.join(codebasePath, 'src/remove-me.ts'));
    const delta = await synchronizer.prepareChanges();
    assert.deepEqual(delta.changes.removed, ['src/remove-me.ts']);
    assert.ok(!delta.changes.modified.includes('src/remove-me.ts'));
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: restart from a Publication source checkpoint detects pending modifications', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/service.ts': 'export const version = 1;\\n',
  });

  try {
    const firstSynchronizer = await seedSynchronizer(codebasePath, []);
    const checkpoint = firstSynchronizer.getSourceCheckpoint();

    const servicePath = path.join(codebasePath, 'src/service.ts');
    fs.writeFileSync(servicePath, 'export const version = 2;\\n', 'utf8');
    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(servicePath, next, next);

    const restartedSynchronizer = new FileSynchronizer(
      codebasePath,
      [],
      undefined,
      { sourceCheckpoint: checkpoint },
    );
    const delta = await restartedSynchronizer.prepareChanges();

    assert.deepEqual(delta.changes.modified, ['src/service.ts']);
    assert.equal(delta.changes.hashedCount, 1);
  } finally {
    cleanupCodebase(codebasePath);
  }
});

test('integration: binary files are hashed as bytes and modifications are detected', async () => {
  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'assets/blob.bin': Buffer.from([0xff, 0x00, 0x7f, 0x12, 0x34, 0xab]),
  });

  try {
    const synchronizer = await seedSynchronizer(codebasePath, [], ['.bin']);

    const binaryPath = path.join(codebasePath, 'assets/blob.bin');
    fs.writeFileSync(binaryPath, Buffer.from([0xff, 0x00, 0x7f, 0x12, 0x34, 0xac]));
    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(binaryPath, next, next);

    const changed = await synchronizer.prepareChanges();
    assert.deepEqual(changed.changes.modified, ['assets/blob.bin']);
    assert.equal(changed.changes.hashedCount, 1);
  } finally {
    await cleanupCodebase(codebasePath);
  }
});

test('integration: incomplete file observation is refused before Publication checkpoint construction', async (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('cannot simulate unreadable files on this platform/user');
    return;
  }

  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/locked.ts': 'export const locked = true;\n',
    'src/readable.ts': 'export const readable = true;\n',
  });

  const lockedFile = path.join(codebasePath, 'src/locked.ts');

  try {
    const synchronizer = await seedSynchronizer(codebasePath, []);

    const now = new Date();
    const next = new Date(now.getTime() + 5000);
    fs.utimesSync(lockedFile, next, next);
    fs.chmodSync(lockedFile, 0o000);

    await assert.rejects(
      () => synchronizer.prepareChanges(),
      /Source observation is incomplete/,
    );

    fs.chmodSync(lockedFile, 0o644);
    const restored = await synchronizer.prepareChanges();
    assert.deepEqual(restored.changes.added, []);
    assert.deepEqual(restored.changes.removed, []);
    assert.deepEqual(restored.changes.modified, []);
  } finally {
    if (fs.existsSync(lockedFile)) {
      fs.chmodSync(lockedFile, 0o644);
    }
    cleanupCodebase(codebasePath);
  }
});

test('integration: incomplete directory observation is refused before Publication checkpoint construction', async (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('cannot simulate unreadable directories on this platform/user');
    return;
  }

  resetSyncEnv();
  const codebasePath = createTempCodebase({
    'src/readable.ts': 'export const readable = true;\n',
    'subdir/locked.ts': 'export const locked = true;\n',
  });

  const lockedDir = path.join(codebasePath, 'subdir');

  try {
    const synchronizer = await seedSynchronizer(codebasePath, []);

    fs.chmodSync(lockedDir, 0o000);
    await assert.rejects(
      () => synchronizer.prepareChanges(),
      /Source observation is incomplete/,
    );

    fs.chmodSync(lockedDir, 0o755);
    const restored = await synchronizer.prepareChanges();
    assert.deepEqual(restored.changes.added, []);
    assert.deepEqual(restored.changes.removed, []);
    assert.deepEqual(restored.changes.modified, []);
  } finally {
    if (fs.existsSync(lockedDir)) {
      fs.chmodSync(lockedDir, 0o755);
    }
    cleanupCodebase(codebasePath);
  }
});
