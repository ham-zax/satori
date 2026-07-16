import {
    SEARCH_MAX_CANDIDATES,
    SEARCH_MUST_RETRY_MULTIPLIER,
    SEARCH_MUST_RETRY_ROUNDS,
} from './search-constants.js';

const SEARCH_MIN_CANDIDATES = 32;
const SEARCH_CANDIDATE_MULTIPLIER = 8;

export type ResolvedSearchPolicy = Readonly<{
    candidateLimit: number;
    maxCandidateLimit: number;
    maxAttempts: number;
}>;

export function resolveSearchPolicy(input: {
    resultLimit: number;
    hasMustOperators: boolean;
}): ResolvedSearchPolicy {
    return {
        candidateLimit: Math.max(
            1,
            Math.min(
                SEARCH_MAX_CANDIDATES,
                Math.max(input.resultLimit * SEARCH_CANDIDATE_MULTIPLIER, SEARCH_MIN_CANDIDATES),
            ),
        ),
        maxCandidateLimit: SEARCH_MAX_CANDIDATES,
        maxAttempts: input.hasMustOperators ? 1 + SEARCH_MUST_RETRY_ROUNDS : 1,
    };
}

export function resolveNextSearchCandidateLimit(currentLimit: number): number {
    return Math.min(
        SEARCH_MAX_CANDIDATES,
        Math.max(currentLimit + 1, currentLimit * SEARCH_MUST_RETRY_MULTIPLIER),
    );
}
