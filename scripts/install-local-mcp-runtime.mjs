#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

function usage() {
  return [
    'Usage: pnpm run dev:install-local-mcp [-- --no-build] [-- --home <path>] [-- --node <path>]',
    '',
    'Builds the local MCP runtime and rewrites ~/.satori/bin/satori-mcp.js',
    'to launch this checkout instead of the npm-installed runtime.',
    '',
    'Options:',
    '  --no-build     Skip pnpm build commands and only rewrite the launcher.',
    '  --home <path>  Override HOME for testing or isolated installs.',
    '  --node <path>  Override the Node executable written into the launcher.',
    '  --help         Show this help.',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = {
    noBuild: false,
    homeDir: os.homedir(),
    nodePath: process.execPath,
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
    if (arg === '--home') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --home.');
      }
      options.homeDir = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg === '--node') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --node.');
      }
      options.nodePath = path.resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function buildLauncherScript({ command, args }) {
  return [
    '#!/usr/bin/env node',
    '',
    'const { spawn } = require("node:child_process");',
    '',
    `const command = ${JSON.stringify(command)};`,
    `const baseArgs = ${JSON.stringify(args)};`,
    'const child = spawn(command, [...baseArgs, ...process.argv.slice(2)], {',
    '  stdio: "inherit",',
    '  env: process.env,',
    '});',
    '',
    'let shutdownSignal = null;',
    'for (const signal of ["SIGINT", "SIGTERM"]) {',
    '  process.on(signal, () => {',
    '    shutdownSignal ??= signal;',
    '    if (child.exitCode === null && child.signalCode === null) {',
    '      child.kill(signal);',
    '    }',
    '  });',
    '}',
    '',
    'child.on("error", (error) => {',
    '  console.error(`Failed to start Satori MCP runtime: ${error.message}`);',
    '  process.exit(1);',
    '});',
    '',
    'child.on("exit", (code, signal) => {',
    '  if (shutdownSignal) {',
    '    process.removeAllListeners(shutdownSignal);',
    '    process.kill(process.pid, shutdownSignal);',
    '    return;',
    '  }',
    '  if (signal) {',
    '    console.error(`Satori MCP runtime exited from signal ${signal}`);',
    '    process.exit(1);',
    '  }',
    '  process.exit(code ?? 0);',
    '});',
    '',
  ].join('\n');
}

function writeTextFileAtomic(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  if (mode !== undefined) {
    fs.chmodSync(tempPath, mode);
  }
  fs.renameSync(tempPath, filePath);
}

function runBuild(repoRoot, execFileSyncImpl) {
  execFileSyncImpl('pnpm', ['--filter', '@zokizuan/satori-core', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  execFileSyncImpl('pnpm', ['--filter', '@zokizuan/satori-mcp', 'build:runtime'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

export function installLocalMcpRuntime(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const homeDir = options.homeDir || os.homedir();
  const nodePath = options.nodePath || process.execPath;
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const logger = options.logger || console;
  const runtimeEntry = path.join(repoRoot, 'packages', 'mcp', 'dist', 'index.js');
  const launcherPath = path.join(homeDir, '.satori', 'bin', 'satori-mcp.js');

  if (!options.noBuild) {
    runBuild(repoRoot, execFileSyncImpl);
  }

  if (!fs.existsSync(runtimeEntry)) {
    throw new Error(`Local MCP runtime entry does not exist: ${runtimeEntry}. Run without --no-build first.`);
  }

  const launcherScript = buildLauncherScript({
    command: nodePath,
    args: [runtimeEntry],
  });
  writeTextFileAtomic(launcherPath, launcherScript, 0o755);

  logger.log(`Satori local MCP launcher updated: ${launcherPath}`);
  logger.log(`Runtime entry: ${runtimeEntry}`);
  logger.log('Restart your MCP client so it starts the local runtime.');

  return {
    launcherPath,
    runtimeEntry,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    installLocalMcpRuntime(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(usage());
    process.exit(1);
  }
}
