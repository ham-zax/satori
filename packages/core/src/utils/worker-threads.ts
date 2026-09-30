import fs from 'node:fs';
import path from 'node:path';

/** A runtime artifact (built worker/entry file) is absent; the only fix is reinstalling the package. */
export class RuntimeArtifactMissingError extends Error {
    readonly remediation = 'reinstall' as const;

    constructor(artifactPath: string) {
        super(`Satori runtime file '${artifactPath}' is missing; reinstall is required.`);
        this.name = 'RuntimeArtifactMissingError';
    }
}

/**
 * Resolves a worker entry next to its caller with the caller's own extension:
 * compiled `.js` in dist, or `.ts` when the caller itself runs from source under a loader.
 */
export function resolveWorkerScriptPath(callerFilename: string, baseName: string): string {
    const scriptPath = path.resolve(path.dirname(callerFilename), `${baseName}${path.extname(callerFilename)}`);
    if (!fs.existsSync(scriptPath)) throw new RuntimeArtifactMissingError(scriptPath);
    return scriptPath;
}

/** Loader flags (e.g. `--import tsx`) a worker needs to run the same sources as its parent. */
export function filterWorkerExecArgv(): string[] {
    const validPrefixes = ['--import', '--loader', '--experimental-loader', '--require', '-r'];
    const result: string[] = [];
    for (let i = 0; i < process.execArgv.length; i++) {
        const arg = process.execArgv[i];
        if (validPrefixes.some((prefix) => arg === prefix || arg.startsWith(prefix + '='))) {
            result.push(arg);
            if (arg === '--import' || arg === '--loader' || arg === '--experimental-loader' || arg === '--require' || arg === '-r') {
                if (i + 1 < process.execArgv.length && !process.execArgv[i + 1].startsWith('-')) {
                    result.push(process.execArgv[++i]);
                }
                // Preload scripts written in TypeScript (test setup) only need to run in the parent: workers inherit its env,
                // and Node < 22.14 workers cannot load a .ts preload.
                if (arg === '--import' && result[result.length - 1].endsWith('.ts')) {
                    result.splice(-2, 2);
                    continue;
                }
                // Node < 22.14 workers ignore tsx's ESM hooks ("Unknown file extension .ts"); tsx/cjs works everywhere.
                if (arg === '--import' && result[result.length - 1] === 'tsx') {
                    result.splice(-2, 2, '--require', 'tsx/cjs');
                }
            }
        }
    }
    return result;
}
