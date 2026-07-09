import { z } from "zod";
import { MANAGE_INDEX_ACTIONS } from "../core/manage-types.js";
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
    zillizDropCollection: z.string().min(1).optional().describe("Only for action='create'. Zilliz-only: drop this Satori-managed collection before creating the new index.")
});

export const manageIndexTool: McpTool = {
    name: "manage_index",
    description: () =>
        "Manage index lifecycle operations (create/reindex/sync/status/clear/repair) for a codebase path. repair rebuilds local readiness only when existing vector payload and trusted runtime fingerprint proof match; otherwise it refuses and asks for create/reindex. Ignore-rule edits in repo-root .satoriignore/.gitignore reconcile automatically in the normal sync path. Use action=\"sync\" for immediate convergence and action=\"reindex\" for full rebuild recovery (preflight may block unnecessary ignore-only reindex churn unless allowUnnecessaryReindex=true). create/reindex return the kickoff response immediately and do not poll to terminal state; use action=\"status\" to observe progress.",
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

        const input = {
            ...parsed.data,
            path: absolutePathResult.absolutePath,
        };
        const providerOperation = input.action === "clear" || input.action === "status"
            ? "vector_only"
            : (input.action === "create" || input.action === "reindex" || input.action === "sync" || input.action === "repair")
                ? "embedding_vector"
                : null;
        let executionContext: ToolContext | MissingProviderConfigIssue;
        try {
            executionContext = providerOperation && ctx.providerRuntime
                ? await ctx.providerRuntime.requireToolContext(providerOperation)
                : ctx;
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
                    response = await executionContext.toolHandlers.handleSyncCodebase(input);
                    break;
                case 'status':
                    response = await executionContext.toolHandlers.handleGetIndexingStatus(input);
                    break;
                case 'clear':
                    response = await executionContext.toolHandlers.handleClearIndex(input);
                    break;
                case 'repair':
                    response = await executionContext.toolHandlers.handleRepairIndex(input);
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
            return formatManageVectorBackendError(input.action, input.path, diagnostic);
        }
    }
};
