import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RerankExecutionDiagnostics } from "@satori-code/core";
import {
    LATEON_RUNTIME_PROFILE_IDS,
    LateOnOperationalError,
    LateOnReranker,
    loadLateOnRuntimeProfile,
} from "./lateon-reranker.js";
import { encodeTokenVectors, maxSimScore } from "./lateon-reranker-encoder.js";
import {
    BoundedCache,
    ByteBoundedCache,
    createDocumentCacheKey,
    createScoreCacheKey,
    DOCUMENT_CACHE_ENTRY_OVERHEAD_BYTES,
    DOCUMENT_CACHE_MAX_BYTES,
    estimateDocumentEncodingBytes,
    QUERY_CACHE_LIMIT,
    SCORE_CACHE_LIMIT,
    scoreDocuments,
    type DocumentEncoding,
    type DocumentScore,
    type LateOnEncoderHandle,
    type QueryEncoding,
} from "./lateon-reranker-worker.js";
import type {
    LateOnEncoderRequest,
    LateOnEncoderResponse,
} from "./lateon-reranker-protocol.js";
import { buildSearchRerankDocument } from "../core/search-rerank-document.js";
import { buildSearchRerankQuery, resolveSearchRerankQuery } from "../core/search-rerank-query.js";
import { LATEON_PROFILE_ID } from "@satori-code/core/runtime-contract";

type FakeWorkerOptions = Readonly<{
    readyDelayMilliseconds?: number;
    readinessMismatch?: boolean;
    pidLogPath?: string;
    bootstrapAttempts?: readonly (
        | "ready"
        | "exit"
        | "timeout"
        | "initialization_error"
        | "malformed"
    )[];
}>;

function createFakeWorker(t: { after(fn: () => void): void }, options: FakeWorkerOptions = {}): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-worker-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const workerPath = path.join(directory, "worker.cjs");
    const attemptLogPath = options.pidLogPath ?? path.join(directory, "worker-attempts.txt");
    fs.writeFileSync(workerPath, `
const fs = require("node:fs");
const options = ${JSON.stringify({ ...options, attemptLogPath })};
function sendResults(message) {
    if (message.query === "hang") return;
    if (message.query === "malformed") {
        process.send({
            type: "result",
            requestId: message.requestId,
            results: [{ index: 0, relevanceScore: 1 }, { index: 0, relevanceScore: 2 }],
        });
        return;
    }
    const respond = () => {
        const results = message.identities
            .map((identity, index) => ({
                index,
                identity,
                relevanceScore: message.documents[index].length,
            }))
            .sort((left, right) =>
                right.relevanceScore - left.relevanceScore
                || (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0)
            )
            .map(({ index, relevanceScore }) => ({ index, relevanceScore }));
        process.send({ type: "result", requestId: message.requestId, results });
    };
    const delay = message.query.startsWith("slow:")
        ? Number(message.query.slice("slow:".length))
        : 0;
    setTimeout(respond, delay);
}
process.on("message", (message) => {
    if (message.type === "initialize") {
        const previousAttempts = fs.existsSync(options.attemptLogPath)
            ? fs.readFileSync(options.attemptLogPath, "utf8").trim().split("\\n").filter(Boolean).length
            : 0;
        fs.appendFileSync(options.attemptLogPath, String(process.pid) + "\\n");
        const bootstrapBehavior = options.bootstrapAttempts?.[previousAttempts] || "ready";
        if (bootstrapBehavior === "exit") {
            process.exit(42);
        }
        if (bootstrapBehavior === "timeout") return;
        if (bootstrapBehavior === "initialization_error") {
            process.send({ type: "error", message: "LateOn fake initialization failed." });
            return;
        }
        if (bootstrapBehavior === "malformed") {
            process.send({ unexpected: "message" });
            return;
        }
        setTimeout(() => process.send({
            type: "ready",
            modelRevision: options.readinessMismatch ? "mismatched-revision" : message.profile.identity.revision,
            projectionVersion: message.profile.identity.projectionVersion,
            candidateDepth: message.profile.inference.candidateDepth,
        }), options.readyDelayMilliseconds || 0);
        return;
    }
    sendResults(message);
});
`, "utf8");
    return workerPath;
}

function readWorkerPids(pidLogPath: string): number[] {
    if (!fs.existsSync(pidLogPath)) return [];
    return fs.readFileSync(pidLogPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number);
}

