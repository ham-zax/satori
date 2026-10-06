import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
    buildFusedPoolEntries,
    buildQueryHarnessRecord,
    computeCohortAggregates,
    computeSummaryReport,
    generateHarnessSummaryMarkdown,
    isDistractorPath,
    resolveRepoTargetChunkIds,
    setDistractorPathClassifier,
    sha256String,
} from './harness-logger.mjs';

// The harness must classify non-production paths exactly as production does, so
// it never keeps its own copy. This test injects the production predicate the
// same way run.mjs does, from the built dist.
const distUrl = new URL('../../packages/mcp/dist/core/search-non-production-path.js', import.meta.url);
const { isNonProductionDistractor: productionClassifier } = await import(distUrl.href);
setDistractorPathClassifier(productionClassifier);

const PROVENANCE = {
    gitSha: 'a'.repeat(40),
    dirtyTreeHash: sha256String('diff --git a/x b/x\n'),
    dirtyTreeUntrackedPaths: [],
    resolvedFlags: {
        compound_join: true,
        path_demotion: true,
        dealias: false,
        focus_cue_wide: false,
        prf: false,
        rerank_blend: true,
    },
    reservation: { enabled: true, cap: 55 },
    altTermsCap: 4,
    judgeFileSha256: sha256String('{"cases":[]}'),
    altTermsFileSha256: sha256String('{"r1":{"alt_terms":["destroy"]}}'),
    altTermsModel: 'claude-sonnet',
};

const QUERY = {
    id: 'r1',
    query: 'where does react run the cleanup function',
    acceptable: [{ pathRegex: 'ReactFiberCommitWork', symbolRegex: 'commitHook', evidence: 'x:10' }],
};

/** A response whose expanded pass ran and emitted terms. */
function responseWithExpansion() {
    return {
        hints: {
            debugSearch: {
                semanticExpansion: {
                    expand: true,
                    attempted: true,
                    reason: 'caller_alt_terms',
                    termsEmitted: ['destroy', 'unmount', 'teardown', 'dispose'],
                    termsDropped: ['release', 'free'],
                },
                candidateSurvival: {
                    stages: [
                        {
                            stage: 'mcp_fusion',
                            candidates: [
                                { candidateId: 'a', relativePath: 'src/a.ts', rank: 1, score: 0.9 },
                                { candidateId: 'b', relativePath: 'src/__tests__/a.test.ts', rank: 2, score: 0.8 },
                            ],
                        },
                    ],
                    // No lexicalRequests: the tracked-lexical debug lane did not run.
                },
                phaseTimingsMs: { semanticSearch: 12, expandedSearch: 7, mcpFusion: 3, rerank: 4 },
            },
        },
    };
}

function build(overrides = {}) {
    return buildQueryHarnessRecord({
        query: QUERY,
        repoName: 'react',
        commit: 'deadbeef',
        response: responseWithExpansion(),
        elapsedMs: 26.4,
        scoreResult: { rank: 1, matched: true },
        targetChunkIds: new Set(),
        flags: PROVENANCE.resolvedFlags,
        workspaceHead: 'a'.repeat(40),
        provenance: PROVENANCE,
        ...overrides,
    });
}

