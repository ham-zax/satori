import assert from 'node:assert/strict';
import test from 'node:test';
import {
    resolveFrozenSearchResultLimit,
    resolveNextSearchCandidateLimit,
    resolveSearchPolicy,
} from './search-policy.js';

test('search policy separates an unbounded logical total from the frozen candidate ceiling', () => {
    assert.equal(resolveFrozenSearchResultLimit(Number.MAX_SAFE_INTEGER), 200);
    assert.deepEqual(resolveSearchPolicy({
        resultLimit: Number.MAX_SAFE_INTEGER,
        hasMustOperators: false,
    }), {
        retrievalResultLimit: 200,
        rerankerResultLimit: 200,
        disclosureResultLimit: 20,
        candidateLimit: 80,
        maxCandidateLimit: 80,
        maxAttempts: 1,
    });
});

test('resolveSearchPolicy spends the whole candidate budget regardless of the requested output count', () => {
    assert.deepEqual(
        [1, 4, 5, 10, 20, 100].map((resultLimit) => (
            resolveSearchPolicy({ resultLimit, hasMustOperators: false }).candidateLimit
        )),
        [80, 80, 80, 80, 80, 80],
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

test('resolveSearchPolicy isolates an explicit diagnostic candidate depth from the product baseline', () => {
    assert.deepEqual(
        resolveSearchPolicy({
            resultLimit: 3,
            hasMustOperators: true,
            diagnosticCandidateLimit: 160,
        }),
        {
            retrievalResultLimit: 3,
            rerankerResultLimit: 3,
            disclosureResultLimit: 3,
            candidateLimit: 80,
            maxCandidateLimit: 80,
            maxAttempts: 3,
            diagnosticCandidateLimit: 160,
        },
    );
    assert.deepEqual(resolveSearchPolicy({
        resultLimit: 3,
        hasMustOperators: false,
        diagnosticCandidateLimit: 999,
    }), {
        retrievalResultLimit: 3,
        rerankerResultLimit: 3,
        disclosureResultLimit: 3,
        candidateLimit: 80,
        maxCandidateLimit: 80,
        maxAttempts: 1,
        diagnosticCandidateLimit: 160,
    });
    assert.equal(resolveSearchPolicy({
        resultLimit: 10,
        hasMustOperators: false,
        diagnosticCandidateLimit: 5,
    }).diagnosticCandidateLimit, 80);
    assert.equal(resolveSearchPolicy({
        resultLimit: 3,
        hasMustOperators: false,
    }).candidateLimit, 80);
});

test('resolveSearchPolicy separates retrieval, reranker, and disclosure budgets', () => {
    assert.deepEqual(
        resolveSearchPolicy({
            resultLimit: 10,
            retrievalResultLimit: 8,
            rerankerResultLimit: 6,
            disclosureResultLimit: 3,
            hasMustOperators: false,
        }),
        {
            retrievalResultLimit: 8,
            rerankerResultLimit: 6,
            disclosureResultLimit: 3,
            candidateLimit: 80,
            maxCandidateLimit: 80,
            maxAttempts: 1,
        },
    );
});

test('resolveSearchPolicy discloses twenty by default and preserves a custom page size', () => {
    assert.equal(resolveSearchPolicy({
        resultLimit: 20,
        hasMustOperators: false,
    }).disclosureResultLimit, 20);
    assert.equal(resolveSearchPolicy({
        resultLimit: 20,
        disclosureResultLimit: 20,
        hasMustOperators: false,
    }).disclosureResultLimit, 20);
    assert.equal(resolveSearchPolicy({
        resultLimit: 20,
        disclosureResultLimit: 7,
        hasMustOperators: false,
    }).disclosureResultLimit, 7);
});
