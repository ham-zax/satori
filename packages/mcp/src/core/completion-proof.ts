import fs from "node:fs";
import path from "node:path";
import {
    indexFingerprintsEqual,
    parseIndexFingerprint,
    type IndexFingerprint,
} from "../config.js";
import {
    type CanonicalCompletionFingerprint,
    inspectCompletionMarker,
    type ProvenGenerationReceipt,
    type ProvenVectorGenerationReceipt,
} from "@zokizuan/satori-core";

export type CompletionProofOutcome = "valid" | "stale_local" | "fingerprint_mismatch" | "policy_incompatible" | "probe_failed";

export type CompletionProofReason =
    | "missing_marker_doc"
    | "invalid_marker_kind"
    | "requires_reindex"
    | "unsupported_authority"
    | "path_mismatch"
    | "invalid_payload"
    | "fingerprint_mismatch"
    | "runtime_policy_incompatible"
    | "invalid_policy_authority"
    | "probe_failed";

type NavigationProofStatus = "valid" | "not_bound" | "missing" | "incompatible" | "corrupt" | "unverified";

export type CompletionProofValidationResult = {
    outcome: CompletionProofOutcome;
    reason?: CompletionProofReason;
    marker?: ValidatedCompletionMarker;
    collectionName?: string;
    vectorReceipt?: ProvenVectorGenerationReceipt;
    generationReceipt?: ProvenGenerationReceipt;
    navigationStatus?: NavigationProofStatus;
    exactPayloadRecounts?: number;
    proofSource?: 'activation' | 'exact' | 'joined' | 'reused';
};

export type ValidatedCompletionMarker = {
    kind: 'satori_index_completion_v3';
    codebasePath: string;
    fingerprint: CanonicalCompletionFingerprint & Pick<
        IndexFingerprint,
        'embeddingProvider' | 'vectorStoreProvider' | 'schemaVersion'
    >;
    indexedFiles: number;
    totalChunks: number;
    completedAt: string;
    runId: string;
    indexPolicyHash: string;
    indexStatus: 'completed' | 'limit_reached';
    navigation:
        | { status: 'not_bound' }
        | {
            status: 'sealed';
            generationId: string;
            symbolRegistryManifestHash: string;
            relationshipManifestHash: string;
            sealHash: string;
        };
};

export type CompletionMarkerReader = (codebasePath: string) => Promise<unknown>;

type CompletionMarkerEvidence =
    | {
        status: 'valid_v3';
        marker: unknown;
        collectionName?: string;
        vectorReceipt?: unknown;
        generationReceipt?: unknown;
        navigationStatus?: NavigationProofStatus;
        exactPayloadRecounts?: number;
        proofSource?: 'activation' | 'exact' | 'joined' | 'reused';
    }
    | { status: 'invalid_v3' }
    | { status: 'requires_reindex' }
    | { status: 'unsupported_authority' }
    | { status: 'policy_authority_invalid' }
    | { status: 'runtime_policy_incompatible' }
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
    if (record.status === 'valid_v3' && 'marker' in record) {
        return {
            status: 'valid_v3',
            marker: record.marker,
            ...(typeof record.collectionName === 'string' && record.collectionName.length > 0
                ? { collectionName: record.collectionName }
                : {}),
            ...(record.generationReceipt !== undefined
                ? { generationReceipt: record.generationReceipt }
                : {}),
            ...(record.vectorReceipt !== undefined
                ? { vectorReceipt: record.vectorReceipt }
                : {}),
            ...(Number.isSafeInteger(record.exactPayloadRecounts)
                && Number(record.exactPayloadRecounts) >= 0
                ? { exactPayloadRecounts: Number(record.exactPayloadRecounts) }
                : {}),
            ...(record.proofSource === 'activation'
                || record.proofSource === 'exact'
                || record.proofSource === 'joined'
                || record.proofSource === 'reused'
                ? { proofSource: record.proofSource }
                : {}),
            ...(isNavigationStatus((record.navigationProof as { status?: unknown } | undefined)?.status)
                ? { navigationStatus: (record.navigationProof as { status: NavigationProofStatus }).status }
                : {}),
        };
    }
    if (record.status === 'invalid_v3') {
        return { status: 'invalid_v3' };
    }
    if (record.status === 'requires_reindex') {
        return { status: 'requires_reindex' };
    }
    if (record.status === 'unsupported_authority') {
        return { status: 'unsupported_authority' };
    }
    if (record.status === 'policy_authority_invalid') {
        return { status: 'policy_authority_invalid' };
    }
    if (record.status === 'runtime_policy_incompatible') {
        return { status: 'runtime_policy_incompatible' };
    }
    if (record.status === 'missing') return { status: 'missing' };
    return null;
}

