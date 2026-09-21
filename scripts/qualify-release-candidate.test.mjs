import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELEASE_QUALIFICATION_COMMANDS,
  qualifyReleaseCandidate,
} from './qualify-release-candidate.mjs';

const quietProgress = { interactive: false, write: () => {} };

test('qualification runs the complete gate before packed graph verification with sync runner', async () => {
  const order = [];
  let statusCalls = 0;
  const report = { valid: true };
  const result = await qualifyReleaseCandidate({
    cwd: '/repo',
    tempRoot: '/tmp/release',
    keepTempDirectory: true,
    progressOptions: quietProgress,
    gitStatusImpl: () => {
      statusCalls += 1;
      return '';
    },
    runCommandImpl: (entry) => order.push(entry.label),
    checkGraphImpl: (options) => {
      order.push('packed release graph');
      assert.equal(options.cwd, '/repo');
      assert.equal(options.tempRoot, '/tmp/release');
      assert.equal(options.keepTempDirectory, true);
      return report;
    },
  });

  assert.equal(result, report);
  assert.equal(statusCalls, 3);
  assert.deepEqual(order, [
    ...RELEASE_QUALIFICATION_COMMANDS.map((entry) => entry.label),
    'packed release graph',
  ]);
});

test('qualification runs with async runner', async () => {
  const executed = [];
  const report = { valid: true };
  const result = await qualifyReleaseCandidate({
    cwd: '/repo',
    progressOptions: quietProgress,
    gitStatusImpl: () => '',
    runCommandImpl: async (entry) => {
      await new Promise((resolve) => setImmediate(resolve));
      executed.push(entry.label);
    },
    checkGraphImpl: async () => report,
  });

  assert.equal(result, report);
  assert.equal(executed.length, RELEASE_QUALIFICATION_COMMANDS.length);
});

test('qualification stops subsequent phases when a command fails', async () => {
  const executed = [];
  await assert.rejects(
    qualifyReleaseCandidate({
      cwd: '/repo',
      progressOptions: quietProgress,
      gitStatusImpl: () => '',
      runCommandImpl: (entry) => {
        executed.push(entry.label);
        if (entry.label === 'clean release build') {
          throw new Error('Build failed');
        }
      },
      checkGraphImpl: async () => ({ valid: true }),
    }),
    /Build failed/,
  );

  assert.deepEqual(executed, [
    'refresh workspace links',
    'repository lint and version checks',
    'clean release build',
  ]);
});

test('qualification refuses a dirty initial worktree before running commands', async () => {
  let commandCalls = 0;
  await assert.rejects(
    qualifyReleaseCandidate({
      progressOptions: quietProgress,
      gitStatusImpl: () => ' M package.json',
      runCommandImpl: () => { commandCalls += 1; },
    }),
    /Working tree is not clean/,
  );
  assert.equal(commandCalls, 0);
});

test('qualification refuses generated drift before graph verification', async () => {
  let statusCalls = 0;
  let graphCalls = 0;
  await assert.rejects(
    qualifyReleaseCandidate({
      progressOptions: quietProgress,
      gitStatusImpl: () => {
        statusCalls += 1;
        return statusCalls === 1 ? '' : ' M server.json';
      },
      runCommandImpl: () => {},
      checkGraphImpl: () => { graphCalls += 1; },
    }),
    /Working tree became dirty during release qualification/,
  );
  assert.equal(graphCalls, 0);
});

test('qualification refuses packed-graph drift after verification', async () => {
  let statusCalls = 0;
  let graphCalls = 0;
  await assert.rejects(
    qualifyReleaseCandidate({
      progressOptions: quietProgress,
      gitStatusImpl: () => {
        statusCalls += 1;
        return statusCalls < 3 ? '' : ' M packages/mcp/package.json';
      },
      runCommandImpl: () => {},
      checkGraphImpl: () => {
        graphCalls += 1;
        return { valid: true };
      },
    }),
    /Working tree became dirty during packed release graph verification/,
  );
  assert.equal(graphCalls, 1);
});
