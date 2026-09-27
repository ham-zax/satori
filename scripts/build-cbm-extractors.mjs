#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith('--') && arg !== '--check') || args.filter((arg) => arg !== '--check').length > 1) {
    throw new Error('Usage: node scripts/build-cbm-extractors.mjs [--check] [<cbm-checkout>]');
}
const checkOnly = args.includes('--check');
const cbmRoot = path.resolve(args.find((arg) => arg !== '--check') ?? '/home/hamza/repo/codebase-memory-mcp');
const vendorRoot = path.join(repoRoot, 'third_party/cbm-extractor');
const grammarRoot = path.join(cbmRoot, 'internal/cbm/vendored/grammars');
const assetRoot = path.join(repoRoot, 'packages/core/assets/cbm-extractor');
const manifestPath = path.join(assetRoot, 'manifest.json');
const gluePath = path.join(assetRoot, 'cbm-extractor.js');
const emscripten = '3.1.64';
const existingAnalyzers = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'cpp', 'scala']);
const coreLanguages = new Set([
    'kotlin', 'php', 'ruby', 'swift', 'lua', 'dart', 'bash', 'elixir', 'haskell', 'ocaml',
    'perl', 'r', 'zig', 'groovy', 'erlang', 'objective-c', 'julia', 'clojure', 'fsharp',
    'elm', 'nix', 'solidity', 'sql', 'hcl', 'css', 'scss', 'html', 'yaml', 'toml', 'vue',
    'svelte', 'protobuf', 'graphql', 'dockerfile', 'makefile', 'cmake', 'powershell',
    'gdscript', 'gleam', 'commonlisp',
]);
const closureSources = [
    'internal/cbm/extract_defs.c', 'internal/cbm/helpers.c', 'internal/cbm/lang_specs.c',
    'internal/cbm/ts_runtime.c', 'src/foundation/arena.c', 'src/semantic/ast_profile.c',
    'src/simhash/minhash.c', 'satori_extractor.c', 'satori_shim.c',
];
const fixedFlags = [
    '-std=gnu11', '-D_GNU_SOURCE', '-O2', '-sSTACK_SIZE=8388608',
    '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=1073741824', '-sMODULARIZE=1',
    '-sEXPORT_NAME=createSatoriCbmExtractor', '-sENVIRONMENT=node',
    '-sEXPORTED_FUNCTIONS=["_satori_extract","_satori_result_ptr","_satori_result_len","_malloc","_free"]',
    '-sEXPORTED_RUNTIME_METHODS=HEAPU8', '-sERROR_ON_UNDEFINED_SYMBOLS=1',
];
function fail(message) { throw new Error(`CBM extractor build: ${message}`); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function filesUnder(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const filename = path.join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(filename) : entry.isFile() ? [filename] : [];
    });
}
function hashFile(hash, filename, relativeName) {
    hash.update(relativeName.replaceAll(path.sep, '/'));
    hash.update('\0');
    hash.update(readFileSync(filename));
    hash.update('\0');
}
function moduleMetadata(filename) {
    const bytes = readFileSync(filename);
    return { sizeBytes: bytes.length, sha256: sha256(bytes) };
}
async function languageMap() {
    const filename = path.join(repoRoot, 'packages/core/src/languages/cbm-language-map.ts');
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: filename,
    }).outputText;
    return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}
