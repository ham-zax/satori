import fs from "node:fs";
import path from "node:path";
import {
    indexFingerprintsEqual,
    parseIndexFingerprint,
    type IndexFingerprint,
} from "../config.js";
import type { ProvenGenerationReceipt } from "@zokizuan/satori-core";

export type CompletionProofOutcome = "valid" | "stale_local" | "fingerprint_mismatch" | "policy_incompatible" | "probe_failed";

export type CompletionProofReason =
    | "missing_marker_doc"
    | "invalid_marker_kind"
    | "legacy_policy_unsealed"
    | "path_mismatch"
    | "invalid_payload"
    | "fingerprint_mismatch"
    | "runtime_policy_incompatible"
    | "probe_failed";

export type CompletionProofValidationResult = {
    outcome: CompletionProofOutcome;
    reason?: CompletionProofReason;
    marker?: ValidatedCompletionMarker;
    collectionName?: string;
    generationReceipt?: ProvenGenerationReceipt;
    navigationStatus?: "valid" | "missing" | "incompatible" | "corrupt";
};

export type ValidatedCompletionMarker = {
    kind: 'satori_index_completion_v2';
    codebasePath: string;
    fingerprint: IndexFingerprint;
    indexedFiles: number;
    totalChunks: number;
    completedAt: string;
    runId: string;
    indexPolicyHash: string;
    indexStatus: 'completed' | 'limit_reached';
    navigationGenerationId?: string;
    symbolRegistryManifestHash?: string;
    relationshipManifestHash?: string;
};

export type CompletionMarkerReader = (codebasePath: string) => Promise<unknown>;

type CompletionMarkerEvidence =
    | {
        status: 'valid_v2';
        marker: unknown;
        collectionName?: string;
        generationReceipt?: unknown;
        navigationStatus?: "valid" | "missing" | "incompatible" | "corrupt";
    }
    | { status: 'invalid_v2' }
    | { status: 'runtime_policy_incompatible' }
    | { status: 'legacy_v1'; marker: unknown }
    | { status: 'missing' };

type CompletionMarkerProvider = {
    getIndexCompletionMarker?: CompletionMarkerReader;
    getIndexCompletionMarkerForValidation?: CompletionMarkerReader;
};

function isCompletionMarkerProvider(value: unknown): value is CompletionMarkerProvider {
    return typeof value === "object"
        && value !== null
        && (
            typeof (value as { getIndexCompletionMarkerForValidation?: unknown }).getIndexCompletionMarkerForValidation === "function"
            || typeof (value as { getIndexCompletionMarker?: unknown }).getIndexCompletionMarker === "function"
        );
}

export function getCompletionMarkerReader(value: unknown): CompletionMarkerReader | undefined {
    if (!isCompletionMarkerProvider(value)) {
        return undefined;
    }
    if (typeof value.getIndexCompletionMarkerForValidation === 'function') {
        return value.getIndexCompletionMarkerForValidation.bind(value);
    }
    return value.getIndexCompletionMarker?.bind(value);
}

function parseCompletionMarkerEvidence(value: unknown): CompletionMarkerEvidence | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.status === 'valid_v2' && 'marker' in record) {
        return {
            status: 'valid_v2',
            marker: record.marker,
            ...(typeof record.collectionName === 'string' && record.collectionName.length > 0
                ? { collectionName: record.collectionName }
                : {}),
            ...(record.generationReceipt !== undefined
                ? { generationReceipt: record.generationReceipt }
                : {}),
            ...(isNavigationStatus((record.navigationProof as { status?: unknown } | undefined)?.status)
                ? { navigationStatus: (record.navigationProof as { status: "valid" | "missing" | "incompatible" | "corrupt" }).status }
                : {}),
        };
    }
    if (record.status === 'invalid_v2') {
        return { status: 'invalid_v2' };
    }
    if (record.status === 'runtime_policy_incompatible') {
        return { status: 'runtime_policy_incompatible' };
    }
    if (record.status === 'legacy_v1' && 'marker' in record) {
        return { status: 'legacy_v1', marker: record.marker };
    }
    if (record.status === 'missing') return { status: 'missing' };
    return null;
}

function isNavigationStatus(value: unknown): value is "valid" | "missing" | "incompatible" | "corrupt" {
    return value === "valid" || value === "missing" || value === "incompatible" || value === "corrupt";
}

