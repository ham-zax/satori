#!/usr/bin/env node
// Satori vs codebase-memory-mcp (CBM) benchmark.
//
// Both tools run as warm MCP servers over stdio and answer the same questions,
// derived from CBM's own graph so neither side picks its favourable queries:
// symbols whose name is unique in the repository and that have at least one
// caller. Measured per repository, sequentially (never two indexers at once):
//   - full index wall time and peak RSS
//   - exact symbol lookup p50/p95 and hit rate (defining symbol among results)
//   - callers-of-X p50/p95 (Satori call_graph, CBM trace_path)
//   - definition recall vs CBM on a deterministic file sample
//   - one-file edit: time until the edit is published / re-indexed
//
// Satori runs this checkout's packages/mcp/dist with the installed runtime's
// providers but an isolated HOME and LanceDB path. CBM runs one account-wide
// daemon, so its indexing memory is sampled on the daemon process, and every
// benchmark project is deleted afterwards.
//
// Usage: node scripts/bench-vs-cbm.mjs --repos-dir <dir> [--runs 2] [--only name,...]
//        [--output docs/evidence/benchmarks/<date>.json] [--lateon-model <dir>]

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SATORI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REPOS = [
    { name: 'satori', language: 'typescript', url: SATORI_ROOT, rev: 'b76d89b6ad951d26b43a7546d29e03e1cfbffc10' },
    { name: 'trufflehog', language: 'go', url: 'https://github.com/trufflesecurity/trufflehog.git', rev: 'bcfcf73aaf4759d4dadc2783177c245a02792318' },
    { name: 'ripgrep', language: 'rust', url: 'https://github.com/BurntSushi/ripgrep.git', rev: '4649aa9700619f94cf9c66876e9549d83420e16c' },
    { name: 'kotlinpoet', language: 'kotlin', url: 'https://github.com/square/kotlinpoet.git', rev: 'd43826762d8d1ea8781091499671dc03fd0b205a' },
    { name: 'fastapi-template', language: 'mixed (python, typescript)', url: 'https://github.com/fastapi/full-stack-fastapi-template.git', rev: 'cb740b656d7a0a6c5e12c7bf8e50343ec94ee9c7' },
];

const DEFINITION_LABELS = ['Function', 'Method', 'Class', 'Interface', 'Struct', 'Enum', 'Trait', 'Type'];
const CALLABLE_LABELS = ['Function', 'Method'];
const QUERY_COUNT = 20;
const RECALL_FILE_COUNT = 30;
const INDEX_TIMEOUT_MS = 30 * 60_000;

function parseArgs(argv) {
    const options = { reposDir: null, runs: 2, only: null, output: null, lateonModel: null };
    for (let i = 0; i < argv.length; i++) {
        const next = () => argv[++i] ?? fail(`${argv[i - 1]} needs a value`);
        switch (argv[i]) {
            case '--repos-dir': options.reposDir = path.resolve(next()); break;
            case '--runs': options.runs = Number(next()); break;
            case '--only': options.only = new Set(next().split(',')); break;
            case '--output': options.output = path.resolve(next()); break;
            case '--lateon-model': options.lateonModel = path.resolve(next()); break;
            default: fail(`unknown argument ${argv[i]}`);
        }
    }
    if (!options.reposDir) fail('--repos-dir is required');
    if (!Number.isInteger(options.runs) || options.runs < 1) fail('--runs must be a positive integer');
    options.output ??= path.join(SATORI_ROOT, 'docs/evidence/benchmarks', `${new Date().toISOString().slice(0, 10)}.json`);
    return options;
}

function fail(message) {
    throw new Error(message);
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
    if (result.status !== 0) fail(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
}

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
}

const round = (value) => (value === null || value === undefined ? value : Math.round(value * 10) / 10);

// ── repositories ────────────────────────────────────────────────────────────

function materializeRepo(repo, reposDir) {
    const dir = path.join(reposDir, repo.name);
    if (!fs.existsSync(dir)) run('git', ['clone', '-q', '--filter=blob:none', repo.url, dir]);
    run('git', ['-C', dir, 'checkout', '-q', '--force', repo.rev]);
    run('git', ['-C', dir, 'clean', '-q', '-fdx']);
    const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
    if (head !== repo.rev) fail(`${repo.name} is at ${head}, expected ${repo.rev}`);
    const trackedFiles = run('git', ['-C', dir, 'ls-files']).split('\n').filter(Boolean).length;
    return { dir, trackedFiles };
}

