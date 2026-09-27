import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
    Reranker,
    RerankExecutionDiagnostics,
    RerankOptions,
    RerankResult,
} from "@zokizuan/satori-core";
import { serializeCanonicalJson } from "../core/canonical-json.js";
import { loadSearchRerankRequestContract } from "../core/search-rerank-request-contract.js";
import type {
    LateOnRuntimeProfile,
    LateOnWorkerRequest,
    LateOnWorkerResponse,
} from "./lateon-reranker-protocol.js";
import {
    LATEON_RETIRED_RUNTIME_PROFILE_IDS,
    LATEON_RUNTIME_PROFILE_IDS,
    type LateOnRuntimeProfileId,
} from "./lateon-reranker-protocol.js";

export { LATEON_RETIRED_RUNTIME_PROFILE_IDS, LATEON_RUNTIME_PROFILE_IDS } from "./lateon-reranker-protocol.js";
export type { LateOnRuntimeProfileId } from "./lateon-reranker-protocol.js";

export type LateOnOperationalReason =
    | "lateon_not_ready"
    | "lateon_execution_timeout"
    | "lateon_cancelled"
    | "lateon_invalid_output"
    | "lateon_worker_failure";

export class LateOnOperationalError extends Error {
    readonly reason: LateOnOperationalReason;
    readonly cause?: unknown;

    constructor(reason: LateOnOperationalReason, message: string, cause?: unknown) {
        super(message);
        this.name = "LateOnOperationalError";
        this.reason = reason;
        this.cause = cause;
    }
}

const PROFILE_PATHS: Readonly<Partial<Record<LateOnRuntimeProfileId, string>>> = Object.freeze({
    [LATEON_RUNTIME_PROFILE_IDS.contextV5D32]: fileURLToPath(
        new URL("../../assets/lateon/runtime-profile-v5-d32.json", import.meta.url),
    ),
});

type PendingWorkerRequest = {
    resolve: (response: LateOnWorkerResponse) => void;
    reject: (error: Error) => void;
};

type QueuedRerank = {
    query: string;
    documents: readonly string[];
    identities: readonly string[];
    offeredAt: number;
    resolve: (results: RerankResult[]) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abortListener?: () => void;
    executionStartedAt?: number;
    onExecutionDiagnostics?: (diagnostics: RerankExecutionDiagnostics) => void;
};

// "idle": no worker process is resident; the next request starts one.
type WorkerState = "idle" | "loading" | "ready" | "unhealthy" | "closed";

const MAXIMUM_BOOTSTRAP_ATTEMPTS = 2;
const LATEON_HARD_OPERATION_TIMEOUT_MS = 300_000;
const LATEON_MAXIMUM_INTRA_OP_THREADS = 8;
// The model worker holds a few hundred MB. It starts on first use and is
// released after this long without rerank activity.
const LATEON_DEFAULT_IDLE_SHUTDOWN_MS = 2 * 60_000;
// Requests queue behind one active execution; beyond this the caller gets a
// not-ready failure and search degrades to unreranked results.
const LATEON_MAXIMUM_QUEUED_REQUESTS = 16;

export type LateOnRerankerConfig = Readonly<{
    modelDirectory: string;
    profileId?: LateOnRuntimeProfileId;
    workerPath?: string;
    /** Idle window before the worker process is released. 0 keeps it resident. */
    idleShutdownMs?: number;
}>;

