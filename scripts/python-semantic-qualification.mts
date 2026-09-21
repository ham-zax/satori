import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createLanguageAnalysisService } from '../packages/core/src/language-analysis/service.ts';
import { getLanguageIdFromFilename } from '../packages/core/src/language/registry.ts';
import { buildSymbolRecordsForFile, buildSymbolRegistry } from '../packages/core/src/symbols/registry.ts';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    type SymbolRecord,
    type SymbolRegistryManifest,
} from '../packages/core/src/symbols/contracts.ts';
import {
    resolvePythonRelationships,
    type PythonResolutionAnalysisInput,
} from '../packages/core/src/relationships/python-resolution.ts';
import {
    NATIVE_PYTHON_PROVIDER_ID,
    NATIVE_PYTHON_PROVIDER_VERSION,
    type ResolutionClaim,
} from '../packages/core/src/relationships/resolution.ts';
import {
    candidateNamesFromResolutionClaim,
    inferResolutionStrategy,
    neutralEvidenceFromResolutionClaim,
} from './semantic-qualification-adapter-helpers.mjs';

interface CanonicalTarget {
    readonly file: string;
    readonly qualifiedName: string;
}

interface QualificationFixture {
    readonly caseId: string;
    readonly sources?: Readonly<Record<string, string>>;
    readonly callFile?: string;
    readonly callLine?: number;
    readonly callee?: string;
    readonly sourceQualifiedName?: string;
    readonly targets?: Readonly<Record<string, CanonicalTarget>>;
    readonly unsupportedReason?: string;
}

interface Corpus {
    readonly version: number;
    readonly cases: readonly { readonly id: string }[];
}

function lines(...values: string[]): string {
    return values.join('\n') + '\n';
}

function parseArgs(argv: readonly string[]) {
    let corpusPath = path.resolve('evals/semantic-relationship-qualification/corpus.json');
    let outPath: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--corpus' && argv[index + 1]) {
            corpusPath = path.resolve(argv[++index]);
        } else if (argv[index] === '--out' && argv[index + 1]) {
            outPath = path.resolve(argv[++index]);
        }
    }
    return { corpusPath, outPath };
}

async function analyzeFiles(sources: Readonly<Record<string, string>>) {
    const analyzer = createLanguageAnalysisService();
    return new Map(await Promise.all(Object.entries(sources).map(async ([relativePath, source]) => [
        relativePath,
        await analyzer.analyze({
            content: source,
            language: getLanguageIdFromFilename(relativePath, 'text'),
            relativePath,
        }),
    ] as const)));
}

async function buildRegistry(sources: Readonly<Record<string, string>>) {
    const entries = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right));
    const analysisByFile = await analyzeFiles(Object.fromEntries(entries));
    const symbols: SymbolRecord[] = [];
    const files: SymbolRegistryManifest['files'] = [];

    for (const [relativePath, source] of entries) {
        const analysis = analysisByFile.get(relativePath);
        if (!analysis) throw new Error('Missing analysis for ' + relativePath);
        const fileHash = 'python-qualification-' + relativePath;
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath,
            language: 'python',
            content: source,
            fileHash,
            extractorVersion: 'python-qualification-v1',
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
                normalizedRootPath: '/python-qualification',
                rootFingerprint: 'python-qualification-root',
                indexPolicyHash: 'python-qualification-policy',
                languageRouterVersion: 'python-qualification-router',
                extractorVersion: 'python-qualification-v1',
                relationshipVersion: 'python-qualification-v1',
                builtAt: '2026-09-21T00:00:00.000Z',
                files,
            },
            symbols,
        }),
    };
}

function canonicalRef(ref: string, target: CanonicalTarget, symbols: readonly SymbolRecord[]) {
    const matches = symbols.filter((symbol) => (
        symbol.file === target.file && symbol.qualifiedName === target.qualifiedName
    ));
    if (matches.length !== 1) {
        throw new Error('Expected one target for ' + ref + ', found ' + matches.length);
    }
    const symbol = matches[0];
    return {
        ref,
        label: symbol.qualifiedName,
        file: symbol.file,
        span: { ...symbol.span },
    };
}

