import assert from 'node:assert/strict';
import test from 'node:test';

import type { SemanticProjectInput } from './contracts';
import {
    analyzeTypeScriptProject,
    type TypeScriptCallEvidence,
} from './typescript-compiler-provider';

const targets = `
export class StructuralA {
    request(): string { return 'a'; }
    structuralOnly(): void {}
}

export class StructuralB {
    request(): string { return 'b'; }
    structuralOnly(): void {}
}

export class ProjectWideDecoyA {
    request(): string { return 'decoy-a'; }
    structuralOnly(): void {}
}

export class ProjectWideDecoyB {
    request(): string { return 'decoy-b'; }
    structuralOnly(): void {}
}

export interface Contract {
    request(): string;
}

export interface SingleContract {
    request(): string;
    unique(): void;
}

export class SingleImpl implements SingleContract {
    request(): string { return 'single'; }
    unique(): void {}
}
`;

const cases = `
import {
    ProjectWideDecoyA,
    StructuralA,
    StructuralB,
    type Contract,
    type SingleContract,
} from './targets';

export function localOrigins(flag: boolean): void {
    const initialized: StructuralA = new StructuralB();
    initialized.request();

    const alias1 = initialized;
    const alias2 = alias1;
    alias2.request();

    let reassigned: StructuralA = new StructuralA();
    reassigned = new StructuralB();
    reassigned.request();

    let conflicted: StructuralA;
    if (flag) {
        conflicted = new StructuralA();
    } else {
        conflicted = new StructuralB();
    }
    conflicted.request();

    let nestedBlock: StructuralA = new StructuralA();
    {
        nestedBlock = new StructuralB();
    }
    nestedBlock.request();

    let loopWrite: StructuralA = new StructuralA();
    for (const ignored of [1]) {
        void ignored;
        loopWrite = new StructuralB();
    }
    loopWrite.request();

    let closureWrite: StructuralA = new StructuralA();
    (() => {
        closureWrite = new StructuralB();
    })();
    closureWrite.request();

    let destructuredWrite: StructuralA = new StructuralA();
    [destructuredWrite] = [new StructuralB()];
    destructuredWrite.request();

    const holder: { worker: StructuralA } = { worker: new StructuralB() };
    holder.worker.request();

    const destructureSource: { worker: StructuralA } = { worker: new StructuralB() };
    const { worker: destructured } = destructureSource;
    destructured.request();
}

export function wrappedEvalWriteCase(): string {
    let wrappedEvalWrite: StructuralA = new StructuralA();
    wrappedEvalWrite = new StructuralB();
    ((eval as typeof eval)!)("wrappedEvalWrite = new ProjectWideDecoyA()");
    void ProjectWideDecoyA;
    return wrappedEvalWrite.request();
}

export function optionalEvalWriteCase(): string {
    let optionalEvalWrite: StructuralA = new StructuralA();
    optionalEvalWrite = new StructuralB();
    eval?.("optionalEvalWrite = new ProjectWideDecoyA()");
    ((eval as typeof eval)!)?.("optionalEvalWrite = new ProjectWideDecoyA()");
    void ProjectWideDecoyA;
    return optionalEvalWrite.request();
}

export class FieldInitializer {
    private readonly worker: StructuralA = new StructuralB();

    run(): string {
        return this.worker.request();
    }
}

export class ParameterProperty {
    constructor(private readonly worker: StructuralA) {}

    run(): string {
        return this.worker.request();
    }
}

export class ConstructorAssignment {
    private readonly worker: StructuralA;

    constructor(worker: StructuralA) {
        this.worker = worker;
    }

    run(): string {
        return this.worker.request();
    }
}

export function typedParameter(worker: StructuralA): string {
    return worker.request();
}

export function optionalParameter(worker: StructuralA | undefined): string | undefined {
    return worker?.request();
}

export function interfaceParameter(worker: Contract): string {
    return worker.request();
}

export function singleInterfaceParameter(worker: SingleContract): string {
    return worker.request();
}

export function instantiateUnsafeCases(): void {
    new ParameterProperty(new StructuralB()).run();
    new ConstructorAssignment(new StructuralB()).run();
}
`;

function project(): SemanticProjectInput {
    return {
        language: 'typescript',
        sourceFiles: [
            { path: 'fixture/targets.ts', source: targets, sourceHash: 'targets' },
            { path: 'fixture/cases.ts', source: cases, sourceHash: 'cases' },
        ],
        auxiliaryFiles: [],
    };
}

function callByText(
    evidence: ReturnType<typeof analyzeTypeScriptProject>,
    calleeText: string,
): TypeScriptCallEvidence {
    const matches = (evidence.occurrencesByFile.get('fixture/cases.ts') ?? [])
        .filter((call) => call.calleeText === calleeText);
    assert.equal(matches.length, 1, calleeText);
    return matches[0];
}

function assertResolvedOwner(call: TypeScriptCallEvidence, ownerName: string): void {
    assert.equal(call.decision, 'resolved', call.calleeText);
    assert.equal(call.target?.ownerName, ownerName, call.calleeText);
}

