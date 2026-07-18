import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
    assertNetworkPolicyAllowsEndpoint,
    EMBEDDING_NORMALIZATION_POLICY_VERSION,
    indexFingerprintsEqual as coreIndexFingerprintsEqual,
    envManager,
    EMBEDDING_PROJECTION_VERSION,
    LANGUAGE_PARSER_VERSION,
    LEXICAL_PROJECTION_VERSION,
    RELATIONSHIP_BUILDER_VERSION,
    SYMBOL_EXTRACTOR_VERSION,
    parseIndexFingerprint as parseCoreIndexFingerprint,
    POTION_DIMENSION,
    POTION_INFERENCE_CONTRACT_DIGEST,
    POTION_MAX_TIMEOUT_MS,
    POTION_MODEL_ID,
    resolveExecutionPolicy,
    resolveOllamaModelIdentity,
    type ExecutionProfile,
    type IndexFingerprint as CoreIndexFingerprint,
    type NetworkPolicy,
    type ResolvedOllamaModelIdentity,
} from "@zokizuan/satori-core";

export type EmbeddingProvider = 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'Potion';
export type VectorStoreProvider = 'Milvus' | 'LanceDB';
export type ResolvedVectorStoreConfig =
    | { vectorStoreProvider: 'Milvus' }
    | { vectorStoreProvider: 'LanceDB'; lanceDbPath: string };
export type FingerprintSource = 'verified' | 'assumed_v2';
/**
 * Distinct freshness / sync timing knobs. Values may coincide numerically but
 * must not be treated as one concept (see docs/plans/INCREMENTAL_INDEX_FRESHNESS_PLAN.md).
 *
 * WATCHER_DEBOUNCE_MS — quiet period after FS events before forced ensureFreshness(0).
 * BACKGROUND_SYNC_INITIAL_DELAY_MS — first background tick after embedding runtime starts.
 * BACKGROUND_SYNC_INTERVAL_MS — delay between background ticks (self-scheduling).
 * SEARCH_FRESHNESS_THRESHOLD_MS — search-path ensureFreshness max age for skipped_recent.
 * BACKGROUND_FRESHNESS_THRESHOLD_MS — background-path ensureFreshness max age.
 * MANUAL_SYNC_FRESHNESS_THRESHOLD_MS — manage_index sync force-check (0 = always compare).
 */
export const WATCHER_DEBOUNCE_MS = 5_000;
/** @deprecated Prefer WATCHER_DEBOUNCE_MS; kept for existing imports. */
export const DEFAULT_WATCH_DEBOUNCE_MS = WATCHER_DEBOUNCE_MS;
export const BACKGROUND_SYNC_INITIAL_DELAY_MS = 5_000;
export const BACKGROUND_SYNC_INTERVAL_MS = 3 * 60 * 1000;
export const SEARCH_FRESHNESS_THRESHOLD_MS = 3 * 60 * 1000;
export const BACKGROUND_FRESHNESS_THRESHOLD_MS = 3 * 60 * 1000;
export const MANUAL_SYNC_FRESHNESS_THRESHOLD_MS = 0;
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

export type IndexFingerprint = Omit<
    CoreIndexFingerprint,
    'embeddingProvider' | 'vectorStoreProvider' | 'schemaVersion'
> & {
    embeddingProvider: EmbeddingProvider;
    vectorStoreProvider: VectorStoreProvider;
    schemaVersion: 'dense_v3' | 'hybrid_v3';
};

export function parseIndexFingerprint(value: unknown): IndexFingerprint | null {
    const record = parseCoreIndexFingerprint(value);
    if (
        !record
        || !['OpenAI', 'VoyageAI', 'Gemini', 'Ollama', 'Potion'].includes(record.embeddingProvider)
        || !['Milvus', 'LanceDB'].includes(record.vectorStoreProvider)
        || (record.schemaVersion !== 'dense_v3' && record.schemaVersion !== 'hybrid_v3')
    ) {
        return null;
    }
    return {
        embeddingProvider: record.embeddingProvider as EmbeddingProvider,
        embeddingModel: record.embeddingModel,
        embeddingDimension: record.embeddingDimension,
        ...(record.embeddingArtifactDigest !== undefined
            ? { embeddingArtifactDigest: record.embeddingArtifactDigest }
            : {}),
        ...(record.embeddingNormalizationPolicy !== undefined
            ? { embeddingNormalizationPolicy: record.embeddingNormalizationPolicy }
            : {}),
        vectorStoreProvider: record.vectorStoreProvider as VectorStoreProvider,
        schemaVersion: record.schemaVersion,
        ...(record.parserVersion !== undefined ? { parserVersion: record.parserVersion } : {}),
        ...(record.extractorVersion !== undefined ? { extractorVersion: record.extractorVersion } : {}),
        ...(record.relationshipVersion !== undefined ? { relationshipVersion: record.relationshipVersion } : {}),
        ...(record.embeddingProjectionVersion !== undefined
            ? { embeddingProjectionVersion: record.embeddingProjectionVersion }
            : {}),
        ...(record.lexicalProjectionVersion !== undefined
            ? { lexicalProjectionVersion: record.lexicalProjectionVersion }
            : {}),
    };
}

