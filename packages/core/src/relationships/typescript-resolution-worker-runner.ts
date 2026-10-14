import { parentPort, workerData } from 'node:worker_threads';
import { TypeScriptSemanticProjectAnalyzer } from './typescript-semantic-analyzer';
import type { ResolutionProjectInput } from './resolution';
import type { TypeScriptResourceFailureRank } from './typescript-resolution-shards';

export type TypeScriptResolutionWorkerRequest =
    | { id: number; method: 'analyze'; input: ResolutionProjectInput }
    | { id: number; method: 'getProjectJobs'; input: ResolutionProjectInput; shardCount: number }
    | { id: number; method: 'importProjectStates'; rootPath: string; states: readonly string[] }
    | { id: number; method: 'getProviderMetadata'; language: string }
    | { id: number; method: 'getSourceControlFiles'; input: { rootPath: string; language: string; sourceFiles: readonly string[] } };

export type TypeScriptResolutionWorkerResponse =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; error: string; projectFailureRank?: TypeScriptResourceFailureRank };

// One analyzer per worker keeps its TypeScript sessions and snapshots across calls.
const options = workerData as {
    maxSessions: number;
    stateDirectory?: string;
    shard?: { index: number; count: number };
    projectKey?: string;
};
const analyzer = new TypeScriptSemanticProjectAnalyzer(options.maxSessions, undefined, undefined, {
    stateDirectory: options.stateDirectory,
    shard: options.shard,
    projectKey: options.projectKey,
});

if (parentPort) {
    const port = parentPort;
    port.on('message', async (request: TypeScriptResolutionWorkerRequest) => {
        try {
            let value: unknown;
            switch (request.method) {
                case 'analyze': {
                    const result = await analyzer.analyzeShard(request.input);
                    value = options.projectKey === undefined ? result : {
                        ...result, state: analyzer.exportRootState(request.input.rootPath),
                    };
                    break;
                }
                case 'getProjectJobs': value = analyzer.getProjectJobs(request.input, request.shardCount); break;
                case 'importProjectStates': value = analyzer.importProjectStates(request.rootPath, request.states); break;
                case 'getProviderMetadata': value = analyzer.getProviderMetadata(request.language); break;
                case 'getSourceControlFiles': value = await analyzer.getSourceControlFiles(request.input); break;
            }
            port.postMessage({ id: request.id, ok: true, value } satisfies TypeScriptResolutionWorkerResponse);
        } catch (error) {
            port.postMessage({
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                projectFailureRank: request.method === 'analyze' ? analyzer.getProjectFailureRank() : undefined,
            } satisfies TypeScriptResolutionWorkerResponse);
        }
    });
}
