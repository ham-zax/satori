import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchOperators, buildSearchQueryPlan } from './search-query-planning.js';
import { resolveSearchAnswerFocus } from './search-answer-focus.js';
import {
    buildSearchRerankQuery,
    SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
} from './search-rerank-query.js';
import { resolveSearchPolicy } from './search-policy.js';
import {
    runSearchExecution,
    type SearchExecutionHost,
    type SearchExecutionInput,
    type SearchDiagnostics,
} from './search-execution.js';
import { SearchQuerySupport } from './search-query-support.js';
import type { CapabilityResolver } from './capabilities.js';
import { SEARCH_RRF_K } from './search-constants.js';

const result = (relativePath: string, content: string) => ({
    relativePath,
    startLine: 1,
    endLine: 2,
    language: 'typescript',
    content,
    score: 0.9,
});

function buildSupport(
    dirtyResults: ReturnType<typeof result>[],
    unreadPaths: Set<string> = new Set(),
): SearchQuerySupport {
    const support = new SearchQuerySupport({
        normalizeSearchPath: (p: string) => p,
        hasPathSegment: () => false,
        isGeneratedPath: () => false,
        isTestPath: () => false,
        isFixturePath: () => false,
        isDocPath: () => false,
        getContextActiveIgnorePatterns: () => [],
        getContextTrackedRelativePaths: () => [],
        classifyPathCategory: () => 'core',
        shouldIncludeCategoryInScope: () => true,
        capabilities: {
            hasReranker: () => false,
            getDefaultRerankEnabled: () => false,
        } as unknown as CapabilityResolver,
        runtimeFingerprint: {} as never,
        reranker: null,
        gitignoreForceReloadEveryN: 1000,
    });
    // The dirty overlay reads the working tree; the test supplies its results directly.
    support.buildDirtyFileSearchResults = async () => ({ results: dirtyResults, unreadPaths }) as never;
    return support;
}

function buildInput(changedFiles: string[]): SearchExecutionInput {
    const parsed = parseSearchOperators('where is naive utc handling');
    const queryPlan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);
    const answerFocus = resolveSearchAnswerFocus(queryPlan).focus;
    return {
        effectiveRoot: '/repo',
        scope: 'runtime',
        rankingMode: 'auto_changed_first',
        resultMode: 'grouped',
        limit: 10,
        debugMode: 'none',
        semanticQuery: parsed.semanticQuery,
        answerFocus,
        rerankQuery: buildSearchRerankQuery({ semanticQuery: parsed.semanticQuery, answerFocus }),
        rerankQueryProjectionIdentity: SEARCH_RERANK_QUERY_PROJECTION_IDENTITY,
        parsedOperators: parsed,
        queryPlan,
        exactRegistryEligible: false,
        exactRegistryFallbackForTrackedLexical: false,
        freshnessMode: 'synced',
        observedChangedFilesState: { available: true, files: new Set(changedFiles) },
        dirtyFilesNotFreshened: true,
        retrievalPolicy: resolveSearchPolicy({ resultLimit: 10, hasMustOperators: false }),
    };
}

test('dirty overlay contributes one fusion pass weight even when primary and expanded both ran', async () => {
    const input = buildInput(['src/dirty.ts']);
    const semanticQueries: string[] = [];
    const host: SearchExecutionHost = {
        searchQuerySupport: buildSupport([result('src/dirty.ts', 'export function naiveUtc() {}')]),
        semanticSearch: async (request) => {
            semanticQueries.push(request.query);
            return [result('src/clean.ts', 'export function naiveUtcClean() {}')];
        },
        reranker: null,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };

    const outcome = await runSearchExecution(input, host, {} as SearchDiagnostics);

    assert.equal(outcome.kind, 'ok');
    assert.equal(semanticQueries.length >= 2, true, 'primary and expanded semantic passes must both run');
    const clean = outcome.scored.find((candidate) => candidate.result.relativePath === 'src/clean.ts');
    const dirty = outcome.scored.find((candidate) => candidate.result.relativePath === 'src/dirty.ts');
    assert.ok(clean && dirty, 'clean and dirty candidates must both survive');
    assert.deepEqual([...clean.retrievalPasses].sort(), ['expanded', 'primary']);
    assert.deepEqual(dirty.retrievalPasses, ['dirty_overlay']);
    const expected = 1 / (SEARCH_RRF_K + 1);
    assert.equal(clean.fusionScore, expected);
    assert.equal(dirty.fusionScore, expected, 'dirty overlay rank 1 must score 1/(K+1), not twice that');
});

test('indexed results are dropped only for dirty files the overlay re-read', async () => {
    const host: SearchExecutionHost = {
        // The overlay re-read src/reread.ts and found no match; src/unread.ts was over its bounds.
        searchQuerySupport: buildSupport([], new Set(['src/unread.ts'])),
        semanticSearch: async () => [
            result('src/reread.ts', 'export function naiveUtcStale() {}'),
            result('src/unread.ts', 'export function naiveUtcUnread() {}'),
        ],
        reranker: null,
        shouldForceSearchPassFailure: () => false,
        classifyEmbeddingProviderError: () => null,
        classifyVectorBackendError: () => null,
        measureSearchPhase: async (_phase, run) => run(),
    };

    const outcome = await runSearchExecution(
        buildInput(['src/reread.ts', 'src/unread.ts']),
        host,
        {} as SearchDiagnostics,
    );

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(outcome.scored.map((candidate) => candidate.result.relativePath), ['src/unread.ts']);
});
