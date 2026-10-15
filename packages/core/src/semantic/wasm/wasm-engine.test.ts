import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WasmSemanticEngine, WasmSemanticSession } from './wasm-engine';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';
import type { NativeSemanticEngine } from './wasm-loader';

function fakeNative(options: {
    failAt?: number;
    failure?: 'zero' | 'malloc' | 'copy';
    error?: Error;
    rc?: number;
    nativeError?: Error;
    message?: string;
} = {}) {
    const heap = new Uint8Array(4096);
    const allocations: Array<{ ptr: number; size: number }> = [];
    const freed: number[] = [];
    const calls: number[][] = [];
    const payloads: string[][] = [];
    const destroyed: number[] = [];
    let mallocCalls = 0;
    let copyCalls = 0;
    heap.set = (bytes, offset = 0) => {
        copyCalls += 1;
        if (options.failure === 'copy' && copyCalls === options.failAt) throw options.error;
        Uint8Array.prototype.set.call(heap, bytes, offset);
    };
    const add = (...args: number[]) => {
        calls.push(args);
        const strings: string[] = [];
        for (let i = 1; i < args.length; i += 2) {
            strings.push(Buffer.from(heap.subarray(args[i], args[i] + args[i + 1])).toString('utf8'));
            assert.equal(heap[args[i] + args[i + 1]], 0, 'native strings must be null terminated');
        }
        payloads.push(strings);
        if (options.nativeError) throw options.nativeError;
        return options.rc ?? 0;
    };
    const native = {
        HEAPU8: heap,
        _malloc(size: number) {
            mallocCalls += 1;
            if (mallocCalls === options.failAt) {
                if (options.failure === 'zero') return 0;
                if (options.failure === 'malloc') throw options.error;
            }
            const ptr = mallocCalls * 128;
            heap.fill(255, ptr, ptr + size);
            allocations.push({ ptr, size });
            return ptr;
        },
        _free(ptr: number) {
            assert.notEqual(ptr, 0, 'must not free a null pointer');
            assert.ok(!freed.includes(ptr), 'must free each pointer only once');
            freed.push(ptr);
        },
        _satori_semantic_add_source: add,
        _satori_semantic_add_auxiliary: add,
        _satori_semantic_last_error(handle: number) {
            assert.equal(handle, 42);
            return 2048;
        },
        UTF8ToString(ptr: number) {
            assert.equal(ptr, 2048);
            return options.message ?? 'native add failed';
        },
        _satori_semantic_free(handle: number) { destroyed.push(handle); },
    } satisfies Partial<NativeSemanticEngine>;
    return { native: native as NativeSemanticEngine, allocations, freed, calls, payloads, destroyed };
}

for (const operation of ['addSource', 'addAuxiliary'] as const) {
    const inputs = operation === 'addSource' ? ['src/é.go', 'package π'] : ['manifest', 'src/é.go', 'package π'];
    const invoke = (session: WasmSemanticSession) => operation === 'addSource'
        ? session.addSource(inputs[0], inputs[1])
        : session.addAuxiliary(inputs[0], inputs[1], inputs[2]);

    for (const failure of ['zero', 'malloc', 'copy'] as const) {
        for (let failAt = 1; failAt <= inputs.length; failAt += 1) {
            test(`WasmSemanticSession fake ${operation} frees allocations on ${failure} failure at ${failAt}`, () => {
                const error = new Error('injected allocation failure');
                const fake = fakeNative({ failure, failAt, error });
                const session = new WasmSemanticSession(fake.native, 42);

                assert.throws(() => invoke(session), (actual: unknown) => {
                    if (failure !== 'zero') return actual === error;
                    assert.ok(actual instanceof Error);
                    assert.equal(actual.message, 'Out of memory allocating buffer in WASM runtime');
                    return true;
                });
                assert.equal(fake.allocations.length, failure === 'copy' ? failAt : failAt - 1);
                assert.equal(fake.calls.length, 0, 'incomplete allocations must not reach native code');
                assert.deepEqual([...fake.freed].sort((a, b) => a - b), fake.allocations.map(({ ptr }) => ptr));
                assert.deepEqual(fake.destroyed, [], 'allocation failure must not destroy the session');
            });
        }
    }

    for (const outcome of ['success', 'throw', 'rc-message', 'rc-fallback'] as const) {
        test(`WasmSemanticSession fake ${operation} preserves arguments and frees allocations on native ${outcome}`, () => {
            const error = new Error('injected native failure');
            const fake = fakeNative({
                nativeError: outcome === 'throw' ? error : undefined,
                rc: outcome.startsWith('rc-') ? 17 : 0,
                message: outcome === 'rc-fallback' ? '' : 'native add failed',
            });
            const session = new WasmSemanticSession(fake.native, 42);

            if (outcome === 'success') assert.equal(invoke(session), undefined);
            else assert.throws(() => invoke(session), (actual: unknown) => {
                if (outcome === 'throw') return actual === error;
                assert.ok(actual instanceof Error);
                assert.equal(actual.message, outcome === 'rc-fallback' ? `${operation} failed with code 17` : 'native add failed');
                return true;
            });
            const expectedArgs = [42];
            inputs.forEach((input, index) => { expectedArgs.push((index + 1) * 128, Buffer.byteLength(input)); });
            assert.deepEqual(fake.calls, [expectedArgs]);
            assert.deepEqual(fake.payloads, [inputs]);
            assert.deepEqual(fake.allocations.map(({ size }) => size), inputs.map(input => Buffer.byteLength(input) + 1));
            assert.deepEqual(fake.freed, fake.allocations.map(({ ptr }) => ptr));
            assert.deepEqual(fake.destroyed, []);

            session.destroy();
            session.destroy();
            assert.deepEqual(fake.destroyed, [42], 'destroy remains idempotent');
            assert.throws(() => invoke(session), { message: 'Semantic session 42 is already destroyed' });
            assert.equal(fake.calls.length, 1);
            assert.equal(fake.allocations.length, inputs.length);
        });
    }
}

