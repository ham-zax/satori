import test from 'node:test';
import assert from 'node:assert/strict';
import { getLanguageCapabilityDeclaration } from '../capabilities';
import {
    clearSymbolExtractorRegistryForTests,
    getRegisteredSymbolExtractorLanguageIds,
    getSymbolExtractorForLanguage,
    registerSymbolExtractor,
} from './index';
import type { SymbolExtractor } from '../types';

function extractor(languageId: string, extractorVersion: string): SymbolExtractor {
    return {
        languageId,
        extractorVersion,
        extract: () => [],
    };
}

test('symbol extractor registry registers and looks up canonical language ids', () => {
    clearSymbolExtractorRegistryForTests();
    registerSymbolExtractor(extractor('go', 'go-test-v1'));

    assert.equal(getSymbolExtractorForLanguage('go')?.extractorVersion, 'go-test-v1');
    assert.ok(getRegisteredSymbolExtractorLanguageIds().includes('go'));
});

test('symbol extractor registry normalizes aliases to canonical language ids', () => {
    clearSymbolExtractorRegistryForTests();
    registerSymbolExtractor(extractor('rust', 'rust-test-v1'));

    assert.equal(getSymbolExtractorForLanguage('rs')?.languageId, 'rust');
});

test('symbol extractor registry returns undefined for unknown languages', () => {
    clearSymbolExtractorRegistryForTests();

    assert.equal(getSymbolExtractorForLanguage('does-not-exist'), undefined);
});

test('registering an extractor does not change language capability claims', () => {
    clearSymbolExtractorRegistryForTests();
    const before = getLanguageCapabilityDeclaration('go');

    registerSymbolExtractor(extractor('go', 'go-test-v1'));

    assert.deepEqual(getLanguageCapabilityDeclaration('go'), before);
});

test('duplicate symbol extractor registration replaces the prior extractor deterministically', () => {
    clearSymbolExtractorRegistryForTests();
    registerSymbolExtractor(extractor('go', 'go-test-v1'));
    registerSymbolExtractor(extractor('go', 'go-test-v2'));

    assert.equal(getSymbolExtractorForLanguage('go')?.extractorVersion, 'go-test-v2');
    assert.equal(getRegisteredSymbolExtractorLanguageIds().filter((languageId) => languageId === 'go').length, 1);
});
