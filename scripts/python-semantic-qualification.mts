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
    type ResolutionProofStepKind,
} from '../packages/core/src/relationships/resolution.ts';
import type { SourceSpan } from '../packages/core/src/language-analysis/types.ts';

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
    readonly strategy?: string;
    readonly evidenceExtras?: readonly string[];
    readonly alternativeRefs?: readonly string[];
    readonly unsupportedReason?: string;
    readonly unsupportedEvidence?: readonly string[];
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

const PROOF_EVIDENCE = new Map<ResolutionProofStepKind, string>([
    ['call_site', 'call_site'],
    ['containing_caller', 'caller_identity'],
    ['absolute_import', 'direct_symbol_binding'],
    ['relative_import', 'direct_symbol_binding'],
    ['same_file_definition', 'direct_symbol_binding'],
    ['constructor_origin', 'constructor_origin'],
    ['parameter_annotation', 'receiver_type'],
    ['receiver_type_binding', 'receiver_type'],
    ['exact_target_definition', 'direct_symbol_binding'],
    ['allocation_origin', 'assignment_origin'],
    ['field_origin', 'field_origin'],
    ['callback_origin', 'assignment_origin'],
    ['class_inheritance', 'inheritance'],
    ['flow_hop', 'flow_hop'],
    ['candidate_set', 'candidate_set'],
    ['ambiguity', 'ambiguity'],
    ['unresolved_dependency', 'unresolved_dependency'],
]);

function normalizedEvidence(
    fixture: QualificationFixture,
    claim: ResolutionClaim,
    target: ReturnType<typeof canonicalRef> | undefined,
) {
    const evidence: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const push = (
        kind: string,
        subject: string,
        span?: SourceSpan,
        detail?: string,
        file = claim.sourceFile,
    ) => {
        const key = [kind, subject, file, span?.startByte ?? ''].join('\0');
        if (seen.has(key)) return;
        seen.add(key);
        evidence.push({
            kind,
            subject,
            ...(detail ? { detail } : {}),
            ...(span ? { file, span: { ...span } } : {}),
        });
    };

    for (const step of claim.proofSteps) {
        const kind = PROOF_EVIDENCE.get(step.kind);
        if (kind) push(kind, step.subject, step.span, step.detail);
    }
    for (const kind of fixture.evidenceExtras ?? []) {
        if (kind === 'alias_binding') {
            push(kind, (fixture.callee ?? 'alias') + ' -> ' + (target?.label ?? claim.targetSymbol ?? 'target'));
        } else if (kind === 'target_provenance' && target) {
            push(kind, target.label, target.span as SourceSpan, undefined, target.file);
        } else if (kind === 'receiver_type') {
            push(kind, claim.proofSteps.find((step) => (
                step.kind === 'parameter_annotation' || step.kind === 'constructor_origin'
            ))?.subject ?? fixture.caseId);
        } else if (kind === 'branch_origin') {
            push(kind, 'multiple non-dominating assignment origins');
        } else if (kind === 'interface_contract') {
            push(kind, 'Runner protocol receiver');
        } else if (kind === 'dynamic_construct') {
            push(kind, 'getattr-derived callable');
        } else if (kind === 'assignment_origin') {
            push(kind, 'constructor parameter assigned to instance field');
        } else {
            push(kind, fixture.caseId);
        }
    }
    if (target) {
        push('target_provenance', target.label, target.span as SourceSpan, undefined, target.file);
    }
    return evidence;
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
        strategy: 'direct_call',
        evidenceExtras: ['target_provenance'],
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
        strategy: 'type_dispatch',
        evidenceExtras: ['receiver_type', 'target_provenance'],
    },
    {
        caseId: 'constructor_parameter_property',
        unsupportedReason: 'Python has no constructor-parameter-property syntax that simultaneously declares and initializes an instance field.',
        unsupportedEvidence: ['constructor_origin', 'field_origin', 'receiver_type'],
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
        strategy: 'type_dispatch',
        evidenceExtras: ['assignment_origin', 'receiver_type', 'target_provenance'],
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
        strategy: 'direct_call',
        evidenceExtras: ['alias_binding', 'target_provenance'],
    },
    {
        caseId: 'optional_receiver',
        unsupportedReason: 'Python native v2 intentionally does not interpret Optional/union narrowing as exact receiver identity.',
        unsupportedEvidence: ['optional_receiver', 'unresolved_dependency'],
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
        strategy: 'type_dispatch',
        evidenceExtras: ['receiver_type', 'target_provenance'],
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
        alternativeRefs: ['target.impl_a', 'target.impl_b'],
        strategy: 'interface_dispatch',
        evidenceExtras: ['receiver_type', 'interface_contract'],
    },
    {
        caseId: 'overload_ambiguity',
        unsupportedReason: 'Python runtime functions do not provide static overload dispatch identity equivalent to compiler overload resolution.',
        unsupportedEvidence: ['overload_candidate', 'unresolved_dependency'],
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
        alternativeRefs: ['target.branch_a', 'target.branch_b'],
        strategy: 'type_dispatch',
        evidenceExtras: ['branch_origin'],
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
        strategy: 'dynamic_dispatch',
        evidenceExtras: ['dynamic_construct'],
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
        strategy: 'direct_call',
        evidenceExtras: ['target_provenance'],
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
            unsupportedEvidence: (fixture.unsupportedEvidence ?? []).map((kind) => ({
                kind,
                subject: item.id,
            })),
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

    const candidateNames = new Set(
        claim.proofSteps
            .filter((step) => step.kind === 'candidate_set')
            .flatMap((step) => step.subject.split('|')),
    );
    const alternatives = (fixture.alternativeRefs ?? [])
        .filter((ref) => {
            const canonical = fixture.targets?.[ref];
            return canonical ? candidateNames.has(canonical.qualifiedName) : false;
        })
        .map((ref) => {
            const canonical = fixture.targets?.[ref];
            if (!canonical) throw new Error('Missing alternative target ' + ref + ' for ' + item.id);
            return canonicalRef(ref, canonical, registry.symbols);
        });

    const evidence = normalizedEvidence(fixture, claim, target);
    const unresolvedEvidence = claim.decision === 'resolved'
        ? []
        : evidence.filter((atom) => (
            atom.kind === 'ambiguity'
            || atom.kind === 'candidate_set'
            || atom.kind === 'unresolved_dependency'
            || atom.kind === 'branch_origin'
            || atom.kind === 'dynamic_construct'
            || atom.kind === 'interface_contract'
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
                strategy: fixture.strategy ?? 'unknown',
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
        adapterVersion: 'python-native-qualification-v1',
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
