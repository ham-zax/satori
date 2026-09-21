import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    buildSymbolRecordsForFile,
} from '../symbols';
import type { SymbolRecord, SymbolRegistryManifest } from '../symbols';
import { createLanguageAnalysisService } from '../language-analysis';
import { getLanguageIdFromFilename } from '../language';
import {
    resolvePythonRelationships,
    type PythonResolutionAnalysisInput,
} from './python-resolution';

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
        analysisByFile: analysisByFile as Map<string, PythonResolutionAnalysisInput>,
        registry: buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: '/repo',
                rootFingerprint: 'root-fingerprint',
                indexPolicyHash: 'policy-hash',
                languageRouterVersion: 'router-v1',
                extractorVersion: 'test-extractor-v1',
                relationshipVersion: 'relationship-v1',
                builtAt: '2026-06-17T00:00:00.000Z',
                files,
            },
            symbols,
        }),
    };
}

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
const engineSource = [
    'from .ledger import OtherLedger, SignalLedger',
    'from .services import Services',
    '',
    'class Engine:',
    '    def __init__(self):',
    '        self.signal_ledger = SignalLedger()',
    '',
    'def build_services(engine: Engine):',
    '    return Services(signal_ledger=engine.signal_ledger)',
    '',
    'def run():',
    '    engine = Engine()',
    '    build_services(engine=engine)',
].join('\n');

test('resolvePythonRelationships resolves direct imported calls with exact binding proof', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/util.py': 'def helper(): return 1\n',
        'src/app.py': 'from .util import helper\n\ndef run():\n    return helper()\n',
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    assert.deepEqual(
        result.records.map((record) => [
            record.file,
            record.type,
            symbolsById.get(record.sourceInstanceId || '')?.qualifiedName,
            symbolsById.get(record.targetInstanceId || '')?.qualifiedName,
            record.confidence,
            record.resolutionAuthority,
        ]),
        [
            ['src/app.py', 'CALLS', 'run', 'helper', 'low', 'direct_binding'],
        ],
    );

    const claims = result.claimsByFile.get('src/app.py') ?? [];
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.decision, 'resolved');
    assert.equal(claim.relationshipType, 'CALLS');
    assert.equal(claim.resolutionAuthority, 'direct_binding');
    assert.equal(claim.flowHops, 0);
    assert.deepEqual(claim.proofSteps.map((step) => step.kind), [
        'call_site',
        'containing_caller',
        'relative_import',
    ]);
    assert.deepEqual(claim.dependencyKeys, []);
});

test('resolvePythonRelationships resolves typed member calls with parameter proof', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/ledger.py': 'class SignalLedger:\n    def record(self): pass\n',
        'src/caller.py': 'from .ledger import SignalLedger\n\ndef typed(ledger: SignalLedger):\n    ledger.record()\n',
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    assert.deepEqual(
        result.records.map((record) => [
            record.file,
            record.type,
            symbolsById.get(record.sourceInstanceId || '')?.qualifiedName,
            symbolsById.get(record.targetInstanceId || '')?.qualifiedName,
            record.confidence,
            record.resolutionAuthority,
        ]),
        [
            ['src/caller.py', 'CALLS', 'typed', 'SignalLedger.record', 'low', 'direct_binding'],
        ],
    );

    const claims = result.claimsByFile.get('src/caller.py') ?? [];
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.decision, 'resolved');
    assert.equal(claim.relationshipType, 'CALLS');
    assert.equal(claim.resolutionAuthority, 'direct_binding');
    assert.deepEqual(claim.proofSteps.map((step) => step.kind), [
        'call_site',
        'containing_caller',
        'parameter_annotation',
    ]);
    assert.deepEqual(claim.dependencyKeys, []);
});

