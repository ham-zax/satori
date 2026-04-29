import { OpenAIEmbedding, VoyageAIEmbedding, GeminiEmbedding, OllamaEmbedding } from "@zokizuan/satori-core";
import { ContextMcpConfig } from "./config.js";

// Helper function to create embedding instance based on provider
export function createEmbeddingInstance(config: ContextMcpConfig): OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding {
    console.log(`[EMBEDDING] Creating ${config.encoderProvider} embedding instance...`);

    switch (config.encoderProvider) {
        case 'OpenAI': {
            if (!config.openaiKey) {
                console.error(`[EMBEDDING] ❌ OpenAI API key is required but not provided`);
                throw new Error('OPENAI_API_KEY is required for OpenAI embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring OpenAI with model: ${config.encoderModel}`);
            const openaiEmbedding = new OpenAIEmbedding({
                apiKey: config.openaiKey,
                model: config.encoderModel,
                ...(config.openaiEndpoint && { baseURL: config.openaiEndpoint })
            });
            console.log(`[EMBEDDING] ✅ OpenAI embedding instance created successfully`);
            return openaiEmbedding;
        }

        case 'VoyageAI': {
            if (!config.voyageKey) {
                console.error(`[EMBEDDING] ❌ VoyageAI API key is required but not provided`);
                throw new Error('VOYAGEAI_API_KEY is required for VoyageAI embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring VoyageAI with model: ${config.encoderModel}`);
            if (config.encoderOutputDimension) {
                console.log(`[EMBEDDING] 🔧 Using custom output dimension: ${config.encoderOutputDimension}`);
            }
            const voyageEmbedding = new VoyageAIEmbedding({
                apiKey: config.voyageKey,
                model: config.encoderModel,
                ...(config.encoderOutputDimension && { outputDimension: config.encoderOutputDimension as 256 | 512 | 1024 | 2048 })
            });
            console.log(`[EMBEDDING] ✅ VoyageAI embedding instance created successfully`);
            return voyageEmbedding;
        }

        case 'Gemini': {
            if (!config.geminiKey) {
                console.error(`[EMBEDDING] ❌ Gemini API key is required but not provided`);
                throw new Error('GEMINI_API_KEY is required for Gemini embedding provider');
            }
            console.log(`[EMBEDDING] 🔧 Configuring Gemini with model: ${config.encoderModel}`);
            const geminiEmbedding = new GeminiEmbedding({
                apiKey: config.geminiKey,
                model: config.encoderModel,
                ...(config.geminiEndpoint && { baseURL: config.geminiEndpoint })
            });
            console.log(`[EMBEDDING] ✅ Gemini embedding instance created successfully`);
            return geminiEmbedding;
        }

        case 'Ollama': {
            const ollamaEndpoint = config.ollamaEndpoint || 'http://127.0.0.1:11434';
            console.log(`[EMBEDDING] 🔧 Configuring Ollama with model: ${config.encoderModel}, host: ${ollamaEndpoint}`);
            const ollamaEmbedding = new OllamaEmbedding({
                model: config.encoderModel,
                host: config.ollamaEndpoint
            });
            console.log(`[EMBEDDING] ✅ Ollama embedding instance created successfully`);
            return ollamaEmbedding;
        }

        default:
            console.error(`[EMBEDDING] ❌ Unsupported embedding provider: ${config.encoderProvider}`);
            throw new Error(`Unsupported embedding provider: ${config.encoderProvider}`);
    }
}

export function logEmbeddingProviderInfo(config: ContextMcpConfig, embedding: OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding): void {
    console.log(`[EMBEDDING] ✅ Successfully initialized ${config.encoderProvider} embedding provider`);
    console.log(`[EMBEDDING] Provider details - Model: ${config.encoderModel}, Dimension: ${embedding.getDimension()}`);

    // Log provider-specific configuration details
    switch (config.encoderProvider) {
        case 'OpenAI':
            console.log(`[EMBEDDING] OpenAI configuration - API Key: ${config.openaiKey ? '✅ Provided' : '❌ Missing'}, Base URL: ${config.openaiEndpoint || 'Default'}`);
            break;
        case 'VoyageAI':
            console.log(`[EMBEDDING] VoyageAI configuration - API Key: ${config.voyageKey ? '✅ Provided' : '❌ Missing'}`);
            break;
        case 'Gemini':
            console.log(`[EMBEDDING] Gemini configuration - API Key: ${config.geminiKey ? '✅ Provided' : '❌ Missing'}, Base URL: ${config.geminiEndpoint || 'Default'}`);
            break;
        case 'Ollama':
            console.log(`[EMBEDDING] Ollama configuration - Host: ${config.ollamaEndpoint || 'http://127.0.0.1:11434'}, Model: ${config.encoderModel}`);
            break;
    }
}
