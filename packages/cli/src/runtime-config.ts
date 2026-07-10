export type RuntimeConfigCheckStatus = "ok" | "error";

export interface RuntimeConfigCheck {
    name: string;
    status: RuntimeConfigCheckStatus;
    message: string;
    nextStep?: string;
}

const SUPPORTED_EMBEDDING_PROVIDERS = new Set(["OpenAI", "VoyageAI", "Gemini", "Ollama"]);
const SUPPORTED_OUTPUT_DIMENSIONS = new Set([256, 512, 1024, 2048]);

function selectedProvider(env: NodeJS.ProcessEnv): string {
    return env.EMBEDDING_PROVIDER?.trim() || "VoyageAI";
}

function defaultModelForProvider(provider: string): string {
    switch (provider) {
        case "OpenAI":
            return "text-embedding-3-small";
        case "VoyageAI":
            return "voyage-code-3";
        case "Gemini":
            return "gemini-embedding-001";
        case "Ollama":
            return "nomic-embed-text";
        default:
            return "unknown";
    }
}

function selectedModel(env: NodeJS.ProcessEnv, provider: string): string {
    if (provider === "Ollama") {
        return env.OLLAMA_MODEL?.trim() || env.EMBEDDING_MODEL?.trim() || defaultModelForProvider(provider);
    }
    return env.EMBEDDING_MODEL?.trim() || defaultModelForProvider(provider);
}

function requiredEmbeddingEnv(provider: string): string | null {
    switch (provider) {
        case "OpenAI":
            return "OPENAI_API_KEY";
        case "VoyageAI":
            return "VOYAGEAI_API_KEY";
        case "Gemini":
            return "GEMINI_API_KEY";
        case "Ollama":
            return null;
        default:
            return null;
    }
}

export function evaluateStaticRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfigCheck[] {
    const provider = selectedProvider(env);
    if (!SUPPORTED_EMBEDDING_PROVIDERS.has(provider)) {
        return [{
            name: "embedding_provider",
            status: "error",
            message: `Unsupported embedding provider: ${provider}. Use OpenAI, VoyageAI, Gemini, or Ollama.`,
            nextStep: "Set EMBEDDING_PROVIDER to OpenAI, VoyageAI, Gemini, or Ollama.",
        }];
    }

    const checks: RuntimeConfigCheck[] = [
        {
            name: "embedding_provider",
            status: "ok",
            message: `Embedding provider: ${provider}.`,
        },
        {
            name: "embedding_model",
            status: "ok",
            message: `Embedding model: ${selectedModel(env, provider)}.`,
        },
    ];

    const dimensionValue = env.EMBEDDING_OUTPUT_DIMENSION?.trim();
    if (dimensionValue) {
        const dimension = Number(dimensionValue);
        if (!Number.isInteger(dimension) || !SUPPORTED_OUTPUT_DIMENSIONS.has(dimension)) {
            checks.push({
                name: "embedding_dimension",
                status: "error",
                message: `Invalid embedding output dimension: ${dimensionValue}. Use 256, 512, 1024, or 2048.`,
                nextStep: "Set EMBEDDING_OUTPUT_DIMENSION to 256, 512, 1024, or 2048, or remove it to use the provider default.",
            });
        } else {
            checks.push({
                name: "embedding_dimension",
                status: "ok",
                message: `Embedding output dimension: ${dimensionValue}.`,
            });
        }
    } else {
        checks.push({
            name: "embedding_dimension",
            status: "ok",
            message: `Embedding output dimension: ${provider === "VoyageAI" ? "1024" : "provider default"}.`,
        });
    }

    const requiredKey = requiredEmbeddingEnv(provider);
    if (requiredKey && !env[requiredKey]?.trim()) {
        const blankButPresent = requiredKey in env;
        checks.push({
            name: "embedding_provider_env",
            status: "error",
            message: blankButPresent
                ? `${provider} requires a non-empty ${requiredKey} (empty string is incomplete).`
                : `${provider} requires ${requiredKey}.`,
            nextStep: provider === "VoyageAI"
                ? "Set VOYAGEAI_API_KEY from the Voyage AI dashboard API keys page."
                : `Set ${requiredKey}.`,
        });
    } else {
        checks.push({
            name: "embedding_provider_env",
            status: "ok",
            message: requiredKey ? `${requiredKey} is present.` : `${provider} does not require an API key.`,
        });
    }

    const milvusAddress = env.MILVUS_ADDRESS?.trim();
    if (!milvusAddress) {
        const blankButPresent = "MILVUS_ADDRESS" in env;
        checks.push({
            name: "milvus_address",
            status: "error",
            message: blankButPresent
                ? "MILVUS_ADDRESS is required and must be non-empty (empty string is incomplete)."
                : "MILVUS_ADDRESS is required for index/search/clear operations.",
            nextStep: "Set MILVUS_ADDRESS to a Zilliz Cloud public endpoint or local Milvus address such as localhost:19530.",
        });
    } else {
        checks.push({ name: "milvus_address", status: "ok", message: "MILVUS_ADDRESS is present." });
    }

    checks.push(env.MILVUS_TOKEN?.trim()
        ? { name: "milvus_token", status: "ok", message: "MILVUS_TOKEN is present." }
        : { name: "milvus_token", status: "ok", message: "MILVUS_TOKEN is not set; local/unauthenticated Milvus endpoints are supported." });

    return checks;
}
