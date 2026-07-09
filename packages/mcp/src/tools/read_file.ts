import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isLanguageCapabilitySupportedForExtension } from "@zokizuan/satori-core";
import { McpTool, ToolContext, formatZodError } from "./types.js";
import { resolveVectorBackedToolContext } from "./provider-context.js";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import type {
    ReadFileAnnotatedOutlineStatus,
    ReadFileAnnotatedResponseEnvelope,
    ReadFileOpenSymbolResponseEnvelope,
} from "../core/search-types.js";

const readFileInputSchema = z.object({
    path: z.string().min(1).describe("ABSOLUTE path to the file."),
    start_line: z.number().int().positive().optional().describe("Optional start line (1-based, inclusive)."),
    end_line: z.number().int().positive().optional().describe("Optional end line (1-based, inclusive)."),
    mode: z.enum(["plain", "annotated"]).default("plain").optional().describe("Output mode. plain returns text only; annotated returns content plus sidecar-backed outline metadata."),
    open_symbol: z.object({
        symbolId: z.string().min(1).optional().describe("Deterministic symbol identifier to open in the target file. On symbol-owned flows, this should carry the symbolInstanceId."),
        symbolLabel: z.string().min(1).optional().describe("Exact symbol label to open in the target file."),
        start_line: z.number().int().positive().optional().describe("Optional direct symbol span start line (1-based, inclusive)."),
        end_line: z.number().int().positive().optional().describe("Optional direct symbol span end line (1-based, inclusive).")
    }).optional().describe("Optional deterministic symbol jump request for this file path. Uses exact symbol resolution within `path` when symbolId/symbolLabel is provided, and only uses direct span opens when no symbol identity fields are supplied. On symbol-owned flows, symbolId should carry the symbolInstanceId.")
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

type ReadFileSearchableStatus = 'indexed' | 'sync_completed' | 'indexing';
type ReadFileCodebaseCandidate = {
    path: string;
    status: ReadFileSearchableStatus;
};

type ReadFileIndexingBlock = {
    codebaseRoot: string;
    progressPct: number | null;
    lastUpdated: string | null;
};

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

const READ_FILE_DISCOVERY_STATUSES = new Set<ReadFileSearchableStatus>(['indexed', 'sync_completed', 'indexing']);
const READ_FILE_RESOLVE_STATUSES = new Set<ReadFileSearchableStatus>(['indexed', 'sync_completed']);
/** Statuses that may serve file content via read_file. */
const READ_FILE_CONTENT_ALLOW_STATUSES = new Set<ReadFileSearchableStatus>(['indexed', 'sync_completed']);

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readFileErrorResponse(payload: ReadFileOpenSymbolResponseEnvelope) {
    return {
        content: [{
            type: "text" as const,
            text: JSON.stringify(payload, null, 2)
        }],
        isError: true
    };
}

function outsideIndexedRootResponse(requestedPath: string): ToolTextResponse {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: "outside_indexed_root",
                reason: "outside_indexed_root",
                path: requestedPath,
                message: `Error: path '${requestedPath}' is not under an indexed/searchable codebase root. Use list_codebases to find tracked roots, or manage_index action=create to index this repository first, then retry with an absolute path under that root.`,
                hints: {
                    nextSteps: [
                        { tool: "list_codebases", args: {} }
                    ]
                }
            }, null, 2)
        }],
        isError: true
    };
}

function relativePathRejectedResponse(requestedPath: string): ToolTextResponse {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: "outside_indexed_root",
                reason: "relative_path_not_allowed",
                path: requestedPath,
                message: `Error: path '${requestedPath}' must be an absolute path under an indexed/searchable codebase root.`,
                hints: {
                    nextSteps: [
                        { tool: "list_codebases", args: {} }
                    ]
                }
            }, null, 2)
        }],
        isError: true
    };
}

