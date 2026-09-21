import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_QUALIFICATION_COMMANDS } from './qualify-release-candidate.mjs';
import { PRODUCTION_NPM_REGISTRY, PRODUCTION_NPM_TAG } from './release-registry.mjs';

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
);

test('release package scripts cannot bypass graph publication', () => {
  for (const key of ['release:core', 'release:mcp', 'release:cli']) {
    const command = packageJson.scripts[key];
    assert.equal(typeof command, 'string');
    assert.match(command, /pnpm run release:all/);
    assert.doesNotMatch(command, /(?:npm|pnpm)[^\n]*publish/);
  }
});

test('no root script directly invokes a package publication command', () => {
  for (const [key, command] of Object.entries(packageJson.scripts)) {
    assert.doesNotMatch(
      command,
      /\b(?:npm|pnpm)\b[^\n]*\bpublish\b/,
      `script '${key}' must not directly publish packages`,
    );
  }
});

test('public release commands delegate to their authoritative owners', () => {
  assert.equal(packageJson.scripts['release:check:packed'], 'node scripts/check-release-graph.mjs');
  assert.equal(packageJson.scripts['release:check'], 'node scripts/qualify-release-candidate.mjs');
  assert.equal(packageJson.scripts['release:all'], 'node scripts/publish-release-graph.mjs');
  assert.equal(packageJson.scripts['release:verify'], 'node scripts/release-registry.mjs');
});

test('release qualification owns the complete production gate', () => {
  const commands = RELEASE_QUALIFICATION_COMMANDS.map((entry) => `${entry.command} ${entry.args.join(' ')}`);
  for (const expected of [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm run check:fast',
    'pnpm run build',
    'pnpm -C packages/core run test:raw',
    'pnpm -C packages/mcp run test:raw',
    'pnpm -C packages/cli run test:raw',
    'pnpm run test:scripts',
    'pnpm -C packages/mcp contract:check',
    'pnpm -C packages/mcp docs:check',
    'pnpm -C packages/mcp manifest:check',
    'pnpm run release:smoke:mcp',
    'pnpm run release:smoke:cli',
  ]) {
    assert.equal(commands.includes(expected), true, `missing release qualification command: ${expected}`);
  }
});

test('publishConfig pins production registry, tag, and access for every release package', () => {
  for (const directory of ['core', 'mcp', 'cli']) {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'packages', directory, 'package.json'), 'utf8'),
    );
    assert.deepEqual(manifest.publishConfig, {
      access: 'public',
      registry: PRODUCTION_NPM_REGISTRY,
      tag: PRODUCTION_NPM_TAG,
    });
  }
});
