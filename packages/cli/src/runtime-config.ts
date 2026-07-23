import path from "node:path";
import { POTION_DIMENSION, POTION_MODEL_ID } from "@zokizuan/satori-core";

export type RuntimeConfigCheckStatus = "ok" | "error";

export interface RuntimeConfigCheck {
    name: string;
    status: RuntimeConfigCheckStatus;
    message: string;
    nextStep?: string;
}

const SUPPORTED_EMBEDDING_PROVIDERS = new Set(["OpenAI", "VoyageAI", "Gemini", "Ollama", "Potion"]);
const SUPPORTED_VECTOR_STORES = new Set(["Milvus", "LanceDB"]);
const SUPPORTED_OUTPUT_DIMENSIONS = new Set([256, 512, 1024, 2048]);

function selectedExecutionProfile(env: NodeJS.ProcessEnv): string {
    return env.SATORI_RUNTIME_PROFILE?.trim() || "connected";
}

export function selectedVectorStore(env: NodeJS.ProcessEnv): string {
    const configured = env.VECTOR_STORE_PROVIDER?.trim();
    if (configured) return configured;
    // Existing connected installations commonly supplied only MILVUS_ADDRESS.
    // Preserve that identity while making LanceDB the no-configuration default.
    return env.MILVUS_ADDRESS?.trim() ? "Milvus" : "LanceDB";
}

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
        case "Potion":
            return POTION_MODEL_ID;
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
        case "Potion":
            return null;
        default:
            return null;
    }
}

