import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLauncherScript,
  installLocalMcpRuntime,
  parseArgs,
} from './install-local-mcp-runtime.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'satori-local-mcp-test-'));
}

test('parseArgs supports local install options', () => {
  const parsed = parseArgs(['--', '--no-build', '--home', '/tmp/satori-home', '--node', '/usr/bin/node']);

  assert.equal(parsed.noBuild, true);
  assert.equal(parsed.homeDir, '/tmp/satori-home');
  assert.equal(parsed.nodePath, '/usr/bin/node');
});

test('buildLauncherScript forwards argv to the local runtime', () => {
  const script = buildLauncherScript({
    command: '/usr/bin/node',
    args: ['/repo/packages/mcp/dist/index.js'],
  });

  assert.match(script, /const command = "\/usr\/bin\/node"/);
  assert.match(script, /\/repo\/packages\/mcp\/dist\/index\.js/);
  assert.match(script, /\.\.\.process\.argv\.slice\(2\)/);
});

test('installLocalMcpRuntime writes launcher pointing at repo dist entry', () => {
  const repoRoot = makeTempDir();
  const homeDir = makeTempDir();
  const runtimeEntry = path.join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(runtimeEntry), { recursive: true });
  fs.writeFileSync(runtimeEntry, '#!/usr/bin/env node\n', 'utf8');
  const messages = [];

  const result = installLocalMcpRuntime({
    repoRoot,
    homeDir,
    nodePath: '/usr/bin/node',
    noBuild: true,
    logger: { log: (message) => messages.push(message) },
  });
  const launcher = fs.readFileSync(result.launcherPath, 'utf8');

  assert.equal(result.runtimeEntry, runtimeEntry);
  assert.equal(result.launcherPath, path.join(homeDir, '.satori', 'bin', 'satori-mcp.js'));
  assert.match(launcher, /\/usr\/bin\/node/);
  assert.match(launcher, new RegExp(runtimeEntry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.statSync(result.launcherPath).mode & 0o755, 0o755);
  assert.equal(messages.some((message) => message.includes('Restart your MCP client')), true);
});
