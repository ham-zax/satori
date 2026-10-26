import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeWithOxc } from '../language-analysis/oxc-adapter';
import { analyzeTypeScriptProject } from '../semantic/typescript-compiler-provider';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/contracts';
import { buildSymbolRecordsForFile, buildSymbolRegistry } from '../symbols/registry';
import { buildTypeScriptResolutionClaims } from './typescript-resolution';
import { isCanonicalResolutionClaim } from './resolution-claim-validation';

const sources = [
    { path: 'targets.ts', source: `
export function primary() { return 1; }
export class Worker { constructor() {} run() { return 1; } }
export class OtherWorker { run() { return 2; } }
export class NominalWorker { private brand = true; run() { return 1; } }
export class BaseWorker { inherited() { return 1; } }
export class DerivedWorker extends BaseWorker {}
export interface WorkerContract { run(): number; }
export function overloaded(value: string): string;
export function overloaded(value: number): string;
export function overloaded(value: string | number): string { return String(value); }
` },
    { path: 'caller.ts', source: `
import { primary as alias, Worker, OtherWorker, NominalWorker, DerivedWorker, WorkerContract, overloaded } from './targets';
export function caller(dynamic: any, value: any) {
    alias();
    const worker: OtherWorker = new Worker();
    worker.run();
    const directWorker = new Worker();
    directWorker.run();
    new Worker().run();
    overloaded(value);
    dynamic.run();
}
export class FieldProof {
    private worker = new NominalWorker();
    run() { return this.worker.run(); }
}
export class ParameterProof {
    constructor(private worker: NominalWorker) {}
    run() { return this.worker.run(); }
}
export class AssignmentProof {
    private worker;
    constructor(worker: NominalWorker) { this.worker = worker; }
    run() { return this.worker.run(); }
}
export class OverwrittenProof {
    private worker;
    constructor(worker: NominalWorker) {
        this.worker = worker;
        this.worker = new NominalWorker();
    }
    run() { return this.worker.run(); }
}
export class UninitializedProof {
    private worker!: NominalWorker;
    run() { return this.worker.run(); }
}
export function optional(worker: NominalWorker | undefined) { return worker?.run(); }
export function inherited() { return new DerivedWorker().inherited(); }
export function contract(worker: WorkerContract) { return worker.run(); }
export function branches(flag: boolean) {
    let worker: Worker;
    if (flag) { worker = new Worker(); } else { worker = new OtherWorker(); }
    return worker.run();
}
export function reassigned() {
    let worker = new Worker();
    worker = new OtherWorker();
    return worker.run();
}
export function closureWrite() {
    let worker = new Worker();
    const mutate = () => { worker = new OtherWorker(); };
    mutate();
    return worker.run();
}
` },
];

function fixture() {
    const sourceFiles = sources.map((file) => ({ ...file, sourceHash: file.path }));
    const evidence = analyzeTypeScriptProject({ language: 'typescript', sourceFiles, auxiliaryFiles: [] });
    const symbols = sources.flatMap((file) => buildSymbolRecordsForFile({
        relativePath: file.path,
        language: 'typescript',
        content: file.source,
        fileHash: file.path,
        extractorVersion: 'test',
        chunks: [],
        extractedSymbols: analyzeWithOxc({
            content: file.source, language: 'typescript', relativePath: file.path,
        }).symbols,
    }));
    const registry = buildSymbolRegistry({
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: '/test', rootFingerprint: 'test', indexPolicyHash: 'test',
            languageRouterVersion: 'test', extractorVersion: 'test', relationshipVersion: 'test',
            builtAt: '2026-10-26T00:00:00.000Z',
            files: sources.map((file) => ({
                path: file.path, hash: file.path, language: 'typescript', symbolCount: 0,
                definitionStatus: 'definitions_present' as const,
            })),
        },
        symbols,
    });
    const convert = (occurrencesByFile = evidence.occurrencesByFile) => buildTypeScriptResolutionClaims({
        registry, environmentConfigId: 'test', providerId: evidence.providerId,
        providerVersion: evidence.providerVersion, occurrencesByFile,
    }).get('caller.ts')!;
    return { evidence, registry, convert };
}

test('compiler binding and allocation proofs survive exact canonical conversion', () => {
    const { evidence, convert } = fixture();
    const calls = evidence.occurrencesByFile.get('caller.ts')!;
    const claims = convert();
    const alias = calls.find((call) => call.calleeText === 'alias')!;
    assert.equal(alias.target?.name, 'primary');
    assert.equal(alias.bindingProofs?.[0].kind, 'relative_import');
    assert.equal(alias.bindingProofs?.[0].subject, 'alias');
    assert.equal(alias.bindingProofs?.[0].detail, './targets');
    const aliasClaim = claims.find((claim) => claim.observation?.calleeText === 'alias')!;
    assert.equal(aliasClaim.resolutionAuthority, 'direct_binding');
    assert.ok(aliasClaim.proofSteps.some((step) => step.kind === 'relative_import'));

    for (const text of ['Worker', 'new Worker().run']) {
        const claim = claims.find((item) => item.observation?.calleeText === text)!;
        assert.equal(claim.decision, 'resolved', text);
        assert.ok(claim.proofSteps.some((step) => step.kind === 'constructor_origin'), text);
    }
    const allocated = claims.find((claim) => claim.observation?.calleeText === 'worker.run')!;
    assert.equal(allocated.resolutionAuthority, 'origin_flow');
    assert.ok(allocated.proofSteps.some((step) => step.kind === 'allocation_origin'));
    const direct = claims.find((claim) => claim.observation?.calleeText === 'directWorker.run')!;
    assert.equal(direct.resolutionAuthority, 'direct_binding');
    assert.ok(direct.proofSteps.some((step) => step.kind === 'constructor_origin'));
    const withoutProof = convert(new Map([['caller.ts', calls.map(({ bindingProofs: _proof, ...call }) => call)]]));
    assert.equal(withoutProof.find((claim) => claim.observation?.calleeText === 'worker.run')?.resolutionAuthority, 'direct_binding');
});