test('resolvePythonRelationships resolves flow-origin member calls with ordered flow_hop proof', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/ledger.py': ledgerSource,
        'src/services.py': servicesSource,
        'src/engine.py': engineSource,
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    assert.deepEqual(
        result.records
            .filter((record) => record.file === 'src/services.py')
            .map((record) => [
                symbolsById.get(record.sourceInstanceId || '')?.qualifiedName,
                symbolsById.get(record.targetInstanceId || '')?.qualifiedName,
                record.type,
                record.confidence,
                record.resolutionAuthority,
            ]),
        [
            ['consume', 'SignalLedger.record', 'CALLS', 'low', 'origin_flow'],
        ],
    );

    const claims = result.claimsByFile.get('src/services.py') ?? [];
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.decision, 'resolved');
    assert.equal(claim.relationshipType, 'CALLS');
    assert.equal(claim.resolutionAuthority, 'origin_flow');
    assert.equal(claim.flowHops, 2);
    assert.deepEqual(claim.proofSteps.map((step) => step.kind), [
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
        claim.proofSteps.filter((step) => step.kind === 'flow_hop').map((step) => step.hop),
        [1, 2],
    );
    assert.equal(claim.dependencyKeys.length, 2);
    assert.ok(claim.dependencyKeys.every((key) => key.startsWith('src/engine.py:')));

    const engineClaims = result.claimsByFile.get('src/engine.py') ?? [];
    assert.equal(engineClaims.length, 4);
    assert.ok(engineClaims.every((engineClaim) => (
        engineClaim.decision === 'resolved' && engineClaim.resolutionAuthority === 'direct_binding'
    )));
});

test('resolvePythonRelationships reports ambiguous member calls as REFERENCES claims without records', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/caller.py': [
            'class Alpha:',
            '    def run(self): pass',
            '',
            'class Beta:',
            '    def run(self): pass',
            '',
            'def invoke(service):',
            '    service.run()',
        ].join('\n'),
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });

    assert.deepEqual(result.records, []);

    const claims = result.claimsByFile.get('src/caller.py') ?? [];
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.decision, 'ambiguous');
    assert.equal(claim.relationshipType, 'REFERENCES');
    assert.equal(claim.resolutionAuthority, 'ambiguous');
    assert.equal(claim.flowHops, 0);
    assert.deepEqual(claim.proofSteps.map((step) => step.kind), [
        'call_site',
        'containing_caller',
        'candidate_set',
        'ambiguity',
    ]);
    assert.equal(claim.dependencyKeys.length, 1);
    assert.ok(claim.dependencyKeys[0].startsWith('src/caller.py:'));
    assert.ok(claim.dependencyKeys[0].includes('service:run'));
});

test('resolvePythonRelationships reports unresolved direct calls as REFERENCES claims without records', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/caller.py': 'def run():\n    return missing_helper()\n',
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });

    assert.deepEqual(result.records, []);

    const claims = result.claimsByFile.get('src/caller.py') ?? [];
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.decision, 'unresolved');
    assert.equal(claim.relationshipType, 'REFERENCES');
    assert.equal(claim.resolutionAuthority, 'unresolved');
    assert.equal(claim.flowHops, 0);
    assert.deepEqual(claim.proofSteps.map((step) => step.kind), [
        'call_site',
        'containing_caller',
        'unresolved_dependency',
    ]);
    assert.equal(claim.dependencyKeys.length, 1);
    assert.ok(claim.dependencyKeys[0].includes('missing_helper'));
});

test('resolvePythonRelationships is side-effect free and deterministically ordered', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/ledger.py': ledgerSource,
        'src/services.py': servicesSource,
        'src/engine.py': engineSource,
        'src/unresolved.py': 'def run():\n    return missing_helper()\n',
    });
    const snapshotAnalysis = () => JSON.stringify(
        [...analysisByFile.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    const snapshotRegistry = () => JSON.stringify({
        manifest: registry.manifest,
        symbols: [...registry.symbols].sort((left, right) => (
            left.symbolKey.localeCompare(right.symbolKey)
        )),
        warnings: registry.warnings,
    });
    const beforeAnalysis = snapshotAnalysis();
    const beforeRegistry = snapshotRegistry();

    const first = resolvePythonRelationships({ registry, analysisByFile });

    // The engine publishes nothing: inputs are not mutated and no claims are
    // attached to analysis evidence (the builder facade performs attachment
    // during emit).
    assert.equal(snapshotAnalysis(), beforeAnalysis);
    assert.equal(snapshotRegistry(), beforeRegistry);
    for (const evidence of analysisByFile.values()) {
        assert.equal((evidence as { resolutionClaims?: unknown }).resolutionClaims, undefined);
    }

    // A run on fresh but identical inputs yields identical records and
    // claims, including claim ordering and proof-step order.
    const secondInput = await buildAnalyzedPythonRegistry({
        'src/ledger.py': ledgerSource,
        'src/services.py': servicesSource,
        'src/engine.py': engineSource,
        'src/unresolved.py': 'def run():\n    return missing_helper()\n',
    });
    const second = resolvePythonRelationships({
        registry: secondInput.registry,
        analysisByFile: secondInput.analysisByFile,
    });
    assert.deepEqual(second.records, first.records);
    assert.deepEqual(second.claimsByFile, first.claimsByFile);
    assert.ok(first.claimsByFile.size > 0);
});

