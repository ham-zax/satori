#!/usr/bin/env node
// Multi-repo offline reranker benchmark with explicit freshness/runtime modes,
// exact-operation readiness, same-request quality + freshness provenance, and
// strict child-process cleanup.
//
// Usage:
//   node evals/reranker-benchmark/run.mjs \
//     [--repos trufflehog,tessera,claive] \
//     [--arms offline-lateon,offline-none] \
//     [--freshness-mode production_watcher|conservative_scan] \
//     [--runtime-mode local|installed] \
//     [--model-root /abs/path/to/models] \
//     [--state-root /tmp/satori-reranker-benchmark-state] \
//     [--out /tmp/satori-reranker-benchmark-out] \
//     [--clean-timing-repeats 0] \
//     [--setup-timeout-ms 1800000]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  FRESHNESS_MODES,
  RUNTIME_MODES,
  SHOOTOUT_RUN_SCHEMA_VERSION,
  sha256CanonicalJson,
  sha256Utf8,
} from './contracts.mjs';
import { normalizeHit, scoreQuery } from '../real-repo-quality/score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SATORI_REPO = path.resolve(HERE, '../..');
const INSTALLED_LAUNCHER = path.join(os.homedir(), '.satori', 'bin', 'satori-mcp.js');
const LOCAL_MCP_ENTRY = path.join(SATORI_REPO, 'packages/mcp/dist/index.js');

export const TERMINAL_FAILURE_PHASES = Object.freeze(['failed', 'blocked', 'cancelled']);
export const TERMINAL_FAILURE_STATUSES = Object.freeze(['error', 'blocked']);

export const DEFAULT_ARMS = Object.freeze([
  {
    id: 'offline-lateon',
    label: 'Offline + LateOn (installed default)',
    env: { SATORI_RERANKER_PROVIDER: 'lateon' },
  },
  {
    id: 'offline-voyage-rerank-3',
    label: 'Offline + Voyage (rerank-3)',
    env: { SATORI_RERANKER_PROVIDER: 'voyage', VOYAGEAI_RERANKER_MODEL: 'rerank-3' },
  },
  {
    id: 'offline-voyage-rerank-3-lite',
    label: 'Offline + Voyage (rerank-3-lite)',
    env: { SATORI_RERANKER_PROVIDER: 'voyage', VOYAGEAI_RERANKER_MODEL: 'rerank-3-lite' },
  },
  {
    id: 'offline-none',
    label: 'Offline + No Reranker (baseline)',
    env: { SATORI_RERANKER_PROVIDER: 'none' },
  },
]);

export function parseBenchmarkArgs(argv, env = process.env) {
  const opt = (name, fallback = null) => {
    const idx = argv.indexOf(`--${name}`);
    if (idx >= 0 && argv[idx + 1] !== undefined) return argv[idx + 1];
    const eq = argv.find((item) => item.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : fallback;
  };

  const freshnessMode = opt('freshness-mode', 'production_watcher');
  if (!FRESHNESS_MODES.includes(freshnessMode)) {
    throw new Error(`Invalid --freshness-mode '${freshnessMode}'; expected ${FRESHNESS_MODES.join(' | ')}.`);
  }

  const runtimeModeFlag = opt('runtime-mode', null);
  const useInstalledFlag = argv.includes('--installed');
  const runtimeMode = runtimeModeFlag ?? (useInstalledFlag ? 'installed' : 'local');
  if (!RUNTIME_MODES.includes(runtimeMode)) {
    throw new Error(`Invalid --runtime-mode '${runtimeMode}'; expected ${RUNTIME_MODES.join(' | ')}.`);
  }
  if (runtimeModeFlag === 'local' && useInstalledFlag) {
    throw new Error('Cannot combine --runtime-mode local with --installed.');
  }

  const modelRootRaw = opt('model-root', env.SATORI_BENCHMARK_MODEL_ROOT ?? null);
  const potionModelPath = opt('potion-model-path', env.POTION_MODEL_PATH ?? null);
  const potionHelperPath = opt('potion-helper-path', env.POTION_HELPER_PATH ?? null);
  const lateonModelPath = opt('lateon-model-path', env.SATORI_LATEON_MODEL_PATH ?? null);
  const cleanTimingRepeats = Number(opt('clean-timing-repeats', '0'));
  if (!Number.isSafeInteger(cleanTimingRepeats) || cleanTimingRepeats < 0) {
    throw new Error('--clean-timing-repeats must be a non-negative integer.');
  }
  const setupTimeoutMs = Number(opt('setup-timeout-ms', String(30 * 60_000)));
  if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs < 1) {
    throw new Error('--setup-timeout-ms must be a positive integer.');
  }

  return {
    casesPath: path.resolve(SATORI_REPO, opt('cases', 'evals/reranker-benchmark/cases.json')),
    stateRootBase: path.resolve(opt('state-root', '/tmp/satori-reranker-benchmark-state')),
    outDir: path.resolve(opt('out', '/tmp/satori-reranker-benchmark-out')),
    freshnessMode,
    runtimeMode,
    modelRoot: modelRootRaw ? path.resolve(modelRootRaw) : null,
    potionModelPath: potionModelPath ? path.resolve(potionModelPath) : null,
    potionHelperPath: potionHelperPath ? path.resolve(potionHelperPath) : null,
    lateonModelPath: lateonModelPath ? path.resolve(lateonModelPath) : null,
    wantedRepos: opt('repos', null)?.split(',').filter(Boolean) ?? null,
    wantedArms: opt('arms', null)?.split(',').filter(Boolean) ?? null,
    cleanTimingRepeats,
    setupTimeoutMs,
  };
}

