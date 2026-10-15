import { parentPort, workerData } from 'node:worker_threads';
import { createLanguageAnalysisService } from './service';
import type {
    LanguageAnalysisInput,
    LanguageAnalysisServiceOptions,
} from './types';
import type {
    AnalysisWorkerPayload,
    IndexingAnalysisCapability,
} from './indexing-analysis';

export type AnalysisWorkerRequest = { id: number; input: LanguageAnalysisInput; mode?: 'indexing' };
export type AnalysisWorkerResponse =
    | { id: number; ok: true; result: AnalysisWorkerPayload }
    | { id: number; ok: false; error: string };

const service = createLanguageAnalysisService(workerData as LanguageAnalysisServiceOptions);
const indexingService = service as typeof service & IndexingAnalysisCapability;

if (parentPort) {
    const port = parentPort;
    port.on('message', async (message: AnalysisWorkerRequest) => {
        try {
            const result = message.mode === 'indexing'
                ? await indexingService.analyzeForIndexing(message.input)
                : await service.analyze(message.input);
            port.postMessage({ id: message.id, ok: true, result } satisfies AnalysisWorkerResponse);
        } catch (error) {
            port.postMessage({
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            } satisfies AnalysisWorkerResponse);
        }
    });
}
