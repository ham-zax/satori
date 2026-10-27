import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads from 'node:worker_threads';
import { ThreadedWasmSemanticProjectAnalyzer } from './wasm-threaded-analyzer';
import { DEFAULT_MAX_SEMANTIC_SOURCE_BYTES } from './wasm-analyzer';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function controlledWorkers(t: import('node:test').TestContext, postFailure?: { worker: number; error: Error }) {
    const workers: FakeWorker[] = [];
    class FakeWorker extends EventEmitter {
        readonly exitGate = deferred<number>();
        readonly requests: Array<{ id: number; prepareOnly?: true }> = [];
        terminateCalls = 0;
        postError?: Error;
        constructor() {
            super();
            workers.push(this);
            if (workers.length === postFailure?.worker) this.postError = postFailure.error;
        }
        postMessage(request: { id: number; prepareOnly?: true }) {
            if (this.postError) throw this.postError;
            this.requests.push(request);
        }
        terminate() { this.terminateCalls += 1; return this.exitGate.promise; }
        succeed(id = this.requests.at(-1)!.id) {
            this.emit('message', { id, success: true, evidence: { language: 'go', occurrencesEntries: [['main.go', []]] } });
        }
    }
    const replacement = t.mock.method(workerThreads, 'Worker', function () {
        return new FakeWorker();
    } as unknown as typeof workerThreads.Worker);
    syncBuiltinESMExports();
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer(undefined, { idleReleaseMs: 10, requestTimeoutMs: 100 });
    t.after(async () => {
        workers.forEach(worker => worker.exitGate.resolve(0));
        await analyzer.dispose().catch(() => undefined);
        replacement.mock.restore();
        syncBuiltinESMExports();
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    return { workers, analyzer };
}

function assertNoPending(analyzer: ThreadedWasmSemanticProjectAnalyzer) {
    assert.equal(analyzer['pendingRequests'].size, 0);
    assert.equal(analyzer['idleTimer'], null);
}

test('preparation succeeds without retiring the worker and removes its abort listener', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const controller = new AbortController();
    const preparation = analyzer.prepareSourceTrees(SMALL_GO_PROJECT, controller.signal);
    await flushMicrotasks();
    assert.equal(workers[0].requests[0].prepareOnly, true);
    workers[0].succeed();
    await preparation;
    controller.abort();
    assert.equal(workers[0].terminateCalls, 0);
    const analysis = analyzer.analyze(SMALL_GO_PROJECT);
    await flushMicrotasks();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].requests[1].prepareOnly, undefined);
    workers[0].succeed();
    await analysis;
    workers[0].exitGate.resolve(0);
    await analyzer.dispose();
    assertNoPending(analyzer);
});

for (const failure of ['abort', 'failure'] as const) {
    test(`preparation ${failure} drains its worker before settling or replacement`, async (t) => {
        const { analyzer, workers } = controlledWorkers(t);
        const controller = new AbortController();
        let settled = false;
        let rejection: unknown;
        const preparation = analyzer.prepareSourceTrees(SMALL_GO_PROJECT, controller.signal)
            .then(() => { settled = true; }, error => { settled = true; rejection = error; });
        await flushMicrotasks();
        const worker = workers[0];
        if (failure === 'abort') controller.abort();
        else worker.emit('message', { id: worker.requests[0].id, success: false, error: 'prepare failed' });
        const next = analyzer.analyze(SMALL_GO_PROJECT);
        await flushMicrotasks();
        assert.equal(settled, false);
        assert.equal(workers.length, 1);
        assert.equal(worker.terminateCalls, 1);
        assertNoPending(analyzer);
        t.mock.timers.tick(1000);
        await flushMicrotasks();
        assert.equal(worker.terminateCalls, 1, 'the request timeout must be cleared');
        assert.equal(settled, false);
        worker.exitGate.resolve(0);
        await preparation;
        if (failure === 'abort') assert.equal(rejection, controller.signal.reason);
        else assert.match(String(rejection), /prepare failed/);
        await flushMicrotasks();
        assert.equal(workers.length, 2);
        workers[1].succeed();
        await next;
        workers[1].exitGate.resolve(0);
        await analyzer.dispose();
        assertNoPending(analyzer);
    });
}

