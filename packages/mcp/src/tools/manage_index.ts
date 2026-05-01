import { z } from "zod";
import { McpTool, ToolContext, formatZodError } from "./types.js";
import { formatManageProviderConfigError, isMissingProviderConfigIssue } from "./setup-errors.js";

const actionEnum = z.enum(["create", "reindex", "sync", "status", "clear"]);

const manageIndexInputSchema = z.object({
    action: actionEnum.describe("Required operation to run."),
    path: z.string().min(1).describe("ABSOLUTE path to the target codebase."),
    force: z.boolean().optional().describe("Only for action='create'. Force rebuild from scratch."),
    allowUnnecessaryReindex: z.boolean().optional().describe("Only for action='reindex'. Override preflight block when reindex is detected as unnecessary ignore-only churn."),
    customExtensions: z.array(z.string()).optional().describe("Only for action='create'. Additional file extensions to include."),
    ignorePatterns: z.array(z.string()).optional().describe("Only for action='create'. Additional ignore patterns to apply."),
    zillizDropCollection: z.string().min(1).optional().describe("Only for action='create'. Zilliz-only: drop this Satori-managed collection before creating the new index.")
});

export const manageIndexTool: McpTool = {
    name: "manage_index",
    description: () =>
        "Manage index lifecycle operations (create/reindex/sync/status/clear) for a codebase path. Ignore-rule edits in repo-root .satoriignore/.gitignore reconcile automatically in the normal sync path. Use action=\"sync\" for immediate convergence and action=\"reindex\" for full rebuild recovery (preflight may block unnecessary ignore-only reindex churn unless allowUnnecessaryReindex=true).",
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

        const input = parsed.data;
        const providerOperation = input.action === "clear"
            ? "vector_only"
            : (input.action === "create" || input.action === "reindex" || input.action === "sync")
                ? "embedding_vector"
                : null;
        const executionContext = providerOperation && ctx.providerRuntime
            ? await ctx.providerRuntime.requireToolContext(providerOperation)
            : ctx;
        if (isMissingProviderConfigIssue(executionContext)) {
            return formatManageProviderConfigError(input.action, input.path, executionContext);
        }

        switch (input.action) {
            case 'create':
                return executionContext.toolHandlers.handleIndexCodebase(input);
            case 'reindex':
                return executionContext.toolHandlers.handleReindexCodebase(input);
            case 'sync':
                return executionContext.toolHandlers.handleSyncCodebase(input);
            case 'status':
                return executionContext.toolHandlers.handleGetIndexingStatus(input);
            case 'clear':
                return executionContext.toolHandlers.handleClearIndex(input);
            default:
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Unsupported action '${input.action}'. Use one of: create, reindex, sync, status, clear.`
                    }],
                    isError: true
                };
        }
    }
};
