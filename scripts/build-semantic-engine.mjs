#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
    REPO_ROOT,
    CBM_SRC_DIR,
    ASSETS_DIR,
    MANIFEST_PATH,
    JS_PATH,
    WASM_PATH,
    PINNED_UPSTREAM_COMMIT,
    PINNED_EMSCRIPTEN_VERSION,
    COMPILE_UNITS,
    INCLUDE_DIRS,
    COMPILER_FLAGS,
    EXPORTED_FUNCTIONS,
    EXPORTED_RUNTIME_METHODS,
    computeLogicalRecipeDigest,
    computeSourceDigest,
} from './semantic-engine-build-config.mjs';

const localRequire = createRequire(import.meta.url);

function findEmcc() {
    const candidatePaths = [
        'emcc',
        path.join(process.env.HOME || '', 'emsdk', 'upstream', 'emscripten', 'emcc'),
        path.join(process.env.HOME || '', '.emsdk', 'upstream', 'emscripten', 'emcc'),
        '/opt/emsdk/upstream/emscripten/emcc',
    ];

    for (const candidate of candidatePaths) {
        try {
            const output = execFileSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            return { path: candidate, versionOutput: output.split('\n')[0] };
        } catch {
            // try next
        }
    }
    return null;
}

async function build() {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    const sourceDigest = computeSourceDigest();
    const buildRecipeDigest = computeLogicalRecipeDigest();
    const emcc = findEmcc();

    if (!emcc) {
        throw new Error(`Emscripten (${PINNED_EMSCRIPTEN_VERSION}) not found. Please install and activate emsdk.`);
    }

    const versionMatch = emcc.versionOutput.match(/emcc.*?(\d+\.\d+\.\d+)/);
    const foundVersion = versionMatch ? versionMatch[1] : null;
    if (foundVersion !== PINNED_EMSCRIPTEN_VERSION) {
        throw new Error(`Emscripten version mismatch: found "${foundVersion}" (${emcc.versionOutput}), expected strictly "${PINNED_EMSCRIPTEN_VERSION}".`);
    }

    console.log(`Found Emscripten: ${emcc.versionOutput}`);
    const cSources = COMPILE_UNITS.map(f => path.join(CBM_SRC_DIR, f));
    const includeFlags = INCLUDE_DIRS.map(d => `-I${path.join(CBM_SRC_DIR, d)}`);

    const tempDir = fs.mkdtempSync(path.join(ASSETS_DIR, '.tmp-build-'));
    const tempJsPath = path.join(tempDir, 'satori-semantic-engine.js');
    const tempWasmPath = path.join(tempDir, 'satori-semantic-engine.wasm');

    const emccArgs = [
        ...COMPILER_FLAGS,
        ...includeFlags,
        ...cSources,
        `-sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONS.map(f => `'${f}'`).join(',')}]`,
        `-sEXPORTED_RUNTIME_METHODS=[${EXPORTED_RUNTIME_METHODS.map(m => `'${m}'`).join(',')}]`,
        '-o', tempJsPath,
    ];

    try {
        console.log(`Compiling WASM semantic engine in temporary directory ${tempDir}...`);
        execFileSync(emcc.path, emccArgs, { stdio: 'inherit', cwd: REPO_ROOT });

        if (!fs.existsSync(tempJsPath) || !fs.existsSync(tempWasmPath)) {
            throw new Error(`Build failed or artifacts missing in temp dir: ${tempJsPath} / ${tempWasmPath}`);
        }

        const jsBytes = fs.readFileSync(tempJsPath);
        const wasmBytes = fs.readFileSync(tempWasmPath);
        if (jsBytes.length === 0 || wasmBytes.length === 0) {
            throw new Error(`Built artifacts are empty: JS ${jsBytes.length} bytes, WASM ${wasmBytes.length} bytes`);
        }

        // Validate candidate module instantiation
        const createCandidate = localRequire(tempJsPath);
        const candidateInstance = await createCandidate();
        const abiVersion = candidateInstance._satori_semantic_abi_version();
        if (abiVersion !== 1) {
            throw new Error(`Candidate engine returned invalid ABI version: ${abiVersion}`);
        }

        const jsSha256 = crypto.createHash('sha256').update(jsBytes).digest('hex');
        const wasmSha256 = crypto.createHash('sha256').update(wasmBytes).digest('hex');

        // Atomically replace assets into place on the same filesystem
        fs.renameSync(tempJsPath, JS_PATH);
        fs.renameSync(tempWasmPath, WASM_PATH);

        const manifest = {
            abiVersion: 1,
            upstreamCommit: PINNED_UPSTREAM_COMMIT,
            emscriptenVersion: PINNED_EMSCRIPTEN_VERSION,
            semanticSourceDigest: sourceDigest,
            buildRecipeDigest,
            jsSha256,
            wasmSha256,
            languages: {
                go: {
                    semanticRevision: 'go-v1',
                    grammar: 'tree-sitter-go',
                },
            },
        };

        // Manifest written last
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        console.log(`✔ Generated manifest at ${MANIFEST_PATH}`);
        console.log(`  Source Digest: ${sourceDigest}`);
        console.log(`  Recipe Digest: ${buildRecipeDigest}`);
        console.log(`  JS Digest:     ${jsSha256}`);
        console.log(`  WASM Digest:   ${wasmSha256}`);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

await build();