test('every provenance field is present on a record', () => {
    const record = build();
    assert.deepEqual(record.provenance, PROVENANCE);
    assert.equal(record.provenance.gitSha.length, 40);
    assert.match(record.provenance.dirtyTreeHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(record.provenance.resolvedFlags, {
        compound_join: true,
        path_demotion: true,
        dealias: false,
        focus_cue_wide: false,
        prf: false,
        rerank_blend: true,
    });
    assert.deepEqual(record.provenance.reservation, { enabled: true, cap: 55 });
    assert.equal(record.provenance.altTermsCap, 4);
    assert.match(record.provenance.judgeFileSha256, /^[0-9a-f]{64}$/);
    assert.match(record.provenance.altTermsFileSha256, /^[0-9a-f]{64}$/);
    assert.equal(record.provenance.altTermsModel, 'claude-sonnet');
});

test('latency reports aggregate retrieval and leaves unmeasured phases unavailable', () => {
    const response = responseWithExpansion();
    response.hints.debugSearch.phaseTimingsMs = { semanticSearch: 19.6, rerank: 4.4 };
    const record = build({ response });
    assert.deepEqual(record.latency, {
        retrievalMs: 20,
        primaryPassMs: null,
        expandedPassMs: null,
        fusionMs: null,
        rerankMs: 4,
        totalElapsedMs: 26,
    });
});

test('missing phase timings are unavailable while measured zero remains zero', () => {
    const response = responseWithExpansion();
    delete response.hints.debugSearch.phaseTimingsMs;
    const missing = build({ response });
    assert.equal(missing.latency.retrievalMs, null);
    assert.equal(missing.latency.rerankMs, null);
    response.hints.debugSearch.phaseTimingsMs = { semanticSearch: 0, rerank: 0 };
    const measured = build({ response });
    assert.equal(measured.latency.retrievalMs, 0);
    assert.equal(measured.latency.rerankMs, 0);
    assert.equal(measured.latency.primaryPassMs, null);
});

test('the record config carries the resolved flags and the alt_terms cap', () => {
    const record = build();
    assert.deepEqual(record.config.flags, PROVENANCE.resolvedFlags);
    assert.equal(record.config.altTermsCap, 4);
    // A record built from the RESOLVED set must not understate the run: the
    // default-on flags are on even though they were never passed.
    assert.equal(record.config.flags.compound_join, true);
    assert.equal(record.config.flags.path_demotion, true);
});

test('the terms actually sent on the expanded pass are recorded', () => {
    const record = build();
    assert.equal(record.expansion_trace.expansionAttempted, true);
    assert.equal(record.expansion_trace.expansionPassRan, true);
    // This is the empty-trace bug: the lexical debug lane did not run, so the
    // record previously showed no terms at all despite an expansion pass.
    assert.deepEqual(
        record.expansion_trace.termsEmitted,
        ['destroy', 'unmount', 'teardown', 'dispose'],
    );
    assert.equal(
        record.expansion_trace.expandedQueryString,
        'destroy unmount teardown dispose',
    );
    assert.deepEqual(record.expansion_trace.termsDropped, ['release', 'free']);
});

test('the lexical-request terms win when the debug lane did run', () => {
    const response = responseWithExpansion();
    response.hints.debugSearch.candidateSurvival.lexicalRequests = [
        { passId: 'expanded/lexical', terms: ['from', 'the', 'lane'] },
    ];
    const record = build({ response });
    assert.deepEqual(record.expansion_trace.termsEmitted, ['from', 'the', 'lane']);
    assert.equal(record.expansion_trace.expandedQueryString, 'from the lane');
});

test('a run with no expansion pass records no terms', () => {
    const response = responseWithExpansion();
    delete response.hints.debugSearch.semanticExpansion;
    response.hints.debugSearch.semanticExpansion = { expand: false, attempted: false, reason: 'primary_candidate_pool_sufficient' };
    const record = build({ response });
    assert.equal(record.expansion_trace.expansionAttempted, false);
    assert.equal(record.expansion_trace.expansionPassRan, false);
    assert.deepEqual(record.expansion_trace.termsEmitted, []);
    assert.equal(record.expansion_trace.expandedQueryString, '');
});

test('the injected production classifier drives distractor share', () => {
    const record = build();
    // The fusion stage holds one production path and one __tests__ path.
    assert.equal(record.lanes.dense_primary.distractorShareTop10, 0);
    // The harness delegates to the production predicate, so these two answers
    // come from packages/mcp, not from this module.
    assert.equal(isDistractorPath('src/a.ts'), false);
    assert.equal(isDistractorPath('src/__tests__/a.test.ts'), true);
});

test('the summary markdown surfaces the provenance', () => {
    const records = [build()];
    const markdown = generateHarnessSummaryMarkdown(records, computeSummaryReport(records));
    for (const needle of [
        '## Provenance',
        PROVENANCE.gitSha,
        PROVENANCE.dirtyTreeHash,
        'cap `55`',
        '`4`',
        PROVENANCE.judgeFileSha256,
        PROVENANCE.altTermsFileSha256,
        'claude-sonnet',
        'rerank_blend',
    ]) {
        assert.ok(markdown.includes(needle), `summary must mention ${needle}`);
    }
});

test('aggregates still work over a record carrying provenance', () => {
    const records = [build()];
    const aggregates = computeCohortAggregates(records);
    assert.equal(aggregates.count, 1);
    assert.equal(aggregates.hit1, 1);
    const report = computeSummaryReport(records, null);
    assert.equal(report.regressionsCount, 0);
    assert.ok(report.aggregates.cohorts.all);
});

test('a record built without provenance still reads, with provenance null', () => {
    // Historical harness-log.json files have no provenance field, and the
    // aggregators must keep working over them.
    const record = build({ provenance: null });
    assert.equal(record.provenance, null);
    assert.equal(record.config.altTermsCap, null);
    const records = [record];
    assert.equal(computeCohortAggregates(records).count, 1);
    const markdown = generateHarnessSummaryMarkdown(records, computeSummaryReport(records));
    assert.ok(markdown.includes('# '));
    assert.equal(markdown.includes('## Provenance'), false);
});

test('historical records without a provenance field are still summarized', () => {
    // A record shaped like the pre-A7 output: no provenance, no altTermsCap,
    // no expansionAttempted.
    const historical = {
        query_id: 'r1',
        repo: 'react',
        commit: 'deadbeef',
        query_text: 'q',
        variant: 'original',
        split: 'tune',
        cohort: 'gap',
        token_overlap: 2,
        targets: [],
        config: {
            workspaceHead: 'a'.repeat(40),
            flags: { synonyms: false, compound_join: true, dealias: false, path_demotion: true, prf: false },
        },
        expansion_trace: { termsEmitted: [], expandedQueryString: '' },
        lanes: {
            dense_primary: { targetRank: 3, score: 0.5, distractorShareTop10: 0.1 },
            lexical_primary: { targetRank: null, score: null, distractorShareTop10: 0 },
            dense_expanded: { targetRank: null, score: null, distractorShareTop10: 0 },
            lexical_expanded: { targetRank: null, score: null, distractorShareTop10: 0 },
        },
        fusion: { fused_rank: 3, in_top80: true, in_rerank_window: true },
        final: { final_rank: 3, matchedTarget: true },
        latency: { primaryPassMs: 1, expandedPassMs: 0, fusionMs: 0, rerankMs: 0, totalElapsedMs: 5 },
    };
    const records = [historical];
    const report = computeSummaryReport(records, null);
    assert.equal(report.aggregates.cohorts.all.count, 1);
    assert.equal(report.aggregates.cohorts.all.counts.fused80, 1);
    assert.equal(report.aggregates.cohorts.all.hit5, 1);
    const markdown = generateHarnessSummaryMarkdown(records, report);
    assert.ok(markdown.includes('r1'));
    // The historical record has no provenance, so no provenance section.
    assert.equal(markdown.includes('## Provenance'), false);
});

// ---------------------------------------------------------------------------
// Target resolution.
//
// The distinction these tests pin down is between a query that cannot be
// answered against this index (the judge's acceptable entries match nothing)
// and an infrastructure failure (the index cannot be read at all). The first is
// a property of the judge and must not destroy every other query's result; the
// second means the run's numbers are meaningless and must still abort.
// ---------------------------------------------------------------------------

const lancedb = await import(pathToFileURL(
    path.resolve('packages/core/node_modules/@lancedb/lancedb/dist/index.js'),
).href);

const REPO_DIR = '/tmp/satori-harness-test-repo';

/**
 * A published index holding two chunks for REPO_DIR: one whose symbol label the
 * `fresh_r1` judge target names, and one it does not.
 */
async function makeIndexWithRows() {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-harness-index-'));
    const db = await lancedb.connect(path.join(stateRoot, 'vector', 'lancedb'));
    await db.createTable('chunks', [
        {
            id: 'chunk-a',
            relativePath: 'src/found.ts',
            startLine: 1,
            endLine: 40,
            metadataJson: JSON.stringify({ codebasePath: REPO_DIR, symbolLabel: 'function foundSymbol' }),
        },
        {
            id: 'chunk-b',
            relativePath: 'src/other.ts',
            startLine: 1,
            endLine: 40,
            metadataJson: JSON.stringify({ codebasePath: REPO_DIR, symbolLabel: 'function otherSymbol' }),
        },
    ], { mode: 'create' });
    return stateRoot;
}

function captureWarnings(fn) {
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => { lines.push(args.join(' ')); };
    return fn().finally(() => { console.warn = original; }).then(
        value => ({ value, warnings: lines }),
        error => ({ error, warnings: lines }),
    );
}

test('a judge target that matches zero rows is unanswerable, not fatal', async (t) => {
    const stateRoot = await makeIndexWithRows();
    t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));

    const queries = [
        {
            id: 'fresh_r1',
            acceptable: [{ pathRegex: 'src/found\\.ts$', symbolRegex: 'foundSymbol' }],
        },
        {
            // Acceptable path is well-formed but matches no indexed row.
            id: 'fresh_r5',
            acceptable: [{ pathRegex: 'src/ReactFiberCommitWork\\.new\\.js$', symbolRegex: 'commitHookEffectListUnmount' }],
        },
    ];

    const { value: targetMap, error, warnings } = await captureWarnings(
        () => resolveRepoTargetChunkIds(stateRoot, REPO_DIR, queries),
    );
    assert.equal(error, undefined, 'a zero-chunk target must not abort the run');

    // Both queries are still present: the answerable one resolved, the
    // unanswerable one is recorded with an empty target set.
    assert.deepEqual([...targetMap.keys()].sort(), ['fresh_r1', 'fresh_r5']);
    assert.deepEqual([...targetMap.get('fresh_r1')], ['chunk-a']);
    assert.equal(targetMap.get('fresh_r5').size, 0);

    // The failure is reported loudly, naming the query, so it cannot pass unnoticed.
    const warned = warnings.filter(l => l.includes('[harness] WARNING:'));
    assert.equal(warned.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
    assert.ok(warned[0].includes('fresh_r5'), 'the warning must name the unanswerable query');
    assert.ok(!warned[0].includes('fresh_r1 '), 'the answerable query must not be named as unanswerable');
});

