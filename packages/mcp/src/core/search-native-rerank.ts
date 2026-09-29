import type { RerankResult } from "@satori-code/core";

export type ValidatedNativeRerankItem = Readonly<{
    candidateId: string;
    originalIndex: number;
    providerRank: number;
    relevanceScore: number;
}>;

function fail(code: string): never {
    throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function validateNativeRerankResults(input: {
    candidateIds: readonly string[];
    results: readonly RerankResult[];
}): readonly ValidatedNativeRerankItem[] {
    const candidateIds = [...input.candidateIds];
    const candidateIdSet = new Set<string>();
    for (const candidateId of candidateIds) {
        if (typeof candidateId !== "string" || candidateId.trim().length === 0) {
            fail("native_rerank_candidate_ids_invalid");
        }
        if (candidateIdSet.has(candidateId)) {
            fail("native_rerank_candidate_ids_invalid");
        }
        candidateIdSet.add(candidateId);
    }

    if (input.results.length !== candidateIds.length) {
        fail("native_rerank_result_count_mismatch");
    }

    const seenIndices = new Set<number>();
    const validated: ValidatedNativeRerankItem[] = [];
    for (let providerPosition = 0; providerPosition < input.results.length; providerPosition += 1) {
        const result: unknown = input.results[providerPosition];
        if (!isRecord(result)) {
            fail("native_rerank_result_index_invalid");
        }
        const originalIndex = result.index;
        if (
            typeof originalIndex !== "number"
            || !Number.isInteger(originalIndex)
            || originalIndex < 0
            || originalIndex >= candidateIds.length
        ) {
            fail("native_rerank_result_index_invalid");
        }
        if (seenIndices.has(originalIndex)) {
            fail("native_rerank_result_duplicate_index");
        }
        seenIndices.add(originalIndex);

        const relevanceScore = result.relevanceScore;
        if (typeof relevanceScore !== "number" || !Number.isFinite(relevanceScore)) {
            fail("native_rerank_result_non_finite_score");
        }
        validated.push({
            candidateId: candidateIds[originalIndex]!,
            originalIndex,
            providerRank: providerPosition + 1,
            relevanceScore,
        });
    }

    if (seenIndices.size !== candidateIds.length) {
        fail("native_rerank_result_incomplete");
    }
    return validated;
}

export function applyNativeRerankToSelectedSlots<T>(input: {
    allCandidates: readonly T[];
    selectedCandidateIds: readonly string[];
    orderedItems: readonly ValidatedNativeRerankItem[];
    identify: (candidate: T) => string;
}): T[] {
    const selectedIds = [...input.selectedCandidateIds];
    const selectedIdSet = new Set<string>();
    for (const candidateId of selectedIds) {
        if (candidateId.trim().length === 0 || selectedIdSet.has(candidateId)) {
            fail("native_rerank_selected_candidate_ids_invalid");
        }
        selectedIdSet.add(candidateId);
    }
    if (input.orderedItems.length !== selectedIds.length) {
        fail("native_rerank_result_incomplete");
    }

    const candidateSlotById = new Map<string, number>();
    for (let slot = 0; slot < input.allCandidates.length; slot += 1) {
        const candidateId = input.identify(input.allCandidates[slot]!);
        if (candidateSlotById.has(candidateId)) {
            fail("native_rerank_candidate_identity_duplicate");
        }
        candidateSlotById.set(candidateId, slot);
    }

    const selectedSlots = selectedIds.map((candidateId) => {
        const slot = candidateSlotById.get(candidateId);
        if (slot === undefined) {
            fail("native_rerank_selected_candidate_missing");
        }
        return slot;
    });

    const orderedIds = input.orderedItems.map((item) => item.candidateId);
    const orderedIdSet = new Set<string>();
    for (const candidateId of orderedIds) {
        if (!selectedIdSet.has(candidateId)) {
            fail("native_rerank_result_foreign_candidate");
        }
        if (orderedIdSet.has(candidateId)) {
            fail("native_rerank_result_duplicate_candidate");
        }
        orderedIdSet.add(candidateId);
    }
    if (orderedIdSet.size !== selectedIdSet.size) {
        fail("native_rerank_result_incomplete");
    }

    const reordered = [...input.allCandidates];
    for (let index = 0; index < selectedSlots.length; index += 1) {
        const targetSlot = selectedSlots[index]!;
        const candidateId = orderedIds[index]!;
        const sourceSlot = candidateSlotById.get(candidateId);
        if (sourceSlot === undefined) {
            fail("native_rerank_result_foreign_candidate");
        }
        reordered[targetSlot] = input.allCandidates[sourceSlot]!;
    }
    return reordered;
}
