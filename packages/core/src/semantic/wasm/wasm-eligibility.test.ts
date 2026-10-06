import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';

const CARGO_MANIFEST = {
    path: 'Cargo.toml',
    role: 'manifest',
    source: '[package]\nname = "demo"\nversion = "0.1.0"\n',
    sourceHash: 'hash-cargo',
};

test('Rust file with only #[cfg(test)] stays eligible and resolves ordinary calls', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const source = [
        'pub fn Help() -> i32 { 1 }',
        '#[cfg(test)] mod tests {',
        '    use super::*;',
        '    #[test] fn calls_help() { Help(); }',
        '}',
        'pub fn Run() -> i32 { Help() }',
    ].join('\n');

    const evidence = await analyzer.analyze({
        language: 'rust',
        auxiliaryFiles: [CARGO_MANIFEST],
        sourceFiles: [{ path: 'src/lib.rs', source, sourceHash: 'hash-lib' }],
    });

    const occurrences = evidence.occurrencesByFile.get('src/lib.rs') ?? [];
    assert.ok(occurrences.length > 0, 'cfg(test) file must be modeled, not dropped');
    assert.ok(occurrences.some((occurrence) => (
        occurrence.decision === 'resolved' && occurrence.proof.strategy === 'direct_call'
    )), 'ordinary direct call in a cfg(test) file resolves');
    assert.equal(evidence.skippedFiles, undefined);
    assert.equal(evidence.coverage?.status, 'complete');
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 1);
});

test('calls inside #[cfg(test)] items are suppressed while ordinary calls resolve', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const source = [
        'pub fn Help() -> i32 { 1 }',
        'pub fn Run() -> i32 { Help() }',
        '#[cfg(test)] mod tests {',
        '    use super::*;',
        '    #[test] fn calls_help() { Help(); }',
        '}',
    ].join('\n');

    const evidence = await analyzer.analyze({
        language: 'rust',
        auxiliaryFiles: [CARGO_MANIFEST],
        sourceFiles: [{ path: 'src/lib.rs', source, sourceHash: 'hash-lib' }],
    });

    const occurrences = evidence.occurrencesByFile.get('src/lib.rs') ?? [];
    assert.equal(occurrences.length, 1);
    const [ordinary] = occurrences;
    assert.equal(ordinary.decision, 'resolved');
    assert.equal(ordinary.proof.strategy, 'direct_call');
    assert.equal(ordinary.targetProvenance?.name, 'Help');
    assert.ok(
        ordinary.callSpan.startByte >= source.indexOf('pub fn Run'),
        'the surviving call site must be the ordinary one, not the test-gated one',
    );
    assert.equal(evidence.skippedFiles, undefined);
    assert.equal(evidence.coverage?.status, 'complete');
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 1);
});

test('Rust file with #[cfg(feature)] is reported as degraded unmodeled_source', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const source = '#[cfg(feature = "x")] pub fn Help() -> i32 { 1 } pub fn Run() -> i32 { Help() }';

    const evidence = await analyzer.analyze({
        language: 'rust',
        auxiliaryFiles: [CARGO_MANIFEST],
        sourceFiles: [{ path: 'src/lib.rs', source, sourceHash: 'hash-lib' }],
    });

    assert.equal([...evidence.occurrencesByFile.values()].flat().length, 0);
    assert.deepEqual(evidence.skippedFiles, [
        { path: 'src/lib.rs', reason: 'unmodeled_source', bytes: Buffer.byteLength(source, 'utf8') },
    ]);
    assert.equal(evidence.coverage?.status, 'degraded');
    assert.equal(evidence.coverage?.sourceFileCount, 1);
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 0);
    assert.deepEqual(evidence.coverage?.skippedFiles, evidence.skippedFiles);
});

test('C++ header with a canonical include guard is analyzed as if the guard were absent', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const source = [
        '#ifndef UTIL_H',
        '#define UTIL_H',
        'int Help() { return 1; }',
        'int Run() { return Help(); }',
        '#endif',
    ].join('\n');

    const evidence = await analyzer.analyze({
        language: 'cpp',
        auxiliaryFiles: [],
        sourceFiles: [{ path: 'include/util.h', source, sourceHash: 'hash-util' }],
    });

    const occurrences = evidence.occurrencesByFile.get('include/util.h') ?? [];
    const resolved = occurrences.find((occurrence) => occurrence.decision === 'resolved');
    assert.ok(resolved, 'guarded header must yield a resolved same-TU call');
    assert.equal(resolved.proof.strategy, 'direct_call');
    assert.equal(resolved.targetProvenance?.file, 'include/util.h');
    assert.equal(resolved.targetProvenance?.name, 'Help');
    assert.equal(evidence.skippedFiles, undefined);
    assert.equal(evidence.coverage?.status, 'complete');
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 1);
});

test('C++ include guard with an #else branch is reported as degraded unmodeled_source', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const source = [
        '#ifndef UTIL_H',
        '#define UTIL_H',
        'int Help() { return 1; }',
        '#else',
        'int Other() { return 2; }',
        '#endif',
    ].join('\n');

    const evidence = await analyzer.analyze({
        language: 'cpp',
        auxiliaryFiles: [],
        sourceFiles: [{ path: 'include/util.h', source, sourceHash: 'hash-util' }],
    });

    assert.equal([...evidence.occurrencesByFile.values()].flat().length, 0);
    assert.deepEqual(evidence.skippedFiles, [
        { path: 'include/util.h', reason: 'unmodeled_source', bytes: Buffer.byteLength(source, 'utf8') },
    ]);
    assert.equal(evidence.coverage?.status, 'degraded');
    assert.equal(evidence.coverage?.sourceFileCount, 1);
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 0);
});
