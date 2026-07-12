import { IndexCompletionMarkerDocument } from '@zokizuan/satori-core';
import {
    IndexFingerprint,
    indexFingerprintsEqual,
} from '../config.js';
import { parseCompletionMarker } from './completion-proof.js';

export type InterruptedIndexingRecoveryDecision =
    | {
        action: 'promote_indexed';
        reason: 'valid_marker' | 'valid_marker_runtime_mismatch';
        stats: {
            indexedFiles: number;
            totalChunks: number;
            /** Preserved from marker.indexStatus; legacy markers without the field are completed. */
            status: 'completed' | 'limit_reached';
        };
        indexFingerprint: IndexFingerprint;
    }
    | {
        action: 'mark_failed';
        reason: 'missing_marker' | 'invalid_marker_payload';
        message: string;
    };

function resolveMarkerIndexStatus(
    marker: IndexCompletionMarkerDocument,
): 'completed' | 'limit_reached' {
    return marker.indexStatus === 'limit_reached' ? 'limit_reached' : 'completed';
}

function fingerprintsMatch(a: IndexCompletionMarkerDocument['fingerprint'], b: IndexFingerprint): boolean {
    return indexFingerprintsEqual(a as IndexFingerprint, b);
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

    const parsedMarker = parseCompletionMarker(marker);
    if (!parsedMarker) {
        return {
            action: 'mark_failed',
            reason: 'invalid_marker_payload',
            message: 'Interrupted indexing detected but completion marker payload is invalid.'
        };
    }

    const indexStatus = resolveMarkerIndexStatus(parsedMarker);
    const indexFingerprint = parsedMarker.fingerprint;

    if (!fingerprintsMatch(parsedMarker.fingerprint, runtimeFingerprint)) {
        return {
            action: 'promote_indexed',
            reason: 'valid_marker_runtime_mismatch',
            indexFingerprint,
            stats: {
                indexedFiles: parsedMarker.indexedFiles,
                totalChunks: parsedMarker.totalChunks,
                status: indexStatus,
            }
        };
    }

    return {
        action: 'promote_indexed',
        reason: 'valid_marker',
        indexFingerprint,
        stats: {
            indexedFiles: parsedMarker.indexedFiles,
            totalChunks: parsedMarker.totalChunks,
            status: indexStatus,
        }
    };
}
