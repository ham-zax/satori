import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { streamIndexingProjections, type IndexingProjectionEvent, type ProjectionQueueTelemetry } from './indexing-projection-stream';
import { createNativeProjectionBatchBuilder, MAX_BYTES, type NativeAddon, type RawInput, type Counts } from './native-search-projections';
import { buildSearchProjections, type SearchProjectionInput } from './search-projections';
import type { SearchProjections } from '../vectordb/types';

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}
function chunk(index: number, content = `value${index}`, fileIndex = 0): Extract<IndexingProjectionEvent, { kind: 'chunk' }> {
    return {
        kind: 'chunk', fileIndex, filePath: `file${fileIndex}.ts`, fileChunkIndex: index,
        input: { relativePath: `file${fileIndex}.ts`, chunk: { content, metadata: { startLine: 1, endLine: 1 } } },
    };
}
function reference(raw: RawInput): SearchProjections {
    const { content, relativePath, ...metadata } = raw;
    return buildSearchProjections({ relativePath, chunk: { content, metadata: { startLine: 1, endLine: 1, ...metadata } } });
}
async function* events(count: number, smallFiles = false): AsyncGenerator<IndexingProjectionEvent> {
    for (let index = 0; index < count; index++) {
        const event = chunk(smallFiles ? 0 : index, `value${index}`, smallFiles ? index : 0);
        yield event;
        if (smallFiles) yield { kind: 'file-complete', filePath: event.filePath, fileIndex: event.fileIndex };
    }
    if (!smallFiles) yield { kind: 'file-complete', filePath: 'file0.ts', fileIndex: 0 };
}
function controlled(signal?: AbortSignal) {
    const started = [gate(), gate(), gate(), gate(), gate(), gate()];
    const releases = started.map(() => gate());
    let calls = 0;
    let running = 0;
    let settled = 0;
    let cancelled = 0;
    const addon: NativeAddon = {
        ProjectionCancellation: class { cancel(): void { cancelled++; } },
        buildProjectionBatch: async inputs => {
            const index = calls++;
            running++;
            started[index]?.release();
            try { await releases[index].promise; return inputs.map(reference); }
            finally { running--; settled++; }
        },
    };
    return {
        builder: createNativeProjectionBatchBuilder({ loader: () => addon, signal }), started, releases,
        state: () => ({ calls, running, settled, cancelled }),
    };
}

for (const smallFiles of [true, false]) {
    test(`ordered output follows bounded native batches across ${smallFiles ? '641 files' : '641 chunks'}`, async () => {
        const batches: number[] = [];
        const builder = createNativeProjectionBatchBuilder({ loader: () => ({
            ProjectionCancellation: class { cancel(): void {} },
            buildProjectionBatch: async inputs => { batches.push(inputs.length); return inputs.map(reference); },
        }) });
        const output = [];
        for await (const event of streamIndexingProjections(events(641, smallFiles), builder)) output.push(event);
        const expected = [];
        for await (const event of events(641, smallFiles)) {
            expected.push(event.kind === 'chunk' ? { ...event, projections: buildSearchProjections(event.input) } : event);
        }
        assert.deepEqual(output, expected);
        assert.deepEqual(batches, [...Array<number>(10).fill(64), 1]);
        assert.equal(output.length, smallFiles ? 1282 : 642);
    });
}

test('zero-chunk windows submit no native work', async () => {
    let calls = 0;
    const builder = createNativeProjectionBatchBuilder({ loader: () => ({
        ProjectionCancellation: class { cancel(): void {} },
        buildProjectionBatch: async inputs => { calls++; return inputs.map(reference); },
    }) });
    async function* source(): AsyncGenerator<IndexingProjectionEvent> {
        for (let index = 0; index < 257; index++) {
            yield { kind: 'file-complete', filePath: `empty${index}.ts`, fileIndex: index };
        }
    }
    let callbacks = 0;
    for await (const event of streamIndexingProjections(source(), builder)) {
        assert.equal(event.kind, 'file-complete');
        callbacks++;
    }
    assert.equal(callbacks, 257);
    assert.equal(calls, 0);
});

