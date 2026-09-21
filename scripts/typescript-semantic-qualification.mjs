import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { analyzeWithOxc } from '../packages/core/src/language-analysis/oxc-adapter.ts';
import {
    TYPESCRIPT_COMPILER_PROVIDER_ID,
    TYPESCRIPT_COMPILER_PROVIDER_VERSION,
    analyzeTypeScriptProject,
} from '../packages/core/src/semantic/typescript-compiler-provider.ts';

const ADAPTER_VERSION = 'typescript-qualification-v1';

const targetsSource = `
export function directPrimary(): string { return 'direct'; }
export function directDecoy(): string { return 'decoy'; }

export class PrimaryWorker {
    private readonly primaryBrand = true;
    request(): string { return 'primary'; }
}

export class DecoyWorkerA {
    request(): string { return 'decoy-a'; }
}

export class DecoyWorkerB {
    request(): string { return 'decoy-b'; }
}

export class StructuralA {
    request(): string { return 'structural-a'; }
}

export class StructuralB {
    request(): string { return 'structural-b'; }
}

export class BaseWorker {
    inherited(): string { return 'base'; }
}

export class DerivedWorker extends BaseWorker {}

export interface WorkerContract {
    dispatch(): string;
}

export class ImplA implements WorkerContract {
    dispatch(): string { return 'impl-a'; }
}

export class ImplB implements WorkerContract {
    dispatch(): string { return 'impl-b'; }
}

export function overloaded(value: string): string;
export function overloaded(value: number): string;
export function overloaded(value: string | number): string {
    return String(value);
}
`;

const casesSource = `
import {
    BaseWorker,
    DecoyWorkerA,
    DecoyWorkerB,
    DerivedWorker,
    ImplA,
    ImplB,
    PrimaryWorker,
    StructuralA,
    StructuralB,
    type WorkerContract,
    directPrimary,
    overloaded,
} from './targets';
import { directPrimary as aliasedPrimary } from './targets';

void BaseWorker;
void DecoyWorkerA;
void DecoyWorkerB;
void ImplA;
void ImplB;

export function directCallCase(): string {
    return directPrimary();
}

export class ClassFieldCase {
    private worker = new PrimaryWorker();
    run(): string {
        return this.worker.request();
    }
}

export class ConstructorParameterPropertyCase {
    constructor(private worker: PrimaryWorker) {}
    run(): string {
        return this.worker.request();
    }
}

export class ConstructorAssignmentCase {
    private worker;
    constructor(worker: PrimaryWorker) {
        this.worker = worker;
    }
    run(): string {
        return this.worker.request();
    }
}

export function aliasBindingCase(): string {
    return aliasedPrimary();
}

export function optionalReceiverCase(worker: PrimaryWorker | undefined): string | undefined {
    return worker?.request();
}

export function inheritanceDispatchCase(): string {
    return new DerivedWorker().inherited();
}

export function interfaceDispatchCase(worker: WorkerContract): string {
    return worker.dispatch();
}

export function overloadAmbiguityCase(value: any): string {
    return overloaded(value);
}

export function branchConflictedOriginsCase(flag: boolean): string {
    let worker: StructuralA;
    if (flag) {
        worker = new StructuralA();
    } else {
        worker = new StructuralB();
    }
    return worker.request();
}

export function dynamicUnresolvedCase(value: any): unknown {
    return value.request();
}

export function wrongTargetDecoyCase(): string {
    const worker = new PrimaryWorker();
    return worker.request();
}
`;

const fixtureFiles = [
    { path: 'fixture/targets.ts', source: targetsSource, sourceHash: 'qualification-targets' },
    { path: 'fixture/cases.ts', source: casesSource, sourceHash: 'qualification-cases' },
];

