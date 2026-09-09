import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
    assertNetworkPolicyAllowsEndpoint,
    EMBEDDING_NORMALIZATION_POLICY_VERSION,
    envManager,
    EMBEDDING_PROJECTION_VERSION,
    LANGUAGE_PARSER_VERSION,
    LEXICAL_PROJECTION_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
    POTION_DIMENSION,
    POTION_MAX_TIMEOUT_MS,
    POTION_MODEL_ID,
    POTION_SEMANTIC_VERSION,
    resolveExecutionPolicy,
    resolveOllamaModelIdentity,
    type ExecutionProfile,
    type NetworkPolicy,
    type ResolvedOllamaModelIdentity,
} from "@zokizuan/satori-core";
import { resolveSatoriStateRoot } from "@zokizuan/satori-core/integration";
import {
    LATEON_ACTIVATION_POLICY_IDS,
    LATEON_RUNTIME_PROFILE_IDS,
    type LateOnActivationPolicyId,
    type LateOnRuntimeProfileId,
} from "./server/lateon-reranker-protocol.js";

export type EmbeddingProvider = 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'Potion';
export type VectorStoreProvider = 'Milvus' | 'LanceDB';
export type RerankerProvider = 'none' | 'voyage' | 'lateon';
export type ResolvedVectorStoreConfig =
    | { vectorStoreProvider: 'Milvus' }
    | { vectorStoreProvider: 'LanceDB'; lanceDbPath: string };
/**
 * Distinct freshness / sync timing knobs. Values may coincide numerically but
 * must not be treated as one concept (see docs/plans/INCREMENTAL_INDEX_FRESHNESS_PLAN.md).
 *
 * BACKGROUND_SYNC_INITIAL_DELAY_MS — first background tick after embedding runtime starts.
 * BACKGROUND_SYNC_INTERVAL_MS — delay between background ticks (self-scheduling).
 * SEARCH_FRESHNESS_THRESHOLD_MS — search-path read-only freshness assessment max age.
 * BACKGROUND_FRESHNESS_THRESHOLD_MS — background-path ensureFreshness max age.
 */
export const BACKGROUND_SYNC_INITIAL_DELAY_MS = 5_000;
export const BACKGROUND_SYNC_INTERVAL_MS = 3 * 60 * 1000;
export const SEARCH_FRESHNESS_THRESHOLD_MS = 3 * 60 * 1000;
export const BACKGROUND_FRESHNESS_THRESHOLD_MS = 3 * 60 * 1000;
export const DEFAULT_MANAGE_RETRY_AFTER_MS = 2000;

export function resolveVectorStoreConfig(input: {
    provider?: string;
    lanceDbPath?: string;
    homeDir: string;
}): ResolvedVectorStoreConfig {
    const provider = input.provider || 'LanceDB';
    if (provider !== 'Milvus' && provider !== 'LanceDB') {
        throw new Error(`Invalid VECTOR_STORE_PROVIDER '${provider}'. Expected Milvus or LanceDB.`);
    }
    if (provider === 'Milvus') return { vectorStoreProvider: 'Milvus' };

    const databasePath = input.lanceDbPath || path.join(input.homeDir, '.satori', 'vector', 'lancedb');
    if (!path.isAbsolute(databasePath)) {
        throw new Error('LANCEDB_PATH must be absolute when VECTOR_STORE_PROVIDER=LanceDB.');
    }
    return {
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: path.resolve(databasePath),
    };
}

/** Package version from packages/mcp/package.json (not the stale historical default 1.0.0). */
export function resolveMcpPackageVersion(): string {
    try {
        const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
        const raw = fs.readFileSync(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
            return parsed.version.trim();
        }
    } catch {
        // fall through
    }
    return "0.0.0";
}

export interface IndexFingerprint {
    embeddingProvider: EmbeddingProvider;
    embeddingModel: string;
    embeddingDimension: number;
    embeddingArtifactDigest?: string | null;
    embeddingNormalizationPolicy?: string;
    vectorStoreProvider: VectorStoreProvider;
    schemaVersion: 'dense_v3' | 'hybrid_v3';
    parserVersion?: string;
    extractorVersion?: string;
    relationshipVersion?: string;
    embeddingProjectionVersion?: string;
    lexicalProjectionVersion?: string;
}

