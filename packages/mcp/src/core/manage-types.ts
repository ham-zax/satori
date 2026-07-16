import type {
    LanguageCapabilityEvidenceSummary,
    RepairProof,
    SymbolQualitySummary,
} from "@zokizuan/satori-core";
import type { IndexOperationReceipt } from "../config.js";
import { WarningCode } from "./warnings.js";

/** Public manage_index action set (SSOT for schema, docs, and contract tests). */
export const MANAGE_INDEX_ACTIONS = [
    "create",
    "reindex",
    "sync",
    "status",
    "clear",
    "repair",
] as const;

export type ManageIndexAction = (typeof MANAGE_INDEX_ACTIONS)[number];

export type ManageIndexStatus =
    | "ok"
    | "not_ready"
    | "not_indexed"
    | "requires_reindex"
    | "blocked"
    | "error";

export const MANAGE_INDEX_STATUS_DETAILS = [
    "summary",
    "capabilities",
    "diagnostics",
    "full",
] as const;

export type ManageIndexStatusDetail = (typeof MANAGE_INDEX_STATUS_DETAILS)[number];

export type ManageIndexReason =
    | "indexing"
    | "not_indexed"
    | "requires_reindex"
    | "unnecessary_reindex_ignore_only"
    | "preflight_unknown"
    | "backend_timeout"
    | "remote_delete_pending"
    | "missing_provider_config"
    | "vector_backend_unavailable"
    | "runtime_owner_conflict"
    | "mutation_in_progress"
    | "needs_create";

export type VectorBackendResponseCode =
    | "ZILLIZ_CLUSTER_STOPPED"
    | "VECTOR_BACKEND_AUTH_FAILED"
    | "VECTOR_BACKEND_UNREACHABLE"
    | "VECTOR_BACKEND_TIMEOUT"
    | "VECTOR_BACKEND_CONNECTION_CLOSED";

export type ManageReindexPreflightOutcome =
    | "reindex_required"
    | "reindex_unnecessary_ignore_only"
    | "unknown"
    | "probe_failed";

export interface ManageIndexToolHint {
    tool: "manage_index";
    args: Record<string, unknown>;
}

export type ManageCompactSymbolQuality = Pick<
    SymbolQualitySummary,
    "status" | "basis" | "message" | "evidenceAvailability"
>;

export interface IndexPublicationReceipt {
    collectionName: string;
    markerRunId: string;
    indexPolicyHash: string;
    policyDocumentDigest: string;
}

export interface ManageIndexResponseEnvelope {
    tool: "manage_index";
    version: 1;
    action: ManageIndexAction;
    path: string;
    status: ManageIndexStatus;
    /** Projection returned for status responses. */
    detail?: ManageIndexStatusDetail;
    reason?: ManageIndexReason;
    code?: "MISSING_PROVIDER_CONFIG" | VectorBackendResponseCode;
    message: string;
    humanText: string;
    warnings?: WarningCode[];
    hints?: Record<string, unknown>;
    preflight?: {
        outcome: ManageReindexPreflightOutcome;
        confidence: "high" | "low";
        probeFailed?: boolean;
    };
    operation?: IndexOperationReceipt;
    /** Stable published-generation identity, independent of sync operation ids. */
    publication?: IndexPublicationReceipt;
    repairProof?: RepairProof;
    /** Observed symbol quality from registry (F9); not parser-cause diagnosis. */
    symbolQuality?: SymbolQualitySummary | ManageCompactSymbolQuality;
    /** Declared claims combined with compatible per-language navigation evidence. */
    languageCapabilities?: LanguageCapabilityEvidenceSummary;
    /** Deterministic filesystem changes observed by a completed sync. */
    syncStats?: { added: number; removed: number; modified: number };
}
