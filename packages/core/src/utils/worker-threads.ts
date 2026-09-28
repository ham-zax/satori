import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves a worker entry next to its caller: the compiled `.js` in dist, or the
 * `.ts` source when running under a TypeScript loader.
 */
export function resolveWorkerScriptPath(callerFilename: string, baseName: string): string {
    const dir = path.dirname(callerFilename);
    const candidateTs = path.resolve(dir, `${baseName}.ts`);
    const candidateJs = path.resolve(dir, `${baseName}.js`);
    const isTs = callerFilename.endsWith('.ts') || !fs.existsSync(candidateJs);
    if (isTs && fs.existsSync(candidateTs)) return candidateTs;
    if (fs.existsSync(candidateJs)) return candidateJs;
    return candidateTs;
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
            }
        }
    }
    return result;
}