// ── process memory ──────────────────────────────────────────────────────────

function processTable() {
    const table = new Map();
    for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
            const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
            const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
            table.set(Number(entry), { ppid, rssKb });
        } catch {
            // process exited between readdir and read
        }
    }
    return table;
}

function treeRssMb(rootPid) {
    const table = processTable();
    let total = 0;
    const stack = [rootPid];
    const seen = new Set();
    while (stack.length) {
        const pid = stack.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        total += table.get(pid)?.rssKb ?? 0;
        for (const [child, info] of table) if (info.ppid === pid) stack.push(child);
    }
    return total / 1024;
}

/** Samples a process tree's RSS every 100 ms until stopped; returns the peak in MB. */
function startRssSampler(pidProvider) {
    let peak = 0;
    const tick = () => {
        const pid = pidProvider();
        if (pid) peak = Math.max(peak, treeRssMb(pid));
    };
    tick();
    const timer = setInterval(tick, 100);
    return { stop: () => { clearInterval(timer); tick(); return round(peak); } };
}

function cbmDaemonPid() {
    const out = spawnSync('pgrep', ['-f', 'codebase-memory-mcp --cbm-daemon-internal'], { encoding: 'utf8' }).stdout.trim();
    const pids = out.split('\n').filter(Boolean).map(Number);
    return pids.length === 1 ? pids[0] : null;
}

// ── MCP stdio client ────────────────────────────────────────────────────────

class McpClient {
    constructor({ command, args = [], cwd, env }) {
        Object.assign(this, { command, args, cwd, env });
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = '';
        this.stderr = '';
    }

    async start() {
        this.child = spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-8192); });
        this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
        this.child.on('close', (code) => {
            for (const pending of this.pending.values()) pending.reject(new Error(`MCP server exited (${code}): ${this.stderr}`));
            this.pending.clear();
        });
        await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench-vs-cbm', version: '1' } });
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    }

    onStdout(chunk) {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            const pending = message.id === undefined ? undefined : this.pending.get(message.id);
            if (!pending) continue;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
            else pending.resolve(message.result);
        }
    }

    request(method, params, timeoutMs = INDEX_TIMEOUT_MS) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolve(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
    }

    async tool(name, args) {
        const result = await this.request('tools/call', { name, arguments: args });
        const text = (result?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('');
        return { result, text };
    }

    async timedTool(name, args) {
        const started = process.hrtime.bigint();
        const response = await this.tool(name, args);
        return { ...response, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    }

    async close() {
        this.child.stdin.end();
        await new Promise((resolve) => {
            const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 10_000);
            this.child.once('close', () => { clearTimeout(timer); resolve(); });
        });
    }
}

const parseJson = (text) => {
    try { return JSON.parse(text); } catch { return null; }
};

// ── CBM ─────────────────────────────────────────────────────────────────────

async function cbmRows(client, project, query) {
    const rows = [];
    let cursor;
    do {
        const request = { project, query, format: 'json', max_rows: 5000, max_output_tokens: 1_000_000, ...(cursor ? { cursor } : {}) };
        const page = parseJson((await client.tool('query_graph', request)).text) ?? fail(`CBM query failed: ${query}`);
        if (!Array.isArray(page.rows)) fail(`unexpected CBM query output: ${JSON.stringify(page).slice(0, 300)}`);
        rows.push(...page.rows);
        cursor = page.has_more ? page.next_cursor ?? fail('CBM reported more rows without a cursor') : undefined;
    } while (cursor);
    return rows;
}

async function cbmGraphFacts(client, project) {
    const definitions = [];
    for (const label of DEFINITION_LABELS) {
        for (const [file, line, name, qualifiedName] of await cbmRows(client, project,
            `MATCH (n:${label}) RETURN n.file_path, n.start_line, n.name, n.qualified_name`)) {
            definitions.push({ label, file, line: Number(line), name, qualifiedName });
        }
    }
    const called = new Set();
    for (const label of CALLABLE_LABELS) {
        for (const [qualifiedName] of await cbmRows(client, project,
            `MATCH (a)-[:CALLS]->(b:${label}) RETURN DISTINCT b.qualified_name`)) {
            called.add(qualifiedName);
        }
    }
    return { definitions, called };
}

