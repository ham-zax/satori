import { parentPort, workerData } from 'node:worker_threads';
import { isPerfTraceEnabled } from '../utils/perf-trace';
import { createLanguageAnalysisService } from './service';
import type {
    LanguageAnalysisInput,
    LanguageAnalysisTiming,
    LanguageAnalysisServiceOptions,
} from './types';
import type {
    AnalysisWorkerPayload,
    IndexingAnalysisCapability,
} from './indexing-analysis';

export type AnalysisWorkerRequest = { id: number; input: LanguageAnalysisInput; mode?: 'indexing' };
export interface AnalysisWorkerTiming extends LanguageAnalysisTiming {
    startedAt: number;
    finishedAt: number;
    resultBytes: number;
    resultSizingMs: number;
    cpuUserMicros?: number;
    cpuSystemMicros?: number;
}

export type AnalysisWorkerResponse =
    | { id: number; ok: true; result: AnalysisWorkerPayload; perfTiming?: AnalysisWorkerTiming }
    | { id: number; ok: false; error: string };

const service = createLanguageAnalysisService(workerData as LanguageAnalysisServiceOptions);
const indexingService = service as typeof service & IndexingAnalysisCapability;
const threadCpuUsage = (process as typeof process & {
    threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
}).threadCpuUsage;
let tracedRequests = 0;
let busyCpuBefore: NodeJS.CpuUsage | undefined;

if (parentPort) {
    const port = parentPort;
    port.on('message', async (message: AnalysisWorkerRequest) => {
        const timing: AnalysisWorkerTiming | undefined = isPerfTraceEnabled() ? {
            parseMs: 0, parseCount: 0, traversalMs: 0, traversalCount: 0,
            startedAt: performance.now(), finishedAt: 0, resultBytes: 0, resultSizingMs: 0,
        } : undefined;
        // threadCpuUsage is unavailable on older Node releases. Never substitute process-wide CPU.
        if (timing) {
            if (tracedRequests++ === 0 && threadCpuUsage) busyCpuBefore = threadCpuUsage();
            message.input = { ...message.input, perfTiming: timing };
        }
        try {
            const result = message.mode === 'indexing'
                ? await indexingService.analyzeForIndexing(message.input)
                : await service.analyze(message.input);
            if (timing) {
                // JSON bytes are a reproducible payload-size proxy, not structured-clone wire bytes.
                const sizingStartedAt = performance.now();
                timing.resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
                timing.finishedAt = performance.now();
                timing.resultSizingMs = timing.finishedAt - sizingStartedAt;
                if (tracedRequests === 1 && busyCpuBefore && threadCpuUsage) {
                    const cpu = threadCpuUsage(busyCpuBefore);
                    timing.cpuUserMicros = cpu.user;
                    timing.cpuSystemMicros = cpu.system;
                }
            }
            if (timing) {
                port.postMessage({ id: message.id, ok: true, result, perfTiming: timing } satisfies AnalysisWorkerResponse);
            } else {
                port.postMessage({ id: message.id, ok: true, result } satisfies AnalysisWorkerResponse);
            }
        } catch (error) {
            port.postMessage({
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            } satisfies AnalysisWorkerResponse);
        } finally {
            if (timing && --tracedRequests === 0) busyCpuBefore = undefined;
        }
    });
}
