import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
    LateOnEncoderRequest,
    LateOnEncoderResponse,
    LateOnRuntimeProfile,
    LateOnWorkerRequest,
    LateOnWorkerResponse,
} from "./lateon-reranker-protocol.js";

type Encoder = Readonly<{
    request: (message: LateOnEncoderRequest) => Promise<LateOnEncoderResponse>;
    terminate: () => Promise<number>;
}>;

type RuntimeState = Readonly<{
    profile: LateOnRuntimeProfile;
    encoders: readonly Encoder[];
}>;

let runtime: RuntimeState | null = null;
let encoders: readonly Encoder[] = [];
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

function startEncoder(): Encoder {
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
    runtime = { profile: request.profile, encoders };
    send({
        type: "ready",
        modelRevision: request.profile.identity.revision,
        projectionVersion: request.profile.identity.projectionVersion,
        candidateDepth: request.profile.inference.candidateDepth,
    });
}

async function encodeQuery(
    state: RuntimeState,
    query: string,
): Promise<Extract<LateOnEncoderResponse, { type: "query" }>> {
    const response = await state.encoders[0].request({ type: "encode_query", text: query });
    if (response.type !== "query") throw new Error("LateOn encoder emitted an unexpected response.");
    return response;
}

async function scoreDocuments(
    state: RuntimeState,
    documents: readonly string[],
    queryVectors: readonly number[][],
): Promise<Readonly<{ scores: readonly number[]; tokenCount: number }>> {
    // Longest documents first, so the last job to finish is a short one.
    const order = documents
        .map((_, index) => index)
        .sort((left, right) => documents[right].length - documents[left].length || left - right);
    const scores = new Array<number>(documents.length);
    let tokenCount = 0;
    let next = 0;
    let failure: { error: unknown } | null = null;
    // Each encoder takes the next document when it finishes one. After a failure
    // no new jobs start, and every lane settles before this returns or throws.
    await Promise.all(state.encoders.map(async (encoder) => {
        while (!failure && next < order.length) {
            const index = order[next++];
            try {
                const response = await encoder.request({
                    type: "score_document",
                    text: documents[index],
                    queryVectors,
                });
                if (response.type !== "scored") {
                    throw new Error("LateOn encoder emitted an unexpected response.");
                }
                scores[index] = response.relevanceScore;
                tokenCount += response.tokenCount;
            } catch (error) {
                failure ??= { error };
            }
        }
    }));
    if (failure) throw (failure as { error: unknown }).error;
    return { scores, tokenCount };
}

async function rerank(
    request: Extract<LateOnWorkerRequest, { type: "rerank" }>,
): Promise<void> {
    if (!runtime) throw new Error("LateOn worker is not initialized.");
    if (
        request.documents.length !== request.identities.length
        || request.documents.length > runtime.profile.inference.candidateDepth
    ) {
        throw new Error("LateOn rerank request violates the candidate contract.");
    }
    const queryEncoding = await encodeQuery(runtime, request.query);
    const documentScores = await scoreDocuments(runtime, request.documents, queryEncoding.vectors);
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

process.on("message", (message: LateOnWorkerRequest) => {
    operation = operation.then(async () => {
        try {
            if (message.type === "initialize") {
                await initialize(message);
            } else {
                await rerank(message);
            }
        } catch (error) {
            send({
                type: "error",
                ...(message.type === "rerank" ? { requestId: message.requestId } : {}),
                message: error instanceof Error ? error.message : String(error),
            });
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
