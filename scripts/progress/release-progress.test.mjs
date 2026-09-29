import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseProgress } from './release-progress.mjs';

test('ReleaseProgress transitions phases and formats lines', () => {
  const progress = new ReleaseProgress([
    { label: 'Phase A' },
    { label: 'Phase B' },
    { label: 'Phase C' },
  ], { interactive: false });

  assert.equal(progress.phases.length, 3);
  assert.equal(progress.phases[0].status, 'pending');

  progress.start(0);
  assert.equal(progress.phases[0].status, 'running');

  progress.complete(0);
  assert.equal(progress.phases[0].status, 'passed');

  progress.start(1);
  progress.fail(1);
  assert.equal(progress.phases[1].status, 'failed');

  const lines = progress.lines();
  assert.match(lines[0], /Satori release qualification/);
  assert.match(lines[2], /Phase A/);
  assert.match(lines[3], /Phase B/);
  assert.match(lines[4], /Phase C/);
});

test('ReleaseProgress non-interactive does not write cursor escapes', () => {
  const progress = new ReleaseProgress([
    { label: 'Lint' },
    { label: 'Build' },
  ], { interactive: false });

  assert.equal(progress.interactive, false);
  progress.start(0);
  progress.complete(0);
  progress.clear();
});

test('ReleaseProgress leaves the terminal to a child command until resumed', () => {
  const output = [];
  const progress = new ReleaseProgress([
    { label: 'Core tests' },
    { label: 'MCP tests' },
  ], { interactive: true, write: (chunk) => output.push(chunk) });

  try {
    progress.start(0);
    progress.suspend();
    const writesBeforeChild = output.length;

    progress.complete(0);
    progress.start(1);
    progress.write();
    assert.equal(output.length, writesBeforeChild);

    progress.resume();
    assert.match(output.at(-1), /MCP tests/);
  } finally {
    progress.clear();
  }
});