function safeIntegerAtLeast(value: unknown, minimum: number, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be a safe integer of at least ${minimum}.`);
    }
    return value as number;
}

function positiveSafeInteger(value: unknown, label: string): number {
    return safeIntegerAtLeast(value, 1, label);
}

function validateCommonProfile(profile: Partial<LateOnRuntimeProfile>): void {
    if (
        profile.identity?.license !== "Apache-2.0"
        || !Array.isArray(profile.artifacts)
        || profile.artifacts.length === 0
        || profile.runtime?.executionProvider !== "cpu"
        || profile.inference?.documentBatchSize !== 1
    ) {
        throw new Error("LateOn runtime profile is malformed or unsupported.");
    }
    positiveSafeInteger(profile.inference.candidateDepth, "LateOn candidate depth");
    positiveSafeInteger(profile.inference.interOpThreads, "LateOn inter-op thread count");
}

export function loadLateOnRuntimeProfile(
    profileIdOrPath: LateOnRuntimeProfileId | string = LATEON_RUNTIME_PROFILE_IDS.contextV5D32,
): LateOnRuntimeProfile {
    // Phase 9.1 — retired profiles are recognized only to produce a clear
    // rejection; they never load or execute.
    if (
        (LATEON_RETIRED_RUNTIME_PROFILE_IDS as readonly string[]).includes(profileIdOrPath)
    ) {
        throw new Error(
            `LateOn runtime profile '${profileIdOrPath}' is retired and unsupported. `
            + `Run \`satori upgrade\` to migrate to ${LATEON_RUNTIME_PROFILE_IDS.contextV5D32}.`,
        );
    }
    const profilePath = PROFILE_PATHS[profileIdOrPath as LateOnRuntimeProfileId]
        ?? path.resolve(profileIdOrPath);
    const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Partial<LateOnRuntimeProfile>;
    validateCommonProfile(parsed);
    if (parsed.schemaVersion !== "satori_lateon_runtime_profile_v5") {
        throw new Error("LateOn runtime profile schema is retired or unsupported.");
    }
    if (
        parsed.profileId !== LATEON_RUNTIME_PROFILE_IDS.contextV5D32
        || parsed.identity?.projectionVersion !== "search_rerank_document_v4"
        || !/^[a-f0-9]{64}$/.test(parsed.identity?.projectionSha256 ?? "")
        || parsed.identity?.queryProjectionVersion !== "search_rerank_query_v2"
        || parsed.identity?.requestContractSha256
            !== loadSearchRerankRequestContract().contractSha256
        || parsed.qualificationStatus !== "owner_activated_not_held_out"
    ) {
        throw new Error("LateOn v5 runtime profile is malformed or unsupported.");
    }
    validateExecutionContract(parsed);
    if (parsed.inference?.candidateDepth !== 32) {
        throw new Error(`LateOn ${parsed.profileId} must use candidate depth 32.`);
    }
    return parsed as LateOnRuntimeProfile;
}

function validateExecutionContract(
    parsed: Partial<LateOnRuntimeProfile>,
): void {
    if (
        parsed.execution?.workerProcesses !== 1
        || parsed.execution.activeModelSessions !== 1
        || parsed.execution.executionMode !== "sequential"
        || parsed.execution.graphOptimizationLevel !== "all"
        || parsed.execution.queryBatchSize !== 1
        || parsed.execution.documentEncoding !== "serial"
        || parsed.execution.tokenizerParallelism !== false
    ) {
        throw new Error("LateOn execution contract is malformed or unsupported.");
    }
}

function profileDigest(profile: LateOnRuntimeProfile): string {
    return crypto.createHash("sha256")
        .update(serializeCanonicalJson(profile), "utf8")
        .digest("hex");
}

function operationalError(
    reason: LateOnOperationalReason,
    message: string,
    cause?: unknown,
): LateOnOperationalError {
    return new LateOnOperationalError(
        reason,
        message,
        cause,
    );
}

export class LateOnReranker implements Reranker {
    private readonly profile: LateOnRuntimeProfile;
    private readonly rawProfileDigest: string;
    private readonly identity: ReturnType<Reranker["getIdentity"]>;
    private readonly modelDirectory: string;
    private readonly intraOpThreads: number;
    private readonly workerPath: string;
    private readonly idleShutdownMs: number;
    private idleShutdownTimer?: NodeJS.Timeout;
    private worker: ChildProcess | null = null;
    private workerState: WorkerState = "idle";
    private readinessPromise: Promise<void>;
    private resolveReadiness!: () => void;
    private rejectReadiness!: (error: Error) => void;
    private readinessTimer?: NodeJS.Timeout;
    private readonly pending = new Map<number, PendingWorkerRequest>();
    private nextRequestId = 1;
    private active = false;
    private activeRequest: QueuedRerank | null = null;
    private activeTask: Promise<void> | null = null;
    private readonly queue: QueuedRerank[] = [];
    private termination: Promise<void> | null = null;
    private closed = false;
    private hasReachedReady = false;
    private bootstrapAttemptCount = 0;
    private initialBootstrapFailure?: LateOnOperationalError;
    private lastBootstrapFailure?: LateOnOperationalError;
    private terminalBootstrapFailure?: LateOnOperationalError;

