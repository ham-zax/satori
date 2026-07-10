import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  buildLauncherScript,
  installLocalMcpRuntime,
  parseArgs,
} from './install-local-mcp-runtime.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'satori-local-mcp-test-'));
}

function isProcessLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readChildPid(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for local runtime child PID.')), 5_000);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/SATORI_TEST_CHILD_PID=(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });
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

test('local launcher forwards SIGTERM and reaps its runtime child', {
  skip: process.platform === 'win32' ? 'POSIX signal forwarding is not observable on Windows' : false,
}, async () => {
  const tempDir = makeTempDir();
  const launcherPath = path.join(tempDir, 'launcher.cjs');
  const runtimeCode = [
    'console.log(`SATORI_TEST_CHILD_PID=${process.pid}`);',
    'process.on("SIGTERM", () => process.exit(0));',
    'setInterval(() => {}, 1_000);',
  ].join('');
  fs.writeFileSync(launcherPath, buildLauncherScript({
    command: process.execPath,
    args: ['-e', runtimeCode],
  }), 'utf8');

  const launcher = spawn(process.execPath, [launcherPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childPid;
  try {
    childPid = await readChildPid(launcher);
    launcher.kill('SIGTERM');
    const [, signal] = await once(launcher, 'exit');
    assert.equal(signal, 'SIGTERM');
    assert.equal(isProcessLive(childPid), false, `runtime child ${childPid} survived launcher SIGTERM`);
  } finally {
    if (childPid && isProcessLive(childPid)) {
      process.kill(childPid, 'SIGKILL');
    }
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGKILL');
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
