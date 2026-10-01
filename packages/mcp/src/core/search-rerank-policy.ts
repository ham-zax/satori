import type { SemanticSearchResult } from "@satori-code/core";
import {
    SEARCH_DEFAULT_DISCLOSURE_LIMIT,
    SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT,
    SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT,
    SEARCH_RERANK_DEFAULT_CANDIDATE_DEPTH,
    SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY,
    SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES,
    SEARCH_RERANK_TOP_K,
} from "./search-constants.js";

export const SEARCH_RERANK_MIN_PROJECTED_CANDIDATES = 2;

export function shouldCallRerankerForProjectedCandidateCount(count: number): boolean {
    return Number.isSafeInteger(count) && count >= SEARCH_RERANK_MIN_PROJECTED_CANDIDATES;
}

export type RerankBudgetReason =
    | "complete_family_pool"
    | "family_ambiguity"
    | "provider_limit"
    | "global_limit";

export type RerankCandidateLike = {
    result: Partial<SemanticSearchResult> & { relativePath: string };
};

export type RerankCandidateSelection<T> = {
    selected: T[];
    familyCount: number;
    supplementalCandidateCount: number;
    candidatePoolCount: number;
    budget: number;
    budgetReason: RerankBudgetReason;
};

export type RerankInputByteSelection<T> = Readonly<{
    candidates: readonly T[];
    documents: readonly string[];
    inputBytes: number;
    omittedCandidateCount: number;
}>;

export type RerankCandidatePool<T> = Readonly<{
    candidates: readonly T[];
    familyCount: number;
    supplementalCandidateCount: number;
}>;

function normalizedString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function exactChunkIdentity(candidate: RerankCandidateLike): string {
    const result = candidate.result;
    const relativePath = result.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const startLine = Number.isInteger(result.startLine) ? result.startLine : 0;
    const endLine = Number.isInteger(result.endLine) ? result.endLine : startLine;
    const language = normalizedString(result.language) ?? "unknown";
    return `${relativePath}:${startLine}:${endLine}:${language}`;
}

export function resolveRerankFamilyKey(candidate: RerankCandidateLike): string {
    const ownerSymbolInstanceId = normalizedString(candidate.result.ownerSymbolInstanceId);
    if (ownerSymbolInstanceId) return `owner_instance:${ownerSymbolInstanceId}`;

    const ownerSymbolKey = normalizedString(candidate.result.ownerSymbolKey);
    if (ownerSymbolKey) return `owner_key:${ownerSymbolKey}`;

    // Missing owner evidence is never guessed from labels or nearby spans.
    return `chunk:${exactChunkIdentity(candidate)}`;
}

export function buildRerankCandidatePool<T extends RerankCandidateLike>(
    candidates: readonly T[],
): RerankCandidatePool<T> {
    const representatives: T[] = [];
    const representedFamilies = new Set<string>();
    const supplementalByFamily = new Map<string, T[]>();

    for (const candidate of candidates) {
        const familyKey = resolveRerankFamilyKey(candidate);
        if (!representedFamilies.has(familyKey)) {
            representatives.push(candidate);
            representedFamilies.add(familyKey);
            continue;
        }
        const supplemental = supplementalByFamily.get(familyKey) ?? [];
        if (supplemental.length < SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY) {
            supplementalByFamily.set(familyKey, [...supplemental, candidate]);
        }
    }

    // Keep supplemental rounds fair across owners before admitting another
    // chunk from the same family. Two bounded siblings cover long owners whose
    // relevant behavior is not in the declaration or first body chunk.
    const supplementalCandidates: T[] = [];
    for (let index = 0; index < SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY; index += 1) {
        for (const supplemental of supplementalByFamily.values()) {
            const candidate = supplemental[index];
            if (candidate) supplementalCandidates.push(candidate);
        }
    }
    const candidatePool = [...representatives, ...supplementalCandidates];
    return {
        candidates: candidatePool,
        familyCount: representatives.length,
        supplementalCandidateCount: supplementalCandidates.length,
    };
}

