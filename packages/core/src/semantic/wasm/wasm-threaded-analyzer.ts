import { Worker } from 'node:worker_threads';
import type { SemanticProjectAnalyzer } from '../analyzer-port';
import type {
    SemanticProjectEvidence,
    SemanticProjectInput,
    SemanticResolvedOccurrence,
} from '../contracts';
import { defaultSemanticLanguageRegistry, type SemanticLanguageRegistry } from '../descriptor';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';
import type { WasmWorkerRequest, WasmWorkerResponse } from './wasm-worker-runner';
import { filterWorkerExecArgv, resolveWorkerScriptPath } from '../../utils/worker-threads';

/** WebAssembly memory never shrinks, so an idle worker is released to return it to the OS. */
export const DEFAULT_SEMANTIC_WORKER_IDLE_RELEASE_MS = 30_000;
/** Bounds one language batch; a stuck resolver would otherwise stall indexing forever. */
export const DEFAULT_SEMANTIC_REQUEST_TIMEOUT_MS = 10 * 60_000;

export interface ThreadedSemanticAnalyzerOptions {
    readonly idleReleaseMs?: number;
    readonly requestTimeoutMs?: number;
}

interface PendingSemanticRequest {
    readonly worker: Worker;
    readonly timer: NodeJS.Timeout;
    readonly resolve: (val: SemanticProjectEvidence) => void;
    readonly reject: (err: unknown) => void;
}

export class ThreadedWasmSemanticProjectAnalyzer implements SemanticProjectAnalyzer {
    private worker: Worker | null = null;
    private disposed = false;
    private nextRequestId = 1;
    private idleTimer: NodeJS.Timeout | null = null;
    private readonly retiring = new Set<Promise<void>>();
    private failedRetirement: { worker: Worker; error: unknown } | null = null;
    private readonly pendingRequests = new Map<number, PendingSemanticRequest>();
    private readonly fallbackAnalyzer: WasmSemanticProjectAnalyzer;
    private readonly idleReleaseMs: number;
    private readonly requestTimeoutMs: number;

    constructor(
        private readonly languageRegistry: SemanticLanguageRegistry = defaultSemanticLanguageRegistry,
        options: ThreadedSemanticAnalyzerOptions = {},
    ) {
        this.fallbackAnalyzer = new WasmSemanticProjectAnalyzer(undefined, languageRegistry);
        this.idleReleaseMs = options.idleReleaseMs ?? DEFAULT_SEMANTIC_WORKER_IDLE_RELEASE_MS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_SEMANTIC_REQUEST_TIMEOUT_MS;
    }

    /** Settles one request: clears its deadline and, once nothing is pending, arms the idle release. */
    private takePending(id: number): PendingSemanticRequest | undefined {
        const pending = this.pendingRequests.get(id);
        if (!pending) return undefined;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        this.scheduleIdleRelease();
        return pending;
    }

    private detachPendingFor(worker: Worker): PendingSemanticRequest[] {
        const requests: PendingSemanticRequest[] = [];
        for (const [id, pending] of this.pendingRequests) {
            if (pending.worker !== worker) continue;
            this.pendingRequests.delete(id);
            clearTimeout(pending.timer);
            requests.push(pending);
        }
        return requests;
    }

