import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_PACKAGES,
  RELEASE_ORDER,
  parseStableVersion,
  formatStableVersion,
  incrementStableVersion,
  compareStableVersions,
  affectedReleasePackages,
  readLocalReleaseGraph,
  validatePackedDependencyGraph,
  createFileTreeSnapshot,
  compareFileTreeSnapshots,
  buildReleaseGraphReport,
} from './release-graph.mjs';

function createWorkspace(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-release-graph-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return cwd;
}

function standardWorkspace(overrides = {}) {
  return createWorkspace({
    'packages/core/package.json': {
      name: '@satori-code/core',
      version: '3.6.0',
      dependencies: { '@lancedb/lancedb': '0.31.0', 'oxc-parser': '0.139.0' },
    },
    'packages/mcp/package.json': {
      name: '@satori-code/mcp',
      version: '6.8.0',
      dependencies: {
        '@satori-code/core': 'workspace:*',
        '@huggingface/transformers': '3.0.2',
        'onnxruntime-node': '1.19.2',
      },
    },
    'packages/cli/package.json': {
      name: '@satori-code/cli',
      version: '1.9.0',
      dependencies: {},
      satoriManagedRuntime: {
        mcp: '6.8.0',
        core: '3.6.0',
        lanceDb: '0.31.0',
        oxcParser: '0.139.0',
        lateOn: { transformers: '3.0.2', onnxruntimeNode: '1.19.2' },
      },
    },
    'server.json': { version: '6.8.0' },
    ...overrides,
  });
}

test('stable version parsing accepts major.minor.patch', () => {
  assert.deepEqual(parseStableVersion('3.5.9'), { major: 3, minor: 5, patch: 9 });
  assert.deepEqual(parseStableVersion('0.0.0'), { major: 0, minor: 0, patch: 0 });
  assert.deepEqual(parseStableVersion('10.20.30'), { major: 10, minor: 20, patch: 30 });
});

test('stable version parsing rejects invalid shapes', () => {
  for (const invalid of [
    '3.5',
    '3.5.9.1',
    'v3.5.9',
    '3.5.9-beta.1',
    '^3.5.9',
    '~3.5.9',
    'workspace:*',
    '3.-5.9',
    '-1.0.0',
    '3.5.9-rc.0',
    '3.5.99999999999999999999',
    '3.5.',
    '',
  ]) {
    assert.throws(() => parseStableVersion(invalid), /major\.minor\.patch/, `should reject ${invalid}`);
  }
  assert.throws(() => parseStableVersion(42), /must be a string/);
  assert.throws(() => parseStableVersion(null), /must be a string/);
});

test('formatStableVersion round trips parsed versions', () => {
  assert.equal(formatStableVersion({ major: 3, minor: 5, patch: 9 }), '3.5.9');
  assert.equal(formatStableVersion(parseStableVersion('0.1.2')), '0.1.2');
  assert.throws(() => formatStableVersion({ major: 1, minor: -1, patch: 0 }), /negative/);
});

test('incrementStableVersion applies patch, minor, and major', () => {
  assert.equal(incrementStableVersion('3.5.9', 'patch'), '3.5.10');
  assert.equal(incrementStableVersion('3.5.9', 'minor'), '3.6.0');
  assert.equal(incrementStableVersion('3.5.9', 'major'), '4.0.0');
  assert.equal(incrementStableVersion('3.5.0', 'patch'), '3.5.1');
  assert.equal(incrementStableVersion('0.9.9', 'minor'), '0.10.0');
  assert.throws(() => incrementStableVersion('3.5.9', 'prerelease'), /bump kind/);
  assert.throws(() => incrementStableVersion('3.5', 'patch'), /major\.minor\.patch/);
});

test('stable versions compare numerically rather than lexically', () => {
  assert.equal(compareStableVersions('3.10.0', '3.9.9'), 1);
  assert.equal(compareStableVersions('3.9.9', '3.10.0'), -1);
  assert.equal(compareStableVersions('3.10.0', '3.10.0'), 0);
});

