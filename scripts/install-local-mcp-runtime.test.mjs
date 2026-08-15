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
import { parseManagedLauncherEnvironment } from '../packages/cli/src/managed-launcher-script.mjs';

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
  const parsed = parseArgs([
    '--',
    '--no-build',
    '--client', 'opencode',
    '--runtime', 'offline',
    '--reranker', 'none',
    '--ollama-model', 'qwen2.5-coder',
    '--vector-store', 'lancedb',
    '--home', '/tmp/satori-home',
    '--node', '/usr/bin/node',
  ]);

  assert.equal(parsed.noBuild, true);
  assert.equal(parsed.client, 'opencode');
  assert.equal(parsed.runtime, 'offline');
  assert.equal(parsed.reranker, 'none');
  assert.equal(parsed.ollamaModel, 'qwen2.5-coder');
  assert.equal(parsed.vectorStore, 'LanceDB');
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

  const launcher = spawn(process.execPath, [launcherPath], { stdio: ['pipe', 'pipe', 'pipe'] });
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

test('local launcher force-kills a child that ignores SIGTERM after grace', {
  skip: process.platform === 'win32' ? 'POSIX signal forwarding is not observable on Windows' : false,
}, async () => {
  const tempDir = makeTempDir();
  const launcherPath = path.join(tempDir, 'launcher.cjs');
  const runtimeCode = [
    'console.log(`SATORI_TEST_CHILD_PID=${process.pid}`);',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1_000);',
  ].join('');
  fs.writeFileSync(launcherPath, buildLauncherScript({
    command: process.execPath,
    args: ['-e', runtimeCode],
    shutdownGraceMs: 200,
  }), 'utf8');

  const launcher = spawn(process.execPath, [launcherPath], { stdio: ['pipe', 'pipe', 'pipe'] });
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

test('buildLauncherScript embeds SIGKILL grace path', () => {
  const script = buildLauncherScript({
    command: '/usr/bin/node',
    args: ['/repo/packages/mcp/dist/index.js'],
    shutdownGraceMs: 1234,
  });

  assert.match(script, /const shutdownGraceMs = 1234/);
  assert.match(script, /child\.kill\("SIGKILL"\)/);
  assert.match(script, /forwardShutdown/);
});

function createLocalRuntimeFixture() {
  const repoRoot = makeTempDir();
  const homeDir = makeTempDir();
  const runtimeEntry = path.join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
  fs.mkdirSync(path.dirname(runtimeEntry), { recursive: true });
  fs.writeFileSync(runtimeEntry, '#!/usr/bin/env node\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'packages', 'mcp', 'package.json'), JSON.stringify({
    name: '@zokizuan/satori-mcp',
    version: '9.9.9',
  }), 'utf8');
  return { repoRoot, homeDir, runtimeEntry };
}

function createActivationOwner(runtimeEnvironment, terminateFn) {
  const calls = [];
  return {
    calls,
    terminateSatoriServers: terminateFn || (async (options) => {
      calls.push({ kind: 'terminate', options });
      return { terminated: [{ pid: 9999, sources: ['shared-runtime-host'] }] };
    }),
    async runInstallPreflight(input) {
      calls.push({ kind: 'preflight', input });
      return { runtimeEnvironment };
    },
    async probeManagedRuntimeCandidate(input) {
      calls.push({ kind: 'probe', input });
    },
    async executeInstallCommand(command, options) {
      calls.push({ kind: 'execute', command, options });
      const preflight = await options.preflightRunner({
        runtime: command.runtime,
        env: options.env,
      }, {});
      const launcherPath = path.join(options.homeDir, '.satori', 'bin', 'satori-mcp.js');
      fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
      fs.writeFileSync(launcherPath, buildLauncherScript({
        command: options.runtimeCommand.command,
        args: options.runtimeCommand.args,
        managedEnv: preflight.runtimeEnvironment,
      }), 'utf8');
      return {
        runtimeEnvironment: preflight.runtimeEnvironment,
        results: [{ client: command.client }],
      };
    },
  };
}

