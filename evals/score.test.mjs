// node --test evals/score.test.mjs
//
// Three things this file exists to pin down, because each one can silently pass while
// being wrong:
//
//   1. STRICT and LENIENT must actually diverge on a path-only query. If they ever agree
//      everywhere, one of them is not doing its job and every strict number in a writeup
//      is a lenient number wearing a strict label.
//   2. An unresolved target must be a non-zero exit that NAMES the query. A silent zero
//      is the failure mode harness-logger.mjs:346 documents, and it is the reason the
//      guard exists.
//   3. The regression list must name every regressed query with baseline rank, current
//      rank, and a reason. A count without names is not actionable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveJudge, ranksUnder, aggregate, diffAgainst, legacyAggregate } from './score.mjs';
import { scoreQuery } from './real-repo-quality/score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Compact fixtures preserve recorded target sets, admission, final ranks, and hits
// from 84bfedc0; original raw runs are retained on the recovery branch.
const RQ = path.join(HERE, 'fixtures', 'search-quality');
const V1 = path.join(RQ, 'judge-v1.json');
const V2 = path.join(HERE, 'judges', 'judge-v2.json');

const judgeV1 = JSON.parse(fs.readFileSync(V1, 'utf8'));
const judgeV2 = JSON.parse(fs.readFileSync(V2, 'utf8'));

