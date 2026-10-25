import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSearchExpansionDecision } from './search-execution.js';

const defaults = {
    retrievalMode: 'hybrid' as const,
    routeKind: 'conceptual' as const,
    exactRegistryFallback: false,
    operatorConstraintPresent: false,
    explicitRoleCuePresent: false,
    primaryScopedCandidateCount: 3,
    primaryFailed: false,
};

test('semantic expansion is skipped for bounded primary evidence and deterministic routes', () => {
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, retrievalMode: 'lexical' }),
        { expand: false, reason: 'lexical_route', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, routeKind: 'structural' }),
        { expand: false, reason: 'deterministic_route_primary', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, explicitRoleCuePresent: true }),
        { expand: false, reason: 'explicit_role_cue', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, primaryScopedCandidateCount: 5 }),
        { expand: false, reason: 'primary_candidate_pool_sufficient', primaryScopedCandidateCount: 5 },
    );
});

test('behavioral-owner queries expand even when the primary candidate pool is numerically sufficient', () => {
    assert.deepEqual(
        resolveSearchExpansionDecision({
            ...defaults,
            behavioralOwnerSeeking: true,
            primaryScopedCandidateCount: 23,
        }),
        {
            expand: true,
            reason: 'behavioral_owner_query',
            primaryScopedCandidateCount: 23,
        },
    );
});

test('semantic expansion remains available for ambiguous, constrained, mixed and failed primary passes', () => {
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults }),
        { expand: true, reason: 'primary_candidate_pool_small', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, routeKind: 'mixed' }),
        { expand: true, reason: 'mixed_route', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, operatorConstraintPresent: true }),
        { expand: true, reason: 'operator_constraint', primaryScopedCandidateCount: 3 },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({ ...defaults, primaryFailed: true }),
        { expand: true, reason: 'primary_failed_fallback', primaryScopedCandidateCount: 3 },
    );
});

test('semantic expansion does not repeat a terminal provider failure', () => {
    assert.deepEqual(
        resolveSearchExpansionDecision({
            ...defaults,
            primaryFailed: true,
            primaryFailureRetryable: false,
        }),
        {
            expand: false,
            reason: 'primary_terminal_provider_failure',
            primaryScopedCandidateCount: 3,
        },
    );
    assert.deepEqual(
        resolveSearchExpansionDecision({
            ...defaults,
            primaryFailed: true,
            primaryFailureRetryable: true,
        }),
        { expand: true, reason: 'primary_failed_fallback', primaryScopedCandidateCount: 3 },
    );
});

test('buildSearchLexicalFallbackTerms supports compoundJoin', async () => {
    const { buildSearchLexicalFallbackTerms } = await import('./search-query-planning.js');
    const termsWithoutJoin = buildSearchLexicalFallbackTerms('where does react bail out of render', { compoundJoin: false });
    assert.ok(termsWithoutJoin.includes('bail'));
    assert.ok(!termsWithoutJoin.includes('bailout'));

    const termsWithJoin = buildSearchLexicalFallbackTerms('where does react bail out of render', { compoundJoin: true });
    assert.ok(termsWithJoin.includes('bailout'));
    assert.ok(termsWithJoin.includes('bail'));
});

test('search-execution re-exports the shared production path classifier', async () => {
    const { isNonProductionDistractor } = await import('./search-execution.js');
    const shared = await import('./search-non-production-path.js');
    assert.equal(isNonProductionDistractor, shared.isNonProductionDistractor);
});

test('hasTestOrDocIntent allows test or doc seeking queries to bypass demotion', async () => {
    const { hasTestOrDocIntent } = await import('./search-execution.js');
    // The plan fields are testSeeking and documentationSeeking. A mock using
    // docsSeeking left both undefined, so the plan branch below was never
    // exercised and every assertion fell through to the query-text regex.
    const neitherSeeking = { testSeeking: false, documentationSeeking: false } as any;
    assert.equal(hasTestOrDocIntent(neitherSeeking, 'where is useeffect cleanup called on unmount'), false);
    assert.equal(hasTestOrDocIntent(neitherSeeking, 'look at the test file for commit work'), true);
    assert.equal(hasTestOrDocIntent(neitherSeeking, 'read the documentation for hooks'), true);

    // The plan branch: each field alone must trigger, with a query text that
    // contains none of the cue words the regex looks for.
    const cleanQuery = 'entry point for the commit phase';
    assert.equal(hasTestOrDocIntent({ testSeeking: true, documentationSeeking: false } as any, cleanQuery), true, 'testSeeking alone');
    assert.equal(hasTestOrDocIntent({ testSeeking: false, documentationSeeking: true } as any, cleanQuery), true, 'documentationSeeking alone');
    assert.equal(hasTestOrDocIntent(neitherSeeking, cleanQuery), false, 'neither seeking');

    // A real plan, not a mock: the fields must be the ones the planner emits.
    const { buildSearchQueryPlan } = await import('./search-query-planning.js');
    assert.equal(hasTestOrDocIntent(buildSearchQueryPlan('find tests for trade veto behavior', true), 'anything'), true);
    assert.equal(hasTestOrDocIntent(buildSearchQueryPlan('where is trade veto documented', true), 'anything'), true);
    assert.equal(hasTestOrDocIntent(buildSearchQueryPlan('trading risk management', true), 'trading'), false);
});

