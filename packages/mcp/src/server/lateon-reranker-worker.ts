import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { maxSimScore } from "./lateon-reranker-encoder.js";
import type {
    LateOnEncoderRequest,
    LateOnEncoderResponse,
    LateOnRuntimeProfile,
    LateOnWorkerRequest,
    LateOnWorkerResponse,
} from "./lateon-reranker-protocol.js";

export type LateOnEncoderHandle = Readonly<{
    request: (message: LateOnEncoderRequest) => Promise<LateOnEncoderResponse>;
    terminate: () => Promise<number>;
}>;

export type QueryEncoding = Readonly<{
    vectors: Float64Array;
    dimensions: number;
    tokenCount: number;
}>;

export type DocumentEncoding = Readonly<{
    vectors: Float64Array;
    dimensions: number;
    tokenCount: number;
}>;

export type DocumentScore = Readonly<{
    relevanceScore: number;
    tokenCount: number;
}>;

// All caches live on the worker runtime, so a worker restart discards them and
// a stale projection can never outlive the process that produced it.
export const QUERY_CACHE_LIMIT = 64;
export const SCORE_CACHE_LIMIT = 4096;
// 64 MiB retains ~500-900 encoded ColBERT document projections (~70-130 KiB each
// in Float64) so follow-up queries with overlapping candidates skip ONNX encoding
// while staying bit-identical and strictly bounded within the worker's RAM budget.
export const DOCUMENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DOCUMENT_CACHE_ENTRY_OVERHEAD_BYTES = 256;

// Insertion-ordered bounded cache. A hit re-inserts the key, so the first entry
// is always the least recently used one.
export class BoundedCache<Value> {
    private readonly entries = new Map<string, Value>();
    private readonly limit: number;

    constructor(limit: number) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("LateOn cache limit must be a positive integer.");
        }
        this.limit = limit;
    }

    get size(): number {
        return this.entries.size;
    }

    get(key: string): Value | undefined {
        const value = this.entries.get(key);
        if (value === undefined) return undefined;
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    set(key: string, value: Value): void {
        this.entries.delete(key);
        this.entries.set(key, value);
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next();
            if (oldest.done) return;
            this.entries.delete(oldest.value);
        }
    }
}

// Insertion-ordered byte-bounded LRU cache. Entries larger than `maxBytes` are
// declined without evicting existing entries (though any stale entry under the
// same key is removed so stale data can never be served).
export class ByteBoundedCache<Value> {
    private readonly entries = new Map<string, Readonly<{ value: Value; bytes: number }>>();
    private readonly limitBytes: number;
    private readonly sizeOf: (value: Value) => number;
    private retainedBytes = 0;

    constructor(maxBytes: number, sizeOf: (value: Value) => number) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new Error("LateOn byte cache limit must be a positive integer.");
        }
        this.limitBytes = maxBytes;
        this.sizeOf = sizeOf;
    }

    get size(): number {
        return this.entries.size;
    }

    get bytes(): number {
        return this.retainedBytes;
    }

    get maxBytes(): number {
        return this.limitBytes;
    }

    get(key: string): Value | undefined {
        const entry = this.entries.get(key);
        if (entry === undefined) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: Value): boolean {
        const entryBytes = this.sizeOf(value);
        if (!Number.isSafeInteger(entryBytes) || entryBytes < 1) {
            throw new Error("LateOn byte cache entry size must be a positive integer.");
        }
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            this.entries.delete(key);
            this.retainedBytes -= existing.bytes;
        }
        if (entryBytes > this.limitBytes) {
            return false;
        }
        this.entries.set(key, { value, bytes: entryBytes });
        this.retainedBytes += entryBytes;
        while (this.retainedBytes > this.limitBytes) {
            const oldest = this.entries.entries().next();
            if (oldest.done) break;
            this.entries.delete(oldest.value[0]);
            this.retainedBytes -= oldest.value[1].bytes;
        }
        return true;
    }
}

export function estimateDocumentEncodingBytes(encoding: DocumentEncoding): number {
    return encoding.vectors.byteLength + DOCUMENT_CACHE_ENTRY_OVERHEAD_BYTES;
}

// The worker is bound to one verified model directory and profile for its
// entire lifetime, so the exact canonical document text uniquely determines
// its tokenized sequence and normalized ColBERT token vectors.
export function createDocumentCacheKey(documentText: string): string {
    return crypto.createHash("sha256")
        .update(documentText)
        .digest("hex");
}