test('target resolution still fails hard when the index cannot be read', async (t) => {
    // A file where the database directory belongs: the run's numbers would be
    // meaningless, so this must still abort rather than report every query a miss.
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-harness-broken-'));
    t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(stateRoot, 'vector'), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'vector', 'lancedb'), 'not a database');

    await assert.rejects(
        () => resolveRepoTargetChunkIds(stateRoot, REPO_DIR, [{ id: 'q1', acceptable: [] }]),
        /harness target resolution failed: cannot open the vector index/,
    );
});

test('target resolution still fails hard when no index table covers the repo', async (t) => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-harness-empty-'));
    t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
    await lancedb.connect(path.join(stateRoot, 'vector', 'lancedb'));

    await assert.rejects(
        () => resolveRepoTargetChunkIds(stateRoot, REPO_DIR, [{ id: 'q1', acceptable: [] }]),
        /no published index table for/,
    );
});

/** A full debug response with fusion, per-pass, grouped, and rerank stages. */
function responseWithFusedPool() {
    const fusion = [
        { candidateId: 'c1', relativePath: 'src/a.ts', startLine: 1, endLine: 10, rank: 1, score: 0.9 },
        { candidateId: 'c2', relativePath: 'src/b.ts', startLine: 20, endLine: 30, rank: 2, score: 0.8 },
        { candidateId: 'c3', relativePath: 'src/c.ts', startLine: 5, endLine: 9, rank: 3, score: 0.7 },
    ];
    return {
        hints: {
            debugSearch: {
                candidateSurvival: {
                    stages: [
                        {
                            stage: 'mcp_pass', passId: 'attempt:1/primary',
                            candidates: [fusion[0], fusion[2]].map(c => ({ ...c })),
                        },
                        {
                            stage: 'mcp_pass', passId: 'attempt:1/expanded',
                            candidates: [fusion[1], fusion[2]].map(c => ({ ...c })),
                        },
                        { stage: 'mcp_fusion', passId: 'attempt:1', candidates: fusion.map(c => ({ ...c })) },
                        {
                            stage: 'grouped',
                            candidates: [
                                { candidateId: 'c1', relativePath: 'src/a.ts', startLine: 1, endLine: 10, rank: 1, groupReplay: { displayLabel: 'function alfa()' } },
                                { candidateId: 'c2', relativePath: 'src/b.ts', startLine: 20, endLine: 30, rank: 2, groupReplay: { displayLabel: 'file src/b.ts:1' } },
                                { candidateId: 'c3', relativePath: 'src/c.ts', startLine: 5, endLine: 9, rank: 3 },
                            ],
                        },
                        {
                            stage: 'reranker_input',
                            candidates: [fusion[0], fusion[1]].map(c => ({ ...c })),
                        },
                    ],
                },
            },
        },
    };
}

