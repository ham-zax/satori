import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    buildSymbolRecordsForFile,
    createSymbolInstanceId,
    createSymbolKey,
    createSynthesizedFileSymbol,
} from '../symbols';
import {
    buildCallRelationshipsForRegistry,
    buildRelationshipDelta,
    buildRelationshipsForRegistry,
    type RelationshipAnalysisEvidence,
} from './builder';
import type { ResolutionClaim } from './resolution';
import type { SymbolKind, SymbolRecord, SymbolRegistryManifest } from '../symbols';
import { createLanguageAnalysisService } from '../language-analysis';
import { getLanguageIdFromFilename } from '../language';

async function analyzeFiles(
    sources: Map<string, string> | Record<string, string>,
) {
    const analyzer = createLanguageAnalysisService();
    const entries = sources instanceof Map ? [...sources.entries()] : Object.entries(sources);
    return new Map(await Promise.all(entries.map(async ([relativePath, content]) => [
        relativePath,
        await analyzer.analyze({
            content,
            language: getLanguageIdFromFilename(relativePath, 'text'),
            relativePath,
        }),
    ] as const)));
}

async function buildAnalyzedPythonRegistry(
    sources: Map<string, string> | Record<string, string>,
) {
    const entries = (sources instanceof Map ? [...sources.entries()] : Object.entries(sources))
        .sort(([left], [right]) => left.localeCompare(right));
    const analysisByFile = await analyzeFiles(new Map(entries));
    const symbols: SymbolRecord[] = [];
    const files: SymbolRegistryManifest['files'] = [];

    for (const [relativePath, content] of entries) {
        const analysis = analysisByFile.get(relativePath);
        assert.ok(analysis);
        const fileHash = `hash-${relativePath}`;
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath,
            language: 'python',
            content,
            fileHash,
            extractorVersion: 'test-extractor-v1',
            chunks: [],
            extractedSymbols: analysis.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path: relativePath,
            hash: fileHash,
            language: 'python',
            symbolCount: fileSymbols.length,
            definitionStatus: analysis.structuralStatus === 'complete'
                ? 'definitions_present'
                : 'structural_unavailable',
        });
    }

    return {
        analysisByFile: analysisByFile as Map<string, RelationshipAnalysisEvidence>,
        registry: buildSymbolRegistry({
            manifest: {
                ...manifest(),
                files,
            },
            symbols,
        }),
    };
}

function createSymbol(input: {
    file: string;
    kind: SymbolKind;
    name: string;
    qualifiedName: string;
    label: string;
    startLine: number;
    endLine: number;
    fileHash: string;
    language?: string;
    parentQualifiedNamePath?: string[];
    startByte?: number;
    endByte?: number;
}): SymbolRecord {
    const parentQualifiedNamePath = input.parentQualifiedNamePath || [];
    const language = input.language || 'typescript';
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language,
        kind: input.kind,
        qualifiedName: input.qualifiedName,
        parentQualifiedNamePath,
    });
    const span = {
        startLine: input.startLine,
        endLine: input.endLine,
        ...(input.startByte === undefined ? {} : { startByte: input.startByte }),
        ...(input.endByte === undefined ? {} : { endByte: input.endByte }),
    };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: 'test-extractor-v1',
        }),
        language,
        kind: input.kind,
        name: input.name,
        qualifiedName: input.qualifiedName,
        label: input.label,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: 'test-extractor-v1',
    };
}

function manifest(): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root-fingerprint',
        indexPolicyHash: 'policy-hash',
        languageRouterVersion: 'router-v1',
        extractorVersion: 'test-extractor-v1',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files: [
            {
                path: 'src/auth.ts',
                hash: 'hash-auth',
                language: 'typescript',
                symbolCount: 3,
                definitionStatus: 'definitions_present',
            },
            {
                path: 'src/routes.ts',
                hash: 'hash-routes',
                language: 'typescript',
                symbolCount: 2,
                definitionStatus: 'definitions_present',
            },
        ],
    };
}

test('buildCallRelationshipsForRegistry creates deterministic CALLS records from owned symbols', async () => {
    const authFile = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: 'export function validateToken(token: string) { return true; }\nexport function login(token: string) {\n  return validateToken(token);\n}\n',
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const routesFile = createSynthesizedFileSymbol({
        relativePath: 'src/routes.ts',
        language: 'typescript',
        content: 'import { login } from "./auth";\nexport function route(token: string) {\n  return login(token);\n}\n',
        fileHash: 'hash-routes',
        extractorVersion: 'test-extractor-v1',
    });
    const validateToken = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'validateToken',
        qualifiedName: 'validateToken',
        label: 'function validateToken(token: string)',
        startLine: 1,
        endLine: 1,
        fileHash: 'hash-auth',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'login',
        qualifiedName: 'login',
        label: 'function login(token: string)',
        startLine: 2,
        endLine: 4,
        fileHash: 'hash-auth',
    });
    const route = createSymbol({
        file: 'src/routes.ts',
        kind: 'function',
        name: 'route',
        qualifiedName: 'route',
        label: 'function route(token: string)',
        startLine: 2,
        endLine: 4,
        fileHash: 'hash-routes',
    });
    const registry = buildSymbolRegistry({
        manifest: manifest(),
        symbols: [routesFile, route, authFile, validateToken, login],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles(new Map([
            ['src/auth.ts', 'export function validateToken(token: string) { return true; }\nexport function login(token: string) {\n  return validateToken(token);\n}\n'],
            ['src/routes.ts', 'import { login } from "./auth";\nexport function route(token: string) {\n  return login(token);\n}\n'],
        ])),
    });

    assert.deepEqual(records.map((record) => ({
        source: record.sourceInstanceId,
        target: record.targetInstanceId,
        file: record.file,
        line: record.span?.startLine,
        confidence: record.confidence,
    })), [
        {
            source: login.symbolInstanceId,
            target: validateToken.symbolInstanceId,
            file: 'src/auth.ts',
            line: 3,
            confidence: 'high',
        },
        {
            source: route.symbolInstanceId,
            target: login.symbolInstanceId,
            file: 'src/routes.ts',
            line: 3,
            confidence: 'low',
        },
    ]);
});

test('buildCallRelationshipsForRegistry adds TESTS only for resolved test-to-production calls', () => {
    const runtimeFile = createSynthesizedFileSymbol({
        relativePath: 'src/runtime.ts',
        language: 'typescript',
        content: 'function target() {}\nfunction productionCaller() { target(); }\n',
        fileHash: 'hash-runtime',
        extractorVersion: 'test-extractor-v1',
    });
    const testFile = createSynthesizedFileSymbol({
        relativePath: 'tests/runtime.test.ts',
        language: 'typescript',
        content: 'function testCaller() { target(); }\n',
        fileHash: 'hash-test',
        extractorVersion: 'test-extractor-v1',
    });
    const unresolvedFile = createSynthesizedFileSymbol({
        relativePath: 'tests/unresolved.test.ts',
        language: 'typescript',
        content: 'function unresolvedCaller() { missing(); }\n',
        fileHash: 'hash-unresolved',
        extractorVersion: 'test-extractor-v1',
    });
    const target = createSymbol({
        file: 'src/runtime.ts',
        kind: 'function',
        name: 'target',
        qualifiedName: 'target',
        label: 'function target',
        startLine: 1,
        endLine: 1,
        fileHash: 'hash-runtime',
    });
    const productionCaller = createSymbol({
        file: 'src/runtime.ts',
        kind: 'function',
        name: 'productionCaller',
        qualifiedName: 'productionCaller',
        label: 'function productionCaller',
        startLine: 2,
        endLine: 2,
        fileHash: 'hash-runtime',
    });
    const testCaller = createSymbol({
        file: 'tests/runtime.test.ts',
        kind: 'function',
        name: 'testCaller',
        qualifiedName: 'testCaller',
        label: 'function testCaller',
        startLine: 1,
        endLine: 1,
        fileHash: 'hash-test',
    });
    const unresolvedCaller = createSymbol({
        file: 'tests/unresolved.test.ts',
        kind: 'function',
        name: 'unresolvedCaller',
        qualifiedName: 'unresolvedCaller',
        label: 'function unresolvedCaller',
        startLine: 1,
        endLine: 1,
        fileHash: 'hash-unresolved',
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [
                { path: 'src/runtime.ts', hash: 'hash-runtime', language: 'typescript', symbolCount: 3, definitionStatus: 'definitions_present' },
                { path: 'tests/runtime.test.ts', hash: 'hash-test', language: 'typescript', symbolCount: 2, definitionStatus: 'definitions_present' },
                { path: 'tests/unresolved.test.ts', hash: 'hash-unresolved', language: 'typescript', symbolCount: 2, definitionStatus: 'definitions_present' },
            ],
        },
        symbols: [
            runtimeFile,
            target,
            productionCaller,
            testFile,
            testCaller,
            unresolvedFile,
            unresolvedCaller,
        ],
    });
    const call = (calleeName: string, line: number, startByte: number) => ({
        calleeName,
        kind: 'direct' as const,
        span: {
            startLine: line,
            endLine: line,
            startByte,
            endByte: startByte + calleeName.length,
            startColumn: startByte,
            endColumn: startByte + calleeName.length,
        },
    });
    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: new Map([
            ['src/runtime.ts', {
                moduleBindings: [],
                callSites: [call('target', 2, 50)],
            }],
            ['tests/runtime.test.ts', {
                moduleBindings: [],
                callSites: [call('target', 1, 24)],
            }],
            ['tests/unresolved.test.ts', {
                moduleBindings: [],
                callSites: [call('missing', 1, 30)],
            }],
        ]),
    });

    assert.deepEqual(
        records.map((record) => [
            record.file,
            record.type,
            record.sourceInstanceId,
            record.targetInstanceId,
        ]),
        [
            ['src/runtime.ts', 'CALLS', productionCaller.symbolInstanceId, target.symbolInstanceId],
            ['tests/runtime.test.ts', 'CALLS', testCaller.symbolInstanceId, target.symbolInstanceId],
            ['tests/runtime.test.ts', 'TESTS', testCaller.symbolInstanceId, target.symbolInstanceId],
        ],
    );
});

