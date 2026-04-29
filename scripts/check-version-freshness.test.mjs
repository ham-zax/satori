import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findStalePackageVersionReferences,
  parsePackageVersions
} from './check-version-freshness.mjs';

test('findStalePackageVersionReferences ignores tests and flags stale docs/config references', () => {
  const files = new Map([
    ['README.md', 'Use @zokizuan/satori-mcp@4.6.0 here'],
    ['packages/mcp/src/config.ts', 'npx -y @zokizuan/satori-mcp@4.7.0'],
    ['packages/mcp/src/cli/index.test.ts', 'fixture @zokizuan/satori-mcp@4.4.1'],
  ]);

  const findings = findStalePackageVersionReferences(files, {
    '@zokizuan/satori-mcp': '4.7.0',
  });

  assert.deepEqual(findings, [{
    filePath: 'README.md',
    packageName: '@zokizuan/satori-mcp',
    foundVersion: '4.6.0',
    expectedVersion: '4.7.0',
  }]);
});

test('parsePackageVersions returns publishable package versions', () => {
  const versions = parsePackageVersions(new Map([
    ['packages/core/package.json', JSON.stringify({ name: '@zokizuan/satori-core', version: '1.4.0' })],
    ['packages/mcp/package.json', JSON.stringify({ name: '@zokizuan/satori-mcp', version: '4.7.0' })],
    ['package.json', JSON.stringify({ name: 'satori', version: '0.3.1', private: true })],
  ]));

  assert.deepEqual(versions, {
    '@zokizuan/satori-core': '1.4.0',
    '@zokizuan/satori-mcp': '4.7.0',
  });
});