test('ambiguous, dynamic, and unmapped targets retain abstention', () => {
    const { registry, convert } = fixture();
    const claims = convert();
    const overloaded = claims.find((claim) => claim.observation?.calleeText === 'overloaded')!;
    assert.equal(overloaded.decision, 'ambiguous');
    assert.equal(overloaded.targetInstanceId, undefined);
    assert.ok(overloaded.proofSteps.some((step) => step.kind === 'ambiguity'
        && step.subject === 'multiple_overload_candidates'));
    const dynamic = claims.find((claim) => claim.observation?.calleeText === 'dynamic.run')!;
    assert.equal(dynamic.decision, 'unresolved');
    assert.equal(dynamic.resolutionAuthority, 'unresolved');
    assert.equal(dynamic.targetInstanceId, undefined);
    registry.symbolsByFile.set('targets.ts', []);
    const unmapped = convert().find((claim) => claim.observation?.calleeText === 'alias')!;
    assert.equal(unmapped.decision, 'unresolved');
    assert.equal(unmapped.targetInstanceId, undefined);
});

test('compiler proof facts preserve field links, optional calls, inheritance and ambiguous contracts', () => {
    const { registry, convert } = fixture();
    const claims = convert();
    const claimFrom = (owner: string, callee: string) => {
        const claim = claims.find((item) => item.observation?.calleeText === callee
            && registry.symbolsByInstanceId.get(item.sourceInstanceId!)?.qualifiedName === owner);
        assert.ok(claim, owner);
        assert.equal(isCanonicalResolutionClaim(claim), true, owner);
        return claim;
    };
    for (const owner of ['FieldProof.run', 'ParameterProof.run', 'AssignmentProof.run']) {
        const claim = claimFrom(owner, 'this.worker.run');
        assert.equal(claim.resolutionAuthority, 'origin_flow');
        assert.ok(claim.proofSteps.some((step) => step.kind === 'field_origin'));
        assert.ok(claim.proofSteps.some((step) => step.kind === 'constructor_origin'));
    }
    const assignment = claimFrom('AssignmentProof.run', 'this.worker.run');
    assert.equal(assignment.flowHops, 1);
    assert.ok(assignment.proofSteps.some((step) => step.kind === 'assignment_origin'));
    assert.ok(assignment.proofSteps.some((step) => step.kind === 'flow_hop' && step.hop === 1));
    for (const owner of ['OverwrittenProof.run', 'UninitializedProof.run']) {
        const claim = claimFrom(owner, 'this.worker.run');
        assert.equal(claim.resolutionAuthority, 'direct_binding');
        assert.equal(claim.proofSteps.some((step) => step.kind === 'field_origin'), false);
        assert.equal(claim.proofSteps.some((step) => step.kind === 'flow_hop'), false);
    }
    assert.ok(claimFrom('optional', 'worker?.run').proofSteps.some((step) => step.kind === 'optional_receiver'));
    assert.ok(claimFrom('inherited', 'new DerivedWorker().inherited').proofSteps.some((step) => step.kind === 'class_inheritance'));
    const contract = claimFrom('contract', 'worker.run');
    assert.equal(contract.decision, 'ambiguous');
    assert.equal(contract.targetInstanceId, undefined);
    assert.ok(contract.proofSteps.some((step) => step.kind === 'interface_contract'));
    const branch = claimFrom('branches', 'worker.run');
    assert.equal(branch.decision, 'ambiguous');
    assert.equal(branch.targetInstanceId, undefined);
    assert.ok(branch.proofSteps.some((step) => step.kind === 'branch_origin'));
    for (const owner of ['reassigned', 'closureWrite']) {
        const uncertain = claimFrom(owner, 'worker.run');
        assert.equal(uncertain.decision, 'ambiguous');
        assert.equal(uncertain.targetInstanceId, undefined);
        const alternatives = uncertain.proofSteps.filter((step) => step.kind === 'branch_origin');
        assert.equal(alternatives.length, 2);
        assert.ok(alternatives.every((step) => step.detail?.includes('reachability are not established')));
    }
    assert.ok(claimFrom('caller', 'alias').proofSteps.some((step) => step.kind === 'alias_binding'));
});

test('unsupported non-indexable targets retain their unsupported authority', () => {
    const { evidence, convert } = fixture();
    const calls = evidence.occurrencesByFile.get('caller.ts')!;
    const claims = convert(new Map([['caller.ts', calls.map((call) => call.calleeText === 'dynamic.run'
        ? { ...call, reason: 'target_not_indexable' as const } : call)]]));
    const claim = claims.find((item) => item.observation?.calleeText === 'dynamic.run')!;
    assert.equal(claim.decision, 'unresolved');
    assert.equal(claim.resolutionAuthority, 'unsupported');
    assert.equal(isCanonicalResolutionClaim(claim), true);
});
