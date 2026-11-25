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
    signal?: AbortSignal,
): Promise<FileOutlineResponseEnvelope> {
    let startLine: number | undefined;
    let merged: FileOutlineResponseEnvelope | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_OUTLINE_PAGES; page += 1) {
        signal?.throwIfAborted();
        const envelope = await fetchPage(startLine);
        signal?.throwIfAborted();
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
    path: absoluteFilesystemPathSchema("Absolute indexed repository root, or a directory inside it to limit the diff to that directory."),
    baseRef: z.string().trim().min(1).max(256).default("HEAD").describe("Git commit/ref compared with the tracked working tree, e.g. HEAD~5. Includes staged and unstaged tracked changes; excludes untracked files."),
    depth: z.number().int().min(1).max(3).default(3).describe("Maximum transitive caller depth."),
    limit: z.number().int().min(1).max(200).default(25).describe("Maximum returned impacted symbols. At most 50 files and 50 seeds are inspected."),
}).strict();

export const detectChangesTool: McpTool = {
    name: "detect_changes",
    description: () => "Diff a Git revision against the tracked working tree, map changed lines to indexed symbols (reporting spanBasis=current|published), and traverse bounded inbound CALLS. Separates seeds from direct/transitive callers with causal paths and evidenceClass=proof_backed|heuristic, and reports uncertainCallReferences and completeness bounds. When space permits, includes candidate tests in directSeedTestReferences with testReferenceCoverage. Advisory, not exhaustive blast-radius proof.",
    inputSchemaZod: () => inputSchema,
    execute: async (args, ctx) => {
        const parsed = inputSchema.safeParse(args);
        if (!parsed.success) return { content: [{ type: "text", text: formatZodError("detect_changes", parsed.error) }], isError: true };
        try {
            ctx.requestSignal?.throwIfAborted();
            const authorized = ctx.workspacePolicy.authorizePath(parsed.data.path);
            const resolved = await resolveVectorBackedToolContext(ctx, { tool: "detect_changes", path: authorized.canonicalPath });
            if (!resolved.ok) return resolved.response;
            const handlers = resolved.context.toolHandlers;
            // An unindexed path keeps itself as the root; its outlines then report not_indexed.
            const input = { ...parsed.data, path: authorized.canonicalPath,
                codebaseRoot: handlers.resolveIndexedRoot(authorized.canonicalPath) ?? authorized.canonicalPath };
            const result = await detectChangeImpact(input, {
                outline: (file, publishedSource) => readCompleteFileOutline(async startLine => {
                    const response = await handlers.handleFileOutline({ path: input.path, file, limitSymbols: 500,
                        ...(startLine === undefined ? {} : { start_line: startLine }) }, ctx.workspacePolicy, {
                        requireCurrentSource: true,
                        signal: ctx.requestSignal,
                        ...(publishedSource ? { publishedSource } : {}),
                    });
                    return JSON.parse(response.content[0].text) as FileOutlineResponseEnvelope;
                }, ctx.requestSignal),
                callers: async (root, symbol, publishedSource) => {
                    const callGraphArgs = {
                        path: root,
                        symbolRef: { file: symbol.file, symbolId: symbol.symbolId },
                        direction: "callers",
                        depth: input.depth,
                        limit: input.limit,
                    };
                    const sourceOptions = publishedSource ? { publishedSource } : undefined;
                    if (typeof handlers.resolveUnprojectedCallGraph === "function") {
                        return handlers.resolveUnprojectedCallGraph(callGraphArgs, ctx.workspacePolicy, ctx.requestSignal, sourceOptions);
                    }
                    const response = await handlers.handleCallGraph(callGraphArgs, ctx.workspacePolicy, ctx.requestSignal, sourceOptions);
                    return JSON.parse(response.content[0].text) as CallGraphResponseEnvelope;
                },
            }, ctx.requestSignal);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
            return { content: [{ type: "text", text: JSON.stringify({ status: "error", path: parsed.data.path,
                message: error instanceof Error ? error.message : String(error) }) }], isError: true };
        }
    },
};
