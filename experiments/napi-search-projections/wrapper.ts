import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
    buildProjectionBatch as buildCoreProjectionBatch,
    loadAddon as loadExplicitAddon,
    type NativeAddon,
    type Options,
} from '../../packages/core/src/core/native-search-projections';
import type { SearchProjectionInput } from '../../packages/core/src/core/search-projections';
import type { SearchProjections } from '../../packages/core/src/vectordb/types';

export { MAX_INPUTS, MAX_BYTES, flatten, rawStrings, rawBytes } from '../../packages/core/src/core/native-search-projections';
export type { RawInput, Cancellation, NativeAddon, Counts, Options } from '../../packages/core/src/core/native-search-projections';

const requireAddon = createRequire(import.meta.url);
let defaultLoaded = false;
let defaultAddon: NativeAddon | undefined;

/** The experiment alone discovers its local platform build and caches platform diagnostics. */
export function loadAddon(addonPath?: string): NativeAddon | undefined {
    if (addonPath !== undefined) return loadExplicitAddon(addonPath);
    if (defaultLoaded) return defaultAddon;
    defaultLoaded = true;
    try {
        const suffix = process.platform === 'linux'
            ? ((process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? '-gnu' : '-musl')
            : process.platform === 'win32' ? '-msvc' : '';
        defaultAddon = requireAddon(fileURLToPath(new URL(`./projection.${process.platform}-${process.arch}${suffix}.node`, import.meta.url))) as NativeAddon;
    } catch { defaultAddon = undefined; }
    return defaultAddon;
}

export function buildProjectionBatch(inputs: readonly SearchProjectionInput[], options: Options = {}): Promise<SearchProjections[]> {
    return buildCoreProjectionBatch(inputs, {
        ...options,
        loader: options.loader ?? (() => loadAddon(options.addonPath)),
    });
}
