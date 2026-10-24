#!/usr/bin/env node
// Dual-judge comparison: Satori's deterministic judge and Jev judge the same item,
// independently, and the runner reports only where they disagree.
//
// Design and protocol: docs/improvements/jev-judgement-workflow.md
//
//   node evals/judges/jev-dual-judge.mjs --lane evidence [--limit N] [--concurrency 8]
//   node evals/judges/jev-dual-judge.mjs --lane items --items items.json
//
// Lane `evidence` judges every accepted entry of evals/judges/judge-v2.json. The judge's
// verdict there is `answers` by construction (the entry is in the accepted set), so a
// disagreement means the entry's evidence text does not actually answer the question.
//
// Lane `items` reads `{ "items": [{ question, evidence, granularity, path?, symbol?, satori?, admission? }] }`
// and compares Jev against whatever verdict Satori recorded in `satori.verdict`. Items without
// `satori` (for example retrieval-triage rows that carry admission metadata instead) are judged
// but not scored: their row has `satori: null` and `agree: null`.
//
// Jev is a judge of supplied text: one request per item, because batching degrades it.
// Credentials come from TYPESAFE_API_KEY or JEV_API_KEY, so run it in a login shell.
// Every request attempt, including the body read, is bounded by a 30 s abort signal.
// Any failed item makes the process exit nonzero after the summary is written.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'api.typesafe.ai';
const API_PATH = '/v1/systemone';
const MODEL = 'jev-1.13.0';
const USD_PER_MILLION_INPUT_TOKENS = 0.042;
const LOW_CONFIDENCE = 0.7;
const JUDGE_PATH = 'evals/judges/judge-v2.json';
const CACHE_DIR = path.join(homedir(), '.cache', 'satori-jev-judge');
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;

export const ANSWER = 'answers';
export const PARTIAL = 'partial';
export const UNRELATED = 'unrelated';

const KNOWN_CHOICES = new Set([ANSWER, PARTIAL, UNRELATED]);

const HELP = `Usage:
  node evals/judges/jev-dual-judge.mjs --lane evidence [--limit N] [--concurrency 8]
  node evals/judges/jev-dual-judge.mjs --lane items --items items.json

Options:
  --lane <evidence|items>  Evidence lane reads judge-v2 accepted entries; items reads a file.
  --items <file>           Items JSON for --lane items.
  --limit <n>              Judge at most n items. 0 (default) means all. Must be a non-negative integer.
  --concurrency <n>        Concurrent requests. Must be a positive integer. Default 8.
  --out <dir>              Output directory. Default: a timestamped directory under the cache.
  --help                   Show this help.
`;

export function question(questionText, granularity) {
    if (granularity !== 'path' && granularity !== 'symbol') {
        throw new Error(
            `Cannot build a rubric without a known granularity (got ${JSON.stringify(granularity)}).`,
        );
    }
    const pathLevel = granularity === 'path';
    return {
        type: 'choice',
        instructions:
            'In `candidate.evidence`, does the evidence name what answers `item.question` at the '
            + `acceptance level in \`item.granularity\` (${granularity})? `
            + (pathLevel
                ? 'At `path` granularity, naming the file that owns the behaviour is a full answer; '
                    + 'no symbol is required. '
                : 'At `symbol` granularity, the answering function, class, or symbol itself must be named. ')
            + 'When the question asks for tests, documentation, or configuration, the file that '
            + 'answers that request is the answer.',
        criteria: {
            [ANSWER]: {
                what: pathLevel
                    ? 'Names the file that owns the behaviour, or is the test, documentation, or '
                        + 'configuration file the question asks for, precisely enough that a reader '
                        + 'can go there and see it'
                    : 'Names the owning file and the function, class, or symbol that performs the '
                        + 'behaviour or defines the thing the question asks for, precisely enough '
                        + 'that a reader can go there and see it',
                not_for: 'A file that only imports, calls, mentions, or documents the behaviour, '
                    + 'unless the question itself asks for that test, documentation, or configuration',
            },
            [PARTIAL]: {
                what: pathLevel
                    ? 'Is in the right subsystem or names a related file, but does not name the '
                        + 'file that owns the behaviour'
                    : 'Is in the right file or subsystem and speaks to the question, but does not '
                        + 'name the symbol that answers it',
                not_for: 'An unrelated subsystem that happens to share a word with the question',
            },
            [UNRELATED]: {
                what: 'Concerns something else entirely',
                not_for: 'A weaker but relevant match that still names the answering code',
            },
        },
    };
}