    constructor(config: LateOnRerankerConfig) {
        this.profile = loadLateOnRuntimeProfile(
            config.profileId ?? LATEON_RUNTIME_PROFILE_IDS.contextV5D32,
        );
        this.rawProfileDigest = profileDigest(this.profile);
        this.modelDirectory = path.resolve(config.modelDirectory);
        this.intraOpThreads = this.resolveIntraOpThreads();
        this.identity = Object.freeze({
            provider: "lateon",
            model: `${this.profile.identity.repository}@${this.profile.identity.revision}`,
            profile: this.rawProfileDigest,
        });
        this.workerPath = config.workerPath
            ? path.resolve(config.workerPath)
            : fileURLToPath(new URL("./lateon-reranker-worker.js", import.meta.url));
        this.idleShutdownMs = Math.max(0, config.idleShutdownMs ?? LATEON_DEFAULT_IDLE_SHUTDOWN_MS);
        this.readinessPromise = this.createReadinessPromise();
    }

    getIdentity(): ReturnType<Reranker["getIdentity"]> {
        return this.identity;
    }

    getMaxDocuments(): number {
        return this.profile.inference.candidateDepth;
    }

    getDocumentProjectionVersion(): LateOnRuntimeProfile["identity"]["projectionVersion"] {
        return this.profile.identity.projectionVersion;
    }

    getQueryProjectionVersion(): string {
        return this.profile.identity.queryProjectionVersion;
    }

    getProfileId(): LateOnRuntimeProfileId {
        return this.profile.profileId;
    }

    getOperationalState(): WorkerState {
        return this.workerState;
    }

    getOperationalSnapshot(): Readonly<{
        state: WorkerState;
        closed: boolean;
        workerAttached: boolean;
        activeRequest: boolean;
        activeTask: boolean;
        queuedRequest: boolean;
        pendingWorkerRequests: number;
        readinessTimerActive: boolean;
        terminationActive: boolean;
        bootstrap: Readonly<{
            attemptCount: number;
            initialFailureReason?: LateOnOperationalReason;
            lastFailureReason?: LateOnOperationalReason;
        }>;
    }> {
        const bootstrap = Object.freeze({
            attemptCount: this.bootstrapAttemptCount,
            ...(this.initialBootstrapFailure
                ? { initialFailureReason: this.initialBootstrapFailure.reason }
                : {}),
            ...(this.lastBootstrapFailure
                ? { lastFailureReason: this.lastBootstrapFailure.reason }
                : {}),
        });
        return Object.freeze({
            state: this.workerState,
            closed: this.closed,
            workerAttached: this.worker !== null,
            activeRequest: this.activeRequest !== null,
            activeTask: this.activeTask !== null,
            queuedRequest: this.queue.length > 0,
            pendingWorkerRequests: this.pending.size,
            readinessTimerActive: this.readinessTimer !== undefined,
            terminationActive: this.termination !== null,
            bootstrap,
        });
    }

    async waitUntilReady(): Promise<void> {
        if (this.closed) {
            throw operationalError("lateon_cancelled", "LateOn reranker is closed.");
        }
        await this.ensureWorkerStarted();
        await this.readinessPromise;
        this.scheduleIdleShutdown();
    }

    private async ensureWorkerStarted(): Promise<void> {
        this.clearIdleShutdown();
        if (this.workerState !== "idle") return;
        if (this.termination) await this.termination;
        if (this.workerState === "idle" && !this.closed) this.startWorker();
    }

    private clearIdleShutdown(): void {
        if (this.idleShutdownTimer) clearTimeout(this.idleShutdownTimer);
        this.idleShutdownTimer = undefined;
    }

    private scheduleIdleShutdown(): void {
        this.clearIdleShutdown();
        if (this.idleShutdownMs <= 0 || this.closed || this.workerState !== "ready") return;
        this.idleShutdownTimer = setTimeout(() => {
            this.idleShutdownTimer = undefined;
            void this.releaseIdleWorker();
        }, this.idleShutdownMs);
        this.idleShutdownTimer.unref();
    }