test('resolvePythonRelationships scopes function-local imports to their owning callable', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/alpha.py': 'def helper(): pass\n',
        'src/beta.py': 'def helper(): pass\n',
        'src/app.py': [
            'def a():',
            '    from .alpha import helper',
            '    helper()',
            '',
            'def b():',
            '    from .beta import helper',
            '    helper()',
            '',
            'def c():',
            '    helper()',
        ].join('\n'),
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;
    const calls = result.records
        .filter((record) => record.type === 'CALLS')
        .map((record) => [
            symbolsById.get(record.sourceInstanceId || '')?.qualifiedName,
            symbolsById.get(record.targetInstanceId || '')?.file,
            symbolsById.get(record.targetInstanceId || '')?.qualifiedName,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])));

    assert.deepEqual(calls, [
        ['a', 'src/alpha.py', 'helper'],
        ['b', 'src/beta.py', 'helper'],
    ]);
    const c = [...(result.claimsByFile.get('src/app.py') ?? [])].find((claim) => (
        symbolsById.get(claim.sourceInstanceId || '')?.qualifiedName === 'c'
    ));
    assert.ok(c);
    assert.notEqual(c.decision, 'resolved');
    assert.equal(c.relationshipType, 'REFERENCES');
});

test('resolvePythonRelationships keeps branch-conflicted origins non-authoritative while preserving straight-line reassignment', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/app.py': [
            'class A:',
            '    def run(self): pass',
            'class B:',
            '    def run(self): pass',
            '',
            'def straight():',
            '    value = A()',
            '    value = B()',
            '    value.run()',
            '',
            'def conditional(flag):',
            '    value = A()',
            '    if flag:',
            '        value = B()',
            '    value.run()',
            '',
            'def if_else(flag):',
            '    if flag:',
            '        value = A()',
            '    else:',
            '        value = B()',
            '    value.run()',
            '',
            'def nested(first, second):',
            '    value = A()',
            '    if first:',
            '        if second:',
            '            value = B()',
            '    value.run()',
        ].join('\n'),
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    const straightCall = result.records.find((record) => (
        record.type === 'CALLS'
        && symbolsById.get(record.sourceInstanceId || '')?.qualifiedName === 'straight'
        && symbolsById.get(record.targetInstanceId || '')?.qualifiedName === 'B.run'
    ));
    assert.ok(straightCall);

    for (const callerName of ['conditional', 'if_else', 'nested']) {
        assert.equal(result.records.some((record) => (
            record.type === 'CALLS'
            && symbolsById.get(record.sourceInstanceId || '')?.qualifiedName === callerName
            && symbolsById.get(record.targetInstanceId || '')?.name === 'run'
        )), false, callerName);
        const claim = [...(result.claimsByFile.get('src/app.py') ?? [])].find((candidate) => (
            symbolsById.get(candidate.sourceInstanceId || '')?.qualifiedName === callerName
            && candidate.proofSteps[0]?.subject === 'run'
        ));
        assert.ok(claim, callerName);
        assert.notEqual(claim.decision, 'resolved', callerName);
        assert.equal(claim.relationshipType, 'REFERENCES', callerName);
    }
});

test('resolvePythonRelationships resolves string annotations, typed aliases, inherited methods, and overrides', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/models.py': 'class Service:\n    def run(self): pass\n',
        'src/app.py': [
            'from .models import Service',
            '',
            'class Base:',
            '    def ping(self): pass',
            '',
            'class Child(Base):',
            '    def run(self): pass',
            '',
            'def typed(service: "Service"):',
            '    alias = service',
            '    alias.run()',
            '',
            'def inherited():',
            '    child = Child()',
            '    child.ping()',
            '',
            'def overridden():',
            '    child = Child()',
            '    child.run()',
        ].join('\n'),
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;
    const targetByCaller = new Map(
        result.records
            .filter((record) => record.type === 'CALLS')
            .map((record) => [
                symbolsById.get(record.sourceInstanceId || '')?.qualifiedName,
                symbolsById.get(record.targetInstanceId || '')?.qualifiedName,
            ] as const),
    );

    assert.equal(targetByCaller.get('typed'), 'Service.run');
    assert.equal(targetByCaller.get('inherited'), 'Base.ping');
    assert.equal(targetByCaller.get('overridden'), 'Child.run');
});

