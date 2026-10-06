#!/usr/bin/env node
// Run the MCP server from this checkout next to the installed Satori runtime.
// Reuses the installed launcher's provider/model environment, but isolates all
// state (index, LanceDB, runtime ownership) under SATORI_DEV_STATE so the
// installed runtime and its index are never touched. See docs/LOCAL_DEV_MCP.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseManagedLauncherEnvironment } from '../packages/cli/src/managed-launcher-script.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_PACKAGE = path.join(REPO_ROOT, 'packages', 'mcp');
const entry = path.join(MCP_PACKAGE, 'dist', 'index.js');
const launcherPath = process.env.SATORI_DEV_LAUNCHER ?? path.join(os.homedir(), '.satori', 'bin', 'satori-mcp.js');
const stateRoot = process.env.SATORI_DEV_STATE ?? path.join(os.homedir(), '.satori-dev');

if (!fs.existsSync(entry)) {
  console.error(`satori-dev: ${entry} is missing; build core and mcp first (see docs/LOCAL_DEV_MCP.md).`);
  process.exit(1);
}
if (!fs.existsSync(launcherPath)) {
  console.error(`satori-dev: installed launcher ${launcherPath} not found; install Satori once to download models.`);
  process.exit(1);
}

// Assets bundled in the installed @satori-code/mcp package (e.g. the Potion
// helper) are redirected to this checkout; downloaded models are reused as-is.
const installedMcpPackage = /[\\/]node_modules[\\/]@satori-code[\\/]mcp(?=[\\/]|$)/;
const managedEnv = Object.fromEntries(
  Object.entries(parseManagedLauncherEnvironment(fs.readFileSync(launcherPath, 'utf8'))).map(([key, value]) => {
    const match = installedMcpPackage.exec(value);
    return [key, match ? MCP_PACKAGE + value.slice(match.index + match[0].length) : value];
  }),
);

fs.mkdirSync(path.join(stateRoot, 'vector'), { recursive: true });
const env = {
  ...process.env,
  ...managedEnv,
  SATORI_STATE_ROOT: stateRoot,
  ...(managedEnv.LANCEDB_PATH ? { LANCEDB_PATH: path.join(stateRoot, 'vector', 'lancedb') } : {}),
};

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
