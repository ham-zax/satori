import { spawn } from 'node:child_process';
import { filterWorkerExecArgv, resolveWorkerScriptPath } from '../utils/worker-threads';
import { CbmExtractorUnavailableError, type CbmDefinitionRecord } from './cbm-extractor-host';

/** Each request owns its child until close; no parser or background compiler survives the call. */
export function extractWithBaselineChild(
    assetRoot: string,
    language: string,
    relativePath: string,
    source: string,
): Promise<CbmDefinitionRecord[]> {
    const runner = resolveWorkerScriptPath(__filename, 'cbm-extractor-child-runner');
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--liftoff-only', ...filterWorkerExecArgv(), runner], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        let diagnostic = '';
        let failure: Error | undefined;
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-2000); });
        child.on('error', (error) => { failure = error; });
        child.stdin.on('error', (error) => {
            failure = error;
            child.kill();
        });
        child.on('close', (code, signal) => {
            if (failure) { reject(failure); return; }
            if (code !== 0) {
                reject(new Error(`CBM extractor child failed for ${relativePath} (${signal ?? code}): ${diagnostic}`));
                return;
            }
            try {
                const response = JSON.parse(output) as { records?: CbmDefinitionRecord[]; error?: string; unavailable?: boolean };
                if (typeof response.error === 'string') {
                    throw response.unavailable
                        ? new CbmExtractorUnavailableError(response.error)
                        : new Error(response.error);
                }
                if (!Array.isArray(response.records)) throw new Error(`Invalid CBM extractor child response for ${relativePath}`);
                resolve(response.records);
            } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify({ assetRoot, language, relativePath, source }));
    });
}