test('failed preparation termination keeps the worker owned until exit', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const controller = new AbortController();
    const preparation = assert.rejects(analyzer.prepareSourceTrees(SMALL_GO_PROJECT, controller.signal));
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    const terminationError = new Error('prepare termination failed');
    workers[0].exitGate.reject(terminationError);
    await preparation;
    await assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), error => error === terminationError);
    assert.equal(workers.length, 1);
    assert.equal(analyzer.hasLiveWorker(), true);
    workers[0].emit('exit', 1);
    assert.equal(analyzer.hasLiveWorker(), false);
    assertNoPending(analyzer);
});

for (const release of ['idle timer', 'explicit release'] as const) {
    test(`controlled retirement: ${release} remains owned and all drains join it`, async (t) => {
        const { analyzer, workers } = controlledWorkers(t);
        const result = analyzer.analyze(SMALL_GO_PROJECT);
        await flushMicrotasks();
        workers[0].succeed();
        assert.deepEqual(await result, { language: 'go', occurrencesByFile: new Map([['main.go', []]]) });
        if (release === 'idle timer') t.mock.timers.tick(10);
        let released = false;
        const idle = analyzer.releaseIdleWorker().then(() => { released = true; });
        let disposed = 0;
        const disposals = [analyzer.dispose(), analyzer.dispose()].map(p => p.then(() => { disposed += 1; }));
        await flushMicrotasks();
        assert.equal(released, false);
        assert.equal(disposed, 0);
        assert.equal(analyzer.hasLiveWorker(), true);
        assert.equal(workers[0].terminateCalls, 1);
        assertNoPending(analyzer);
        workers[0].exitGate.resolve(0);
        await Promise.all([idle, ...disposals]);
        assert.equal(analyzer.hasLiveWorker(), false);
        await analyzer.dispose();
    });
}

test('controlled retirement: concurrent disposal delays pending rejection until termination', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const requests = [analyzer.analyze(SMALL_GO_PROJECT), analyzer.analyze(SMALL_GO_PROJECT)];
    const errors: unknown[] = [];
    const observed = requests.map(p => p.catch(error => { errors.push(error); }));
    await flushMicrotasks();
    let disposed = 0;
    const drains = [analyzer.dispose(), analyzer.dispose()].map(p => p.then(() => { disposed += 1; }));
    await flushMicrotasks();
    assert.equal(errors.length, 0);
    assert.equal(disposed, 0);
    assertNoPending(analyzer);
    workers[0].emit('exit', 1);
    workers[0].exitGate.resolve(0);
    await Promise.all([...observed, ...drains]);
    assert.equal(workers[0].terminateCalls, 1);
    assert.equal(errors.length, 2);
    for (const error of errors) assert.match(String(error), /Semantic analyzer disposed while request was pending/);
    assert.equal(analyzer.hasLiveWorker(), false);
});

test('controlled retirement: ordinary job error leaves other admitted jobs on the live worker', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const failed = assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), { message: 'job failed' });
    let completed = false;
    const other = analyzer.analyze(SMALL_GO_PROJECT).then(value => { completed = true; return value; });
    await flushMicrotasks();
    const worker = workers[0];
    worker.emit('message', { id: worker.requests[0].id, success: false, error: 'job failed' });
    await flushMicrotasks();
    assert.equal(analyzer['pendingRequests'].size, 1, 'only the failed job is removed');
    assert.equal(worker.terminateCalls, 0);
    assert.equal(analyzer.hasLiveWorker(), true);
    assert.equal(completed, false);
    await failed;
    worker.succeed(worker.requests[1].id);
    assert.deepEqual(await other, { language: 'go', occurrencesByFile: new Map([['main.go', []]]) });
    assert.equal(workers.length, 1);
    assert.equal(worker.terminateCalls, 0);
    worker.exitGate.resolve(0);
    await analyzer.releaseIdleWorker();
    assertNoPending(analyzer);
});

