import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WasmSemanticProjectAnalyzer } from '../semantic/wasm/wasm-analyzer';
import { WasmSemanticEngine } from '../semantic/wasm/wasm-engine';
import {
    buildSymbolRegistry,
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRecord,
} from '../symbols';
import { createLanguageAnalysisService } from '../language-analysis/service';
import { buildSymbolRecordsForFile } from '../symbols';
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
    readonly language: 'java' | 'csharp' | 'cpp' | 'rust' | 'kotlin' | 'php';
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

        // The same qualified name in a sibling project must not make the
        // caller's own definition ambiguous.
        const targetA = crossProjectSources[0]!.path;
        const targetB = targetA.replace('project-a/', 'project-b/');
        const sharedNameEvidence = await analyze(fixture.language, [
            { path: targetA, source: fixture.targetSource },
            { path: targetB, source: fixture.targetSource },
            crossProjectSources[1]!,
        ], crossProjectAuxiliaries);
        const sharedNameCall = [...sharedNameEvidence.occurrencesByFile.values()].flat()[0];
        assert.equal(sharedNameCall?.decision, 'resolved');
        assert.equal(sharedNameCall?.targetProvenance?.file, targetB);
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

test('Rust test-only direct calls remain unadmitted while ordinary direct calls resolve', async () => {
    const cargo = [{
        path: 'Cargo.toml',
        role: 'manifest',
        source: '[package]\nname = "demo"\nversion = "0.1.0"\n',
    }];
    const testOnlySource = [
        'pub fn search_maxn() -> i32 { 1 }',
        '#[cfg(test)] mod tests {',
        '    use super::*;',
        '    #[test] fn calls_maxn() { search_maxn(); }',
        '}',
    ].join('\n');
    const ordinarySource = testOnlySource.replace('#[cfg(test)] mod tests', 'mod tests');
    const testOnly = await analyze('rust', [{ path: 'src/lib.rs', source: testOnlySource }], cargo);
    const ordinary = await analyze('rust', [{ path: 'src/lib.rs', source: ordinarySource }], cargo);

    assert.equal((testOnly.occurrencesByFile.get('src/lib.rs') ?? []).length, 0);
    assert.equal((ordinary.occurrencesByFile.get('src/lib.rs') ?? []).some((occurrence) => (
        occurrence.decision === 'resolved'
        && occurrence.proof.strategy === 'direct_call'
    )), true);
});

function allOccurrences(evidence: { readonly occurrencesByFile: ReadonlyMap<string, readonly { readonly proof: { readonly strategy: string }; readonly decision: string; readonly targetProvenance?: { readonly file?: string; readonly name?: string } }[]> }) {
    return [...evidence.occurrencesByFile.values()].flat();
}

test('Kotlin qualification admits package, import, and companion calls and abstains on receivers and unimported names', async () => {
    const gradle = [{ path: 'build.gradle.kts', role: 'manifest', source: '' }];
    const utilSource = 'package demo\n\nfun help(): Int {\n    return 1\n}\n';
    const mainSource = 'package demo\n\nfun run(): Int {\n    return help()\n}\n';
    const sources = [
        { path: 'src/demo/Util.kt', source: utilSource },
        { path: 'src/demo/Main.kt', source: mainSource },
    ];
    const symbols = [
        symbol({
            file: 'src/demo/Util.kt', source: utilSource, language: 'kotlin', name: 'help',
            marker: 'fun help()', kind: 'function', qualifiedName: 'help',
        }),
        symbol({
            file: 'src/demo/Main.kt', source: mainSource, language: 'kotlin', name: 'run',
            marker: 'fun run()', kind: 'function', qualifiedName: 'run',
        }),
    ];
    const { evidence, records } = await qualify('kotlin', sources, symbols, gradle);
    assert.equal(calls(records).length, 1);
    const [same] = allOccurrences(evidence);
    assert.equal(same?.proof.strategy, 'direct_call');
    assert.equal(same?.decision, 'resolved');
    assert.equal(same?.targetProvenance?.file, 'src/demo/Util.kt');

    const imported = allOccurrences(await analyze('kotlin', [
        { path: 'src/demo/Util.kt', source: utilSource },
        { path: 'src/app/Main.kt', source: 'package app\n\nimport demo.help\n\nfun run(): Int {\n    return help()\n}\n' },
    ], gradle));
    assert.equal(imported.length, 1);
    assert.equal(imported[0]?.proof.strategy, 'direct_call');
    assert.equal(imported[0]?.targetProvenance?.file, 'src/demo/Util.kt');

    // Another package without an import cannot see `help`; CBM's sole-definer
    // fallback would bind it anyway, and Satori removes that fallback.
    const unimported = await analyze('kotlin', [
        { path: 'src/demo/Util.kt', source: utilSource },
        { path: 'src/app/Main.kt', source: 'package app\n\nfun run(): Int {\n    return help()\n}\n' },
    ], gradle);
    assert.equal(allOccurrences(unimported).length, 0);

    const companion = allOccurrences(await analyze('kotlin', [
        { path: 'src/demo/Util.kt', source: 'package demo\n\nclass Util {\n    companion object {\n        fun make(): Int {\n            return 1\n        }\n    }\n}\n' },
        { path: 'src/demo/Main.kt', source: 'package demo\n\nfun run(): Int {\n    return Util.make()\n}\n' },
    ], gradle));
    assert.equal(companion.length, 1);
    assert.equal(companion[0]?.proof.strategy, 'direct_call');
    assert.equal(companion[0]?.targetProvenance?.name, 'make');

    const receiver = allOccurrences(await analyze('kotlin', [{
        path: 'src/demo/S.kt',
        source: 'package demo\n\nclass S {\n    fun help(): Int {\n        return 1\n    }\n\n    fun run(): Int {\n        return help()\n    }\n}\n',
    }], gradle));
    assert.deepEqual(receiver.map((occurrence) => occurrence.proof.strategy), ['type_dispatch']);
});

