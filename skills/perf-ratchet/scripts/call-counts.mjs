#!/usr/bin/env node
// Counts JavaScript function calls made by a Node command, using V8 precise
// coverage (NODE_V8_COVERAGE records exact per-function call counts). Call
// counts are deterministic for a fixed input and explain *why* instruction counts
// moved: a function called 3x per item instead of 1x shows up directly.
//
//   node call-counts.mjs [--filter SUBSTR] [--top N] [--json FILE] -- <command> [args...]
//
// --filter keeps only scripts whose URL contains SUBSTR (e.g. your package dir).
// --json writes { totalCalls, functions: [{ name, url, line, calls }] } for ratchets.
// The command must exit normally (not via SIGKILL) for coverage to be written.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
if (sep < 0 || sep === args.length - 1) {
    console.error('usage: call-counts.mjs [--filter SUBSTR] [--top N] [--json FILE] -- <command> [args...]');
    process.exit(2);
}
const opts = { filter: '', top: 25, json: '' };
for (let i = 0; i < sep; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!(key in opts) || args[i + 1] === undefined) {
        console.error(`unknown or incomplete option: ${args[i]}`);
        process.exit(2);
    }
    opts[key] = key === 'top' ? Number(args[i + 1]) : args[i + 1];
}
const [cmd, ...cmdArgs] = args.slice(sep + 1);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-counts-'));
try {
    const run = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: dir } });
    if (run.error) throw run.error;
    if (run.status !== 0) console.error(`warning: command exited with ${run.status ?? run.signal}`);

    // Coverage ranges are byte offsets; map the function start to a line when the source is readable.
    const lineOf = new Map();
    const lineFor = (url, offset) => {
        if (!url.startsWith('file://')) return 0;
        if (!lineOf.has(url)) {
            let starts = null;
            try {
                const text = fs.readFileSync(new URL(url), 'utf8');
                starts = [0];
                for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
            } catch {}
            lineOf.set(url, starts);
        }
        const starts = lineOf.get(url);
        if (!starts) return 0;
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    };

    const byKey = new Map();
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        const { result } = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        for (const script of result) {
            if (!script.url || script.url.startsWith('node:')) continue;
            if (opts.filter && !script.url.includes(opts.filter)) continue;
            for (const fn of script.functions) {
                const calls = fn.ranges[0]?.count ?? 0;
                if (calls === 0 || (!fn.functionName && fn.ranges[0].startOffset === 0)) continue; // skip module top level
                const line = lineFor(script.url, fn.ranges[0].startOffset);
                const key = `${script.url}:${line}:${fn.functionName}`;
                const entry = byKey.get(key) ?? { name: fn.functionName || '(anonymous)', url: script.url, line, calls: 0 };
                entry.calls += calls;
                byKey.set(key, entry);
            }
        }
    }

    // Stable order: calls desc, then location, so equal inputs give identical output.
    const functions = [...byKey.values()].sort(
        (a, b) => b.calls - a.calls || a.url.localeCompare(b.url) || a.line - b.line || a.name.localeCompare(b.name),
    );
    const totalCalls = functions.reduce((sum, f) => sum + f.calls, 0);
    console.log(`calls ${totalCalls}`);
    for (const f of functions.slice(0, opts.top)) {
        console.log(`${String(f.calls).padStart(12)}  ${f.name}  ${f.url.split('/').slice(-2).join('/')}:${f.line}`);
    }
    if (opts.json) fs.writeFileSync(opts.json, `${JSON.stringify({ totalCalls, functions }, null, 2)}\n`);
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
