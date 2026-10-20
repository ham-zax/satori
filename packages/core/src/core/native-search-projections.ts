import { createRequire } from 'node:module';
import { isAbsolute, extname } from 'node:path';
import { buildSearchProjections, type SearchProjectionInput } from './search-projections';
import { validateRepositoryRelativePath } from '../paths/repository-path';
import type { SearchProjections } from '../vectordb/types';
import { perfTrace } from '../utils/perf-trace';

export const MAX_INPUTS = 64;
export const MAX_BYTES = 4 * 1024 * 1024;
export interface RawInput {
    content: string;
    relativePath: string;
    language?: string;
    symbolKind?: string;
    symbolLabel?: string;
    breadcrumbs?: string[];
}
export interface Cancellation { cancel(): void }
export interface NativeAddon {
    ProjectionCancellation: new () => Cancellation;
    buildProjectionBatch(inputs: RawInput[], token?: Cancellation): Promise<(SearchProjections | null)[]>;
}
export interface Counts { total: number; native: number; fallback: number; calls: number }
export interface Options {
    signal?: AbortSignal;
    addonPath?: string;
    /** Test seam also permits deterministic lifecycle tests without loading an addon. */
    loader?: () => NativeAddon | undefined;
    counts?: Counts;
}
const requireAddon = createRequire(__filename);

/** Core loads only the explicitly configured local binary. Packaging stays outside this owner. */
export function loadAddon(addonPath?: string): NativeAddon | undefined {
    if (!addonPath || !isAbsolute(addonPath) || extname(addonPath) !== '.node') return undefined;
    try { return requireAddon(addonPath) as NativeAddon; } catch { return undefined; }
}

/** Internal binding seam for deterministic pipeline lifecycle tests without a native binary. */
export const nativeProjectionBinding = { load: loadAddon };

export function flatten(input: SearchProjectionInput): RawInput {
    const { language, symbolKind, symbolLabel, breadcrumbs } = input.chunk.metadata;
    return { content: input.chunk.content, relativePath: input.relativePath, language, symbolKind, symbolLabel, breadcrumbs };
}
export function rawStrings(input: RawInput): string[] {
    return [input.content, input.relativePath, input.language ?? '', input.symbolKind ?? '', input.symbolLabel ?? '', ...(input.breadcrumbs ?? [])];
}
export function rawBytes(input: RawInput): number {
    return rawStrings(input).reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
}
function supported(input: RawInput): boolean {
    // Reject lone surrogates here, before napi converts JavaScript UTF-16 to Rust UTF-8.
    return rawStrings(input).every(value => !/[\x80-\uffff]/.test(value) && !/[a-zA-Z0-9_$]{257}/.test(value));
}
function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason;
}
export interface NativeProjectionBatchBuilder {
    prepare(inputs: readonly SearchProjectionInput[]): Promise<Array<SearchProjections | null>>;
    finish(input: SearchProjectionInput, result: SearchProjections | null): SearchProjections;
    build(inputs: readonly SearchProjectionInput[]): Promise<SearchProjections[]>;
    cancel(reason: unknown): void;
    /** Boundaries without chunks must observe the same operation cancellation. */
    assertActive(): void;
}

