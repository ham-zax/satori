import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isLanguageCapabilitySupportedForExtension } from "@zokizuan/satori-core";
import { McpTool, ToolContext, formatZodError } from "./types.js";
import { ensureAbsolutePath } from "../utils.js";

const readFileInputSchema = z.object({
    path: z.string().min(1).describe("ABSOLUTE path to the file."),
    start_line: z.number().int().positive().optional().describe("Optional start line (1-based, inclusive)."),
    end_line: z.number().int().positive().optional().describe("Optional end line (1-based, inclusive)."),
    mode: z.enum(["plain", "annotated"]).default("plain").optional().describe("Output mode. plain returns text only; annotated returns content plus sidecar-backed outline metadata."),
    open_symbol: z.object({
        symbolId: z.string().min(1).optional().describe("Deterministic symbol identifier to open in the target file."),
        symbolLabel: z.string().min(1).optional().describe("Exact symbol label to open in the target file."),
        start_line: z.number().int().positive().optional().describe("Optional direct symbol span start line (1-based, inclusive)."),
        end_line: z.number().int().positive().optional().describe("Optional direct symbol span end line (1-based, inclusive).")
    }).optional().describe("Optional deterministic symbol jump request for this file path. Uses exact symbol resolution within `path` when symbolId/symbolLabel is provided.")
}).superRefine((input, ctx) => {
    if (!input.open_symbol) {
        return;
    }
    const request = input.open_symbol;
    if (!request.symbolId && !request.symbolLabel && request.start_line === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['open_symbol'],
            message: 'open_symbol requires symbolId, symbolLabel, or start_line.'
        });
    }
});

function splitIntoLines(content: string): string[] {
    if (content.length === 0) {
        return [];
    }

    const lines = content.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, "/");
}

function isOutlineSupportedFile(absolutePath: string): boolean {
    const ext = path.extname(absolutePath).toLowerCase();
    return isLanguageCapabilitySupportedForExtension(ext, "fileOutline");
}

function resolveCodebaseRootForFile(absolutePath: string, ctx: ToolContext): string | undefined {
    const allCodebases = typeof ctx.snapshotManager?.getAllCodebases === "function"
        ? ctx.snapshotManager.getAllCodebases()
        : [];
    if (!Array.isArray(allCodebases)) {
        return undefined;
    }

    const matches = allCodebases
        .map((item) => (item && typeof item.path === "string") ? ensureAbsolutePath(item.path) : undefined)
        .filter((candidate): candidate is string => Boolean(candidate))
        .filter((candidate) => {
            return absolutePath === candidate || absolutePath.startsWith(`${candidate}${path.sep}`);
        });

    if (matches.length === 0) {
        return undefined;
    }

    matches.sort((a, b) => b.length - a.length);
    return matches[0];
}

