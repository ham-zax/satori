// Build the Jev `--lane items` input for retrieval triage from one real harness result.json.
//
// `result.json` stores only a short `preview` per hit, so the evidence is preferred from the
// local checkout recorded in `repo.path`. That file is read at triage time at the recorded path
// and span. `repo.commit` and `repo.head` label the revision the harness recorded; this script
// does not run Git, hash the bytes, or otherwise verify that the checkout is at that revision.
//
// Admission is not a Satori verdict. An earlier version of this adapter set
// `satori.verdict: 'answers'` for every top-k hit. This adapter omits `satori` and emits
// `admission` separately, so the judge lane reports `satori: null` and `agree: null`. A Jev
// `partial` or `unrelated` answer therefore describes an admitted hit; it does not contradict a
// Satori verdict. Historical item files that carry a real `satori.verdict` still compare.
//
// Granularity comes from evals/real-repo-quality/cases.json, resolved by repository name, query
// id, and the exact pinned query text. For each hit, the acceptable entries whose pathRegex
// matches that hit path decide the level; if none match, the query's full acceptable set does.
// The level is `path` when any selected entry has symbolRegex null, otherwise `symbol`.
//
// Usage:
//   node evals/judges/result-triage.mjs --result <dir>/result.json --out <dir>
//   bash -ic 'node evals/judges/jev-dual-judge.mjs --lane items --items <dir>/triage-items.json'
//
// The second command writes rows under ~/.cache/satori-jev-judge/<timestamp>/items.json.
// Join those rows with triage-index.json to separate admission noise from rank damage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_FILE = path.resolve(HERE, '../real-repo-quality/cases.json');
const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_CHARS = 4000;

const HELP = `Usage:
  node evals/judges/result-triage.mjs --result <dir>/result.json [--out <dir>]

Options:
  --result <file>     Harness result.json to adapt. Required.
  --out <dir>         Output directory. Created recursively. Default: the result's directory.
  --max-lines <n>     Maximum source lines per evidence snippet. Default 200.
  --max-chars <n>     Maximum source characters per evidence snippet. Default 4000.
  --help              Show this help.
`;