for (const reason of [null, new Error('lease lost at batch entry')]) {
    test(`consumer failure preserves ${String(reason)} and drains tasks and source before rejection`, async () => {
        const root = new AbortController();
        const work = controlled(root.signal);
        const closeStarted = gate();
        const closeRelease = gate();
        let closed = false;
        let yielded = 0;
        let returned = false;
        async function* source() {
            try { yield* events(400, true); }
            finally { closeStarted.release(); await closeRelease.promise; closed = true; }
        }
        const operation = (async () => {
            for await (const event of streamIndexingProjections(source(), work.builder)) {
                void event; yielded++; throw reason;
            }
        })();
        operation.then(() => { returned = true; }, () => { returned = true; });
        const rejected = assert.rejects(operation, error => error === reason);
        rejected.catch(() => undefined);
        try {
            await work.started[3].promise;
            work.releases[0].release();
            await setImmediate();
            assert.equal(yielded, 1);
            await closeStarted.promise;
            assert.deepEqual(work.state(), { calls: 4, running: 3, settled: 1, cancelled: 3 });
            assert.equal(yielded, 1);
            assert.equal(returned, false);
            assert.equal(closed, false);
            work.releases.forEach(item => item.release());
            await setImmediate();
            assert.equal(work.state().settled, 4);
            assert.equal(returned, false, 'the pending source close still belongs to this operation');
            closeRelease.release();
            await rejected;
            assert.equal(closed, true);
            assert.equal(root.signal.aborted, false);
            assert.equal(work.state().running, 0);
            assert.equal(yielded, 1);
            assert.equal(yielded, 1);
        } finally {
            work.releases.forEach(item => item.release()); closeRelease.release();
            await operation.catch(() => undefined);
        }
    });
}

for (const smallFiles of [true, false]) {
    test(`four binding calls overlap across ${smallFiles ? 'small files' : 'a large file'} and deliver in order`, async () => {
        const work = controlled();
        let telemetry: ProjectionQueueTelemetry | undefined;
        const output: unknown[] = [];
        const operation = (async () => {
            for await (const event of streamIndexingProjections(events(320, smallFiles), work.builder, {
                onTelemetry: metrics => { telemetry = metrics; },
            })) output.push(event);
        })();
        try {
            await work.started[3].promise;
            assert.deepEqual(work.state(), { calls: 4, running: 4, settled: 0, cancelled: 0 });
            work.releases[3].release(); work.releases[2].release(); work.releases[1].release();
            await setImmediate();
            assert.equal(output.length, 0);
            assert.equal(work.state().calls, 4, 'completed jobs still own their slots');
            work.releases[0].release();
            await work.started[4].promise;
            work.releases[4].release();
            await operation;
            const expected = [];
            for await (const event of events(320, smallFiles)) {
                expected.push(event.kind === 'chunk' ? { ...event, projections: buildSearchProjections(event.input) } : event);
            }
            assert.deepEqual(output, expected);
            assert.equal(telemetry?.peakRetainedBatches, 4);
            assert.equal(telemetry?.maxOverlappingWork, 4);
            assert.ok(telemetry!.peakRetainedInputBytes <= 4 * MAX_BYTES);
            assert.equal(work.state().running, 0);
        } finally {
            work.releases.forEach(item => item.release());
            await operation;
        }
    });
}

test('a partially yielded batch retains its slot alongside three ready batches', async () => {
    const work = controlled();
    let telemetry: ProjectionQueueTelemetry | undefined;
    const iterator = streamIndexingProjections(events(384), work.builder, { onTelemetry: value => { telemetry = value; } });
    const first = iterator.next();
    try {
        await work.started[3].promise;
        work.releases.slice(0, 4).forEach(item => item.release());
        assert.equal((await first).value?.kind, 'chunk');
        await setImmediate();
        assert.equal(work.state().calls, 4, 'yielding + three ready slots prevent replacement');
        await iterator.return();
        assert.equal(work.state().calls, 4);
        assert.equal(work.state().settled, 4);
        assert.equal(telemetry?.peakRetainedBatches, 4);
    } finally { work.releases.forEach(item => item.release()); await iterator.return(); }
});

test('early return cancels local work, awaits every call and closes the source without aborting the caller', async () => {
    const root = new AbortController();
    const work = controlled(root.signal);
    let closed = false;
    async function* source() {
        try { yield* events(400); }
        finally { closed = true; }
    }
    const iterator = streamIndexingProjections(source(), work.builder);
    const first = iterator.next();
    let returned = false;
    try {
        await work.started[3].promise;
        work.releases[0].release();
        await first;
        const returning = iterator.return().then(() => { returned = true; });
        await setImmediate();
        assert.equal(returned, false);
        assert.equal(closed, true);
        assert.equal(root.signal.aborted, false);
        assert.equal(work.state().cancelled, 3);
        work.releases.forEach(item => item.release());
        await returning;
        assert.equal(work.state().settled, 4);
        assert.equal(work.state().running, 0);
    } finally { work.releases.forEach(item => item.release()); await iterator.return(); }
});