test('buildCallRelationshipsForRegistry preserves the six direct Python run_validation calls', async () => {
    const content = [
        'def phase_one(): pass',
        'def phase_two(): pass',
        'def phase_three(): pass',
        'def phase_four(): pass',
        'def phase_five(): pass',
        'def phase_six(): pass',
        '',
        'def run_validation():',
        '    phase_one()',
        '    phase_two()',
        '    phase_three()',
        '    phase_four()',
        '    phase_five()',
        '    phase_six()',
    ].join('\n');
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/validation.py': content,
    });

    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;
    const runValidation = registry.symbols.find((symbol) => symbol.qualifiedName === 'run_validation');

    assert.ok(runValidation);
    assert.deepEqual(
        records
            .filter((record) => record.sourceInstanceId === runValidation.symbolInstanceId)
            .map((record) => symbolsById.get(record.targetInstanceId || '')?.qualifiedName),
        ['phase_one', 'phase_two', 'phase_three', 'phase_four', 'phase_five', 'phase_six'],
    );
});

test('buildCallRelationshipsForRegistry resolves exact same-class Python self and cls calls', async () => {
    const content = [
        'class CircuitBreaker:',
        '    def check_drawdown(self):',
        '        self._determine_new_state()',
        '        self._handle_state_transition()',
        '        self._build_state_snapshot()',
        '',
        '    def _handle_state_transition(self):',
        '        return self._get_threshold_for_state()',
        '',
        '    def _determine_new_state(self): pass',
        '    def _build_state_snapshot(self): pass',
        '    def _get_threshold_for_state(self): pass',
        '',
        '    @classmethod',
        '    def restore(cls):',
        '        return cls._build_state_snapshot()',
    ].join('\n');
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/circuit_breaker.py': content,
    });

    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    assert.deepEqual(
        records.map((record) => [
            symbolsById.get(record.sourceInstanceId || '')?.qualifiedName,
            symbolsById.get(record.targetInstanceId || '')?.qualifiedName,
        ]),
        [
            ['CircuitBreaker.check_drawdown', 'CircuitBreaker._determine_new_state'],
            ['CircuitBreaker.check_drawdown', 'CircuitBreaker._handle_state_transition'],
            ['CircuitBreaker.check_drawdown', 'CircuitBreaker._build_state_snapshot'],
            ['CircuitBreaker._handle_state_transition', 'CircuitBreaker._get_threshold_for_state'],
            ['CircuitBreaker.restore', 'CircuitBreaker._build_state_snapshot'],
        ],
    );
});

test('buildCallRelationshipsForRegistry resolves exact Python aliases and parameter types without leaking receiver authority', async () => {
    const sources: Record<string, string> = {
        'src/factory.py': [
            'class SpreadModelFactory:',
            '    @classmethod',
            '    def create_model(cls):',
            '        return None',
        ].join('\n'),
        'src/consumer.py': [
            'from .factory import SpreadModelFactory',
            'import pandas as pd',
            '',
            'def build(model):',
            '    SpreadModelFactory.create_model()',
            '    model.calculate_metrics()',
            '    pd.merge()',
        ].join('\n'),
        'src/not_authorized.py': [
            'from .factory import another_name',
            '',
            'def invalid_build():',
            '    SpreadModelFactory.create_model()',
        ].join('\n'),
        'src/aliased.py': [
            'from .factory import SpreadModelFactory as Factory',
            '',
            'def aliased_build():',
            '    Factory.create_model()',
        ].join('\n'),
        'src/ambiguous.py': [
            'class Alpha:',
            '    def calculate_metrics(self): pass',
            '',
            'class Beta:',
            '    def calculate_metrics(self): pass',
        ].join('\n'),
        'src/typed_receiver.py': [
            'class MetricsModel:',
            '    def calculate_metrics(self): pass',
            '',
            'class OtherModel:',
            '    def calculate_metrics(self): pass',
            '',
            'def inspect(model: MetricsModel):',
            '    model.calculate_metrics()',
            '',
            'def inspect_other(model: OtherModel):',
            '    model.calculate_metrics()',
            '',
            'def string_annotation(model: "MetricsModel"):',
            '    model.calculate_metrics()',
            '',
            'def optional_annotation(model: Optional[MetricsModel]):',
            '    model.calculate_metrics()',
            '',
            'def union_annotation(model: MetricsModel | None):',
            '    model.calculate_metrics()',
            '',
            'def chained_receiver(model: MetricsModel):',
            '    model.client.calculate_metrics()',
            '',
            'def unknown_receiver(object):',
            '    object.calculate_metrics()',
        ].join('\n'),
        'src/ambiguous_typed.py': [
            'class MetricsModel:',
            '    def calculate_metrics(self): pass',
            '',
            'class MetricsModel:',
            '    def calculate_metrics(self): pass',
            '',
            'def inspect(model: MetricsModel):',
            '    model.calculate_metrics()',
        ].join('\n'),
    };
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry(sources);

    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    assert.deepEqual(
        records.map((record) => [
            symbolsById.get(record.sourceInstanceId || '')?.qualifiedName,
            symbolsById.get(record.targetInstanceId || '')?.qualifiedName,
        ]),
        [
            ['aliased_build', 'SpreadModelFactory.create_model'],
            ['build', 'SpreadModelFactory.create_model'],
            ['inspect', 'MetricsModel.calculate_metrics'],
            ['inspect_other', 'OtherModel.calculate_metrics'],
        ],
    );
});

test('buildCallRelationshipsForRegistry records exact Python parameter proof and abstains without it', async () => {
    const sources: Record<string, string> = {
        'src/ledger.py': [
            'class SignalLedger:',
            '    def record(self): pass',
            '',
            'class OtherLedger:',
            '    def record(self): pass',
        ].join('\n'),
        'src/caller.py': [
            'from .ledger import SignalLedger',
            '',
            'def typed(ledger: SignalLedger):',
            '    ledger.record()',
            '',
            'def untyped(ledger):',
            '    ledger.record()',
        ].join('\n'),
    };
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry(sources);
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;
    const signalLedgerRecord = registry.symbols.find((symbol) => symbol.qualifiedName === 'SignalLedger.record');

    assert.ok(signalLedgerRecord);
    assert.deepEqual(
        records
            .filter((record) => record.targetInstanceId === signalLedgerRecord.symbolInstanceId)
            .map((record) => symbolsById.get(record.sourceInstanceId ?? '')?.qualifiedName),
        ['typed'],
    );

    const claims = (analysisByFile.get('src/caller.py') as {
        resolutionClaims?: readonly ResolutionClaim[];
    } | undefined)?.resolutionClaims ?? [];
    const typedClaim = claims.find((claim) => claim.callSpan.startLine === 4);
    const untypedClaim = claims.find((claim) => claim.callSpan.startLine === 7);
    assert.equal(typedClaim?.decision, 'resolved');
    assert.equal(typedClaim?.resolutionAuthority, 'direct_binding');
    assert.deepEqual(typedClaim?.proofSteps.map((step) => step.kind), [
        'call_site',
        'containing_caller',
        'parameter_annotation',
    ]);
    assert.equal(untypedClaim?.decision, 'ambiguous');
    assert.equal(untypedClaim?.relationshipType, 'REFERENCES');
    assert.equal(untypedClaim?.resolutionAuthority, 'ambiguous');
});

test('buildCallRelationshipsForRegistry assigns same-line calls by byte containment', async () => {
    const content = [
        'function targetA() {}',
        'function targetB() {}',
        'function first() { targetA(); } function second() { targetB(); }',
    ].join('\n');
    const file = 'src/same-line.ts';
    const fileHash = 'hash-same-line';
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: file,
        language: 'typescript',
        content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
    });
    const symbol = (name: string, startLine: number, startByte: number, endByte: number) => createSymbol({
        file,
        kind: 'function',
        name,
        qualifiedName: name,
        label: `function ${name}`,
        startLine,
        endLine: startLine,
        startByte,
        endByte,
        fileHash,
    });
    const firstStart = content.indexOf('function first');
    const secondStart = content.indexOf('function second');
    const symbols = [
        symbol('targetA', 1, content.indexOf('function targetA'), content.indexOf('function targetA') + 21),
        symbol('targetB', 2, content.indexOf('function targetB'), content.indexOf('function targetB') + 21),
        symbol('first', 3, firstStart, secondStart - 1),
        symbol('second', 3, secondStart, content.length),
    ];
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: file, hash: fileHash, language: 'typescript', symbolCount: symbols.length + 1, definitionStatus: 'definitions_present' }],
        },
        symbols: [fileOwner, ...symbols],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({ [file]: content }),
    });
    const nameById = new Map(symbols.map((entry) => [entry.symbolInstanceId, entry.name]));

    assert.deepEqual(records.map((record) => [
        nameById.get(record.sourceInstanceId ?? '') ?? '',
        nameById.get(record.targetInstanceId ?? '') ?? '',
    ]).sort((left, right) => left[0].localeCompare(right[0])), [
        ['first', 'targetA'],
        ['second', 'targetB'],
    ]);
});

test('buildCallRelationshipsForRegistry preserves distinct same-line call spans', () => {
    const file = 'src/two-calls.ts';
    const fileHash = 'hash-two-calls';
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: file,
        language: 'typescript',
        content: 'function target() {}\nfunction run() { target(); target(); }\n',
        fileHash,
        extractorVersion: 'test-extractor-v1',
    });
    const target = createSymbol({ file, kind: 'function', name: 'target', qualifiedName: 'target', label: 'function target', startLine: 1, endLine: 1, startByte: 0, endByte: 20, fileHash });
    const run = createSymbol({ file, kind: 'function', name: 'run', qualifiedName: 'run', label: 'function run', startLine: 2, endLine: 2, startByte: 21, endByte: 58, fileHash });
    const registry = buildSymbolRegistry({
        manifest: { ...manifest(), files: [{ path: file, hash: fileHash, language: 'typescript', symbolCount: 3, definitionStatus: 'definitions_present' }] },
        symbols: [fileOwner, target, run],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: new Map([[file, {
            moduleBindings: [],
            callSites: [
                { calleeName: 'target', kind: 'direct', span: { startLine: 2, endLine: 2, startByte: 38, endByte: 46, startColumn: 17, endColumn: 25 } },
                { calleeName: 'target', kind: 'direct', span: { startLine: 2, endLine: 2, startByte: 48, endByte: 56, startColumn: 27, endColumn: 35 } },
            ],
        }]]),
    });

    assert.deepEqual(records.map((record) => record.span), [
        { startLine: 2, endLine: 2, startByte: 38, endByte: 46, startColumn: 17, endColumn: 25 },
        { startLine: 2, endLine: 2, startByte: 48, endByte: 56, startColumn: 27, endColumn: 35 },
    ]);
});