test('PHP qualification admits namespace, use-imported static, and global calls and abstains on receivers and short-name guesses', async () => {
    const composer = [{ path: 'composer.json', role: 'manifest', source: '{}' }];
    const utilSource = '<?php\nnamespace Demo;\n\nfunction help(): int {\n    return 1;\n}\n';
    const mainSource = '<?php\nnamespace Demo;\n\nfunction run(): int {\n    return help();\n}\n';
    const sources = [
        { path: 'src/Util.php', source: utilSource },
        { path: 'src/Main.php', source: mainSource },
    ];
    const symbols = [
        symbol({
            file: 'src/Util.php', source: utilSource, language: 'php', name: 'help',
            marker: 'function help()', kind: 'function', qualifiedName: 'Demo.help', parentQualifiedNamePath: ['Demo'],
        }),
        symbol({
            file: 'src/Main.php', source: mainSource, language: 'php', name: 'run',
            marker: 'function run()', kind: 'function', qualifiedName: 'Demo.run', parentQualifiedNamePath: ['Demo'],
        }),
    ];
    const { evidence, records } = await qualify('php', sources, symbols, composer);
    assert.equal(calls(records).length, 1);
    const [namespaced] = allOccurrences(evidence);
    assert.equal(namespaced?.proof.strategy, 'direct_call');
    assert.equal(namespaced?.targetProvenance?.file, 'src/Util.php');

    const staticCall = allOccurrences(await analyze('php', [
        { path: 'src/Demo/Util.php', source: '<?php\nnamespace Demo;\n\nclass Util {\n    public static function make(): int {\n        return 1;\n    }\n}\n' },
        { path: 'src/App/Main.php', source: '<?php\nnamespace App;\n\nuse Demo\\Util;\n\nfunction run(): int {\n    return Util::make();\n}\n' },
    ], composer));
    assert.equal(staticCall.length, 1);
    assert.equal(staticCall[0]?.proof.strategy, 'direct_call');
    assert.equal(staticCall[0]?.targetProvenance?.file, 'src/Demo/Util.php');
    assert.equal(staticCall[0]?.targetProvenance?.name, 'make');

    // Without the import, `Util` means App\Util, which does not exist; CBM's
    // short-name class fallback must not turn Demo\Util into direct proof.
    const unimportedClass = allOccurrences(await analyze('php', [
        { path: 'src/Demo/Util.php', source: '<?php\nnamespace Demo;\n\nclass Util {\n    public static function make(): int {\n        return 1;\n    }\n}\n' },
        { path: 'src/App/Main.php', source: '<?php\nnamespace App;\n\nfunction run(): int {\n    return Util::make();\n}\n' },
    ], composer));
    assert.equal(unimportedClass.some((occurrence) => occurrence.proof.strategy === 'direct_call'), false);

    const global = allOccurrences(await analyze('php', [
        { path: 'src/util.php', source: '<?php\nfunction help() {\n    return 1;\n}\n' },
        { path: 'src/main.php', source: '<?php\nfunction run() {\n    return help();\n}\n' },
    ], composer));
    assert.equal(global.length, 1);
    assert.equal(global[0]?.proof.strategy, 'direct_call');
    assert.equal(global[0]?.targetProvenance?.file, 'src/util.php');

    // PHP function names are case-insensitive: inside namespace Demo, help()
    // calls Demo\HELP(), so the global help() must not be claimed.
    const shadowed = allOccurrences(await analyze('php', [
        { path: 'src/util.php', source: '<?php\nfunction help() {\n    return 1;\n}\n' },
        { path: 'src/Demo/Upper.php', source: '<?php\nnamespace Demo;\n\nfunction HELP() {\n    return 2;\n}\n' },
        { path: 'src/Demo/Main.php', source: '<?php\nnamespace Demo;\n\nfunction run() {\n    return help();\n}\n' },
    ], composer));
    assert.equal(shadowed.some((occurrence) => (
        occurrence.proof.strategy === 'direct_call' && occurrence.targetProvenance?.file === 'src/util.php'
    )), false);

    // `help()` in namespace Other is neither Other\help nor a global function;
    // CBM's any-namespace short-name match must never become direct proof.
    const guessed = allOccurrences(await analyze('php', [
        { path: 'src/Util.php', source: utilSource },
        { path: 'src/Main.php', source: '<?php\nnamespace Other;\n\nfunction run(): int {\n    return help();\n}\n' },
    ], composer));
    assert.equal(guessed.some((occurrence) => occurrence.proof.strategy === 'direct_call'), false);

    const receiver = allOccurrences(await analyze('php', [{
        path: 'src/S.php',
        source: '<?php\nnamespace Demo;\n\nclass S {\n    public function help(): int {\n        return 1;\n    }\n\n    public function run(): int {\n        return $this->help() + self::help();\n    }\n}\n',
    }], composer));
    assert.equal(receiver.length, 2);
    assert.equal(receiver.every((occurrence) => occurrence.proof.strategy === 'type_dispatch'), true);
});

