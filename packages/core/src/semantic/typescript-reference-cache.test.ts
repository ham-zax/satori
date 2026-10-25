import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeScriptReferenceDeclarationCache, type TypeScriptReferenceDeclarationState } from './typescript-reference-cache';

const state: TypeScriptReferenceDeclarationState = { outputs: ['/lib/index.d.ts'], references: [], unproven: false };

test('reference cache evicts the least recently used proof at its entry bound', () => {
    const cache = new TypeScriptReferenceDeclarationCache(2, 1024);
    cache.set('a', 'one', state);
    cache.set('b', 'one', state);
    assert.equal(cache.get('a', 'one'), state);
    cache.set('c', 'one', state);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('b', 'one'), undefined);
    assert.equal(cache.get('a', 'one'), state);
    assert.equal(cache.get('c', 'one'), state);
});

test('reference cache bounds retained bytes and skips oversized proofs', () => {
    const cache = new TypeScriptReferenceDeclarationCache(128, 300);
    cache.set('a', 'one', state);
    cache.set('b', 'one', state);
    assert.ok(cache.bytes <= 300);
    assert.equal(cache.size, 1);
    cache.set('huge', 'one', { ...state, outputs: ['x'.repeat(1024)] });
    assert.equal(cache.get('huge', 'one'), undefined);
    assert.equal(cache.get('b', 'one'), state);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
});

test('reference cache invalidates changed fingerprints and replaces byte accounting', () => {
    const cache = new TypeScriptReferenceDeclarationCache(2, 1024);
    cache.set('a', 'old', state);
    const bytes = cache.bytes;
    cache.set('a', 'new', state);
    assert.equal(cache.bytes, bytes);
    assert.equal(cache.get('a', 'old'), undefined);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
});
