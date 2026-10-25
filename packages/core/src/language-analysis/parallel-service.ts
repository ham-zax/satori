import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { isPerfTraceEnabled, perfTrace } from '../utils/perf-trace';
import { envManager } from '../utils/env-manager';
import { filterWorkerExecArgv, resolveWorkerScriptPath } from '../utils/worker-threads';
import { createLanguageAnalysisService } from './service';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-runner';
import type {
    LanguageAnalysisInput,
    LanguageAnalysisPort,
    LanguageAnalysisResult,
    LanguageAnalysisServiceOptions,
} from './types';
import type {
    AnalysisWorkerPayload,
    IndexingAnalysisCapability,
    IndexingAnalysisResult,
} from './indexing-analysis';

/** Parsers and grammar WASM stay resident per worker; release idle workers to return that memory. */
const ANALYSIS_WORKER_IDLE_RELEASE_MS = 30_000;
/** Each worker holds its own parser state (~100 MB); cap the pool to bound RAM. */
const MAX_DEFAULT_ANALYSIS_WORKERS = 8;

export interface ParallelLanguageAnalysisPort extends LanguageAnalysisPort {
    readonly concurrency: number;
    dispose(): Promise<void>;
}

/** Worker count from SATORI_ANALYSIS_WORKERS, else available cores minus one, capped. */
export function resolveAnalysisWorkerCount(): number {
    const configured = envManager.get('SATORI_ANALYSIS_WORKERS');
    if (configured !== undefined && configured.trim() !== '') {
        const parsed = Number.parseInt(configured, 10);
        if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
    return Math.max(0, Math.min(MAX_DEFAULT_ANALYSIS_WORKERS, os.availableParallelism() - 1));
}

type PendingAnalysis = {
    resolve: (result: AnalysisWorkerPayload) => void;
    reject: (error: unknown) => void;
    submittedAt?: number;
    sourceBytes?: number;
};

type PoolWorker = {
    worker: Worker;
    pending: Map<number, PendingAnalysis>;
};

/**
 * Runs the language analysis service on a pool of worker threads. Analysis is a
 * pure function of its input, so results are identical to the in-process
 * service; callers that submit several files at once get them on separate cores.
 * With zero workers it is the in-process service.
 */
export function createParallelLanguageAnalysisService(
    options: LanguageAnalysisServiceOptions = {},
    workerCount = resolveAnalysisWorkerCount(),
): ParallelLanguageAnalysisPort {
    const local = createLanguageAnalysisService(options);
    const localIndexing = local as LanguageAnalysisPort & IndexingAnalysisCapability;
    const workers: PoolWorker[] = [];
    const retiring = new Set<Promise<number>>();
    let nextId = 1;
    let idleTimer: NodeJS.Timeout | undefined;
    let disposed = false;
    const totals = isPerfTraceEnabled() ? {
        count: 0, parseMs: 0, parseCount: 0, traversalMs: 0, traversalCount: 0,
        queueMs: 0, transferMs: 0, analysisMs: 0, sourceBytes: 0, resultBytes: 0, resultSizingMs: 0,
        cpuCount: 0, cpuUserMicros: 0, cpuSystemMicros: 0,
    } : undefined;
    const reportPerfTrace = (): void => {
        if (!totals || totals.count === 0) return;
        perfTrace('payload.worker.parse', totals.parseMs, { count: totals.parseCount });
        perfTrace('payload.worker.traversal', totals.traversalMs, { count: totals.traversalCount });
        perfTrace('payload.worker.queue', totals.queueMs, { count: totals.count });
        perfTrace('payload.worker.transfer', totals.transferMs, { count: totals.count });
        perfTrace('payload.worker.analysis', totals.analysisMs, { count: totals.count });
        perfTrace('payload.worker.result_sizing', totals.resultSizingMs, { count: totals.count });
        perfTrace('payload.worker.bytes', 0, {
            count: totals.count, sourceBytes: totals.sourceBytes,
            resultJsonBytes: totals.resultBytes,
        });
        perfTrace('payload.worker.cpu', (totals.cpuUserMicros + totals.cpuSystemMicros) / 1000, {
            count: totals.cpuCount, available: totals.cpuCount > 0,
            userMs: totals.cpuUserMicros / 1000, systemMs: totals.cpuSystemMicros / 1000,
        });
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = 0;
    };

    const pendingCount = () => workers.reduce((sum, entry) => sum + entry.pending.size, 0);

    const retire = (entry: PoolWorker) => {
        const exited = entry.worker.terminate();
        retiring.add(exited);
        void exited.finally(() => retiring.delete(exited));
        return exited;
    };

    const releaseAll = () => {
        for (const entry of workers.splice(0)) {
            retire(entry);
        }
    };

    const scheduleIdleRelease = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = undefined;
            if (pendingCount() === 0) releaseAll();
        }, ANALYSIS_WORKER_IDLE_RELEASE_MS);
        idleTimer.unref();
    };

    const failWorker = (entry: PoolWorker, error: unknown) => {
        const index = workers.indexOf(entry);
        if (index >= 0) workers.splice(index, 1);
        const pending = [...entry.pending.values()];
        entry.pending.clear();
        // A failed handle remains owned until exit; callers cannot drain a pool
        // that has silently discarded its still-terminating worker.
        void retire(entry).then(() => { for (const request of pending) request.reject(error); });
    };

    const spawnWorker = (): PoolWorker => {
        const worker = new Worker(resolveWorkerScriptPath(__filename, 'analysis-worker-runner'), {
            execArgv: filterWorkerExecArgv(),
            workerData: options,
        });
        // Workers never keep the process alive; idle release and dispose end them.
        worker.unref();
        const entry: PoolWorker = { worker, pending: new Map() };
        worker.on('message', (response: AnalysisWorkerResponse) => {
            const pending = entry.pending.get(response.id);
            if (!pending) return;
            entry.pending.delete(response.id);
            if (response.ok && response.perfTiming && totals && pending.submittedAt !== undefined) {
                const timing = response.perfTiming;
                totals.count++;
                totals.parseMs += timing.parseMs;
                totals.parseCount += timing.parseCount;
                totals.traversalMs += timing.traversalMs;
                totals.traversalCount += timing.traversalCount;
                // performance.now() shares one monotonic clock across Node worker threads.
                totals.queueMs += timing.startedAt - pending.submittedAt;
                totals.transferMs += performance.now() - timing.finishedAt;
                totals.analysisMs += timing.finishedAt - timing.startedAt - timing.resultSizingMs;
                totals.resultSizingMs += timing.resultSizingMs;
                totals.sourceBytes += pending.sourceBytes ?? 0;
                totals.resultBytes += timing.resultBytes;
                if (timing.cpuUserMicros !== undefined && timing.cpuSystemMicros !== undefined) {
                    totals.cpuCount++;
                    totals.cpuUserMicros += timing.cpuUserMicros;
                    totals.cpuSystemMicros += timing.cpuSystemMicros;
                }
            }
            if (response.ok) pending.resolve(response.result);
            else pending.reject(new Error(response.error));
            if (pendingCount() === 0) scheduleIdleRelease();
        });
        worker.on('error', (error) => failWorker(entry, error));
        worker.on('exit', (code) => {
            if (entry.pending.size > 0) failWorker(entry, new Error(`Language analysis worker exited with code ${code}.`));
        });
        workers.push(entry);
        return entry;
    };

    const leastBusyWorker = (): PoolWorker => {
        const idle = workers.find((entry) => entry.pending.size === 0);
        if (idle) return idle;
        if (workers.length < workerCount) return spawnWorker();
        return workers.reduce((best, entry) => (entry.pending.size < best.pending.size ? entry : best));
    };

    const dispatch = (
        input: LanguageAnalysisInput,
        mode?: 'indexing',
    ): Promise<AnalysisWorkerPayload> => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
        }
        const entry = leastBusyWorker();
        const id = nextId++;
        return new Promise<AnalysisWorkerPayload>((resolve, reject) => {
            const pending: PendingAnalysis = { resolve, reject };
            if (totals) {
                pending.sourceBytes = Buffer.byteLength(input.content, 'utf8');
                pending.submittedAt = performance.now();
            }
            entry.pending.set(id, pending);
            entry.worker.postMessage({
                id,
                ...(mode ? { mode } : {}),
                input: {
                    content: input.content,
                    language: input.language,
                    relativePath: input.relativePath,
                    ...(input.includeEarlyExitSpans === undefined
                        ? {}
                        : { includeEarlyExitSpans: input.includeEarlyExitSpans }),
                },
            } satisfies AnalysisWorkerRequest);
        });
    };

    const service = {
        concurrency: Math.max(1, workerCount),
        getDescription: () => local.getDescription(),
        reportPerfTrace,
        getStrategyForLanguage: (language: string) => local.getStrategyForLanguage(language),
        async analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult> {
            if (workerCount === 0 || disposed) return local.analyze(input);
            return await dispatch(input) as LanguageAnalysisResult;
        },
        async analyzeForIndexing(input: LanguageAnalysisInput): Promise<IndexingAnalysisResult> {
            if (workerCount === 0 || disposed) return localIndexing.analyzeForIndexing(input);
            return await dispatch(input, 'indexing') as IndexingAnalysisResult;
        },
        releaseIdleWorkers(): void {
            if (pendingCount() > 0) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = undefined;
            releaseAll();
        },
        async dispose(): Promise<void> {
            disposed = true;
            if (idleTimer) clearTimeout(idleTimer);
            const all = workers.splice(0);
            for (const entry of all) {
                for (const pending of entry.pending.values()) pending.reject(new Error('Language analysis service was disposed.'));
                entry.pending.clear();
            }
            await Promise.all([...all.map(retire), ...retiring]);
        },
    };
    return service as ParallelLanguageAnalysisPort & IndexingAnalysisCapability;
}
