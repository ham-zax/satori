import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');

export const CBM_SRC_DIR = path.join(REPO_ROOT, 'third_party', 'cbm-semantic');
export const ASSETS_DIR = path.join(REPO_ROOT, 'packages', 'core', 'assets', 'semantic-engine');
export const MANIFEST_PATH = path.join(ASSETS_DIR, 'semantic-engine.manifest.json');
export const DESCRIPTOR_PATH = path.join(ASSETS_DIR, 'semantic-languages.json');
export const SCHEMA_PATH = path.join(ASSETS_DIR, 'semantic-languages.schema.json');
export const JS_PATH = path.join(ASSETS_DIR, 'satori-semantic-engine.js');
export const WASM_PATH = path.join(ASSETS_DIR, 'satori-semantic-engine.wasm');

export const PINNED_UPSTREAM_COMMIT = 'd150ebe4fc78a9a3f85013d2087a849e5d59eb0f';
export const PINNED_EMSCRIPTEN_VERSION = '3.1.64';

export const COMPILE_UNITS = [
    'common/arena.c',
    'common/scope.c',
    'common/type_rep.c',
    'common/type_registry.c',
    'languages/go/go_lsp.c',
    'languages/go/go_stdlib_data.c',
    'tree_sitter/lib.c',
    'grammars/tree-sitter-go/parser.c',
    'satori_semantic.c',
];

export const INCLUDE_DIRS = [
    '.',
    'common',
    'minimal-compat',
    'languages/go',
    'tree_sitter',
];

export const COMPILER_FLAGS = [
    '-std=c11',
    '-D_GNU_SOURCE',
    '-O3',
    '-sENVIRONMENT=node',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sINITIAL_MEMORY=67108864',
    '-sMAXIMUM_MEMORY=1073741824',
    '-sSTACK_SIZE=2097152',
    '-sASSERTIONS=1',
    '-sMODULARIZE=1',
    '-sEXPORT_NAME=createSatoriSemanticEngine',
];

export const EXPORTED_FUNCTIONS = [
    '_malloc',
    '_free',
    '_satori_semantic_abi_version',
    '_satori_semantic_engine_version',
    '_satori_semantic_global_last_error_message',
    '_satori_semantic_last_error_message',
    '_satori_semantic_last_error',
    '_satori_semantic_create',
    '_satori_semantic_add_auxiliary',
    '_satori_semantic_add_source',
    '_satori_semantic_resolve',
    '_satori_semantic_destroy',
    '_satori_semantic_free',
    '_satori_semantic_result_count',
    '_satori_semantic_results',
    '_satori_semantic_relationship_count',
    '_satori_semantic_relationships',
    '_satori_semantic_definition_count',
    '_satori_semantic_definitions',
    '_satori_semantic_diagnostic_count',
    '_satori_semantic_diagnostics',
    '_satori_semantic_string_table',
    '_satori_semantic_go_smoke',
];

export const EXPORTED_RUNTIME_METHODS = [
    'ccall',
    'cwrap',
    'getValue',
    'setValue',
    'UTF8ToString',
    'stringToUTF8',
    'HEAPU8',
    'HEAP32',
    'HEAPF32',
];

export function computeLogicalRecipeDigest() {
    const logicalRecipe = {
        compiler: PINNED_EMSCRIPTEN_VERSION,
        upstreamCommit: PINNED_UPSTREAM_COMMIT,
        sources: COMPILE_UNITS,
        includes: INCLUDE_DIRS,
        flags: COMPILER_FLAGS,
        exportedFunctions: EXPORTED_FUNCTIONS,
        exportedRuntimeMethods: EXPORTED_RUNTIME_METHODS,
    };
    return crypto.createHash('sha256').update(JSON.stringify(logicalRecipe)).digest('hex');
}

export function computeSourceDigest(rootDir = CBM_SRC_DIR) {
    const files = [];

    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                if (['.c', '.h'].includes(ext)) {
                    files.push(fullPath);
                }
            }
        }
    }

    walk(rootDir);
    files.sort();

    const hash = crypto.createHash('sha256');
    for (const file of files) {
        const rel = path.relative(rootDir, file).replace(/\\/g, '/');
        const content = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        hash.update(`${rel}\n${content}\n`);
    }

    return hash.digest('hex');
}

const ALLOWED_STRATEGIES = new Set(['cbm_semantic']);
const ALLOWED_DESCRIPTOR_KEYS = new Set([
    'language',
    'canonicalLanguage',
    'extensions',
    'strategy',
    'semanticRevision',
    'grammar',
    'auxiliaryFiles',
    'providerId',
    'providerVersion',
    'environmentConfigId',
]);
const ALLOWED_AUXILIARY_KEYS = new Set(['pattern', 'role']);