function positiveInteger(raw, flag, fallback) {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${flag} must be a positive integer (got ${String(raw)}).`);
    }
    return value;
}

export function parseArgs(argv) {
    const allowed = new Set(['result', 'out', 'max-lines', 'max-chars']);
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--help') {
            values.set('help', true);
            continue;
        }
        if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
        const key = flag.slice(2);
        if (!allowed.has(key)) throw new Error(`Unknown argument: ${flag}`);
        const value = argv[index + 1];
        if (value === undefined) throw new Error(`${flag} needs a value.`);
        values.set(key, value);
        index += 1;
    }
    return {
        result: values.has('result') ? path.resolve(values.get('result')) : '',
        out: values.has('out') ? path.resolve(values.get('out')) : '',
        maxLines: positiveInteger(values.get('max-lines'), '--max-lines', DEFAULT_MAX_LINES),
        maxChars: positiveInteger(values.get('max-chars'), '--max-chars', DEFAULT_MAX_CHARS),
        help: values.get('help') === true,
    };
}

export function loadCases(file = CASES_FILE) {
    const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(cases?.repos)) throw new Error(`${file} has no repos array`);
    return cases;
}

export function buildCaseIndex(cases) {
    const index = new Map();
    for (const repo of cases.repos) {
        if (typeof repo?.name !== 'string') throw new Error('cases.json repo has no name');
        const queries = new Map();
        for (const query of repo.queries ?? []) {
            if (typeof query?.id !== 'string') throw new Error(`cases.json repo ${repo.name} has a query without id`);
            queries.set(query.id, query);
        }
        index.set(repo.name, queries);
    }
    return index;
}

export function resolveCaseQuery(index, repoName, query) {
    const queries = index.get(repoName);
    if (!queries) throw new Error(`cases.json has no repo "${repoName}"`);
    const pinned = queries.get(query?.id);
    if (!pinned) throw new Error(`cases.json has no query "${repoName}:${query?.id}"`);
    if (pinned.query !== query.query) {
        throw new Error(
            `query text mismatch for "${repoName}:${query.id}": cases.json has `
            + `${JSON.stringify(pinned.query)}, result.json has ${JSON.stringify(query.query)}`,
        );
    }
    return pinned;
}

export function resolveGranularity(acceptable, hitPath) {
    if (!Array.isArray(acceptable) || acceptable.length === 0) {
        throw new Error('acceptable must be a non-empty array');
    }
    const matching = acceptable.filter((entry) => {
        if (typeof entry?.pathRegex !== 'string') {
            throw new Error('acceptable entry has no pathRegex');
        }
        let regex;
        try {
            regex = new RegExp(entry.pathRegex);
        } catch (error) {
            throw new Error(`invalid acceptable pathRegex ${JSON.stringify(entry.pathRegex)}: ${error.message}`);
        }
        return regex.test(hitPath);
    });
    const selected = matching.length > 0 ? matching : acceptable;
    return selected.some((entry) => entry.symbolRegex == null) ? 'path' : 'symbol';
}

export function readSourceEvidence(
    repoPath,
    hit,
    maxLines = DEFAULT_MAX_LINES,
    maxChars = DEFAULT_MAX_CHARS,
) {
    const span = hit?.span;
    if (typeof repoPath !== 'string' || repoPath.length === 0) return null;
    if (typeof hit?.path !== 'string' || hit.path.length === 0 || !span) return null;
    try {
        const lines = fs.readFileSync(path.join(repoPath, hit.path), 'utf8').split(/\r?\n/);
        const start = Math.max(1, Number.isSafeInteger(span.startLine) ? span.startLine : 1);
        const end = Math.min(lines.length, Number.isSafeInteger(span.endLine) ? span.endLine : start);
        const text = lines.slice(start - 1, end).slice(0, maxLines).join('\n').slice(0, maxChars);
        return text.trim().length > 0 ? text : null;
    } catch {
        return null;
    }
}

export function buildTriage(result, cases, options = {}) {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    if (!Array.isArray(result?.repos)) throw new Error('result.json has no repos array');
    const caseIndex = buildCaseIndex(cases);
    const items = [];
    const index = [];

    for (const repo of result.repos) {
        if (typeof repo?.name !== 'string') throw new Error('result.json repo has no name');
        for (const query of repo.queries ?? []) {
            const pinned = resolveCaseQuery(caseIndex, repo.name, query);
            for (const hit of query.hits ?? []) {
                const id = `${repo.name}:${query.id}#${hit.rank}`;
                const granularity = resolveGranularity(pinned.acceptable, hit.path);
                const sourceText = readSourceEvidence(repo.path, hit, maxLines, maxChars);
                const preview = typeof hit.raw?.preview === 'string' ? hit.raw.preview : '';
                const evidence = sourceText ?? (preview.trim().length > 0 ? preview : null);
                if (!evidence) {
                    throw new Error(
                        `no evidence for ${id}: source read failed and result.json has no non-empty preview`,
                    );
                }
                const evidenceSource = sourceText ? 'source' : 'preview';
                const sourceProvenance = {
                    kind: sourceText ? 'local-checkout-read-time' : 'harness-preview',
                    repoPath: repo.path ?? null,
                    recordedCommit: repo.commit ?? null,
                    recordedHead: repo.head ?? null,
                    revisionVerified: false,
                };
                items.push({
                    id,
                    question: query.query,
                    evidence,
                    path: hit.path,
                    symbol: hit.symbol ?? null,
                    granularity,
                    admission: { source: 'harness top-k admission', rank: hit.rank },
                    sourceProvenance,
                });
                index.push({
                    id,
                    repo: repo.name,
                    queryId: query.id,
                    rank: hit.rank,
                    path: hit.path,
                    symbol: hit.symbol ?? null,
                    hitGranularity: hit.granularity ?? null,
                    pathCategory: hit.pathCategory ?? null,
                    scoredRank: query.score?.rank ?? null,
                    scoredStrictRank: query.score?.strictRank ?? null,
                    rubricGranularity: granularity,
                    evidenceSource,
                    sourceReadFailed: sourceText === null,
                    evidenceChars: evidence.length,
                    previewChars: preview.length,
                    sourceProvenance,
                });
            }
        }
    }
    return { items, index };
}

export function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(HELP.trimEnd());
        return 0;
    }
    if (!options.result) throw new Error('--result <result.json> is required');
    const result = JSON.parse(fs.readFileSync(options.result, 'utf8'));
    const cases = loadCases();
    const { items, index } = buildTriage(result, cases, options);
    const outDir = options.out || path.dirname(options.result);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'triage-items.json'), `${JSON.stringify({ items }, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'triage-index.json'), `${JSON.stringify(index, null, 2)}\n`);
    const bytes = items.reduce((total, item) => total + Buffer.byteLength(item.evidence, 'utf8'), 0);
    const fromPreview = index.filter((row) => row.evidenceSource === 'preview').length;
    console.log(`items ${items.length} from ${result.repos.length} repo(s); evidence bytes ${bytes}; preview fallbacks ${fromPreview}`);
    console.log('source evidence is read from the local checkout at triage time; recorded revisions are not verified');
    console.log(`wrote ${path.join(outDir, 'triage-items.json')} and triage-index.json`);
    return 0;
}

const invokedDirectly = process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;

if (invokedDirectly) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
