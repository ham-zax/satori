// evals/score.mjs — re-score a committed harness log against a versioned judge.
//
//   node evals/score.mjs --log <harness-log.json> --judge <judge.json> [--strict|--lenient]
//                        [--baseline <harness-log.json>] [--result <result.json>]
//                        [--baseline-result <result.json>] [--legacy]
//
// The judge sha256 is printed on every invocation, so no table in a writeup can be
// attributed to the wrong judge.
//
// What it emits, in order, as four separate blocks that must not be merged:
//
//   1. header      -- judge/log paths, both sha256s, granularity, mode.
//   2. scorecard   -- Hit@1/5/10, MRR, pool R@64/R@80, by cohort. New-scorer
//                     numbers only: judge resolution against this log's data.
//   3. answerable  -- the same numerators over the denominator a fair test would
//                     have used (n minus unanswerable). Its own table, because the
//                     two denominators answer different questions.
//   3b. corrected   -- the same numerators over the denominator that additionally
//                     honors the judge's top-level unanswerableQueries map (n=39
//                     for judge-v2: fresh_f6 leaves too). Its own table; the judge
//                     file stays untouched. For a map-less judge it repeats block 3.
//   4. legacy      -- ONLY with --legacy. The log's own final.final_rank. Labelled
//                     "legacy-replay, not reproducible" and never combined with
//                     anything above. See legacyAggregate() for why.
//
// Three things this script deliberately does NOT do:
//
//  * It does not recompute pool recall. Recall@64 and Recall@80 are read straight out of
//    the log's `fusion.in_rerank_window` and `fusion.in_top80` booleans, because the
//    harness computed them against the judge that was live at run time. They therefore
//    describe THAT judge, not the judge passed to --judge, so the table column headers say
//    "pool ... (run-time judge)" on every run.
//  * It does not re-resolve chunk targets. Chunk IDs are minted by one LanceDB
//    publication, so a judge holding them is only meaningful for the log it was read out
//    of. Resolution is therefore a *binding* check — does the judge's target set
//    intersect the target set the log recorded? — and an empty intersection is a hard
//    failure naming the query, not a zero.
//  * It does not reimplement ranking. The path/symbol oracle is the harness's own
//    scoreQuery() from evals/real-repo-quality/score.mjs, imported, not copied.
//
// Ranking oracle by judge:
//
//  judge-v1 (chunk)  Hit@k / MRR are the log's own recorded `final.final_rank`. v1 holds no
//                    granularity, so --strict and --lenient are the same number by
//                    construction and the flag is accepted and reported as such.
//  judge-v2 (path)   Hit@k / MRR are re-derived from the run's result.json hits:
//                      --lenient  all entries; a whole-file result on a matching path counts
//                      --strict   symbol-level entries only, and a symbol-level result
//
// Exit codes: 0 ok, 1 a target failed to resolve, 2 bad usage.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_SCORER = path.join(HERE, 'real-repo-quality', 'score.mjs');
const COHORTS = ['gap', 'control', 'all'];
const REGRESSION_THRESHOLD = 3;

const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------------------------------------------------------------- args

function usage(msg) {
    if (msg) process.stderr.write(`score.mjs: ${msg}\n\n`);
    process.stderr.write(
        'usage: node evals/score.mjs --log <harness-log.json> --judge <judge.json>\n'
        + '                            [--strict|--lenient] [--baseline <harness-log.json>]\n'
        + '                            [--result <result.json>] [--baseline-result <result.json>]\n'
        + '                            [--legacy]\n',
    );
    process.exit(2);
}

function parseArgs(argv) {
    const out = { strict: null, result: null, baselineResult: null, legacy: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--log') out.log = argv[++i];
        else if (a === '--judge') out.judge = argv[++i];
        else if (a === '--baseline') out.baseline = argv[++i];
        else if (a === '--result') out.result = argv[++i];
        else if (a === '--baseline-result') out.baselineResult = argv[++i];
        else if (a === '--strict') out.strict = true;
        else if (a === '--lenient') out.strict = false;
        else if (a === '--legacy') out.legacy = true;
        else usage(`unknown argument ${a}`);
    }
    if (!out.log) usage('--log is required');
    if (!out.judge) usage('--judge is required');
    return out;
}

// ---------------------------------------------------------------- load

