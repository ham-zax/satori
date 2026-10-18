import assert from 'node:assert/strict';
import test from 'node:test';

import type { PublicationRef } from '../generation/contracts';
import type { VectorCandidate, VectorDatabase, VectorDocument } from '../vectordb';
import { buildSemanticSearchCandidateTrace, SemanticSearchService } from './semantic-search-service';
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

test('Sparse lexical fallback fusion reports RRF scores only when fallback rows are present', async () => {
    const primary = candidate('all-terms', 'src/owner.ts', 5);
    const fallback = candidate('any-terms', 'src/other.ts', 40);
    let fallbackCandidates: VectorCandidate[] = [fallback];
    const lexicalRequests: Array<{ query: string; matchMode?: string }> = [];
    const vectorDatabase = {
        getBackendInfo: () => ({
            provider: 'lancedb',
            transport: 'embedded',
            address: 'test',
            lexicalMatchModes: ['all_terms', 'any_terms'],
            defaultLexicalMatchMode: 'all_terms',
        }),
        retrieveLexical: async (
            _collectionName: string,
            request: { query: string; matchMode?: string },
        ) => {
            lexicalRequests.push(request);
            return request.matchMode === 'any_terms' ? fallbackCandidates : [primary];
        },
    } as unknown as VectorDatabase;
    const service = new SemanticSearchService({
        getVectorDatabase: () => vectorDatabase,
        embeddingAccess: {
            getEmbedding: () => {
                throw new Error('Sparse search must not access embeddings.');
            },
            assertEmbeddingIdentityCurrent: () => undefined,
        },
        authority: {
            acquireCurrentRead: () => null,
            isReadAdmitted: async () => true,
        },
        isHybridEnabled: () => true,
        canonicalizeCodebasePath: (codebasePath) => codebasePath,
    });
    const publication: PublicationRef = {
        id: 'publication-1',
        publication: {
            version: 2,
            id: 'publication-1',
            canonicalRoot: '/repo',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 'complete',
            policy: {
                profile: 'default',
                customExtensions: [],
                customIgnorePatterns: [],
                fileBasedIgnorePatterns: [],
                supportedExtensions: [],
                effectiveIgnorePatterns: [],
                policyHash: 'test-policy',
                controlSignature: 'test-control',
            },
            format: {
                indexFormatVersion: 'test-index-format',
                embeddingIdentity: 'test-embedding',
                relationshipVersion: 'test-relationships',
            },
            vector: { collectionName: 'test-collection', indexedFiles: 2, totalChunks: 2 },
            packageOwnership: false,
            navigation: null,
        },
    };
    const request = {
        codebasePath: '/repo',
        query: 'target helper',
        topK: 2,
        retrievalMode: 'lexical' as const,
        lexicalMatchMode: 'all_terms' as const,
        lexicalFallbackTerms: ['target'],
    };

    const fusedResults = await service.searchInPublication(publication, request);
    const expectedFused = fuseVectorCandidatesWithRrf({
        dense: [],
        lexical: [primary],
        lexicalFallback: [fallback],
        lexicalFallbackLimit: 2,
        k: VECTOR_CANDIDATE_RRF_K_V1,
        limit: 2,
    });
    assert.deepEqual(
        fusedResults.map(({ candidateId, score, backendScore }) => ({
            candidateId,
            score,
            backendScore,
        })),
        expectedFused.map(({ document, score }) => ({
            candidateId: document.id,
            score,
            backendScore: score,
        })),
    );
    assert.deepEqual(fusedResults.map((result) => result.backendScoreKind), ['rrf_fusion', 'rrf_fusion']);
    assert.deepEqual(lexicalRequests.map(({ query, matchMode }) => ({ query, matchMode })), [
        { query: 'target helper', matchMode: 'all_terms' },
        { query: 'target', matchMode: 'any_terms' },
    ]);

    fallbackCandidates = [];
    const emptyFallbackResults = await service.searchInPublication(publication, request);
    assert.deepEqual(emptyFallbackResults.map((result) => result.backendScoreKind), ['lexical_rank']);
    assert.deepEqual(emptyFallbackResults.map((result) => result.score), [primary.score]);

    const plainLexicalResults = await service.searchInPublication(publication, {
        ...request,
        lexicalFallbackTerms: undefined,
    });
    assert.deepEqual(plainLexicalResults.map((result) => result.backendScoreKind), ['lexical_rank']);
    assert.deepEqual(plainLexicalResults.map((result) => result.score), [primary.score]);
    assert.deepEqual(lexicalRequests.slice(-3).map(({ matchMode }) => matchMode), [
        'all_terms',
        'any_terms',
        'all_terms',
    ]);
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