// The query is length-prefixed before the NUL separator, so a query that
// contains a NUL byte cannot shift the boundary: `("a\0b", "c")` and
// `("a", "b\0c")` hash different inputs.
export function createScoreCacheKey(query: string, documentText: string): string {
    return crypto.createHash("sha256")
        .update(`${query.length}:${query}\0${documentText}`)
        .digest("hex");
}

export type ScoreDocumentsState = Readonly<{
    encoders: readonly LateOnEncoderHandle[];
    documentCache: ByteBoundedCache<DocumentEncoding>;
    scoreCache: BoundedCache<DocumentScore>;
}>;

type RuntimeState = ScoreDocumentsState & Readonly<{
    profile: LateOnRuntimeProfile;
    queryCache: BoundedCache<QueryEncoding>;
}>;

let runtime: RuntimeState | null = null;
let encoders: readonly LateOnEncoderHandle[] = [];
let shuttingDown = false;
let operation: Promise<void> = Promise.resolve();

function send(message: LateOnWorkerResponse): void {
    if (process.send) process.send(message);
}

function sha256File(filePath: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolvePackageVersion(packageName: string): string {
    const require = createRequire(import.meta.url);
    let directory = path.dirname(require.resolve(packageName));
    while (directory !== path.dirname(directory)) {
        const packagePath = path.join(directory, "package.json");
        if (fs.existsSync(packagePath)) {
            const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
                name?: unknown;
                version?: unknown;
            };
            if (parsed.name === packageName && typeof parsed.version === "string") {
                return parsed.version;
            }
        }
        directory = path.dirname(directory);
    }
    throw new Error(`Unable to resolve ${packageName} version.`);
}

function assertArtifacts(profile: LateOnRuntimeProfile, modelDirectory: string): void {
    for (const artifact of profile.artifacts) {
        const artifactPath = path.join(modelDirectory, artifact.path);
        if (sha256File(artifactPath) !== artifact.sha256) {
            throw new Error(`LateOn artifact digest mismatch: ${artifact.path}.`);
        }
    }
}

function startEncoder(): LateOnEncoderHandle {
    const thread = new Worker(new URL("./lateon-reranker-encoder.js", import.meta.url));
    let pending: Readonly<{
        resolve: (response: LateOnEncoderResponse) => void;
        reject: (error: Error) => void;
    }> | null = null;
    // An encoder that dies mid-run leaves the pool in an unknown state; the parent
    // treats this process exit as a worker failure and starts a fresh worker.
    const abandon = (): void => {
        if (!shuttingDown) process.exit(1);
    };
    thread.once("error", abandon);
    thread.once("exit", abandon);
    thread.on("message", (response: LateOnEncoderResponse) => {
        const current = pending;
        pending = null;
        if (!current) {
            abandon();
            return;
        }
        if (response.type === "error") {
            current.reject(new Error(response.message));
        } else {
            current.resolve(response);
        }
    });
    return {
        request: (message) => new Promise((resolve, reject) => {
            if (pending) {
                reject(new Error("LateOn encoder received overlapping jobs."));
                return;
            }
            pending = { resolve, reject };
            thread.postMessage(message);
        }),
        terminate: () => thread.terminate(),
    };
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1;
}

async function initialize(
    request: Extract<LateOnWorkerRequest, { type: "initialize" }>,
): Promise<void> {
    if (runtime || encoders.length > 0) throw new Error("LateOn worker is already initialized.");
    if (!isPositiveInteger(request.encoderSessions) || !isPositiveInteger(request.intraOpThreads)) {
        throw new Error("LateOn execution plan is malformed.");
    }
    if (request.profile.runtime.transformersJs !== resolvePackageVersion("@huggingface/transformers")) {
        throw new Error("Transformers.js version does not match the LateOn profile.");
    }
    if (request.profile.runtime.onnxruntimeNode !== resolvePackageVersion("onnxruntime-node")) {
        throw new Error("ONNX Runtime version does not match the LateOn profile.");
    }
    assertArtifacts(request.profile, request.modelDirectory);
    // Encoder threads copy the environment when they start.
    process.env.TOKENIZERS_PARALLELISM = "false";
    encoders = Array.from({ length: request.encoderSessions }, startEncoder);
    // Wait for every encoder, so no initialization is in flight when this fails.
    const settled = await Promise.allSettled(encoders.map((encoder) => encoder.request({
        type: "initialize",
        modelDirectory: request.modelDirectory,
        profile: request.profile,
        intraOpThreads: request.intraOpThreads,
    })));
    for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
        if (outcome.value.type !== "ready") throw new Error("LateOn encoder emitted an unexpected response.");
    }
    runtime = {
        profile: request.profile,
        encoders,
        queryCache: new BoundedCache(QUERY_CACHE_LIMIT),
        documentCache: new ByteBoundedCache(DOCUMENT_CACHE_MAX_BYTES, estimateDocumentEncodingBytes),
        scoreCache: new BoundedCache(SCORE_CACHE_LIMIT),
    };
    send({
        type: "ready",
        modelRevision: request.profile.identity.revision,
        projectionVersion: request.profile.identity.projectionVersion,
        candidateDepth: request.profile.inference.candidateDepth,
    });
}

