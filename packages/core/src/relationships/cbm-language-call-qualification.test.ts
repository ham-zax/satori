import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WasmSemanticProjectAnalyzer } from '../semantic/wasm/wasm-analyzer';
import { WasmSemanticEngine } from '../semantic/wasm/wasm-engine';
import {
    buildSymbolRegistry,
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRecord,
} from '../symbols';
import { buildRelationshipsForRegistry } from './builder';

interface SourceInput {
    readonly path: string;
    readonly source: string;
}

interface AuxiliaryInput {
    readonly path: string;
    readonly role: string;
    readonly source: string;
}

interface SymbolInput {
    readonly file: string;
    readonly source: string;
    readonly language: 'java' | 'csharp' | 'cpp' | 'rust';
    readonly name: string;
    readonly marker: string;
    readonly kind: 'function' | 'method';
    readonly qualifiedName: string;
    readonly parentQualifiedNamePath?: readonly string[];
}

const enginePromise = WasmSemanticEngine.create();
const analyzer = new WasmSemanticProjectAnalyzer(() => enginePromise);

function lineForByte(source: string, byte: number): number {
    return 1 + (source.slice(0, byte).match(/\n/g)?.length ?? 0);
}

function columnForByte(source: string, byte: number): number {
    const previousNewline = source.lastIndexOf('\n', Math.max(0, byte - 1));
    return byte - (previousNewline + 1);
}

function bracedSpan(source: string, marker: string) {
    const startByte = source.indexOf(marker);
    assert.notEqual(startByte, -1, `Missing callable marker: ${marker}`);
    const bodyStart = source.indexOf('{', startByte);
    assert.notEqual(bodyStart, -1, `Missing callable body for marker: ${marker}`);

    let depth = 0;
    let endByte = -1;
    for (let i = bodyStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                endByte = i + 1;
                break;
            }
        }
    }
    assert.notEqual(endByte, -1, `Unterminated callable body for marker: ${marker}`);

    return {
        startLine: lineForByte(source, startByte),
        endLine: lineForByte(source, endByte),
        startByte,
        endByte,
        startColumn: columnForByte(source, startByte),
        endColumn: columnForByte(source, endByte),
    };
}

function symbol(input: SymbolInput): SymbolRecord {
    return {
        symbolKey: `${input.file}#${input.qualifiedName}`,
        symbolInstanceId: `inst:${input.file}:${input.qualifiedName}`,
        name: input.name,
        label: input.name,
        qualifiedName: input.qualifiedName,
        kind: input.kind,
        file: input.file,
        language: input.language,
        span: bracedSpan(input.source, input.marker),
        parentQualifiedNamePath: [...(input.parentQualifiedNamePath ?? [])],
        fileHash: `hash-${input.file}`,
        extractorVersion: 'cbm-language-qualification',
    };
}

function createRegistry(
    language: SymbolInput['language'],
    sources: readonly SourceInput[],
    symbols: readonly SymbolRecord[],
) {
    return buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: '/qualification',
            rootFingerprint: `${language}-qualification-root`,
            indexPolicyHash: `${language}-qualification-policy`,
            languageRouterVersion: `${language}-qualification-router`,
            extractorVersion: 'cbm-language-qualification',
            relationshipVersion: 'cbm-language-qualification',
            builtAt: '2026-08-28T00:00:00.000Z',
            files: sources.map((source) => ({
                path: source.path,
                hash: `hash-${source.path}`,
                language,
                symbolCount: symbols.filter((entry) => entry.file === source.path).length,
                definitionStatus: 'definitions_present' as const,
            })),
        },
        symbols: [...symbols],
    });
}

async function analyze(
    language: SymbolInput['language'],
    sources: readonly SourceInput[],
    auxiliaries: readonly AuxiliaryInput[] = [],
) {
    return analyzer.analyze({
        language,
        sourceFiles: sources.map((source) => ({
            ...source,
            sourceHash: `hash-${source.path}`,
        })),
        auxiliaryFiles: auxiliaries.map((auxiliary) => ({
            ...auxiliary,
            sourceHash: `hash-${auxiliary.path}`,
        })),
    });
}

