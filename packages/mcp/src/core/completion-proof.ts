import fs from "node:fs";
import path from "node:path";
import {
    indexFingerprintsEqual,
    parseIndexFingerprint,
    type IndexFingerprint,
} from "../config.js";

export type CompletionProofOutcome = "valid" | "stale_local" | "fingerprint_mismatch" | "probe_failed";

export type CompletionProofReason =
    | "missing_marker_doc"
    | "invalid_marker_kind"
    | "path_mismatch"
    | "invalid_payload"
    | "fingerprint_mismatch"
    | "probe_failed";

export type CompletionProofValidationResult = {
    outcome: CompletionProofOutcome;
    reason?: CompletionProofReason;
    marker?: ValidatedCompletionMarker;
};

export type ValidatedCompletionMarker = {
    kind: 'satori_index_completion_v1';
    codebasePath: string;
    fingerprint: IndexFingerprint;
    indexedFiles: number;
    totalChunks: number;
    completedAt: string;
    runId: string;
    indexStatus: 'completed' | 'limit_reached';
};

export type CompletionMarkerReader = (codebasePath: string) => Promise<unknown>;

type CompletionMarkerProvider = {
    getIndexCompletionMarker: CompletionMarkerReader;
};

function isCompletionMarkerProvider(value: unknown): value is CompletionMarkerProvider {
    return typeof value === "object"
        && value !== null
        && typeof (value as { getIndexCompletionMarker?: unknown }).getIndexCompletionMarker === "function";
}

export function getCompletionMarkerReader(value: unknown): CompletionMarkerReader | undefined {
    if (!isCompletionMarkerProvider(value)) {
        return undefined;
    }
    return value.getIndexCompletionMarker.bind(value);
}

function trimTrailingSeparators(inputPath: string): string {
    const normalized = path.normalize(inputPath);
    const parsedRoot = path.parse(normalized).root;
    if (normalized === parsedRoot) {
        return normalized;
    }
    return normalized.replace(/[\\/]+$/, "");
}

function canonicalizeCodebasePath(codebasePath: string): string {
    const resolved = path.resolve(codebasePath);
    try {
        const realPath = typeof fs.realpathSync.native === "function"
            ? fs.realpathSync.native(resolved)
            : fs.realpathSync(resolved);
        return trimTrailingSeparators(realPath);
    } catch {
        return trimTrailingSeparators(resolved);
    }
}

function markerMatchesRuntimeFingerprint(
    marker: ValidatedCompletionMarker,
    runtimeFingerprint?: IndexFingerprint,
): boolean {
    if (!runtimeFingerprint || typeof runtimeFingerprint !== "object") {
        return true;
    }
    return indexFingerprintsEqual(marker.fingerprint, runtimeFingerprint);
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0;
}

export function parseCompletionMarker(
    marker: unknown,
): ValidatedCompletionMarker | null {
    if (!marker || typeof marker !== "object") {
        return null;
    }

    const record = marker as Record<string, unknown>;
    if (record.kind !== "satori_index_completion_v1") {
        return null;
    }

    if (typeof record.codebasePath !== "string" || record.codebasePath.trim().length === 0) {
        return null;
    }

    const fingerprint = parseIndexFingerprint(record.fingerprint);
    if (!fingerprint) {
        return null;
    }

    if (!isNonNegativeInteger(record.indexedFiles) || !isNonNegativeInteger(record.totalChunks)) {
        return null;
    }

    if (typeof record.completedAt !== "string" || Number.isNaN(Date.parse(record.completedAt))) {
        return null;
    }

    if (typeof record.runId !== "string" || record.runId.trim().length === 0) {
        return null;
    }

    if (record.indexStatus !== undefined
        && record.indexStatus !== 'completed'
        && record.indexStatus !== 'limit_reached') {
        return null;
    }

    return {
        kind: 'satori_index_completion_v1',
        codebasePath: record.codebasePath,
        fingerprint,
        indexedFiles: record.indexedFiles,
        totalChunks: record.totalChunks,
        completedAt: record.completedAt,
        runId: record.runId,
        indexStatus: record.indexStatus === 'limit_reached'
            ? 'limit_reached'
            : 'completed',
    };
}

function validateMarkerShape(
    expectedCodebasePath: string,
    marker: unknown,
): { ok: true; marker: ValidatedCompletionMarker } | { ok: false; reason: CompletionProofReason } {
    if (marker && typeof marker === 'object') {
        const kind = (marker as { kind?: unknown }).kind;
        if (kind !== 'satori_index_completion_v1') {
            return { ok: false, reason: 'invalid_marker_kind' };
        }
    }

    const parsedMarker = parseCompletionMarker(marker);
    if (!parsedMarker) {
        return { ok: false, reason: 'invalid_payload' };
    }

    const expectedCanonical = canonicalizeCodebasePath(expectedCodebasePath);
    const markerCanonical = canonicalizeCodebasePath(parsedMarker.codebasePath);
    if (expectedCanonical !== markerCanonical) {
        return { ok: false, reason: "path_mismatch" };
    }

    return { ok: true, marker: parsedMarker };
}

export async function validateCompletionProof(args: {
    codebasePath: string;
    runtimeFingerprint?: IndexFingerprint;
    getIndexCompletionMarker?: CompletionMarkerReader;
    onProbeError?: (error: unknown) => void;
}): Promise<CompletionProofValidationResult> {
    const { codebasePath, runtimeFingerprint, getIndexCompletionMarker, onProbeError } = args;
    if (typeof getIndexCompletionMarker !== "function") {
        return { outcome: "probe_failed", reason: "probe_failed" };
    }

    let marker: unknown;
    try {
        marker = await getIndexCompletionMarker(codebasePath);
    } catch (error) {
        onProbeError?.(error);
        return { outcome: "probe_failed", reason: "probe_failed" };
    }

    if (!marker) {
        return { outcome: "stale_local", reason: "missing_marker_doc" };
    }

    const markerShape = validateMarkerShape(codebasePath, marker);
    if (!markerShape.ok) {
        return {
            outcome: "stale_local",
            reason: markerShape.reason,
        };
    }

    if (!markerMatchesRuntimeFingerprint(markerShape.marker, runtimeFingerprint)) {
        return {
            outcome: "fingerprint_mismatch",
            reason: "fingerprint_mismatch",
            marker: markerShape.marker,
        };
    }

    return {
        outcome: "valid",
        marker: markerShape.marker,
    };
}