function grammarDirectories() {
    const byFactory = new Map();
    for (const entry of readdirSync(grammarRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(grammarRoot, entry.name);
        const parser = path.join(dir, 'parser.c');
        if (!existsSync(parser)) continue;
        const size = statSync(parser).size;
        const handle = readFileSync(parser);
        const tail = handle.subarray(Math.max(0, size - 65536)).toString('utf8');
        for (const match of tail.matchAll(/\b(tree_sitter_[A-Za-z0-9_]+)\s*\(\s*void\s*\)\s*\{/g)) {
            const matches = byFactory.get(match[1]) ?? [];
            matches.push(dir);
            byFactory.set(match[1], matches);
        }
    }
    return byFactory;
}

const { CBM_LANGUAGE_MAP, CBM_LANGUAGE_MAP_COMMIT } = await languageMap();
const commit = execFileSync('git', ['-C', cbmRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (commit !== CBM_LANGUAGE_MAP_COMMIT) fail(`CBM checkout ${commit} is not pinned ${CBM_LANGUAGE_MAP_COMMIT}`);
const dirty = execFileSync('git', ['-C', cbmRoot, 'status', '--porcelain', '--', 'internal/cbm/vendored/grammars'], { encoding: 'utf8' }).trim();
if (dirty) fail('CBM grammar checkout has uncommitted changes');
execFileSync(process.execPath, [path.join(repoRoot, 'scripts/cbm-extractor-sync.mjs'), '--check', cbmRoot], { stdio: 'pipe' });
const selected = CBM_LANGUAGE_MAP.filter((row) => row.grammarFactory && row.satoriLanguageId && !existingAnalyzers.has(row.satoriLanguageId))
    .sort((left, right) => left.cbmLanguage < right.cbmLanguage ? -1 : left.cbmLanguage > right.cbmLanguage ? 1 : 0);
if (selected.length === 0) fail('no mapped extractor languages');
const factories = [...new Set([...readFileSync(path.join(vendorRoot, 'internal/cbm/lang_specs.c'), 'utf8')
    .matchAll(/extern const TSLanguage \*(tree_sitter_[A-Za-z0-9_]+)\(void\);/g)].map((match) => match[1]))].sort();
if (factories.length < 150) fail(`only ${factories.length} grammar factories in lang_specs.c`);
const dirs = grammarDirectories();
const sourceFiles = filesUnder(vendorRoot).filter((filename) => /\.(?:c|h|inc)$/.test(filename)).sort();
const sharedHash = createHash('sha256');
for (const filename of sourceFiles) hashFile(sharedHash, filename, path.relative(vendorRoot, filename));
sharedHash.update(JSON.stringify(fixedFlags));
sharedHash.update(emscripten);

let oldManifest = null;
if (existsSync(manifestPath)) {
    try { oldManifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (error) { fail(`invalid existing manifest: ${error.message}`); }
}
let glue = existsSync(gluePath) ? readFileSync(gluePath) : null;
if (oldManifest?.glue && (!glue || sha256(glue) !== oldManifest.glue.sha256)) fail('shipped glue differs from manifest');
if (!checkOnly) {
    const version = spawnSync('emcc', ['--version'], { encoding: 'utf8' });
    if (version.status !== 0 || !new RegExp(`\\b${emscripten.replaceAll('.', '\\.')}\\b`).test(version.stdout)) {
        fail(`emcc ${emscripten} is required: ${version.error?.message ?? version.stdout.trim()}`);
    }
    mkdirSync(path.join(assetRoot, 'extended'), { recursive: true });
}

// Every compile runs in a memory-capped systemd scope with swap disabled: a
// generated parser.c can need more RAM than the machine has (COBOL's 30 MB
// parser exceeds 3 GiB even at -O0), and swapping freezes WSL. A module whose
// compile is killed by the cap is recorded as a failure and its language
// stays search-only; any other compiler error still fails the build.
const memoryMax = process.env.SATORI_BUILD_MEMORY_MAX ?? '3G';
function cappedEmcc(args) {
    return spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', `MemoryMax=${memoryMax}`,
        '-p', 'MemorySwapMax=0', 'emcc', ...args], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}
if (!checkOnly) {
    const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', 'MemoryMax=64M', 'true'], { encoding: 'utf8' });
    if (probe.status !== 0) fail(`a memory-capped systemd user scope is required: ${probe.error?.message ?? probe.stderr.trim()}`);
}
const memoryFailure = `exceeded the ${memoryMax} build memory budget`;

const modules = [];
const failures = [];
let built = 0;
let reused = 0;
const startTime = Date.now();
// SATORI_BUILD_ONLY=KOTLIN,LUA builds a subset for quick checks; the manifest
// then lists only that subset, so finish with a full build before committing.
const only = process.env.SATORI_BUILD_ONLY ? new Set(process.env.SATORI_BUILD_ONLY.split(',')) : null;
for (const row of only ? selected.filter((candidate) => only.has(candidate.cbmLanguage)) : selected) {
    const matches = dirs.get(row.grammarFactory) ?? [];
    if (matches.length !== 1) fail(`${row.cbmLanguage}: expected one ${row.grammarFactory}(void) parser, found ${matches.length}`);
    const dir = matches[0];
    const scannerC = path.join(dir, 'scanner.c');
    const scannerCC = path.join(dir, 'scanner.cc');
    if (existsSync(scannerCC)) fail(`${row.cbmLanguage}: scanner.cc requires an em++ build`);
    const grammarFiles = filesUnder(dir).filter((filename) => /\.(?:c|cc|h|inc)$/.test(filename)).sort();
    const stubs = '#include "tree_sitter/api.h"\n' + factories.filter((factory) => factory !== row.grammarFactory)
        .map((factory) => `const TSLanguage *${factory}(void) { return NULL; }`).join('\n') + '\n';
    const sourceHash = sharedHash.copy();
    sourceHash.update(row.cbmLanguage);
    sourceHash.update('\0');
    sourceHash.update(stubs);
    for (const filename of grammarFiles) hashFile(sourceHash, filename, path.relative(dir, filename));
    const sourceSha256 = sourceHash.digest('hex');
    const pack = coreLanguages.has(row.satoriLanguageId) ? 'core' : 'extended';
    const file = `${row.cbmLanguage.toLowerCase()}.wasm`;
    const output = path.join(assetRoot, pack === 'core' ? '' : 'extended', file);
    const previous = oldManifest?.modules?.find((entry) => entry.cbmLanguage === row.cbmLanguage &&
        entry.sourceSha256 === sourceSha256 && entry.pack === pack && entry.file === file);
    const cached = previous && existsSync(output) && previous.sizeBytes === statSync(output).size &&
        previous.sha256 === moduleMetadata(output).sha256;
    const knownFailure = oldManifest?.failures?.find((entry) => entry.cbmLanguage === row.cbmLanguage &&
        entry.sourceSha256 === sourceSha256 && entry.reason === memoryFailure);
    if (knownFailure) {
        failures.push(knownFailure);
        continue;
    }
    const absentExtended = checkOnly && pack === 'extended' && previous && !existsSync(output);
    if (checkOnly && !cached && !absentExtended) fail(`${row.cbmLanguage}: source or module is stale`);
    if (!cached && !absentExtended) {
        const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'satori-cbm-extractor-'));
        try {
            const tempJs = path.join(tempRoot, 'cbm-extractor.js');
            const tempWasm = path.join(tempRoot, 'cbm-extractor.wasm');
            const tempStubs = path.join(tempRoot, 'stubs.c');
            writeFileSync(tempStubs, stubs);
            const includes = [
                path.join(vendorRoot, 'internal/cbm/vendored/ts_runtime/include'),
                path.join(vendorRoot, 'internal/cbm/vendored/ts_runtime/src'),
                path.join(vendorRoot, 'internal/cbm'), path.join(vendorRoot, 'src'),
                path.join(vendorRoot, 'vendored'), dir,
            ];
            const sources = closureSources.map((name) => path.join(vendorRoot, name));
            const command = [
                '-std=gnu11', '-D_GNU_SOURCE', '-O2', `-DSATORI_CBM_LANG=CBM_LANG_${row.cbmLanguage}`,
                ...includes.flatMap((include) => [`-I${include}`]), ...sources, tempStubs,
                path.join(dir, 'parser.c'), ...(existsSync(scannerC) ? [scannerC] : []),
                ...fixedFlags.slice(3), '-o', tempJs,
            ];
            let result = cappedEmcc(command);
            // Grammars whose static tables exceed the default 16 MiB initial
            // memory (e.g. Lean) are relinked with the size wasm-ld reports,
            // rounded up to 1 MiB. The emitted glue does not depend on it.
            const needed = /initial memory too small, (\d+) bytes needed/.exec(result.stderr ?? '');
            if (result.status !== 0 && needed) {
                const initialMemory = Math.ceil(Number(needed[1]) / 1048576) * 1048576;
                result = cappedEmcc([...command, `-sINITIAL_MEMORY=${initialMemory}`]);
            }
            // An OOM kill inside the scope surfaces as 137/SIGKILL, or as emcc exiting
            // non-zero after its compiler child died silently (empty stderr).
            const oomKilled = result.status === 137 || result.signal === 'SIGKILL'
                || (result.status !== 0 && !result.error && (!result.stderr.trim() || /killed|signal 9/i.test(result.stderr)));
            if (oomKilled) {
                failures.push({ cbmLanguage: row.cbmLanguage, satoriLanguageId: row.satoriLanguageId, sourceSha256, reason: memoryFailure });
                console.log(`skipped ${row.cbmLanguage}: ${memoryFailure}`);
                continue;
            }
            if (result.status !== 0) {
                // Record and keep going so the manifest (and the modules already
                // built) survive; the run still exits non-zero below.
                const detail = result.error?.message ?? result.stderr.trim().split('\n').find((line) => /error:/.test(line)) ?? `exit ${result.status}`;
                failures.push({ cbmLanguage: row.cbmLanguage, satoriLanguageId: row.satoriLanguageId, sourceSha256, reason: `emcc failed: ${detail}` });
                console.log(`failed ${row.cbmLanguage}: ${detail}`);
                continue;
            }
            const emittedGlue = readFileSync(tempJs);
            if (glue && !glue.equals(emittedGlue)) {
                const index = glue.findIndex((byte, position) => byte !== emittedGlue[position]);
                fail(`${row.cbmLanguage}: emitted JS differs from shared glue at byte ${index < 0 ? Math.min(glue.length, emittedGlue.length) : index}`);
            }
            glue = emittedGlue;
            copyFileSync(tempWasm, output);
            if (!existsSync(gluePath)) writeFileSync(gluePath, glue);
            built++;
            console.log(`built ${row.cbmLanguage} (${pack}, ${(statSync(output).size / 1048576).toFixed(2)} MiB)`);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    } else reused++;
    const metadata = absentExtended ? { sizeBytes: previous.sizeBytes, sha256: previous.sha256 } : moduleMetadata(output);
    modules.push({ cbmLanguage: row.cbmLanguage, satoriLanguageId: row.satoriLanguageId, file,
        ...metadata, sourceSha256, pack });
}
if (!glue) fail('no shared Emscripten glue');
const manifest = { schemaVersion: 1, cbmCommit: commit, emscripten,
    glue: { file: 'cbm-extractor.js', sha256: sha256(glue) }, modules, failures };
const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
if (checkOnly) {
    if (readFileSync(manifestPath, 'utf8') !== rendered) fail('manifest is stale');
    console.log(`Manifest current: ${modules.length} modules`);
} else {
    writeFileSync(manifestPath, rendered);
    console.log(`Manifest written: ${modules.length} modules, ${built} built, ${reused} reused, ${((Date.now() - startTime) / 1000).toFixed(1)} s`);
}
const buildErrors = failures.filter((entry) => entry.reason !== memoryFailure);
if (buildErrors.length > 0) fail(`emcc failed for ${buildErrors.map((entry) => entry.cbmLanguage).join(', ')}`);
