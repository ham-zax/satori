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
export const POTION_SEMANTIC_VERSION = 'potion_semantics_v1';
export const POTION_DIMENSION = 256;
export const POTION_RETAINED_TOKEN_LIMIT = 4096;
export const POTION_MAX_TIMEOUT_MS = 300_000;
const MAX_WORKER_FRAME_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BATCH_ITEMS = 64;
const MAX_BATCH_ITEMS = 64;
const MAX_PENDING_ITEMS = 256;
const FOREGROUND_QUERY_RESERVE_ITEMS = 1;
const NORMALIZATION_TOLERANCE = 1e-5;
const POTION_STARTUP_SMOKE_TEXT = 'satori potion runtime conformance smoke';

export interface PotionEmbeddingConfig {
    helperPath: string;
    modelPath: string;
    requestTimeoutMs?: number;
    startupTimeoutMs?: number;
    maxBatchItems?: number;
    /**
     * Normal/background outstanding item capacity (defaults to 2x maxBatchItems).
     * One additional foreground query slot is reserved separately.
     */
    maxPendingItems?: number;
    /**
     * The worker process is released after this long without embedding
     * activity and restarted on the next request. 0 keeps it resident.
     */
    idleShutdownMs?: number;
}

// Semantic search needs Potion often, so it keeps a longer warm window than
// the reranker before its worker memory is returned to the OS.
const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60_000;

interface WorkerResponse {
    id?: unknown;
    ok?: unknown;
    retainedTokenCount?: unknown;
    vector?: unknown;
    items?: unknown;
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
    itemCount: number;
}

// 'idle': the worker was released after inactivity; the next request restarts it.
type WorkerState = 'starting' | 'ready' | 'idle' | 'closing' | 'closed' | 'failed';

function providerError(options: {
    code: 'EMBEDDING_PROVIDER_ERROR' | 'EMBEDDING_PROVIDER_TIMEOUT' | 'EMBEDDING_PROVIDER_UNAVAILABLE' | 'EMBEDDING_PROVIDER_INVALID_REQUEST';
    message: string;
    retryable: boolean;
}): EmbeddingProviderError {
    return new EmbeddingProviderError({
        provider: 'Potion',
        code: options.code,
        message: options.message,
        retryable: options.retryable,
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

function serializeBatchRequest(
    id: string,
    texts: readonly string[],
): string {
    return `${JSON.stringify({
        op: 'encode_batch',
        id,
        texts,
    })}\n`;
}

function classifyNativePotionError(response: WorkerResponse): EmbeddingProviderError | null {
    if (response.ok === true) return null;
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
    return providerError({
        code: invalidInput
            ? 'EMBEDDING_PROVIDER_INVALID_REQUEST'
            : 'EMBEDDING_PROVIDER_ERROR',
        retryable: false,
        message: `Potion embedding request was rejected (${nativeCode}).`,
    });
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

// Installation owns the managed model cache and repairs it on rerun.
const POTION_RESTORE_HINT = 'Rerun `npx -y @zokizuan/satori-cli@latest install` to restore it.';

async function assertFileDigest(filePath: string, expected: string, label: string): Promise<void> {
    let actual: string;
    try {
        actual = await sha256File(filePath);
    } catch {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: `Pinned Potion ${label} is unavailable. ${POTION_RESTORE_HINT}`,
        });
    }
    if (actual !== expected) {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: `Pinned Potion ${label} failed checksum verification. ${POTION_RESTORE_HINT}`,
        });
    }
}

/**
 * Repair the owner execute bit on a pinned artifact after exact byte
 * verification. Installation/preflight is the single owner of this integrity
 * repair; runtime startup never attempts it. The repair is limited to the
 * owner execute bit; group and world modes are never widened.
 */
export async function restoreVerifiedOwnerExecutableBit(input: {
    filePath: string;
    expectedSha256: string;
    label: string;
}): Promise<void> {
    let stats: fs.Stats;
    try {
        stats = await fs.promises.lstat(input.filePath);
    } catch {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: `Pinned Potion ${input.label} is unavailable.`,
        });
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: `Pinned Potion ${input.label} must be a regular file.`,
        });
    }
    await assertFileDigest(input.filePath, input.expectedSha256, input.label);
    if ((stats.mode & 0o100) === 0) {
        try {
            await fs.promises.chmod(input.filePath, stats.mode | 0o100);
        } catch {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: `Failed to set executable mode on pinned Potion ${input.label}.`,
            });
        }
    }
    try {
        await fs.promises.access(input.filePath, fs.constants.X_OK);
    } catch {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: `Pinned Potion ${input.label} is not executable.`,
        });
    }
}

