#!/usr/bin/env node
// Summarizes V8 .cpuprofile files (from `node --cpu-prof`, or index-probe --cpu-prof).
//
//   node scripts/perf/cpuprofile.mjs self <profile> [limit]              top functions by self time
//   node scripts/perf/cpuprofile.mjs inclusive <profile> [urlFilter] [limit]
//                                                                         inclusive time per function whose URL contains urlFilter
//   node scripts/perf/cpuprofile.mjs subtree <profile> <function> [limit] inclusive time of everything called under <function>
//   node scripts/perf/cpuprofile.mjs callers <profile> <function> [depth] which call chains reach <function>
//
// Async boundaries break V8 call stacks, so inclusive numbers undercount work
// that crosses an await. WASM frames have names only when built with
// --profiling-funcs (see build-named-semantic-engine.mjs).

import fs from 'node:fs';

function load(file) {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const parent = new Map();
    for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
    const label = (id) => {
        const frame = byId.get(id).callFrame;
        return `${frame.functionName || '(anonymous)'} ${frame.url.split('/').slice(-2).join('/')}:${frame.lineNumber + 1}`;
    };
    const stack = (id) => {
        const chain = [];
        for (let current = id; current !== undefined; current = parent.get(current)) chain.push(current);
        return chain;
    };
    return { profile, byId, label, stack };
}

function print(entries, limit, total) {
    if (total !== undefined) console.log(`total ${(total / 1000).toFixed(0)} ms`);
    for (const [key, micros] of [...entries].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
        console.log(`${(micros / 1000).toFixed(0).padStart(8)} ms  ${key}`);
    }
}

const [mode, file, arg, extra] = process.argv.slice(2);
if (!mode || !file) {
    console.error('usage: cpuprofile.mjs <self|inclusive|subtree|callers> <profile> [...]');
    process.exit(2);
}
const { profile, byId, label, stack } = load(file);
const samples = profile.samples.map((id, index) => [id, profile.timeDeltas[index] ?? 0]);
const totals = new Map();
let total = 0;

switch (mode) {
    case 'self':
        for (const [id, micros] of samples) {
            total += micros;
            totals.set(label(id), (totals.get(label(id)) ?? 0) + micros);
        }
        print(totals, Number(arg ?? 25), total);
        break;
    case 'inclusive': {
        const filter = arg ?? '';
        for (const [id, micros] of samples) {
            total += micros;
            const seen = new Set();
            for (const frame of stack(id)) {
                if (!byId.get(frame).callFrame.url.includes(filter)) continue;
                const key = label(frame);
                if (seen.has(key)) continue;
                seen.add(key);
                totals.set(key, (totals.get(key) ?? 0) + micros);
            }
        }
        print(totals, Number(extra ?? 30), total);
        break;
    }
    case 'subtree': {
        if (!arg) throw new Error('subtree needs a function name');
        for (const [id, micros] of samples) {
            const chain = stack(id).map(label);
            const rootAt = chain.findIndex((entry) => entry.startsWith(`${arg} `));
            if (rootAt < 0) continue;
            total += micros;
            const seen = new Set();
            for (const key of chain.slice(0, rootAt)) {
                if (seen.has(key)) continue;
                seen.add(key);
                totals.set(key, (totals.get(key) ?? 0) + micros);
            }
        }
        print(totals, Number(extra ?? 30), total);
        break;
    }
    case 'callers': {
        if (!arg) throw new Error('callers needs a function name');
        const depth = Number(extra ?? 3);
        for (const [id, micros] of samples) {
            const chain = stack(id).map(label);
            const at = chain.findIndex((entry) => entry.startsWith(`${arg} `));
            if (at < 0) continue;
            total += micros;
            const key = chain.slice(at + 1, at + 1 + depth).join(' < ') || '(root)';
            totals.set(key, (totals.get(key) ?? 0) + micros);
        }
        print(totals, 10, total);
        break;
    }
    default:
        console.error(`unknown mode ${mode}`);
        process.exit(2);
}
