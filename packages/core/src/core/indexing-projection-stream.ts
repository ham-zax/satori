import type { SearchProjectionInput } from './search-projections';
import type { SearchProjections } from '../vectordb/types';
import { MAX_BYTES, MAX_INPUTS, projectionInputBytes, type NativeProjectionBatchBuilder } from './native-search-projections';

export type IndexingProjectionEvent =
    | { kind: 'chunk'; input: SearchProjectionInput; filePath: string; fileIndex: number; fileChunkIndex: number }
    | { kind: 'file-complete'; filePath: string; fileIndex: number }
    | { kind: 'file-error'; filePath: string; fileIndex: number; error: unknown };
export type ProjectedIndexingEvent =
    | (Extract<IndexingProjectionEvent, { kind: 'chunk' }> & { projections: SearchProjections })
    | Exclude<IndexingProjectionEvent, { kind: 'chunk' }>;
export interface ProjectionQueueTelemetry {
    peakRetainedBatches: number;
    peakRetainedInputBytes: number;
    maxOverlappingWork: number;
}
type Settled = { ok: true; results: Array<SearchProjections | null> } | { ok: false; error: unknown };
interface Slot {
    events: IndexingProjectionEvent[];
    bytes: number;
    settled: Promise<Settled>;
}

/** Operation-local queue. A yielding or ready batch owns its slot until consumption ends. */
export async function* streamIndexingProjections(
    source: AsyncIterable<IndexingProjectionEvent>,
    builder: NativeProjectionBatchBuilder,
    options: { beforePrepare?: () => void; beforeConsume?: () => void; onTelemetry?: (metrics: ProjectionQueueTelemetry) => void } = {},
): AsyncGenerator<ProjectedIndexingEvent, void, unknown> {
    const iterator = source[Symbol.asyncIterator]();
    const slots: Slot[] = [];
    const metrics: ProjectionQueueTelemetry = { peakRetainedBatches: 0, peakRetainedInputBytes: 0, maxOverlappingWork: 0 };
    let retainedBytes = 0;
    let working = 0;
    let stopped = false;
    let failed = false;
    let producerDone = false;
    let sourceDone = false;
    let carry: IndexingProjectionEvent | undefined;
    let wakeConsumer: (() => void) | undefined;
    let wakeProducer: (() => void) | undefined;
    const changed = (): void => { wakeConsumer?.(); wakeConsumer = undefined; };
    // The producer owns source.next/return. Its finally joins even a pending read.
    const produce = async (): Promise<void> => {
        try {
            while (!stopped && !failed && !sourceDone) {
                if (slots.length === 4) {
                    await new Promise<void>(resolve => { wakeProducer = resolve; });
                    continue;
                }
                let settle!: (result: Settled | PromiseLike<Settled>) => void;
                const slot: Slot = { events: [], bytes: 0, settled: new Promise(resolve => { settle = resolve; }) };
                slots.push(slot);
                metrics.peakRetainedBatches = Math.max(metrics.peakRetainedBatches, slots.length);
                changed();
                let inputs: SearchProjectionInput[] = [];
                try {
                    while (!stopped && !failed && slot.events.length < 128 && inputs.length < MAX_INPUTS) {
                        let next: IteratorResult<IndexingProjectionEvent>;
                        try { next = carry ? { done: false, value: carry } : await iterator.next(); }
                        catch (error) {
                            const previous = slot.events[slot.events.length - 1];
                            if (!previous) throw error;
                            slot.events.push({ kind: 'file-error', filePath: previous.filePath, fileIndex: previous.fileIndex, error });
                            sourceDone = true;
                            break;
                        }
                        carry = undefined;
                        if (stopped || failed) break;
                        if (next.done) { sourceDone = true; break; }
                        const event = next.value;
                        const bytes = event.kind === 'chunk' ? projectionInputBytes(event.input) : 0;
                        if (slot.events.length > 0 && slot.bytes + bytes > MAX_BYTES) {
                            carry = event;
                            break;
                        }
                        slot.events.push(event);
                        slot.bytes += bytes;
                        retainedBytes += bytes;
                        metrics.peakRetainedInputBytes = Math.max(metrics.peakRetainedInputBytes, retainedBytes);
                        if (event.kind === 'chunk') inputs.push(event.input);
                        if (event.kind === 'file-error') { sourceDone = true; break; }
                        // One oversized chunk travels alone for ordered reference fallback.
                        if (slot.bytes >= MAX_BYTES) break;
                    }
                    if (stopped || failed) { settle({ ok: true, results: [] }); break; }
                    builder.assertActive();
                    if (!inputs.length) { settle({ ok: true, results: [] }); continue; }
                    options.beforePrepare?.();
                    const job = builder.prepare(inputs);
                    inputs = [];
                    working++;
                    metrics.maxOverlappingWork = Math.max(metrics.maxOverlappingWork, working);
                    // The retained slot adopts both handlers at submission. A rejected later
                    // request stops submission immediately but keeps its ordered error position.
                    settle(job.then(results => {
                        working--;
                        return { ok: true, results } as const;
                    }, error => {
                        working--;
                        failed = true;
                        wakeProducer?.(); wakeProducer = undefined;
                        return { ok: false, error } as const;
                    }));
                } catch (error) {
                    // A source failure follows any partial input already read into this batch.
                    // Tagged file errors normally arrive through the source port instead.
                    failed = true;
                    settle({ ok: false, error });
                }
            }
        } finally {
            carry = undefined;
            try { await iterator.return?.(); }
            finally { producerDone = true; changed(); }
        }
    };
    const producer = produce();
    // Keep producer errors observed until the consumer reaches its finally drain.
    let producerError: { error: unknown } | undefined;
    const joinedProducer = producer.catch(error => { producerError = { error }; });
    let completed = false;
    try {
        while (true) {
            if (!slots.length) {
                if (producerDone) break;
                await new Promise<void>(resolve => { wakeConsumer = resolve; });
                continue;
            }
            const slot = slots[0];
            const result = await slot.settled;
            if (!result.ok) {
                // Boundaries before the first failed chunk still belong to earlier work.
                for (const event of slot.events) {
                    if (event.kind === 'chunk') break;
                    builder.assertActive();
                    yield event;
                }
                const event = slot.events.find(event => event.kind === 'chunk') ?? slot.events[0];
                if (event) yield { kind: 'file-error', filePath: event.filePath, fileIndex: event.fileIndex, error: result.error };
                else throw result.error;
                return;
            }
            options.beforeConsume?.();
            let index = 0;
            for (const event of slot.events) {
                if (event.kind === 'chunk') {
                    yield { ...event, projections: builder.finish(event.input, result.results[index++]) };
                } else {
                    builder.assertActive();
                    yield event;
                    if (event.kind === 'file-error') return;
                }
            }
            // Release both input and output references before another batch can reuse the slot.
            retainedBytes -= slot.bytes;
            slot.events = [];
            result.results.length = 0;
            slots.shift();
            wakeProducer?.(); wakeProducer = undefined;
        }
        await joinedProducer;
        if (producerError) throw producerError.error;
        completed = true;
    } finally {
        stopped = true;
        if (!completed) builder.cancel(new Error('Projection stream closed'));
        wakeProducer?.(); wakeProducer = undefined;
        // Cancellation errors never replace the consumer's original failure or reason.
        await joinedProducer;
        await Promise.all(slots.map(slot => slot.settled));
        for (const slot of slots) slot.events = [];
        slots.length = 0;
        options.onTelemetry?.(metrics);
    }
}