/**
 * Structurally validate the pinned Potion runtime closure at startup - without
 * re-hashing. Byte integrity is owned by install/preflight (pinned manifest and
 * artifact closure); PotionEmbedding.create() proves execution through the
 * readiness contract and a capability smoke embedding.
 */
export async function verifyPinnedPotionArtifacts(config: {
    helperPath: string;
    modelPath: string;
}): Promise<void> {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'The Potion helper supports Linux x64 only.',
        });
    }
    if (!path.isAbsolute(config.helperPath) || !path.isAbsolute(config.modelPath)) {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
            retryable: false,
            message: 'Potion helper and model paths must be absolute.',
        });
    }
    let helperStats: fs.Stats;
    try {
        helperStats = await fs.promises.lstat(config.helperPath);
    } catch {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'Pinned Potion helper is unavailable.',
        });
    }
    if (helperStats.isSymbolicLink() || !helperStats.isFile()) {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'Pinned Potion helper must be a regular file.',
        });
    }
    try {
        await fs.promises.access(config.helperPath, fs.constants.X_OK);
    } catch {
        throw providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'Pinned Potion helper is not executable.',
        });
    }
    const requiredModelFiles = [
        { path: path.join(config.modelPath, 'model.safetensors'), label: 'model' },
        { path: path.join(config.modelPath, 'tokenizer.json'), label: 'tokenizer' },
        { path: path.join(config.modelPath, 'config.json'), label: 'configuration' },
    ];
    for (const item of requiredModelFiles) {
        let stats: fs.Stats;
        try {
            stats = await fs.promises.lstat(item.path);
        } catch {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: `Pinned Potion ${item.label} is unavailable.`,
            });
        }
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: `Pinned Potion ${item.label} must be a regular file.`,
            });
        }
    }
}

