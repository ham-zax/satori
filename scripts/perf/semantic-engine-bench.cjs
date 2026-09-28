#!/usr/bin/env node
// Times the CBM semantic engine on one language of a repository and hashes its
// decoded results (compare hashes across engine builds for byte-identical output).
//
//   node scripts/perf/semantic-engine-bench.cjs <repo> [language=go] [extension=.go] [--engine <engine.js>]
// --engine defaults to the shipped asset; build a profiling copy with
// scripts/perf/build-named-semantic-engine.mjs and run under `node --cpu-prof`.
// Only Go auxiliaries (go.mod) are supplied; other languages run without manifests.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const { WasmSemanticEngine } = require(path.join(ROOT, 'packages/core/dist/semantic/wasm/wasm-engine.js'));

(async () => {
    const args = process.argv.slice(2);
    const engineAt = args.indexOf('--engine');
    const enginePath = engineAt >= 0 ? path.resolve(args.splice(engineAt, 2)[1]) : path.join(ROOT, 'packages/core/assets/semantic-engine/satori-semantic-engine.js');
    const [repoArg, language = 'go', extension = '.go'] = args;
    const repo = path.resolve(repoArg);
    const native = await require(enginePath)();
    const session = await new WasmSemanticEngine(native).createSession(language);
    let files = 0;
    for (const file of execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }).split('\n').filter((entry) => entry.endsWith(extension))) {
        const source = fs.readFileSync(path.join(repo, file), 'utf8');
        if (Buffer.byteLength(source) > 1_048_576) continue;
        session.addSource(file, source);
        files++;
    }
    if (language === 'go') {
        for (const file of execFileSync('git', ['-C', repo, 'ls-files', '*go.mod'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
            session.addAuxiliary('manifest', file, fs.readFileSync(path.join(repo, file), 'utf8'));
        }
    }
    const startedAt = performance.now();
    const results = await session.resolve();
    const ms = performance.now() - startedAt;
    const hash = crypto.createHash('sha256').update(JSON.stringify(results)).digest('hex').slice(0, 16);
    console.log(`${language} files=${files} resolve=${Math.round(ms)}ms results=${results.length} hash=${hash}`);
    session.destroy();
})();
