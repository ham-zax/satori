import {
    VoyageAIReranker,
    type Reranker,
    type RerankOptions,
    type RerankResult,
} from "@satori-code/core";
import { SEARCH_RERANK_DOCUMENT_POLICY } from "../core/search-rerank-document.js";
import { SEARCH_RERANK_QUERY_PROJECTION_IDENTITY } from "../core/search-rerank-query.js";

/**
 * The canonical rerank projections are byte contracts, not provider features.
 * Voyage accepts the same publication-bound document and formatted query as
 * the local profile, so it advertises those identities and the coordinator
 * builds the matching bytes. Without this, Voyage silently falls back to the
 * raw query and the plain native document.
 */
export class VoyageProjectionReranker implements Reranker {
    constructor(private readonly provider: VoyageAIReranker) {}

    getIdentity(): ReturnType<Reranker["getIdentity"]> {
        return this.provider.getIdentity();
    }

    rerank(
        query: string,
        documents: string[],
        options?: RerankOptions,
    ): Promise<RerankResult[]> {
        return this.provider.rerank(query, documents, options);
    }

    getDocumentProjectionVersion(): string {
        return SEARCH_RERANK_DOCUMENT_POLICY.id;
    }

    getQueryProjectionVersion(): string {
        return SEARCH_RERANK_QUERY_PROJECTION_IDENTITY;
    }
}
