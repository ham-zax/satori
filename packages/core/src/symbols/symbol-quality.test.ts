import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeSymbolQualitySummary,
    formatSymbolQualityMarker,
    isLanguageSymbolEligible,
    unknownSymbolQualitySummary,
} from './symbol-quality';

test('typescript is symbol-eligible; markdown/json-style search_only are not', () => {
    assert.equal(isLanguageSymbolEligible('typescript'), true);
    assert.equal(isLanguageSymbolEligible('python'), true);
    // search_only claims in capability matrix
    assert.equal(isLanguageSymbolEligible('markdown'), false);
    assert.equal(isLanguageSymbolEligible('json'), false);
    assert.equal(isLanguageSymbolEligible('totally-unknown-lang'), null);
});

test('computeSymbolQualitySummary returns symbol_rich when most eligible files have non-file symbols', () => {
    const summary = computeSymbolQualitySummary({
        files: [
            { path: 'a.ts', language: 'typescript' },
            { path: 'b.ts', language: 'typescript' },
            { path: 'c.ts', language: 'typescript' },
            { path: 'd.ts', language: 'typescript' },
            { path: 'e.ts', language: 'typescript' },
        ],
        symbols: [
            { file: 'a.ts', kind: 'file' },
            { file: 'a.ts', kind: 'function' },
            { file: 'b.ts', kind: 'file' },
            { file: 'b.ts', kind: 'class' },
            { file: 'c.ts', kind: 'file' },
            { file: 'c.ts', kind: 'method' },
            { file: 'd.ts', kind: 'file' },
            { file: 'e.ts', kind: 'file' },
        ],
    });
    // 3/5 = 0.60 → symbol_rich
    assert.equal(summary.status, 'symbol_rich');
    assert.equal(summary.basis, 'symbol_registry');
    assert.equal(summary.evidenceAvailability, 'ready');
    assert.equal(summary.eligibleFiles, 5);
    assert.equal(summary.filesWithNonFileSymbols, 3);
    assert.equal(summary.fileOwnerOnlyFiles, 2);
    assert.equal(summary.nonFileSymbolCount, 3);
    assert.equal(summary.languages[0]?.language, 'typescript');
    assert.equal(summary.languages[0]?.status, 'symbol_rich');
    assert.match(summary.message, /symbol evidence/i);
});

test('computeSymbolQualitySummary returns mixed for partial coverage', () => {
    const summary = computeSymbolQualitySummary({
        files: [
            { path: 'a.ts', language: 'typescript' },
            { path: 'b.ts', language: 'typescript' },
            { path: 'c.ts', language: 'typescript' },
            { path: 'd.ts', language: 'typescript' },
            { path: 'e.ts', language: 'typescript' },
        ],
        symbols: [
            { file: 'a.ts', kind: 'file' },
            { file: 'a.ts', kind: 'function' },
            { file: 'b.ts', kind: 'file' },
            { file: 'c.ts', kind: 'file' },
            { file: 'd.ts', kind: 'file' },
            { file: 'e.ts', kind: 'file' },
        ],
    });
    // 1/5 = 0.20 → mixed
    assert.equal(summary.status, 'mixed');
    assert.equal(summary.filesWithNonFileSymbols, 1);
    assert.equal(summary.fileOwnerOnlyFiles, 4);
});

test('computeSymbolQualitySummary returns symbol_sparse for file-owner-only eligible files', () => {
    const summary = computeSymbolQualitySummary({
        files: [
            { path: 'a.ts', language: 'typescript' },
            { path: 'b.ts', language: 'typescript' },
            { path: 'c.ts', language: 'typescript' },
        ],
        symbols: [
            { file: 'a.ts', kind: 'file' },
            { file: 'b.ts', kind: 'file' },
            { file: 'c.ts', kind: 'file' },
        ],
    });
    assert.equal(summary.status, 'symbol_sparse');
    assert.equal(summary.eligibleFiles, 3);
    assert.equal(summary.filesWithNonFileSymbols, 0);
    assert.equal(summary.fileOwnerOnlyFiles, 3);
    assert.match(summary.message, /weak navigation/i);
});

test('computeSymbolQualitySummary returns search_only for search-only languages only', () => {
    const summary = computeSymbolQualitySummary({
        files: [
            { path: 'README.md', language: 'markdown' },
            { path: 'data.json', language: 'json' },
        ],
        symbols: [
            { file: 'README.md', kind: 'file' },
            { file: 'data.json', kind: 'file' },
        ],
    });
    assert.equal(summary.status, 'search_only');
    assert.equal(summary.eligibleFiles, 0);
    assert.equal(summary.fileOwnerOnlyFiles, 0);
    assert.notEqual(summary.status, 'symbol_sparse');
});

test('computeSymbolQualitySummary does not mark search_only repo as symbol_sparse when mixed with eligible empty', () => {
    const summary = computeSymbolQualitySummary({
        files: [
            { path: 'README.md', language: 'markdown' },
            { path: 'a.ts', language: 'typescript' },
        ],
        symbols: [
            { file: 'README.md', kind: 'file' },
            { file: 'a.ts', kind: 'file' },
        ],
    });
    // one eligible file-owner-only → ratio 0 → symbol_sparse (eligible exists)
    assert.equal(summary.status, 'symbol_sparse');
    assert.equal(summary.eligibleFiles, 1);
    assert.equal(summary.languages.find((entry) => entry.language === 'markdown')?.status, 'search_only');
});

test('computeSymbolQualitySummary returns unknown for empty files', () => {
    const summary = computeSymbolQualitySummary({ files: [], symbols: [] });
    assert.equal(summary.status, 'unknown');
    assert.equal(summary.eligibleFiles, 0);
});

test('unknownSymbolQualitySummary is stable', () => {
    const summary = unknownSymbolQualitySummary();
    assert.equal(summary.status, 'unknown');
    assert.equal(summary.basis, 'symbol_registry');
    assert.equal(summary.evidenceAvailability, 'missing');
    assert.equal(formatSymbolQualityMarker(summary), 'symbolQuality=unknown');
});

test('formatSymbolQualityMarker is deterministic compact form', () => {
    assert.equal(
        formatSymbolQualityMarker(computeSymbolQualitySummary({
            files: [{ path: 'a.ts', language: 'typescript' }],
            symbols: [{ file: 'a.ts', kind: 'file' }, { file: 'a.ts', kind: 'function' }],
        })),
        'symbolQuality=symbol_rich',
    );
});
