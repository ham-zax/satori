import { IndexCompletionMarkerDocument } from '@zokizuan/satori-core';
import { IndexFingerprint } from '../config.js';

export type InterruptedIndexingRecoveryDecision =
    | {
        action: 'promote_indexed';
        reason: 'valid_marker' | 'valid_marker_runtime_mismatch';
        stats: {
            indexedFiles: number;
            totalChunks: number;
            status: 'completed';
        };
        indexFingerprint: IndexFingerprint;
    }
    | {
        action: 'mark_failed';
        reason: 'missing_marker' | 'invalid_marker_payload';
        message: string;
    };

function fingerprintsMatch(a: IndexCompletionMarkerDocument['fingerprint'], b: IndexFingerprint): boolean {
    return a.embeddingProvider === b.embeddingProvider
        && a.embeddingModel === b.embeddingModel
        && Number(a.embeddingDimension) === Number(b.embeddingDimension)
        && a.vectorStoreProvider === b.vectorStoreProvider
        && a.schemaVersion === b.schemaVersion;
}

function hasValidMarkerPayload(marker: IndexCompletionMarkerDocument): boolean {
    return marker.kind === 'satori_index_completion_v1'
        && typeof marker.codebasePath === 'string'
        && marker.codebasePath.length > 0
        && Number.isFinite(Number(marker.indexedFiles))
        && Number(marker.indexedFiles) >= 0
        && Number.isFinite(Number(marker.totalChunks))
        && Number(marker.totalChunks) >= 0
        && typeof marker.completedAt === 'string'
        && !Number.isNaN(Date.parse(marker.completedAt))
        && typeof marker.runId === 'string'
        && marker.runId.length > 0;
}

function normalizeMarkerFingerprint(
    fingerprint: IndexCompletionMarkerDocument['fingerprint']
): IndexFingerprint {
    return {
        embeddingProvider: fingerprint.embeddingProvider as IndexFingerprint['embeddingProvider'],
        embeddingModel: fingerprint.embeddingModel,
        embeddingDimension: Number(fingerprint.embeddingDimension),
        vectorStoreProvider: fingerprint.vectorStoreProvider as IndexFingerprint['vectorStoreProvider'],
        schemaVersion: fingerprint.schemaVersion as IndexFingerprint['schemaVersion'],
    };
}

export function decideInterruptedIndexingRecovery(
    marker: IndexCompletionMarkerDocument | null,
    runtimeFingerprint: IndexFingerprint
): InterruptedIndexingRecoveryDecision {
    if (!marker) {
        return {
            action: 'mark_failed',
            reason: 'missing_marker',
            message: 'Interrupted indexing detected without completion marker proof.'
        };
    }

    if (!hasValidMarkerPayload(marker)) {
        return {
            action: 'mark_failed',
            reason: 'invalid_marker_payload',
            message: 'Interrupted indexing detected but completion marker payload is invalid.'
        };
    }

    if (!fingerprintsMatch(marker.fingerprint, runtimeFingerprint)) {
        return {
            action: 'promote_indexed',
            reason: 'valid_marker_runtime_mismatch',
            indexFingerprint: normalizeMarkerFingerprint(marker.fingerprint),
            stats: {
                indexedFiles: Number(marker.indexedFiles),
                totalChunks: Number(marker.totalChunks),
                status: 'completed'
            }
        };
    }

    return {
        action: 'promote_indexed',
        reason: 'valid_marker',
        indexFingerprint: normalizeMarkerFingerprint(marker.fingerprint),
        stats: {
            indexedFiles: Number(marker.indexedFiles),
            totalChunks: Number(marker.totalChunks),
            status: 'completed'
        }
    };
}
