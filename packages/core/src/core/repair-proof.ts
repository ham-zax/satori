import type { IndexCompletionFingerprint } from '../vectordb/types';

export type RepairProofStatus =
    | 'matched'
    | 'failed'
    | 'missing'
    | 'unproven'
    | 'not_checked';

export interface RepairProofItem {
    status: RepairProofStatus;
    basis?: string;
    expectedCount?: number;
    observedCount?: number;
    missingCount?: number;
    extraCount?: number;
}

export interface RepairProof {
    collection: RepairProofItem;
    snapshot: RepairProofItem;
    marker: RepairProofItem;
    fingerprint: RepairProofItem;
    payload: RepairProofItem;
    staleRemoteChunks: RepairProofItem;
    navigation: RepairProofItem;
}

export interface RepairSnapshotEvidence {
    status: 'missing' | 'unproven' | 'verified';
    basis: string;
    fingerprint?: IndexCompletionFingerprint;
}

export interface RepairIndexResult {
    status: 'ok' | 'blocked' | 'requires_reindex';
    reason?: 'needs_create' | 'requires_reindex';
    message: string;
    proof: RepairProof;
    missingCount?: number;
    warnings?: string[];
    indexedFiles?: number;
    totalChunks?: number;
    trackedRelativePaths?: string[];
    collectionName?: string;
}
