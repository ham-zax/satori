#!/usr/bin/env node
// Real-repo search-quality check against the LOCAL workspace build (packages/*/dist).
// Usage: node evals/real-repo-quality/run.mjs [--repos react,polars,flatbuffers] [--out DIR]
//        [--state-root DIR] [--index-timeout-min N] [--reuse-index]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openLocalSession } from './session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const home = os.homedir();
const reposDir = path.join(home, '.cache', 'satori-eval-repos');
const stateRoot = path.resolve(opt('state-root', path.join(home, '.cache', 'satori-eval-state')));
const outDir = path.resolve(opt('out', path.join(home, '.cache', 'satori-eval-results', new Date().toISOString().replace(/[:.]/g, '-'))));
const indexTimeoutMs = Number(opt('index-timeout-min', '30')) * 60_000;
const reuseIndex = args.includes('--reuse-index');
const pollMs = 5_000;

const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
const wanted = new Set((opt('repos', cases.repos.map((r) => r.name).join(','))).split(','));

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function dist(rel) {
    const ns = await import(pathToFileURL(path.join(workspaceRoot, rel)).href);
    return ns.default && Object.keys(ns).length <= 1 ? ns.default : ns;
}

function ensureClone(repo) {
    const dir = path.join(reposDir, `${repo.name}@${repo.commit}`);
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(reposDir, { recursive: true });
        execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', repo.url, dir], { stdio: 'inherit' });
        execFileSync('git', ['-C', dir, 'checkout', '-q', repo.commit], { stdio: 'inherit' });
    }
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (!head.startsWith(repo.commit)) throw new Error(`${dir} is at ${head}, expected ${repo.commit}`);
    const dirty = execFileSync('git', ['-C', dir, 'status', '--short'], { encoding: 'utf8' }).trim();
    if (dirty) throw new Error(`${dir} has local changes; pinned-repository evidence requires a clean checkout.`);
    return { dir, head };
}

/** Manifest files of the current Publication for `repoDir`, read from the index state (not re-implemented). */
function readManifestFiles(repoDir) {
    const publications = path.join(stateRoot, 'publications');
    const found = [];
    const walk = (dir, depth) => {
        if (depth > 6) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (entry.name === 'manifest.json' && dir.endsWith(path.join('navigation'))) found.push(full);
        }
    };
    if (fs.existsSync(publications)) walk(publications, 0);
    for (const file of found) {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (manifest.normalizedRootPath === repoDir && Array.isArray(manifest.files)) {
            return { manifestPath: file, manifest };
        }
    }
    return undefined;
}