test('the fused pool carries rank, key, pass tags, score, and rerank membership', () => {
    const entries = buildFusedPoolEntries(responseWithFusedPool(), 'q1');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0].retrievalPasses, ['primary']);
    assert.deepEqual(entries[1].retrievalPasses, ['expanded']);
    assert.deepEqual(entries[2].retrievalPasses, ['primary', 'expanded']);
    assert.equal(entries[0].key, 'src/a.ts|function alfa()|1-10');
    // File-level groups carry no symbol.
    assert.equal(entries[1].key, 'src/b.ts||20-30');
    // No grouped entry: the symbol is empty but the span still keys the chunk.
    assert.equal(entries[2].key, 'src/c.ts||5-9');
    assert.equal(entries[0].fusedScore, 0.9);
    assert.equal(entries[0].in_rerank_window, true);
    assert.equal(entries[1].in_rerank_window, true);
    assert.equal(entries[2].in_rerank_window, false);
});

test('the fused pool fails loudly when the fusion stage is absent', () => {
    assert.throws(
        () => buildFusedPoolEntries({ hints: { debugSearch: { candidateSurvival: { stages: [] } } } }, 'q9'),
        /fused pool unavailable for q9: mcp_fusion stage is absent/,
    );
    assert.throws(
        () => buildFusedPoolEntries({ hints: {} }, 'q9'),
        /fused pool unavailable for q9/,
    );
});

