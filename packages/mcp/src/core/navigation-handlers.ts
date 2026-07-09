import * as fs from "fs";
import * as path from "path";
import {
    compareContractStrings,
    getSupportedExtensionsForCapability,
    type NavigationStore,
    type SymbolRecord,
} from "@zokizuan/satori-core";

const OUTLINE_DUPLICATE_SYMBOL_KEY_RE = /^Duplicate symbolKey '([^']+)' has \d+ candidates$/;

/**
 * Non-blocking outline warning: count + optional sample keys + agent action.
 * Does not dump every registry diagnostic string into the outline payload.
 */
export function formatOutlineSymbolRegistryWarnings(registryWarnings: readonly string[]): string | undefined {
    if (registryWarnings.length === 0) {
        return undefined;
    }
    const samples: string[] = [];
    for (const warning of registryWarnings) {
        const match = OUTLINE_DUPLICATE_SYMBOL_KEY_RE.exec(warning);
        if (match) {
            samples.push(match[1]);
        }
    }
    samples.sort(compareContractStrings);
    const sample = samples.slice(0, 3).join(",");
    return `OUTLINE_SYMBOL_REGISTRY_WARNINGS:${registryWarnings.length} action=treat_outline_as_degraded_identity${sample ? ` sample=${sample}` : ""}`;
}
import {
    repairSourceBackedPythonSpan,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import {
    buildRegistryFileOutlinePayload,
    findExactRegistrySymbols,
} from "./registry-file-outline.js";
import type {
    CompletionProbeDebugHint,
    TrackedRootReadiness,
} from "./tracked-root-readiness.js";
import type {
    CallGraphDirection,
    CallGraphEdge,
    CallGraphNode,
    CallGraphNote,
    CallGraphSymbolRef,
    CallGraphTestReference,
} from "./call-graph.js";
import type {
    CallGraphHint,
    CallGraphResponseEnvelope,
    FileOutlineInput,
    FileOutlineResponseEnvelope,
    FileOutlineStatus,
} from "./search-types.js";
import { requireAbsoluteFilesystemPath, requireRepoRelativeFilePath, trackCodebasePath } from "../utils.js";

type ToolArgs = Record<string, unknown>;

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type CallGraphUnavailableReason = "missing_symbol" | "stale_symbol_ref" | "unsupported_language" | "missing_relationship_sidecar" | "incompatible_relationship_sidecar" | "missing_symbol_registry" | "incompatible_symbol_registry";

const OUTLINE_SUPPORTED_EXTENSIONS = getSupportedExtensionsForCapability("fileOutline");
const PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_DETAIL = "Partial index/search data may exist, but navigation sidecars were not published because indexing stopped before completion.";

type NavigationHandlersHost = {
    navigationStore: Pick<NavigationStore, "getSymbolsByFile" | "getCompatibilityState">;
    trackedRootReadiness: Pick<
        TrackedRootReadiness,
        | "prepareTrackedRootForRead"
        | "buildIndexFailedFileOutlinePayload"
        | "buildMissingLocalCollectionFileOutlinePayload"
        | "buildIndexFailedCallGraphPayload"
        | "buildMissingLocalCollectionCallGraphPayload"
    >;
    stringifyToolJson(value: unknown): string;
    normalizeRelativeFilePath(relativeFilePath: string): string;
    buildInvalidFileOutlineRequestPayload(root: string, file: string, message: string, status?: string, reason?: string): unknown;
    buildRequiresReindexFileOutlinePayload(codebasePath: string, args: Record<string, unknown>, detail?: string, reason?: string): object;
    buildNotIndexedFileOutlinePayload(file: string, requestedPath: string, staleLocal?: { codebaseRoot: string; reason: string }): FileOutlineResponseEnvelope;
    buildNotReadyFileOutlinePayload(codebasePath: string, file: string, requestedPath: string): FileOutlineResponseEnvelope & Record<string, unknown>;
    withProofDebugHint<T extends object>(payload: T, proofDebugHint?: CompletionProbeDebugHint): T;
    isPartialIndexNavigationUnavailable(info: unknown): boolean;
    getRegistryFileFreshness(input: {
        symbols: SymbolRecord[];
        absoluteFile: string;
    }): { status: "fresh" | "stale" | "unknown" | "inconsistent"; registryHash?: string; currentHash?: string };
    buildStaleSymbolRefFileOutlinePayload(codebasePath: string, args: Record<string, unknown>, detail?: string): FileOutlineResponseEnvelope;
    loadRegistryValidatedCallGraphSidecar(input: {
        codebaseRoot: string;
        registryManifestHash?: string;
        registryUnavailableReason?: CallGraphUnavailableReason;
    }): Promise<{
        relationshipReady: boolean;
        relationshipBuiltAt?: string;
        relationshipUnavailableReason?: CallGraphUnavailableReason;
        warning?: string;
    }>;
    buildRegistrySymbolCallGraphHint(symbol: SymbolRecord, file: string, navigationState: {
        relationshipReady: boolean;
        relationshipBuiltAt?: string;
        relationshipUnavailableReason?: CallGraphUnavailableReason;
    }): CallGraphHint;
    buildOutlineSpanWarningCodes(repair: PythonSourceBackedSpanRepair | undefined): string[];
    touchWatchedCodebase(codebasePath: string): Promise<void>;
    getOutlineStatusForLanguage(relativeFilePath: string): FileOutlineStatus;
    buildInvalidCallGraphRequestPayload(context: {
        path: string;
        symbolRef: CallGraphSymbolRef;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
    }, message: string, status?: string, reason?: string): unknown;
    buildRequiresReindexCallGraphPayload(codebasePath: string, detail: string | undefined, context: {
        path: string;
        symbolRef: CallGraphSymbolRef;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
    }, reason?: string): CallGraphResponseEnvelope;
    buildNotReadyCallGraphPayload(codebasePath: string, context: {
        path: string;
        symbolRef: CallGraphSymbolRef;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
    }): CallGraphResponseEnvelope;
    buildNotIndexedCallGraphPayload(context: {
        path: string;
        symbolRef: CallGraphSymbolRef;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
    }, staleLocal?: { codebaseRoot: string; reason: string }): CallGraphResponseEnvelope;
    isCallGraphLanguageSupported(language: string, file?: string): boolean;
    isSha256HexHash(input: string | undefined): boolean;
    buildStaleSymbolRefCallGraphPayload(input: {
        codebaseRoot: string;
        context: {
            path: string;
            symbolRef: CallGraphSymbolRef;
            direction: CallGraphDirection;
            depth: number;
            limit: number;
        };
        message: string;
    }): CallGraphResponseEnvelope;
    buildRelationshipBackedCallGraph(input: {
        codebaseRoot: string;
        registry: {
            symbolsByInstanceId: Map<string, SymbolRecord>;
        };
        registryManifestHash: string;
        resolvedSymbol: SymbolRecord;
        sourceSpanRepair?: PythonSourceBackedSpanRepair;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
    }): Promise<{
        supported: true;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
        nodes: CallGraphNode[];
        edges: CallGraphEdge[];
        notes: CallGraphNote[];
        warnings?: string[];
        testReferences?: CallGraphTestReference[];
        notesTruncated: boolean;
        totalNoteCount: number;
        returnedNoteCount: number;
        sidecar: {
            builtAt: string;
            nodeCount: number;
            edgeCount: number;
        };
        hints?: Record<string, unknown>;
    } | null>;
};

function collectErrorFragments(
    value: unknown,
    output: string[],
    visited: Set<unknown>,
    depth = 0,
): void {
    if (output.length >= 8 || depth > 4 || value == null) {
        return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        output.push(String(value));
        return;
    }
    if (typeof value !== "object") {
        return;
    }
    if (visited.has(value)) {
        return;
    }
    visited.add(value);
    if (value instanceof Error) {
        if (typeof value.message === "string" && value.message.trim()) {
            output.push(value.message);
        }
        const namedRecord = value as unknown as Record<string, unknown>;
        for (const key of ["code", "reason", "detail", "details", "status", "cause"]) {
            if (key in namedRecord) {
                collectErrorFragments(namedRecord[key], output, visited, depth + 1);
                if (output.length >= 8) {
                    return;
                }
            }
        }
    }
    if (!Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        for (const key of ["message", "error", "reason", "detail", "details", "status", "code", "cause"]) {
            if (key in record) {
                collectErrorFragments(record[key], output, visited, depth + 1);
                if (output.length >= 8) {
                    return;
                }
            }
        }
    }
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
        collectErrorFragments(nestedValue, output, visited, depth + 1);
        if (output.length >= 8) {
            return;
        }
    }
}

