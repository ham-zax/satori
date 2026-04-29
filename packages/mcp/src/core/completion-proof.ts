import fs from "node:fs";
import path from "node:path";
import type { IndexFingerprint } from "../config.js";

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
    marker?: {
        kind?: string;
        codebasePath?: string;
        fingerprint?: unknown;
        indexedFiles?: number;
        totalChunks?: number;
        completedAt?: string;
        runId?: string;
    };
};

export type CompletionMarkerReader = (codebasePath: string) => Promise<unknown>;

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

function markerMatchesRuntimeFingerprint(marker: unknown, runtimeFingerprint?: IndexFingerprint): boolean {
    if (!runtimeFingerprint || typeof runtimeFingerprint !== "object") {
        return true;
    }
    const fingerprint = (marker as { fingerprint?: unknown } | null)?.fingerprint;
    if (!fingerprint || typeof fingerprint !== "object") {
        return false;
    }
    const record = fingerprint as Record<string, unknown>;
    return record.embeddingProvider === runtimeFingerprint.embeddingProvider
        && record.embeddingModel === runtimeFingerprint.embeddingModel
        && Number(record.embeddingDimension) === Number(runtimeFingerprint.embeddingDimension)
        && record.vectorStoreProvider === runtimeFingerprint.vectorStoreProvider
        && record.schemaVersion === runtimeFingerprint.schemaVersion;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number"
        && Number.isInteger(value)
        && value >= 0;
}

function validateMarkerShape(
    expectedCodebasePath: string,
    marker: unknown
): { ok: true } | { ok: false; reason: CompletionProofReason } {
    if (!marker || typeof marker !== "object") {
        return { ok: false, reason: "invalid_payload" };
    }

    const record = marker as Record<string, unknown>;
    if (record.kind !== "satori_index_completion_v1") {
        return { ok: false, reason: "invalid_marker_kind" };
    }

    if (typeof record.codebasePath !== "string" || record.codebasePath.trim().length === 0) {
        return { ok: false, reason: "invalid_payload" };
    }

    if (!record.fingerprint || typeof record.fingerprint !== "object") {
        return { ok: false, reason: "invalid_payload" };
    }

    if (!isNonNegativeInteger(record.indexedFiles) || !isNonNegativeInteger(record.totalChunks)) {
        return { ok: false, reason: "invalid_payload" };
    }

    if (typeof record.completedAt !== "string" || Number.isNaN(Date.parse(record.completedAt))) {
        return { ok: false, reason: "invalid_payload" };
    }

    const expectedCanonical = canonicalizeCodebasePath(expectedCodebasePath);
    const markerCanonical = canonicalizeCodebasePath(record.codebasePath);
    if (expectedCanonical !== markerCanonical) {
        return { ok: false, reason: "path_mismatch" };
    }

    return { ok: true };
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
            marker: marker as CompletionProofValidationResult["marker"]
        };
    }

    if (!markerMatchesRuntimeFingerprint(marker, runtimeFingerprint)) {
        return {
            outcome: "fingerprint_mismatch",
            reason: "fingerprint_mismatch",
            marker: marker as CompletionProofValidationResult["marker"]
        };
    }

    return {
        outcome: "valid",
        marker: marker as CompletionProofValidationResult["marker"]
    };
}