    private scheduleIdleRelease(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.pendingRequests.size > 0 || !this.worker || this.disposed) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.pendingRequests.size === 0) this.releaseWorker();
        }, this.idleReleaseMs);
        this.idleTimer.unref();
    }

    /** Stops the current worker; the next analyze() starts a fresh one. */
    private releaseWorker(error?: unknown, worker = this.worker, exited = false): void {
        if (!worker || this.worker !== worker) return;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.worker = null;
        const requests = this.detachPendingFor(worker);
        const rejectRequests = () => {
            for (const request of requests) request.reject(error!);
        };
        const onExit = () => {
            exited = true;
            if (this.failedRetirement?.worker === worker) this.failedRetirement = null;
        };
        if (!exited) worker.once('exit', onExit);
        // Keep ownership through termination, including synchronous throws.
        // Exit events cannot replace the captured request failure once detached.
        const retirement = Promise.resolve().then(() => worker.terminate()).then(
            () => {
                worker.off('exit', onExit);
                rejectRequests();
            },
            (terminationError: unknown) => {
                // A rejected terminate does not prove the isolate stopped.
                // Retain ownership until this worker's actual exit event.
                if (!exited) this.failedRetirement = { worker, error: terminationError };
                rejectRequests();
                throw terminationError;
            },
        );
        this.retiring.add(retirement);
        // Both branches handle background retirement; no ignored rejecting finally chain.
        void retirement.then(
            () => { this.retiring.delete(retirement); },
            () => { this.retiring.delete(retirement); },
        );
    }

    private async awaitRetirements(): Promise<void> {
        const results = await Promise.allSettled([...this.retiring]);
        if (this.failedRetirement) throw this.failedRetirement.error;
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
    }

    /** True while a worker (and its WebAssembly memory) is alive. */
    hasLiveWorker(): boolean {
        return this.worker !== null || this.retiring.size > 0 || this.failedRetirement !== null;
    }

    async releaseIdleWorker(): Promise<void> {
        if (this.pendingRequests.size === 0) this.releaseWorker();
        await this.awaitRetirements();
    }

    supportsLanguage(language: string): boolean {
        return this.fallbackAnalyzer.supportsLanguage(language);
    }

    provableLimitFailure(language: string, sourceFileBytes: readonly number[]): string | undefined {
        // The worker runs the same analyzer with the same default budget.
        return this.fallbackAnalyzer.provableLimitFailure(language, sourceFileBytes);
    }

    private getOrCreateWorker(): Worker {
        if (this.disposed) {
            throw new Error('Semantic analyzer has been disposed');
        }
        if (!this.worker) {
            const scriptPath = resolveWorkerScriptPath(__filename, 'wasm-worker-runner');
            const worker = new Worker(scriptPath, {
                execArgv: filterWorkerExecArgv(),
            });
            this.worker = worker;

            worker.on('message', (response: WasmWorkerResponse) => {
                if (this.pendingRequests.get(response.id)?.worker !== worker) return;
                const pending = this.takePending(response.id);
                if (!pending) return;
                if (response.success) {
                    const occurrencesByFile = new Map<string, SemanticResolvedOccurrence[]>(
                        response.evidence.occurrencesEntries,
                    );
                    pending.resolve({
                        language: response.evidence.language,
                        occurrencesByFile,
                        ...(response.evidence.skippedFiles ? { skippedFiles: response.evidence.skippedFiles } : {}),
                        ...(response.evidence.partialFiles ? { partialFiles: response.evidence.partialFiles } : {}),
                        ...(response.evidence.coverage ? { coverage: response.evidence.coverage } : {}),
                    });
                } else {
                    pending.reject(new Error(response.error));
                }
            });

            worker.on('error', (err) => {
                this.releaseWorker(err, worker);
            });

            worker.on('exit', (code) => {
                // Only this worker's requests: a released worker may exit after
                // its replacement has taken new requests.
                this.releaseWorker(
                    new Error(`CBM Semantic Worker stopped unexpectedly with exit code ${code}`),
                    worker,
                    true,
                );
            });
        }
        return this.worker;
    }

    async analyze(input: SemanticProjectInput): Promise<SemanticProjectEvidence> {
        if (this.failedRetirement) throw this.failedRetirement.error;
        if (this.disposed) {
            throw new Error('Semantic analyzer has been disposed');
        }
        if (!this.supportsLanguage(input.language)) {
            return {
                language: input.language,
                occurrencesByFile: new Map(),
            };
        }

        // Another resumed caller can retire a replacement before this one resumes.
        while (this.retiring.size > 0 || this.failedRetirement) await this.awaitRetirements();
        if (this.disposed) {
            throw new Error('Semantic analyzer has been disposed');
        }

        const id = this.nextRequestId++;
        const worker = this.getOrCreateWorker();
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const request: WasmWorkerRequest = { id, input };

        return new Promise<SemanticProjectEvidence>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pendingRequests.has(id)) return;
                // The worker is stuck in this request; stopping it is the only way out.
                this.releaseWorker(new Error(
                    `Semantic analysis for '${input.language}' timed out after ${this.requestTimeoutMs} ms`,
                ), worker);
            }, this.requestTimeoutMs);
            timer.unref();
            this.pendingRequests.set(id, { worker, timer, resolve, reject });
            try {
                worker.postMessage(request);
            } catch (error) {
                this.releaseWorker(error as Error, worker);
            }
        });
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;

        this.releaseWorker(new Error('Semantic analyzer disposed while request was pending'));
        await this.awaitRetirements();
    }
}
