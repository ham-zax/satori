import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionEnvironment,
  ensureIndexed,
  parseBenchmarkArgs,
  runQualificationQuery,
  runWithManagedSession,
  settleSync,
  summarizeArmRepo,
} from './run.mjs';

function makeMockSession(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (typeof next === 'function') return next(name, args);
      return next;
    },
  };
}

test('parseBenchmarkArgs defaults to production_watcher and local mode, and validates flags', () => {
  const defaults = parseBenchmarkArgs([], {});
  assert.equal(defaults.freshnessMode, 'production_watcher');
  assert.equal(defaults.runtimeMode, 'local');

  const scanMode = parseBenchmarkArgs(['--freshness-mode', 'conservative_scan', '--installed'], {});
  assert.equal(scanMode.freshnessMode, 'conservative_scan');
  assert.equal(scanMode.runtimeMode, 'installed');

  assert.throws(() => parseBenchmarkArgs(['--freshness-mode', 'invalid'], {}), /freshness-mode/i);
  assert.throws(
    () => parseBenchmarkArgs(['--runtime-mode', 'local', '--installed'], {}),
    /cannot combine/i,
  );
});

test('settleSync rejects old completed operations, waits for exact sync op ID, and rejects pendingSync', async () => {
  const session = makeMockSession([
    // Initial sync response launches op-new-2
    { isError: false, json: { status: 'ok', operation: { id: 'op-new-2', phase: 'running' } }, text: '' },
    // Stale status still showing earlier completed op-old-1 -> must NOT pass
    { isError: false, json: { status: 'ok', operation: { id: 'op-old-1', phase: 'completed' }, publication: { publicationId: 'pub-old' } }, text: '' },
    // Correct op ID but pendingSync still present -> must NOT pass
    { isError: false, json: { status: 'ok', operation: { id: 'op-new-2', phase: 'completed' }, pendingSync: { operationId: 'op-new-3', phase: 'queued' } }, text: '' },
    // Finally exact op-new-2 completed with no pendingSync -> passes
    { isError: false, json: { status: 'ok', operation: { id: 'op-new-2', phase: 'completed' }, publication: { publicationId: 'pub-new' } }, text: '' },
  ]);

  const result = await settleSync(session, '/tmp/fake-repo', {
    pollIntervalMs: 1,
    timeoutMs: 1000,
    sleep: async () => {},
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.operationId, 'op-new-2');
  assert.equal(result.publicationId, 'pub-new');
  assert.equal(session.calls.length, 4);
});

test('settleSync recognizes explicit synchronous no-op without inventing a synthetic operation ID', async () => {
  const session = makeMockSession([
    { isError: false, json: { status: 'ok', publication: { publicationId: 'pub-unchanged' } }, text: '' },
  ]);

  const result = await settleSync(session, '/tmp/fake-repo', {
    sleep: async () => {},
  });
  assert.equal(result.outcome, 'noop');
  assert.equal(result.operationId, null);
  assert.equal(result.publicationId, 'pub-unchanged');
  assert.equal(session.calls.length, 1);
});

test('settleSync fails immediately on failed, blocked, or cancelled operations', async () => {
  for (const phase of ['failed', 'blocked', 'cancelled']) {
    const session = makeMockSession([
      { isError: false, json: { status: 'ok', operation: { id: 'op-9', phase: 'running' } }, text: '' },
      { isError: false, json: { status: 'ok', operation: { id: 'op-9', phase } }, text: '' },
    ]);
    await assert.rejects(
      () => settleSync(session, '/tmp/fake-repo', { sleep: async () => {} }),
      new RegExp(phase),
    );
  }
});

test('settleSync and ensureIndexed enforce bounded overall deadline with last-status reporting', async () => {
  let clock = 0;
  const session = makeMockSession([
    { isError: false, json: { status: 'ok', operation: { id: 'op-stuck', phase: 'running' } }, text: '' },
    { isError: false, json: { status: 'ok', operation: { id: 'op-stuck', phase: 'running' } }, text: '' },
  ]);
  await assert.rejects(
    () => settleSync(session, '/tmp/fake-repo', {
      timeoutMs: 50,
      pollIntervalMs: 25,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
    /Timed out waiting for sync.*op-stuck/,
  );

  let idxClock = 0;
  const idxSession = makeMockSession([
    { isError: false, json: { status: 'not_ready', operation: { id: 'op-idx', phase: 'indexing' } }, text: '' },
  ]);
  await assert.rejects(
    () => ensureIndexed(idxSession, '/tmp/fake-repo', {
      timeoutMs: 40,
      pollIntervalMs: 20,
      now: () => idxClock,
      sleep: async (ms) => { idxClock += ms; },
    }),
    /Timed out settling index.*op-idx/,
  );
});

test('local runtime mode requires explicit model paths and prevents env layering from defeating freshnessMode', () => {
  assert.throws(
    () => buildSessionEnvironment({
      stateRoot: '/tmp/state',
      roots: ['/tmp/repo'],
      armEnv: { SATORI_RERANKER_PROVIDER: 'lateon' },
      freshnessMode: 'production_watcher',
      runtimeMode: 'local',
      localArtifacts: { potionHelperPath: '/tmp/helper', potionModelPath: null, lateonModelPath: null },
    }),
    /explicit --model-root/i,
  );

  // Even if baseProcessEnv or armEnv tries to force MCP_ENABLE_WATCHER=false,
  // production_watcher wins; and conservative_scan always enforces false.
  const localArtifacts = {
    potionHelperPath: '/tmp/models/satori-potion',
    potionModelPath: '/tmp/models/potion/potion-code-16M-v2',
    lateonModelPath: '/tmp/models/lateon/LateOn-Code-edge',
  };
  const prodEnv = buildSessionEnvironment({
    stateRoot: '/tmp/state',
    roots: ['/tmp/repo'],
    armEnv: { SATORI_RERANKER_PROVIDER: 'lateon', MCP_ENABLE_WATCHER: 'false' },
    freshnessMode: 'production_watcher',
    runtimeMode: 'local',
    localArtifacts,
    baseProcessEnv: { MCP_ENABLE_WATCHER: 'false' },
  });
  assert.equal(prodEnv.MCP_ENABLE_WATCHER, 'true');
  assert.equal(prodEnv.POTION_MODEL_PATH, localArtifacts.potionModelPath);

  const scanEnv = buildSessionEnvironment({
    stateRoot: '/tmp/state',
    roots: ['/tmp/repo'],
    armEnv: { SATORI_RERANKER_PROVIDER: 'none', MCP_ENABLE_WATCHER: 'true' },
    freshnessMode: 'conservative_scan',
    runtimeMode: 'local',
    localArtifacts,
    baseProcessEnv: { MCP_ENABLE_WATCHER: 'true' },
  });
  assert.equal(scanEnv.MCP_ENABLE_WATCHER, 'false');
});

test('runQualificationQuery captures same-request freshness/publication and keeps stale, unknown, or drifted cases as failures without shrinking denominator', async () => {
  const queryCase = {
    id: 'q1',
    tags: ['ts'],
    query: 'where does X happen',
    acceptable: [{ pathRegex: '^src/x\\.ts$', symbolRegex: '^runX$' }],
  };
  const classify = () => 'srcRuntime';

  const makeHitResp = (overrides = {}) => ({
    isError: false,
    text: '',
    json: {
      status: 'ok',
      publication: { publicationId: 'pub-1' },
      freshnessDecision: { mode: 'verified' },
      results: [{ target: { file: 'src/x.ts' }, symbolKind: 'function', displayLabel: 'function runX' }],
      hints: { debugSearch: { rerank: { applied: true, orderAuthority: 'reranker_order' }, phaseTimingsMs: { rerank: 120 } } },
      ...overrides,
    },
  });

  // 1. Healthy same-request capture
  const okRow = await runQualificationQuery({
    session: makeMockSession([makeHitResp()]),
    repoPath: '/tmp/repo',
    queryCase,
    expectedPublicationId: 'pub-1',
    classifyPathCategory: classify,
  });
  assert.equal(okRow.failed, false);
  assert.equal(okRow.score.strictRank, 1);
  assert.equal(okRow.freshnessMode, 'verified');

  // 2. Missing same-request freshness -> unknown & failed
  const missingFreshRow = await runQualificationQuery({
    session: makeMockSession([makeHitResp({ freshnessDecision: undefined })]),
    repoPath: '/tmp/repo',
    queryCase,
    expectedPublicationId: 'pub-1',
    classifyPathCategory: classify,
  });
  assert.equal(missingFreshRow.freshnessMode, 'unknown');
  assert.equal(missingFreshRow.failed, true);

  // 3. Stale served_previous_generation -> failed
  const staleRow = await runQualificationQuery({
    session: makeMockSession([makeHitResp({ freshnessDecision: { mode: 'served_previous_generation' } })]),
    repoPath: '/tmp/repo',
    queryCase,
    expectedPublicationId: 'pub-1',
    classifyPathCategory: classify,
  });
  assert.equal(staleRow.failed, true);
  assert.equal(staleRow.failureReason, 'stale_previous_generation');

  // 4. Publication drift -> invalidated & failed
  const driftRow = await runQualificationQuery({
    session: makeMockSession([makeHitResp({ publication: { publicationId: 'pub-drifted' } })]),
    repoPath: '/tmp/repo',
    queryCase,
    expectedPublicationId: 'pub-1',
    classifyPathCategory: classify,
  });
  assert.equal(driftRow.failed, true);
  assert.match(driftRow.failureReason, /publication_drift/);

  // Denominator stays 4; only okRow counts as a hit
  const summary = summarizeArmRepo([okRow, missingFreshRow, staleRow, driftRow]);
  assert.equal(summary.queries, 4);
  assert.equal(summary.failedCount, 3);
  assert.equal(summary.hitAt1, 1);
  assert.equal(summary.staleReads, 1);
  assert.equal(summary.unknownFreshnessReads, 1);
});

test('runWithManagedSession closes owned session deterministically on body failure and cancellation', async () => {
  let closed = false;
  await assert.rejects(
    () => runWithManagedSession(
      async () => ({
        pid: 99999999,
        async close() { closed = true; },
      }),
      async () => {
        throw new Error('injected_worker_fault');
      },
    ),
    /injected_worker_fault/,
  );
  assert.equal(closed, true);

  let normalClosed = false;
  const { result, processLifecycle } = await runWithManagedSession(
    async () => ({
      pid: 99999999,
      async close() { normalClosed = true; },
    }),
    async () => 'ok',
  );
  assert.equal(result, 'ok');
  assert.equal(normalClosed, true);
  assert.deepEqual(processLifecycle.remainingPids, []);
});
