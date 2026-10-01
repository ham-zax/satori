#!/usr/bin/env node
// Refresh quality evidence with unchanged pinned cases, plus cold/warm local MCP latency.
// node evals/real-repo-quality/benchmark.mjs --state-root TASK_DIR --out OUTPUT_DIR [--reuse-index] [--quality-only] [--label LABEL]
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOfflineEnvironment, openLocalSession } from './session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(`--${name}`) + 1];
if (!argv.includes('--state-root') || !argv.includes('--out')) throw new Error('--state-root and --out are required; use a task-owned state root.');
const stateRoot = path.resolve(option('state-root'));
const out = path.resolve(option('out'));
const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function identity() {
    const sourceFiles = git('ls-files', '-c', '-o', '--exclude-standard', '--', 'packages', 'scripts', 'evals', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json').split('\n').filter(Boolean).sort();
    const sources = sourceFiles.filter((file) => fs.existsSync(path.join(workspace, file))).map((file) => ({ path: file, sha256: sha(fs.readFileSync(path.join(workspace, file))) }));
    const runtime = [];
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile() && !file.endsWith('.map') && !file.endsWith('.d.ts')) runtime.push({ path: path.relative(workspace, file), sha256: sha(fs.readFileSync(file)) });
        }
    };
    for (const name of ['core', 'mcp', 'cli']) walk(path.join(workspace, 'packages', name, 'dist'));
    for (const name of ['core', 'mcp']) walk(path.join(workspace, 'packages', name, 'assets'));
    const launcher = fs.readFileSync(path.join(os.homedir(), '.satori/bin/satori-mcp.js'), 'utf8');
    const profile = await localOfflineEnvironment();
    const modelFiles = [];
    for (const key of ['POTION_MODEL_PATH', 'SATORI_LATEON_MODEL_PATH']) {
        for (const name of fs.readdirSync(profile[key]).sort()) {
            const file = path.join(profile[key], name);
            if (fs.statSync(file).isFile()) modelFiles.push({ model: key, name, sha256: sha(fs.readFileSync(file)) });
        }
    }
    return {
        head: git('rev-parse', 'HEAD'),
        dirtyStatus: git('status', '--short'),
        trackedDiffSha256: sha(execFileSync('git', ['-C', workspace, 'diff', 'HEAD', '--', 'packages', 'scripts', 'evals', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json'], { maxBuffer: 16 * 1024 * 1024 })),
        sourceFiles: sources,
        sourceSha256: sha(JSON.stringify(sources)),
        runtimeFiles: runtime,
        runtimeSha256: sha(JSON.stringify(runtime)),
        modelFiles,
        modelSha256: sha(JSON.stringify(modelFiles)),
        offlineProfile: Object.fromEntries(['SATORI_RUNTIME_PROFILE', 'VECTOR_STORE_PROVIDER', 'EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'EMBEDDING_OUTPUT_DIMENSION', 'SATORI_RERANKER_PROVIDER', 'SATORI_LATEON_PROFILE', 'SATORI_LATEON_ACTIVATION_POLICY'].map((key) => [key, profile[key]])),
        casesSha256: sha(fs.readFileSync(path.join(here, 'cases.json'))),
        scoreSha256: sha(fs.readFileSync(path.join(here, 'score.mjs'))),
        installedOfflineLauncherSha256: sha(fs.readFileSync(path.join(os.homedir(), '.satori/bin/satori-mcp.js'))),
    };
}

function treeRssMiB(rootPid) {
    const processes = new Map();
    for (const pid of fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
        try {
            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
            processes.set(Number(pid), { parent: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]), rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) });
        } catch { /* process exited while sampling */ }
    }
    let total = 0;
    const queue = [rootPid];
    const seen = new Set();
    while (queue.length) {
        const pid = queue.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        total += processes.get(pid)?.rssKiB ?? 0;
        for (const [child, row] of processes) if (row.parent === pid) queue.push(child);
    }
    return total / 1024;
}

function sampleMemory(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Missing child process PID; cannot measure process-tree memory.');
    let peakRSSMiB = 0;
    const tick = () => { peakRSSMiB = Math.max(peakRSSMiB, treeRssMiB(pid)); };
    tick();
    const timer = setInterval(tick, 200);
    return () => { clearInterval(timer); tick(); return peakRSSMiB; };
}

async function quality() {
    const args = [path.join(here, 'run.mjs'), '--state-root', stateRoot, '--out', path.join(out, 'quality')];
    if (argv.includes('--reuse-index')) args.push('--reuse-index');
    if (argv.includes('--index-timeout-min')) args.push('--index-timeout-min', option('index-timeout-min'));
    const loadBefore = os.loadavg();
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    const stop = sampleMemory(child.pid);
    let code;
    let peakRSSMiB;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
    finally { peakRSSMiB = stop(); }
    if (code !== 0) throw new Error(`quality harness exited ${code}`);
    return { peakRSSMiB, loadBefore, loadAfter: os.loadavg(), result: JSON.parse(fs.readFileSync(path.join(out, 'quality/result.json'), 'utf8')) };
}

async function latency(repo, indexStateRoot = stateRoot, warmOnly = false) {
    const request = repo.queries[0].request;
    const trials = [];
    for (let trial = 0; trial < (warmOnly ? 1 : 3); trial++) {
        const loadBefore = os.loadavg();
        const started = performance.now();
        const session = await openLocalSession({ stateRoot: indexStateRoot, roots: [repo.path] });
        const connectedMs = performance.now() - started;
        const stop = sampleMemory(session.processId);
        try {
            const call = async () => {
                const at = performance.now();
                const response = await session.call('search_codebase', request);
                if (response.isError || response.json?.status !== 'ok') throw new Error(`latency response ${response.json?.status}: ${response.text.slice(0, 300)}`);
                return { elapsedMs: performance.now() - at, status: response.json.status, resultsSha256: sha(JSON.stringify(response.json.results)) };
            };
            const cold = await call();
            const warm = [];
            for (let sample = 0; sample < 3; sample++) warm.push(await call());
            const debug = await session.call('search_codebase', { ...request, debugMode: 'full' });
            trials.push({ trial: trial + 1, connectedMs, cold, startupInclusiveColdMs: connectedMs + cold.elapsedMs, warm, warmMedianMs: median(warm.map((row) => row.elapsedMs)), debugStatus: debug.json?.status, debugSearch: debug.json?.hints?.debugSearch, protocolErrors: session.protocolErrors, loadBefore, loadAfter: os.loadavg() });
        } finally {
            const peakRSSMiB = stop();
            if (trials.at(-1)?.trial === trial + 1) trials.at(-1).peakRSSMiB = peakRSSMiB;
            await session.close();
        }
    }
    return { repo: repo.name, queryId: repo.queries[0].id, request, method: warmOnly ? 'One fresh MCP session: first request is warmup, followed by three measured warm requests. No cold median.' : 'Three fresh MCP sessions, each with one cold request and three warm requests.', trials, ...(!warmOnly ? { coldMedianMs: median(trials.map((row) => row.cold.elapsedMs)), startupInclusiveColdMedianMs: median(trials.map((row) => row.startupInclusiveColdMs)) } : {}), warmMedianMs: median(trials.map((row) => row.warmMedianMs)), peakRSSMiB: Math.max(...trials.map((row) => row.peakRSSMiB)) };
}

function scoreSummary(result) {
    return result.repos.map((repo) => {
        const oracle = cases.repos.find((row) => row.name === repo.name);
        const symbolQueries = repo.queries.filter((q) => oracle.queries.find((row) => row.id === q.id).acceptable.every((owner) => owner.symbolRegex));
        const hits = (queries, key, k) => queries.filter((q) => q.score[key] !== null && q.score[key] <= k).length;
        const mrr = (queries, key) => queries.reduce((sum, q) => sum + (q.score[key] ? 1 / q.score[key] : 0), 0) / queries.length;
        return { repo: repo.name, queries: repo.queries.length, hitAt1: hits(repo.queries, 'rank', 1), hitAt5: hits(repo.queries, 'rank', 5), hitAt10: hits(repo.queries, 'rank', 10), meanReciprocalRank: mrr(repo.queries, 'rank'), symbolOnlyOracleQueries: symbolQueries.length, symbolAt1: hits(symbolQueries, 'strictRank', 1), symbolAt5: hits(symbolQueries, 'strictRank', 5), symbolAt10: hits(symbolQueries, 'strictRank', 10), symbolMeanReciprocalRank: mrr(symbolQueries, 'strictRank'), statuses: repo.queries.map((q) => ({ id: q.id, status: q.responseStatus })), pinnedHead: repo.head, workingTreeStatus: execFileSync('git', ['-C', repo.path, 'status', '--short'], { encoding: 'utf8' }).trim() };
    });
}

fs.mkdirSync(out, { recursive: true });
const before = await identity();
const measured = await quality();
if (measured.result.repos.some((repo) => !repo.indexing?.succeeded)) throw new Error('A repository did not finish indexing; do not publish partial benchmark results.');
const latencies = [];
if (!argv.includes('--quality-only')) for (const repo of measured.result.repos) latencies.push(await latency(repo));
if (argv.includes('--latency-request-json')) {
    if (!argv.includes('--latency-state-root')) throw new Error('--latency-state-root is required with --latency-request-json.');
    const request = JSON.parse(fs.readFileSync(path.resolve(option('latency-request-json')), 'utf8'));
    const head = execFileSync('git', ['-C', request.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const workingTreeStatus = execFileSync('git', ['-C', request.path, 'status', '--short'], { encoding: 'utf8' }).trim();
    if (workingTreeStatus) throw new Error('Representative latency checkout is dirty.');
    const row = await latency({ name: path.basename(request.path), path: request.path, queries: [{ id: 'representative_latency_only', request }] }, path.resolve(option('latency-state-root')), true);
    latencies.push({ ...row, pinnedHead: head, workingTreeStatus, scoredByQualityOracle: false });
}
const after = await identity();
if (before.sourceSha256 !== after.sourceSha256 || before.runtimeSha256 !== after.runtimeSha256 || before.modelSha256 !== after.modelSha256) throw new Error('Source/runtime/models changed during measurement; results cannot identify one implementation.');
const artifact = {
    benchmark: 'satori-real-repo-search-quality-and-latency', formatVersion: 1, generatedAt: new Date().toISOString(), identity: before,
    label: argv.includes('--label') ? option('label') : null,
    measurementMode: latencies.length ? 'quality_and_latency' : 'quality_only',
    environment: { node: process.version, platform: `${process.platform} ${os.release()}`, cpu: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3 },
    method: { quality: 'Unchanged cases.json and score.mjs; top 10 grouped results, default runtime scope, local offline workspace build.', latency: 'First query per pinned repository. Three fresh MCP sessions, each one cold request then three warm requests. Cold means fresh process over an existing index, not cold filesystem/model cache. Warm value is median of three per-session medians. Startup-inclusive cold adds session connection time; CLI wrapper overhead excluded.', memory: 'Linux /proc process-tree RSS sampled every 200 ms; quality includes harness, MCP and index descendants, latency samples MCP tree after connection. Sampled peaks may miss shorter spikes.', oracle: 'Overall hit accepts a matching whole-file result. Symbol metric excludes any query with a file-only acceptable entry; strictRank then requires a matching symbol.' },
    quality: scoreSummary(measured.result), qualityProcess: { peakRSSMiB: measured.peakRSSMiB, loadBefore: measured.loadBefore, loadAfter: measured.loadAfter }, latency: latencies,
    qualityRaw: measured.result.repos.map((repo) => ({
        repo: repo.name, pinnedHead: repo.head, indexing: { succeeded: repo.indexing.succeeded, wallMs: repo.indexing.wallMs, finalStatusSummary: repo.indexing.finalStatusSummary },
        parseOutcomeCounts: repo.parseOutcomeCounts, protocolErrors: repo.protocolErrors,
        queries: repo.queries.map(({ id, tags, request, elapsedMs, responseStatus, response, score }) => ({ id, tags, request, elapsedMs, responseStatus, response, score })),
    })),
    limitations: ['28 curated tasks on three pinned repositories, not a held-out or representative customer distribution.', 'Quality measured once. See each latency workload method for sample count; the separate representative query is not part of the quality oracle. No confidence intervals or competitor comparison.', 'Results measure a dirty local workspace build, not an npm release.', 'Definition extraction coverage and caller graph correctness are separate from search-owner accuracy.'],
};
fs.writeFileSync(path.join(out, 'benchmark.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ quality: artifact.quality, latency: artifact.latency.map(({ repo, coldMedianMs, startupInclusiveColdMedianMs, warmMedianMs, peakRSSMiB }) => ({ repo, coldMedianMs, startupInclusiveColdMedianMs, warmMedianMs, peakRSSMiB })) }));