export function summarizeIndexFingerprint(fingerprint: IndexFingerprint): string {
    const summarizeIdentity = (identity: string | undefined): string => identity
        ? crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 12)
        : 'legacy';
    return [
        fingerprint.embeddingProvider,
        fingerprint.embeddingModel,
        fingerprint.embeddingDimension,
        fingerprint.vectorStoreProvider,
        fingerprint.schemaVersion,
        `artifact=${summarizeIdentity(fingerprint.embeddingArtifactDigest ?? undefined)}`,
        `normalization=${fingerprint.embeddingNormalizationPolicy || 'legacy'}`,
        `parser=${summarizeIdentity(fingerprint.parserVersion)}`,
        `extractor=${summarizeIdentity(fingerprint.extractorVersion)}`,
        `relationship=${summarizeIdentity(fingerprint.relationshipVersion)}`,
        `embedding_projection=${summarizeIdentity(fingerprint.embeddingProjectionVersion)}`,
        `lexical_projection=${summarizeIdentity(fingerprint.lexicalProjectionVersion)}`,
    ].join('/');
}

export interface ContextMcpConfig {
    name: string;
    version: string;
    // Canonical absolute state root for the MCP runtime. Resolved from
    // SATORI_STATE_ROOT when configured; otherwise <homeDir>/.satori.
    stateRoot: string;
    executionProfile: ExecutionProfile;
    networkPolicy: NetworkPolicy;
    // Embedding provider configuration
    encoderProvider: EmbeddingProvider;
    encoderModel: string;
    encoderOutputDimension?: number;  // For VoyageAI: 256, 512, 1024, 2048
    embeddingArtifactDigest?: string;
    // Provider-specific API keys
    openaiKey?: string;
    openaiEndpoint?: string;
    voyageKey?: string;
    geminiKey?: string;
    geminiEndpoint?: string;
    // Ollama configuration
    ollamaEncoderModel?: string;
    ollamaModelDigest?: string;
    ollamaEndpoint?: string;
    // Installer-managed Potion configuration.
    potionHelperPath?: string;
    potionModelPath?: string;
    potionRequestTimeoutMs?: number;
    // Vector database configuration
    vectorStoreProvider: VectorStoreProvider;
    milvusEndpoint?: string; // Required for provider-backed tool calls
    milvusApiToken?: string;
    lanceDbPath?: string;
    // Reranker configuration
    rerankerProvider?: RerankerProvider;
    rankerModel?: 'rerank-2.5' | 'rerank-2.5-lite' | 'rerank-2' | 'rerank-2-lite';
    lateOnModelPath?: string;
    lateOnProfileId?: LateOnRuntimeProfileId;
    lateOnActivationPolicy?: LateOnActivationPolicyId;
    // read_file behavior
    readFileMaxLines?: number;
    readFileMaxBytes?: number;
    // Filesystem observation behavior
    watchSyncEnabled?: boolean;
    // Opt-in initial indexing of authorized session roots, offline runtimes only.
    autoIndexWorkspace?: boolean;
}

export function resolveRerankerProvider(config: ContextMcpConfig): RerankerProvider {
    if (config.rerankerProvider) return config.rerankerProvider;
    if (config.lateOnModelPath) return 'lateon';
    if (config.networkPolicy.kind === 'remote-allowed' && config.voyageKey) return 'voyage';
    return 'none';
}

export function assertExecutionPolicyAllowsRuntime(input: {
    executionProfile: ExecutionProfile;
    encoderProvider: EmbeddingProvider;
    vectorStoreProvider: VectorStoreProvider;
}): void {
    if (input.encoderProvider === 'Potion' && input.executionProfile !== 'offline') {
        throw new Error(
            'EMBEDDING_PROVIDER=Potion requires SATORI_RUNTIME_PROFILE=offline.',
        );
    }
    if (input.executionProfile !== 'offline') return;

    if (input.encoderProvider !== 'Ollama' && input.encoderProvider !== 'Potion') {
        throw new Error(
            'SATORI_RUNTIME_PROFILE=offline requires EMBEDDING_PROVIDER=Ollama or Potion.',
        );
    }
    if (input.vectorStoreProvider !== 'LanceDB') {
        throw new Error(
            'SATORI_RUNTIME_PROFILE=offline requires VECTOR_STORE_PROVIDER=LanceDB.',
        );
    }
}

// Helper function to get default model for each provider
export function getDefaultModelForProvider(provider: string): string {
    switch (provider) {
        case 'OpenAI':
            return 'text-embedding-3-small';
        case 'VoyageAI':
            return 'voyage-code-3';
        case 'Gemini':
            return 'gemini-embedding-001';
        case 'Ollama':
            return 'nomic-embed-text';
        case 'Potion':
            return POTION_MODEL_ID;
        default:
            return 'text-embedding-3-small';
    }
}