async function parseOutcomes(repoDir, manifestFiles) {
    const { createLanguageAnalysisService } = await dist('packages/core/dist/language-analysis/service.js');
    const analyzer = createLanguageAnalysisService();
    const rows = [];
    for (const file of manifestFiles) {
        const row = {
            path: file.path,
            language: file.language,
            structuralStatus: file.definitionStatus,
            symbolCount: file.symbolCount,
        };
        if (file.definitionStatus === 'structural_unavailable') {
            // The manifest keeps only the status; re-run the analyzer on the file for the reason.
            try {
                const result = await analyzer.analyze({
                    content: fs.readFileSync(path.join(repoDir, file.path), 'utf8'),
                    language: file.language,
                    relativePath: file.path,
                });
                row.reason = result.structuralReason ?? null;
                row.reasonSource = 'reanalysis';
                row.reanalysisBackend = result.backend;
                row.reanalysisStructuralStatus = result.structuralStatus;
                row.reanalysisSymbolCount = result.symbols.length;
            } catch (error) {
                row.reason = `reanalysis_threw: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
        rows.push(row);
    }
    await analyzer.dispose?.();
    return rows;
}

function countsByLanguage(rows) {
    const table = {};
    for (const row of rows) {
        const entry = (table[row.language] ??= {});
        entry[row.structuralStatus] = (entry[row.structuralStatus] ?? 0) + 1;
    }
    return table;
}

async function indexRepo(session, repoDir, log) {
    const record = { startedAt: now(), events: [] };
    const call = async (name, callArgs) => {
        const at = now();
        let response;
        try {
            response = await session.call(name, callArgs);
        } catch (error) {
            response = { text: '', isError: true, exception: error instanceof Error ? error.message : String(error) };
        }
        record.events.push({ at, tool: name, args: callArgs, isError: response.isError, exception: response.exception, text: response.text });
        return response;
    };
    let t0 = Date.now();
    const settled = async (label) => {
        // Wait out any running mutation (e.g. the startup background sync) so the create below is the measured one.
        for (;;) {
            const status = await call('manage_index', { action: 'status', path: repoDir });
            if (status.json?.status !== 'not_ready') return status;
            if (Date.now() - t0 > indexTimeoutMs) { record.timedOut = true; record.timedOutWhile = label; return status; }
            await sleep(pollMs);
        }
    };
    if (!reuseIndex) {
        // A clean measurement starts from an untracked root; whatever state existed is logged verbatim first.
        const before = await settled('settle-before-clear');
        record.statusBeforeCreate = before.json ?? before.text;
        if (before.json?.status !== 'not_indexed') {
            const cleared = await call('manage_index', { action: 'clear', path: repoDir });
            record.clearResponse = cleared.json ?? cleared.text;
        }
        t0 = Date.now();
        record.createRequestedAt = now();
        const create = await call('manage_index', { action: 'create', path: repoDir });
        record.createResponse = create.json ?? create.text;
    }
    let last;
    for (;;) {
        const status = await call('manage_index', { action: 'status', path: repoDir });
        last = status;
        const phase = status.json?.operation?.phase;
        const terminal = status.json?.status === 'ok'
            || (status.json?.operation && ['failed', 'blocked', 'cancelled', 'completed'].includes(phase))
            || status.json?.status === 'error';
        if (terminal) break;
        if (status.json && status.json.status !== 'not_ready' && status.json.status !== 'ok') {
            // not_indexed straight after create is recorded verbatim (lifecycle anomaly) and polling continues briefly.
            record.sawNonProgressStatus = true;
        }
        if (Date.now() - t0 > indexTimeoutMs) {
            record.timedOut = true;
            break;
        }
        log(`  ${Math.round((Date.now() - t0) / 1000)}s status=${status.json?.status} reason=${status.json?.reason} phase=${phase}`);
        await sleep(pollMs);
    }
    record.wallMs = Date.now() - t0;
    record.finalStatusSummary = last?.json ?? last?.text;
    record.statusFull = (await call('manage_index', { action: 'status', path: repoDir, detail: 'full' })).text;
    record.listCodebases = (await call('list_codebases', {})).text;
    record.succeeded = record.finalStatusSummary?.status === 'ok';
    return record;
}

function extractHits(json) {
    const items = Array.isArray(json?.results) ? json.results : [];
    return items.map((item, index) => ({ rank: index + 1, raw: item }));
}

async function main() {
    fs.mkdirSync(outDir, { recursive: true });
    const log = (line) => process.stderr.write(`${line}\n`);
    const { buildSearchQueryPlan } = await dist('packages/mcp/dist/core/search-query-planning.js');
    const { resolveSearchAnswerFocus } = await dist('packages/mcp/dist/core/search-answer-focus.js');
    const { classifyPathCategory } = await dist('packages/mcp/dist/core/search-ranking-policy.js');
    const { scoreQuery, normalizeHit } = await import('./score.mjs');

    const result = {
        generatedAt: now(),
        workspaceHead: execFileSync('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        stateRoot,
        topK: cases.topK,
        repos: [],
    };
    const resultPath = path.join(outDir, 'result.json');
    if (fs.existsSync(resultPath)) {
        // Repos are run one at a time into the same --out; keep the ones already measured.
        const previous = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        result.repos = previous.repos.filter((r) => !wanted.has(r.name));
        result.previousGeneratedAt = previous.generatedAt;
    }
    for (const repo of cases.repos.filter((r) => wanted.has(r.name))) {
        log(`== ${repo.name}`);
        const entry = { name: repo.name, url: repo.url, commit: repo.commit };
        result.repos.push(entry);
        const { dir, head } = ensureClone(repo);
        entry.path = dir;
        entry.head = head;
        const session = await openLocalSession({ stateRoot, roots: [reposDir] });
        try {
            entry.indexing = await indexRepo(session, dir, log);
            const manifest = readManifestFiles(dir);
            if (manifest) {
                entry.manifestPath = manifest.manifestPath;
                entry.parseOutcomes = await parseOutcomes(dir, manifest.manifest.files);
                entry.parseOutcomeCounts = countsByLanguage(entry.parseOutcomes);
            }
            entry.queries = [];
            for (const query of repo.queries) {
                const callArgs = { path: dir, query: query.query, limit: cases.topK };
                const at = now();
                const queryStartedAt = performance.now();
                const response = await session.call('search_codebase', callArgs);
                const elapsedMs = performance.now() - queryStartedAt;
                const plan = buildSearchQueryPlan(query.query, true);
                const focus = resolveSearchAnswerFocus(plan);
                const hits = extractHits(response.json).slice(0, cases.topK).map((hit) => normalizeHit(hit, classifyPathCategory));
                entry.queries.push({
                    id: query.id,
                    tags: query.tags,
                    query: query.query,
                    at,
                    elapsedMs,
                    request: callArgs,
                    responseStatus: response.json?.status ?? null,
                    response: response.json ?? response.text,
                    queryPlan: plan,
                    answerFocus: focus.focus,
                    answerFocusReasons: focus.reasons,
                    hits,
                    score: scoreQuery(query, hits),
                });
                log(`  ${query.id} status=${response.json?.status} rank=${entry.queries.at(-1).score.rank} strict=${entry.queries.at(-1).score.strictRank} top=${hits[0]?.symbol ?? '(file)'} focus=${focus.focus} elapsedMs=${elapsedMs.toFixed(1)}`);
            }
        } finally {
            entry.serverStderr = session.stderr;
            entry.serverStderrSummary = summarizeStderr(session.stderr);
            entry.protocolErrors = session.protocolErrors;
            entry.protocolErrorSummary = summarizeProtocolErrors(session.protocolErrors);
            await session.close().catch(() => undefined);
        }
    }
    // Lone UTF-16 surrogates (previews cut mid-character) are replaced so the file stays valid for jq.
    const json = JSON.stringify(result, null, 2).replace(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/gi, '\\ufffd');
    fs.writeFileSync(path.join(outDir, 'result.json'), `${json}\n`);
    fs.writeFileSync(path.join(outDir, 'summary.md'), summarize(result));
    log(`wrote ${outDir}/result.json and summary.md`);
}

function summarizeProtocolErrors(errors) {
    const counts = new Map();
    for (const error of errors) {
        if (error.source !== 'stdout-tap') continue;
        const key = error.raw.replace(/\d+/g, 'N').slice(0, 200);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
        total: errors.length,
        stdoutNonJsonLines: [...counts.values()].reduce((a, b) => a + b, 0),
        topRepeatedStdoutLines: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([line, count]) => ({ count, line })),
    };
}

function summarizeStderr(chunks) {
    const text = chunks.map((chunk) => chunk.text).join('');
    const counts = new Map();
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const key = line.trim().replace(/\d+/g, 'N').slice(0, 200);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
        bytes: Buffer.byteLength(text),
        lines: text.split('\n').filter(Boolean).length,
        topRepeatedLines: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([line, count]) => ({ count, line })),
    };
}

function summarize(result) {
    const lines = [`# Real-repo search quality (${result.generatedAt})`, '', `workspace ${result.workspaceHead}`, ''];
    let at1 = 0, at5 = 0, total = 0;
    for (const repo of result.repos) {
        lines.push(`## ${repo.name}@${repo.commit}`, '', `index: ${repo.indexing?.succeeded ? 'ok' : 'NOT ok'} wall=${Math.round((repo.indexing?.wallMs ?? 0) / 1000)}s timedOut=${Boolean(repo.indexing?.timedOut)}`, '');
        lines.push('| id | tags | rank | strict | granularity | focus | top-1 |', '|---|---|---|---|---|---|---|');
        for (const q of repo.queries ?? []) {
            total += 1;
            if (q.score.rank && q.score.rank <= 1) at1 += 1;
            if (q.score.rank && q.score.rank <= 5) at5 += 1;
            const top = q.hits[0];
            lines.push(`| ${q.id} | ${q.tags.join(',')} | ${q.score.rank ?? 'absent'} | ${q.score.strictRank ?? 'absent'} | ${q.score.granularity ?? '-'} | ${q.answerFocus} | ${top ? `${top.path} ${top.symbol ?? '(file)'} [${top.pathCategory}]` : '-'} |`);
        }
        lines.push('');
    }
    lines.push(`hit@1 ${at1}/${total}  hit@5 ${at5}/${total}`, '');
    return lines.join('\n');
}

await main();