/** One cancellation scope owns every native call made by this operation. */
export function createNativeProjectionBatchBuilder(options: Options = {}): NativeProjectionBatchBuilder {
    const local = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
    const counts = options.counts ?? { total: 0, native: 0, fallback: 0, calls: 0 };
    let loaded = false;
    let addon: NativeAddon | undefined;
    const prepare = async (inputs: readonly SearchProjectionInput[]): Promise<Array<SearchProjections | null>> => {
        checkAbort(signal);
        // Validate the whole request before loading or dispatching native work.
        for (const input of inputs) validateRepositoryRelativePath(input.relativePath);
        if (!loaded) {
            loaded = true;
            try { addon = options.loader ? options.loader() : loadAddon(options.addonPath); } catch { addon = undefined; }
        }
        counts.total += inputs.length;
        const output: Array<SearchProjections | null> = new Array(inputs.length).fill(null);
        let batch: RawInput[] = [];
        let indices: number[] = [];
        let bytes = 0;
        const flush = async (): Promise<void> => {
            if (!batch.length || !addon) return;
            checkAbort(signal);
            const token = new addon.ProjectionCancellation();
            const cancel = (): void => token.cancel();
            signal.addEventListener('abort', cancel, { once: true });
            try {
                counts.calls++;
                let results: (SearchProjections | null)[];
                try { results = await addon.buildProjectionBatch(batch, token); }
                catch (error) { checkAbort(signal); throw error; }
                checkAbort(signal);
                if (results.length !== batch.length) throw new Error('Native projection batch length mismatch');
                for (let i = 0; i < results.length; i++) {
                    output[indices[i]] = results[i];
                    if (results[i] !== null) counts.native++;
                }
            } finally { signal.removeEventListener('abort', cancel); }
            batch = [];
            indices = [];
            bytes = 0;
        };
        for (let index = 0; index < inputs.length; index++) {
            checkAbort(signal);
            if ((inputs[index].chunk.metadata.breadcrumbs?.length ?? 0) > 256) continue;
            const raw = flatten(inputs[index]);
            const size = rawBytes(raw);
            if (!addon || size > MAX_BYTES || !supported(raw)) continue;
            if (batch.length === MAX_INPUTS || bytes + size > MAX_BYTES) await flush();
            batch.push(raw);
            indices.push(index);
            bytes += size;
        }
        await flush();
        checkAbort(signal);
        return output;
    };
    const finish = (input: SearchProjectionInput, result: SearchProjections | null): SearchProjections => {
        checkAbort(signal);
        if (result !== null) return result;
        const projection = buildSearchProjections(input);
        counts.fallback++;
        return projection;
    };
    return {
        prepare, finish,
        assertActive: () => checkAbort(signal),
        build: async inputs => (await prepare(inputs)).map((result, index) => finish(inputs[index], result)),
        cancel: reason => local.abort(reason),
    };
}

export async function buildProjectionBatch(inputs: readonly SearchProjectionInput[], options: Options = {}): Promise<SearchProjections[]> {
    return createNativeProjectionBatchBuilder(options).build(inputs);
}

/** Measures flattened input without allocating a second breadcrumb array. */
export function projectionInputBytes(input: SearchProjectionInput): number {
    const { language, symbolKind, symbolLabel, breadcrumbs } = input.chunk.metadata;
    let bytes = Buffer.byteLength(input.chunk.content, 'utf8') + Buffer.byteLength(input.relativePath, 'utf8');
    for (const value of [language, symbolKind, symbolLabel]) bytes += Buffer.byteLength(value ?? '', 'utf8');
    for (const value of breadcrumbs ?? []) bytes += Buffer.byteLength(value, 'utf8');
    return bytes;
}

/** One operation captures configuration, binding and cancellation once, outside every chunk loop. */
export function createConfiguredNativeProjectionBatchBuilder(getSignal?: () => AbortSignal | undefined): {
    report(): void;
} & NativeProjectionBatchBuilder | undefined {
    const addonPath = process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS;
    if (!addonPath) return undefined;
    const startedAt = performance.now();
    const signal = getSignal?.();
    let addon: NativeAddon | undefined;
    if (!signal?.aborted) {
        try { addon = nativeProjectionBinding.load(addonPath); } catch { addon = undefined; }
    }
    const counts: Counts = { total: 0, native: 0, fallback: 0, calls: 0 };
    let reported = false;
    return {
        ...createNativeProjectionBatchBuilder({ signal, loader: () => addon, counts }),
        report: () => {
            if (reported) return;
            reported = true;
            perfTrace('payload.native_projections', performance.now() - startedAt, { ...counts });
        },
    };
}
