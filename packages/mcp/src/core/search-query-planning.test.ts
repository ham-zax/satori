import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchQueryPlan, parseSearchOperators } from './search-query-planning.js';

test('quoted must: value stays one literal token after unquoting', () => {
    const parsed = parseSearchOperators('must:"replace(tzinfo=None)" where is naive utc handling');
    assert.deepEqual(parsed.must, ['replace(tzinfo=None)']);
    assert.deepEqual(parsed.semanticQuery, 'where is naive utc handling');
});

test('quoted must: value with escaped quotes is unquoted without splitting', () => {
    const parsed = parseSearchOperators('must:"a \\"quoted\\" phrase" other');
    assert.deepEqual(parsed.must, ['a "quoted" phrase']);
});

test('multiple must: values remain separate tokens', () => {
    const parsed = parseSearchOperators('must:tzinfo must:None check');
    assert.deepEqual(parsed.must, ['tzinfo', 'None']);
});

test('wildcard-looking quoted must: values are treated literally, not as globs', () => {
    const parsed = parseSearchOperators('must:"replace(*, None)" caller');
    assert.deepEqual(parsed.must, ['replace(*, None)']);
    assert.equal(parsed.must[0].includes('*'), true);
    assert.equal(parsed.must[0].includes('('), true);
});

test('unquoted must: value with punctuation stays a single token', () => {
    const parsed = parseSearchOperators('must:replace(tzinfo=None)');
    assert.deepEqual(parsed.must, ['replace(tzinfo=None)']);
});

test('lang: aliases normalize through the canonical language registry', () => {
    assert.deepEqual(parseSearchOperators('lang:py worker').lang, ['python']);
    assert.deepEqual(parseSearchOperators('lang:python worker').lang, ['python']);
    assert.deepEqual(parseSearchOperators('lang:ts worker').lang, ['typescript']);
    assert.deepEqual(parseSearchOperators('lang:tsx worker').lang, ['typescript']);
    assert.equal(parseSearchOperators('lang:py').semanticQuery, 'python');
});

test('lang: preserves unregistered normalized values instead of guessing', () => {
    const parsed = parseSearchOperators('lang:NotARegisteredLanguage worker');
    assert.deepEqual(parsed.lang, ['notaregisteredlanguage']);
});

test('query plans do not carry a numeric lexical relevance weight', () => {
    const parsed = parseSearchOperators('where is the search reranker order decided');
    const plan = buildSearchQueryPlan(parsed.semanticQuery, true, parsed);

    assert.equal('lexicalWeight' in plan, false);
});

test('query plans flag documentation-seeking queries', () => {
    assert.equal(buildSearchQueryPlan('where is trade veto documented', true).documentationSeeking, true);
    assert.equal(buildSearchQueryPlan('readme for the reranker contract', true).documentationSeeking, true);
    assert.equal(buildSearchQueryPlan('guide to index rebuilds', true).documentationSeeking, true);
});

test('query plans do not flag documentation-seeking for unrelated queries', () => {
    assert.equal(buildSearchQueryPlan('how does regime filtering gate entry decisions', true).documentationSeeking, false);
    assert.equal(buildSearchQueryPlan('who calls validate_order', true).documentationSeeking, false);
});

test('how-does behavioral questions request owner-oriented semantic expansion', () => {
    const plan = buildSearchQueryPlan(
        'how does the decision worker send board snapshots and reject late responses',
        true,
    );

    assert.equal(plan.behavioralOwnerSeeking, true);
    assert.equal(plan.documentationSeeking, false);
    assert.equal(plan.route.kind, 'conceptual');

    const documentationPlan = buildSearchQueryPlan(
        'how does the README explain deployment configuration',
        true,
    );
    assert.equal(documentationPlan.behavioralOwnerSeeking, false);
});

test('behavioral questions keep calls in when clauses out of reference intent', () => {
    const queries = [
        'where does useState schedule a re-render when you call the setter',
        'where does useState schedule a re-render when I call the setter',
        'where does React throw when a hook is called outside a component',
    ];
    for (const query of queries) {
        const plan = buildSearchQueryPlan(query, true);
        assert.equal(plan.referenceSeeking, false, query);
        assert.notEqual(plan.route.kind, 'references', query);
        assert.equal(plan.implementationSeeking, true, query);
        assert.equal(plan.referenceDirection, undefined, query);
    }
});

test('explicit reference questions retain reference routing and direction', () => {
    const cases = [
        ['who calls useState', 'callers'],
        ['what does dispatchSetState call', 'callees'],
        ['references to useState', 'callers'],
        ['where is useState called', 'both'],
        ['where is useState used', 'both'],
        ['where does dispatchSetState call scheduleUpdateOnFiber', undefined],
        ['where is useState called when rendering a component', 'both'],
        ['how does dispatchSetState call scheduleUpdateOnFiber when updating state', undefined],
    ] as const;
    for (const [query, direction] of cases) {
        const plan = buildSearchQueryPlan(query, true);
        assert.equal(plan.referenceSeeking, true, query);
        assert.equal(plan.route.kind, 'references', query);
        assert.equal(plan.referenceDirection, direction, query);
    }
});