    private async releaseIdleWorker(): Promise<void> {
        if (
            this.closed
            || this.active
            || this.queue.length > 0
            || this.pending.size > 0
            || this.workerState !== "ready"
            || !this.worker
            || this.termination
        ) {
            return;
        }
        const worker = this.worker;
        this.worker = null;
        this.workerState = "idle";
        const termination = (async () => {
            if (worker.exitCode === null && worker.signalCode === null) {
                const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
                worker.kill("SIGKILL");
                await exited;
            }
        })();
        this.termination = termination;
        try {
            await termination;
        } finally {
            if (this.termination === termination) this.termination = null;
        }
    }

    async rerank(
        query: string,
        documents: string[],
        options: RerankOptions = {},
    ): Promise<RerankResult[]> {
        if (this.closed) {
            throw operationalError("lateon_cancelled", "LateOn reranker is closed.");
        }
        if (!query.trim()) throw new Error("Query cannot be empty.");
        if (documents.length === 0) return [];
        if (documents.length > this.getMaxDocuments()) {
            throw new Error(
                `LateOn accepts at most ${this.getMaxDocuments()} documents per request.`,
            );
        }
        const identities = options.identities
            ? [...options.identities]
            : documents.map((_document, index) => String(index));
        if (identities.length !== documents.length) {
            throw new Error("LateOn candidate identities and documents must have equal lengths.");
        }
        const signal = (options as RerankOptions & { signal?: AbortSignal }).signal;
        if (signal?.aborted) {
            throw operationalError("lateon_cancelled", "LateOn rerank was cancelled.");
        }
        if (this.workerState !== "ready") {
            if (this.terminalBootstrapFailure) {
                throw this.terminalBootstrapFailure;
            }
            await this.waitUntilReady();
            if (signal?.aborted) {
                throw operationalError("lateon_cancelled", "LateOn rerank was cancelled.");
            }
        }
        if (this.active && this.queue.length >= LATEON_MAXIMUM_QUEUED_REQUESTS) {
            throw operationalError(
                "lateon_not_ready",
                `LateOn rerank queue is full (${LATEON_MAXIMUM_QUEUED_REQUESTS} waiting requests).`,
            );
        }
        this.clearIdleShutdown();

        const offeredAt = Date.now();
        let submittedRequest!: QueuedRerank;
        const result = new Promise<RerankResult[]>((resolve, reject) => {
            const request: QueuedRerank = {
                query,
                documents: [...documents],
                identities,
                offeredAt,
                resolve,
                reject,
                ...(signal ? { signal } : {}),
                ...(options.onExecutionDiagnostics
                    ? { onExecutionDiagnostics: options.onExecutionDiagnostics }
                    : {}),
            };
            submittedRequest = request;
            if (signal) {
                request.abortListener = () => this.cancelRequest(request);
                signal.addEventListener("abort", request.abortListener, { once: true });
            }
            if (!this.active) {
                this.startExecution(request);
                return;
            }
            this.queue.push(request);
        });
        return result.finally(() => {
            if (signal && submittedRequest.abortListener) {
                signal.removeEventListener("abort", submittedRequest.abortListener);
            }
        });
    }

    private resolveIntraOpThreads(): number {
        return Math.max(
            1,
            Math.min(os.availableParallelism(), LATEON_MAXIMUM_INTRA_OP_THREADS),
        );
    }

    private createReadinessPromise(): Promise<void> {
        const readiness = new Promise<void>((resolve, reject) => {
            this.resolveReadiness = resolve;
            this.rejectReadiness = reject;
        });
        void readiness.catch(() => undefined);
        return readiness;
    }

