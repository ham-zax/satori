import process from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { checkReleaseGraph } from './check-release-graph.mjs';
import { ReleaseProgress } from './progress/release-progress.mjs';

export const RELEASE_QUALIFICATION_COMMANDS = Object.freeze([
  Object.freeze({ label: 'refresh workspace links', command: 'pnpm', args: Object.freeze(['install', '--frozen-lockfile', '--ignore-scripts']) }),
  Object.freeze({ label: 'repository lint and version checks', command: 'pnpm', args: Object.freeze(['run', 'check:fast']) }),
  Object.freeze({ label: 'clean release build', command: 'pnpm', args: Object.freeze(['run', 'build']) }),
  Object.freeze({ label: 'Core tests', cached: true, command: 'pnpm', args: Object.freeze(['-C', 'packages/core', 'run', 'test:raw']) }),
  Object.freeze({ label: 'MCP tests', cached: true, command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'run', 'test:raw']) }),
  Object.freeze({ label: 'CLI tests', cached: true, command: 'pnpm', args: Object.freeze(['-C', 'packages/cli', 'run', 'test:raw']) }),
  Object.freeze({ label: 'release script tests', cached: true, command: 'pnpm', args: Object.freeze(['run', 'test:scripts']) }),
  Object.freeze({ label: 'MCP request contract', cached: true, command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'contract:check']) }),
  Object.freeze({ label: 'MCP documentation', cached: true, command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'docs:check']) }),
  Object.freeze({ label: 'MCP manifest', command: 'pnpm', args: Object.freeze(['-C', 'packages/mcp', 'manifest:check']) }),
  Object.freeze({ label: 'MCP packed smoke', cached: true, parallel: true, command: 'pnpm', args: Object.freeze(['run', 'release:smoke:mcp']) }),
  Object.freeze({ label: 'CLI packed smoke', cached: true, parallel: true, command: 'pnpm', args: Object.freeze(['run', 'release:smoke:cli']) }),
]);

// Files a version bump rewrites. They are excluded from the qualification key so
// a bump-only release commit reuses the qualification of the source it bumps;
// version checks, the build and the packed release graph always rerun.
const VERSION_BUMP_FILES = new Set([
  'packages/core/package.json',
  'packages/mcp/package.json',
  'packages/cli/package.json',
  'server.json',
]);

function stripVersionFields(source) {
  // Formatting and exact x.y.z version strings are what a bump changes.
  return JSON.stringify(JSON.parse(source), (_key, value) => (
    typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? '<version>' : value
  ));
}

/**
 * Records the source identity of the last fully qualified tree, so a retry or a
 * bump-only commit skips the slow cached checks. Any other change is a miss.
 */
export function createQualificationCache({ cwd, execFileSyncImpl }) {
  const cachePath = path.join(cwd, 'node_modules', '.cache', 'satori-release', 'qualified.json');
  const key = () => {
    const hash = crypto.createHash('sha256').update(process.version);
    const tree = String(execFileSyncImpl('git', ['ls-tree', '-r', 'HEAD'], { cwd, encoding: 'utf8' }));
    for (const line of tree.split('\n')) {
      const filePath = line.split('\t')[1];
      if (!filePath) continue;
      if (VERSION_BUMP_FILES.has(filePath)) {
        const source = String(execFileSyncImpl('git', ['show', `HEAD:${filePath}`], { cwd, encoding: 'utf8' }));
        hash.update(`${filePath}\0${stripVersionFields(source)}\n`);
      } else {
        hash.update(`${line}\n`);
      }
    }
    return hash.digest('hex');
  };
  return {
    key,
    isQualified() {
      try {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8')).key === key();
      } catch {
        return false;
      }
    },
    recordQualified() {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, `${JSON.stringify({ key: key() })}\n`);
    },
  };
}

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
  // Injected runners (tests) opt out of the on-disk cache unless one is given.
  const cache = options.cache
    ?? (options.runCommandImpl ? null : createQualificationCache({ cwd, execFileSyncImpl }));

  const initialStatus = String(gitStatusImpl()).trim();
  if (initialStatus !== '') {
    throw new Error(`Working tree is not clean; refusing release qualification:\n${initialStatus}`);
  }
  const alreadyQualified = cache?.isQualified() === true;
  if (alreadyQualified) {
    console.log('Source already qualified; skipping cached checks (build and packed graph still run).');
  }

  const progress = new ReleaseProgress(
    RELEASE_QUALIFICATION_COMMANDS.map((entry) => ({
      label: entry.label,
    })),
    options.progressOptions,
  );

  const runEntry = async (index, stdio) => {
    const entry = RELEASE_QUALIFICATION_COMMANDS[index];
    progress.start(index);
    try {
      if (!(alreadyQualified && entry.cached)) {
        await runCommandImpl(entry, { stdio });
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
  };

  for (let index = 0; index < RELEASE_QUALIFICATION_COMMANDS.length;) {
    const entry = RELEASE_QUALIFICATION_COMMANDS[index];
    if (entry.parallel) {
      // Consecutive parallel entries (independent packed smokes) run together.
      const group = [];
      while (RELEASE_QUALIFICATION_COMMANDS[index]?.parallel) group.push(index++);
      const outcomes = await Promise.allSettled(group.map((groupIndex) => runEntry(groupIndex, 'pipe')));
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      continue;
    }
    const ownsScreen = entry.label === 'Core tests'
      || entry.label === 'MCP tests'
      || entry.label === 'CLI tests';
    if (progress.interactive && ownsScreen && !(alreadyQualified && entry.cached)) {
      progress.suspend();
      await runEntry(index, 'inherit');
      progress.resume();
    } else {
      await runEntry(index, 'pipe');
    }
    index += 1;
  }

  progress.finish();

  const finalStatus = String(gitStatusImpl()).trim();
  if (finalStatus !== '') {
    throw new Error(`Working tree became dirty during release qualification:\n${finalStatus}`);
  }
  cache?.recordQualified();

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
