import { isDeepStrictEqual } from 'node:util';

import type { VectorCandidate } from '../vectordb';
import { compareContractStrings } from '../utils/compare-contract-strings';

type RankedCandidate = {
    document: VectorCandidate['document'];
    score: number;
};

/** Backend-arm RRF constant. MCP multi-pass fusion has a separate constant. */
export const VECTOR_CANDIDATE_RRF_K_V1 = 100;

function assertValidCandidate(candidate: VectorCandidate): void {
    if (candidate.document.id.length === 0) {
        throw new Error('Vector candidate document ID must be non-empty.');
    }
    if (!Number.isFinite(candidate.score)) {
        throw new Error(`Vector candidate '${candidate.document.id}' has a non-finite score.`);
    }
}

function documentsMatch(
    left: VectorCandidate['document'],
    right: VectorCandidate['document'],
): boolean {
    return left.id === right.id
        && left.relativePath === right.relativePath
        && left.startLine === right.startLine
        && left.endLine === right.endLine
        && left.fileExtension === right.fileExtension
        && left.content === right.content
        && isDeepStrictEqual(left.metadata, right.metadata);
}

function assertMatchingDocument(
    existing: VectorCandidate['document'],
    candidate: VectorCandidate['document'],
): void {
    if (!documentsMatch(existing, candidate)) {
        throw new Error(`Vector candidate '${candidate.id}' has conflicting document payloads.`);
    }
}

export function orderVectorCandidateArm(arm: readonly VectorCandidate[]): VectorCandidate[] {
    for (const candidate of arm) assertValidCandidate(candidate);
    return [...arm].sort((left, right) => (
        right.score - left.score
        || compareContractStrings(left.document.id, right.document.id)
    ));
}

export function vectorCandidateOwnerId(candidate: VectorCandidate): string {
    const ownerSymbolInstanceId = candidate.document.metadata.ownerSymbolInstanceId;
    return typeof ownerSymbolInstanceId === 'string' && ownerSymbolInstanceId.length > 0
        ? JSON.stringify(['symbol', candidate.document.relativePath, ownerSymbolInstanceId])
        : JSON.stringify(['file', candidate.document.relativePath]);
}

export function fuseVectorCandidatesWithRrf(input: {
    readonly dense: readonly VectorCandidate[];
    readonly lexical: readonly VectorCandidate[];
    /**
     * Any-terms lexical arm for backends whose primary lexical request ANDs
     * every query term. It is fused as an ordinary arm, so it may open files
     * dense retrieval missed (as provider-sparse BM25 retrieval does), and a
     * row that matches all terms also collects the fallback contribution.
     */
    readonly lexicalFallback?: readonly VectorCandidate[];
    /**
     * Retrieval limit the fallback arm was requested with. An all-terms row is
     * in the any-terms match set by construction, so when the fallback arm
     * filled this limit and cut the row off, the row is credited the first
     * rank past the cut: the most the untruncated arm could have given it.
     * Without the limit, truncation is unknown and no credit is given.
     */
    readonly lexicalFallbackLimit?: number;
    readonly k: number;
    readonly limit: number;
}): VectorCandidate[] {
    if (!Number.isFinite(input.k) || input.k <= 0) {
        throw new Error('RRF k must be a positive finite number.');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
        throw new Error('RRF result limit must be a non-negative safe integer.');
    }
    if (input.lexicalFallbackLimit !== undefined
        && (!Number.isSafeInteger(input.lexicalFallbackLimit) || input.lexicalFallbackLimit <= 0)) {
        throw new Error('RRF lexical fallback limit must be a positive safe integer.');
    }

    const candidatesById = new Map<string, RankedCandidate>();
    const scoresByOwner = new Map<string, number>();
    const addRankedArm = (arm: readonly VectorCandidate[]): {
        readonly contributors: readonly VectorCandidate[];
        readonly ownerIds: ReadonlySet<string>;
    } => {
        const contributors: VectorCandidate[] = [];
        const seenDocumentsById = new Map<string, VectorCandidate['document']>();
        const seenOwnerIds = new Set<string>();
        let rank = 0;
        for (const candidate of orderVectorCandidateArm(arm)) {
            const priorArmDocument = seenDocumentsById.get(candidate.document.id);
            if (priorArmDocument) {
                assertMatchingDocument(priorArmDocument, candidate.document);
                continue;
            }
            seenDocumentsById.set(candidate.document.id, candidate.document);
            const ownerId = vectorCandidateOwnerId(candidate);
            if (seenOwnerIds.has(ownerId)) {
                continue;
            }
            seenOwnerIds.add(ownerId);
            contributors.push(candidate);
            rank++;
            const score = 1 / (input.k + rank);
            scoresByOwner.set(ownerId, (scoresByOwner.get(ownerId) ?? 0) + score);
            const existing = candidatesById.get(candidate.document.id);
            if (existing) {
                assertMatchingDocument(existing.document, candidate.document);
                candidatesById.set(candidate.document.id, {
                    ...existing,
                    score: existing.score + score,
                });
            } else {
                candidatesById.set(candidate.document.id, {
                    document: candidate.document,
                    score,
                });
            }
        }
        return { contributors, ownerIds: seenOwnerIds };
    };

    const dense = addRankedArm(input.dense);
    const denseRepresentatives = new Map(dense.contributors.map(candidate => (
        [vectorCandidateOwnerId(candidate), candidate.document.id]
    )));
    const lexical = addRankedArm(input.lexical);
    const lexicalOwnerIds = new Set(lexical.ownerIds);
    if (input.lexicalFallback) {
        const fallback = addRankedArm(input.lexicalFallback);
        for (const ownerId of fallback.ownerIds) lexicalOwnerIds.add(ownerId);
        if (input.lexicalFallbackLimit !== undefined
            && input.lexicalFallback.length >= input.lexicalFallbackLimit) {
            const cutScore = 1 / (input.k + fallback.ownerIds.size + 1);
            for (const candidate of lexical.contributors) {
                // An owner the fallback arm already ranked keeps that rank.
                if (fallback.ownerIds.has(vectorCandidateOwnerId(candidate))) continue;
                const existing = candidatesById.get(candidate.document.id)!;
                candidatesById.set(candidate.document.id, {
                    ...existing,
                    score: existing.score + cutScore,
                });
                const ownerId = vectorCandidateOwnerId(candidate);
                scoresByOwner.set(ownerId, (scoresByOwner.get(ownerId) ?? 0) + cutScore);
            }
        }
    }

    return Array.from(candidatesById.values())
        .map(candidate => {
            const owner = candidate.document.metadata.ownerSymbolInstanceId;
            const ownerId = vectorCandidateOwnerId(candidate);
            // Dense and lexical retrieval corroborate the published symbol even
            // when they select different chunks. Keep both chunks as evidence.
            // Two lexical requests alone do not establish independent agreement.
            const corroborated = typeof owner === 'string' && owner.length > 0
                && dense.ownerIds.has(ownerId) && lexicalOwnerIds.has(ownerId);
            return {
                ...candidate,
                score: corroborated ? scoresByOwner.get(ownerId)! : candidate.score,
                representativeId: corroborated ? denseRepresentatives.get(ownerId)! : candidate.document.id,
            };
        })
        .sort((left, right) => (
            right.score - left.score
            || compareContractStrings(left.representativeId, right.representativeId)
            || Number(right.document.id === right.representativeId) - Number(left.document.id === left.representativeId)
            || compareContractStrings(left.document.id, right.document.id)
        ))
        .slice(0, input.limit)
        .map(({ document, score }) => ({ document, score }));
}
