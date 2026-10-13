export const RERANKER_PROVIDERS = {
    lateon: { network: "local" },
    voyage: {
        network: "remote",
        keyEnv: "VOYAGEAI_API_KEY",
        modelEnv: "VOYAGEAI_RERANKER_MODEL",
        // Mirrors DEFAULT_VOYAGE_RERANKER_MODEL in core; the CLI does not depend on core.
        defaultModel: "rerank-3-lite",
    },
    none: { network: "local" },
} as const;

export type InstallReranker = keyof typeof RERANKER_PROVIDERS;
