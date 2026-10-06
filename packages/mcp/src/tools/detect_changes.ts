import { z } from "zod";
import { detectChangeImpact } from "../core/change-impact.js";
import type { CallGraphResponseEnvelope, FileOutlineResponseEnvelope } from "../core/search-types.js";
import { absoluteFilesystemPathSchema, formatZodError, type McpTool } from "./types.js";
import { resolveVectorBackedToolContext } from "./provider-context.js";

const MAX_OUTLINE_PAGES = 40;

/**
 * file_outline pages large files under its byte budget; change seeding needs every
 * member symbol, or hunks inside a big class map only to the enclosing class.
 */
export async function readCompleteFileOutline(
    fetchPage: (startLine: number | undefined) => Promise<FileOutlineResponseEnvelope>,
): Promise<FileOutlineResponseEnvelope> {
    let startLine: number | undefined;
    let merged: FileOutlineResponseEnvelope | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_OUTLINE_PAGES; page += 1) {
        const envelope = await fetchPage(startLine);
        if (envelope.status !== "ok" || !envelope.outline) return merged ?? envelope;
        // Pages repeat enclosing symbols that overlap their window.
        const symbols = envelope.outline.symbols.filter(symbol => !seen.has(symbol.symbolId));
        for (const symbol of symbols) seen.add(symbol.symbolId);
        merged = merged
            ? { ...merged, hasMore: envelope.hasMore,
                outline: { ...merged.outline!, symbols: [...merged.outline!.symbols, ...symbols] } }
            : envelope;
        const next = (envelope.hints as { nextPage?: { args?: { start_line?: number } } } | undefined)?.nextPage?.args?.start_line;
        if (next === undefined) return merged;
        startLine = next;
    }
    return merged!;
}

const inputSchema = z.object({
    path: absoluteFilesystemPathSchema("Absolute indexed repository root."),
    baseRef: z.string().trim().min(1).max(256).default("HEAD").describe("Git commit/ref compared with the tracked working tree, e.g. HEAD~5. Includes staged and unstaged tracked changes; excludes untracked files."),
    depth: z.number().int().min(1).max(3).default(3).describe("Maximum transitive caller depth."),
    limit: z.number().int().min(1).max(200).default(100).describe("Maximum returned impacted symbols. At most 50 files and 50 seeds are inspected."),
}).strict();

export const detectChangesTool: McpTool = {
    name: "detect_changes",
    description: () => "Compare a Git revision with the tracked working tree, map changed ranges to current indexed symbols, and traverse bounded inbound CALLS. Seeds are labeled separately; graph-derived callers are labeled direct or transitive and retain causal CALLS paths back to the changed seed. Each impacted node declares evidenceClass=proof_backed or heuristic, and every causal-path edge preserves strategy, confidence, and resolution authority so heuristic CALLS are never presented as semantic proof. areaImpact breaks those evidence classes out explicitly. Persisted ambiguous/unresolved semantic references remain separate in uncertainCallReferences. completeness discloses depth, limit, unavailable-navigation, heuristic-path, and uncertainty bounds; this is advisory and never an exhaustive blast-radius proof.",
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
                outline: file => readCompleteFileOutline(async startLine => {
                    const response = await handlers.handleFileOutline({ path: input.path, file, limitSymbols: 500,
                        ...(startLine === undefined ? {} : { start_line: startLine }) }, ctx.workspacePolicy);
                    return JSON.parse(response.content[0].text) as FileOutlineResponseEnvelope;
                }),
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