test('later native failure stops submission and follows earlier chunks and callbacks with original file context', async () => {
    const release = gate();
    const failed = gate();
    const failure = { native: 'failure' };
    let calls = 0;
    const builder = createNativeProjectionBatchBuilder({ loader: () => ({
        ProjectionCancellation: class { cancel(): void {} },
        buildProjectionBatch: async inputs => {
            if (++calls === 2) { failed.release(); throw failure; }
            await release.promise;
            return inputs.map(reference);
        },
    }) });
    const output: IndexingProjectionEvent[] = [];
    const operation = (async () => {
        for await (const event of streamIndexingProjections(events(400, true), builder)) output.push(event);
    })();
    try {
        await failed.promise;
        await setImmediate();
        assert.equal(calls, 2);
        assert.equal(output.length, 0);
        release.release();
        await operation;
        assert.equal(output.length, 129);
        assert.equal(output[127].kind, 'file-complete');
        assert.deepEqual(output[128], { kind: 'file-error', filePath: 'file64.ts', fileIndex: 64, error: failure });
    } finally { release.release(); await operation; }
});

test('partial source data precedes a tagged source failure and source closes', async () => {
    const failure = new Error('file read failed');
    let closed = false;
    async function* source(): AsyncGenerator<IndexingProjectionEvent> {
        try {
            yield chunk(0);
            yield { kind: 'file-complete', filePath: 'file0.ts', fileIndex: 0 };
            yield chunk(0, 'otherValue', 1);
            yield { kind: 'file-error', filePath: 'file1.ts', fileIndex: 1, error: failure };
            assert.fail('source continued after a terminal event');
        } finally { closed = true; }
    }
    const builder = createNativeProjectionBatchBuilder();
    const output = [];
    for await (const event of streamIndexingProjections(source(), builder)) output.push(event);
    assert.deepEqual(output.map(event => event.kind), ['chunk', 'file-complete', 'chunk', 'file-error']);
    assert.equal((output[3] as { error: unknown }).error, failure);
    assert.equal(closed, true);
});

test('an iterator throw still flushes partial source data before the original failure', async () => {
    const failure = new Error('source iterator failed');
    async function* source(): AsyncGenerator<IndexingProjectionEvent> { yield chunk(0); throw failure; }
    const output = [];
    for await (const event of streamIndexingProjections(source(), createNativeProjectionBatchBuilder())) output.push(event);
    assert.equal(output[0].kind, 'chunk');
    assert.deepEqual(output[1], { kind: 'file-error', filePath: 'file0.ts', fileIndex: 0, error: failure });
});

test('unsupported and unsure fallback computes only the next consumed chunk', async () => {
    let consumedReads = 0;
    let consuming = false;
    const inputs = [chunk(0, 'café'), chunk(1, 'asciiValue'), chunk(2, '😀'), chunk(3, '\ud800')];
    // Measurement and flattening each read content once. Any further read belongs
    // to reference projection and must happen inside ordered consumption.
    for (const event of inputs) {
        const content = event.input.chunk.content;
        let reads = 0;
        Object.defineProperty(event.input.chunk, 'content', {
            enumerable: true, get: () => {
                if (++reads > 2) { assert.equal(consuming, true); consumedReads++; }
                return content;
            },
        });
    }
    const counts: Counts = { total: 0, native: 0, fallback: 0, calls: 0 };
    const canonical = createNativeProjectionBatchBuilder({ counts, loader: () => ({
        ProjectionCancellation: class { cancel(): void {} }, buildProjectionBatch: async values => values.map(() => null),
    }) });
    let finished = 0;
    const builder = { ...canonical, finish: (input: SearchProjectionInput, result: SearchProjections | null) => {
        consuming = true;
        try { finished++; return canonical.finish(input, result); }
        finally { consuming = false; }
    } };
    async function* source() { yield* inputs; }
    const iterator = streamIndexingProjections(source(), builder);
    await iterator.next();
    assert.equal(finished, 1);
    assert.equal(counts.fallback, 1);
    assert.equal(counts.total, 4);
    await iterator.return();
    assert.equal(finished, 1);
    assert.equal(counts.fallback, 1);
    assert.ok(consumedReads > 0);
});