function cloneProvenGenerationReceipt(
    value: unknown,
    expectedCodebasePath: string,
    expectedCollectionName: string,
    expectedMarker: ValidatedCompletionMarker,
): ProvenGenerationReceipt | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const policy = record.policy as Record<string, unknown> | undefined;
    const observations = record.observations as Record<string, unknown> | undefined;
    const receiptMarker = parseCompletionMarker(record.marker);
    const stringArrays = [
        policy?.customExtensions,
        policy?.customIgnorePatterns,
        policy?.fileBasedIgnorePatterns,
        policy?.supportedExtensions,
        policy?.effectiveIgnorePatterns,
    ];
    if (
        record.collectionName !== expectedCollectionName
        || typeof record.policyDocumentDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(record.policyDocumentDigest)
        || !Number.isSafeInteger(record.exactPayloadCount)
        || Number(record.exactPayloadCount) !== expectedMarker.totalChunks
        || !receiptMarker
        || JSON.stringify(receiptMarker) !== JSON.stringify(expectedMarker)
        || !policy
        || typeof policy.canonicalRoot !== "string"
        || canonicalizeCodebasePath(policy.canonicalRoot) !== canonicalizeCodebasePath(expectedCodebasePath)
        || (policy.profile !== "default" && policy.profile !== "minimal" && policy.profile !== "all-text")
        || typeof policy.policyHash !== "string"
        || policy.policyHash !== expectedMarker.indexPolicyHash
        || !stringArrays.every((array) => Array.isArray(array) && array.every((entry) => typeof entry === "string"))
        || !observations
        || (observations.profileFileToken !== null && typeof observations.profileFileToken !== "string")
        || typeof observations.policyFileToken !== "string"
        || (observations.navigationToken !== null && typeof observations.navigationToken !== "string")
    ) return null;
    const navigation = record.navigation as Record<string, unknown> | null | undefined;
    if (expectedMarker.navigationGenerationId) {
        if (
            !navigation
            || navigation.generationId !== expectedMarker.navigationGenerationId
            || navigation.symbolRegistryManifestHash !== expectedMarker.symbolRegistryManifestHash
            || navigation.relationshipManifestHash !== expectedMarker.relationshipManifestHash
            || typeof navigation.generationRoot !== "string"
            || navigation.generationRoot.length === 0
            || typeof observations.navigationToken !== "string"
        ) return null;
    } else if (navigation !== null || observations.navigationToken !== null) {
        return null;
    }
    return structuredClone(value) as ProvenGenerationReceipt;
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
    if (record.kind !== "satori_index_completion_v2") {
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
    if (typeof record.indexPolicyHash !== "string" || record.indexPolicyHash.length === 0) {
        return null;
    }

    if (record.indexStatus !== undefined
        && record.indexStatus !== 'completed'
        && record.indexStatus !== 'limit_reached') {
        return null;
    }
    const navigationFields = [
        record.navigationGenerationId,
        record.symbolRegistryManifestHash,
        record.relationshipManifestHash,
    ];
    if (
        navigationFields.some((value) => value !== undefined)
        && !navigationFields.every((value) => typeof value === 'string' && value.length > 0)
    ) {
        return null;
    }

    return {
        kind: 'satori_index_completion_v2',
        codebasePath: record.codebasePath,
        fingerprint,
        indexedFiles: record.indexedFiles,
        totalChunks: record.totalChunks,
        completedAt: record.completedAt,
        runId: record.runId,
        indexPolicyHash: record.indexPolicyHash,
        indexStatus: record.indexStatus === 'limit_reached'
            ? 'limit_reached'
            : 'completed',
        ...(typeof record.navigationGenerationId === 'string' ? {
            navigationGenerationId: record.navigationGenerationId,
            symbolRegistryManifestHash: record.symbolRegistryManifestHash as string,
            relationshipManifestHash: record.relationshipManifestHash as string,
        } : {}),
    };
}

function validateMarkerShape(
    expectedCodebasePath: string,
    marker: unknown,
): { ok: true; marker: ValidatedCompletionMarker } | { ok: false; reason: CompletionProofReason } {
    if (marker && typeof marker === 'object') {
        const kind = (marker as { kind?: unknown }).kind;
        if (kind === 'satori_index_completion_v1') {
            return { ok: false, reason: 'legacy_policy_unsealed' };
        }
        if (kind !== 'satori_index_completion_v2') {
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

    const evidence = parseCompletionMarkerEvidence(marker);
    if (evidence?.status === 'invalid_v2') {
        return { outcome: 'stale_local', reason: 'invalid_payload' };
    }
    if (evidence?.status === 'runtime_policy_incompatible') {
        return { outcome: 'policy_incompatible', reason: 'runtime_policy_incompatible' };
    }
    if (evidence?.status === 'missing') {
        marker = null;
    } else if (evidence?.status === 'legacy_v1' || evidence?.status === 'valid_v2') {
        marker = evidence.marker;
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

    const generationReceipt = evidence?.status === "valid_v2"
        && evidence.collectionName
        && evidence.generationReceipt !== undefined
        ? cloneProvenGenerationReceipt(
            evidence.generationReceipt,
            codebasePath,
            evidence.collectionName,
            markerShape.marker,
        )
        : null;

    return {
        outcome: "valid",
        marker: markerShape.marker,
        ...(evidence?.status === "valid_v2" && evidence.collectionName
            ? { collectionName: evidence.collectionName }
            : {}),
        ...(generationReceipt
            ? { generationReceipt }
            : {}),
        ...(evidence?.status === "valid_v2" && evidence.navigationStatus
            ? { navigationStatus: evidence.navigationStatus }
            : {}),
    };
}