for (const failure of ['timeout', 'error', 'postMessage', 'exit'] as const) {
    test(`controlled retirement: ${failure} joins exit before rejection and replacement`, async (t) => {
        const { analyzer, workers } = controlledWorkers(t);
        const original = new Error('original worker failure');
        let requestError: unknown;
        const request = analyzer.analyze(SMALL_GO_PROJECT).catch(error => { requestError = error; });
        await flushMicrotasks();
        const worker = workers[0];
        if (failure === 'timeout') t.mock.timers.tick(100);
        if (failure === 'error') worker.emit('error', original);
        if (failure === 'exit') worker.emit('exit', 7);
        let postRequest: Promise<unknown> | undefined;
        if (failure === 'postMessage') {
            worker.postError = original;
            postRequest = analyzer.analyze(SMALL_GO_PROJECT).catch(error => { assert.equal(error, original); });
            await flushMicrotasks();
        }
        let replacementDone = false;
        const next = analyzer.analyze(SMALL_GO_PROJECT).then(value => { replacementDone = true; return value; });
        await flushMicrotasks();
        assert.equal(requestError, undefined, 'failure must wait for worker exit');
        assert.equal(workers.length, 1, 'replacement must wait for worker exit');
        assert.equal(worker.terminateCalls, 1);
        assert.equal(analyzer.hasLiveWorker(), true);
        assertNoPending(analyzer);
        t.mock.timers.tick(1000);
        worker.emit('exit', 99);
        worker.exitGate.resolve(0);
        await request;
        await postRequest;
        await flushMicrotasks();
        assert.equal(workers.length, 2);
        assert.equal(replacementDone, false);
        const replacement = workers[1];
        worker.succeed(replacement.requests[0].id);
        await flushMicrotasks();
        assert.equal(replacementDone, false, 'old worker cannot answer a replacement request');
        replacement.succeed();
        assert.deepEqual(await next, { language: 'go', occurrencesByFile: new Map([['main.go', []]]) });
        if (failure === 'timeout') assert.match(String(requestError), /timed out after 100 ms/);
        else if (failure === 'exit') assert.match(String(requestError), /exit code 7/);
        else assert.equal(requestError, original);
        replacement.exitGate.resolve(0);
        await analyzer.releaseIdleWorker();
        assertNoPending(analyzer);
        assert.equal(analyzer.hasLiveWorker(), false);
    });
}

test('controlled retirement: analyze rechecks disposal after joining retirement', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const first = analyzer.analyze(SMALL_GO_PROJECT);
    await flushMicrotasks();
    workers[0].succeed();
    await first;
    t.mock.timers.tick(10);
    const next = assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), /Semantic analyzer has been disposed/);
    const drain = analyzer.dispose();
    workers[0].exitGate.resolve(0);
    await Promise.all([next, drain]);
    assert.equal(workers.length, 1);
    assertNoPending(analyzer);
});

test('controlled retirement: concurrent analyze rejoins a replacement that fails during dispatch', async (t) => {
    const error = new Error('replacement dispatch failed');
    const { analyzer, workers } = controlledWorkers(t, { worker: 2, error });
    const first = analyzer.analyze(SMALL_GO_PROJECT);
    await flushMicrotasks();
    workers[0].succeed();
    await first;
    t.mock.timers.tick(10);
    const failed = assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), actual => actual === error);
    const next = analyzer.analyze(SMALL_GO_PROJECT);
    workers[0].exitGate.resolve(0);
    await flushMicrotasks();
    assert.equal(workers.length, 2, 'concurrent continuation must join the replacement retirement');
    assert.equal(workers[1].terminateCalls, 1);
    assertNoPending(analyzer);
    workers[1].exitGate.resolve(0);
    await failed;
    await flushMicrotasks();
    assert.equal(workers.length, 3);
    workers[2].succeed();
    await next;
    workers[2].exitGate.resolve(0);
    await analyzer.releaseIdleWorker();
    assertNoPending(analyzer);
});