test('affectedReleasePackages returns reverse dependency closure', () => {
  assert.deepEqual(affectedReleasePackages('core'), ['core', 'mcp', 'cli']);
  assert.deepEqual(affectedReleasePackages('mcp'), ['mcp', 'cli']);
  assert.deepEqual(affectedReleasePackages('cli'), ['cli']);
  assert.throws(() => affectedReleasePackages('unknown'), /Unknown release package key/);
});

test('readLocalReleaseGraph reads manifests and server.json', () => {
  const cwd = standardWorkspace();
  const graph = readLocalReleaseGraph(cwd);
  assert.equal(graph.packages.core.versionString, '3.6.0');
  assert.equal(graph.packages.mcp.versionString, '6.8.0');
  assert.equal(graph.packages.cli.versionString, '1.9.0');
  assert.equal(graph.serverJson.version, '6.8.0');
  assert.equal(graph.packages.core.name, RELEASE_PACKAGES.core.name);
  assert.equal(graph.packages.cli.directory, 'packages/cli');
});

test('server.json mismatch is rejected', () => {
  const cwd = standardWorkspace({ 'server.json': { version: '6.7.0' } });
  assert.throws(() => readLocalReleaseGraph(cwd), /server\.json version .* must equal local MCP version 6\.8\.0/);
});

test('non-workspace MCP dependency on Core is rejected', () => {
  const cwd = standardWorkspace({
    'packages/mcp/package.json': {
      name: '@satori-code/mcp',
      version: '6.8.0',
      dependencies: { '@satori-code/core': '^3.6.0' },
    },
  });
  assert.throws(() => readLocalReleaseGraph(cwd), /must remain workspace:\*/);
});

test('CLI bootstrap dependency on managed runtime is rejected', () => {
  const cwd = standardWorkspace({
    'packages/cli/package.json': {
      name: '@satori-code/cli',
      version: '1.9.0',
      dependencies: { '@satori-code/mcp': '6.8.0' },
      satoriManagedRuntime: {
        mcp: '6.8.0',
        core: '3.6.0',
        lanceDb: '0.31.0',
        oxcParser: '0.139.0',
        lateOn: { transformers: '3.0.2', onnxruntimeNode: '1.19.2' },
      },
    },
  });
  assert.throws(() => readLocalReleaseGraph(cwd), /must not install managed runtime dependency/);
});

test('wrong package names and unstable versions are rejected', () => {
  const cwd = standardWorkspace({
    'packages/core/package.json': { name: '@satori-code/wrong', version: '3.6.0' },
  });
  assert.throws(() => readLocalReleaseGraph(cwd), /name must be @satori-code\/core/);

  const prerelease = standardWorkspace({
    'packages/mcp/package.json': {
      name: '@satori-code/mcp',
      version: '6.8.0-rc.1',
      dependencies: { '@satori-code/core': 'workspace:*' },
    },
  });
  assert.throws(() => readLocalReleaseGraph(prerelease), /major\.minor\.patch/);
});

function packedManifests(overrides = {}) {
  return {
    core: { name: '@satori-code/core', version: '3.6.0', dependencies: {} },
    mcp: {
      name: '@satori-code/mcp',
      version: '6.8.0',
      dependencies: { '@satori-code/core': '3.6.0' },
    },
    cli: {
      name: '@satori-code/cli',
      version: '1.9.0',
      dependencies: {},
      satoriManagedRuntime: { core: '3.6.0', mcp: '6.8.0' },
    },
    ...overrides,
  };
}

test('exact packed dependency graph is accepted', () => {
  const result = validatePackedDependencyGraph({
    localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
    packedManifests: packedManifests(),
  });
  assert.deepEqual(result.edges, [
    { from: 'mcp', to: 'core', kind: 'dependency', version: '3.6.0' },
    { from: 'cli', to: 'mcp', kind: 'managed-runtime', version: '6.8.0' },
    { from: 'cli', to: 'core', kind: 'managed-runtime', version: '3.6.0' },
  ]);
});

test('packed MCP with stale Core pin is rejected', () => {
  assert.throws(
    () =>
      validatePackedDependencyGraph({
        localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
        packedManifests: packedManifests({
          mcp: { name: '@satori-code/mcp', version: '6.8.0', dependencies: { '@satori-code/core': '3.5.0' } },
        }),
      }),
    /@satori-code\/core.*exact version 3\.6\.0.*received "3\.5\.0"/
  );
});

