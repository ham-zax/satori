import type { BackendScoreKind, RetrievalMode, ScorePolicy } from './vectordb/types';

export interface SearchQuery {
    term: string;
    includeContent?: boolean;
    limit?: number;
}

export interface SemanticSearchRequest {
    codebasePath: string;
    query: string;
    topK?: number;
    retrievalMode?: RetrievalMode;
    filterExpr?: string;
    scorePolicy?: ScorePolicy;
}

export interface SemanticSearchResult {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    breadcrumbs?: string[];
    indexedAt?: string;
    symbolId?: string;
    symbolLabel?: string;
    backendScore?: number;
    backendScoreKind?: BackendScoreKind;
}
