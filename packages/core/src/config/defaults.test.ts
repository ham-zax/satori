import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IGNORE_PATTERNS, INDEXABLE_EXACT_FILENAMES, getIndexableExactFilenames, getSupportedExtensionsForIndexProfile } from './defaults';
import { getSupportedExtensionsForCapability, getSupportedFilenamesForCapability } from '../language';

const NOT_DEFAULT_INDEXED = ['.csv', '.diff', '.patch', '.svg', '.po', '.pot', '.env'];

test('the default profile admits every searchable catalog extension except bulk data and secrets', () => {
    const defaultProfileExtensions = new Set(getSupportedExtensionsForIndexProfile('default'));
    const missing = getSupportedExtensionsForCapability('search')
        .filter((extension) => !defaultProfileExtensions.has(extension) && !NOT_DEFAULT_INDEXED.includes(extension));
    assert.deepEqual(missing, []);
    for (const extension of NOT_DEFAULT_INDEXED) {
        assert.equal(defaultProfileExtensions.has(extension), false, extension);
    }
    for (const extension of ['.vue', '.svelte', '.dart', '.ex', '.lua', '.zig', '.kts', '.html', '.scss']) {
        assert.ok(defaultProfileExtensions.has(extension), extension);
    }
});

test('every profile admits all extensions of languages with symbol navigation', () => {
    const symbolExtensions = getSupportedExtensionsForCapability('symbols');
    for (const extension of ['.cc', '.cxx', '.hh', '.hxx', '.cppm', '.ixx', '.mts', '.cts']) {
        assert.ok(symbolExtensions.includes(extension), extension);
    }
    for (const profile of ['minimal', 'default', 'all-text'] as const) {
        const profileExtensions = new Set(getSupportedExtensionsForIndexProfile(profile));
        assert.deepEqual(symbolExtensions.filter((extension) => !profileExtensions.has(extension)), [], profile);
    }
    assert.equal(getSupportedExtensionsForIndexProfile('minimal').includes('.vue'), false);
});

test('catalog filenames are admitted except secret-bearing env files', () => {
    const exact = new Set(INDEXABLE_EXACT_FILENAMES);
    assert.ok(getSupportedFilenamesForCapability('search').includes('.env'));
    assert.equal(exact.has('.env'), false);
    assert.equal(exact.has('.env.local'), false);
    for (const filename of ['CMakeLists.txt', 'BUILD.bazel', 'Dockerfile', 'Jenkinsfile']) {
        assert.ok(exact.has(filename), filename);
    }
    const minimalExact = new Set(getIndexableExactFilenames(new Set(getSupportedExtensionsForIndexProfile('minimal'))));
    assert.equal(minimalExact.has('kustomization.yaml'), false);
    assert.equal(minimalExact.has('go.mod'), false);
    assert.ok(minimalExact.has('Dockerfile'));
    assert.deepEqual(getIndexableExactFilenames(new Set(getSupportedExtensionsForIndexProfile('default'))), INDEXABLE_EXACT_FILENAMES);
    assert.equal(getSupportedExtensionsForIndexProfile('all-text').includes('<all-text>'), true);
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('.env'));
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('.env.*'));
});
