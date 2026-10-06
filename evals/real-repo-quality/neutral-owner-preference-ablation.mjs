import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLocalSession } from './session.mjs';
import { normalizeHit } from './score.mjs';
import { assertRuntimeDistFresh, importFreshDist } from './dist-freshness.mjs';

// Diagnostic comparison of an owner-discovery search flag, off vs on, against ONE publication of a
// clean pinned colonist-assistant checkout. It reproduces the miss queries recorded in
// docs/improvements/implementation-owner-ranking.md and checks that explicit-intent queries do not move.
// It is not a benchmark: one repository, a handful of queries, owners judged from the documented source.
const root = fileURLToPath(new URL('../..', import.meta.url));
const reposDir = path.join(os.homedir(), '.cache/satori-eval-repos');
const repo = { name: 'colonist-assistant', commit: '40a7c12' };
const dir = path.join(reposDir, `${repo.name}@${repo.commit}`);
const output = process.env.OWNER_PREFERENCE_EVAL_OUTPUT ?? path.join(os.tmpdir(), 'satori-neutral-owner-preference.json');
const comparedFlag = process.env.OWNER_PREFERENCE_EVAL_FLAG ?? 'neutral_owner_preference';
if (!['neutral_owner_preference', 'symbol_metadata_bm25', 'definition_discovery', 'first_stage_owner_floor'].includes(comparedFlag)) throw new Error(`Unsupported comparison flag: ${comparedFlag}`);
const repeats = Number(process.env.OWNER_PREFERENCE_EVAL_REPEATS ?? 2);
if (!Number.isInteger(repeats) || repeats < 2 || repeats > 3) throw new Error('Comparison requires two or three repeats per arm');

assertRuntimeDistFresh(root);
const { DEFAULT_SEARCH_FLAGS } = await importFreshDist(root, 'packages/mcp/dist/core/search-flags.js');
// Unknown flag keys are silently ignored by the resolver, so a stale build would make the "on" arm a no-op.
if (!(comparedFlag in DEFAULT_SEARCH_FLAGS)) throw new Error(`Built runtime lacks ${comparedFlag}; rebuild before comparing.`);
const { classifyPathCategory } = await importFreshDist(root, 'packages/mcp/dist/core/search-ranking-policy.js');

