import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  packLocalPackage,
  fetchPublishedPackage,
  extractPackageTarball,
  loadPackedPackageSnapshot,
} from './release-package-snapshots.mjs';
import { createNpmChildEnvironment } from './npm-child-process.mjs';

function makeFixture(files, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-fixture-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    if (options.executablePaths && options.executablePaths.includes(relative)) {
      fs.chmodSync(absolute, 0o755);
    }
  }
  return root;
}

function createRunner({ fixtures = {}, viewVersion, viewRaw, viewError } = {}) {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'pnpm' && args.includes('pack')) {
      const destination = args[args.indexOf('--pack-destination') + 1];
      const filterIndex = args.indexOf('--filter');
      const packageName = args[filterIndex + 1];
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, `${packageName.replace(/^@/, '').replace('/', '-')}-1.0.0.tgz`), 'placeholder');
      return '';
    }
    if (command === 'tar') {
      const destination = args[args.length - 1];
      const tarballName = path.basename(args[1]);
      const fixture = fixtures[tarballName];
      if (!fixture) {
        throw new Error(`no fixture for ${tarballName}`);
      }
      fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(fixture, destination, { recursive: true });
      return '';
    }
    if (command === 'npm' && args.includes('view')) {
      if (viewError) {
        throw viewError;
      }
      if (viewRaw !== undefined) {
        return viewRaw;
      }
      return JSON.stringify(viewVersion);
    }
    if (command === 'npm' && args.includes('pack')) {
      const destination = args[args.indexOf('--pack-destination') + 1];
      const requested = args[1];
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, `${requested.replace(/^@/, '').replace('/', '-').replace('@', '-')}.tgz`), 'placeholder');
      return `${path.basename(requested)}.tgz\n`;
    }
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  runner.calls = calls;
  return runner;
}

function localFixture(version, pins = {}) {
  return makeFixture({
    'package/package.json': JSON.stringify({
      name: '@satori-code/core',
      version,
      dependencies: pins,
    }),
    'package/dist/index.js': 'module.exports = 1;\n',
  });
}

function publishedFixture(name, version, pins) {
  return makeFixture({
    'package/package.json': JSON.stringify({ name, version, dependencies: pins }),
    'package/dist/index.js': 'module.exports = 1;\n',
  });
}

test('local pack receives exact package name and an isolated destination', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-cwd-'));
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const fixture = localFixture('3.6.0');
  const runner = createRunner({ fixtures: { 'satori-code-core-1.0.0.tgz': fixture } });
  const result = packLocalPackage({
    packageName: '@satori-code/core',
    cwd,
    workDirectory,
    execFileSyncImpl: runner,
  });
  const packCall = runner.calls.find((call) => call.command === 'pnpm');
  assert.deepEqual(packCall.args.slice(0, 4), ['--filter', '@satori-code/core', 'pack', '--pack-destination']);
  assert.ok(packCall.args[4].startsWith(workDirectory));
  assert.ok(packCall.args[4].endsWith(path.join('pack')));
  assert.equal(result.manifest.name, '@satori-code/core');
  assert.equal(result.manifest.version, '3.6.0');
  assert.ok(result.snapshot.some((entry) => entry.path === 'package.json'));
});

test('exactly one new tarball is required', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-cwd-'));
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const runner = createRunner({ fixtures: { 'satori-code-core-1.0.0.tgz': localFixture('3.6.0') } });
  const result = packLocalPackage({
    packageName: '@satori-code/core',
    cwd,
    workDirectory,
    execFileSyncImpl: runner,
  });
  assert.equal(result.manifest.version, '3.6.0');
});

test('an older tarball already in the pack directory is ignored', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-cwd-'));
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const packDirectory = path.join(workDirectory, 'pack');
  fs.mkdirSync(packDirectory, { recursive: true });
  fs.writeFileSync(path.join(packDirectory, 'satori-code-core-0.9.0.tgz'), 'old');
  const runner = createRunner({ fixtures: { 'satori-code-core-1.0.0.tgz': localFixture('3.6.0') } });
  const result = packLocalPackage({
    packageName: '@satori-code/core',
    cwd,
    workDirectory,
    execFileSyncImpl: runner,
  });
  assert.equal(result.manifest.version, '3.6.0');
  assert.equal(fs.readFileSync(path.join(packDirectory, 'satori-code-core-0.9.0.tgz'), 'utf8'), 'old');
});