test('the fused pool is capped at the top 80', () => {
    const response = responseWithFusedPool();
    const fusion = response.hints.debugSearch.candidateSurvival.stages.find(s => s.stage === 'mcp_fusion');
    fusion.candidates = Array.from({ length: 85 }, (_, i) => ({
        candidateId: `c${i}`, relativePath: 'src/a.ts', startLine: i, endLine: i + 1, rank: i + 1, score: 1 / (i + 1),
    }));
    const entries = buildFusedPoolEntries(response, 'q1');
    assert.equal(entries.length, 80);
    assert.equal(entries[79].rank, 80);
});

test('the rerank window is false without a reranker_input stage (no rank fallback)', () => {
    const response = responseWithFusedPool();
    response.hints.debugSearch.candidateSurvival.stages =
        response.hints.debugSearch.candidateSurvival.stages.filter(s => s.stage !== 'reranker_input');
    const fusion = response.hints.debugSearch.candidateSurvival.stages.find(s => s.stage === 'mcp_fusion');
    fusion.candidates = Array.from({ length: 70 }, (_, i) => ({
        candidateId: `c${i}`, relativePath: 'src/a.ts', startLine: i, endLine: i + 1, rank: i + 1, score: 1 / (i + 1),
    }));
    const entries = buildFusedPoolEntries(response, 'q1');
    // A fused rank <= 64 is not admission: without a reranker_input stage no
    // candidate was actually admitted, so every entry must read false. The
    // previous oracle asserted 64 trues here, which recorded unobserved
    // reranker membership as fact.
    assert.equal(entries.filter(e => e.in_rerank_window).length, 0);
});

/** A debug response whose fusion target has a known candidateId and rank. */
function responseWithTargetInFusion({ fusedRank = 1, rerankIds = null, fusedId = 'target-1' }) {
    const target = { candidateId: fusedId, relativePath: 'src/ReactFiberCommitWork.js', startLine: 8, endLine: 12, rank: fusedRank, score: 0.9 };
    const stages = [{ stage: 'mcp_fusion', candidates: [{ ...target }] }];
    if (rerankIds !== null) {
        stages.push({
            stage: 'reranker_input',
            // A non-target id must not match via the path/evidence fallback
            // either; otherwise the "omitted" case would still match.
            candidates: rerankIds.map((id, i) => (id === fusedId
                ? { candidateId: id, relativePath: 'src/ReactFiberCommitWork.js', startLine: 8, endLine: 12, rank: i + 1, score: 0.8 }
                : { candidateId: id, relativePath: 'src/unrelated-other.ts', startLine: 100, endLine: 110, rank: i + 1, score: 0.8 })),
        });
    }
    return { hints: { debugSearch: { candidateSurvival: { stages }, phaseTimingsMs: {} } } };
}

test('in_rerank_window measures actual reranker_input admission, never fused rank', () => {
    const ids = new Set(['target-1']);
    const absent = build({ response: responseWithTargetInFusion({ fusedRank: 1, rerankIds: null }), targetChunkIds: ids });
    assert.equal(absent.fusion.fused_rank, 1);
    assert.equal(absent.fusion.in_rerank_window, false);
    const empty = build({ response: responseWithTargetInFusion({ fusedRank: 1, rerankIds: [] }), targetChunkIds: ids });
    assert.equal(empty.fusion.in_rerank_window, false);
    const omitted = build({ response: responseWithTargetInFusion({ fusedRank: 1, rerankIds: ['other-1'] }), targetChunkIds: ids });
    assert.equal(omitted.fusion.in_rerank_window, false);
    const admitted = build({ response: responseWithTargetInFusion({ fusedRank: 1, rerankIds: ['target-1'] }), targetChunkIds: ids });
    assert.equal(admitted.fusion.in_rerank_window, true);
});

