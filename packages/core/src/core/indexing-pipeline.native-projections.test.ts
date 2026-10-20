import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { IndexingPipeline } from './indexing-pipeline';
import { buildSearchProjections } from './search-projections';
import { MAX_BYTES, nativeProjectionBinding, rawBytes, type NativeAddon, type RawInput } from './native-search-projections';
import { createAnalysisChunkPlan } from '../language-analysis/chunks';
import type { LanguageAnalysisInput, LanguageAnalysisPort, LanguageAnalysisResult } from '../language-analysis/types';
import type { IndexingAnalysisResult } from '../language-analysis/indexing-analysis';
import type { Embedding, EmbeddingIdentity } from '../embedding';
import type { IndexedVectorDocument, VectorDatabase } from '../vectordb/types';
import type { RepositoryRelativePath } from '../paths/repository-path';
import { IndexingResourcePlanner } from '../indexing/resources';

function gate(): { promise: Promise<void>; release(): void } {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

function reference(raw: RawInput) {
    const { content, relativePath, ...metadata } = raw;
    return buildSearchProjections({ relativePath, chunk: { content, metadata: { startLine: 1, endLine: 1, ...metadata } } });
}

function addon(onBatch: (inputs: RawInput[]) => void = () => {}): NativeAddon {
    return {
        ProjectionCancellation: class { cancel(): void {} },
        buildProjectionBatch: async inputs => { onBatch(inputs); return inputs.map(reference); },
    };
}

function analyzer(mode: 'eager' | 'deferred', chunkSize: number): LanguageAnalysisPort {
    const evidence = {
        backend: 'bounded_text' as const, structuralStatus: 'complete' as const,
        symbols: [], moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [],
    };
    const options = { chunkSize, chunkOverlap: 0 };
    const eager: LanguageAnalysisPort = {
        getDescription: () => 'projection fixture analyzer',
        getStrategyForLanguage: () => ({ backend: 'bounded_text', structural: false }),
        analyze: async input => ({
            ...evidence,
            chunks: [...createAnalysisChunkPlan(input.content, input.relativePath, input.language, [], options).chunks()]
                .map(chunk => ({ ...chunk, metadata: { ...chunk.metadata, filePath: '/untrusted/path.ts' } })),
        }),
    };
    if (mode === 'eager') return eager;
    return Object.assign(eager, {
        analyzeForIndexing: async (_input: LanguageAnalysisInput): Promise<IndexingAnalysisResult> => ({
            ...evidence, chunkPlan: { kind: 'symbols', options },
        }),
    });
}

const identity: EmbeddingIdentity = {
    provider: 'test', model: 'projection-fixture', dimension: 2, artifactDigest: null, normalizationPolicy: 'none',
};

function fixturePipeline(input: {
    analyzer: LanguageAnalysisPort;
    sources: Readonly<Record<string, string>>;
    embed?: (texts: string[]) => Promise<void>;
    read?: (file: string) => Promise<void>;
    signal?: () => AbortSignal;
    hardTokenLimit?: number;
    onFileProcessed?: (file: string) => void;
    queuedEmbeddingTextBytes?: number;
}) {
    const documents: IndexedVectorDocument[] = [];
    const embeddingInputs: string[][] = [];
    const callbacks: string[] = [];
    const embedding = {
        getIdentity: () => identity,
        getBatchPolicy: () => ({ preferredMaxItems: 4, hardMaxItems: 1000, maxConcurrentRequests: 1, hardTokenLimit: input.hardTokenLimit }),
        embedDocuments: async (texts: string[]) => {
            embeddingInputs.push([...texts]);
            await input.embed?.(texts);
            return texts.map(text => ({ vector: [text.length, 1], dimension: 2 }));
        },
    } as unknown as Embedding;
    const database = {
        writeDocuments: async (_collection: string, rows: IndexedVectorDocument[]) => { documents.push(...rows); },
    } as unknown as VectorDatabase;
    const pipeline = new IndexingPipeline({
        getVectorDatabase: () => database, languageAnalyzer: input.analyzer,
        getEmbedding: () => embedding, assertEmbeddingIdentityCurrent: () => identity,
        getMutationSignal: input.signal ?? (() => { assert.fail('disabled native feature requested a lease'); }),
        isHybridEnabled: () => false, canonicalizeCodebasePath: value => value,
        normalizeRelativePathForCodebase: (_root, file) => file.slice('/repo/'.length) as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'fixture-v1', repositoryVocabularyEnabled: false,
    });
    pipeline.readIndexableFileObservationInsideRoot = async file => {
        await input.read?.(file);
        const content = input.sources[file];
        assert.equal(typeof content, 'string', `missing fixture ${file}`);
        return {
            content, sourceHash: createHash('sha256').update(content).digest('hex'),
            sourceStat: { size: Buffer.byteLength(content), mtimeMs: 1, ctimeMs: 1 },
        };
    };
    const run = (assertMutationCurrent?: () => void) => pipeline.processFileList({
        filePaths: Object.keys(input.sources), codebasePath: '/repo', collectionName: 'fixture', assertMutationCurrent,
        onFileProcessed: (file, index, total) => { callbacks.push(`${file}:${index}:${total}`); input.onFileProcessed?.(file); },
        resourcePlan: input.queuedEmbeddingTextBytes === undefined ? undefined : {
            ...new IndexingResourcePlanner({
                platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
                totalMemory: () => 16 * 1024 ** 3, freeMemory: () => 16 * 1024 ** 3, cpuCount: () => 8,
            }, () => ({ diagnostics: [] })).createPlan(),
            queuedEmbeddingTextBytes: input.queuedEmbeddingTextBytes,
        },
    });
    return { run, documents, embeddingInputs, callbacks };
}

function configure(t: TestContext, enabled: boolean) {
    const previous = process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS;
    const trace = process.env.SATORI_PERF_TRACE;
    const batchSize = process.env.EMBEDDING_BATCH_SIZE;
    t.after(() => {
        for (const [name, value] of [
            ['SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS', previous], ['SATORI_PERF_TRACE', trace], ['EMBEDDING_BATCH_SIZE', batchSize],
        ]) {
            if (value === undefined) delete process.env[name!];
            else process.env[name!] = value;
        }
    });
    if (enabled) process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '/test/projection.node';
    else process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '';
    delete process.env.EMBEDDING_BATCH_SIZE;
    process.env.SATORI_PERF_TRACE = '1';
    const traces: Array<{ span: string; total: number; native: number; fallback: number; calls: number; ms: number }> = [];
    t.mock.method(process.stderr, 'write', (line: string | Uint8Array) => {
        const text = String(line);
        if (text.startsWith('[perf] ')) {
            const record = JSON.parse(text.slice(7));
            if (record.span === 'payload.native_projections') traces.push(record);
        }
        return true;
    });
    t.mock.method(Date.prototype, 'toISOString', () => '2026-10-20T00:00:00.000Z');
    return traces;
}

for (const chunked of [true, false]) {
    test(`native lease observations match the reference write boundaries across ${chunked ? '641 chunk batches' : '257 empty-file event windows'}`, async t => {
        configure(t, false);
        const fileCount = chunked ? 641 : 257;
        const sources = Object.fromEntries(Array.from({ length: fileCount }, (_, index) => [
            `/repo/file${index}.ts`, chunked ? `const fooBar${index} = raw_value;` : '',
        ]));
        let baselineChecks = 0;
        const baseline = fixturePipeline({ analyzer: analyzer('deferred', 64), sources });
        const before = await baseline.run(() => { baselineChecks++; });
        await before.payloadSettled;
        assert.equal(baselineChecks, before.performance.logicalVectorWriteRequests);

        const batches: number[] = [];
        t.mock.method(nativeProjectionBinding, 'load', () => addon(inputs => { batches.push(inputs.length); }));
        process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '/test/projection.node';
        let checks = 0;
        const native = fixturePipeline({ analyzer: analyzer('deferred', 64), sources, signal: () => new AbortController().signal });
        const after = await native.run(() => { checks++; });
        await after.payloadSettled;
        assert.equal(after.totalChunks, chunked ? 641 : 0);
        assert.equal(after.processedFiles, fileCount);
        assert.deepEqual(batches, chunked ? [...Array<number>(10).fill(64), 1] : []);
        assert.equal(checks, baselineChecks, 'native lease observations are the reference write guards');
        assert.deepEqual(native.documents, baseline.documents);
        assert.deepEqual(native.embeddingInputs, baseline.embeddingInputs);
        assert.deepEqual(native.callbacks, baseline.callbacks);
    });
}

for (const reason of [null, new Error('lease lost after native settlement')]) {
    test(`lease loss at the first write guard wraps ${String(reason)} as the reference write failure and drains before rejection`, async t => {
        configure(t, true);
        const started = gate();
        const releaseFirst = gate();
        const releaseOthers = gate();
        const readStarted = gate();
        const releaseRead = gate();
        const leaseChecked = gate();
        const root = new AbortController();
        let calls = 0;
        let settledCalls = 0;
        let checks = 0;
        let returned = false;
        let readSettled = false;
        t.mock.method(nativeProjectionBinding, 'load', () => ({
            ProjectionCancellation: class { cancel(): void { /* not observed by this test */ } },
            buildProjectionBatch: async (inputs: RawInput[]) => {
                const call = calls++;
                if (calls === 4) started.release();
                try {
                    await (call === 0 ? releaseFirst.promise : releaseOthers.promise);
                    return inputs.map(reference);
                } finally { settledCalls++; }
            },
        }));
        const fixture = fixturePipeline({
            analyzer: analyzer('deferred', 64),
            sources: { '/repo/a.ts': 'fooBar \n'.repeat(2560), '/repo/b.ts': 'laterFile' },
            signal: () => root.signal,
            read: async file => {
                if (file.endsWith('/b.ts')) {
                    readStarted.release(); await releaseRead.promise; readSettled = true;
                }
            },
        });
        const operation = fixture.run(() => {
            checks++;
            leaseChecked.release();
            if (checks === 1) throw reason;
            assert.fail('no lease callback follows a failed write guard');
        });
        operation.then(() => { returned = true; }, () => { returned = true; });
        const rejected = assert.rejects(operation, error => error instanceof Error && error.message.startsWith('Failed to persist') && error.cause === reason);
        try {
            await Promise.all([started.promise, readStarted.promise]);
            releaseFirst.release();
            releaseOthers.release();
            await leaseChecked.promise;
            await setImmediate();
            assert.equal(returned, false);
            assert.equal(fixture.documents.length, 0);
            assert.equal(root.signal.aborted, false);
            assert.equal(readSettled, false, 'the pending source read still belongs to this operation');
            releaseRead.release();
            await rejected;
            assert.equal(readSettled, true);
            assert.equal(checks, 1);
            assert.equal(settledCalls, calls);
            assert.equal(root.signal.aborted, false);
            assert.equal(fixture.documents.length, 0);
            assert.equal(fixture.callbacks.length, 0);
        } finally {
            releaseFirst.release(); releaseOthers.release(); releaseRead.release();
            await operation.catch(() => undefined);
        }
    });
}

for (const mode of ['eager', 'deferred'] as const) {
    for (const scenario of ['count', 'bytes', 'oversized'] as const) {
        test(`${mode} ${scenario} windows preserve exact vector documents, embedding batches and callbacks`, async t => {
            const traces = configure(t, false);
            const calls: Array<{ count: number; bytes: number }> = [];
            let loads = 0;
            t.mock.method(nativeProjectionBinding, 'load', () => {
                loads++;
                return addon(inputs => {
                    const bytes = inputs.reduce((sum, raw) => sum + rawBytes(raw), 0);
                    assert.ok(inputs.length <= 64);
                    assert.ok(bytes <= MAX_BYTES);
                    calls.push({ count: inputs.length, bytes });
                });
            });
            const source = scenario === 'count'
                ? 'fooBar \n'.repeat(1040)
                : `fooBar\n${' '.repeat((scenario === 'bytes' ? 5 : 4) * 1024 ** 2)}endValue`;
            const chunkSize = scenario === 'count' ? 64 : scenario === 'bytes' ? 2 * 1024 ** 2 : MAX_BYTES + 1000;
            const sources = { '/repo/main.ts': source, '/repo/unicode.ts': 'const café = "😀";\nconst raw = "\ud800";' };
            const baseline = fixturePipeline({ analyzer: analyzer(mode, chunkSize), sources });
            const before = await baseline.run();
            await before.payloadSettled;
            assert.equal(loads, 0);
            assert.equal(traces.length, 0);

            process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '/test/projection.node';
            let signals = 0;
            const native = fixturePipeline({
                analyzer: analyzer(mode, chunkSize), sources,
                signal: () => { signals++; return new AbortController().signal; },
            });
            const after = await native.run();
            await after.payloadSettled;
            assert.equal(loads, 1);
            assert.equal(signals, 1);
            assert.deepEqual(native.documents, baseline.documents);
            assert.deepEqual(native.embeddingInputs, baseline.embeddingInputs);
            assert.deepEqual(native.callbacks, baseline.callbacks);
            assert.deepEqual(after.symbolRecords, before.symbolRecords);
            assert.deepEqual(after.sourceFiles, before.sourceFiles);
            assert.equal(after.totalChunks, before.totalChunks);
            assert.equal(traces.length, 1);
            assert.equal(traces[0].total, after.totalChunks);
            assert.equal(traces[0].native + traces[0].fallback, traces[0].total);
            assert.equal(traces[0].calls, calls.length);
            assert.ok(traces[0].fallback > 0, 'Unicode must use the reference');
            if (scenario === 'oversized') {
                assert.equal(calls.length, 0);
            } else {
                assert.ok(traces[0].native > 0, 'the injected native binding must execute');
                assert.ok(calls.length >= 2);
                if (scenario === 'count') {
                    assert.equal(before.totalChunks, 131);
                    assert.deepEqual(calls.map(call => call.count), [64, 64, 2]);
                } else {
                    assert.equal(before.totalChunks, 4);
                    assert.deepEqual(calls.map(call => call.count), [1, 2]);
                }
            }
            assert.deepEqual(native.documents.slice(0, before.totalChunks - 1).map(row => row.document.metadata.chunkIndex),
                Array.from({ length: before.totalChunks - 1 }, (_, index) => index));
            assert.ok(native.documents.every(row => row.document.metadata.ownerSymbolKey));
            assert.ok(native.documents.every(row => !('filePath' in row.document.metadata)));
        });
    }
}

test('configured addon load failure falls back in the real pipeline', async t => {
    const traces = configure(t, true);
    t.mock.method(nativeProjectionBinding, 'load', () => { throw new Error('cannot load addon'); });
    const fixture = fixturePipeline({
        analyzer: analyzer('deferred', 64), sources: { '/repo/main.ts': 'fooBar' },
        signal: () => new AbortController().signal,
    });
    const result = await fixture.run();
    await result.payloadSettled;
    assert.equal(fixture.documents.length, 1);
    assert.equal(traces.length, 1);
    assert.deepEqual({ ...traces[0], ms: 0 }, {
        span: 'payload.native_projections', total: 1, native: 0, fallback: 1, calls: 0, ms: 0,
    });
});

test('native rejection drains earlier payload work and all started analyses before rejection', async t => {
    const traces = configure(t, true);
    const nativeEntered = gate();
    const nativeFailure = gate();
    const payloadEntered = gate();
    const payloadRelease = gate();
    const analysisEntered = gate();
    const analysisRelease = gate();
    const failure = new Error('native batch failed');
    let nativeCalls = 0;
    let payloadFinished = false;
    let analysisFinished = false;
    t.mock.method(nativeProjectionBinding, 'load', () => ({
        ...addon(), buildProjectionBatch: async (inputs: RawInput[]) => {
            if (++nativeCalls === 2) {
                nativeEntered.release();
                await nativeFailure.promise;
                throw failure;
            }
            return inputs.map(reference);
        },
    }));
    const fixture = fixturePipeline({
        analyzer: analyzer('deferred', 64),
        sources: { '/repo/a.ts': 'fooBar \n'.repeat(1040), '/repo/b.ts': 'laterFile' },
        signal: () => new AbortController().signal,
        embed: async () => { payloadEntered.release(); await payloadRelease.promise; payloadFinished = true; },
        read: async file => {
            if (file.endsWith('/b.ts')) {
                analysisEntered.release(); await analysisRelease.promise; analysisFinished = true;
            }
        },
    });
    let settled = false;
    const operation = fixture.run();
    operation.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(operation, error => error === failure);
    try {
        await Promise.all([nativeEntered.promise, payloadEntered.promise, analysisEntered.promise]);
        nativeFailure.release();
        await setImmediate();
        assert.equal(settled, false);
        assert.equal(payloadFinished, false);
        payloadRelease.release();
        await setImmediate();
        assert.equal(payloadFinished, true);
        assert.equal(analysisFinished, false);
        assert.equal(settled, false);
        analysisRelease.release();
        await rejected;
        assert.equal(analysisFinished, true);
        assert.equal(nativeCalls, 2);
        assert.equal(fixture.documents.length, 0);
        assert.equal(fixture.callbacks.length, 0);
        assert.equal(traces.length, 1);
        assert.equal(traces[0].calls, 2);
        await setImmediate();
        assert.equal(fixture.documents.length, 0, 'cleanup cannot race later writes');
    } finally {
        nativeFailure.release(); payloadRelease.release(); analysisRelease.release();
        await operation.catch(() => undefined);
    }
});

for (const stop of ['cancellation', 'lease loss'] as const) {
    test(`${stop} while native work is pending waits for settlement and prevents later writes`, async t => {
        const traces = configure(t, true);
        const entered = gate();
        const release = gate();
        const controller = new AbortController();
        const staleLease = new Error('lease no longer current');
        let valid = true;
        let cancelled = 0;
        let nativeCalls = 0;
        let nativeFinished = 0;
        let settled = false;
        let checks = 0;
        t.mock.method(nativeProjectionBinding, 'load', () => ({
            ProjectionCancellation: class { cancel(): void { cancelled++; } },
            buildProjectionBatch: async (inputs: RawInput[]) => {
                if (++nativeCalls === 4) entered.release();
                await release.promise;
                nativeFinished++;
                return inputs.map(reference);
            },
        }));
        const fixture = fixturePipeline({
            analyzer: analyzer('deferred', 64), sources: { '/repo/main.ts': 'fooBar \n'.repeat(2560) },
            signal: () => controller.signal,
        });
        const operation = fixture.run(() => {
            checks++;
            if (!valid) { assert.equal(nativeFinished, 4); throw staleLease; }
        });
        operation.then(() => { settled = true; }, () => { settled = true; });
        const rejected = assert.rejects(operation, error => stop === 'cancellation'
            ? error === null
            : error instanceof Error && error.message.startsWith('Failed to persist') && error.cause === staleLease);
        try {
            await entered.promise;
            valid = false;
            if (stop === 'cancellation') controller.abort(null);
            await setImmediate();
            assert.equal(cancelled, stop === 'cancellation' ? 4 : 0);
            assert.equal(nativeFinished, 0);
            assert.equal(settled, false);
            assert.equal(checks, 0, 'no lease check runs while native work is pending');
            assert.equal(fixture.documents.length, 0);
            release.release();
            await rejected;
            assert.equal(checks, stop === 'cancellation' ? 0 : 1);
            assert.equal(nativeFinished, 4);
            assert.equal(fixture.documents.length, 0);
            // Like the reference path, lease loss surfaces at the write guard after its embedding batch.
            assert.equal(fixture.embeddingInputs.length, stop === 'cancellation' ? 0 : 1);
            assert.equal(fixture.callbacks.length, 0);
            assert.equal(traces.length, 1);
            assert.equal(traces[0].calls, 4);
            await setImmediate();
            assert.equal(fixture.documents.length, 0);
        } finally { release.release(); await operation.catch(() => undefined); }
    });
}

test('native projections still obey the embedding token limit before submitting payload work', async t => {
    const traces = configure(t, true);
    t.mock.method(nativeProjectionBinding, 'load', () => addon());
    const fixture = fixturePipeline({
        analyzer: analyzer('eager', 64), sources: { '/repo/main.ts': 'fooBar' }, hardTokenLimit: 1,
        signal: () => new AbortController().signal,
    });
    await assert.rejects(fixture.run(), /exceeding the provider hard limit of 1/);
    assert.equal(fixture.embeddingInputs.length, 0);
    assert.equal(fixture.documents.length, 0);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].native, 1);
});

