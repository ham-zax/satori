import { parentPort, type Transferable } from "node:worker_threads";
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

// Specialized 48-dimension late-interaction max-sim preserving strict
// left-to-right IEEE-754 addition order so scores remain bit-identical to the
// generic loop while avoiding inner-loop overhead on warm documentCache hits.
function maxSimScore48(
    queryVectors: Float64Array,
    documentVectors: Float64Array,
): number {
    const queryCount = Math.floor(queryVectors.length / 48);
    const documentCount = Math.floor(documentVectors.length / 48);
    if (queryCount === 0 || documentCount === 0) return 0;
    let score = 0;
    for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
        const qo = queryIndex * 48;
        const q0 = queryVectors[qo], q1 = queryVectors[qo + 1], q2 = queryVectors[qo + 2], q3 = queryVectors[qo + 3];
        const q4 = queryVectors[qo + 4], q5 = queryVectors[qo + 5], q6 = queryVectors[qo + 6], q7 = queryVectors[qo + 7];
        const q8 = queryVectors[qo + 8], q9 = queryVectors[qo + 9], q10 = queryVectors[qo + 10], q11 = queryVectors[qo + 11];
        const q12 = queryVectors[qo + 12], q13 = queryVectors[qo + 13], q14 = queryVectors[qo + 14], q15 = queryVectors[qo + 15];
        const q16 = queryVectors[qo + 16], q17 = queryVectors[qo + 17], q18 = queryVectors[qo + 18], q19 = queryVectors[qo + 19];
        const q20 = queryVectors[qo + 20], q21 = queryVectors[qo + 21], q22 = queryVectors[qo + 22], q23 = queryVectors[qo + 23];
        const q24 = queryVectors[qo + 24], q25 = queryVectors[qo + 25], q26 = queryVectors[qo + 26], q27 = queryVectors[qo + 27];
        const q28 = queryVectors[qo + 28], q29 = queryVectors[qo + 29], q30 = queryVectors[qo + 30], q31 = queryVectors[qo + 31];
        const q32 = queryVectors[qo + 32], q33 = queryVectors[qo + 33], q34 = queryVectors[qo + 34], q35 = queryVectors[qo + 35];
        const q36 = queryVectors[qo + 36], q37 = queryVectors[qo + 37], q38 = queryVectors[qo + 38], q39 = queryVectors[qo + 39];
        const q40 = queryVectors[qo + 40], q41 = queryVectors[qo + 41], q42 = queryVectors[qo + 42], q43 = queryVectors[qo + 43];
        const q44 = queryVectors[qo + 44], q45 = queryVectors[qo + 45], q46 = queryVectors[qo + 46], q47 = queryVectors[qo + 47];
        let maximum = Number.NEGATIVE_INFINITY;
        for (let documentIndex = 0; documentIndex < documentCount; documentIndex++) {
            const o = documentIndex * 48;
            let dotProduct = q0 * documentVectors[o];
            dotProduct += q1 * documentVectors[o + 1]; dotProduct += q2 * documentVectors[o + 2]; dotProduct += q3 * documentVectors[o + 3];
            dotProduct += q4 * documentVectors[o + 4]; dotProduct += q5 * documentVectors[o + 5]; dotProduct += q6 * documentVectors[o + 6]; dotProduct += q7 * documentVectors[o + 7];
            dotProduct += q8 * documentVectors[o + 8]; dotProduct += q9 * documentVectors[o + 9]; dotProduct += q10 * documentVectors[o + 10]; dotProduct += q11 * documentVectors[o + 11];
            dotProduct += q12 * documentVectors[o + 12]; dotProduct += q13 * documentVectors[o + 13]; dotProduct += q14 * documentVectors[o + 14]; dotProduct += q15 * documentVectors[o + 15];
            dotProduct += q16 * documentVectors[o + 16]; dotProduct += q17 * documentVectors[o + 17]; dotProduct += q18 * documentVectors[o + 18]; dotProduct += q19 * documentVectors[o + 19];
            dotProduct += q20 * documentVectors[o + 20]; dotProduct += q21 * documentVectors[o + 21]; dotProduct += q22 * documentVectors[o + 22]; dotProduct += q23 * documentVectors[o + 23];
            dotProduct += q24 * documentVectors[o + 24]; dotProduct += q25 * documentVectors[o + 25]; dotProduct += q26 * documentVectors[o + 26]; dotProduct += q27 * documentVectors[o + 27];
            dotProduct += q28 * documentVectors[o + 28]; dotProduct += q29 * documentVectors[o + 29]; dotProduct += q30 * documentVectors[o + 30]; dotProduct += q31 * documentVectors[o + 31];
            dotProduct += q32 * documentVectors[o + 32]; dotProduct += q33 * documentVectors[o + 33]; dotProduct += q34 * documentVectors[o + 34]; dotProduct += q35 * documentVectors[o + 35];
            dotProduct += q36 * documentVectors[o + 36]; dotProduct += q37 * documentVectors[o + 37]; dotProduct += q38 * documentVectors[o + 38]; dotProduct += q39 * documentVectors[o + 39];
            dotProduct += q40 * documentVectors[o + 40]; dotProduct += q41 * documentVectors[o + 41]; dotProduct += q42 * documentVectors[o + 42]; dotProduct += q43 * documentVectors[o + 43];
            dotProduct += q44 * documentVectors[o + 44]; dotProduct += q45 * documentVectors[o + 45]; dotProduct += q46 * documentVectors[o + 46]; dotProduct += q47 * documentVectors[o + 47];
            if (dotProduct > maximum) maximum = dotProduct;
        }
        score += maximum;
    }
    return score;
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
    if (queryDimensions === 48 && documentDimensions === 48) {
        return maxSimScore48(queryVectors, documentVectors);
    }
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
        vectors: encoded.vectors,
        dimensions: encoded.dimensions,
    };
}

function transferListFor(response: LateOnEncoderResponse): Transferable[] {
    if (
        (response.type === "query" || response.type === "scored")
        && response.vectors.byteLength > 0
        && response.vectors.byteOffset === 0
        && response.vectors.byteLength === response.vectors.buffer.byteLength
        && response.vectors.buffer instanceof ArrayBuffer
    ) {
        return [response.vectors.buffer];
    }
    return [];
}

// The encoder is only ever started as a worker thread, so the port is present
// in production. Guarding it keeps the pure projection helpers importable.
if (parentPort) {
    const port = parentPort;
    port.on("message", (request: LateOnEncoderRequest) => {
        void handle(request).then(
            (response) => port.postMessage(response, transferListFor(response)),
            (error: unknown) => port.postMessage({
                type: "error",
                message: error instanceof Error ? error.message : String(error),
            } satisfies LateOnEncoderResponse),
        );
    });
}
