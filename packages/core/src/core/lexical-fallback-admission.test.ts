import assert from 'node:assert/strict';
import test from 'node:test';

import type { VectorCandidate, VectorDocument } from '../vectordb';
import { buildSemanticSearchCandidateTrace } from './semantic-search-service';
import {
    admitLexicalFallbackCandidates,
    fuseVectorCandidatesWithRrf,
    LEXICAL_FALLBACK_DISCOVERY_PREFIX,
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

test('Lexical fallback discovery prefix keeps the policy bounded and small', () => {
    assert.ok(Number.isSafeInteger(LEXICAL_FALLBACK_DISCOVERY_PREFIX));
    assert.ok(LEXICAL_FALLBACK_DISCOVERY_PREFIX >= 2);
    assert.ok(LEXICAL_FALLBACK_DISCOVERY_PREFIX <= 5);
});

test('Strong fallback rows from a dense-missing path survive admission and reach fusion', () => {
    const dense = [candidate('dense-a', 'src/a.ts'), candidate('dense-b', 'src/b.ts')];
    const densePaths = new Set(dense.map((row) => row.document.relativePath));
    const fallback = [
        candidate('fallback-c-strong', 'src/c.ts', 21),
        candidate('fallback-c-next', 'src/c.ts', 20),
        candidate('fallback-d-tail', 'src/d.ts', 1),
    ];
    const admission = admitLexicalFallbackCandidates({ fallback, densePaths });

    assert.deepEqual(
        admission.admitted.map((row) => row.document.id),
        ['fallback-c-strong', 'fallback-c-next'],
    );
    assert.deepEqual(admission.densePathFilteredIds, ['fallback-d-tail']);

    const fused = fuseVectorCandidatesWithRrf({
        dense,
        lexical: admission.admitted,
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 80,
    });
    assert.ok(fused.some((row) => row.document.id === 'fallback-c-strong'));
});

test('Fallback tail from dense-missing paths remains excluded', () => {
    const densePaths = new Set(['src/a.ts']);
    const fallback = [
        candidate('keep-1', 'src/new-1.ts', 30),
        candidate('keep-2', 'src/new-2.ts', 29),
        candidate('drop-1', 'src/new-3.ts', 28),
        candidate('drop-2', 'src/new-4.ts', 27),
    ];
    assert.equal(fallback.length > LEXICAL_FALLBACK_DISCOVERY_PREFIX, true);
    const admission = admitLexicalFallbackCandidates({ fallback, densePaths });

    assert.equal(admission.admitted.length, LEXICAL_FALLBACK_DISCOVERY_PREFIX);
    assert.deepEqual(admission.densePathFilteredIds, ['drop-1', 'drop-2']);
});

test('Fallback rows on dense-discovered paths remain eligible beyond the prefix', () => {
    const densePaths = new Set(['src/a.ts']);
    const fallback = [
        candidate('prefix-new', 'src/new.ts', 30),
        candidate('prefix-other', 'src/other.ts', 29),
        candidate('enrichment-weak', 'src/a.ts', 1),
    ];
    const admission = admitLexicalFallbackCandidates({ fallback, densePaths });

    assert.deepEqual(
        admission.admitted.map((row) => row.document.id),
        ['prefix-new', 'prefix-other', 'enrichment-weak'],
    );
    assert.deepEqual(admission.densePathFilteredIds, []);
});

test('Dense-path filtered rows are recorded with the dense_path_filter reason', () => {
    const trace = buildSemanticSearchCandidateTrace(traceInput({
        productDense: [candidate('dense-a', 'src/a.ts')],
        productLexical: [],
        productLexicalFallback: [candidate('fallback-c-strong', 'src/c.ts')],
        densePathFilteredIds: ['filtered-tail'],
        result: [candidate('dense-a', 'src/a.ts')],
    }));

    const removal = trace.removals.find((entry) => entry.candidateId === 'filtered-tail');
    assert.deepEqual(removal, {
        candidateId: 'filtered-tail',
        afterStage: 'raw_lexical_fallback',
        reason: 'dense_path_filter',
    });
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
