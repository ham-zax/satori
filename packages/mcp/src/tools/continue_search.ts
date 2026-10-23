import { z } from "zod";
import { SEARCH_DEFAULT_DISCLOSURE_LIMIT } from "../core/search-constants.js";
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
        .max(ctx.capabilities.getMaxFrozenSearchResults())
        .describe("Exact nextOffset from the search or continuation response. Retrying the same handle, expectedOffset, and limit replays the same page."),
    limit: z.number()
        .int()
        .positive()
        .max(ctx.capabilities.getMaxSearchPageSize())
        .optional()
        .describe(`Optional maximum number of additional groups, up to ${ctx.capabilities.getMaxSearchPageSize()}. Defaults to the initial disclosure size (normally ${SEARCH_DEFAULT_DISCLOSURE_LIMIT}). Each call can request a different size, subject to remaining results and response byte limits.`),
}).strict();

export const continueSearchTool: McpTool = {
    name: "continue_search",
    description: () =>
        "Reveal additional groups from the same frozen search_codebase ranking. Pass the response's exact handle and nextOffset; no new retrieval or reranking occurs. Handles are process-local and expire, so start a new search_codebase request when a handle is stale or unavailable.",
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