function formatUnknownError(error: unknown): string {
    const fragments: string[] = [];
    collectErrorFragments(error, fragments, new Set());
    const deduped = Array.from(new Set(fragments.map((fragment) => fragment.trim()).filter(Boolean)));
    if (deduped.length > 0) {
        return deduped.slice(0, 3).join(" | ");
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export class NavigationHandlers {
    constructor(private readonly host: NavigationHandlersHost) {}

    public async handleFileOutline(args: FileOutlineInput): Promise<ToolTextResponse> {
        const limitSymbols = Number.isFinite(args?.limitSymbols)
            ? Math.max(1, Number(args.limitSymbols))
            : 500;
        const requestedStartLine = Number.isFinite(args?.start_line) ? Math.max(1, Number(args.start_line)) : undefined;
        const requestedEndLine = Number.isFinite(args?.end_line) ? Math.max(1, Number(args.end_line)) : undefined;
        const resolveMode = args?.resolveMode === "exact" ? "exact" : "outline";
        const symbolIdExact = typeof args?.symbolIdExact === "string" ? args.symbolIdExact.trim() : undefined;
        const symbolLabelExact = typeof args?.symbolLabelExact === "string" ? args.symbolLabelExact.trim() : undefined;

        try {
            const absoluteRootResult = requireAbsoluteFilesystemPath(args.path, "path");
            if (!absoluteRootResult.ok) {
                const payload = this.host.buildInvalidFileOutlineRequestPayload(
                    absoluteRootResult.path,
                    typeof args.file === "string" ? args.file : "",
                    absoluteRootResult.message,
                    "not_indexed",
                    "not_indexed",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }
            const absoluteRoot = absoluteRootResult.absolutePath;
            const relativeFileResult = requireRepoRelativeFilePath(
                typeof args.file === "string" ? args.file : "",
                "file",
            );
            if (!relativeFileResult.ok) {
                const payload = this.host.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    relativeFileResult.path,
                    relativeFileResult.message,
                    "not_found",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }
            const normalizedFile = this.host.normalizeRelativeFilePath(relativeFileResult.relativePath);

            if (!fs.existsSync(absoluteRoot)) {
                const payload = this.host.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    normalizedFile,
                    `Path '${absoluteRoot}' does not exist. file_outline requires an indexed codebase directory root.`,
                    "not_indexed",
                    "not_indexed",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            const rootStat = fs.statSync(absoluteRoot);
            if (!rootStat.isDirectory()) {
                const payload = this.host.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    normalizedFile,
                    `Path '${absoluteRoot}' is not a directory. file_outline requires an indexed codebase directory root.`,
                    "not_indexed",
                    "not_indexed",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            trackCodebasePath(absoluteRoot);

            const trackedRootState = await this.host.trackedRootReadiness.prepareTrackedRootForRead(absoluteRoot, "navigation");
            if (trackedRootState.state === "requires_reindex") {
                const payload = this.host.buildRequiresReindexFileOutlinePayload(trackedRootState.codebasePath, {
                    ...args,
                    file: normalizedFile,
                }, trackedRootState.message);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "index_failed") {
                const payload = this.host.trackedRootReadiness.buildIndexFailedFileOutlinePayload(
                    trackedRootState.codebasePath,
                    absoluteRoot,
                    normalizedFile,
                    trackedRootState.info,
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "not_indexed") {
                const payload = this.host.buildNotIndexedFileOutlinePayload(normalizedFile, absoluteRoot);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "indexing") {
                const payload = this.host.buildNotReadyFileOutlinePayload(trackedRootState.codebasePath, normalizedFile, absoluteRoot);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "stale_local") {
                const payload = this.host.buildNotIndexedFileOutlinePayload(normalizedFile, absoluteRoot, {
                    codebaseRoot: trackedRootState.codebasePath,
                    reason: trackedRootState.reason,
                });
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "missing_collection") {
                const payload = this.host.withProofDebugHint(this.host.trackedRootReadiness.buildMissingLocalCollectionFileOutlinePayload(
                    trackedRootState.codebasePath,
                    absoluteRoot,
                    normalizedFile,
                    trackedRootState.collectionName,
                ), trackedRootState.proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const matchedRoot = trackedRootState.root;
            const effectiveRoot = matchedRoot.path;
            const absoluteFile = path.resolve(effectiveRoot, normalizedFile);
            const relativeToRoot = path.relative(effectiveRoot, absoluteFile);
            if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
                const payload = this.host.buildInvalidFileOutlineRequestPayload(
                    effectiveRoot,
                    normalizedFile,
                    `File '${normalizedFile}' must be inside codebase root '${effectiveRoot}'.`,
                    "not_found",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            const proofDebugHint = trackedRootState.proofDebugHint;

            if (this.host.isPartialIndexNavigationUnavailable(matchedRoot.info)) {
                const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexFileOutlinePayload(
                    effectiveRoot,
                    {
                        ...args,
                        file: normalizedFile,
                    },
                    PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_DETAIL,
                    "partial_index_navigation_unavailable",
                ), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (!fs.existsSync(absoluteFile)) {
                const payload: FileOutlineResponseEnvelope = {
                    status: "not_found",
                    path: effectiveRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `File '${normalizedFile}' does not exist under codebase root '${effectiveRoot}'.`,
                };
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(payload, proofDebugHint)) }],
                };
            }

            const fileStat = fs.statSync(absoluteFile);
            if (!fileStat.isFile()) {
                const payload: FileOutlineResponseEnvelope = {
                    status: "not_found",
                    path: effectiveRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `'${normalizedFile}' is not a file.`,
                };
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(payload, proofDebugHint)) }],
                };
            }

            const windowStart = requestedStartLine;
            const windowEnd = requestedEndLine && requestedStartLine
                ? Math.max(requestedEndLine, requestedStartLine)
                : requestedEndLine;

            const registryState = await this.host.navigationStore.getSymbolsByFile({
                normalizedRootPath: effectiveRoot,
                file: normalizedFile,
            });
            if (registryState.status === "ok") {
                const registrySymbols = registryState.symbols;
                if (registrySymbols.length > 0) {
                    const fileFreshness = this.host.getRegistryFileFreshness({
                        symbols: registrySymbols,
                        absoluteFile,
                    });
                    if (fileFreshness.status === "inconsistent") {
                        const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                            ...args,
                            file: normalizedFile,
                        }, `Symbol registry contains inconsistent file hashes for '${normalizedFile}'.`, "incompatible_symbol_registry"), proofDebugHint);
                        return {
                            content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                        };
                    }
                    if (fileFreshness.status === "stale") {
                        const payload = this.host.withProofDebugHint(this.host.buildStaleSymbolRefFileOutlinePayload(effectiveRoot, {
                            ...args,
                            file: normalizedFile,
                        }, `File '${normalizedFile}' has changed since the symbol registry snapshot was published.`), proofDebugHint);
                        return {
                            content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                        };
                    }

                    const relationshipGraph = await this.host.loadRegistryValidatedCallGraphSidecar({
                        codebaseRoot: effectiveRoot,
                        registryManifestHash: registryState.manifestHash,
                    });
                    const outlineWarnings: string[] = [];
                    const registryWarning = formatOutlineSymbolRegistryWarnings(registryState.warnings);
                    if (registryWarning) {
                        outlineWarnings.push(registryWarning);
                    }
                    if (relationshipGraph.warning) {
                        outlineWarnings.push(`OUTLINE_${relationshipGraph.warning}`);
                    }
                    const payload = buildRegistryFileOutlinePayload({
                        codebaseRoot: effectiveRoot,
                        file: normalizedFile,
                        symbols: registrySymbols,
                        limitSymbols,
                        resolveMode,
                        symbolIdExact,
                        symbolLabelExact,
                        windowStart,
                        windowEnd,
                        warnings: outlineWarnings.length > 0 ? outlineWarnings : undefined,
                        buildCallGraphHint: (symbol) => this.host.buildRegistrySymbolCallGraphHint(symbol, normalizedFile, relationshipGraph),
                        buildOutlineSpanWarningCodes: (repair) => this.host.buildOutlineSpanWarningCodes(repair),
                    });
                    await this.host.touchWatchedCodebase(effectiveRoot);
                    return {
                        content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(payload, proofDebugHint)) }],
                    };
                }

                const languageStatus = this.host.getOutlineStatusForLanguage(normalizedFile);
                if (languageStatus !== "ok") {
                    const payload: FileOutlineResponseEnvelope = {
                        status: "unsupported",
                        reason: "unsupported_language",
                        path: effectiveRoot,
                        file: normalizedFile,
                        outline: null,
                        hasMore: false,
                        message: `File '${normalizedFile}' is not supported for sidecar outline. Supported extensions: ${OUTLINE_SUPPORTED_EXTENSIONS.join(", ")}.`,
                    };
                    return {
                        content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(payload, proofDebugHint)) }],
                    };
                }

                const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                    ...args,
                    file: normalizedFile,
                }, `File '${normalizedFile}' is missing from the symbol registry for this snapshot.`, "missing_symbol_registry"), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (registryState.status === "incompatible") {
                const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                    ...args,
                    file: normalizedFile,
                }, `Symbol registry is incompatible: ${registryState.reason}`, "incompatible_symbol_registry"), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (this.host.getOutlineStatusForLanguage(normalizedFile) !== "ok") {
                const payload: FileOutlineResponseEnvelope = {
                    status: "unsupported",
                    reason: "unsupported_language",
                    path: effectiveRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `File '${normalizedFile}' is not supported for sidecar outline. Supported extensions: ${OUTLINE_SUPPORTED_EXTENSIONS.join(", ")}.`,
                };
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(payload, proofDebugHint)) }],
                };
            }

            const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexFileOutlinePayload(effectiveRoot, {
                ...args,
                file: normalizedFile,
            }, registryState.reason, "missing_symbol_registry"), proofDebugHint);
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
            };
        } catch (error: unknown) {
            const pathResult = typeof args?.path === "string"
                ? requireAbsoluteFilesystemPath(args.path)
                : null;
            const pathForError = pathResult?.ok ? pathResult.absolutePath : (typeof args?.path === "string" ? args.path : "");
            const payload = this.host.buildInvalidFileOutlineRequestPayload(
                pathForError,
                typeof args?.file === "string" ? this.host.normalizeRelativeFilePath(args.file) : "",
                `Unexpected file_outline failure: ${formatUnknownError(error)}`,
                "not_ready",
            );
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                isError: true,
            };
        }
    }

    public async handleCallGraph(args: ToolArgs): Promise<ToolTextResponse> {
        const rawDirection = args?.direction;
        const direction: CallGraphDirection = rawDirection === "callers" || rawDirection === "callees" || rawDirection === "both"
            ? rawDirection
            : "both";
        const depth = Number.isFinite(args?.depth) ? Math.max(1, Math.min(3, Number(args.depth))) : 1;
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Number(args.limit)) : 20;
        const symbolRef = args?.symbolRef as CallGraphSymbolRef | undefined;
        const symbolFileResult = typeof symbolRef?.file === "string"
            ? requireRepoRelativeFilePath(symbolRef.file, "symbolRef.file")
            : { ok: false as const, path: "", message: "symbolRef.file is required." };
        const normalizedSymbolRef: CallGraphSymbolRef = {
            file: symbolFileResult.ok
                ? this.host.normalizeRelativeFilePath(symbolFileResult.relativePath)
                : (typeof symbolRef?.file === "string" ? this.host.normalizeRelativeFilePath(symbolRef.file) : ""),
            symbolId: typeof symbolRef?.symbolId === "string" ? symbolRef.symbolId : "",
            ...(typeof symbolRef?.symbolLabel === "string" ? { symbolLabel: symbolRef.symbolLabel } : {}),
            ...(symbolRef?.span ? { span: symbolRef.span } : {}),
        };
        const absolutePathResult = typeof args?.path === "string"
            ? requireAbsoluteFilesystemPath(args.path, "path")
            : { ok: false as const, path: "", message: "path is required." };
        const invalidSymbolRefContext = {
            path: absolutePathResult.ok ? absolutePathResult.absolutePath : (typeof args?.path === "string" ? args.path : ""),
            symbolRef: normalizedSymbolRef,
            direction,
            depth,
            limit,
        };

        if (!absolutePathResult.ok) {
            const payload = this.host.buildInvalidCallGraphRequestPayload(
                invalidSymbolRefContext,
                absolutePathResult.message,
                "not_indexed",
                "not_indexed",
            );
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                isError: true,
            };
        }

        if (!symbolFileResult.ok) {
            const payload = this.host.buildInvalidCallGraphRequestPayload(
                invalidSymbolRefContext,
                symbolFileResult.message,
                "not_found",
                "invalid_symbol_ref",
            );
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                isError: true,
            };
        }

        if (!symbolRef || typeof symbolRef.file !== "string" || typeof symbolRef.symbolId !== "string") {
            const payload = this.host.buildInvalidCallGraphRequestPayload(
                invalidSymbolRefContext,
                "symbolRef with { file, symbolId } is required.",
                "not_found",
                "invalid_symbol_ref",
            );
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                isError: true,
            };
        }

        try {
            const absolutePath = absolutePathResult.absolutePath;
            if (!fs.existsSync(absolutePath)) {
                const payload = this.host.buildInvalidCallGraphRequestPayload(
                    {
                        path: absolutePath,
                        symbolRef: normalizedSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    `Path '${absolutePath}' does not exist. call_graph requires an indexed codebase directory root.`,
                    "not_indexed",
                    "not_indexed",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                const payload = this.host.buildInvalidCallGraphRequestPayload(
                    {
                        path: absolutePath,
                        symbolRef: normalizedSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    `Path '${absolutePath}' is not a directory. call_graph requires an indexed codebase directory root.`,
                    "not_indexed",
                    "not_indexed",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            trackCodebasePath(absolutePath);

            const trackedRootState = await this.host.trackedRootReadiness.prepareTrackedRootForRead(absolutePath, "navigation");
            if (trackedRootState.state === "requires_reindex") {
                const payload = this.host.buildRequiresReindexCallGraphPayload(
                    trackedRootState.codebasePath,
                    trackedRootState.message,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "indexing") {
                const payload = this.host.buildNotReadyCallGraphPayload(trackedRootState.codebasePath, {
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit,
                });
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "index_failed") {
                const payload = this.host.trackedRootReadiness.buildIndexFailedCallGraphPayload(trackedRootState.codebasePath, {
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit,
                }, trackedRootState.info);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "not_indexed") {
                const payload = this.host.buildNotIndexedCallGraphPayload({
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit,
                });
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "stale_local") {
                const payload = this.host.buildNotIndexedCallGraphPayload(
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    {
                        codebaseRoot: trackedRootState.codebasePath,
                        reason: trackedRootState.reason,
                    },
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "missing_collection") {
                const payload = this.host.withProofDebugHint(this.host.trackedRootReadiness.buildMissingLocalCollectionCallGraphPayload(
                    trackedRootState.codebasePath,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    trackedRootState.collectionName,
                ), trackedRootState.proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const searchableRoot = trackedRootState.root;
            const effectiveRoot = searchableRoot.path;
            const proofDebugHint = trackedRootState.proofDebugHint;

            if (this.host.isPartialIndexNavigationUnavailable(searchableRoot.info)) {
                const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_DETAIL,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    "partial_index_navigation_unavailable",
                ), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const normalizedSymbolFile = this.host.normalizeRelativeFilePath(symbolRef.file);
            const registryState = await this.host.navigationStore.getSymbolsByFile({
                normalizedRootPath: effectiveRoot,
                file: normalizedSymbolFile,
            });
            if (registryState.status !== "ok") {
                const reason = registryState.status === "missing"
                    ? "missing_symbol_registry"
                    : "incompatible_symbol_registry";
                const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    `Symbol registry is ${registryState.status}: ${registryState.reason}`,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    reason,
                ), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const exactRegistrySymbols = findExactRegistrySymbols({
                symbols: registryState.symbols,
                symbolIdExact: symbolRef.symbolId,
                symbolLabelExact: symbolRef.symbolLabel,
            });
            if (exactRegistrySymbols.length === 0) {
                const payload = this.host.withProofDebugHint({
                    status: "not_found" as const,
                    path: effectiveRoot,
                    symbolRef,
                    supported: false,
                    reason: "missing_symbol",
                    message: "No exact symbol match found in relationship-backed navigation state.",
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (exactRegistrySymbols.length > 1) {
                const payload = this.host.withProofDebugHint({
                    status: "not_found" as const,
                    path: effectiveRoot,
                    symbolRef,
                    supported: false,
                    reason: "missing_symbol",
                    message: "Ambiguous exact symbol reference. Use symbolInstanceId for deterministic traversal.",
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const resolvedSymbolRepair = repairSourceBackedPythonSpan({
                codebaseRoot: effectiveRoot,
                symbol: exactRegistrySymbols[0],
            });
            const resolvedSymbol = resolvedSymbolRepair.symbol;
            const absoluteSymbolFile = path.resolve(effectiveRoot, normalizedSymbolFile);
            const relativeSymbolFile = path.relative(effectiveRoot, absoluteSymbolFile);
            const symbolFileInsideRoot = !relativeSymbolFile.startsWith("..") && !path.isAbsolute(relativeSymbolFile);
            if (!symbolFileInsideRoot || !fs.existsSync(absoluteSymbolFile) || !fs.statSync(absoluteSymbolFile).isFile()) {
                if (exactRegistrySymbols.some((symbol) => this.host.isSha256HexHash(symbol.fileHash))) {
                    const payload = this.host.withProofDebugHint(this.host.buildStaleSymbolRefCallGraphPayload({
                        codebaseRoot: effectiveRoot,
                        context: {
                            path: absolutePath,
                            symbolRef,
                            direction,
                            depth,
                            limit,
                        },
                        message: `Symbol reference points at '${normalizedSymbolFile}', but the current file is unavailable. Refresh the index before using exact call graph navigation.`,
                    }), proofDebugHint);
                    return {
                        content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    };
                }
            } else {
                const fileFreshness = this.host.getRegistryFileFreshness({
                    symbols: exactRegistrySymbols,
                    absoluteFile: absoluteSymbolFile,
                });
                if (fileFreshness.status === "inconsistent") {
                    const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexCallGraphPayload(
                        effectiveRoot,
                        `Symbol registry contains inconsistent file hashes for '${normalizedSymbolFile}'.`,
                        {
                            path: absolutePath,
                            symbolRef,
                            direction,
                            depth,
                            limit,
                        },
                        "incompatible_symbol_registry",
                    ), proofDebugHint);
                    return {
                        content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    };
                }
                if (fileFreshness.status === "stale") {
                    const payload = this.host.withProofDebugHint(this.host.buildStaleSymbolRefCallGraphPayload({
                        codebaseRoot: effectiveRoot,
                        context: {
                            path: absolutePath,
                            symbolRef,
                            direction,
                            depth,
                            limit,
                        },
                        message: `Symbol reference for '${normalizedSymbolFile}' is stale relative to the current file contents. Refresh the index before using exact call graph navigation.`,
                    }), proofDebugHint);
                    return {
                        content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    };
                }
            }

            if (!this.host.isCallGraphLanguageSupported(resolvedSymbol.language, resolvedSymbol.file)) {
                const payload = this.host.withProofDebugHint({
                    status: "unsupported" as const,
                    path: effectiveRoot,
                    symbolRef,
                    supported: false,
                    reason: "unsupported_language",
                    message: `Language '${resolvedSymbol.language}' does not support relationship-backed call graph traversal.`,
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const compatibility = await this.host.navigationStore.getCompatibilityState({
                normalizedRootPath: effectiveRoot,
                expectedSymbolRegistryManifestHash: registryState.manifestHash,
            });
            if (compatibility.relationships.status !== "ok") {
                const reason = compatibility.relationships.status === "missing"
                    ? "missing_relationship_sidecar"
                    : "incompatible_relationship_sidecar";
                const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    `Relationship sidecar is ${compatibility.relationships.status}: ${compatibility.relationships.reason}`,
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    reason,
                ), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const relationshipBackedGraph = await this.host.buildRelationshipBackedCallGraph({
                codebaseRoot: effectiveRoot,
                registry: registryState.registry,
                registryManifestHash: registryState.manifestHash,
                resolvedSymbol,
                sourceSpanRepair: resolvedSymbolRepair,
                direction,
                depth,
                limit,
            });
            if (!relationshipBackedGraph) {
                const payload = this.host.withProofDebugHint(this.host.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    "Relationship-backed call graph traversal could not load a compatible navigation snapshot.",
                    {
                        path: absolutePath,
                        symbolRef,
                        direction,
                        depth,
                        limit,
                    },
                ), proofDebugHint);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            await this.host.touchWatchedCodebase(effectiveRoot);
            const payload = this.host.withProofDebugHint({
                status: "ok" as const,
                path: effectiveRoot,
                symbolRef,
                ...relationshipBackedGraph,
            } satisfies CallGraphResponseEnvelope, proofDebugHint);
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
            };
        } catch (error: unknown) {
            const pathResult = typeof args?.path === "string"
                ? requireAbsoluteFilesystemPath(args.path)
                : null;
            const payload = this.host.buildInvalidCallGraphRequestPayload(
                {
                    path: pathResult?.ok ? pathResult.absolutePath : (typeof args?.path === "string" ? args.path : ""),
                    symbolRef: normalizedSymbolRef,
                    direction,
                    depth,
                    limit,
                },
                `Unexpected call_graph failure: ${formatUnknownError(error)}`,
                "not_ready",
            );
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                isError: true,
            };
        }
    }
}