    private startWorker(): void {
        if (this.closed || this.worker || this.termination) return;
        this.workerState = "loading";
        if (this.hasReachedReady) {
            this.readinessPromise = this.createReadinessPromise();
        } else {
            this.bootstrapAttemptCount += 1;
        }
        const worker = fork(this.workerPath, [], {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            execArgv: process.execArgv.filter(
                (argument) => !argument.startsWith("--input-type"),
            ),
        });
        this.worker = worker;
        const fail = (error: LateOnOperationalError): void => {
            if (this.worker !== worker) return;
            this.failWorker(error, true);
        };
        worker.once("error", (error) => fail(operationalError(
            "lateon_worker_failure",
            "LateOn worker process failed.",
            error,
        )));
        worker.once("exit", (code, signal) => {
            if (this.worker !== worker) return;
            fail(operationalError(
                "lateon_worker_failure",
                `LateOn worker exited before completion (${signal ?? code ?? "unknown"}).`,
            ));
        });
        worker.on("message", (message: unknown) => {
            if (this.worker !== worker) return;
            this.handleWorkerMessage(worker, message);
        });
        this.readinessTimer = setTimeout(() => {
            fail(operationalError(
                "lateon_not_ready",
                `LateOn worker readiness exceeded ${LATEON_HARD_OPERATION_TIMEOUT_MS} ms.`,
            ));
        }, LATEON_HARD_OPERATION_TIMEOUT_MS);
        this.readinessTimer.unref();
        worker.send({
            type: "initialize",
            modelDirectory: this.modelDirectory,
            profile: this.profile,
            intraOpThreads: this.intraOpThreads,
        } satisfies LateOnWorkerRequest);
    }

    private handleWorkerMessage(worker: ChildProcess, message: unknown): void {
        if (!message || typeof message !== "object" || !("type" in message)) {
            this.failWorker(operationalError(
                "lateon_invalid_output",
                "LateOn worker emitted a malformed message.",
            ), false);
            return;
        }
        const response = message as Record<string, unknown> & {
            type?: LateOnWorkerResponse["type"];
            requestId?: unknown;
        };
        if (
            response.type !== "ready"
            && response.type !== "result"
            && response.type !== "error"
        ) {
            this.failWorker(operationalError(
                "lateon_invalid_output",
                "LateOn worker emitted an unsupported message.",
            ), false);
            return;
        }
        if (response.type === "ready") {
            if (
                response.modelRevision !== this.profile.identity.revision
                || response.projectionVersion !== this.profile.identity.projectionVersion
                || response.candidateDepth !== this.profile.inference.candidateDepth
            ) {
                this.failWorker(operationalError(
                    "lateon_worker_failure",
                    "LateOn worker readiness identity does not match the selected profile.",
                ), false);
                return;
            }
            if (this.readinessTimer) clearTimeout(this.readinessTimer);
            this.readinessTimer = undefined;
            this.workerState = "ready";
            this.hasReachedReady = true;
            this.resolveReadiness();
            if (!this.active && this.queue.length === 0) this.scheduleIdleShutdown();
            return;
        }
        if (response.type === "error" && response.requestId === undefined) {
            this.failWorker(operationalError(
                "lateon_worker_failure",
                typeof response.message === "string"
                    ? response.message
                    : "LateOn worker initialization failed.",
            ), true);
            return;
        }
        const requestId = response.requestId;
        if (!Number.isSafeInteger(requestId)) {
            this.failWorker(operationalError(
                "lateon_invalid_output",
                "LateOn worker response has an invalid request identity.",
            ), false);
            return;
        }
        const pending = this.pending.get(requestId as number);
        if (!pending) return;
        this.pending.delete(requestId as number);
        if (response.type === "error") {
            pending.reject(operationalError(
                "lateon_worker_failure",
                typeof response.message === "string"
                    ? response.message
                    : "LateOn worker request failed.",
            ));
        } else {
            pending.resolve(response as LateOnWorkerResponse);
        }
    }

    private startExecution(request: QueuedRerank): void {
        request.executionStartedAt = Date.now();
        this.active = true;
        this.activeRequest = request;
        let task!: Promise<void>;
        task = (async () => {
            try {
                request.resolve(await this.rerankOnce(request));
            } catch (error) {
                request.reject(error instanceof Error ? error : new Error(String(error)));
            } finally {
                this.active = false;
                if (this.activeRequest === request) this.activeRequest = null;
                if (this.activeTask === task) this.activeTask = null;
                this.startQueuedIfPossible();
                if (!this.active && this.queue.length === 0) this.scheduleIdleShutdown();
            }
        })();
        this.activeTask = task;
        void task.catch(() => undefined);
    }