test('packed CLI with stale MCP pin is rejected', () => {
  assert.throws(
    () =>
      validatePackedDependencyGraph({
        localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
        packedManifests: packedManifests({
          cli: {
            name: '@satori-code/cli',
            version: '1.9.0',
            dependencies: {},
            satoriManagedRuntime: { core: '3.6.0', mcp: '6.7.0' },
          },
        }),
      }),
    /@satori-code\/mcp.*exact version 6\.8\.0.*received "6\.7\.0"/
  );
});

test('packed CLI with stale Core pin is rejected', () => {
  assert.throws(
    () =>
      validatePackedDependencyGraph({
        localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
        packedManifests: packedManifests({
          cli: {
            name: '@satori-code/cli',
            version: '1.9.0',
            dependencies: {},
            satoriManagedRuntime: { core: '3.5.0', mcp: '6.8.0' },
          },
        }),
      }),
    /@satori-code\/core.*exact version 3\.6\.0.*received "3\.5\.0"/
  );
});

test('dependency ranges and workspace syntax in packed manifests are rejected', () => {
  for (const badDependency of ['workspace:*', '^3.6.0', '~3.6.0', '>=3.6.0', '3.6.x']) {
    assert.throws(
      () =>
        validatePackedDependencyGraph({
          localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
          packedManifests: packedManifests({
            mcp: { name: '@satori-code/mcp', version: '6.8.0', dependencies: { '@satori-code/core': badDependency } },
          }),
        }),
      /exact version/,
      `should reject ${badDependency}`
    );
  }
});

test('missing packed managed-runtime target is rejected', () => {
  assert.throws(
    () =>
      validatePackedDependencyGraph({
        localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
        packedManifests: packedManifests({
          cli: {
            name: '@satori-code/cli',
            version: '1.9.0',
            dependencies: {},
            satoriManagedRuntime: { core: '3.6.0' },
          },
        }),
      }),
    /exact version 6\.8\.0.*received undefined/
  );
});

test('packed version mismatches and prereleases are rejected', () => {
  assert.throws(
    () =>
      validatePackedDependencyGraph({
        localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
        packedManifests: packedManifests({ core: { name: '@satori-code/core', version: '3.5.0', dependencies: {} } }),
      }),
    /does not match local version 3\.6\.0/
  );
  assert.throws(
    () =>
      validatePackedDependencyGraph({
        localVersions: { core: '3.6.0', mcp: '6.8.0', cli: '1.9.0' },
        packedManifests: packedManifests({ core: { name: '@satori-code/core', version: '3.6.0-beta.1', dependencies: {} } }),
      }),
    /major\.minor\.patch/
  );
});

function writeTree(root, files, options = {}) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    if (options.executablePaths && options.executablePaths.includes(relative)) {
      fs.chmodSync(absolute, 0o755);
    }
  }
}

test('identical normalized snapshots compare equal despite directory mtimes', () => {
  const leftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-left-'));
  const rightRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-right-'));
  const files = {
    'package/package.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
    'package/dist/index.js': 'module.exports = 1;\n',
    'package/README.md': 'readme',
  };
  writeTree(leftRoot, files);
  writeTree(rightRoot, files);
  fs.utimesSync(path.join(leftRoot, 'package'), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(leftRoot, 'package/dist'), new Date(2000), new Date(2000));
  fs.utimesSync(path.join(rightRoot, 'package'), new Date(3000), new Date(3000));
  fs.utimesSync(path.join(rightRoot, 'package/dist'), new Date(4000), new Date(4000));
  const comparison = compareFileTreeSnapshots(createFileTreeSnapshot(leftRoot), createFileTreeSnapshot(rightRoot));
  assert.equal(comparison.identical, true);
  assert.deepEqual(comparison.changes, []);
});