test('eager analyzer chunks preserve lone surrogate input through reference fallback', async t => {
    const traces = configure(t, true);
    const ordinary = analyzer('eager', 64);
    const eager: LanguageAnalysisPort = {
        ...ordinary,
        analyze: async (): Promise<LanguageAnalysisResult> => ({
            backend: 'bounded_text', structuralStatus: 'complete', symbols: [], moduleBindings: [], callSites: [], receiverTypeBindings: [],
            chunks: [{ content: 'raw\ud800value', metadata: { startLine: 1, endLine: 1, language: 'typescript' } }],
        }),
    };
    t.mock.method(nativeProjectionBinding, 'load', () => addon(() => { assert.fail('surrogate reached the native boundary'); }));
    const fixture = fixturePipeline({
        analyzer: eager, sources: { '/repo/main.ts': 'raw\ud800value' }, signal: () => new AbortController().signal,
    });
    const result = await fixture.run();
    await result.payloadSettled;
    assert.equal(fixture.documents[0].document.content, 'raw\ud800value');
    assert.ok(fixture.embeddingInputs[0][0].includes('raw\ud800value'));
    assert.equal(traces[0].fallback, 1);
    assert.equal(traces[0].native, 0);
});

for (const mode of ['eager', 'deferred'] as const) {
    for (const shape of ['small files', 'large file'] as const) {
        test(`${mode} four concurrent ${shape} batches completing out of order equal the default pipeline`, async t => {
            configure(t, false);
            const sources: Record<string, string> = shape === 'small files'
                ? Object.fromEntries(Array.from({ length: 320 }, (_, index) => [`/repo/file${index}.ts`, `const fooBar${index} = raw_value;`]))
                : { '/repo/large.ts': 'fooBar \n'.repeat(2560) };
            sources['/repo/unicode.ts'] = 'const café = "😀";\nconst raw = "\ud800";';
            sources['/repo/empty.ts'] = '';
            const baseline = fixturePipeline({ analyzer: analyzer(mode, 64), sources });
            const before = await baseline.run();
            await before.payloadSettled;
            assert.ok(before.totalChunks > 256);
            const started = gate();
            const releases = Array.from({ length: 4 }, gate);
            let calls = 0;
            let running = 0;
            let maximum = 0;
            t.mock.method(nativeProjectionBinding, 'load', () => ({
                ...addon(), buildProjectionBatch: async (inputs: RawInput[]) => {
                    const call = calls++;
                    running++;
                    maximum = Math.max(maximum, running);
                    if (calls === 4) started.release();
                    try {
                        if (call < 4) await releases[call].promise;
                        return inputs.map(reference);
                    } finally { running--; }
                },
            }));
            process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '/test/projection.node';
            const native = fixturePipeline({ analyzer: analyzer(mode, 64), sources, signal: () => new AbortController().signal });
            const operation = native.run();
            try {
                await started.promise;
                assert.equal(running, 4);
                releases[3].release(); releases[2].release(); releases[1].release();
                await setImmediate();
                assert.equal(native.embeddingInputs.length, 0);
                assert.equal(native.callbacks.length, 0);
                assert.equal(calls, 4, 'ready batches keep their slots');
                releases[0].release();
                const after = await operation;
                await after.payloadSettled;
                assert.equal(maximum, 4);
                assert.equal(running, 0);
                assert.deepEqual(native.documents, baseline.documents);
                assert.deepEqual(native.embeddingInputs, baseline.embeddingInputs);
                assert.deepEqual(native.callbacks, baseline.callbacks);
                assert.deepEqual(after.sourceFiles, before.sourceFiles);
                assert.deepEqual(after.symbolRecords, before.symbolRecords);
                assert.deepEqual(after.symbolManifestFiles, before.symbolManifestFiles);
                assert.deepEqual(after.analysisByFile, before.analysisByFile);
                assert.equal(after.totalChunks, before.totalChunks);
                assert.equal(after.processedFiles, before.processedFiles);
                assert.ok(native.callbacks.at(-1)?.startsWith('/repo/empty.ts:'));
            } finally {
                releases.forEach(item => item.release());
                const result = await operation;
                await result.payloadSettled;
            }
        });
    }
}