export function evaluateStaticRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfigCheck[] {
    const executionProfile = selectedExecutionProfile(env);
    if (executionProfile !== "connected" && executionProfile !== "offline") {
        return [{
            name: "runtime_profile",
            status: "error",
            message: `Unsupported runtime profile: ${executionProfile}. Use connected or offline.`,
            nextStep: "Set SATORI_RUNTIME_PROFILE to connected or offline.",
        }];
    }
    const provider = selectedProvider(env);
    if (!SUPPORTED_EMBEDDING_PROVIDERS.has(provider)) {
        return [{
            name: "embedding_provider",
            status: "error",
            message: `Unsupported embedding provider: ${provider}. Use OpenAI, VoyageAI, Gemini, Ollama, or Potion.`,
            nextStep: "Set EMBEDDING_PROVIDER to OpenAI, VoyageAI, Gemini, Ollama, or Potion.",
        }];
    }

    const vectorStore = selectedVectorStore(env);
    if (!SUPPORTED_VECTOR_STORES.has(vectorStore)) {
        return [{
            name: "vector_store_provider",
            status: "error",
            message: `Unsupported vector store provider: ${vectorStore}. Use Milvus or LanceDB.`,
            nextStep: "Set VECTOR_STORE_PROVIDER to Milvus or LanceDB.",
        }];
    }

    const model = selectedModel(env, provider);
    const checks: RuntimeConfigCheck[] = [
        {
            name: "runtime_profile",
            status: "ok",
            message: `Runtime profile: ${executionProfile}.`,
        },
        {
            name: "embedding_provider",
            status: "ok",
            message: `Embedding provider: ${provider}.`,
        },
        provider === "Potion" && model !== POTION_MODEL_ID
            ? {
                name: "embedding_model",
                status: "error",
                message: `Potion requires the pinned model identity ${POTION_MODEL_ID}; received ${model}.`,
                nextStep: "Re-run satori install --runtime offline.",
            }
            : {
                name: "embedding_model",
                status: "ok",
                message: `Embedding model: ${model}.`,
            },
        {
            name: "vector_store_provider",
            status: "ok",
            message: `Vector store provider: ${vectorStore}.`,
        },
    ];

    if (executionProfile === "offline" && provider !== "Ollama" && provider !== "Potion") {
        checks.push({
            name: "offline_embedding_policy",
            status: "error",
            message: "Offline runtime requires EMBEDDING_PROVIDER=Potion or Ollama.",
            nextStep: "Set EMBEDDING_PROVIDER to Potion or Ollama, or select SATORI_RUNTIME_PROFILE=connected.",
        });
    }
    if (executionProfile !== "offline" && provider === "Potion") {
        checks.push({
            name: "potion_runtime_policy",
            status: "error",
            message: "Potion requires SATORI_RUNTIME_PROFILE=offline.",
            nextStep: "Select the offline runtime or use a connected embedding provider.",
        });
    }
    if (executionProfile === "offline" && vectorStore !== "LanceDB") {
        checks.push({
            name: "offline_vector_policy",
            status: "error",
            message: "Offline runtime requires VECTOR_STORE_PROVIDER=LanceDB.",
            nextStep: "Set VECTOR_STORE_PROVIDER to LanceDB or select SATORI_RUNTIME_PROFILE=connected.",
        });
    }

    const dimensionValue = env.EMBEDDING_OUTPUT_DIMENSION?.trim();
    if (dimensionValue) {
        const dimension = Number(dimensionValue);
        const valid = provider === "VoyageAI"
            ? SUPPORTED_OUTPUT_DIMENSIONS.has(dimension)
            : provider === "Ollama"
                ? Number.isSafeInteger(dimension) && dimension > 0
                : provider === "Potion"
                    ? dimension === POTION_DIMENSION
                : false;
        if (!valid) {
            const expected = provider === "VoyageAI"
                ? "256, 512, 1024, or 2048"
                : provider === "Ollama"
                    ? "a positive safe integer resolved from the installed model"
                    : provider === "Potion"
                        ? String(POTION_DIMENSION)
                    : `no explicit dimension because ${provider} ignores this setting`;
            checks.push({
                name: "embedding_dimension",
                status: "error",
                message: `Invalid embedding output dimension for ${provider}: ${dimensionValue}. Use ${expected}.`,
                nextStep: provider === "Ollama"
                    ? "Re-run offline install so the selected Ollama model dimension is recorded."
                    : provider === "Potion"
                        ? "Re-run offline install so the pinned Potion dimension is recorded."
                    : "Remove EMBEDDING_OUTPUT_DIMENSION or use a dimension supported by the selected provider.",
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

    if (vectorStore === "Milvus") {
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
    } else {
        const lanceDbPath = env.LANCEDB_PATH?.trim();
        if (lanceDbPath && !path.isAbsolute(lanceDbPath)) {
            checks.push({
                name: "lancedb_path",
                status: "error",
                message: "LANCEDB_PATH must be absolute when configured.",
                nextStep: "Set LANCEDB_PATH to an absolute installer-owned directory or remove it to use the default.",
            });
        } else {
            checks.push({
                name: "lancedb_path",
                status: "ok",
                message: lanceDbPath
                    ? `LanceDB path: ${lanceDbPath}.`
                    : "LanceDB path uses the installer-owned default.",
            });
        }
    }

    if (executionProfile === "offline" && provider !== "Potion") {
        if (!env.OLLAMA_MODEL_DIGEST?.trim()) {
            checks.push({
                name: "offline_model_digest",
                status: "error",
                message: "Offline runtime requires installer-recorded OLLAMA_MODEL_DIGEST.",
                nextStep: "Re-run satori install --runtime offline with the selected local model.",
            });
        } else {
            checks.push({
                name: "offline_model_digest",
                status: "ok",
                message: "Installer-recorded Ollama model digest is present.",
            });
        }
    }

    if (provider === "Potion") {
        const helperPath = env.POTION_HELPER_PATH?.trim();
        const modelPath = env.POTION_MODEL_PATH?.trim();
        const validPaths = Boolean(
            helperPath
            && modelPath
            && path.isAbsolute(helperPath)
            && path.isAbsolute(modelPath),
        );
        checks.push(validPaths
            ? { name: "potion_artifacts", status: "ok", message: "Pinned Potion artifact paths are configured." }
            : {
                name: "potion_artifacts",
                status: "error",
                message: "Potion requires absolute POTION_HELPER_PATH and POTION_MODEL_PATH values.",
                nextStep: "Re-run satori install --runtime offline.",
            });
    }

    return checks;
}