async function qualify(
    language: SymbolInput['language'],
    sources: readonly SourceInput[],
    symbols: readonly SymbolRecord[],
    auxiliaries: readonly AuxiliaryInput[] = [],
) {
    const evidence = await analyze(language, sources, auxiliaries);
    const registry = createRegistry(language, sources, symbols);
    const analysisByFile = new Map(
        sources.map((source) => [
            source.path,
            { moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [] },
        ]),
    );
    const records = buildRelationshipsForRegistry({
        registry,
        analysisByFile,
        mode: {
            kind: 'qualification',
            enabledUnpromotedCallLanguages: new Set([language]),
        },
        semanticEvidenceByLanguage: new Map([[language, evidence]]),
    });
    return { evidence, records };
}

function calls(records: readonly { readonly type: string }[]) {
    return records.filter((record) => record.type === 'CALLS');
}

for (const fixture of [
    {
        language: 'java' as const,
        targetPath: 'src/demo/Util.java',
        targetSource: 'package demo; public class Util { public static int Help() { return 1; } }',
        targetMarker: 'public static int Help()',
        targetQualifiedName: 'Util.Help',
        targetParents: ['Util'],
        callerPath: 'src/demo/Main.java',
        callerSource: 'package demo; public class Main { public static int Run() { return Util.Help(); } }',
        callerMarker: 'public static int Run()',
        callerQualifiedName: 'Main.Run',
        callerParents: ['Main'],
        auxiliaries: [{ path: 'pom.xml', role: 'manifest', source: '<project />' }],
    },
    {
        language: 'csharp' as const,
        targetPath: 'src/Demo/Util.cs',
        targetSource: 'namespace Demo; public static class Util { public static int Help() { return 1; } }',
        targetMarker: 'public static int Help()',
        targetQualifiedName: 'Demo.Util.Help',
        targetParents: ['Demo', 'Util'],
        callerPath: 'src/Demo/Main.cs',
        callerSource: 'namespace Demo; public static class Main { public static int Run() { return Util.Help(); } }',
        callerMarker: 'public static int Run()',
        callerQualifiedName: 'Demo.Main.Run',
        callerParents: ['Demo', 'Main'],
        auxiliaries: [{ path: 'Demo.csproj', role: 'manifest', source: '<Project />' }],
    },
] as const) {
    test(`${fixture.language} qualification admits exact cross-file static calls and abstains on receiver dispatch`, async () => {
        const sources = [
            { path: fixture.targetPath, source: fixture.targetSource },
            { path: fixture.callerPath, source: fixture.callerSource },
        ];
        const symbols = [
            symbol({
                file: fixture.targetPath,
                source: fixture.targetSource,
                language: fixture.language,
                name: 'Help',
                marker: fixture.targetMarker,
                kind: 'method',
                qualifiedName: fixture.targetQualifiedName,
                parentQualifiedNamePath: fixture.targetParents,
            }),
            symbol({
                file: fixture.callerPath,
                source: fixture.callerSource,
                language: fixture.language,
                name: 'Run',
                marker: fixture.callerMarker,
                kind: 'method',
                qualifiedName: fixture.callerQualifiedName,
                parentQualifiedNamePath: fixture.callerParents,
            }),
        ];

        const { evidence, records } = await qualify(fixture.language, sources, symbols, fixture.auxiliaries);
        assert.equal(calls(records).length, 1);
        const occurrence = (evidence.occurrencesByFile.get(fixture.callerPath) ?? [])[0];
        assert.ok(occurrence);
        assert.equal(occurrence.proof.strategy, 'direct_call');
        assert.equal(occurrence.decision, 'resolved');
        assert.equal(occurrence.targetProvenance?.file, fixture.targetPath);
        assert.equal(occurrence.targetProvenance?.name, 'Help');

        const receiverSource = fixture.language === 'java'
            ? 'class S { int Help() { return 1; } int Run() { return Help(); } }'
            : 'class S { int Help() { return 1; } int Run() { return Help(); } }';
        const receiverEvidence = await analyze(
            fixture.language,
            [{ path: fixture.language === 'java' ? 'src/S.java' : 'src/S.cs', source: receiverSource }],
            fixture.auxiliaries,
        );
        const receiverOccurrences = [...receiverEvidence.occurrencesByFile.values()].flat();
        assert.equal(receiverOccurrences.length, 1);
        assert.equal(receiverOccurrences[0]?.proof.strategy, 'type_dispatch');

        const crossProjectSources = fixture.language === 'java'
            ? [
                { path: 'project-a/src/demo/Util.java', source: fixture.targetSource },
                { path: 'project-b/src/demo/Main.java', source: fixture.callerSource },
            ]
            : [
                { path: 'project-a/src/Demo/Util.cs', source: fixture.targetSource },
                { path: 'project-b/src/Demo/Main.cs', source: fixture.callerSource },
            ];
        const crossProjectAuxiliaries = fixture.language === 'java'
            ? [
                { path: 'project-a/pom.xml', role: 'manifest', source: '<project />' },
                { path: 'project-b/pom.xml', role: 'manifest', source: '<project />' },
            ]
            : [
                { path: 'project-a/Demo.csproj', role: 'manifest', source: '<Project />' },
                { path: 'project-b/Demo.csproj', role: 'manifest', source: '<Project />' },
            ];
        const crossProjectEvidence = await analyze(fixture.language, crossProjectSources, crossProjectAuxiliaries);
        const crossProjectCall = [...crossProjectEvidence.occurrencesByFile.values()].flat()[0];
        assert.ok(crossProjectCall);
        assert.equal(crossProjectCall.decision, 'unresolved');
        assert.equal(crossProjectCall.targetProvenance, undefined);
    });
}

