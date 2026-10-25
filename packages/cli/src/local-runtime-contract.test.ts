import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(sourceDirectory, '..');
const corePackageRoot = path.resolve(packageRoot, '..', 'core');

const AUTHORITATIVE_NAMES = [
    'EMBEDDING_PROJECTION_VERSION',
    'LEXICAL_PROJECTION_VERSION',
    'POTION_MODEL_ID',
    'POTION_DIMENSION',
] as const;

type RuntimeContractValues = Record<(typeof AUTHORITATIVE_NAMES)[number], string | number>;

function pickAuthoritativeValues(source: Record<string, unknown>): RuntimeContractValues {
    return {
        EMBEDDING_PROJECTION_VERSION: source.EMBEDDING_PROJECTION_VERSION as string,
        LEXICAL_PROJECTION_VERSION: source.LEXICAL_PROJECTION_VERSION as string,
        POTION_MODEL_ID: source.POTION_MODEL_ID as string,
        POTION_DIMENSION: source.POTION_DIMENSION as number,
    };
}

test('source runtime bridge and local contract match the lightweight core export', async () => {
    const coreContract = require('@satori-code/core/runtime-contract');
    const bridge = require('./runtime-identities.cjs');
    const sourceContract = await import('./local-runtime-contract.js');

    const expected = pickAuthoritativeValues(coreContract);
    assert.deepEqual(pickAuthoritativeValues(bridge), expected);
    assert.deepEqual(pickAuthoritativeValues(sourceContract), expected);
    assert.equal(sourceContract.LEXICAL_PROJECTION_VERSION, 'lexical_projection_v2');
});

test('built local runtime contract works in an isolated package without core installed', (t) => {
    const builtModule = path.join(packageRoot, 'dist', 'local-runtime-contract.js');
    const builtBridge = path.join(packageRoot, 'dist', 'runtime-identities.cjs');
    assert.ok(fs.existsSync(builtModule), `Build the CLI before this test: ${builtModule}`);
    assert.ok(fs.existsSync(builtBridge), `Build the CLI before this test: ${builtBridge}`);

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-runtime-contract-'));
    t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

    fs.copyFileSync(builtModule, path.join(fixtureRoot, 'local-runtime-contract.js'));
    fs.copyFileSync(builtBridge, path.join(fixtureRoot, 'runtime-identities.cjs'));
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    const runner = path.join(fixtureRoot, 'runner.mjs');
    fs.writeFileSync(runner, `
const contract = await import('./local-runtime-contract.js');
process.stdout.write(JSON.stringify({
    EMBEDDING_PROJECTION_VERSION: contract.EMBEDDING_PROJECTION_VERSION,
    LEXICAL_PROJECTION_VERSION: contract.LEXICAL_PROJECTION_VERSION,
    POTION_MODEL_ID: contract.POTION_MODEL_ID,
    POTION_DIMENSION: contract.POTION_DIMENSION,
}));
`, 'utf8');

    const result = spawnSync(process.execPath, [runner], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    const expected = pickAuthoritativeValues(require('@satori-code/core/runtime-contract'));
    assert.deepEqual(JSON.parse(result.stdout), expected);
});

test('copied CLI artifacts are byte-for-byte equal to the core build artifacts', () => {
    const pairs = [
        ['runtime-identities.cjs', 'runtime-contract.js'],
        ['runtime-identities.d.cts', 'runtime-contract.d.ts'],
    ] as const;
    for (const [cliFile, coreFile] of pairs) {
        const cliBytes = fs.readFileSync(path.join(packageRoot, 'dist', cliFile));
        const coreBytes = fs.readFileSync(path.join(corePackageRoot, 'dist', coreFile));
        assert.equal(cliBytes.equals(coreBytes), true, `${cliFile} must equal ${coreFile}`);
    }
});

test('lightweight core subpath import does not load resolver, compiler, or native modules', () => {
    const script = `
const before = new Set(Object.keys(require.cache));
require('@satori-code/core/runtime-contract');
const loaded = Object.keys(require.cache).filter((file) => !before.has(file));
process.stdout.write(JSON.stringify({ loaded, moduleLoadList: process.moduleLoadList }));
`;
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: packageRoot,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const { loaded, moduleLoadList } = JSON.parse(result.stdout) as {
        loaded: string[];
        moduleLoadList: string[];
    };

    assert.deepEqual(
        loaded.filter((file) => !file.endsWith(path.join('dist', 'runtime-contract.js'))),
        [],
    );
    const loadedFiles = loaded.join('\n');
    assert.doesNotMatch(loadedFiles, /node_modules[\\/](?:typescript|@lancedb|web-tree-sitter|oxc-parser)/i);
    assert.doesNotMatch(loadedFiles, /\.node$/m);
    assert.deepEqual(
        moduleLoadList.filter((entry) => /^node_modules[\\/]/.test(entry)),
        [],
    );
});
