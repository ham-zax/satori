import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
    DEFAULT_IGNORE_PATTERNS,
    createIndexIgnoreMatcher,
    detectLanguageId,
    isLanguageCapabilitySupportedForExtension,
    isLanguageCapabilitySupportedForLanguage,
    isSearchableLanguageSource,
    observeIndexPolicyInputs,
    pathDeterminedLanguageId,
    recordSourceProcessing,
} from "@satori-code/core";
import {
    McpTool,
    ToolContext,
    absoluteFilesystemPathSchema,
    formatZodError,
} from "./types.js";
import { resolveVectorBackedToolContext } from "./provider-context.js";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import {
    PublishedFileAuthorizationError,
} from "../core/published-file-authorization.js";
import {
    AuthorizedSourceReadError,
    READ_FILE_MAX_BYTES_DEFAULT,
    readAuthorizedPublishedSource,
} from "../core/published-source-reader.js";
import { WorkspaceAuthorizationError } from "../core/session-workspace-policy.js";
import {
    getChangedFilesForCodebase,
    type ChangedFilesCacheEntry,
} from "../core/working-tree-state.js";
import { SEARCH_CHANGED_FILES_CACHE_TTL_MS } from "../core/search-constants.js";
import type {
    ReadFileAnnotatedOutlineStatus,
    ReadFileAnnotatedResponseEnvelope,
    FileOutlineResponseEnvelope,
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
import type { ComposedSymbolContext } from "../core/symbol-context-composer.js";
import {
    renderOrdinaryRangeText,
    renderSymbolContextText,
} from "../core/symbol-context-text-renderer.js";

export const readFileInputSchema = z.object({
    path: absoluteFilesystemPathSchema(
        "ABSOLUTE path to the file under an indexed/searchable codebase root (relative paths are rejected).",
    ),
    codebaseRoot: absoluteFilesystemPathSchema(
        "Optional originating indexed root for open_symbol or start_line/end_line range reads. Preserve it when continuing an exact-symbol read.",
    ).optional(),
    start_line: z.number().int().positive().optional().describe("Optional start line (1-based, inclusive)."),
    end_line: z.number().int().positive().optional().describe("Optional end line (1-based, inclusive). An end_line past the end of the file reads to the last line."),
    mode: z.enum(["plain", "annotated"]).optional().describe("Output mode. Defaults to plain, including exact-symbol requests."),
    format: z.enum(["json", "text"]).optional().describe("Response format. Defaults to json; text renders compact line-numbered source and metadata in a single text block."),
    presentation: z.enum(["compact", "full"]).optional().describe("Ordinary-read presentation. Omit or use full for raw multiline source; use compact to wrap an ordinary read in a one-line JSON envelope."),
    open_symbol: openSymbolRequestSchema.optional().describe("Read bounded symbol source with continuation-aware excerpts using {contractVersion:2, symbolId}; context defaults to {preset:definition}. Explicit context and continuation are mutually exclusive. Direct spans use one-based inclusive startLine/endLine.")
}).strict().superRefine((input, ctx) => {
    if (input.start_line !== undefined && input.end_line !== undefined && input.start_line > input.end_line) {
        ctx.addIssue({
            code: "custom",
            path: ["end_line"],
            message: `start_line (${input.start_line}) must not exceed end_line (${input.end_line}).`,
        });
    }
    if (!input.open_symbol) return;
    if (input.start_line !== undefined || input.end_line !== undefined) {
        ctx.addIssue({
            code: "custom",
            path: ["open_symbol"],
            message: "open_symbol cannot be combined with top-level line ranges.",
        });
    }
    if (input.presentation !== undefined) {
        ctx.addIssue({
            code: "custom",
            path: ["presentation"],
            message: "presentation applies only to ordinary reads and cannot be combined with open_symbol.",
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

const TOP_LEVEL_DECLARATION = /^(?:(?:export|default|declare|abstract|async|public|private|protected|static|sealed|final|open|internal|external|pub(?:\([^)]*\))?)\s+)*(?:function|class|interface|type|enum|namespace|module|const|let|var|def|struct|trait|impl|fn|func|record|object|data\s+class|test|it|describe|beforeEach|afterEach|beforeAll|afterAll)\b|^(?:test|it|describe|beforeEach|afterEach|beforeAll|afterAll)(?:\.(?:only|skip|todo))?\s*\(/;

type ReadFileCompactEnvelope = {
    presentation: "compact";
    path: string;
    startLine: number;
    endLine: number;
    preview: string;
    source: string;
};

function compactSourceRange(lines: string[], startLine: number, endLine: number, absolutePath: string): ReadFileCompactEnvelope {
    const declarationAnchor = lines.find(
        (line) => line.length > 0 && !/^\s/.test(line) && TOP_LEVEL_DECLARATION.test(line),
    );
    const firstNonBlank = lines.find((line) => line.trim().length > 0);
    return {
        presentation: "compact",
        path: absolutePath,
        startLine,
        endLine,
        preview: declarationAnchor ?? firstNonBlank ?? "",
        source: lines.join("\n"),
    };
}

type ReadFileSearchableStatus = 'indexed' | 'indexing';
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

const READ_FILE_DISCOVERY_STATUSES = new Set<ReadFileSearchableStatus>(['indexed', 'indexing']);
const READ_FILE_RESOLVE_STATUSES = new Set<ReadFileSearchableStatus>(['indexed']);
/** Statuses that may serve file content via read_file. */
const READ_FILE_CONTENT_ALLOW_STATUSES = new Set<ReadFileSearchableStatus>(['indexed']);

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

function readFileAuthorizationDenial(input: {
    reason: string;
    code: string;
    path: string;
    message: string;
    maxBytes?: number;
}): ToolTextResponse {
    const payload = {
        status: "error" as const,
        reason: input.reason,
        code: input.code,
        path: input.path,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        message: input.message,
    };
    return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        isError: true,
    };
}

function publishedFileAuthorizationDenial(error: PublishedFileAuthorizationError, pathValue: string): ToolTextResponse {
    switch (error.code) {
        case "FILE_NOT_PUBLISHED":
            return readFileAuthorizationDenial({
                reason: "file_not_published",
                code: "FILE_NOT_PUBLISHED",
                path: pathValue,
                message: error.message,
            });
        case "FINAL_SYMLINK_REJECTED":
            return readFileAuthorizationDenial({
                reason: "symlink_rejected",
                code: "FINAL_SYMLINK_REJECTED",
                path: pathValue,
                message: error.message,
            });
        case "NOT_A_REGULAR_FILE":
            return readFileAuthorizationDenial({
                reason: "not_a_regular_file",
                code: "NOT_A_REGULAR_FILE",
                path: pathValue,
                message: error.message,
            });
        case "OUTSIDE_CODEBASE_ROOT":
            return outsideIndexedRootResponse(pathValue);
    }
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
    format?: "json" | "text";
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
        ...(input.format === "text"
            ? {
                measureResponseBytes: (context: ComposedSymbolContext) => Buffer.byteLength(
                    renderSymbolContextText({
                        codebaseRoot: input.root,
                        envelope: composePublicSymbolContextEnvelope({
                            effectiveRequest: input.operation.effectiveRequest,
                            context,
                        }),
                    }),
                    "utf8",
                ),
            }
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

/**
 * Module-level changed-files cache for live-path read admission. Mirrors the
 * search lane's cache discipline (same TTL) so read_file does not run `git
 * status` per request while still reusing the authoritative git-status parser.
 */
const READ_FILE_CHANGED_FILES_CACHE = new Map<string, ChangedFilesCacheEntry>();

/**
 * The published searchable-file manifest for a resolved root is the exact file
 * coverage recorded in the current Publication's source.json. Partial
 * Publication unprocessedPaths are deliberately excluded because those paths
 * were not published into the vector generation.
 */
function resolvePublishedRelativePaths(codebaseRoot: string, ctx: ToolContext): Set<string> {
    const publication = ctx.context.getCurrentPublication(codebaseRoot);
    if (!publication) return new Set<string>();
    const checkpoint = ctx.context.getPublicationSourceCheckpoint(publication);
    return new Set(
        (checkpoint?.fileHashes ?? []).map(([relativePath]) => normalizeRelativePath(relativePath)),
    );
}

/**
 * Active ignore matcher for live-path admission, failing closed whenever
 * active session patterns or live disk ignore control files (`.satoriignore`,
 * `.gitignore`, `.git/info/exclude`) cannot be verified.
 */
async function buildReadFileIgnoreMatcher(
    codebaseRoot: string,
    ctx: ToolContext,
): Promise<(relativePath: string) => boolean> {
    let activePatterns: unknown;
    try {
        activePatterns = (ctx.context as { getActiveIgnorePatterns?: (root: string) => string[] } | undefined)
            ?.getActiveIgnorePatterns?.(codebaseRoot);
    } catch {
        return () => true;
    }
    if (!Array.isArray(activePatterns) || activePatterns.length === 0) {
        return () => true;
    }
    let observedPatterns: readonly string[];
    try {
        observedPatterns = (await observeIndexPolicyInputs(codebaseRoot)).fileBasedIgnorePatterns;
    } catch {
        return () => true;
    }
    try {
        const matcher = createIndexIgnoreMatcher([
            ...DEFAULT_IGNORE_PATTERNS,
            ...activePatterns.filter((pattern): pattern is string => typeof pattern === "string"),
            ...observedPatterns,
        ]);
        return (relativePath: string) => {
            const normalized = relativePath.replace(/\\/g, "/");
            if (!normalized) {
                return true;
            }
            if (matcher.ignores(normalized)) {
                return true;
            }
            const withSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
            return matcher.ignores(withSlash);
        };
    } catch {
        return () => true;
    }
}

function readBoundedLanguageProbe(absoluteFile: string, maxBytes: number = 4096): string | undefined {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    let fd: number | undefined;
    try {
        fd = fs.openSync(absoluteFile, flags);
        if (!fs.fstatSync(fd).isFile()) return undefined;
        const buffer = Buffer.allocUnsafe(maxBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* best-effort */ }
        }
    }
}

/**
 * Live-path admission for one requested file, mirroring the search freshness
 * policy: the path must be changed/untracked per git status, language-capable
 * for search (using bounded content disambiguation for `.cls`/`.m`/shebangs),
 * and not excluded by the active or live on-disk ignore rules.
 */
async function isLivePathAdmittedForRead(
    codebaseRoot: string,
    relativePath: string,
    ctx: ToolContext,
): Promise<boolean> {
    const changed = getChangedFilesForCodebase({
        codebasePath: codebaseRoot,
        nowMs: Date.now(),
        changedFilesCache: READ_FILE_CHANGED_FILES_CACHE,
        ttlMs: SEARCH_CHANGED_FILES_CACHE_TTL_MS,
    });
    if (!changed.available || !changed.files.has(relativePath)) {
        return false;
    }
    const matcher = await buildReadFileIgnoreMatcher(codebaseRoot, ctx);
    if (matcher(relativePath)) {
        return false;
    }
    const pathLanguage = pathDeterminedLanguageId(relativePath);
    if (pathLanguage !== undefined) {
        if (!isLanguageCapabilitySupportedForLanguage(pathLanguage, "search")) {
            return false;
        }
    } else {
        const probe = readBoundedLanguageProbe(path.join(codebaseRoot, relativePath));
        if (probe === undefined || !isSearchableLanguageSource(relativePath, probe)) {
            return false;
        }
    }
    return true;
}

function collectCodebaseCandidatesForFile(
    absolutePath: string,
    ctx: ToolContext,
    allowedStatuses: ReadonlySet<ReadFileSearchableStatus>
): ReadFileCodebaseCandidate[] {
    const tracked = new Map<string, ReadFileSearchableStatus>();
    for (const publication of ctx.context.listCurrentPublications()) {
        tracked.set(publication.publication.canonicalRoot, 'indexed');
    }
    for (const activity of ctx.mutationRuntime.listActiveMutations()) {
        if (activity.action === 'create' || activity.action === 'reindex') {
            if (activity.action === 'reindex' && tracked.has(activity.canonicalRoot)) continue;
            tracked.set(activity.canonicalRoot, 'indexing');
        }
    }

    const candidates: ReadFileCodebaseCandidate[] = [];
    for (const [rootPath, status] of tracked) {
        const rootResult = requireAbsoluteFilesystemPath(rootPath, "codebase.path");
        if (!rootResult.ok) continue;
        const candidatePath = canonicalizeFilesystemPath(rootResult.absolutePath);
        if (!isPathInsideRoot(absolutePath, candidatePath) || !allowedStatuses.has(status)) {
            continue;
        }
        try {
            ctx.workspacePolicy.authorizeRoot(candidatePath);
        } catch {
            continue;
        }
        candidates.push({ path: candidatePath, status });
    }

    candidates.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
    return candidates;
}

/**
 * Returns the longest searchable root that contains the canonical path, or undefined.
 * Only roots with a current Publication may serve content.
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

function isOutlineSupportedFile(absolutePath: string, content?: string): boolean {
    if (content !== undefined) {
        const language = detectLanguageId(absolutePath, content, "");
        return language !== "" && isLanguageCapabilitySupportedForLanguage(language, "fileOutline");
    }
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

async function touchResolvedCodebaseRoot(absolutePath: string, ctx: ToolContext, boundRoot?: string): Promise<void> {
    const codebaseRoot = boundRoot ?? resolveCodebaseRootForFile(absolutePath, ctx);
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

function resolveIndexingBlockForFile(absolutePath: string, ctx: ToolContext, boundRoot?: string): ReadFileIndexingBlock | undefined {
    const candidates: Array<{
        codebaseRoot: string;
        progressPct: number | null;
        lastUpdated: string | null;
    }> = [];

    const activeMutations = ctx.mutationRuntime.listActiveMutations();
    if (activeMutations.length === 0) return undefined;
    const publishedRoots = new Set(ctx.context.listCurrentPublications().map(({ publication }) => publication.canonicalRoot));
    for (const activity of activeMutations) {
        if (activity.action !== 'create' && activity.action !== 'reindex') continue;
        if (activity.action === 'reindex' && publishedRoots.has(activity.canonicalRoot)) continue;
        const rootResult = requireAbsoluteFilesystemPath(activity.canonicalRoot, "codebase.path");
        if (!rootResult.ok) continue;
        const codebaseRoot = canonicalizeFilesystemPath(rootResult.absolutePath);
        if (boundRoot && codebaseRoot !== boundRoot) continue;
        try {
            ctx.workspacePolicy.authorizeRoot(codebaseRoot);
        } catch {
            continue;
        }
        if (!isPathInsideRoot(absolutePath, codebaseRoot)) continue;
        const operation = ctx.mutationRuntime.getOperation(activity.canonicalRoot);
        candidates.push({
            codebaseRoot,
            progressPct: operation?.progress ?? null,
            lastUpdated: operation?.updatedAt ?? activity.acceptedAt,
        });
    }

    candidates.sort((a, b) => b.codebaseRoot.length - a.codebaseRoot.length || a.codebaseRoot.localeCompare(b.codebaseRoot));
    return candidates[0];
}

export const readFileTool: McpTool = {
    name: "read_file",
    description: () =>
        "Read exact source within a current Satori Publication (prefer canonical read_file requests from search_codebase). open_symbol / symbol_context returns bounded symbol source with continuation-aware excerpts and relationships. Explicit start_line/end_line reads return the exact requested source range; presentation=\"full\" returns raw multiline source. Restricted to published files plus searchable, non-ignored git-changed/untracked files.",
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
                    text: formatZodError("read_file", parsed.error) + "\nExample: " + JSON.stringify({
                        path: path.isAbsolute(rawPath) ? rawPath : "/absolute/path/to/file.ts",
                        open_symbol: { contractVersion: 2, symbolId: "<symbolId from search_codebase>" },
                    })
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
            ctx.requestSignal?.throwIfAborted();
            const resolvedPath = path.resolve(input.path);
            const boundRoot = input.codebaseRoot
                ? ctx.workspacePolicy.authorizeRoot(input.codebaseRoot).canonicalPath
                : undefined;
            // Authorize the directory without resolving the final component. A link's
            // destination must never determine the public denial for a file read.
            let parent: string | undefined;
            try {
                parent = ctx.workspacePolicy.authorizePath(path.dirname(resolvedPath)).canonicalPath;
            } catch (error) {
                if (!boundRoot || !(error instanceof WorkspaceAuthorizationError)) throw error;
            }
            const absolutePath = parent ? path.join(parent, path.basename(resolvedPath)) : resolvedPath;
            if (boundRoot && (!parent || !isPathInsideRoot(absolutePath, boundRoot))) {
                if (exactRequest) {
                    return symbolContextErrorResponse({
                        code: "ROOT_BINDING_INVALID",
                        reason: "root_binding_invalid",
                        message: "The requested file is outside its originating codebase root.",
                    });
                }
                return readFileAuthorizationDenial({
                    reason: "root_binding_invalid",
                    code: "ROOT_BINDING_INVALID",
                    path: resolvedPath,
                    message: "The requested file is outside its originating codebase root.",
                });
            }

            // Fail closed: deny content access outside searchable roots before any content read.
            // Indexing roots are handled next with not_ready (still no content).
            const indexingBlock = resolveIndexingBlockForFile(absolutePath, ctx, boundRoot);
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
                                    completionProof: "current_publication"
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

            const allowedRoot = boundRoot
                ? collectCodebaseCandidatesForFile(absolutePath, ctx, READ_FILE_CONTENT_ALLOW_STATUSES)
                    .find((candidate) => candidate.path === boundRoot)?.path
                : resolveContentAllowedRoot(absolutePath, ctx);
            if (!allowedRoot) {
                if (exactRequest) {
                    return symbolContextErrorResponse({
                        code: "NAVIGATION_UNAVAILABLE",
                        reason: "navigation_unavailable",
                        message: "Current navigation authority is unavailable; refresh the indexed root state and retry.",
                    });
                }
                return outsideIndexedRootResponse(resolvedPath);
            }

            // This check provides a stable diagnostic. The descriptor opener enforces
            // the same restriction at open and when validating the final observation.
            const finalStat = await fs.promises.lstat(absolutePath).catch(() => undefined);
            if (finalStat?.isSymbolicLink()) {
                return publishedFileAuthorizationDenial(
                    new PublishedFileAuthorizationError(
                        "FINAL_SYMLINK_REJECTED",
                        `Final path component is a symlink: ${resolvedPath}`,
                    ),
                    resolvedPath,
                );
            }

            if (exactRequest) {
                const relativeFile = normalizeRelativePath(path.relative(allowedRoot, absolutePath));
                const operation = resolveSymbolContextOperation({
                    mode: input.mode as "plain" | "annotated",
                    ...(input.format !== undefined ? { format: input.format } : {}),
                    request: exactRequest,
                });
                if (operation.kind === "unsupported_continuation") {
                    return symbolContextErrorResponse({
                        code: "UNSUPPORTED_CONTINUATION_KIND",
                        reason: "unsupported_continuation_kind",
                        message: "The requested symbol-context continuation kind is unsupported.",
                    });
                }

                const executionContext = await resolveVectorBackedToolContext(ctx, {
                    tool: "read_file",
                    path: allowedRoot,
                    file: relativeFile,
                    messagePrefix: "Exact-symbol navigation authority could not be verified.",
                });
                if (!executionContext.ok) {
                    return symbolContextErrorResponse({
                        code: "NAVIGATION_UNAVAILABLE",
                        reason: "navigation_unavailable",
                        message: "Current navigation authority is unavailable; refresh the index state and retry.",
                    });
                }

                ctx.requestSignal?.throwIfAborted();
                await touchResolvedCodebaseRoot(absolutePath, executionContext.context, allowedRoot);
                ctx.requestSignal?.throwIfAborted();
                const result = await executionContext.context.toolHandlers.composeSymbolContext(
                    composeSymbolContextRequest({
                        root: allowedRoot,
                        relativeFile,
                        request: exactRequest,
                        operation,
                        ...(input.format !== undefined ? { format: input.format } : {}),
                    }),
                    ctx.requestSignal,
                );
                ctx.requestSignal?.throwIfAborted();
                if (result.status === "ok") {
                    const envelope = composePublicSymbolContextEnvelope({
                        effectiveRequest: operation.effectiveRequest,
                        context: result.context,
                    });
                    const hardLimit = operation.effectiveRequest.budgets.totalResponseBytes;
                    if (input.format === "text") {
                        const text = renderSymbolContextText({
                            codebaseRoot: allowedRoot,
                            envelope,
                        });
                        if (Buffer.byteLength(text, "utf8") > hardLimit) {
                            return symbolContextErrorResponse({
                                code: "MINIMUM_SYMBOL_CONTEXT_EXCEEDS_LIMIT",
                                reason: "minimum_safe_package_exceeds_limit",
                                message: "The exact symbol cannot be represented safely within the bounded response contract.",
                                extra: {
                                    symbolId: result.context.symbol.symbolId,
                                    minimumRequiredResponseBytes: Buffer.byteLength(text, "utf8"),
                                    hardResponseLimitBytes: SYMBOL_CONTEXT_LIMITS.hardResponseLimitBytes,
                                },
                            });
                        }
                        return {
                            content: [{ type: "text", text }],
                        };
                    }
                    const payload = { codebaseRoot: allowedRoot, ...envelope };
                    const serialized = JSON.stringify(payload);
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

            // Publication-bound authorization: the file must be in the current
            // published searchable-file manifest OR admitted by the live-path
            // source policy (changed/untracked, in-scope, non-ignored). Both
            // paths use the shared descriptor-bound open. The earlier final-symlink
            // check runs after workspace and root authorization and gives the same
            // denial for every destination. Unpublished regular and missing paths
            // get the same denial from the publication gate.
            const publishedRelativePaths = resolvePublishedRelativePaths(allowedRoot, ctx);
            const requestedRelativePath = normalizeRelativePath(path.relative(allowedRoot, absolutePath));
            if (
                requestedRelativePath.length > 0
                && !publishedRelativePaths.has(requestedRelativePath)
                && await isLivePathAdmittedForRead(allowedRoot, requestedRelativePath, ctx)
            ) {
                publishedRelativePaths.add(requestedRelativePath);
            }

            const maxBytes = Math.max(1, ctx.readFileMaxBytes ?? READ_FILE_MAX_BYTES_DEFAULT);
            let sourceBytes: Buffer;
            let sourceObservation: import("@satori-code/core").SourceMeasurementObservation | undefined;
            try {
                // Publication-bound read through the shared bounded reader: the
                // same open, byte-ceiling, descriptor read, and stability
                // verification every navigation tool uses. The reader performs
                // the source-measurement bookkeeping (observation, io, outcome)
                // so the read_file ledger contract is unchanged.
                const sourceRead = await readAuthorizedPublishedSource({
                    workspacePolicy: ctx.workspacePolicy,
                    codebaseRoot: allowedRoot,
                    // Pass the unresolved path so the authorizer can reject a
                    // final symlink; absolutePath is already realpathed.
                    requestedPath: resolvedPath,
                    publishedRelativePaths,
                    maxBytes,
                    signal: ctx.requestSignal,
                    sourceMeasurement: {
                        owner: "validation",
                        filePath: absolutePath,
                        scanKind: "complete",
                    },
                    // Touch the resolved codebase only after the authorized open
                    // and byte check, so a watcher callback that observes the
                    // working tree cannot be used to influence the authorization
                    // decision; the touch still runs before the content read.
                    onAuthorized: () => touchResolvedCodebaseRoot(absolutePath, ctx, allowedRoot),
                });
                sourceBytes = sourceRead.bytes;
                sourceObservation = sourceRead.sourceMeasurementObservation;
            } catch (error) {
                if (error instanceof PublishedFileAuthorizationError) {
                    return publishedFileAuthorizationDenial(error, resolvedPath);
                }
                if (error instanceof WorkspaceAuthorizationError) {
                    return readFileAuthorizationDenial({
                        reason: error.code === "WORKSPACE_POLICY_NOT_BOUND"
                            ? "workspace_policy_not_bound"
                            : "root_not_authorized",
                        code: error.code === "WORKSPACE_POLICY_NOT_BOUND"
                            ? "WORKSPACE_POLICY_NOT_BOUND"
                            : "ROOT_NOT_AUTHORIZED",
                        path: resolvedPath,
                        message: error.message,
                    });
                }
                if (error instanceof AuthorizedSourceReadError) {
                    if (error.code === "FILE_TOO_LARGE") {
                        return readFileAuthorizationDenial({
                            reason: "file_too_large",
                            code: "FILE_TOO_LARGE",
                            path: resolvedPath,
                            maxBytes,
                            message: error.message,
                        });
                    }
                    return readFileAuthorizationDenial({
                        reason: "file_replaced",
                        code: "FILE_REPLACED",
                        path: resolvedPath,
                        message: error.message,
                    });
                }
                throw error;
            }

            {
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
                // Clamping a start past the end would serve the last line as if
                // it were the requested one.
                if (input.start_line !== undefined && input.start_line > Math.max(totalLines, 1)) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: start_line ${input.start_line} is past the end of '${absolutePath}' (${totalLines} lines).`,
                        }],
                        isError: true,
                    };
                }

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
                    if (typeof openSymbol.startLine === "number" && typeof openSymbol.endLine === "number") {
                        startLine = clamp(openSymbol.startLine, 1, totalLines);
                        endLine = clamp(openSymbol.endLine, startLine, totalLines);
                        addContinuationHint = false;
                    }
                }

                const selectedLines = totalLines === 0 ? [] : lines.slice(startLine - 1, endLine);
                const nextStartLine = addContinuationHint ? endLine + 1 : undefined;
                if (input.format === "text" && mode === "plain") {
                    const text = renderOrdinaryRangeText({
                        absolutePath,
                        ...(allowedRoot ? { codebaseRoot: allowedRoot } : {}),
                        startLine,
                        endLine,
                        lines: selectedLines,
                        ...(nextStartLine !== undefined ? { nextStartLine } : {}),
                    });
                    return {
                        content: [{
                            type: "text",
                            text,
                        }],
                    };
                }
                const shouldCompact = input.format !== "text"
                    && !input.open_symbol
                    && input.presentation === "compact";
                const compactEnvelope = shouldCompact
                    ? compactSourceRange(selectedLines, startLine, endLine, absolutePath)
                    : undefined;
                const selected = input.format === "text"
                    ? renderOrdinaryRangeText({
                        absolutePath,
                        ...(allowedRoot ? { codebaseRoot: allowedRoot } : {}),
                        mode,
                        startLine,
                        endLine,
                        lines: selectedLines,
                        ...(nextStartLine !== undefined ? { nextStartLine } : {}),
                    })
                    : totalLines === 0
                        ? content
                        : compactEnvelope
                            ? JSON.stringify(compactEnvelope)
                            : selectedLines.join("\n");
                const hint = input.format !== "text" && addContinuationHint
                    ? `\n\n(File truncated at line ${endLine}. To read more, call read_file with path="${absolutePath}" and start_line=${nextStartLine}.)`
                    : "";
                const contentWithHint = `${selected}${hint}`;

            if (mode === "plain") {
                return {
                    content: [{
                        type: "text",
                        text: contentWithHint
                    }],
                };
            }

            const outlineSupported = isOutlineSupportedFile(absolutePath, content);
            const resolvedRoot = allowedRoot;
            const relativeFile = resolvedRoot
                ? normalizeRelativePath(path.relative(resolvedRoot, absolutePath))
                : undefined;
            let outlineStatus: ReadFileAnnotatedOutlineStatus = outlineSupported ? "requires_reindex" : "unsupported";
            let outlineReason: ReadFileAnnotatedResponseEnvelope["outlineReason"];
            let outline: FileOutlineResponseEnvelope["outline"] = null;
            let hasMore = false;
            let warnings: string[] | undefined;
            let hints: Record<string, unknown> | undefined;

            if (!outlineSupported) {
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
                        }, ctx.workspacePolicy, {
                            requireCurrentSource: true,
                            ...(ctx.requestSignal ? { signal: ctx.requestSignal } : {}),
                        });
                        const parsedOutline = JSON.parse(outlineResponse.content?.[0]?.text || "{}");
                        const status = parsedOutline?.status;
                        if (status === "ok" || status === "not_ready" || status === "requires_reindex" || status === "unsupported" || status === "ambiguous") {
                            outlineStatus = status;
                        } else {
                            outlineStatus = "requires_reindex";
                        }
                        if (outlineStatus !== "ok" && typeof parsedOutline?.reason === "string") {
                            outlineReason = parsedOutline.reason;
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
                } catch (error) {
                    if (ctx.requestSignal?.aborted) {
                        throw error;
                    }
                    outlineStatus = "requires_reindex";
                }
            }

            const payload: ReadFileAnnotatedResponseEnvelope = {
                path: absolutePath,
                mode: "annotated",
                content: contentWithHint,
                outlineStatus,
                ...(outlineReason ? { outlineReason } : {}),
                outline,
                hasMore,
                ...(warnings && warnings.length > 0 ? { warnings } : {}),
                ...(hints ? { hints } : {})
            };
            if (input.format === "text") {
                const annotations = [
                    `Outline: ${outlineStatus}${outlineReason ? ` (${outlineReason})` : ""}`,
                    ...(outline?.symbols.map((symbol) => `- ${symbol.symbolLabel} (${symbol.span.startLine}-${symbol.span.endLine}) [${symbol.symbolId}]`) ?? []),
                    ...(hasMore ? ["More symbols are available through file_outline."] : []),
                    ...(warnings ?? []),
                    ...(hints ? [`Hints: ${JSON.stringify(hints)}`] : []),
                ];
                return {
                    content: [{ type: "text", text: `${contentWithHint}\n\n${annotations.join("\n")}` }],
                };
            }
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(payload, null, 2),
                }],
            };
            }
        } catch (error) {
            ctx.requestSignal?.throwIfAborted();
            if (error instanceof WorkspaceAuthorizationError) {
                return readFileAuthorizationDenial({
                    reason: error.code.toLowerCase(),
                    code: error.code,
                    path: input.path,
                    message: error.message,
                });
            }
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
