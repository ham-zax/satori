import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationRef, Reranker, RepositoryVocabularyResult } from '@satori-code/core';
import type { CapabilityResolver } from './capabilities.js';
import { resolveRepositorySearchTerms } from './search-repository-vocabulary.js';
import { runSearchExecution, type SearchDiagnostics, type SearchExecutionHost, type SearchExecutionInput } from './search-execution.js';
import { SearchQuerySupport } from './search-query-support.js';
import { buildSearchQueryPlan, parseSearchOperators } from './search-query-planning.js';
import { resolveSearchAnswerFocus } from './search-answer-focus.js';
import { buildSearchRerankQuery, SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from './search-rerank-query.js';
import { resolveSearchPolicy } from './search-policy.js';

const question = 'where is cleanup invoked';
const publication = { id: 'held-publication' } as PublicationRef;
const vocabulary: RepositoryVocabularyResult = {
    status: 'ok', publicationId: publication.id, artifactHash: 'artifact-hash',
    terms: ['clearPassiveEffects', 'scheduleUnmount', 'destroy', 'dispose', 'overCap'], matches: [],
};
const candidates = ['effects', 'scheduler'].map((name, index) => ({
    candidateId: name, relativePath: `src/${name}.ts`, startLine: 1, endLine: 3,
    language: 'typescript', content: 'export function clearPassiveEffects() { return true; }',
    score: 0.9 - index / 10, symbolLabel: 'function clearPassiveEffects()',
}));

async function execute(lookup?: () => Promise<RepositoryVocabularyResult>, enabled = true, callerTerms?: string[]) {
    const terms = await resolveRepositorySearchTerms({
        publication, semanticQuery: question, enabled, callerTerms, lookup,
    });
    const parsedOperators = parseSearchOperators(question);
    const queryPlan = buildSearchQueryPlan(question, true, parsedOperators);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    const input: SearchExecutionInput = {
        effectiveRoot: '/repo', scope: 'runtime', rankingMode: 'default', resultMode: 'raw',
        limit: 3, debugMode: 'full', semanticQuery: question, parsedOperators, queryPlan, answerFocus,
        rerankQuery: buildSearchRerankQuery({ semanticQuery: question, answerFocus, callerTerms: terms.resolved.termsEmitted }),
        rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        exactRegistryEligible: false, exactRegistryFallbackForTrackedLexical: false,
        freshnessMode: 'synced', observedChangedFilesState: { available: false, files: new Set() },
        dirtyFilesNotFreshened: false,
        retrievalPolicy: resolveSearchPolicy({ resultLimit: 3, hasMustOperators: false }),
        resolvedAltTerms: terms.resolved, repositoryVocabulary: terms.vocabulary,
    };
    const retrievalQueries: string[] = [];
    const rerankQueries: string[] = [];
    const sourceQueries: string[] = [];
    const reranker: Reranker = {
        getIdentity: () => ({ provider: 'lateon', model: 'test', profile: 'context-v6' }),
        getQueryProjectionVersion: () => SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        rerank: async (query, _documents, options) => {
            rerankQueries.push(query);
            return (options?.identities ?? []).map((_identity, index) => ({ index, relevanceScore: 1 - index / 10 }));
        },
    };
    const host: SearchExecutionHost = {
        searchQuerySupport: new SearchQuerySupport({
            normalizeSearchPath: value => value,
            hasPathSegment: () => false, isGeneratedPath: () => false,
            isTestPath: () => false, isFixturePath: () => false, isDocPath: () => false,
            getContextActiveIgnorePatterns: () => [], getContextTrackedRelativePaths: () => [],
            classifyPathCategory: () => 'srcRuntime', shouldIncludeCategoryInScope: () => true,
            capabilities: { hasReranker: () => true, getDefaultRerankEnabled: () => true } as unknown as CapabilityResolver,
            runtimeFingerprint: {} as never, reranker, gitignoreForceReloadEveryN: 25,
        }),
        semanticSearch: async request => { retrievalQueries.push(request.query); return candidates; },
        reranker,
        buildRerankDocument: async (query, result) => {
            sourceQueries.push(query);
            const document = JSON.stringify({ repository_relative_path: result.relativePath, query_relevant_source_excerpt: result.content });
            return {
                ok: true, document, utf8Bytes: Buffer.byteLength(document), sha256: 'fixture',
                candidateRole: 'implementation', projectionIdentity: 'search_rerank_document_v5',
            };
        },
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null, classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };
    const diagnostics: SearchDiagnostics = {
        queryLength: question.length, limitRequested: 3, resultsBeforeFilter: 0, resultsAfterFilter: 0,
        excludedByIgnore: 0, excludedBySubdirectory: 0, filterPass: 'expanded', freshnessMode: undefined,
        searchPassCount: 0, searchPassSuccessCount: 0, searchPassFailureCount: 0,
        rerankerAttempted: false, rerankerUsed: false, semanticSearchAttempts: 0,
        embeddingCallsByCurrentContract: 0, denseQueriesByCurrentContract: 0, sparseQueriesByCurrentContract: 0,
        rerankerCalls: 0, rerankerCandidates: 0, rerankerInputBytes: 0, rerankerFailures: 0,
        rerankerRetries: 0, rerankerTimeouts: 0, candidatesWithSemanticEvidence: 0,
        candidatesWithLexicalEvidence: 0, candidatesWithCurrentSourceEvidence: 0, semanticExpansionAttempted: false,
    };
    const outcome = await runSearchExecution(input, host, diagnostics);
    assert.equal(outcome.kind, 'ok');
    return { outcome, retrievalQueries, rerankQueries, sourceQueries };
}

test('automatic accepted terms are identical in retrieval and reranking while source selection uses the question', async () => {
    const result = await execute(async () => vocabulary);
    const accepted = vocabulary.terms.slice(0, 4);
    assert.deepEqual(result.retrievalQueries, [question, accepted.join(' ')]);
    assert.equal(result.rerankQueries.length, 1);
    assert.ok(result.rerankQueries[0].includes(`${question} (${accepted.join(', ')})`));
    assert.ok(!result.rerankQueries[0].includes('overCap'));
    assert.deepEqual(result.sourceQueries, [question, question]);
    if (result.outcome.kind !== 'ok') return;
    assert.equal(result.outcome.semanticExpansion.reason, 'repository_vocabulary');
    assert.deepEqual(result.outcome.semanticExpansion.termsEmitted, accepted);
});

test('caller vocabulary wins over automatic terms through retrieval and reranking', async () => {
    const result = await execute(async () => { throw new Error('caller must skip vocabulary'); }, true, ['callerDestroy']);
    assert.deepEqual(result.retrievalQueries, [question, 'callerDestroy']);
    assert.ok(result.rerankQueries[0].includes(`${question} (callerDestroy)`));
    if (result.outcome.kind !== 'ok') return;
    assert.equal(result.outcome.semanticExpansion.reason, 'caller_alt_terms');
    assert.equal(result.outcome.semanticExpansion.repositoryVocabulary, undefined);
});

test('old artifact and disabled vocabulary preserve legacy execution bytes and provider queries', async () => {
    const legacy = await execute();
    const missing = await execute(async () => ({ ...vocabulary, status: 'missing', terms: [] }));
    const disabled = await execute(async () => { throw new Error('disabled vocabulary lookup'); }, false);
    for (const result of [missing, disabled]) {
        assert.equal(JSON.stringify(result), JSON.stringify(legacy));
    }
});
