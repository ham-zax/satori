import {
    SEARCH_MAX_DIAGNOSTIC_CANDIDATES,
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
    diagnosticCandidateLimit?: number;
}>;

export function resolveSearchPolicy(input: {
    resultLimit: number;
    hasMustOperators: boolean;
    diagnosticCandidateLimit?: number;
}): ResolvedSearchPolicy {
    const maxCandidateLimit = SEARCH_MAX_CANDIDATES;
    const candidateLimit = Math.max(
        1,
        Math.min(
            maxCandidateLimit,
            Math.max(input.resultLimit * SEARCH_CANDIDATE_MULTIPLIER, SEARCH_MIN_CANDIDATES),
        ),
    );
    const diagnosticCandidateLimit = input.diagnosticCandidateLimit === undefined
        ? undefined
        : Math.max(
            candidateLimit,
            Math.min(SEARCH_MAX_DIAGNOSTIC_CANDIDATES, input.diagnosticCandidateLimit),
        );
    return {
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
