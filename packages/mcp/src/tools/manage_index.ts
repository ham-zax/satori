import { z } from "zod";
import {
    MANAGE_INDEX_ACTIONS,
    MANAGE_INDEX_STATUS_DETAILS,
} from "../core/manage-types.js";
import { AuthorizedWorkspacePath, WorkspaceAuthorizationError } from "../core/session-workspace-policy.js";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import {
    McpTool,
    MissingProviderConfigIssue,
    ToolContext,
    ToolResponse,
    absoluteFilesystemPathSchema,
    formatZodError,
} from "./types.js";
import {
    classifyVectorBackendError,
    formatManageProviderConfigError,
    formatManageVectorBackendError,
    isMissingProviderConfigIssue
} from "./setup-errors.js";

/** Re-export for contract tests and docs generators. */
export { MANAGE_INDEX_ACTIONS };

const actionEnum = z.enum(MANAGE_INDEX_ACTIONS);

const manageIndexInputSchema = z.object({
    action: actionEnum.describe("Required operation to run."),
    path: absoluteFilesystemPathSchema("ABSOLUTE filesystem path to the target codebase (relative paths are rejected)."),
    force: z.boolean().optional().describe("Only for action='create'. Force rebuild from scratch."),
    allowUnnecessaryReindex: z.boolean().optional().describe("Only for action='reindex'. Override preflight block when reindex is detected as unnecessary ignore-only churn."),
    customExtensions: z.array(z.string()).optional().describe("Only for action='create'. Additional file extensions to include."),
    ignorePatterns: z.array(z.string()).optional().describe("Only for action='create'. Additional ignore patterns to apply."),
    zillizDropCollection: z.string().min(1).optional().describe("Only for action='create'. Zilliz-only: drop this Satori-managed collection before creating the new index."),
    detail: z.enum(MANAGE_INDEX_STATUS_DETAILS).optional().describe("Only for action='status'. Response projection: summary, capabilities, diagnostics, or full. Defaults to summary."),
    operationId: z.string().min(1).optional().describe("Required only for action='cancel'. Exact live operation ID returned by sync/status."),
}).superRefine((value, ctx) => {
    if (value.action !== "status" && value.detail !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["detail"],
            message: "detail is only valid for action='status'.",
        });
    }
    if (value.action === "cancel" && value.operationId === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operationId"],
            message: "operationId is required for action='cancel'.",
        });
    }
    if (value.action !== "cancel" && value.operationId !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["operationId"],
            message: "operationId is only valid for action='cancel'.",
        });
    }
});

export const manageIndexTool: McpTool = {
    name: "manage_index",
    description: () =>
        "Manage Publication lifecycle operations (create/reindex/sync/status/cancel/clear). A compatible completed Publication remains readable while source freshness is changed or unverified. Explicit sync is a supervised background operation. Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance for already-tracked incompatible Publications; explicit reindex is the operator recovery override when automatic maintenance is unavailable, suppressed after failure, unsafe, or intentionally disabled for connected/remote providers. cancel requires the exact live supervised create/reindex/sync operationId and never force-unlocks a root. Mutation operation state is process-lifetime diagnostic state, not persistent history. Status detail=capabilities/diagnostics/full exposes language support, structural coverage within the current Publication policy, compatibility, and runtime-owner evidence. Use read_file on a specific absolute path when exact published-path coverage must be checked.",
    inputSchemaZod: () => manageIndexInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const parsed = manageIndexInputSchema.safeParse(args || {});
        if (!parsed.success) {
            return {
                content: [{
                    type: "text",
                    text: formatZodError("manage_index", parsed.error)
                }],
                isError: true
            };
        }

        const absolutePathResult = requireAbsoluteFilesystemPath(parsed.data.path, "path");
        if (!absolutePathResult.ok) {
            return {
                content: [{
                    type: "text",
                    text: absolutePathResult.message,
                }],
                isError: true,
            };
        }

        // Session workspace gate: every action (including status) must be
        // authorized before provider resolution, filesystem existence checks,
        // vector operations or mutation leases. An
        // unbound policy fails closed with WORKSPACE_POLICY_NOT_BOUND.
        const workspacePolicy = ctx.workspacePolicy;
        if (!workspacePolicy) {
            return manageIndexWorkspaceDenial({
                path: absolutePathResult.absolutePath,
                code: "WORKSPACE_POLICY_NOT_BOUND",
                message: "Tool context has not been bound to an MCP session workspace policy.",
            });
        }
        let authorizedRoot: AuthorizedWorkspacePath;
        try {
            authorizedRoot = workspacePolicy.authorizeRoot(absolutePathResult.absolutePath);
        } catch (error) {
            if (error instanceof WorkspaceAuthorizationError) {
                return manageIndexWorkspaceDenial({
                    path: absolutePathResult.absolutePath,
                    code: error.code,
                    message: error.message,
                });
            }
            throw error;
        }

        const statusDetail = parsed.data.detail ?? "summary";
        const input = {
            ...parsed.data,
            path: authorizedRoot.canonicalPath,
            ...(parsed.data.action === "status"
                ? { detail: statusDetail }
                : {}),
        };
        const providerOperation = input.action === "clear"
            ? "vector_only"
            : (input.action === "create" || input.action === "reindex")
                ? "embedding_vector"
                : null;
        let executionContext: ToolContext | MissingProviderConfigIssue;
        let statusProviderIssue: MissingProviderConfigIssue | null = null;
        try {
            if (input.action === "status" && ctx.providerRuntime) {
                const preferredContext = await ctx.providerRuntime.requireToolContext(
                    "embedding_vector",
                    { signal: ctx.requestSignal },
                );
                executionContext = isMissingProviderConfigIssue(preferredContext)
                    ? await ctx.providerRuntime.requireToolContext(
                        "vector_only",
                        { signal: ctx.requestSignal },
                    )
                    : preferredContext;
            } else {
                executionContext = providerOperation && ctx.providerRuntime
                    ? await ctx.providerRuntime.requireToolContext(
                        providerOperation,
                        { signal: ctx.requestSignal },
                    )
                    : ctx;
            }
        } catch (error) {
            const diagnostic = classifyVectorBackendError(error);
            if (input.action === "status" && diagnostic) {
                executionContext = ctx;
            } else {
                if (!diagnostic) {
                    throw error;
                }
                return formatManageVectorBackendError(input.action, input.path, diagnostic);
            }
        }
        if (isMissingProviderConfigIssue(executionContext)) {
            if (input.action === "status") {
                // Status remains usable without credentials for pure not_indexed / path errors.
                // For tracked roots, provider gaps must beat fake fingerprint / marker narratives.
                statusProviderIssue = executionContext;
                executionContext = ctx;
            } else {
                return formatManageProviderConfigError(input.action, input.path, executionContext);
            }
        }

        try {
            let response: ToolResponse;
            switch (input.action) {
                case 'create':
                    response = await executionContext.toolHandlers.handleIndexCodebase(input);
                    break;
                case 'reindex':
                    response = await executionContext.toolHandlers.handleReindexCodebase(input);
                    break;
                case 'sync':
                    response = await executionContext.toolHandlers.handleSyncCodebase(
                        input,
                        executionContext.requestSignal,
                    );
                    break;
                case 'status':
                    response = await executionContext.toolHandlers.handleGetIndexingStatus(input);
                    if (statusProviderIssue) {
                        response = preferProviderIncompleteForStatus(
                            response,
                            input.path,
                            statusProviderIssue,
                        );
                    }
                    response = withStatusDetail(response, statusDetail);
                    break;
                case 'cancel':
                    response = await executionContext.toolHandlers.handleCancelIndexOperation(input);
                    break;
                case 'clear':
                    response = await executionContext.toolHandlers.handleClearIndex(input);
                    break;
                default:
                    return {
                        content: [{
                            type: 'text',
                            text: `Error: Unsupported action '${String(input.action)}'. Use one of: ${MANAGE_INDEX_ACTIONS.join(", ")}.`
                        }],
                        isError: true
                    };
            }
            return response;
        } catch (error) {
            const diagnostic = classifyVectorBackendError(error);
            if (!diagnostic) {
                throw error;
            }
            const response = formatManageVectorBackendError(input.action, input.path, diagnostic);
            return input.action === "status"
                ? withStatusDetail(response, statusDetail)
                : response;
        }
    }
};