// Helper function to get embedding model with provider-specific environment variable priority
export function getEmbeddingModelForProvider(provider: string): string {
    switch (provider) {
        case 'Ollama': {
            // For Ollama, prioritize OLLAMA_MODEL over EMBEDDING_MODEL for backward compatibility
            const ollamaEncoderModel = envManager.get('OLLAMA_MODEL') || envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            return ollamaEncoderModel;
        }
        case 'Potion':
            return POTION_MODEL_ID;
        case 'OpenAI':
        case 'VoyageAI':
        case 'Gemini':
        default: {
            // For all other providers, use EMBEDDING_MODEL or default
            const selectedModel = envManager.get('EMBEDDING_MODEL') || getDefaultModelForProvider(provider);
            return selectedModel;
        }
    }
}

function getSchemaVersionFromEnv(): 'dense_v3' | 'hybrid_v3' {
    const hybridModeRaw = envManager.get('HYBRID_MODE');
    if (!hybridModeRaw) {
        return 'hybrid_v3';
    }
    return hybridModeRaw.toLowerCase() === 'true' ? 'hybrid_v3' : 'dense_v3';
}

export function resolveConfiguredEmbeddingDimension(config: ContextMcpConfig): number {
    switch (config.encoderProvider) {
        case 'OpenAI':
            return config.encoderModel === 'text-embedding-3-large' ? 3072 : 1536;
        case 'Gemini':
            return 3072;
        case 'Ollama':
            return config.encoderOutputDimension || 768;
        case 'Potion':
            return POTION_DIMENSION;
        case 'VoyageAI':
        default:
            return config.encoderOutputDimension || 1024;
    }
}

export function buildRuntimeIndexFingerprint(config: ContextMcpConfig, embeddingDimension: number): IndexFingerprint {
    return {
        embeddingProvider: config.encoderProvider,
        embeddingModel: config.encoderModel,
        embeddingDimension,
        embeddingArtifactDigest: config.embeddingArtifactDigest ?? null,
        embeddingNormalizationPolicy: EMBEDDING_NORMALIZATION_POLICY_VERSION,
        vectorStoreProvider: config.vectorStoreProvider,
        schemaVersion: getSchemaVersionFromEnv(),
        parserVersion: LANGUAGE_PARSER_VERSION,
        extractorVersion: SYMBOL_EXTRACTOR_VERSION,
        relationshipVersion: RELATIONSHIP_BUILDER_VERSION,
        embeddingProjectionVersion: EMBEDDING_PROJECTION_VERSION,
        lexicalProjectionVersion: LEXICAL_PROJECTION_VERSION,
    };
}

export interface ResolvedMcpRuntimeBootstrap {
    config: Readonly<ContextMcpConfig>;
    runtimeFingerprint: IndexFingerprint;
}

function parseRecordedOllamaDigest(value: string): string {
    const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(value.trim());
    if (!match?.[1]) {
        throw new Error('OLLAMA_MODEL_DIGEST must be a SHA-256 digest.');
    }
    return match[1].toLowerCase();
}