function toReadFileSearchableStatus(status: unknown): ReadFileSearchableStatus | undefined {
    if (status === 'indexed' || status === 'sync_completed' || status === 'indexing') {
        return status;
    }
    return undefined;
}

function refreshSnapshotState(ctx: ToolContext): void {
    const snapshotManager = ctx.snapshotManager as unknown as {
        refreshFromDiskIfChanged?: () => boolean;
    };
    if (typeof snapshotManager.refreshFromDiskIfChanged === 'function') {
        snapshotManager.refreshFromDiskIfChanged();
    }
}

/**
 * Resolve to an absolute path and, when the target exists, its real path
 * (follows symlinks). Non-existent paths keep path.resolve output so `..`
 * segments are still collapsed.
 */
function canonicalizeFilesystemPath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
    return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function collectCodebaseCandidatesForFile(
    absolutePath: string,
    ctx: ToolContext,
    allowedStatuses: ReadonlySet<ReadFileSearchableStatus>
): ReadFileCodebaseCandidate[] {
    refreshSnapshotState(ctx);
    const allCodebases = typeof ctx.snapshotManager?.getAllCodebases === "function"
        ? ctx.snapshotManager.getAllCodebases()
        : [];
    if (!Array.isArray(allCodebases)) {
        return [];
    }

    const canonicalTarget = canonicalizeFilesystemPath(absolutePath);
    const candidates: ReadFileCodebaseCandidate[] = [];
    for (const item of allCodebases) {
        if (!item || typeof item.path !== "string") {
            continue;
        }
        // Snapshot roots must already be absolute. Never CWD-resolve relative/legacy roots.
        const rootResult = requireAbsoluteFilesystemPath(item.path, "codebase.path");
        if (!rootResult.ok) {
            continue;
        }
        const candidatePath = canonicalizeFilesystemPath(rootResult.absolutePath);
        if (!isPathInsideRoot(canonicalTarget, candidatePath)) {
            continue;
        }
        const status = toReadFileSearchableStatus(item.info?.status);
        if (!status || !allowedStatuses.has(status)) {
            continue;
        }
        candidates.push({ path: candidatePath, status });
    }

    candidates.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
    return candidates;
}

/**
 * Returns the longest searchable root that contains the canonical path, or undefined.
 * Only `indexed` and `sync_completed` roots may serve content.
 */
function resolveContentAllowedRoot(canonicalPath: string, ctx: ToolContext): string | undefined {
    const candidates = collectCodebaseCandidatesForFile(canonicalPath, ctx, READ_FILE_CONTENT_ALLOW_STATUSES);
    return candidates[0]?.path;
}

function buildRootDiscoveryNextSteps(absolutePath: string, ctx: ToolContext): Array<{ tool: string; args: Record<string, unknown> }> {
    const candidates = collectCodebaseCandidatesForFile(absolutePath, ctx, READ_FILE_DISCOVERY_STATUSES);
    if (candidates.length !== 1) {
        return [{ tool: "list_codebases", args: {} }];
    }

    const [{ path: candidateRoot, status }] = candidates;
    const nextSteps: Array<{ tool: string; args: Record<string, unknown> }> = [
        { tool: "manage_index", args: { action: "status", path: candidateRoot } }
    ];
    if (status !== 'indexing') {
        nextSteps.push({ tool: "manage_index", args: { action: "reindex", path: candidateRoot } });
    }
    return nextSteps;
}

function isOutlineSupportedFile(absolutePath: string): boolean {
    const ext = path.extname(absolutePath).toLowerCase();
    return isLanguageCapabilitySupportedForExtension(ext, "fileOutline");
}

function resolveCodebaseRootForFile(absolutePath: string, ctx: ToolContext): string | undefined {
    const candidates = collectCodebaseCandidatesForFile(absolutePath, ctx, READ_FILE_RESOLVE_STATUSES);
    if (candidates.length === 0) {
        return undefined;
    }
    return candidates[0].path;
}

