export const RERANK_TOP_K = 24;

export interface SearchPolicy {
    rerankTopK: number;
    expandWhenAmbiguous: boolean;
}

export const DEFAULT_SEARCH_POLICY: SearchPolicy = {
    rerankTopK: RERANK_TOP_K,
    expandWhenAmbiguous: true,
};
