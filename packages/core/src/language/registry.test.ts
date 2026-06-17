import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getLanguageCapabilityDeclaration,
    getLanguageCapabilityDeclarations,
    getLanguageAdapterByFilename,
    getLanguageIdFromExtension,
    getLanguageIdFromFilename,
    getSupportedExtensionsForCapability,
    getSupportedFilenamesForCapability,
    isLanguageCapabilitySupportedForExtension,
    isLanguageCapabilitySupportedForFilename,
    isLanguageCapabilitySupportedForLanguage,
} from './registry';

test('language registry is backed by canonical capability declarations', () => {
    const declarations = getLanguageCapabilityDeclarations();
    const languageIds = declarations.map((declaration) => declaration.languageId);

    assert.deepEqual([...languageIds].sort((a, b) => a.localeCompare(b)), languageIds);
    assert.equal(new Set(languageIds).size, languageIds.length);

    const typescript = getLanguageCapabilityDeclaration('typescript');
    assert.equal(typescript?.symbolExtractionCapability, 'production_ready');
    assert.equal(typescript?.ownerExtractionCapability, 'production_ready');
    assert.equal(typescript?.callsCapability, 'production_ready');

    const go = getLanguageCapabilityDeclaration('go');
    assert.equal(go?.searchEligibility, 'production_ready');
    assert.equal(go?.parserCapability, 'production_ready');
    assert.equal(go?.symbolExtractionCapability, 'production_ready');
    assert.equal(go?.ownerExtractionCapability, 'production_ready');
    assert.notEqual(go?.callsCapability, 'production_ready');
});

test('language registry routes modern module and systems extensions without changing capability honesty', () => {
    assert.equal(getLanguageIdFromExtension('.mts'), 'typescript');
    assert.equal(getLanguageIdFromExtension('cts'), 'typescript');
    assert.equal(getLanguageIdFromExtension('.cc'), 'cpp');
    assert.equal(getLanguageIdFromExtension('.cxx'), 'cpp');
    assert.equal(getLanguageIdFromExtension('.hh'), 'cpp');
    assert.equal(getLanguageIdFromExtension('.hxx'), 'cpp');
    assert.equal(getLanguageIdFromExtension('.ixx'), 'cpp');
    assert.equal(getLanguageIdFromExtension('.kts'), 'kotlin');

    assert.equal(isLanguageCapabilitySupportedForExtension('.mts', 'search'), true);
    assert.equal(isLanguageCapabilitySupportedForExtension('.mts', 'owner'), true);
    assert.equal(isLanguageCapabilitySupportedForExtension('.cc', 'search'), true);
    assert.equal(isLanguageCapabilitySupportedForExtension('.cc', 'owner'), false);
    assert.equal(isLanguageCapabilitySupportedForExtension('.kts', 'search'), true);
    assert.equal(isLanguageCapabilitySupportedForExtension('.kts', 'owner'), false);
});

test('L1 candidate languages do not claim graph capabilities by routing alone', () => {
    for (const language of ['go', 'rust', 'java', 'csharp', 'php', 'ruby', 'kotlin', 'swift']) {
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'search'), true, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'callGraph'), false, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'callGraphBuild'), false, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'callGraphQuery'), false, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'testLinks'), false, language);
    }
    for (const language of ['go', 'rust']) {
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'symbols'), true, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'owner'), true, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'fileOutline'), true, language);
    }
    for (const language of ['java', 'csharp', 'php', 'ruby', 'kotlin', 'swift']) {
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'symbols'), false, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'owner'), false, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'fileOutline'), false, language);
    }
});

test('language registry exposes search-only frontend/style containers until extractors exist', () => {
    for (const extension of ['.vue', '.svelte', '.astro', '.css', '.scss']) {
        assert.equal(isLanguageCapabilitySupportedForExtension(extension, 'search'), true, extension);
        assert.equal(isLanguageCapabilitySupportedForExtension(extension, 'symbols'), false, extension);
        assert.equal(isLanguageCapabilitySupportedForExtension(extension, 'owner'), false, extension);
        assert.equal(isLanguageCapabilitySupportedForExtension(extension, 'imports'), false, extension);
        assert.equal(isLanguageCapabilitySupportedForExtension(extension, 'callGraph'), false, extension);
        assert.equal(isLanguageCapabilitySupportedForExtension(extension, 'fileOutline'), false, extension);
    }
});

test('declared parser catalog entries do not claim executable AST splitter support', () => {
    for (const language of ['zig', 'solidity', 'gleam', 'kotlin', 'ruby', 'swift']) {
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'search'), true, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'astSplitter'), false, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'fileOutline'), false, language);
        assert.equal(isLanguageCapabilitySupportedForLanguage(language, 'callGraph'), false, language);
    }

    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'astSplitter'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('go', 'astSplitter'), true);
});

test('language registry routes special filenames as search-only artifacts', () => {
    const expected: Array<[string, string]> = [
        ['Dockerfile', 'dockerfile'],
        ['services/api/Dockerfile', 'dockerfile'],
        ['Makefile', 'makefile'],
        ['CMakeLists.txt', 'cmake'],
        ['justfile', 'justfile'],
        ['Justfile', 'justfile'],
    ];

    for (const [filename, language] of expected) {
        assert.equal(getLanguageIdFromFilename(filename), language, filename);
        assert.equal(getLanguageAdapterByFilename(filename)?.id, language, filename);
        assert.equal(isLanguageCapabilitySupportedForFilename(filename, 'search'), true, filename);
        assert.equal(isLanguageCapabilitySupportedForFilename(filename, 'owner'), false, filename);
        assert.equal(isLanguageCapabilitySupportedForFilename(filename, 'callGraph'), false, filename);
    }
});

test('language registry keeps legacy and plan capability aliases compatible', () => {
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'symbols'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'symbolMetadata'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'callGraph'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'callGraphBuild'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'callGraphQuery'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'fileOutline'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'imports'), false);
    assert.equal(isLanguageCapabilitySupportedForLanguage('typescript', 'testLinks'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('javascript', 'imports'), false);
    assert.equal(isLanguageCapabilitySupportedForLanguage('python', 'imports'), false);

    assert.equal(isLanguageCapabilitySupportedForLanguage('vue', 'search'), true);
    assert.equal(isLanguageCapabilitySupportedForLanguage('vue', 'symbols'), false);
    assert.equal(isLanguageCapabilitySupportedForLanguage('vue', 'symbolMetadata'), false);
});

test('language registry reports deterministic capability extension and filename sets', () => {
    assert.deepEqual(
        getSupportedExtensionsForCapability('owner').filter((extension) => ['.cts', '.mts', '.ts', '.tsx'].includes(extension)),
        ['.cts', '.mts', '.ts', '.tsx']
    );
    assert.ok(getSupportedExtensionsForCapability('search').includes('.vue'));
    assert.ok(!getSupportedExtensionsForCapability('owner').includes('.vue'));
    const searchableFilenames = getSupportedFilenamesForCapability('search');
    assert.deepEqual([...searchableFilenames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), searchableFilenames);
    for (const filename of [
        'CMakeLists.txt',
        'Dockerfile',
        'Justfile',
        'Kconfig',
        'Makefile',
        'go.mod',
        'justfile',
        'kustomization.yaml',
        'requirements.txt',
    ]) {
        assert.ok(searchableFilenames.includes(filename), filename);
    }
    assert.deepEqual(getSupportedFilenamesForCapability('owner'), []);
});
