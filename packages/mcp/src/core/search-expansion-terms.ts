import { SEARCH_ALT_TERMS_MAX } from "./search-constants.js";

export type ResolvedSearchAltTerms = Readonly<{
    termsEmitted: string[];
    termsDropped: string[];
    query: string | null;
}>;

/** One accepted vocabulary for retrieval, reranking, and the expansion trace. */
export function resolveSearchAltTerms(input?: string[] | string): ResolvedSearchAltTerms {
    const requested = (typeof input === "string" ? input.split(/[,\s]+/) : input ?? [])
        .map((term) => term.trim()).filter(Boolean);
    const termsEmitted = requested.slice(0, SEARCH_ALT_TERMS_MAX);
    return {
        termsEmitted,
        termsDropped: requested.slice(SEARCH_ALT_TERMS_MAX),
        query: termsEmitted.length > 0 ? termsEmitted.join(" ") : null,
    };
}