test('no new tarball fails', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-cwd-'));
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const runner = (command, args) => {
    if (command === 'pnpm') {
      fs.mkdirSync(args[args.length - 1], { recursive: true });
      return '';
    }
    throw new Error(`unexpected command ${command}`);
  };
  assert.throws(
    () => packLocalPackage({ packageName: '@satori-code/core', cwd, workDirectory, execFileSyncImpl: runner }),
    /produced no tarball/
  );
});

test('multiple new tarballs fail', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-cwd-'));
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const runner = (command, args) => {
    if (command === 'pnpm') {
      const destination = args[args.length - 1];
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'one.tgz'), 'a');
      fs.writeFileSync(path.join(destination, 'two.tgz'), 'b');
      return '';
    }
    throw new Error(`unexpected command ${command}`);
  };
  assert.throws(
    () => packLocalPackage({ packageName: '@satori-code/core', cwd, workDirectory, execFileSyncImpl: runner }),
    /produced 2 tarballs/
  );
});

test('npm exact version not found returns unpublished', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const runner = createRunner({
    viewError: { status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@satori-code%2fcore/3.6.0 - Not found' },
  });
  const result = fetchPublishedPackage({
    packageName: '@satori-code/core',
    version: '3.6.0',
    workDirectory,
    execFileSyncImpl: runner,
  });
  assert.deepEqual(result, { status: 'unpublished' });
});

test('registry or network failure is not interpreted as unpublished', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const runner = createRunner({
    viewError: { status: 1, stderr: 'npm error code ETIMEDOUT\nnpm error request to https://registry.npmjs.org failed' },
  });
  assert.throws(
    () => fetchPublishedPackage({ packageName: '@satori-code/core', version: '3.6.0', workDirectory, execFileSyncImpl: runner }),
    /Cannot verify @satori-code\/core@3\.6\.0 on the registry/
  );
  const authRunner = createRunner({
    viewError: { status: 1, stderr: 'npm error code E401\nnpm error Unable to authenticate' },
  });
  assert.throws(
    () => fetchPublishedPackage({ packageName: '@satori-code/core', version: '3.6.0', workDirectory, execFileSyncImpl: authRunner }),
    /Cannot verify/
  );
});

test('malformed npm output fails', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const runner = createRunner({ viewRaw: 'not-json' });
  assert.throws(
    () => fetchPublishedPackage({ packageName: '@satori-code/core', version: '3.6.0', workDirectory, execFileSyncImpl: runner }),
    /Malformed npm view output/
  );
});

test('published package lookup accepts npm 12 single-result arrays', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const fixture = publishedFixture('@satori-code/core', '3.6.0', {});
  const runner = createRunner({
    viewRaw: JSON.stringify(['3.6.0']),
    fixtures: { 'satori-code-core-3.6.0.tgz': fixture },
  });
  const result = fetchPublishedPackage({
    packageName: '@satori-code/core',
    version: '3.6.0',
    workDirectory,
    execFileSyncImpl: runner,
  });
  assert.equal(result.status, 'published');
});

test('published package identity mismatch fails', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const fixture = publishedFixture('@satori-code/wrong', '3.6.0', {});
  const runner = createRunner({
    viewVersion: '3.6.0',
    fixtures: { 'satori-code-core-3.6.0.tgz': fixture },
  });
  assert.throws(
    () => fetchPublishedPackage({ packageName: '@satori-code/core', version: '3.6.0', workDirectory, execFileSyncImpl: runner }),
    /does not match requested @satori-code\/core@3\.6\.0/
  );
});

test('published manifest with wrong version fails', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const fixture = publishedFixture('@satori-code/core', '3.5.0', {});
  const runner = createRunner({
    viewVersion: '3.6.0',
    fixtures: { 'satori-code-core-3.6.0.tgz': fixture },
  });
  assert.throws(
    () => fetchPublishedPackage({ packageName: '@satori-code/core', version: '3.6.0', workDirectory, execFileSyncImpl: runner }),
    /does not match requested @satori-code\/core@3\.6\.0/
  );
});

test('extraction without a package/ root fails', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const destination = path.join(workDirectory, 'extract');
  const tarballPath = path.join(workDirectory, 'bad.tgz');
  const runner = (command, args) => {
    if (command === 'tar') {
      const dest = args[args.length - 1];
      fs.mkdirSync(path.join(dest, 'loose-dir'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'loose-dir', 'x.js'), '1');
      return '';
    }
    throw new Error(`unexpected command ${command}`);
  };
  assert.throws(
    () => extractPackageTarball({ tarballPath, destinationDirectory: destination, execFileSyncImpl: runner }),
    /exactly one package\/ root/
  );
});