test('resolvePythonRelationships propagates exact callbacks and callable-object origins', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/app.py': [
            'class Handler:',
            '    def __call__(self): pass',
            '',
            'def target(): pass',
            '',
            'def invoke(cb):',
            '    cb()',
            '',
            'def entry():',
            '    invoke(target)',
            '    handler = Handler()',
            '    handler()',
        ].join('\n'),
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    const callbackClaim = [...(result.claimsByFile.get('src/app.py') ?? [])].find((claim) => (
        symbolsById.get(claim.sourceInstanceId || '')?.qualifiedName === 'invoke'
        && claim.proofSteps[0]?.subject === 'cb'
    ));
    assert.equal(callbackClaim?.decision, 'resolved');
    assert.equal(callbackClaim?.targetSymbol, 'target');
    assert.equal(callbackClaim?.resolutionAuthority, 'origin_flow');

    const callableObjectClaim = [...(result.claimsByFile.get('src/app.py') ?? [])].find((claim) => (
        symbolsById.get(claim.sourceInstanceId || '')?.qualifiedName === 'entry'
        && claim.proofSteps[0]?.subject === 'handler'
    ));
    assert.equal(callableObjectClaim?.decision, 'resolved');
    assert.equal(callableObjectClaim?.targetSymbol, 'Handler.__call__');
    assert.equal(callableObjectClaim?.resolutionAuthority, 'origin_flow');
});

test('resolvePythonRelationships fails closed for protocol-only dispatch and decorated callable rebinding', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/app.py': [
            'from typing import Protocol',
            '',
            'class Runner(Protocol):',
            '    def run(self): ...',
            '',
            'class Impl:',
            '    def run(self): pass',
            '',
            'def use(value: Runner):',
            '    value.run()',
            '',
            'def replacement(): pass',
            '',
            'def replace(fn):',
            '    return replacement',
            '',
            '@replace',
            'def original(): pass',
            '',
            'def go():',
            '    original()',
        ].join('\n'),
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const symbolsById = registry.symbolsByInstanceId;

    for (const [callerName, calleeName] of [['use', 'run'], ['go', 'original']] as const) {
        assert.equal(result.records.some((record) => (
            record.type === 'CALLS'
            && symbolsById.get(record.sourceInstanceId || '')?.qualifiedName === callerName
        )), false, callerName);
        const claim = [...(result.claimsByFile.get('src/app.py') ?? [])].find((candidate) => (
            symbolsById.get(candidate.sourceInstanceId || '')?.qualifiedName === callerName
            && candidate.proofSteps[0]?.subject === calleeName
        ));
        assert.ok(claim, callerName);
        assert.notEqual(claim.decision, 'resolved', callerName);
        assert.equal(claim.relationshipType, 'REFERENCES', callerName);
    }
});

test('resolvePythonRelationships maps exact positional constructor arguments into parameter flow', async () => {
    const { registry, analysisByFile } = await buildAnalyzedPythonRegistry({
        'src/app.py': [
            'from typing import Any',
            '',
            'class Ledger:',
            '    def record(self): pass',
            '',
            'class Engine:',
            '    def __init__(self):',
            '        self.ledger = Ledger()',
            '',
            'class Services:',
            '    def __init__(self, ledger: Any):',
            '        self.ledger = ledger',
            '',
            'def consume(services: Services):',
            '    services.ledger.record()',
            '',
            'def entry():',
            '    engine = Engine()',
            '    services = Services(engine.ledger)',
            '    consume(services=services)',
        ].join('\n'),
    });
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const claim = [...(result.claimsByFile.get('src/app.py') ?? [])].find((candidate) => (
        candidate.callSpan.startLine === 15 && candidate.proofSteps[0]?.subject === 'record'
    ));

    assert.equal(claim?.decision, 'resolved');
    assert.equal(claim?.targetSymbol, 'Ledger.record');
    assert.equal(claim?.resolutionAuthority, 'origin_flow');
    assert.equal(claim?.flowHops, 2);
    assert.equal(claim?.proofSteps.filter((step) => step.kind === 'flow_hop').length, 2);
});