async function touchResolvedCodebaseRoot(absolutePath: string, ctx: ToolContext): Promise<void> {
    const codebaseRoot = resolveCodebaseRootForFile(absolutePath, ctx);
    if (!codebaseRoot) {
        return;
    }

    const syncManager = ctx.syncManager as unknown as {
        touchWatchedCodebase?: (path: string) => Promise<void> | void;
        registerCodebaseWatcher?: (path: string) => Promise<void> | void;
    };

    if (typeof syncManager.touchWatchedCodebase === "function") {
        await syncManager.touchWatchedCodebase(codebaseRoot);
        return;
    }

    if (typeof syncManager.registerCodebaseWatcher === "function") {
        await syncManager.registerCodebaseWatcher(codebaseRoot);
    }
}

function resolveIndexingBlockForFile(absolutePath: string, ctx: ToolContext): ReadFileIndexingBlock | undefined {
    refreshSnapshotState(ctx);
    const allCodebases = typeof ctx.snapshotManager?.getAllCodebases === "function"
        ? ctx.snapshotManager.getAllCodebases()
        : [];
    if (!Array.isArray(allCodebases)) {
        return undefined;
    }

    const canonicalTarget = canonicalizeFilesystemPath(absolutePath);
    const candidates: Array<{
        codebaseRoot: string;
        info: { indexingPercentage: number; lastUpdated: string };
        matches: boolean;
    }> = [];

    for (const item of allCodebases) {
        if (!item || typeof item.path !== "string" || !item.info || item.info.status !== "indexing") {
            continue;
        }
        // Snapshot roots must already be absolute. Never CWD-resolve relative/legacy roots.
        const rootResult = requireAbsoluteFilesystemPath(item.path, "codebase.path");
        if (!rootResult.ok) {
            continue;
        }
        const codebaseRoot = canonicalizeFilesystemPath(rootResult.absolutePath);
        candidates.push({
            codebaseRoot,
            info: item.info,
            matches: isPathInsideRoot(canonicalTarget, codebaseRoot)
        });
    }

    const matchingCandidates = candidates
        .filter((item) => item.matches)
        .sort((a, b) => b.codebaseRoot.length - a.codebaseRoot.length || a.codebaseRoot.localeCompare(b.codebaseRoot));

    if (matchingCandidates.length === 0) {
        return undefined;
    }

    const match = matchingCandidates[0];
    const progressRaw = match.info?.indexingPercentage;
    const lastUpdatedRaw = match.info?.lastUpdated;
    return {
        codebaseRoot: match.codebaseRoot,
        progressPct: Number.isFinite(progressRaw) ? Number(progressRaw) : null,
        lastUpdated: typeof lastUpdatedRaw === "string" ? lastUpdatedRaw : null
    };
}