for (const consumer of ['embedding', 'callback'] as const) {
    test(`${consumer} failure drains other native calls, reads and payloads without aborting the root`, async t => {
        configure(t, true);
        const started = gate();
        const releaseFirst = gate();
        const releaseOthers = gate();
        const failing = gate();
        const root = new AbortController();
        const failure = new Error(`${consumer} failed`);
        let calls = 0;
        let settledCalls = 0;
        let cancellations = 0;
        let returned = false;
        let payloadSettled = false;
        t.mock.method(nativeProjectionBinding, 'load', () => ({
            ProjectionCancellation: class { cancel(): void { cancellations++; } },
            buildProjectionBatch: async (inputs: RawInput[]) => {
                const call = calls++;
                if (calls === 4) started.release();
                try {
                    await (call === 0 ? releaseFirst.promise : releaseOthers.promise);
                    return inputs.map(reference);
                } finally { settledCalls++; }
            },
        }));
        const fixture = fixturePipeline({
            analyzer: analyzer('deferred', 64), sources: consumer === 'embedding'
                ? { '/repo/a.ts': 'fooBar \n'.repeat(2560), '/repo/b.ts': 'nextFile' }
                : Object.fromEntries(Array.from({ length: 320 }, (_, index) => [`/repo/file${index}.ts`, 'fooBar'])),
            signal: () => root.signal, queuedEmbeddingTextBytes: consumer === 'embedding' ? 1 : undefined,
            embed: async () => {
                if (consumer === 'embedding') { failing.release(); payloadSettled = true; throw failure; }
                payloadSettled = true;
            },
            onFileProcessed: () => {
                if (consumer === 'callback') { failing.release(); throw failure; }
            },
        });
        const operation = fixture.run();
        operation.then(() => { returned = true; }, () => { returned = true; });
        const rejected = assert.rejects(operation, error => consumer === 'embedding'
            ? error instanceof Error && error.cause === failure
            : error === failure);
        try {
            await started.promise;
            releaseFirst.release();
            await failing.promise;
            await setImmediate();
            assert.equal(returned, false);
            assert.equal(settledCalls, 1);
            assert.equal(cancellations, 3);
            assert.equal(root.signal.aborted, false);
            releaseOthers.release();
            await rejected;
            assert.equal(settledCalls, calls);
            assert.equal(payloadSettled, consumer === 'embedding');
            const writes = fixture.documents.length;
            await setImmediate();
            assert.equal(fixture.documents.length, writes);
        } finally { releaseFirst.release(); releaseOthers.release(); await operation.catch(() => undefined); }
    });
}

