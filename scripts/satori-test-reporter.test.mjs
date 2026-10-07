import test from 'node:test';
import assert from 'node:assert/strict';
import satoriTestReporter from './satori-test-reporter.mjs';

async function collectReporterOutput(events, envOverrides = {}) {
  const originalCi = process.env.CI;
  const originalNoColor = process.env.NO_COLOR;
  try {
    if (envOverrides.CI !== undefined) process.env.CI = envOverrides.CI;
    if (envOverrides.NO_COLOR !== undefined) process.env.NO_COLOR = envOverrides.NO_COLOR;

    async function* eventSource() {
      for (const event of events) {
        yield event;
      }
    }

    const chunks = [];
    for await (const chunk of satoriTestReporter(eventSource())) {
      chunks.push(chunk);
    }
    return chunks.join('');
  } finally {
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  }
}

test('non-TTY / CI mode emits deterministic append-only lines without cursor controls', async () => {
  const output = await collectReporterOutput([
    { type: 'test:start', data: { file: '/repo/packages/core/src/a.test.ts' } },
    { type: 'test:pass', data: { file: '/repo/packages/core/src/a.test.ts' } },
    {
      type: 'test:summary',
      data: {
        file: '/repo/packages/core/src/a.test.ts',
        counts: { passed: 1, failed: 0, skipped: 0 },
        duration_ms: 120,
      },
    },
    {
      type: 'test:summary',
      data: {
        counts: { passed: 1, failed: 0, skipped: 0 },
      },
    },
  ], { CI: '1', NO_COLOR: '1' });

  assert.match(output, /\[test\] PASS core\/src\/a\.test\.ts 1 passed/);
  assert.match(output, /✓ Satori tests passed/);
  assert.match(output, /1 passed/);
  assert.equal(output.includes('\x1b['), false);
});

test('interleaved events maintain independent counters and report failures accurately', async () => {
  const output = await collectReporterOutput([
    { type: 'test:start', data: { file: '/repo/packages/core/src/a.test.ts' } },
    { type: 'test:start', data: { file: '/repo/packages/core/src/b.test.ts' } },
    { type: 'test:pass', data: { file: '/repo/packages/core/src/a.test.ts' } },
    {
      type: 'test:fail',
      data: {
        file: '/repo/packages/core/src/b.test.ts',
        name: 'sample failing test',
        error: new Error('assertion failed'),
      },
    },
    {
      type: 'test:summary',
      data: {
        file: '/repo/packages/core/src/a.test.ts',
        counts: { passed: 1, failed: 0, skipped: 0 },
        duration_ms: 50,
      },
    },
    {
      type: 'test:summary',
      data: {
        file: '/repo/packages/core/src/b.test.ts',
        counts: { passed: 0, failed: 1, skipped: 0 },
        duration_ms: 60,
      },
    },
    {
      type: 'test:summary',
      data: {
        counts: { passed: 1, failed: 1, skipped: 0 },
      },
    },
  ], { CI: '1', NO_COLOR: '1' });

  assert.match(output, /✖ FAIL sample failing test/);
  assert.match(output, /\[test\] PASS core\/src\/a\.test\.ts 1 passed/);
  assert.match(output, /\[test\] FAIL core\/src\/b\.test\.ts 0 passed 1 failed/);
  assert.match(output, /✖ Satori tests failed/);
  assert.match(output, /1 failed · 1 passed/);
});

test('interactive mode renders live dashboard with active files, progress, and recent list', async () => {
  const originalIsTty = process.stdout.isTTY;
  try {
    process.stdout.isTTY = true;
    const output = await collectReporterOutput([
      { type: 'test:start', data: { file: '/repo/packages/core/src/file1.test.ts' } },
      { type: 'test:start', data: { file: '/repo/packages/core/src/file2.test.ts' } },
      { type: 'test:start', data: { file: '/repo/packages/core/src/file3.test.ts' } },
      { type: 'test:start', data: { file: '/repo/packages/core/src/file4.test.ts' } },
      { type: 'test:pass', data: { file: '/repo/packages/core/src/file1.test.ts' } },
      {
        type: 'test:summary',
        data: {
          file: '/repo/packages/core/src/file1.test.ts',
          counts: { passed: 1, failed: 0, skipped: 0 },
          duration_ms: 200,
        },
      },
      {
        type: 'test:summary',
        data: {
          counts: { passed: 1, failed: 0, skipped: 0 },
        },
      },
    ], { CI: '', NO_COLOR: '1' });

    assert.match(output, /RUNNING/);
    assert.match(output, /PROGRESS/);
    assert.match(output, /RECENT/);
    assert.match(output, /✓ Satori tests passed/);
  } finally {
    process.stdout.isTTY = originalIsTty;
  }
});

test('a test file over the time budget fails the run and is named', async () => {
  const originalBudget = process.env.SATORI_TEST_FILE_BUDGET_MS;
  const originalExitCode = process.exitCode;
  process.env.SATORI_TEST_FILE_BUDGET_MS = '1000';
  try {
    const output = await collectReporterOutput([
      { type: 'test:summary', data: { file: '/repo/packages/core/src/fast.test.ts', counts: { passed: 1 }, duration_ms: 999 } },
      { type: 'test:summary', data: { file: '/repo/packages/core/src/slow.test.ts', counts: { passed: 1 }, duration_ms: 1001 } },
      { type: 'test:summary', data: { counts: { passed: 2 } } },
    ], { CI: '1', NO_COLOR: '1' });
    assert.match(output, /Test files over the time budget/);
    assert.match(output, /core\/src\/slow\.test\.ts/);
    assert.doesNotMatch(output, /over the time budget[\s\S]*fast\.test\.ts/);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = originalExitCode;
    if (originalBudget === undefined) delete process.env.SATORI_TEST_FILE_BUDGET_MS;
    else process.env.SATORI_TEST_FILE_BUDGET_MS = originalBudget;
  }
});