test('C++ qualification admits same-TU direct calls and rejects unproved cross-TU visibility and receiver dispatch', async () => {
    const source = 'int Help() { return 1; } int Run() { return Help(); }';
    const sources = [{ path: 'src/main.cpp', source }];
    const symbols = [
        symbol({
            file: 'src/main.cpp', source, language: 'cpp', name: 'Help',
            marker: 'int Help()', kind: 'function', qualifiedName: 'Help',
        }),
        symbol({
            file: 'src/main.cpp', source, language: 'cpp', name: 'Run',
            marker: 'int Run()', kind: 'function', qualifiedName: 'Run',
        }),
    ];
    const { records } = await qualify('cpp', sources, symbols);
    assert.equal(calls(records).length, 1);

    const crossEvidence = await analyze('cpp', [
        { path: 'src/a.cpp', source: 'int Hidden() { return 1; }' },
        { path: 'src/b.cpp', source: 'int Run() { return Hidden(); }' },
    ]);
    const crossCall = (crossEvidence.occurrencesByFile.get('src/b.cpp') ?? [])
        .find((occurrence) => occurrence.callSpan.endByte > occurrence.callSpan.startByte);
    assert.ok(crossCall);
    assert.equal(crossCall.decision, 'unresolved');
    assert.equal(crossCall.targetProvenance, undefined);

    const receiverEvidence = await analyze('cpp', [{
        path: 'src/method.cpp',
        source: 'struct S { int Help() { return 1; } int Run() { return Help(); } };',
    }]);
    assert.equal([...receiverEvidence.occurrencesByFile.values()].flat().length, 0);

    const conditionalEvidence = await analyze('cpp', [{
        path: 'src/config.cpp',
        source: '#if FEATURE\nint Help() { return 1; }\n#endif\nint Run() { return Help(); }',
    }]);
    assert.equal([...conditionalEvidence.occurrencesByFile.values()].flat().length, 0);
});

