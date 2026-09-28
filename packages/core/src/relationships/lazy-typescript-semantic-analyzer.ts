import os from 'node:os';
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
import { mergeTypeScriptShardEvidence, type TypeScriptShardEvidence } from './typescript-resolution-shards';

/** TypeScript projects are analyzed on this many worker threads at most. */
const MAX_TYPESCRIPT_RESOLUTION_SHARDS = 3;

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
class WorkerTypeScriptResolutionAnalyzer {
    private worker: Worker | undefined;
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private nextId = 1;
    private disposed = false;

    constructor(
        private readonly maxSessions: number,
        private readonly stateDirectory: string | undefined,
        private readonly shard: Readonly<{ index: number; count: number }> | undefined,
    ) {}

    analyzeShard(input: ResolutionProjectInput): Promise<TypeScriptShardEvidence> {
        return this.request({ method: 'analyze', input }) as Promise<TypeScriptShardEvidence>;
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
            workerData: { maxSessions: this.maxSessions, stateDirectory: this.stateDirectory, shard: this.shard },
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

/**
 * Splits TypeScript projects across worker threads (the analyzer's `shard`
 * option) and merges their evidence into what one analyzer returns. Metadata
 * requests go to the first shard only.
 */
class ShardedTypeScriptResolutionAnalyzer implements ResolutionProjectAnalyzer {
    readonly shards: readonly WorkerTypeScriptResolutionAnalyzer[];

    constructor(maxSessions: number, stateDirectory: string | undefined, count: number) {
        this.shards = Array.from({ length: count }, (_, index) => new WorkerTypeScriptResolutionAnalyzer(
            count === 1 ? maxSessions : Math.max(2, Math.ceil(maxSessions / count)),
            stateDirectory,
            count === 1 ? undefined : { index, count },
        ));
    }

    supportsLanguage(language: string): boolean {
        return language.trim().toLowerCase() === 'typescript';
    }

    async analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        // Wait for every shard, even after one fails, so no worker is still
        // analyzing when this returns.
        const settled = await Promise.allSettled(this.shards.map((shard) => shard.analyzeShard(input)));
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
        return mergeTypeScriptShardEvidence(settled.map((result) => (
            (result as PromiseFulfilledResult<TypeScriptShardEvidence>).value
        )));
    }

    getProviderMetadata(language: string) {
        return this.shards[0].getProviderMetadata(language);
    }

    getSourceControlFiles(input: SourceControlInput): Promise<readonly string[]> {
        return this.shards[0].getSourceControlFiles(input);
    }

    async dispose(): Promise<void> {
        await Promise.all(this.shards.map((shard) => shard.dispose()));
    }
}

function resolutionShardCount(): number {
    return Math.max(1, Math.min(MAX_TYPESCRIPT_RESOLUTION_SHARDS, os.availableParallelism() - 1));
}

export class LazyTypeScriptSemanticProjectAnalyzer implements ResolutionProjectAnalyzer {
    private analyzerPromise?: Promise<ResolutionProjectAnalyzer>;

    /** `stateDirectory` keeps each root's resolution state across processes. */
    constructor(
        private readonly maxSessions = 4,
        private readonly stateDirectory?: string,
        private readonly shardCount = resolutionShardCount(),
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
        this.analyzerPromise ??= Promise.resolve(new ShardedTypeScriptResolutionAnalyzer(
            this.maxSessions,
            this.stateDirectory,
            this.shardCount,
        ));
        return this.analyzerPromise;
    }
}