export function selectRerankCandidates<T extends RerankCandidateLike>(input: {
    candidates: readonly T[];
    requestedLimit: number;
    providerMaximumDocuments?: number;
    preferredCandidates?: readonly T[];
}): RerankCandidateSelection<T> {
    const pool = buildRerankCandidatePool(input.candidates);
    const candidatePool = [...pool.candidates];
    const available = new Set(input.candidates);
    const preferred = [...new Set(input.preferredCandidates ?? [])].filter((candidate) => available.has(candidate));
    for (const candidate of preferred) {
        if (!candidatePool.includes(candidate)) candidatePool.push(candidate);
    }
    const providerMaximumDocuments = Number.isSafeInteger(input.providerMaximumDocuments)
        && (input.providerMaximumDocuments as number) > 0
        ? input.providerMaximumDocuments as number
        : undefined;
    let budget: number;
    let budgetReason: RerankBudgetReason;
    if (providerMaximumDocuments !== undefined) {
        const capacity = Math.min(SEARCH_RERANK_TOP_K, providerMaximumDocuments);
        const requestedDepth = Math.max(
            SEARCH_RERANK_DEFAULT_CANDIDATE_DEPTH,
            Math.ceil(Math.max(1, Math.floor(input.requestedLimit))
                * SEARCH_RERANK_DEFAULT_CANDIDATE_DEPTH / SEARCH_DEFAULT_DISCLOSURE_LIMIT),
        );
        budget = Math.min(candidatePool.length, capacity, requestedDepth);
        if (candidatePool.length <= budget) {
            budgetReason = "complete_family_pool";
        } else if (capacity <= requestedDepth) {
            budgetReason = providerMaximumDocuments < SEARCH_RERANK_TOP_K
                ? "provider_limit"
                : "global_limit";
        } else {
            budgetReason = "family_ambiguity";
        }
    } else {
        const requestedLimit = Math.max(1, Math.floor(input.requestedLimit));
        const ambiguous = pool.familyCount > requestedLimit;
        const adaptiveBudget = ambiguous
            ? Math.max(
                SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES,
                requestedLimit * SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT,
            )
            : requestedLimit * SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT;
        budget = Math.min(SEARCH_RERANK_TOP_K, candidatePool.length, adaptiveBudget);
        if (candidatePool.length <= budget) {
            budgetReason = "complete_family_pool";
        } else {
            budgetReason = SEARCH_RERANK_TOP_K < adaptiveBudget
                ? "global_limit"
                : "family_ambiguity";
        }
    }

    let selected = candidatePool.slice(0, budget);
    if (preferred.length > 0) {
        const selectedSet = new Set(preferred.slice(0, Math.floor(budget / 2)));
        for (const candidate of candidatePool) {
            if (selectedSet.size >= budget) break;
            selectedSet.add(candidate);
        }
        selected = input.candidates.filter((candidate) => selectedSet.has(candidate));
    }
    return {
        selected,
        familyCount: pool.familyCount,
        supplementalCandidateCount: pool.supplementalCandidateCount + candidatePool.length - pool.candidates.length,
        candidatePoolCount: candidatePool.length,
        budget,
        budgetReason,
    };
}

export function selectRerankInputWithinUtf8Budget<T>(input: {
    candidates: readonly T[];
    documents: readonly string[];
    maxInputBytes: number;
}): RerankInputByteSelection<T> {
    if (input.candidates.length !== input.documents.length) {
        throw new Error("Reranker candidates and documents must have equal lengths.");
    }
    if (!Number.isSafeInteger(input.maxInputBytes) || input.maxInputBytes <= 0) {
        throw new Error("Reranker input byte budget must be a positive safe integer.");
    }

    let inputBytes = 0;
    let selectedCount = 0;
    for (const document of input.documents) {
        const documentBytes = Buffer.byteLength(document, "utf8");
        if (inputBytes + documentBytes > input.maxInputBytes) {
            break;
        }
        inputBytes += documentBytes;
        selectedCount += 1;
    }

    return {
        candidates: input.candidates.slice(0, selectedCount),
        documents: input.documents.slice(0, selectedCount),
        inputBytes,
        omittedCandidateCount: input.candidates.length - selectedCount,
    };
}
