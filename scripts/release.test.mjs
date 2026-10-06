import test from 'node:test';
import assert from 'node:assert/strict';
import { runRelease } from './release.mjs';

const report = (core, mcp = 'published-identical', cli = 'published-identical') => ({
  packages: { core: { status: core }, mcp: { status: mcp }, cli: { status: cli } },
});

function harness({
  dirty = false,
  dirtyAfterBuild = false,
  branch = 'master',
  statuses = report('published-identical', 'stale-version'),
  changed = [{ key: 'mcp', to: '0.9.0' }, { key: 'cli', to: '0.6.3' }],
  fail,
} = {}) {
  const calls = [];
  let built = false;
  return {
    calls,
    options: {
      argv: [],
      log: () => {},
      execFileSyncImpl: (command, args) => {
        calls.push(command === 'pnpm' ? ['build'] : args);
        if (command === 'pnpm') built = true;
        if (args[0] === fail) throw new Error(`${fail} failed`);
        if (args[0] === 'status') return dirty || (built && dirtyAfterBuild) ? ' M source.ts' : '';
        if (args[0] === 'branch') return branch;
        if (args[0] === 'rev-parse') return 'head';
        return '';
      },
      detectImpl: async () => { calls.push(['detect']); return statuses; },
      bumpImpl: async (input) => { calls.push(['bump', input]); return { changed }; },
      publishImpl: async (options) => { calls.push(['publish', options]); },
    },
  };
}

test('release bumps only changed packages with a default minor, commits, pushes, then publishes', async () => {
  const { calls, options } = harness();
  await runRelease(options);
  assert.deepEqual(calls.map(([name]) => name), [
    'status', 'branch', 'fetch', 'rev-parse', 'rev-parse', 'merge-base',
    'build', 'status', 'detect', 'bump', 'add', 'commit', 'push', 'publish',
  ]);
  const [, bump] = calls.find(([name]) => name === 'bump');
  assert.deepEqual({ targets: bump.targets, bump: bump.bump, apply: bump.apply }, {
    targets: ['mcp'], bump: 'minor', apply: true,
  });
  assert.deepEqual(calls.find(([name]) => name === 'commit'), [
    'commit', '-m', 'chore(release): bump mcp 0.9.0, cli 0.6.3', '--only', '--',
    'packages/core/package.json', 'packages/mcp/package.json', 'packages/cli/package.json', 'server.json',
  ]);
  assert.deepEqual(calls.find(([name]) => name === 'push'), [
    'push', 'https://github.com/ham-zax/satori.git', 'HEAD:refs/heads/master',
  ]);
});

test('an explicit major bump applies to every changed package', async () => {
  const { calls, options } = harness({ statuses: report('stale-version', 'published-identical', 'non-monotonic-version') });
  await runRelease({ ...options, argv: ['major'] });
  const [, bump] = calls.find(([name]) => name === 'bump');
  assert.deepEqual([bump.targets, bump.bump], [['core', 'cli'], 'major']);
});

test('unchanged packages release nothing', async () => {
  const { calls, options } = harness({ statuses: report('published-identical') });
  assert.equal(await runRelease(options), null);
  assert.equal(calls.some(([name]) => ['bump', 'commit', 'push', 'publish'].includes(name)), false);
});

test('prepared but unpublished versions publish without another bump', async () => {
  const { calls, options } = harness({ statuses: report('published-identical', 'unpublished', 'unpublished') });
  await runRelease(options);
  assert.equal(calls.some(([name]) => name === 'bump' || name === 'commit'), false);
  assert.deepEqual(calls.slice(-2).map(([name]) => name), ['push', 'publish']);
});

test('a bump that changes no version does not create an empty commit', async () => {
  const { calls, options } = harness({ changed: [] });
  await runRelease(options);
  assert.equal(calls.some(([name]) => name === 'commit' || name === 'add'), false);
  assert.equal(calls.at(-1)[0], 'publish');
});

test('dirty, wrong-branch, divergent, and build-dirtied checkouts stop before bumping', async () => {
  for (const input of [{ dirty: true }, { branch: 'feature' }, { fail: 'merge-base' }, { dirtyAfterBuild: true }]) {
    const { calls, options } = harness(input);
    await assert.rejects(runRelease(options));
    assert.equal(calls.some(([name]) => name === 'bump'), false);
  }
});

test('build, commit, and push failures prevent publication', async () => {
  for (const fail of ['build', 'commit', 'push']) {
    const { calls, options } = harness({ fail });
    if (fail === 'build') {
      options.execFileSyncImpl = ((inner) => (command, args) => {
        if (command === 'pnpm') throw new Error('build failed');
        return inner(command, args);
      })(options.execFileSyncImpl);
    }
    await assert.rejects(runRelease(options), new RegExp(`${fail} failed`));
    assert.notEqual(calls.at(-1)?.[0], 'publish');
  }
});

test('emergency flag preserves publish-only behavior', async () => {
  const { calls, options } = harness();
  await runRelease({ ...options, argv: ['--allow-unpushed-head'] });
  assert.deepEqual(calls, [['publish', { cwd: process.cwd(), allowUnpushedHead: true }]]);
});

test('invalid arguments stop before side effects', async () => {
  for (const argv of [['minor', '--apply'], ['mcp'], ['mcp', 'minor']]) {
    const { calls, options } = harness();
    await assert.rejects(runRelease({ ...options, argv }), /Usage:/);
    assert.deepEqual(calls, []);
  }
});