/** Unique-name callables with callers, ordered by a hash of the name: deterministic and unbiased. */
function selectQuerySymbols(facts) {
    const nameCounts = new Map();
    for (const definition of facts.definitions) nameCounts.set(definition.name, (nameCounts.get(definition.name) ?? 0) + 1);
    return facts.definitions
        .filter((definition) => CALLABLE_LABELS.includes(definition.label)
            && nameCounts.get(definition.name) === 1
            && facts.called.has(definition.qualifiedName)
            && /^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.name))
        .sort((a, b) => sha(a.name).localeCompare(sha(b.name)))
        .slice(0, QUERY_COUNT);
}

function selectRecallFiles(facts, symbolLanguageFile) {
    const byFile = new Map();
    for (const definition of facts.definitions) {
        if (!symbolLanguageFile(definition.file)) continue;
        const list = byFile.get(definition.file) ?? [];
        list.push(definition);
        byFile.set(definition.file, list);
    }
    return [...byFile.keys()].sort((a, b) => sha(a).localeCompare(sha(b))).slice(0, RECALL_FILE_COUNT)
        .map((file) => ({ file, definitions: byFile.get(file) }));
}

async function benchmarkCbm(dir, edit) {
    const client = new McpClient({ command: 'codebase-memory-mcp', cwd: dir, env: process.env });
    await client.start();
    let project;
    try {
        const daemonPid = cbmDaemonPid() ?? fail('CBM daemon process not found');
        const baselineMb = treeRssMb(daemonPid);
        const sampler = startRssSampler(() => daemonPid);
        const indexed = await client.timedTool('index_repository', { repo_path: dir, mode: 'full' });
        const peakMb = sampler.stop();
        project = parseJson(indexed.text)?.project ?? fail(`CBM index failed: ${indexed.text.slice(0, 300)}`);

        const facts = await cbmGraphFacts(client, project);
        const symbols = selectQuerySymbols(facts);
        const lookups = [];
        const callers = [];
        await client.tool('search_graph', { project, name_pattern: '^main$', limit: 5 }); // warm-up, untimed
        for (const symbol of symbols) {
            const lookup = await client.timedTool('search_graph', { project, name_pattern: `^${symbol.name}$`, limit: 5 });
            lookups.push({ ms: lookup.ms, hit: lookup.text.includes(path.basename(symbol.file)) });
            const trace = await client.timedTool('trace_path', { project, function_name: symbol.name, direction: 'inbound', depth: 1 });
            callers.push({ ms: trace.ms });
        }

        edit.apply();
        let editMs;
        try {
            editMs = (await client.timedTool('index_repository', { repo_path: dir, mode: 'full' })).ms;
        } finally {
            edit.revert();
        }
        return {
            facts,
            symbols,
            metrics: {
                indexMs: round(indexed.ms),
                peakRssMb: peakMb,
                peakRssDeltaMb: round(peakMb - baselineMb),
                definitions: facts.definitions.length,
                lookup: summarizeTimings(lookups),
                callers: summarizeTimings(callers),
                oneFileEditReindexMs: round(editMs),
            },
        };
    } finally {
        if (project) await client.tool('delete_project', { project }).catch(() => {});
        await client.close();
    }
}

function summarizeTimings(samples) {
    const times = samples.map((sample) => sample.ms);
    const hits = samples.filter((sample) => sample.hit !== undefined);
    return {
        count: samples.length,
        p50Ms: percentile(times, 50),
        p95Ms: percentile(times, 95),
        ...(hits.length ? { hitRate: round((hits.filter((sample) => sample.hit).length / hits.length) * 100) / 100 } : {}),
    };
}

// ── Satori ──────────────────────────────────────────────────────────────────