test('buildCallRelationshipsForRegistry skips definitions, unresolved calls, and non-source owners', async () => {
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: 'export function login() {\n  missingCall();\n}\n',
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'login',
        qualifiedName: 'login',
        label: 'function login()',
        startLine: 1,
        endLine: 3,
        fileHash: 'hash-auth',
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 2, definitionStatus: 'definitions_present' }],
        },
        symbols: [fileOwner, login],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({
            'src/auth.ts': 'export function login() {\n  missingCall();\n}\n',
        }),
    });

    assert.deepEqual(records, []);
});

test('buildCallRelationshipsForRegistry does not emit duplicate container-owned class calls', async () => {
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: [
            'export function normalize(input: string) {',
            '  return input.trim();',
            '}',
            '',
            'export class AuthService {',
            '  async login(input: string) {',
            '    return normalize(input);',
            '  }',
            '}',
        ].join('\n'),
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const normalize = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'normalize',
        qualifiedName: 'normalize',
        label: 'function normalize(input: string)',
        startLine: 1,
        endLine: 3,
        fileHash: 'hash-auth',
    });
    const authService = createSymbol({
        file: 'src/auth.ts',
        kind: 'class',
        name: 'AuthService',
        qualifiedName: 'AuthService',
        label: 'class AuthService',
        startLine: 5,
        endLine: 9,
        fileHash: 'hash-auth',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'login',
        qualifiedName: 'AuthService.login',
        label: 'async login(input: string)',
        startLine: 6,
        endLine: 8,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class AuthService'],
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 4, definitionStatus: 'definitions_present' }],
        },
        symbols: [fileOwner, normalize, authService, login],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({
            'src/auth.ts': [
                'export function normalize(input: string) {',
                '  return input.trim();',
                '}',
                '',
                'export class AuthService {',
                '  async login(input: string) {',
                '    return normalize(input);',
                '  }',
                '}',
            ].join('\n'),
        }),
    });

    assert.deepEqual(records.map((record) => record.sourceInstanceId), [login.symbolInstanceId]);
    assert.deepEqual(records.map((record) => record.targetInstanceId), [normalize.symbolInstanceId]);
});

test('buildCallRelationshipsForRegistry skips ambiguous same-name targets until receiver resolution exists', async () => {
    const content = [
        'export class AuthService {',
        '  login(input: string) {',
        '    return audit(input);',
        '  }',
        '  audit(input: string) {',
        '    return input;',
        '  }',
        '}',
        '',
        'export class UserService {',
        '  audit(input: string) {',
        '    return input;',
        '  }',
        '}',
    ].join('\n');
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content,
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const authService = createSymbol({
        file: 'src/auth.ts',
        kind: 'class',
        name: 'AuthService',
        qualifiedName: 'AuthService',
        label: 'class AuthService',
        startLine: 1,
        endLine: 8,
        fileHash: 'hash-auth',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'login',
        qualifiedName: 'AuthService.login',
        label: 'login(input: string)',
        startLine: 2,
        endLine: 4,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class AuthService'],
    });
    const authAudit = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'audit',
        qualifiedName: 'AuthService.audit',
        label: 'audit(input: string)',
        startLine: 5,
        endLine: 7,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class AuthService'],
    });
    const userService = createSymbol({
        file: 'src/auth.ts',
        kind: 'class',
        name: 'UserService',
        qualifiedName: 'UserService',
        label: 'class UserService',
        startLine: 10,
        endLine: 14,
        fileHash: 'hash-auth',
    });
    const userAudit = createSymbol({
        file: 'src/auth.ts',
        kind: 'method',
        name: 'audit',
        qualifiedName: 'UserService.audit',
        label: 'audit(input: string)',
        startLine: 11,
        endLine: 13,
        fileHash: 'hash-auth',
        parentQualifiedNamePath: ['class UserService'],
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/auth.ts', hash: 'hash-auth', language: 'typescript', symbolCount: 6, definitionStatus: 'definitions_present' }],
        },
        symbols: [fileOwner, authService, login, authAudit, userService, userAudit],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({ 'src/auth.ts': content }),
    });

    assert.deepEqual(records, []);
});

test('buildCallRelationshipsForRegistry is case-sensitive and refuses receiver-unproven member calls', async () => {
    const content = [
        'function Process() {}',
        'class Cache { save() {} }',
        'function run(database: { save(): void }) {',
        '  process();',
        '  database.save();',
        '}',
    ].join('\n');
    const file = 'src/case.ts';
    const fileHash = 'hash-case';
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: file,
        language: 'typescript',
        content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
    });
    const symbols = [
        createSymbol({ file, kind: 'function', name: 'Process', qualifiedName: 'Process', label: 'function Process', startLine: 1, endLine: 1, fileHash }),
        createSymbol({ file, kind: 'method', name: 'save', qualifiedName: 'Cache.save', label: 'method save', startLine: 2, endLine: 2, fileHash, parentQualifiedNamePath: ['Cache'] }),
        createSymbol({ file, kind: 'function', name: 'run', qualifiedName: 'run', label: 'function run', startLine: 3, endLine: 6, fileHash }),
    ];
    const registry = buildSymbolRegistry({
        manifest: { ...manifest(), files: [{ path: file, hash: fileHash, language: 'typescript', symbolCount: symbols.length + 1, definitionStatus: 'definitions_present' }] },
        symbols: [fileOwner, ...symbols],
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({ [file]: content }),
    });

    assert.deepEqual(records, []);
});

test('buildCallRelationshipsForRegistry constrains targets by call kind', () => {
    const file = 'src/targets.ts';
    const fileHash = 'hash-target-kinds';
    const content = 'function run() {}\n';
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: file,
        language: 'typescript',
        content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
    });
    const symbol = (kind: SymbolKind, name: string, line: number) => createSymbol({
        file,
        kind,
        name,
        qualifiedName: name,
        label: `${kind} ${name}`,
        startLine: line,
        endLine: line,
        fileHash,
    });
    const run = symbol('function', 'run', 1);
    const helper = symbol('function', 'helper', 2);
    const service = symbol('class', 'Service', 3);
    const classCalledDirectly = symbol('class', 'DirectClass', 4);
    const propertyCalledDirectly = symbol('property', 'directProperty', 5);
    const functionConstructed = symbol('function', 'factory', 6);
    const symbols = [fileOwner, run, helper, service, classCalledDirectly, propertyCalledDirectly, functionConstructed];
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: file, hash: fileHash, language: 'typescript', symbolCount: symbols.length, definitionStatus: 'definitions_present' }],
        },
        symbols,
    });

    const records = buildCallRelationshipsForRegistry({
        registry,
        analysisByFile: new Map<string, RelationshipAnalysisEvidence>([
            [
                file,
                {
                moduleBindings: [],
                callSites: [
                    { calleeName: 'helper', kind: 'direct', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'Service', kind: 'constructor', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'DirectClass', kind: 'direct', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'directProperty', kind: 'direct', span: { startLine: 1, endLine: 1 } },
                    { calleeName: 'factory', kind: 'constructor', span: { startLine: 1, endLine: 1 } },
                ],
            } as unknown as RelationshipAnalysisEvidence,
        ]]),
    });
    const targetNameById = new Map(symbols.map((entry) => [entry.symbolInstanceId, entry.name]));

    assert.deepEqual(
        records.map((record) => targetNameById.get(record.targetInstanceId ?? '')).sort(),
        ['Service', 'helper'],
    );
});

test('buildCallRelationshipsForRegistry treats components and hooks as callable owners', async () => {
    const file = 'src/widget.tsx';
    const fileHash = 'hash-widget';
    const content = 'function target() {}\nfunction Widget() { target(); }\nfunction useThing() { target(); }\n';
    const fileOwner = createSynthesizedFileSymbol({ relativePath: file, language: 'tsx', content, fileHash, extractorVersion: 'test-extractor-v1' });
    const target = createSymbol({ file, kind: 'function', name: 'target', qualifiedName: 'target', label: 'function target', startLine: 1, endLine: 1, fileHash, language: 'tsx' });
    const widget = createSymbol({ file, kind: 'component', name: 'Widget', qualifiedName: 'Widget', label: 'component Widget', startLine: 2, endLine: 2, fileHash, language: 'tsx' });
    const hook = createSymbol({ file, kind: 'hook', name: 'useThing', qualifiedName: 'useThing', label: 'hook useThing', startLine: 3, endLine: 3, fileHash, language: 'tsx' });
    const registry = buildSymbolRegistry({
        manifest: { ...manifest(), files: [{ path: file, hash: fileHash, language: 'tsx', symbolCount: 4, definitionStatus: 'definitions_present' }] },
        symbols: [fileOwner, target, widget, hook],
    });

    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile: await analyzeFiles({ [file]: content }) });

    assert.deepEqual(new Set(records.map((record) => record.sourceInstanceId)), new Set([
        widget.symbolInstanceId,
        hook.symbolInstanceId,
    ]));
});

test('buildCallRelationshipsForRegistry resolves bounded Python constructor receivers', async () => {
    const source = [
        'class SignalGenerator:',
        '    def check_entry(self):',
        '        return True',
        '',
        'class Runner:',
        '    def __init__(self):',
        '        self.signal_gen = SignalGenerator()',
        '',
        '    def run(self):',
        '        before.check_entry()',
        '        local = SignalGenerator()',
        '        local.check_entry()',
        '        self.signal_gen.check_entry()',
        '',
        '        if enabled:',
        '            nested = SignalGenerator()',
        '            nested.check_entry()',
        '',
        '        conflict = SignalGenerator()',
        '        conflict = OtherGenerator()',
        '        conflict.check_entry()',
        '',
        '        factory = make_generator()',
        '        factory.check_entry()',
    ].join('\n');
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({ 'src/runner.py': source });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const checkEntryCalls = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.qualifiedName
            === 'SignalGenerator.check_entry'
    ));

    assert.deepEqual(checkEntryCalls.map((record) => record.span?.startLine), [12, 13, 17]);
    assert.deepEqual(checkEntryCalls.map((record) => (
        registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName
    )), ['Runner.run', 'Runner.run', 'Runner.run']);
});

