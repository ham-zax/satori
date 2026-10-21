import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';
import { WasmSemanticEngine } from './wasm-engine';

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

test('Rust configuration-gated code is modeled: calls resolve in and around cfg variants', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    // Code under a non-test cfg is real code in some build configuration, so
    // its calls are callers. Alternate variants share one qualified name, so
    // a call to them is ambiguous rather than bound to one variant.
    const source = [
        '#[cfg(not(target_arch = "wasm32"))]',
        'pub fn Now() -> u64 { 1 }',
        '#[cfg(target_arch = "wasm32")]',
        'pub fn Now() -> u64 { 2 }',
        '#[cfg_attr(not(test), allow(dead_code))]',
        'pub fn Help() -> u64 { Now() }',
        '#[cfg(feature = "x")]',
        'pub fn Gated() -> u64 { Help() }',
        'pub fn Run() -> u64 {',
        '    #[cfg(feature = "x")]',
        '    let _ = Gated();',
        '    Help()',
        '}',
    ].join('\n');

    const evidence = await analyzer.analyze({
        language: 'rust',
        auxiliaryFiles: [CARGO_MANIFEST],
        sourceFiles: [{ path: 'src/lib.rs', source, sourceHash: 'hash-lib' }],
    });

    const occurrences = evidence.occurrencesByFile.get('src/lib.rs') ?? [];
    const resolvedTargets = occurrences
        .filter((occurrence) => occurrence.decision === 'resolved' && occurrence.proof.strategy === 'direct_call')
        .map((occurrence) => `${occurrence.callSpan.startByte}:${occurrence.targetProvenance?.name}`)
        .sort();
    const at = (needle: string, name: string) => `${source.indexOf(needle)}:${name}`;
    assert.deepEqual(resolvedTargets, [
        at('Help() }', 'Help'),
        at('Gated();', 'Gated'),
        at('Help()\n}', 'Help'),
    ].sort());
    const variantCall = occurrences.find((occurrence) => occurrence.callSpan.startByte === source.indexOf('Now() }'));
    assert.equal(variantCall?.decision, 'ambiguous');
    assert.equal(evidence.skippedFiles, undefined);
    assert.equal(evidence.coverage?.status, 'complete');
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 1);
});

test('C++ macro-wrapped definitions resolve under their argument names', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../../language-analysis/__fixtures__/cpp-macro-definitions.cpp'), 'utf8')
        + '\nvoid controls() { ordinary(); pick(1); PAIR(); WRAP(); }\n';
    const evidence = await new WasmSemanticProjectAnalyzer().analyze({
        language: 'cpp', auxiliaryFiles: [],
        sourceFiles: [{ path: 'src/macros.cpp', source, sourceHash: 'hash-macros' }],
    });
    const occurrences = evidence.occurrencesByFile.get('src/macros.cpp') ?? [];
    for (const [call, name, line] of [
        ['first_caller();', 'first_caller', 5],
        ['later_function();', 'later_function', 6],
        ['Cls::Reload(0)', 'Reload', 7],
        ['ordinary();', 'ordinary', 8],
        ['pick(1)', 'pick', 9],
        ['PAIR();', 'PAIR', 10],
        ['WRAP();', 'WRAP', 11],
    ] as const) {
        const occurrence = occurrences.find((entry) => entry.callSpan.startByte === source.indexOf(call));
        assert.equal(occurrence?.decision, 'resolved', call);
        assert.equal(occurrence?.targetProvenance?.name, name, call);
        assert.equal(occurrence?.targetProvenance?.span.startLine, line, call);
    }
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

test('C++ include guard with an #else branch reports excluded regions as partial', async () => {
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
    assert.deepEqual(evidence.skippedFiles ?? [], []);
    assert.deepEqual(evidence.partialFiles, [
        { path: 'include/util.h', reason: 'excluded_regions', bytes: Buffer.byteLength(source, 'utf8') },
    ]);
    assert.equal(evidence.coverage?.status, 'degraded');
    assert.equal(evidence.coverage?.sourceFileCount, 1);
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 1);
});