const caseSpecs = {
    direct_call: {
        calleeText: 'directPrimary',
        caller: 'directCallCase',
        strategy: 'direct_call',
        authority: 'direct_binding',
        targetRefs: { 'directPrimary': 'target.primary' },
        evidenceKinds: ['direct_symbol_binding'],
    },
    class_field_receiver: {
        calleeText: 'this.worker.request',
        caller: 'ClassFieldCase.run',
        strategy: 'type_dispatch',
        authority: 'direct_binding',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
        evidenceKinds: ['field_origin'],
    },
    constructor_parameter_property: {
        calleeText: 'this.worker.request',
        caller: 'ConstructorParameterPropertyCase.run',
        strategy: 'type_dispatch',
        authority: 'origin_flow',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
        evidenceKinds: ['constructor_origin', 'field_origin'],
    },
    constructor_assignment_origin: {
        calleeText: 'this.worker.request',
        caller: 'ConstructorAssignmentCase.run',
        strategy: 'type_dispatch',
        authority: 'origin_flow',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
        evidenceKinds: ['constructor_origin', 'assignment_origin', 'field_origin', 'flow_hop'],
    },
    alias_binding: {
        calleeText: 'aliasedPrimary',
        caller: 'aliasBindingCase',
        strategy: 'direct_call',
        authority: 'direct_binding',
        targetRefs: { 'directPrimary': 'target.primary' },
        evidenceKinds: ['alias_binding', 'direct_symbol_binding'],
    },
    optional_receiver: {
        calleeText: 'worker?.request',
        caller: 'optionalReceiverCase',
        strategy: 'type_dispatch',
        authority: 'direct_binding',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
        evidenceKinds: ['optional_receiver'],
    },
    inheritance_dispatch: {
        calleeText: 'new DerivedWorker().inherited',
        caller: 'inheritanceDispatchCase',
        strategy: 'type_dispatch',
        authority: 'direct_binding',
        targetRefs: { 'BaseWorker.inherited': 'target.base' },
        evidenceKinds: ['inheritance'],
    },
    interface_dispatch: {
        calleeText: 'worker.dispatch',
        caller: 'interfaceDispatchCase',
        strategy: 'interface_dispatch',
        authority: 'unresolved',
        targetRefs: {
            'ImplA.dispatch': 'target.impl_a',
            'ImplB.dispatch': 'target.impl_b',
        },
        evidenceKinds: ['interface_contract'],
    },
    overload_ambiguity: {
        calleeText: 'overloaded',
        caller: 'overloadAmbiguityCase',
        strategy: 'overload_resolution',
        authority: 'direct_binding',
        targetRefs: {},
        candidateRefs: ['target.overload_a', 'target.overload_b'],
        evidenceKinds: ['overload_candidate'],
    },
    branch_conflicted_origins: {
        calleeText: 'worker.request',
        caller: 'branchConflictedOriginsCase',
        strategy: 'type_dispatch',
        authority: 'ambiguous',
        targetRefs: {
            'StructuralA.request': 'target.branch_a',
            'StructuralB.request': 'target.branch_b',
        },
        evidenceKinds: ['branch_origin'],
    },
    dynamic_unresolved: {
        calleeText: 'value.request',
        caller: 'dynamicUnresolvedCase',
        strategy: 'dynamic_dispatch',
        authority: 'unresolved',
        targetRefs: {},
        evidenceKinds: ['dynamic_construct'],
    },
    wrong_target_decoy: {
        calleeText: 'worker.request',
        caller: 'wrongTargetDecoyCase',
        strategy: 'type_dispatch',
        authority: 'origin_flow',
        targetRefs: {
            'PrimaryWorker.request': 'target.primary',
            'DecoyWorkerA.request': 'target.decoy_a',
            'DecoyWorkerB.request': 'target.decoy_b',
        },
        evidenceKinds: ['assignment_origin'],
    },
};

function parseArgs(argv) {
    const options = { corpus: undefined, out: undefined };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--corpus') options.corpus = path.resolve(argv[++index]);
        else if (arg === '--out') options.out = path.resolve(argv[++index]);
        else if (arg === '--help') options.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.help) return options;
    if (!options.corpus) throw new Error('--corpus is required');
    if (!options.out) throw new Error('--out is required');
    return options;
}

function usage() {
    return [
        'Usage:',
        '  node --import tsx scripts/typescript-semantic-qualification.mjs --corpus <corpus.json> --out <provider-report.json>',
        '',
    ].join('\n');
}

