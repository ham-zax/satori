import assert from 'node:assert/strict';
import test from 'node:test';
import {
    resolveNextSearchCandidateLimit,
    resolveSearchPolicy,
} from './search-policy.js';

test('resolveSearchPolicy preserves the bounded 32-to-80 candidate formula', () => {
    assert.deepEqual(
        [1, 4, 5, 10, 100].map((resultLimit) => (
            resolveSearchPolicy({ resultLimit, hasMustOperators: false }).candidateLimit
        )),
        [32, 32, 40, 80, 80],
    );
});

test('resolveSearchPolicy enables the existing bounded must retry rounds', () => {
    assert.equal(resolveSearchPolicy({ resultLimit: 5, hasMustOperators: false }).maxAttempts, 1);
    assert.equal(resolveSearchPolicy({ resultLimit: 5, hasMustOperators: true }).maxAttempts, 3);
    assert.deepEqual(
        [32, 64, 80].map(resolveNextSearchCandidateLimit),
        [64, 80, 80],
    );
});
