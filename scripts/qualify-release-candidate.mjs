import process from 'node:process';
import { spawn, execFileSync } from 'node:child_process';
import { checkReleaseGraph } from './check-release-graph.mjs';
import { ReleaseProgress } from './progress/release-progress.mjs';

export const RELEASE_QUALIFICATION_COMMANDS = Object.freeze([
  Object.freeze({ label: 'refresh workspace links', command: 'pnpm', args: Object.freeze(['install', '--frozen-lockfile', '--ignore-scripts']) }),
  Object.freeze({ label: 'repository lint and version checks', command: 'pnpm', args: Object.freeze(['run', 'check:fast']) }),
  Object.freeze({ label: 'clean release build', command: 'pnpm', args: Object.freeze(['run', 'build']) }),
  Object.freeze({ label: 'Core tests', command: 'pnpm', args: Object.freeze(['-C', 'packages/core', 'run', 'test:raw']) }),
  Object.freeze({ label: 'MCP tests', command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'run', 'test:raw']) }),
  Object.freeze({ label: 'CLI tests', command: 'pnpm', args: Object.freeze(['-C', 'packages/cli', 'run', 'test:raw']) }),
  Object.freeze({ label: 'release script tests', command: 'pnpm', args: Object.freeze(['run', 'test:scripts']) }),
  Object.freeze({ label: 'MCP request contract', command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'contract:check']) }),
  Object.freeze({ label: 'MCP documentation', command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'docs:check']) }),
  Object.freeze({ label: 'MCP manifest', command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'manifest:check']) }),
  Object.freeze({ label: 'MCP packed smoke', command: 'pnpm', args: Object.freeze(['run', 'release:smoke:mcp']) }),
  Object.freeze({ label: 'CLI packed smoke', command: 'pnpm', args: Object.freeze(['run', 'release:smoke:cli']) }),
]);

function defaultSpawnRunner(entry, commandOptions = {}, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, [...entry.args], {
      cwd,
      stdio: commandOptions.stdio || 'inherit',
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    if (child.stdout) {
      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    }

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Command failed with code ${code ?? signal}: ${entry.command} ${entry.args.join(' ')}`);
        error.code = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

export async function qualifyReleaseCandidate(options = {}) {
  const cwd = options.cwd || process.cwd();
  const execFileSyncImpl = options.execFileSyncImpl || execFileSync;
  const gitStatusImpl = options.gitStatusImpl
    || (() => execFileSyncImpl('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }));
  const runCommandImpl = options.runCommandImpl
    || ((entry, commandOptions) => defaultSpawnRunner(entry, commandOptions, cwd));
  const checkGraphImpl = options.checkGraphImpl
    || ((checkOptions) => checkReleaseGraph(checkOptions));

  const initialStatus = String(gitStatusImpl()).trim();
  if (initialStatus !== '') {
    throw new Error(`Working tree is not clean; refusing release qualification:\n${initialStatus}`);
  }

  const progress = new ReleaseProgress(
    RELEASE_QUALIFICATION_COMMANDS.map((entry) => ({
      label: entry.label,
    })),
    options.progressOptions,
  );

  for (
    let index = 0;
    index < RELEASE_QUALIFICATION_COMMANDS.length;
    index += 1
  ) {
    const entry = RELEASE_QUALIFICATION_COMMANDS[index];
    const ownsScreen = entry.label === 'Core tests'
      || entry.label === 'MCP tests'
      || entry.label === 'CLI tests';

    progress.start(index);

    try {
      if (progress.interactive && ownsScreen) {
        progress.clear();
        await runCommandImpl(entry, { stdio: 'inherit' });
      } else if (progress.interactive) {
        await runCommandImpl(entry, { stdio: 'pipe' });
      } else {
        await runCommandImpl(entry, { stdio: 'pipe' });
      }
      progress.complete(index);
    } catch (error) {
      progress.fail(index);
      progress.clear();
      if (error?.stdout) {
        process.stdout.write(String(error.stdout));
      }
      if (error?.stderr) {
        process.stderr.write(String(error.stderr));
      }
      throw error;
    }
  }

  progress.finish();

  const finalStatus = String(gitStatusImpl()).trim();
  if (finalStatus !== '') {
    throw new Error(`Working tree became dirty during release qualification:\n${finalStatus}`);
  }

  const report = await checkGraphImpl({
    cwd,
    tempRoot: options.tempRoot,
    keepTempDirectory: options.keepTempDirectory === true,
    execFileSyncImpl,
  });

  const postGraphStatus = String(gitStatusImpl()).trim();
  if (postGraphStatus !== '') {
    throw new Error(
      `Working tree became dirty during packed release graph verification:\n${postGraphStatus}`,
    );
  }

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/qualify-release-candidate.mjs');
    process.exit(2);
  }
  try {
    await qualifyReleaseCandidate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