function loadLog(p) {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const records = Array.isArray(raw) ? raw : raw.records;
    if (!Array.isArray(records)) throw new Error(`${p}: not an array and has no records[] array`);
    return new Map(records.map(r => [r.query_id, r]));
}

/** query_id -> top hits ordered by rank, from a run's result.json. */
function loadHits(p) {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = new Map();
    for (const repo of raw.repos ?? []) {
        for (const q of repo.queries ?? []) out.set(q.id, (q.hits ?? []).slice().sort((a, b) => a.rank - b.rank));
    }
    return out;
}

// ---------------------------------------------------------------- resolution

/**
 * Bind a judge to a log. Returns { unresolved, unanswerable, notes }.
 *
 * v1 holds chunk IDs and is index-state-specific: a query resolves when the judge's target
 * set intersects the target set the log recorded. v2 holds path/symbol regexes and resolves
 * when the query has at least one entry, or is explicitly marked unanswerable.
 *
 * Two failure kinds, deliberately not conflated:
 *
 *   unresolved  -- the judge HAS a target but the log does not (disjoint chunk sets, i.e.
 *                  two index states), or the query is absent from the judge, or a v2 query
 *                  has zero entries without an explicit unanswerable flag. Hard failure.
 *   unanswerable-- the judge has NO satisfiable target for this query at all (empty chunk
 *                  set, or an explicit unanswerable flag). Not a binding failure and not a
 *                  retrieval miss: the query was never a fair test. Reported in its own
 *                  column and still counted in the denominator, which is what reproduces
 *                  the historical scorecard.
 */
export function resolveJudge(judge, log) {
    const unresolved = [];
    const notes = [];
    const unanswerable = [];
    for (const [id, rec] of log) {
        const q = judge.queries[id];
        if (!q) {
            unresolved.push({ query_id: id, reason: 'not present in judge' });
            continue;
        }
        if (q.unanswerable === true) unanswerable.push({ query_id: id, reason: q.unanswerableReason ?? 'judge marks this query unanswerable' });
        if (judge.granularity === 'chunk') {
            const logT = new Set(rec.targets ?? []);
            const judgeT = q.targets ?? [];
            const shared = judgeT.filter(t => logT.has(t));
            if (judgeT.length === 0) {
                if (q.unanswerable !== true) {
                    notes.push({ query_id: id, reason: 'judge resolved zero target chunks and does not flag the query unanswerable; treated as a miss' });
                }
            } else if (shared.length === 0) {
                unresolved.push({
                    query_id: id,
                    reason: `judge holds ${judgeT.length} target chunk(s), log recorded ${logT.size}, intersection empty `
                        + '(judge and log were produced against different index states)',
                });
            } else if (shared.length !== logT.size || shared.length !== judgeT.length) {
                notes.push({
                    query_id: id,
                    reason: `judge/log target sets differ: judge ${judgeT.length}, log ${logT.size}, shared ${shared.length}`,
                });
            }
        } else if (!q.unanswerable && (q.entries ?? []).length === 0) {
            unresolved.push({ query_id: id, reason: 'judge holds zero acceptable entries and the query is not marked unanswerable' });
        }
    }
    return { unresolved, unanswerable, notes };
}

// ---------------------------------------------------------------- ranking

function logRanks(judge, log) {
    const out = new Map();
    for (const [id, rec] of log) {
        if (!judge.queries[id]) continue;
        const r = rec.final?.final_rank ?? null;
        out.set(id, {
            rank: r,
            // A file-level hit records matchedTarget.symbol === null (score.mjs normalizeHit
            // nulls the symbol when granularity === 'file'). That is the whole of the
            // granularity information the log kept, and it is enough to say whether the
            // RECORDED hit was symbol-level -- but not enough to recover the run's own
            // strictRank, because a file-level match can shadow a later symbol-level match
            // on the same path. Reported as `recordedHitWasSymbolLevel`, not as strictRank.
            recordedHitWasSymbolLevel: r !== null && (rec.final?.matchedTarget?.symbol ?? null) !== null,
            matched: rec.final?.matchedTarget ?? null,
        });
    }
    return out;
}

