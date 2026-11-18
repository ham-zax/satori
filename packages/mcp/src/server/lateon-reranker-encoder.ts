import { parentPort } from "node:worker_threads";
import path from "node:path";
import type * as onnxRuntime from "onnxruntime-node";
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

// Token vectors stay in one flat Float64Array so a document never allocates a
// boxed array per token. `dimensions` is the stride between token vectors.
export type EncodedText = Readonly<{
    vectors: Float64Array;
    dimensions: number;
    tokenCount: number;
}>;

type QueryProjection = Readonly<{
    vectors: Float64Array;
    dimensions: number;
}>;

type RuntimeState = Readonly<{
    profile: LateOnRuntimeProfile;
    tokenizer: (
        text: string,
        options: { truncation: boolean; max_length: number },
    ) => TokenizedInput;
    session: onnxRuntime.InferenceSession;
    // The tensor constructor travels with the runtime, so the native ONNX
    // Runtime module is only loaded once an encoder actually initializes.
    Tensor: typeof onnxRuntime.Tensor;
    skippedTokens: ReadonlySet<number>;
}>;

let runtime: RuntimeState | null = null;
let currentQuery: QueryProjection | null = null;

// Normalizes the kept token rows of a model output tensor into one flat
// Float64Array. The accumulation and division order matches the previous
// `Array.from(...).map((value) => value / norm)` path exactly, so every score
// stays bit-identical.
export function encodeTokenVectors(
    data: Float32Array,
    sequenceLength: number,
    dimensions: number,
    isKept: (tokenIndex: number) => boolean,
): Float64Array {
    let keptTokens = 0;
    for (let tokenIndex = 0; tokenIndex < sequenceLength; tokenIndex++) {
        if (isKept(tokenIndex)) keptTokens += 1;
    }
    const vectors = new Float64Array(keptTokens * dimensions);
    let writeOffset = 0;
    for (let tokenIndex = 0; tokenIndex < sequenceLength; tokenIndex++) {
        if (!isKept(tokenIndex)) continue;
        const offset = tokenIndex * dimensions;
        let squaredNorm = 0;
        for (let dimension = 0; dimension < dimensions; dimension++) {
            const value = data[offset + dimension];
            squaredNorm += value * value;
        }
        const norm = Math.sqrt(squaredNorm);
        if (!Number.isFinite(norm) || norm === 0) {
            throw new Error("LateOn emitted a non-normalizable token vector.");
        }
        for (let dimension = 0; dimension < dimensions; dimension++) {
            vectors[writeOffset + dimension] = data[offset + dimension] / norm;
        }
        writeOffset += dimensions;
    }
    return vectors;
}

