import { z } from "zod";
import {
    McpTool,
    ToolContext,
    formatZodError,
} from "./types.js";

const buildContinueSearchSchema = (ctx: ToolContext) => z.object({
    handle: z.string()
        .trim()
        .regex(/^[a-f0-9]{48}$/, "must be a 48-character lowercase hexadecimal continuation handle")
        .describe("Opaque handle returned by search_codebase for a frozen ranked result set."),
    expectedOffset: z.number()
        .int()
        .nonnegative()
        .max(ctx.capabilities.getMaxSearchLimit())
        .describe("Exact nextOffset from the search or continuation response. Retrying the same handle, expectedOffset, and limit replays the same page."),
    limit: z.number()
        .int()
        .positive()
        .max(ctx.capabilities.getMaxSearchLimit())
        .optional()
        .describe("Optional maximum number of additional groups. Defaults to the initial disclosure size."),
}).strict();

export const continueSearchTool: McpTool = {
    name: "continue_search",
    description: () =>
        "Return the next groups from a frozen search_codebase result set. Pass the response's exact nextOffset so transport retries are idempotent. Continuation performs no query embedding, vector-store retrieval, or reranking. Handles are process-local, bounded, and expire; stale or unavailable handles require a new search_codebase request.",
    inputSchemaZod: (ctx: ToolContext) => buildContinueSearchSchema(ctx),
    execute: async (args: unknown, ctx: ToolContext) => {
        const schema = buildContinueSearchSchema(ctx);
        const parsed = schema.safeParse(args ?? {});
        if (!parsed.success) {
            return {
                content: [{
                    type: "text",
                    text: formatZodError("continue_search", parsed.error),
                }],
                isError: true,
            };
        }
        return ctx.toolHandlers.handleContinueSearch(parsed.data);
    },
};