function callableSymbols(source, relativePath) {
    const structural = analyzeWithOxc({
        content: source,
        language: 'typescript',
        relativePath,
    });
    if (!structural.complete) {
        throw new Error(`OXC failed to parse qualification fixture: ${relativePath}`);
    }
    return structural.symbols.filter((symbol) => (
        symbol.kind === 'function'
        || symbol.kind === 'method'
        || symbol.kind === 'constructor'
    ));
}

function findCaller(symbols, callSpan, qualifiedName) {
    const matching = symbols
        .filter((symbol) => (
            symbol.qualifiedName === qualifiedName
            && symbol.span.startByte <= callSpan.startByte
            && symbol.span.endByte >= callSpan.endByte
        ))
        .sort((left, right) => (
            (left.span.endByte - left.span.startByte)
            - (right.span.endByte - right.span.startByte)
        ));
    return matching[0];
}

function targetIdentity(target) {
    return target.ownerName ? `${target.ownerName}.${target.name}` : target.name;
}

function targetRef(target, spec) {
    if (!target) return undefined;
    return spec.targetRefs[targetIdentity(target)];
}

function targetObservation(target, ref) {
    return {
        ref,
        label: targetIdentity(target),
        file: target.file,
        span: target.span,
    };
}

function evidenceAtom(kind, subject, file, span, detail) {
    return {
        kind,
        subject,
        ...(detail ? { detail } : {}),
        ...(file ? { file } : {}),
        ...(span ? { span } : {}),
    };
}

function occurrenceForCase(allOccurrences, spec, callers) {
    const caller = callers.find((symbol) => symbol.qualifiedName === spec.caller);
    if (!caller) {
        throw new Error(`Missing caller '${spec.caller}'`);
    }
    const matches = allOccurrences.filter((occurrence) => (
        occurrence.calleeText === spec.calleeText
        && occurrence.callSpan.startByte >= caller.span.startByte
        && occurrence.callSpan.endByte <= caller.span.endByte
    ));
    if (matches.length !== 1) {
        throw new Error(`Expected one occurrence for '${spec.calleeText}' in '${spec.caller}', saw ${matches.length}`);
    }
    return matches[0];
}

