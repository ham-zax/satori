import type { VectorBackendDiagnostic } from "./backend-diagnostics.js";
import type { CallGraphDirection, CallGraphSymbolRef } from "./call-graph.js";
import type { CompletionProofReason } from "./completion-proof.js";
import type {
    ManageIndexAction,
    ManageIndexReason,
    ManageIndexResponseEnvelope,
    ManageIndexStatus,
} from "./manage-types.js";
import type { SearchGroupBy, SearchResultMode, SearchScope } from "./search-constants.js";
import type {
    CallGraphResponseEnvelope,
    CallGraphResponseReason,
    CallGraphResponseStatus,
    FileOutlineResponseEnvelope,
    FileOutlineStatus,
    FingerprintCompatibilityDiagnostics,
    NonOkReason,
    SearchRecommendedNextAction,
    SearchResponseEnvelope,
} from "./search-types.js";
import type { FreshnessDecision } from "./sync.js";
import type { WarningCode } from "./warnings.js";
import type { ReindexPreflightResult } from "./working-tree-state.js";

type SearchContext = {
    path: string;
    query: string;
    scope: SearchScope;
    groupBy: SearchGroupBy;
    resultMode: SearchResultMode;
    limit: number;
};

type CallGraphContext = {
    path: string;
    symbolRef: CallGraphSymbolRef;
    direction: CallGraphDirection;
    depth: number;
    limit: number;
};

export type ToolResponseBuildersHost = {
    buildManageIndexRecommendedAction(
        action: "create" | "reindex" | "sync" | "status",
        codebasePath: string,
        rationale: string,
    ): SearchRecommendedNextAction;
    buildCreateHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildReindexHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildStatusHint(codebasePath: string): { tool: string; args: { action: string; path: string } };
    buildStaleLocalHint(codebasePath: string, reason: CompletionProofReason): Record<string, unknown>;
    buildStaleLocalMessage(codebasePath: string, requestedPath: string, reason: CompletionProofReason): string;
    buildIndexingMetadata(codebasePath: string): {
        progressPct: number | null;
        lastUpdated: string | null;
        phase: string | null;
    };
    buildCompatibilityDiagnostics(codebasePath: string): FingerprintCompatibilityDiagnostics;
    buildRuntimeMismatchHint(codebasePath: string, diagnostics: FingerprintCompatibilityDiagnostics): Record<string, unknown>;
    isRuntimeFingerprintMismatch(diagnostics: FingerprintCompatibilityDiagnostics): boolean;
    summarizeFingerprint(fingerprint: FingerprintCompatibilityDiagnostics["runtimeFingerprint"]): string;
};

export class ToolResponseBuilders {
    constructor(private readonly host: ToolResponseBuildersHost) {}

