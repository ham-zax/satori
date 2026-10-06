import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { runReleaseBump } from './bump-release-graph.mjs';
import { checkReleaseGraph } from './check-release-graph.mjs';
import {
  assertSourceAuthority,
  CANONICAL_MASTER_FETCH_ARGS,
  CANONICAL_RELEASE_REF,
  CANONICAL_RELEASE_REPOSITORY,
  publishReleaseGraph,
} from './publish-release-graph.mjs';
import { RELEASE_ORDER } from './release-graph.mjs';

const RELEASE_FILES = [
  'packages/core/package.json',
  'packages/mcp/package.json',
  'packages/cli/package.json',
  'server.json',
];
const BUMP_KINDS = ['major', 'minor', 'patch'];
const DEFAULT_BUMP = 'minor';

// Packages whose packed content no longer matches a publishable version. An
// unpublished, already-prepared version is not a target, so retrying after a
// partial publication never bumps again.
const NEEDS_BUMP_STATUSES = new Set(['stale-version', 'non-monotonic-version', 'superseded-version']);

export function changedReleaseTargets(report) {
  return RELEASE_ORDER.filter((key) => NEEDS_BUMP_STATUSES.has(report.packages[key].status));
}

export async function runRelease(options = {}) {
  const cwd = options.cwd || process.cwd();
  const argv = (options.argv || []).filter((arg) => arg !== '--');
  const publishImpl = options.publishImpl || publishReleaseGraph;
  if (argv.length === 1 && argv[0] === '--allow-unpushed-head') {
    return publishImpl({ cwd, allowUnpushedHead: true });
  }
  if (argv.length > 1 || (argv.length === 1 && !BUMP_KINDS.includes(argv[0]))) {
    throw new Error('Usage: pnpm release [major|minor|patch|--allow-unpushed-head]');
  }
  const bump = argv[0] || DEFAULT_BUMP;
  const log = options.log || ((line) => console.log(line));
  const execImpl = options.execFileSyncImpl || execFileSync;
  const git = (...args) => execImpl('git', args, { cwd, encoding: 'utf8' });

  if (String(git('status', '--porcelain')).trim()) {
    throw new Error('Working tree is not clean; commit your changes before running pnpm release');
  }
  assertSourceAuthority({
    allowUnpushedHead: true,
    branchImpl: () => git('branch', '--show-current'),
    fetchCanonicalMasterImpl: () => git(...CANONICAL_MASTER_FETCH_ARGS),
    headImpl: () => git('rev-parse', 'HEAD'),
    canonicalMasterImpl: () => git('rev-parse', CANONICAL_RELEASE_REF),
    canonicalMasterIsAncestorImpl: () => {
      try {
        git('merge-base', '--is-ancestor', CANONICAL_RELEASE_REF, 'HEAD');
        return true;
      } catch {
        return false;
      }
    },
  });

  // Packing compares built output, so build the committed source first.
  execImpl('pnpm', ['run', 'build'], { cwd, stdio: 'inherit' });
  if (String(git('status', '--porcelain')).trim()) {
    throw new Error('The build changed tracked files; commit the regenerated files before running pnpm release');
  }
  const detectImpl = options.detectImpl || (() => checkReleaseGraph({ cwd, requireValid: false }));
  const report = await detectImpl();
  const statuses = RELEASE_ORDER.map((key) => report.packages[key].status);
  if (statuses.every((status) => status === 'published-identical')) {
    log('Every package matches its published version; nothing to release.');
    return null;
  }

  const targets = changedReleaseTargets(report);
  if (targets.length > 0) {
    log(`Changed since publication: ${targets.join(', ')} (${bump} bump)`);
    const bumpImpl = options.bumpImpl || runReleaseBump;
    const plan = await bumpImpl({ cwd, targets, bump, apply: true });
    if (plan.changed.length > 0) {
      const versions = plan.changed.map((entry) => `${entry.key} ${entry.to}`).join(', ');
      git('add', '--', ...RELEASE_FILES);
      git('commit', '-m', `chore(release): bump ${versions}`, '--only', '--', ...RELEASE_FILES);
    }
  } else {
    log('Prepared versions are not published yet; publishing them without another bump.');
  }
  // A failed push leaves the release commit available for a normal retry.
  git('push', CANONICAL_RELEASE_REPOSITORY, 'HEAD:refs/heads/master');
  return publishImpl({ cwd });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runRelease({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = /^Usage:/.test(error.message) ? 2 : 1;
  }
}
