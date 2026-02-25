import { z } from "zod";
import { McpTool, ToolContext, formatZodError } from "./types.js";

const actionEnum = z.enum(["create", "sync", "status", "clear"]);

const manageIndexInputSchema = z.object({
    action: actionEnum.describe("Required operation to run."),
    path: z.string().min(1).describe("ABSOLUTE path to the target codebase."),
    force: z.boolean().optional().describe("Only for action='create'. Force rebuild from scratch."),
    splitter: z.enum(["ast", "langchain"]).optional().describe("Only for action='create'. Code splitter strategy."),
    customExtensions: z.array(z.string()).optional().describe("Only for action='create'. Additional file extensions to include."),
    ignorePatterns: z.array(z.string()).optional().describe("Only for action='create'. Additional ignore patterns to apply."),
    zillizDropCollection: z.string().min(1).optional().describe("Only for action='create'. Zilliz-only: drop this Satori-managed collection before creating the new index.")
});

export const manageIndexTool: McpTool = {
    name: "manage_index",
    description: () =>
        "Manage index lifecycle operations (create/sync/status/clear) for a codebase path.",
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

        switch (input.action) {
            case 'create':
                return ctx.toolHandlers.handleIndexCodebase(input);
            case 'sync':
                return ctx.toolHandlers.handleSyncCodebase(input);
            case 'status':
                return ctx.toolHandlers.handleGetIndexingStatus(input);
            case 'clear':
                return ctx.toolHandlers.handleClearIndex(input);
            default:
                return {
                    content: [{
                        type: 'text',
                        text: `Error: Unsupported action '${input.action}'. Use one of: create, sync, status, clear.`
                    }],
                    isError: true
                };
        }
    }
};
