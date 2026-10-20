import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { buildSearchProjections, type SearchProjectionInput } from './search-projections';
import {
    buildProjectionBatch,
    createConfiguredNativeProjectionBatchBuilder,
    createNativeProjectionBatchBuilder,
    flatten,
    loadAddon,
    MAX_BYTES,
    nativeProjectionBinding,
    projectionInputBytes,
    rawBytes,
    type Counts,
    type NativeAddon,
    type RawInput,
} from './native-search-projections';
import type { SearchProjections } from '../vectordb/types';

function input(content = 'parseHTTPResponse raw_value', metadata = {}, relativePath = 'src/parser.ts'): SearchProjectionInput {
    return { relativePath, chunk: { content, metadata: { startLine: 1, endLine: 1, ...metadata } } };
}

function reference(raw: RawInput): SearchProjections {
    const { content, relativePath, ...metadata } = raw;
    return buildSearchProjections(input(content, metadata, relativePath));
}

function binding(onBatch: (inputs: RawInput[]) => void = () => {}): NativeAddon {
    return {
        ProjectionCancellation: class { cancel(): void {} },
        buildProjectionBatch: async inputs => { onBatch(inputs); return inputs.map(reference); },
    };
}

test('batch policy preserves projections, validates paths and bounds dispatch by count and bytes', async () => {
    const batches: RawInput[][] = [];
    const addon = binding(inputs => {
        assert.ok(inputs.length <= 64);
        assert.ok(inputs.reduce((sum, value) => sum + rawBytes(value), 0) <= MAX_BYTES);
        batches.push(inputs);
    });
    const fixtures = [
        input(' '.repeat(MAX_BYTES / 2)), input(' '.repeat(MAX_BYTES / 2)),
        ...Array.from({ length: 65 }, (_, i) => input(`value${i}`)),
        input('café'), input('😀'), input('\ud800'), input('\udfff'),
        input('x', { breadcrumbs: ['Ä'] }), input('a'.repeat(257)),
        input('x', { breadcrumbs: Array(257).fill('') }), input(' '.repeat(MAX_BYTES)),
    ];
    const counts: Counts = { total: 0, native: 0, fallback: 0, calls: 0 };
    const actual = await buildProjectionBatch(fixtures, { loader: () => addon, counts });
    assert.deepEqual(actual, fixtures.map(buildSearchProjections));
    assert.deepEqual(counts, { total: 75, native: 67, fallback: 8, calls: 3 });
    assert.deepEqual(batches.map(batch => batch.length), [1, 64, 2]);
    for (const fixture of fixtures) assert.equal(projectionInputBytes(fixture), rawBytes(flatten(fixture)));
    await assert.rejects(buildProjectionBatch([input(), input('x', {}, '../escape')], {
        loader: () => { assert.fail('invalid paths must fail before loading'); },
    }), /canonical repository-relative path/);
});

test('only explicit absolute native paths load, absence and unsure results use the reference', async () => {
    for (const path of [undefined, './projection.node', '/missing.node', '/tmp/wrong.js']) {
        assert.equal(loadAddon(path), undefined);
    }
    const fixtures = [input(), input('otherValue')];
    for (const loader of [() => undefined, () => { throw new Error('loader failed'); }]) {
        assert.deepEqual(await buildProjectionBatch(fixtures, { loader }), fixtures.map(buildSearchProjections));
    }
    const counts: Counts = { total: 0, native: 0, fallback: 0, calls: 0 };
    assert.deepEqual(await buildProjectionBatch(fixtures, {
        loader: () => ({ ...binding(), buildProjectionBatch: async values => values.map(() => null) }), counts,
    }), fixtures.map(buildSearchProjections));
    assert.deepEqual(counts, { total: 2, native: 0, fallback: 2, calls: 1 });
    const failure = new Error('native failure');
    await assert.rejects(buildProjectionBatch(fixtures, {
        loader: () => ({ ...binding(), buildProjectionBatch: async () => { throw failure; } }),
    }), error => error === failure);
    await assert.rejects(buildProjectionBatch(fixtures, {
        loader: () => ({ ...binding(), buildProjectionBatch: async () => [] }),
    }), /batch length mismatch/);
});

