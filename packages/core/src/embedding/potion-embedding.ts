import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    Embedding,
    EmbeddingProviderError,
    type EmbeddingBatchPolicy,
    type EmbeddingIdentity,
    type EmbeddingVector,
} from './base-embedding';

export const POTION_MODEL_ID =
    'minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b';
export const POTION_DIMENSION = 256;
export const POTION_RETAINED_TOKEN_LIMIT = 4096;
export const POTION_MAX_TIMEOUT_MS = 300_000;
export const POTION_INFERENCE_CONTRACT_DIGEST =
    'bfda80d97aeb585e20650b1c54e9063a65068ce284317f0e0a812e20964dcee7';

const POTION_HELPER_SHA256 =
    '2e42f3165b96927bb365f74a11b0495661ac3c44e1a194c55a8f0613b5bb2e12';
const POTION_MODEL_SHA256 =
    '75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c';
const POTION_TOKENIZER_SHA256 =
    '107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45';
const POTION_CONFIG_SHA256 =
    '148e5691a6fcc553437156859701fba017a1ba5d340b170f17e0f3668fb861a7';
const MAX_WORKER_FRAME_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BATCH_ITEMS = 32;
const MAX_BATCH_ITEMS = 64;
const NORMALIZATION_TOLERANCE = 1e-5;

export interface PotionEmbeddingConfig {
    helperPath: string;
    modelPath: string;
    requestTimeoutMs?: number;
    startupTimeoutMs?: number;
    maxBatchItems?: number;
}

interface WorkerResponse {
    id?: unknown;
    ok?: unknown;
    retainedTokenCount?: unknown;
    vector?: unknown;
    errorCode?: unknown;
    ready?: unknown;
    modelLoadedOnce?: unknown;
    retainedTokenLimit?: unknown;
    networkBlocked?: unknown;
}

interface PendingRequest {
    resolve: (response: WorkerResponse) => void;
    reject: (error: EmbeddingProviderError) => void;
    timeout: NodeJS.Timeout;
}

type WorkerState = 'starting' | 'ready' | 'closing' | 'closed' | 'failed';

function providerError(input: {
    code: ConstructorParameters<typeof EmbeddingProviderError>[0]['code'];
    retryable: boolean;
    message: string;
}): EmbeddingProviderError {
    return new EmbeddingProviderError({
        provider: 'Potion',
        code: input.code,
        retryable: input.retryable,
        message: input.message,
    });
}

function boundedPositiveInteger(
    value: number | undefined,
    fallback: number,
    maximum: number,
    name: string,
): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
        throw new Error(`${name} must be a positive safe integer no greater than ${maximum}.`);
    }
    return resolved;
}

async function sha256File(filePath: string): Promise<string> {
    const digest = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(filePath);
        input.on('data', (chunk) => digest.update(chunk));
        input.once('error', reject);
        input.once('end', resolve);
    });
    return digest.digest('hex');
}

async function assertFileDigest(filePath: string, expected: string, label: string): Promise<void> {
    let actual: string;
    try {
        actual = await sha256File(filePath);
    } catch {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: `Pinned Potion ${label} is unavailable.`,
        });
    }
    if (actual !== expected) {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: `Pinned Potion ${label} failed checksum verification.`,
        });
    }
}

/** Verify the exact L1 artifact closure before any source text reaches native code. */
export async function verifyPinnedPotionArtifacts(
    config: Readonly<PotionEmbeddingConfig>,
): Promise<void> {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'The pinned experimental Potion helper supports Linux x64 only.',
        });
    }
    if (!path.isAbsolute(config.helperPath) || !path.isAbsolute(config.modelPath)) {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
            retryable: false,
            message: 'Potion helper and model paths must be absolute.',
        });
    }
    await Promise.all([
        assertFileDigest(config.helperPath, POTION_HELPER_SHA256, 'helper'),
        assertFileDigest(path.join(config.modelPath, 'model.safetensors'), POTION_MODEL_SHA256, 'model'),
        assertFileDigest(path.join(config.modelPath, 'tokenizer.json'), POTION_TOKENIZER_SHA256, 'tokenizer'),
        assertFileDigest(path.join(config.modelPath, 'config.json'), POTION_CONFIG_SHA256, 'configuration'),
    ]);
    try {
        await fs.promises.access(config.helperPath, fs.constants.X_OK);
    } catch {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'Pinned Potion helper is not executable.',
        });
    }
}