// Valid owners follow the doc's judgement: a path pattern, optionally narrowed by symbol. Paths are matched, not
// line numbers, because historical line references have drifted.
const missCases = [
  { id: 'tracker', query: 'belief tracker hidden card probabilities', owners: [{ label: 'src/core/tracker.ts', file: /(^|\/)src\/core\/tracker\.ts$/, path: 'src/core/tracker.ts' }] },
  { id: 'maxn', query: 'MaxN search default AlphaBeta defensive simulator', owners: [{ label: 'search_maxn', file: /catan-search\/src\/depth\.rs$/, symbol: /\bsearch_maxn\b/, path: 'engine/crates/catan-search/src/depth.rs', decl: /\bfn search_maxn\s*\(/ }] },
  { id: 'trade', query: 'trade workflow idempotent rejected bundle loop', owners: [{ label: 'tradeWorkflow', file: /src\/content\/action-guide\.ts$/, symbol: /\btradeWorkflow\b/, path: 'src/content/action-guide.ts', decl: /^\s*const tradeWorkflow\b/ }] },
  {
    id: 'click', query: 'click executor state signature legal target validation',
    owners: [
      { label: 'nextClickStillLegal', file: /src\/content\/overlay\.ts$/, symbol: /\bnextClickStillLegal\b/, path: 'src/content/overlay.ts', decl: /^\s*(?:private\s+)?nextClickStillLegal\s*\(/ },
      { label: 'legal_actions', file: /catan-core\/src\/state\.rs$/, symbol: /\blegal_actions\b/, path: 'engine/crates/catan-core/src/state.rs', decl: /\bfn legal_actions\s*\(/ },
    ],
    // A relevant execution guard, reported separately so it is not counted as noise.
    guards: [{ label: 'validatedClick', file: /src\/content\/action-guide\.ts$/, symbol: /\bvalidatedClick\b/, path: 'src/content/action-guide.ts', decl: /^\s*const validatedClick\b/ }],
  },
  { id: 'focused_click', query: 'validate next click against current board legal targets', owners: [{ label: 'nextClickStillLegal', file: /src\/content\/overlay\.ts$/, symbol: /\bnextClickStillLegal\b/, path: 'src/content/overlay.ts', decl: /^\s*(?:private\s+)?nextClickStillLegal\s*\(/ }] },
  { id: 'focused_legal', query: 'generate legal actions for the current game phase', owners: [{ label: 'legal_actions', file: /catan-core\/src\/state\.rs$/, symbol: /\blegal_actions\b/, path: 'engine/crates/catan-core/src/state.rs', decl: /\bfn legal_actions\s*\(/ }] },
];
// Explicit intent must be identical with the flag off and on.
const intentControls = [
  { id: 'tests_trade', query: 'tests for trade workflow idempotent rejected bundle loop' },
  { id: 'callers_trade', query: 'callers of tradeWorkflow' },
  { id: 'config_trade', query: 'configuration for trade workflow' },
  { id: 'path_trade', query: 'path:src/content/action-guide.ts trade workflow idempotent rejected bundle loop' },
];

const runtimeFiles = ['packages/mcp/dist/core/search-flags.js', 'packages/mcp/dist/core/search-ranking-policy.js', 'packages/mcp/dist/core/search-execution.js', 'packages/mcp/dist/core/search-request-coordinator.js', 'packages/mcp/dist/core/search-symbol-metadata-bm25.js', 'packages/mcp/dist/core/search-definition-discovery.js', 'packages/mcp/dist/core/search-order-policy.js'];
const runtimeHash = () => crypto.createHash('sha256').update(Buffer.concat(runtimeFiles.map(file => fs.readFileSync(path.join(root, file))))).digest('hex');
const startedRuntimeHash = runtimeHash();
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-owner-preference-eval-'));
const report = { diagnosticOnly: true, comparedFlag, repeats, repo, stateRoot, runtimeHash: startedRuntimeHash, loadAtStart: os.loadavg(), cases: [], controls: [] };
const save = () => fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
const signature = hits => JSON.stringify(hits.map(hit => [hit.file, hit.symbol]));
const matches = (hit, owner) => owner.file.test(hit.file ?? '') && (!owner.symbol || owner.symbol.test(hit.symbol ?? ''));
const rankOf = (hits, owner) => hits.find(hit => matches(hit, owner))?.rank ?? null;
const show = hit => `${hit.rank}. [${hit.pathCategory}] ${hit.file}${hit.symbol ? ` :: ${hit.symbol}` : ''}`;
const write = line => process.stdout.write(`${line}\n`);
// Resolve symbol identity from this publication before tracing its chunks. A declaration-containing span alone can
// belong to another owner, and body chunks need not include the declaration. File-level controls match any file chunk.
// Stage lists are truncated, so absence is only meaningful when shown === total.
const resolvedOwnerIds = new Map();
const declLineOf = owner => {
  if (!owner.decl) return null;
  const index = fs.readFileSync(path.join(dir, owner.path), 'utf8').split(/\r?\n/).findIndex(line => owner.decl.test(line));
  if (index < 0) throw new Error(`Declaration not found for ${owner.label}`);
  return index + 1;
};
const traceOwner = (owner, survival) => {
  if (!survival) return { error: 'no candidateSurvival in response' };
  const declLine = declLineOf(owner);
  const ownerId = resolvedOwnerIds.get(owner.label) ?? null;
  const inOwner = occurrence => ownerId !== null
    ? occurrence.ownerId === ownerId
    : occurrence.relativePath === owner.path;
  const stages = survival.stages.map(stage => {
    const found = stage.candidates.filter(inOwner);
    return { stage: stage.stage, passId: stage.passId ?? null, shown: stage.candidates.length, total: stage.totalOccurrences, bestRank: found.length ? Math.min(...found.map(occurrence => occurrence.rank)) : null, candidateIds: [...new Set(found.map(occurrence => occurrence.candidateId))], occurrences: found };
  });
  const ids = new Set(stages.flatMap(stage => stage.candidateIds));
  const removals = survival.removals.filter(removal => ids.has(removal.candidateId)).map(removal => ({ afterStage: removal.afterStage, reason: removal.reason, passId: removal.passId ?? null }));
  return { declLine, ownerId, stages, removals };
};
const printTrace = (label, trace) => {
  if (trace.error) { write(`  trace ${label}: ${trace.error}`); return; }
  write(`  trace ${label} (owner ${trace.ownerId ?? 'file-level'}), flag off:`);
  for (const stage of trace.stages) write(`    ${stage.stage}${stage.passId ? `[${stage.passId}]` : ''}: ${stage.bestRank ? `rank ${stage.bestRank}` : 'absent'} (shown ${stage.shown}/${stage.total})`);
  for (const removal of trace.removals) write(`    removed after ${removal.afterStage}: ${removal.reason}`);
};

let session;
try {
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!head.startsWith(repo.commit) || execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error(`Pinned repository mismatch: ${dir}`);
  report.head = head;
  session = await openLocalSession({ stateRoot, roots: [reposDir] });
  const status = async () => (await session.call('manage_index', { action: 'status', path: dir })).json;
  write(`Indexing ${repo.name}@${repo.commit} into owned state ${stateRoot}`);
  const indexStarted = performance.now();
  const created = await session.call('manage_index', { action: 'create', path: dir });
  if (created.isError) throw new Error(created.text);
  let ready;
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    ready = await status();
    if (ready?.status === 'ok') break;
    if (ready?.status === 'error' || ['failed', 'blocked', 'cancelled'].includes(ready?.operation?.phase) || Date.now() > deadline) throw new Error(`Index failure: ${JSON.stringify(ready)}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const publicationId = ready.publication?.publicationId;
  if (!publicationId) throw new Error(`No publication identity: ${JSON.stringify(ready)}`);
  report.publicationId = publicationId;
  report.indexElapsedMs = performance.now() - indexStarted;
  write(`Indexed in ${Math.round(report.indexElapsedMs / 1000)}s; publication=${publicationId}`);

  const search = async (query, enabled) => {
    const started = performance.now();
    const response = await session.call('search_codebase', {
      path: dir, query, scope: 'runtime', resultMode: 'grouped', groupBy: 'symbol', limit: 10,
      debugMode: 'full', debugCandidateLimit: 160,
      // Isolate the older pilots from the default engine, which reuses metadata admission.
      flags: { ...DEFAULT_SEARCH_FLAGS, definition_discovery: false, [comparedFlag]: enabled },
    });
    if (response.isError || response.json?.status !== 'ok') throw new Error(`Search failed for "${query}": ${response.text.slice(0, 800)}`);
    const hits = response.json.results.map((raw, index) => {
      const hit = normalizeHit({ rank: index + 1, raw }, classifyPathCategory);
      return { rank: hit.rank, file: hit.path, symbol: hit.symbol ?? hit.displayLabel, pathCategory: hit.pathCategory };
    });
    return { elapsedMs: performance.now() - started, hits, survival: response.json.hints?.debugSearch?.candidateSurvival };
  };
  // Alternate arms so an order effect or nondeterminism is visible rather than assumed away.
  const compare = async query => {
    const samples = { off: [], on: [] };
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const enabled of repeat % 2 === 0 ? [false, true] : [true, false]) samples[enabled ? 'on' : 'off'].push(await search(query, enabled));
    }
    const stageSignature = survival => JSON.stringify(survival?.stages.map(stage => [stage.stage, stage.passId, stage.totalOccurrences, stage.candidates.map(candidate => [candidate.candidateId, candidate.ownerId, candidate.rank])]));
    const arm = list => ({ survival: list[0].survival, hits: list[0].hits, repeatsAgree: list.every(sample => signature(sample.hits) === signature(list[0].hits)), stageRanksAgree: list.every(sample => stageSignature(sample.survival) === stageSignature(list[0].survival)), medianMs: [...list.map(sample => sample.elapsedMs)].sort((a, b) => a - b)[Math.floor(list.length / 2)] });
    if ((await status())?.publication?.publicationId !== publicationId) throw new Error('Publication changed during comparison');
    return { off: arm(samples.off), on: arm(samples.on) };
  };

  report.exactControls = [];
  for (const owner of missCases.flatMap(item => [...item.owners, ...(item.guards ?? [])]).filter(owner => owner.decl)) {
    const response = await session.call('search_codebase', {
      path: dir, query: owner.label, scope: 'runtime', resultMode: 'grouped', groupBy: 'symbol', limit: 5,
      flags: { ...DEFAULT_SEARCH_FLAGS, neutral_owner_preference: false },
    });
    if (response.isError || response.json?.status !== 'ok') throw new Error(`Exact owner lookup failed: ${owner.label}`);
    const raw = response.json.results.find(result => {
      const hit = normalizeHit({ rank: 1, raw: result }, classifyPathCategory);
      return matches({ file: hit.path, symbol: hit.symbol }, owner) && result.target?.symbolId;
    });
    if (!raw) throw new Error(`No published symbol identity for ${owner.label}`);
    const ownerId = JSON.stringify(['symbol', raw.target.file, raw.target.symbolId]);
    resolvedOwnerIds.set(owner.label, ownerId);
    report.exactControls.push({ label: owner.label, ownerId, target: raw.target, navigation: raw.navigation });
  }
  if ((await status())?.publication?.publicationId !== publicationId) throw new Error('Publication changed during owner lookups');

  for (const item of missCases) {
    const { off, on } = await compare(item.query);
    const rows = [...item.owners.map(owner => ({ kind: 'owner', owner })), ...(item.guards ?? []).map(owner => ({ kind: 'guard', owner }))]
      .map(({ kind, owner }) => ({ kind, label: owner.label, off: rankOf(off.hits, owner), on: rankOf(on.hits, owner) }));
    const tracked = [...item.owners, ...(item.guards ?? [])];
    const traces = tracked.map(owner => ({ label: owner.label, off: traceOwner(owner, off.survival), on: traceOwner(owner, on.survival) }));
    // The raw survival trace is large; the report keeps only the per-owner extraction.
    const slim = arm => ({ hits: arm.hits, repeatsAgree: arm.repeatsAgree, stageRanksAgree: arm.stageRanksAgree, medianMs: arm.medianMs });
    report.cases.push({ ...item, owners: item.owners.map(owner => owner.label), guards: (item.guards ?? []).map(owner => owner.label), rows, traces, off: slim(off), on: slim(on) });
    write(`\n[${item.id}] ${item.query}`);
    for (const row of rows) write(`  ${row.kind} ${row.label}: rank ${row.off ?? 'miss'} -> ${row.on ?? 'miss'}`);
    for (const trace of traces) printTrace(trace.label, trace.off);
    write(`  repeats agree: hits off=${off.repeatsAgree} on=${on.repeatsAgree}; stages off=${off.stageRanksAgree} on=${on.stageRanksAgree}; median ms ${off.medianMs.toFixed(0)} -> ${on.medianMs.toFixed(0)}`);
    write('  top 5 off:'); for (const hit of off.hits.slice(0, 5)) write(`    ${show(hit)}`);
    write('  top 5 on:'); for (const hit of on.hits.slice(0, 5)) write(`    ${show(hit)}`);
    save();
  }
  let controlsChanged = 0;
  for (const item of intentControls) {
    const { off, on } = await compare(item.query);
    const identical = signature(off.hits) === signature(on.hits);
    if (!identical) controlsChanged++;
    report.controls.push({ ...item, identical, off: { hits: off.hits }, on: { hits: on.hits } });
    write(`\n[control ${item.id}] ${item.query}\n  off vs on: ${identical ? 'identical' : 'CHANGED'}; hits=${off.hits.length}/${on.hits.length}`);
    save();
  }
  report.intentControlsChanged = controlsChanged;
  if (runtimeHash() !== startedRuntimeHash) throw new Error('Compiled runtime changed during comparison');
  report.loadAtEnd = os.loadavg();
  save();
  write(`\nExplicit-intent controls changed: ${controlsChanged}/${intentControls.length}\nResults: ${output}`);
  if (controlsChanged) process.exitCode = 1;
} catch (error) { report.error = String(error.stack ?? error); save(); throw error; }
finally {
  if (session) await session.close();
  // The model link points to user-owned data; recursive removal must never follow it.
  const models = path.join(stateRoot, 'models');
  if (fs.lstatSync(models, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(models);
  if (!report.error) fs.rmSync(stateRoot, { recursive: true, force: true });
}