function satoriEnv(home, lateonModel) {
    const potion = path.join(SATORI_ROOT, 'packages/mcp/assets/potion/linux-x64');
    return {
        ...process.env,
        HOME: home,
        SATORI_RUNTIME_PROFILE: 'offline',
        VECTOR_STORE_PROVIDER: 'LanceDB',
        LANCEDB_PATH: path.join(home, '.satori/vector/lancedb'),
        EMBEDDING_PROVIDER: 'Potion',
        EMBEDDING_MODEL: 'minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
        EMBEDDING_OUTPUT_DIMENSION: '256',
        POTION_HELPER_PATH: path.join(potion, 'satori-potion'),
        POTION_MODEL_PATH: path.join(potion, 'model'),
        POTION_REQUEST_TIMEOUT_MS: '5000',
        SATORI_RERANKER_PROVIDER: 'lateon',
        SATORI_LATEON_MODEL_PATH: lateonModel,
        SATORI_LATEON_PROFILE: 'lateon_offline_quality_projection_v5_d32_v1',
        SATORI_LATEON_ACTIVATION_POLICY: 'lateon_context_v5_d32_owner_default_v1',
    };
}

async function waitForSatoriIndex(client, dir, previousGeneration) {
    const started = Date.now();
    for (;;) {
        const status = parseJson((await client.tool('manage_index', { action: 'status', path: dir })).text);
        const operation = status?.operation;
        if (operation && (previousGeneration === undefined || operation.generation > previousGeneration)) {
            if (operation.phase === 'completed') return operation;
            if (operation.phase === 'failed' || status.status === 'error') fail(`Satori indexing failed: ${JSON.stringify(status).slice(0, 500)}`);
        }
        if (Date.now() - started > INDEX_TIMEOUT_MS) fail('Satori indexing timed out');
        await delay(100);
    }
}

function satoriSymbolFile(target) {
    return typeof target?.file === 'string' ? target.file : undefined;
}

async function benchmarkSatori(dir, cbm, edit, options) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-bench-home-'));
    const client = new McpClient({
        command: process.execPath,
        args: [path.join(SATORI_ROOT, 'packages/mcp/dist/index.js')],
        cwd: dir,
        env: satoriEnv(home, options.lateonModel),
    });
    await client.start();
    try {
        const sampler = startRssSampler(() => client.child.pid);
        const started = process.hrtime.bigint();
        const created = parseJson((await client.tool('manage_index', { action: 'create', path: dir })).text);
        if (created?.status !== 'ok') fail(`Satori create failed: ${JSON.stringify(created).slice(0, 500)}`);
        const operation = await waitForSatoriIndex(client, dir);
        const indexMs = Number(process.hrtime.bigint() - started) / 1e6;
        const peakRssMb = sampler.stop();

        const lookups = [];
        const callers = [];
        let unsupportedCallers = 0;
        // Warm-up, untimed: the first search loads the LateOn reranker.
        await client.tool('search_codebase', { path: dir, query: 'main', limit: 5 });
        for (const symbol of cbm.symbols) {
            const search = await client.timedTool('search_codebase', { path: dir, query: symbol.name, limit: 5 });
            const searchPayload = parseJson(search.text);
            if (searchPayload?.status !== 'ok') fail(`Satori search failed for ${symbol.name}: ${search.text.slice(0, 500)}`);
            const results = searchPayload.results ?? [];
            // CBM merges same-name overloads into one node, so any same-name
            // definition in the defining file answers "where is X defined":
            // the result's first lines (annotations allowed) must name it.
            const namePattern = new RegExp(`(^|[^A-Za-z0-9_])${symbol.name}([^A-Za-z0-9_]|$)`);
            const lines = fs.readFileSync(path.join(dir, symbol.file), 'utf8').split('\n');
            const hit = results.find((result) => {
                const span = result.target?.span;
                if (satoriSymbolFile(result.target) !== symbol.file || !span) return false;
                if (span.startLine <= symbol.line && symbol.line <= span.endLine && span.endLine - span.startLine < 200) return true;
                const head = lines.slice(span.startLine - 1, Math.min(span.endLine, span.startLine + 2)).join('\n');
                return namePattern.test(head);
            });
            lookups.push({ ms: search.ms, hit: Boolean(hit) });
            if (!hit && process.env.BENCH_DEBUG) {
                console.error(`[bench] satori miss ${symbol.file}:${symbol.line} ${symbol.name} -> ${results
                    .map((result) => `${result.target?.file}:${result.target?.span?.startLine}-${result.target?.span?.endLine}`).join(', ')}`);
            }
            if (hit?.target?.symbolId) {
                const graph = await client.timedTool('call_graph', {
                    path: dir,
                    symbolRef: { file: hit.target.file, symbolId: hit.target.symbolId, span: hit.target.span },
                    direction: 'callers',
                    depth: 1,
                });
                const graphStatus = parseJson(graph.text)?.status;
                if (graphStatus === 'unsupported') unsupportedCallers++;
                else if (graphStatus === 'ok') callers.push({ ms: graph.ms });
                else fail(`Satori call_graph failed for ${symbol.name}: ${graph.text.slice(0, 500)}`);
            }
        }

        let matched = 0;
        let expected = 0;
        for (const { file, definitions } of cbm.recallFiles) {
            const outline = parseJson((await client.tool('file_outline', { path: dir, file, limitSymbols: 5000 })).text);
            const symbols = outline?.outline?.symbols ?? [];
            for (const definition of definitions) {
                expected++;
                if (symbols.some((symbol) => (symbol.label ?? symbol.name) === definition.name
                    && symbol.span?.startLine <= definition.line && definition.line <= symbol.span?.endLine)) {
                    matched++;
                }
            }
        }

        edit.apply();
        let editMs;
        try {
            const editStarted = process.hrtime.bigint();
            await client.tool('manage_index', { action: 'sync', path: dir });
            await waitForSatoriIndex(client, dir, operation.generation);
            editMs = Number(process.hrtime.bigint() - editStarted) / 1e6;
        } finally {
            edit.revert();
        }

        return {
            indexMs: round(indexMs),
            peakRssMb,
            lookup: summarizeTimings(lookups),
            callers: { ...summarizeTimings(callers), unsupportedCount: unsupportedCallers },
            definitionRecall: expected ? round((matched / expected) * 1000) / 1000 : null,
            definitionRecallSample: { files: cbm.recallFiles.length, definitions: expected },
            oneFileEditSyncMs: round(editMs),
        };
    } finally {
        await client.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
}

