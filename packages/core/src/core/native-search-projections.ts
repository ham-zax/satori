import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, extname, join, resolve } from 'node:path';
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
const BUNDLED_ADDON_ROOT = resolve(__dirname, '../../assets/native-projections/linux-x64');
const verifiedBundledAddons = new Map<string, string | undefined>();

/** The bundled linux-x64 addon, only when its bytes match the shipped manifest. */
function verifiedBundledAddonPath(assetRoot: string): string | undefined {
    if (verifiedBundledAddons.has(assetRoot)) return verifiedBundledAddons.get(assetRoot);
    let addonPath: string | undefined;
    try {
        const manifest = JSON.parse(readFileSync(join(assetRoot, 'manifest.json'), 'utf8')) as {
            schemaVersion?: number;
            files?: { path?: string; sha256?: string }[];
        };
        const entry = manifest.schemaVersion === 1 ? manifest.files?.find(file => file.path === 'projection.node') : undefined;
        const candidate = join(assetRoot, 'projection.node');
        if (entry?.sha256 && createHash('sha256').update(readFileSync(candidate)).digest('hex') === entry.sha256) addonPath = candidate;
    } catch {
        addonPath = undefined;
    }
    verifiedBundledAddons.set(assetRoot, addonPath);
    return addonPath;
}

/**
 * SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS overrides the addon path, and an empty
 * value turns native projections off. Without it, linux-x64 uses the bundled
 * addon. Every other case keeps the TypeScript projections, which give the same output.
 */
export function resolveNativeProjectionAddonPath(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
    assetRoot: string = BUNDLED_ADDON_ROOT,
): string | undefined {
    const configured = env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS;
    if (configured !== undefined) return configured || undefined;
    if (platform !== 'linux' || arch !== 'x64') return undefined;
    return verifiedBundledAddonPath(assetRoot);
}

/** Core loads only an absolute .node path; a failed load keeps the TypeScript projections. */
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
export function nativeInputBytes(input: RawInput): number | undefined {
    // Reject lone surrogates here, before napi converts JavaScript UTF-16 to Rust UTF-8.
    let total = 0;
    const breadcrumbs = input.breadcrumbs;
    for (let field = 0; field < 5 + (breadcrumbs?.length ?? 0); field++) {
        const value = (field === 0 ? input.content
            : field === 1 ? input.relativePath
            : field === 2 ? input.language
            : field === 3 ? input.symbolKind
            : field === 4 ? input.symbolLabel
            : breadcrumbs![field - 5]) ?? '';
        total += value.length;
        if (total > MAX_BYTES) return undefined;
        let run = 0;
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            if (code >= 0x80) return undefined;
            if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
                || (code >= 48 && code <= 57) || code === 95 || code === 36) {
                if (++run >= 257) return undefined;
            } else run = 0;
        }
    }
    return total;
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
            if (!addon) continue;
            const raw = flatten(inputs[index]);
            const size = nativeInputBytes(raw);
            if (size === undefined) continue;
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
    const addonPath = resolveNativeProjectionAddonPath();
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