async function waitForWorkerAttempts(pidLogPath: string, expected: number): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (readWorkerPids(pidLogPath).length < expected) {
        if (Date.now() >= deadline) {
            assert.fail(`Expected ${expected} LateOn worker attempts.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

type GatedWorkerTermination = Readonly<{
    terminationRequested: Promise<void>;
    releaseTermination: () => void;
}>;

// Holds the kill of a real fake-worker process until the test releases it, so
// the replacement window is an explicit event instead of a timing assumption.
function gateWorkerTermination(reranker: LateOnReranker): GatedWorkerTermination {
    const internals = reranker as unknown as { worker: ChildProcess | null };
    const worker = internals.worker;
    assert.ok(worker, "LateOn must have an attached worker to gate.");
    let requestTermination!: () => void;
    let releaseTermination!: () => void;
    const terminationRequested = new Promise<void>((resolve) => {
        requestTermination = resolve;
    });
    const terminationGate = new Promise<void>((resolve) => {
        releaseTermination = resolve;
    });
    const kill = worker.kill.bind(worker);
    worker.kill = ((...args: Parameters<ChildProcess["kill"]>) => {
        requestTermination();
        void terminationGate.then(() => kill(...args));
        return true;
    }) as ChildProcess["kill"];
    return { terminationRequested, releaseTermination };
}

async function waitForOperationalSnapshot(
    reranker: LateOnReranker,
    predicate: (snapshot: ReturnType<LateOnReranker["getOperationalSnapshot"]>) => boolean,
): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (!predicate(reranker.getOperationalSnapshot())) {
        if (Date.now() >= deadline) {
            assert.fail("Timed out waiting for the expected LateOn operational snapshot.");
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

async function assertOperationalReason(
    promise: Promise<unknown>,
    reason: LateOnOperationalError["reason"],
): Promise<void> {
    await assert.rejects(promise, (error: unknown) => (
        error instanceof LateOnOperationalError && error.reason === reason
    ));
}

// The boxed `number[][]` implementation the flat Float64Array path replaced,
// kept verbatim as the bit-identity reference.
function referenceNormalizeVector(vector: readonly number[]): number[] {
    let squaredNorm = 0;
    for (const value of vector) squaredNorm += value * value;
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm === 0) {
        throw new Error("LateOn emitted a non-normalizable token vector.");
    }
    return vector.map((value) => value / norm);
}

function referenceMaxSimScore(
    queryVectors: readonly number[][],
    documentVectors: readonly number[][],
): number {
    if (queryVectors.length === 0 || documentVectors.length === 0) return 0;
    let score = 0;
    for (const queryVector of queryVectors) {
        let maximum = Number.NEGATIVE_INFINITY;
        for (const documentVector of documentVectors) {
            let dotProduct = 0;
            for (let dimension = 0; dimension < queryVector.length; dimension++) {
                dotProduct += queryVector[dimension] * documentVector[dimension];
            }
            maximum = Math.max(maximum, dotProduct);
        }
        score += maximum;
    }
    return score;
}

// Deterministic float32 tensor data, so the comparison never depends on timing.
function createDeterministicTensor(length: number, seed: number): Float32Array {
    const data = new Float32Array(length);
    let state = seed;
    for (let index = 0; index < length; index++) {
        state = (state * 48271) % 2147483647;
        data[index] = Math.fround((state / 2147483647) * 2 - 1);
    }
    return data;
}

test("LateOn flat Float64Array projections reproduce the boxed number[][] scores bit for bit", () => {
    const dimensions = 48;
    const sequenceLength = 37;
    const data = createDeterministicTensor(sequenceLength * dimensions, 7);
    // Skip a few rows so kept-token compaction is part of the comparison.
    const isKept = (tokenIndex: number): boolean => tokenIndex % 7 !== 3;
    const flat = encodeTokenVectors(data, sequenceLength, dimensions, isKept);
    const reference: number[][] = [];
    for (let tokenIndex = 0; tokenIndex < sequenceLength; tokenIndex++) {
        if (!isKept(tokenIndex)) continue;
        const offset = tokenIndex * dimensions;
        reference.push(referenceNormalizeVector(
            Array.from(data.slice(offset, offset + dimensions)),
        ));
    }

    assert.equal(flat.length, reference.length * dimensions);
    for (let tokenIndex = 0; tokenIndex < reference.length; tokenIndex++) {
        for (let dimension = 0; dimension < dimensions; dimension++) {
            assert.strictEqual(
                flat[tokenIndex * dimensions + dimension],
                reference[tokenIndex][dimension],
                `token ${tokenIndex} dimension ${dimension} must stay bit-identical`,
            );
        }
    }

    const queryLength = 11;
    const queryData = createDeterministicTensor(queryLength * dimensions, 11);
    const queryFlat = encodeTokenVectors(queryData, queryLength, dimensions, () => true);
    const queryReference = Array.from({ length: queryLength }, (_, tokenIndex) => (
        referenceNormalizeVector(Array.from(
            queryData.slice(tokenIndex * dimensions, (tokenIndex + 1) * dimensions),
        ))
    ));
    assert.strictEqual(
        maxSimScore(queryFlat, dimensions, flat, dimensions),
        referenceMaxSimScore(queryReference, reference),
        "max-sim over flat projections must match the boxed reference exactly",
    );
    assert.strictEqual(maxSimScore(new Float64Array(0), dimensions, flat, dimensions), 0);
    assert.strictEqual(maxSimScore(queryFlat, dimensions, new Float64Array(0), dimensions), 0);
});

test("LateOn flat projection rejects a non-normalizable token row", () => {
    const data = new Float32Array(2 * 4);
    data.set([1, 0, 0, 0], 0);
    assert.throws(
        () => encodeTokenVectors(data, 2, 4, () => true),
        /non-normalizable token vector/,
    );
});

test("LateOn rerank caches are bounded, LRU-ordered, and keyed on query plus document text", () => {
    assert.equal(QUERY_CACHE_LIMIT, 64);
    assert.equal(SCORE_CACHE_LIMIT, 4096);

    const cache = new BoundedCache<number>(2);
    cache.set("first", 1);
    cache.set("second", 2);
    assert.strictEqual(cache.get("first"), 1, "a hit must be served");
    cache.set("third", 3);
    assert.equal(cache.size, 2);
    assert.strictEqual(cache.get("second"), undefined, "the least recently used entry is evicted");
    assert.strictEqual(cache.get("first"), 1);
    assert.strictEqual(cache.get("third"), 3);
    assert.throws(() => new BoundedCache<number>(0), /positive integer/);

    // A cached score keeps its token count, so the aggregate request budget is
    // still charged for documents served from cache.
    const scores = new BoundedCache<{ relevanceScore: number; tokenCount: number }>(4);
    scores.set("key", { relevanceScore: 1.5, tokenCount: 9 });
    assert.deepEqual(scores.get("key"), { relevanceScore: 1.5, tokenCount: 9 });

    assert.equal(createScoreCacheKey("query", "document"), createScoreCacheKey("query", "document"));
    assert.notEqual(createScoreCacheKey("query", "document"), createScoreCacheKey("other", "document"));
    assert.notEqual(createScoreCacheKey("query", "document"), createScoreCacheKey("query", "other"));
    assert.notEqual(
        createScoreCacheKey("ab", "c"),
        createScoreCacheKey("a", "bc"),
        "the separator must keep concatenation boundaries distinct",
    );
    assert.notEqual(
        createScoreCacheKey("a\0b", "c"),
        createScoreCacheKey("a", "b\0c"),
        "a NUL byte inside the query must not collide with the separator",
    );
});

test("LateOn document vector cache enforces byte bounds, LRU order, and oversized-entry safety", () => {
    assert.equal(DOCUMENT_CACHE_MAX_BYTES, 64 * 1024 * 1024);
    assert.equal(DOCUMENT_CACHE_ENTRY_OVERHEAD_BYTES, 256);

    const cache = new ByteBoundedCache<Uint8Array>(10, (value) => value.byteLength);
    assert.equal(cache.maxBytes, 10);
    assert.equal(cache.bytes, 0);
    assert.equal(cache.set("a", new Uint8Array(4)), true);
    assert.equal(cache.set("b", new Uint8Array(4)), true);
    assert.equal(cache.bytes, 8);
    assert.equal(cache.size, 2);

    // Touch "a" so "b" becomes least recently used.
    assert.ok(cache.get("a"));
    assert.equal(cache.set("c", new Uint8Array(4)), true);
    assert.equal(cache.get("b"), undefined, "LRU entry must be evicted when byte budget is exceeded");
    assert.ok(cache.get("a"));
    assert.ok(cache.get("c"));
    assert.equal(cache.bytes, 8);

    // Overwriting an existing key adjusts retained bytes without leaking.
    assert.equal(cache.set("a", new Uint8Array(6)), true);
    assert.equal(cache.bytes, 10);
    assert.equal(cache.size, 2);

    // An oversized entry is declined without evicting unrelated entries, while
    // dropping any stale value stored under the same key.
    assert.equal(cache.set("oversized", new Uint8Array(11)), false);
    assert.equal(cache.size, 2);
    assert.equal(cache.bytes, 10);
    assert.equal(cache.set("a", new Uint8Array(11)), false);
    assert.equal(cache.get("a"), undefined, "stale entry under replaced oversized key must be cleared");
    assert.ok(cache.get("c"), "unrelated entries must survive an oversized insert");
    assert.equal(cache.bytes, 4);

    assert.throws(() => new ByteBoundedCache<Uint8Array>(0, (v) => v.byteLength), /positive integer/);
    assert.throws(() => cache.set("zero", new Uint8Array(0)), /positive integer/);

    assert.equal(createDocumentCacheKey("doc"), createDocumentCacheKey("doc"));
    assert.notEqual(createDocumentCacheKey("doc"), createDocumentCacheKey("doc "));
    assert.equal(
        estimateDocumentEncodingBytes({
            vectors: new Float64Array(48),
            dimensions: 48,
            tokenCount: 1,
        }),
        48 * 8 + DOCUMENT_CACHE_ENTRY_OVERHEAD_BYTES,
    );
});

test("LateOn documentCache reproduces uncached scores bit-for-bit across queries and catches broken keys", async () => {
    const dimensions = 48;
    const seedFor = (text: string): number => {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index++) {
            hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
        }
        return (hash % 2147483646) + 1;
    };
    const encodeSynthetic = (text: string, tokenCount: number): DocumentEncoding => ({
        vectors: encodeTokenVectors(
            createDeterministicTensor(tokenCount * dimensions, seedFor(text)),
            tokenCount,
            dimensions,
            (tokenIndex) => tokenIndex % 5 !== 2,
        ),
        dimensions,
        tokenCount,
    });
    const encodeSyntheticQuery = (text: string): QueryEncoding => ({
        vectors: encodeTokenVectors(
            createDeterministicTensor(9 * dimensions, seedFor(`Q:${text}`)),
            9,
            dimensions,
            () => true,
        ),
        dimensions,
        tokenCount: 9,
    });

    const createInstrumentedEncoders = (count: number) => {
        const counts = { setQuery: 0, scoreDocument: 0 };
        const encoders: LateOnEncoderHandle[] = Array.from({ length: count }, () => {
            let activeQuery: Readonly<{ vectors: Float64Array; dimensions: number }> | null = null;
            return {
                request: async (message: LateOnEncoderRequest): Promise<LateOnEncoderResponse> => {
                    if (message.type === "set_query") {
                        counts.setQuery += 1;
                        activeQuery = { vectors: message.vectors, dimensions: message.dimensions };
                        return { type: "query_set" };
                    }
                    if (message.type === "score_document") {
                        counts.scoreDocument += 1;
                        assert.ok(activeQuery, "query must be installed before scoring");
                        const tokenCount = 12 + (message.text.length % 17);
                        const encoded = encodeSynthetic(message.text, tokenCount);
                        return {
                            type: "scored",
                            relevanceScore: maxSimScore(
                                activeQuery.vectors,
                                activeQuery.dimensions,
                                encoded.vectors,
                                encoded.dimensions,
                            ),
                            tokenCount: encoded.tokenCount,
                            vectors: encoded.vectors,
                            dimensions: encoded.dimensions,
                        };
                    }
                    throw new Error(`Unexpected encoder message: ${message.type}`);
                },
                terminate: async () => 0,
            };
        });
        return { encoders, counts };
    };

    const docs = [
        '{"canonical_symbol_label":"alpha","query_relevant_source_excerpt":"function alpha() { return 1; }"}',
        '{"canonical_symbol_label":"beta","query_relevant_source_excerpt":"function beta(x) { return x * 2; }"}',
        '{"canonical_symbol_label":"gamma","query_relevant_source_excerpt":"class Gamma { run() {} }"}',
        '{"canonical_symbol_label":"alpha","query_relevant_source_excerpt":"function alpha() { return 1; }"}',
    ];
    const query1 = "find alpha implementation";
    const query2 = "locate beta and gamma handlers";
    const q1Enc = encodeSyntheticQuery(query1);
    const q2Enc = encodeSyntheticQuery(query2);

    // Reference uncached run for query2 (completely cold caches).
    const coldRef = createInstrumentedEncoders(3);
    const expectedQuery2 = await scoreDocuments(
        {
            encoders: coldRef.encoders,
            documentCache: new ByteBoundedCache<DocumentEncoding>(
                DOCUMENT_CACHE_MAX_BYTES,
                estimateDocumentEncodingBytes,
            ),
            scoreCache: new BoundedCache<DocumentScore>(SCORE_CACHE_LIMIT),
        },
        query2,
        docs,
        q2Enc,
    );
    // Duplicate doc[0]/doc[3] should only invoke the encoder once while still
    // counting both occurrences toward tokenCount.
    assert.equal(coldRef.counts.scoreDocument, 3);
    assert.equal(coldRef.counts.setQuery, 3);

    // Warm run: populate documentCache via query1, then run query2 with 0% scoreCache overlap.
    const warm = createInstrumentedEncoders(3);
    const warmState = {
        encoders: warm.encoders,
        documentCache: new ByteBoundedCache<DocumentEncoding>(
            DOCUMENT_CACHE_MAX_BYTES,
            estimateDocumentEncodingBytes,
        ),
        scoreCache: new BoundedCache<DocumentScore>(SCORE_CACHE_LIMIT),
    };
    await scoreDocuments(warmState, query1, docs, q1Enc);
    assert.equal(warm.counts.scoreDocument, 3);
    warm.counts.setQuery = 0;
    warm.counts.scoreDocument = 0;

    const cachedQuery2 = await scoreDocuments(warmState, query2, docs, q2Enc);
    assert.equal(warm.counts.setQuery, 0, "100% documentCache hit must not call set_query");
    assert.equal(warm.counts.scoreDocument, 0, "100% documentCache hit must not call score_document");
    assert.equal(cachedQuery2.tokenCount, expectedQuery2.tokenCount);
    assert.equal(cachedQuery2.scores.length, expectedQuery2.scores.length);
    for (let index = 0; index < expectedQuery2.scores.length; index++) {
        assert.ok(
            Object.is(cachedQuery2.scores[index], expectedQuery2.scores[index]),
            `cached score[${index}] must be bit-identical to uncached score`,
        );
    }

    // Partial hit (3 cached + 1 unseen) installs query on only 1 encoder lane.
    const mixedDocs = [
        docs[0],
        '{"canonical_symbol_label":"delta","query_relevant_source_excerpt":"export const delta = 42;"}',
        docs[2],
    ];
    const mixedRef = createInstrumentedEncoders(3);
    const expectedMixed = await scoreDocuments(
        {
            encoders: mixedRef.encoders,
            documentCache: new ByteBoundedCache<DocumentEncoding>(
                DOCUMENT_CACHE_MAX_BYTES,
                estimateDocumentEncodingBytes,
            ),
            scoreCache: new BoundedCache<DocumentScore>(SCORE_CACHE_LIMIT),
        },
        query2,
        mixedDocs,
        q2Enc,
    );
    warm.counts.setQuery = 0;
    warm.counts.scoreDocument = 0;
    const cachedMixed = await scoreDocuments(warmState, query2, mixedDocs, q2Enc);
    assert.equal(warm.counts.setQuery, 1, "single miss must only install query on 1 encoder lane");
    assert.equal(warm.counts.scoreDocument, 1, "only the unseen document must hit the encoder");
    assert.equal(cachedMixed.tokenCount, expectedMixed.tokenCount);
    for (let index = 0; index < expectedMixed.scores.length; index++) {
        assert.ok(Object.is(cachedMixed.scores[index], expectedMixed.scores[index]));
    }

    // Witness/key mutation check: breaking the cache key must fail equivalence.
    const mutated = createInstrumentedEncoders(3);
    const mutatedState = {
        encoders: mutated.encoders,
        documentCache: new ByteBoundedCache<DocumentEncoding>(
            DOCUMENT_CACHE_MAX_BYTES,
            estimateDocumentEncodingBytes,
        ),
        scoreCache: new BoundedCache<DocumentScore>(SCORE_CACHE_LIMIT),
    };
    const brokenKey = () => "broken-constant-witness";
    await scoreDocuments(mutatedState, query1, [docs[0]], q1Enc, brokenKey);
    const poisonedQuery2 = await scoreDocuments(mutatedState, query2, docs, q2Enc, brokenKey);
    assert.notDeepEqual(
        poisonedQuery2.scores,
        expectedQuery2.scores,
        "a broken documentCache witness must visibly diverge from the uncached reference",
    );
});

test("LateOn runtime profile loading defaults to the V6 D128 context profile and rejects any other profile id", () => {
    const defaultProfile = loadLateOnRuntimeProfile();

    assert.equal(defaultProfile.schemaVersion, "satori_lateon_runtime_profile_v6");
    assert.equal(defaultProfile.identity.projectionVersion, "search_rerank_document_v5");
    assert.equal(defaultProfile.identity.queryProjectionVersion, "search_rerank_query_v2");
    assert.equal(defaultProfile.inference.candidateDepth, 128);

    assert.throws(
        () => loadLateOnRuntimeProfile("lateon_offline_quality_projection_v4_d32_v1"),
        /Unsupported LateOn runtime profile 'lateon_offline_quality_projection_v4_d32_v1'; reinstall is required/,
    );
});

test("LateOn native request scores all 128 candidates and rejects overflow before execution", async (t) => {
    const reranker = new LateOnReranker({ modelDirectory: "/unused", workerPath: createFakeWorker(t) });
    t.after(async () => reranker.close());
    const documents = Array.from({ length: 128 }, (_, index) => "x".repeat(index + 1));
    const diagnostics: RerankExecutionDiagnostics[] = [];
    const results = await reranker.rerank("capacity", documents, {
        onExecutionDiagnostics: (value) => diagnostics.push(value),
    });
    assert.deepEqual(results.map((row) => row.index), Array.from({ length: 128 }, (_, index) => 127 - index));
    assert.deepEqual(results.map((row) => row.relevanceScore), Array.from({ length: 128 }, (_, index) => 128 - index));
    assert.equal(diagnostics.length, 1, "one native execution owns the complete candidate set");
    await assert.rejects(reranker.rerank("overflow", [...documents, "extra"]), /at most 128 documents/);
    assert.equal(reranker.getOperationalSnapshot().pendingWorkerRequests, 0);
});

test("LateOn context-v6 profile keeps query-v2 and document-v5 semantic projections", () => {
    const v5 = loadLateOnRuntimeProfile(LATEON_RUNTIME_PROFILE_IDS.contextV6D128);
    assert.equal(v5.schemaVersion, "satori_lateon_runtime_profile_v6");
    assert.equal(v5.profileId, LATEON_PROFILE_ID);
    assert.equal(v5.qualificationStatus, "owner_activated_not_held_out");
    assert.equal(v5.identity.projectionVersion, "search_rerank_document_v5");
    assert.equal(v5.identity.queryProjectionVersion, "search_rerank_query_v2");
    assert.equal(
        v5.identity.projectionSha256,
        "b9131931424dae9430e0f954af1f79dec1b12fed76dc785bb9b73351fff7f712",
    );
});

test("LateOn reranker defaults to the V5 profile and reports semantic projection identities", async (t) => {
    const workerPath = createFakeWorker(t);
    const defaulted = new LateOnReranker({ modelDirectory: "/unused", workerPath });
    const contextV4 = new LateOnReranker({
        modelDirectory: "/unused",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath,
    });
    t.after(async () => Promise.all([
        defaulted.close(),
        contextV4.close(),
    ]).then(() => undefined));

    assert.equal(defaulted.getProfileId(), LATEON_RUNTIME_PROFILE_IDS.contextV6D128);
    assert.equal(defaulted.getMaxDocuments(), 128);
    assert.equal(defaulted.getDocumentProjectionVersion(), "search_rerank_document_v5");
    assert.equal(defaulted.getQueryProjectionVersion(), "search_rerank_query_v2");
    assert.equal(contextV4.getProfileId(), LATEON_RUNTIME_PROFILE_IDS.contextV6D128);
    assert.equal(contextV4.getMaxDocuments(), 128);
    assert.equal(contextV4.getDocumentProjectionVersion(), "search_rerank_document_v5");
    assert.equal(contextV4.getQueryProjectionVersion(), "search_rerank_query_v2");
});

test("LateOn reranker rejects unknown profile selections at construction", () => {
    assert.throws(
        () => new LateOnReranker({
            modelDirectory: "/unused",
            profileId: "lateon_offline_quality_projection_v4_d32_v1" as never,
        }),
        /Unsupported LateOn runtime profile[\s\S]*reinstall is required/,
    );
});

test("LateOn advertised query identities route to the promised query projection", async (t) => {
    const workerPath = createFakeWorker(t);
    const contextV4 = new LateOnReranker({ modelDirectory: "/unused", workerPath });
    t.after(() => contextV4.close());

    const rawQuestion = "how does Shariah compliance checking block trades";
    const focusedV2 = "Question:\nhow does Shariah compliance checking block trades\n\nRequested answer type:\nproduction implementation, control flow, and integration path";

    const v4 = resolveSearchRerankQuery({
        semanticQuery: rawQuestion,
        focusedQueryV2: focusedV2,
        projectionIdentity: contextV4.getQueryProjectionVersion(),
    });
    assert.equal(v4.query, focusedV2);
    assert.equal(v4.queryProjectionIdentity, "search_rerank_query_v2");

    const raw = resolveSearchRerankQuery({
        semanticQuery: rawQuestion,
        focusedQueryV2: focusedV2,
        projectionIdentity: "semantic_query_raw_v1",
    });
    assert.equal(raw.query, rawQuestion);
    assert.equal(raw.queryProjectionIdentity, "semantic_query_raw_v1");
});

test("LateOn identity binds the semantic profile rather than machine-speed settings", async (t) => {
    const workerPath = createFakeWorker(t);
    const first = new LateOnReranker({
        modelDirectory: "/unused",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath,
    });
    const second = new LateOnReranker({
        modelDirectory: "/other",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath,
    });
    t.after(async () => Promise.all([
        first.close(),
        second.close(),
    ]).then(() => undefined));

    assert.equal(first.getMaxDocuments(), 128);
    assert.equal(first.getDocumentProjectionVersion(), "search_rerank_document_v5");
    assert.equal(first.getQueryProjectionVersion(), "search_rerank_query_v2");
    assert.equal(first.getIdentity().profile, second.getIdentity().profile);
});

test("the first rerank starts the worker and waits for readiness", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { readyDelayMilliseconds: 100 }),
    });
    t.after(() => reranker.close());

    assert.deepEqual(
        await reranker.rerank("find owner", ["document"]),
        [{ index: 0, relevanceScore: 8 }],
    );
    assert.equal(reranker.getOperationalState(), "ready");
});

test("LateOn waits through one pre-ready worker retry", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-exit-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["exit", "ready"],
            pidLogPath,
            readyDelayMilliseconds: 100,
        }),
    });
    t.after(() => reranker.close());

    const rerank = reranker.rerank("find owner", ["document"]);
    await waitForWorkerAttempts(pidLogPath, 2);
    assert.deepEqual(await rerank, [{ index: 0, relevanceScore: 8 }]);
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.deepEqual(reranker.getOperationalSnapshot().bootstrap, {
        attemptCount: 2,
        initialFailureReason: "lateon_worker_failure",
        lastFailureReason: "lateon_worker_failure",
    });
});

test("LateOn retries one worker-reported initialization failure", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-init-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["initialization_error", "ready"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());

    await reranker.waitUntilReady();
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.equal(reranker.getOperationalState(), "ready");
});

test("LateOn stops after two retryable bootstrap failures and retains the final cause", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-terminal-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["initialization_error", "exit"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());

    await assert.rejects(reranker.waitUntilReady(), (error: unknown) => (
        error instanceof LateOnOperationalError
        && error.reason === "lateon_worker_failure"
        && error.message.includes("exited before completion")
    ));
    await waitForWorkerAttempts(pidLogPath, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.equal(reranker.getOperationalState(), "unhealthy");
    assert.deepEqual(reranker.getOperationalSnapshot().bootstrap, {
        attemptCount: 2,
        initialFailureReason: "lateon_worker_failure",
        lastFailureReason: "lateon_worker_failure",
    });
    await assert.rejects(
        reranker.rerank("find owner", ["document"]),
        (error: unknown) => (
            error instanceof LateOnOperationalError
            && error.reason === "lateon_worker_failure"
            && error.message.includes("exited before completion")
        ),
    );
});

test("LateOn fails closed when worker readiness identity mismatches the selected profile", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-identity-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { readinessMismatch: true, pidLogPath }),
    });
    t.after(() => reranker.close());

    await assertOperationalReason(reranker.waitUntilReady(), "lateon_worker_failure");
    assert.equal(reranker.getOperationalState(), "unhealthy");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 1);
    await assertOperationalReason(
        reranker.rerank("find owner", ["document"]),
        "lateon_worker_failure",
    );
});

test("LateOn treats malformed bootstrap protocol as terminal without retry", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-protocol-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["malformed", "ready"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());

    await assertOperationalReason(reranker.waitUntilReady(), "lateon_invalid_output");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 1);
    await assertOperationalReason(
        reranker.rerank("find owner", ["document"]),
        "lateon_invalid_output",
    );
});

test("LateOn close prevents a loading worker from spawning a bootstrap retry", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-bootstrap-close-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["timeout", "ready"],
            pidLogPath,
        }),
    });

    const readiness = reranker.waitUntilReady();
    void readiness.catch(() => undefined);
    await waitForWorkerAttempts(pidLogPath, 1);
    await reranker.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 1);
    assert.equal(reranker.getOperationalState(), "closed");
});

test("LateOn a readiness waiter waits for replacement termination before reporting readiness", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-replacement-wait-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["ready", "ready"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const termination = gateWorkerTermination(reranker);
    try {
        const malformed = assertOperationalReason(
            reranker.rerank("malformed", ["first", "second"]),
            "lateon_invalid_output",
        );
        await termination.terminationRequested;

        const waiter = reranker.waitUntilReady();
        let waiterSettled = false;
        void waiter.then(
            () => { waiterSettled = true; },
            () => { waiterSettled = true; },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(waiterSettled, false, "readiness must not resolve while the old worker is terminating");
        assert.equal(reranker.getOperationalSnapshot().terminationActive, true);
        assert.equal(reranker.getOperationalSnapshot().workerAttached, false);
        assert.equal(readWorkerPids(pidLogPath).length, 1, "a waiter must not start a replacement before termination");

        termination.releaseTermination();
        await waiter;
        await malformed;
        assert.equal(reranker.getOperationalState(), "ready");
        assert.equal(readWorkerPids(pidLogPath).length, 2);
    } finally {
        termination.releaseTermination();
    }
});

test("LateOn recovers on demand after a replacement worker fails during loading", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-replacement-recovery-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["ready", "exit", "ready"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    await assertOperationalReason(
        reranker.rerank("malformed", ["first", "second"]),
        "lateon_invalid_output",
    );
    await waitForOperationalSnapshot(reranker, (snapshot) => (
        snapshot.state === "unhealthy"
        && !snapshot.workerAttached
        && !snapshot.terminationActive
    ));
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.equal(reranker.getOperationalSnapshot().bootstrap.attemptCount, 1);

    assert.deepEqual(
        await reranker.rerank("recover", ["document"]),
        [{ index: 0, relevanceScore: 8 }],
    );
    assert.equal(reranker.getOperationalState(), "ready");
    assert.equal(readWorkerPids(pidLogPath).length, 3);
});

test("LateOn close during a replacement window rejects the waiting readiness caller", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-replacement-close-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, {
            bootstrapAttempts: ["ready", "ready"],
            pidLogPath,
        }),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const termination = gateWorkerTermination(reranker);
    const malformed = assertOperationalReason(
        reranker.rerank("malformed", ["first", "second"]),
        "lateon_invalid_output",
    );
    await termination.terminationRequested;

    const waiter = reranker.waitUntilReady();
    const closed = reranker.close();
    termination.releaseTermination();

    await assertOperationalReason(waiter, "lateon_cancelled");
    await malformed;
    await closed;
    assert.equal(reranker.getOperationalState(), "closed");
    assert.equal(readWorkerPids(pidLogPath).length, 1, "close during replacement must not start another worker");
});

test("LateOn starts its worker on first use, releases it when idle, and restarts on demand", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-idle-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "worker-pids.txt");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { pidLogPath }),
        idleShutdownMs: 50,
    });
    t.after(() => reranker.close());

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readWorkerPids(pidLogPath).length, 0);
    assert.equal(reranker.getOperationalSnapshot().workerAttached, false);

    assert.deepEqual(await reranker.rerank("first", ["document"]), [{ index: 0, relevanceScore: 8 }]);
    assert.equal(readWorkerPids(pidLogPath).length, 1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(reranker.getOperationalSnapshot().workerAttached, false);
    assert.equal(reranker.getOperationalState(), "idle");

    assert.deepEqual(await reranker.rerank("second", ["document"]), [{ index: 0, relevanceScore: 8 }]);
    assert.equal(readWorkerPids(pidLogPath).length, 2);
    assert.equal(reranker.getOperationalSnapshot().bootstrap.attemptCount, 1);
});

test("LateOn serializes overlapping reranks through one FIFO queue", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const first = reranker.rerank("slow:80", ["first"]);
    const second = reranker.rerank("second", ["second"]);
    const third = reranker.rerank("third", ["third"]);
    assert.deepEqual(await first, [{ index: 0, relevanceScore: 5 }]);
    assert.deepEqual(await second, [{ index: 0, relevanceScore: 6 }]);
    assert.deepEqual(await third, [{ index: 0, relevanceScore: 5 }]);
});

test("LateOn rejects requests beyond the bounded wait queue", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const active = reranker.rerank("slow:80", ["active"]);
    const queued = Array.from({ length: 16 }, (_, index) => reranker.rerank(`queued-${index}`, ["queued"]));
    await assertOperationalReason(reranker.rerank("overflow", ["overflow"]), "lateon_not_ready");
    await active;
    await Promise.all(queued);
});

test("LateOn queued work waits for the active rerank instead of falling back", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const active = reranker.rerank("slow:80", ["active"]);
    const queued = reranker.rerank("queued", ["queued"]);
    assert.deepEqual(await active, [{ index: 0, relevanceScore: 6 }]);
    assert.deepEqual(await queued, [{ index: 0, relevanceScore: 6 }]);
});

test("LateOn invalid output is rejected transactionally and restarts the worker", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    await assertOperationalReason(
        reranker.rerank("malformed", ["first", "second"]),
        "lateon_invalid_output",
    );
    await reranker.waitUntilReady();
    assert.deepEqual(
        await reranker.rerank("recover", ["document"]),
        [{ index: 0, relevanceScore: 8 }],
    );
});

test("LateOn cancellation removes queued work and terminates executing work", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = reranker.rerank("hang", ["active"], {
        signal: activeController.signal,
    } as Parameters<LateOnReranker["rerank"]>[2]);
    const queued = reranker.rerank("queued", ["queued"], {
        signal: queuedController.signal,
    } as Parameters<LateOnReranker["rerank"]>[2]);
    queuedController.abort();
    await assertOperationalReason(queued, "lateon_cancelled");
    activeController.abort();
    await assertOperationalReason(active, "lateon_cancelled");
    await reranker.waitUntilReady();
});

test("LateOn cancellation during worker startup rejects before readiness without failing other waiters", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { readyDelayMilliseconds: 500 }),
    });
    t.after(() => reranker.close());

    const controller = new AbortController();
    const cancelled = reranker.rerank("find owner", ["cancelled"], {
        signal: controller.signal,
    } as Parameters<LateOnReranker["rerank"]>[2]);
    const waiter = reranker.rerank("find owner", ["document"]);
    controller.abort();
    await assertOperationalReason(cancelled, "lateon_cancelled");
    assert.equal(reranker.getOperationalState(), "loading");
    assert.deepEqual(await waiter, [{ index: 0, relevanceScore: 8 }]);
    assert.equal(reranker.getOperationalState(), "ready");
});

test("LateOn close rejects active and queued work and joins its worker", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    await reranker.waitUntilReady();

    const active = reranker.rerank("hang", ["active"]);
    const queued = reranker.rerank("queued", ["queued"]);
    const activeRejection = assertOperationalReason(active, "lateon_cancelled");
    const queuedRejection = assertOperationalReason(queued, "lateon_cancelled");
    await reranker.close();
    await activeRejection;
    await queuedRejection;
    assert.equal(reranker.getOperationalState(), "closed");
    assert.deepEqual(reranker.getOperationalSnapshot(), {
        state: "closed",
        closed: true,
        workerAttached: false,
        activeRequest: false,
        activeTask: false,
        queuedRequest: false,
        pendingWorkerRequests: 0,
        readinessTimerActive: false,
        terminationActive: false,
        bootstrap: {
            attemptCount: 1,
        },
    });
});

test("LateOn successful execution reports queue wait and a hard safety ceiling", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const reported: { diagnostics: RerankExecutionDiagnostics | null } = { diagnostics: null };
    assert.deepEqual(
        await reranker.rerank("scored", ["alpha", "alphabetic"], {
            onExecutionDiagnostics: (diagnostics) => { reported.diagnostics = diagnostics; },
        }),
        [{ index: 1, relevanceScore: 10 }, { index: 0, relevanceScore: 5 }],
    );

    assert.ok(reported.diagnostics);
    assert.equal(reported.diagnostics.attempts, 1);
    assert.equal(reported.diagnostics.retries, 0);
    assert.equal(reported.diagnostics.timeouts, 0);
    assert.ok(typeof reported.diagnostics.queueWaitMs === "number" && reported.diagnostics.queueWaitMs >= 0);
    assert.ok(
        reported.diagnostics.effectiveScoreDeadlineMs !== undefined
        && reported.diagnostics.effectiveScoreDeadlineMs >= 60_000,
    );
    assert.equal(reported.diagnostics.effectiveStageDeadlineMs, undefined);
    assert.ok(typeof reported.diagnostics.observedWallMs === "number" && reported.diagnostics.observedWallMs >= 0);
    assert.equal(reported.diagnostics.deadlineLatenessMs, undefined);
});

test("LateOn queued execution reports the actual queue wait without a queue timeout", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const reported: { diagnostics: RerankExecutionDiagnostics | null } = { diagnostics: null };
    const active = reranker.rerank("slow:80", ["active"]);
    const queued = reranker.rerank("queued", ["queued"], {
        onExecutionDiagnostics: (diagnostics) => { reported.diagnostics = diagnostics; },
    });
    await active;
    await queued;

    assert.ok(reported.diagnostics);
    assert.equal(reported.diagnostics.timeouts, 0);
    assert.ok(
        typeof reported.diagnostics.queueWaitMs === "number"
        && reported.diagnostics.queueWaitMs >= 50,
    );
    assert.equal(reported.diagnostics.effectiveStageDeadlineMs, undefined);
});

test("LateOn diagnostics callback failure never changes rerank behavior", async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t),
    });
    t.after(() => reranker.close());
    await reranker.waitUntilReady();

    const throwing = (): void => { throw new Error("telemetry boom"); };
    assert.deepEqual(
        await reranker.rerank("scored", ["document"], { onExecutionDiagnostics: throwing }),
        [{ index: 0, relevanceScore: 8 }],
    );
});

test("LateOn warmUp starts the worker asynchronously when idle, is idempotent, and releases after idleShutdownMs", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-warmup-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "warmup-pids.log");
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { pidLogPath }),
        idleShutdownMs: 60,
    });
    t.after(() => reranker.close());

    assert.equal(reranker.getOperationalState(), "idle");
    reranker.warmUp();
    assert.equal(reranker.getOperationalState(), "loading");
    // Second warmUp while loading must not spawn another worker.
    reranker.warmUp();
    await reranker.waitUntilReady();
    assert.equal(reranker.getOperationalState(), "ready");
    assert.equal(readWorkerPids(pidLogPath).length, 1);

    // Calling warmUp while ready is a no-op.
    reranker.warmUp();
    assert.equal(readWorkerPids(pidLogPath).length, 1);

    // Unused warmed worker releases after idleShutdownMs.
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(reranker.getOperationalState(), "idle");
    assert.equal(reranker.getOperationalSnapshot().workerAttached, false);
});

test("LateOn warmUp skips when mutations are active or reranker is closed, and close cleans up mid-warmup", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "satori-lateon-warmup-skip-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pidLogPath = path.join(directory, "warmup-skip-pids.log");
    let activeMutations = 1;
    const reranker = new LateOnReranker({
        modelDirectory: "/unused/by/fake-worker",
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
        workerPath: createFakeWorker(t, { pidLogPath, readyDelayMilliseconds: 120 }),
        getActiveMutationCount: () => activeMutations,
    });
    t.after(() => reranker.close());

    reranker.warmUp();
    assert.equal(reranker.getOperationalState(), "idle");
    assert.equal(readWorkerPids(pidLogPath).length, 0);

    activeMutations = 0;
    reranker.warmUp();
    assert.equal(reranker.getOperationalState(), "loading");
    await reranker.close();
    assert.equal(reranker.getOperationalState(), "closed");
    assert.equal(reranker.getOperationalSnapshot().workerAttached, false);

    // Calling warmUp after close must remain closed without spawning.
    reranker.warmUp();
    assert.equal(reranker.getOperationalState(), "closed");
});

const realLateOnModelDirectory = process.env.SATORI_LATEON_MODEL_PATH;
test("LateOn v6 accepts query-v2 and the canonical document projection through the real tokenizer and model", {
    skip: !realLateOnModelDirectory || !fs.existsSync(path.join(realLateOnModelDirectory, "model.onnx")),
}, async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: realLateOnModelDirectory as string,
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
    });
    t.after(async () => reranker.close());
    await reranker.waitUntilReady();
    const query = buildSearchRerankQuery({
        semanticQuery: "how does Shariah compliance checking block trades",
        answerFocus: "implementation",
    });
    const documents = [
        buildSearchRerankDocument({
            relativePath: "src/veto.ts",
            language: "typescript",
            candidateRole: "implementation",
            symbolKind: "function",
            canonicalSymbolLabel: "validate_order",
            symbolSpan: { startLine: 1, endLine: 3 },
            content: [
                "function validate_order(order) {",
                "    return check_shariah_compliance(order);",
                "}",
            ].join("\n"),
            query: "how does Shariah compliance checking block trades",
        }).text,
        buildSearchRerankDocument({
            relativePath: "tests/veto.test.ts",
            language: "typescript",
            candidateRole: "test",
            symbolKind: "test",
            canonicalSymbolLabel: "validates_trade_veto",
            symbolSpan: { startLine: 1, endLine: 3 },
            content: [
                "test(\"validates trade veto\", () => {",
                "    assert.equal(validate_order(order), false);",
                "});",
            ].join("\n"),
            query: "how does Shariah compliance checking block trades",
        }).text,
    ];
    const results = await reranker.rerank(query, documents);
    assert.equal(results.length, documents.length);
    assert.deepEqual(results.map((result) => result.index).sort(), [0, 1]);
    assert.ok(results.every((result) => Number.isFinite(result.relevanceScore)));
});

test("LateOn encoder pools return the single-session ranking and scores exactly", {
    skip: !realLateOnModelDirectory || !fs.existsSync(path.join(realLateOnModelDirectory, "model.onnx")),
}, async (t) => {
    const semanticQuery = "where are effect cleanups run when a component unmounts";
    const query = buildSearchRerankQuery({ semanticQuery, answerFocus: "implementation" });
    const sources = [
        "function commitHookEffectListUnmount(flags, finishedWork) {\n    const destroy = effect.destroy;\n    if (destroy !== undefined) safelyCallDestroy(finishedWork, destroy);\n}",
        "export function useEffect(create, deps) {\n    return mountEffect(create, deps);\n}",
        "test(\"runs cleanup on unmount\", () => {\n    root.unmount();\n    expect(log).toEqual([\"cleanup\"]);\n});",
        `${"// scheduler lane bookkeeping\n".repeat(40)}function markRootFinished(root, lanes) {\n    root.pendingLanes = lanes;\n}`,
        "const NoFlags = 0;",
    ];
    const documents = [...sources, sources[1]].map((content, index) => buildSearchRerankDocument({
        relativePath: `src/effects-${index}.js`,
        language: "javascript",
        candidateRole: index === 2 ? "test" : "implementation",
        symbolKind: "function",
        canonicalSymbolLabel: `symbol_${index}`,
        symbolSpan: { startLine: 1, endLine: content.split("\n").length },
        content,
        query: semanticQuery,
    }).text);
    const rankWith = async (encoderSessions: number, intraOpThreads: number) => {
        const reranker = new LateOnReranker({
            modelDirectory: realLateOnModelDirectory as string,
            profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
            executionPlan: { encoderSessions, intraOpThreads },
        });
        t.after(async () => reranker.close());
        return reranker.rerank(query, documents);
    };
    const serial = await rankWith(1, 1);
    assert.equal(serial.length, documents.length);
    assert.deepEqual(await rankWith(3, 1), serial);
    assert.deepEqual(await rankWith(4, 2), serial);
});

test("LateOn rerank serves repeated query and document pairs from cache without changing scores", {
    skip: !realLateOnModelDirectory || !fs.existsSync(path.join(realLateOnModelDirectory, "model.onnx")),
}, async (t) => {
    const reranker = new LateOnReranker({
        modelDirectory: realLateOnModelDirectory as string,
        profileId: LATEON_RUNTIME_PROFILE_IDS.contextV6D128,
    });
    t.after(async () => reranker.close());
    const semanticQuery = "where are effect cleanups run when a component unmounts";
    const query = buildSearchRerankQuery({ semanticQuery, answerFocus: "implementation" });
    const sources = [
        "function commitHookEffectListUnmount(flags, finishedWork) {\n    const destroy = effect.destroy;\n    if (destroy !== undefined) safelyCallDestroy(finishedWork, destroy);\n}",
        "export function useEffect(create, deps) {\n    return mountEffect(create, deps);\n}",
        "test(\"runs cleanup on unmount\", () => {\n    root.unmount();\n    expect(log).toEqual([\"cleanup\"]);\n});",
        "const NoFlags = 0;",
    ];
    const documents = sources.map((content, index) => buildSearchRerankDocument({
        relativePath: `src/cache-${index}.js`,
        language: "javascript",
        candidateRole: index === 2 ? "test" : "implementation",
        symbolKind: "function",
        canonicalSymbolLabel: `cache_symbol_${index}`,
        symbolSpan: { startLine: 1, endLine: content.split("\n").length },
        content,
        query: semanticQuery,
    }).text);

    const cold = await reranker.rerank(query, documents);
    const warm = await reranker.rerank(query, documents);
    assert.deepEqual(warm, cold, "a fully cached rerank must return the identical ranking and scores");

    // A different query must not reuse the cached document scores.
    const otherQuery = buildSearchRerankQuery({
        semanticQuery: "how is scheduler lane bookkeeping reset after work finishes",
        answerFocus: "implementation",
    });
    const requery = await reranker.rerank(otherQuery, documents);
    assert.notDeepEqual(
        requery.map((row) => row.relevanceScore),
        cold.map((row) => row.relevanceScore),
    );

    // A different document text must not reuse the cached score for that slot.
    const mutated = [...documents];
    mutated[0] = buildSearchRerankDocument({
        relativePath: "src/cache-0.js",
        language: "javascript",
        candidateRole: "implementation",
        symbolKind: "function",
        canonicalSymbolLabel: "cache_symbol_0",
        symbolSpan: { startLine: 1, endLine: 1 },
        content: "const NoFlags = 0;",
        query: semanticQuery,
    }).text;
    const remutated = await reranker.rerank(query, mutated);
    assert.notStrictEqual(
        remutated.find((row) => row.index === 0)?.relevanceScore,
        cold.find((row) => row.index === 0)?.relevanceScore,
    );
});