test('byte limits, a single carry, oversized fallback and zero-chunk event caps stay bounded', async () => {
    const observed: Array<{ count: number; bytes: number }> = [];
    let telemetry: ProjectionQueueTelemetry | undefined;
    const large = ' '.repeat(MAX_BYTES / 2);
    const inputs = [chunk(0, large), chunk(1, large), chunk(2, ' '.repeat(MAX_BYTES + 1)), chunk(3)];
    let emitted = 0;
    async function* source(): AsyncGenerator<IndexingProjectionEvent> {
        for (const input of inputs) { emitted++; yield input; }
        for (let index = 1; index <= 600; index++) {
            emitted++;
            yield { kind: 'file-complete', filePath: `empty${index}.ts`, fileIndex: index };
        }
    }
    const builder = createNativeProjectionBatchBuilder({ loader: () => ({
        ProjectionCancellation: class { cancel(): void {} },
        buildProjectionBatch: async values => {
            observed.push({ count: values.length, bytes: values.reduce((sum, value) => sum + Buffer.byteLength(value.content) + Buffer.byteLength(value.relativePath), 0) });
            return values.map(reference);
        },
    }) });
    const iterator = streamIndexingProjections(source(), builder, { onTelemetry: value => { telemetry = value; } });
    const first = await iterator.next();
    assert.equal(first.value?.kind, 'chunk');
    await setImmediate();
    // Three input batches plus one bounded event batch fill the queue. No list of empty files accumulates.
    assert.ok(emitted <= 132);
    let completions = 0;
    for await (const event of iterator) if (event.kind === 'file-complete') completions++;
    assert.equal(completions, 600);
    assert.ok(observed.every(batch => batch.count <= 64 && batch.bytes <= MAX_BYTES));
    assert.equal(observed.length, 3);
    assert.equal(telemetry?.peakRetainedBatches, 4);
    assert.ok(telemetry!.peakRetainedInputBytes <= 4 * MAX_BYTES + MAX_BYTES + 100);
});


test('four retained normal windows bound input bytes even while the consumer holds the first event', async () => {
    const release = gate();
    const started = gate();
    let calls = 0;
    let emitted = 0;
    let telemetry: ProjectionQueueTelemetry | undefined;
    const content = ' '.repeat(1024 * 1024);
    async function* source(): AsyncGenerator<IndexingProjectionEvent> {
        for (let index = 0; index < 64; index++) { emitted++; yield chunk(index, content); }
    }
    const builder = createNativeProjectionBatchBuilder({ loader: () => ({
        ProjectionCancellation: class { cancel(): void {} },
        buildProjectionBatch: async values => {
            assert.equal(values.length, 3);
            if (++calls === 4) started.release();
            await release.promise;
            return values.map(() => null);
        },
    }) });
    const iterator = streamIndexingProjections(source(), builder, { onTelemetry: value => { telemetry = value; } });
    const first = iterator.next();
    try {
        await started.promise;
        assert.equal(calls, 4);
        assert.equal(emitted, 13, 'four windows of three chunks plus one carry');
        release.release();
        await first;
        await iterator.return();
        assert.equal(telemetry?.peakRetainedBatches, 4);
        assert.ok(telemetry!.peakRetainedInputBytes <= 4 * MAX_BYTES);
        assert.ok(telemetry!.peakRetainedInputBytes > 12 * 1024 * 1024);
    } finally { release.release(); await iterator.return(); }
});

for (const reason of [null, 'root stop', new Error('root failure')]) {
    test(`external abort preserves ${String(reason)} and joins all four tasks`, async () => {
        const root = new AbortController();
        const work = controlled(root.signal);
        const output: IndexingProjectionEvent[] = [];
        let returned = false;
        const operation = (async () => {
            for await (const event of streamIndexingProjections(events(400), work.builder)) {
                output.push(event);
                if (event.kind === 'file-error') throw event.error;
            }
        })();
        operation.then(() => { returned = true; }, () => { returned = true; });
        const rejected = assert.rejects(operation, error => error === reason);
        try {
            await work.started[3].promise;
            root.abort(reason);
            await setImmediate();
            assert.equal(work.state().cancelled, 4);
            assert.equal(returned, false);
            work.releases[0].release();
            await setImmediate();
            assert.equal(returned, false);
            work.releases.forEach(item => item.release());
            await rejected;
            assert.equal(work.state().settled, 4);
            assert.equal(work.state().running, 0);
            assert.equal(output.length, 1);
        } finally { work.releases.forEach(item => item.release()); await operation.catch(() => undefined); }
    });
}


test('cancellation at a zero-chunk boundary preserves null and closes the source', async () => {
    const root = new AbortController();
    let closed = false;
    async function* source(): AsyncGenerator<IndexingProjectionEvent> {
        try {
            for (let index = 0; index < 300; index++) {
                yield { kind: 'file-complete', filePath: `empty${index}.ts`, fileIndex: index };
            }
        } finally { closed = true; }
    }
    const builder = createNativeProjectionBatchBuilder({ signal: root.signal });
    const iterator = streamIndexingProjections(source(), builder);
    assert.equal((await iterator.next()).value?.kind, 'file-complete');
    root.abort(null);
    await assert.rejects(iterator.next(), error => error === null);
    assert.equal(closed, true);
});

test('a pre-aborted operation starts no zero-chunk callbacks', async () => {
    const root = new AbortController();
    root.abort(null);
    async function* source(): AsyncGenerator<IndexingProjectionEvent> {
        yield { kind: 'file-complete', filePath: 'empty.ts', fileIndex: 0 };
    }
    const iterator = streamIndexingProjections(source(), createNativeProjectionBatchBuilder({ signal: root.signal }));
    await assert.rejects(iterator.next(), error => error === null);
});
