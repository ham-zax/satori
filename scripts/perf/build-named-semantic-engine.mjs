#!/usr/bin/env node
// Builds a profiling copy of the semantic engine with WASM function names
// (--profiling-funcs) into <outDir>, leaving the shipped asset untouched.
//
//   node scripts/perf/build-named-semantic-engine.mjs <outDir>
// Then: node --cpu-prof scripts/perf/semantic-engine-bench.cjs <repo> go .go --engine <outDir>/satori-semantic-engine.js
// Uses the same emcc lookup and flags as scripts/build-semantic-engine.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    CBM_SRC_DIR,
    COMPILE_UNITS,
    COMPILER_FLAGS,
    EXPORTED_FUNCTIONS,
    EXPORTED_RUNTIME_METHODS,
    INCLUDE_DIRS,
    REPO_ROOT,
} from '../semantic-engine-build-config.mjs';

const outDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
    console.error('usage: build-named-semantic-engine.mjs <outDir>');
    process.exit(2);
}
const emcc = [
    'emcc',
    path.join(process.env.HOME ?? '', 'emsdk/upstream/emscripten/emcc'),
    path.join(process.env.HOME ?? '', '.emsdk/upstream/emscripten/emcc'),
].find((candidate) => {
    try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
});
if (!emcc) throw new Error('emcc not found');
fs.mkdirSync(outDir, { recursive: true });
execFileSync(emcc, [
    ...COMPILER_FLAGS,
    '--profiling-funcs',
    ...INCLUDE_DIRS.map((dir) => `-I${path.join(CBM_SRC_DIR, dir)}`),
    ...COMPILE_UNITS.map((file) => path.join(CBM_SRC_DIR, file)),
    `-sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONS.map((name) => `'${name}'`).join(',')}]`,
    `-sEXPORTED_RUNTIME_METHODS=[${EXPORTED_RUNTIME_METHODS.map((name) => `'${name}'`).join(',')}]`,
    '-o', path.join(outDir, 'satori-semantic-engine.js'),
], { stdio: 'inherit', cwd: REPO_ROOT });
console.log(`built ${path.join(outDir, 'satori-semantic-engine.js')}`);