test('installLocalMcpRuntime delegates exact local selection and preflights before activation', async () => {
  const { repoRoot, homeDir, runtimeEntry } = createLocalRuntimeFixture();
  const runtimeEnvironment = {
    SATORI_RUNTIME_PROFILE: 'offline',
    VECTOR_STORE_PROVIDER: 'LanceDB',
    EMBEDDING_PROVIDER: 'Potion',
    SATORI_RERANKER_PROVIDER: 'none',
  };
  const activationOwner = createActivationOwner(runtimeEnvironment);
  const messages = [];

  try {
    const result = await installLocalMcpRuntime({
      repoRoot,
      homeDir,
      nodePath: '/usr/bin/node',
      noBuild: true,
      client: 'opencode',
      runtime: 'offline',
      reranker: 'none',
      activationOwner,
      env: { PATH: '/usr/bin' },
      logger: { log: (message) => messages.push(message) },
    });
    const launcher = fs.readFileSync(result.launcherPath, 'utf8');
    const execute = activationOwner.calls.find((call) => call.kind === 'execute');
    const probe = activationOwner.calls.find((call) => call.kind === 'probe');

    assert.equal(result.runtimeEntry, runtimeEntry);
    assert.deepEqual(execute.command, {
      kind: 'install',
      client: 'opencode',
      runtime: 'offline',
      reranker: 'none',
      dryRun: false,
    });
    assert.deepEqual(execute.options.runtimeCommand, {
      command: '/usr/bin/node',
      args: [runtimeEntry],
    });
    assert.equal(
      execute.options.potionAssetsRoot,
      path.join(repoRoot, 'packages', 'mcp', 'assets', 'potion', 'linux-x64'),
    );
    assert.equal(probe.input.expectedVersion, '9.9.9');
    assert.deepEqual(probe.input.runtimeEnvironment, runtimeEnvironment);
    assert.deepEqual(parseManagedLauncherEnvironment(launcher), runtimeEnvironment);
    assert.equal(messages.some((message) => message.includes('MCP initialization and tool-surface verification passed')), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('installLocalMcpRuntime preserves the managed runtime family when no runtime is explicit', async () => {
  const { repoRoot, homeDir } = createLocalRuntimeFixture();
  const managedEnv = {
    SATORI_RUNTIME_PROFILE: 'connected',
    VECTOR_STORE_PROVIDER: 'LanceDB',
    EMBEDDING_PROVIDER: 'VoyageAI',
  };
  const activationOwner = createActivationOwner(managedEnv);

  try {
    const launcherPath = path.join(homeDir, '.satori', 'bin', 'satori-mcp.js');
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, buildLauncherScript({
      command: '/usr/bin/old-node',
      args: ['/old/packages/mcp/dist/index.js'],
      managedEnv,
    }), 'utf8');

    const result = await installLocalMcpRuntime({
      repoRoot,
      homeDir,
      nodePath: '/usr/bin/node',
      noBuild: true,
      activationOwner,
      logger: { log: () => {} },
    });

    assert.equal(result.command.runtime, 'voyage');
    assert.equal(result.command.client, 'opencode');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('installLocalMcpRuntime builds Core, MCP, and CLI before activation', async () => {
  const { repoRoot, homeDir } = createLocalRuntimeFixture();
  const activationOwner = createActivationOwner({ SATORI_RUNTIME_PROFILE: 'offline' });
  const buildCalls = [];
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

  try {
    await installLocalMcpRuntime({
      repoRoot,
      homeDir,
      activationOwner,
      execFileSyncImpl: (command, args) => buildCalls.push([command, args]),
      logger: { log: () => {} },
    });

    assert.deepEqual(buildCalls, [
      [pnpmCmd, ['semantic:verify']],
      [pnpmCmd, ['--filter', '@zokizuan/satori-core', 'build']],
      [pnpmCmd, ['--filter', '@zokizuan/satori-mcp', 'build:runtime']],
      [pnpmCmd, ['--filter', '@zokizuan/satori-cli', 'build']],
    ]);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('installLocalMcpRuntime terminates active background servers before activation', async () => {
  const { repoRoot, homeDir } = createLocalRuntimeFixture();
  const messages = [];
  let terminatedOptions = null;
  const activationOwner = createActivationOwner({ SATORI_RUNTIME_PROFILE: 'offline' }, async (options) => {
    terminatedOptions = options;
    return { status: 'terminated', terminated: [{ pid: 4242, sources: ['shared-runtime-host'] }] };
  });

  try {
    await installLocalMcpRuntime({
      repoRoot,
      homeDir,
      noBuild: true,
      activationOwner,
      env: { CUSTOM_VAR: '1' },
      logger: { log: (msg) => messages.push(msg) },
    });

    assert.equal(terminatedOptions?.homeDir, homeDir);
    assert.equal(terminatedOptions?.env?.CUSTOM_VAR, '1');
    assert.equal(messages.some((msg) => msg.includes('Terminated 1 active background Satori server(s)')), true);
    assert.equal(activationOwner.calls.some((call) => call.kind === 'execute'), true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('installLocalMcpRuntime fails closed and avoids activation if terminateSatoriServers throws', async () => {
  const { repoRoot, homeDir } = createLocalRuntimeFixture();
  const activationOwner = createActivationOwner({ SATORI_RUNTIME_PROFILE: 'offline' }, async () => {
    throw new Error('E_TERMINATION_FAILED: Failed to terminate Satori server pid=4242');
  });

  try {
    await assert.rejects(
      installLocalMcpRuntime({
        repoRoot,
        homeDir,
        noBuild: true,
        activationOwner,
        logger: { log: () => {} },
      }),
      /E_TERMINATION_FAILED: Failed to terminate Satori server pid=4242/,
    );
    assert.equal(activationOwner.calls.some((call) => call.kind === 'execute'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('installLocalMcpRuntime fails closed and avoids activation if terminateSatoriServers returns partial status', async () => {
  const { repoRoot, homeDir } = createLocalRuntimeFixture();
  const activationOwner = createActivationOwner({ SATORI_RUNTIME_PROFILE: 'offline' }, async () => ({
    status: 'partial',
    terminated: [],
  }));

  try {
    await assert.rejects(
      installLocalMcpRuntime({
        repoRoot,
        homeDir,
        noBuild: true,
        activationOwner,
        logger: { log: () => {} },
      }),
      /Cannot safely activate local runtime: Satori server state is only partially verified\./,
    );
    assert.equal(activationOwner.calls.some((call) => call.kind === 'execute'), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('installLocalMcpRuntime rejects reranker selection for voyage runtime', async () => {
  const { repoRoot, homeDir } = createLocalRuntimeFixture();
  try {
    await assert.rejects(
      installLocalMcpRuntime({
        repoRoot,
        homeDir,
        noBuild: true,
        runtime: 'voyage',
        reranker: 'none',
        activationOwner: createActivationOwner({}),
      }),
      /--reranker is supported only with --runtime offline/,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
