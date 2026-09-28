import { Worker } from 'node:worker_threads';
import { filterWorkerExecArgv, resolveWorkerScriptPath } from '../utils/worker-threads';
import type {
    ResolutionProjectAnalyzer,
    ResolutionProjectEvidence,
    ResolutionProjectInput,
} from './resolution';
import type {
    TypeScriptResolutionWorkerRequest,
    TypeScriptResolutionWorkerResponse,
} from './typescript-resolution-worker-runner';

type SourceControlInput = {
    readonly rootPath: string;
    readonly language: string;
    readonly sourceFiles: readonly string[];
};

type WorkerRequestBody =
    | { method: 'analyze'; input: ResolutionProjectInput }
    | { method: 'getProviderMetadata'; language: string }
    | { method: 'getSourceControlFiles'; input: SourceControlInput };

/**
 * Runs the TypeScript compiler analyzer on its own worker thread. Compiler work
 * is synchronous and takes seconds per project; on the indexing thread it would
 * stall the event loop that embedding and vector writes need. The worker keeps
 * the analyzer (and its cached sessions) for its lifetime. A worker that dies
 * fails its pending requests; the next request starts a fresh one, which is
 * the same cold state as a new process.
 */
class WorkerTypeScriptResolutionAnalyzer implements ResolutionProjectAnalyzer {
    private worker: Worker | undefined;
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private nextId = 1;
    private disposed = false;

    constructor(
        private readonly maxSessions: number,
        private readonly stateDirectory: string | undefined,
    ) {}

    supportsLanguage(language: string): boolean {
        return language.trim().toLowerCase() === 'typescript';
    }

    analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        return this.request({ method: 'analyze', input }) as Promise<ResolutionProjectEvidence>;
    }

    getProviderMetadata(language: string) {
        return this.request({ method: 'getProviderMetadata', language }) as Promise<Readonly<{
            providerId: string;
            providerVersion: string;
            environmentConfigId?: string;
        }> | undefined>;
    }

    getSourceControlFiles(input: SourceControlInput): Promise<readonly string[]> {
        return this.request({ method: 'getSourceControlFiles', input }) as Promise<readonly string[]>;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const worker = this.worker;
        this.failPending(new Error('TypeScript resolution analyzer was disposed.'));
        await worker?.terminate();
    }

    private startWorker(): Worker {
        const worker = new Worker(resolveWorkerScriptPath(__filename, 'typescript-resolution-worker-runner'), {
            execArgv: filterWorkerExecArgv(),
            workerData: { maxSessions: this.maxSessions, stateDirectory: this.stateDirectory },
        });
        worker.unref();
        worker.on('message', (response: TypeScriptResolutionWorkerResponse) => {
            const pending = this.pending.get(response.id);
            if (!pending) return;
            this.pending.delete(response.id);
            if (response.ok) pending.resolve(response.value);
            else pending.reject(new Error(response.error));
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) return;
            this.failPending(error);
        };
        worker.on('error', fail);
        worker.on('exit', (code) => fail(new Error(`TypeScript resolution worker exited with code ${code}.`)));
        return worker;
    }

    /** Rejects every pending request and drops the current worker. */
    private failPending(error: Error): void {
        this.worker = undefined;
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending) entry.reject(error);
    }

    private request(body: WorkerRequestBody): Promise<unknown> {
        if (this.disposed) return Promise.reject(new Error('TypeScript resolution analyzer was disposed.'));
        const worker = this.worker ??= this.startWorker();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            // The worker holds the event loop only while a request is pending.
            worker.ref();
            const settle = () => {
                if (this.pending.size === 0) worker.unref();
            };
            this.pending.set(id, {
                resolve: (value) => { resolve(value); settle(); },
                reject: (error) => { reject(error); settle(); },
            });
            try {
                worker.postMessage({ id, ...body } as TypeScriptResolutionWorkerRequest);
            } catch (error) {
                // An uncloneable input never reaches the worker; do not leave it pending.
                const entry = this.pending.get(id);
                this.pending.delete(id);
                entry?.reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
}

export class LazyTypeScriptSemanticProjectAnalyzer implements ResolutionProjectAnalyzer {
    private analyzerPromise?: Promise<ResolutionProjectAnalyzer>;

    /** `stateDirectory` keeps each root's resolution state across processes. */
    constructor(
        private readonly maxSessions = 4,
        private readonly stateDirectory?: string,
    ) {}

    supportsLanguage(language: string): boolean {
        return language.trim().toLowerCase() === 'typescript';
    }

    analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        return this.loadAnalyzer().then((analyzer) => analyzer.analyze(input));
    }

    async getProviderMetadata(language: string) {
        if (!this.supportsLanguage(language)) return undefined;
        const analyzer = await this.loadAnalyzer();
        return analyzer.getProviderMetadata?.(language);
    }

    async getSourceControlFiles(input: SourceControlInput): Promise<readonly string[]> {
        if (!this.supportsLanguage(input.language)) return [];
        const analyzer = await this.loadAnalyzer();
        return analyzer.getSourceControlFiles?.(input) ?? [];
    }

    async dispose(): Promise<void> {
        if (!this.analyzerPromise) return;
        const analyzer = await this.analyzerPromise;
        await analyzer.dispose?.();
    }

    private loadAnalyzer(): Promise<ResolutionProjectAnalyzer> {
        this.analyzerPromise ??= Promise.resolve(new WorkerTypeScriptResolutionAnalyzer(this.maxSessions, this.stateDirectory));
        return this.analyzerPromise;
    }
}