test('Rust qualification uses Cargo ownership, admits exact direct calls, and fails closed on receiver/cfg contexts', async () => {
    const cargo = [{
        path: 'Cargo.toml',
        role: 'manifest',
        source: '[package]\nname = "demo"\nversion = "0.1.0"\n',
    }];
    const libSource = 'mod util; pub fn Run() -> i32 { crate::util::Help() }';
    const utilSource = 'pub fn Help() -> i32 { 1 }';
    const sources = [
        { path: 'src/lib.rs', source: libSource },
        { path: 'src/util.rs', source: utilSource },
    ];
    const symbols = [
        symbol({
            file: 'src/lib.rs', source: libSource, language: 'rust', name: 'Run',
            marker: 'pub fn Run()', kind: 'function', qualifiedName: 'Run',
        }),
        symbol({
            file: 'src/util.rs', source: utilSource, language: 'rust', name: 'Help',
            marker: 'pub fn Help()', kind: 'function', qualifiedName: 'Help',
        }),
    ];
    const { evidence, records } = await qualify('rust', sources, symbols, cargo);
    assert.equal(calls(records).length, 1);
    const direct = (evidence.occurrencesByFile.get('src/lib.rs') ?? [])
        .find((occurrence) => occurrence.proof.strategy === 'direct_call');
    assert.ok(direct);
    assert.equal(direct.decision, 'resolved');
    assert.equal(direct.targetProvenance?.file, 'src/util.rs');

    const missingCargo = await analyze('rust', [{
        path: 'src/lib.rs',
        source: 'pub fn Help() -> i32 { 1 } pub fn Run() -> i32 { Help() }',
    }]);
    assert.equal([...missingCargo.occurrencesByFile.values()].flat().length, 0);

    const receiverEvidence = await analyze('rust', [{
        path: 'src/lib.rs',
        source: 'pub struct S; impl S { pub fn Help(&self)->i32 {1} pub fn Run(&self)->i32 { self.Help() } }',
    }], cargo);
    const receiver = [...receiverEvidence.occurrencesByFile.values()].flat();
    assert.equal(receiver.length, 1);
    assert.equal(receiver[0]?.proof.strategy, 'type_dispatch');

    const cfgEvidence = await analyze('rust', [{
        path: 'src/lib.rs',
        source: '#[cfg(feature = "x")] pub fn Help() -> i32 { 1 } pub fn Run() -> i32 { Help() }',
    }], cargo);
    assert.equal([...cfgEvidence.occurrencesByFile.values()].flat().length, 0);
});

test('Rust admits bare calls through use imports as exact direct calls', async () => {
    const cargo = [{
        path: 'Cargo.toml',
        role: 'manifest',
        source: '[package]\nname = "demo"\nversion = "0.1.0"\n',
    }];
    const libSource = 'mod eval;\nmod features;\n';
    const evalSource = 'pub fn production_pips() -> f32 { 1.0 }';
    const featuresSource = 'use crate::eval::production_pips;\npub fn f() -> f32 { production_pips() }';
    const sources = [
        { path: 'src/lib.rs', source: libSource },
        { path: 'src/eval.rs', source: evalSource },
        { path: 'src/features.rs', source: featuresSource },
    ];
    const symbols = [
        symbol({
            file: 'src/eval.rs', source: evalSource, language: 'rust', name: 'production_pips',
            marker: 'pub fn production_pips', kind: 'function', qualifiedName: 'production_pips',
        }),
        symbol({
            file: 'src/features.rs', source: featuresSource, language: 'rust', name: 'f',
            marker: 'pub fn f', kind: 'function', qualifiedName: 'f',
        }),
    ];
    const { evidence, records } = await qualify('rust', sources, symbols, cargo);
    const resolved = (evidence.occurrencesByFile.get('src/features.rs') ?? [])
        .find((occurrence) => occurrence.decision === 'resolved');
    assert.ok(resolved, 'use-imported bare call resolves to the defining file');
    assert.equal(resolved?.targetProvenance?.file, 'src/eval.rs');
    assert.equal(resolved?.proof.strategy, 'direct_call');
    assert.equal(calls(records).length, 1);
});
