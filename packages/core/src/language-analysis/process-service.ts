import { fork, type ChildProcess } from 'node:child_process';
import { filterWorkerExecArgv, resolveWorkerScriptPath } from '../utils/worker-threads';
import type { IndexingResourcePlan } from '../indexing/resources';
import { createLanguageAnalysisService } from './service';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-runner';
import type { LanguageAnalysisInput, LanguageAnalysisPort, LanguageAnalysisResult, LanguageAnalysisServiceOptions } from './types';
import type {
    AnalysisWorkerPayload,
    IndexingAnalysisResult,
} from './indexing-analysis';

type ParserPlan = Pick<IndexingResourcePlan, 'analysisWorkers' | 'analysisProcessMaxFiles' | 'analysisProcessMaxSourceBytes' | 'analysisLargeFileBytes'>;
type Job = { id: number; input: LanguageAnalysisInput; mode?: 'indexing'; resolve(result: AnalysisWorkerPayload): void; reject(error: Error): void };
type Entry = { child: ChildProcess; exited: Promise<void>; stopping: boolean; files: number; bytes: number; job?: Job };

/** Small-budget parser owner: baseline WASM, bounded reuse, and process exit before slot reuse. */
export function createProcessLanguageAnalysisService(options: LanguageAnalysisServiceOptions, plan: ParserPlan, signal?: AbortSignal): LanguageAnalysisPort & { dispose(): Promise<void> } {
    const local = createLanguageAnalysisService(options);
    const entries = new Set<Entry>();
    const queue: Job[] = [];
    let nextId = 0;
    let pumping = false;
    let failure: Error | undefined;
    let drain: Promise<void> | undefined;

    const stop = async (entry: Entry) => {
        entry.stopping = true;
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill();
        await entry.exited;
        entries.delete(entry);
    };
    const shutdown = (error: Error): Promise<void> => {
        failure ??= error;
        return drain ??= (async () => {
            const jobs = [...queue.splice(0), ...[...entries].flatMap(entry => entry.job ? [entry.job] : [])];
            await Promise.all([...entries].map(stop));
            signal?.removeEventListener('abort', abort);
            for (const job of jobs) job.reject(failure!);
        })();
    };
    const abort = () => { void shutdown(signal?.reason instanceof Error ? signal.reason : new Error('Language analysis was cancelled.')); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const spawn = (): Entry => {
        const child = fork(resolveWorkerScriptPath(__filename, 'analysis-process-runner'), [JSON.stringify(options)], {
            // The generated lexer optimization working set exceeded 2 GiB in
            // profiling. Restrict the flag to parser children; other stages and
            // large-budget thread pools retain their established compiler policy.
            execArgv: ['--liftoff-only', ...filterWorkerExecArgv()],
            serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        let closed!: () => void;
        const exited = new Promise<void>(resolve => { closed = resolve; });
        const entry: Entry = { child, exited, stopping: false, files: 0, bytes: 0 };
        entries.add(entry);
        child.once('close', (code, signal) => {
            closed();
            if (!entry.stopping) void shutdown(new Error(`Language analysis process exited (${signal ?? code}).`));
        });
        child.once('error', error => { void shutdown(error); });
        child.on('message', (response: AnalysisWorkerResponse) => {
            const job = entry.job;
            if (!job || response.id !== job.id) return;
            if (!response.ok) { void shutdown(new Error(response.error)); return; }
            void (async () => {
                entry.files++;
                const bytes = Buffer.byteLength(job.input.content, 'utf8');
                entry.bytes += bytes;
                if (bytes >= plan.analysisLargeFileBytes || entry.files >= plan.analysisProcessMaxFiles
                    || entry.bytes >= plan.analysisProcessMaxSourceBytes) await stop(entry);
                if (failure) { job.reject(failure); return; }
                entry.job = undefined;
                job.resolve(response.result);
                void pump();
            })().catch(error => { void shutdown(error); });
        });
        return entry;
    };
    const pump = async () => {
        if (pumping || failure) return;
        pumping = true;
        try {
            while (queue.length && !failure) {
                let entry = [...entries].find(candidate => !candidate.job && !candidate.stopping);
                if (entry && entry.files && Buffer.byteLength(queue[0].input.content, 'utf8') >= plan.analysisLargeFileBytes) {
                    // A large file starts with a fresh allocator/grammar scope.
                    await stop(entry);
                    entry = undefined;
                }
                if (failure) break;
                if (!entry) {
                    if (entries.size >= plan.analysisWorkers) break;
                    entry = spawn();
                }
                const job = queue.shift()!;
                entry.job = job;
                entry.child.send({
                    id: job.id,
                    ...(job.mode ? { mode: job.mode } : {}),
                    input: job.input,
                } satisfies AnalysisWorkerRequest, error => {
                    if (error) void shutdown(error);
                });
            }
        } catch (error) { await shutdown(error instanceof Error ? error : new Error(String(error))); }
        finally { pumping = false; }
    };
    const submit = (
        input: LanguageAnalysisInput,
        mode?: 'indexing',
    ): Promise<AnalysisWorkerPayload> => {
        if (failure) return (drain ?? Promise.resolve()).then(() => { throw failure; });
        return new Promise<AnalysisWorkerPayload>((resolve, reject) => {
            queue.push({ id: ++nextId, input, ...(mode ? { mode } : {}), resolve, reject });
            void pump();
        });
    };
    const service = {
        concurrency: plan.analysisWorkers,
        getDescription: () => local.getDescription(),
        getStrategyForLanguage: (language: string) => local.getStrategyForLanguage(language),
        analyze(input: LanguageAnalysisInput): Promise<LanguageAnalysisResult> {
            return submit(input) as Promise<LanguageAnalysisResult>;
        },
        analyzeForIndexing(input: LanguageAnalysisInput): Promise<IndexingAnalysisResult> {
            return submit(input, 'indexing') as Promise<IndexingAnalysisResult>;
        },
        dispose: () => shutdown(new Error('Language analysis service was disposed.')),
    };
    return service;
}
