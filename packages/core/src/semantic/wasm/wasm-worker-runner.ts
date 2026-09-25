import { parentPort } from 'node:worker_threads';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';
import type {
    SemanticProjectInput,
    SemanticProviderCoverage,
    SemanticResolvedOccurrence,
    SemanticSkippedFile,
} from '../contracts';

const analyzer = new WasmSemanticProjectAnalyzer();

export type WasmWorkerRequest = {
    id: number;
    input: SemanticProjectInput;
};

export type WasmWorkerResponse =
    | {
        id: number;
        success: true;
        evidence: {
            language: string;
            occurrencesEntries: Array<[string, SemanticResolvedOccurrence[]]>;
            skippedFiles?: readonly SemanticSkippedFile[];
            coverage?: SemanticProviderCoverage;
        };
    }
    | {
        id: number;
        success: false;
        error: string;
    };

if (parentPort) {
    parentPort.on('message', async (message: WasmWorkerRequest) => {
        try {
            const evidence = await analyzer.analyze(message.input);
            const occurrencesEntries: Array<[string, SemanticResolvedOccurrence[]]> = [];
            for (const [file, occurrences] of evidence.occurrencesByFile.entries()) {
                occurrencesEntries.push([file, [...occurrences]]);
            }
            const response: WasmWorkerResponse = {
                id: message.id,
                success: true,
                evidence: {
                    language: evidence.language,
                    occurrencesEntries,
                    ...(evidence.skippedFiles ? { skippedFiles: evidence.skippedFiles } : {}),
                    ...(evidence.coverage ? { coverage: evidence.coverage } : {}),
                },
            };
            parentPort!.postMessage(response);
        } catch (error) {
            const response: WasmWorkerResponse = {
                id: message.id,
                success: false,
                error: error instanceof Error ? error.stack || error.message : String(error),
            };
            parentPort!.postMessage(response);
        }
    });
}