    private buildCompactManageMessage(humanText: string): string {
        const firstLine = humanText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0);
        if (!firstLine) {
            return "";
        }
        return firstLine.length > 240
            ? `${firstLine.slice(0, 237)}...`
            : firstLine;
    }

    public buildManageResponseEnvelope(
        action: ManageIndexAction,
        codebasePath: string,
        status: ManageIndexStatus,
        humanText: string,
        options: {
            reason?: ManageIndexReason;
            code?: ManageIndexResponseEnvelope["code"];
            warnings?: WarningCode[];
            hints?: Record<string, unknown>;
            preflight?: ReindexPreflightResult;
            message?: string;
        } = {},
    ): ManageIndexResponseEnvelope {
        const envelope: ManageIndexResponseEnvelope = {
            tool: "manage_index",
            version: 1,
            action,
            path: codebasePath,
            status,
            message: options.message || this.buildCompactManageMessage(humanText),
            humanText,
        };
        if (options.reason) {
            envelope.reason = options.reason;
        }
        if (options.code) {
            envelope.code = options.code;
        }
        if (Array.isArray(options.warnings) && options.warnings.length > 0) {
            envelope.warnings = [...new Set(options.warnings)];
        }
        if (options.hints && Object.keys(options.hints).length > 0) {
            envelope.hints = options.hints;
        }
        if (options.preflight) {
            envelope.preflight = {
                outcome: options.preflight.outcome,
                confidence: options.preflight.confidence,
                probeFailed: options.preflight.probeFailed === true,
            };
        }
        return envelope;
    }

    public manageResponseFromEnvelope(
        envelope: ManageIndexResponseEnvelope,
    ): { content: Array<{ type: "text"; text: string }> } {
        return {
            content: [{
                type: "text",
                text: JSON.stringify(envelope),
            }],
        };
    }

    public manageResponse(
        action: ManageIndexAction,
        codebasePath: string,
        status: ManageIndexStatus,
        humanText: string,
        options: {
            reason?: ManageIndexReason;
            code?: ManageIndexResponseEnvelope["code"];
            warnings?: WarningCode[];
            hints?: Record<string, unknown>;
            preflight?: ReindexPreflightResult;
            message?: string;
        } = {},
    ): { content: Array<{ type: "text"; text: string }> } {
        return this.manageResponseFromEnvelope(
            this.buildManageResponseEnvelope(action, codebasePath, status, humanText, options),
        );
    }

    public manageVectorBackendResponse(
        action: ManageIndexAction,
        codebasePath: string,
        diagnostic: VectorBackendDiagnostic,
        humanText = diagnostic.message,
    ): { content: Array<{ type: "text"; text: string }> } {
        return this.manageResponse(action, codebasePath, "error", humanText, {
            reason: "vector_backend_unavailable",
            code: diagnostic.code,
            message: diagnostic.message,
            hints: diagnostic.hints,
        });
    }

    public buildRequiresReindexPayload(
        codebasePath: string,
        detail?: string,
        searchContext?: SearchContext,
    ): Record<string, unknown> {
        const detailLine = detail ? `${detail}\n\n` : "";
        const base = searchContext ? {
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
        } : {};
        const compatibility = this.host.buildCompatibilityDiagnostics(codebasePath);
        const runtimeMismatch = this.host.isRuntimeFingerprintMismatch(compatibility);
        const message = runtimeMismatch
            ? (() => {
                const indexedFingerprint = compatibility.indexedFingerprint
                    ? this.host.summarizeFingerprint(compatibility.indexedFingerprint)
                    : "the indexed runtime fingerprint";
                const runtimeFingerprint = this.host.summarizeFingerprint(compatibility.runtimeFingerprint);
                return `${detailLine}The current Satori runtime does not match the existing index at '${codebasePath}'. Recovery: restart Satori with ${indexedFingerprint} to reuse the current index. Reindex only if you intentionally want to migrate this repo to ${runtimeFingerprint}.`;
            })()
            : `${detailLine}The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {"action":"reindex","path":"${codebasePath}"}.`;
        return {
            ...base,
            status: "requires_reindex",
            reason: "requires_reindex" as NonOkReason,
            codebasePath,
            results: [],
            freshnessDecision: {
                mode: "skipped_requires_reindex",
            },
            message,
            recommendedNextAction: runtimeMismatch
                ? this.host.buildManageIndexRecommendedAction(
                    "status",
                    codebasePath,
                    "Inspect the indexed/runtime fingerprints, then restart a matching runtime unless you intend to migrate the index.",
                )
                : this.host.buildManageIndexRecommendedAction(
                    "reindex",
                    codebasePath,
                    "Rebuild the incompatible index before retrying search.",
                ),
            hints: {
                ...(runtimeMismatch ? {
                    status: this.host.buildStatusHint(codebasePath),
                    runtimeMismatch: this.host.buildRuntimeMismatchHint(codebasePath, compatibility),
                } : {}),
                reindex: this.host.buildReindexHint(codebasePath),
            },
            compatibility,
        };
    }

    public buildRequiresReindexCallGraphPayload(
        codebasePath: string,
        detail: string | undefined,
        context: CallGraphContext,
        reason: Extract<
            NonOkReason,
            | "requires_reindex"
            | "partial_index_navigation_unavailable"
            | "missing_symbol_registry"
            | "missing_relationship_sidecar"
            | "incompatible_symbol_registry"
            | "incompatible_relationship_sidecar"
        > = "requires_reindex",
    ): CallGraphResponseEnvelope {
        const detailLine = detail ? `${detail}\n\n` : "";
        return {
            status: "requires_reindex",
            supported: false,
            reason,
            path: context.path,
            codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            freshnessDecision: {
                mode: "skipped_requires_reindex",
            },
            message: `${detailLine}The index at '${codebasePath}' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {"action":"reindex","path":"${codebasePath}"}.`,
            hints: {
                reindex: this.host.buildReindexHint(codebasePath),
            },
            compatibility: this.host.buildCompatibilityDiagnostics(codebasePath),
        };
    }

    public buildNotReadySearchPayload(
        codebasePath: string,
        searchContext: SearchContext,
    ): SearchResponseEnvelope {
        return {
            status: "not_ready",
            reason: "indexing",
            codebasePath,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            freshnessDecision: {
                mode: "skipped_indexing",
            },
            message: `Codebase '${codebasePath}' is currently indexing. Wait for indexing to complete, then retry.`,
            recommendedNextAction: this.host.buildManageIndexRecommendedAction(
                "status",
                codebasePath,
                "Check indexing progress before retrying search.",
            ),
            hints: {
                status: this.host.buildStatusHint(codebasePath),
                debugIndexing: {
                    completionProof: "marker_doc",
                },
            },
            indexing: this.host.buildIndexingMetadata(codebasePath),
            results: [],
        } as SearchResponseEnvelope;
    }

    public buildFreshnessBlockedSearchPayload(
        codebasePath: string,
        freshnessDecision: FreshnessDecision,
        searchContext: SearchContext,
    ): SearchResponseEnvelope | null {
        switch (freshnessDecision.mode) {
            case "skipped_indexing":
                return this.buildNotReadySearchPayload(codebasePath, searchContext);

            case "skipped_requires_reindex": {
                const detail = freshnessDecision.errorMessage
                    ? `Search blocked because this codebase requires reindex (${freshnessDecision.errorMessage}).`
                    : "Search blocked because this codebase requires reindex.";
                const payload = this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope;
                return {
                    ...payload,
                    freshnessDecision,
                };
            }

            case "skipped_missing_path":
                return {
                    status: "not_indexed",
                    reason: "not_indexed",
                    codebasePath,
                    path: searchContext.path,
                    query: searchContext.query,
                    scope: searchContext.scope,
                    groupBy: searchContext.groupBy,
                    resultMode: searchContext.resultMode,
                    limit: searchContext.limit,
                    freshnessDecision,
                    message: `Indexed codebase path '${codebasePath}' no longer exists. Search cannot serve stale vector results for this path.`,
                    recommendedNextAction: this.host.buildManageIndexRecommendedAction(
                        "create",
                        searchContext.path,
                        "Recreate the index for the requested path after the previously indexed root disappeared.",
                    ),
                    hints: {
                        create: this.host.buildCreateHint(searchContext.path),
                    },
                    results: [],
                } as SearchResponseEnvelope;

            case "ignore_reload_failed": {
                const fallbackLine = freshnessDecision.fallbackSyncExecuted
                    ? " Fallback incremental sync was executed, but ignore-rule reconciliation did not complete deterministically."
                    : "";
                const detail = `Search blocked because ignore-rule reconciliation failed (${freshnessDecision.errorMessage || "unknown_ignore_reload_error"}).${fallbackLine}`;
                const payload = this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope;
                return {
                    ...payload,
                    freshnessDecision,
                };
            }

            case "coalesced":
                if (typeof freshnessDecision.errorMessage === "string"
                    && freshnessDecision.errorMessage.trim().length > 0) {
                    const fallbackLine = freshnessDecision.fallbackSyncExecuted
                        ? " Fallback incremental sync was executed, but freshness still could not be proven."
                        : "";
                    const detail = `Search blocked because coalesced in-flight sync failed (${freshnessDecision.errorMessage}).${fallbackLine}`;
                    const payload = this.buildRequiresReindexPayload(codebasePath, detail, searchContext) as unknown as SearchResponseEnvelope;
                    return {
                        ...payload,
                        freshnessDecision,
                    };
                }
                return null;

            case "synced":
            case "skipped_recent":
            case "reconciled_ignore_change":
                return null;

            default: {
                const exhaustive: never = freshnessDecision.mode;
                return exhaustive;
            }
        }
    }

    public buildVectorBackendSearchPayload(
        diagnostic: { code: string; message: string; hints?: Record<string, unknown> },
        searchContext: SearchContext,
    ): SearchResponseEnvelope {
        return {
            status: "not_ready",
            reason: "vector_backend_unavailable",
            code: diagnostic.code,
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            freshnessDecision: null,
            message: diagnostic.message,
            hints: diagnostic.hints,
            results: [],
        } as SearchResponseEnvelope;
    }

    public buildInvalidSearchRequestPayload(
        searchContext: SearchContext,
        message: string,
        status: SearchResponseEnvelope["status"] = "not_ready",
        reason?: NonOkReason,
    ): SearchResponseEnvelope {
        return {
            status,
            ...(reason ? { reason } : {}),
            path: searchContext.path,
            query: searchContext.query,
            scope: searchContext.scope,
            groupBy: searchContext.groupBy,
            resultMode: searchContext.resultMode,
            limit: searchContext.limit,
            freshnessDecision: null,
            message,
            results: [],
        } as SearchResponseEnvelope;
    }

    public buildNotReadyFileOutlinePayload(
        codebasePath: string,
        file: string,
        requestedPath: string,
    ): FileOutlineResponseEnvelope & Record<string, unknown> {
        return {
            status: "not_ready",
            reason: "indexing",
            path: requestedPath,
            codebaseRoot: codebasePath,
            file,
            outline: null,
            hasMore: false,
            message: `Codebase '${codebasePath}' is currently indexing. Wait for indexing to complete, then retry file outline.`,
            hints: {
                status: this.host.buildStatusHint(codebasePath),
                debugIndexing: {
                    completionProof: "marker_doc",
                },
            },
            indexing: this.host.buildIndexingMetadata(codebasePath),
        };
    }

    public buildNotIndexedFileOutlinePayload(
        file: string,
        requestedPath: string,
        staleLocal?: { codebaseRoot: string; reason: CompletionProofReason },
    ): FileOutlineResponseEnvelope & Record<string, unknown> {
        if (staleLocal) {
            return {
                status: "not_indexed",
                reason: "not_indexed",
                path: requestedPath,
                file,
                outline: null,
                hasMore: false,
                message: this.host.buildStaleLocalMessage(staleLocal.codebaseRoot, requestedPath, staleLocal.reason),
                hints: {
                    create: this.host.buildCreateHint(staleLocal.codebaseRoot),
                    staleLocal: this.host.buildStaleLocalHint(staleLocal.codebaseRoot, staleLocal.reason),
                },
            };
        }
        return {
            status: "not_indexed",
            reason: "not_indexed",
            path: requestedPath,
            file,
            outline: null,
            hasMore: false,
            message: `Codebase '${requestedPath}' (or any parent) is not indexed.`,
            hints: {
                create: this.host.buildCreateHint(requestedPath),
            },
        };
    }

    public buildInvalidFileOutlineRequestPayload(
        requestedPath: string,
        file: string,
        message: string,
        status: FileOutlineStatus = "not_ready",
        reason?: NonOkReason,
    ): FileOutlineResponseEnvelope {
        return {
            status,
            ...(reason ? { reason } : {}),
            path: requestedPath,
            file,
            outline: null,
            hasMore: false,
            message,
        };
    }

    public buildNotIndexedCallGraphPayload(
        context: CallGraphContext,
        staleLocal?: { codebaseRoot: string; reason: CompletionProofReason },
    ): CallGraphResponseEnvelope {
        const baseHints: Record<string, unknown> = staleLocal
            ? {
                create: this.host.buildCreateHint(staleLocal.codebaseRoot),
                staleLocal: this.host.buildStaleLocalHint(staleLocal.codebaseRoot, staleLocal.reason),
            }
            : {
                create: this.host.buildCreateHint(context.path),
            };
        return {
            status: "not_indexed",
            supported: false,
            reason: "not_indexed",
            path: context.path,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            message: staleLocal
                ? this.host.buildStaleLocalMessage(staleLocal.codebaseRoot, context.path, staleLocal.reason)
                : `Codebase '${context.path}' (or any parent) is not indexed.`,
            hints: baseHints,
        };
    }

    public buildNotReadyCallGraphPayload(
        codebasePath: string,
        context: CallGraphContext,
    ): CallGraphResponseEnvelope {
        return {
            status: "not_ready",
            supported: false,
            reason: "indexing",
            path: context.path,
            codebaseRoot: codebasePath,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            freshnessDecision: {
                mode: "skipped_indexing",
            },
            message: `Codebase '${codebasePath}' is currently indexing. Wait for indexing to complete, then retry.`,
            hints: {
                status: this.host.buildStatusHint(codebasePath),
                debugIndexing: {
                    completionProof: "marker_doc",
                },
            },
            indexing: this.host.buildIndexingMetadata(codebasePath),
        };
    }

    public buildInvalidCallGraphRequestPayload(
        context: CallGraphContext,
        message: string,
        status: CallGraphResponseStatus = "not_ready",
        reason?: CallGraphResponseReason,
    ): CallGraphResponseEnvelope {
        return {
            status,
            supported: false,
            ...(reason ? { reason } : {}),
            path: context.path,
            symbolRef: context.symbolRef,
            direction: context.direction,
            depth: context.depth,
            limit: context.limit,
            nodes: [],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
            message,
        };
    }
}