function isNavigationStatus(value: unknown): value is NavigationProofStatus {
    return value === "valid"
        || value === "not_bound"
        || value === "missing"
        || value === "incompatible"
        || value === "corrupt"
        || value === "unverified";
}

function cloneProvenVectorGenerationReceipt(
    value: unknown,
    expectedCodebasePath: string,
    expectedCollectionName: string,
    expectedMarker: ValidatedCompletionMarker,
): ProvenVectorGenerationReceipt | null {
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
    ) return null;
    return {
        collectionName: record.collectionName as string,
        marker: structuredClone(receiptMarker),
        policy: structuredClone(policy) as unknown as ProvenVectorGenerationReceipt["policy"],
        policyDocumentDigest: record.policyDocumentDigest as string,
        exactPayloadCount: record.exactPayloadCount as number,
        observations: {
            profileFileToken: observations.profileFileToken as string | null,
            policyFileToken: observations.policyFileToken as string,
        },
    };
}

function cloneProvenGenerationReceipt(
    value: unknown,
    expectedCodebasePath: string,
    expectedCollectionName: string,
    expectedMarker: ValidatedCompletionMarker,
): ProvenGenerationReceipt | null {
    const vectorReceipt = cloneProvenVectorGenerationReceipt(
        value,
        expectedCodebasePath,
        expectedCollectionName,
        expectedMarker,
    );
    if (!vectorReceipt || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const observations = record.observations as Record<string, unknown>;
    if (observations.navigationToken !== null && typeof observations.navigationToken !== "string") return null;
    const navigation = record.navigation as Record<string, unknown> | null | undefined;
    if (expectedMarker.navigation.status !== 'sealed') return null;
    if (
        !navigation
        || navigation.generationId !== expectedMarker.navigation.generationId
        || navigation.symbolRegistryManifestHash !== expectedMarker.navigation.symbolRegistryManifestHash
        || navigation.relationshipManifestHash !== expectedMarker.navigation.relationshipManifestHash
        || navigation.navigationSealHash !== expectedMarker.navigation.sealHash
        || typeof navigation.generationRoot !== "string"
        || navigation.generationRoot.length === 0
        || typeof observations.navigationToken !== "string"
    ) return null;
    return {
        ...vectorReceipt,
        navigation: {
            generationId: navigation.generationId as string,
            generationRoot: navigation.generationRoot,
            symbolRegistryManifestHash: navigation.symbolRegistryManifestHash as string,
            relationshipManifestHash: navigation.relationshipManifestHash as string,
            navigationSealHash: navigation.navigationSealHash as string,
        },
        observations: {
            ...vectorReceipt.observations,
            navigationToken: observations.navigationToken,
        },
    };
}

function reconcileNavigationEvidence(
    marker: ValidatedCompletionMarker,
    evidence: CompletionMarkerEvidence | null,
    generationReceipt: ProvenGenerationReceipt | null,
): { ok: true; status: NavigationProofStatus } | { ok: false } {
    const structuredEvidence = evidence?.status === "valid_v3" ? evidence : null;
    const suppliedStatus = structuredEvidence?.navigationStatus;
    const generationReceiptSupplied = structuredEvidence?.generationReceipt !== undefined;

    if (marker.navigation.status === "not_bound") {
        if (
            generationReceiptSupplied
            || (suppliedStatus !== undefined && suppliedStatus !== "not_bound")
        ) {
            return { ok: false };
        }
        return { ok: true, status: "not_bound" };
    }

    if (suppliedStatus === "not_bound") {
        return { ok: false };
    }
    if (suppliedStatus === "valid" && !generationReceipt) {
        return { ok: false };
    }
    if (
        generationReceipt
        && suppliedStatus !== undefined
        && suppliedStatus !== "valid"
    ) {
        return { ok: false };
    }
    if (generationReceipt) {
        return { ok: true, status: "valid" };
    }
    return { ok: true, status: suppliedStatus ?? "unverified" };
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

export function parseCompletionMarker(
    marker: unknown,
): ValidatedCompletionMarker | null {
    const inspected = inspectCompletionMarker(marker);
    if (inspected.status !== 'current') return null;
    const fingerprint = parseIndexFingerprint(inspected.value.fingerprint);
    if (
        !fingerprint
        || typeof fingerprint.parserVersion !== 'string'
        || fingerprint.parserVersion.length === 0
        || typeof fingerprint.extractorVersion !== 'string'
        || fingerprint.extractorVersion.length === 0
        || typeof fingerprint.relationshipVersion !== 'string'
        || fingerprint.relationshipVersion.length === 0
    ) return null;
    return {
        ...inspected.value,
        fingerprint: fingerprint as ValidatedCompletionMarker['fingerprint'],
        navigation: { ...inspected.value.navigation },
    };
}

function validateMarkerShape(
    expectedCodebasePath: string,
    marker: unknown,
): { ok: true; marker: ValidatedCompletionMarker } | { ok: false; reason: CompletionProofReason } {
    if (marker && typeof marker === 'object') {
        const kind = (marker as { kind?: unknown }).kind;
        if (kind === 'satori_index_completion_v1' || kind === 'satori_index_completion_v2') {
            return { ok: false, reason: 'requires_reindex' };
        }
        const futureVersion = typeof kind === 'string'
            ? /^satori_index_completion_v([1-9]\d*)$/.exec(kind)
            : null;
        if (futureVersion && Number(futureVersion[1]) > 3) {
            return { ok: false, reason: 'unsupported_authority' };
        }
        if (kind !== 'satori_index_completion_v3') {
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
    if (evidence?.status === 'invalid_v3') {
        return { outcome: 'stale_local', reason: 'invalid_payload' };
    }
    if (evidence?.status === 'requires_reindex') {
        return { outcome: 'stale_local', reason: 'requires_reindex' };
    }
    if (evidence?.status === 'unsupported_authority') {
        return { outcome: 'stale_local', reason: 'unsupported_authority' };
    }
    if (evidence?.status === 'policy_authority_invalid') {
        return { outcome: 'policy_incompatible', reason: 'invalid_policy_authority' };
    }
    if (evidence?.status === 'runtime_policy_incompatible') {
        return { outcome: 'policy_incompatible', reason: 'runtime_policy_incompatible' };
    }
    if (evidence?.status === 'missing') {
        marker = null;
    } else if (evidence?.status === 'valid_v3') {
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

    const generationReceipt = evidence?.status === "valid_v3"
        && evidence.collectionName
        && evidence.generationReceipt !== undefined
        ? cloneProvenGenerationReceipt(
            evidence.generationReceipt,
            codebasePath,
            evidence.collectionName,
            markerShape.marker,
        )
        : null;
    const clonedVectorReceipt = evidence?.status === "valid_v3"
        && evidence.collectionName
        && evidence.vectorReceipt !== undefined
        ? cloneProvenVectorGenerationReceipt(
            evidence.vectorReceipt,
            codebasePath,
            evidence.collectionName,
            markerShape.marker,
        )
        : null;
    const vectorReceipt = clonedVectorReceipt ?? generationReceipt;
    const navigationEvidence = reconcileNavigationEvidence(
        markerShape.marker,
        evidence,
        generationReceipt,
    );
    if (!navigationEvidence.ok) {
        return {
            outcome: "stale_local",
            reason: "invalid_payload",
        };
    }

    return {
        outcome: "valid",
        marker: markerShape.marker,
        ...(evidence?.status === "valid_v3" && evidence.collectionName
            ? { collectionName: evidence.collectionName }
            : {}),
        ...(generationReceipt
            ? { generationReceipt }
            : {}),
        ...(vectorReceipt
            ? { vectorReceipt }
            : {}),
        navigationStatus: navigationEvidence.status,
        ...(evidence?.status === 'valid_v3' && evidence.exactPayloadRecounts !== undefined
            ? { exactPayloadRecounts: evidence.exactPayloadRecounts }
            : {}),
        ...(evidence?.status === 'valid_v3' && evidence.proofSource
            ? { proofSource: evidence.proofSource }
            : {}),
    };
}