test('controlled retirement: rejected termination preserves request reason and drains without unhandled rejection', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const request = assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), /disposed while request was pending/);
    await flushMicrotasks();
    const terminationError = new Error('terminate rejected');
    const drains = [analyzer.dispose(), analyzer.dispose()].map(p => assert.rejects(p, error => error === terminationError));
    assertNoPending(analyzer);
    workers[0].exitGate.reject(terminationError);
    await Promise.all([request, ...drains]);
    assert.equal(analyzer.hasLiveWorker(), true, 'failed termination still owns the potentially live worker');
    for (let i = 0; i < 2; i += 1) {
        await assert.rejects(analyzer.dispose(), error => error === terminationError);
        await assert.rejects(analyzer.releaseIdleWorker(), error => error === terminationError);
    }
    assert.equal(workers[0].terminateCalls, 1);
    workers[0].emit('exit', 1);
    await analyzer.dispose();
    await analyzer.releaseIdleWorker();
    assert.equal(analyzer.hasLiveWorker(), false);
});

test('controlled retirement: failed termination blocks replacement until actual worker exit', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const original = new Error('fatal worker error');
    const terminationError = new Error('termination failed');
    const request = assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), error => error === original);
    await flushMicrotasks();
    const worker = workers[0];
    worker.emit('error', original);
    let drained = false;
    const drain = assert.rejects(analyzer.releaseIdleWorker(), error => error === terminationError)
        .then(() => { drained = true; });
    await flushMicrotasks();
    assert.equal(drained, false);
    assertNoPending(analyzer);
    worker.exitGate.reject(terminationError);
    await Promise.all([request, drain]);
    assert.equal(analyzer.hasLiveWorker(), true);
    for (let i = 0; i < 2; i += 1) {
        await assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), error => error === terminationError);
        await assert.rejects(analyzer.releaseIdleWorker(), error => error === terminationError);
    }
    assert.equal(workers.length, 1, 'failed termination cannot allow replacement');
    assert.equal(worker.terminateCalls, 1, 'failed termination is not retried');
    worker.emit('exit', 1);
    assert.equal(analyzer.hasLiveWorker(), false);
    const replacement = analyzer.analyze(SMALL_GO_PROJECT);
    await flushMicrotasks();
    assert.equal(workers.length, 2);
    workers[1].succeed();
    await replacement;
    workers[1].exitGate.resolve(0);
    await analyzer.releaseIdleWorker();
    assertNoPending(analyzer);
});

test('controlled retirement: exit before termination rejection does not restore failed ownership', async (t) => {
    const { analyzer, workers } = controlledWorkers(t);
    const request = assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), /disposed while request was pending/);
    await flushMicrotasks();
    const terminationError = new Error('late termination rejection');
    const drain = assert.rejects(analyzer.dispose(), error => error === terminationError);
    await flushMicrotasks();
    workers[0].emit('exit', 1);
    workers[0].exitGate.reject(terminationError);
    await Promise.all([request, drain]);
    assert.equal(analyzer.hasLiveWorker(), false);
    await analyzer.dispose();
    assertNoPending(analyzer);
});

