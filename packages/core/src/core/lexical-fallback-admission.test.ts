import assert from 'node:assert/strict';
import test from 'node:test';

import type { VectorCandidate, VectorDocument } from '../vectordb';
import { buildSemanticSearchCandidateTrace } from './semantic-search-service';
import {
    fuseVectorCandidatesWithRrf,
    VECTOR_CANDIDATE_RRF_K_V1,
} from './vector-candidate-fusion';

function candidate(
    id: string,
    relativePath: string,
    score = 1,
): VectorCandidate {
    const document: VectorDocument = {
        id,
        vector: [],
        content: id,
        relativePath,
        startLine: 1,
        endLine: 1,
        fileExtension: '.ts',
        metadata: {},
    };
    return { document, score };
}

function traceInput(overrides: Record<string, unknown> = {}) {
    return {
        diagnosticRetrievals: [],
        result: [],
        hybrid: true,
        maxEntries: 160,
        productCandidateLimit: 80,
        queryEmbeddingSha256: null,
        lexicalRequests: [],
        ...overrides,
    } as Parameters<typeof buildSemanticSearchCandidateTrace>[0];
}

test('Fallback rows from paths dense retrieval missed reach fusion', () => {
    const dense = [candidate('dense-a', 'src/a.ts'), candidate('dense-b', 'src/b.ts')];
    const fallback = [
        candidate('fallback-c', 'src/c.ts', 30),
        candidate('fallback-d', 'src/d.ts', 20),
        candidate('fallback-e', 'src/e.ts', 10),
    ];
    const fused = fuseVectorCandidatesWithRrf({
        dense,
        lexical: [],
        lexicalFallback: fallback,
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 80,
    });

    assert.deepEqual(
        fused.map((row) => row.document.id).sort(),
        ['dense-a', 'dense-b', 'fallback-c', 'fallback-d', 'fallback-e'],
    );
});

test('A short all-terms arm is supplemented, and its rows outrank fallback-only rows', () => {
    const allTerms = candidate('all-terms', 'src/owner.ts', 5);
    const fused = fuseVectorCandidatesWithRrf({
        dense: [],
        lexical: [allTerms],
        lexicalFallback: [candidate('any-terms', 'src/other.ts', 40), allTerms],
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 80,
    });

    assert.deepEqual(fused.map((row) => row.document.id), ['all-terms', 'any-terms']);
});

test('Product and diagnostic fallback rows are traced as distinct stages', () => {
    const trace = buildSemanticSearchCandidateTrace(traceInput({
        productDense: [candidate('dense-a', 'src/a.ts')],
        productLexical: [],
        productLexicalFallback: [candidate('product-row', 'src/c.ts')],
        diagnosticLexicalFallback: [candidate('diagnostic-row', 'src/z.ts')],
        result: [candidate('dense-a', 'src/a.ts')],
    }));

    const fallbackStage = trace.stages.find((stage) => stage.stage === 'raw_lexical_fallback');
    const diagnosticStage = trace.stages.find(
        (stage) => stage.stage === 'diagnostic_fallback_lexical',
    );
    assert.deepEqual(
        fallbackStage?.candidates.map((row) => row.candidateId),
        ['product-row'],
    );
    assert.deepEqual(
        diagnosticStage?.candidates.map((row) => row.candidateId),
        ['diagnostic-row'],
    );
});

test('Product-only fallback still traces without a diagnostic stage', () => {
    const trace = buildSemanticSearchCandidateTrace(traceInput({
        productDense: [candidate('dense-a', 'src/a.ts')],
        productLexical: [],
        productLexicalFallback: [candidate('product-row', 'src/c.ts')],
        result: [candidate('dense-a', 'src/a.ts')],
    }));

    assert.equal(
        trace.stages.some((stage) => stage.stage === 'diagnostic_fallback_lexical'),
        false,
    );
    assert.equal(
        trace.stages.some((stage) => stage.stage === 'raw_lexical_fallback'),
        true,
    );
});
