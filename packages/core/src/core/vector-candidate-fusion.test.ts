import assert from 'node:assert/strict';
import test from 'node:test';

import type { VectorCandidate, VectorDocument } from '../vectordb';
import {
    fuseVectorCandidatesWithRrf,
    VECTOR_CANDIDATE_RRF_K_V1,
} from './vector-candidate-fusion';

function candidate(
    id: string,
    score = 1,
    overrides: Partial<VectorDocument> = {},
): VectorCandidate {
    const document: VectorDocument = {
        id,
        vector: [],
        content: id,
        relativePath: `src/${id}.ts`,
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        metadata: {},
        ...overrides,
    };
    return { document, score };
}

test('Core RRF fusion combines independent arms and deduplicates repeated IDs', () => {
    const results = fuseVectorCandidatesWithRrf({
        dense: [candidate('shared', 3), candidate('dense', 2), candidate('dense', 1)],
        lexical: [candidate('lexical', 2), candidate('shared', 1)],
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 3,
    });

    assert.deepEqual(results.map((result) => result.document.id), [
        'shared',
        'lexical',
        'dense',
    ]);
    assert.equal(results[0]?.score, (1 / 101) + (1 / 102));
    assert.equal(results.find((result) => result.document.id === 'dense')?.score, 1 / 102);
});

test('Core RRF fusion orders equal-score arms before assigning ranks', () => {
    const fuse = (dense: VectorCandidate[]) => fuseVectorCandidatesWithRrf({
        dense,
        lexical: [],
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 3,
    }).map((result) => result.document.id);

    assert.deepEqual(fuse([candidate('z'), candidate('a'), candidate('m')]), ['a', 'm', 'z']);
    assert.deepEqual(fuse([candidate('m'), candidate('z'), candidate('a')]), ['a', 'm', 'z']);
});

test('Core RRF fusion assigns ranks after duplicate IDs are removed', () => {
    const results = fuseVectorCandidatesWithRrf({
        dense: [candidate('a', 3), candidate('a', 2), candidate('b', 1)],
        lexical: [],
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 2,
    });

    assert.equal(results.find((result) => result.document.id === 'b')?.score, 1 / 102);
});

test('Core RRF fusion assigns arm ranks after repeated owner chunks are removed', () => {
    const repeatedOwner = {
        relativePath: 'src/owner-a.ts',
        metadata: { ownerSymbolInstanceId: 'owner-a' },
    };
    const results = fuseVectorCandidatesWithRrf({
        dense: [
            candidate('a-1', 3, repeatedOwner),
            candidate('a-2', 2, repeatedOwner),
            candidate('b', 1, { metadata: { ownerSymbolInstanceId: 'owner-b' } }),
        ],
        lexical: [],
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 2,
    });

    assert.deepEqual(results.map((result) => result.document.id), ['a-1', 'b']);
    assert.equal(results.find((result) => result.document.id === 'b')?.score, 1 / 102);
});

test('Core RRF fusion uses only code-unit ID order for equal fused scores', () => {
    const denseIds = Array.from({ length: 8 }, (_, index) => `dense-${index + 1}`);
    denseIds[4] = 'z-best-rank';
    denseIds[7] = 'a-id';
    const lexicalIds = Array.from({ length: 40 }, (_, index) => `lexical-${index + 1}`);
    lexicalIds[34] = 'a-id';
    lexicalIds[39] = 'z-best-rank';
    const rankedArm = (ids: string[]) => ids.map((id, index) => candidate(id, ids.length - index));

    const results = fuseVectorCandidatesWithRrf({
        dense: rankedArm(denseIds),
        lexical: rankedArm(lexicalIds),
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 2,
    });

    assert.equal(results[0]?.score, 1 / 60);
    assert.equal(results[1]?.score, 1 / 60);
    assert.deepEqual(results.map((result) => result.document.id), ['a-id', 'z-best-rank']);
});

test('Core RRF fusion rejects empty IDs and conflicting payloads for one ID', () => {
    assert.throws(() => fuseVectorCandidatesWithRrf({
        dense: [candidate('')],
        lexical: [],
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 1,
    }), /non-empty/);

    assert.throws(() => fuseVectorCandidatesWithRrf({
        dense: [candidate('same')],
        lexical: [candidate('same', 1, { relativePath: 'src/other.ts' })],
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 1,
    }), /conflicting document payloads/);
});

test('Core RRF fusion credits an all-terms row that a truncated fallback arm cut off', () => {
    const dense = Array.from({ length: 4 }, (_, index) => candidate(`both-${index + 1}`, 4 - index));
    const fallback = Array.from({ length: 4 }, (_, index) => candidate(`both-${4 - index}`, 4 - index));
    const fuse = (lexicalFallbackLimit?: number) => fuseVectorCandidatesWithRrf({
        dense,
        lexical: [candidate('strict', 9)],
        lexicalFallback: fallback,
        ...(lexicalFallbackLimit !== undefined ? { lexicalFallbackLimit } : {}),
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 5,
    });
    const strictScore = (results: VectorCandidate[]) => (
        results.find((result) => result.document.id === 'strict')?.score
    );

    // The arm filled its limit, so the row is credited the first rank past the cut.
    const truncated = fuse(4);
    assert.equal(strictScore(truncated), (1 / 101) + (1 / 105));
    assert.equal(truncated.find((result) => result.document.id === 'both-1')?.score, (1 / 101) + (1 / 104));

    // An arm that returned fewer rows than its limit excluded the row for real.
    assert.equal(strictScore(fuse(5)), 1 / 101);
    assert.equal(strictScore(fuse()), 1 / 101);
});

test('Core RRF fusion keeps the fallback rank of an owner the fallback arm already ranked', () => {
    const owner = { relativePath: 'src/owner.ts', metadata: { ownerSymbolInstanceId: 'owner' } };
    const results = fuseVectorCandidatesWithRrf({
        dense: [],
        lexical: [candidate('owner-strict', 9, owner), candidate('listed', 8)],
        lexicalFallback: [candidate('owner-other', 3, owner), candidate('listed', 2)],
        lexicalFallbackLimit: 2,
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 3,
    });
    const score = (id: string) => results.find((result) => result.document.id === id)?.score;

    assert.equal(score('owner-strict'), 1 / 101);
    assert.equal(score('listed'), (1 / 102) + (1 / 102));
    assert.throws(() => fuseVectorCandidatesWithRrf({
        dense: [], lexical: [], lexicalFallbackLimit: 0, k: VECTOR_CANDIDATE_RRF_K_V1, limit: 1,
    }), /fallback limit/);
});