async function promotedCalls(
    language: 'kotlin' | 'php',
    sources: readonly SourceInput[],
    auxiliaries: readonly AuxiliaryInput[],
) {
    const service = createLanguageAnalysisService();
    const symbols: SymbolRecord[] = [];
    for (const source of sources) {
        const analysis = await service.analyze({ content: source.source, relativePath: source.path, language });
        assert.equal(analysis.backend, 'cbm_definitions');
        symbols.push(...buildSymbolRecordsForFile({
            relativePath: source.path,
            language,
            content: source.source,
            fileHash: `hash-${source.path}`,
            extractorVersion: 'cbm-language-qualification',
            chunks: [...analysis.chunks],
            extractedSymbols: analysis.symbols,
        }));
    }
    const records = buildRelationshipsForRegistry({
        registry: createRegistry(language, sources, symbols),
        analysisByFile: new Map(sources.map((source) => [
            source.path,
            { moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [] },
        ])),
        semanticEvidenceByLanguage: new Map([[language, await analyze(language, sources, auxiliaries)]]),
    });
    const label = new Map(symbols.map((entry) => [entry.symbolKey, `${entry.file}#${entry.qualifiedName}`]));
    return records
        .filter((record) => record.type === 'CALLS')
        .map((record) => [label.get(record.sourceKey), record.targetKey && label.get(record.targetKey)]);
}

test('promoted Kotlin and PHP calls bind CBM extractor symbols without qualification mode', async () => {
    assert.deepEqual(await promotedCalls('kotlin', [
        { path: 'src/demo/Util.kt', source: 'package demo\n\nobject Tools {\n    fun noop() {}\n}\n\nfun help(): Int {\n    return 1\n}\n' },
        { path: 'src/app/Main.kt', source: 'package app\n\nimport demo.help\n\nclass Main {\n    fun run(): Int {\n        return help()\n    }\n}\n' },
    ], [{ path: 'build.gradle.kts', role: 'manifest', source: '' }]), [['src/app/Main.kt#Main.run', 'src/demo/Util.kt#help']]);

    assert.deepEqual(await promotedCalls('php', [
        { path: 'src/Demo/Util.php', source: '<?php\nnamespace Demo;\n\nclass Util {\n    public static function make(): int {\n        return 1;\n    }\n}\n' },
        { path: 'src/App/Main.php', source: '<?php\nnamespace App;\n\nuse Demo\\Util;\n\nfunction run(): int {\n    return Util::make();\n}\n' },
    ], [{ path: 'composer.json', role: 'manifest', source: '{}' }]), [['src/App/Main.php#run', 'src/Demo/Util.php#Util.make']]);
});
