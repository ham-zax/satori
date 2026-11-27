#!/usr/bin/env node
// Multi-repo offline reranker benchmark (None vs LateOn vs Voyage rerank-3 / rerank-3-lite).
// Usage:
//   node evals/reranker-benchmark/run.mjs [--repos tessera,claive] [--arms offline-lateon,offline-voyage-rerank-3-lite]
//     [--cases evals/reranker-benchmark/cases.json] [--state-root /tmp/satori-reranker-bench]
//     [--out /tmp/satori-reranker-bench-out] [--installed]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SATORI_REPO = path.resolve(HERE, '../..');
const INSTALLED_LAUNCHER = path.join(os.homedir(), '.satori', 'bin', 'satori-mcp.js');
const LOCAL_MCP_ENTRY = path.join(SATORI_REPO, 'packages/mcp/dist/index.js');

const mcpRequire = createRequire(path.join(SATORI_REPO, 'packages/mcp/package.json'));
const { Client } = mcpRequire('@modelcontextprotocol/client');
const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/client/stdio');
const { scoreQuery, normalizeHit } = await import(pathToFileURL(path.join(SATORI_REPO, 'evals/real-repo-quality/score.mjs')).href);
const { classifyPathCategory } = await import(pathToFileURL(path.join(SATORI_REPO, 'packages/mcp/dist/core/search-ranking-policy.js')).href);

const DEFAULT_ARMS = [
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
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const casesPath = path.resolve(SATORI_REPO, opt('cases', 'evals/reranker-benchmark/cases.json'));
const stateRootBase = path.resolve(opt('state-root', '/tmp/satori-reranker-benchmark-state'));
const outDir = path.resolve(opt('out', '/tmp/satori-reranker-benchmark-out'));
const useInstalled = argv.includes('--installed');
const wantedRepos = opt('repos', null)?.split(',').filter(Boolean);
const wantedArms = opt('arms', null)?.split(',').filter(Boolean);

function resolveInstalledEntry() {
  const src = fs.readFileSync(INSTALLED_LAUNCHER, 'utf8');
  const argsLine = src.split(/\r?\n/).find((l) => l.startsWith('const baseArgs = '));
  if (!argsLine) throw new Error(`Cannot read baseArgs from ${INSTALLED_LAUNCHER}`);
  return JSON.parse(argsLine.slice('const baseArgs = '.length, -1))[0];
}

function readInstalledManagedEnv() {
  const src = fs.readFileSync(INSTALLED_LAUNCHER, 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.startsWith('const managedEnv = '));
  if (!line) throw new Error(`Cannot read managedEnv from ${INSTALLED_LAUNCHER}`);
  return JSON.parse(line.slice('const managedEnv = '.length, -1));
}

const log = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function isTerminalStatus(json) {
  const phase = json?.operation?.phase;
  if (json?.status === 'ok' && (!json?.operation || ['completed', 'failed', 'blocked', 'cancelled'].includes(phase))) {
    return true;
  }
  return false;
}

async function openSession({ stateRoot, roots, armEnv, mcpEntry }) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const modelsLink = path.join(stateRoot, 'models');
  if (!fs.existsSync(modelsLink)) {
    fs.symlinkSync(path.join(os.homedir(), '.satori', 'models'), modelsLink);
  }
  const baseEnv = readInstalledManagedEnv();
  const env = {
    ...process.env,
    ...baseEnv,
    ...armEnv,
    MCP_ENABLE_WATCHER: 'false',
    SATORI_AUTO_INDEX_WORKSPACE: 'false',
    SATORI_STATE_ROOT: stateRoot,
    SATORI_SESSION_ROOTS_JSON: JSON.stringify(roots),
    LANCEDB_PATH: path.join(stateRoot, 'vector', 'lancedb'),
  };
  if (env.SATORI_RERANKER_PROVIDER !== 'lateon') {
    delete env.SATORI_LATEON_PROFILE;
    delete env.SATORI_LATEON_ACTIVATION_POLICY;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'satori-reranker-benchmark', version: '1.0.0' });
  await client.connect(transport);
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, { timeout: 3_600_000 });
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-json */ }
      return { text, json, isError: result.isError === true };
    },
    close: () => client.close(),
  };
}

