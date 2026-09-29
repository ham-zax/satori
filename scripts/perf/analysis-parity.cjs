#!/usr/bin/env node
// Every tracked file of <repo> analyzed in-process and through the language
// analysis worker pool must produce deep-equal results; also reports timings.
//
//   node scripts/perf/analysis-parity.cjs <repo> [--workers 6]
// Requires `pnpm --filter @satori-code/core build`.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const { createLanguageAnalysisService, createParallelLanguageAnalysisService } = require(path.join(ROOT, 'packages/core/dist/language-analysis'));
const { detectLanguageId } = require(path.join(ROOT, 'packages/core/dist/language/registry'));

(async () => {
    const repo = path.resolve(process.argv[2] ?? '');
    const workersAt = process.argv.indexOf('--workers');
    const workers = workersAt > 0 ? Number(process.argv[workersAt + 1]) : 6;
    const options = { chunkSize: 2500, chunkOverlap: 300 };
    const local = createLanguageAnalysisService(options);
    const pool = createParallelLanguageAnalysisService(options, workers);
    const inputs = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).flatMap((file) => {
        let bytes;
        try { bytes = fs.readFileSync(path.join(repo, file)); } catch { return []; }
        if (bytes.length > 1e6 || bytes.includes(0)) return [];
        const content = bytes.toString('utf8');
        return [{ content, relativePath: file, language: detectLanguageId(file, content) }];
    });
    let startedAt = performance.now();
    const expected = [];
    for (const input of inputs) expected.push(await local.analyze(input));
    const serialMs = performance.now() - startedAt;
    startedAt = performance.now();
    const actual = await Promise.all(inputs.map((input) => pool.analyze(input)));
    const poolMs = performance.now() - startedAt;
    let differing = 0;
    for (let i = 0; i < inputs.length; i++) {
        try { assert.deepStrictEqual(actual[i], expected[i]); } catch {
            differing++;
            if (differing <= 5) console.log(`DIFF ${inputs[i].relativePath}`);
        }
    }
    console.log(`files=${inputs.length} differing=${differing} serial=${Math.round(serialMs)}ms pool(${workers})=${Math.round(poolMs)}ms`);
    await pool.dispose();
    if (differing > 0) process.exitCode = 1;
})();