test('buildCallRelationshipsForRegistry resolves one exact same-module constructor', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/runner.py': [
            'class TradingEntryVetoes:',
            '    pass',
            '',
            'def run():',
            '    TradingEntryVetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edges = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.kind === 'class'
    ));
    assert.equal(edges.length, 1, `expected one constructor edge, got ${JSON.stringify(edges)}`);
    assert.equal(registry.symbolsByInstanceId.get(edges[0].sourceInstanceId ?? '')?.qualifiedName, 'run');
    assert.equal(registry.symbolsByInstanceId.get(edges[0].targetInstanceId ?? '')?.name, 'TradingEntryVetoes');
    assert.equal(edges[0].confidence, 'low');
    assert.equal(edges[0].resolutionAuthority, 'direct_binding');
});

test('buildCallRelationshipsForRegistry fails closed when two same-module classes are ambiguous', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/runner.py': [
            'class A:',
            '    pass',
            '',
            'class Outer:',
            '    class A:',
            '        pass',
            '',
            'def run():',
            '    A()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edges = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
    ));
    assert.deepEqual(edges, []);
});

test('buildCallRelationshipsForRegistry does not treat a shadowing local variable as the class constructor', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/runner.py': [
            'class TradingEntryVetoes:',
            '    pass',
            '',
            'def run():',
            '    TradingEntryVetoes = make_vetoes()',
            '    TradingEntryVetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edges = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
    ));
    assert.deepEqual(edges, []);
});

test('buildCallRelationshipsForRegistry mixed same-module and cross-module callers both appear', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/rules.py': [
            'class TradingEntryVetoes:',
            '    pass',
            '',
            'def local_run():',
            '    TradingEntryVetoes()',
        ].join('\n'),
        'src/runner.py': [
            'from rules import TradingEntryVetoes',
            '',
            'def run():',
            '    TradingEntryVetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edges = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.name === 'TradingEntryVetoes'
    ));
    assert.equal(edges.length, 2, `expected same-module and cross-module edges, got ${JSON.stringify(edges)}`);
    assert.deepEqual(
        edges.map((record) => (
            registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName
        )).sort(),
        ['local_run', 'run'],
    );
});

test('buildCallRelationshipsForRegistry resolves cross-module constructor callers via direct imports', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/rules.py': [
            'class TradingEntryVetoes:',
            '    pass',
        ].join('\n'),
        'src/runner.py': [
            'from rules import TradingEntryVetoes',
            '',
            'def run():',
            '    TradingEntryVetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edge = records.find((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.name === 'TradingEntryVetoes'
    ));
    assert.ok(edge, 'expected an inbound constructor CALLS edge from the direct import');
    assert.equal(edge?.confidence, 'low');
    assert.equal(edge?.resolutionAuthority, 'direct_binding');
});

test('buildCallRelationshipsForRegistry emits the TradingCore.__init__ constructor caller edge', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/rules.py': [
            'class TradingEntryVetoes:',
            '    pass',
        ].join('\n'),
        'src/core.py': [
            'from rules import TradingEntryVetoes',
            '',
            'class TradingCore:',
            '    def __init__(self):',
            '        self.vetoes = TradingEntryVetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edge = records.find((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'TradingCore.__init__'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.name === 'TradingEntryVetoes'
    ));
    assert.ok(edge, 'expected a TradingCore.__init__ constructor CALLS edge for the imported TradingEntryVetoes');
});

test('buildCallRelationshipsForRegistry resolves cross-module constructor callers via import aliases', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/rules.py': [
            'class TradingEntryVetoes:',
            '    pass',
        ].join('\n'),
        'src/runner.py': [
            'from rules import TradingEntryVetoes as Vetoes',
            '',
            'def run():',
            '    Vetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edge = records.find((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.name === 'TradingEntryVetoes'
    ));
    assert.ok(edge, 'expected an inbound constructor CALLS edge from the aliased import');
    assert.equal(edge?.confidence, 'low');
    assert.equal(edge?.resolutionAuthority, 'direct_binding');
});

test('buildCallRelationshipsForRegistry resolves qualified module alias constructor callers', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/rules.py': [
            'class TradingEntryVetoes:',
            '    pass',
        ].join('\n'),
        'src/runner.py': [
            'import rules as r',
            '',
            'def run():',
            '    r.TradingEntryVetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edge = records.find((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.name === 'TradingEntryVetoes'
    ));
    assert.ok(edge, 'expected an inbound constructor CALLS edge from the qualified module alias');
    assert.equal(edge?.confidence, 'low');
});

test('buildCallRelationshipsForRegistry resolves plain qualified module constructor callers', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/rules.py': [
            'class TradingEntryVetoes:',
            '    pass',
        ].join('\n'),
        'src/runner.py': [
            'import rules',
            '',
            'def run():',
            '    rules.TradingEntryVetoes()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edge = records.find((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.name === 'TradingEntryVetoes'
    ));
    assert.ok(edge, 'expected an inbound constructor CALLS edge from the plain qualified module');
    assert.equal(edge?.confidence, 'low');
});

test('buildCallRelationshipsForRegistry fails closed on ambiguous constructor imports', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/a_rules.py': [
            'class A:',
            '    pass',
        ].join('\n'),
        'src/b_rules.py': [
            'class A:',
            '    pass',
        ].join('\n'),
        'src/runner.py': [
            'from a_rules import A',
            'from b_rules import A',
            '',
            'def run():',
            '    A()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edges = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
        && registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.kind === 'class'
    ));
    assert.deepEqual(edges, []);
});

test('buildCallRelationshipsForRegistry does not fabricate edges for unresolved constructor imports', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/runner.py': [
            'from missing_module import A',
            'import missing_module as m',
            '',
            'def run():',
            '    A()',
            '    m.B()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const edges = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
    ));
    assert.deepEqual(edges, []);
});

test('buildCallRelationshipsForRegistry reports method and cross-module constructor callers together', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/rules.py': [
            'class Handler:',
            '    def handle(self):',
            '        pass',
        ].join('\n'),
        'src/runner.py': [
            'from rules import Handler',
            '',
            'def run():',
            '    Handler()',
            '    handler = Handler()',
            '    handler.handle()',
        ].join('\n'),
    });
    const records = buildCallRelationshipsForRegistry({ registry, analysisByFile });
    const targets = records.filter((record) => (
        record.type === 'CALLS'
        && registry.symbolsByInstanceId.get(record.sourceInstanceId ?? '')?.qualifiedName === 'run'
    )).map((record) => registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.qualifiedName);
    assert.ok(targets.includes('Handler'), `expected constructor edge, got ${JSON.stringify(targets)}`);
    assert.ok(targets.includes('Handler.handle'), `expected method edge, got ${JSON.stringify(targets)}`);
});

test('buildRelationshipsForRegistry creates conservative IMPORTS and EXPORTS file-owner records', async () => {
    const authContent = [
        'export function login(token: string) {',
        '  return token;',
        '}',
    ].join('\n');
    const routesContent = [
        'import { login } from "./auth";',
        'export { login } from "./auth";',
        'export function route(token: string) {',
        '  return login(token);',
        '}',
    ].join('\n');
    const authFile = createSynthesizedFileSymbol({
        relativePath: 'src/auth.ts',
        language: 'typescript',
        content: authContent,
        fileHash: 'hash-auth',
        extractorVersion: 'test-extractor-v1',
    });
    const routesFile = createSynthesizedFileSymbol({
        relativePath: 'src/routes.ts',
        language: 'typescript',
        content: routesContent,
        fileHash: 'hash-routes',
        extractorVersion: 'test-extractor-v1',
    });
    const login = createSymbol({
        file: 'src/auth.ts',
        kind: 'function',
        name: 'login',
        qualifiedName: 'login',
        label: 'function login(token: string)',
        startLine: 1,
        endLine: 3,
        fileHash: 'hash-auth',
    });
    const route = createSymbol({
        file: 'src/routes.ts',
        kind: 'function',
        name: 'route',
        qualifiedName: 'route',
        label: 'function route(token: string)',
        startLine: 3,
        endLine: 5,
        fileHash: 'hash-routes',
    });
    const registry = buildSymbolRegistry({
        manifest: manifest(),
        symbols: [authFile, login, routesFile, route],
    });

    const records = buildRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles(new Map([
            ['src/auth.ts', authContent],
            ['src/routes.ts', routesContent],
        ])),
    });

    assert.deepEqual(records.map((record) => ({
        type: record.type,
        source: record.sourceInstanceId,
        target: record.targetInstanceId,
        targetPath: record.targetPath,
        file: record.file,
        line: record.span?.startLine,
        confidence: record.confidence,
    })), [
        {
            type: 'EXPORTS',
            source: authFile.symbolInstanceId,
            target: login.symbolInstanceId,
            targetPath: undefined,
            file: 'src/auth.ts',
            line: 1,
            confidence: 'high',
        },
        {
            type: 'IMPORTS',
            source: routesFile.symbolInstanceId,
            target: authFile.symbolInstanceId,
            targetPath: 'src/auth.ts',
            file: 'src/routes.ts',
            line: 1,
            confidence: 'high',
        },
        {
            type: 'EXPORTS',
            source: routesFile.symbolInstanceId,
            target: authFile.symbolInstanceId,
            targetPath: 'src/auth.ts',
            file: 'src/routes.ts',
            line: 2,
            confidence: 'high',
        },
        {
            type: 'EXPORTS',
            source: routesFile.symbolInstanceId,
            target: route.symbolInstanceId,
            targetPath: undefined,
            file: 'src/routes.ts',
            line: 3,
            confidence: 'high',
        },
        {
            type: 'CALLS',
            source: route.symbolInstanceId,
            target: login.symbolInstanceId,
            targetPath: undefined,
            file: 'src/routes.ts',
            line: 4,
            confidence: 'low',
        },
    ]);
});

