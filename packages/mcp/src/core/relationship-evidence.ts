import { compareContractStrings } from "@zokizuan/satori-core";
import type { CallGraphEdge, CallGraphNote } from "./call-graph.js";

export const RELATIONSHIP_EVIDENCE_PROJECTION_POLICY_VERSION = "relationship_evidence_v1" as const;
export const RELATIONSHIP_CONFIDENCE_POLICY_VERSION = "call_graph_score_bands_v1" as const;

export type RelationshipEvidenceStatus =
    | "ok"
    | "unavailable"
    | "unsupported"
    | "ambiguous"
    | "degraded";

export type RelationshipEvidenceKind = "caller" | "callee";
export type RelationshipEvidenceCompleteness = "bounded_static";
export type RelationshipEvidenceSource = "relationship_graph" | "source_backed_dynamic";
export type RelationshipConfidenceClass = "high" | "medium" | "low";
export type RelationshipConfidenceBasis =
    | "stored_static_relationship"
    | "source_backed_dynamic_relationship";
export type RelationshipSiteStatus = "current_source_validated" | "not_current_source_validated";
export type RelationshipEvidenceLimitation =
    | "dynamic_relationships_unknown"
    | "relationship_limit_reached"
    | "low_confidence_relationships_suppressed"
    | "dynamic_source_observation_failed"
    | "dynamic_relationship_continuation_ineligible";

export interface RelationshipEvidenceSite {
    file: string;
    startLine: number;
    endLine?: number;
}

export interface RelationshipEvidenceItem {
    symbolId: string;
    relationship: RelationshipEvidenceKind;
    source: RelationshipEvidenceSource;
    confidenceClass: RelationshipConfidenceClass;
    confidenceBasis: RelationshipConfidenceBasis;
    rawConfidenceScore?: number;
    calibrated: false;
    sites: {
        status: RelationshipSiteStatus;
        items: RelationshipEvidenceSite[];
    };
}

export interface RelationshipEvidenceAvailableProjection {
    status: "ok" | "degraded";
    projectionPolicyVersion: typeof RELATIONSHIP_EVIDENCE_PROJECTION_POLICY_VERSION;
    confidencePolicyVersion: typeof RELATIONSHIP_CONFIDENCE_POLICY_VERSION;
    completeness: RelationshipEvidenceCompleteness;
    relationship: RelationshipEvidenceKind;
    items: RelationshipEvidenceItem[];
    returnedCount: number;
    availableCount?: number;
    truncated: boolean;
    terminal: boolean;
    suppressedCount: number;
    suppressionNotes: CallGraphNote[];
    limitations: RelationshipEvidenceLimitation[];
    emptyReason?: "no_validated_edge_found";
}

export interface RelationshipEvidenceUnavailableProjection {
    status: "unavailable" | "unsupported" | "ambiguous";
    projectionPolicyVersion: typeof RELATIONSHIP_EVIDENCE_PROJECTION_POLICY_VERSION;
    confidencePolicyVersion: typeof RELATIONSHIP_CONFIDENCE_POLICY_VERSION;
    relationship: RelationshipEvidenceKind;
    reason: string;
    unsupportedRelationshipKind?: string;
    items: [];
    returnedCount: 0;
    truncated: false;
    suppressedCount: 0;
    suppressionNotes: [];
    limitations: RelationshipEvidenceLimitation[];
}

export type RelationshipEvidenceProjection =
    | RelationshipEvidenceAvailableProjection
    | RelationshipEvidenceUnavailableProjection;

/**
 * Edges come from the matching single-direction traversal and retain its order.
 * availableCount, when known, counts source-eligible evidence before response
 * truncation; callers must not include failed dynamic-source candidates.
 */
type RelationshipEvidenceAvailableInput = {
    status: "ok" | "degraded";
    relationship: RelationshipEvidenceKind;
    edges: readonly CallGraphEdge[];
    truncated: boolean;
    availableCount?: number;
    suppressedCount: number;
    suppressionNotes?: readonly CallGraphNote[];
    limitations?: readonly RelationshipEvidenceLimitation[];
    siteStatusByFile?: ReadonlyMap<string, RelationshipSiteStatus>;
    failedDynamicSourceFiles?: ReadonlySet<string>;
};

type RelationshipEvidenceUnavailableInput = {
    status: "unavailable" | "ambiguous";
    relationship: RelationshipEvidenceKind;
    reason: string;
    limitations?: readonly RelationshipEvidenceLimitation[];
} | {
    status: "unsupported";
    relationship: RelationshipEvidenceKind;
    reason: string;
    unsupportedRelationshipKind: string;
    limitations?: readonly RelationshipEvidenceLimitation[];
};

