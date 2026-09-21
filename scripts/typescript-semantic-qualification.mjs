import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { analyzeWithOxc } from '../packages/core/src/language-analysis/oxc-adapter.ts';
import { buildTypeScriptResolutionClaims } from '../packages/core/src/relationships/typescript-resolution.ts';
import {
    TYPESCRIPT_COMPILER_PROVIDER_ID,
    TYPESCRIPT_COMPILER_PROVIDER_VERSION,
    analyzeTypeScriptProject,
} from '../packages/core/src/semantic/typescript-compiler-provider.ts';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../packages/core/src/symbols/contracts.ts';
import { buildSymbolRecordsForFile, buildSymbolRegistry } from '../packages/core/src/symbols/registry.ts';
import {
    inferResolutionStrategy,
    mapExactCanonicalTarget,
    neutralEvidenceFromResolutionClaim,
} from './semantic-qualification-adapter-helpers.mjs';
import {
    TYPESCRIPT_PRODUCTION_QUALIFICATION_CASE_IDS,
    runTypeScriptProductionQualificationCase,
} from './typescript-production-qualification-support.mts';

const ADAPTER_VERSION = 'typescript-qualification-v2';

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

export interface SingleContract {
    singleOnly(): string;
}

export class SingleImpl implements SingleContract {
    singleOnly(): string { return 'single'; }
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
    type SingleContract,
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

export function structuralDecoyCase(): string {
    const initialized: StructuralA = new StructuralB();
    return initialized.request();
}

export function mutableReassignmentCase(): string {
    let reassigned: StructuralA = new StructuralA();
    reassigned = new StructuralB();
    return reassigned.request();
}

export function nestedWriteCase(): string {
    let nestedBlock: StructuralA = new StructuralA();
    {
        nestedBlock = new StructuralB();
    }
    return nestedBlock.request();
}

export function loopWriteCase(): string {
    let loopWrite: StructuralA = new StructuralA();
    for (let index = 0; index < 1; index += 1) {
        loopWrite = new StructuralB();
    }
    return loopWrite.request();
}

export function closureWriteCase(): string {
    let closureWrite: StructuralA = new StructuralA();
    function mutate(): void {
        closureWrite = new StructuralB();
    }
    mutate();
    return closureWrite.request();
}

export function openWorldSingleInterfaceCase(worker: SingleContract): string {
    return worker.singleOnly();
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
        targetRefs: { directPrimary: 'target.primary' },
    },
    class_field_receiver: {
        calleeText: 'this.worker.request',
        caller: 'ClassFieldCase.run',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
    },
    constructor_parameter_property: {
        calleeText: 'this.worker.request',
        caller: 'ConstructorParameterPropertyCase.run',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
    },
    constructor_assignment_origin: {
        calleeText: 'this.worker.request',
        caller: 'ConstructorAssignmentCase.run',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
    },
    alias_binding: {
        calleeText: 'aliasedPrimary',
        caller: 'aliasBindingCase',
        targetRefs: { directPrimary: 'target.primary' },
    },
    optional_receiver: {
        calleeText: 'worker?.request',
        caller: 'optionalReceiverCase',
        targetRefs: { 'PrimaryWorker.request': 'target.primary' },
    },
    inheritance_dispatch: {
        calleeText: 'new DerivedWorker().inherited',
        caller: 'inheritanceDispatchCase',
        targetRefs: { 'BaseWorker.inherited': 'target.base' },
    },
    interface_dispatch: {
        calleeText: 'worker.dispatch',
        caller: 'interfaceDispatchCase',
        targetRefs: {
            'ImplA.dispatch': 'target.impl_a',
            'ImplB.dispatch': 'target.impl_b',
        },
    },
    overload_ambiguity: {
        calleeText: 'overloaded',
        caller: 'overloadAmbiguityCase',
        targetRefs: {},
        targetSpanRefs: [
            {
                ref: 'target.overload_a',
                file: 'fixture/targets.ts',
                qualifiedName: 'overloaded',
                startLine: 52,
            },
            {
                ref: 'target.overload_b',
                file: 'fixture/targets.ts',
                qualifiedName: 'overloaded',
                startLine: 53,
            },
        ],
    },
    branch_conflicted_origins: {
        calleeText: 'worker.request',
        caller: 'branchConflictedOriginsCase',
        targetRefs: {
            'StructuralA.request': 'target.branch_a',
            'StructuralB.request': 'target.branch_b',
        },
    },
    dynamic_unresolved: {
        calleeText: 'value.request',
        caller: 'dynamicUnresolvedCase',
        targetRefs: {},
    },
    wrong_target_decoy: {
        calleeText: 'worker.request',
        caller: 'wrongTargetDecoyCase',
        targetRefs: {
            'PrimaryWorker.request': 'target.primary',
            'DecoyWorkerA.request': 'target.decoy_a',
            'DecoyWorkerB.request': 'target.decoy_b',
        },
    },
    'typescript.structural_decoy': {
        calleeText: 'initialized.request',
        caller: 'structuralDecoyCase',
        targetRefs: {
            'StructuralB.request': 'target.primary',
            'StructuralA.request': 'target.decoy',
        },
    },
    'typescript.mutable_reassignment': {
        calleeText: 'reassigned.request',
        caller: 'mutableReassignmentCase',
        targetRefs: {
            'StructuralA.request': 'target.a',
            'StructuralB.request': 'target.b',
        },
    },
    'typescript.nested_write': {
        calleeText: 'nestedBlock.request',
        caller: 'nestedWriteCase',
        targetRefs: {
            'StructuralA.request': 'target.a',
            'StructuralB.request': 'target.b',
        },
    },
    'typescript.loop_write': {
        calleeText: 'loopWrite.request',
        caller: 'loopWriteCase',
        targetRefs: {
            'StructuralA.request': 'target.a',
            'StructuralB.request': 'target.b',
        },
    },
    'typescript.closure_write': {
        calleeText: 'closureWrite.request',
        caller: 'closureWriteCase',
        targetRefs: {
            'StructuralA.request': 'target.a',
            'StructuralB.request': 'target.b',
        },
    },
    'typescript.open_world_single_interface': {
        calleeText: 'worker.singleOnly',
        caller: 'openWorldSingleInterfaceCase',
        targetRefs: {
            'SingleImpl.singleOnly': 'target.impl',
        },
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

function symbolAsProviderTarget(symbol) {
    const ownerName = symbol.parentQualifiedNamePath?.at(-1);
    return {
        file: symbol.file,
        span: { ...symbol.span },
        name: symbol.name,
        ...(ownerName ? { ownerName } : {}),
    };
}

function buildFixtureRegistry() {
    const symbols = [];
    const files = [];
    for (const fixture of fixtureFiles) {
        const structural = analyzeWithOxc({
            content: fixture.source,
            language: 'typescript',
            relativePath: fixture.path,
        });
        if (!structural.complete) {
            throw new Error(`OXC failed to parse qualification fixture: ${fixture.path}`);
        }
        const fileSymbols = buildSymbolRecordsForFile({
            relativePath: fixture.path,
            language: 'typescript',
            content: fixture.source,
            fileHash: fixture.sourceHash,
            extractorVersion: ADAPTER_VERSION,
            chunks: [],
            extractedSymbols: structural.symbols,
        });
        symbols.push(...fileSymbols);
        files.push({
            path: fixture.path,
            hash: fixture.sourceHash,
            language: 'typescript',
            symbolCount: fileSymbols.length,
            definitionStatus: 'definitions_present',
        });
    }
    return buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: '/typescript-qualification',
            rootFingerprint: 'typescript-qualification-root',
            indexPolicyHash: 'typescript-qualification-policy',
            languageRouterVersion: 'typescript-qualification-router',
            extractorVersion: ADAPTER_VERSION,
            relationshipVersion: ADAPTER_VERSION,
            builtAt: '2026-09-21T00:00:00.000Z',
            files,
        },
        symbols,
    });
}