test('resolveSearchFlags defaults compound_join and path_demotion on and the rest off', async () => {
    const { resolveSearchFlags } = await import('./search-flags.js');
    const flags = resolveSearchFlags();
    assert.equal(flags.compound_join, true);
    assert.equal(flags.path_demotion, true);
    assert.equal(flags.prf, false);
    assert.equal(flags.rerank_blend, false);

    // The token-array form ("baseline") is rejected, not coerced: the resolver
    // and the tool schema now agree on a single record shape.
    assert.throws(() => resolveSearchFlags(['baseline'] as unknown as Record<string, boolean>), /received array/);

    // A partial object only overwrites the keys it names; the remaining
    // defaults stay in effect. The returned set is the runtime truth.
    const explicit = resolveSearchFlags({ compound_join: false, rerank_blend: true });
    assert.equal(explicit.compound_join, false);
    assert.equal(explicit.path_demotion, true);
    assert.equal(explicit.rerank_blend, true);
});

test('the synonyms flag no longer resolves', async () => {
    const { resolveSearchFlags } = await import('./search-flags.js');
    assert.equal('synonyms' in resolveSearchFlags(), false);
    assert.equal('synonyms' in resolveSearchFlags({ synonyms: true } as any), false);
    assert.throws(() => resolveSearchFlags(['synonyms'] as unknown as Record<string, boolean>), /received array/);
    const { buildIsolatedSynonymQuery, CODE_LIFECYCLE_SYNONYMS } = await import('./search-execution.js') as any;
    assert.equal(buildIsolatedSynonymQuery, undefined);
    assert.equal(CODE_LIFECYCLE_SYNONYMS, undefined);
});

test('the flags schema accepts the record form and rejects every other shape', async () => {
    const { searchCodebaseTool } = await import('../tools/search_codebase.js');
    const { resolveSearchFlags } = await import('./search-flags.js');
    const schema = (searchCodebaseTool as any).inputSchemaZod({
        capabilities: {
            getMaxSearchResultTotal: () => 100,
            getDefaultSearchLimit: () => 10,
            getMaxSearchPageSize: () => 10,
        },
    });
    const base = { path: '/absolute/path', query: 'q' };

    // The record form: the one shape the public schema accepts, and the only
    // shape the resolver accepts. Schema and resolver must not disagree again.
    const record = schema.safeParse({ ...base, flags: { rerank_blend: true, path_demotion: false } });
    assert.equal(record.success, true, 'a name-to-boolean record must be accepted');
    assert.deepEqual(record.data?.flags, { rerank_blend: true, path_demotion: false });

    const resolved = resolveSearchFlags(record.data?.flags);
    assert.equal(resolved.rerank_blend, true);
    assert.equal(resolved.path_demotion, false);
    assert.equal(resolved.compound_join, true, 'unnamed flags keep their default');

    // The record form leaves unnamed flags at their default; the A7 defect was
    // the harness recording this partial set as if it were the whole set.
    assert.equal(resolveSearchFlags({ rerank_blend: true }).compound_join, true);
    assert.equal(resolveSearchFlags({ rerank_blend: true }).path_demotion, true);

    // A8's F7 widened this to z.union([record, array]). Reverted in C2: the
    // token array is no longer a public parameter, so the schema must refuse it
    // and the resolver must refuse it too rather than accepting what the tool
    // surface cannot express.
    assert.equal(schema.safeParse({ ...base, flags: ['rerank_blend', 'no-path_demotion'] }).success, false);
    assert.throws(
        () => resolveSearchFlags(['rerank_blend', 'no-path_demotion'] as unknown as Record<string, boolean>),
        /search flags must be a record of flag names to booleans; received array/,
    );

    // Still rejected: a form neither side accepts.
    assert.equal(schema.safeParse({ ...base, flags: 'rerank_blend' }).success, false);
    assert.equal(schema.safeParse({ ...base, flags: [1, 2] }).success, false);
    assert.equal(schema.safeParse({ ...base, flags: { rerank_blend: 'yes' } }).success, false);
});

