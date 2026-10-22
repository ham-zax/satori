#!/usr/bin/env node
// Full-index probe: indexes one repository through the built MCP server (offline
// Potion + LanceDB + LateOn, isolated HOME), optionally edits one file and syncs,
// and prints Satori's own timing records (SATORI_PERF_TRACE) plus wall time.
//
//   node scripts/perf/index-probe.mjs <repo> [--edit <relative file>] [--log <file>] [--cpu-prof <dir>]
//       [--save-search <N,N,...> --ext <.go> [--runs 3]] [--wait-timeout <ms>]
//
// --save-search measures save-to-search freshness: for each N it appends a unique
// comment term to N tracked files with extension --ext, then searches for the
// term with no sync ("idle") and right after a sync starts ("sync"). It reports
// the first search's time, hits and freshness state, and the time from save until
// every edited file is a hit. Each trial restores the files and syncs back.
//
// Run memory-capped, e.g.
//   systemd-run --user --scope -q -p MemoryMax=7G -p MemorySwapMax=0 node scripts/perf/index-probe.mjs ../some-repo
// Requires `pnpm --filter @satori-code/core build && pnpm --filter @satori-code/mcp build`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
    const options = { repo: null, edit: null, log: null, cpuProf: null, saveSearch: null, ext: null, runs: 3, waitTimeoutMs: 600_000 };
    const positiveInt = (value, flag) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0) fail(`${flag} needs a positive integer, got ${value}`);
        return number;
    };
    for (let i = 0; i < argv.length; i++) {
        const next = () => argv[++i] ?? fail(`${argv[i - 1]} needs a value`);
        switch (argv[i]) {
            case '--edit': options.edit = next(); break;
            case '--log': options.log = path.resolve(next()); break;
            case '--cpu-prof': options.cpuProf = path.resolve(next()); break;
            case '--save-search': options.saveSearch = next().split(',').map((value) => positiveInt(value, '--save-search')); break;
            case '--ext': options.ext = next(); break;
            case '--runs': options.runs = positiveInt(next(), '--runs'); break;
            case '--wait-timeout': options.waitTimeoutMs = positiveInt(next(), '--wait-timeout'); break;
            default:
                if (options.repo) fail(`unexpected argument ${argv[i]}`);
                options.repo = path.resolve(argv[i]);
        }
    }
    if (!options.repo) fail('usage: index-probe.mjs <repo> [--edit <file>] [--log <file>] [--cpu-prof <dir>] [--save-search <N,...> --ext <.ext> [--runs 3]] [--wait-timeout <ms>]');
    if (options.saveSearch && !options.ext?.startsWith('.')) fail('--save-search needs --ext <.extension>');
    return options;
}

/** RSS of a process and all its descendants, in MB. */
function treeRssMb(rootPid) {
    const table = new Map();
    for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
            table.set(Number(entry), {
                ppid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]),
                rssKb: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0),
            });
        } catch { /* exited */ }
    }
    let totalKb = 0;
    const stack = [rootPid];
    const seen = new Set();
    while (stack.length) {
        const pid = stack.pop();
        if (seen.has(pid)) continue;
        seen.add(pid);
        totalKb += table.get(pid)?.rssKb ?? 0;
        for (const [child, info] of table) if (info.ppid === pid) stack.push(child);
    }
    return totalKb / 1024;
}

// Original bytes of files a save-search trial has edited, restored on a signal too.
const pendingRestores = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        for (const [file, original] of pendingRestores) fs.writeFileSync(file, original);
        process.exit(130);
    });
}

function fail(message) {
    console.error(message);
    process.exit(2);
}

