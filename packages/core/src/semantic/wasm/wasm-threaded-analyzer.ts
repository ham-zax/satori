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

export class ThreadedWasmSemanticProjectAnalyzer implements SemanticProjectAnalyzer {
    private worker: Worker | null = null;
    private disposed = false;
    private nextRequestId = 1;
    private readonly pendingRequests = new Map<number, {
        resolve: (val: SemanticProjectEvidence) => void;
        reject: (err: Error) => void;
    }>();
    private readonly fallbackAnalyzer: WasmSemanticProjectAnalyzer;

    constructor(
        private readonly languageRegistry: SemanticLanguageRegistry = defaultSemanticLanguageRegistry,
    ) {
        this.fallbackAnalyzer = new WasmSemanticProjectAnalyzer(undefined, languageRegistry);
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
                const pending = this.pendingRequests.get(response.id);
                if (!pending) return;
                this.pendingRequests.delete(response.id);
                if (response.success) {
                    const occurrencesByFile = new Map<string, SemanticResolvedOccurrence[]>(
                        response.evidence.occurrencesEntries,
                    );
                    pending.resolve({
                        language: response.evidence.language,
                        occurrencesByFile,
                    });
                } else {
                    pending.reject(new Error(response.error));
                }
            });

            worker.on('error', (err) => {
                for (const [, req] of this.pendingRequests) {
                    req.reject(err);
                }
                this.pendingRequests.clear();
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    const exitError = new Error(`CBM Semantic Worker stopped unexpectedly with exit code ${code}`);
                    for (const [, req] of this.pendingRequests) {
                        req.reject(exitError);
                    }
                    this.pendingRequests.clear();
                }
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
        const request: WasmWorkerRequest = { id, input };

        return new Promise<SemanticProjectEvidence>((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            worker.postMessage(request);
        });
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;

        const worker = this.worker;
        this.worker = null;

        for (const [, req] of this.pendingRequests) {
            req.reject(new Error('Semantic analyzer disposed while request was pending'));
        }
        this.pendingRequests.clear();

        if (worker) {
            await worker.terminate();
        }
    }
}