function assertNotResolvedToA(call: TypeScriptCallEvidence): void {
    assert.notEqual(
        call.decision === 'resolved' ? call.target?.ownerName : undefined,
        'StructuralA',
        `${call.calleeText} must not fabricate StructuralA.request from a static structural type`,
    );
}

test('immutable origin evidence resolves exact origins while mutable structural writes remain ambiguous', () => {
    const evidence = analyzeTypeScriptProject(project(), { collectDiagnostics: true });
    assert.equal(evidence.diagnostics?.semantic, 0);

    assertResolvedOwner(callByText(evidence, 'initialized.request'), 'StructuralB');

    for (const calleeText of [
        'reassigned.request',
        'nestedBlock.request',
        'conflicted.request',
        'loopWrite.request',
        'closureWrite.request',
    ]) {
        const call = callByText(evidence, calleeText);
        assert.equal(call.decision, 'ambiguous', calleeText);
        assert.equal(call.target, undefined, calleeText);
        assert.deepEqual(
            call.candidates?.map((target) => target.ownerName).sort(),
            ['StructuralA', 'StructuralB'],
            calleeText,
        );
    }
});

test('unproven aliases, nested member origins, destructuring, and externally supplied receivers never fabricate static-type targets', () => {
    const evidence = analyzeTypeScriptProject(project());

    for (const calleeText of [
        'alias2.request',
        'holder.worker.request',
        'destructured.request',
        'this.worker.request',
        'worker.request',
        'worker?.request',
    ]) {
        const matches = (evidence.occurrencesByFile.get('fixture/cases.ts') ?? [])
            .filter((call) => call.calleeText === calleeText);
        assert.ok(matches.length > 0, calleeText);
        for (const call of matches) {
            assertNotResolvedToA(call);
        }
    }

    const allCalls = evidence.occurrencesByFile.get('fixture/cases.ts') ?? [];
    const alias = allCalls.find((call) => call.calleeText === 'alias2.request');
    assertResolvedOwner(alias!, 'StructuralB');

    for (const calleeText of ['holder.worker.request', 'destructured.request', 'worker?.request']) {
        const call = allCalls.find((item) => item.calleeText === calleeText);
        assert.equal(call?.decision, 'ambiguous', calleeText);
    }

    const destructuredWrite = callByText(evidence, 'destructuredWrite.request');
    assert.equal(destructuredWrite.decision, 'ambiguous');
    assert.deepEqual(
        destructuredWrite.candidates?.map((target) => target.ownerName).sort(),
        ['ProjectWideDecoyA', 'ProjectWideDecoyB', 'StructuralA', 'StructuralB'],
    );

    const fieldCalls = allCalls.filter((call) => call.calleeText === 'this.worker.request');
    assert.equal(fieldCalls.length, 3);
    assertResolvedOwner(fieldCalls[0], 'StructuralB');
    assert.equal(fieldCalls[1].decision, 'ambiguous');
    assert.equal(fieldCalls[2].decision, 'ambiguous');

    const structuralParameter = allCalls.find(
        (call) => call.calleeText === 'worker.request' && call.receiverType === 'StructuralA',
    );
    assert.equal(structuralParameter?.decision, 'ambiguous');

    const interfaceCall = allCalls.find(
        (call) => call.calleeText === 'worker.request' && call.receiverType === 'Contract',
    );
    assert.equal(interfaceCall?.decision, 'ambiguous');
    assert.equal(interfaceCall?.reason, 'multiple_executable_targets');

    const singleInterfaceCall = allCalls.find(
        (call) => call.calleeText === 'worker.request' && call.receiverType === 'SingleContract',
    );
    assert.equal(singleInterfaceCall?.decision, 'unresolved');
    assert.equal(singleInterfaceCall?.target, undefined);
    assert.deepEqual(
        singleInterfaceCall?.candidates?.map((target) => target.ownerName),
        ['SingleImpl'],
    );
});

test('transparent direct eval wrappers force mutable-origin fallback', () => {
    const evidence = analyzeTypeScriptProject(project(), { collectDiagnostics: true });
    assert.equal(evidence.diagnostics?.syntactic, 0);
    assert.equal(evidence.diagnostics?.semantic, 0);

    const wrappedEvalWrite = callByText(evidence, 'wrappedEvalWrite.request');
    assert.equal(wrappedEvalWrite.decision, 'ambiguous');
    assert.deepEqual(
        wrappedEvalWrite.candidates?.map((target) => target.ownerName).sort(),
        ['ProjectWideDecoyA', 'ProjectWideDecoyB', 'StructuralA', 'StructuralB'],
    );
});

test('optional eval calls remain indirect for mutable-origin precision', () => {
    const evidence = analyzeTypeScriptProject(project(), { collectDiagnostics: true });
    assert.equal(evidence.diagnostics?.syntactic, 0);
    assert.equal(evidence.diagnostics?.semantic, 0);

    const optionalEvalWrite = callByText(evidence, 'optionalEvalWrite.request');
    assert.equal(optionalEvalWrite.decision, 'ambiguous');
    assert.deepEqual(
        optionalEvalWrite.candidates?.map((target) => target.ownerName).sort(),
        ['StructuralA', 'StructuralB'],
    );
});
