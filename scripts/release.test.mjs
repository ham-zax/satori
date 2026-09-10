import test from 'node:test';
import assert from 'node:assert/strict';
import { runRelease } from './release.mjs';

function harness({ dirty = false, branch = 'master', changed = true, fail } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      argv: ['minor'],
      execFileSyncImpl: (_command, args) => {
        calls.push(args);
        if (args[0] === fail) throw new Error(`${fail} failed`);
        if (args[0] === 'status') return dirty ? ' M source.ts' : '';
        if (args[0] === 'branch') return branch;
        if (args[0] === 'rev-parse') return 'head';
        if (args[0] === 'diff') return changed ? 'packages/core/package.json' : '';
        return '';
      },
      bumpImpl: async ({ argv }) => { calls.push(['bump', ...argv]); },
      publishImpl: async (options) => { calls.push(['publish', options]); },
    },
  };
}

test('minor bumps, commits only release files, pushes canonical master, then publishes', async () => {
  const { calls, options } = harness();
  await runRelease(options);
  assert.deepEqual(calls.map(([name]) => name), [
    'status', 'branch', 'fetch', 'rev-parse', 'rev-parse', 'merge-base',
    'bump', 'diff', 'add', 'commit', 'push', 'publish',
  ]);
  assert.deepEqual(calls.find(([name]) => name === 'bump'), ['bump', 'core', 'minor', '--apply']);
  assert.deepEqual(calls.find(([name]) => name === 'commit'), [
    'commit', '-m', 'chore: prepare minor release', '--only', '--',
    'packages/core/package.json', 'packages/mcp/package.json', 'packages/cli/package.json', 'server.json',
  ]);
  assert.deepEqual(calls.find(([name]) => name === 'push'), [
    'push', 'https://github.com/ham-zax/satori.git', 'HEAD:refs/heads/master',
  ]);
});

test('prepared versions do not create an empty commit', async () => {
  const { calls, options } = harness({ changed: false });
  await runRelease(options);
  assert.equal(calls.some(([name]) => name === 'commit' || name === 'add'), false);
  assert.equal(calls.at(-1)[0], 'publish');
});

test('dirty, wrong-branch, and divergent checkouts stop before bumping', async () => {
  for (const input of [{ dirty: true }, { branch: 'feature' }, { fail: 'merge-base' }]) {
    const { calls, options } = harness(input);
    await assert.rejects(runRelease(options));
    assert.equal(calls.some(([name]) => name === 'bump'), false);
  }
});

test('commit and push failures prevent publication', async () => {
  for (const fail of ['commit', 'push']) {
    const { calls, options } = harness({ fail });
    await assert.rejects(runRelease(options), new RegExp(`${fail} failed`));
    assert.notEqual(calls.at(-1)[0], 'publish');
  }
});

test('plain release and emergency flag preserve publish-only behavior', async () => {
  for (const argv of [[], ['--allow-unpushed-head']]) {
    const { calls, options } = harness();
    await runRelease({ ...options, argv });
    assert.deepEqual(calls, [['publish', { cwd: process.cwd(), allowUnpushedHead: argv.length === 1 }]]);
  }
});

test('invalid arguments stop before side effects', async () => {
  const { calls, options } = harness();
  await assert.rejects(runRelease({ ...options, argv: ['minor', '--apply'] }), /Usage:/);
  assert.deepEqual(calls, []);
});
