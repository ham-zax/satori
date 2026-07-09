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

export interface ManageIndexResponseEnvelope {
    tool: "manage_index";
    version: 1;
    action: ManageIndexAction;
    path: string;
    status: ManageIndexStatus;
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
}