test('WasmSemanticEngine manages sessions, isolates data between sessions, and cleans up on destroy', async () => {
    const engine = await WasmSemanticEngine.create();

    const sessionA = await engine.createSession('go');
    const sessionB = await engine.createSession('go');

    assert.notEqual(sessionA.handleId, sessionB.handleId, 'Handles must be distinct');

    const goSrcA = `package main

func foo() {}
func main() {
    foo()
}
`;
    sessionA.addSource('a/main.go', goSrcA);

    const goSrcB = `package main

func bar() {}
func main() {
    bar()
}
`;
    sessionB.addSource('b/main.go', goSrcB);

    const resultsA = await sessionA.resolve();
    const resultsB = await sessionB.resolve();

    assert.equal(resultsA.length, 1);
    assert.equal(resultsA[0].sourceFile, 'a/main.go');
    assert.equal(resultsA[0].targetName, 'foo');

    assert.equal(resultsB.length, 1);
    assert.equal(resultsB[0].sourceFile, 'b/main.go');
    assert.equal(resultsB[0].targetName, 'bar');

    sessionA.destroy();
    sessionB.destroy();

    assert.throws(() => sessionA.addSource('a/other.go', ''), /destroyed/i);
    assert.throws(() => sessionB.addSource('b/other.go', ''), /destroyed/i);
});

test('WasmSemanticProjectAnalyzer supports Go, rejects Python, and produces structured project evidence', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();

    assert.equal(analyzer.supportsLanguage('go'), true);
    assert.equal(analyzer.supportsLanguage('python'), false);
    assert.equal(analyzer.supportsLanguage('typescript'), false);

    const evidence = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [
            {
                path: 'go.mod',
                role: 'manifest',
                source: 'module example.com/app\n\ngo 1.22\n',
                sourceHash: 'sha-mod',
            },
        ],
        sourceFiles: [
            {
                path: 'main.go',
                source: `package main

type Service struct{}

func (s *Service) Process() {}

func main() {
    svc := &Service{}
    svc.Process()
}
`,
                sourceHash: 'sha-main',
            },
        ],
    });

    assert.equal(evidence.language, 'go');
    const occurrences = evidence.occurrencesByFile.get('main.go');
    assert.ok(occurrences);
    assert.equal(occurrences.length, 1);

    const occ = occurrences[0];
    assert.equal(occ.sourceFile, 'main.go');
    assert.ok(occ.targetProvenance);
    assert.equal(occ.targetProvenance.name, 'Process');
    assert.equal(occ.targetProvenance.kind, 'method');
    assert.equal(occ.targetProvenance.ownerName, 'Service');
    assert.equal(occ.proof.strategy, 'type_dispatch');
    assert.equal(occ.proof.receiverBinding?.receiverType, 'Service');
    assert.equal(occ.decision, 'resolved');
});
