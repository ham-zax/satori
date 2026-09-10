import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { runReleaseBump } from './bump-release-graph.mjs';
import {
  assertSourceAuthority,
  CANONICAL_MASTER_FETCH_ARGS,
  CANONICAL_RELEASE_REF,
  CANONICAL_RELEASE_REPOSITORY,
  publishReleaseGraph,
} from './publish-release-graph.mjs';

const RELEASE_FILES = [
  'packages/core/package.json',
  'packages/mcp/package.json',
  'packages/cli/package.json',
  'server.json',
];

export async function runRelease(options = {}) {
  const cwd = options.cwd || process.cwd();
  const argv = (options.argv || []).filter((arg) => arg !== '--');
  const publishImpl = options.publishImpl || publishReleaseGraph;
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--allow-unpushed-head')) {
    return publishImpl({ cwd, allowUnpushedHead: argv.length === 1 });
  }
  if (argv.length !== 1 || !['major', 'minor', 'patch'].includes(argv[0])) {
    throw new Error('Usage: pnpm release [major|minor|patch|--allow-unpushed-head]');
  }

  const execImpl = options.execFileSyncImpl || execFileSync;
  const git = (...args) => execImpl('git', args, { cwd, encoding: 'utf8' });
  if (String(git('status', '--porcelain')).trim()) {
    throw new Error('Working tree is not clean; commit your changes before running pnpm release ' + argv[0]);
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

  const bumpImpl = options.bumpImpl || runReleaseBump;
  await bumpImpl({ cwd, argv: ['core', argv[0], '--apply'] });
  if (String(git('diff', 'HEAD', '--name-only', '--', ...RELEASE_FILES)).trim()) {
    git('add', '--', ...RELEASE_FILES);
    git('commit', '-m', `chore: prepare ${argv[0]} release`, '--only', '--', ...RELEASE_FILES);
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
