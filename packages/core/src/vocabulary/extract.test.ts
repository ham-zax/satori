import assert from 'node:assert/strict';
import test from 'node:test';
import type { SymbolRecord } from '../symbols/contracts';
import { vocabularyTokens } from './extract';
import { withSourceVocabulary } from './extract';

let sequence = 0;
function record(source: string, overrides: Partial<SymbolRecord> & { name: string; span: SymbolRecord['span'] }): SymbolRecord {
    sequence += 1;
    return {
        symbolKey: `test#${sequence}`,
        symbolInstanceId: `instance-${sequence}`,
        language: 'javascript',
        kind: 'function',
        qualifiedName: overrides.name,
        label: `function ${overrides.name}`,
        file: 'fixture.js',
        parentQualifiedNamePath: [],
        fileHash: 'hash',
        extractorVersion: 'fixture',
        ...overrides,
    };
}

/** Every emitted word must occur on its recorded source line after normalization. */
function assertLinesProveWords(source: string, symbols: readonly SymbolRecord[]): void {
    const lines = source.split(/\r?\n/);
    for (const symbol of symbols) {
        for (const term of symbol.vocabulary?.terms ?? []) {
            assert.ok(term.line >= 1 && term.line <= lines.length,
                `${symbol.qualifiedName}: line ${term.line} out of range`);
            assert.ok(vocabularyTokens(lines[term.line - 1] ?? '').includes(term.term),
                `${symbol.qualifiedName}: ${term.kind} word '${term.term}' missing from line ${term.line}`);
        }
    }
}

test('an enclosing synthetic test title does not become identifier evidence for an inner symbol', () => {
    const source = [
        'describe("budget dashboard", () => {',
        '  it("should not re-run summaries", () => {',
        '    function Inner() { return summarizeTotals(); }',
        '  });',
        '});',
    ].join('\n');
    const [inner] = withSourceVocabulary([record(source, {
        name: 'Inner',
        qualifiedName: 'describe("budget dashboard") callback.it("should not re-run summaries") callback.Inner',
        span: { startLine: 3, endLine: 3 },
    })], source);
    const identifiers = (inner?.vocabulary?.terms ?? []).filter(term => term.kind === 'identifier');
    assert.deepEqual(identifiers.map(term => term.term), ['inner']);
    assert.ok(identifiers.every(term => term.line === 3));
    assertLinesProveWords(source, [inner!]);
});

test('callback display words absent from the definition line are not identifier evidence', () => {
    const source = [
        'describe("children", () => {',
        '  it("warns about keys", () => { warnForMissingKey(child); });',
        '});',
    ].join('\n');
    const [callback] = withSourceVocabulary([record(source, {
        name: 'it("warns about keys") callback',
        qualifiedName: 'describe("children") callback.it("warns about keys") callback',
        span: { startLine: 2, endLine: 2 },
    })], source);
    const identifiers = (callback?.vocabulary?.terms ?? []).filter(term => term.kind === 'identifier');
    assert.ok(identifiers.length > 0, 'words proven on the line are kept');
    assert.ok(!identifiers.some(term => ['callback', 'children', 'describe'].includes(term.term)),
        `display/container words must not be identifiers: ${identifiers.map(term => term.term)}`);
    assertLinesProveWords(source, [callback!]);
});

test('ordinary, member, and C++-style names keep proven identifier evidence', () => {
    const source = [
        'class Series {',
        '  to_numpy() { return new Array(); }',
        '}',
        'function releaseSubscription() { destroyBuffer(); }',
        'void ns::Foo::bar() { return; }',
    ].join('\n');
    const symbols = withSourceVocabulary([
        record(source, { name: 'Series', qualifiedName: 'Series', kind: 'class', span: { startLine: 1, endLine: 3 } }),
        record(source, { name: 'to_numpy', qualifiedName: 'Series.to_numpy', span: { startLine: 2, endLine: 2 } }),
        record(source, { name: 'releaseSubscription', qualifiedName: 'releaseSubscription', span: { startLine: 4, endLine: 4 } }),
        record(source, { name: 'bar', qualifiedName: 'ns::Foo::bar', span: { startLine: 5, endLine: 5 } }),
    ], source);
    const identifiers = new Map(symbols.map(symbol => [
        symbol.name, (symbol.vocabulary?.terms ?? []).filter(term => term.kind === 'identifier').map(term => term.term),
    ]));
    assert.ok(identifiers.get('Series')?.includes('series'));
    assert.ok(identifiers.get('to_numpy')?.includes('numpy'));
    assert.ok(identifiers.get('releaseSubscription')?.includes('release'));
    assert.ok(identifiers.get('bar')?.includes('bar'));
    assertLinesProveWords(source, symbols);
});
