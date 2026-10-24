import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    agrees,
    askOne,
    main as judgeMain,
    question,
    readVerdict,
} from './jev-dual-judge.mjs';
import {
    loadCases,
    resolveGranularity,
} from './result-triage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JUDGE = path.join(HERE, 'jev-dual-judge.mjs');
const TRIAGE = path.join(HERE, 'result-triage.mjs');

async function tempDir(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'satori-jev-workflow-'));
    t.after(async () => {
        await rm(directory, { recursive: true, force: true });
    });
    return directory;
}

function mockFetch(t, implementation) {
    const original = globalThis.fetch;
    globalThis.fetch = implementation;
    t.after(() => {
        globalThis.fetch = original;
    });
}

async function writeJson(file, value) {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runNode(args, env = process.env) {
    return spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env,
        timeout: 10_000,
    });
}

function withoutApiKeys() {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    delete env.JEV_API_KEY;
    return env;
}

test('question builds a granularity-specific rubric and preserves test/doc intent', () => {
    const pathRubric = question('where are the tests for useEffect', 'path');
    assert.match(pathRubric.instructions, /`path` granularity/);
    assert.match(pathRubric.criteria.answers.what, /Names the file that owns/);
    assert.doesNotMatch(pathRubric.criteria.answers.what, /function, class, or symbol/);
    assert.match(pathRubric.criteria.answers.not_for, /unless the question itself asks/);
    assert.match(pathRubric.criteria.partial.what, /does not name the file that owns/);

    const symbolRubric = question('where is the owner', 'symbol');
    assert.match(symbolRubric.instructions, /`symbol` granularity/);
    assert.match(symbolRubric.criteria.answers.what, /function, class, or symbol/);
    assert.match(symbolRubric.criteria.partial.what, /does not name the symbol/);

    assert.throws(() => question('q', 'file'), /known granularity/);
    assert.throws(() => question('q', undefined), /known granularity/);
});

test('readVerdict accepts documented bare and nested shapes and rejects invalid choices', () => {
    const probabilities = { answers: 0.9, partial: 0.06, unrelated: 0.04 };
    assert.deepEqual(
        readVerdict({ choice: 'answers', confidence: 0.9, probabilities }),
        { choice: 'answers', confidence: 0.9, probabilities },
    );
    assert.equal(
        readVerdict({ answers: { evidence: { choice: 'partial', confidence: 0.4 } } }).choice,
        'partial',
    );
    assert.equal(
        readVerdict({ questions: { evidence: { choice: 'unrelated' } } }).choice,
        'unrelated',
    );
    assert.equal(
        readVerdict({ results: [{ choice: 'answers', confidence: 1 }] }).choice,
        'answers',
    );
    assert.equal(
        readVerdict({ answers: { evidence: { selected: 'partial' } } }).choice,
        'partial',
    );

    assert.equal(readVerdict({ answers: { evidence: { choice: 'maybe' } } }), null);
    assert.equal(readVerdict({ answers: { evidence: { choice: 'accepted' } } }), null);
    assert.equal(readVerdict({ answers: { evidence: { confidence: 0.9 } } }), null);
    assert.equal(
        readVerdict({ answers: { evidence: { confidence: 0.9 } }, choice: 'answers' }),
        null,
    );
    assert.equal(readVerdict({ usage: { input_tokens: 12 } }), null);
    assert.equal(readVerdict(null), null);
});

test('agrees supports partial as a third explicit outcome and keeps reject semantics', () => {
    assert.equal(agrees('answers', 'answers'), true);
    assert.equal(agrees('accept', 'answers'), true);
    assert.equal(agrees('accepted', 'answers'), true);
    assert.equal(agrees('answers', 'partial'), false);

    assert.equal(agrees('partial', 'partial'), true);
    assert.equal(agrees('partial', 'answers'), false);

    assert.equal(agrees('reject', 'answers'), false);
    assert.equal(agrees('rejected', 'partial'), true);
    assert.equal(agrees('unrelated', 'unrelated'), true);
    assert.equal(agrees('reject', 'unrelated'), true);

    assert.equal(agrees(undefined, 'answers'), null);
    assert.equal(agrees(null, 'answers'), null);
    assert.equal(agrees('mystery', 'answers'), null);
    assert.equal(agrees('answers', 'mystery'), null);
});