test('buildRelationshipsForRegistry creates Python IMPORTS and top-level EXPORTS for relative module calls', async () => {
    const telemetryContent = [
        'def build_entry_telemetry():',
        '    return None',
    ].join('\n');
    const phasesContent = [
        'from .telemetry import build_entry_telemetry',
        '',
        'def _attach_entry_telemetry():',
        '    return build_entry_telemetry()',
    ].join('\n');
    const telemetryFile = createSynthesizedFileSymbol({
        relativePath: 'src/telemetry.py',
        language: 'python',
        content: telemetryContent,
        fileHash: 'hash-telemetry',
        extractorVersion: 'test-extractor-v1',
    });
    const phasesFile = createSynthesizedFileSymbol({
        relativePath: 'src/phases.py',
        language: 'python',
        content: phasesContent,
        fileHash: 'hash-phases',
        extractorVersion: 'test-extractor-v1',
    });
    const buildEntryTelemetry = createSymbol({
        file: 'src/telemetry.py',
        kind: 'function',
        name: 'build_entry_telemetry',
        qualifiedName: 'build_entry_telemetry',
        label: 'function build_entry_telemetry()',
        startLine: 1,
        endLine: 2,
        fileHash: 'hash-telemetry',
        language: 'python',
    });
    const attachEntryTelemetry = createSymbol({
        file: 'src/phases.py',
        kind: 'function',
        name: '_attach_entry_telemetry',
        qualifiedName: '_attach_entry_telemetry',
        label: 'function _attach_entry_telemetry()',
        startLine: 3,
        endLine: 4,
        fileHash: 'hash-phases',
        language: 'python',
    });
    const registry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: '/repo',
            rootFingerprint: 'root-fingerprint',
            indexPolicyHash: 'policy-hash',
            languageRouterVersion: 'router-v1',
            extractorVersion: 'test-extractor-v1',
            relationshipVersion: 'relationship-v1',
            builtAt: '2026-06-17T00:00:00.000Z',
            files: [
                { path: 'src/phases.py', hash: 'hash-phases', language: 'python', symbolCount: 2, definitionStatus: 'definitions_present' },
                { path: 'src/telemetry.py', hash: 'hash-telemetry', language: 'python', symbolCount: 2, definitionStatus: 'definitions_present' },
            ],
        },
        symbols: [phasesFile, attachEntryTelemetry, telemetryFile, buildEntryTelemetry],
    });

    const records = buildRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles(new Map([
            ['src/phases.py', phasesContent],
            ['src/telemetry.py', telemetryContent],
        ])),
    });

    assert.deepEqual(records.map((record) => ({
        type: record.type,
        source: record.sourceInstanceId,
        target: record.targetInstanceId,
        targetPath: record.targetPath,
        file: record.file,
        line: record.span?.startLine,
        confidence: record.confidence,
    })), [
        {
            type: 'IMPORTS',
            source: phasesFile.symbolInstanceId,
            target: telemetryFile.symbolInstanceId,
            targetPath: 'src/telemetry.py',
            file: 'src/phases.py',
            line: 1,
            confidence: 'high',
        },
        {
            type: 'EXPORTS',
            source: phasesFile.symbolInstanceId,
            target: attachEntryTelemetry.symbolInstanceId,
            targetPath: undefined,
            file: 'src/phases.py',
            line: 3,
            confidence: 'high',
        },
        {
            type: 'CALLS',
            source: attachEntryTelemetry.symbolInstanceId,
            target: buildEntryTelemetry.symbolInstanceId,
            targetPath: undefined,
            file: 'src/phases.py',
            line: 4,
            confidence: 'low',
        },
        {
            type: 'EXPORTS',
            source: telemetryFile.symbolInstanceId,
            target: buildEntryTelemetry.symbolInstanceId,
            targetPath: undefined,
            file: 'src/telemetry.py',
            line: 1,
            confidence: 'high',
        },
    ]);
});

test('buildRelationshipsForRegistry skips unresolved package imports and ambiguous local exports', async () => {
    const content = [
        'import express from "express";',
        'export { missing } from "./missing";',
        'export const known = true;',
    ].join('\n');
    const fileOwner = createSynthesizedFileSymbol({
        relativePath: 'src/routes.ts',
        language: 'typescript',
        content,
        fileHash: 'hash-routes',
        extractorVersion: 'test-extractor-v1',
    });
    const knownOne = createSymbol({
        file: 'src/routes.ts',
        kind: 'property',
        name: 'known',
        qualifiedName: 'known',
        label: 'const known',
        startLine: 3,
        endLine: 3,
        fileHash: 'hash-routes',
    });
    const knownTwo = createSymbol({
        file: 'src/routes.ts',
        kind: 'function',
        name: 'known',
        qualifiedName: 'known',
        label: 'function known()',
        startLine: 3,
        endLine: 3,
        fileHash: 'hash-routes',
    });
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{ path: 'src/routes.ts', hash: 'hash-routes', language: 'typescript', symbolCount: 3, definitionStatus: 'definitions_present' }],
        },
        symbols: [fileOwner, knownOne, knownTwo],
    });

    const records = buildRelationshipsForRegistry({
        registry,
        analysisByFile: await analyzeFiles({ 'src/routes.ts': content }),
    });

    assert.deepEqual(records, []);
});

test('buildRelationshipsForRegistry resolves NodeNext source extensions and rejects root traversal', async () => {
    const files = [
        { path: 'src/a.ts', hash: 'hash-a', language: 'typescript', content: 'import "./b.js"; import "../../outside";' },
        { path: 'src/b.ts', hash: 'hash-b', language: 'typescript', content: 'export const value = 1;' },
        { path: 'outside.ts', hash: 'hash-outside', language: 'typescript', content: 'export const value = 2;' },
        { path: 'src/pkg/a.py', hash: 'hash-py', language: 'python', content: 'from ...outside import value' },
        { path: 'outside.py', hash: 'hash-outside-py', language: 'python', content: 'value = 1' },
    ];
    const owners = files.map((file) => createSynthesizedFileSymbol({
        relativePath: file.path,
        language: file.language,
        content: file.content,
        fileHash: file.hash,
        extractorVersion: 'test-extractor-v1',
    }));
    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: files.map((file) => ({
                path: file.path,
                hash: file.hash,
                language: file.language,
                symbolCount: 1,
                definitionStatus: 'definitions_present',
            })),
        },
        symbols: owners,
    });
    const analyzed = await analyzeFiles(Object.fromEntries(files.map((file) => [file.path, file.content])));

    const records = buildRelationshipsForRegistry({ registry, analysisByFile: analyzed });

    assert.deepEqual(records.filter((record) => record.type === 'IMPORTS').map((record) => record.targetPath), [
        'src/b.ts',
    ]);
});

test('buildRelationshipsForRegistry retains complete semantic context when publication is source-scoped', async () => {
    const analyzed = await buildAnalyzedPythonRegistry({
        'src/model.py': [
            'class CopulaNetwork:',
            '    def calculate_metrics(self): pass',
        ].join('\n'),
        'src/caller.py': [
            'from .model import CopulaNetwork',
            '',
            'def run(model: CopulaNetwork):',
            '    model.calculate_metrics()',
        ].join('\n'),
    });
    const fullRecords = buildRelationshipsForRegistry(analyzed);
    const callerRecords = buildRelationshipsForRegistry({
        ...analyzed,
        sourceFiles: new Set(['src/caller.py']),
    });

    assert.deepEqual(
        callerRecords,
        fullRecords.filter((record) => record.file === 'src/caller.py'),
    );
    assert.equal(
        callerRecords.some((record) => (
            record.type === 'CALLS'
            && analyzed.registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.qualifiedName
                === 'CopulaNetwork.calculate_metrics'
        )),
        true,
    );
});

test('buildRelationshipDelta matches a full rebuild when a call target becomes ambiguous and resolves again', async () => {
    const callerPath = 'src/caller.ts';
    const targetAPath = 'src/target-a.ts';
    const targetBPath = 'src/target-b.ts';
    const sources: Record<string, string> = {
        [callerPath]: 'export function run() { return target(); }\n',
        [targetAPath]: 'export function target() { return 1; }\n',
        [targetBPath]: 'export function target() { return 2; }\n',
    };
    const registry = (includeSecondTarget: boolean) => {
        const files = includeSecondTarget
            ? [callerPath, targetAPath, targetBPath]
            : [callerPath, targetAPath];
        const symbols = files.map((file) => createSynthesizedFileSymbol({
            relativePath: file,
            language: 'typescript',
            content: sources[file]!,
            fileHash: `hash-${file}`,
            extractorVersion: 'test-extractor-v1',
        }));
        symbols.push(createSymbol({
            file: callerPath,
            kind: 'function',
            name: 'run',
            qualifiedName: 'run',
            label: 'function run',
            startLine: 1,
            endLine: 1,
            fileHash: `hash-${callerPath}`,
        }));
        for (const file of files.filter((candidate) => candidate !== callerPath)) {
            symbols.push(createSymbol({
                file,
                kind: 'function',
                name: 'target',
                qualifiedName: 'target',
                label: 'function target',
                startLine: 1,
                endLine: 1,
                fileHash: `hash-${file}`,
            }));
        }
        return buildSymbolRegistry({
            manifest: {
                ...manifest(),
                files: files.map((file) => ({
                    path: file,
                    hash: `hash-${file}`,
                    language: 'typescript',
                    symbolCount: 2,
                    definitionStatus: 'definitions_present',
                })),
            },
            symbols,
        });
    };
    const analysis = await analyzeFiles(sources);
    const uniqueRegistry = registry(false);
    const ambiguousRegistry = registry(true);
    const uniqueRecords = buildRelationshipsForRegistry({ registry: uniqueRegistry, analysisByFile: analysis });

    const ambiguousDelta = buildRelationshipDelta({
        previousRegistry: uniqueRegistry,
        registry: ambiguousRegistry,
        existingRecords: uniqueRecords,
        analysisByFile: analysis,
        changedFiles: new Set([targetBPath]),
    });
    assert.deepEqual(
        ambiguousDelta.records,
        buildRelationshipsForRegistry({ registry: ambiguousRegistry, analysisByFile: analysis }),
    );
    assert.deepEqual(ambiguousDelta.affectedFiles, [callerPath, targetBPath]);

    const resolvedDelta = buildRelationshipDelta({
        previousRegistry: ambiguousRegistry,
        registry: uniqueRegistry,
        existingRecords: ambiguousDelta.records,
        analysisByFile: analysis,
        changedFiles: new Set([targetBPath]),
    });
    assert.deepEqual(resolvedDelta.records, uniqueRecords);
    assert.deepEqual(resolvedDelta.affectedFiles, [callerPath, targetBPath]);
});

