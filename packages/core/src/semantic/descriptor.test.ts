import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultSemanticLanguageRegistry,
    DefaultSemanticLanguageRegistry,
    validateSemanticLanguagesConfig,
    type SemanticLanguageDescriptor,
} from './descriptor';
import { RELATIONSHIP_BUILDER_VERSION } from '../language-analysis/versions';

test('defaultSemanticLanguageRegistry loads from packaged assets and supports Go', () => {
    assert.equal(defaultSemanticLanguageRegistry.supportsLanguage('go'), true);
    assert.equal(defaultSemanticLanguageRegistry.supportsLanguage('Go'), true);
    assert.equal(defaultSemanticLanguageRegistry.supportsLanguage('python'), false);

    const desc = defaultSemanticLanguageRegistry.getDescriptor('go');
    assert.ok(desc);
    assert.equal(desc.language, 'go');
    assert.equal(desc.strategy, 'cbm_semantic');
    assert.equal(desc.semanticRevision, 'go-v3');
    assert.equal(desc.grammar, 'tree-sitter-go');
    assert.equal(desc.providerId, 'satori-cbm-semantic-go');
    assert.equal(desc.providerVersion, 'cbm-d150ebe4+satori-go-semantic-v3');
    assert.equal(desc.environmentConfigId, 'cbm-go-semantic-v3');
    assert.equal(
        RELATIONSHIP_BUILDER_VERSION,
        'relationship-v19+cbm-multilang-v1+python-cross-module-constructors+python-native-resolution-v2+scala-syntactic-calls-v1+js-this-member-calls-v1+typescript-compiler-resolution-v8+relationship-evidence-v1+provider-coverage-v1+resource-budgets-v1',
    );

    assert.equal(defaultSemanticLanguageRegistry.getStrategyForLanguage('go'), 'cbm_semantic');
});

test('SemanticLanguageRegistry matches auxiliary files per language correctly', () => {
    const matchesMod = defaultSemanticLanguageRegistry.matchAuxiliaries('backend/go.mod');
    assert.equal(matchesMod.length, 1);
    assert.equal(matchesMod[0].role, 'manifest');
    assert.equal(matchesMod[0].language, 'go');

    const matchesSum = defaultSemanticLanguageRegistry.matchAuxiliaries('go.sum');
    assert.equal(matchesSum.length, 1);
    assert.equal(matchesSum[0].role, 'lockfile');
    assert.equal(matchesSum[0].language, 'go');

    const matchesWork = defaultSemanticLanguageRegistry.matchAuxiliaries('go.work');
    assert.equal(matchesWork.length, 1);
    assert.equal(matchesWork[0].role, 'workspace');
    assert.equal(matchesWork[0].language, 'go');

    assert.equal(defaultSemanticLanguageRegistry.isAuxiliaryPath('go.mod'), true);
    assert.equal(defaultSemanticLanguageRegistry.isAuxiliaryPath('main.go'), false);
    assert.equal(defaultSemanticLanguageRegistry.isAuxiliaryPath('Cargo.toml'), true);

    const matchesCargo = defaultSemanticLanguageRegistry.matchAuxiliaries('crate/Cargo.toml');
    assert.equal(matchesCargo.length, 1);
    assert.equal(matchesCargo[0].role, 'manifest');
    assert.equal(matchesCargo[0].language, 'rust');

    const matchesPom = defaultSemanticLanguageRegistry.matchAuxiliaries('service/pom.xml');
    assert.equal(matchesPom.length, 1);
    assert.equal(matchesPom[0].role, 'manifest');
    assert.equal(matchesPom[0].language, 'java');

    const matchesGradle = defaultSemanticLanguageRegistry.matchAuxiliaries('service/build.gradle.kts');
    assert.equal(matchesGradle.length, 1);
    assert.equal(matchesGradle[0].role, 'manifest');
    assert.equal(matchesGradle[0].language, 'java');

    const matchesCsproj = defaultSemanticLanguageRegistry.matchAuxiliaries('service/Demo.csproj');
    assert.equal(matchesCsproj.length, 1);
    assert.equal(matchesCsproj[0].role, 'manifest');
    assert.equal(matchesCsproj[0].language, 'csharp');
});

