import { isDeepStrictEqual } from 'node:util';

import type { VectorCandidate } from '../vectordb';
import { compareContractStrings } from '../utils/compare-contract-strings';

type RankedCandidate = {
    document: VectorCandidate['document'];
    score: number;
};

/** Backend-arm RRF policy v1. MCP multi-pass fusion has a separate policy. */
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

export function fuseVectorCandidatesWithRrf(input: {
    readonly dense: readonly VectorCandidate[];
    readonly lexical: readonly VectorCandidate[];
    readonly k: number;
    readonly limit: number;
}): VectorCandidate[] {
    if (!Number.isFinite(input.k) || input.k <= 0) {
        throw new Error('RRF k must be a positive finite number.');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
        throw new Error('RRF result limit must be a non-negative safe integer.');
    }

    const candidatesById = new Map<string, RankedCandidate>();
    const addRankedArm = (arm: readonly VectorCandidate[]): void => {
        const seenDocumentsById = new Map<string, VectorCandidate['document']>();
        let rank = 0;
        for (const candidate of orderVectorCandidateArm(arm)) {
            const priorArmDocument = seenDocumentsById.get(candidate.document.id);
            if (priorArmDocument) {
                assertMatchingDocument(priorArmDocument, candidate.document);
                continue;
            }
            seenDocumentsById.set(candidate.document.id, candidate.document);
            rank++;
            const score = 1 / (input.k + rank);
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
    };

    addRankedArm(input.dense);
    addRankedArm(input.lexical);

    return Array.from(candidatesById.values())
        .sort((left, right) => (
            right.score - left.score
            || compareContractStrings(left.document.id, right.document.id)
        ))
        .slice(0, input.limit)
        .map(({ document, score }) => ({ document, score }));
}
