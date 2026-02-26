import { envManager } from "@zokizuan/satori-core";

export type EmbeddingProvider = 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama';
export type VectorStoreProvider = 'Milvus';
export type FingerprintSource = 'verified' | 'assumed_v2';
export const DEFAULT_WATCH_DEBOUNCE_MS = 5000;

export interface IndexFingerprint {
    embeddingProvider: EmbeddingProvider;
    embeddingModel: string;
    embeddingDimension: number;
    vectorStoreProvider: VectorStoreProvider;
    schemaVersion: 'dense_v3' | 'hybrid_v3';
}

export interface ContextMcpConfig {
    name: string;
    version: string;
    // Embedding provider configuration
    encoderProvider: EmbeddingProvider;
    encoderModel: string;
    encoderOutputDimension?: number;  // For VoyageAI: 256, 512, 1024, 2048
    // Provider-specific API keys
    openaiKey?: string;
    openaiEndpoint?: string;
    voyageKey?: string;
    geminiKey?: string;
    geminiEndpoint?: string;
    // Ollama configuration
    ollamaEncoderModel?: string;
    ollamaEndpoint?: string;
    // Vector database configuration
    milvusEndpoint?: string; // Optional, can be auto-resolved from token
    milvusApiToken?: string;
    // Reranker configuration
    rankerModel?: 'rerank-2.5' | 'rerank-2.5-lite' | 'rerank-2' | 'rerank-2-lite';
    // read_file behavior
    readFileMaxLines?: number;
    // Proactive sync watcher behavior
    watchSyncEnabled?: boolean;
    watchDebounceMs?: number;
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

// Legacy format (v1) - for backward compatibility
export interface CodebaseSnapshotV1 {
    indexedCodebases: string[];
    indexingCodebases: string[] | Record<string, number>;  // Array (legacy) or Map of codebase path to progress percentage
    lastUpdated: string;
}

interface CodebaseInfoBase {
    lastUpdated: string;
    indexFingerprint?: IndexFingerprint;
    fingerprintSource?: FingerprintSource;
    reindexReason?: 'legacy_unverified_fingerprint' | 'fingerprint_mismatch' | 'missing_fingerprint';
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
            return 'voyage-4-large';
        case 'Gemini':
            return 'gemini-embedding-001';
        case 'Ollama':
            return 'nomic-embed-text';
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

export function buildRuntimeIndexFingerprint(config: ContextMcpConfig, embeddingDimension: number): IndexFingerprint {
    return {
        embeddingProvider: config.encoderProvider,
        embeddingModel: config.encoderModel,
        embeddingDimension,
        vectorStoreProvider: 'Milvus',
        schemaVersion: getSchemaVersionFromEnv()
    };
}

export function createMcpConfig(): ContextMcpConfig {
    const defaultProvider = (envManager.get('EMBEDDING_PROVIDER') as EmbeddingProvider) || 'VoyageAI';
    const defaultReadFileMaxLines = 1000;

    // Parse output dimension from env var
    const outputDimensionStr = envManager.get('EMBEDDING_OUTPUT_DIMENSION');
    let encoderOutputDimension: number | undefined;
    if (outputDimensionStr) {
        const parsed = parseInt(outputDimensionStr, 10);
        if ([256, 512, 1024, 2048].includes(parsed)) {
            encoderOutputDimension = parsed;
        } else {
            console.warn(`[WARN] Invalid EMBEDDING_OUTPUT_DIMENSION value: ${outputDimensionStr}. Must be 256, 512, 1024, or 2048.`);
        }
    } else if (defaultProvider === 'VoyageAI') {
        // Default to 1024 for VoyageAI to balance quality/cost.
        encoderOutputDimension = 1024;
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
        version: envManager.get('MCP_SERVER_VERSION') || "1.0.0",
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
        ollamaEndpoint: envManager.get('OLLAMA_HOST'),
        // Vector database configuration - address can be auto-resolved from token
        milvusEndpoint: envManager.get('MILVUS_ADDRESS'), // Optional, can be resolved from token
        milvusApiToken: envManager.get('MILVUS_TOKEN'),
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
    console.log(`[MCP]   Embedding Provider: ${config.encoderProvider}`);
    console.log(`[MCP]   Embedding Model: ${config.encoderModel}`);
    console.log(`[MCP]   Milvus Address: ${config.milvusEndpoint || (config.milvusApiToken ? '[Auto-resolve from token]' : '[Not configured]')}`);
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
    }

    console.log(`[MCP] 🔧 Initializing server components...`);
}

export function showHelpMessage(): void {
    console.log(`
Satori MCP Server

Usage: npx @zokizuan/satori-mcp@latest [options]

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
  MILVUS_ADDRESS          Milvus address (optional, can be auto-resolved from token)
  MILVUS_TOKEN            Milvus token (optional, used for authentication and address resolution)

  Read File Configuration:
  READ_FILE_MAX_LINES     Max lines returned by read_file when no explicit range is provided (default: 1000)

  Proactive Sync Configuration:
  MCP_ENABLE_WATCHER      Enable filesystem watch mode for near-real-time sync (default: true)
  MCP_WATCH_DEBOUNCE_MS   Debounce window for watch-triggered sync in milliseconds (default: 5000)

Examples:
  # Start MCP server with OpenAI and explicit Milvus address
  OPENAI_API_KEY=sk-xxx MILVUS_ADDRESS=localhost:19530 npx @zokizuan/satori-mcp@latest

  # Start MCP server with VoyageAI and specific model
  EMBEDDING_PROVIDER=VoyageAI VOYAGEAI_API_KEY=pa-xxx EMBEDDING_MODEL=voyage-4-large MILVUS_TOKEN=your-token npx @zokizuan/satori-mcp@latest

  # Start MCP server with Gemini and specific model
  EMBEDDING_PROVIDER=Gemini GEMINI_API_KEY=xxx EMBEDDING_MODEL=gemini-embedding-001 MILVUS_TOKEN=your-token npx @zokizuan/satori-mcp@latest

  # Start MCP server with Ollama and specific model
  EMBEDDING_PROVIDER=Ollama EMBEDDING_MODEL=nomic-embed-text MILVUS_TOKEN=your-token npx @zokizuan/satori-mcp@latest
        `);
}