export function parseArgs(argv) {
    const options = { lane: 'evidence', limit: 0, concurrency: 8, items: '', out: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const readValue = () => {
            index += 1;
            const value = argv[index];
            if (value === undefined) throw new Error(`${flag} needs a value.`);
            return value;
        };
        if (flag === '--lane') options.lane = readValue();
        else if (flag === '--limit') options.limit = Number(readValue());
        else if (flag === '--concurrency') options.concurrency = Number(readValue());
        else if (flag === '--items') options.items = readValue();
        else if (flag === '--out') options.out = readValue();
        else if (flag === '--help' || flag === '-h') options.help = true;
        else throw new Error(`Unknown argument: ${flag}`);
    }
    return options;
}

export function validateOptions(options) {
    if (options.lane !== 'evidence' && options.lane !== 'items') {
        throw new Error(`--lane must be "evidence" or "items" (got ${String(options.lane)}).`);
    }
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
        throw new Error(
            `--concurrency must be a positive integer (got ${String(options.concurrency)}).`,
        );
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
        throw new Error(`--limit must be a non-negative integer (got ${String(options.limit)}).`);
    }
    if (options.lane === 'items' && !options.items) {
        throw new Error('--lane items needs --items <file>.');
    }
}

async function loadEvidenceItems(limit) {
    const judge = JSON.parse(await readFile(JUDGE_PATH, 'utf8'));
    const items = [];
    for (const [id, query] of Object.entries(judge.queries)) {
        for (const [index, entry] of query.entries.entries()) {
            if (entry.adjudicatedVerdict === 'no') continue;
            items.push({
                id: `${query.repo}:${id}#${index}`,
                question: query.query,
                evidence: entry.evidence,
                path: entry.pathRegex,
                symbol: entry.symbolRegex ?? null,
                granularity: entry.granularity,
                satori: { verdict: ANSWER, source: 'judge-v2 accepted entry' },
            });
        }
    }
    return limit > 0 ? items.slice(0, limit) : items;
}

async function loadItemsFile(file, limit) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) throw new Error(`${file} has no items array`);
    return limit > 0 ? items.slice(0, limit) : items;
}

function apiKey(deps = {}) {
    if (typeof deps.apiKey === 'function') return deps.apiKey();
    const key = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
    if (!key) {
        throw new Error(
            'TYPESAFE_API_KEY is not set. The key lives in the login shell, so run this through '
            + '`bash -ic` (or export it) rather than a bare non-interactive shell.',
        );
    }
    return key;
}

function normalizeChoice(value) {
    if (typeof value !== 'string') return null;
    const choice = value.trim().toLowerCase();
    return KNOWN_CHOICES.has(choice) ? choice : null;
}

function answerObjects(container) {
    if (!container || typeof container !== 'object') return [];
    const values = Array.isArray(container) ? container : Object.values(container);
    return values.filter((value) => value
        && typeof value === 'object'
        && !Array.isArray(value)
        && ['choice', 'selected', 'answer', 'confidence', 'probabilities', 'probability']
            .some((key) => Object.hasOwn(value, key)));
}

function verdictFrom(candidate) {
    const rawChoice = candidate.choice ?? candidate.selected ?? candidate.answer;
    if (rawChoice === undefined || rawChoice === null) return null;
    const choice = normalizeChoice(rawChoice);
    if (!choice) return null;
    return {
        choice,
        confidence: typeof candidate.confidence === 'number'
            && Number.isFinite(candidate.confidence)
            ? candidate.confidence
            : null,
        probabilities: candidate.probabilities ?? candidate.probability ?? null,
    };
}