function rederivedRanks(judge, log, hits, mode, scoreQuery) {
    const strict = mode === 'strict';
    const out = new Map();
    for (const [id, q] of Object.entries(judge.queries)) {
        if (!log.has(id)) continue;
        if (q.unanswerable) { out.set(id, { rank: null, excluded: 'unanswerable' }); continue; }
        const hs = hits?.get(id);
        if (!hs) { out.set(id, { rank: null, excluded: 'no result.json hits' }); continue; }
        const acceptable = q.entries.map(e => ({
            pathRegex: e.pathRegex,
            symbolRegex: e.symbolRegex ?? null,
            evidence: e.evidence ?? '',
        }));
        const oracle = strict ? { acceptable: acceptable.filter(e => e.symbolRegex) } : { acceptable };
        const res = scoreQuery(oracle, hs);
        out.set(id, {
            rank: strict ? (res.strictRank ?? null) : (res.rank ?? null),
            matched: res.matched ?? null,
            matchedGranularity: res.granularity ?? null,
        });
    }
    return out;
}

export function ranksUnder(judge, log, { mode, hits, scoreQuery }) {
    return judge.granularity === 'chunk'
        ? logRanks(judge, log)
        : rederivedRanks(judge, log, hits, mode, scoreQuery);
}

// ---------------------------------------------------------------- aggregate

export function aggregate(records, ranks, judge) {
    const cohortOf = id => judge.queries[id]?.cohort ?? 'control';
    const isUnanswerable = rec => judge.queries[rec.query_id]?.unanswerable === true;
    // The judge's top-level unanswerableQueries map can list queries the per-query
    // flag misses (judge-v2 records fresh_f6 there without setting its flag). The
    // judge file is frozen, so the scorer honors the map here instead of editing it.
    const isMapUnanswerable = rec => Object.hasOwn(judge.unanswerableQueries ?? {}, rec.query_id);
    const one = rs => {
        const n = rs.length;
        let h1 = 0, h5 = 0, h10 = 0, rr = 0, unans = 0;
        let r80 = 0, r64 = 0;
        for (const rec of rs) {
            if (rec.fusion?.in_top80) r80++;
            if (rec.fusion?.in_rerank_window) r64++;
            if (isUnanswerable(rec)) unans++;
            const rank = ranks.get(rec.query_id)?.rank ?? null;
            if (rank === null) continue;
            if (rank <= 1) h1++;
            if (rank <= 5) h5++;
            if (rank <= 10) h10++;
            rr += 1 / rank;
        }
        // The denominator is every query in the log, unanswerable ones included. That is
        // what reproduces the historical v1-era scorecard; the `unanswerable` column is
        // printed next to it so the reader can see how much of the denominator was never a
        // fair test and subtract it themselves. Nothing is silently dropped or absorbed.
        return {
            n, unanswerable: unans,
            hit1: `${h1}/${n}`, hit5: `${h5}/${n}`, hit10: `${h10}/${n}`,
            mrr: n ? +(rr / n).toFixed(3) : null,
            pool64: `${r64}/${n}`, pool80: `${r80}/${n}`,
            counts: { h1, h5, h10, r64, r80, unans },
        };
    };
    // The answerable-only view: the same numerators over the denominator a fair
    // test would have used (n - unanswerable). Reported alongside the full
    // denominator rather than replacing it, because the two answer different
    // questions and picking one silently is how a scorecard drifts.
    const answerableOne = rs => {
        const kept = rs.filter(rec => !isUnanswerable(rec));
        const a = one(kept);
        const n = kept.length;
        let h1 = 0, h5 = 0, h10 = 0, rr = 0;
        for (const rec of kept) {
            const rank = ranks.get(rec.query_id)?.rank ?? null;
            if (rank === null) continue;
            if (rank <= 1) h1++;
            if (rank <= 5) h5++;
            if (rank <= 10) h10++;
            rr += 1 / rank;
        }
        return {
            n, dropped: rs.length - n,
            hit1: `${h1}/${n}`, hit5: `${h5}/${n}`, hit10: `${h10}/${n}`,
            mrr: n ? +(rr / n).toFixed(3) : null,
            pool64: `${a.counts.r64}/${n}`, pool80: `${a.counts.r80}/${n}`,
            counts: { h1, h5, h10, r64: a.counts.r64, r80: a.counts.r80 },
        };
    };
    // The corrected answerable view: the same numerators over the denominator that
    // additionally honors the judge's unanswerableQueries map (n=39 for judge-v2:
    // fresh_f6 leaves too). Reported as its own table so the as-run (n=46),
    // flag-based answerable (n=40), and map-corrected (n=39) denominators are never
    // mistaken for one another.
    const correctedOne = rs => {
        const kept = rs.filter(rec => !isUnanswerable(rec) && !isMapUnanswerable(rec));
        const a = one(kept);
        const n = kept.length;
        let h1 = 0, h5 = 0, h10 = 0, rr = 0;
        for (const rec of kept) {
            const rank = ranks.get(rec.query_id)?.rank ?? null;
            if (rank === null) continue;
            if (rank <= 1) h1++;
            if (rank <= 5) h5++;
            if (rank <= 10) h10++;
            rr += 1 / rank;
        }
        return {
            n, dropped: rs.length - n,
            hit1: `${h1}/${n}`, hit5: `${h5}/${n}`, hit10: `${h10}/${n}`,
            mrr: n ? +(rr / n).toFixed(3) : null,
            pool64: `${a.counts.r64}/${n}`, pool80: `${a.counts.r80}/${n}`,
            counts: { h1, h5, h10, r64: a.counts.r64, r80: a.counts.r80 },
        };
    };
    const byCohort = pred => records.filter(r => pred(cohortOf(r.query_id)));
    return {
        gap: one(byCohort(c => c === 'gap')),
        control: one(byCohort(c => c === 'control')),
        all: one(records),
        answerable: {
            gap: answerableOne(byCohort(c => c === 'gap')),
            control: answerableOne(byCohort(c => c === 'control')),
            all: answerableOne(records),
        },
        answerableCorrected: {
            gap: correctedOne(byCohort(c => c === 'gap')),
            control: correctedOne(byCohort(c => c === 'control')),
            all: correctedOne(records),
        },
        // True when the judge labels no query with a cohort. The gap/control rows
        // are then meaningless -- cohortOf() falls back to 'control' for every
        // query, so gap would read 0/0 -- and only the `all` row means anything.
        hasCohorts: Object.values(judge.queries ?? {}).some(q => typeof q?.cohort === 'string'),
    };
}

