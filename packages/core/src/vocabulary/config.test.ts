import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRepositoryVocabularyIndexingEnabled } from './config';

test('vocabulary indexing requires the explicit 1 opt-in', () => {
    for (const value of ['', '0', 'false', 'true', 'yes', 'invalid']) {
        assert.equal(resolveRepositoryVocabularyIndexingEnabled(value), false, value);
    }
    assert.equal(resolveRepositoryVocabularyIndexingEnabled('1'), true);
});