    private cancelRequest(request: QueuedRerank): void {
        const cancellation = operationalError(
            "lateon_cancelled",
            "LateOn rerank was cancelled.",
        );
        const queuedIndex = this.queue.indexOf(request);
        if (queuedIndex >= 0) {
            this.queue.splice(queuedIndex, 1);
            request.reject(cancellation);
            return;
        }
        if (this.activeRequest === request) {
            void this.stopWorker(cancellation, true);
        }
    }

    private startQueuedIfPossible(): void {
        if (this.active || this.queue.length === 0) return;
        if (this.closed) {
            const cancellation = operationalError("lateon_cancelled", "LateOn reranker is closed.");
            for (const queued of this.queue.splice(0)) queued.reject(cancellation);
            return;
        }
        if (this.workerState !== "ready") {
            void this.waitUntilReady().then(
                () => this.startQueuedIfPossible(),
                (error: unknown) => {
                    const failure = error instanceof Error ? error : new Error(String(error));
                    for (const queued of this.queue.splice(0)) queued.reject(failure);
                },
            );
            return;
        }
        const queued = this.queue.shift();
        if (!queued) return;
        if (queued.signal?.aborted) {
            queued.reject(operationalError("lateon_cancelled", "LateOn rerank was cancelled."));
            this.startQueuedIfPossible();
            return;
        }
        this.startExecution(queued);
    }

    private reportExecutionDiagnostics(
        request: QueuedRerank,
        diagnostics: RerankExecutionDiagnostics,
    ): void {
        if (!request.onExecutionDiagnostics) return;
        try {
            request.onExecutionDiagnostics(diagnostics);
        } catch {
            // Diagnostics are observational only: a throwing telemetry
            // callback must never alter ranking behavior or mask the
            // terminal error classification.
        }
    }