export class PotionEmbedding extends Embedding {
    protected maxTokens = POTION_RETAINED_TOKEN_LIMIT;
    private readonly helperPath: string;
    private readonly modelPath: string;
    private readonly requestTimeoutMs: number;
    private readonly startupTimeoutMs: number;
    private readonly maxBatchItems: number;
    private readonly pending = new Map<string, PendingRequest>();
    private child: ChildProcessWithoutNullStreams | null = null;
    private state: WorkerState = 'starting';
    private stdoutBuffer = Buffer.alloc(0);
    private requestSequence = 0;
    private startupPromise: Promise<void> | null = null;
    private closePromise: Promise<void> | null = null;
    private resolveStartup: (() => void) | null = null;
    private rejectStartup: ((error: EmbeddingProviderError) => void) | null = null;

    private constructor(config: Readonly<PotionEmbeddingConfig>) {
        super();
        this.helperPath = config.helperPath;
        this.modelPath = config.modelPath;
        this.requestTimeoutMs = boundedPositiveInteger(
            config.requestTimeoutMs,
            DEFAULT_REQUEST_TIMEOUT_MS,
            POTION_MAX_TIMEOUT_MS,
            'Potion request timeout',
        );
        this.startupTimeoutMs = boundedPositiveInteger(
            config.startupTimeoutMs,
            DEFAULT_STARTUP_TIMEOUT_MS,
            POTION_MAX_TIMEOUT_MS,
            'Potion startup timeout',
        );
        this.maxBatchItems = boundedPositiveInteger(
            config.maxBatchItems,
            DEFAULT_MAX_BATCH_ITEMS,
            MAX_BATCH_ITEMS,
            'Potion maximum batch size',
        );
    }

    static async create(
        config: Readonly<PotionEmbeddingConfig>,
    ): Promise<PotionEmbedding> {
        await verifyPinnedPotionArtifacts(config);
        const embedding = new PotionEmbedding(config);
        try {
            await embedding.start();
            return embedding;
        } catch (error) {
            await embedding.close();
            throw error;
        }
    }

