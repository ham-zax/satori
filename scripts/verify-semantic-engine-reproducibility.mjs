import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import {
    ASSETS_DIR,
    MANIFEST_PATH,
    DESCRIPTOR_PATH,
    SCHEMA_PATH,
    JS_PATH,
    WASM_PATH,
    PINNED_UPSTREAM_COMMIT,
    PINNED_EMSCRIPTEN_VERSION,
    computeLogicalRecipeDigest,
    computeSourceDigest,
    validateSemanticLanguagesConfig,
} from './semantic-engine-build-config.mjs';

export { computeSourceDigest, computeLogicalRecipeDigest };

export function verifySemanticEngine() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        throw new Error(`Semantic engine manifest missing: ${MANIFEST_PATH}`);
    }
    if (!fs.existsSync(DESCRIPTOR_PATH)) {
        throw new Error(`Semantic language descriptor missing: ${DESCRIPTOR_PATH}`);
    }
    if (!fs.existsSync(SCHEMA_PATH)) {
        throw new Error(`Semantic language descriptor schema missing: ${SCHEMA_PATH}`);
    }
    if (!fs.existsSync(JS_PATH)) {
        throw new Error(`Semantic engine JS artifact missing: ${JS_PATH}`);
    }
    if (!fs.existsSync(WASM_PATH)) {
        throw new Error(`Semantic engine WASM artifact missing: ${WASM_PATH}`);
    }

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const descriptorRaw = JSON.parse(fs.readFileSync(DESCRIPTOR_PATH, 'utf8'));
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

    // 1. Verify against committed JSON Schema
    const ajv = new Ajv({ allErrors: true });
    const validateSchema = ajv.compile(schema);
    if (!validateSchema(descriptorRaw)) {
        const errorDetails = (validateSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join(', ');
        throw new Error(`Descriptor failed JSON schema validation: ${errorDetails}`);
    }

    // 2. Verify runtime config parser
    const descriptorJson = validateSemanticLanguagesConfig(descriptorRaw);
    const sourceDigest = computeSourceDigest();
    const recipeDigest = computeLogicalRecipeDigest();

    const descriptorByLang = new Map(descriptorJson.languages.map((l) => [l.language.toLowerCase(), l]));

    if (manifest.abiVersion !== 1) {
        throw new Error(`Manifest abiVersion mismatch: expected 1, saw ${manifest.abiVersion}`);
    }
    if (manifest.upstreamCommit !== PINNED_UPSTREAM_COMMIT) {
        throw new Error(`Manifest upstreamCommit mismatch: expected ${PINNED_UPSTREAM_COMMIT}, saw ${manifest.upstreamCommit}`);
    }
    if (manifest.emscriptenVersion !== PINNED_EMSCRIPTEN_VERSION) {
        throw new Error(`Manifest emscriptenVersion mismatch: expected ${PINNED_EMSCRIPTEN_VERSION}, saw ${manifest.emscriptenVersion}`);
    }
    if (manifest.semanticSourceDigest !== sourceDigest) {
        throw new Error(`Manifest source digest mismatch:\n  manifest: ${manifest.semanticSourceDigest}\n  computed: ${sourceDigest}`);
    }
    if (manifest.buildRecipeDigest !== recipeDigest) {
        throw new Error(`Manifest build recipe digest mismatch:\n  manifest: ${manifest.buildRecipeDigest}\n  computed: ${recipeDigest}`);
    }

    if (!manifest.languages || typeof manifest.languages !== 'object') {
        throw new Error(`Manifest missing 'languages' specification`);
    }

    // Verify descriptor<->manifest agreement for all compiled native languages
    for (const [lang, compiledSpec] of Object.entries(manifest.languages)) {
        const desc = descriptorByLang.get(lang.toLowerCase());
        if (!desc) {
            throw new Error(`Compiled language '${lang}' in manifest has no matching descriptor in ${DESCRIPTOR_PATH}`);
        }
        if (desc.semanticRevision !== compiledSpec.semanticRevision) {
            throw new Error(`Language '${lang}' revision mismatch:\n  descriptor: ${desc.semanticRevision}\n  manifest:   ${compiledSpec.semanticRevision}`);
        }
        if (desc.grammar !== compiledSpec.grammar) {
            throw new Error(`Language '${lang}' grammar mismatch:\n  descriptor: ${desc.grammar}\n  manifest:   ${compiledSpec.grammar}`);
        }
    }

    const jsBytes = fs.readFileSync(JS_PATH);
    const jsHash = crypto.createHash('sha256').update(jsBytes).digest('hex');
    if (manifest.jsSha256 !== jsHash) {
        throw new Error(`JS artifact hash mismatch:\n  manifest: ${manifest.jsSha256}\n  actual:   ${jsHash}`);
    }

    const wasmBytes = fs.readFileSync(WASM_PATH);
    const wasmHash = crypto.createHash('sha256').update(wasmBytes).digest('hex');
    if (manifest.wasmSha256 !== wasmHash) {
        throw new Error(`WASM artifact hash mismatch:\n  manifest: ${manifest.wasmSha256}\n  actual:   ${wasmHash}`);
    }

    const descriptorBytes = fs.readFileSync(DESCRIPTOR_PATH);
    const descriptorHash = crypto.createHash('sha256').update(descriptorBytes).digest('hex');

    return {
        abiVersion: manifest.abiVersion,
        upstreamCommit: manifest.upstreamCommit,
        emscriptenVersion: manifest.emscriptenVersion,
        semanticSourceDigest: sourceDigest,
        buildRecipeDigest: recipeDigest,
        descriptorSha256: descriptorHash,
        jsSha256: jsHash,
        wasmSha256: wasmHash,
        verifiedLanguages: Object.keys(manifest.languages),
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const result = verifySemanticEngine();
        console.log(`✔ Satori Semantic Engine verification passed:`);
        console.log(`  ABI Version:        ${result.abiVersion}`);
        console.log(`  Upstream Commit:    ${result.upstreamCommit}`);
        console.log(`  Emscripten Version: ${result.emscriptenVersion}`);
        console.log(`  Source Digest:      ${result.semanticSourceDigest}`);
        console.log(`  Recipe Digest:      ${result.buildRecipeDigest}`);
        console.log(`  Descriptor Digest:  ${result.descriptorSha256}`);
        console.log(`  JS Digest:          ${result.jsSha256}`);
        console.log(`  WASM Digest:        ${result.wasmSha256}`);
        console.log(`  Verified Languages: ${result.verifiedLanguages.join(', ')}`);
    } catch (err) {
        console.error(`✖ Semantic engine verification failed: ${err.message}`);
        process.exit(1);
    }
}
