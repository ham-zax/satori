import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getLanguageAdapterByFilename,
    getLanguageIdFromExtension,
    getLanguageIdFromFilename,
    getSupportedExtensionsForCapability,
    getSupportedFilenamesForCapability,
    isLanguageCapabilitySupportedForExtension,
    isLanguageCapabilitySupportedForFilename,
    isLanguageCapabilitySupportedForLanguage,
} from './registry';

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
    assert.deepEqual(getSupportedFilenamesForCapability('search'), [
        'CMakeLists.txt',
        'Dockerfile',
        'Justfile',
        'Makefile',
        'justfile',
    ]);
    assert.deepEqual(getSupportedFilenamesForCapability('owner'), []);
});
