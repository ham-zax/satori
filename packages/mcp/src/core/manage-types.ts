import { WarningCode } from "./warnings.js";

export type ManageIndexAction = "create" | "reindex" | "sync" | "status" | "clear";

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
    | "preflight_unknown";

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