export class PotionEmbedding extends Embedding {
    protected maxTokens = POTION_RETAINED_TOKEN_LIMIT;
    private readonly helperPath: string;
    private readonly modelPath: string;
    private readonly requestTimeoutMs: number;
    private readonly startupTimeoutMs: number;
    private readonly maxBatchItems: number;
    private readonly maxPendingItems: number;
    private readonly idleShutdownMs: number;
    private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
    private idleRelease: Promise<void> | null = null;
    private restart: Promise<void> | null = null;
    private readonly pending = new Map<string, PendingRequest>();
    private pendingItemsCount = 0;
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
        this.maxPendingItems = boundedPositiveInteger(
            config.maxPendingItems,
            2 * this.maxBatchItems,
            MAX_PENDING_ITEMS,
            'Potion worker pending capacity',
        );
        if (this.maxPendingItems < this.maxBatchItems) {
            throw new Error('Potion worker pending capacity must be no smaller than the maximum batch size.');
        }
        this.idleShutdownMs = Math.max(0, config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS);
    }

    private clearIdleShutdown(): void {
        if (this.idleShutdownTimer) clearTimeout(this.idleShutdownTimer);
        this.idleShutdownTimer = null;
    }

    private scheduleIdleShutdown(): void {
        this.clearIdleShutdown();
        if (this.idleShutdownMs <= 0 || this.state !== 'ready' || this.pending.size > 0) return;
        this.idleShutdownTimer = setTimeout(() => {
            this.idleShutdownTimer = null;
            this.releaseIdleWorker();
        }, this.idleShutdownMs);
        this.idleShutdownTimer.unref?.();
    }

    private releaseIdleWorker(): void {
        const child = this.child;
        if (this.state !== 'ready' || this.pending.size > 0 || !child) return;
        this.child = null;
        this.state = 'idle';
        this.stdoutBuffer = Buffer.alloc(0);
        this.idleRelease = this.stopChild(child, true).finally(() => {
            this.idleRelease = null;
        });
    }

    private async stopChild(child: ChildProcessWithoutNullStreams, requestShutdown: boolean): Promise<void> {
        if (requestShutdown) {
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
    }

    private async ensureStarted(): Promise<void> {
        this.clearIdleShutdown();
        if (this.restart) {
            await this.restart;
            return;
        }
        if (this.state !== 'idle') return;
        this.restart = (async () => {
            await this.idleRelease;
            if (this.state !== 'idle') return;
            this.state = 'starting';
            this.startupPromise = null;
            await this.start();
        })().finally(() => {
            this.restart = null;
        });
        await this.restart;
    }

    private nextRequestId(): string {
        this.requestSequence += 1;
        return `potion-${this.requestSequence}`;
    }

    static async create(
        config: Readonly<PotionEmbeddingConfig>,
    ): Promise<PotionEmbedding> {
        await verifyPinnedPotionArtifacts(config);
        const embedding = new PotionEmbedding(config);
        try {
            await embedding.start();
            // Capability smokes: installation-integrity ownership lives in
            // install/preflight; startup proves the worker executes, loads the
            // model, and returns a valid normalized embedding.
            await embedding.embedDocuments([POTION_STARTUP_SMOKE_TEXT]);
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
        // A worker released for idleness may still flush or exit; only the
        // current child can affect provider state.
        child.stdout.on('data', (chunk: Buffer) => {
            if (this.child === child) this.handleStdout(chunk);
        });
        // Consume native diagnostics so the pipe cannot block. Their content is
        // intentionally neither retained nor copied into public errors.
        child.stderr.on('data', () => undefined);
        child.stdin.on('error', () => undefined);
        child.once('error', () => this.child === child && this.failWorker(providerError({
            code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
            retryable: false,
            message: 'Potion worker failed.',
        })));
        child.once('exit', () => {
            if (this.child !== child) return;
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
        this.handleResponse(response);
    }

    private handleResponse(response: WorkerResponse): void {
        if (!response || typeof response !== 'object') {
            this.failWorker(providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned a malformed response.',
            }));
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
        this.pendingItemsCount = Math.max(0, this.pendingItemsCount - pending.itemCount);
        clearTimeout(pending.timeout);
        pending.resolve(response);
        if (this.pending.size === 0) this.scheduleIdleShutdown();
    }

    private failWorker(error: EmbeddingProviderError): void {
        if (this.state === 'failed' || this.state === 'closed') return;
        this.state = 'failed';
        this.rejectStartup?.(error);
        this.resolveStartup = null;
        this.rejectStartup = null;
        this.pendingItemsCount = 0;
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
        this.pendingItemsCount = 0;
    }

    private request(role: 'query' | 'document', text: string): Promise<WorkerResponse> {
        if (this.state !== 'ready' || !this.child) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: 'Potion worker is not available.',
            }));
        }
        const itemCount = 1;
        const capacityLimit = role === 'query'
            ? this.maxPendingItems + FOREGROUND_QUERY_RESERVE_ITEMS
            : this.maxPendingItems;
        if (this.pendingItemsCount + itemCount > capacityLimit) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                retryable: false,
                message: 'Potion worker queue is full.',
            }));
        }
        const id = this.nextRequestId();
        const frame = `${JSON.stringify({ op: 'encode', id, role, text })}\n`;
        if (Buffer.byteLength(frame) > MAX_WORKER_FRAME_BYTES) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                retryable: false,
                message: 'Potion embedding input exceeds the bounded worker frame.',
            }));
        }
        this.clearIdleShutdown();
        this.pendingItemsCount += itemCount;
        const response = new Promise<WorkerResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                const timeoutError = providerError({
                    code: 'EMBEDDING_PROVIDER_TIMEOUT',
                    retryable: true,
                    message: 'Potion embedding request timed out.',
                });
                this.failWorker(timeoutError);
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timeout, itemCount });
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

    private requestBatchFrame(id: string, frame: string, itemCount: number): Promise<WorkerResponse> {
        if (this.state !== 'ready' || !this.child) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_UNAVAILABLE',
                retryable: false,
                message: 'Potion worker is not available.',
            }));
        }
        if (this.pendingItemsCount + itemCount > this.maxPendingItems) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                retryable: false,
                message: 'Potion worker queue is full.',
            }));
        }
        if (Buffer.byteLength(frame, 'utf8') > MAX_WORKER_FRAME_BYTES) {
            return Promise.reject(providerError({
                code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                retryable: false,
                message: 'Potion embedding input exceeds the bounded worker frame.',
            }));
        }
        this.clearIdleShutdown();
        this.pendingItemsCount += itemCount;
        const response = new Promise<WorkerResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                const timeoutError = providerError({
                    code: 'EMBEDDING_PROVIDER_TIMEOUT',
                    retryable: true,
                    message: 'Potion embedding request timed out.',
                });
                this.failWorker(timeoutError);
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timeout, itemCount });
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

    private validateItem(item: unknown): EmbeddingVector {
        if (!item || typeof item !== 'object') {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned an invalid embedding item.',
            });
        }
        const record = item as { retainedTokenCount?: unknown; vector?: unknown };
        if (
            !Number.isSafeInteger(record.retainedTokenCount)
            || (record.retainedTokenCount as number) <= 0
            || (record.retainedTokenCount as number) > POTION_RETAINED_TOKEN_LIMIT
            || !Array.isArray(record.vector)
            || record.vector.length !== POTION_DIMENSION
            || record.vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned an invalid embedding.',
            });
        }
        const vector = record.vector as number[];
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

    private validateResponse(response: WorkerResponse): EmbeddingVector {
        const nativeError = classifyNativePotionError(response);
        if (nativeError) throw nativeError;
        return this.validateItem(response);
    }

    private validateBatchResponse(response: WorkerResponse, expectedCount: number): EmbeddingVector[] {
        const nativeError = classifyNativePotionError(response);
        if (nativeError) throw nativeError;
        if (!Array.isArray(response.items) || response.items.length !== expectedCount) {
            throw providerError({
                code: 'EMBEDDING_PROVIDER_ERROR',
                retryable: false,
                message: 'Potion worker returned an invalid batch result array.',
            });
        }
        return response.items.map((item) => this.validateItem(item));
    }

    async detectDimension(): Promise<number> {
        return POTION_DIMENSION;
    }

    async embedQuery(text: string): Promise<EmbeddingVector> {
        await this.ensureStarted();
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

        // One native frame per sub-batch, bounded by items and by exact frame
        // bytes. Frame size is additive: an empty frame plus each JSON-encoded
        // text plus one comma between texts, so it is summed, not re-serialized.
        const NATIVE_SUBBATCH_LIMIT = MAX_BATCH_ITEMS;
        type PlannedSubbatch = { id: string; texts: string[]; frame: string };
        const subbatches: PlannedSubbatch[] = [];
        let currentTexts: string[] = [];
        let currentId = this.nextRequestId();
        let currentBytes = 0;
        const emptyFrameBytes = (id: string) => Buffer.byteLength(serializeBatchRequest(id, []), 'utf8');
        const closeSubbatch = () => {
            subbatches.push({ id: currentId, texts: currentTexts, frame: serializeBatchRequest(currentId, currentTexts) });
        };

        for (const text of texts) {
            const textBytes = Buffer.byteLength(JSON.stringify(text), 'utf8');
            if (emptyFrameBytes(currentId) + textBytes > MAX_WORKER_FRAME_BYTES) {
                throw providerError({
                    code: 'EMBEDDING_PROVIDER_INVALID_REQUEST',
                    retryable: false,
                    message: 'Potion embedding input exceeds the bounded worker frame.',
                });
            }
            if (
                currentTexts.length >= NATIVE_SUBBATCH_LIMIT
                || (currentTexts.length > 0 && currentBytes + 1 + textBytes > MAX_WORKER_FRAME_BYTES)
            ) {
                closeSubbatch();
                currentId = this.nextRequestId();
                currentTexts = [];
            }
            currentBytes = currentTexts.length === 0
                ? emptyFrameBytes(currentId) + textBytes
                : currentBytes + 1 + textBytes;
            currentTexts.push(text);
        }
        if (currentTexts.length > 0) closeSubbatch();

        await this.ensureStarted();
        const results: EmbeddingVector[] = [];
        for (const subbatch of subbatches) {
            const response = await this.requestBatchFrame(subbatch.id, subbatch.frame, subbatch.texts.length);
            results.push(...this.validateBatchResponse(response, subbatch.texts.length));
        }
        return results;
    }

    getDimension(): number {
        return POTION_DIMENSION;
    }

    getProvider(): string {
        return 'Potion';
    }

    override getIdentity(): Readonly<EmbeddingIdentity> {
        return this.buildIdentity(
            `${POTION_MODEL_ID}+${POTION_SEMANTIC_VERSION}`,
            null,
        );
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
            this.clearIdleShutdown();
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
                await this.idleRelease;
                this.finishClosed();
                return;
            }
            await this.stopChild(child, canRequestShutdown);
            this.finishClosed();
        })();
        return this.closePromise;
    }
}