const asMap = recs => new Map(recs.map(r => [r.query_id, r]));
const readLog = name => asMap(JSON.parse(fs.readFileSync(path.join(RQ, name, 'harness-log.json'), 'utf8')));
const readHits = name => {
    const raw = JSON.parse(fs.readFileSync(path.join(RQ, name, 'result.json'), 'utf8'));
    const out = new Map();
    for (const repo of raw.repos ?? []) for (const q of repo.queries ?? []) out.set(q.id, (q.hits ?? []).slice().sort((a, b) => a.rank - b.rank));
    return out;
};
const run = argv => {
    try {
        return { code: 0, out: execFileSync(process.execPath, [path.join(HERE, 'score.mjs'), ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
        return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
};

// ---------------------------------------------------------------- 1. strict vs lenient

test('STRICT and LENIENT diverge on the path-only query p5_rewritten', () => {
    const log = readLog('baseline');
    const hits = readHits('baseline');

    const q = judgeV2.queries.p5_rewritten;
    assert.ok(q.entries.some(e => e.granularity === 'path'), 'p5_rewritten must have a path-level entry for this test to mean anything');
    assert.ok(!q.entries.some(e => e.granularity === 'symbol'), 'p5_rewritten is the path-only case: adding a symbol entry would stop testing the divergence');

    const strict = ranksUnder(judgeV2, log, { mode: 'strict', hits, scoreQuery });
    const lenient = ranksUnder(judgeV2, log, { mode: 'lenient', hits, scoreQuery });

    // Lenient admits the whole-file result on the path-level entry; strict has no
    // symbol-level entry to match, so it scores nothing.
    assert.equal(lenient.get('p5_rewritten').rank, 4, 'lenient should score the rank-4 whole-file result on predicate_pushdown/');
    assert.equal(strict.get('p5_rewritten').rank, null, 'strict has no symbol-level entry, so it must not score');

    const aggStrict = aggregate([...log.values()], strict, judgeV2);
    const aggLenient = aggregate([...log.values()], lenient, judgeV2);
    assert.notEqual(aggStrict.all.hit5, aggLenient.all.hit5, 'the two modes must produce different Hit@5 columns');
    assert.ok(aggLenient.all.counts.h5 > aggStrict.all.counts.h5, 'lenient can only be >= strict; it admits a superset of entries');
});

test('the v2 judge has at least one query whose strict and lenient ranks differ on the committed Baseline', () => {
    const log = readLog('baseline');
    const hits = readHits('baseline');
    const strict = ranksUnder(judgeV2, log, { mode: 'strict', hits, scoreQuery });
    const lenient = ranksUnder(judgeV2, log, { mode: 'lenient', hits, scoreQuery });
    const diverging = Object.entries(judgeV2.queries)
        .filter(([, q]) => !q.unanswerable)
        .filter(([id]) => (strict.get(id)?.rank ?? null) !== (lenient.get(id)?.rank ?? null))
        .map(([id]) => id);
    assert.deepEqual(diverging.sort(), ['fresh_r6', 'p5_rewritten', 'r7_rewritten']);
    for (const id of diverging) {
        assert.ok(judgeV2.queries[id].entries.some(e => e.granularity === 'path'), `${id} diverges, so it must be a path-only query`);
    }
});

test('under a chunk-level judge strict and lenient are the same number by construction', () => {
    const log = readLog('baseline');
    const a = ranksUnder(judgeV1, log, { mode: 'strict' });
    const b = ranksUnder(judgeV1, log, { mode: 'lenient' });
    for (const [id, ra] of a) assert.deepEqual(ra.rank, b.get(id).rank, `${id} must not differ under a granularity-free judge`);
});

// ---------------------------------------------------------------- 2. fail on unresolved

test('resolveJudge fails a chunk judge whose target set is disjoint from the log, naming the query', () => {
    const log = new Map([['ghost', { query_id: 'ghost', targets: ['chunk_deadbeef'] }]]);
    const judge = { granularity: 'chunk', queries: { ghost: { targets: ['chunk_0000aaaa'], targetCount: 1 } } };
    const { unresolved, unanswerable } = resolveJudge(judge, log);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].query_id, 'ghost');
    assert.match(unresolved[0].reason, /intersection empty/);
    assert.equal(unanswerable.length, 0, 'a disjoint non-empty target set is a binding failure, not an unanswerable query');
});

test('resolveJudge reports a zero-chunk v1 entry as unanswerable rather than as a failure', () => {
    const log = new Map([['r1', { query_id: 'r1', targets: [] }]]);
    const judge = { granularity: 'chunk', queries: { r1: { targets: [], targetCount: 0, unanswerable: true, unanswerableReason: 'no acceptable path matched' } } };
    const { unresolved, unanswerable } = resolveJudge(judge, log);
    assert.equal(unresolved.length, 0, 'an unsatisfiable oracle is a judge defect to report, not a scoring failure');
    assert.deepEqual(unanswerable.map(u => u.query_id), ['r1']);
});

test('the CLI exits non-zero and names the query when targets do not resolve', () => {
    // unresolved was scored against cases.json: 26 of its 28 ids are absent
    // from every committed judge.
    const r = run(['--log', path.join(RQ, 'unresolved', 'harness-log.json'), '--judge', V1, '--strict']);
    assert.equal(r.code, 1, 'must exit 1, not 0 and not a crash');
    assert.match(r.out, /FAIL: 26 target\(s\) failed to resolve under judge v1/);
    assert.match(r.out, /^\s+p9: not present in judge$/m);
    assert.match(r.out, /^\s+f10: not present in judge$/m);
    // A failure must still print the judge hash, or the failure is unattributable.
    assert.match(r.out, /judge sha256\s+[0-9a-f]{64}/);
    // And it must not print an aggregate table it cannot stand behind.
    assert.doesNotMatch(r.out, /^\| all \|/m);
});

test('the CLI exits non-zero on unbound-log.json, which recorded no target set at all', () => {
    const r = run(['--log', path.join(RQ, 'unbound-log.json'), '--judge', V1, '--strict']);
    assert.equal(r.code, 1);
    assert.match(r.out, /r1: judge holds 2 target chunk\(s\), log recorded 0, intersection empty/);
});

test('the CLI fails when a path/symbol judge is given no result.json to rank against', () => {
    // A log v2 fully covers, pointed at a result.json that does not exist: resolution
    // passes, so the failure must come from the missing ranking source.
    const r = run([
        '--log', path.join(RQ, 'baseline', 'harness-log.json'),
        '--judge', V2, '--lenient',
        '--result', path.join(RQ, 'baseline', 'no-such-result.json'),
    ]);
    assert.equal(r.code, 1);
    assert.match(r.out, /needs the run's result\.json hits/);
    assert.match(r.out, /no-such-result\.json/);
    assert.match(r.out, /judge sha256\s+[0-9a-f]{64}/, 'even a ranking-source failure must print the judge hash');
});

// ---------------------------------------------------------------- 3. regression list

test('diffAgainst names every regressed query with baseline rank, current rank, and a reason', () => {
    const judge = { queries: { a: { cohort: 'gap' }, b: { cohort: 'gap' }, c: { cohort: 'control' }, d: { cohort: 'control' } } };
    const rec = (qid, rank, inTop80 = true) => ({ query_id: qid, fusion: { in_top80: inTop80, in_rerank_window: inTop80 }, final: { final_rank: rank } });
    // a: 4 -> absent (dropped out of the top 10)
    // b: 1 -> 5    (worsened by 4, over the threshold of 3)
    // c: 2 -> 2    (unchanged)
    // d: 6 -> 5    (improved)
    const current = new Map(['a', 'b', 'c', 'd'].map(id => [id, rec(id, id === 'a' ? null : id === 'b' ? 5 : id === 'c' ? 2 : 5)]));
    const baseline = new Map(['a', 'b', 'c', 'd'].map(id => [id, rec(id, id === 'a' ? 4 : id === 'b' ? 1 : id === 'c' ? 2 : 6)]));
    const curRanks = new Map([['a', { rank: null }], ['b', { rank: 5 }], ['c', { rank: 2 }], ['d', { rank: 5 }]]);
    const baseRanks = new Map([['a', { rank: 4 }], ['b', { rank: 1 }], ['c', { rank: 2 }], ['d', { rank: 6 }]]);

    const { regressions } = diffAgainst(current, baseline, judge, curRanks, baseRanks);
    const byId = Object.fromEntries(regressions.map(r => [r.query_id, r]));

    assert.deepEqual(Object.keys(byId).sort(), ['a', 'b'], 'exactly the two regressed queries, and no others');
    assert.deepEqual([byId.a.base, byId.a.cur], [4, null]);
    assert.match(byId.a.reason, /dropped out of the top 10 \(baseline rank 4\)/);
    assert.deepEqual([byId.b.base, byId.b.cur], [1, 5]);
    assert.match(byId.b.reason, /rank worsened by 4 \(1 -> 5\), over the threshold of 3/);
    assert.ok(!byId.c, 'an unchanged rank is not a regression');
    assert.ok(!byId.d, 'an improvement is not a regression');
});

test('diffAgainst flags a query that leaves the fused top-80 pool even when its rank is unchanged', () => {
    const judge = { queries: { z: { cohort: 'control' } } };
    const current = new Map([['z', { query_id: 'z', fusion: { in_top80: false, in_rerank_window: false }, final: { final_rank: 2 } }]]);
    const baseline = new Map([['z', { query_id: 'z', fusion: { in_top80: true, in_rerank_window: true }, final: { final_rank: 2 } }]]);
    const ranks = new Map([['z', { rank: 2 }]]);
    const { regressions } = diffAgainst(current, baseline, judge, ranks, ranks);
    assert.equal(regressions.length, 1);
    assert.match(regressions[0].reason, /left the fused top-80 pool/);
});

test('the Baseline vs Condition A diff names all 5 known regressions on the committed logs', () => {
    const r = run([
        '--log', path.join(RQ, 'expanded', 'harness-log.json'),
        '--judge', V1, '--strict',
        '--baseline', path.join(RQ, 'baseline', 'harness-log.json'),
    ]);
    assert.equal(r.code, 0);
    assert.match(r.out, /REGRESSIONS \(5\):/);
    for (const id of ['r8', 'r5_rewritten', 'fresh_r6', 'fresh_p2', 'f10_rewritten']) {
        assert.match(r.out, new RegExp(`^  ${id}: baseline rank \\d+ -> current rank`, 'm'), `${id} must be named with both ranks`);
    }
    assert.match(r.out, /r8: baseline rank 6 -> current rank absent; dropped out of the top 10 \(baseline rank 6\)/);
    assert.match(r.out, /fresh_p2: baseline rank 1 -> current rank 8; rank worsened by 7 \(1 -> 8\), over the threshold of 3/);
});

// ---------------------------------------------------------------- known-good reproduction

test('judge-v1 reproduces the known-good Baseline numbers exactly', () => {
    const log = readLog('baseline');
    const ranks = ranksUnder(judgeV1, log, { mode: 'strict' });
    const a = aggregate([...log.values()], ranks, judgeV1);
    assert.equal(a.all.hit1, '5/46');
    assert.equal(a.all.hit5, '11/46');
    assert.equal(a.all.hit10, '16/46');
    assert.equal(a.all.mrr, 0.168);
    assert.equal(a.gap.pool80, '2/23');
    assert.equal(a.control.pool80, '23/23');
    assert.equal(a.all.unanswerable, 5, 'the 5 zero-target v1 entries are reported, not absorbed');
});

test('judge-v1 reproduces the known-good Condition A numbers exactly', () => {
    const log = readLog('expanded');
    const ranks = ranksUnder(judgeV1, log, { mode: 'strict' });
    const a = aggregate([...log.values()], ranks, judgeV1);
    assert.equal(a.all.hit1, '6/46');
    assert.equal(a.all.hit5, '12/46');
    assert.equal(a.all.hit10, '17/46');
    assert.equal(a.all.mrr, 0.187);
    assert.equal(a.gap.pool80, '13/23');
    assert.equal(a.control.pool80, '23/23');
});

test('the v2 judge binds to every one of its 46 queries with no unresolvable query', () => {
    const log = readLog('baseline');
    const { unresolved, unanswerable } = resolveJudge(judgeV2, log);
    assert.deepEqual(unresolved, []);
    // fresh_f6 left this list at C4: its pathRegex was a filename-case error
    // (^docs/source/(WhitePaper|FlatBuffers)\.md$), corrected to the regex the
    // blind adjudicator itself proposed. See v2-adjudication.md "Post-adjudication
    // path repairs (C4)". 40 answerable / 6 unanswerable.
    assert.equal(unanswerable.length, 6);
    assert.deepEqual(unanswerable.map(u => u.query_id).sort(), ['f1_rewritten', 'fresh_p1', 'fresh_p4', 'fresh_p5', 'fresh_p6', 'fresh_r5']);
});

test('every judge-v2 query is either answerable with entries or flagged unanswerable', () => {
    // A query with zero entries and no unanswerable flag is neither: resolveJudge
    // fails it as unresolved, and aggregate would absorb it as a retrieval miss.
    for (const [id, q] of Object.entries(judgeV2.queries)) {
        if (q.unanswerable === true) {
            assert.equal((q.entries ?? []).length, 0, `${id} is flagged unanswerable, so it must carry no satisfiable entry`);
            assert.ok(q.unanswerableReason, `${id} must record why it is not a fair test`);
            continue;
        }
        assert.ok((q.entries ?? []).length > 0, `${id} is answerable, so it must carry at least one acceptable entry`);
        for (const e of q.entries) {
            assert.ok(e.granularity === 'path' || e.granularity === 'symbol', `${id} entry needs an explicit granularity`);
            assert.ok(e.pathRegex, `${id} entry needs a pathRegex`);
            if (e.granularity === 'symbol') assert.ok(e.symbolRegex, `${id} symbol entry needs a symbolRegex`);
        }
    }
});

test('a C4 repaired pathRegex matches its repaired path and not the path it replaced', () => {
    // The point of a path repair is that the old string resolved to nothing. If
    // this regresses, the entry is unsatisfiable again and the query is silently
    // unanswerable without being flagged.
    const repaired = [
        { id: 'fresh_f6', pathRegex: '^docs/source/white_paper\\.md$', good: 'docs/source/white_paper.md', bad: ['docs/source/WhitePaper.md', 'docs/source/FlatBuffers.md'] },
        { id: 'fresh_f3', pathRegex: '^java/src/main/java/com/google/flatbuffers/FlexBuffers\\.java$', good: 'java/src/main/java/com/google/flatbuffers/FlexBuffers.java', bad: ['java/com/google/flatbuffers/FlexBuffers.java'] },
    ];
    for (const r of repaired) {
        const rx = new RegExp(r.pathRegex);
        assert.ok(rx.test(r.good), `${r.id}: ${r.pathRegex} must match ${r.good}`);
        for (const b of r.bad) assert.equal(rx.test(b), false, `${r.id}: ${r.pathRegex} must not match the path it replaced (${b})`);
        const entry = judgeV2.queries[r.id].entries.find(e => e.pathRegex === r.pathRegex);
        assert.ok(entry, `${r.id} must actually carry the repaired pathRegex`);
        assert.equal(entry.adjudicatedVerdict, 'yes');
    }
});

// ---------------------------------------------------------------- 4. full scorecard + legacy separation

test('answerable-only denominators drop the unanswerable queries and keep the numerators', () => {
    const judge = {
        granularity: 'chunk',
        queries: {
            a: { cohort: 'gap' },
            b: { cohort: 'gap', unanswerable: true },
            c: { cohort: 'gap' },
            d: { cohort: 'control', unanswerable: true },
            e: { cohort: 'control' },
        },
    };
    const rec = (qid, rank) => ({ query_id: qid, fusion: { in_top80: true, in_rerank_window: true }, final: { final_rank: rank } });
    const records = [rec('a', 1), rec('b', 4), rec('c', 2), rec('d', 3), rec('e', null)];
    const ranks = new Map([['a', { rank: 1 }], ['b', { rank: 4 }], ['c', { rank: 2 }], ['d', { rank: 3 }], ['e', { rank: null }]]);
    const agg = aggregate(records, ranks, judge);

    // Full denominator: everything counts, which is what reproduces history.
    assert.equal(agg.all.n, 5);
    assert.equal(agg.all.unanswerable, 2);
    assert.equal(agg.all.hit1, '1/5');

    // Answerable-only: n falls by the two unanswerable queries. b (rank 4) and
    // d (rank 3) leave the denominator without contributing a numerator here, so
    // Hit@1 over 3 is 1/3 -- this is a DIFFERENT measurement, not a better one.
    assert.equal(agg.answerable.all.n, 3);
    assert.equal(agg.answerable.all.dropped, 2);
    assert.equal(agg.answerable.all.hit1, '1/3');
    assert.equal(agg.answerable.all.mrr, 0.5, '(1/1 + 1/2) / 3');

    // gap lost one unanswerable, control lost one.
    assert.equal(agg.answerable.gap.n, 2);
    assert.equal(agg.answerable.gap.dropped, 1);
    assert.equal(agg.answerable.control.n, 1);
    assert.equal(agg.answerable.control.dropped, 1);
});

test('aggregate reports hasCohorts=false for a judge that labels no cohort', () => {
    // judge-28 (cases.json) carries tags, not cohorts. Without this flag the
    // cohortOf fallback would put every query in `control` and print a gap row of
    // 0/0 that reads like a real measurement.
    const judge = { granularity: 'chunk', queries: { r1: {}, p1: {}, f1: {} } };
    const records = ['r1', 'p1', 'f1'].map(q => ({ query_id: q, fusion: { in_top80: true, in_rerank_window: true }, final: { final_rank: 1 } }));
    const ranks = new Map(records.map(r => [r.query_id, { rank: 1 }]));
    const agg = aggregate(records, ranks, judge);
    assert.equal(agg.hasCohorts, false);
    assert.equal(agg.all.n, 3);
    assert.equal(agg.gap.n, 0, 'no query is labelled gap, so the gap row is empty and must not be read as a score');
    assert.equal(agg.control.n, 3, 'the cohortOf fallback parks everything in control, which is why the flag exists');

    // And a judge that does label cohorts reports so.
    const labelled = { granularity: 'chunk', queries: { r1: { cohort: 'gap' }, p1: { cohort: 'control' } } };
    assert.equal(aggregate(records.slice(0, 2), new Map([['r1', { rank: 1 }], ['p1', { rank: 1 }]]), labelled).hasCohorts, true);
});

test('legacyAggregate reads only final.final_rank and can disagree with the new scorer', () => {
    // The whole point of separating the blocks: the same log can yield different
    // numbers depending on which oracle is applied, and neither is wrong.
    const judge = { granularity: 'chunk', queries: { a: { cohort: 'gap' }, b: { cohort: 'gap' } } };
    const records = [
        { query_id: 'a', fusion: {}, final: { final_rank: 1 } },
        { query_id: 'b', fusion: {}, final: { final_rank: null } },
    ];
    const leg = legacyAggregate(records, judge);
    assert.equal(leg.all.hit1, '1/2');
    assert.equal(leg.all.recorded, 1, 'only one query carried a final_rank');

    // The new scorer resolves targets instead, and finds b at rank 3.
    const ranks = new Map([['a', { rank: 1 }], ['b', { rank: 3 }]]);
    const agg = aggregate(records, ranks, judge);
    assert.equal(agg.all.hit1, '1/2');
    assert.equal(agg.all.hit10, '2/2', 'the new scorer resolves b; the legacy field recorded null for it');

    // legacyAggregate must ignore anything that is not final_rank.
    assert.equal(legacyAggregate([{ query_id: 'a', fusion: {}, final: {} }], judge).all.recorded, 0);
    assert.equal(legacyAggregate([{ query_id: 'a', fusion: {}, strictRank: 1 }], judge).all.recorded, 0);
});

test('the CLI prints a labelled legacy block only with --legacy, and never mixes it with a new-scorer column', () => {
    const argv = ['--log', path.join(RQ, 'baseline', 'harness-log.json'), '--judge', V1, '--strict'];
    const plain = run(argv);
    assert.equal(plain.code, 0);
    assert.doesNotMatch(plain.out, /LEGACY REPLAY/, 'the legacy block must be opt-in, not part of the default scorecard');
    assert.doesNotMatch(plain.out, /legacy Hit@/);

    const withLegacy = run([...argv, '--legacy']);
    assert.equal(withLegacy.code, 0);
    assert.match(withLegacy.out, /# {2}LEGACY REPLAY -- NOT REPRODUCIBLE, NOT COMPARABLE/);
    assert.match(withLegacy.out, /Do not sum, average, or quote these next to a new-scorer/);
    assert.match(withLegacy.out, /\| cohort \| n \| legacy Hit@1 \| legacy Hit@5 \| legacy Hit@10 \| legacy MRR \| final_rank recorded \|/);

    // The legacy table's columns are named differently from the scorecard's, so
    // the two cannot be read as one table even if a reader glances at both.
    assert.match(withLegacy.out, /\| cohort \| n \| unanswerable \| Hit@1 \|/);
    const legacyHeaderLine = withLegacy.out.split('\n').find(l => l.includes('legacy Hit@1'));
    const scorecardHeaderLine = withLegacy.out.split('\n').find(l => l.includes('| Hit@1 |'));
    assert.notEqual(legacyHeaderLine, scorecardHeaderLine);
});

test('the CLI prints answerable-only denominators as their own table', () => {
    const r = run(['--log', path.join(RQ, 'baseline', 'harness-log.json'), '--judge', V1, '--strict']);
    assert.equal(r.code, 0);
    assert.match(r.out, /--- answerable-only denominators \(same numerators; unanswerable queries removed from the denominator\) ---/);
    assert.match(r.out, /\| cohort \| n answerable \| dropped as unanswerable \| Hit@1 \|/);
    assert.match(r.out, /^\| all \| 41 \| 5 \| 5\/41 \| 11\/41 \| 16\/41 \|/m);
    assert.match(r.out, /Hit@k and MRR are NOT comparable between the two tables when dropped > 0/);
});

// ---------------------------------------------------------------- 5. corrected denominators (D14)

test('answerableCorrected honors the unanswerableQueries map without touching the flag logic', () => {
    // A query the map lists but the flag misses stays in `answerable` (n=40
    // as-run behaviour) and leaves only in `answerableCorrected` (n=39). The
    // numerators must be identical: only denominators move.
    const judge = {
        granularity: 'chunk',
        unanswerableQueries: { b: { reason: 'map-listed without a flag' } },
        queries: {
            a: { cohort: 'gap' },
            b: { cohort: 'gap' },
            c: { cohort: 'gap' },
            d: { cohort: 'control', unanswerable: true },
            e: { cohort: 'control' },
        },
    };
    // b mirrors fresh_f6 in the frozen judge-v2: map-listed, flag missing, and
    // never retrieved (rank null, outside the pool), so it contributes no
    // numerator anywhere.
    const rec = (qid, rank, inPool = true) => ({ query_id: qid, fusion: { in_top80: inPool, in_rerank_window: inPool }, final: { final_rank: rank } });
    const records = [rec('a', 1), rec('b', null, false), rec('c', 2), rec('d', 3), rec('e', null)];
    const ranks = new Map([['a', { rank: 1 }], ['b', { rank: null }], ['c', { rank: 2 }], ['d', { rank: 3 }], ['e', { rank: null }]]);
    const agg = aggregate(records, ranks, judge);

    // The flag-based table is unchanged by the map: b still counts there.
    assert.equal(agg.answerable.all.n, 4);
    assert.equal(agg.answerable.all.hit1, '1/4');

    // The corrected table drops b as well. Every numerator count is unchanged;
    // only the denominator moves (4 -> 3). MRR is a mean, so its value moves
    // (0.375 -> 0.5) while its numerator, the reciprocal sum 1.5, does not.
    assert.equal(agg.answerableCorrected.all.n, 3);
    assert.equal(agg.answerableCorrected.all.dropped, 2);
    assert.equal(agg.answerableCorrected.all.hit1, '1/3');
    assert.equal(agg.answerableCorrected.all.mrr, 0.5);
    for (const k of ['h1', 'h5', 'h10', 'r64', 'r80']) {
        assert.equal(agg.answerableCorrected.all.counts[k], agg.answerable.all.counts[k], `numerator ${k} must not move`);
    }
    assert.equal(agg.answerableCorrected.gap.n, 2);
    assert.equal(agg.answerableCorrected.control.n, 1);
});

test('on the committed c0 log the corrected table is n=39 with identical numerators', () => {
    // judge-v2 is frozen: fresh_f6 is map-listed without a flag, so the flag
    // table reads n=40 and the corrected table n=39. If the judge file is ever
    // reconciled, this test names the query that must move tables.
    const log = readLog('denominators');
    const hits = readHits('denominators');
    const ranks = ranksUnder(judgeV2, log, { mode: 'lenient', hits, scoreQuery });
    const agg = aggregate([...log.values()], ranks, judgeV2);

    assert.equal(agg.answerable.all.n, 40);
    assert.equal(agg.answerableCorrected.all.n, 39);
    assert.equal(agg.answerableCorrected.all.dropped, agg.answerable.all.dropped + 1);
    for (const k of ['h1', 'h5', 'h10', 'r64', 'r80']) {
        assert.equal(agg.answerableCorrected.all.counts[k], agg.answerable.all.counts[k], `numerator ${k} must not move`);
    }
    assert.equal(agg.answerableCorrected.gap.n, 17);
    assert.equal(agg.answerableCorrected.control.n, 22);
    assert.ok(Object.hasOwn(judgeV2.unanswerableQueries, 'fresh_f6'), 'fresh_f6 must still be map-listed in the untouched judge file');
    assert.notEqual(judgeV2.queries.fresh_f6.unanswerable, true, 'fresh_f6 must still lack the flag in the untouched judge file');
});

test('the CLI prints the corrected table, identical to answerable when the judge has no map', () => {
    const c0 = run([
        '--log', path.join(RQ, 'denominators', 'harness-log.json'),
        '--judge', V2, '--lenient',
        '--result', path.join(RQ, 'denominators', 'result.json'),
    ]);
    assert.equal(c0.code, 0);
    assert.match(c0.out, /--- corrected answerable-only denominators \(additionally honoring the judge unanswerableQueries map; judge file untouched\) ---/);
    assert.match(c0.out, /map-listed unanswerable queries under this judge: 7/);
    assert.match(c0.out, /\| cohort \| n corrected \| dropped \(flag\+map\) \| Hit@1 \|/);
    assert.match(c0.out, /^\| all \| 39 \| 7 \| 2\/39 \| 7\/39 \| 12\/39 \|/m);

    // judge-28 carries no unanswerableQueries map, so the corrected table must
    // repeat the answerable table exactly: same denominators, same numerators.
    const g0 = run([
        '--log', path.join(RQ, 'guard', 'harness-log.json'),
        '--judge', path.join(RQ, 'judge-28.json'), '--lenient',
    ]);
    assert.equal(g0.code, 0);
    assert.match(g0.out, /map-listed unanswerable queries under this judge: 0/);
    assert.match(g0.out, /^\| all \| 28 \| 0 \| 11\/28 \| 19\/28 \| 22\/28 \| 0\.508 \| 24\/28 \| 22\/28 \|/m);
});

test('paired regressions omit map-listed unanswerable queries', () => {
    const judge = { queries: { missing: {} }, unanswerableQueries: { missing: { reason: 'no indexed target' } } };
    const current = asMap([{ query_id: 'missing', fusion: { in_top80: false } }]);
    const baseline = asMap([{ query_id: 'missing', fusion: { in_top80: true } }]);
    const ranks = new Map([['missing', { rank: 1 }]]);
    assert.deepEqual(diffAgainst(current, baseline, judge, ranks, ranks), { rows: [], regressions: [] });
});
