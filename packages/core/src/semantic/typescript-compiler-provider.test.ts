import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeWithOxc } from '../language-analysis/oxc-adapter';
import type { SemanticProjectInput } from './contracts';
import {
    analyzeTypeScriptProject,
    type TypeScriptCallEvidence,
} from './typescript-compiler-provider';

const workersSource = `
export class WorkerA {
    private readonly workerKind = 'a';
    request(): string { return 'a'; }
}

export class WorkerB {
    private readonly workerKind = 'b';
    request(): string { return 'b'; }
}

export class StructuralA {
    request(): string { return 'structural-a'; }
}

export class StructuralB {
    request(): string { return 'structural-b'; }
}

export interface WorkerLike {
    request(): string;
}

export class OverloadedWorker {
    run(value: string): string;
    run(value: number): string;
    run(value: string | number): string { return String(value); }
}

export class BaseWorker {
    inherited(): string { return 'base'; }
}

export class DerivedWorker extends BaseWorker {}

export function directCall(): string {
    return 'direct';
}

export function overloaded(value: string): string;
export function overloaded(value: number): string;
export function overloaded(value: string | number): string {
    return String(value);
}

export function makeWorker(): WorkerA {
    return new WorkerA();
}

export function identity<T>(value: T): T {
    return value;
}

export function genericReceiver<T extends WorkerLike>(worker: T): string {
    return worker.request();
}
`;

const consumerSource = `
import {
    BaseWorker,
    DerivedWorker,
    OverloadedWorker,
    StructuralA,
    StructuralB,
    WorkerA,
    WorkerB,
    type WorkerLike,
    directCall,
    identity,
    makeWorker,
    overloaded,
} from './workers';

export class Consumer {
    private typedField: WorkerA;
    private assignedField;

    constructor(
        private parameterProperty: WorkerA,
        worker: WorkerA,
    ) {
        this.typedField = worker;
        this.assignedField = worker;
    }

    run(local: WorkerA, iface: WorkerLike, maybe: WorkerA | undefined, chooseA: boolean): void {
        directCall();
        local.request();
        const typedLocal: WorkerA = local;
        typedLocal.request();
        new WorkerB().request();
        this.typedField.request();
        this.parameterProperty.request();
        this.assignedField.request();

        const alias = this.typedField;
        alias.request();

        maybe?.request();

        new DerivedWorker().inherited();

        iface.request();

        const concreteInterface: WorkerLike = new WorkerA();
        concreteInterface.request();

        overloaded('x');
        new OverloadedWorker().run('x');

        makeWorker().request();
        identity(new WorkerA()).request();

        const nested = { worker: this.typedField };
        nested.worker.request();

        let reassigned: WorkerA | WorkerB = this.typedField;
        reassigned = new WorkerB();
        reassigned.request();

        let conflicted: WorkerA | WorkerB;
        if (chooseA) {
            conflicted = new WorkerA();
        } else {
            conflicted = new WorkerB();
        }
        conflicted.request();

        const structurallyInitialized: StructuralA = new StructuralB();
        structurallyInitialized.request();

        let structurallyReassigned: StructuralA = new StructuralA();
        structurallyReassigned = new StructuralB();
        structurallyReassigned.request();

        let structurallyConflicted: StructuralA;
        if (chooseA) {
            structurallyConflicted = new StructuralA();
        } else {
            structurallyConflicted = new StructuralB();
        }
        structurallyConflicted.request();

        let loopReassigned: StructuralA = new StructuralA();
        for (const ignored of [1]) {
            void ignored;
            loopReassigned = new StructuralB();
        }
        loopReassigned.request();

        const dynamic: any = this.typedField;
        dynamic.request();

        const key = 'request';
        this.typedField[key]();
    }
}
`;

function project(): SemanticProjectInput {
    return {
        language: 'typescript',
        sourceFiles: [
            { path: 'src/workers.ts', source: workersSource, sourceHash: 'workers' },
            { path: 'src/consumer.ts', source: consumerSource, sourceHash: 'consumer' },
        ],
        auxiliaryFiles: [],
    };
}

