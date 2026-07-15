import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
    beginSourceMeasurementObservation,
    finishSourceMeasurementObservation,
    isLanguageCapabilitySupportedForExtension,
    recordSourceIo,
    recordSourceProcessing,
} from "@zokizuan/satori-core";
import {
    McpTool,
    ToolContext,
    absoluteFilesystemPathSchema,
    formatZodError,
} from "./types.js";
import { resolveVectorBackedToolContext } from "./provider-context.js";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import type {
    ReadFileAnnotatedOutlineStatus,
    ReadFileAnnotatedResponseEnvelope,
    ReadFileStructuredErrorResponseEnvelope,
} from "../core/search-types.js";
import {
    SYMBOL_CONTEXT_FORMAT_VERSION,
    SYMBOL_CONTEXT_KIND,
    SYMBOL_CONTEXT_LIMITS,
    composePublicSymbolContextEnvelope,
    exactSymbolOpenRequestSchema,
    openSymbolRequestSchema,
    resolveSymbolContextOperation,
    type ExactSymbolOpenRequest,
    type ResolvedSymbolContextOperation,
} from "../core/symbol-context-public-contract.js";

export const readFileInputSchema = z.object({
    path: absoluteFilesystemPathSchema(
        "ABSOLUTE path to the file under an indexed/searchable codebase root (relative paths are rejected).",
    ),
    start_line: z.number().int().positive().optional().describe("Optional start line (1-based, inclusive)."),
    end_line: z.number().int().positive().optional().describe("Optional end line (1-based, inclusive)."),
    mode: z.enum(["plain", "annotated"]).optional().describe("Output mode. Required for exact-symbol context requests. Other reads default to plain."),
    open_symbol: openSymbolRequestSchema.optional().describe("Strict exact-symbol context or direct-span request. Exact symbols require contractVersion 2 and exactly one context or continuation operation; direct spans use one-based inclusive startLine/endLine.")
}).strict().superRefine((input, ctx) => {
    if (!input.open_symbol) return;
    if (input.start_line !== undefined || input.end_line !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["open_symbol"],
            message: "open_symbol cannot be combined with top-level line ranges.",
        });
    }
    if (exactSymbolOpenRequestSchema.safeParse(input.open_symbol).success && input.mode === undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["mode"],
            message: "mode is required for exact-symbol context requests.",
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

function readFileErrorResponse(payload: ReadFileStructuredErrorResponseEnvelope) {
    return {
        content: [{
            type: "text" as const,
            text: JSON.stringify(payload, null, 2)
        }],
        isError: true
    };
}

type SymbolContextErrorCode =
    | "STALE_CONTINUATION"
    | "AMBIGUOUS_SYMBOL"
    | "SYMBOL_NOT_FOUND"
    | "NAVIGATION_UNAVAILABLE"
    | "INVALID_RELATIONSHIP_CONTINUATION"
    | "UNSUPPORTED_CONTINUATION_KIND"
    | "ROOT_BINDING_INVALID"
    | "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT";

function symbolContextErrorResponse(input: {
    code: SymbolContextErrorCode;
    reason: string;
    message: string;
    extra?: Record<string, string | number>;
}): ToolTextResponse {
    const payload = {
        formatVersion: SYMBOL_CONTEXT_FORMAT_VERSION,
        kind: SYMBOL_CONTEXT_KIND,
        status: "error",
        code: input.code,
        reason: input.reason,
        ...input.extra,
        message: input.message,
    };
    const serialized = JSON.stringify(payload);
    const errorLimit = input.code === "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT"
        || input.code === "ROOT_BINDING_INVALID"
        ? SYMBOL_CONTEXT_LIMITS.emergencyErrorLimitBytes
        : SYMBOL_CONTEXT_LIMITS.acceptedErrorLimitBytes;
    if (Buffer.byteLength(serialized, "utf8") > errorLimit) {
        throw new Error("The fixed symbol-context error envelope exceeded its transport limit.");
    }
    return {
        content: [{ type: "text", text: serialized }],
        isError: true,
    };
}

function isExactSymbolRequest(
    request: z.infer<typeof openSymbolRequestSchema> | undefined,
): request is ExactSymbolOpenRequest {
    return exactSymbolOpenRequestSchema.safeParse(request).success;
}

function composeSymbolContextRequest(input: {
    root: string;
    relativeFile: string;
    request: ExactSymbolOpenRequest;
    operation: Exclude<ResolvedSymbolContextOperation, { kind: "unsupported_continuation" }>;
}) {
    return {
        codebaseRoot: input.root,
        relativeFile: input.relativeFile,
        ...(input.request.symbolId
            ? { symbolId: input.request.symbolId }
            : { symbolLabel: input.request.symbolLabel as string }),
        include: input.operation.include,
        budgets: input.operation.budgets,
        ...(input.operation.kind === "context" && input.operation.query
            ? { query: input.operation.query }
            : {}),
        ...(input.operation.kind === "continuation"
            ? { continuation: input.operation.continuation }
            : {}),
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
        "Read source only under an indexed/searchable Satori root. Ordinary reads and unversioned open_symbol startLine/endLine requests return source text. Exact symbolId/symbolLabel requests require mode plus open_symbol contractVersion 2 and exactly one context or continuation operation; they return one bounded structured symbol_context package in both modes. The canonical real path must remain inside a tracked indexed or sync_completed root.",
    inputSchemaZod: () => readFileInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const parsed = readFileInputSchema.safeParse(args || {});
        if (!parsed.success) {
            // Preserve structured relative-path rejection for agent recovery when path is the failure.
            const rawArgs = args && typeof args === "object" ? args as Record<string, unknown> : {};
            const rawPath = typeof rawArgs.path === "string" ? rawArgs.path : "";
            const pathFailedAbsolute = parsed.error.issues.some((issue) => (
                issue.path[0] === "path"
                && !path.isAbsolute(rawPath)
            ));
            if (rawPath.length > 0 && pathFailedAbsolute) {
                return relativePathRejectedResponse(rawPath);
            }
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
        const exactRequest = isExactSymbolRequest(input.open_symbol)
            ? input.open_symbol
            : undefined;

        try {
            // Schema already requires an absolute path; collapse . / .. and realpath when present.
            const resolvedPath = path.resolve(input.path);
            const absolutePath = canonicalizeFilesystemPath(resolvedPath);
            const wantsStructuredError = mode === "annotated" || Boolean(input.open_symbol);

            // Fail closed: deny content access outside searchable roots before any content read.
            // Indexing roots are handled next with not_ready (still no content).
            const indexingBlock = resolveIndexingBlockForFile(absolutePath, ctx);
            if (indexingBlock) {
                if (exactRequest) {
                    return symbolContextErrorResponse({
                        code: "NAVIGATION_UNAVAILABLE",
                        reason: "navigation_unavailable",
                        message: "Current navigation authority is unavailable; wait for indexing to complete and retry.",
                    });
                }
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
                if (exactRequest) {
                    return symbolContextErrorResponse({
                        code: "NAVIGATION_UNAVAILABLE",
                        reason: "navigation_unavailable",
                        message: "Current navigation authority is unavailable; refresh the indexed root state and retry.",
                    });
                }
                return outsideIndexedRootResponse(absolutePath);
            }

            if (exactRequest) {
                const relativeFile = normalizeRelativePath(path.relative(allowedRoot, absolutePath));
                const operation = resolveSymbolContextOperation({
                    mode: input.mode as "plain" | "annotated",
                    request: exactRequest,
                });
                if (operation.kind === "unsupported_continuation") {
                    return symbolContextErrorResponse({
                        code: "UNSUPPORTED_CONTINUATION_KIND",
                        reason: "unsupported_continuation_kind",
                        message: "The requested symbol-context continuation kind is unsupported.",
                    });
                }

                await touchResolvedCodebaseRoot(absolutePath, ctx);
                const result = await ctx.toolHandlers.composeSymbolContext(
                    composeSymbolContextRequest({
                        root: allowedRoot,
                        relativeFile,
                        request: exactRequest,
                        operation,
                    }),
                );
                if (result.status === "ok") {
                    const payload = composePublicSymbolContextEnvelope({
                        effectiveRequest: operation.effectiveRequest,
                        context: result.context,
                    });
                    const serialized = JSON.stringify(payload);
                    const hardLimit = operation.effectiveRequest.budgets.totalResponseBytes;
                    if (Buffer.byteLength(serialized, "utf8") > hardLimit) {
                        return symbolContextErrorResponse({
                            code: "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT",
                            reason: "minimum_safe_package_exceeds_limit",
                            message: "The exact symbol cannot be represented safely within the bounded response contract.",
                            extra: {
                                symbolId: result.context.symbol.symbolId,
                                minimumRequiredResponseBytes: Buffer.byteLength(serialized, "utf8"),
                                hardResponseLimitBytes: SYMBOL_CONTEXT_LIMITS.hardResponseLimitBytes,
                            },
                        });
                    }
                    return {
                        content: [{ type: "text", text: serialized }],
                    };
                }

                switch (result.status) {
                    case "symbol_not_found":
                        return symbolContextErrorResponse({
                            code: "SYMBOL_NOT_FOUND",
                            reason: "symbol_not_found",
                            message: "No exact symbol matched the current navigation snapshot.",
                        });
                    case "ambiguous_symbol":
                        return symbolContextErrorResponse({
                            code: "AMBIGUOUS_SYMBOL",
                            reason: "ambiguous_symbol",
                            message: "The exact symbol label resolves to more than one current symbol.",
                        });
                    case "stale_continuation":
                        return symbolContextErrorResponse({
                            code: "STALE_CONTINUATION",
                            reason: "continuation_identity_changed",
                            message: "The continuation no longer matches current evidence; request fresh symbol context.",
                        });
                    case "invalid_relationship_continuation":
                        return symbolContextErrorResponse({
                            code: "INVALID_RELATIONSHIP_CONTINUATION",
                            reason: "invalid_relationship_continuation",
                            message: "The relationship cursor is invalid for the current traversal.",
                        });
                    case "safety_error":
                        return symbolContextErrorResponse({
                            code: "ROOT_BINDING_INVALID",
                            reason: "root_binding_invalid",
                            message: "Source evidence could not be bound safely to the indexed root.",
                        });
                    case "resource_limit": {
                        const publicLimit = operation.effectiveRequest.budgets.totalResponseBytes;
                        const wrapperBytes = publicLimit - operation.budgets.maxSerializedResponseBytes;
                        return symbolContextErrorResponse({
                            code: "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT",
                            reason: "minimum_safe_package_exceeds_limit",
                            message: "The exact symbol cannot be represented safely within the bounded response contract.",
                            extra: {
                                symbolId: result.symbolId,
                                minimumRequiredResponseBytes: result.minimumRequiredResponseBytes + wrapperBytes,
                                hardResponseLimitBytes: SYMBOL_CONTEXT_LIMITS.hardResponseLimitBytes,
                            },
                        });
                    }
                    case "navigation_unavailable":
                    case "stale":
                        return symbolContextErrorResponse({
                            code: "NAVIGATION_UNAVAILABLE",
                            reason: "navigation_unavailable",
                            message: "Current navigation authority is unavailable; refresh the index state and retry.",
                        });
                }
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

            const sourceObservation = beginSourceMeasurementObservation({
                owner: "validation",
                filePath: absolutePath,
                logicalBytesRequested: stat.size,
                scanKind: "complete",
            });
            let sourceBytes: Buffer;
            try {
                sourceBytes = fs.readFileSync(absolutePath);
                recordSourceIo({
                    observation: sourceObservation,
                    startByte: 0,
                    endByte: sourceBytes.length,
                    basis: "path_read",
                });
                finishSourceMeasurementObservation({
                    observation: sourceObservation,
                    status: sourceBytes.length === stat.size ? "completed" : "partial",
                });
            } catch (error) {
                finishSourceMeasurementObservation({
                    observation: sourceObservation,
                    status: "failed",
                });
                throw error;
            }
            const selectorStartedAt = performance.now();
            let selectorOutcome: "success" | "failed" = "failed";
            let content: string;
            let lines: string[];
            try {
                content = sourceBytes.toString("utf8");
                lines = splitIntoLines(content);
                selectorOutcome = "success";
            } finally {
                recordSourceProcessing({
                    observation: sourceObservation,
                    owner: "selector",
                    inputBytesProcessed: sourceBytes.length,
                    basis: "shared_buffer",
                    outcome: selectorOutcome,
                    durationMs: performance.now() - selectorStartedAt,
                });
            }
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

            if (input.open_symbol && !isExactSymbolRequest(input.open_symbol) && totalLines > 0) {
                const openSymbol = input.open_symbol;
                startLine = clamp(openSymbol.startLine, 1, totalLines);
                endLine = clamp(openSymbol.endLine, startLine, totalLines);
                addContinuationHint = false;
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
            if (exactRequest) {
                return symbolContextErrorResponse({
                    code: "NAVIGATION_UNAVAILABLE",
                    reason: "navigation_unavailable",
                    message: "Current symbol context could not be prepared safely; refresh index state and retry.",
                });
            }
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