async function ensureIndexed(session, repoPath, timeoutMs = 30 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const st = await session.call('manage_index', { action: 'status', path: repoPath });
    const phase = st.json?.operation?.phase;
    if (isTerminalStatus(st.json)) return { reused: true, indexWallMs: 0, status: st.json };
    if (st.json?.status === 'not_indexed') break;
    if (st.json?.status === 'error' || ['failed', 'blocked', 'cancelled'].includes(phase)) {
      throw new Error(`Indexing error for ${repoPath}: ${st.text}`);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out settling ${repoPath}`);
    await sleep(2000);
  }
  const createStart = Date.now();
  await session.call('manage_index', { action: 'create', path: repoPath });
  for (;;) {
    const st = await session.call('manage_index', { action: 'status', path: repoPath });
    const phase = st.json?.operation?.phase;
    if (isTerminalStatus(st.json)) {
      return { reused: false, indexWallMs: Date.now() - createStart, status: st.json };
    }
    if (st.json?.status === 'error' || ['failed', 'blocked', 'cancelled'].includes(phase)) {
      throw new Error(`Indexing failed for ${repoPath}: ${st.text}`);
    }
    if (Date.now() - createStart > timeoutMs) throw new Error(`Indexing timed out for ${repoPath}`);
    await sleep(3000);
  }
}

async function settleSync(session, repoPath) {
  const resp = await session.call('manage_index', { action: 'sync', path: repoPath });
  if (resp.isError) throw new Error(`Sync failed for ${repoPath}: ${resp.text}`);
  for (;;) {
    const st = await session.call('manage_index', { action: 'status', path: repoPath });
    if (isTerminalStatus(st.json)) break;
    await sleep(1000);
  }
}

function summarizeArmRepo(queries) {
  const n = queries.length;
  const hitAt = (key, k) => queries.filter((q) => q.score[key] !== null && q.score[key] <= k).length;
  const mrr = (key) => queries.reduce((sum, q) => sum + (q.score[key] ? 1 / q.score[key] : 0), 0) / n;
  return {
    queries: n,
    rerankAppliedCount: queries.filter((q) => q.rerankApplied).length,
    staleReads: queries.filter((q) => q.freshnessMode === 'served_previous_generation').length,
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
    warmCleanMedianMs: median(queries.map((q) => q.warmCleanMs).filter((v) => typeof v === 'number')),
    warmCleanP95Ms: percentile(queries.map((q) => q.warmCleanMs).filter((v) => typeof v === 'number'), 95),
    rerankerFailures: queries.reduce((s, q) => s + (q.rerankerFailures ?? 0), 0),
    rerankerTimeouts: queries.reduce((s, q) => s + (q.rerankerTimeouts ?? 0), 0),
    rerankerTokens: queries.reduce((s, q) => s + (q.rerankerProviderTokens ?? 0), 0),
  };
}

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}% (${n}/${d})`;

async function main() {
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const repos = wantedRepos ? cases.repos.filter((r) => wantedRepos.includes(r.name)) : cases.repos;
  const arms = wantedArms ? DEFAULT_ARMS.filter((a) => wantedArms.includes(a.id)) : DEFAULT_ARMS;
  const mcpEntry = useInstalled ? resolveInstalledEntry() : LOCAL_MCP_ENTRY;

  fs.mkdirSync(outDir, { recursive: true });
  const repoMeta = {};
  for (const repo of repos) {
    if (!fs.existsSync(repo.path)) throw new Error(`Missing repo checkout at ${repo.path}`);
    const head = execFileSync('git', ['-C', repo.path, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', repo.path, 'status', '--short'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
    repoMeta[repo.name] = { path: repo.path, language: repo.language, head, dirtyFiles: dirty };
  }

  const indexingStats = {};
  for (const repo of repos) {
    const repoStateRoot = path.join(stateRootBase, repo.name);
    const session = await openSession({ stateRoot: repoStateRoot, roots: [repo.path], armEnv: arms[0].env, mcpEntry });
    try {
      log(`Indexing ${repo.name}...`);
      indexingStats[repo.name] = await ensureIndexed(session, repo.path);
    } finally {
      await session.close();
    }
  }

  const armResults = {};
  for (const arm of arms) {
    log(`\n=== Arm: ${arm.id} ===`);
    const repoRows = {};
    for (const repo of repos) {
      const repoStateRoot = path.join(stateRootBase, repo.name);
      const session = await openSession({ stateRoot: repoStateRoot, roots: [repo.path], armEnv: arm.env, mcpEntry });
      try {
        await ensureIndexed(session, repo.path);
        await settleSync(session, repo.path);
        await session.call('search_codebase', { path: repo.path, query: repo.queries[0].query, limit: 10 });

        const qRows = [];
        for (const q of repo.queries) {
          const cleanT0 = performance.now();
          const cleanResp = await session.call('search_codebase', { path: repo.path, query: q.query, limit: 10 });
          const warmCleanMs = performance.now() - cleanT0;
          if (cleanResp.isError || cleanResp.json?.status !== 'ok') {
            throw new Error(`Search failed for ${arm.id}/${repo.name}/${q.id}: ${cleanResp.text.slice(0, 400)}`);
          }
          const dbgResp = await session.call('search_codebase', {
            path: repo.path,
            query: q.query,
            limit: 10,
            debugMode: 'full',
            debugCandidateLimit: 80,
          });
          const hits = (cleanResp.json?.results ?? []).slice(0, 10).map((raw, idx) => normalizeHit({ rank: idx + 1, raw }, classifyPathCategory));
          const score = scoreQuery(q, hits);
          const ds = dbgResp.json?.hints?.debugSearch ?? {};
          const pw = ds.providerWork ?? {};
          const rk = ds.rerank ?? {};
          const pt = ds.phaseTimingsMs ?? {};
          qRows.push({
            id: q.id,
            tags: q.tags,
            query: q.query,
            score,
            warmCleanMs,
            rerankMs: typeof pt.rerank === 'number' ? pt.rerank : null,
            rerankApplied: rk.applied ?? false,
            orderAuthority: rk.orderAuthority ?? null,
            freshnessMode: ds.readiness?.freshnessMode ?? null,
            rerankerFailures: pw.rerankerFailures ?? 0,
            rerankerTimeouts: pw.rerankerTimeouts ?? 0,
            rerankerProviderTokens: pw.rerankerProviderTokens ?? 0,
            top3: hits.slice(0, 3).map((h) => ({ rank: h.rank, path: h.path, symbol: h.symbol, granularity: h.granularity })),
          });
          log(`  ${q.id} rank=${score.rank ?? '-'} applied=${rk.applied ?? false} warm=${warmCleanMs.toFixed(0)}ms`);
        }
        repoRows[repo.name] = { summary: summarizeArmRepo(qRows), queries: qRows };
      } finally {
        await session.close();
      }
    }
    const allQueries = Object.values(repoRows).flatMap((r) => r.queries);
    armResults[arm.id] = { label: arm.label, env: arm.env, overall: summarizeArmRepo(allQueries), repos: repoRows };
  }

  const output = { generatedAt: new Date().toISOString(), mcpEntry, stateRootBase, repoMeta, indexingStats, arms: armResults };
  fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(output, null, 2)}\n`);

  const md = ['# Satori Offline Reranker Benchmark', ''];
  md.push('| Arm | Hit@1 | Hit@3 | Hit@5 | Hit@10 | MRR@10 | Warm p50 | Reranked | Stale Reads | Voyage Tokens |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    const o = armResults[arm.id].overall;
    md.push(`| ${arm.id} | ${pct(o.hitAt1, o.queries)} | ${pct(o.hitAt3, o.queries)} | ${pct(o.hitAt5, o.queries)} | ${pct(o.hitAt10, o.queries)} | ${o.mrr.toFixed(4)} | ${o.warmCleanMedianMs.toFixed(0)} ms | ${o.rerankAppliedCount}/${o.queries} | ${o.staleReads} | ${o.rerankerTokens} |`);
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${md.join('\n')}\n`);
  log(`Wrote ${path.join(outDir, 'results.json')} and ${path.join(outDir, 'summary.md')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