function callsByCallee(evidence: ReturnType<typeof analyzeTypeScriptProject>): Map<string, TypeScriptCallEvidence[]> {
    const out = new Map<string, TypeScriptCallEvidence[]>();
    for (const call of evidence.occurrencesByFile.get('src/consumer.ts') ?? []) {
        const list = out.get(call.calleeName) ?? [];
        list.push(call);
        out.set(call.calleeName, list);
    }
    return out;
}

function resolvedTargets(calls: readonly TypeScriptCallEvidence[]): string[] {
    return calls
        .filter((call) => call.decision === 'resolved' && call.target)
        .map((call) => [
            call.target!.file,
            call.target!.ownerName ?? '',
            call.target!.name,
        ].join(':'));
}

test('TypeScript compiler provider resolves project semantic calls and abstains on dynamic dispatch', () => {
    const evidence = analyzeTypeScriptProject(project(), { collectDiagnostics: true });
    const calls = callsByCallee(evidence);

    assert.equal(evidence.diagnostics?.syntactic, 0);
    assert.equal(evidence.diagnostics?.semantic, 0);

    assert.deepEqual(resolvedTargets(calls.get('directCall') ?? []), [
        'src/workers.ts::directCall',
    ]);

    const requestCalls = calls.get('request') ?? [];
    const requestTargets = resolvedTargets(requestCalls);

    assert.ok(
        requestTargets.filter((target) => target === 'src/workers.ts:WorkerA:request').length >= 8,
        `expected WorkerA request bindings, got ${JSON.stringify(requestTargets)}`,
    );
    assert.ok(
        requestTargets.includes('src/workers.ts:WorkerB:request'),
        `expected the explicit WorkerB receiver to bind to WorkerB, got ${JSON.stringify(requestTargets)}`,
    );

    const reassigned = requestCalls.find((call) => call.calleeText === 'reassigned.request');
    assert.equal(reassigned?.decision, 'resolved');
    assert.equal(reassigned?.target?.ownerName, 'WorkerB');

    const interfaceCall = requestCalls.find((call) => call.calleeText === 'iface.request');
    assert.equal(interfaceCall?.decision, 'unresolved');
    assert.equal(interfaceCall?.reason, 'declaration_without_implementation');

    const concreteInterface = requestCalls.find((call) => call.calleeText === 'concreteInterface.request');
    assert.equal(concreteInterface?.decision, 'resolved');
    assert.equal(concreteInterface?.target?.ownerName, 'WorkerA');

    const dynamicCall = requestCalls.find((call) => call.calleeText === 'dynamic.request');
    assert.equal(dynamicCall?.decision, 'unsupported');
    assert.equal(dynamicCall?.reason, 'dynamic_receiver');

    const computedCall = (evidence.occurrencesByFile.get('src/consumer.ts') ?? [])
        .find((call) => call.calleeText === 'this.typedField[key]');
    assert.equal(computedCall?.decision, 'unsupported');
    assert.equal(computedCall?.reason, 'dynamic_callee');

    const conflicted = requestCalls.find((call) => call.calleeText === 'conflicted.request');
    assert.equal(conflicted?.decision, 'ambiguous');
    assert.deepEqual(
        conflicted?.candidates?.map((target) => `${target.ownerName}.${target.name}`).sort(),
        ['WorkerA.request', 'WorkerB.request'],
    );

    const structurallyConflicted = requestCalls.find((call) => call.calleeText === 'structurallyConflicted.request');
    assert.equal(structurallyConflicted?.decision, 'ambiguous');
    assert.deepEqual(
        structurallyConflicted?.candidates?.map((target) => `${target.ownerName}.${target.name}`).sort(),
        ['StructuralA.request', 'StructuralB.request'],
    );

    const structurallyInitialized = requestCalls.find((call) => call.calleeText === 'structurallyInitialized.request');
    assert.equal(structurallyInitialized?.decision, 'resolved');
    assert.equal(structurallyInitialized?.target?.ownerName, 'StructuralB');

    const structurallyReassigned = requestCalls.find((call) => call.calleeText === 'structurallyReassigned.request');
    assert.equal(structurallyReassigned?.decision, 'resolved');
    assert.equal(structurallyReassigned?.target?.ownerName, 'StructuralB');

    const loopReassigned = requestCalls.find((call) => call.calleeText === 'loopReassigned.request');
    assert.equal(loopReassigned?.decision, 'unresolved');
    assert.equal(loopReassigned?.reason, 'origin_unknown_after_write');

    const inherited = (calls.get('inherited') ?? []).find((call) => call.calleeText.endsWith('.inherited'));
    assert.equal(inherited?.decision, 'resolved');
    assert.equal(inherited?.target?.ownerName, 'BaseWorker');
    assert.equal(inherited?.target?.name, 'inherited');

    const overload = (calls.get('overloaded') ?? [])[0];
    assert.equal(overload?.decision, 'resolved');
    assert.equal(overload?.target?.name, 'overloaded');
    assert.equal(overload?.target?.file, 'src/workers.ts');

    const overloadedMethod = (calls.get('run') ?? [])[0];
    assert.equal(overloadedMethod?.decision, 'resolved');
    assert.equal(overloadedMethod?.target?.ownerName, 'OverloadedWorker');
    assert.equal(overloadedMethod?.target?.name, 'run');

    const genericReceiver = (evidence.occurrencesByFile.get('src/workers.ts') ?? [])
        .find((call) => call.calleeText === 'worker.request');
    assert.equal(genericReceiver?.decision, 'unresolved');
    assert.equal(genericReceiver?.reason, 'generic_receiver');
});

