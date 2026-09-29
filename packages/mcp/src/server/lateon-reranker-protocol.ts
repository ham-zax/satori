export const LATEON_RUNTIME_PROFILE_IDS = Object.freeze({
    contextV5D32: "lateon_offline_quality_projection_v5_d32_v1",
} as const);

export type LateOnRuntimeProfileId =
    typeof LATEON_RUNTIME_PROFILE_IDS[keyof typeof LATEON_RUNTIME_PROFILE_IDS];

export const LATEON_ACTIVATION_POLICY_IDS = Object.freeze({
    ownerDefaultContextV5: "lateon_context_v5_d32_owner_default_v1",
} as const);

export type LateOnActivationPolicyId =
    typeof LATEON_ACTIVATION_POLICY_IDS[keyof typeof LATEON_ACTIVATION_POLICY_IDS];

export type LateOnArtifactContract = Readonly<{
    path: string;
    sha256: string;
}>;

type LateOnRuntimeProfileBase = Readonly<{
    identity: Readonly<{
        repository: string;
        revision: string;
        license: "Apache-2.0";
        projectionVersion:
            | "search_rerank_document_v1"
            | "search_rerank_document_v2"
            | "search_rerank_document_v3"
            | "search_rerank_document_v4";
        projectionSha256?: string;
    }>;
    artifacts: readonly LateOnArtifactContract[];
    runtime: Readonly<{
        transformersJs: string;
        onnxruntimeNode: string;
        executionProvider: "cpu";
    }>;
    inference: Readonly<{
        modelPath: string;
        inputIdsName: string;
        attentionMaskName: string;
        outputName: string;
        embeddingDimensions: number;
        queryPrefix: string;
        documentPrefix: string;
        padTokenId: number;
        queryTokenLimit: number;
        documentTokenLimit: number;
        lowercase: boolean;
        documentSkipTokenIds: readonly number[];
        candidateDepth: number;
        documentBatchSize: 1;
        interOpThreads: number;
    }>;
}>;

export type LateOnRuntimeProfileV5 = LateOnRuntimeProfileBase & Readonly<{
    schemaVersion: "satori_lateon_runtime_profile_v5";
    profileId: typeof LATEON_RUNTIME_PROFILE_IDS.contextV5D32;
    qualificationStatus: "owner_activated_not_held_out";
    identity: LateOnRuntimeProfileBase["identity"] & Readonly<{
        projectionVersion: "search_rerank_document_v4";
        projectionSha256: string;
        queryProjectionVersion: "search_rerank_query_v2";
        requestContractSha256: string;
    }>;
    execution: Readonly<{
        workerProcesses: 1;
        activeModelSessions: 1;
        executionMode: "sequential";
        graphOptimizationLevel: "all";
        queryBatchSize: 1;
        documentEncoding: "serial";
        tokenizerParallelism: false;
        aggregateRequestTokenLimit: number;
        padding: "none_single_sequence";
        truncationSide: "right";
        truncationStrategy: "longest_suffix_discarded";
        warmupRequests: number;
    }>;
}>;

export type LateOnRuntimeProfile = LateOnRuntimeProfileV5;

export type LateOnWorkerRequest =
    | Readonly<{
        type: "initialize";
        modelDirectory: string;
        profile: LateOnRuntimeProfile;
        intraOpThreads: number;
    }>
    | Readonly<{
        type: "rerank";
        requestId: number;
        query: string;
        documents: readonly string[];
        identities: readonly string[];
    }>;

export type LateOnWorkerResponse =
    | Readonly<{
        type: "ready";
        modelRevision: string;
        projectionVersion: LateOnRuntimeProfile["identity"]["projectionVersion"];
        candidateDepth: number;
    }>
    | Readonly<{
        type: "result";
        requestId: number;
        results: ReadonlyArray<{
            index: number;
            relevanceScore: number;
        }>;
    }>
    | Readonly<{
        type: "error";
        requestId?: number;
        message: string;
    }>;
