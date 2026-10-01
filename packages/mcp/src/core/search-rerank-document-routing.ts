/**
 * Phase 9.2 review repair — document projection routing.
 *
 * One executable document projection (`search_rerank_document_v5`) plus the
 * raw fallback identity (`semantic_document_raw_v1`). Retired v1/v2/v3
 * identities fail closed before any provider call — symmetrically with query
 * routing — so an advertised identity can never name different document bytes
 * than the ones actually sent to the provider.
 */
import { SEARCH_RERANK_DOCUMENT_POLICY } from "./search-rerank-document.js";

export const SEARCH_RERANK_DOCUMENT_RAW_IDENTITY = "semantic_document_raw_v1" as const;

export type SearchRerankDocumentProjectionIdentity =
    | typeof SEARCH_RERANK_DOCUMENT_RAW_IDENTITY
    | typeof SEARCH_RERANK_DOCUMENT_POLICY.id;

export function resolveSearchRerankDocumentProjectionIdentity(
    projectionIdentity: string | undefined,
): SearchRerankDocumentProjectionIdentity {
    const identity = projectionIdentity?.trim();
    if (!identity || identity === SEARCH_RERANK_DOCUMENT_RAW_IDENTITY) {
        return SEARCH_RERANK_DOCUMENT_RAW_IDENTITY;
    }
    if (identity === SEARCH_RERANK_DOCUMENT_POLICY.id) {
        return SEARCH_RERANK_DOCUMENT_POLICY.id;
    }
    throw new Error(`search_rerank_document_projection_identity_unknown:${identity}`);
}