test('content change compares unequal', () => {
  const leftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-left-'));
  const rightRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-right-'));
  writeTree(leftRoot, { 'package/package.json': '{"a":1}' });
  writeTree(rightRoot, { 'package/package.json': '{"a":2}' });
  const comparison = compareFileTreeSnapshots(createFileTreeSnapshot(leftRoot), createFileTreeSnapshot(rightRoot));
  assert.equal(comparison.identical, false);
  assert.deepEqual(comparison.changes, [{ path: 'package/package.json', change: 'content' }]);
});

test('executable-bit change compares unequal', () => {
  const leftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-left-'));
  const rightRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-right-'));
  writeTree(leftRoot, { 'package/bin/tool': '#!/bin/sh\necho hi\n' }, { executablePaths: ['package/bin/tool'] });
  writeTree(rightRoot, { 'package/bin/tool': '#!/bin/sh\necho hi\n' });
  const comparison = compareFileTreeSnapshots(createFileTreeSnapshot(leftRoot), createFileTreeSnapshot(rightRoot));
  assert.equal(comparison.identical, false);
  assert.deepEqual(comparison.changes, [{ path: 'package/bin/tool', change: 'mode' }]);
});

test('added and removed files compare unequal', () => {
  const leftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-left-'));
  const rightRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-right-'));
  writeTree(leftRoot, { 'package/package.json': '{}', 'package/a.js': '1' });
  writeTree(rightRoot, { 'package/package.json': '{}', 'package/b.js': '2' });
  const comparison = compareFileTreeSnapshots(createFileTreeSnapshot(leftRoot), createFileTreeSnapshot(rightRoot));
  assert.equal(comparison.identical, false);
  assert.deepEqual(comparison.changes, [
    { path: 'package/a.js', change: 'removed' },
    { path: 'package/b.js', change: 'added' },
  ]);
});

test('symlink in extracted package is rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-symlink-'));
  fs.mkdirSync(path.join(root, 'package'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package/target.js'), '1');
  fs.symlinkSync('target.js', path.join(root, 'package/link.js'));
  assert.throws(() => createFileTreeSnapshot(root), /Symlink not allowed/);
});

test('snapshots are sorted and include package.json, assets, and executable bits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-snap-order-'));
  writeTree(
    root,
    {
      'package/package.json': '{}',
      'package/assets/linux-x64/bin': 'binary',
      'package/dist/z.js': 'z',
      'package/dist/a.js': 'a',
    },
    { executablePaths: ['package/assets/linux-x64/bin'] }
  );
  const snapshot = createFileTreeSnapshot(root);
  assert.deepEqual(
    snapshot.map((entry) => entry.path),
    ['package/assets/linux-x64/bin', 'package/dist/a.js', 'package/dist/z.js', 'package/package.json']
  );
  const binary = snapshot.find((entry) => entry.path === 'package/assets/linux-x64/bin');
  assert.equal(binary.executable, true);
  assert.equal(binary.sizeBytes, 6);
  assert.match(binary.sha256, /^[0-9a-f]{64}$/);
  const manifest = snapshot.find((entry) => entry.path === 'package/package.json');
  assert.equal(manifest.executable, false);
});

function reportInput(overrides = {}) {
  return {
    packages: {
      core: { localVersion: '3.6.0', localPackedSnapshot: [], published: null },
      mcp: { localVersion: '6.8.0', localPackedSnapshot: [], published: null },
      cli: { localVersion: '1.9.0', localPackedSnapshot: [], published: null },
    },
    ...overrides,
  };
}

test('unpublished package is classified correctly', () => {
  const report = buildReleaseGraphReport(reportInput());
  assert.equal(report.packages.core.status, 'unpublished');
  assert.equal(report.packages.mcp.status, 'unpublished');
  assert.equal(report.packages.cli.status, 'unpublished');
  assert.equal(report.valid, true);
});

test('published identical package is classified correctly', () => {
  const snapshot = Object.freeze([Object.freeze({ path: 'package/package.json', sha256: 'a', executable: false, sizeBytes: 2 })]);
  const report = buildReleaseGraphReport(
    reportInput({
      packages: {
        core: { localVersion: '3.6.0', localPackedSnapshot: snapshot, published: { version: '3.6.0', packedSnapshot: snapshot, packedManifest: {} } },
        mcp: { localVersion: '6.8.0', localPackedSnapshot: [], published: null },
        cli: { localVersion: '1.9.0', localPackedSnapshot: [], published: null },
      },
    })
  );
  assert.equal(report.packages.core.status, 'published-identical');
  assert.equal(report.packages.core.publishedVersion, '3.6.0');
  assert.equal(report.valid, true);
});