test('extracted symlink fails', () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const destination = path.join(workDirectory, 'extract');
  const tarballPath = path.join(workDirectory, 'bad.tgz');
  const runner = (command, args) => {
    if (command === 'tar') {
      const dest = args[args.length - 1];
      fs.mkdirSync(path.join(dest, 'package'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'package', 'target.js'), '1');
      fs.symlinkSync('target.js', path.join(dest, 'package', 'link.js'));
      return '';
    }
    throw new Error(`unexpected command ${command}`);
  };
  assert.throws(
    () => extractPackageTarball({ tarballPath, destinationDirectory: destination, execFileSyncImpl: runner }),
    /Symlink not allowed/
  );
});

test('local and published snapshots share one normalization path', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-cwd-'));
  const localWork = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-local-'));
  const publishedWork = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-published-'));
  const localFixture = makeFixture({
    'package/package.json': JSON.stringify({ name: '@satori-code/mcp', version: '6.8.0', dependencies: { '@satori-code/core': '3.6.0' } }),
    'package/dist/server.js': 'serve();\n',
  });
  const publishedFixtureTree = makeFixture({
    'package/package.json': JSON.stringify({ name: '@satori-code/mcp', version: '6.8.0', dependencies: { '@satori-code/core': '3.6.0' } }),
    'package/dist/server.js': 'serve();\n',
  });
  const localRunner = createRunner({ fixtures: { 'satori-code-mcp-1.0.0.tgz': localFixture } });
  const publishedRunner = createRunner({
    viewVersion: '6.8.0',
    fixtures: { 'satori-code-mcp-6.8.0.tgz': publishedFixtureTree },
  });
  const local = packLocalPackage({
    packageName: '@satori-code/mcp',
    cwd,
    workDirectory: localWork,
    execFileSyncImpl: localRunner,
  });
  const published = fetchPublishedPackage({
    packageName: '@satori-code/mcp',
    version: '6.8.0',
    workDirectory: publishedWork,
    execFileSyncImpl: publishedRunner,
  });
  assert.equal(published.status, 'published');
  assert.deepEqual(published.manifest, local.manifest);
  assert.deepEqual(published.snapshot, local.snapshot);
});

test('loadPackedPackageSnapshot reads manifest and snapshot together', () => {
  const fixture = localFixture('3.6.0');
  const { manifest, snapshot } = loadPackedPackageSnapshot({ rootDirectory: path.join(fixture, 'package') });
  assert.equal(manifest.name, '@satori-code/core');
  assert.equal(manifest.version, '3.6.0');
  assert.ok(snapshot.length >= 2);
  assert.ok(snapshot.some((entry) => entry.path === 'dist/index.js'));
});

test('pnpm pack keeps the original environment while npm probes are sanitized', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-cwd-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pkg-work-'));
  const fixture = localFixture('3.6.0');
  const runner = createRunner({
    viewVersion: '3.6.0',
    fixtures: {
      'satori-code-core-1.0.0.tgz': fixture,
      'satori-code-core-3.6.0.tgz': fixture,
    },
  });
  packLocalPackage({
    packageName: '@satori-code/core',
    cwd,
    workDirectory: work,
    execFileSyncImpl: runner,
  });
  fetchPublishedPackage({
    packageName: '@satori-code/core',
    version: '3.6.0',
    workDirectory: work,
    execFileSyncImpl: runner,
  });
  const expectedSanitized = createNpmChildEnvironment(process.env);
  const packCall = runner.calls.find((call) => call.command === 'pnpm' && call.args.includes('pack'));
  assert.equal('env' in packCall.options, false);
  assert.equal(packCall.options.cwd, cwd);
  assert.deepEqual(packCall.options.stdio, ['ignore', 'pipe', 'pipe']);
  const viewCall = runner.calls.find((call) => call.command === 'npm' && call.args.includes('view'));
  assert.deepEqual(viewCall.options.env, expectedSanitized);
  assert.deepEqual(viewCall.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(viewCall.args.slice(-2), ['--registry', 'https://registry.npmjs.org/']);
  const npmPackCall = runner.calls.find((call) => call.command === 'npm' && call.args.includes('pack'));
  assert.deepEqual(npmPackCall.options.env, expectedSanitized);
  assert.deepEqual(npmPackCall.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(npmPackCall.args.slice(-2), ['--registry', 'https://registry.npmjs.org/']);
});
