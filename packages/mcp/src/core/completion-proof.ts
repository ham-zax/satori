import type {
    PublicationNavigationStatus,
    PublicationRef,
} from "@zokizuan/satori-core";

export type CompletionProofOutcome = "valid" | "stale_local" | "policy_incompatible" | "probe_failed";

export type CompletionProofReason =
    | "missing_publication"
    | "requires_reindex"
    | "runtime_policy_incompatible"
    | "invalid_policy_authority"
    | "invalid_payload"
    | "probe_failed";

export type CompletionProofValidationResult = {
    outcome: CompletionProofOutcome;
    reason?: CompletionProofReason;
    publication?: PublicationRef;
    navigationStatus?: PublicationNavigationStatus;
};

export type PublicationProofReader = (codebasePath: string) => Promise<unknown>;

type PublicationProofProvider = {
    getCurrentPublicationForValidation?: PublicationProofReader;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicationProofProvider(value: unknown): value is PublicationProofProvider {
    return isRecord(value)
        && typeof value.getCurrentPublicationForValidation === "function";
}

export function getPublicationProofReader(value: unknown): PublicationProofReader | undefined {
    return isPublicationProofProvider(value)
        ? value.getCurrentPublicationForValidation?.bind(value)
        : undefined;
}

function isNavigationStatus(value: unknown): value is PublicationNavigationStatus {
    return value === "valid"
        || value === "not_bound"
        || value === "missing"
        || value === "incompatible"
        || value === "corrupt";
}

function parsePublicationRef(value: unknown): PublicationRef | null {
    if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.publication)) return null;
    const publication = value.publication;
    const policy = isRecord(publication.policy) ? publication.policy : null;
    const format = isRecord(publication.format) ? publication.format : null;
    const vector = isRecord(publication.vector) ? publication.vector : null;
    const navigation = publication.navigation;
    if (
        publication.id !== value.id
        // Mirrors PublicationStore, which reads v1 and writes v2 (package ownership).
        || (publication.version !== 1 && publication.version !== 2)
        || typeof publication.canonicalRoot !== "string"
        || typeof publication.createdAt !== "string"
        || (publication.status !== "complete" && publication.status !== "partial")
        || !policy
        || typeof policy.policyHash !== "string"
        || typeof policy.controlSignature !== "string"
        || !format
        || typeof format.indexFormatVersion !== "string"
        || typeof format.embeddingIdentity !== "string"
        || typeof format.relationshipVersion !== "string"
        || !vector
        || typeof vector.collectionName !== "string"
        || !Number.isSafeInteger(vector.indexedFiles)
        || !Number.isSafeInteger(vector.totalChunks)
        || (navigation !== null && (!isRecord(navigation) || navigation.relativeRoot !== "navigation"))
    ) return null;
    return structuredClone(value) as unknown as PublicationRef;
}

export async function validateCompletionProof(args: {
    codebasePath: string;
    getCurrentPublication?: PublicationProofReader;
    onProbeError?: (error: unknown) => void;
}): Promise<CompletionProofValidationResult> {
    const { codebasePath, getCurrentPublication, onProbeError } = args;
    if (typeof getCurrentPublication !== "function") {
        return { outcome: "probe_failed", reason: "probe_failed" };
    }

    let raw: unknown;
    try {
        raw = await getCurrentPublication(codebasePath);
    } catch (error) {
        onProbeError?.(error);
        return { outcome: "probe_failed", reason: "probe_failed" };
    }
    if (!isRecord(raw)) return { outcome: "stale_local", reason: "invalid_payload" };
    if (raw.status === "missing") return { outcome: "stale_local", reason: "missing_publication" };
    if (raw.status === "requires_reindex") return { outcome: "stale_local", reason: "requires_reindex" };
    if (raw.status === "policy_authority_invalid") {
        return { outcome: "policy_incompatible", reason: "invalid_policy_authority" };
    }
    if (raw.status === "runtime_policy_incompatible") {
        return { outcome: "policy_incompatible", reason: "runtime_policy_incompatible" };
    }
    if (raw.status !== "valid") return { outcome: "stale_local", reason: "invalid_payload" };

    const publication = parsePublicationRef(raw.publication);
    if (!publication || !isNavigationStatus(raw.navigationStatus)) {
        return { outcome: "stale_local", reason: "invalid_payload" };
    }
    return {
        outcome: "valid",
        publication,
        navigationStatus: raw.navigationStatus,
    };
}
