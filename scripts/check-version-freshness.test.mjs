import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkVersionFreshness,
  findStalePackageVersionReferences,
  parsePackageVersions
} from './check-version-freshness.mjs';

test('findStalePackageVersionReferences ignores tests and flags stale docs/config references', () => {
  const files = new Map([
    ['README.md', 'Use @zokizuan/satori-mcp@4.6.0 here'],
    ['packages/mcp/src/config.ts', 'npx -y @zokizuan/satori-mcp@4.8.0'],
    ['packages/mcp/src/cli/index.test.ts', 'fixture @zokizuan/satori-mcp@4.4.1'],
  ]);

  const findings = findStalePackageVersionReferences(files, {
    '@zokizuan/satori-mcp': '4.8.0',
  });

  assert.deepEqual(findings, [{
    filePath: 'README.md',
    packageName: '@zokizuan/satori-mcp',
    foundVersion: '4.6.0',
    expectedVersion: '4.8.0',
  }]);
});

test('parsePackageVersions returns publishable package versions', () => {
  const versions = parsePackageVersions(new Map([
    ['packages/core/package.json', JSON.stringify({ name: '@zokizuan/satori-core', version: '1.5.0' })],
    ['packages/mcp/package.json', JSON.stringify({ name: '@zokizuan/satori-mcp', version: '4.8.0' })],
    ['package.json', JSON.stringify({ name: 'satori', version: '0.4.0', private: true })],
  ]));

  assert.deepEqual(versions, {
    '@zokizuan/satori-core': '1.5.0',
    '@zokizuan/satori-mcp': '4.8.0',
  });
});

test('checkVersionFreshness scans generated and bridge version references', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-version-freshness-'));
  try {
    for (const dir of [
      'packages/core',
      'packages/mcp/src',
      'packages/cli',
      'examples/pi-extension/satori-bridge',
    ]) {
      fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(cwd, 'packages/core/package.json'), JSON.stringify({ name: '@zokizuan/satori-core', version: '1.5.0' }));
    fs.writeFileSync(path.join(cwd, 'packages/mcp/package.json'), JSON.stringify({ name: '@zokizuan/satori-mcp', version: '4.8.0' }));
    fs.writeFileSync(path.join(cwd, 'packages/cli/package.json'), JSON.stringify({ name: '@zokizuan/satori-cli', version: '0.2.0' }));
    fs.writeFileSync(path.join(cwd, 'README.md'), '');
    fs.writeFileSync(path.join(cwd, 'packages/mcp/README.md'), '');
    fs.writeFileSync(path.join(cwd, 'packages/cli/README.md'), '');
    fs.writeFileSync(path.join(cwd, 'packages/mcp/src/config.ts'), '');
    fs.writeFileSync(path.join(cwd, 'server.json'), '@zokizuan/satori-mcp@4.7.0');
    fs.writeFileSync(path.join(cwd, 'examples/pi-extension/satori-bridge/index.ts'), '@zokizuan/satori-cli@0.1.0');
    fs.writeFileSync(path.join(cwd, 'examples/pi-extension/satori-bridge/README.md'), '');
    fs.writeFileSync(path.join(cwd, 'examples/pi-extension/satori-bridge/config.example.json'), '');

    assert.deepEqual(checkVersionFreshness({ cwd }), [
      {
        filePath: 'server.json',
        packageName: '@zokizuan/satori-mcp',
        foundVersion: '4.7.0',
        expectedVersion: '4.8.0',
      },
      {
        filePath: 'examples/pi-extension/satori-bridge/index.ts',
        packageName: '@zokizuan/satori-cli',
        foundVersion: '0.1.0',
        expectedVersion: '0.2.0',
      },
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
