import { z } from "zod";
import { detectChangeImpact } from "../core/change-impact.js";
import type { CallGraphResponseEnvelope, FileOutlineResponseEnvelope } from "../core/search-types.js";
import { absoluteFilesystemPathSchema, formatZodError, type McpTool } from "./types.js";
import { resolveVectorBackedToolContext } from "./provider-context.js";

const inputSchema = z.object({
    path: absoluteFilesystemPathSchema("Absolute indexed repository root."),
    baseRef: z.string().trim().min(1).max(256).default("HEAD").describe("Git commit/ref compared with the tracked working tree, e.g. HEAD~5. Includes staged and unstaged tracked changes; excludes untracked files."),
    depth: z.number().int().min(1).max(3).default(3).describe("Maximum transitive caller depth."),
    limit: z.number().int().min(1).max(200).default(100).describe("Maximum returned impacted symbols. At most 50 files and 50 seeds are inspected."),
}).strict();

export const detectChangesTool: McpTool = {
    name: "detect_changes",
    description: () => "Compare a Git revision with the tracked working tree, map changed ranges to current indexed symbols, and traverse transitive callers. Bounded advisory impact, not exhaustive blast-radius proof. Persisted ambiguous/unresolved semantic references are returned separately as uncertainCallReferences and are never counted as confirmed impacted symbols. Reports unavailable files/seeds, truncation, and file-level seed fallback. Deleted symbols and stale source require independent verification; does not index or synchronize files.",
    inputSchemaZod: () => inputSchema,
    execute: async (args, ctx) => {
        const parsed = inputSchema.safeParse(args);
        if (!parsed.success) return { content: [{ type: "text", text: formatZodError("detect_changes", parsed.error) }], isError: true };
        try {
            const authorized = ctx.workspacePolicy.authorizePath(parsed.data.path);
            const resolved = await resolveVectorBackedToolContext(ctx, { tool: "detect_changes", path: authorized.canonicalPath });
            if (!resolved.ok) return resolved.response;
            const handlers = resolved.context.toolHandlers;
            const input = { ...parsed.data, path: authorized.canonicalPath };
            const result = await detectChangeImpact(input, {
                outline: async file => {
                    const response = await handlers.handleFileOutline({ path: input.path, file, limitSymbols: 500 }, ctx.workspacePolicy);
                    return JSON.parse(response.content[0].text) as FileOutlineResponseEnvelope;
                },
                callers: async (root, symbol) => {
                    const response = await handlers.handleCallGraph({ path: root,
                        symbolRef: { file: symbol.file, symbolId: symbol.symbolId },
                        direction: "callers", depth: input.depth, limit: input.limit }, ctx.workspacePolicy);
                    return JSON.parse(response.content[0].text) as CallGraphResponseEnvelope;
                },
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
            return { content: [{ type: "text", text: JSON.stringify({ status: "error", path: parsed.data.path,
                message: error instanceof Error ? error.message : String(error) }) }], isError: true };
        }
    },
};