test('threaded analysis preserves skipped source and auxiliary files while analyzing admitted sources', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    const oversizedSource = ' '.repeat(DEFAULT_MAX_SEMANTIC_SOURCE_BYTES + 1);
    try {
        const result = await analyzer.analyze({
            language: 'go',
            auxiliaryFiles: [
                { role: 'go.mod', path: 'go.mod', source: oversizedSource, sourceHash: 'large-aux' },
            ],
            sourceFiles: [
                { path: 'large.go', source: oversizedSource, sourceHash: 'large-source' },
                {
                    path: 'main.go',
                    source: 'package main\nfunc Helper() {}\nfunc Caller() { Helper() }\n',
                    sourceHash: 'small-source',
                },
            ],
        });
        assert.deepEqual(result.skippedFiles, [
            { path: 'go.mod', reason: 'source_too_large', bytes: DEFAULT_MAX_SEMANTIC_SOURCE_BYTES + 1 },
            { path: 'large.go', reason: 'source_too_large', bytes: DEFAULT_MAX_SEMANTIC_SOURCE_BYTES + 1 },
        ]);
        assert.equal(result.occurrencesByFile.has('large.go'), false);
        assert.ok((result.occurrencesByFile.get('main.go')?.length ?? 0) > 0);
        assert.equal(result.coverage?.status, 'degraded');
        assert.equal(result.coverage?.sourceFileCount, 2);
        assert.equal(result.coverage?.analyzedSourceFileCount, 1);
        assert.deepEqual(result.coverage?.skippedFiles, result.skippedFiles);
    } finally {
        await analyzer.dispose();
    }
});

test('ThreadedWasmSemanticProjectAnalyzer executes analysis without blocking main event loop', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    assert.equal(analyzer.supportsLanguage('go'), true);
    assert.equal(analyzer.supportsLanguage('python'), false);

    // Build a multi-file Go project with callers and targets
    const sourceFiles = [];
    for (let i = 0; i < 30; i++) {
        sourceFiles.push({
            path: `pkg/file${i}.go`,
            source: `package pkg\n\nfunc Helper${i}() {}\nfunc CallHelper${i}() {\n    Helper${i}()\n}\n`,
            sourceHash: `hash-${i}`,
        });
    }

    let eventLoopTicks = 0;
    const timer = setInterval(() => { eventLoopTicks += 1; }, 2);

    const result = await analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [
            {
                role: 'go.mod',
                path: 'go.mod',
                source: 'module example.com/test\n\ngo 1.21\n',
                sourceHash: 'aux-hash',
            },
        ],
        sourceFiles,
    });

    clearInterval(timer);
    assert.ok(eventLoopTicks > 0, `Main event loop must tick during off-thread WASM analysis (observed ${eventLoopTicks} ticks)`);
    assert.equal(result.language, 'go');
    assert.equal(result.occurrencesByFile.size, 30);
    const firstOccurrences = result.occurrencesByFile.get('pkg/file0.go');
    assert.ok(firstOccurrences && firstOccurrences.length > 0);
    assert.equal(firstOccurrences[0].targetProvenance?.name, 'Helper0');

    await analyzer.dispose();
});

test('ThreadedWasmSemanticProjectAnalyzer handles unsupported languages and disposal cleanly', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    const result = await analyzer.analyze({
        language: 'unsupported_lang',
        auxiliaryFiles: [],
        sourceFiles: [],
    });
    assert.equal(result.occurrencesByFile.size, 0);
    await analyzer.dispose();
});

test('ThreadedWasmSemanticProjectAnalyzer rejects in-flight pending requests when disposed', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    const sourceFiles = [];
    for (let i = 0; i < 50; i++) {
        sourceFiles.push({
            path: `pkg/file${i}.go`,
            source: `package pkg\n\nfunc HeavyFunc${i}() {}\nfunc Call${i}() { HeavyFunc${i}() }\n`,
            sourceHash: `hash-${i}`,
        });
    }

    const pendingPromise = analyzer.analyze({
        language: 'go',
        auxiliaryFiles: [
            {
                role: 'go.mod',
                path: 'go.mod',
                source: 'module example.com/test\n\ngo 1.21\n',
                sourceHash: 'aux-hash',
            },
        ],
        sourceFiles,
    });

    // Dispose immediately while analysis request is in-flight
    const disposePromise = analyzer.dispose();

    await assert.rejects(
        pendingPromise,
        /Semantic analyzer disposed while request was pending|CBM Semantic Worker stopped unexpectedly/,
    );
    await disposePromise;
});

