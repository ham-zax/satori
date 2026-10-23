import {
    SEARCH_MAX_DIAGNOSTIC_CANDIDATES,
    SEARCH_MAX_CANDIDATES,
    SEARCH_MAX_FROZEN_RESULTS,
    SEARCH_MAX_PAGE_SIZE,
    SEARCH_DEFAULT_DISCLOSURE_LIMIT,
    SEARCH_MUST_RETRY_MULTIPLIER,
    SEARCH_MUST_RETRY_ROUNDS,
} from './search-constants.js';

export type ResolvedSearchPolicy = Readonly<{
    retrievalResultLimit: number;
    rerankerResultLimit: number;
    disclosureResultLimit: number;
    candidateLimit: number;
    maxCandidateLimit: number;
    maxAttempts: number;
    diagnosticCandidateLimit?: number;
}>;

export function resolveFrozenSearchResultLimit(requestedTotal: number): number {
    return Math.max(
        1,
        Math.min(SEARCH_MAX_FROZEN_RESULTS, Math.floor(requestedTotal)),
    );
}

export function resolveSearchPolicy(input: {
    resultLimit: number;
    retrievalResultLimit?: number;
    rerankerResultLimit?: number;
    disclosureResultLimit?: number;
    hasMustOperators: boolean;
    diagnosticCandidateLimit?: number;
}): ResolvedSearchPolicy {
    const normalizedResultLimit = resolveFrozenSearchResultLimit(input.resultLimit);
    const retrievalResultLimit = Math.max(
        1,
        Math.min(
            SEARCH_MAX_FROZEN_RESULTS,
            Math.floor(input.retrievalResultLimit ?? normalizedResultLimit),
        ),
    );
    const rerankerResultLimit = Math.max(
        1,
        Math.min(
            SEARCH_MAX_FROZEN_RESULTS,
            Math.floor(input.rerankerResultLimit ?? retrievalResultLimit),
        ),
    );
    const disclosureResultLimit = Math.max(
        1,
        Math.min(
            SEARCH_MAX_PAGE_SIZE,
            Math.floor(input.disclosureResultLimit
                ?? Math.min(normalizedResultLimit, SEARCH_DEFAULT_DISCLOSURE_LIMIT)),
        ),
    );
    // Retrieval spends the whole candidate budget on every request.
    // SEARCH_MAX_CANDIDATES alone owns that cap: a budget that scaled with the
    // requested output count made discovery depend on how many results were
    // displayed, so a narrow request searched less of the repository than a
    // wide one over the same query. limit, retrievalResultLimit,
    // rerankerResultLimit and disclosureResultLimit shape the response.
    const maxCandidateLimit = SEARCH_MAX_CANDIDATES;
    const candidateLimit = SEARCH_MAX_CANDIDATES;
    const diagnosticCandidateLimit = input.diagnosticCandidateLimit === undefined
        ? undefined
        : Math.max(
            candidateLimit,
            Math.min(SEARCH_MAX_DIAGNOSTIC_CANDIDATES, input.diagnosticCandidateLimit),
        );
    return {
        retrievalResultLimit,
        rerankerResultLimit,
        disclosureResultLimit,
        candidateLimit,
        maxCandidateLimit,
        maxAttempts: input.hasMustOperators ? 1 + SEARCH_MUST_RETRY_ROUNDS : 1,
        ...(diagnosticCandidateLimit !== undefined ? { diagnosticCandidateLimit } : {}),
    };
}

export function resolveNextSearchCandidateLimit(currentLimit: number): number {
    return Math.min(
        SEARCH_MAX_CANDIDATES,
        Math.max(currentLimit + 1, currentLimit * SEARCH_MUST_RETRY_MULTIPLIER),
    );
}