function probeEnv(home, cpuProf) {
    const potion = path.join(ROOT, 'packages/mcp/assets/potion/linux-x64');
    const lateonDir = path.join(os.homedir(), '.satori/models/lateon');
    const lateon = fs.existsSync(lateonDir) ? fs.readdirSync(lateonDir).map((entry) => path.join(lateonDir, entry))[0] : undefined;
    return {
        ...process.env,
        HOME: home,
        SATORI_PERF_TRACE: '1',
        SATORI_RUNTIME_PROFILE: 'offline',
        VECTOR_STORE_PROVIDER: 'LanceDB',
        LANCEDB_PATH: path.join(home, '.satori/vector/lancedb'),
        EMBEDDING_PROVIDER: 'Potion',
        EMBEDDING_MODEL: 'minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
        EMBEDDING_OUTPUT_DIMENSION: '256',
        POTION_HELPER_PATH: path.join(potion, 'satori-potion'),
        POTION_MODEL_PATH: path.join(potion, 'model'),
        POTION_REQUEST_TIMEOUT_MS: '5000',
        ...(lateon ? {
            SATORI_RERANKER_PROVIDER: 'lateon',
            SATORI_LATEON_MODEL_PATH: lateon,
            SATORI_LATEON_PROFILE: 'lateon_offline_quality_projection_v6_d128_v1',
            SATORI_LATEON_ACTIVATION_POLICY: 'lateon_context_v6_d128_owner_default_v1',
        } : { SATORI_RERANKER_PROVIDER: 'none' }),
        ...(cpuProf ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --cpu-prof --cpu-prof-dir=${cpuProf}`.trim() } : {}),
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-index-probe-'));
    if (options.cpuProf) fs.mkdirSync(options.cpuProf, { recursive: true });
    const logPath = options.log ?? path.join(home, 'probe.log');
    const log = fs.createWriteStream(logPath);
    const perfLines = [];
    const capture = (line) => {
        log.write(`${line}\n`);
        const at = line.indexOf('[perf] ');
        if (at >= 0) {
            try { perfLines.push(JSON.parse(line.slice(at + 7))); } catch { /* partial line */ }
        }
    };

    const child = spawn(process.execPath, [path.join(ROOT, 'packages/mcp/dist/index.js')], {
        cwd: options.repo,
        env: probeEnv(home, options.cpuProf),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Mutation workers inherit stdout, so their logs arrive interleaved with JSON-RPC.
    const pending = new Map();
    let nextId = 1;
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdoutBuffer += chunk;
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
            const line = stdoutBuffer.slice(0, newline);
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            let message;
            try { message = JSON.parse(line); } catch { capture(line); continue; }
            pending.get(message.id)?.(message.result);
            pending.delete(message.id);
        }
    });
    let stderrBuffer = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderrBuffer += chunk;
        let newline;
        while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
            capture(stderrBuffer.slice(0, newline));
            stderrBuffer = stderrBuffer.slice(newline + 1);
        }
    });

    const request = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} got no response in ${options.waitTimeoutMs} ms`));
        }, options.waitTimeoutMs);
        pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = async (name, args) => {
        const result = await request('tools/call', { name, arguments: args });
        const text = (result?.content ?? []).map((item) => item.text).join('');
        log.write(`[probe] ${name} ${args.action ?? args.query ?? ''} -> ${text.slice(0, 2000)}\n`);
        try { return JSON.parse(text); } catch { return { status: 'unparsed', text }; }
    };
    const requireAccepted = (action, response) => {
        if (response?.status !== 'ok') throw new Error(`${action} not accepted: ${JSON.stringify(response).slice(0, 500)}`);
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const currentOperation = async () => (await tool('manage_index', { action: 'status', path: options.repo }))?.operation;
    const waitForGeneration = async (previousGeneration) => {
        const deadline = performance.now() + options.waitTimeoutMs;
        while (performance.now() < deadline) {
            const operation = await currentOperation();
            if (operation && (previousGeneration === undefined || operation.generation > previousGeneration)) {
                if (operation.phase === 'completed') return operation;
                if (operation.phase === 'failed') throw new Error(`operation failed: ${JSON.stringify(operation).slice(0, 300)}`);
            }
            await sleep(100);
        }
        throw new Error(`no completed generation after ${previousGeneration ?? 'none'} in ${options.waitTimeoutMs} ms`);
    };
    const startSync = async () => {
        const before = await currentOperation();
        const started = performance.now();
        requireAccepted('sync', await tool('manage_index', { action: 'sync', path: options.repo }));
        return { before, started, requestMs: performance.now() - started };
    };
    // Waits for the sync's operation to end. A sync that starts no new operation
    // within noOpMs counts as a no-op (the working tree matches the index).
    const waitSync = async ({ before, started, requestMs }, noOpMs = 3000) => {
        const deadline = started + options.waitTimeoutMs;
        // Status calls overlap worker execution. Their sum is observation work,
        // not an additive component of the worker's critical path.
        const timing = { requestMs: Math.round(requestMs), beforePollingMs: Math.round(performance.now() - started),
            statusCalls: 0, statusMs: 0, pollSleepMs: 0 };
        while (performance.now() < deadline) {
            const statusStarted = performance.now();
            const operation = await currentOperation();
            timing.statusCalls += 1;
            timing.statusMs += Math.round(performance.now() - statusStarted);
            if (operation && operation.id !== before?.id) {
                if (operation.phase === 'completed') return { operation, wallMs: performance.now() - started,
                    timing: { ...timing, operationId: operation.id,
                        completedToObservationMs: Math.max(0, Date.now() - Date.parse(operation.updatedAt)) } };
                if (['failed', 'blocked', 'cancelled'].includes(operation.phase)) {
                    throw new Error(`sync ${operation.phase}: ${JSON.stringify(operation).slice(0, 300)}`);
                }
            } else if (performance.now() - started > noOpMs) {
                return { operation: before, wallMs: null, timing };
            }
            const sleepStarted = performance.now();
            await sleep(100);
            timing.pollSleepMs += Math.round(performance.now() - sleepStarted);
        }
        throw new Error(`sync did not end in ${options.waitTimeoutMs} ms`);
    };
    const syncAndWait = async () => waitSync(await startSync());

    const saveSearchTrial = async (files, mode, comment) => {
        const term = `satoriprobe${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
        const edited = new Set(files);
        const search = async () => {
            const started = performance.now();
            const response = await tool('search_codebase', {
                path: options.repo, query: term, resultMode: 'raw', limit: files.length + 20, debugMode: 'full',
            });
            const editedResultFiles = (response?.results ?? [])
                .map((result) => result.target?.file ?? result.file)
                .filter(Boolean)
                .map((file) => (path.isAbsolute(file) ? path.relative(options.repo, file) : file))
                .filter((file) => edited.has(file));
            const hitFiles = new Set(editedResultFiles);
            const missed = [...edited].filter((file) => !hitFiles.has(file)).sort();
            return {
                ms: Math.round(performance.now() - started),
                hits: hitFiles.size,
                resultCount: response?.results?.length ?? 0,
                editedResultCount: editedResultFiles.length,
                ...(missed.length > 0 ? { missedCount: missed.length, missed: missed.slice(0, 10) } : {}),
                status: response?.status,
                freshness: response?.freshness?.state ?? 'none',
                freshnessMode: response?.freshnessDecision?.mode,
                overlaidPaths: response?.freshness?.overlaidPaths?.length,
                changedFiles: response?.freshnessSummary?.changedFileCount,
                warnings: (response?.warnings ?? []).map((warning) => warning?.code ?? warning).join('|') || undefined,
                slowPhases: Object.fromEntries(Object.entries(response?.hints?.debugSearch?.phaseTimingsMs ?? {})
                    .filter(([, ms]) => ms > 100)),
                rerankerCandidates: response?.hints?.debugSearch?.providerWork?.rerankerCandidates,
                rerankerInputBytes: response?.hints?.debugSearch?.providerWork?.rerankerInputBytes,
            };
        };
        for (const file of files) pendingRestores.set(path.join(options.repo, file), fs.readFileSync(path.join(options.repo, file)));
        try {
            for (const [file, original] of pendingRestores) fs.writeFileSync(file, Buffer.concat([original, Buffer.from(`\n${comment} ${term}\n`)]));
            const saved = performance.now();
            const syncHandle = mode === 'sync' ? await startSync() : null;
            const first = await search();
            let fullHitAt = first.hits === files.length ? performance.now() : null;
            let syncResult = null;
            let syncError = null;
            const syncDone = syncHandle
                ? waitSync(syncHandle).then((result) => { syncResult = result; }, (error) => { syncError = error; })
                : null;
            // Idle trials have no sync to wait for: the overlay is the only path to a hit.
            const pollUntil = saved + (mode === 'sync' ? options.waitTimeoutMs : 10_000);
            let last = first;
            while (fullHitAt === null && performance.now() < pollUntil && syncError === null) {
                const syncEnded = syncResult !== null;
                await sleep(250);
                last = await search();
                if (last.hits === files.length) fullHitAt = performance.now();
                else if (syncEnded) break;
            }
            await syncDone;
            if (syncError) throw syncError;
            // Repeated identical searches separate a cold first search from steady state.
            const repeats = [];
            if (mode === 'idle') for (let index = 0; index < 3; index++) repeats.push(await search());
            return {
                first,
                last,
                repeats,
                saveToFullHitMs: fullHitAt === null ? null : Math.round(fullHitAt - saved),
                syncWallMs: syncResult?.wallMs == null ? null : Math.round(syncResult.wallMs),
                ...(syncResult ? { syncTiming: syncResult.timing } : {}),
            };
        } finally {
            for (const [file, original] of pendingRestores) fs.writeFileSync(file, original);
            pendingRestores.clear();
            await syncAndWait();
        }
    };

    let rssTimer;
    try {
        await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'index-probe', version: '1' } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

        let peakRssMb = 0;
        rssTimer = setInterval(() => { peakRssMb = Math.max(peakRssMb, treeRssMb(child.pid)); }, 200);
        const indexStarted = performance.now();
        requireAccepted('create', await tool('manage_index', { action: 'create', path: options.repo }));
        const operation = await waitForGeneration();
        clearInterval(rssTimer);
        console.log(`index wall ${Math.round(performance.now() - indexStarted)} ms, peak tree RSS ${Math.round(peakRssMb)} MB`);

        if (options.edit) {
            const file = path.join(options.repo, options.edit);
            const original = fs.readFileSync(file);
            fs.appendFileSync(file, file.endsWith('.py') ? '\n# satori probe edit\n' : '\n// satori probe edit\n');
            try {
                const syncStarted = performance.now();
                await tool('manage_index', { action: 'sync', path: options.repo });
                await waitForGeneration(operation.generation);
                console.log(`sync wall ${Math.round(performance.now() - syncStarted)} ms`);
            } finally {
                fs.writeFileSync(file, original);
            }
        }

        if (options.saveSearch) {
            await syncAndWait();
            const tracked = await new Promise((resolve, reject) => {
                const git = spawn('git', ['-C', options.repo, 'ls-files', '-z', `*${options.ext}`], { stdio: ['ignore', 'pipe', 'inherit'] });
                let out = '';
                git.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
                git.once('close', (code) => (code === 0 ? resolve(out.split('\0').filter(Boolean).sort()) : reject(new Error(`git ls-files exit ${code}`))));
            });
            const comment = options.ext === '.py' ? '#' : '//';
            for (const count of options.saveSearch) {
                if (count > tracked.length) fail(`--save-search ${count} exceeds ${tracked.length} tracked ${options.ext} files`);
                // Even stride over the sorted list spreads the edits across directories.
                const files = Array.from({ length: count }, (_, index) => tracked[Math.floor(index * tracked.length / count)]);
                for (const mode of ['idle', 'sync']) {
                    for (let run = 1; run <= options.runs; run++) {
                        console.log(`save-search N=${count} mode=${mode} run=${run} ${JSON.stringify(await saveSearchTrial(files, mode, comment))}`);
                    }
                }
            }
        }
    } finally {
        clearInterval(rssTimer);
        child.stdin.end();
        await new Promise((resolve) => child.once('close', resolve));
        log.end();
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }

    for (const record of perfLines) {
        const { span, ms, ...fields } = record;
        const detail = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ');
        console.log(`${String(ms).padStart(9)} ms  ${span}${detail ? `  ${detail}` : ''}`);
    }
    if (options.log) console.log(`log: ${logPath}`);
    if (options.cpuProf) console.log(`cpu profiles: ${options.cpuProf} (summarize with scripts/perf/cpuprofile.mjs)`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