test('ThreadedWasmSemanticProjectAnalyzer rejects analyze calls made after disposal', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    await analyzer.dispose();

    await assert.rejects(
        () => analyzer.analyze({
            language: 'go',
            auxiliaryFiles: [],
            sourceFiles: [],
        }),
        /Semantic analyzer has been disposed/,
    );
});

test('ThreadedWasmSemanticProjectAnalyzer handles multiple dispose calls idempotently without error', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    await Promise.all([
        analyzer.dispose(),
        analyzer.dispose(),
        analyzer.dispose(),
    ]);
});

test('Context memoizes dispose and calls underlying analyzer dispose exactly once across concurrent callers', async () => {
    let disposeCount = 0;
    const mockAnalyzer = {
        supportsLanguage: () => true,
        analyze: async () => ({ language: 'go', occurrencesByFile: new Map() }),
        dispose: async () => {
            disposeCount += 1;
        },
    };
    const { Context } = await import('../../core/context.js');
    const context = new Context({
        semanticAnalyzer: mockAnalyzer,
        embedding: {
            getProvider: () => 'mock',
            getDimension: () => 10,
            getIdentity: () => ({
                provider: 'mock',
                model: 'mock-model',
                dimension: 10,
                artifactDigest: null,
                normalizationPolicy: 'provider_output_v1',
            }),
            embed: async () => [],
            close: async () => {},
        } as any,
        vectorDatabase: {
            search: async () => [],
        } as any,
    });

    await Promise.all([
        context.dispose(),
        context.dispose(),
        context.dispose(),
    ]);

    assert.equal(disposeCount, 1);
});

const SMALL_GO_PROJECT = {
    language: 'go',
    auxiliaryFiles: [],
    sourceFiles: [{
        path: 'main.go',
        source: 'package main\nfunc Helper() {}\nfunc Caller() { Helper() }\n',
        sourceHash: 'small-source',
    }],
};

test('ThreadedWasmSemanticProjectAnalyzer releases an idle worker and starts a new one on demand', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer(undefined, { idleReleaseMs: 20 });
    try {
        const first = await analyzer.analyze(SMALL_GO_PROJECT);
        assert.ok((first.occurrencesByFile.get('main.go')?.length ?? 0) > 0);
        assert.equal(analyzer.hasLiveWorker(), true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(analyzer.hasLiveWorker(), false, 'idle worker must be released');

        const second = await analyzer.analyze(SMALL_GO_PROJECT);
        assert.deepEqual(
            [...second.occurrencesByFile.entries()],
            [...first.occurrencesByFile.entries()],
        );
    } finally {
        await analyzer.dispose();
    }
});

test('ThreadedWasmSemanticProjectAnalyzer rejects a request past its deadline and stops the stuck worker', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer(undefined, { requestTimeoutMs: 1 });
    try {
        await assert.rejects(analyzer.analyze(SMALL_GO_PROJECT), /timed out after 1 ms/);
        assert.equal(analyzer.hasLiveWorker(), false);
    } finally {
        await analyzer.dispose();
    }
});

test('explicit idle semantic release awaits exit and preserves subsequent evidence', async () => {
    const analyzer = new ThreadedWasmSemanticProjectAnalyzer();
    try {
        const expected = await analyzer.analyze(SMALL_GO_PROJECT);
        const worker = (analyzer as unknown as { worker: import('node:worker_threads').Worker }).worker;
        await analyzer.releaseIdleWorker();
        assert.equal(worker.threadId, -1, 'returned before the semantic isolate exited');
        assert.equal(analyzer.hasLiveWorker(), false);
        const actual = await analyzer.analyze(SMALL_GO_PROJECT);
        assert.deepEqual(actual, expected);
    } finally { await analyzer.dispose(); }
});
