import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getEventListeners } from 'node:events';
import { buildSearchProjections, type SearchProjectionInput } from '../../../packages/core/src/core/search-projections';
import type { SearchProjections } from '../../../packages/core/src/vectordb/types';
import { buildProjectionBatch, flatten, loadAddon, MAX_BYTES, type Cancellation, type Counts, type NativeAddon, type RawInput } from '../wrapper';
import { assertProjectionEqual } from '../compare';

function input(content = 'const parseHTTPResponse = raw_value + HTTPServer2;', metadata = {}, relativePath = 'src/http_parser.ts'): SearchProjectionInput {
    return { relativePath, chunk: { content, metadata: { startLine: 1, endLine: 1, ...metadata } } };
}
function counts(): Counts { return { total: 0, native: 0, fallback: 0, calls: 0 }; }
interface Barrier {
    started(): boolean;
    finished(): boolean;
    observedCancel(): boolean;
    release(): void;
}
interface TestAddon extends NativeAddon {
    ProjectionBarrier?: new () => Barrier;
    buildProjectionBatchForTest?: (inputs: RawInput[], token: Cancellation, fail?: number, panic?: number, barrier?: Barrier, limit?: number) => Promise<(SearchProjections | null)[]>;
}
let native: TestAddon;
const faultTests = process.env.NAPI_TEST_FAULTS === '1';

test('default lookup caches platform detection and the loaded addon', async () => {
    const original = process.report.getReport;
    let reports = 0;
    process.report.getReport = (...args: Parameters<typeof original>) => { reports++; return original.apply(process.report, args); };
    try {
        native = loadAddon() as TestAddon;
        assert.ok(native, 'real compiled addon must load');
        const first = await buildProjectionBatch([input()]);
        const second = await buildProjectionBatch([input()]);
        assert.deepEqual(first, second);
        assert.equal(reports, process.platform === 'linux' ? 1 : 0);
        assert.equal(loadAddon(), native);
    } finally { process.report.getReport = original; }
    assert.equal(typeof native.buildProjectionBatchForTest, faultTests ? 'function' : 'undefined');
    assert.equal(typeof native.ProjectionBarrier, faultTests ? 'function' : 'undefined');
});