// Late-interaction max-sim over two flat projections. Reads both buffers in
// place, so scoring a document allocates nothing.
export function maxSimScore(
    queryVectors: Float64Array,
    queryDimensions: number,
    documentVectors: Float64Array,
    documentDimensions: number,
): number {
    if (queryDimensions <= 0 || documentDimensions <= 0) return 0;
    const queryCount = Math.floor(queryVectors.length / queryDimensions);
    const documentCount = Math.floor(documentVectors.length / documentDimensions);
    if (queryCount === 0 || documentCount === 0) return 0;
    let score = 0;
    for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
        const queryOffset = queryIndex * queryDimensions;
        let maximum = Number.NEGATIVE_INFINITY;
        for (let documentIndex = 0; documentIndex < documentCount; documentIndex++) {
            const documentOffset = documentIndex * documentDimensions;
            let dotProduct = 0;
            for (let dimension = 0; dimension < queryDimensions; dimension++) {
                dotProduct += queryVectors[queryOffset + dimension]
                    * documentVectors[documentOffset + dimension];
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
    const dimensions = inference.embeddingDimensions;
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
    // The tokenizer already hands back BigInt64Array buffers, so the tensor
    // inputs are only copied when it does not.
    const inputIds = tokenized.input_ids.data instanceof BigInt64Array
        ? tokenized.input_ids.data
        : new BigInt64Array(tokenized.input_ids.data);
    const attentionMask = tokenized.attention_mask.data instanceof BigInt64Array
        ? tokenized.attention_mask.data
        : new BigInt64Array(tokenized.attention_mask.data);
    const output = await state.session.run({
        [inference.inputIdsName]: new state.Tensor(
            "int64",
            inputIds,
            [1, sequenceLength],
        ),
        [inference.attentionMaskName]: new state.Tensor(
            "int64",
            attentionMask,
            [1, sequenceLength],
        ),
    });
    const tensor = output[inference.outputName];
    const tensorData = tensor?.data;
    if (
        !tensor
        || tensor.type !== "float32"
        || tensor.dims[0] !== 1
        || tensor.dims[1] !== sequenceLength
        || tensor.dims[2] !== dimensions
        || !(tensorData instanceof Float32Array)
    ) {
        throw new Error("LateOn model returned an incompatible output tensor.");
    }
    const skippedTokens = state.skippedTokens;
    const vectors = encodeTokenVectors(
        tensorData,
        sequenceLength,
        dimensions,
        (tokenIndex) => attentionMask[tokenIndex] !== 0n
            && (isQuery || !skippedTokens.has(Number(inputIds[tokenIndex]))),
    );
    return { vectors, dimensions, tokenCount: sequenceLength };
}

async function initialize(
    request: Extract<LateOnEncoderRequest, { type: "initialize" }>,
): Promise<void> {
    if (runtime) throw new Error("LateOn encoder is already initialized.");
    // Transformers.js and ONNX Runtime are ~240 MB of native libraries. Loading
    // them here rather than at module scope keeps the pure projection helpers
    // importable by unit tests without paying that cost.
    const [transformersModule, onnxRuntimeModule] = await Promise.all([
        import("@huggingface/transformers"),
        import("onnxruntime-node"),
    ]);
    transformersModule.env.allowRemoteModels = false;
    transformersModule.env.allowLocalModels = true;
    // An absolute directory is loaded as a local path; Transformers.js v4 rejects
    // revision-pinned basenames (`name@sha`) as model ids.
    const tokenizer = await transformersModule.AutoTokenizer.from_pretrained(request.modelDirectory);
    (tokenizer as unknown as { truncation_side: "right" }).truncation_side = "right";
    const session = await onnxRuntimeModule.InferenceSession.create(
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
        Tensor: onnxRuntimeModule.Tensor,
        skippedTokens: new Set(request.profile.inference.documentSkipTokenIds),
    };
}

async function handle(request: LateOnEncoderRequest): Promise<LateOnEncoderResponse> {
    if (request.type === "initialize") {
        await initialize(request);
        return { type: "ready" };
    }
    if (!runtime) throw new Error("LateOn encoder is not initialized.");
    if (request.type === "set_query") {
        if (!Number.isSafeInteger(request.dimensions) || request.dimensions <= 0) {
            throw new Error("LateOn encoder received a malformed query projection.");
        }
        const expectedDimensions = runtime.profile.inference.embeddingDimensions;
        if (request.dimensions !== expectedDimensions) {
            throw new Error(
                `LateOn encoder received a query projection with ${request.dimensions} dimensions; `
                + `the profile requires ${expectedDimensions}.`,
            );
        }
        if (request.vectors.length === 0 || request.vectors.length % request.dimensions !== 0) {
            throw new Error(
                "LateOn encoder received a query projection whose vector length is not a "
                + "whole number of token vectors.",
            );
        }
        currentQuery = { vectors: request.vectors, dimensions: request.dimensions };
        return { type: "query_set" };
    }
    if (request.type === "encode_query") {
        const encoded = await encodeText(runtime, request.text, true);
        return {
            type: "query",
            vectors: encoded.vectors,
            dimensions: encoded.dimensions,
            tokenCount: encoded.tokenCount,
        };
    }
    const query = currentQuery;
    if (!query) throw new Error("LateOn encoder has no query projection to score against.");
    const encoded = await encodeText(runtime, request.text, false);
    return {
        type: "scored",
        relevanceScore: maxSimScore(
            query.vectors,
            query.dimensions,
            encoded.vectors,
            encoded.dimensions,
        ),
        tokenCount: encoded.tokenCount,
    };
}

// The encoder is only ever started as a worker thread, so the port is present
// in production. Guarding it keeps the pure projection helpers importable.
if (parentPort) {
    const port = parentPort;
    port.on("message", (request: LateOnEncoderRequest) => {
        void handle(request).then(
            (response) => port.postMessage(response),
            (error: unknown) => port.postMessage({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
            } satisfies LateOnEncoderResponse),
        );
    });
}