test('buildSearchLexicalFallbackTerms does not read the environment', async () => {
    const { buildSearchLexicalFallbackTerms } = await import('./search-query-planning.js');
    const { DEFAULT_SEARCH_FLAGS } = await import('./search-flags.js');
    const previous = process.env.SATORI_SEARCH_FLAGS;
    try {
        process.env.SATORI_SEARCH_FLAGS = 'no-compound_join';
        // No options: must fall back to the compiled default, not the env.
        assert.equal(
            buildSearchLexicalFallbackTerms('where does react bail out of render')
                .includes('bailout'),
            DEFAULT_SEARCH_FLAGS.compound_join,
            'an omitted option must use the flag default, not SATORI_SEARCH_FLAGS',
        );
        // The explicit option still wins in both directions.
        assert.equal(
            buildSearchLexicalFallbackTerms('where does react bail out of render', { compoundJoin: true })
                .includes('bailout'),
            true,
        );
        process.env.SATORI_SEARCH_FLAGS = 'compound_join';
        assert.equal(
            buildSearchLexicalFallbackTerms('where does react bail out of render', { compoundJoin: false })
                .includes('bailout'),
            false,
            'an explicit false must not be overridden by the env',
        );
    } finally {
        if (previous === undefined) delete process.env.SATORI_SEARCH_FLAGS;
        else process.env.SATORI_SEARCH_FLAGS = previous;
    }
});

test('search_codebase accepts alt_terms and routes into isolated expansion pass', async () => {
    const { searchCodebaseTool } = await import('../tools/search_codebase.js');
    const schema = (searchCodebaseTool as any).inputSchemaZod({
        capabilities: {
            getMaxSearchResultTotal: () => 100,
            getDefaultSearchLimit: () => 10,
            getMaxSearchPageSize: () => 10,
        },
    });

    const parsedArray = schema.safeParse({
        path: '/absolute/path',
        query: 'where is cleanup executed',
        alt_terms: ['destroy', 'unmount'],
    });
    assert.equal(parsedArray.success, true);
    assert.deepEqual(parsedArray.data?.alt_terms, ['destroy', 'unmount']);

    const parsedString = schema.safeParse({
        path: '/absolute/path',
        query: 'where is cleanup executed',
        alt_terms: 'destroy unmount',
    });
    assert.equal(parsedString.success, true);
    assert.equal(parsedString.data?.alt_terms, 'destroy unmount');
});

test('one constant caps alt_terms in the schema, the description, and the string form', async () => {
    const { SEARCH_ALT_TERMS_MAX, SEARCH_ALT_TERMS_STRING_MAX_CHARS, SEARCH_ALT_TERMS_TERM_MAX_CHARS } = await import('./search-constants.js');
    const { searchCodebaseTool } = await import('../tools/search_codebase.js');
    assert.equal(SEARCH_ALT_TERMS_MAX, 4);
    const schema = (searchCodebaseTool as any).inputSchemaZod({
        capabilities: {
            getMaxSearchResultTotal: () => 100,
            getDefaultSearchLimit: () => 10,
            getMaxSearchPageSize: () => 10,
        },
    });

    // Array form: N is accepted, N+1 is rejected.
    const atCap = schema.safeParse({
        path: '/absolute/path',
        query: 'q',
        alt_terms: ['a', 'b', 'c', 'd'],
    });
    assert.equal(atCap.success, true, 'N terms must be accepted');
    const overCap = schema.safeParse({
        path: '/absolute/path',
        query: 'q',
        alt_terms: ['a', 'b', 'c', 'd', 'e'],
    });
    assert.equal(overCap.success, false, 'N+1 array terms must be rejected');

    assert.equal(schema.safeParse({ path: '/absolute/path', query: 'q',
        alt_terms: ['x'.repeat(SEARCH_ALT_TERMS_TERM_MAX_CHARS)],
    }).success, true, 'a term at the character cap must be accepted');
    assert.equal(schema.safeParse({ path: '/absolute/path', query: 'q',
        alt_terms: ['x'.repeat(SEARCH_ALT_TERMS_TERM_MAX_CHARS + 1)],
    }).success, false, 'a long array term must not bypass the bounded query payload');

    // String form: previously unbounded. Now bounded, and the bound is derived
    // from the same N.
    const longString = Array.from({ length: SEARCH_ALT_TERMS_MAX }, () => 'x'.repeat(200)).join(' ');
    assert.ok(longString.length > SEARCH_ALT_TERMS_STRING_MAX_CHARS);
    const overString = schema.safeParse({ path: '/absolute/path', query: 'q', alt_terms: longString });
    assert.equal(overString.success, false, 'an over-long string form must be rejected');

    // The advertised description states the same cap the schema enforces.
    const description = schema.shape.alt_terms.description ?? '';
    assert.ok(
        description.toLowerCase().includes(`at most ${SEARCH_ALT_TERMS_MAX} terms`),
        `description must state the cap; got: ${description}`,
    );
});