test('source failure after partial data delivers earlier callbacks and drains every started read and payload', async t => {
    configure(t, true);
    const readStarted = gate();
    const releaseRead = gate();
    const callbackSeen = gate();
    const failure = new Error('source failed');
    let readSettled = false;
    let returned = false;
    const fixture = fixturePipeline({
        analyzer: analyzer('deferred', 64),
        sources: { '/repo/a.ts': 'firstValue', '/repo/b.ts': 'failedValue', '/repo/c.ts': 'laterValue' },
        signal: () => new AbortController().signal,
        read: async file => {
            if (file.endsWith('/b.ts')) throw failure;
            if (file.endsWith('/c.ts')) { readStarted.release(); await releaseRead.promise; readSettled = true; }
        },
        onFileProcessed: () => { callbackSeen.release(); },
    });
    let calls = 0;
    t.mock.method(nativeProjectionBinding, 'load', () => addon(() => { calls++; }));
    const operation = fixture.run();
    operation.then(() => { returned = true; }, () => { returned = true; });
    const rejected = assert.rejects(operation, error => error === failure);
    try {
        await Promise.all([readStarted.promise, callbackSeen.promise]);
        await setImmediate();
        assert.deepEqual(fixture.callbacks, ['/repo/a.ts:1:3']);
        assert.equal(calls, 1);
        assert.equal(returned, false);
        assert.equal(readSettled, false);
        releaseRead.release();
        await rejected;
        assert.equal(readSettled, true);
        assert.equal(fixture.documents.length, 0);
        assert.equal(fixture.embeddingInputs.length, 0);
        await setImmediate();
        assert.equal(fixture.documents.length, 0);
    } finally { releaseRead.release(); await operation.catch(() => undefined); }
});