export function readVerdict(body) {
    // Documented shapes: {answers:{name:{choice,confidence,probabilities}}},
    // {questions:{...}}, {results:[...]}, or a bare {choice,confidence,probabilities}.
    // The first container with answer-like content is authoritative. Only the three known
    // choices are accepted; a malformed or unknown answer is an error, never agreement evidence.
    if (!body || typeof body !== 'object') return null;
    for (const container of [body.questions, body.answers, body.results]) {
        const answers = answerObjects(container);
        if (answers.length === 0) continue;
        return verdictFrom(answers[0]);
    }
    return verdictFrom(body);
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(error) {
    return error?.name === 'TimeoutError'
        || error?.name === 'AbortError'
        || /timed out|timeout/i.test(errorMessage(error));
}

export async function askOne(key, item, stats, options = {}) {
    const cacheDir = options.cacheDir ?? CACHE_DIR;
    const fetchImpl = options.fetchImpl ?? fetch;
    const payload = JSON.stringify(
        {
            model: MODEL,
            state: {
                item: { question: item.question, granularity: item.granularity },
                candidate: {
                    evidence: item.evidence,
                    path: item.path ?? null,
                    symbol: item.symbol ?? null,
                },
            },
            questions: {
                evidence_answers_question: question(item.question, item.granularity),
            },
        },
    );
    const hash = createHash('sha256').update(payload).digest('hex');
    const cachePath = path.join(cacheDir, `${hash}.json`);
    try {
        const cached = JSON.parse(await readFile(cachePath, 'utf8'));
        const cachedChoice = normalizeChoice(cached?.choice);
        if (cachedChoice) return { ...cached, choice: cachedChoice, cached: true };
    } catch { /* a missing, unreadable, or malformed entry is a cache miss */ }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const started = performance.now();
        let response;
        let text;
        try {
            response = await fetchImpl(`https://${HOST}${API_PATH}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: payload,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            text = await response.text();
        } catch (error) {
            if (isTimeoutError(error)) {
                return {
                    error: `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${errorMessage(error)}`,
                };
            }
            if (attempt === MAX_ATTEMPTS - 1) {
                return { error: `request failed after ${MAX_ATTEMPTS} attempts: ${errorMessage(error)}` };
            }
            continue;
        }
        if (response.status === 429 || response.status === 529) {
            if (attempt === MAX_ATTEMPTS - 1) {
                return { error: `HTTP ${response.status} through all retries: ${text.slice(0, 300)}` };
            }
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            continue;
        }
        if (!response.ok) return { error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            return { error: `unparseable response: ${text.slice(0, 300)}` };
        }
        const verdict = readVerdict(body);
        if (!verdict) return { error: `unexpected or invalid verdict in response: ${text.slice(0, 300)}` };
        const usage = body.usage ?? body.metadata?.usage ?? {};
        const result = {
            choice: verdict.choice,
            confidence: verdict.confidence,
            probabilities: verdict.probabilities,
            inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
            seconds: (performance.now() - started) / 1000,
        };
        if (typeof result.inputTokens === 'number') stats.tokens += result.inputTokens;
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cachePath, JSON.stringify(result));
        return result;
    }
    return { error: `request still rate limited after ${MAX_ATTEMPTS} attempts` };
}

export function agrees(satoriVerdict, jevChoice) {
    if (typeof satoriVerdict !== 'string') return null;
    const choice = normalizeChoice(jevChoice);
    if (!choice) return null;
    const left = satoriVerdict.trim().toLowerCase();
    if (left === 'answers' || left === 'accept' || left === 'accepted') return choice === ANSWER;
    if (left === 'partial') return choice === PARTIAL;
    if (left === 'reject' || left === 'rejected' || left === 'unrelated') return choice !== ANSWER;
    return null; // an unknown verdict is not agreement evidence either way
}

function itemDiagnostic(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'item must be an object';
    if (typeof item.question !== 'string' || item.question.trim().length === 0) {
        return 'question must be a non-empty string';
    }
    if (typeof item.evidence !== 'string' || item.evidence.trim().length === 0) {
        return 'evidence must be a non-empty string';
    }
    if (item.granularity !== 'path' && item.granularity !== 'symbol') {
        return `granularity must be "path" or "symbol" (got ${JSON.stringify(item.granularity)})`;
    }
    return null;
}

function itemId(item, index) {
    if (typeof item?.id === 'string' && item.id.trim().length > 0) return item.id;
    if (typeof item?.id === 'number') return String(item.id);
    return `item#${index + 1}`;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(HELP.trimEnd());
        return 0;
    }
    validateOptions(options);

    const items = options.lane === 'evidence'
        ? await loadEvidenceItems(options.limit)
        : await loadItemsFile(options.items, options.limit);
    const cacheDir = deps.cacheDir ?? CACHE_DIR;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const prepared = items.map((item, index) => ({
        item,
        id: itemId(item, index),
        diagnostic: itemDiagnostic(item),
    }));
    const runnable = prepared.filter((entry) => !entry.diagnostic).length;
    const key = runnable > 0 ? apiKey(deps) : null;

    const stats = { tokens: 0 };
    const results = new Array(prepared.length);
    let cursor = 0;
    const workers = Array.from(
        { length: Math.min(options.concurrency, Math.max(1, prepared.length)) },
        async () => {
            while (cursor < prepared.length) {
                const index = cursor;
                cursor += 1;
                const { item, diagnostic } = prepared[index];
                let jev;
                if (diagnostic) {
                    jev = { error: `invalid item: ${diagnostic}` };
                } else {
                    try {
                        jev = await askOne(key, item, stats, { cacheDir, fetchImpl });
                    } catch (error) {
                        jev = { error: `unexpected item failure: ${errorMessage(error)}` };
                    }
                }
                results[index] = { item, jev };
            }
        },
    );
    await Promise.all(workers);

    const rows = results.map(({ item, jev }, index) => {
        const satoriVerdict = typeof item?.satori?.verdict === 'string'
            ? item.satori.verdict
            : null;
        return {
            id: prepared[index].id,
            question: item?.question ?? null,
            satori: satoriVerdict,
            jev: jev.choice ?? null,
            confidence: jev.confidence ?? null,
            agree: jev.error ? null : agrees(satoriVerdict, jev.choice),
            lowConfidence: typeof jev.confidence === 'number' && jev.confidence < LOW_CONFIDENCE,
            seconds: jev.seconds ?? null,
            error: jev.error ?? null,
            admission: item?.admission ?? null,
            sourceProvenance: item?.sourceProvenance ?? null,
            evidence: item?.evidence ?? null,
        };
    });

    const errors = rows.filter((row) => row.error);
    const scored = rows.filter((row) => row.agree !== null);
    const disagreements = rows.filter((row) => row.agree === false);
    const elapsed = rows.reduce((total, row) => total + (row.seconds ?? 0), 0);

    console.log(`lane=${options.lane} items=${rows.length} scored=${scored.length} errors=${errors.length}`);
    console.log(`agree=${scored.filter((row) => row.agree).length} disagree=${disagreements.length}`);
    console.log(`jev cost=$${((stats.tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS).toFixed(6)}`
        + ` input_tokens=${stats.tokens} summed_seconds=${elapsed.toFixed(1)}`);
    for (const row of disagreements) {
        const flag = row.lowConfidence ? ' LOW-CONFIDENCE' : '';
        console.log(`\n- ${row.id}${flag} satori=${row.satori} jev=${row.jev} (${row.confidence ?? 'n/a'})`);
        console.log(`  q: ${row.question}`);
        console.log(`  evidence: ${row.evidence}`);
    }
    for (const row of errors) console.log(`\n! ${row.id}: ${row.error}`);

    const outDirectory = options.out
        || path.join(cacheDir, new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(outDirectory, { recursive: true });
    const outPath = path.join(outDirectory, `${options.lane}.json`);
    await writeFile(outPath, `${JSON.stringify({ lane: options.lane, model: MODEL, generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
    console.log(`\nresults: ${outPath}`);
    return errors.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;

if (invokedDirectly) {
    try {
        const code = await main();
        if (code !== 0) process.exitCode = code;
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}