test('askOne sends the granular rubric and a timeout signal without touching the user cache', async (t) => {
    const cacheDir = await tempDir(t);
    let captured;
    mockFetch(t, async (url, options) => {
        captured = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
            answers: {
                evidence_answers_question: {
                    choice: 'answers',
                    confidence: 0.93,
                    probabilities: { answers: 0.93, partial: 0.05, unrelated: 0.02 },
                },
            },
            usage: { input_tokens: 123 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const stats = { tokens: 0 };
    const result = await askOne('test-key', {
        question: 'where does the owner live',
        evidence: 'src/owner.ts',
        path: 'src/owner.ts',
        symbol: null,
        granularity: 'path',
    }, stats, { cacheDir });

    assert.equal(result.choice, 'answers');
    assert.equal(result.cached, undefined);
    assert.equal(stats.tokens, 123);
    assert.equal(captured.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
    assert.equal(captured.options.signal instanceof AbortSignal, true);
    assert.equal(captured.body.state.item.granularity, 'path');
    assert.match(
        captured.body.questions.evidence_answers_question.criteria.answers.what,
        /Names the file that owns/,
    );
    assert.match(
        captured.body.questions.evidence_answers_question.instructions,
        /no symbol is required/,
    );
});

test('askOne reports an aborted request or body read as a failed item', async (t) => {
    const cacheDir = await tempDir(t);
    const item = {
        question: 'where does the owner live',
        evidence: 'src/owner.ts',
        path: 'src/owner.ts',
        symbol: null,
        granularity: 'path',
    };

    let calls = 0;
    let signal;
    mockFetch(t, async (_url, options) => {
        calls += 1;
        signal = options.signal;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const requestFailure = await askOne('test-key', item, { tokens: 0 }, { cacheDir });
    assert.match(requestFailure.error, /timed out after 30s/);
    assert.equal(calls, 1);
    assert.equal(signal instanceof AbortSignal, true);

    calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        throw new DOMException('The operation was aborted', 'AbortError');
    };
    const abortFailure = await askOne('test-key', { ...item, evidence: 'src/abort.ts' }, { tokens: 0 }, { cacheDir });
    assert.match(abortFailure.error, /timed out after 30s/);
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => ({
        status: 200,
        ok: true,
        text: async () => {
            calls += 1;
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
    });
    const bodyFailure = await askOne('test-key', { ...item, evidence: 'src/other.ts' }, { tokens: 0 }, { cacheDir });
    assert.match(bodyFailure.error, /timed out after 30s/);
    assert.equal(calls, 1);
});

test('judge main writes the summary and returns nonzero only after workers settle', async (t) => {
    const directory = await tempDir(t);
    const itemsFile = path.join(directory, 'items.json');
    await writeJson(itemsFile, {
        items: [
            { id: 'path-item', question: 'q1', evidence: 'src/a.ts', path: 'src/a.ts', granularity: 'path' },
            { id: 'symbol-item', question: 'q2', evidence: 'src/b.ts b', path: 'src/b.ts', symbol: 'b', granularity: 'symbol' },
            { id: 'malformed', question: 'q3', evidence: 'src/c.ts' },
        ],
    });

    let calls = 0;
    mockFetch(t, async () => {
        calls += 1;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const outDirectory = path.join(directory, 'new', 'nested', 'out');
    const code = await judgeMain(
        ['--lane', 'items', '--items', itemsFile, '--out', outDirectory, '--concurrency', '2'],
        { apiKey: () => 'test-key', cacheDir: path.join(directory, 'cache') },
    );

    assert.equal(code, 1);
    assert.equal(calls, 2);
    const written = JSON.parse(await readFile(path.join(outDirectory, 'items.json'), 'utf8'));
    assert.equal(written.rows.length, 3);
    assert.equal(written.rows.filter((row) => row.error).length, 3);
    assert.match(written.rows[0].error, /timed out/);
    assert.match(written.rows[1].error, /timed out/);
    assert.match(written.rows[2].error, /granularity/);
    assert.equal(written.rows.every((row) => row.satori === null), true);
    assert.equal(written.rows.every((row) => row.agree === null), true);
});

test('judge main still scores rows that carry a real Satori verdict', async (t) => {
    const directory = await tempDir(t);
    const itemsFile = path.join(directory, 'items.json');
    await writeJson(itemsFile, {
        items: [
            {
                id: 'answer-baseline',
                question: 'q1',
                evidence: 'src/a.ts',
                path: 'src/a.ts',
                granularity: 'path',
                satori: { verdict: 'answers' },
            },
            {
                id: 'partial-baseline',
                question: 'q2',
                evidence: 'src/b.ts',
                path: 'src/b.ts',
                granularity: 'path',
                satori: { verdict: 'partial' },
            },
        ],
    });
    mockFetch(t, async () => new Response(JSON.stringify({
        answers: {
            evidence_answers_question: {
                choice: 'partial',
                confidence: 0.8,
                probabilities: { answers: 0.1, partial: 0.8, unrelated: 0.1 },
            },
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const outDirectory = path.join(directory, 'out');
    const code = await judgeMain(
        ['--lane', 'items', '--items', itemsFile, '--out', outDirectory],
        { apiKey: () => 'test-key', cacheDir: path.join(directory, 'cache') },
    );
    assert.equal(code, 0);
    const written = JSON.parse(await readFile(path.join(outDirectory, 'items.json'), 'utf8'));
    assert.equal(written.rows[0].satori, 'answers');
    assert.equal(written.rows[0].agree, false);
    assert.equal(written.rows[1].satori, 'partial');
    assert.equal(written.rows[1].agree, true);
    assert.equal(written.rows.every((row) => row.admission === null), true);
});

test('judge CLI creates a new out directory and exits nonzero for a malformed item', async (t) => {
    const directory = await tempDir(t);
    const itemsFile = path.join(directory, 'items.json');
    await writeJson(itemsFile, {
        items: [{ id: 'malformed', question: 'q', evidence: 'text' }],
    });
    const outDirectory = path.join(directory, 'new', 'out');
    const run = runNode(
        [JUDGE, '--lane', 'items', '--items', itemsFile, '--out', outDirectory],
        withoutApiKeys(),
    );

    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /items=1 scored=0 errors=1/);
    assert.match(run.stdout, /invalid item: granularity/);
    const written = JSON.parse(await readFile(path.join(outDirectory, 'items.json'), 'utf8'));
    assert.match(written.rows[0].error, /granularity/);
});

test('judge CLI rejects invalid concurrency and limit before any empty success', async (t) => {
    const directory = await tempDir(t);
    const itemsFile = path.join(directory, 'items.json');
    await writeJson(itemsFile, { items: [] });

    for (const [flag, value, pattern] of [
        ['--concurrency', '0', /positive integer/],
        ['--limit', '-1', /non-negative integer/],
    ]) {
        const run = runNode(
            [JUDGE, '--lane', 'items', '--items', itemsFile, flag, value],
            withoutApiKeys(),
        );
        assert.equal(run.status, 1, `${flag} ${value}: ${run.stderr}`);
        assert.match(run.stderr, pattern);
    }
});

test('importing both scripts neither runs the CLI nor reads credentials', async (t) => {
    const directory = await tempDir(t);
    const importer = path.join(directory, 'import.mjs');
    await writeFile(importer, [
        `import ${JSON.stringify(pathToFileURL(JUDGE).href)};`,
        `import ${JSON.stringify(pathToFileURL(TRIAGE).href)};`,
        "console.log('imported');",
        '',
    ].join('\n'));
    const run = runNode([importer], withoutApiKeys());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'imported');
});

test('triage derives granularity from the pinned cases, including the p8 mixed entries', () => {
    const cases = loadCases();
    const queries = cases.repos.flatMap((repo) => repo.queries.map((query) => ({
        repo: repo.name,
        query,
    })));

    const mixed = queries
        .filter(({ query }) => new Set(query.acceptable.map((entry) => (
            entry.symbolRegex == null ? 'path' : 'symbol'
        ))).size > 1)
        .map(({ repo, query }) => `${repo}:${query.id}`);
    assert.deepEqual(mixed, ['polars:p8']);

    const p8 = queries.find(({ repo, query }) => repo === 'polars' && query.id === 'p8').query;
    assert.equal(
        resolveGranularity(p8.acceptable, 'py-polars/src/polars/series/series.py'),
        'symbol',
    );
    assert.equal(
        resolveGranularity(p8.acceptable, 'crates/polars-python/src/interop/numpy/to_numpy_series.rs'),
        'path',
    );
    assert.equal(resolveGranularity(p8.acceptable, 'notes/absent.rs'), 'path');

    const r1 = queries.find(({ repo, query }) => repo === 'react' && query.id === 'r1').query;
    assert.equal(
        resolveGranularity(r1.acceptable, 'packages/react-reconciler/src/ReactFiberCommitEffects.js'),
        'symbol',
    );
    const f3 = queries.find(({ repo, query }) => repo === 'flatbuffers' && query.id === 'f3').query;
    assert.equal(resolveGranularity(f3.acceptable, 'python/flatbuffers/builder.py'), 'symbol');
    const p3 = queries.find(({ repo, query }) => repo === 'polars' && query.id === 'p3').query;
    assert.equal(
        resolveGranularity(p3.acceptable, 'crates/polars-core/src/frame/column/mod.rs'),
        'path',
    );
});

function p8Result(repoDirectory, query, hits) {
    return {
        repos: [{
            name: 'polars',
            path: repoDirectory,
            commit: '74dd736d655c',
            head: '74dd736d655cf3b0f5f32f4d4e0f7d9e8f5f4b1a',
            queries: [{
                id: 'p8',
                query: query.query,
                hits,
                score: { rank: 1, strictRank: 1 },
            }],
        }],
    };
}

async function writeP8Sources(repoDirectory) {
    await mkdir(path.join(repoDirectory, 'py-polars/src/polars/series'), { recursive: true });
    await writeFile(
        path.join(repoDirectory, 'py-polars/src/polars/series/series.py'),
        'def to_numpy(self):\n    return self._s.to_numpy()\n',
    );
    await mkdir(path.join(repoDirectory, 'crates/polars-python/src/interop/numpy'), { recursive: true });
    await writeFile(
        path.join(repoDirectory, 'crates/polars-python/src/interop/numpy/to_numpy_series.rs'),
        'fn to_numpy_series() {}\n',
    );
}

test('triage CLI creates a new out directory, keeps admission separate, and preserves mixed levels', async (t) => {
    const directory = await tempDir(t);
    const repoDirectory = path.join(directory, 'repo');
    await writeP8Sources(repoDirectory);
    const cases = loadCases();
    const p8 = cases.repos.find((repo) => repo.name === 'polars').queries.find((query) => query.id === 'p8');
    const resultFile = path.join(directory, 'result.json');
    await writeJson(resultFile, p8Result(repoDirectory, p8, [
        {
            rank: 1,
            path: 'py-polars/src/polars/series/series.py',
            symbol: 'Series.to_numpy',
            granularity: 'symbol',
            pathCategory: 'bindings',
            span: { startLine: 1, endLine: 2 },
            raw: { preview: 'def to_numpy(self):' },
        },
        {
            rank: 2,
            path: 'crates/polars-python/src/interop/numpy/to_numpy_series.rs',
            symbol: 'to_numpy_series',
            granularity: 'symbol',
            pathCategory: 'bindings',
            span: { startLine: 1, endLine: 1 },
            raw: { preview: 'fn to_numpy_series' },
        },
        {
            rank: 3,
            path: 'notes/absent.rs',
            symbol: null,
            granularity: 'file',
            pathCategory: 'docs',
            span: { startLine: 1, endLine: 1 },
            raw: { preview: 'a preview-only hit' },
        },
    ]));

    const outDirectory = path.join(directory, 'new', 'triage');
    const run = runNode([TRIAGE, '--result', resultFile, '--out', outDirectory], withoutApiKeys());
    assert.equal(run.status, 0, run.stderr);

    const { items } = JSON.parse(await readFile(path.join(outDirectory, 'triage-items.json'), 'utf8'));
    const index = JSON.parse(await readFile(path.join(outDirectory, 'triage-index.json'), 'utf8'));
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((item) => item.id), ['polars:p8#1', 'polars:p8#2', 'polars:p8#3']);
    assert.equal(items.every((item) => !Object.hasOwn(item, 'satori')), true);
    assert.deepEqual(items.map((item) => item.granularity), ['symbol', 'path', 'path']);
    assert.deepEqual(items.map((item) => item.admission), [
        { source: 'harness top-k admission', rank: 1 },
        { source: 'harness top-k admission', rank: 2 },
        { source: 'harness top-k admission', rank: 3 },
    ]);
    assert.equal(items[0].sourceProvenance.kind, 'local-checkout-read-time');
    assert.equal(items[0].sourceProvenance.recordedCommit, '74dd736d655c');
    assert.equal(items[0].sourceProvenance.revisionVerified, false);
    assert.equal(items[2].sourceProvenance.kind, 'harness-preview');
    assert.equal(index[0].evidenceSource, 'source');
    assert.equal(index[2].evidenceSource, 'preview');
    assert.equal(index[2].sourceReadFailed, true);
    assert.ok(index[2].previewChars > 0);

    mockFetch(t, async () => new Response(JSON.stringify({
        answers: {
            evidence_answers_question: {
                choice: 'answers',
                confidence: 0.9,
                probabilities: { answers: 0.9, partial: 0.06, unrelated: 0.04 },
            },
        },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const judgeOut = path.join(directory, 'judged');
    const judgeCode = await judgeMain(
        ['--lane', 'items', '--items', path.join(outDirectory, 'triage-items.json'), '--out', judgeOut],
        { apiKey: () => 'test-key', cacheDir: path.join(directory, 'cache') },
    );
    assert.equal(judgeCode, 0);
    const judged = JSON.parse(await readFile(path.join(judgeOut, 'items.json'), 'utf8'));
    assert.equal(judged.rows.length, 3);
    assert.equal(judged.rows.every((row) => row.satori === null), true);
    assert.equal(judged.rows.every((row) => row.agree === null), true);
    assert.equal(judged.rows.every((row) => row.jev === 'answers'), true);
    assert.deepEqual(judged.rows.map((row) => row.admission.rank), [1, 2, 3]);
    assert.equal(judged.rows[0].sourceProvenance.kind, 'local-checkout-read-time');
});

test('triage refuses unknown repositories and unknown or mismatched queries', async (t) => {
    const directory = await tempDir(t);
    const cases = loadCases();
    const p8 = cases.repos.find((repo) => repo.name === 'polars').queries.find((query) => query.id === 'p8');
    const casesToTry = [
        {
            label: 'unknown repo',
            result: {
                repos: [{
                    name: 'unknown',
                    path: directory,
                    queries: [{ id: 'x', query: 'q', hits: [] }],
                }],
            },
            pattern: /no repo "unknown"/,
        },
        {
            label: 'unknown query id',
            result: p8Result(directory, p8, []),
            pattern: /no query "polars:p999"/,
            queryId: 'p999',
        },
        {
            label: 'mismatched query text',
            result: p8Result(directory, { ...p8, query: 'a different question' }, []),
            pattern: /query text mismatch/,
        },
    ];

    for (const [index, entry] of casesToTry.entries()) {
        if (entry.queryId) entry.result.repos[0].queries[0].id = entry.queryId;
        const resultFile = path.join(directory, `result-${index}.json`);
        await writeJson(resultFile, entry.result);
        const outDirectory = path.join(directory, `out-${index}`);
        const run = runNode([TRIAGE, '--result', resultFile, '--out', outDirectory], withoutApiKeys());
        assert.notEqual(run.status, 0, entry.label);
        assert.match(run.stderr, entry.pattern, entry.label);
        assert.equal(existsSync(path.join(outDirectory, 'triage-items.json')), false, entry.label);
    }
});

test('triage refuses a hit with neither source evidence nor a preview', async (t) => {
    const directory = await tempDir(t);
    const cases = loadCases();
    const p8 = cases.repos.find((repo) => repo.name === 'polars').queries.find((query) => query.id === 'p8');
    const resultFile = path.join(directory, 'result.json');
    await writeJson(resultFile, p8Result(directory, p8, [{
        rank: 1,
        path: 'notes/absent.rs',
        symbol: null,
        granularity: 'file',
        span: { startLine: 1, endLine: 1 },
    }]));
    const outDirectory = path.join(directory, 'out');
    const run = runNode([TRIAGE, '--result', resultFile, '--out', outDirectory], withoutApiKeys());

    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no evidence for polars:p8#1/);
    assert.equal(existsSync(path.join(outDirectory, 'triage-items.json')), false);
});