/**
 * Legacy replay: the metrics implied by the log's OWN `final.final_rank`.
 *
 * NOT comparable with anything above. `final.final_rank` was written at run time
 * by the harness's scoreQuery() regex oracle over the acceptable sets as they
 * stood that day, which is not the judge being passed to --judge. scoreQuery is
 * committed (evals/real-repo-quality/score.mjs), so the oracle can be re-run --
 * but the run-time acceptable sets it was applied to are not recorded anywhere,
 * so a replay cannot be validated against the number in the log. A difference
 * between this block and the table above is therefore uninterpretable: it may be
 * a retrieval change, an oracle change, or both.
 *
 * Kept because deleting it would erase the only record of what the harness itself
 * thought it had achieved, and because hiding it would let a legacy number be
 * quoted next to a current one without the reader noticing.
 */
export function legacyAggregate(records, judge) {
    const cohortOf = id => judge.queries[id]?.cohort ?? 'control';
    const one = rs => {
        const n = rs.length;
        let h1 = 0, h5 = 0, h10 = 0, rr = 0, recorded = 0;
        for (const rec of rs) {
            const rank = rec.final?.final_rank;
            if (rank === null || rank === undefined) continue;
            recorded++;
            if (rank <= 1) h1++;
            if (rank <= 5) h5++;
            if (rank <= 10) h10++;
            rr += 1 / rank;
        }
        return {
            n, recorded,
            hit1: `${h1}/${n}`, hit5: `${h5}/${n}`, hit10: `${h10}/${n}`,
            mrr: n ? +(rr / n).toFixed(3) : null,
        };
    };
    const byCohort = pred => records.filter(r => pred(cohortOf(r.query_id)));
    return {
        gap: one(byCohort(c => c === 'gap')),
        control: one(byCohort(c => c === 'control')),
        all: one(records),
    };
}

// ---------------------------------------------------------------- diff