    private async start(): Promise<void> {
        if (this.startupPromise) return this.startupPromise;
        this.startupPromise = new Promise<void>((resolve, reject) => {
            this.resolveStartup = resolve;
            this.rejectStartup = reject;
        });

        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(
                this.helperPath,
                ['worker', this.modelPath, '--block-network'],
                { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
            );
        } catch {
            this.failWorker(providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: 'Potion worker could not be started.',
            }));
            return this.startupPromise;
        }
        this.child = child;
        child.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk));
        // Consume native diagnostics so the pipe cannot block. Their content is
        // intentionally neither retained nor copied into public errors.
        child.stderr.on('data', () => undefined);
        child.stdin.on('error', () => undefined);
        child.once('error', () => this.failWorker(providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'Potion worker failed.',
        })));
        child.once('exit', () => {
            if (this.state === 'closing' || this.state === 'closed') {
                this.finishClosed();
                return;
            }
            this.failWorker(providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: true,
                message: 'Potion worker exited.',
            }));
        });

        const startupTimer = setTimeout(() => {
            this.failWorker(providerError({
                code: 'EMBEDDING_PROVIDER_TIMEOUT',
                retryable: true,
                message: 'Potion worker readiness timed out.',
            }));
        }, this.startupTimeoutMs);
        this.startupPromise.finally(() => clearTimeout(startupTimer)).catch(() => undefined);
        return this.startupPromise;
    }

    private handleStdout(chunk: Buffer): void {
        if (this.state === 'closed' || this.state === 'failed') return;
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        while (true) {
            let leadingWhitespace = 0;
            while (
                leadingWhitespace < this.stdoutBuffer.length
                && this.stdoutBuffer[leadingWhitespace] <= 0x20
            ) {
                leadingWhitespace += 1;
            }
            if (leadingWhitespace > 0) {
                this.stdoutBuffer = this.stdoutBuffer.subarray(leadingWhitespace);
            }
            if (this.stdoutBuffer.length === 0) return;
            if (this.stdoutBuffer[0] !== 0x7b) {
                this.failWorker(providerError({
                    code: 'EMBEDDING_PROVIDER_ERROR',
                    retryable: false,
                    message: 'Potion worker returned an invalid frame.',
                }));
                return;
            }

            let depth = 0;
            let inString = false;
            let escaped = false;
            let frameEnd = -1;
            for (let index = 0; index < this.stdoutBuffer.length; index += 1) {
                const byte = this.stdoutBuffer[index];
                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (byte === 0x5c) {
                        escaped = true;
                    } else if (byte === 0x22) {
                        inString = false;
                    }
                    continue;
                }
                if (byte === 0x22) {
                    inString = true;
                } else if (byte === 0x7b || byte === 0x5b) {
                    depth += 1;
                } else if (byte === 0x7d || byte === 0x5d) {
                    depth -= 1;
                    if (depth === 0) {
                        frameEnd = index + 1;
                        break;
                    }
                    if (depth < 0) break;
                }
            }
            if (frameEnd < 0) {
                if (this.stdoutBuffer.length > MAX_WORKER_FRAME_BYTES) {
                    this.failWorker(providerError({
                        code: 'EMBEDDING_PROVIDER_ERROR',
                        retryable: false,
                        message: 'Potion worker returned an oversized frame.',
                    }));
                }
                return;
            }
            const frame = this.stdoutBuffer.subarray(0, frameEnd);
            this.stdoutBuffer = this.stdoutBuffer.subarray(frameEnd);
            if (frame.length > MAX_WORKER_FRAME_BYTES) {
                this.failWorker(providerError({
                    code: 'EMBEDDING_PROVIDER_ERROR',
                    retryable: false,
                    message: 'Potion worker returned an oversized frame.',
                }));
                return;
            }
            this.handleFrame(frame);
            if (this.isTerminal()) return;
        }
    }

    private isTerminal(): boolean {
        return this.state === 'closed' || this.state === 'failed';
    }

    private handleFrame(frame: Buffer): void {
        let response: WorkerResponse;
        try {
            response = JSON.parse(frame.toString('utf8')) as WorkerResponse;
        } catch {
            this.failWorker(providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned an invalid frame.',
            }));
            return;
        }
        if (this.state === 'starting') {
            if (
                response.ready !== true
                || response.modelLoadedOnce !== true
                || response.retainedTokenLimit !== POTION_RETAINED_TOKEN_LIMIT
                || response.networkBlocked !== true
            ) {
                this.failWorker(providerError({
                    code: 'EMBEDDING_PROVIDER_ERROR',
                    retryable: false,
                    message: 'Potion worker readiness contract did not match.',
                }));
                return;
            }
            this.state = 'ready';
            this.resolveStartup?.();
            this.resolveStartup = null;
            this.rejectStartup = null;
            return;
        }
        if (typeof response.id !== 'string') {
            this.failWorker(providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker response omitted its request identity.',
            }));
            return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) {
            this.failWorker(providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned an unknown request identity.',
            }));
            return;
        }
        this.pending.delete(response.id);
        clearTimeout(pending.timeout);
        pending.resolve(response);
    }

    private failWorker(error: EmbeddingProviderError): void {
        if (this.state === 'failed' || this.state === 'closed') return;
        this.state = 'failed';
        this.rejectStartup?.(error);
        this.resolveStartup = null;
        this.rejectStartup = null;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
        this.child?.kill('SIGKILL');
    }

    private finishClosed(): void {
        this.state = 'closed';
        this.child = null;
        this.stdoutBuffer = Buffer.alloc(0);
    }

    private request(role: 'query' | 'document', text: string): Promise<WorkerResponse> {
        if (this.state !== 'ready' || !this.child) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: 'Potion worker is not available.',
            }));
        }
        if (this.pending.size >= this.maxBatchItems) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                retryable: false,
                message: 'Potion worker queue is full.',
            }));
        }
        const id = `potion-${++this.requestSequence}`;
        const frame = `${JSON.stringify({ op: 'encode', id, role, text })}\n`;
        if (Buffer.byteLength(frame) > MAX_WORKER_FRAME_BYTES) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                retryable: false,
                message: 'Potion embedding input exceeds the bounded worker frame.',
            }));
        }
        const response = new Promise<WorkerResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                const timeoutError = providerError({
                    code: 'EMBEDDING_PROVIDER_TIMEOUT',
                    retryable: true,
                    message: 'Potion embedding request timed out.',
                });
                this.failWorker(timeoutError);
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timeout });
        });
        this.child.stdin.write(frame, (error) => {
            if (error) {
                this.failWorker(providerError({
                    code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                    retryable: true,
                    message: 'Potion worker request could not be delivered.',
                }));
            }
        });
        return response;
    }

    private validateResponse(response: WorkerResponse): EmbeddingVector {
        if (response.ok !== true) {
            const nativeCode = typeof response.errorCode === 'string'
                ? response.errorCode
                : 'UNCLASSIFIED_NATIVE_ERROR';
            const invalidInput = new Set([
                'EMPTY_INPUT',
                'ALL_UNKNOWN_INPUT',
                'OVERSIZED_INPUT',
                'FRAME_TOO_LARGE',
                'INVALID_FRAME',
            ]).has(nativeCode);
            throw providerError({
                code: invalidInput
                    ? 'EMBEDDING_PROVIDER_INVALID_REQUEST'
                    : 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: `Potion embedding request was rejected (${nativeCode}).`,
            });
        }
        if (
            !Number.isSafeInteger(response.retainedTokenCount)
            || (response.retainedTokenCount as number) <= 0
            || (response.retainedTokenCount as number) > POTION_RETAINED_TOKEN_LIMIT
            || !Array.isArray(response.vector)
            || response.vector.length !== POTION_DIMENSION
            || response.vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned an invalid embedding.',
            });
        }
        const vector = response.vector as number[];
        const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0);
        const norm = Math.sqrt(squaredNorm);
        if (!Number.isFinite(norm) || norm <= Number.EPSILON) {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned a zero-norm or non-finite embedding.',
            });
        }
        if (Math.abs(norm - 1) > NORMALIZATION_TOLERANCE) {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned an unnormalized embedding.',
            });
        }
        return { vector, dimension: POTION_DIMENSION };
    }

    async detectDimension(): Promise<number> {
        return POTION_DIMENSION;
    }

    async embedQuery(text: string): Promise<EmbeddingVector> {
        return this.validateResponse(await this.request('query', text));
    }

    async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
        if (texts.length === 0) return [];
        if (texts.length > this.maxBatchItems) {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                retryable: false,
                message: `Potion embedding batch exceeds ${this.maxBatchItems} items.`,
            });
        }
        const responses = await Promise.all(texts.map((text) => this.request('document', text)));
        return responses.map((response) => this.validateResponse(response));
    }

    getDimension(): number {
        return POTION_DIMENSION;
    }

    getProvider(): string {
        return 'Potion';
    }

    override getIdentity(): Readonly<EmbeddingIdentity> {
        // The existing artifact-digest authority seam carries Potion's complete
        // inference-contract digest, not merely the model-file checksum.
        return this.buildIdentity(POTION_MODEL_ID, POTION_INFERENCE_CONTRACT_DIGEST);
    }

    override getBatchPolicy(): EmbeddingBatchPolicy {
        return {
            preferredMaxItems: this.maxBatchItems,
            hardMaxItems: this.maxBatchItems,
        };
    }

    override async close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closePromise = (async () => {
            if (this.state === 'closed') return;
            const child = this.child;
            const canRequestShutdown = this.state === 'ready';
            this.state = 'closing';
            const closeError = providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: 'Potion worker is shutting down.',
            });
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timeout);
                pending.reject(closeError);
            }
            this.pending.clear();
            if (!child) {
                this.finishClosed();
                return;
            }
            if (canRequestShutdown) {
                const shutdownFrame = `${JSON.stringify({
                    op: 'shutdown',
                    id: `potion-${++this.requestSequence}`,
                })}\n`;
                child.stdin.end(shutdownFrame);
            } else {
                child.kill('SIGKILL');
            }
            await new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.signalCode !== null) {
                    resolve();
                    return;
                }
                const timeout = setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve();
                }, Math.min(this.requestTimeoutMs, 1_000));
                child.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
            this.finishClosed();
        })();
        return this.closePromise;
    }
}