export const readFileTool: McpTool = {
    name: "read_file",
    description: () =>
        "Read file content under an indexed/searchable Satori codebase root only (not a general host filesystem reader). Requires an absolute path whose canonical real path is inside a tracked root with status indexed or sync_completed. Supports optional 1-based inclusive line ranges and safe truncation.",
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
            if (!path.isAbsolute(input.path)) {
                return relativePathRejectedResponse(input.path);
            }

            // Collapse . / .. segments; realpath when the path (or a prefix) exists.
            const resolvedPath = path.resolve(input.path);
            const absolutePath = canonicalizeFilesystemPath(resolvedPath);
            const wantsStructuredError = mode === "annotated" || Boolean(input.open_symbol);

            // Fail closed: deny content access outside searchable roots before any content read.
            // Indexing roots are handled next with not_ready (still no content).
            const indexingBlock = resolveIndexingBlockForFile(absolutePath, ctx);
            if (indexingBlock) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            status: "not_ready",
                            reason: "indexing",
                            path: absolutePath,
                            codebaseRoot: indexingBlock.codebaseRoot,
                            message: `Codebase '${indexingBlock.codebaseRoot}' is currently indexing. Wait for indexing to complete, then retry.`,
                            hints: {
                                status: {
                                    tool: "manage_index",
                                    args: {
                                        action: "status",
                                        path: indexingBlock.codebaseRoot
                                    }
                                },
                                debugIndexing: {
                                    completionProof: "marker_doc"
                                }
                            },
                            indexing: {
                                progressPct: indexingBlock.progressPct,
                                lastUpdated: indexingBlock.lastUpdated,
                                phase: null
                            }
                        }, null, 2)
                    }]
                };
            }

            const allowedRoot = resolveContentAllowedRoot(absolutePath, ctx);
            if (!allowedRoot) {
                return outsideIndexedRootResponse(absolutePath);
            }

            if (!fs.existsSync(absolutePath)) {
                if (wantsStructuredError) {
                    return readFileErrorResponse({
                        status: "not_found",
                        message: `Error: File '${absolutePath}' not found.`,
                    });
                }
                return {
                    content: [{ type: "text", text: `Error: File '${absolutePath}' not found.` }],
                    isError: true
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isFile()) {
                if (wantsStructuredError) {
                    return readFileErrorResponse({
                        status: "not_found",
                        message: `Error: '${absolutePath}' is not a file.`,
                    });
                }
                return {
                    content: [{ type: "text", text: `Error: '${absolutePath}' is not a file.` }],
                    isError: true
                };
            }

            await touchResolvedCodebaseRoot(absolutePath, ctx);

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
                const hasExactIdentity = Boolean(openSymbol.symbolId || openSymbol.symbolLabel);
                const spanStart = Number.isFinite(openSymbol.start_line) ? Number(openSymbol.start_line) : undefined;
                const spanEnd = Number.isFinite(openSymbol.end_line) ? Number(openSymbol.end_line) : undefined;
                if (hasExactIdentity) {
                    if (!isOutlineSupportedFile(absolutePath)) {
                        return readFileErrorResponse({
                            status: "unsupported",
                            reason: "unsupported_language",
                            message: `Error opening symbol: file '${absolutePath}' is not outline-capable.`,
                        });
                    }

                    const resolvedRoot = resolveCodebaseRootForFile(absolutePath, ctx);
                    const relativeFile = resolvedRoot
                        ? normalizeRelativePath(path.relative(resolvedRoot, absolutePath))
                        : undefined;
                    if (!resolvedRoot || !relativeFile) {
                        const nextSteps = buildRootDiscoveryNextSteps(absolutePath, ctx);
                        const payload: ReadFileOpenSymbolResponseEnvelope = {
                            status: "requires_reindex",
                            message: "Cannot resolve codebase root for open_symbol. Resolve the indexed repo root first via list_codebases/manage_index status, then reindex that root and retry.",
                            hints: {
                                nextSteps
                            }
                        };
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify(payload, null, 2)
                            }],
                            isError: true
                        };
                    }

                    const executionContext = await resolveVectorBackedToolContext(ctx, {
                        tool: "read_file",
                        path: resolvedRoot,
                        file: relativeFile,
                        messagePrefix: "Cannot resolve open_symbol because navigation readiness could not be verified.",
                    });
                    if (!executionContext.ok) {
                        return executionContext.response;
                    }

                    const outlineResponse = await executionContext.context.toolHandlers.handleFileOutline({
                        path: resolvedRoot,
                        file: relativeFile,
                        resolveMode: "exact",
                        symbolIdExact: openSymbol.symbolId,
                        symbolLabelExact: openSymbol.symbolLabel,
                        limitSymbols: 25
                    });
                    const parsedOutline = JSON.parse(outlineResponse.content?.[0]?.text || "{}");
                    if (parsedOutline?.status !== "ok") {
                        const payload: ReadFileOpenSymbolResponseEnvelope = {
                            status: parsedOutline?.status || "not_found",
                            ...(typeof parsedOutline?.reason === "string" ? { reason: parsedOutline.reason } : {}),
                            message: parsedOutline?.message || "Failed to resolve open_symbol request.",
                            file: relativeFile,
                            ...(parsedOutline?.outline ? { matches: parsedOutline.outline.symbols } : {}),
                            ...(parsedOutline?.warnings ? { warnings: parsedOutline.warnings } : {}),
                            ...(parsedOutline?.hints ? { hints: parsedOutline.hints } : {}),
                            ...(parsedOutline?.indexingFailure ? { indexingFailure: parsedOutline.indexingFailure } : {})
                        };
                        return {
                            content: [{
                                type: "text",
                                text: JSON.stringify(payload, null, 2)
                            }],
                            isError: true
                        };
                    }

                    const resolvedSymbol = parsedOutline?.outline?.symbols?.[0];
                    if (!resolvedSymbol?.span || !Number.isFinite(resolvedSymbol.span.startLine) || !Number.isFinite(resolvedSymbol.span.endLine)) {
                        return readFileErrorResponse({
                            status: "not_found",
                            reason: "missing_symbol",
                            message: "Error opening symbol: resolved symbol is missing a valid span.",
                        });
                    }
                    startLine = clamp(Number(resolvedSymbol.span.startLine), 1, totalLines);
                    endLine = clamp(Number(resolvedSymbol.span.endLine), startLine, totalLines);
                    addContinuationHint = false;
                } else if (spanStart !== undefined) {
                    startLine = clamp(spanStart, 1, totalLines);
                    endLine = spanEnd !== undefined
                        ? clamp(spanEnd, startLine, totalLines)
                        : startLine;
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
            let outlineStatus: ReadFileAnnotatedOutlineStatus = supportedByExtension ? "requires_reindex" : "unsupported";
            let outline: { symbols: unknown[] } | null = null;
            let hasMore = false;
            let warnings: string[] | undefined;
            let hints: Record<string, unknown> | undefined;

            if (!supportedByExtension) {
                outlineStatus = "unsupported";
            } else if (!resolvedRoot || !relativeFile) {
                outlineStatus = "requires_reindex";
                const nextSteps = buildRootDiscoveryNextSteps(absolutePath, ctx);
                hints = {
                    nextSteps
                };
            } else {
                try {
                    const executionContext = await resolveVectorBackedToolContext(ctx, {
                        tool: "read_file",
                        path: resolvedRoot,
                        file: relativeFile,
                        messagePrefix: "Annotated outline metadata is unavailable because navigation readiness could not be verified.",
                    });
                    if (!executionContext.ok) {
                        const parsedFailure = JSON.parse(executionContext.response.content?.[0]?.text || "{}");
                        outlineStatus = "requires_reindex";
                        if (parsedFailure?.hints && typeof parsedFailure.hints === "object") {
                            hints = parsedFailure.hints;
                        }
                    } else {
                        const outlineResponse = await executionContext.context.toolHandlers.handleFileOutline({
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
                    }
                } catch {
                    outlineStatus = "requires_reindex";
                }
            }

            const payload: ReadFileAnnotatedResponseEnvelope = {
                path: absolutePath,
                mode: "annotated",
                content: contentWithHint,
                outlineStatus,
                outline,
                hasMore,
                ...(warnings && warnings.length > 0 ? { warnings } : {}),
                ...(hints ? { hints } : {})
            };
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(payload, null, 2)
                }]
            };
        } catch (error) {
            if (mode === "annotated" || input.open_symbol) {
                return readFileErrorResponse({
                    status: "not_ready",
                    message: `Error reading file: ${errorMessage(error)}`,
                });
            }
            return {
                content: [{ type: "text", text: `Error reading file: ${errorMessage(error)}` }],
                isError: true
            };
        }
    }
};
