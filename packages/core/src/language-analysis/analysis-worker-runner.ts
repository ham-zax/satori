import { parentPort, workerData } from 'node:worker_threads';
import { createLanguageAnalysisService } from './service';
import type {
    LanguageAnalysisInput,
    LanguageAnalysisResult,
    LanguageAnalysisServiceOptions,
} from './types';

export type AnalysisWorkerRequest = { id: number; input: LanguageAnalysisInput };
export type AnalysisWorkerResponse =
    | { id: number; ok: true; result: LanguageAnalysisResult }
    | { id: number; ok: false; error: string };

const service = createLanguageAnalysisService(workerData as LanguageAnalysisServiceOptions);

if (parentPort) {
    const port = parentPort;
    port.on('message', async (message: AnalysisWorkerRequest) => {
        try {
            const result = await service.analyze(message.input);
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