export function diffAgainst(current, baseline, judge, currentRanks, baselineRanks) {
    const rows = [];
    const regressions = [];
    for (const [id, cur] of current) {
        if (judge.queries[id]?.unanswerable || Object.hasOwn(judge.unanswerableQueries ?? {}, id)) continue;
        const base = baseline.get(id);
        if (!base) { rows.push({ query_id: id, base: null, cur: cur, basePool80: null, curPool80: cur.fusion?.in_top80 === true, note: 'absent from baseline log' }); continue; }
        const b = baselineRanks.get(id)?.rank ?? null;
        const c = currentRanks.get(id)?.rank ?? null;
        const basePool80 = base.fusion?.in_top80 === true;
        const curPool80 = cur.fusion?.in_top80 === true;
        const row = { query_id: id, base: b, cur: c, basePool80, curPool80, delta: b === null ? null : (c === null ? null : c - b) };
        let reason = null;
        if (b !== null && c === null) reason = `dropped out of the top 10 (baseline rank ${b})`;
        else if (b !== null && c !== null && c - b > REGRESSION_THRESHOLD) reason = `rank worsened by ${c - b} (${b} -> ${c}), over the threshold of ${REGRESSION_THRESHOLD}`;
        else if (basePool80 && !curPool80) reason = 'left the fused top-80 pool';
        if (reason) { row.regression = true; row.reason = reason; regressions.push(row); }
        else if (b === null && c !== null) row.note = 'newly resolved';
        rows.push(row);
    }
    return { rows, regressions };
}

// ---------------------------------------------------------------- report