async function encodeQuery(state: RuntimeState, query: string): Promise<QueryEncoding> {
    const cached = state.queryCache.get(query);
    if (cached) return cached;
    const response = await state.encoders[0].request({ type: "encode_query", text: query });
    if (response.type !== "query") throw new Error("LateOn encoder emitted an unexpected response.");
    const encoding: QueryEncoding = {
        vectors: response.vectors,
        dimensions: response.dimensions,
        tokenCount: response.tokenCount,
    };
    state.queryCache.set(query, encoding);
    return encoding;
}

export class LateOnWorkerCancelledError extends Error {
    constructor() {
        super("LateOn rerank was cancelled.");
        this.name = "LateOnWorkerCancelledError";
    }
}

export async function scoreDocuments(
    state: ScoreDocumentsState,
    query: string,
    documents: readonly string[],
    queryEncoding: QueryEncoding,
    documentCacheKey: (documentText: string) => string = createDocumentCacheKey,
    isCancelled?: () => boolean,
): Promise<Readonly<{ scores: readonly number[]; tokenCount: number }>> {
    if (isCancelled?.()) throw new LateOnWorkerCancelledError();
    const scores = new Array<number>(documents.length);
    const scoreKeys = documents.map((document) => createScoreCacheKey(query, document));
    // Cached documents still contribute their token count, so the aggregate
    // request budget is enforced exactly as it was before caching existed.
    let tokenCount = 0;
    const pendingByDocKey = new Map<string, number[]>();
    for (let index = 0; index < documents.length; index++) {
        const cachedScore = state.scoreCache.get(scoreKeys[index]);
        if (cachedScore) {
            scores[index] = cachedScore.relevanceScore;
            tokenCount += cachedScore.tokenCount;
            continue;
        }
        const docKey = documentCacheKey(documents[index]);
        const cachedDoc = state.documentCache.get(docKey);
        if (cachedDoc && cachedDoc.dimensions === queryEncoding.dimensions) {
            const relevanceScore = maxSimScore(
                queryEncoding.vectors,
                queryEncoding.dimensions,
                cachedDoc.vectors,
                cachedDoc.dimensions,
            );
            scores[index] = relevanceScore;
            tokenCount += cachedDoc.tokenCount;
            state.scoreCache.set(scoreKeys[index], {
                relevanceScore,
                tokenCount: cachedDoc.tokenCount,
            });
            continue;
        }
        const indices = pendingByDocKey.get(docKey);
        if (indices) {
            indices.push(index);
        } else {
            pendingByDocKey.set(docKey, [index]);
        }
    }
    // Every document was served from scoreCache or documentCache: no encoder work at all.
    if (pendingByDocKey.size === 0) return { scores, tokenCount };
    const pendingGroups = Array.from(pendingByDocKey.entries()).map(([docKey, indices]) => ({
        docKey,
        representativeIndex: indices[0],
        indices,
    }));
    // Longest documents first, so the last job to finish is a short one.
    pendingGroups.sort((left, right) => (
        documents[right.representativeIndex].length - documents[left.representativeIndex].length
        || left.representativeIndex - right.representativeIndex
    ));
    // Only install the query on encoder lanes that will actually process a miss.
    const activeEncoders = state.encoders.slice(
        0,
        Math.min(state.encoders.length, pendingGroups.length),
    );
    if (activeEncoders.length === 0) {
        throw new Error("LateOn worker has no encoder lanes available.");
    }
    const installed = await Promise.all(activeEncoders.map((encoder) => encoder.request({
        type: "set_query",
        vectors: queryEncoding.vectors,
        dimensions: queryEncoding.dimensions,
    })));
    for (const response of installed) {
        if (response.type !== "query_set") {
            throw new Error("LateOn encoder emitted an unexpected response.");
        }
    }
    if (isCancelled?.()) throw new LateOnWorkerCancelledError();
    let next = 0;
    let failure: { error: unknown } | null = null;
    // Each encoder takes the next unique document when it finishes one. After a
    // failure or cancellation no new jobs start, completed in-flight encodings
    // are retained in the warm caches, and every lane settles before returning.
    await Promise.all(activeEncoders.map(async (encoder) => {
        while (!failure && !isCancelled?.() && next < pendingGroups.length) {
            const group = pendingGroups[next++];
            try {
                const response = await encoder.request({
                    type: "score_document",
                    text: documents[group.representativeIndex],
                });
                if (
                    response.type !== "scored"
                    || response.dimensions !== queryEncoding.dimensions
                    || !(response.vectors instanceof Float64Array)
                    || response.vectors.length % response.dimensions !== 0
                ) {
                    throw new Error("LateOn encoder emitted an unexpected response.");
                }
                state.documentCache.set(group.docKey, {
                    vectors: response.vectors,
                    dimensions: response.dimensions,
                    tokenCount: response.tokenCount,
                });
                for (const index of group.indices) {
                    scores[index] = response.relevanceScore;
                    tokenCount += response.tokenCount;
                    state.scoreCache.set(scoreKeys[index], {
                        relevanceScore: response.relevanceScore,
                        tokenCount: response.tokenCount,
                    });
                }
            } catch (error) {
                failure ??= { error };
            }
        }
    }));
    if (failure) throw (failure as { error: unknown }).error;
    if (isCancelled?.()) throw new LateOnWorkerCancelledError();
    return { scores, tokenCount };
}

