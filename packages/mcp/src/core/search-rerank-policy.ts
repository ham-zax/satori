import type { SemanticSearchResult } from "@zokizuan/satori-core";
import {
    SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT,
    SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT,
    SEARCH_RERANK_MAX_SUPPLEMENTAL_CHUNKS_PER_FAMILY,
    SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES,
    SEARCH_RERANK_TOP_K,
} from "./search-constants.js";

export type RerankBudgetReason =
    | "complete_family_pool"
    | "family_ambiguity";

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

export function selectRerankCandidates<T extends RerankCandidateLike>(input: {
    candidates: readonly T[];
    requestedLimit: number;
}): RerankCandidateSelection<T> {
    const representatives: T[] = [];
    const representedFamilies = new Set<string>();
    const supplementalByFamily = new Map<string, T[]>();

    for (const candidate of input.candidates) {
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
    const requestedLimit = Math.max(1, Math.floor(input.requestedLimit));
    const ambiguous = representatives.length > requestedLimit;
    const adaptiveBudget = ambiguous
        ? Math.max(
            SEARCH_RERANK_MIN_AMBIGUOUS_CANDIDATES,
            requestedLimit * SEARCH_RERANK_AMBIGUOUS_CANDIDATES_PER_RESULT,
        )
        : requestedLimit * SEARCH_RERANK_BOUNDED_CANDIDATES_PER_RESULT;
    const budget = Math.min(SEARCH_RERANK_TOP_K, candidatePool.length, adaptiveBudget);
    const budgetReason: RerankBudgetReason = candidatePool.length <= adaptiveBudget
        ? "complete_family_pool"
        : "family_ambiguity";

    return {
        selected: candidatePool.slice(0, budget),
        familyCount: representatives.length,
        supplementalCandidateCount: supplementalCandidates.length,
        candidatePoolCount: candidatePool.length,
        budget,
        budgetReason,
    };
}