test('published same-version changed package is classified as stale', () => {
  const localSnapshot = Object.freeze([
    Object.freeze({ path: 'package/local.js', sha256: 'local', executable: false, sizeBytes: 1 }),
    Object.freeze({ path: 'package/package.json', sha256: 'aaa', executable: false, sizeBytes: 2 }),
  ]);
  const publishedSnapshot = Object.freeze([
    Object.freeze({ path: 'package/package.json', sha256: 'bbb', executable: false, sizeBytes: 2 }),
    Object.freeze({ path: 'package/published.js', sha256: 'published', executable: false, sizeBytes: 1 }),
  ]);
  const report = buildReleaseGraphReport(
    reportInput({
      packages: {
        core: { localVersion: '3.6.0', localPackedSnapshot: localSnapshot, published: { version: '3.6.0', packedSnapshot: publishedSnapshot, packedManifest: {} } },
        mcp: { localVersion: '6.8.0', localPackedSnapshot: [], published: null },
        cli: { localVersion: '1.9.0', localPackedSnapshot: [], published: null },
      },
    })
  );
  assert.equal(report.packages.core.status, 'stale-version');
  assert.deepEqual(report.packages.core.changedEntries, [
    { path: 'package/local.js', change: 'added' },
    { path: 'package/package.json', change: 'content' },
    { path: 'package/published.js', change: 'removed' },
  ]);
  assert.equal(report.valid, false);
  assert.deepEqual(report.invalidPackages, ['core']);
});

test('Core change is detectable through stale same-version MCP and CLI packed manifests', () => {
  const publishedCore = Object.freeze([
    Object.freeze({ path: 'package/package.json', sha256: 'core-old', executable: false, sizeBytes: 10 }),
  ]);
  const publishedMcp = Object.freeze([
    Object.freeze({ path: 'package/package.json', sha256: 'mcp-pins-3-5-0', executable: false, sizeBytes: 10 }),
    Object.freeze({ path: 'package/dist/mcp.js', sha256: 'mcp-dist', executable: false, sizeBytes: 10 }),
  ]);
  const publishedCli = Object.freeze([
    Object.freeze({ path: 'package/package.json', sha256: 'cli-pins-3-5-0', executable: false, sizeBytes: 10 }),
    Object.freeze({ path: 'package/dist/cli.js', sha256: 'cli-dist', executable: false, sizeBytes: 10 }),
  ]);
  const localMcp = Object.freeze([
    Object.freeze({ path: 'package/package.json', sha256: 'mcp-pins-3-6-0', executable: false, sizeBytes: 10 }),
    Object.freeze({ path: 'package/dist/mcp.js', sha256: 'mcp-dist', executable: false, sizeBytes: 10 }),
  ]);
  const localCli = Object.freeze([
    Object.freeze({ path: 'package/package.json', sha256: 'cli-pins-3-6-0', executable: false, sizeBytes: 10 }),
    Object.freeze({ path: 'package/dist/cli.js', sha256: 'cli-dist', executable: false, sizeBytes: 10 }),
  ]);
  const report = buildReleaseGraphReport(
    reportInput({
      packages: {
        core: { localVersion: '3.6.0', localPackedSnapshot: [], published: null },
        mcp: { localVersion: '6.8.0', localPackedSnapshot: localMcp, published: { version: '6.8.0', packedSnapshot: publishedMcp, packedManifest: {} } },
        cli: { localVersion: '1.9.0', localPackedSnapshot: localCli, published: { version: '1.9.0', packedSnapshot: publishedCli, packedManifest: {} } },
      },
    })
  );
  assert.equal(report.packages.core.status, 'unpublished');
  assert.equal(report.packages.mcp.status, 'stale-version');
  assert.equal(report.packages.cli.status, 'stale-version');
  assert.deepEqual(report.invalidPackages, ['mcp', 'cli']);
  assert.equal(report.valid, false);
});