export async function resolveMcpRuntimeBootstrap(
    config: ContextMcpConfig,
    dependencies: {
        resolveOllamaIdentity?: (input: {
            model: string;
            host?: string;
        }) => Promise<Readonly<ResolvedOllamaModelIdentity>>;
    } = {},
    options: { useRecordedOllamaIdentity?: boolean } = {},
): Promise<ResolvedMcpRuntimeBootstrap> {
    assertExecutionPolicyAllowsRuntime({
        executionProfile: config.executionProfile,
        encoderProvider: config.encoderProvider,
        vectorStoreProvider: config.vectorStoreProvider,
    });
    if (config.encoderProvider === 'Potion') {
        if (config.encoderModel !== POTION_MODEL_ID) {
            throw new Error(`Potion requires the pinned model identity '${POTION_MODEL_ID}'.`);
        }
        if (
            config.encoderOutputDimension !== undefined
            && config.encoderOutputDimension !== POTION_DIMENSION
        ) {
            throw new Error(`Potion requires EMBEDDING_OUTPUT_DIMENSION=${POTION_DIMENSION}.`);
        }
        const resolvedConfig = Object.freeze({
            ...config,
            encoderModel: `${POTION_MODEL_ID}+${POTION_SEMANTIC_VERSION}`,
            encoderOutputDimension: POTION_DIMENSION,
            embeddingArtifactDigest: undefined,
        });
        return Object.freeze({
            config: resolvedConfig,
            runtimeFingerprint: buildRuntimeIndexFingerprint(
                resolvedConfig,
                POTION_DIMENSION,
            ),
        });
    }
    if (config.encoderProvider !== 'Ollama') {
        const resolvedConfig = Object.freeze({ ...config });
        return Object.freeze({
            config: resolvedConfig,
            runtimeFingerprint: buildRuntimeIndexFingerprint(
                resolvedConfig,
                resolveConfiguredEmbeddingDimension(resolvedConfig),
            ),
        });
    }

    const host = config.ollamaEndpoint || 'http://127.0.0.1:11434';
    assertNetworkPolicyAllowsEndpoint(config.networkPolicy, host, 'OLLAMA_HOST');
    if (config.executionProfile === 'offline' && !config.ollamaModelDigest) {
        throw new Error(
            'SATORI_RUNTIME_PROFILE=offline requires installer-recorded OLLAMA_MODEL_DIGEST.',
        );
    }

    if (options.useRecordedOllamaIdentity) {
        const artifactDigest = config.ollamaModelDigest
            ? parseRecordedOllamaDigest(config.ollamaModelDigest)
            : null;
        const dimension = config.encoderOutputDimension;
        if (
            !artifactDigest
            || typeof dimension !== 'number'
            || !Number.isSafeInteger(dimension)
            || dimension <= 0
        ) {
            throw new Error(
                'Recorded Ollama bootstrap requires OLLAMA_MODEL_DIGEST and EMBEDDING_OUTPUT_DIMENSION.',
            );
        }
        const resolvedConfig = Object.freeze({
            ...config,
            embeddingArtifactDigest: artifactDigest,
            encoderOutputDimension: dimension,
            ollamaEndpoint: host,
        });
        return Object.freeze({
            config: resolvedConfig,
            runtimeFingerprint: buildRuntimeIndexFingerprint(resolvedConfig, dimension),
        });
    }

    const resolveIdentity = dependencies.resolveOllamaIdentity ?? resolveOllamaModelIdentity;
    const identity = await resolveIdentity({
        model: config.ollamaEncoderModel || config.encoderModel,
        host,
    });
    const recordedDigest = config.ollamaModelDigest
        ? parseRecordedOllamaDigest(config.ollamaModelDigest)
        : undefined;
    if (recordedDigest && recordedDigest !== identity.artifactDigest) {
        throw new Error(
            `Configured Ollama model digest does not match the installed artifact for '${identity.resolvedModel}'.`,
        );
    }

    const resolvedConfig = Object.freeze({
        ...config,
        encoderModel: identity.resolvedModel,
        encoderOutputDimension: identity.dimension,
        embeddingArtifactDigest: identity.artifactDigest,
        ollamaEndpoint: host,
    });
    return Object.freeze({
        config: resolvedConfig,
        runtimeFingerprint: buildRuntimeIndexFingerprint(
            resolvedConfig,
            identity.dimension,
        ),
    });
}