// ── driver ──────────────────────────────────────────────────────────────────

/** Appends a comment line to the query-set's first file (a real source file of the benchmark language). */
function oneFileEdit(dir, file) {
    const absolute = path.join(dir, file);
    const original = fs.readFileSync(absolute);
    const comment = file.endsWith('.py') ? '\n# satori benchmark edit\n' : '\n// satori benchmark edit\n';
    return {
        file,
        apply: () => fs.appendFileSync(absolute, comment),
        revert: () => fs.writeFileSync(absolute, original),
    };
}

async function benchmarkRepo(repo, options) {
    const { dir, trackedFiles } = materializeRepo(repo, options.reposDir);
    // The query set is fixed per repository (CBM graph at this revision), so
    // both tools and both runs answer the same questions.
    const probe = new McpClient({ command: 'codebase-memory-mcp', cwd: dir, env: process.env });
    await probe.start();
    let facts;
    let project;
    try {
        project = parseJson((await probe.tool('index_repository', { repo_path: dir, mode: 'full' })).text)?.project;
        facts = await cbmGraphFacts(probe, project);
    } finally {
        if (project) await probe.tool('delete_project', { project }).catch(() => {});
        await probe.close();
    }
    const symbols = selectQuerySymbols(facts);
    if (symbols.length === 0) fail(`${repo.name}: no unique called symbols to query`);
    const recallFiles = selectRecallFiles(facts, () => true);
    const edit = oneFileEdit(dir, symbols[0].file);

    const runs = [];
    for (let index = 0; index < options.runs; index++) {
        const cbm = await benchmarkCbm(dir, edit);
        const satori = await benchmarkSatori(dir, { symbols, recallFiles }, edit, options);
        runs.push({ cbm: cbm.metrics, satori });
        console.error(`[bench] ${repo.name} run ${index + 1}: satori index ${satori.indexMs} ms / ${satori.peakRssMb} MB, cbm index ${cbm.metrics.indexMs} ms`);
    }
    return {
        name: repo.name,
        language: repo.language,
        url: repo.url === SATORI_ROOT ? 'https://github.com/zokizuan/satori' : repo.url,
        rev: repo.rev,
        trackedFiles,
        querySymbols: symbols.map((symbol) => `${symbol.file}:${symbol.line}:${symbol.name}`),
        editedFile: edit.file,
        runs,
    };
}