test('in_rerank_window is true for an admitted target beyond fused rank 64', () => {
    const record = build({ response: responseWithTargetInFusion({ fusedRank: 70, rerankIds: ['target-1'] }), targetChunkIds: new Set(['target-1']) });
    assert.equal(record.fusion.fused_rank, 70);
    assert.equal(record.fusion.in_rerank_window, true);
});

test('the fused-pool sidecar measures actual reranker_input admission', () => {
    // Omitted at fused rank 1: false even though the rank is within 64.
    const omittedStages = [
        { stage: 'mcp_fusion', candidates: [{ candidateId: 'target-1', relativePath: 'src/a.ts', startLine: 1, endLine: 2, rank: 1, score: 0.9 }] },
        { stage: 'reranker_input', candidates: [{ candidateId: 'other-1', relativePath: 'src/a.ts', startLine: 3, endLine: 4, rank: 1, score: 0.8 }] },
    ];
    const omitted = buildFusedPoolEntries({ hints: { debugSearch: { candidateSurvival: { stages: omittedStages } } } }, 'q1');
    assert.equal(omitted[0].in_rerank_window, false);
    // Admitted at fused rank 70: true despite the rank exceeding 64.
    const admittedStages = [
        { stage: 'mcp_fusion', candidates: [{ candidateId: 'target-1', relativePath: 'src/a.ts', startLine: 1, endLine: 2, rank: 70, score: 0.1 }] },
        { stage: 'reranker_input', candidates: [{ candidateId: 'target-1', relativePath: 'src/a.ts', startLine: 1, endLine: 2, rank: 5, score: 0.8 }] },
    ];
    const admitted = buildFusedPoolEntries({ hints: { debugSearch: { candidateSurvival: { stages: admittedStages } } } }, 'q1');
    assert.equal(admitted[0].in_rerank_window, true);
});

test('the record and fused-pool sidecar agree on rerank membership', () => {
    const ids = new Set(['target-1']);
    const cases = [
        { fusedRank: 1, rerankIds: ['other-1'] },
        { fusedRank: 1, rerankIds: ['target-1'] },
        { fusedRank: 70, rerankIds: ['target-1'] },
    ];
    for (const { fusedRank, rerankIds } of cases) {
        const response = responseWithTargetInFusion({ fusedRank, rerankIds });
        const record = build({ response, targetChunkIds: ids });
        const entries = buildFusedPoolEntries(response, 'q1');
        const entry = entries.find(e => e.rank === fusedRank);
        assert.equal(entry.in_rerank_window, record.fusion.in_rerank_window);
    }
});

test('stage ranks follow the expected owner through every recorded stage', () => {
    const response = responseWithExpansion();
    const target = { candidateId: 't', relativePath: 'src/t.ts' };
    const other = { candidateId: 'o', relativePath: 'src/o.ts' };
    response.hints.debugSearch.candidateSurvival.stages = [
        { stage: 'raw_dense', passId: 'attempt:1/primary', candidates: [{ ...other, rank: 1 }, { ...target, rank: 2 }] },
        { stage: 'mcp_pass', passId: 'attempt:1/symbol_metadata_bm25', candidates: [{ ...target, rank: 1 }] },
        { stage: 'reranker_input', candidates: [{ ...other, rank: 1 }, { ...target, rank: 2 }] },
        { stage: 'reranker_output', candidates: [{ ...other, rank: 1 }] },
        { stage: 'disclosed' },
    ];
    const record = build({ response, targetChunkIds: new Set(['t']) });
    assert.deepEqual(record.stage_ranks, [
        { stage: 'raw_dense', passId: 'attempt:1/primary', rank: 2, recorded: 2 },
        { stage: 'mcp_pass', passId: 'attempt:1/symbol_metadata_bm25', rank: 1, recorded: 1 },
        { stage: 'reranker_input', passId: null, rank: 2, recorded: 2 },
        { stage: 'reranker_output', passId: null, rank: null, recorded: 1 },
        { stage: 'disclosed', passId: null, rank: null, recorded: 0 },
    ]);
});