export function isTerminalFailureEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (TERMINAL_FAILURE_STATUSES.includes(envelope.status)) return true;
  if (TERMINAL_FAILURE_PHASES.includes(envelope.operation?.phase)) return true;
  if (TERMINAL_FAILURE_PHASES.includes(envelope.pendingSync?.phase)) return true;
  return false;
}

export function isReadyIndexEnvelope(envelope, expectedOperationId = null) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (isTerminalFailureEnvelope(envelope)) return false;
  if (envelope.status !== 'ok') return false;
  if (envelope.pendingSync) return false;
  const op = envelope.operation;
  if (expectedOperationId !== null) {
    if (!op || op.id !== expectedOperationId) return false;
    return op.phase === 'completed';
  }
  if (!op) return true;
  return op.phase === 'completed';
}

function summarizeStatusSnapshot(envelope, rawText = '') {
  if (!envelope || typeof envelope !== 'object') {
    return rawText ? rawText.slice(0, 300) : 'empty_response';
  }
  return JSON.stringify({
    status: envelope.status ?? null,
    reason: envelope.reason ?? null,
    operation: envelope.operation
      ? { id: envelope.operation.id ?? null, phase: envelope.operation.phase ?? null }
      : null,
    pendingSync: envelope.pendingSync
      ? { operationId: envelope.pendingSync.operationId ?? null, phase: envelope.pendingSync.phase ?? null }
      : null,
    publicationId: envelope.publication?.publicationId ?? null,
  });
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation aborted.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Operation aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function ensureIndexed(session, repoPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const deadline = now() + timeoutMs;

  let lastStatus;
  let createOperationId = null;
  let created = false;
  const startedAt = now();

  for (;;) {
    signal?.throwIfAborted?.();
    const st = await session.call('manage_index', { action: 'status', path: repoPath });
    lastStatus = st;
    if (st.isError || isTerminalFailureEnvelope(st.json)) {
      throw new Error(
        `Index status failed for ${repoPath}: ${summarizeStatusSnapshot(st.json, st.text)}`,
      );
    }
    if (!created && isReadyIndexEnvelope(st.json, null) && st.json?.publication?.publicationId) {
      return {
        reused: true,
        indexWallMs: 0,
        publicationId: st.json.publication.publicationId,
        status: st.json,
      };
    }
    if (!created && st.json?.status === 'not_indexed') {
      const createResp = await session.call('manage_index', { action: 'create', path: repoPath });
      lastStatus = createResp;
      if (createResp.isError || isTerminalFailureEnvelope(createResp.json)) {
        throw new Error(
          `Index create failed for ${repoPath}: ${summarizeStatusSnapshot(createResp.json, createResp.text)}`,
        );
      }
      created = true;
      createOperationId = createResp.json?.operation?.id ?? null;
      if (
        createOperationId === null
        && isReadyIndexEnvelope(createResp.json, null)
        && createResp.json?.publication?.publicationId
      ) {
        return {
          reused: false,
          indexWallMs: now() - startedAt,
          publicationId: createResp.json.publication.publicationId,
          status: createResp.json,
        };
      }
    } else if (
      created
      && isReadyIndexEnvelope(st.json, createOperationId)
      && st.json?.publication?.publicationId
    ) {
      return {
        reused: false,
        indexWallMs: now() - startedAt,
        publicationId: st.json.publication.publicationId,
        status: st.json,
      };
    }

    if (now() >= deadline) {
      throw new Error(
        `Timed out settling index for ${repoPath} after ${timeoutMs} ms; last status=${summarizeStatusSnapshot(lastStatus?.json, lastStatus?.text)}`,
      );
    }
    await sleep(pollIntervalMs, signal);
  }
}

export async function settleSync(session, repoPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;
  const deadline = now() + timeoutMs;

  signal?.throwIfAborted?.();
  const resp = await session.call('manage_index', { action: 'sync', path: repoPath });
  if (resp.isError || isTerminalFailureEnvelope(resp.json)) {
    throw new Error(
      `Sync request failed for ${repoPath}: ${summarizeStatusSnapshot(resp.json, resp.text)}`,
    );
  }

  const expectedOpId = resp.json?.operation?.id ?? resp.json?.pendingSync?.operationId ?? null;
  // Explicit synchronous no-op per ManageIndexResponseEnvelope: status === 'ok',
  // no operation, no pendingSync. Never invent a synthetic operation ID.
  if (expectedOpId === null && isReadyIndexEnvelope(resp.json, null)) {
    return {
      outcome: 'noop',
      operationId: null,
      publicationId: resp.json?.publication?.publicationId ?? null,
      status: resp.json,
    };
  }
  if (expectedOpId !== null && isReadyIndexEnvelope(resp.json, expectedOpId)) {
    return {
      outcome: 'completed',
      operationId: expectedOpId,
      publicationId: resp.json?.publication?.publicationId ?? null,
      status: resp.json,
    };
  }

  let lastStatus = resp;
  for (;;) {
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for sync (${expectedOpId ?? 'pending'}) on ${repoPath} after ${timeoutMs} ms; last status=${summarizeStatusSnapshot(lastStatus?.json, lastStatus?.text)}`,
      );
    }
    await sleep(pollIntervalMs, signal);
    signal?.throwIfAborted?.();
    const st = await session.call('manage_index', { action: 'status', path: repoPath });
    lastStatus = st;
    if (st.isError || isTerminalFailureEnvelope(st.json)) {
      throw new Error(
        `Sync operation failed for ${repoPath}: ${summarizeStatusSnapshot(st.json, st.text)}`,
      );
    }
    // Never accept a different/older completed operation ID when a specific sync
    // operation was started, and never accept while pendingSync is active.
    if (isReadyIndexEnvelope(st.json, expectedOpId)) {
      return {
        outcome: 'completed',
        operationId: expectedOpId,
        publicationId: st.json?.publication?.publicationId ?? null,
        status: st.json,
      };
    }
  }
}

export function resolveLocalArtifactPaths(config, arch = process.arch) {
  const platformDir = process.platform === 'linux' && arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  const defaultHelper = path.join(SATORI_REPO, 'packages', 'mcp', 'assets', 'potion', platformDir, 'satori-potion');

  let potionModelPath = config.potionModelPath;
  let lateonModelPath = config.lateonModelPath;

  if (config.modelRoot) {
    if (!fs.existsSync(config.modelRoot)) {
      throw new Error(`Explicit --model-root does not exist: ${config.modelRoot}`);
    }
    const potionDir = path.join(config.modelRoot, 'potion');
    if (!potionModelPath && fs.existsSync(potionDir)) {
      const match = fs.readdirSync(potionDir).sort().find((name) => name.startsWith('potion-'));
      if (match) potionModelPath = path.join(potionDir, match);
    }
    const lateonDir = path.join(config.modelRoot, 'lateon');
    if (!lateonModelPath && fs.existsSync(lateonDir)) {
      const match = fs.readdirSync(lateonDir).sort().find((name) => name.startsWith('LateOn-'));
      if (match) lateonModelPath = path.join(lateonDir, match);
    }
  }

  return {
    potionHelperPath: config.potionHelperPath ?? defaultHelper,
    potionModelPath,
    lateonModelPath,
  };
}

export function resolveInstalledEntry(launcherPath = INSTALLED_LAUNCHER) {
  const src = fs.readFileSync(launcherPath, 'utf8');
  const argsLine = src.split(/\r?\n/).find((l) => l.startsWith('const baseArgs = '));
  if (!argsLine) throw new Error(`Cannot read baseArgs from ${launcherPath}`);
  return JSON.parse(argsLine.slice('const baseArgs = '.length, -1))[0];
}

export function readInstalledManagedEnv(launcherPath = INSTALLED_LAUNCHER) {
  const src = fs.readFileSync(launcherPath, 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.startsWith('const managedEnv = '));
  if (!line) throw new Error(`Cannot read managedEnv from ${launcherPath}`);
  return JSON.parse(line.slice('const managedEnv = '.length, -1));
}

export function buildSessionEnvironment({
  stateRoot,
  roots,
  armEnv,
  freshnessMode,
  runtimeMode,
  localArtifacts,
  installedManagedEnv,
  baseProcessEnv = process.env,
}) {
  if (!FRESHNESS_MODES.includes(freshnessMode)) {
    throw new Error(`Unsupported freshnessMode '${freshnessMode}'.`);
  }
  if (!RUNTIME_MODES.includes(runtimeMode)) {
    throw new Error(`Unsupported runtimeMode '${runtimeMode}'.`);
  }

  let baseEnv;
  if (runtimeMode === 'installed') {
    if (!installedManagedEnv || typeof installedManagedEnv !== 'object') {
      throw new Error('Installed runtime mode requires installedManagedEnv.');
    }
    baseEnv = { ...baseProcessEnv, ...installedManagedEnv };
  } else {
    // Local mode MUST NOT read installed launcher env or touch ~/.satori/models.
    if (!localArtifacts?.potionModelPath) {
      throw new Error(
        'Local runtime mode requires an explicit --model-root (or --potion-model-path) and never reads ~/.satori/models.',
      );
    }
    if (armEnv.SATORI_RERANKER_PROVIDER === 'lateon' && !localArtifacts?.lateonModelPath) {
      throw new Error(
        'Local runtime mode with LateOn requires an explicit --model-root (or --lateon-model-path).',
      );
    }
    baseEnv = {
      ...baseProcessEnv,
      SATORI_RUNTIME_PROFILE: 'offline',
      EMBEDDING_PROVIDER: 'Potion',
      VECTOR_STORE_PROVIDER: 'LanceDB',
      POTION_HELPER_PATH: localArtifacts.potionHelperPath,
      POTION_MODEL_PATH: localArtifacts.potionModelPath,
      ...(localArtifacts.lateonModelPath ? { SATORI_LATEON_MODEL_PATH: localArtifacts.lateonModelPath } : {}),
    };
  }

  const watcherValue = freshnessMode === 'production_watcher' ? 'true' : 'false';

  // Freshness mode is applied LAST so layered env cannot silently defeat it.
  const env = {
    ...baseEnv,
    ...armEnv,
    MCP_ENABLE_WATCHER: watcherValue,
    SATORI_AUTO_INDEX_WORKSPACE: 'false',
    SATORI_STATE_ROOT: stateRoot,
    SATORI_SESSION_ROOTS_JSON: JSON.stringify(roots),
    LANCEDB_PATH: path.join(stateRoot, 'vector', 'lancedb'),
  };

  if (env.SATORI_RERANKER_PROVIDER !== 'lateon') {
    delete env.SATORI_LATEON_PROFILE;
    delete env.SATORI_LATEON_ACTIVATION_POLICY;
  }

  return env;
}

export function extractNonSecretRecordedSettings(env) {
  const keys = [
    'SATORI_RUNTIME_PROFILE',
    'EMBEDDING_PROVIDER',
    'VECTOR_STORE_PROVIDER',
    'SATORI_RERANKER_PROVIDER',
    'VOYAGEAI_RERANKER_MODEL',
    'MCP_ENABLE_WATCHER',
    'SATORI_AUTO_INDEX_WORKSPACE',
    'SATORI_LATEON_PROFILE',
    'SATORI_LATEON_ACTIVATION_POLICY',
  ];
  const out = {};
  for (const key of keys) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

export function extractSameRequestFreshnessMode(responseJson) {
  const direct = responseJson?.freshnessDecision?.mode;
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  const summary = responseJson?.freshnessSummary?.syncMode;
  if (typeof summary === 'string' && summary.trim().length > 0) return summary.trim();
  const debugMode = responseJson?.hints?.debugSearch?.readiness?.freshnessMode;
  if (typeof debugMode === 'string' && debugMode.trim().length > 0) return debugMode.trim();
  return 'unknown';
}

export async function runQualificationQuery({
  session,
  repoPath,
  queryCase,
  expectedPublicationId,
  classifyPathCategory,
  now = () => performance.now(),
}) {
  const requestId = `qual-${queryCase.id}-${crypto.randomUUID().slice(0, 8)}`;
  const t0 = now();
  let resp;
  try {
    resp = await session.call('search_codebase', {
      path: repoPath,
      query: queryCase.query,
      limit: 10,
      debugMode: 'full',
      debugCandidateLimit: 80,
    });
  } catch (err) {
    return {
      id: queryCase.id,
      requestId,
      tags: queryCase.tags,
      query: queryCase.query,
      publicationId: expectedPublicationId ?? 'unknown',
      freshnessMode: 'unknown',
      failed: true,
      failureReason: `rpc_error: ${err instanceof Error ? err.message : String(err)}`,
      score: { rank: null, strictRank: null, granularity: null, matched: null },
      instrumentedFullDebugMs: now() - t0,
      rerankMs: null,
      rerankApplied: false,
      orderAuthority: null,
      rerankerFailures: 0,
      rerankerTimeouts: 0,
      rerankerProviderTokens: 0,
      top3: [],
    };
  }
  const instrumentedFullDebugMs = now() - t0;

  if (resp.isError || resp.json?.status !== 'ok') {
    return {
      id: queryCase.id,
      requestId,
      tags: queryCase.tags,
      query: queryCase.query,
      publicationId: expectedPublicationId ?? 'unknown',
      freshnessMode: 'unknown',
      failed: true,
      failureReason: `search_status_${resp.json?.status ?? 'error'}`,
      score: { rank: null, strictRank: null, granularity: null, matched: null },
      instrumentedFullDebugMs,
      rerankMs: null,
      rerankApplied: false,
      orderAuthority: null,
      rerankerFailures: 0,
      rerankerTimeouts: 0,
      rerankerProviderTokens: 0,
      top3: [],
    };
  }

  const ds = resp.json?.hints?.debugSearch ?? {};
  const pw = ds.providerWork ?? {};
  const rk = ds.rerank ?? {};
  const pt = ds.phaseTimingsMs ?? {};
  const freshnessMode = extractSameRequestFreshnessMode(resp.json);
  const publicationId = resp.json?.publication?.publicationId
    ?? ds.readiness?.publicationId
    ?? expectedPublicationId
    ?? 'unknown';

  const hits = (resp.json?.results ?? [])
    .slice(0, 10)
    .map((raw, idx) => normalizeHit({ rank: idx + 1, raw }, classifyPathCategory));
  const score = scoreQuery(queryCase, hits);

  let failed = false;
  let failureReason = null;
  if (freshnessMode === 'served_previous_generation') {
    failed = true;
    failureReason = 'stale_previous_generation';
  } else if (freshnessMode === 'unknown') {
    failed = true;
    failureReason = 'missing_same_request_freshness';
  } else if (
    expectedPublicationId
    && publicationId !== 'unknown'
    && publicationId !== expectedPublicationId
  ) {
    failed = true;
    failureReason = `publication_drift:${expectedPublicationId}->${publicationId}`;
  }

  return {
    id: queryCase.id,
    requestId,
    tags: queryCase.tags,
    query: queryCase.query,
    publicationId,
    freshnessMode,
    failed,
    failureReason,
    score,
    instrumentedFullDebugMs,
    rerankMs: typeof pt.rerank === 'number' ? pt.rerank : null,
    rerankApplied: rk.applied === true,
    orderAuthority: rk.orderAuthority ?? null,
    rerankerFailures: pw.rerankerFailures ?? 0,
    rerankerTimeouts: pw.rerankerTimeouts ?? 0,
    rerankerProviderTokens: pw.rerankerProviderTokens ?? 0,
    top3: hits.slice(0, 3).map((h) => ({
      rank: h.rank,
      path: h.path,
      symbol: h.symbol,
      granularity: h.granularity,
    })),
  };
}

const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export function summarizeArmRepo(queries) {
  const n = queries.length;
  const hitAt = (key, k) => queries.filter((q) => (
    !q.failed && q.score[key] !== null && q.score[key] <= k
  )).length;
  const mrr = (key) => (n === 0
    ? 0
    : queries.reduce((sum, q) => sum + (!q.failed && q.score[key] ? 1 / q.score[key] : 0), 0) / n);
  const debugMs = queries
    .map((q) => q.instrumentedFullDebugMs)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  return {
    queries: n,
    failedCount: queries.filter((q) => q.failed).length,
    rerankAppliedCount: queries.filter((q) => !q.failed && q.rerankApplied).length,
    staleReads: queries.filter((q) => q.freshnessMode === 'served_previous_generation').length,
    unknownFreshnessReads: queries.filter((q) => q.freshnessMode === 'unknown').length,
    hitAt1: hitAt('rank', 1),
    hitAt3: hitAt('rank', 3),
    hitAt5: hitAt('rank', 5),
    hitAt10: hitAt('rank', 10),
    mrr: mrr('rank'),
    strictHitAt1: hitAt('strictRank', 1),
    strictHitAt3: hitAt('strictRank', 3),
    strictHitAt5: hitAt('strictRank', 5),
    strictHitAt10: hitAt('strictRank', 10),
    strictMrr: mrr('strictRank'),
    instrumentedFullDebugP50Ms: median(debugMs),
    instrumentedFullDebugP95Ms: percentile(debugMs, 95),
    rerankerFailures: queries.reduce((s, q) => s + (q.rerankerFailures ?? 0), 0),
    rerankerTimeouts: queries.reduce((s, q) => s + (q.rerankerTimeouts ?? 0), 0),
    rerankerTokens: queries.reduce((s, q) => s + (q.rerankerProviderTokens ?? 0), 0),
  };
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runWithManagedSession(openSessionFn, bodyFn) {
  const session = await openSessionFn();
  const ownedPids = [];
  if (Number.isSafeInteger(session.pid) && session.pid > 0) {
    ownedPids.push(session.pid);
  }
  try {
    const result = await bodyFn(session);
    await session.close();
    const remainingPids = ownedPids.filter((pid) => isPidAlive(pid));
    const exitedPids = ownedPids.filter((pid) => !remainingPids.includes(pid));
    return { result, processLifecycle: { ownedPids, exitedPids, remainingPids } };
  } catch (err) {
    try {
      await session.close();
    } catch {
      // Preserve the primary failure while attempting cleanup.
    }
    throw err;
  }
}

async function openLiveSession({
  stateRoot,
  roots,
  armEnv,
  mcpEntry,
  freshnessMode,
  runtimeMode,
  localArtifacts,
  installedManagedEnv,
}) {
  fs.mkdirSync(stateRoot, { recursive: true });
  if (runtimeMode === 'installed') {
    const modelsLink = path.join(stateRoot, 'models');
    if (!fs.existsSync(modelsLink)) {
      fs.symlinkSync(path.join(os.homedir(), '.satori', 'models'), modelsLink);
    }
  }
  const env = buildSessionEnvironment({
    stateRoot,
    roots,
    armEnv,
    freshnessMode,
    runtimeMode,
    localArtifacts,
    installedManagedEnv,
  });

  const mcpRequire = createRequire(path.join(SATORI_REPO, 'packages/mcp/package.json'));
  const { Client } = mcpRequire('@modelcontextprotocol/client');
  const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/client/stdio');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'satori-reranker-benchmark', version: '2.0.0' });
  await client.connect(transport);
  const pid = transport.pid ?? null;

  return {
    pid,
    recordedSettings: extractNonSecretRecordedSettings(env),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, { timeout: 3_600_000 });
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-json */ }
      return { text, json, isError: result.isError === true };
    },
    async close() {
      await client.close();
    },
  };
}

const log = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
const pct = (n, d) => `${((n / (d || 1)) * 100).toFixed(1)}% (${n}/${d})`;

async function main() {
  const config = parseBenchmarkArgs(process.argv.slice(2));
  const casesRaw = fs.readFileSync(config.casesPath, 'utf8');
  const cases = JSON.parse(casesRaw);
  const repos = config.wantedRepos
    ? cases.repos.filter((r) => config.wantedRepos.includes(r.name))
    : cases.repos;
  const arms = config.wantedArms
    ? DEFAULT_ARMS.filter((a) => config.wantedArms.includes(a.id))
    : DEFAULT_ARMS;

  const installedManagedEnv = config.runtimeMode === 'installed' ? readInstalledManagedEnv() : null;
  const localArtifacts = config.runtimeMode === 'local' ? resolveLocalArtifactPaths(config) : null;
  const mcpEntry = config.runtimeMode === 'installed' ? resolveInstalledEntry() : LOCAL_MCP_ENTRY;

  const { classifyPathCategory } = await import(
    pathToFileURL(path.join(SATORI_REPO, 'packages/mcp/dist/core/search-ranking-policy.js')).href
  );

  fs.mkdirSync(config.outDir, { recursive: true });
  const repoMeta = {};
  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) throw new Error(`Missing repo checkout at ${repo.path}`);
    const head = execFileSync('git', ['-C', repo.path, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repo.path, 'status', '--short'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean).length;
    repoMeta[repo.name] = { path: repo.path, language: repo.language, head, dirtyFiles: dirty };
  }

  const indexingStats = {};
  for (const repo of repos) {
    const repoStateRoot = path.join(config.stateRootBase, repo.name);
    const { result } = await runWithManagedSession(
      () => openLiveSession({
        stateRoot: repoStateRoot,
        roots: [repo.path],
        armEnv: arms[0].env,
        mcpEntry,
        freshnessMode: config.freshnessMode,
        runtimeMode: config.runtimeMode,
        localArtifacts,
        installedManagedEnv,
      }),
      async (session) => {
        log(`Indexing ${repo.name} (${config.runtimeMode}/${config.freshnessMode})...`);
        return ensureIndexed(session, repo.path, { timeoutMs: config.setupTimeoutMs });
      },
    );
    indexingStats[repo.name] = result;
  }

  const manifestRaw = fs.readFileSync(path.join(HERE, 'models.json'), 'utf8');
  const armResults = {};
  for (const arm of arms) {
    log(`\n=== Arm: ${arm.id} (${config.freshnessMode}, ${config.runtimeMode}) ===`);
    const repoRows = {};
    const allOwned = [];
    const allExited = [];
    const allRemaining = [];
    let recordedSettings = {};

    for (const repo of repos) {
      const repoStateRoot = path.join(config.stateRootBase, repo.name);
      const { result, processLifecycle } = await runWithManagedSession(
        () => openLiveSession({
          stateRoot: repoStateRoot,
          roots: [repo.path],
          armEnv: arm.env,
          mcpEntry,
          freshnessMode: config.freshnessMode,
          runtimeMode: config.runtimeMode,
          localArtifacts,
          installedManagedEnv,
        }),
        async (session) => {
          recordedSettings = session.recordedSettings;
          const idxInfo = await ensureIndexed(session, repo.path, { timeoutMs: config.setupTimeoutMs });
          const syncInfo = await settleSync(session, repo.path, { timeoutMs: config.setupTimeoutMs });
          const pinnedPublicationId = syncInfo.publicationId ?? idxInfo.publicationId;

          const qRows = [];
          for (const q of repo.queries) {
            const row = await runQualificationQuery({
              session,
              repoPath: repo.path,
              queryCase: q,
              expectedPublicationId: pinnedPublicationId,
              classifyPathCategory,
            });
            qRows.push(row);
            log(
              `  ${q.id} rank=${row.score.rank ?? '-'} strict=${row.score.strictRank ?? '-'} `
              + `freshness=${row.freshnessMode} failed=${row.failed} ms=${row.instrumentedFullDebugMs.toFixed(0)}`,
            );
          }

          const cleanTimingObservations = [];
          for (let repeat = 0; repeat < config.cleanTimingRepeats; repeat += 1) {
            for (const q of repo.queries) {
              const t0 = performance.now();
              const cleanResp = await session.call('search_codebase', {
                path: repo.path,
                query: q.query,
                limit: 10,
              });
              cleanTimingObservations.push({
                id: q.id,
                repeat,
                cleanServingMs: performance.now() - t0,
                ok: !cleanResp.isError && cleanResp.json?.status === 'ok',
              });
            }
          }

          return {
            pinnedPublicationId,
            syncOutcome: syncInfo.outcome,
            summary: summarizeArmRepo(qRows),
            queries: qRows,
            cleanTimingObservations,
          };
        },
      );
      repoRows[repo.name] = result;
      allOwned.push(...processLifecycle.ownedPids);
      allExited.push(...processLifecycle.exitedPids);
      allRemaining.push(...processLifecycle.remainingPids);
    }

    const allQueries = Object.values(repoRows).flatMap((r) => r.queries);
    const overallSummary = summarizeArmRepo(allQueries);
    armResults[arm.id] = {
      schemaVersion: SHOOTOUT_RUN_SCHEMA_VERSION,
      label: arm.label,
      manifestSha256: sha256Utf8(manifestRaw),
      corpusSha256: sha256Utf8(casesRaw),
      configSha256: sha256CanonicalJson({ arm: arm.id, freshnessMode: config.freshnessMode, runtimeMode: config.runtimeMode, recordedSettings }),
      command: process.argv.join(' '),
      host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? 'unknown' },
      freshnessMode: config.freshnessMode,
      runtimeMode: config.runtimeMode,
      debugMode: 'full',
      cacheState: 'initially_empty_novel_query',
      expectedCaseCount: allQueries.length,
      qualityCases: allQueries,
      timingScope: {
        label: 'instrumented_full_debug',
        novelQueryClaim: true,
      },
      latency: {
        instrumentedFullDebugP50Ms: overallSummary.instrumentedFullDebugP50Ms,
        instrumentedFullDebugP95Ms: overallSummary.instrumentedFullDebugP95Ms,
      },
      memory: {
        rssScope: 'not_sampled_by_runner',
        rssMethod: 'none',
        inferenceHostPeakRssBytes: null,
        wholeServicePeakRssBytes: null,
      },
      recordedSettings,
      processLifecycle: {
        ownedPids: allOwned,
        exitedPids: allExited,
        remainingPids: allRemaining,
      },
      overall: overallSummary,
      repos: repoRows,
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    freshnessMode: config.freshnessMode,
    runtimeMode: config.runtimeMode,
    mcpEntry,
    stateRootBase: config.stateRootBase,
    repoMeta,
    indexingStats,
    arms: armResults,
  };
  fs.writeFileSync(path.join(config.outDir, 'results.json'), `${JSON.stringify(output, null, 2)}\n`);

  const md = [
    '# Satori Offline Reranker Benchmark',
    '',
    `- Freshness mode: \`${config.freshnessMode}\``,
    `- Runtime mode: \`${config.runtimeMode}\``,
    '- Quality timing scope: `instrumented_full_debug` (same-request quality + freshness provenance)',
    '',
    '| Arm | Hit@1 | Strict Hit@1 | Hit@5 | MRR@10 | Debug p50 | Reranked | Failed | Stale | Voyage Tokens |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const arm of arms) {
    const o = armResults[arm.id].overall;
    md.push(
      `| ${arm.id} | ${pct(o.hitAt1, o.queries)} | ${pct(o.strictHitAt1, o.queries)} | ${pct(o.hitAt5, o.queries)} | ${o.mrr.toFixed(4)} | ${o.instrumentedFullDebugP50Ms?.toFixed(0) ?? '-'} ms | ${o.rerankAppliedCount}/${o.queries} | ${o.failedCount} | ${o.staleReads} | ${o.rerankerTokens} |`,
    );
  }
  fs.writeFileSync(path.join(config.outDir, 'summary.md'), `${md.join('\n')}\n`);
  log(`Wrote ${path.join(config.outDir, 'results.json')} and ${path.join(config.outDir, 'summary.md')}`);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
