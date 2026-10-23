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

test('published parser degradation stays visible with recovered symbols and legacy unknown evidence', () => {
    const summary = computeSymbolQualitySummary({
        files: [
            { path: 'complete.ts', language: 'typescript', structuralStatus: 'complete' },
            { path: 'recovered.ts', language: 'typescript', structuralStatus: 'recovered', structuralReason: 'syntax_error' },
            { path: 'empty.ts', language: 'typescript', structuralStatus: 'recovered', structuralReason: 'syntax_error' },
            { path: 'missing.py', language: 'python', structuralStatus: 'recovered', structuralReason: 'parser_unavailable' },
            { path: 'failed.go', language: 'go', structuralStatus: 'recovered', structuralReason: 'analysis_failure' },
            { path: 'readme.md', language: 'markdown', structuralStatus: 'unsupported', structuralReason: 'unsupported_language' },
            { path: 'legacy.ts', language: 'typescript' },
        ], symbols: [{ file: 'recovered.ts', kind: 'function' }],
    });
    assert.equal(summary.filesWithNonFileSymbols, 1);
    assert.deepEqual(summary.structuralAnalysis, {
        completeFiles: 1, recoveredFiles: 4, searchOnlyFiles: 1, unknownFiles: 1,
        reasons: [
            { reason: 'analysis_failure', files: 1 }, { reason: 'parser_unavailable', files: 1 },
            { reason: 'syntax_error', files: 2 },
        ],
    });
});

test('published coverage separates expected text-only files from recovery failures', () => {
    const files = [
        { path: 'docs/guide.md', language: 'markdown', structuralStatus: 'unsupported', structuralReason: 'unsupported_language' },
        { path: 'data/config.json', language: 'json', structuralStatus: 'unsupported' },
        { path: 'src/main.cobol', language: 'cobol', structuralStatus: 'unsupported', structuralReason: 'unsupported_language' },
        { path: 'src/complete.ts', language: 'typescript', structuralStatus: 'complete' },
        { path: 'src/empty.ts', language: 'typescript', structuralStatus: 'complete' },
        { path: 'src/recovered.go', language: 'go', structuralStatus: 'recovered', structuralReason: 'parser_unavailable' },
        { path: 'src/failed.rs', language: 'rust', structuralStatus: 'recovered', structuralReason: 'analysis_failure' },
        { path: 'src/legacy.py', language: 'python' },
    ] as const;
    const summary = computeSymbolQualitySummary({ files: [...files], symbols: [] });
    const analysis = summary.structuralAnalysis;

    // Text-only formats are expected coverage, so they are not failure reasons.
    assert.equal(analysis.searchOnlyFiles, 3);
    assert.equal(analysis.completeFiles, 2);
    assert.equal(analysis.recoveredFiles, 2);
    assert.equal(analysis.unknownFiles, 1);
    assert.equal(
        analysis.completeFiles + analysis.recoveredFiles + analysis.searchOnlyFiles + analysis.unknownFiles,
        files.length,
    );
    assert.deepEqual(analysis.reasons, [
        { reason: 'analysis_failure', files: 1 },
        { reason: 'parser_unavailable', files: 1 },
    ]);
    assert.ok(!analysis.reasons.some((entry) => (entry.reason as string) === 'unsupported_language'));
    assert.ok(!('unsupportedFiles' in analysis));

    // A code format without structural support still discloses the missing capability.
    assert.deepEqual(
        summary.languages.find((entry) => entry.language === 'cobol'),
        { language: 'cobol', eligibleFiles: 0, filesWithNonFileSymbols: 0, status: 'search_only' },
    );
    // Complete analysis of a symbol-free file stays complete rather than search-only.
    assert.equal(summary.languages.find((entry) => entry.language === 'typescript')?.status, 'symbol_sparse');
    assert.equal(summary.eligibleFiles, 5);
});

test('missing and unverified publication evidence keeps unknown coverage', () => {
    for (const evidenceAvailability of ['missing', 'unverified'] as const) {
        const summary = unknownSymbolQualitySummary(undefined, evidenceAvailability);
        assert.equal(summary.status, 'unknown');
        assert.equal(summary.evidenceAvailability, evidenceAvailability);
        assert.deepEqual(summary.structuralAnalysis, {
            completeFiles: 0, recoveredFiles: 0, searchOnlyFiles: 0, unknownFiles: 0, reasons: [],
        });
    }
});