/** Largest relative spread between runs of every timing metric; the ticket requires <= 10%. */
function runAgreement(results) {
    const spreads = [];
    for (const repo of results) {
        const paths = [['satori', 'indexMs'], ['cbm', 'indexMs'], ['satori', 'oneFileEditSyncMs'], ['cbm', 'oneFileEditReindexMs']];
        for (const [side, key] of paths) {
            const values = repo.runs.map((entry) => entry[side][key]).filter((value) => typeof value === 'number');
            if (values.length < 2) continue;
            const max = Math.max(...values);
            const min = Math.min(...values);
            spreads.push({ repo: repo.name, metric: `${side}.${key}`, spread: round(((max - min) / max) * 1000) / 1000 });
        }
    }
    const worst = spreads.reduce((acc, entry) => (entry.spread > (acc?.spread ?? -1) ? entry : acc), null);
    return { maxSpread: worst?.spread ?? null, worst, withinTenPercent: spreads.every((entry) => entry.spread <= 0.1) };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    options.lateonModel ??= fs.readdirSync(path.join(os.homedir(), '.satori/models/lateon'))
        .map((entry) => path.join(os.homedir(), '.satori/models/lateon', entry))[0];
    if (!options.lateonModel || !fs.existsSync(options.lateonModel)) fail('LateOn model not found; pass --lateon-model');
    if (!fs.existsSync(path.join(SATORI_ROOT, 'packages/mcp/dist/index.js'))) fail('build packages/mcp first');
    fs.mkdirSync(options.reposDir, { recursive: true });

    const results = [];
    for (const repo of REPOS) {
        if (options.only && !options.only.has(repo.name)) continue;
        results.push(await benchmarkRepo(repo, options));
    }
    const artifact = {
        benchmark: 'satori-vs-cbm',
        formatVersion: 1,
        generatedAt: new Date().toISOString(),
        environment: {
            satoriCommit: run('git', ['-C', SATORI_ROOT, 'rev-parse', 'HEAD']).trim(),
            satoriSourceDiffSha256: sha(run('git', ['-C', SATORI_ROOT, 'diff', 'HEAD', '--binary', '--', 'packages/core/src', 'packages/mcp/src'])),
            cbmVersion: run('codebase-memory-mcp', ['--version']).trim().split(/\s+/).pop(),
            node: process.version,
            cpu: os.cpus()[0]?.model,
            cpuCount: os.cpus().length,
            totalMemoryGb: round(os.totalmem() / 1024 ** 3),
            platform: `${os.platform()} ${os.release()}`,
        },
        method: {
            querySymbols: `${QUERY_COUNT} callables per repository with a unique name and at least one caller in CBM's graph, ordered by sha256(name)`,
            lookup: 'Satori search_codebase(name, limit 5) vs CBM search_graph(name_pattern ^name$, limit 5); hit = a same-name definition in the defining file among results (CBM merges overloads into one node)',
            callers: 'Satori call_graph(callers, depth 1) from the lookup hit vs CBM trace_path(inbound, depth 1); unsupported Satori responses are counted separately and excluded from latency',
            definitionRecall: `CBM ${DEFINITION_LABELS.join('/')} definitions in ${RECALL_FILE_COUNT} hash-ordered files matched by Satori file_outline (same name, span contains CBM start line); covers every language, including ones Satori leaves search-only`,
            oneFileEdit: 'append one comment line to the first query symbol\'s file; Satori manage_index sync until the next generation publishes vs CBM index_repository',
            memory: 'Satori: RSS of the MCP server process tree during indexing (fresh process per run). CBM: RSS of the shared account daemon (it also serves other sessions); delta = peak minus pre-index baseline',
        },
        repositories: results,
        agreement: runAgreement(results),
    };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
    console.error(`[bench] wrote ${options.output}; runs within 10%: ${artifact.agreement.withinTenPercent}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