for (const reason of [null, new Error('caller cancellation'), 'caller string', undefined]) {
    test(`cancellation preserves ${String(reason)} and drains native settlement`, async () => {
        const controller = new AbortController();
        let release!: () => void;
        let cancelled = false;
        let settled = false;
        const pending = new Promise<(SearchProjections | null)[]>(resolve => {
            release = () => resolve([buildSearchProjections(input())]);
        });
        const work = buildProjectionBatch([input()], {
            signal: controller.signal,
            loader: () => ({
                ProjectionCancellation: class { cancel(): void { cancelled = true; } },
                buildProjectionBatch: () => pending,
            }),
        });
        const rejection = assert.rejects(work, error => error === controller.signal.reason);
        work.then(() => { settled = true; }, () => { settled = true; });
        try {
            controller.abort(reason);
            await setImmediate();
            assert.equal(cancelled, true);
            assert.equal(settled, false);
        } finally { release(); }
        await rejection;
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        await assert.rejects(buildProjectionBatch([input()], {
            signal: controller.signal, loader: () => { assert.fail('pre-aborted request loaded'); },
        }), error => error === controller.signal.reason);
    });
}

test('operation captures configuration, signal and addon once and reports aggregate counts once', async t => {
    const previous = process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS;
    const trace = process.env.SATORI_PERF_TRACE;
    t.after(() => {
        if (previous === undefined) delete process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS;
        else process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = previous;
        if (trace === undefined) delete process.env.SATORI_PERF_TRACE;
        else process.env.SATORI_PERF_TRACE = trace;
    });
    delete process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS;
    assert.equal(createConfiguredNativeProjectionBatchBuilder(() => { assert.fail('disabled feature requested a signal'); }), undefined);
    process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '';
    assert.equal(createConfiguredNativeProjectionBatchBuilder(), undefined);
    process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '/explicit/addon.node';
    process.env.SATORI_PERF_TRACE = '1';
    let loads = 0;
    let signals = 0;
    t.mock.method(nativeProjectionBinding, 'load', (path: string) => {
        assert.equal(path, '/explicit/addon.node'); loads++; return binding();
    });
    const lines: string[] = [];
    t.mock.method(process.stderr, 'write', (line: string | Uint8Array) => { lines.push(String(line)); return true; });
    const builder = createConfiguredNativeProjectionBatchBuilder(() => { signals++; return new AbortController().signal; });
    assert.ok(builder);
    process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '/changed/addon.node';
    await builder.build([input()]);
    await builder.build([input('😀')]);
    builder.report();
    builder.report();
    assert.equal(loads, 1);
    assert.equal(signals, 1);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0].slice('[perf] '.length));
    assert.deepEqual({ ...record, ms: 0 }, {
        span: 'payload.native_projections', total: 2, native: 1, fallback: 1, calls: 1, ms: 0,
    });
    assert.ok(record.ms >= 0);
});

test('prepare shares canonical validation and native policy while finish alone computes fallback', async () => {
    let loads = 0;
    const counts: Counts = { total: 0, native: 0, fallback: 0, calls: 0 };
    const builder = createNativeProjectionBatchBuilder({ counts, loader: () => {
        loads++;
        return { ...binding(), buildProjectionBatch: async values => values.map(() => null) };
    } });
    await assert.rejects(builder.prepare([input(), input('invalid', {}, '../escape')]), /canonical repository-relative path/);
    assert.equal(loads, 0);
    const fixtures = [input(), input('café'), input('x', { breadcrumbs: Array(257).fill('') })];
    const prepared = await builder.prepare(fixtures);
    assert.deepEqual(prepared, [null, null, null]);
    assert.deepEqual(counts, { total: 3, native: 0, fallback: 0, calls: 1 });
    assert.deepEqual(builder.finish(fixtures[0], prepared[0]), buildSearchProjections(fixtures[0]));
    assert.deepEqual(counts, { total: 3, native: 0, fallback: 1, calls: 1 });
    await builder.prepare([input('otherValue')]);
    assert.equal(loads, 1);
    assert.equal(counts.fallback, 1, 'unconsumed null results do not invoke fallback');
});

test('local cancellation preserves null and cancels every native flag without aborting the caller', async () => {
    const root = new AbortController();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let cancelled = 0;
    let settled = 0;
    const builder = createNativeProjectionBatchBuilder({ signal: root.signal, loader: () => ({
        ProjectionCancellation: class { cancel(): void { cancelled++; } },
        buildProjectionBatch: async values => { await barrier; settled++; return values.map(reference); },
    }) });
    const tasks = Array.from({ length: 4 }, () => builder.prepare([input()]));
    const rejections = tasks.map(task => assert.rejects(task, reason => reason === null));
    builder.cancel(null);
    assert.equal(cancelled, 4);
    assert.equal(root.signal.aborted, false);
    assert.equal(settled, 0);
    release();
    await Promise.all(rejections);
    assert.equal(settled, 4);
    assert.throws(() => builder.finish(input(), null), reason => reason === null);
});