export function createMcpConfig(): ContextMcpConfig {
    if (envManager.get('SATORI_RERANK_APPLICATION_MODE') !== undefined) {
        throw new Error(
            'SATORI_RERANK_APPLICATION_MODE has been removed; unset it or roll back to the previous Satori release for legacy_rrf behavior.',
        );
    }
    const executionPolicy = resolveExecutionPolicy(envManager.get('SATORI_RUNTIME_PROFILE'));
    const defaultProvider = (envManager.get('EMBEDDING_PROVIDER') as EmbeddingProvider) || 'VoyageAI';
    const defaultReadFileMaxLines = 1000;
    const defaultReadFileMaxBytes = 8 * 1024 * 1024;
    const readFileMaxBytesMin = 65_536;
    const readFileMaxBytesMax = 67_108_864;
    const vectorStore = resolveVectorStoreConfig({
        provider: envManager.get('VECTOR_STORE_PROVIDER')
            || (envManager.get('MILVUS_ADDRESS') ? 'Milvus' : 'LanceDB'),
        lanceDbPath: envManager.get('LANCEDB_PATH'),
        homeDir: os.homedir(),
    });
    assertExecutionPolicyAllowsRuntime({
        executionProfile: executionPolicy.executionProfile,
        encoderProvider: defaultProvider,
        vectorStoreProvider: vectorStore.vectorStoreProvider,
    });

    // Parse output dimension from env var
    const outputDimensionStr = envManager.get('EMBEDDING_OUTPUT_DIMENSION');
    let encoderOutputDimension: number | undefined;
    if (outputDimensionStr) {
        const parsed = Number(outputDimensionStr);
        if (
            (defaultProvider === 'VoyageAI' && [256, 512, 1024, 2048].includes(parsed))
            || (defaultProvider === 'Ollama' && Number.isSafeInteger(parsed) && parsed > 0)
            || (defaultProvider === 'Potion' && parsed === POTION_DIMENSION)
        ) {
            encoderOutputDimension = parsed;
        } else {
            const expected = defaultProvider === 'VoyageAI'
                ? '256, 512, 1024, or 2048'
                : defaultProvider === 'Ollama'
                    ? 'a positive safe integer resolved from the installed model'
                    : defaultProvider === 'Potion'
                        ? String(POTION_DIMENSION)
                    : `unset because ${defaultProvider} ignores this setting`;
            console.warn(`[WARN] Invalid EMBEDDING_OUTPUT_DIMENSION value for ${defaultProvider}: ${outputDimensionStr}. Expected ${expected}.`);
        }
    } else if (defaultProvider === 'VoyageAI') {
        // Default to 1024 for VoyageAI to balance quality/cost.
        encoderOutputDimension = 1024;
    } else if (defaultProvider === 'Potion') {
        encoderOutputDimension = POTION_DIMENSION;
    }

    const configuredModel = envManager.get('EMBEDDING_MODEL');
    if (
        defaultProvider === 'Potion'
        && configuredModel
        && configuredModel !== POTION_MODEL_ID
    ) {
        throw new Error(`Potion requires EMBEDDING_MODEL=${POTION_MODEL_ID} when EMBEDDING_MODEL is set.`);
    }

    const potionRequestTimeoutRaw = envManager.get('POTION_REQUEST_TIMEOUT_MS');
    let potionRequestTimeoutMs: number | undefined;
    if (defaultProvider === 'Potion') {
        potionRequestTimeoutMs = 5_000;
        if (potionRequestTimeoutRaw) {
            const parsed = Number(potionRequestTimeoutRaw);
            if (
                !Number.isSafeInteger(parsed)
                || parsed <= 0
                || parsed > POTION_MAX_TIMEOUT_MS
            ) {
                throw new Error(
                    `POTION_REQUEST_TIMEOUT_MS must be between 1 and ${POTION_MAX_TIMEOUT_MS}.`,
                );
            }
            potionRequestTimeoutMs = parsed;
        }
    }

    const configuredRerankerProvider = envManager.get('SATORI_RERANKER_PROVIDER');
    if (
        configuredRerankerProvider
        && !['none', 'voyage', 'lateon'].includes(configuredRerankerProvider)
    ) {
        throw new Error(
            `Invalid SATORI_RERANKER_PROVIDER '${configuredRerankerProvider}'. `
            + 'Expected none, voyage, or lateon.',
        );
    }
    const lateOnModelPathRaw = envManager.get('SATORI_LATEON_MODEL_PATH');
    if (lateOnModelPathRaw && !path.isAbsolute(lateOnModelPathRaw)) {
        throw new Error('SATORI_LATEON_MODEL_PATH must be absolute.');
    }
    const lateOnModelPath = lateOnModelPathRaw
        ? path.resolve(lateOnModelPathRaw)
        : undefined;
    const rerankerProvider: RerankerProvider = configuredRerankerProvider
        ? configuredRerankerProvider as RerankerProvider
        : lateOnModelPath
            ? 'lateon'
            : executionPolicy.networkPolicy.kind === 'remote-allowed'
                && Boolean(envManager.get('VOYAGEAI_API_KEY'))
                ? 'voyage'
                : 'none';
    if (rerankerProvider === 'lateon' && !lateOnModelPath) {
        throw new Error(
            'SATORI_RERANKER_PROVIDER=lateon requires SATORI_LATEON_MODEL_PATH.',
        );
    }
    if (
        rerankerProvider === 'voyage'
        && executionPolicy.networkPolicy.kind !== 'remote-allowed'
    ) {
        throw new Error(
            'SATORI_RERANKER_PROVIDER=voyage is unavailable under the local-only network policy.',
        );
    }

    const lateOnProfileRaw = rerankerProvider === 'lateon'
        ? envManager.get('SATORI_LATEON_PROFILE')
        : undefined;
    const knownLateOnProfiles = Object.values(LATEON_RUNTIME_PROFILE_IDS);
    if (lateOnProfileRaw && !knownLateOnProfiles.includes(lateOnProfileRaw as LateOnRuntimeProfileId)) {
        throw new Error(
            `Invalid SATORI_LATEON_PROFILE '${lateOnProfileRaw}'. Expected one of: ${knownLateOnProfiles.join(', ')}.`,
        );
    }
    if (
        lateOnProfileRaw
        && lateOnProfileRaw !== LATEON_RUNTIME_PROFILE_IDS.contextV5D32
    ) {
        throw new Error(
            `Unsupported SATORI_LATEON_PROFILE '${lateOnProfileRaw}'. `
            + 'This historical LateOn runtime profile is retired and cannot execute. '
            + `Run \`satori upgrade\` to migrate to SATORI_LATEON_PROFILE=${LATEON_RUNTIME_PROFILE_IDS.contextV5D32} `
            + `with SATORI_LATEON_ACTIVATION_POLICY=${LATEON_ACTIVATION_POLICY_IDS.ownerDefaultContextV5}.`,
        );
    }
    const lateOnProfileId = rerankerProvider === 'lateon'
        ? (lateOnProfileRaw as LateOnRuntimeProfileId | undefined)
            ?? LATEON_RUNTIME_PROFILE_IDS.contextV5D32
        : undefined;
    const lateOnActivationPolicyRaw = envManager.get('SATORI_LATEON_ACTIVATION_POLICY');
    const knownLateOnActivationPolicies = Object.values(LATEON_ACTIVATION_POLICY_IDS);
    if (
        lateOnActivationPolicyRaw
        && !knownLateOnActivationPolicies.includes(
            lateOnActivationPolicyRaw as LateOnActivationPolicyId,
        )
    ) {
        throw new Error(
            `Invalid SATORI_LATEON_ACTIVATION_POLICY '${lateOnActivationPolicyRaw}'. `
            + `Expected one of: ${knownLateOnActivationPolicies.join(', ')}.`,
        );
    }
    if (lateOnActivationPolicyRaw && rerankerProvider !== 'lateon') {
        throw new Error(
            `SATORI_LATEON_ACTIVATION_POLICY requires SATORI_RERANKER_PROVIDER=lateon; `
            + `received ${rerankerProvider}.`,
        );
    }
    if (
        lateOnActivationPolicyRaw === LATEON_ACTIVATION_POLICY_IDS.ownerDefaultD32V2
        || lateOnActivationPolicyRaw === LATEON_ACTIVATION_POLICY_IDS.ownerDefaultContextV3
        || lateOnActivationPolicyRaw === LATEON_ACTIVATION_POLICY_IDS.ownerDefaultContextV4
    ) {
        throw new Error(
            `Unsupported SATORI_LATEON_ACTIVATION_POLICY '${lateOnActivationPolicyRaw}'. `
            + 'This historical LateOn activation policy is retired. '
            + `Run \`satori upgrade\` to migrate to SATORI_LATEON_ACTIVATION_POLICY=${LATEON_ACTIVATION_POLICY_IDS.ownerDefaultContextV5} `
            + `with SATORI_LATEON_PROFILE=${LATEON_RUNTIME_PROFILE_IDS.contextV5D32}.`,
        );
    }
    const lateOnActivationPolicy = (
        rerankerProvider === 'lateon' && lateOnProfileRaw === undefined
            ? lateOnActivationPolicyRaw ?? LATEON_ACTIVATION_POLICY_IDS.ownerDefaultContextV5
            : lateOnActivationPolicyRaw
    ) as LateOnActivationPolicyId | undefined;

    // Parse Voyage reranker model from env var.
    const rankerModelEnv = envManager.get('VOYAGEAI_RERANKER_MODEL');
    let rankerModel: 'rerank-2.5' | 'rerank-2.5-lite' | 'rerank-2' | 'rerank-2-lite' | undefined;
    if (rankerModelEnv && ['rerank-2.5', 'rerank-2.5-lite', 'rerank-2', 'rerank-2-lite'].includes(rankerModelEnv)) {
        rankerModel = rankerModelEnv as typeof rankerModel;
    } else {
        rankerModel = 'rerank-2.5';
    }

    let readFileMaxLines = defaultReadFileMaxLines;
    const readFileMaxLinesRaw = envManager.get('READ_FILE_MAX_LINES');
    if (readFileMaxLinesRaw) {
        const parsed = Number.parseInt(readFileMaxLinesRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            readFileMaxLines = parsed;
        } else {
            console.warn(`[WARN] Invalid READ_FILE_MAX_LINES value: ${readFileMaxLinesRaw}. Using default ${defaultReadFileMaxLines}.`);
        }
    }

    let readFileMaxBytes = defaultReadFileMaxBytes;
    const readFileMaxBytesRaw = envManager.get('READ_FILE_MAX_BYTES');
    if (readFileMaxBytesRaw) {
        const parsedBytes = Number.parseInt(readFileMaxBytesRaw, 10);
        if (Number.isFinite(parsedBytes) && parsedBytes >= readFileMaxBytesMin && parsedBytes <= readFileMaxBytesMax) {
            readFileMaxBytes = parsedBytes;
        } else {
            console.warn(`[WARN] Invalid READ_FILE_MAX_BYTES value: ${readFileMaxBytesRaw}. Using default ${defaultReadFileMaxBytes}.`);
        }
    }

    const watchSyncEnabledRaw = envManager.get('MCP_ENABLE_WATCHER');
    const watchSyncEnabled = watchSyncEnabledRaw
        ? watchSyncEnabledRaw.toLowerCase() === 'true'
        : true;

    const config: ContextMcpConfig = {
        name: envManager.get('MCP_SERVER_NAME') || "Satori MCP Server",
        version: envManager.get('MCP_SERVER_VERSION') || resolveMcpPackageVersion(),
        stateRoot: resolveSatoriStateRoot({
            configured: envManager.get('SATORI_STATE_ROOT'),
            homeDir: os.homedir(),
        }),
        executionProfile: executionPolicy.executionProfile,
        networkPolicy: executionPolicy.networkPolicy,
        // Embedding provider configuration
        encoderProvider: defaultProvider,
        encoderModel: getEmbeddingModelForProvider(defaultProvider),
        encoderOutputDimension,
        // Provider-specific API keys
        openaiKey: envManager.get('OPENAI_API_KEY'),
        openaiEndpoint: envManager.get('OPENAI_BASE_URL'),
        voyageKey: envManager.get('VOYAGEAI_API_KEY'),
        geminiKey: envManager.get('GEMINI_API_KEY'),
        geminiEndpoint: envManager.get('GEMINI_BASE_URL'),
        // Ollama configuration
        ollamaEncoderModel: envManager.get('OLLAMA_MODEL'),
        ollamaModelDigest: envManager.get('OLLAMA_MODEL_DIGEST'),
        ollamaEndpoint: envManager.get('OLLAMA_HOST'),
        // The installer pins these paths to its integrity- and capability-verified runtime bundle.
        potionHelperPath: envManager.get('POTION_HELPER_PATH'),
        potionModelPath: envManager.get('POTION_MODEL_PATH'),
        potionRequestTimeoutMs,
        // Vector database configuration
        vectorStoreProvider: vectorStore.vectorStoreProvider,
        milvusEndpoint: envManager.get('MILVUS_ADDRESS'),
        milvusApiToken: envManager.get('MILVUS_TOKEN'),
        ...(vectorStore.vectorStoreProvider === 'LanceDB'
            ? { lanceDbPath: vectorStore.lanceDbPath }
            : {}),
        // Reranker configuration
        rerankerProvider,
        rankerModel,
        ...(lateOnModelPath ? { lateOnModelPath } : {}),
        ...(lateOnProfileId ? { lateOnProfileId } : {}),
        ...(lateOnActivationPolicy ? { lateOnActivationPolicy } : {}),
        // read_file behavior
        readFileMaxLines,
        readFileMaxBytes,
        // filesystem observation behavior
        watchSyncEnabled,
        autoIndexWorkspace: envManager.get('SATORI_AUTO_INDEX_WORKSPACE')?.toLowerCase() === 'true',
    };

    return config;
}

