import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMilvusIdInFilter } from './filters';

test('buildMilvusIdInFilter escapes Milvus string literals', () => {
    assert.equal(
        buildMilvusIdInFilter(['plain', 'quote"break', 'slash\\break']),
        'id in ["plain", "quote\\"break", "slash\\\\break"]'
    );
});