test('buildRelationshipDelta matches a full rebuild for constructor-derived receiver evidence', async () => {
    const path = 'src/runner.py';
    const before = await buildAnalyzedPythonRegistry({
        [path]: [
            'class SignalGenerator:',
            '    def check_entry(self): pass',
            '',
            'def run():',
            '    signal_gen = SignalGenerator()',
            '    signal_gen.check_entry()',
        ].join('\n'),
    });
    const after = await buildAnalyzedPythonRegistry({
        [path]: [
            'class SignalGenerator:',
            '    def check_entry(self): pass',
            '',
            'def run():',
            '    signal_gen = SignalGenerator()',
            '    signal_gen.check_entry()',
            '    signal_gen.check_entry()',
        ].join('\n'),
    });
    const previousRecords = buildRelationshipsForRegistry(before);
    const delta = buildRelationshipDelta({
        previousRegistry: before.registry,
        registry: after.registry,
        existingRecords: previousRecords,
        analysisByFile: after.analysisByFile,
        changedFiles: new Set([path]),
    });

    assert.deepEqual(delta.records, buildRelationshipsForRegistry(after));
    assert.deepEqual(delta.affectedFiles, [path]);
});

test('buildRelationshipDelta matches a full rebuild when a Python class receiver becomes ambiguous and resolves again', async () => {
    const callerPath = 'src/caller.py';
    const targetAPath = 'src/factory_a.py';
    const targetBPath = 'src/factory_b.py';
    const sources: Record<string, string> = {
        [callerPath]: [
            'from .factory_a import SpreadModelFactory',
            'from .factory_b import SpreadModelFactory',
            '',
            'def build():',
            '    return SpreadModelFactory.create_model()',
        ].join('\n'),
        [targetAPath]: [
            'class SpreadModelFactory:',
            '    @classmethod',
            '    def create_model(cls): pass',
        ].join('\n'),
        [targetBPath]: [
            'class SpreadModelFactory:',
            '    @classmethod',
            '    def create_model(cls): pass',
        ].join('\n'),
    };
    const beforeSources = {
        [callerPath]: sources[callerPath],
        [targetAPath]: sources[targetAPath],
    };
    const before = await buildAnalyzedPythonRegistry(beforeSources);
    const after = await buildAnalyzedPythonRegistry(sources);
    const beforeRecords = buildRelationshipsForRegistry(before);

    const ambiguousDelta = buildRelationshipDelta({
        previousRegistry: before.registry,
        registry: after.registry,
        existingRecords: beforeRecords,
        analysisByFile: after.analysisByFile,
        changedFiles: new Set([targetBPath]),
    });
    assert.deepEqual(
        ambiguousDelta.records,
        buildRelationshipsForRegistry(after),
    );
    assert.deepEqual(ambiguousDelta.affectedFiles, [callerPath, targetBPath]);

    const resolvedDelta = buildRelationshipDelta({
        previousRegistry: after.registry,
        registry: before.registry,
        existingRecords: ambiguousDelta.records,
        analysisByFile: before.analysisByFile,
        changedFiles: new Set([targetBPath]),
    });
    assert.deepEqual(resolvedDelta.records, beforeRecords);
    assert.deepEqual(resolvedDelta.affectedFiles, [callerPath, targetBPath]);
});

test('buildRelationshipDelta invalidates absolute Python import dependents when a target file changes', async () => {
    const callerPath = 'src/caller.py';
    const targetPath = 'src/target.py';
    const callerSource = 'from src.target import Target\n';
    const before = await buildAnalyzedPythonRegistry({
        [callerPath]: callerSource,
        [targetPath]: 'class Target:\n    pass\n',
    });
    const after = await buildAnalyzedPythonRegistry({
        [callerPath]: callerSource,
        [targetPath]: 'class Target:\n    """Changed target snapshot."""\n    pass\n',
    });
    const previousRecords = buildRelationshipsForRegistry(before);
    const delta = buildRelationshipDelta({
        previousRegistry: before.registry,
        registry: after.registry,
        existingRecords: previousRecords,
        analysisByFile: after.analysisByFile,
        changedFiles: new Set([targetPath]),
    });

    assert.deepEqual(delta.records, buildRelationshipsForRegistry(after));
    assert.deepEqual(delta.affectedFiles, [callerPath, targetPath]);
    assert.equal(delta.records.filter((record) => record.type === 'IMPORTS').length, 1);
});

test('buildRelationshipDelta revisits an unresolved relative import when its target file appears', async () => {
    const callerPath = 'src/caller.ts';
    const targetPath = 'src/target.ts';
    const sources: Record<string, string> = {
        [callerPath]: 'import { target } from "./target";\nexport function run() { return target(); }\n',
        [targetPath]: 'export function target() { return 1; }\n',
    };
    const buildRegistry = (includeTarget: boolean) => {
        const files = includeTarget ? [callerPath, targetPath] : [callerPath];
        const symbols: SymbolRecord[] = files.map((file) => createSynthesizedFileSymbol({
            relativePath: file,
            language: 'typescript',
            content: sources[file]!,
            fileHash: `hash-${file}`,
            extractorVersion: 'test-extractor-v1',
        }));
        symbols.push(createSymbol({
            file: callerPath,
            kind: 'function',
            name: 'run',
            qualifiedName: 'run',
            label: 'function run',
            startLine: 2,
            endLine: 2,
            fileHash: `hash-${callerPath}`,
        }));
        if (includeTarget) {
            symbols.push(createSymbol({
                file: targetPath,
                kind: 'function',
                name: 'target',
                qualifiedName: 'target',
                label: 'function target',
                startLine: 1,
                endLine: 1,
                fileHash: `hash-${targetPath}`,
            }));
        }
        return buildSymbolRegistry({
            manifest: {
                ...manifest(),
                files: files.map((file) => ({
                    path: file,
                    hash: `hash-${file}`,
                    language: 'typescript',
                    symbolCount: 2,
                    definitionStatus: 'definitions_present',
                })),
            },
            symbols,
        });
    };
    const analysis = await analyzeFiles(sources);
    const before = buildRegistry(false);
    const after = buildRegistry(true);
    const delta = buildRelationshipDelta({
        previousRegistry: before,
        registry: after,
        existingRecords: buildRelationshipsForRegistry({ registry: before, analysisByFile: analysis }),
        analysisByFile: analysis,
        changedFiles: new Set([targetPath]),
    });

    assert.deepEqual(
        delta.records,
        buildRelationshipsForRegistry({ registry: after, analysisByFile: analysis }),
    );
    assert.deepEqual(delta.affectedFiles, [callerPath, targetPath]);
    assert.ok(delta.records.some((record) => record.type === 'IMPORTS' && record.targetPath === targetPath));
});

test('buildRelationshipDelta keeps TESTS records equivalent across add, delete, rename, and retarget', async () => {
    const productionSource = [
        'def target(): pass',
        'def replacement(): pass',
    ].join('\n');
    const testSource = [
        'from src.runtime import target',
        'def test_runtime():',
        '    target()',
    ].join('\n');
    const retargetedTestSource = [
        'from src.runtime import replacement',
        'def test_runtime():',
        '    replacement()',
    ].join('\n');
    const scenarios = [
        {
            name: 'add',
            previous: { 'src/runtime.py': productionSource },
            next: {
                'src/runtime.py': productionSource,
                'tests/test_runtime.py': testSource,
            },
            changedFiles: new Set(['tests/test_runtime.py']),
            expectedTests: 1,
        },
        {
            name: 'delete',
            previous: {
                'src/runtime.py': productionSource,
                'tests/test_runtime.py': testSource,
            },
            next: { 'src/runtime.py': productionSource },
            changedFiles: new Set(['tests/test_runtime.py']),
            expectedTests: 0,
        },
        {
            name: 'rename',
            previous: {
                'src/runtime.py': productionSource,
                'tests/test_runtime.py': testSource,
            },
            next: {
                'src/runtime.py': productionSource,
                'tests/test_runtime_renamed.py': testSource,
            },
            changedFiles: new Set(['tests/test_runtime.py', 'tests/test_runtime_renamed.py']),
            expectedTests: 1,
        },
        {
            name: 'retarget',
            previous: {
                'src/runtime.py': productionSource,
                'tests/test_runtime.py': testSource,
            },
            next: {
                'src/runtime.py': productionSource,
                'tests/test_runtime.py': retargetedTestSource,
            },
            changedFiles: new Set(['tests/test_runtime.py']),
            expectedTests: 1,
        },
    ] as const;

    for (const scenario of scenarios) {
        const previous = await buildAnalyzedPythonRegistry(scenario.previous);
        const next = await buildAnalyzedPythonRegistry(scenario.next);
        const existingRecords = buildRelationshipsForRegistry(previous);
        const fullRecords = buildRelationshipsForRegistry(next);
        const delta = buildRelationshipDelta({
            previousRegistry: previous.registry,
            registry: next.registry,
            existingRecords,
            analysisByFile: next.analysisByFile,
            changedFiles: scenario.changedFiles,
        });

        assert.deepEqual(delta.records, fullRecords, scenario.name);
        assert.equal(
            delta.records.filter((record) => record.type === 'TESTS').length,
            scenario.expectedTests,
            scenario.name,
        );
    }
});

