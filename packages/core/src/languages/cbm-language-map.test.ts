import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CBM_LANGUAGE_MAP, CBM_LANGUAGE_MAP_COMMIT, SATORI_EXTENSION_SPLITS } from './cbm-language-map';
import { getLanguageCapabilityDeclarations } from './capabilities';

const repoRoot = fs.existsSync(path.join(process.cwd(), 'packages/core/src/languages/capabilities.ts'))
    ? process.cwd()
    : path.resolve(process.cwd(), '../..');
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
            const routedExtensions = entry.extensions.filter((extension) =>
                SATORI_EXTENSION_SPLITS[extension.toLowerCase()] !== declaration.languageId);
            if (routedExtensions.some((extension) => extensions.has(extension.toLowerCase())) ||
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

test('generated map is current for its pinned CBM commit', (context) => {
    const head = spawnSync('git', ['-C', cbmRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== CBM_LANGUAGE_MAP_COMMIT) {
        context.skip(`CBM checkout at ${cbmRoot} is not at the pinned commit ${CBM_LANGUAGE_MAP_COMMIT}`);
        return;
    }
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/sync-cbm-language-map.mjs'), '--check', cbmRoot], {
        cwd: repoRoot,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
});
