import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CBM_LANGUAGE_MAP, CBM_LANGUAGE_MAP_COMMIT } from './cbm-language-map';
import { getLanguageCapabilityDeclarations } from './capabilities';

const repoRoot = fs.existsSync(path.join(process.cwd(), 'packages/core/src/languages/capabilities.ts'))
    ? process.cwd()
    : path.resolve(process.cwd(), '../..');
const generatedFile = path.join(repoRoot, 'packages/core/src/languages/cbm-language-map.ts');
const cbmRoot = process.env.CBM_CHECKOUT ?? '/home/hamza/repo/codebase-memory-mcp';

test('every mapped Satori language exists in the registry', () => {
    const ids = new Set(getLanguageCapabilityDeclarations().map((entry) => entry.languageId));
    for (const entry of CBM_LANGUAGE_MAP) {
        if (entry.satoriLanguageId !== null) {
            assert.ok(ids.has(entry.satoriLanguageId), `${entry.cbmLanguage} maps to an unknown language`);
        }
    }
});

test('every registry language sharing a CBM grammar route is mapped', () => {
    for (const declaration of getLanguageCapabilityDeclarations()) {
        const extensions = new Set(declaration.extensions.map((extension) => extension.toLowerCase()));
        const filenames = new Set((declaration.filenames ?? []).map((filename) => filename.toLowerCase()));
        for (const entry of CBM_LANGUAGE_MAP) {
            if (entry.grammarFactory === null) continue;
            if (entry.extensions.some((extension) => extensions.has(extension.toLowerCase())) ||
                entry.filenames.some((filename) => filenames.has(filename.toLowerCase()))) {
                assert.equal(entry.satoriLanguageId, declaration.languageId,
                    `${entry.cbmLanguage} has a grammar route through ${declaration.languageId}`);
            }
        }
    }
});

test('catalog is sorted and frozen', () => {
    assert.deepEqual(CBM_LANGUAGE_MAP.map((entry) => entry.cbmLanguage),
        [...CBM_LANGUAGE_MAP.map((entry) => entry.cbmLanguage)].sort());
    assert.ok(Object.isFrozen(CBM_LANGUAGE_MAP));
    for (const entry of CBM_LANGUAGE_MAP) {
        assert.ok(Object.isFrozen(entry));
        assert.ok(Object.isFrozen(entry.extensions));
        assert.ok(Object.isFrozen(entry.filenames));
    }
    assert.match(CBM_LANGUAGE_MAP_COMMIT, /^[0-9a-f]{40}$/);
});

test('CBM-only extensions and shared host extensions map to their registry owners', () => {
    const byCbmLanguage = new Map(CBM_LANGUAGE_MAP.map((entry) => [entry.cbmLanguage, entry]));
    for (const [cbmLanguage, satoriLanguageId] of [
        ['ARKTS', 'arkts'],
        ['CHIALISP', 'chialisp'],
        ['MOJO', 'mojo'],
        ['OBJECTSCRIPT_ROUTINE', 'objectscript-routine'],
        ['PLSQL', 'plsql'],
        ['CSHARP', 'csharp'],
        ['XML', 'xml'],
    ]) {
        assert.equal(byCbmLanguage.get(cbmLanguage)?.satoriLanguageId, satoriLanguageId);
    }
});

test('generator reproduces byte-identical output', (context) => {
    if (!fs.existsSync(path.join(cbmRoot, 'src/discover/language.c'))) {
        context.skip(`CBM checkout unavailable: ${cbmRoot}`);
        return;
    }
    const expected = fs.readFileSync(generatedFile);
    for (let run = 0; run < 2; run++) {
        const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/sync-cbm-language-map.mjs'), cbmRoot], {
            cwd: repoRoot,
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(fs.readFileSync(generatedFile), expected, `generator run ${run + 1} changed the output`);
    }
});