test('C++ parse-error regions leave clean same-file calls resolved and report partial coverage', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const source = [
        'void* f(size_t n) mi_attr_noexcept { return 0; }',
        'int h(){return 1;}',
        'int r(){return h();}',
    ].join('\n');
    const evidence = await analyzer.analyze({
        language: 'cpp', auxiliaryFiles: [],
        sourceFiles: [{ path: 'src/main.c', source, sourceHash: 'hash-main' }],
    });
    const occurrences = evidence.occurrencesByFile.get('src/main.c') ?? [];
    const call = occurrences.find((occurrence) => occurrence.callSpan.startByte === source.lastIndexOf('h()'));
    assert.equal(call?.decision, 'resolved');
    assert.equal(call?.targetProvenance?.name, 'h');
    assert.deepEqual(evidence.skippedFiles ?? [], []);
    assert.deepEqual(evidence.partialFiles, [
        { path: 'src/main.c', reason: 'excluded_regions', bytes: Buffer.byteLength(source, 'utf8') },
    ]);
    assert.deepEqual(evidence.coverage?.partialFiles, evidence.partialFiles);
    assert.equal(evidence.coverage?.status, 'degraded');
    assert.equal(evidence.coverage?.analyzedSourceFileCount, 1);
});

for (const guarded of [false, true]) {
    test(`C++ excludes #ifdef calls and keeps clean calls${guarded ? ' inside a canonical guard' : ''}`, async () => {
        const analyzer = new WasmSemanticProjectAnalyzer();
        const body = [
            'int h(){return 1;}',
            '#ifdef FEATURE',
            'int conditional(){return h();}',
            '#endif',
            'int r(){return h();}',
        ].join('\n');
        const source = guarded ? `#ifndef UTIL_H\n#define UTIL_H\n${body}\n#endif` : body;
        const evidence = await analyzer.analyze({
            language: 'cpp', auxiliaryFiles: [],
            sourceFiles: [{ path: 'include/util.h', source, sourceHash: 'hash-util' }],
        });
        const occurrences = evidence.occurrencesByFile.get('include/util.h') ?? [];
        assert.equal(occurrences.length, 1);
        assert.equal(occurrences[0]?.callSpan.startByte, source.lastIndexOf('h()'));
        assert.equal(occurrences[0]?.decision, 'resolved');
        assert.equal(occurrences[0]?.targetProvenance?.name, 'h');
        assert.deepEqual(evidence.skippedFiles ?? [], []);
        assert.deepEqual(evidence.partialFiles, [
            { path: 'include/util.h', reason: 'excluded_regions', bytes: Buffer.byteLength(source, 'utf8') },
        ]);
        assert.equal(evidence.coverage?.status, 'degraded');
        assert.equal(evidence.coverage?.analyzedSourceFileCount, 1);
    });
}

test('C++ missing punctuation excludes its parent region and its enclosing definition', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const source = 'int broken();\nint broken(){return 0}\nint h(){return 1;}\nint r(){broken(); return h();}';
    const evidence = await analyzer.analyze({
        language: 'cpp', auxiliaryFiles: [],
        sourceFiles: [
            { path: 'src/main.c', source, sourceHash: 'hash-main' },
            // Keep the callable known to the resolver. The invalid same-file
            // definition must not make this cross-file lookup ambiguous.
            { path: 'src/other.c', source: 'int broken(){return 0;}', sourceHash: 'hash-other' },
        ],
    });
    const occurrences = evidence.occurrencesByFile.get('src/main.c') ?? [];
    assert.equal(occurrences.find((call) => call.callSpan.startByte === source.lastIndexOf('broken()'))?.decision, 'unresolved');
    assert.equal(occurrences.find((call) => call.callSpan.startByte === source.lastIndexOf('h()'))?.decision, 'resolved');
    assert.equal(evidence.partialFiles?.[0]?.reason, 'excluded_regions');
});