function canonicalTargetsForSpec(spec, registry) {
    const canonicalTargets = [];
    for (const [qualifiedName, ref] of Object.entries(spec.targetRefs ?? {})) {
        const matches = registry.symbols.filter((symbol) => (
            symbol.file === 'fixture/targets.ts'
            && symbol.qualifiedName === qualifiedName
        ));
        if (matches.length !== 1) {
            throw new Error(`Expected one canonical target ${qualifiedName}, saw ${matches.length}`);
        }
        canonicalTargets.push({
            ref,
            ...symbolAsProviderTarget(matches[0]),
        });
    }
    for (const selector of spec.targetSpanRefs ?? []) {
        const matches = registry.symbols.filter((symbol) => (
            symbol.file === selector.file
            && symbol.qualifiedName === selector.qualifiedName
            && symbol.span.startLine === selector.startLine
        ));
        if (matches.length !== 1) {
            throw new Error(
                `Expected one canonical target ${selector.ref} at ${selector.file}:${selector.startLine}, saw ${matches.length}`,
            );
        }
        canonicalTargets.push({
            ref: selector.ref,
            ...symbolAsProviderTarget(matches[0]),
        });
    }
    return canonicalTargets;
}

function sameProviderTarget(left, right) {
    return left.file === right.file
        && left.name === right.name
        && (left.ownerName ?? undefined) === (right.ownerName ?? undefined)
        && left.span.startByte === right.span.startByte
        && left.span.endByte === right.span.endByte;
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

function claimForOccurrence(claimsByFile, occurrence) {
    const matches = (claimsByFile.get(occurrence.sourceFile) ?? []).filter((claim) => (
        claim.callSpan.startByte === occurrence.callSpan.startByte
        && claim.callSpan.endByte === occurrence.callSpan.endByte
        && claim.proofSteps[0]?.subject === occurrence.calleeText
    ));
    if (matches.length !== 1) {
        throw new Error(
            `Expected one ResolutionClaim for ${occurrence.sourceFile}:${occurrence.callSpan.startLine}, saw ${matches.length}`,
        );
    }
    return matches[0];
}

function observationFor(occurrence, spec, claim, registry) {
    const source = claim.sourceInstanceId
        ? registry.symbolsByInstanceId.get(claim.sourceInstanceId)
        : undefined;
    if (!source || source.qualifiedName !== spec.caller) {
        throw new Error(`Unexpected source identity for ${spec.caller}`);
    }

    const canonicalTargets = canonicalTargetsForSpec(spec, registry);
    let target;
    let providerTarget;
    if (claim.targetInstanceId) {
        const targetSymbol = registry.symbolsByInstanceId.get(claim.targetInstanceId);
        if (!targetSymbol) {
            throw new Error(`Missing claimed target instance for ${spec.caller}`);
        }
        providerTarget = symbolAsProviderTarget(targetSymbol);
        target = mapExactCanonicalTarget(providerTarget, canonicalTargets);
    }

    const alternatives = (occurrence.candidates ?? [])
        .filter((candidate) => !providerTarget || !sameProviderTarget(candidate, providerTarget))
        .map((candidate) => mapExactCanonicalTarget(candidate, canonicalTargets));

    const evidence = neutralEvidenceFromResolutionClaim(claim, { target });
    const unresolvedEvidence = claim.decision === 'resolved'
        ? []
        : evidence.filter((atom) => (
            atom.kind === 'candidate_set'
            || atom.kind === 'ambiguity'
            || atom.kind === 'unresolved_dependency'
        ));

    return {
        decision: claim.decision,
        relationshipType: claim.relationshipType,
        callSite: {
            file: occurrence.sourceFile,
            span: { ...claim.callSpan },
            text: `${occurrence.calleeText}()`,
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
            strategy: inferResolutionStrategy(claim, { reason: occurrence.reason }),
            detail: `Normalized from ${claim.providerId}/${claim.providerVersion} ResolutionClaim and compiler reason '${occurrence.reason}'.`,
        },
        evidence,
        unresolvedEvidence,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(usage());
        return;
    }

    const corpus = JSON.parse(fs.readFileSync(options.corpus, 'utf8'));
    const corpusIds = corpus.cases.map((item) => item.id);
    const productionCaseIds = new Set(TYPESCRIPT_PRODUCTION_QUALIFICATION_CASE_IDS);
    const unknown = corpusIds.filter((caseId) => !caseSpecs[caseId] && !productionCaseIds.has(caseId));
    if (unknown.length > 0) {
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

    const registry = buildFixtureRegistry();
    const claimsByFile = buildTypeScriptResolutionClaims({
        registry,
        environmentConfigId: ADAPTER_VERSION,
        providerId: providerEvidence.providerId,
        providerVersion: providerEvidence.providerVersion,
        occurrencesByFile: providerEvidence.occurrencesByFile,
    });
    const occurrences = providerEvidence.occurrencesByFile.get('fixture/cases.ts') ?? [];
    const callers = callableSymbols(casesSource, 'fixture/cases.ts');
    const cases = [];

    for (const caseId of corpusIds) {
        if (productionCaseIds.has(caseId)) {
            try {
                const result = await runTypeScriptProductionQualificationCase(caseId);
                cases.push({
                    caseId,
                    status: 'ok',
                    observation: result.observation,
                    measurements: [result.measurement],
                });
            } catch (error) {
                cases.push({
                    caseId,
                    status: 'error',
                    error: error instanceof Error ? error.message : String(error),
                    measurements: [],
                });
            }
            continue;
        }
        const spec = caseSpecs[caseId];
        try {
            const occurrence = occurrenceForCase(occurrences, spec, callers);
            const claim = claimForOccurrence(claimsByFile, occurrence);

            cases.push({
                caseId,
                status: 'ok',
                observation: observationFor(occurrence, spec, claim, registry),
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

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
});
