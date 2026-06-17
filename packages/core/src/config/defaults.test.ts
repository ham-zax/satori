import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IGNORE_PATTERNS, getSupportedExtensionsForIndexProfile } from './defaults';
import { getSupportedExtensionsForCapability, getSupportedFilenamesForCapability } from '../language';

test('language capability routing does not silently broaden default index profile', () => {
    const defaultProfileExtensions = getSupportedExtensionsForIndexProfile('default');
    const searchableLanguageExtensions = getSupportedExtensionsForCapability('search');

    assert.ok(searchableLanguageExtensions.includes('.vue'));
    assert.ok(searchableLanguageExtensions.includes('.astro'));
    assert.ok(searchableLanguageExtensions.includes('.scss'));
    assert.ok(searchableLanguageExtensions.includes('.zig'));
    assert.ok(searchableLanguageExtensions.includes('.sol'));
    assert.ok(searchableLanguageExtensions.includes('.gleam'));
    assert.ok(searchableLanguageExtensions.includes('.env'));
    assert.ok(getSupportedFilenamesForCapability('search').includes('.env'));

    assert.equal(defaultProfileExtensions.includes('.vue'), false);
    assert.equal(defaultProfileExtensions.includes('.astro'), false);
    assert.equal(defaultProfileExtensions.includes('.scss'), false);
    assert.equal(defaultProfileExtensions.includes('.zig'), false);
    assert.equal(defaultProfileExtensions.includes('.sol'), false);
    assert.equal(defaultProfileExtensions.includes('.gleam'), false);
    assert.equal(defaultProfileExtensions.includes('.env'), false);
});

test('index profiles remain explicit allowlists independent from language capability matrix', () => {
    assert.deepEqual(
        getSupportedExtensionsForIndexProfile('minimal').filter((extension) => ['.go', '.rs', '.java', '.cs'].includes(extension)),
        ['.java', '.cs', '.go', '.rs']
    );

    assert.equal(getSupportedExtensionsForIndexProfile('default').includes('.kts'), false);
    assert.equal(getSupportedExtensionsForIndexProfile('minimal').includes('.env'), false);
    assert.equal(getSupportedExtensionsForIndexProfile('default').includes('.env'), false);
    assert.equal(getSupportedExtensionsForIndexProfile('all-text').includes('.env'), false);
    assert.equal(getSupportedExtensionsForIndexProfile('all-text').includes('<all-text>'), true);
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('.env'));
    assert.ok(DEFAULT_IGNORE_PATTERNS.includes('.env.*'));
});