export const readFileTool: McpTool = {
    name: "read_file",
    description: () => "Read file content from the local filesystem, with optional 1-based inclusive line ranges and safe truncation.",
    inputSchemaZod: () => readFileInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const parsed = readFileInputSchema.safeParse(args || {});
        if (!parsed.success) {
            return {
                content: [{
                    type: "text",
                    text: formatZodError("read_file", parsed.error)
                }],
                isError: true
            };
        }

        const input = parsed.data;
        const mode = input.mode || "plain";

        try {
            const absolutePath = ensureAbsolutePath(input.path);

            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{ type: "text", text: `Error: File '${absolutePath}' not found.` }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isFile()) {
                return {
                    content: [{ type: "text", text: `Error: '${absolutePath}' is not a file.` }],
                    isError: true
                };
            }

            const content = fs.readFileSync(absolutePath, "utf-8");
            const lines = splitIntoLines(content);
            const totalLines = lines.length;

            const maxLines = Math.max(1, ctx.readFileMaxLines);
            const hasStart = input.start_line !== undefined;
            const hasEnd = input.end_line !== undefined;
            let startLine = 1;
            let endLine = totalLines > 0 ? totalLines : 0;
            let addContinuationHint = false;

            if (totalLines === 0) {
                startLine = 1;
                endLine = 0;
            } else if (!hasStart && !hasEnd) {
                if (totalLines > maxLines) {
                    endLine = maxLines;
                    addContinuationHint = true;
                }
            } else if (hasStart && !hasEnd) {
                startLine = clamp(input.start_line as number, 1, totalLines);
                endLine = Math.min(startLine + maxLines - 1, totalLines);
                addContinuationHint = endLine < totalLines;
            } else if (!hasStart && hasEnd) {
                endLine = clamp(input.end_line as number, 1, totalLines);
            } else {
                startLine = clamp(input.start_line as number, 1, totalLines);
                endLine = clamp(input.end_line as number, startLine, totalLines);
            }

            if (input.open_symbol && totalLines > 0) {
                const openSymbol = input.open_symbol;
                const spanStart = Number.isFinite(openSymbol.start_line) ? Number(openSymbol.start_line) : undefined;
                const spanEnd = Number.isFinite(openSymbol.end_line) ? Number(openSymbol.end_line) : undefined;
                if (spanStart !== undefined) {
                    startLine = clamp(spanStart, 1, totalLines);
                    endLine = spanEnd !== undefined
                        ? clamp(spanEnd, startLine, totalLines)
                        : startLine;
                    addContinuationHint = false;
                } else {
                    if (!isOutlineSupportedFile(absolutePath)) {
                        return {
                            content: [{ type: "text", text: `Error opening symbol: file '${absolutePath}' is not outline-capable.` }],
                            isError: true
                        };
                    }

                    const resolvedRoot = resolveCodebaseRootForFile(absolutePath, ctx);
                    const relativeFile = resolvedRoot
                        ? normalizeRelativePath(path.relative(resolvedRoot, absolutePath))
                        : undefined;
                    if (!resolvedRoot || !relativeFile) {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    status: "requires_reindex",
                                    message: "Cannot resolve codebase root for open_symbol. Resolve the indexed repo root first via list_codebases/manage_index status, then reindex that root and retry.",
                                    hints: {
                                        nextSteps: [
                                            "Call list_codebases or manage_index { action: \"status\", path: <repo-root> } to find the indexed root.",
                                            "Run manage_index { action: \"reindex\", path: <repo-root> }.",
                                            "Retry read_file with open_symbol."
                                        ]
                                    }
                                }, null, 2)
                            }],
                            isError: true
                        };
                    }

                    const outlineResponse = await ctx.toolHandlers.handleFileOutline({
                        path: resolvedRoot,
                        file: relativeFile,
                        resolveMode: "exact",
                        symbolIdExact: openSymbol.symbolId,
                        symbolLabelExact: openSymbol.symbolLabel,
                        limitSymbols: 25
                    });
                    const parsedOutline = JSON.parse(outlineResponse.content?.[0]?.text || "{}");
                    if (parsedOutline?.status !== "ok") {
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify({
                                    status: parsedOutline?.status || "not_found",
                                    message: parsedOutline?.message || "Failed to resolve open_symbol request.",
                                    file: relativeFile,
                                    ...(parsedOutline?.outline ? { matches: parsedOutline.outline.symbols } : {}),
                                    ...(parsedOutline?.warnings ? { warnings: parsedOutline.warnings } : {}),
                                    ...(parsedOutline?.hints ? { hints: parsedOutline.hints } : {})
                                }, null, 2)
                            }],
                            isError: true
                        };
                    }

                    const resolvedSymbol = parsedOutline?.outline?.symbols?.[0];
                    if (!resolvedSymbol?.span || !Number.isFinite(resolvedSymbol.span.startLine) || !Number.isFinite(resolvedSymbol.span.endLine)) {
                        return {
                            content: [{ type: "text", text: "Error opening symbol: resolved symbol is missing a valid span." }],
                            isError: true
                        };
                    }
                    startLine = clamp(Number(resolvedSymbol.span.startLine), 1, totalLines);
                    endLine = clamp(Number(resolvedSymbol.span.endLine), startLine, totalLines);
                    addContinuationHint = false;
                }
            }

            const selected = totalLines === 0 ? content : lines.slice(startLine - 1, endLine).join("\n");
            const nextStartLine = addContinuationHint ? endLine + 1 : undefined;
            const hint = addContinuationHint
                ? `\n\n(File truncated at line ${endLine}. To read more, call read_file with path="${absolutePath}" and start_line=${nextStartLine}.)`
                : "";
            const contentWithHint = `${selected}${hint}`;

            if (mode === "plain") {
                return {
                    content: [{
                        type: "text",
                        text: contentWithHint
                    }]
                };
            }

            const supportedByExtension = isOutlineSupportedFile(absolutePath);
            const resolvedRoot = resolveCodebaseRootForFile(absolutePath, ctx);
            const relativeFile = resolvedRoot
                ? normalizeRelativePath(path.relative(resolvedRoot, absolutePath))
                : undefined;
            let outlineStatus: "ok" | "requires_reindex" | "unsupported" | "ambiguous" = supportedByExtension ? "requires_reindex" : "unsupported";
            let outline: { symbols: unknown[] } | null = null;
            let hasMore = false;
            let warnings: string[] | undefined;
            let hints: Record<string, unknown> | undefined;

            if (!supportedByExtension) {
                outlineStatus = "unsupported";
            } else if (!resolvedRoot || !relativeFile) {
                outlineStatus = "requires_reindex";
                hints = {
                    reindex: {
                        tool: "manage_index",
                        args: {
                            action: "reindex",
                            path: path.dirname(absolutePath),
                        },
                    },
                };
            } else {
                try {
                    const outlineResponse = await ctx.toolHandlers.handleFileOutline({
                        path: resolvedRoot,
                        file: relativeFile,
                        start_line: totalLines === 0 ? undefined : startLine,
                        end_line: totalLines === 0 ? undefined : endLine,
                    });
                    const parsedOutline = JSON.parse(outlineResponse.content?.[0]?.text || "{}");
                    const status = parsedOutline?.status;
                    if (status === "ok" || status === "requires_reindex" || status === "unsupported" || status === "ambiguous") {
                        outlineStatus = status;
                    } else {
                        outlineStatus = "requires_reindex";
                    }
                    outline = outlineStatus === "ok" && parsedOutline?.outline ? parsedOutline.outline : null;
                    hasMore = parsedOutline?.hasMore === true;
                    if (Array.isArray(parsedOutline?.warnings)) {
                        warnings = parsedOutline.warnings.filter((item: unknown): item is string => typeof item === "string");
                    }
                    if (parsedOutline?.hints && typeof parsedOutline.hints === "object") {
                        hints = parsedOutline.hints;
                    }
                } catch {
                    outlineStatus = "requires_reindex";
                }
            }

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        path: absolutePath,
                        mode: "annotated",
                        content: contentWithHint,
                        outlineStatus,
                        outline,
                        hasMore,
                        ...(warnings && warnings.length > 0 ? { warnings } : {}),
                        ...(hints ? { hints } : {})
                    }, null, 2)
                }]
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Error reading file: ${error.message}` }],
                isError: true
            };
        }
    }
};