export function logConfigurationSummary(config: ContextMcpConfig): void {
    // Log configuration summary before starting server
    console.log(`[MCP] 🚀 Starting Satori MCP Server`);
    console.log(`[MCP] Configuration Summary:`);
    console.log(`[MCP]   Server: ${config.name} v${config.version}`);
    console.log(`[MCP]   Runtime Profile: ${config.executionProfile} (${config.networkPolicy.kind})`);
    console.log(`[MCP]   Embedding Provider: ${config.encoderProvider}`);
    console.log(`[MCP]   Reranker Provider: ${resolveRerankerProvider(config)}`);
    console.log(`[MCP]   Embedding Model: ${config.encoderModel}`);
    console.log(`[MCP]   Vector Store: ${config.vectorStoreProvider}`);
    if (config.vectorStoreProvider === 'LanceDB') {
        console.log(`[MCP]   LanceDB Path: ${config.lanceDbPath}`);
    } else {
        console.log(`[MCP]   Milvus Address: ${config.milvusEndpoint || '[Not configured]'}`);
    }
    console.log(`[MCP]   Filesystem Watcher: ${config.watchSyncEnabled ? 'enabled (observation only)' : 'disabled'}`);

    // Log provider-specific configuration without exposing sensitive data
    switch (config.encoderProvider) {
        case 'OpenAI':
            console.log(`[MCP]   OpenAI API Key: ${config.openaiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.openaiEndpoint) {
                console.log(`[MCP]   OpenAI Base URL: ${config.openaiEndpoint}`);
            }
            break;
        case 'VoyageAI':
            console.log(`[MCP]   VoyageAI API Key: ${config.voyageKey ? '✅ Configured' : '❌ Missing'}`);
            break;
        case 'Gemini':
            console.log(`[MCP]   Gemini API Key: ${config.geminiKey ? '✅ Configured' : '❌ Missing'}`);
            if (config.geminiEndpoint) {
                console.log(`[MCP]   Gemini Base URL: ${config.geminiEndpoint}`);
            }
            break;
        case 'Ollama':
            console.log(`[MCP]   Ollama Host: ${config.ollamaEndpoint || 'http://127.0.0.1:11434'}`);
            console.log(`[MCP]   Ollama Model: ${config.encoderModel}`);
            break;
        case 'Potion':
            console.log(`[MCP]   Potion Helper: ${config.potionHelperPath ? '✅ Configured' : '❌ Missing'}`);
            console.log(`[MCP]   Potion Model Artifacts: ${config.potionModelPath ? '✅ Configured' : '❌ Missing'}`);
            break;
    }

    console.log(`[MCP] 🔧 Initializing server components...`);
}

export function showHelpMessage(): void {
    console.log(`
Satori MCP Server

Usage:
  satori [options]
  node /path/to/@zokizuan/satori-mcp/dist/index.js [options]

Options:
  --help, -h                          Show this help message

Environment Variables:
  MCP_SERVER_NAME         Server name
  MCP_SERVER_VERSION      Server version

  Embedding Provider Configuration:
  EMBEDDING_PROVIDER      Embedding provider: OpenAI, VoyageAI, Gemini, Ollama (default: VoyageAI)
  EMBEDDING_MODEL         Embedding model name (works for all providers)

  Provider-specific API Keys:
  OPENAI_API_KEY          OpenAI API key (required for OpenAI provider)
  OPENAI_BASE_URL         OpenAI API base URL (optional, for custom endpoints)
  VOYAGEAI_API_KEY        VoyageAI API key (required for VoyageAI provider)
  GEMINI_API_KEY          Google AI API key (required for Gemini provider)
  GEMINI_BASE_URL         Gemini API base URL (optional, for custom endpoints)

  Ollama Configuration:
  OLLAMA_HOST             Ollama server host (default: http://127.0.0.1:11434)
  OLLAMA_MODEL            Ollama model name (alternative to EMBEDDING_MODEL for Ollama)

  Vector Database Configuration:
  VECTOR_STORE_PROVIDER   Vector store: LanceDB or Milvus (default: LanceDB; legacy MILVUS_ADDRESS selects Milvus)
  MILVUS_ADDRESS          Milvus address (required for index/search/clear tool calls)
  MILVUS_TOKEN            Milvus token (optional, used for authenticated endpoints)
  LANCEDB_PATH            Absolute LanceDB directory (default: ~/.satori/vector/lancedb)

  Read File Configuration:
  READ_FILE_MAX_LINES     Max lines returned by read_file when no explicit range is provided (default: 1000)
  READ_FILE_MAX_BYTES     Max whole-file bytes read_file may read before range selection (default: 8388608, min 65536, max 67108864)

  Filesystem Observation:
  MCP_ENABLE_WATCHER      Observe source changes for freshness-aware reads (default: true)

Examples:
  # Install resident MCP config without package-manager startup on every client launch
  npx -y @zokizuan/satori-cli@latest install --client all

  # Start MCP server with OpenAI and explicit Milvus address
  OPENAI_API_KEY=sk-xxx MILVUS_ADDRESS=localhost:19530 satori

  # Start MCP server with VoyageAI and specific model
  EMBEDDING_PROVIDER=VoyageAI VOYAGEAI_API_KEY=pa-xxx EMBEDDING_MODEL=voyage-code-3 MILVUS_ADDRESS=https://your-zilliz-endpoint MILVUS_TOKEN=your-token satori

  # Start MCP server with Gemini and specific model
  EMBEDDING_PROVIDER=Gemini GEMINI_API_KEY=xxx EMBEDDING_MODEL=gemini-embedding-001 MILVUS_ADDRESS=https://your-zilliz-endpoint MILVUS_TOKEN=your-token satori

  # Start MCP server with Ollama and specific model
  EMBEDDING_PROVIDER=Ollama EMBEDDING_MODEL=nomic-embed-text MILVUS_ADDRESS=localhost:19530 satori
        `);
}