test('buildRelationshipDelta keeps typed receiver evidence equivalent across annotation and imported-class changes', async () => {
    const localClasses = [
        'class MetricsModel:',
        '    def calculate_metrics(self): pass',
        '',
        'class OtherModel:',
        '    def calculate_metrics(self): pass',
    ].join('\n');
    const untyped = `${localClasses}\n\ndef inspect(model):\n    model.calculate_metrics()\n`;
    const typedMetrics = `${localClasses}\n\ndef inspect(model: MetricsModel):\n    model.calculate_metrics()\n`;
    const typedOther = `${localClasses}\n\ndef inspect(model: OtherModel):\n    model.calculate_metrics()\n`;
    const annotationScenarios = [
        { name: 'add annotation', previous: untyped, next: typedMetrics, expectedTarget: 'MetricsModel.calculate_metrics' },
        { name: 'remove annotation', previous: typedMetrics, next: untyped, expectedTarget: undefined },
        { name: 'change annotation', previous: typedMetrics, next: typedOther, expectedTarget: 'OtherModel.calculate_metrics' },
    ] as const;

    for (const scenario of annotationScenarios) {
        const previous = await buildAnalyzedPythonRegistry({ 'src/runtime.py': scenario.previous });
        const next = await buildAnalyzedPythonRegistry({ 'src/runtime.py': scenario.next });
        const delta = buildRelationshipDelta({
            previousRegistry: previous.registry,
            registry: next.registry,
            existingRecords: buildRelationshipsForRegistry(previous),
            analysisByFile: next.analysisByFile,
            changedFiles: new Set(['src/runtime.py']),
        });
        const fullRecords = buildRelationshipsForRegistry(next);

        assert.deepEqual(delta.records, fullRecords, scenario.name);
        const callTarget = delta.records.find((record) => record.type === 'CALLS')?.targetInstanceId;
        assert.equal(
            callTarget ? next.registry.symbolsByInstanceId.get(callTarget)?.qualifiedName : undefined,
            scenario.expectedTarget,
            scenario.name,
        );
    }

    const callerSource = [
        'from .factory import Factory as Model',
        '',
        'def inspect(model: Model):',
        '    model.calculate_metrics()',
    ].join('\n');
    const previous = await buildAnalyzedPythonRegistry({
        'src/factory.py': [
            'class Factory:',
            '    def calculate_metrics(self): pass',
        ].join('\n'),
        'src/caller.py': callerSource,
    });
    const next = await buildAnalyzedPythonRegistry({
        'src/factory.py': [
            'class RenamedFactory:',
            '    def calculate_metrics(self): pass',
        ].join('\n'),
        'src/caller.py': callerSource,
    });
    const delta = buildRelationshipDelta({
        previousRegistry: previous.registry,
        registry: next.registry,
        existingRecords: buildRelationshipsForRegistry(previous),
        analysisByFile: next.analysisByFile,
        changedFiles: new Set(['src/factory.py']),
    });

    assert.deepEqual(delta.records, buildRelationshipsForRegistry(next));
    assert.ok(delta.affectedFiles.includes('src/caller.py'));
    assert.equal(delta.records.some((record) => record.type === 'CALLS'), false);
});

test('buildRelationshipDelta invalidates callers through persisted Python flow dependencies', async () => {
    const ledgerSource = [
        'class SignalLedger:',
        '    def record(self): pass',
        '',
        'class OtherLedger:',
        '    def record(self): pass',
    ].join('\n');
    const servicesSource = [
        'class Services:',
        '    pass',
        '',
        'def consume(services: Services):',
        '    services.signal_ledger.record()',
    ].join('\n');
    const engineSource = (ledgerType: 'SignalLedger' | 'OtherLedger') => [
        'from .ledger import OtherLedger, SignalLedger',
        'from .services import Services',
        '',
        'class Engine:',
        '    def __init__(self):',
        `        self.signal_ledger = ${ledgerType}()`,
        '',
        'def build_services(engine: Engine):',
        '    return Services(signal_ledger=engine.signal_ledger)',
        '',
        'def run():',
        '    engine = Engine()',
        '    build_services(engine=engine)',
    ].join('\n');
    const previous = await buildAnalyzedPythonRegistry({
        'src/ledger.py': ledgerSource,
        'src/services.py': servicesSource,
        'src/engine.py': engineSource('SignalLedger'),
    });
    const next = await buildAnalyzedPythonRegistry({
        'src/ledger.py': ledgerSource,
        'src/services.py': servicesSource,
        'src/engine.py': engineSource('OtherLedger'),
    });
    const previousRecords = buildRelationshipsForRegistry(previous);
    const fullRecords = buildRelationshipsForRegistry(next);
    const delta = buildRelationshipDelta({
        previousRegistry: previous.registry,
        registry: next.registry,
        existingRecords: previousRecords,
        analysisByFile: next.analysisByFile,
        previousAnalysisByFile: previous.analysisByFile,
        changedFiles: new Set(['src/engine.py']),
    });

    assert.deepEqual(delta.records, fullRecords);
    assert.ok(delta.affectedFiles.includes('src/services.py'));
    assert.equal(
        fullRecords.some((record) => (
            record.file === 'src/services.py'
            && record.type === 'CALLS'
            && next.registry.symbolsByInstanceId.get(record.targetInstanceId ?? '')?.qualifiedName === 'OtherLedger.record'
        )),
        true,
    );
});

test('buildRelationshipDelta full-rebuild oracle keeps records, claims, proof steps, and deterministic order identical', async () => {
    const ledgerSource = [
        'class SignalLedger:',
        '    def record(self): pass',
        '',
        'class OtherLedger:',
        '    def record(self): pass',
    ].join('\n');
    const servicesSource = [
        'class Services:',
        '    pass',
        '',
        'def consume(services: Services):',
        '    services.signal_ledger.record()',
    ].join('\n');
    const engineSource = (ledgerType: 'SignalLedger' | 'OtherLedger') => [
        'from .ledger import OtherLedger, SignalLedger',
        'from .services import Services',
        '',
        'class Engine:',
        '    def __init__(self):',
        `        self.signal_ledger = ${ledgerType}()`,
        '',
        'def build_services(engine: Engine):',
        '    return Services(signal_ledger=engine.signal_ledger)',
        '',
        'def run():',
        '    engine = Engine()',
        '    build_services(engine=engine)',
    ].join('\n');
    const previousSources = {
        'src/ledger.py': ledgerSource,
        'src/services.py': servicesSource,
        'src/engine.py': engineSource('SignalLedger'),
    };
    const nextSources = {
        'src/ledger.py': ledgerSource,
        'src/services.py': servicesSource,
        'src/engine.py': engineSource('OtherLedger'),
    };
    const previous = await buildAnalyzedPythonRegistry(previousSources);
    const next = await buildAnalyzedPythonRegistry(nextSources);
    const previousRecords = buildRelationshipsForRegistry(previous);

    const claimsFor = (analysis: Map<string, RelationshipAnalysisEvidence>, file: string) => (
        (analysis.get(file) as { resolutionClaims?: readonly ResolutionClaim[] } | undefined)
            ?.resolutionClaims ?? []
    );

    const fullAnalysis = await analyzeFiles(nextSources);
    const fullRecords = buildRelationshipsForRegistry({ registry: next.registry, analysisByFile: fullAnalysis });

    const deltaAnalysis = await analyzeFiles(nextSources);
    const delta = buildRelationshipDelta({
        previousRegistry: previous.registry,
        registry: next.registry,
        existingRecords: previousRecords,
        analysisByFile: deltaAnalysis,
        previousAnalysisByFile: previous.analysisByFile,
        changedFiles: new Set(['src/engine.py']),
    });

    assert.deepEqual(delta.affectedFiles, ['src/engine.py', 'src/services.py']);
    assert.deepEqual(delta.records, fullRecords);

    // The rebuilt delta evidence carries the identical claims as the full
    // rebuild for every affected file: same decisions, authorities, proof
    // steps (kind and order), dependency keys, and claim ordering.
    for (const file of delta.affectedFiles) {
        assert.deepEqual(claimsFor(deltaAnalysis, file), claimsFor(fullAnalysis, file));
    }

    // The oracle is not vacuous: it covers an origin-flow claim with ordered
    // flow_hop steps and direct-binding claims with import/definition proof.
    const servicesClaims = claimsFor(deltaAnalysis, 'src/services.py');
    assert.equal(servicesClaims.length, 1);
    const [flowClaim] = servicesClaims;
    assert.equal(flowClaim.decision, 'resolved');
    assert.equal(flowClaim.relationshipType, 'CALLS');
    assert.equal(flowClaim.resolutionAuthority, 'origin_flow');
    assert.equal(flowClaim.flowHops, 2);
    assert.deepEqual(flowClaim.proofSteps.map((step) => step.kind), [
        'call_site',
        'containing_caller',
        'parameter_annotation',
        'allocation_origin',
        'constructor_origin',
        'flow_hop',
        'field_origin',
        'flow_hop',
        'allocation_origin',
    ]);
    assert.deepEqual(
        flowClaim.proofSteps.filter((step) => step.kind === 'flow_hop').map((step) => step.hop),
        [1, 2],
    );
    assert.equal(flowClaim.dependencyKeys.length, 2);
    assert.ok(flowClaim.dependencyKeys.every((key) => key.startsWith('src/engine.py:')));
    const engineClaims = claimsFor(deltaAnalysis, 'src/engine.py');
    assert.equal(engineClaims.length, 4);
    assert.ok(engineClaims.every((claim) => (
        claim.decision === 'resolved' && claim.resolutionAuthority === 'direct_binding'
    )));

    // Claim attachment is deterministically ordered by call span.
    for (const file of delta.affectedFiles) {
        const claims = claimsFor(deltaAnalysis, file);
        const sorted = [...claims].sort((left, right) => (
            left.callSpan.startByte - right.callSpan.startByte
        ));
        assert.deepEqual(claims, sorted);
    }

    // Deterministic order: a second full rebuild and a second delta on fresh
    // analysis produce identical records, affected files, and claims.
    const determinismAnalysis = await analyzeFiles(nextSources);
    const determinismRecords = buildRelationshipsForRegistry({
        registry: next.registry,
        analysisByFile: determinismAnalysis,
    });
    assert.deepEqual(determinismRecords, fullRecords);
    for (const file of delta.affectedFiles) {
        assert.deepEqual(claimsFor(determinismAnalysis, file), claimsFor(fullAnalysis, file));
    }
    const deltaAnalysis2 = await analyzeFiles(nextSources);
    const delta2 = buildRelationshipDelta({
        previousRegistry: previous.registry,
        registry: next.registry,
        existingRecords: previousRecords,
        analysisByFile: deltaAnalysis2,
        previousAnalysisByFile: previous.analysisByFile,
        changedFiles: new Set(['src/engine.py']),
    });
    assert.deepEqual(delta2.records, delta.records);
    assert.deepEqual(delta2.affectedFiles, delta.affectedFiles);
    for (const file of delta.affectedFiles) {
        assert.deepEqual(claimsFor(deltaAnalysis2, file), claimsFor(deltaAnalysis, file));
    }
});

