import os from 'node:os';
import { Worker } from 'node:worker_threads';
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
    resolve: (result: LanguageAnalysisResult) => void;
    reject: (error: Error) => void;
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
    const workers: PoolWorker[] = [];
    let nextId = 1;
    let idleTimer: NodeJS.Timeout | undefined;
    let disposed = false;

    const pendingCount = () => workers.reduce((sum, entry) => sum + entry.pending.size, 0);

    const releaseAll = () => {
        for (const entry of workers.splice(0)) {
            void entry.worker.terminate();
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

    const failWorker = (entry: PoolWorker, error: Error) => {
        const index = workers.indexOf(entry);
        if (index >= 0) workers.splice(index, 1);
        for (const pending of entry.pending.values()) pending.reject(error);
        entry.pending.clear();
        void entry.worker.terminate();
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

    return {
        concurrency: Math.max(1, workerCount),
        getDescription: () => local.getDescription(),
        getStrategyForLanguage: (language) => local.getStrategyForLanguage(language),
        async analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult> {
            if (workerCount === 0 || disposed) return local.analyze(input);
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = undefined;
            }
            const entry = leastBusyWorker();
            const id = nextId++;
            return new Promise<LanguageAnalysisResult>((resolve, reject) => {
                entry.pending.set(id, { resolve, reject });
                entry.worker.postMessage({
                    id,
                    input: { content: input.content, language: input.language, relativePath: input.relativePath },
                } satisfies AnalysisWorkerRequest);
            });
        },
        async dispose(): Promise<void> {
            disposed = true;
            if (idleTimer) clearTimeout(idleTimer);
            const all = workers.splice(0);
            for (const entry of all) {
                for (const pending of entry.pending.values()) pending.reject(new Error('Language analysis service was disposed.'));
                entry.pending.clear();
            }
            await Promise.all(all.map((entry) => entry.worker.terminate()));
        },
    };
}