export function indexFingerprintsEqual(left: IndexFingerprint, right: IndexFingerprint): boolean {
    return coreIndexFingerprintsEqual(left, right);
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

export type IndexOperationAction = 'create' | 'reindex' | 'sync' | 'repair' | 'clear';
export type IndexOperationPhase = 'accepted' | 'preflight' | 'scanning' | 'writing' | 'proving' | 'publishing' | 'completed' | 'failed' | 'blocked';

export interface IndexOperationReceipt {
    id: string;
    action: IndexOperationAction;
    canonicalRoot: string;
    generation: number;
    acceptedAt: string;
    phase: IndexOperationPhase;
    lastDurableTransitionAt: string;
    runtimeFingerprint: IndexFingerprint;
    writer: {
        ownerId: string;
        pid: number;
        satoriVersion: string;
    };
}

export interface ContextMcpConfig {
    name: string;
    version: string;
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
    // Experimental Potion configuration. Artifact installation remains out of scope.
    potionHelperPath?: string;
    potionModelPath?: string;
    potionRequestTimeoutMs?: number;
    // Vector database configuration
    vectorStoreProvider: VectorStoreProvider;
    milvusEndpoint?: string; // Required for provider-backed tool calls
    milvusApiToken?: string;
    lanceDbPath?: string;
    // Reranker configuration
    rankerModel?: 'rerank-2.5' | 'rerank-2.5-lite' | 'rerank-2' | 'rerank-2-lite';
    // read_file behavior
    readFileMaxLines?: number;
    // Proactive sync watcher behavior
    watchSyncEnabled?: boolean;
    watchDebounceMs?: number;
}

export function assertExecutionPolicyAllowsRuntime(input: {
    executionProfile: ExecutionProfile;
    encoderProvider: EmbeddingProvider;
    vectorStoreProvider: VectorStoreProvider;
}): void {
    if (input.encoderProvider === 'Potion' && input.executionProfile !== 'offline') {
        throw new Error(
            'EMBEDDING_PROVIDER=Potion is experimental and requires SATORI_RUNTIME_PROFILE=offline.',
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

export interface CallGraphSidecarInfo {
    version: 'v3';
    sidecarPath: string;
    builtAt: string;
    nodeCount: number;
    edgeCount: number;
    noteCount: number;
    fingerprint: IndexFingerprint;
}

export interface CodebaseIndexManifest {
    indexedPaths: string[];
    updatedAt: string;
}

export interface CodebaseClearTombstone {
    clearedAt: string;
    collectionName?: string;
}

// Legacy format (v1) - for backward compatibility
export interface CodebaseSnapshotV1 {
    indexedCodebases: string[];
    indexingCodebases: string[] | Record<string, number>;  // Array (legacy) or Map of codebase path to progress percentage
    lastUpdated: string;
}

interface CodebaseInfoBase {
    lastUpdated: string;
    collectionName?: string;
    indexFingerprint?: IndexFingerprint;
    fingerprintSource?: FingerprintSource;
    reindexReason?: 'legacy_unverified_fingerprint' | 'fingerprint_mismatch' | 'missing_fingerprint' | 'navigation_recovery_failed';
    callGraphSidecar?: CallGraphSidecarInfo;
    indexManifest?: CodebaseIndexManifest;
    ignoreRulesVersion?: number;
    ignoreControlSignature?: string;
}

// Indexing state - when indexing is in progress
export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;  // Current progress percentage
}

// Indexed state - when indexing completed successfully
export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;        // Number of files indexed
    totalChunks: number;         // Total number of chunks generated
    indexStatus: 'completed' | 'limit_reached';  // Status from indexing result
}

// Index failed state - when indexing failed
export interface CodebaseInfoIndexFailed extends CodebaseInfoBase {
    status: 'indexfailed';
    errorMessage: string;        // Error message from the failure
    lastAttemptedPercentage?: number;  // Progress when failure occurred
}

// Sync completed state - when incremental sync completed
export interface CodebaseInfoSyncCompleted extends CodebaseInfoBase {
    status: 'sync_completed';
    added: number;               // Number of new files added
    removed: number;             // Number of files removed
    modified: number;            // Number of files modified
    totalChanges: number;        // Total number of changes
    indexedFiles?: number;       // Completion-proof file count for rollback authority
    totalChunks?: number;        // Completion-proof payload count for rollback authority
    indexStatus?: 'completed' | 'limit_reached';
}

// Reindex required state - fingerprint mismatch or legacy assumptions
export interface CodebaseInfoRequiresReindex extends CodebaseInfoBase {
    status: 'requires_reindex';
    message: string;
}

// Union type for all codebase information states
export type CodebaseInfo =
    | CodebaseInfoIndexing
    | CodebaseInfoIndexed
    | CodebaseInfoIndexFailed
    | CodebaseInfoSyncCompleted
    | CodebaseInfoRequiresReindex;

// New format (v2) - structured with codebase information (legacy compatibility)
export interface CodebaseSnapshotV2 {
    formatVersion: 'v2';
    codebases: Record<string, Omit<CodebaseInfo, 'status'> & { status: 'indexing' | 'indexed' | 'indexfailed' | 'sync_completed' }>;
    lastUpdated: string;
}

// Snapshot v3
export interface CodebaseSnapshotV3 {
    formatVersion: 'v3';
    codebases: Record<string, CodebaseInfo>;  // codebasePath -> CodebaseInfo
    clearTombstones?: Record<string, CodebaseClearTombstone>;
    latestOperations?: Record<string, IndexOperationReceipt>;
    lastUpdated: string;
}

// Union type for all supported formats
export type CodebaseSnapshot = CodebaseSnapshotV1 | CodebaseSnapshotV2 | CodebaseSnapshotV3;

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
        if (
            config.embeddingArtifactDigest !== undefined
            && config.embeddingArtifactDigest !== POTION_INFERENCE_CONTRACT_DIGEST
        ) {
            throw new Error('Potion inference-contract digest does not match the pinned L1 authority.');
        }
        const resolvedConfig = Object.freeze({
            ...config,
            encoderModel: POTION_MODEL_ID,
            encoderOutputDimension: POTION_DIMENSION,
            // Reuse the existing persisted artifact-digest authority field for
            // Potion's complete inference contract rather than adding a second
            // fingerprint shape that would invalidate existing providers.
            embeddingArtifactDigest: POTION_INFERENCE_CONTRACT_DIGEST,
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
    const executionPolicy = resolveExecutionPolicy(envManager.get('SATORI_RUNTIME_PROFILE'));
    const defaultProvider = (envManager.get('EMBEDDING_PROVIDER') as EmbeddingProvider) || 'VoyageAI';
    const defaultReadFileMaxLines = 1000;
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

    // Parse reranker model from env var
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

    const watchSyncEnabledRaw = envManager.get('MCP_ENABLE_WATCHER');
    const watchSyncEnabled = watchSyncEnabledRaw
        ? watchSyncEnabledRaw.toLowerCase() === 'true'
        : true;

    let watchDebounceMs = DEFAULT_WATCH_DEBOUNCE_MS;
    const watchDebounceRaw = envManager.get('MCP_WATCH_DEBOUNCE_MS');
    if (watchDebounceRaw) {
        const parsed = Number.parseInt(watchDebounceRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            watchDebounceMs = parsed;
        } else {
            console.warn(`[WARN] Invalid MCP_WATCH_DEBOUNCE_MS value: ${watchDebounceRaw}. Using default ${DEFAULT_WATCH_DEBOUNCE_MS}.`);
        }
    }

    const config: ContextMcpConfig = {
        name: envManager.get('MCP_SERVER_NAME') || "Satori MCP Server",
        version: envManager.get('MCP_SERVER_VERSION') || resolveMcpPackageVersion(),
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
        // Experimental Potion artifacts are provisioned manually through the
        // L0 path. No installer or implicit download is introduced here.
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
        rankerModel,
        // read_file behavior
        readFileMaxLines,
        // proactive sync watcher behavior
        watchSyncEnabled,
        watchDebounceMs,
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
    console.log(`[MCP]   Embedding Model: ${config.encoderModel}`);
    console.log(`[MCP]   Vector Store: ${config.vectorStoreProvider}`);
    if (config.vectorStoreProvider === 'LanceDB') {
        console.log(`[MCP]   LanceDB Path: ${config.lanceDbPath}`);
    } else {
        console.log(`[MCP]   Milvus Address: ${config.milvusEndpoint || '[Not configured]'}`);
    }
    console.log(`[MCP]   Proactive Watcher: ${config.watchSyncEnabled ? `enabled (${config.watchDebounceMs || DEFAULT_WATCH_DEBOUNCE_MS}ms debounce)` : 'disabled'}`);

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

  Proactive Sync Configuration:
  MCP_ENABLE_WATCHER      Enable filesystem watch mode for near-real-time sync (default: true)
  MCP_WATCH_DEBOUNCE_MS   Quiet period after FS events before incremental sync (default: 5000; not "searchable in 5s")

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