test('Characterization: Python resolution preserves exact CALLS, claims, and flow proof steps', async () => {
    const sources = new Map([
        ['pkg/__init__.py', ''],
        ['pkg/db.py', 'class Database:\n    def query(self, q: str) -> str:\n        return q\n'],
        ['pkg/service.py', 'from pkg.db import Database\n\ndef run():\n    db = Database()\n    return db.query("SELECT 1")\n'],
    ]);
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry(sources);
    const records = buildRelationshipsForRegistry({ registry, analysisByFile });
    
    // Check CALLS records
    const calls = records.filter((r) => r.type === 'CALLS');
    assert.ok(calls.length >= 2, 'Must have at least constructor call and query call');
    
    // Check attached claims
    const serviceEvidence = analysisByFile.get('pkg/service.py');
    assert.ok(serviceEvidence?.resolutionClaims);
    assert.ok(serviceEvidence.resolutionClaims.length >= 2);
    
    const queryClaim = serviceEvidence.resolutionClaims.find((c) => c.targetSymbol?.includes('query'));
    assert.ok(queryClaim, 'Query method call must be resolved in claims');
    assert.equal(queryClaim.decision, 'resolved');
    assert.equal(queryClaim.resolutionAuthority, 'origin_flow');
});

test('Characterization: JS/TS syntactic resolution produces direct CALLS and derived TESTS edges', async () => {
    const sources = new Map([
        ['src/math.ts', 'export function add(a: number, b: number): number { return a + b; }\n'],
        ['src/app.ts', 'import { add } from "./math";\nexport function main() { return add(1, 2); }\n'],
        ['tests/app.test.ts', 'import { add } from "../src/math";\nexport function testAdd() { return add(2, 3); }\n'],
    ]);
    const analysisByFile = await analyzeFiles(sources);
    const symbols: SymbolRecord[] = [];
    const files: SymbolRegistryManifest['files'] = [];

    for (const [relativePath, content] of sources.entries()) {
        const analysis = analysisByFile.get(relativePath);
        assert.ok(analysis);
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath,
            language: 'typescript',
            content,
            fileHash: `hash-${relativePath}`,
            extractorVersion: 'test-extractor-v1',
            chunks: [],
            extractedSymbols: analysis.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path: relativePath,
            language: 'typescript',
            hash: `hash-${relativePath}`,
            symbolCount: fileSymbols.length,
            definitionStatus: 'definitions_present',
        });
    }

    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files,
        },
        symbols,
    });


    const records = buildRelationshipsForRegistry({ registry, analysisByFile });
    
    // Production call from src/app.ts -> src/math.ts
    const appCalls = records.filter((r) => r.file === 'src/app.ts' && r.type === 'CALLS');
    assert.equal(appCalls.length, 1);
    
    // Test call from tests/app.test.ts -> src/math.ts has both CALLS and derived TESTS
    const testCalls = records.filter((r) => r.file === 'tests/app.test.ts' && r.type === 'CALLS');
    const testTests = records.filter((r) => r.file === 'tests/app.test.ts' && r.type === 'TESTS');
    assert.equal(testCalls.length, 1);
    assert.equal(testTests.length, 1);
    assert.equal(testCalls[0].targetInstanceId, testTests[0].targetInstanceId);
    assert.equal(testCalls[0].confidence, 'low');
    assert.equal(testTests[0].confidence, 'low');
});

test('resolveUniqueLocalSymbol resolves top-level local export when nested member shares same name', async () => {
    const source = `function value() {
    return 1;
}

class Thing {
    value() {
        return 2;
    }
}

export { value as aliasValue };
`;
    const analysisByFile = await analyzeFiles(new Map([['src/mod.ts', source]]));
    const analyzer = createLanguageAnalysisService();
    const analysis = await analyzer.analyze({
        content: source,
        language: 'typescript',
        relativePath: 'src/mod.ts',
    });

    const fileSymbols = buildSymbolRecordsForFile({
        relativePath: 'src/mod.ts',
        language: 'typescript',
        content: source,
        fileHash: 'hash-mod',
        extractorVersion: 'test-extractor-v1',
        chunks: [],
        extractedSymbols: analysis.symbols,
    });

    const registry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [{
                path: 'src/mod.ts',
                language: 'typescript',
                hash: 'hash-mod',
                symbolCount: fileSymbols.length,
                definitionStatus: 'definitions_present',
            }],
        },
        symbols: fileSymbols,
    });

    const records = buildRelationshipsForRegistry({ registry, analysisByFile });
    const exportRecords = records.filter((r) => r.type === 'EXPORTS');
    assert.equal(exportRecords.length, 1);
    const target = registry.symbols.find(
        (symbol) => symbol.symbolInstanceId === exportRecords[0].targetInstanceId,
    );
    assert.ok(target);
    assert.equal(target.name, 'value');
    assert.equal(target.kind, 'function');
    assert.deepEqual(target.parentQualifiedNamePath, []);
});

test('buildRelationshipDelta incrementally rebuilds CBM language relationships when fresh semantic evidence is provided', () => {
    const symbols1: SymbolRecord[] = [
        {
            symbolKey: 'main.go#main',
            symbolInstanceId: 'inst-main',
            name: 'main',
            label: 'main',
            qualifiedName: 'main',
            kind: 'function',
            file: 'main.go',
            language: 'go',
            span: { startByte: 0, endByte: 100, startLine: 1, endLine: 10, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: 'fh-main-1',
            extractorVersion: 'v1',
        },
        {
            symbolKey: 'service.go#Run',
            symbolInstanceId: 'inst-service-1',
            name: 'Run',
            label: 'Run',
            qualifiedName: 'Run',
            kind: 'function',
            file: 'service.go',
            language: 'go',
            span: { startByte: 0, endByte: 80, startLine: 1, endLine: 8, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: 'fh-srv-1',
            extractorVersion: 'v1',
        },
    ];

    const prevRegistry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [
                { path: 'main.go', language: 'go', hash: 'fh-main-1', symbolCount: 1, definitionStatus: 'definitions_present' },
                { path: 'service.go', language: 'go', hash: 'fh-srv-1', symbolCount: 1, definitionStatus: 'definitions_present' },
            ],
        },
        symbols: symbols1,
    });

    const initialEvidence: import('../semantic').SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 20, endByte: 35, startLine: 3, endLine: 3, startColumn: 2, endColumn: 17 },
                        targetProvenance: {
                            file: 'service.go',
                            span: { startByte: 0, endByte: 80, startLine: 1, endLine: 8, startColumn: 0, endColumn: 1 },
                            name: 'Run',
                            kind: 'function',
                        },
                        proof: { strategy: 'direct_call' },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();
    analysisByFile.set('main.go', { moduleBindings: [], callSites: [] });
    analysisByFile.set('service.go', { moduleBindings: [], callSites: [] });

    const existingRecords = buildRelationshipsForRegistry({
        registry: prevRegistry,
        analysisByFile,
        mode: { kind: 'qualification', enabledUnpromotedCallLanguages: new Set(['go']) },
        semanticEvidenceByLanguage: new Map([['go', initialEvidence]]),
    });

    assert.equal(existingRecords.length, 1);
    assert.equal(existingRecords[0].targetInstanceId, 'inst-service-1');

    // Next state: service.go is updated with a new symbol instance ID and byte span (90..170)
    const symbols2: SymbolRecord[] = [
        symbols1[0],
        {
            symbolKey: 'service.go#Run',
            symbolInstanceId: 'inst-service-2',
            name: 'Run',
            label: 'Run',
            qualifiedName: 'Run',
            kind: 'function',
            file: 'service.go',
            language: 'go',
            span: { startByte: 90, endByte: 170, startLine: 10, endLine: 18, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: 'fh-srv-2',
            extractorVersion: 'v1',
        },
    ];

    const nextRegistry = buildSymbolRegistry({
        manifest: {
            ...manifest(),
            files: [
                { path: 'main.go', language: 'go', hash: 'fh-main-1', symbolCount: 1, definitionStatus: 'definitions_present' },
                { path: 'service.go', language: 'go', hash: 'fh-srv-2', symbolCount: 1, definitionStatus: 'definitions_present' },
            ],
        },
        symbols: symbols2,
    });

    const freshEvidence: import('../semantic').SemanticProjectEvidence = {
        language: 'go',
        occurrencesByFile: new Map([
            [
                'main.go',
                [
                    {
                        sourceFile: 'main.go',
                        callSpan: { startByte: 20, endByte: 35, startLine: 3, endLine: 3, startColumn: 2, endColumn: 17 },
                        targetProvenance: {
                            file: 'service.go',
                            span: { startByte: 90, endByte: 170, startLine: 10, endLine: 18, startColumn: 0, endColumn: 1 },
                            name: 'Run',
                            kind: 'function',
                        },
                        proof: { strategy: 'direct_call' },
                        decision: 'resolved',
                        confidence: 1.0,
                    },
                ],
            ],
        ]),
    };

    const delta = buildRelationshipDelta({
        previousRegistry: prevRegistry,
        registry: nextRegistry,
        existingRecords,
        analysisByFile,
        changedFiles: new Set(['service.go']),
        mode: { kind: 'qualification', enabledUnpromotedCallLanguages: new Set(['go']) },
        semanticEvidenceByLanguage: new Map([['go', freshEvidence]]),
    });

    // Verify that the relationship was rebuilt and retargeted to the new instance ID
    assert.equal(delta.records.length, 1);
    assert.equal(delta.records[0].targetInstanceId, 'inst-service-2');
    assert.ok(delta.affectedFiles.includes('main.go'));
    assert.ok(delta.affectedFiles.includes('service.go'));
});