export type RelationshipEvidenceProjectionInput =
    | RelationshipEvidenceAvailableInput
    | RelationshipEvidenceUnavailableInput;

function uniqueSortedLimitations(
    limitations: readonly RelationshipEvidenceLimitation[],
): RelationshipEvidenceLimitation[] {
    return [...new Set(limitations)].sort(compareContractStrings);
}

function confidenceClass(score: number): RelationshipConfidenceClass {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new RangeError("Relationship confidence score must be finite and between 0 and 1.");
    }
    if (score >= 0.9) return "high";
    if (score >= 0.6) return "medium";
    return "low";
}

function projectAvailableRelationshipEvidence(
    input: RelationshipEvidenceAvailableInput,
): RelationshipEvidenceAvailableProjection {
    if (!Number.isInteger(input.suppressedCount) || input.suppressedCount < 0) {
        throw new RangeError("suppressedCount must be a non-negative integer.");
    }
    if (
        input.availableCount !== undefined
        && (!Number.isInteger(input.availableCount) || input.availableCount < 0)
    ) {
        throw new RangeError("availableCount must be a non-negative integer when present.");
    }

    const failedDynamicSourceFiles = input.failedDynamicSourceFiles || new Set<string>();
    let suppressedDynamicEdgeCount = 0;
    const items = input.edges.flatMap((edge): RelationshipEvidenceItem[] => {
        if (edge.kind === "dynamic" && failedDynamicSourceFiles.has(edge.site.file)) {
            suppressedDynamicEdgeCount += 1;
            return [];
        }

        const isDynamic = edge.kind === "dynamic";
        return [{
            symbolId: input.relationship === "caller" ? edge.srcSymbolId : edge.dstSymbolId,
            relationship: input.relationship,
            source: isDynamic ? "source_backed_dynamic" : "relationship_graph",
            confidenceClass: confidenceClass(edge.confidence),
            confidenceBasis: isDynamic
                ? "source_backed_dynamic_relationship"
                : "stored_static_relationship",
            rawConfidenceScore: edge.confidence,
            calibrated: false,
            sites: {
                status: input.siteStatusByFile?.get(edge.site.file) || "not_current_source_validated",
                items: [{ ...edge.site }],
            },
        }];
    });

    if (input.availableCount !== undefined && input.availableCount < items.length) {
        throw new RangeError("availableCount cannot be smaller than the returned relationship item count.");
    }
    const limitations: RelationshipEvidenceLimitation[] = [
        "dynamic_relationships_unknown",
        ...(input.limitations || []),
        ...(input.truncated ? ["relationship_limit_reached" as const] : []),
        ...(input.suppressedCount > 0 ? ["low_confidence_relationships_suppressed" as const] : []),
        ...(suppressedDynamicEdgeCount > 0 ? ["dynamic_source_observation_failed" as const] : []),
    ];

    return {
        status: input.status,
        projectionPolicyVersion: RELATIONSHIP_EVIDENCE_PROJECTION_POLICY_VERSION,
        confidencePolicyVersion: RELATIONSHIP_CONFIDENCE_POLICY_VERSION,
        completeness: "bounded_static",
        relationship: input.relationship,
        items,
        returnedCount: items.length,
        ...(input.availableCount !== undefined ? { availableCount: input.availableCount } : {}),
        truncated: input.truncated,
        terminal: !input.truncated,
        suppressedCount: input.suppressedCount + suppressedDynamicEdgeCount,
        suppressionNotes: (input.suppressionNotes || []).map((note) => ({ ...note })),
        limitations: uniqueSortedLimitations(limitations),
        ...(items.length === 0
            && !input.truncated
            && (input.availableCount === undefined || input.availableCount === 0)
            ? { emptyReason: "no_validated_edge_found" as const }
            : {}),
    };
}

export function projectRelationshipEvidence(
    input: RelationshipEvidenceProjectionInput,
): RelationshipEvidenceProjection {
    if (input.status === "ok" || input.status === "degraded") {
        return projectAvailableRelationshipEvidence(input);
    }
    if (!("reason" in input)) {
        throw new TypeError("Unavailable relationship evidence requires a reason.");
    }

    return {
        status: input.status,
        projectionPolicyVersion: RELATIONSHIP_EVIDENCE_PROJECTION_POLICY_VERSION,
        confidencePolicyVersion: RELATIONSHIP_CONFIDENCE_POLICY_VERSION,
        relationship: input.relationship,
        reason: input.reason,
        ...(input.status === "unsupported"
            ? { unsupportedRelationshipKind: input.unsupportedRelationshipKind }
            : {}),
        items: [],
        returnedCount: 0,
        truncated: false,
        suppressedCount: 0,
        suppressionNotes: [],
        limitations: uniqueSortedLimitations(input.limitations || []),
    };
}