test('worker loads the native addon before receiving inputs and matches the reference', async () => {
    // Resolve the actual local platform file through the loader, then use it in a fresh worker.
    const { readdirSync } = await import('node:fs');
    const file = readdirSync(new URL('..', import.meta.url)).find(name => name.startsWith(`projection.${process.platform}-${process.arch}`) && name.endsWith('.node'));
    assert.ok(file);
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
        const addon = require(workerData);
        parentPort.postMessage('loaded');
        parentPort.once('message', async inputs => {
            try { parentPort.postMessage(await addon.buildProjectionBatch(inputs)); }
            catch (error) { throw error; }
        });`, { eval: true, workerData: fileURLToPath(new URL(`../${file}`, import.meta.url)) });
    const receive = (): Promise<unknown> => new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
    });
    try {
        assert.equal(await receive(), 'loaded');
        const fixture = input('HTTPServer_v2 parseHTTPResponse utf8Decode $scope __proto__ a$b$c', { symbolLabel: 'Owner.parseHTTPResponse', breadcrumbs: ['Owner', ''] });
        const response = receive();
        worker.postMessage([flatten(fixture)]);
        assert.deepEqual(await response, [buildSearchProjections(fixture)]);
    } finally { await worker.terminate(); }
});

const ascii = [
    input(), input(''), input('plain words here', { language: '', symbolKind: '', symbolLabel: '', breadcrumbs: [] }),
    input('a1B 2ABC abc123 ABC123d AABbCc HTTPServer2 utf8Decode snake_case a$b __$__', { symbolLabel: 'Parser.parseHTTPResponse', breadcrumbs: ['Parser', 'parseHTTPResponse'] }),
    input('line1\r\nline2\t"\\\b\f\0' + String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)), { language: 'a\n"\\', symbolKind: '\t', symbolLabel: '\u007f', breadcrumbs: ['', 'crumb\r\n'] }, 'path\nheader.ts'),
    input('A'.repeat(256), { symbolLabel: 'a'.repeat(255) + 'B' }),
    input(Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i % 128)).join('')),
    input('fooBar FooBar fooBar FOO_BAR fooBaz foobar', { breadcrumbs: ['fooBar', '', 'FooBar'] }),
];
test('real native fixtures preserve complete four-field byte output and order', async () => {
    const actual = await native.buildProjectionBatch(ascii.map(flatten));
    for (let i = 0; i < ascii.length; i++) {
        assert.ok(actual[i], `fixture ${i} must execute natively`);
        assertProjectionEqual(actual[i]!, buildSearchProjections(ascii[i]), `fixture ${i}`);
    }
    const metrics = counts();
    const wrapped = await buildProjectionBatch(ascii, { counts: metrics });
    assert.deepEqual(wrapped, ascii.map(buildSearchProjections));
    assert.equal(metrics.native, ascii.length);
    assert.equal(metrics.fallback, 0);
});

test('seeded ASCII token combinations are differential, including adjacent regex boundaries', async () => {
    let state = 424242;
    const chars = 'abCD09_$./- \n';
    const fixtures = Array.from({ length: 320 }, () => {
        let text = '';
        for (let n = 0; n < 80; n++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; text += chars[state % chars.length]; }
        return input(text, { symbolLabel: text, breadcrumbs: ['', text] });
    });
    const metrics = counts();
    const results = await buildProjectionBatch(fixtures, { counts: metrics });
    for (let i = 0; i < fixtures.length; i++) assertProjectionEqual(results[i], buildSearchProjections(fixtures[i]));
    assert.equal(metrics.native, fixtures.length);
    assert.equal(metrics.calls, 5);
});

test('Unicode, astral, lone surrogates, long tokens and excess breadcrumbs fall back unchanged', async () => {
    const unsupported = [input('café Δelta 東京'), input('😀'), input('\ud800'), input('\udfff'), input('x', {}, 'unicode/Ä.ts'),
        input('x', { language: '日本語' }), input('x', { symbolKind: 'méthode' }), input('x', { symbolLabel: 'ÄpfelBaum' }), input('x', { breadcrumbs: ['😀'] }),
        input('a'.repeat(257)), input('x', { symbolLabel: 'b'.repeat(257) }), input('x', { breadcrumbs: Array(257).fill('') }), input('x', { breadcrumbs: Array(4096).fill('') })];
    const metrics = counts();
    const values = await buildProjectionBatch([ascii[0], ...unsupported, ascii[1]], { counts: metrics });
    assert.deepEqual(values, [ascii[0], ...unsupported, ascii[1]].map(buildSearchProjections));
    assert.equal(metrics.native, 2);
    assert.equal(metrics.fallback, unsupported.length);
    // Lone surrogates never cross napi string conversion. Actual Unicode does, returning null.
    for (const fixture of unsupported.filter(f => !/[\ud800-\udfff]/u.test(f.chunk.content))) {
        assert.deepEqual(await native.buildProjectionBatch([flatten(fixture)]), [null]);
    }
});

test('invalid paths reject the whole wrapper request before dispatch or loader access', async () => {
    let loads = 0;
    for (const path of ['', './a', '../a', '/a', 'C:/a', 'a\\b', 'a//b', 'a\0b']) {
        await assert.rejects(buildProjectionBatch([input(), input('x', {}, path)], { loader: () => { loads++; return native; } }), /canonical repository-relative path/);
    }
    assert.equal(loads, 0);
});

test('raw count and aggregate UTF-8 bounds reject before scheduling, including metadata', async () => {
    assert.throws(() => native.buildProjectionBatch(Array.from({ length: 65 }, () => flatten(input()))), /64 inputs or 4 MiB/);
    assert.throws(() => native.buildProjectionBatch([flatten(input(' '.repeat(MAX_BYTES)))]), /64 inputs or 4 MiB/);
    assert.throws(() => native.buildProjectionBatch([flatten(input('', { breadcrumbs: [' '.repeat(MAX_BYTES)] }))]), /64 inputs or 4 MiB/);
    assert.throws(() => native.buildProjectionBatch([{ relativePath: 'a' } as RawInput]), /String|content/);
    const edge = input(' '.repeat(MAX_BYTES - 1), {}, 'a');
    assertProjectionEqual((await native.buildProjectionBatch([flatten(edge)]))[0]!, buildSearchProjections(edge));
    const metrics = counts();
    const oversized = input(' '.repeat(MAX_BYTES));
    assert.deepEqual(await buildProjectionBatch([oversized], { counts: metrics }), [buildSearchProjections(oversized)]);
    assert.equal(metrics.calls, 0);
    assert.equal(metrics.fallback, 1);
});

test('wrapper splits at byte and count limits while preserving order', async () => {
    const fixtures = [input(' '.repeat(MAX_BYTES / 2)), input(' '.repeat(MAX_BYTES / 2)), ...Array.from({ length: 65 }, (_, i) => input(`value${i}`))];
    const metrics = counts();
    const values = await buildProjectionBatch(fixtures, { counts: metrics });
    assert.deepEqual(values, fixtures.map(buildSearchProjections));
    assert.equal(metrics.native, fixtures.length);
    assert.equal(metrics.calls, 3);
});

test('missing addon and load exceptions use the reference, runtime rejection propagates', async () => {
    const fixture = [input()];
    assert.deepEqual(await buildProjectionBatch(fixture, { addonPath: '/does/not/exist.node' }), fixture.map(buildSearchProjections));
    assert.deepEqual(await buildProjectionBatch(fixture, { loader: () => { throw new Error('load exception'); } }), fixture.map(buildSearchProjections));
    const failure = new Error('native runtime failure');
    await assert.rejects(buildProjectionBatch(fixture, { loader: () => ({ ...native, buildProjectionBatch: async () => { throw failure; } }) }), error => error === failure);
});

test('pre-aborted signal starts no loader or native work and preserves the reason', async () => {
    const controller = new AbortController();
    const reason = new Error('caller reason');
    controller.abort(reason);
    await assert.rejects(buildProjectionBatch([input()], { signal: controller.signal, loader: () => { assert.fail('must not load'); } }), error => error === reason);
});

test('wrapper awaits injected native settlement on abort and removes its listener', async () => {
    const controller = new AbortController();
    const reason = new Error('abort reason');
    let release!: () => void;
    let cancelled = false;
    let settled = false;
    const pending = new Promise<(SearchProjections | null)[]>(resolve => { release = () => resolve([buildSearchProjections(input())]); });
    const addon: NativeAddon = { ProjectionCancellation: class { cancel(): void { cancelled = true; } }, buildProjectionBatch: () => pending };
    const work = buildProjectionBatch([input()], { signal: controller.signal, loader: () => addon });
    const rejection = assert.rejects(work, error => error === reason);
    work.then(() => { settled = true; }, () => { settled = true; });
    controller.abort(reason);
    await setImmediate();
    assert.equal(cancelled, true);
    assert.equal(settled, false);
    release();
    await rejection;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('real cooperative cancellation waits for compute exit', { skip: !faultTests }, async () => {
    const barrier = new native.ProjectionBarrier!();
    const controller = new AbortController();
    const reason = new Error('real cancellation');
    let nativeError: unknown;
    const addon: NativeAddon = { ProjectionCancellation: native.ProjectionCancellation,
        buildProjectionBatch: async (values, token) => {
            try { return await native.buildProjectionBatchForTest!(values, token!, undefined, undefined, barrier); }
            catch (error) { nativeError = error; throw error; }
        } };
    let settled = false;
    const work = buildProjectionBatch([input(), input()], { loader: () => addon, signal: controller.signal });
    const rejection = assert.rejects(work, error => error === reason);
    work.then(() => { settled = true; }, () => { settled = true; });
    try {
        while (!barrier.started()) await setImmediate();
        controller.abort(reason);
        await setImmediate();
        assert.equal(settled, false);
        assert.equal(barrier.finished(), false);
    } finally { barrier.release(); }
    await rejection;
    assert.equal(barrier.finished(), true);
    assert.equal(barrier.observedCancel(), true);
    assert.match(String(nativeError), /cancelled/, 'native compute must reject after observing the actual flag');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const token = new native.ProjectionCancellation();
    token.cancel();
    await assert.rejects(native.buildProjectionBatch([flatten(input())], token), /cancelled/);
});

test('injected mid-batch error and panic reject atomically, then next call succeeds', { skip: !faultTests }, async () => {
    for (const [fail, panic] of [[1, undefined], [undefined, 1]]) {
        const token = new native.ProjectionCancellation();
        await assert.rejects(native.buildProjectionBatchForTest!([flatten(input()), flatten(input())], token, fail, panic), /injected projection failure|panic contained/);
        assertProjectionEqual((await native.buildProjectionBatch([flatten(input())]))[0]!, buildSearchProjections(input()));
    }
});

test('native output budget returns unsure, discards temporary charges, and wrapper uses reference', { skip: !faultTests }, async () => {
    const large = input('someCompoundIdentifier anotherCompoundIdentifier', { symbolLabel: 'VeryLongCompoundSymbolIdentifierWithPrefixes' });
    const small = input('', {}, 'a');
    const token = new native.ProjectionCancellation();
    const raw = await native.buildProjectionBatchForTest!([flatten(large), flatten(small)], token, undefined, undefined, undefined, 2400);
    assert.equal(raw[0], null);
    assertProjectionEqual(raw[1]!, buildSearchProjections(small));
    const cumulative = await native.buildProjectionBatchForTest!([flatten(small), flatten(small)], token, undefined, undefined, undefined, 2000);
    assertProjectionEqual(cumulative[0]!, buildSearchProjections(small));
    assert.equal(cumulative[1], null, 'the output budget applies across the whole batch');
    const metrics = counts();
    const addon: NativeAddon = { ProjectionCancellation: native.ProjectionCancellation,
        buildProjectionBatch: (values, cancellation) => native.buildProjectionBatchForTest!(values, cancellation!, undefined, undefined, undefined, 1024) };
    assert.deepEqual(await buildProjectionBatch([large], { loader: () => addon, counts: metrics }), [buildSearchProjections(large)]);
    assert.equal(metrics.fallback, 1);
    assert.equal(metrics.native, 0);
});

test('comparison mutation fails and the restored native result passes', async () => {
    const expected = buildSearchProjections(input());
    const actual = (await native.buildProjectionBatch([flatten(input())]))[0]!;
    assertProjectionEqual(actual, expected);
    assert.throws(() => assertProjectionEqual({ ...actual, lexicalText: actual.lexicalText + 'CORRUPTED' }, expected), /projection mismatch/);
    assert.throws(() => assertProjectionEqual({ ...actual, embeddingVersion: 'CORRUPTED' }, expected), /projection mismatch/);
    assertProjectionEqual(actual, expected);
});


test('explicit null cancellation reason survives before dispatch and after native settlement', async () => {
    const preAborted = AbortSignal.abort(null);
    await assert.rejects(buildProjectionBatch([input()], {
        signal: preAborted, loader: () => { assert.fail('must not load'); },
    }), reason => reason === null);
    const controller = new AbortController();
    let release!: () => void;
    let cancelled = false;
    let settled = false;
    const pending = new Promise<(SearchProjections | null)[]>(resolve => {
        release = () => resolve([buildSearchProjections(input())]);
    });
    const addon: NativeAddon = {
        ProjectionCancellation: class { cancel(): void { cancelled = true; } },
        buildProjectionBatch: () => pending,
    };
    const work = buildProjectionBatch([input()], { signal: controller.signal, loader: () => addon });
    const rejection = assert.rejects(work, reason => reason === null);
    work.then(() => { settled = true; }, () => { settled = true; });
    controller.abort(null);
    await setImmediate();
    assert.equal(cancelled, true);
    assert.equal(settled, false);
    release();
    await rejection;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