function out(s) { process.stdout.write(s); }

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const judgePath = path.resolve(args.judge);
    const logPath = path.resolve(args.log);
    const required = [judgePath, logPath, ...(args.baseline ? [path.resolve(args.baseline)] : [])];
    for (const p of required) {
        if (!fs.existsSync(p)) { process.stderr.write(`score.mjs: no such file: ${p}\n`); process.exit(2); }
    }

    const judgeSha = sha256(judgePath);
    const judge = JSON.parse(fs.readFileSync(judgePath, 'utf8'));
    const log = loadLog(logPath);
    const mode = args.strict === null ? 'lenient' : (args.strict ? 'strict' : 'lenient');

    out(`judge            ${args.judge}\n`);
    out(`judge sha256     ${judgeSha}\n`);
    out(`judge version    ${judge.judgeVersion}  granularity=${judge.granularity ?? 'entry'}  portability=${judge.portability}\n`);
    out(`log              ${args.log}\n`);
    out(`log sha256       ${sha256(logPath)}\n`);
    out(`mode             ${mode}\n`);
    if (judge.granularity === 'chunk') {
        out('mode note        this judge is chunk-level and carries no granularity, so --strict and --lenient are the same number by construction.\n');
    } else if (args.strict === null) {
        out('mode note        no --strict/--lenient given; defaulting to lenient. For this judge the two differ.\n');
    }

    const { unresolved, unanswerable, notes } = resolveJudge(judge, log);
    if (unanswerable.length) {
        out(`\nunanswerable under this judge (${unanswerable.length}) -- never a fair test, so never a retrieval miss; kept in the denominator and reported here:\n`);
        for (const u of unanswerable) out(`  ${u.query_id}: ${u.reason}\n`);
    }
    if (notes.length) {
        out(`\nbinding notes (${notes.length}):\n`);
        for (const n of notes) out(`  ${n.query_id}: ${n.reason}\n`);
    }
    if (unresolved.length) {
        process.stderr.write(`\nFAIL: ${unresolved.length} target(s) failed to resolve under judge ${judge.judgeVersion} (sha256 ${judgeSha}):\n`);
        for (const u of unresolved) process.stderr.write(`  ${u.query_id}: ${u.reason}\n`);
        process.exit(1);
    }

    const needsHits = judge.granularity !== 'chunk';
    let hits = null;
    if (needsHits) {
        const rp = path.resolve(args.result ?? path.join(path.dirname(logPath), 'result.json'));
        if (!fs.existsSync(rp)) {
            process.stderr.write(
                `\nFAIL: judge ${judge.judgeVersion} ranks by path/symbol, which needs the run's result.json hits, and none was found at\n`
                + `      ${rp}\n      Pass --result <path>, or use judge-v1, which ranks from the log alone.\n`,
            );
            process.exit(1);
        }
        hits = loadHits(rp);
        out(`ranking source   ${path.relative(process.cwd(), rp)} sha256 ${sha256(rp)}\n`);
    }

    const { scoreQuery } = await import(pathToFileURL(HARNESS_SCORER).href);
    const current = ranksUnder(judge, log, { mode, hits, scoreQuery });
    const agg = aggregate([...log.values()], current, judge);

    out(`\n=== ${judge.judgeVersion} / ${mode === 'strict' ? 'STRICT (symbol-level entries only)' : 'LENIENT (symbol + path entries)'} ===\n`);
    out('source: judge resolution against this log\'s chunk/hit data. Current-scorer numbers only.\n');
    if (!agg.hasCohorts) {
        out('cohorts: this judge labels no query with a cohort, so the gap and control rows below are not meaningful -- read the `all` row only.\n');
    }
    out('\n| cohort | n | unanswerable | Hit@1 | Hit@5 | Hit@10 | MRR | pool R@64 (run-time judge) | pool R@80 (run-time judge) |\n');
    out('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n');
    for (const c of COHORTS) {
        const a = agg[c];
        out(`| ${c} | ${a.n} | ${a.unanswerable} | ${a.hit1} | ${a.hit5} | ${a.hit10} | ${a.mrr} | ${a.pool64} | ${a.pool80} |\n`);
    }
    out('\npool R@64/R@80 are the log\'s own fusion.in_rerank_window / fusion.in_top80, computed at run time against that run\'s judge. Not recomputed here.\n');
    out('the denominator is every query in the log, unanswerable ones included, which is what reproduces the historical scorecard; subtract the unanswerable column to get the denominator a fair test would have used. The answerable-only denominators are printed as a separate table below rather than left as an exercise.\n');

    // Answerable-only denominators. Same numerators, denominator reduced by the
    // queries this judge holds no satisfiable target for. Reported as its own
    // table so the two denominators are never mistaken for one another.
    out(`\n--- answerable-only denominators (same numerators; unanswerable queries removed from the denominator) ---\n`);
    if (!agg.hasCohorts) out('this judge labels no cohort, so only the `all` row applies.\n');
    out('\n| cohort | n answerable | dropped as unanswerable | Hit@1 | Hit@5 | Hit@10 | MRR | pool R@64 (run-time judge) | pool R@80 (run-time judge) |\n');
    out('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n');
    for (const c of (agg.hasCohorts ? COHORTS : ['all'])) {
        const a = agg.answerable[c];
        out(`| ${c} | ${a.n} | ${a.dropped} | ${a.hit1} | ${a.hit5} | ${a.hit10} | ${a.mrr} | ${a.pool64} | ${a.pool80} |\n`);
    }
    out('\nHit@k and MRR are NOT comparable between the two tables when dropped > 0: the first penalises the judge for queries it could not answer, the second does not. Quote one and say which.\n');

    // Corrected answerable denominators. Same numerators as the table above;
    // the denominator additionally honors the judge's top-level
    // unanswerableQueries map without editing the judge file. For judge-v2 this
    // removes fresh_f6 (map-listed, flag missing): n=40 becomes n=39, and only
    // the denominators move. For a judge with no such map (judge-28) this table
    // repeats the one above exactly.
    const mapListed = Object.keys(judge.unanswerableQueries ?? {}).length;
    out('\n--- corrected answerable-only denominators (additionally honoring the judge unanswerableQueries map; judge file untouched) ---\n');
    out(`map-listed unanswerable queries under this judge: ${mapListed}\n`);
    if (!agg.hasCohorts) out('this judge labels no cohort, so only the `all` row applies.\n');
    out('\n| cohort | n corrected | dropped (flag+map) | Hit@1 | Hit@5 | Hit@10 | MRR | pool R@64 (run-time judge) | pool R@80 (run-time judge) |\n');
    out('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n');
    for (const c of (agg.hasCohorts ? COHORTS : ['all'])) {
        const a = agg.answerableCorrected[c];
        out(`| ${c} | ${a.n} | ${a.dropped} | ${a.hit1} | ${a.hit5} | ${a.hit10} | ${a.mrr} | ${a.pool64} | ${a.pool80} |\n`);
    }

    if (judge.granularity === 'chunk') {
        const sym = [...log.values()].filter(r => r.final?.final_rank != null && current.get(r.query_id)?.recordedHitWasSymbolLevel).length;
        const rec = [...log.values()].filter(r => r.final?.final_rank != null).length;
        out(`\nrecorded-hit granularity (informational, not a separate metric): ${sym}/${rec} recorded hits were symbol-level; the rest were whole-file results on a matching path.\n`);
        out('This does not reproduce the run\'s own strictRank: a whole-file match can shadow a later symbol-level match on the same path, and the run never recorded strictRank.\n');
    }

    if (args.baseline) {
        const basePath = path.resolve(args.baseline);
        const baseLog = loadLog(basePath);
        out(`\n--- paired diff vs ${path.relative(process.cwd(), basePath)} (sha256 ${sha256(basePath)}) ---\n`);
        const bu = resolveJudge(judge, baseLog);
        if (bu.unresolved.length) {
            process.stderr.write(`\nFAIL: baseline log has ${bu.unresolved.length} target(s) that fail to resolve under judge ${judge.judgeVersion} (sha256 ${judgeSha}):\n`);
            for (const u of bu.unresolved) process.stderr.write(`  ${u.query_id}: ${u.reason}\n`);
            process.exit(1);
        }
        const baseHits = needsHits
            ? loadHits(path.resolve(args.baselineResult ?? path.join(path.dirname(basePath), 'result.json')))
            : null;
        const baseRanks = ranksUnder(judge, baseLog, { mode, hits: baseHits, scoreQuery });
        const { rows, regressions } = diffAgainst(log, baseLog, judge, current, baseRanks);
        const interesting = rows.filter(r => r.regression || r.note || (r.delta !== null && r.delta !== 0));
        out('\n| query | baseline rank | current rank | delta | pool80 base->cur | status |\n');
        out('|---|---:|---:|---:|:---:|---|\n');
        for (const r of interesting.sort((a, b) => String(a.query_id).localeCompare(String(b.query_id)))) {
            const st = r.regression ? `REGRESSION: ${r.reason}` : (r.note ?? 'changed');
            out(`| ${r.query_id} | ${r.base ?? 'absent'} | ${r.cur ?? 'absent'} | ${r.delta ?? '-'} | ${r.basePool80 ? 'Y' : 'N'}->${r.curPool80 ? 'Y' : 'N'} | ${st} |\n`);
        }
        out(`\nREGRESSIONS (${regressions.length}):\n`);
        if (regressions.length === 0) out('  (none)\n');
        for (const r of regressions) {
            out(`  ${r.query_id}: baseline rank ${r.base ?? 'absent'} -> current rank ${r.cur ?? 'absent'}; ${r.reason}\n`);
        }
    }

    // ---------------------------------------------------------------- legacy
    // Opt-in via --legacy, and printed in its own block under its own heading,
    // after everything above. The numbers come from the log's own
    // final.final_rank, which the harness computed with a different oracle
    // against different acceptable sets. They are never summed with, averaged
    // into, or placed beside the current-scorer tables.
    if (args.legacy) {
        const leg = legacyAggregate([...log.values()], judge);
        out('\n\n');
        out('################################################################\n');
        out('#  LEGACY REPLAY -- NOT REPRODUCIBLE, NOT COMPARABLE\n');
        out('#  Source: this log\'s own `final.final_rank` field.\n');
        out('#  That field was written at run time by the harness scoreQuery()\n');
        out('#  regex oracle over the acceptable sets as they stood that day,\n');
        out('#  which is NOT the judge used above. The oracle source is\n');
        out('#  committed (evals/real-repo-quality/score.mjs) but the run-time\n');
        out('#  acceptable sets are not recorded, so a replay here cannot be\n');
        out('#  validated against the number in the log. A difference between\n');
        out('#  this block and the tables above is uninterpretable: retrieval\n');
        out('#  change, oracle change, or both.\n');
        out('#  Do not sum, average, or quote these next to a new-scorer\n');
        out('#  column. New-scorer numbers come from judge resolution; these\n');
        out('#  do not.\n');
        out('################################################################\n');
        out(`\njudge (for cohort labels only) ${judge.judgeVersion}  sha256 ${judgeSha}\n`);
        out('\n| cohort | n | legacy Hit@1 | legacy Hit@5 | legacy Hit@10 | legacy MRR | final_rank recorded |\n');
        out('|---|---:|---:|---:|---:|---:|---:|\n');
        for (const c of COHORTS) {
            const a = leg[c];
            out(`| ${c} | ${a.n} | ${a.hit1} | ${a.hit5} | ${a.hit10} | ${a.mrr} | ${a.recorded}/${a.n} |\n`);
        }
        out('\n`final_rank recorded` is how many of the n queries carried a final_rank at all. Where it is below n, the legacy MRR divides by n anyway, so it is not comparable even to itself across runs.\n');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
