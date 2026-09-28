import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import type { SemanticProjectAnalyzer } from '../analyzer-port';
import type {
    SemanticProjectEvidence,
    SemanticProjectInput,
    SemanticResolvedOccurrence,
} from '../contracts';
import { defaultSemanticLanguageRegistry, type SemanticLanguageRegistry } from '../descriptor';
import { WasmSemanticProjectAnalyzer } from './wasm-analyzer';
import type { WasmWorkerRequest, WasmWorkerResponse } from './wasm-worker-runner';

function resolveWorkerScriptPath(): string {
    const isTs = __filename.endsWith('.ts') || !fs.existsSync(path.resolve(__dirname, './wasm-worker-runner.js'));
    const candidateTs = path.resolve(__dirname, './wasm-worker-runner.ts');
    const candidateJs = path.resolve(__dirname, './wasm-worker-runner.js');
    if (isTs && fs.existsSync(candidateTs)) {
        return candidateTs;
    }
    if (fs.existsSync(candidateJs)) {
        return candidateJs;
    }
    return candidateTs;
}

function filterWorkerExecArgv(): string[] {
    const validPrefixes = ['--import', '--loader', '--experimental-loader', '--require', '-r'];
    const result: string[] = [];
    for (let i = 0; i < process.execArgv.length; i++) {
        const arg = process.execArgv[i];
        if (validPrefixes.some((prefix) => arg === prefix || arg.startsWith(prefix + '='))) {
            result.push(arg);
            if (arg === '--import' || arg === '--loader' || arg === '--experimental-loader' || arg === '--require' || arg === '-r') {
                if (i + 1 < process.execArgv.length && !process.execArgv[i + 1].startsWith('-')) {
                    result.push(process.execArgv[++i]);
                }
            }
        }
    }
    return result;
}

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
    readonly reject: (err: Error) => void;
}

export class ThreadedWasmSemanticProjectAnalyzer implements SemanticProjectAnalyzer {
    private worker: Worker | null = null;
    private disposed = false;
    private nextRequestId = 1;
    private idleTimer: NodeJS.Timeout | null = null;
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

    private rejectPendingFor(worker: Worker, error: Error): void {
        for (const [id, pending] of this.pendingRequests) {
            if (pending.worker !== worker) continue;
            this.pendingRequests.delete(id);
            clearTimeout(pending.timer);
            pending.reject(error);
        }
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
    private releaseWorker(error?: Error): void {
        const worker = this.worker;
        if (!worker) return;
        this.worker = null;
        if (error) this.rejectPendingFor(worker, error);
        void worker.terminate();
    }

    /** True while a worker (and its WebAssembly memory) is alive. */
    hasLiveWorker(): boolean {
        return this.worker !== null;
    }

    supportsLanguage(language: string): boolean {
        return this.fallbackAnalyzer.supportsLanguage(language);
    }

    private getOrCreateWorker(): Worker {
        if (this.disposed) {
            throw new Error('Semantic analyzer has been disposed');
        }
        if (!this.worker) {
            const scriptPath = resolveWorkerScriptPath();
            const worker = new Worker(scriptPath, {
                execArgv: filterWorkerExecArgv(),
            });
            this.worker = worker;

            worker.on('message', (response: WasmWorkerResponse) => {
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
                        ...(response.evidence.coverage ? { coverage: response.evidence.coverage } : {}),
                    });
                } else {
                    pending.reject(new Error(response.error));
                }
            });

            worker.on('error', (err) => {
                this.rejectPendingFor(worker, err);
            });

            worker.on('exit', (code) => {
                // Only this worker's requests: a released worker may exit after
                // its replacement has taken new requests.
                this.rejectPendingFor(
                    worker,
                    new Error(`CBM Semantic Worker stopped unexpectedly with exit code ${code}`),
                );
                if (this.worker === worker) {
                    this.worker = null;
                }
            });
        }
        return this.worker;
    }

    async analyze(input: SemanticProjectInput): Promise<SemanticProjectEvidence> {
        if (this.disposed) {
            throw new Error('Semantic analyzer has been disposed');
        }
        if (!this.supportsLanguage(input.language)) {
            return {
                language: input.language,
                occurrencesByFile: new Map(),
            };
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
                ));
            }, this.requestTimeoutMs);
            timer.unref();
            this.pendingRequests.set(id, { worker, timer, resolve, reject });
            worker.postMessage(request);
        });
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;

        const worker = this.worker;
        this.worker = null;

        for (const [, req] of this.pendingRequests) {
            clearTimeout(req.timer);
            req.reject(new Error('Semantic analyzer disposed while request was pending'));
        }
        this.pendingRequests.clear();

        if (worker) {
            await worker.terminate();
        }
    }
}
