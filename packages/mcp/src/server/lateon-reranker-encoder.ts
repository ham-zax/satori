import { parentPort } from "node:worker_threads";
import path from "node:path";
import * as transformers from "@huggingface/transformers";
import * as onnxRuntime from "onnxruntime-node";
import type {
    LateOnEncoderRequest,
    LateOnEncoderResponse,
    LateOnRuntimeProfile,
} from "./lateon-reranker-protocol.js";

// One encoder thread owns one model session. The worker process verifies the
// runtime and artifacts before starting encoders and runs one job per encoder at
// a time, so every score is computed exactly as the serial path computed it.

type TokenizedInput = Readonly<{
    input_ids: Readonly<{
        data: BigInt64Array;
        dims: readonly number[];
    }>;
    attention_mask: Readonly<{
        data: BigInt64Array;
        dims: readonly number[];
    }>;
}>;

type EncodedText = Readonly<{
    vectors: number[][];
    tokenCount: number;
}>;

type RuntimeState = Readonly<{
    profile: LateOnRuntimeProfile;
    tokenizer: (
        text: string,
        options: { truncation: boolean; max_length: number },
    ) => TokenizedInput;
    session: onnxRuntime.InferenceSession;
}>;

let runtime: RuntimeState | null = null;

function normalizeVector(vector: number[]): number[] {
    let squaredNorm = 0;
    for (const value of vector) squaredNorm += value * value;
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm === 0) {
        throw new Error("LateOn emitted a non-normalizable token vector.");
    }
    return vector.map((value) => value / norm);
}

function maxSimScore(queryVectors: readonly number[][], documentVectors: readonly number[][]): number {
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

async function encodeText(
    state: RuntimeState,
    text: string,
    isQuery: boolean,
): Promise<EncodedText> {
    const { inference } = state.profile;
    const normalizedText = inference.lowercase ? text.toLowerCase() : text;
    const tokenized = state.tokenizer(
        `${isQuery ? inference.queryPrefix : inference.documentPrefix}${normalizedText}`,
        {
            truncation: true,
            max_length: isQuery
                ? inference.queryTokenLimit
                : inference.documentTokenLimit,
        },
    );
    const sequenceLength = tokenized.input_ids.dims[1];
    if (!Number.isSafeInteger(sequenceLength) || sequenceLength <= 0) {
        throw new Error("LateOn tokenizer emitted an empty sequence.");
    }
    const inputIds = new BigInt64Array(tokenized.input_ids.data);
    const attentionMask = new BigInt64Array(tokenized.attention_mask.data);
    const output = await state.session.run({
        [inference.inputIdsName]: new onnxRuntime.Tensor(
            "int64",
            inputIds,
            [1, sequenceLength],
        ),
        [inference.attentionMaskName]: new onnxRuntime.Tensor(
            "int64",
            attentionMask,
            [1, sequenceLength],
        ),
    });
    const tensor = output[inference.outputName];
    if (
        !tensor
        || tensor.type !== "float32"
        || tensor.dims[0] !== 1
        || tensor.dims[1] !== sequenceLength
        || tensor.dims[2] !== inference.embeddingDimensions
        || !(tensor.data instanceof Float32Array)
    ) {
        throw new Error("LateOn model returned an incompatible output tensor.");
    }
    const skippedTokens = new Set(inference.documentSkipTokenIds);
    const vectors: number[][] = [];
    for (let tokenIndex = 0; tokenIndex < sequenceLength; tokenIndex++) {
        if (attentionMask[tokenIndex] === 0n) continue;
        const tokenId = Number(inputIds[tokenIndex]);
        if (!isQuery && skippedTokens.has(tokenId)) continue;
        const offset = tokenIndex * inference.embeddingDimensions;
        vectors.push(normalizeVector(Array.from(
            tensor.data.slice(offset, offset + inference.embeddingDimensions),
        )));
    }
    return { vectors, tokenCount: sequenceLength };
}

async function initialize(
    request: Extract<LateOnEncoderRequest, { type: "initialize" }>,
): Promise<void> {
    if (runtime) throw new Error("LateOn encoder is already initialized.");
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    // An absolute directory is loaded as a local path; Transformers.js v4 rejects
    // revision-pinned basenames (`name@sha`) as model ids.
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(request.modelDirectory);
    (tokenizer as unknown as { truncation_side: "right" }).truncation_side = "right";
    const session = await onnxRuntime.InferenceSession.create(
        path.join(request.modelDirectory, request.profile.inference.modelPath),
        {
            executionProviders: [request.profile.runtime.executionProvider],
            intraOpNumThreads: request.intraOpThreads,
            interOpNumThreads: request.profile.inference.interOpThreads,
            executionMode: request.profile.execution.executionMode,
            graphOptimizationLevel: request.profile.execution.graphOptimizationLevel,
        } as unknown as Parameters<typeof onnxRuntime.InferenceSession.create>[1],
    );
    runtime = {
        profile: request.profile,
        tokenizer: tokenizer as unknown as RuntimeState["tokenizer"],
        session,
    };
}

async function handle(request: LateOnEncoderRequest): Promise<LateOnEncoderResponse> {
    if (request.type === "initialize") {
        await initialize(request);
        return { type: "ready" };
    }
    if (!runtime) throw new Error("LateOn encoder is not initialized.");
    if (request.type === "encode_query") {
        const encoded = await encodeText(runtime, request.text, true);
        return { type: "query", vectors: encoded.vectors, tokenCount: encoded.tokenCount };
    }
    const encoded = await encodeText(runtime, request.text, false);
    return {
        type: "scored",
        relevanceScore: maxSimScore(request.queryVectors, encoded.vectors),
        tokenCount: encoded.tokenCount,
    };
}

const port = parentPort;
if (!port) throw new Error("LateOn encoder must run as a worker thread.");
port.on("message", (request: LateOnEncoderRequest) => {
    void handle(request).then(
        (response) => port.postMessage(response),
        (error: unknown) => port.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
        } satisfies LateOnEncoderResponse),
    );
});