    private async rerankOnce(request: QueuedRerank): Promise<RerankResult[]> {
        const worker = this.worker;
        if (!worker || this.workerState !== "ready") {
            throw operationalError("lateon_not_ready", "LateOn worker is not ready.");
        }
        const executionStartedAt = request.executionStartedAt ?? Date.now();
        const queueWaitMs = Math.max(0, executionStartedAt - request.offeredAt);
        const timeoutMilliseconds = LATEON_HARD_OPERATION_TIMEOUT_MS;
        const timeoutError = operationalError(
            "lateon_execution_timeout",
            `LateOn scoring exceeded the ${timeoutMilliseconds} ms hard safety ceiling.`,
        );
        const requestId = this.nextRequestId++;
        let timeout: NodeJS.Timeout | undefined;
        let terminationAfterTimeout: Promise<void> | undefined;
        const operation = new Promise<LateOnWorkerResponse>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            try {
                worker.send({
                    type: "rerank",
                    requestId,
                    query: request.query,
                    documents: request.documents,
                    identities: request.identities,
                } satisfies LateOnWorkerRequest, (error) => {
                    if (!error) return;
                    const pending = this.pending.get(requestId);
                    if (!pending) return;
                    this.pending.delete(requestId);
                    pending.reject(operationalError(
                        "lateon_worker_failure",
                        "LateOn worker request could not be sent.",
                        error,
                    ));
                });
            } catch (error) {
                this.pending.delete(requestId);
                reject(operationalError(
                    "lateon_worker_failure",
                    "LateOn worker request could not be sent.",
                    error,
                ));
            }
        });
        const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                terminationAfterTimeout = this.stopWorker(timeoutError, true);
                reject(timeoutError);
            }, timeoutMilliseconds);
            timeout.unref();
        });
        try {
            const response = await Promise.race([operation, deadline]);
            const results = this.validateResponse(response, requestId, request.documents.length);
            this.reportExecutionDiagnostics(request, {
                attempts: 1,
                retries: 0,
                timeouts: 0,
                queueWaitMs,
                effectiveScoreDeadlineMs: timeoutMilliseconds,
                observedWallMs: Date.now() - executionStartedAt,
            });
            return results;
        } catch (error) {
            if (terminationAfterTimeout) await terminationAfterTimeout;
            const classified = error instanceof LateOnOperationalError
                ? error
                : operationalError("lateon_invalid_output", "LateOn emitted invalid output.", error);
            if (classified.reason !== "lateon_cancelled") {
                const observedWallMs = Date.now() - executionStartedAt;
                this.reportExecutionDiagnostics(request, {
                    attempts: 1,
                    retries: 0,
                    timeouts: classified.reason === "lateon_execution_timeout" ? 1 : 0,
                    queueWaitMs,
                    effectiveScoreDeadlineMs: timeoutMilliseconds,
                    observedWallMs,
                    ...(classified.reason === "lateon_execution_timeout"
                        ? { deadlineLatenessMs: Math.max(0, observedWallMs - timeoutMilliseconds) }
                        : {}),
                });
            }
            if (
                classified.reason === "lateon_invalid_output"
                || classified.reason === "lateon_worker_failure"
            ) {
                await this.stopWorker(classified, true);
            }
            throw classified;
        } finally {
            if (timeout) clearTimeout(timeout);
            this.pending.delete(requestId);
        }
    }

    private validateResponse(
        response: LateOnWorkerResponse,
        requestId: number,
        documentCount: number,
    ): RerankResult[] {
        if (response.type !== "result" || response.requestId !== requestId) {
            throw operationalError("lateon_invalid_output", "LateOn worker returned an invalid response.");
        }
        if (response.results.length !== documentCount) {
            throw operationalError(
                "lateon_invalid_output",
                "LateOn worker returned an incomplete result set.",
            );
        }
        const indexes = new Set<number>();
        return response.results.map((row) => {
            if (
                !Number.isSafeInteger(row.index)
                || row.index < 0
                || row.index >= documentCount
                || indexes.has(row.index)
                || !Number.isFinite(row.relevanceScore)
            ) {
                throw operationalError(
                    "lateon_invalid_output",
                    "LateOn worker returned an invalid result row.",
                );
            }
            indexes.add(row.index);
            return { index: row.index, relevanceScore: row.relevanceScore };
        });
    }

    private failWorker(error: LateOnOperationalError, retryableBeforeReady: boolean): void {
        if (this.workerState === "ready") {
            void this.stopWorker(error, true);
            return;
        }
        if (!this.hasReachedReady) {
            void this.finishBootstrapAttempt(error, retryableBeforeReady);
            return;
        }
        void this.stopWorker(error, false);
    }

    private async finishBootstrapAttempt(
        error: LateOnOperationalError,
        retryable: boolean,
    ): Promise<void> {
        this.initialBootstrapFailure ??= error;
        this.lastBootstrapFailure = error;
        const retry = retryable
            && this.bootstrapAttemptCount < MAXIMUM_BOOTSTRAP_ATTEMPTS;
        if (!retry) this.terminalBootstrapFailure = error;
        await this.stopWorker(error, false, !retry);
        if (retry && !this.closed && !this.hasReachedReady) this.startWorker();
    }

    private async stopWorker(
        error: LateOnOperationalError,
        restart: boolean,
        rejectReadiness: boolean = true,
    ): Promise<void> {
        if (this.termination) return this.termination;
        const worker = this.worker;
        this.worker = null;
        if (this.readinessTimer) clearTimeout(this.readinessTimer);
        this.readinessTimer = undefined;
        if (!this.closed) this.workerState = "unhealthy";
        if (rejectReadiness) this.rejectReadiness(error);
        const pendingRequests = [...this.pending.values()];
        this.pending.clear();
        const termination = (async () => {
            if (worker && worker.exitCode === null && worker.signalCode === null) {
                const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
                worker.kill("SIGKILL");
                await exited;
            }
        })();
        this.termination = termination;
        try {
            await termination;
        } finally {
            if (this.termination === termination) this.termination = null;
        }
        for (const pending of pendingRequests) pending.reject(error);
        if (restart && !this.closed) this.startWorker();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.clearIdleShutdown();
        this.workerState = "closed";
        const cancellation = operationalError("lateon_cancelled", "LateOn reranker is closed.");
        this.rejectReadiness(cancellation);
        for (const queued of this.queue.splice(0)) queued.reject(cancellation);
        await this.stopWorker(cancellation, false);
        await this.activeTask?.catch(() => undefined);
    }
}
