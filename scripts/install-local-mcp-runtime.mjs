#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildLauncherScript,
  DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS,
  parseManagedLauncherEnvironment,
} from '../packages/cli/src/managed-launcher-script.mjs';

export { buildLauncherScript, DEFAULT_LAUNCHER_SHUTDOWN_GRACE_MS };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const INSTALL_CLIENTS = new Set(['all', 'claude', 'codex', 'opencode']);
const INSTALL_RUNTIMES = new Set(['offline', 'voyage']);
const OFFLINE_RERANKERS = new Set(['lateon', 'none']);

function usage() {
  return [
    'Usage: pnpm run dev:install-local-mcp [-- [options]]',
    '',
    'Builds, preflights, and activates the local MCP runtime through the',
    'same installer owner used by the CLI. Managed client configs are updated',
    'without installing or replacing the globally published Satori CLI.',
    '',
    'Options:',
    '  --client <name>       all, claude, codex, or opencode (default: opencode).',
    '  --runtime <name>      offline or voyage (default: preserve managed selection).',
    '  --reranker <name>     lateon or none for an offline runtime.',
    '  --ollama-model <id>   Use Ollama instead of Potion for offline embeddings.',
    '  --vector-store <name> lancedb or milvus (milvus requires voyage runtime).',
    '  --no-build            Reuse existing Core, MCP, and CLI build output.',
    '  --home <path>         Override HOME for testing or isolated installs.',
    '  --node <path>         Override the Node executable written into the launcher.',
    '  --help                Show this help.',
  ].join('\n');
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value === '--') {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    noBuild: false,
    homeDir: os.homedir(),
    nodePath: process.execPath,
    client: 'opencode',
    runtime: undefined,
    reranker: undefined,
    ollamaModel: undefined,
    vectorStore: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--no-build') {
      options.noBuild = true;
      continue;
    }
    if (arg === '--client') {
      const value = readOptionValue(argv, i, arg);
      if (!INSTALL_CLIENTS.has(value)) {
        throw new Error('--client must be one of: all, claude, codex, opencode.');
      }
      options.client = value;
      i += 1;
      continue;
    }
    if (arg === '--runtime') {
      const value = readOptionValue(argv, i, arg);
      if (!INSTALL_RUNTIMES.has(value)) {
        throw new Error('--runtime must be one of: offline, voyage.');
      }
      options.runtime = value;
      i += 1;
      continue;
    }
    if (arg === '--reranker') {
      const value = readOptionValue(argv, i, arg);
      if (!OFFLINE_RERANKERS.has(value)) {
        throw new Error('--reranker must be one of: lateon, none.');
      }
      options.reranker = value;
      i += 1;
      continue;
    }
    if (arg === '--ollama-model') {
      options.ollamaModel = readOptionValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--vector-store') {
      const value = readOptionValue(argv, i, arg).toLowerCase();
      if (value !== 'lancedb' && value !== 'milvus') {
        throw new Error('--vector-store must be one of: lancedb, milvus.');
      }
      options.vectorStore = value === 'lancedb' ? 'LanceDB' : 'Milvus';
      i += 1;
      continue;
    }
    if (arg === '--home') {
      const value = readOptionValue(argv, i, arg);
      options.homeDir = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg === '--node') {
      const value = readOptionValue(argv, i, arg);
      options.nodePath = path.resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function runBuild(repoRoot, execFileSyncImpl) {
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  execFileSyncImpl(pnpmCmd, ['semantic:verify'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  execFileSyncImpl(pnpmCmd, ['--filter', '@zokizuan/satori-core', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  execFileSyncImpl(pnpmCmd, ['--filter', '@zokizuan/satori-mcp', 'build:runtime'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  execFileSyncImpl(pnpmCmd, ['--filter', '@zokizuan/satori-cli', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function resolveInstallRuntime(options, managedEnv) {
  if (options.runtime) return options.runtime;
  return managedEnv.SATORI_RUNTIME_PROFILE === 'connected' ? 'voyage' : 'offline';
}

function createLocalInstallCommand(options, managedEnv) {
  const runtime = resolveInstallRuntime(options, managedEnv);
  if (runtime === 'voyage') {
    if (options.reranker !== undefined) {
      throw new Error('--reranker is supported only with --runtime offline.');
    }
    if (options.ollamaModel !== undefined) {
      throw new Error('--ollama-model is supported only with --runtime offline.');
    }
    return {
      kind: 'install',
      client: options.client,
      runtime,
      ...(options.vectorStore ? { vectorStore: options.vectorStore } : {}),
      dryRun: false,
    };
  }
  if (options.vectorStore === 'Milvus') {
    throw new Error('--runtime offline requires --vector-store lancedb.');
  }
  return {
    kind: 'install',
    client: options.client,
    runtime,
    ...(options.vectorStore ? { vectorStore: options.vectorStore } : {}),
    ...(options.reranker ? { reranker: options.reranker } : {}),
    ...(options.ollamaModel ? { ollamaModel: options.ollamaModel } : {}),
    dryRun: false,
  };
}

async function loadActivationOwner(repoRoot) {
  const installModulePath = path.join(repoRoot, 'packages', 'cli', 'dist', 'install.js');
  const preflightModulePath = path.join(repoRoot, 'packages', 'cli', 'dist', 'install-preflight.js');
  const terminateModulePath = path.join(repoRoot, 'packages', 'cli', 'dist', 'terminate.js');
  if (!fs.existsSync(installModulePath) || !fs.existsSync(preflightModulePath)) {
    throw new Error('Local CLI build output is missing. Run without --no-build first.');
  }
  const [installModule, preflightModule, terminateModule] = await Promise.all([
    import(pathToFileURL(installModulePath).href),
    import(pathToFileURL(preflightModulePath).href),
    fs.existsSync(terminateModulePath)
      ? import(pathToFileURL(terminateModulePath).href)
      : Promise.resolve({}),
  ]);
  return {
    executeInstallCommand: installModule.executeInstallCommand,
    runInstallPreflight: preflightModule.runInstallPreflight,
    probeManagedRuntimeCandidate: preflightModule.probeManagedRuntimeCandidate,
    terminateSatoriServers: terminateModule.terminateSatoriServers,
  };
}

function assertActivationOwner(owner) {
  for (const name of ['executeInstallCommand', 'runInstallPreflight', 'probeManagedRuntimeCandidate']) {
    if (typeof owner?.[name] !== 'function') {
      throw new Error(`Local CLI activation owner does not export ${name}().`);
    }
  }
}

export async function installLocalMcpRuntime(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const homeDir = options.homeDir || os.homedir();
  const nodePath = options.nodePath || process.execPath;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const logger = options.logger || console;
  const inheritedEnvironment = options.env || process.env;
  const runtimeEntry = path.join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
  const launcherPath = path.join(homeDir, '.satori', 'bin', 'satori-mcp.js');

  if (!options.noBuild) {
    runBuild(repoRoot, execFileSyncImpl);
  }

  if (!fs.existsSync(runtimeEntry)) {
    throw new Error(`Local MCP runtime entry does not exist: ${runtimeEntry}. Run without --no-build first.`);
  }

  const managedEnv = fs.existsSync(launcherPath)
    ? parseManagedLauncherEnvironment(fs.readFileSync(launcherPath, 'utf8'))
    : {};
  const command = createLocalInstallCommand({
    client: options.client || 'opencode',
    runtime: options.runtime,
    reranker: options.reranker,
    ollamaModel: options.ollamaModel,
    vectorStore: options.vectorStore,
  }, managedEnv);
  const activationOwner = options.activationOwner || await loadActivationOwner(repoRoot);
  assertActivationOwner(activationOwner);

  if (typeof activationOwner.terminateSatoriServers === 'function') {
    const termResult = await activationOwner.terminateSatoriServers({
      homeDir,
      env: inheritedEnvironment,
    });
    if (termResult?.status === 'partial') {
      throw new Error('Cannot safely activate local runtime: Satori server state is only partially verified.');
    }
    if (termResult?.terminated?.length) {
      logger.log(`Terminated ${termResult.terminated.length} active background Satori server(s) before activation.`);
    }
  }
  const runtimeCommand = { command: nodePath, args: [runtimeEntry] };
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'mcp', 'package.json'), 'utf8'));
  const expectedVersion = packageJson.version;
  const preflightRunner = async (input, dependencies) => {
    const result = await activationOwner.runInstallPreflight(input, dependencies);
    await activationOwner.probeManagedRuntimeCandidate({
      runtimeCommand,
      runtimeEnvironment: result.runtimeEnvironment,
      inheritedEnvironment: input.env,
      homeDir,
      expectedVersion,
    });
    return result;
  };
  const result = await activationOwner.executeInstallCommand(command, {
    homeDir,
    repoDir: repoRoot,
    runtimeCommand,
    potionAssetsRoot: path.join(repoRoot, 'packages', 'mcp', 'assets', 'potion', 'linux-x64'),
    env: inheritedEnvironment,
    preflightRunner,
  });

  logger.log(`Satori local MCP activation updated: ${launcherPath}`);
  logger.log(`Runtime entry: ${runtimeEntry}`);
  logger.log(`Runtime selection: ${result.runtimeEnvironment?.SATORI_RUNTIME_PROFILE || command.runtime}`);
  logger.log(`Reranker selection: ${result.runtimeEnvironment?.SATORI_RERANKER_PROVIDER || 'provider default'}`);
  logger.log(`Managed clients: ${result.results.map((entry) => entry.client).join(', ') || 'none detected'}`);
  logger.log('Preflight: MCP initialization and tool-surface verification passed.');
  logger.log('Restart updated MCP clients so they start the local runtime.');

  return {
    launcherPath,
    runtimeEntry,
    command,
    result,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    await installLocalMcpRuntime(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(usage());
    process.exit(1);
  }
}
