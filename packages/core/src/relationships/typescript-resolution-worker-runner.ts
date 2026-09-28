import { parentPort, workerData } from 'node:worker_threads';
import { TypeScriptSemanticProjectAnalyzer } from './typescript-semantic-analyzer';
import type { ResolutionProjectInput } from './resolution';

export type TypeScriptResolutionWorkerRequest =
    | { id: number; method: 'analyze'; input: ResolutionProjectInput }
    | { id: number; method: 'getProviderMetadata'; language: string }
    | { id: number; method: 'getSourceControlFiles'; input: { rootPath: string; language: string; sourceFiles: readonly string[] } };

export type TypeScriptResolutionWorkerResponse =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; error: string };

// One analyzer per worker keeps its TypeScript sessions and snapshots across calls.
const analyzer = new TypeScriptSemanticProjectAnalyzer((workerData as { maxSessions: number }).maxSessions);

if (parentPort) {
    const port = parentPort;
    port.on('message', async (request: TypeScriptResolutionWorkerRequest) => {
        try {
            const value = request.method === 'analyze'
                ? await analyzer.analyze(request.input)
                : request.method === 'getProviderMetadata'
                    ? await analyzer.getProviderMetadata?.(request.language)
                    : await analyzer.getSourceControlFiles?.(request.input);
            port.postMessage({ id: request.id, ok: true, value } satisfies TypeScriptResolutionWorkerResponse);
        } catch (error) {
            port.postMessage({
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            } satisfies TypeScriptResolutionWorkerResponse);
        }
    });
}
