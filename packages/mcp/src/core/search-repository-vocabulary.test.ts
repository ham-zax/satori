import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationRef, RepositoryVocabularyResult, SymbolRecord, SymbolRegistry } from '@satori-code/core';
import { allowsRepositoryVocabulary, buildRepositoryVocabularyFilter, resolveRepositorySearchTerms } from './search-repository-vocabulary.js';
import { SearchQuerySupport } from './search-query-support.js';
import { buildSearchQueryPlan, parseSearchOperators } from './search-query-planning.js';
import { classifyPathCategory, shouldIncludeCategoryInScope } from './search-ranking-policy.js';

const publication = { id: 'held-publication' } as PublicationRef;
const automatic: RepositoryVocabularyResult = {
    status: 'ok', publicationId: publication.id,
    terms: ['clearPassiveEffects', 'scheduleUnmount'], matches: [],
};
const support = new SearchQuerySupport({ classifyPathCategory, shouldIncludeCategoryInScope } as never);

test('conceptual questions naming an identifier can expand; exact and structural requests cannot', () => {
    const conceptual = buildSearchQueryPlan('how are work units cancelled before completion', true);
    assert.equal(conceptual.route.kind, 'conceptual');
    assert.equal(allowsRepositoryVocabulary(conceptual), true);
    for (const query of ['where does React run the cleanup function of useEffect',
        'where does React bail out of re-rendering a component whose props did not change']) {
        const operators = parseSearchOperators(query);
        const plan = buildSearchQueryPlan(operators.semanticQuery, true, operators);
        assert.equal(plan.route.kind, 'mixed');
        assert.equal(allowsRepositoryVocabulary(plan), true);
    }
    for (const kind of ['exact_identifier', 'exact_path', 'literal', 'configuration', 'ownership', 'references', 'structural'] as const) {
        const plan = buildSearchQueryPlan('cleanup effects', true);
        assert.equal(allowsRepositoryVocabulary({ route: { ...plan.route, kind } }), false, kind);
    }
});

test('lookup uses the held publication and a bounded term count; caller input and flag off skip it', async () => {
    let calls = 0;
    const lookup = async (lease: PublicationRef, query: string, limit: number) => {
        calls++;
        assert.equal(lease, publication);
        assert.equal(query, 'cleanup effects');
        assert.equal(limit, 4);
        return automatic;
    };
    const input = { publication, semanticQuery: 'cleanup effects', enabled: true, lookup };
    const result = await resolveRepositorySearchTerms(input);
    assert.deepEqual(result.resolved.termsEmitted, automatic.terms);
    assert.equal(result.vocabulary, automatic);
    for (const callerTerms of [['callerOnly'], '', []]) {
        const caller = await resolveRepositorySearchTerms({ ...input, callerTerms });
        assert.equal(caller.vocabulary, undefined);
        assert.deepEqual(caller.resolved.termsEmitted, callerTerms === '' ? [] : callerTerms);
    }
    assert.equal((await resolveRepositorySearchTerms({ ...input, enabled: false })).vocabulary, undefined);
    assert.equal(calls, 1);
});

test('old, unavailable, mismatched, and empty artifacts preserve the legacy resolved bytes', async () => {
    const input = { publication, semanticQuery: 'cleanup effects', enabled: true };
    const legacyBytes = JSON.stringify(await resolveRepositorySearchTerms(input));
    for (const status of ['missing', 'incompatible', 'corrupt', 'budget_exceeded'] as const) {
        const result = await resolveRepositorySearchTerms({
            ...input, lookup: async () => ({ ...automatic, status }),
        });
        assert.equal(JSON.stringify(result), legacyBytes, status);
    }
    for (const result of [{ ...automatic, publicationId: 'other-publication' }, { ...automatic, terms: [] }]) {
        assert.equal(JSON.stringify(await resolveRepositorySearchTerms({
            ...input, lookup: async () => result,
        })), legacyBytes);
    }
});

function symbol(id: string, file: string, language = 'typescript'): SymbolRecord {
    return {
        symbolKey: id, symbolInstanceId: id, name: 'clearPassiveEffects', qualifiedName: 'clearPassiveEffects',
        parentQualifiedNamePath: [], kind: 'function', file, language,
        label: 'function clearPassiveEffects()', span: { startLine: 1, endLine: 3 },
        fileHash: 'file-hash', extractorVersion: 'test',
    };
}

test('posting predicate uses registry identity and composes scope, language, paths and subtree without scanning symbols', async () => {
    const symbols = [
        symbol('accepted', 'src/effects.ts'),
        symbol('subtree', 'src-other/effects.ts'),
        symbol('language', 'src/effects.py', 'python'),
        symbol('excluded-path', 'src/effects.test.ts'),
        symbol('scope', 'docs/effects.md', 'typescript'),
        symbol('include-path', 'src/unrelated.ts'),
    ];
    const registry = {
        symbolsByInstanceId: new Map(symbols.map(value => [value.symbolInstanceId, value])),
        get symbols(): never { throw new Error('full-registry scan is forbidden'); },
    } as unknown as SymbolRegistry;
    const accepts = buildRepositoryVocabularyFilter(registry, support.buildExactRegistrySymbolFilter({
        scope: 'runtime',
        parsedOperators: parseSearchOperators('cleanup effects lang:typescript path:src/effects* -path:*.test.ts'),
        requestedSubdirectory: { relativePrefix: 'src' },
    }));
    const result = await resolveRepositorySearchTerms({
        publication, semanticQuery: 'cleanup effects', enabled: true, accepts,
        lookup: async (_publication, _query, _limit, predicate) => {
            const matches = symbols.filter(value => predicate!(value));
            assert.deepEqual(matches.map(value => value.symbolInstanceId), ['accepted']);
            assert.equal(predicate!({ ...symbols[0], symbolInstanceId: 'unknown' }), false);
            assert.equal(predicate!({ ...symbols[0], file: 'other.ts' }), false);
            assert.equal(predicate!({ ...symbols[0], language: 'python' }), false);
            return { ...automatic, terms: matches.map(value => value.qualifiedName) };
        },
    });
    assert.deepEqual(result.resolved.termsEmitted, ['clearPassiveEffects']);
});

test('posting predicate preserves exact symbol must/exclude constraints', () => {
    const symbols = [symbol('allowed', 'src/effects.ts'), symbol('excluded', 'src/forbidden.ts')];
    const registry = { symbolsByInstanceId: new Map(symbols.map(value => [value.symbolInstanceId, value])) };
    const accepts = buildRepositoryVocabularyFilter(registry, support.buildExactRegistrySymbolFilter({
        scope: 'runtime', parsedOperators: parseSearchOperators('cleanup effects must:clearPassiveEffects exclude:forbidden'),
    }));
    assert.equal(accepts(symbols[0]), true);
    assert.equal(accepts(symbols[1]), false);
});