test('TypeScript target provenance spans match OXC symbol spans and reject same-name decoys', () => {
    const evidence = analyzeTypeScriptProject(project());
    const structural = analyzeWithOxc({
        content: workersSource,
        language: 'typescript',
        relativePath: 'src/workers.ts',
    });
    assert.equal(structural.complete, true);
    const structuralSymbols = structural.complete ? structural.symbols : [];
    const resolvedWorkerTargets = [...evidence.occurrencesByFile.values()]
        .flat()
        .filter((call) => call.decision === 'resolved' && call.target?.file === 'src/workers.ts')
        .map((call) => call.target!);
    for (const target of resolvedWorkerTargets) {
        assert.ok(structuralSymbols.some((symbol) => (
            symbol.name === target.name
            && symbol.span.startByte === target.span.startByte
            && symbol.span.endByte === target.span.endByte
        )), `missing exact OXC provenance match for ${target.ownerName ?? ''}.${target.name}`);
    }

    const requestCalls = callsByCallee(evidence).get('request') ?? [];

    const localCall = requestCalls.find((call) => call.calleeText === 'local.request');
    assert.equal(localCall?.decision, 'resolved');
    assert.equal(localCall?.target?.ownerName, 'WorkerA');

    const target = localCall?.target;
    assert.ok(target);
    const targetSource = workersSource.slice(target.span.startByte, target.span.endByte);
    assert.match(targetSource, /^request\(\): string \{ return 'a'; \}/);
    assert.doesNotMatch(targetSource, /return 'b'/);

    const workerBCall = requestCalls.find((call) => call.calleeText === 'new WorkerB().request');
    assert.equal(workerBCall?.decision, 'resolved');
    assert.equal(workerBCall?.target?.ownerName, 'WorkerB');
    const workerBTarget = workerBCall?.target;
    assert.ok(workerBTarget);
    const workerBSource = workersSource.slice(workerBTarget.span.startByte, workerBTarget.span.endByte);
    assert.match(workerBSource, /^request\(\): string \{ return 'b'; \}/);
    assert.doesNotMatch(workerBSource, /return 'a'/);
});

test('TypeScript compiler provider handles constructor inference, aliases, optional receivers, chains, and concrete generic inference', () => {
    const evidence = analyzeTypeScriptProject(project());
    const requestCalls = callsByCallee(evidence).get('request') ?? [];

    const expectedResolved = [
        'typedLocal.request',
        'this.typedField.request',
        'this.parameterProperty.request',
        'this.assignedField.request',
        'alias.request',
        'maybe?.request',
        'makeWorker().request',
        'identity(new WorkerA()).request',
        'nested.worker.request',
    ];

    for (const calleeText of expectedResolved) {
        const call = requestCalls.find((item) => item.calleeText === calleeText);
        assert.equal(call?.decision, 'resolved', calleeText);
        assert.equal(call?.target?.ownerName, 'WorkerA', calleeText);
    }
});