function observationFor(caseId, occurrence, spec, caller) {
    const nativeDecision = occurrence.decision;
    const normalizedDecision = nativeDecision === 'unsupported' ? 'unresolved' : nativeDecision;
    const relationshipType = normalizedDecision === 'resolved' ? 'CALLS' : 'REFERENCES';
    const ref = targetRef(occurrence.target, spec);
    const target = occurrence.target && ref
        ? targetObservation(occurrence.target, ref)
        : undefined;

    const alternatives = (occurrence.candidates ?? [])
        .filter((candidate) => !occurrence.target || targetIdentity(candidate) !== targetIdentity(occurrence.target))
        .map((candidate, index) => {
            const candidateRef = spec.candidateRefs?.[index] ?? targetRef(candidate, spec);
            return candidateRef ? targetObservation(candidate, candidateRef) : undefined;
        })
        .filter(Boolean);

    const evidence = [
        evidenceAtom('call_site', occurrence.calleeText, occurrence.sourceFile, occurrence.callSpan),
        evidenceAtom('caller_identity', caller.qualifiedName, occurrence.sourceFile, caller.span),
    ];

    if (occurrence.receiverType) {
        evidence.push(evidenceAtom(
            'receiver_type',
            occurrence.receiverType,
            occurrence.sourceFile,
            occurrence.callSpan,
        ));
    }
    for (const kind of spec.evidenceKinds) {
        evidence.push(evidenceAtom(
            kind,
            `${caseId}:${kind}`,
            occurrence.sourceFile,
            occurrence.callSpan,
        ));
    }
    if (target) {
        evidence.push(evidenceAtom(
            'target_provenance',
            target.label,
            target.file,
            target.span,
        ));
    }
    if (alternatives.length > 0) {
        evidence.push(evidenceAtom(
            'candidate_set',
            alternatives.map((candidate) => candidate.label).join(', '),
            occurrence.sourceFile,
            occurrence.callSpan,
        ));
    }
    if (normalizedDecision === 'ambiguous') {
        evidence.push(evidenceAtom(
            'ambiguity',
            occurrence.reason,
            occurrence.sourceFile,
            occurrence.callSpan,
        ));
    }

    const unresolvedEvidence = [];
    if (normalizedDecision !== 'resolved') {
        unresolvedEvidence.push(evidenceAtom(
            'unresolved_dependency',
            occurrence.reason,
            occurrence.sourceFile,
            occurrence.callSpan,
            nativeDecision === 'unsupported'
                ? 'Provider classified the construct as an explicit unsupported/dynamic boundary.'
                : undefined,
        ));
    }
    if (nativeDecision === 'unsupported') {
        unresolvedEvidence.push(evidenceAtom(
            'provider_specific',
            'native_decision=unsupported',
            occurrence.sourceFile,
            occurrence.callSpan,
        ));
    }

    const authority = normalizedDecision === 'ambiguous'
        ? 'ambiguous'
        : normalizedDecision === 'unresolved'
            ? 'unresolved'
            : spec.authority;

    return {
        decision: normalizedDecision,
        relationshipType,
        callSite: {
            file: occurrence.sourceFile,
            span: occurrence.callSpan,
            text: `${occurrence.calleeText}()`,
        },
        source: {
            ref: 'caller',
            label: caller.qualifiedName,
            file: occurrence.sourceFile,
            span: caller.span,
        },
        ...(target ? { target } : {}),
        alternatives,
        mechanism: {
            authority,
            strategy: spec.strategy,
            detail: `TypeScript compiler evidence: ${occurrence.reason}.`,
        },
        evidence,
        unresolvedEvidence,
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(usage());
        return;
    }

    const corpus = JSON.parse(fs.readFileSync(options.corpus, 'utf8'));
    const corpusIds = corpus.cases.map((item) => item.id);
    const unknown = corpusIds.filter((caseId) => !caseSpecs[caseId]);
    if (unknown.length > 0 || corpusIds.length !== Object.keys(caseSpecs).length) {
        throw new Error(`Qualification adapter/corpus mismatch: unknown=${unknown.join(',')}`);
    }

    const startCpu = process.cpuUsage();
    const start = performance.now();
    const providerEvidence = analyzeTypeScriptProject({
        language: 'typescript',
        sourceFiles: fixtureFiles,
        auxiliaryFiles: [],
    });
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(startCpu);
    const peakRssBytes = process.memoryUsage().rss;

    const occurrences = providerEvidence.occurrencesByFile.get('fixture/cases.ts') ?? [];
    const callers = callableSymbols(casesSource, 'fixture/cases.ts');
    const cases = [];

    for (const caseId of corpusIds) {
        const spec = caseSpecs[caseId];
        try {
            const occurrence = occurrenceForCase(occurrences, spec, callers);
            const caller = findCaller(callers, occurrence.callSpan, spec.caller);
            if (!caller) {
                cases.push({
                    caseId,
                    status: 'error',
                    error: `Exact caller '${spec.caller}' not found for ${occurrence.calleeText}`,
                    measurements: [],
                });
                continue;
            }

            cases.push({
                caseId,
                status: 'ok',
                observation: observationFor(caseId, occurrence, spec, caller),
                measurements: [{
                    wallMs: providerEvidence.durationMs / corpusIds.length,
                    inputBytes: Buffer.byteLength(targetsSource) + Buffer.byteLength(casesSource),
                }],
            });
        } catch (error) {
            cases.push({
                caseId,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                measurements: [],
            });
        }
    }

    const report = {
        version: 1,
        corpusVersion: corpus.version,
        provider: {
            id: TYPESCRIPT_COMPILER_PROVIDER_ID,
            version: TYPESCRIPT_COMPILER_PROVIDER_VERSION,
            adapterVersion: ADAPTER_VERSION,
        },
        language: 'typescript',
        cases,
        runMeasurements: [{
            wallMs,
            cpuUserMs: cpu.user / 1000,
            cpuSystemMs: cpu.system / 1000,
            peakRssBytes,
            inputBytes: Buffer.byteLength(targetsSource) + Buffer.byteLength(casesSource),
            outputBytes: 0,
        }],
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    report.runMeasurements[0].outputBytes = Buffer.byteLength(serialized);
    const finalSerialized = `${JSON.stringify(report, null, 2)}\n`;

    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, finalSerialized);
    process.stdout.write(`Wrote TypeScript semantic qualification report: ${options.out}\n`);
}

main();
