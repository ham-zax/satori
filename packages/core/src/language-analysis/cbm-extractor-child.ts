import { spawn } from 'node:child_process';
import { filterWorkerExecArgv, resolveWorkerScriptPath } from '../utils/worker-threads';
import { CbmExtractorUnavailableError, type CbmDefinitionRecord } from './cbm-extractor-host';

const DEFAULT_CHILD_TIMEOUT_MS = 30_000;
const DEFAULT_CHILD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface ExtractWithBaselineChildOptions {
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly signal?: AbortSignal;
}

/** Each request owns its child until close; no parser or background compiler survives the call. */
export function extractWithBaselineChild(
    assetRoot: string,
    language: string,
    relativePath: string,
    source: string,
    options: ExtractWithBaselineChildOptions = {},
): Promise<CbmDefinitionRecord[]> {
    const runner = resolveWorkerScriptPath(__filename, 'cbm-extractor-child-runner');
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CHILD_MAX_OUTPUT_BYTES;
    const signal = options.signal;

    if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new Error(`CBM extractor child cancelled for ${relativePath}`));
    }

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--liftoff-only', ...filterWorkerExecArgv(), runner], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let output = '';
        let outputBytes = 0;
        let diagnostic = '';
        let failure: Error | undefined;

        const failAndKill = (error: Error): void => {
            if (!failure) failure = error;
            if (child.exitCode === null && child.signalCode === null) {
                try { child.kill('SIGKILL'); } catch { /* ignore */ }
            }
        };

        const timer = timeoutMs > 0
            ? setTimeout(() => {
                failAndKill(new Error(`CBM extractor child timed out after ${timeoutMs}ms for ${relativePath}`));
            }, timeoutMs)
            : undefined;
        timer?.unref?.();

        const onAbort = (): void => {
            const reason = signal?.reason;
            failAndKill(reason instanceof Error ? reason : new Error(`CBM extractor child cancelled for ${relativePath}`));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
            if (failure) return;
            outputBytes += Buffer.byteLength(chunk, 'utf8');
            if (outputBytes > maxOutputBytes) {
                failAndKill(new Error(
                    `CBM extractor child stdout exceeded output limit of ${maxOutputBytes} bytes for ${relativePath}`,
                ));
                return;
            }
            output += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-2000); });
        child.on('error', (error) => { failure ??= error; });
        child.stdin.on('error', (error) => {
            failAndKill(error);
        });
        child.on('close', (code, exitSignal) => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (failure) { reject(failure); return; }
            if (code !== 0) {
                reject(new Error(`CBM extractor child failed for ${relativePath} (${exitSignal ?? code}): ${diagnostic}`));
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