/**
 * Structured workspace denial per the security hardening contract. The
 * `reason` is the snake_case form of the policy's authorization code, so the
 * common rejection (ROOT_NOT_AUTHORIZED) renders exactly as documented while
 * BROAD_ROOT_NOT_ALLOWED / INVALID_WORKSPACE_ROOT / WORKSPACE_POLICY_NOT_BOUND
 * stay distinguishable to callers.
 */
function manageIndexWorkspaceDenial(input: {
    path: string;
    code: "ROOT_NOT_AUTHORIZED" | "BROAD_ROOT_NOT_ALLOWED" | "INVALID_WORKSPACE_ROOT" | "WORKSPACE_POLICY_NOT_BOUND";
    message: string;
}): ToolResponse {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: "error",
                reason: input.code.toLowerCase(),
                code: input.code,
                path: input.path,
                message: input.message,
            }),
        }],
        isError: true,
    };
}

function withStatusDetail(
    response: ToolResponse,
    detail: (typeof MANAGE_INDEX_STATUS_DETAILS)[number],
): ToolResponse {
    const text = response.content?.[0]?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
        return response;
    }
    try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        return {
            ...response,
            content: [{
                ...response.content[0],
                type: "text",
                text: JSON.stringify({ ...payload, detail }),
            }, ...response.content.slice(1)],
        };
    } catch {
        return response;
    }
}

/**
 * When provider config is incomplete, status may still report compatibility/stale
 * narratives driven by defaulted runtime config. Prefer
 * missing_provider_config for those cases; keep pure not_indexed / path errors intact.
 */
function preferProviderIncompleteForStatus(
    response: ToolResponse,
    path: string,
    issue: MissingProviderConfigIssue,
): ToolResponse {
    const text = response.content?.[0]?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
        return formatManageProviderConfigError("status", path, issue);
    }

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return formatManageProviderConfigError("status", path, issue);
    }

    const status = typeof payload.status === "string" ? payload.status : "";
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    const hints = payload.hints && typeof payload.hints === "object" && !Array.isArray(payload.hints)
        ? payload.hints as Record<string, unknown>
        : null;
    const hasStaleLocalHint = Boolean(hints && hints.staleLocal);

    // Untracked / never-indexed roots and hard path errors remain valid without provider env.
    if (status === "error") {
        return response;
    }
    if (status === "not_indexed" && reason === "not_indexed" && !hasStaleLocalHint) {
        return response;
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                tool: "manage_index",
                version: 1,
                action: "status",
                path: typeof payload.path === "string" ? payload.path : path,
                status: "not_ready",
                detail: typeof payload.detail === "string" ? payload.detail : "summary",
                reason: "missing_provider_config",
                code: issue.code,
                message: issue.message,
                humanText: issue.message,
                hints: {
                    ...issue.hints,
                    ...(hints?.activeMutation ? { activeMutation: hints.activeMutation } : {}),
                },
                ...(payload.operation ? { operation: payload.operation } : {}),
            }),
        }],
    };
}
