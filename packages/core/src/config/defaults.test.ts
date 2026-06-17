import test from 'node:test';
import assert from 'node:assert/strict';
import { getSupportedExtensionsForIndexProfile } from './defaults';
import { getSupportedExtensionsForCapability } from '../language';

test('language capability routing does not silently broaden default index profile', () => {
    const defaultProfileExtensions = getSupportedExtensionsForIndexProfile('default');
    const searchableLanguageExtensions = getSupportedExtensionsForCapability('search');

    assert.ok(searchableLanguageExtensions.includes('.vue'));
    assert.ok(searchableLanguageExtensions.includes('.astro'));
    assert.ok(searchableLanguageExtensions.includes('.scss'));
    assert.ok(searchableLanguageExtensions.includes('.zig'));
    assert.ok(searchableLanguageExtensions.includes('.sol'));
    assert.ok(searchableLanguageExtensions.includes('.gleam'));

    assert.equal(defaultProfileExtensions.includes('.vue'), false);
    assert.equal(defaultProfileExtensions.includes('.astro'), false);
    assert.equal(defaultProfileExtensions.includes('.scss'), false);
    assert.equal(defaultProfileExtensions.includes('.zig'), false);
    assert.equal(defaultProfileExtensions.includes('.sol'), false);
    assert.equal(defaultProfileExtensions.includes('.gleam'), false);
});

test('index profiles remain explicit allowlists independent from language capability matrix', () => {
    assert.deepEqual(
        getSupportedExtensionsForIndexProfile('minimal').filter((extension) => ['.go', '.rs', '.java', '.cs'].includes(extension)),
        ['.java', '.cs', '.go', '.rs']
    );

    assert.equal(getSupportedExtensionsForIndexProfile('default').includes('.kts'), false);
    assert.equal(getSupportedExtensionsForIndexProfile('all-text').includes('<all-text>'), true);
});