for (const [language, label, extension] of [
    ['java', 'Java', 'java'],
    ['csharp', 'C#', 'cs'],
] as const) {
    test(`${label} parse-error regions preserve clean cross-file calls and report partial coverage`, async () => {
        const mainPath = `src/Main.${extension}`;
        const helperPath = `src/Helper.${extension}`;
        const source = [
            'package demo;',
            'class Main {',
            '    public static void Broken() { Helper.Help() }',
            '    public static void Run() { Helper.Help(); }',
            '}',
        ].map((line) => language === 'csharp' && line === 'package demo;' ? 'namespace demo;' : line).join('\n');
        const helper = [
            language === 'java' ? 'package demo;' : 'namespace demo;',
            'class Helper {',
            '    public static void Help() {}',
            '    public static void Probe() { Main.Run(); Main.Broken(); }',
            '}',
        ].join('\n');
        const evidence = await new WasmSemanticProjectAnalyzer().analyze({
            language, auxiliaryFiles: [],
            sourceFiles: [
                { path: mainPath, source, sourceHash: 'hash-main' },
                { path: helperPath, source: helper, sourceHash: 'hash-helper' },
            ],
        });
        const occurrences = evidence.occurrencesByFile.get(mainPath) ?? [];
        assert.equal(occurrences.length, 1, 'only the clean method call is published');
        assert.equal(occurrences[0]?.callSpan.startByte, source.lastIndexOf('Helper.Help()'));
        assert.equal(occurrences[0]?.decision, 'resolved');
        assert.equal(occurrences[0]?.targetProvenance?.file, helperPath);
        assert.equal(occurrences[0]?.targetProvenance?.name, 'Help');
        const probes = evidence.occurrencesByFile.get(helperPath) ?? [];
        assert.equal(probes.find((call) => call.callSpan.startByte === helper.indexOf('Main.Run()'))?.decision, 'resolved');
        assert.ok(!probes.some((call) => call.decision === 'resolved' && call.targetProvenance?.name === 'Broken'),
            'the broken method definition must not enter the registry');
        assert.deepEqual(evidence.skippedFiles ?? [], []);
        assert.deepEqual(evidence.partialFiles, [
            { path: mainPath, reason: 'excluded_regions', bytes: Buffer.byteLength(source, 'utf8') },
        ]);
        assert.deepEqual(evidence.coverage?.partialFiles, evidence.partialFiles);
        assert.equal(evidence.coverage?.status, 'degraded');
        assert.equal(evidence.coverage?.analyzedSourceFileCount, 2);

        const session = await (await WasmSemanticEngine.create()).createSession(language);
        try {
            session.addSource(mainPath, source);
            session.addSource(helperPath, helper);
            const results = await session.resolve();
            assert.ok(!results.some((call) => call.sourceFile === mainPath
                && call.callStartByte < source.indexOf('public static void Run')),
            'the engine must suppress calls inside the excluded region');
            assert.deepEqual(session.diagnostics(), [{
                message: 'excluded parse-error regions',
                file: mainPath,
                spanStartByte: 0,
                spanEndByte: Buffer.byteLength(source, 'utf8'),
                severity: 2,
                code: 2,
            }]);
        } finally {
            session.destroy();
        }
    });
}

test('C++ excluded regions emit one whole-file PARTIAL_SOURCE diagnostic', async () => {
    const engine = await WasmSemanticEngine.create();
    const session = await engine.createSession('cpp');
    const source = '#ifdef FEATURE\nint h(){return 1;}\n#endif';
    try {
        session.addSource('include/util.h', source);
        await session.resolve();
        assert.deepEqual(session.diagnostics(), [{
            message: 'excluded parse-error or conditional preprocessing regions',
            file: 'include/util.h',
            spanStartByte: 0,
            spanEndByte: Buffer.byteLength(source, 'utf8'),
            severity: 2,
            code: 2,
        }]);
    } finally {
        session.destroy();
    }
});
