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

type ProjectJobEvidence = TypeScriptShardEvidence & { readonly state?: string };

type SourceControlInput = {
    readonly rootPath: string;
    readonly language: string;
    readonly sourceFiles: readonly string[];
};

type WorkerRequestBody =
    | { method: 'analyze'; input: ResolutionProjectInput }
    | { method: 'getProjectJobs'; input: ResolutionProjectInput; shardCount: number }
    | { method: 'importProjectStates'; rootPath: string; states: readonly string[] }
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
        private readonly projectKey?: string,
    ) {}

    analyzeShard(input: ResolutionProjectInput): Promise<ProjectJobEvidence> {
        return this.request({ method: 'analyze', input }) as Promise<ProjectJobEvidence>;
    }

    getProjectJobs(input: ResolutionProjectInput, shardCount: number) {
        return this.request({ method: 'getProjectJobs', input, shardCount }) as Promise<readonly { key: string; shardIndex: number }[]>;
    }

    async importProjectStates(rootPath: string, states: readonly string[]): Promise<void> {
        await this.request({ method: 'importProjectStates', rootPath, states });
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
        await this.releaseWorker();
    }

    async releaseWorker(): Promise<void> {
        const worker = this.worker;
        this.failPending(new Error('TypeScript resolution analyzer was disposed.'));
        await worker?.terminate();
        if (this.worker === worker) this.worker = undefined;
    }

    private startWorker(): Worker {
        const worker = new Worker(resolveWorkerScriptPath(__filename, 'typescript-resolution-worker-runner'), {
            execArgv: filterWorkerExecArgv(),
            workerData: { maxSessions: this.maxSessions, stateDirectory: this.stateDirectory, shard: this.shard, projectKey: this.projectKey },
        });
        worker.unref();
        worker.on('message', (response: TypeScriptResolutionWorkerResponse) => {
            const pending = this.pending.get(response.id);
            if (!pending) return;
            this.pending.delete(response.id);
            if (response.ok) pending.resolve(response.value);
            else pending.reject(Object.assign(new Error(response.error), { projectFailureRank: response.projectFailureRank }));
        });
        const fail = (error: Error) => {
            if (this.worker !== worker) return;
            this.failPending(error);
        };
        worker.on('error', fail);
        worker.on('exit', (code) => {
            fail(new Error(`TypeScript resolution worker exited with code ${code}.`));
            if (this.worker === worker) this.worker = undefined;
        });
        return worker;
    }

    /** Retain the handle until exit so failure cleanup can still await termination. */
    private failPending(error: Error): void {
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
    private readonly activeJobs = new Set<WorkerTypeScriptResolutionAnalyzer>();
    private disposed = false;
    private analysisTail: Promise<void> = Promise.resolve();
    private providerMetadata?: Awaited<ReturnType<WorkerTypeScriptResolutionAnalyzer['getProviderMetadata']>>;

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

    analyze(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        // A full index must not overlap a previous warm analysis's Programs.
        const operation = this.analysisTail.then(async () => {
            if (this.disposed) throw new Error('TypeScript resolution analyzer was disposed.');
            try {
                return input.changedFiles === undefined
                    ? await this.analyzeFullIndex(input)
                    : await this.analyzeWarm(input);
            } catch (error) {
                await Promise.all([...this.shards, ...this.activeJobs].map((shard) => shard.releaseWorker()));
                this.activeJobs.clear();
                throw error;
            }
        });
        this.analysisTail = operation.then(() => {}, () => {});
        return operation;
    }

    private async analyzeFullIndex(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        await Promise.all(this.shards.map((shard) => shard.releaseWorker()));
        await this.getProviderMetadata(input.language);
        const jobs = await this.shards[0].getProjectJobs(input, this.shards.length);
        // An empty input still gets the established empty-provider evidence.
        const keys: readonly (string | undefined)[] = jobs.length ? jobs.map((job) => job.key) : [undefined];
        const settled: PromiseSettledResult<ProjectJobEvidence>[] = new Array(keys.length);
        const concurrency = input.resourcePlan?.typescriptProjectConcurrency ?? 1;
        let nextIndex = 0;
        const runLane = async () => {
            while (nextIndex < keys.length && !this.disposed) {
                const index = nextIndex++;
                const worker = new WorkerTypeScriptResolutionAnalyzer(1, undefined, undefined, keys[index]);
                this.activeJobs.add(worker);
                try {
                    const value = await worker.analyzeShard(input);
                    settled[index] = { status: 'fulfilled', value };
                } catch (reason) {
                    settled[index] = { status: 'rejected', reason };
                } finally {
                    // A slot is reused only after its isolate exits. Continuous
                    // lanes avoid a slow project holding up all later projects.
                    await worker.dispose();
                    this.activeJobs.delete(worker);
                }
            }
        };
        const lanes = await Promise.allSettled(Array.from({ length: Math.min(keys.length, concurrency) }, runLane));
        const laneFailure = lanes.find((lane): lane is PromiseRejectedResult => lane.status === 'rejected');
        if (laneFailure) throw laneFailure.reason;
        if (this.disposed) throw new Error('TypeScript resolution analyzer was disposed.');
        // Jobs are ordered by their legacy shard, then plan order: thrown
        // failures keep the old shard precedence; resource failures use phase rank.
        const terminalByShard = new Map<number, { rank: readonly number[]; result: PromiseSettledResult<ProjectJobEvidence> }>();
        for (const [index, result] of settled.entries()) {
            const rank = result.status === 'rejected'
                ? result.reason.projectFailureRank ?? [0, 0]
                : result.value.resourceFailure;
            if (!rank) continue;
            const shardIndex = jobs[index]?.shardIndex ?? 0;
            const previous = terminalByShard.get(shardIndex);
            // A shard originally stopped at its earliest pass failure. An eager
            // singleton's claims failure cannot outrank a later dependency failure.
            if (!previous || rank[0] < previous.rank[0] || (rank[0] === previous.rank[0] && rank[1] < previous.rank[1])) {
                terminalByShard.set(shardIndex, { rank, result });
            }
        }
        for (const [, terminal] of [...terminalByShard].sort(([left], [right]) => left - right)) {
            if (terminal.result.status === 'rejected') throw terminal.result.reason;
        }
        const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        const evidence = mergeTypeScriptShardEvidence(results);
        if (!results.some((result) => result.resourceFailure)) {
            const states = results.flatMap((result) => result.state ? [result.state] : []);
            // Seed the same in-memory/disk snapshots warm sync already consumes.
            // These workers have no Programs until a delta actually needs one.
            await Promise.all(this.shards.map((shard) => shard.importProjectStates(input.rootPath, states)));
        }
        return evidence;
    }

    private async analyzeWarm(input: ResolutionProjectInput): Promise<ResolutionProjectEvidence> {
        // Wait for every shard, even after one fails, so no worker is still
        // analyzing when this returns.
        const settled = await Promise.allSettled(this.shards.map((shard) => shard.analyzeShard(input)));
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
        return mergeTypeScriptShardEvidence(settled.map((result) => (
            (result as PromiseFulfilledResult<TypeScriptShardEvidence>).value
        )));
    }

    async getProviderMetadata(language: string) {
        // Disposal must still make metadata unavailable so cancellation cannot
        // be mistaken for an optional-provider failure and activate a publication.
        if (this.disposed) throw new Error('TypeScript resolution analyzer was disposed.');
        // Provider identity is fixed for this analyzer's runtime. Retain it across
        // isolate exits so reporting degraded coverage starts no replacement worker.
        this.providerMetadata ??= await this.shards[0].getProviderMetadata(language);
        return this.providerMetadata;
    }

    getSourceControlFiles(input: SourceControlInput): Promise<readonly string[]> {
        return this.shards[0].getSourceControlFiles(input);
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await Promise.all([...this.shards, ...this.activeJobs].map((shard) => shard.dispose()));
        await this.analysisTail;
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
