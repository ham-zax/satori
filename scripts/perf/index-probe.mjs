#!/usr/bin/env node
// Full-index probe: indexes one repository through the built MCP server (offline
// Potion + LanceDB + LateOn, isolated HOME), optionally edits one file and syncs,
// and prints Satori's own timing records (SATORI_PERF_TRACE) plus wall time.
//
//   node scripts/perf/index-probe.mjs <repo> [--edit <relative file>] [--log <file>] [--cpu-prof <dir>]
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
    const options = { repo: null, edit: null, log: null, cpuProf: null };
    for (let i = 0; i < argv.length; i++) {
        const next = () => argv[++i] ?? fail(`${argv[i - 1]} needs a value`);
        switch (argv[i]) {
            case '--edit': options.edit = next(); break;
            case '--log': options.log = path.resolve(next()); break;
            case '--cpu-prof': options.cpuProf = path.resolve(next()); break;
            default:
                if (options.repo) fail(`unexpected argument ${argv[i]}`);
                options.repo = path.resolve(argv[i]);
        }
    }
    if (!options.repo) fail('usage: index-probe.mjs <repo> [--edit <file>] [--log <file>] [--cpu-prof <dir>]');
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

    const request = (method, params) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = async (name, args) => {
        const result = await request('tools/call', { name, arguments: args });
        const text = (result?.content ?? []).map((item) => item.text).join('');
        try { return JSON.parse(text); } catch { return null; }
    };
    const waitForGeneration = async (previousGeneration) => {
        for (;;) {
            const operation = (await tool('manage_index', { action: 'status', path: options.repo }))?.operation;
            if (operation && (previousGeneration === undefined || operation.generation > previousGeneration)) {
                if (operation.phase === 'completed') return operation;
                if (operation.phase === 'failed') throw new Error(`operation failed: ${JSON.stringify(operation).slice(0, 300)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    };

    let rssTimer;
    try {
        await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'index-probe', version: '1' } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

        let peakRssMb = 0;
        rssTimer = setInterval(() => { peakRssMb = Math.max(peakRssMb, treeRssMb(child.pid)); }, 200);
        const indexStarted = performance.now();
        await tool('manage_index', { action: 'create', path: options.repo });
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