export function validateSemanticLanguagesConfig(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid semantic language configuration: root must be a JSON object');
    }
    if (!Array.isArray(raw.languages) || raw.languages.length === 0) {
        throw new Error("Invalid semantic language configuration: 'languages' must be a non-empty array");
    }

    const seenCanonical = new Set();
    for (let i = 0; i < raw.languages.length; i++) {
        const entry = raw.languages[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`Invalid descriptor at index ${i}: must be an object`);
        }
        for (const key of Object.keys(entry)) {
            if (!ALLOWED_DESCRIPTOR_KEYS.has(key)) {
                throw new Error(`Invalid descriptor at index ${i}: unknown property '${key}'`);
            }
        }
        if (typeof entry.language !== 'string' || !entry.language.trim()) {
            throw new Error(`Invalid descriptor at index ${i}: 'language' must be a non-empty string`);
        }
        if (typeof entry.canonicalLanguage !== 'string' || !entry.canonicalLanguage.trim()) {
            throw new Error(`Invalid descriptor '${entry.language}': 'canonicalLanguage' must be a non-empty string`);
        }
        const canonical = entry.canonicalLanguage.toLowerCase();
        if (seenCanonical.has(canonical)) {
            throw new Error(`Duplicate descriptor for canonical language '${canonical}'`);
        }
        seenCanonical.add(canonical);

        if (typeof entry.strategy !== 'string' || !ALLOWED_STRATEGIES.has(entry.strategy)) {
            throw new Error(`Invalid descriptor '${entry.language}': 'strategy' must be one of [${[...ALLOWED_STRATEGIES].join(', ')}], saw '${entry.strategy}'`);
        }
        if (typeof entry.semanticRevision !== 'string' || !entry.semanticRevision.trim()) {
            throw new Error(`Invalid descriptor '${entry.language}': 'semanticRevision' must be non-empty`);
        }
        if (typeof entry.grammar !== 'string' || !entry.grammar.trim()) {
            throw new Error(`Invalid descriptor '${entry.language}': 'grammar' must be non-empty`);
        }
        if (!Array.isArray(entry.extensions) || entry.extensions.length === 0) {
            throw new Error(`Invalid descriptor '${entry.language}': 'extensions' must be non-empty array`);
        }
        for (let extIdx = 0; extIdx < entry.extensions.length; extIdx++) {
            const ext = entry.extensions[extIdx];
            if (typeof ext !== 'string' || !/^\.[a-zA-Z0-9_-]+$/.test(ext)) {
                throw new Error(`Invalid descriptor '${entry.language}': extension at index ${extIdx} must match pattern ^\\.[a-zA-Z0-9_-]+$ (e.g. '.go')`);
            }
        }
        if (!Array.isArray(entry.auxiliaryFiles)) {
            throw new Error(`Invalid descriptor '${entry.language}': 'auxiliaryFiles' must be an array`);
        }
        for (let aIdx = 0; aIdx < entry.auxiliaryFiles.length; aIdx++) {
            const aux = entry.auxiliaryFiles[aIdx];
            if (!aux || typeof aux !== 'object' || Array.isArray(aux)) {
                throw new Error(`Invalid auxiliary entry at ${aIdx} in '${entry.language}'`);
            }
            for (const key of Object.keys(aux)) {
                if (!ALLOWED_AUXILIARY_KEYS.has(key)) {
                    throw new Error(`Invalid auxiliary property '${key}' at index ${aIdx} in '${entry.language}'`);
                }
            }
            if (typeof aux.pattern !== 'string' || !aux.pattern.trim()) {
                throw new Error(`Invalid auxiliary pattern at index ${aIdx} in '${entry.language}'`);
            }
            if (typeof aux.role !== 'string' || !aux.role.trim()) {
                throw new Error(`Invalid auxiliary role at index ${aIdx} in '${entry.language}'`);
            }
        }
        if (typeof entry.providerId !== 'string' || !entry.providerId.trim()) {
            throw new Error(`Invalid descriptor '${entry.language}': 'providerId' must be non-empty`);
        }
        if (typeof entry.providerVersion !== 'string' || !entry.providerVersion.trim()) {
            throw new Error(`Invalid descriptor '${entry.language}': 'providerVersion' must be non-empty`);
        }
        if (typeof entry.environmentConfigId !== 'string' || !entry.environmentConfigId.trim()) {
            throw new Error(`Invalid descriptor '${entry.language}': 'environmentConfigId' must be non-empty`);
        }
    }
    return raw;
}