test('SemanticLanguageRegistry supports multi-language auxiliary routing without cross-talk', () => {
    const multiLangDescriptors: SemanticLanguageDescriptor[] = [
        {
            language: 'go',
            canonicalLanguage: 'go',
            extensions: ['.go'],
            strategy: 'cbm_semantic',
            semanticRevision: 'go-v1',
            grammar: 'tree-sitter-go',
            auxiliaryFiles: [
                { pattern: '**/go.mod', role: 'manifest' },
                { pattern: '**/go.sum', role: 'lockfile' },
            ],
            providerId: 'satori-cbm-semantic-go',
            providerVersion: 'cbm-go-v1',
            environmentConfigId: 'cbm-go-config-v1',
        },
        {
            language: 'rust',
            canonicalLanguage: 'rust',
            extensions: ['.rs'],
            strategy: 'cbm_semantic',
            semanticRevision: 'rust-v1',
            grammar: 'tree-sitter-rust',
            auxiliaryFiles: [
                { pattern: '**/Cargo.toml', role: 'manifest' },
                { pattern: '**/Cargo.lock', role: 'lockfile' },
            ],
            providerId: 'satori-cbm-semantic-rust',
            providerVersion: 'cbm-rust-v1',
            environmentConfigId: 'cbm-rust-config-v1',
        },
    ];

    const registry = new DefaultSemanticLanguageRegistry(multiLangDescriptors);

    const goMatches = registry.matchAuxiliaries('src/go.mod');
    assert.equal(goMatches.length, 1);
    assert.equal(goMatches[0].language, 'go');
    assert.equal(goMatches[0].role, 'manifest');

    const rustMatches = registry.matchAuxiliaries('crate/Cargo.toml');
    assert.equal(rustMatches.length, 1);
    assert.equal(rustMatches[0].language, 'rust');
    assert.equal(rustMatches[0].role, 'manifest');

    assert.equal(registry.isAuxiliaryPath('Cargo.lock'), true);
    assert.equal(registry.isAuxiliaryPath('package.json'), false);
});

test('validateSemanticLanguagesConfig rejects invalid strategy, missing fields, unknown keys, and duplicate languages', () => {
    const validDescriptor: SemanticLanguageDescriptor = {
        language: 'go',
        canonicalLanguage: 'go',
        extensions: ['.go'],
        strategy: 'cbm_semantic',
        semanticRevision: 'go-v1',
        grammar: 'tree-sitter-go',
        auxiliaryFiles: [{ pattern: '**/go.mod', role: 'manifest' }],
        providerId: 'satori-cbm-semantic-go',
        providerVersion: 'cbm-go-v1',
        environmentConfigId: 'cbm-go-config-v1',
    };

    // 1. Valid configuration passes
    const result = validateSemanticLanguagesConfig({ languages: [validDescriptor] });
    assert.equal(result.languages.length, 1);
    assert.equal(result.languages[0].language, 'go');

    // 2. Reject invalid strategy 'banana'
    assert.throws(
        () => validateSemanticLanguagesConfig({ languages: [{ ...validDescriptor, strategy: 'banana' }] }),
        /strategy' must be one of \[cbm_semantic\], saw 'banana'/,
    );

    // 3. Reject unknown property
    assert.throws(
        () => validateSemanticLanguagesConfig({ languages: [{ ...validDescriptor, extraField: 'unexpected' }] }),
        /unknown property 'extraField'/,
    );

    // 4. Reject duplicate canonical languages
    assert.throws(
        () => validateSemanticLanguagesConfig({
            languages: [
                validDescriptor,
                { ...validDescriptor, language: 'GoAlternative', canonicalLanguage: 'go' },
            ],
        }),
        /Duplicate descriptor for canonical language 'go'/,
    );

    // 5. Reject invalid extension format
    assert.throws(
        () => validateSemanticLanguagesConfig({ languages: [{ ...validDescriptor, extensions: ['go'] }] }),
        /extension at index 0 must match pattern/,
    );

    // 6. Reject empty languages array
    assert.throws(
        () => validateSemanticLanguagesConfig({ languages: [] }),
        /'languages' must be a non-empty array/,
    );
});