async function rerank(
    request: Extract<LateOnWorkerRequest, { type: "rerank" }>,
    isCancelled: () => boolean,
): Promise<void> {
    if (!runtime) throw new Error("LateOn worker is not initialized.");
    if (isCancelled()) {
        send({ type: "cancelled", requestId: request.requestId });
        return;
    }
    if (
        request.documents.length !== request.identities.length
        || request.documents.length > runtime.profile.inference.candidateDepth
    ) {
        throw new Error("LateOn rerank request violates the candidate contract.");
    }
    const queryEncoding = await encodeQuery(runtime, request.query);
    if (isCancelled()) {
        send({ type: "cancelled", requestId: request.requestId });
        return;
    }
    let documentScores: Readonly<{ scores: readonly number[]; tokenCount: number }>;
    try {
        documentScores = await scoreDocuments(
            runtime,
            request.query,
            request.documents,
            queryEncoding,
            createDocumentCacheKey,
            isCancelled,
        );
    } catch (error) {
        if (error instanceof LateOnWorkerCancelledError) {
            send({ type: "cancelled", requestId: request.requestId });
            return;
        }
        throw error;
    }
    if (isCancelled()) {
        send({ type: "cancelled", requestId: request.requestId });
        return;
    }
    if (
        queryEncoding.tokenCount + documentScores.tokenCount
        > runtime.profile.execution.aggregateRequestTokenLimit
    ) {
        throw new Error("LateOn rerank request exceeds the aggregate token contract.");
    }
    const scored = request.documents.map((_, index) => ({
        index,
        identity: request.identities[index],
        relevanceScore: documentScores.scores[index],
    }));
    scored.sort((left, right) => (
        right.relevanceScore - left.relevanceScore
        || (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0)
    ));
    send({
        type: "result",
        requestId: request.requestId,
        results: scored.map(({ index, relevanceScore }) => ({ index, relevanceScore })),
    });
}

// The worker is only ever forked with an IPC channel, so `process.send` is
// present in production. Guarding it keeps the cache helpers importable.
if (process.send) {
    const queuedOrActiveRequestIds = new Set<number>();
    const cancelledRequestIds = new Set<number>();

    process.on("message", (message: LateOnWorkerRequest) => {
        // Handle cancellation out-of-band so an active rerank loop observes it
        // between document dispatches without waiting for the serialized queue.
        if (message.type === "cancel") {
            if (queuedOrActiveRequestIds.has(message.requestId)) {
                cancelledRequestIds.add(message.requestId);
            }
            return;
        }
        if (message.type === "rerank") {
            queuedOrActiveRequestIds.add(message.requestId);
        }
        operation = operation.then(async () => {
            try {
                if (message.type === "initialize") {
                    await initialize(message);
                } else {
                    await rerank(message, () => cancelledRequestIds.has(message.requestId));
                }
            } catch (error) {
                send({
                    type: "error",
                    ...(message.type === "rerank" ? { requestId: message.requestId } : {}),
                    message: error instanceof Error ? error.message : String(error),
                });
            } finally {
                if (message.type === "rerank") {
                    queuedOrActiveRequestIds.delete(message.requestId);
                    cancelledRequestIds.delete(message.requestId);
                }
            }
        });
    });

    process.once("disconnect", () => {
        void operation
            .catch(() => undefined)
            .then(() => {
                shuttingDown = true;
                return Promise.all(encoders.map((encoder) => encoder.terminate()));
            })
            .finally(() => process.exit(0));
    });
}
