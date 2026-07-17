import {
    EmbeddingProviderError,
    type EmbeddingProviderErrorCode,
} from '@zokizuan/satori-core';

export interface EmbeddingProviderDiagnostic {
    code: EmbeddingProviderErrorCode;
    message: string;
    retryable: boolean;
    hints: {
        embedding: {
            code: EmbeddingProviderErrorCode;
            provider: string;
            retryable: boolean;
            statusCode: number | null;
            nextSteps: string[];
        };
    };
}

function publicMessageFor(error: EmbeddingProviderError): string {
    const provider = /^[A-Za-z0-9._ -]{1,64}$/.test(error.provider)
        ? error.provider
        : 'Embedding provider';
    const status = error.statusCode === null ? '' : ` (HTTP ${error.statusCode})`;
    switch (error.code) {
        case 'EMBEDDING_PROVIDER_AUTH_FAILED':
            return `${provider} embedding authentication failed${status}.`;
        case 'EMBEDDING_PROVIDER_FORBIDDEN':
            return `${provider} embedding request was forbidden${status}.`;
        case 'EMBEDDING_PROVIDER_RATE_LIMITED':
            return `${provider} embedding rate limit was exceeded${status}.`;
        case 'EMBEDDING_PROVIDER_INVALID_REQUEST':
            return `${provider} embedding request was rejected${status}.`;
        case 'EMBEDDING_PROVIDER_TIMEOUT':
            return `${provider} embedding request timed out${status}.`;
        case 'EMBEDDING_PROVIDER_UNAVAILABLE':
            return `${provider} embedding service was unavailable${status}.`;
        case 'EMBEDDING_PROVIDER_NETWORK_ERROR':
            return `${provider} embedding network request failed.`;
        case 'EMBEDDING_PROVIDER_ERROR':
            return `${provider} embedding request failed${status}.`;
    }
}

function nextStepsFor(error: EmbeddingProviderError): string[] {
    switch (error.code) {
        case 'EMBEDDING_PROVIDER_AUTH_FAILED':
            return [
                'Verify VOYAGEAI_API_KEY is present and current in the MCP client environment.',
                'Restart the MCP server after correcting the credential.',
            ];
        case 'EMBEDDING_PROVIDER_FORBIDDEN':
            return [
                'Verify that the VoyageAI account and source network are permitted to call the embedding API.',
                'Correct the account or network policy before retrying.',
            ];
        case 'EMBEDDING_PROVIDER_RATE_LIMITED':
            return [
                'Wait for the VoyageAI rate-limit window to recover, then retry once.',
                'Reduce concurrent searches if rate limiting recurs.',
            ];
        case 'EMBEDDING_PROVIDER_INVALID_REQUEST':
            return [
                'Verify the configured VoyageAI embedding model and output dimension.',
                'Correct the provider configuration before retrying.',
            ];
        case 'EMBEDDING_PROVIDER_TIMEOUT':
        case 'EMBEDDING_PROVIDER_UNAVAILABLE':
        case 'EMBEDDING_PROVIDER_NETWORK_ERROR':
            return [
                'Verify network access to the VoyageAI API and provider availability.',
                'Retry the search after the provider responds normally.',
            ];
        case 'EMBEDDING_PROVIDER_ERROR':
            return [
                'Inspect the redacted MCP server log for the VoyageAI failure classification.',
                'Verify provider configuration and availability before retrying.',
            ];
    }
}

export function classifyEmbeddingProviderError(error: unknown): EmbeddingProviderDiagnostic | null {
    if (!(error instanceof EmbeddingProviderError)) return null;

    return {
        code: error.code,
        message: publicMessageFor(error),
        retryable: error.retryable,
        hints: {
            embedding: {
                code: error.code,
                provider: error.provider,
                retryable: error.retryable,
                statusCode: error.statusCode,
                nextSteps: nextStepsFor(error),
            },
        },
    };
}
