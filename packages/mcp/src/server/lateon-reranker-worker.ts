import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as transformers from "@huggingface/transformers";
import * as onnxRuntime from "onnxruntime-node";
import type {
    LateOnRuntimeProfile,
    LateOnWorkerRequest,
    LateOnWorkerResponse,
} from "./lateon-reranker-protocol.js";

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
    vectors: readonly number[][];
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
    request: Extract<LateOnWorkerRequest, { type: "initialize" }>,
): Promise<void> {
    if (runtime) throw new Error("LateOn worker is already initialized.");
    if (request.profile.runtime.transformersJs !== resolvePackageVersion("@huggingface/transformers")) {
        throw new Error("Transformers.js version does not match the LateOn profile.");
    }
    if (request.profile.runtime.onnxruntimeNode !== resolvePackageVersion("onnxruntime-node")) {
        throw new Error("ONNX Runtime version does not match the LateOn profile.");
    }
    assertArtifacts(request.profile, request.modelDirectory);
    process.env.TOKENIZERS_PARALLELISM = "false";
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.localModelPath = `${path.dirname(request.modelDirectory)}${path.sep}`;
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(
        path.basename(request.modelDirectory),
    );
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
    send({
        type: "ready",
        modelRevision: request.profile.identity.revision,
        projectionVersion: request.profile.identity.projectionVersion,
        candidateDepth: request.profile.inference.candidateDepth,
    });
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
    const queryEncoding = await encodeText(runtime, request.query, true);
    let aggregateTokenCount = queryEncoding.tokenCount;
    const scored: Array<{ index: number; identity: string; relevanceScore: number }> = [];
    for (let index = 0; index < request.documents.length; index++) {
        const documentEncoding = await encodeText(runtime, request.documents[index], false);
        aggregateTokenCount += documentEncoding.tokenCount;
        if (aggregateTokenCount > runtime.profile.execution.aggregateRequestTokenLimit) {
            throw new Error("LateOn rerank request exceeds the aggregate token contract.");
        }
        scored.push({
            index,
            identity: request.identities[index],
            relevanceScore: maxSimScore(queryEncoding.vectors, documentEncoding.vectors),
        });
    }
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
        .then(() => runtime?.session.release())
        .finally(() => process.exit(0));
});
