#!/usr/bin/env node
// Ratchet gate for deterministic performance metrics.
//
//   node ratchet.mjs check  <baseline.json> <metrics.json> [--tolerance 0.005]
//   node ratchet.mjs update <baseline.json> <metrics.json> [--tolerance 0.005]
//
// baseline.json: { "<metric>": { "ceiling": <number>, "unit": "instructions" } , ... }
// metrics.json:  { "<metric>": <number>, ... }   (lower is better for every metric)
//
// check  fails (exit 1) when any metric exceeds ceiling * (1 + tolerance), or when a
//        baselined metric is missing from metrics.json.
// update runs check first, then lowers each ceiling to the measured value when it
//        improved. It never raises a ceiling: a deliberate regression is a reviewed
//        edit to baseline.json, not a flag.
// New metrics in metrics.json are reported and, on update, added at their value.

import fs from 'node:fs';

const [mode, baselinePath, metricsPath, ...rest] = process.argv.slice(2);
if (!['check', 'update'].includes(mode) || !baselinePath || !metricsPath) {
    console.error('usage: ratchet.mjs check|update <baseline.json> <metrics.json> [--tolerance 0.005]');
    process.exit(2);
}
const tolIdx = rest.indexOf('--tolerance');
const tolerance = tolIdx >= 0 ? Number(rest[tolIdx + 1]) : 0.005;
if (!Number.isFinite(tolerance) || tolerance < 0) {
    console.error('--tolerance must be a non-negative number');
    process.exit(2);
}

const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};
const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));

let failed = false;
const lines = [];
for (const name of Object.keys(baseline).sort()) {
    const { ceiling } = baseline[name];
    const value = metrics[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        failed = true;
        lines.push(`MISSING   ${name}`);
        continue;
    }
    const delta = ((value - ceiling) / ceiling) * 100;
    const pct = `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`;
    if (value > ceiling * (1 + tolerance)) {
        failed = true;
        lines.push(`REGRESSED ${name}: ${value} > ceiling ${ceiling} (${pct})`);
    } else if (value < ceiling) {
        lines.push(`IMPROVED  ${name}: ${value} < ceiling ${ceiling} (${pct})`);
        if (mode === 'update') baseline[name].ceiling = value;
    } else {
        lines.push(`OK        ${name}: ${value} (ceiling ${ceiling}, ${pct})`);
    }
}
for (const name of Object.keys(metrics).sort()) {
    if (name in baseline) continue;
    lines.push(`NEW       ${name}: ${metrics[name]}`);
    if (mode === 'update') baseline[name] = { ceiling: metrics[name] };
}
console.log(lines.join('\n'));

if (failed) {
    console.error('ratchet: FAIL');
    process.exit(1);
}
if (mode === 'update') {
    const sorted = Object.fromEntries(Object.keys(baseline).sort().map((k) => [k, baseline[k]]));
    fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`ratchet: baseline written to ${baselinePath}`);
}