function alternativesFromClaim(
    fixture: QualificationFixture,
    claim: ResolutionClaim,
    symbols: readonly SymbolRecord[],
) {
    return candidateNamesFromResolutionClaim(claim).flatMap((candidateName) => {
        const providerMatches = symbols.filter((symbol) => symbol.qualifiedName === candidateName);
        if (providerMatches.length !== 1) {
            throw new Error(
                'Provider candidate ' + candidateName + ' did not map to one exact registry symbol; saw '
                + providerMatches.length,
            );
        }
        const symbol = providerMatches[0];
        const canonicalMatches = Object.entries(fixture.targets ?? {}).filter(([, canonical]) => (
            canonical.file === symbol.file
            && canonical.qualifiedName === symbol.qualifiedName
        ));
        if (canonicalMatches.length === 1) {
            const [ref, canonical] = canonicalMatches[0];
            return [canonicalRef(ref, canonical, symbols)];
        }
        return [{
            ref: `unmapped:${symbol.file}:${symbol.span.startByte}:${symbol.qualifiedName}`,
            label: symbol.qualifiedName,
            file: symbol.file,
            span: { ...symbol.span },
        }];
    });
}

const fixtures: readonly QualificationFixture[] = [
    {
        caseId: 'direct_call',
        sources: {
            'fixture/primary.py': lines('def helper(): pass'),
            'fixture/decoy.py': lines('def helper(): pass'),
            'fixture/direct.py': lines('from .primary import helper', '', 'def caller():', '    helper()'),
        },
        callFile: 'fixture/direct.py',
        callLine: 4,
        callee: 'helper',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/primary.py', qualifiedName: 'helper' },
            'target.decoy': { file: 'fixture/decoy.py', qualifiedName: 'helper' },
        },
    },
    {
        caseId: 'class_field_receiver',
        sources: {
            'fixture/field.py': lines(
                'class Service:',
                '    def run(self): pass',
                'class Decoy:',
                '    def run(self): pass',
                '',
                'class Owner:',
                '    def __init__(self):',
                '        self.service = Service()',
                '    def caller(self):',
                '        self.service.run()',
            ),
        },
        callFile: 'fixture/field.py',
        callLine: 10,
        callee: 'run',
        sourceQualifiedName: 'Owner.caller',
        targets: {
            'target.primary': { file: 'fixture/field.py', qualifiedName: 'Service.run' },
            'target.decoy': { file: 'fixture/field.py', qualifiedName: 'Decoy.run' },
        },
    },
    {
        caseId: 'constructor_parameter_property',
        unsupportedReason: 'Python has no constructor-parameter-property syntax that simultaneously declares and initializes an instance field.',
    },
    {
        caseId: 'constructor_assignment_origin',
        sources: {
            'fixture/constructor_assignment.py': lines(
                'class Service:',
                '    def run(self): pass',
                'class Decoy:',
                '    def run(self): pass',
                '',
                'class Owner:',
                '    def __init__(self, dependency):',
                '        self.dependency = dependency',
                '    def caller(self):',
                '        self.dependency.run()',
                '',
                'def entry():',
                '    service = Service()',
                '    owner = Owner(service)',
                '    owner.caller()',
            ),
        },
        callFile: 'fixture/constructor_assignment.py',
        callLine: 10,
        callee: 'run',
        sourceQualifiedName: 'Owner.caller',
        targets: {
            'target.primary': { file: 'fixture/constructor_assignment.py', qualifiedName: 'Service.run' },
            'target.decoy': { file: 'fixture/constructor_assignment.py', qualifiedName: 'Decoy.run' },
        },
    },
    {
        caseId: 'alias_binding',
        sources: {
            'fixture/primary.py': lines('def helper(): pass'),
            'fixture/decoy.py': lines('def helper(): pass'),
            'fixture/alias.py': lines('from .primary import helper as alias', '', 'def caller():', '    alias()'),
        },
        callFile: 'fixture/alias.py',
        callLine: 4,
        callee: 'alias',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/primary.py', qualifiedName: 'helper' },
            'target.decoy': { file: 'fixture/decoy.py', qualifiedName: 'helper' },
        },
    },
    {
        caseId: 'optional_receiver',
        unsupportedReason: 'Python native v2 intentionally does not interpret Optional/union narrowing as exact receiver identity.',
    },
    {
        caseId: 'inheritance_dispatch',
        sources: {
            'fixture/inheritance.py': lines(
                'class Base:',
                '    def run(self): pass',
                'class Decoy:',
                '    def run(self): pass',
                'class Child(Base):',
                '    pass',
                '',
                'def caller():',
                '    child = Child()',
                '    child.run()',
            ),
        },
        callFile: 'fixture/inheritance.py',
        callLine: 10,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.base': { file: 'fixture/inheritance.py', qualifiedName: 'Base.run' },
            'target.decoy': { file: 'fixture/inheritance.py', qualifiedName: 'Decoy.run' },
        },
    },
    {
        caseId: 'interface_dispatch',
        sources: {
            'fixture/interface.py': lines(
                'from typing import Protocol',
                '',
                'class Runner(Protocol):',
                '    def run(self): ...',
                'class ImplA:',
                '    def run(self): pass',
                'class ImplB:',
                '    def run(self): pass',
                '',
                'def caller(value: Runner):',
                '    value.run()',
            ),
        },
        callFile: 'fixture/interface.py',
        callLine: 11,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.impl_a': { file: 'fixture/interface.py', qualifiedName: 'ImplA.run' },
            'target.impl_b': { file: 'fixture/interface.py', qualifiedName: 'ImplB.run' },
        },
    },
    {
        caseId: 'overload_ambiguity',
        unsupportedReason: 'Python runtime functions do not provide static overload dispatch identity equivalent to compiler overload resolution.',
    },
    {
        caseId: 'branch_conflicted_origins',
        sources: {
            'fixture/branch.py': lines(
                'class A:',
                '    def run(self): pass',
                'class B:',
                '    def run(self): pass',
                '',
                'def caller(flag):',
                '    value = A()',
                '    if flag:',
                '        value = B()',
                '    value.run()',
            ),
        },
        callFile: 'fixture/branch.py',
        callLine: 10,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.branch_a': { file: 'fixture/branch.py', qualifiedName: 'A.run' },
            'target.branch_b': { file: 'fixture/branch.py', qualifiedName: 'B.run' },
        },
    },
    {
        caseId: 'dynamic_unresolved',
        sources: {
            'fixture/dynamic.py': lines(
                'class Service:',
                '    def run(self): pass',
                '',
                'def caller(value):',
                '    getattr(value, "run")()',
            ),
        },
        callFile: 'fixture/dynamic.py',
        callLine: 5,
        callee: 'getattr',
        sourceQualifiedName: 'caller',
        targets: {},
    },
    {
        caseId: 'wrong_target_decoy',
        sources: {
            'fixture/primary.py': lines('def helper(): pass'),
            'fixture/decoy_a.py': lines('def helper(): pass'),
            'fixture/decoy_b.py': lines('def helper(): pass'),
            'fixture/decoys.py': lines('from .primary import helper', '', 'def caller():', '    helper()'),
        },
        callFile: 'fixture/decoys.py',
        callLine: 4,
        callee: 'helper',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/primary.py', qualifiedName: 'helper' },
            'target.decoy_a': { file: 'fixture/decoy_a.py', qualifiedName: 'helper' },
            'target.decoy_b': { file: 'fixture/decoy_b.py', qualifiedName: 'helper' },
        },
    },
    {
        caseId: 'python.local_import',
        sources: {
            'fixture/models.py': lines('def helper(): pass'),
            'fixture/decoy.py': lines('def helper(): pass'),
            'fixture/app.py': lines('def caller():', '    from .models import helper', '    helper()'),
        },
        callFile: 'fixture/app.py',
        callLine: 3,
        callee: 'helper',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/models.py', qualifiedName: 'helper' },
            'target.decoy': { file: 'fixture/decoy.py', qualifiedName: 'helper' },
        },
    },
    {
        caseId: 'python.competing_local_import',
        sources: {
            'fixture/alpha.py': lines('def helper(): pass'),
            'fixture/beta.py': lines('def helper(): pass'),
            'fixture/app.py': lines(
                'def caller():',
                '    from .alpha import helper',
                '    helper()',
                '',
                'def other():',
                '    from .beta import helper',
                '    helper()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 3,
        callee: 'helper',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/alpha.py', qualifiedName: 'helper' },
            'target.decoy': { file: 'fixture/beta.py', qualifiedName: 'helper' },
        },
    },
    {
        caseId: 'python.forward_annotation',
        sources: {
            'fixture/models.py': lines('class Service:', '    def run(self): pass'),
            'fixture/decoy.py': lines('class Decoy:', '    def run(self): pass'),
            'fixture/app.py': lines(
                'from .models import Service',
                '',
                'def caller(service: "Service"):',
                '    service.run()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 4,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/models.py', qualifiedName: 'Service.run' },
            'target.decoy': { file: 'fixture/decoy.py', qualifiedName: 'Decoy.run' },
        },
    },
    {
        caseId: 'python.callback_keyword',
        sources: {
            'fixture/app.py': lines(
                'def target(): pass',
                '',
                'def invoke(cb):',
                '    cb()',
                '',
                'def entry():',
                '    invoke(cb=target)',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 4,
        callee: 'cb',
        sourceQualifiedName: 'invoke',
        targets: {
            'target.primary': { file: 'fixture/app.py', qualifiedName: 'target' },
        },
    },
    {
        caseId: 'python.keyword_flow',
        sources: {
            'fixture/app.py': lines(
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
                '    services = Services(ledger=engine.ledger)',
                '    consume(services=services)',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 15,
        callee: 'record',
        sourceQualifiedName: 'consume',
        targets: {
            'target.primary': { file: 'fixture/app.py', qualifiedName: 'Ledger.record' },
        },
    },
    {
        caseId: 'python.positional_flow',
        sources: {
            'fixture/app.py': lines(
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
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 15,
        callee: 'record',
        sourceQualifiedName: 'consume',
        targets: {
            'target.primary': { file: 'fixture/app.py', qualifiedName: 'Ledger.record' },
        },
    },
    {
        caseId: 'python.import_alias',
        sources: {
            'fixture/models.py': lines('class Service:', '    def run(self): pass'),
            'fixture/decoy.py': lines('class Decoy:', '    def run(self): pass'),
            'fixture/app.py': lines(
                'from .models import Service as S',
                '',
                'def caller():',
                '    service = S()',
                '    service.run()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 5,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/models.py', qualifiedName: 'Service.run' },
            'target.decoy': { file: 'fixture/decoy.py', qualifiedName: 'Decoy.run' },
        },
    },
    {
        caseId: 'python.override_dispatch',
        sources: {
            'fixture/app.py': lines(
                'class Base:',
                '    def run(self): pass',
                '',
                'class Child(Base):',
                '    def run(self): pass',
                '',
                'def caller():',
                '    child = Child()',
                '    child.run()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 9,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.child': { file: 'fixture/app.py', qualifiedName: 'Child.run' },
            'target.base': { file: 'fixture/app.py', qualifiedName: 'Base.run' },
        },
    },
    {
        caseId: 'python.branch_conflict',
        sources: {
            'fixture/app.py': lines(
                'class A:',
                '    def run(self): pass',
                'class B:',
                '    def run(self): pass',
                '',
                'def caller(flag):',
                '    value = A()',
                '    if flag:',
                '        value = B()',
                '    value.run()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 10,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.a': { file: 'fixture/app.py', qualifiedName: 'A.run' },
            'target.b': { file: 'fixture/app.py', qualifiedName: 'B.run' },
        },
    },
    {
        caseId: 'python.callable_object',
        sources: {
            'fixture/app.py': lines(
                'class Handler:',
                '    def __call__(self): pass',
                '',
                'def caller():',
                '    handler = Handler()',
                '    handler()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 6,
        callee: 'handler',
        sourceQualifiedName: 'caller',
        targets: {
            'target.primary': { file: 'fixture/app.py', qualifiedName: 'Handler.__call__' },
        },
    },
    {
        caseId: 'python.decorator_abstention',
        sources: {
            'fixture/app.py': lines(
                'def replacement(): pass',
                '',
                'def replace(fn):',
                '    return replacement',
                '',
                '@replace',
                'def original(): pass',
                '',
                'def caller():',
                '    original()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 10,
        callee: 'original',
        sourceQualifiedName: 'caller',
        targets: {},
    },
    {
        caseId: 'python.protocol_ambiguity',
        sources: {
            'fixture/app.py': lines(
                'from typing import Protocol',
                '',
                'class Runner(Protocol):',
                '    def run(self): ...',
                'class ImplA:',
                '    def run(self): pass',
                'class ImplB:',
                '    def run(self): pass',
                '',
                'def caller(value: Runner):',
                '    value.run()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 11,
        callee: 'run',
        sourceQualifiedName: 'caller',
        targets: {
            'target.impl_a': { file: 'fixture/app.py', qualifiedName: 'ImplA.run' },
            'target.impl_b': { file: 'fixture/app.py', qualifiedName: 'ImplB.run' },
        },
    },
    {
        caseId: 'python.dynamic_abstention',
        sources: {
            'fixture/app.py': lines(
                'class A:',
                '    def run(self): pass',
                '',
                'def caller(value):',
                '    getattr(value, "run")()',
            ),
        },
        callFile: 'fixture/app.py',
        callLine: 5,
        callee: 'getattr',
        sourceQualifiedName: 'caller',
        targets: {},
    },
];

const { corpusPath, outPath } = parseArgs(process.argv.slice(2));
if (!fs.existsSync(corpusPath)) {
    throw new Error('Qualification corpus not found: ' + corpusPath + '. Pass --corpus <path>.');
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as Corpus;
const fixturesById = new Map(fixtures.map((fixture) => [fixture.caseId, fixture]));
const missingFixtures = corpus.cases.map((item) => item.id).filter((id) => !fixturesById.has(id));
if (missingFixtures.length > 0) {
    throw new Error('Missing Python qualification fixtures: ' + missingFixtures.join(', '));
}

const runStart = performance.now();
const cases: Array<Record<string, unknown>> = [];

for (const item of corpus.cases) {
    const fixture = fixturesById.get(item.id)!;
    const caseStart = performance.now();
    if (fixture.unsupportedReason) {
        cases.push({
            caseId: item.id,
            status: 'unsupported',
            unsupportedReason: fixture.unsupportedReason,
            unsupportedEvidence: [{
                kind: 'provider_specific',
                subject: fixture.unsupportedReason,
            }],
            measurements: [{ wallMs: performance.now() - caseStart }],
        });
        continue;
    }

    const { registry, analysisByFile } = await buildRegistry(fixture.sources ?? {});
    const result = resolvePythonRelationships({ registry, analysisByFile });
    const claim = (result.claimsByFile.get(fixture.callFile!) ?? []).find((candidate) => (
        candidate.callSpan.startLine === fixture.callLine
        && candidate.proofSteps[0]?.subject === fixture.callee
    ));
    if (!claim) throw new Error('No claim for qualification case ' + item.id);

    const source = claim.sourceInstanceId
        ? registry.symbolsByInstanceId.get(claim.sourceInstanceId)
        : undefined;
    if (!source || source.qualifiedName !== fixture.sourceQualifiedName) {
        throw new Error('Unexpected source identity for qualification case ' + item.id);
    }

    let target: ReturnType<typeof canonicalRef> | undefined;
    if (claim.targetInstanceId) {
        const symbol = registry.symbolsByInstanceId.get(claim.targetInstanceId);
        if (!symbol) throw new Error('Missing target symbol for ' + item.id);
        const entry = Object.entries(fixture.targets ?? {}).find(([, canonical]) => (
            canonical.file === symbol.file && canonical.qualifiedName === symbol.qualifiedName
        ));
        if (!entry) {
            throw new Error('Unmapped target ' + symbol.file + '::' + symbol.qualifiedName + ' for ' + item.id);
        }
        target = canonicalRef(entry[0], entry[1], registry.symbols);
    }

    const alternatives = alternativesFromClaim(fixture, claim, registry.symbols);

    const evidence = neutralEvidenceFromResolutionClaim(claim, { target });
    const unresolvedEvidence = claim.decision === 'resolved'
        ? []
        : evidence.filter((atom) => (
            atom.kind === 'ambiguity'
            || atom.kind === 'candidate_set'
            || atom.kind === 'unresolved_dependency'
        ));

    cases.push({
        caseId: item.id,
        status: 'ok',
        observation: {
            decision: claim.decision,
            relationshipType: claim.relationshipType,
            callSite: {
                file: fixture.callFile,
                span: { ...claim.callSpan },
                text: fixture.callee,
            },
            source: {
                ref: 'caller',
                label: source.qualifiedName,
                file: source.file,
                span: { ...source.span },
            },
            ...(target ? { target } : {}),
            alternatives,
            mechanism: {
                authority: claim.resolutionAuthority,
                strategy: inferResolutionStrategy(claim),
                detail: 'Normalized from ' + claim.providerId + '/' + claim.providerVersion + ' ResolutionClaim proof.',
            },
            evidence,
            unresolvedEvidence,
        },
        measurements: [{
            wallMs: performance.now() - caseStart,
            inputBytes: Buffer.byteLength(Object.values(fixture.sources ?? {}).join('\n')),
            outputBytes: Buffer.byteLength(JSON.stringify(claim)),
        }],
    });
}

const report = {
    version: 1,
    corpusVersion: corpus.version,
    provider: {
        id: NATIVE_PYTHON_PROVIDER_ID,
        version: NATIVE_PYTHON_PROVIDER_VERSION,
        adapterVersion: 'python-native-qualification-v2',
    },
    language: 'python',
    cases,
    runMeasurements: [{ wallMs: performance.now() - runStart }],
};

const output = JSON.stringify(report, null, 2) + '\n';
if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);
}
process.stdout.write(output);
