import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
    ensureModel,
    resolveModelDirectory,
    type ModelProgressReporter,
    type ModelSpec,
} from "./model-store.js";
import type { InstallCommandOptions } from "./install-contracts.js";

// The extended CBM extractor pack (languages beyond the 39 core modules that
// ship inside @zokizuan/satori-core) is published once per extractor build to
// this Hugging Face repository. The revision pins the exact upload; every file
// is verified against the sha256 in the installed core package's manifest, so
// a runtime whose manifest does not match this upload fails integrity and its
// extended languages stay search-only.
export const CBM_EXTENDED_REPOSITORY = "zokizuan/satori-cbm-extractors";
export const CBM_EXTENDED_REVISION = "943a2cb54e39bc86ca13e8e1cbd459fdc18e53f5";
const CBM_EXTENDED_ID = "cbm-extractors";
const CBM_EXTENDED_LABEL = "CBM extended language pack";

type ExtractorManifest = {
    modules?: Array<{ file?: unknown; sizeBytes?: unknown; sha256?: unknown; pack?: unknown }>;
};

function coreManifestPath(runtimePackageRoot: string): string {
    const coreEntry = createRequire(path.join(runtimePackageRoot, "package.json")).resolve("@zokizuan/satori-core");
    // dist/index.js -> package root
    return path.join(path.dirname(path.dirname(coreEntry)), "assets", "cbm-extractor", "manifest.json");
}

export function readCbmExtendedPackSpec(runtimePackageRoot: string): ModelSpec {
    const manifest = JSON.parse(fs.readFileSync(coreManifestPath(runtimePackageRoot), "utf8")) as ExtractorManifest;
    const artifacts = (manifest.modules ?? [])
        .filter((entry) => entry.pack === "extended")
        .map((entry) => {
            if (typeof entry.file !== "string" || typeof entry.sha256 !== "string" || !Number.isSafeInteger(entry.sizeBytes)) {
                throw new Error("CBM extractor manifest has a malformed extended module entry.");
            }
            return Object.freeze({ path: entry.file, sizeBytes: entry.sizeBytes as number, sha256: entry.sha256 });
        });
    return Object.freeze({
        id: CBM_EXTENDED_ID,
        label: CBM_EXTENDED_LABEL,
        repository: CBM_EXTENDED_REPOSITORY,
        revision: CBM_EXTENDED_REVISION,
        artifacts: Object.freeze(artifacts),
    });
}

/** Where the extended pack lives once acquired; used before the runtime is installed. */
export function plannedCbmExtendedDirectory(homeDir: string): string {
    return resolveModelDirectory(homeDir, {
        id: CBM_EXTENDED_ID,
        label: CBM_EXTENDED_LABEL,
        repository: CBM_EXTENDED_REPOSITORY,
        revision: CBM_EXTENDED_REVISION,
        artifacts: [],
    });
}

/**
 * Acquires the extended pack. Failure is not fatal: installation continues and
 * the extended languages stay search-only until a later install succeeds.
 */
export async function acquireCbmExtendedPack(input: {
    homeDir: string;
    runtimePackageRoot: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    onProgress?: ModelProgressReporter;
    retryDelaysMs?: readonly number[];
}): Promise<{ directory: string } | { directory?: undefined; warning: string }> {
    try {
        const { modelDirectory } = await ensureModel({
            homeDir: input.homeDir,
            spec: readCbmExtendedPackSpec(input.runtimePackageRoot),
            env: input.env,
            fetchImpl: input.fetchImpl,
            onProgress: input.onProgress,
            retryDelaysMs: input.retryDelaysMs,
            // ~100 small modules: parallel requests hide per-request latency.
            concurrency: 8,
        });
        return { directory: modelDirectory };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            warning: `${CBM_EXTENDED_LABEL} unavailable (${message}); its languages stay search-only. Rerun install to retry.`,
        };
    }
}

/** Install/upgrade entry point: an explicit path wins; otherwise acquire, warning on failure. */
export async function resolveCbmExtendedPath(input: {
    homeDir: string;
    runtimePackageRoot: string | undefined;
    env?: NodeJS.ProcessEnv;
    options: Pick<InstallCommandOptions, "cbmExtendedPath" | "fetchImpl" | "modelProgress" | "modelRetryDelaysMs" | "onInstallWarning">;
}): Promise<string | undefined> {
    if (input.options.cbmExtendedPath) return input.options.cbmExtendedPath;
    if (!input.runtimePackageRoot) return undefined;
    const pack = await acquireCbmExtendedPack({
        homeDir: input.homeDir,
        runtimePackageRoot: input.runtimePackageRoot,
        env: input.env,
        fetchImpl: input.options.fetchImpl,
        onProgress: input.options.modelProgress,
        retryDelaysMs: input.options.modelRetryDelaysMs,
    });
    if ("warning" in pack) {
        input.options.onInstallWarning?.(pack.warning);
        return undefined;
    }
    return pack.directory;
}
