import * as crypto from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import {
    analyzeGoSymbolStructure,
    analyzePythonSymbolStructure,
    compareContractStrings,
    detectLanguageId,
    getSupportedExtensionsForCapability,
    isLanguageCapabilitySupportedForLanguage,
    pathDeterminedLanguageId,
    JsonNavigationStore,
    isProofBackedAuthoritativeCall,
    summarizeResolutionConstructCoverage,
    traceRelationshipPath,
    type PublicationLease,
    type PublicationPackageOwnership,
    type PublicationRef,
    type SymbolRecord,
    type SymbolRegistry,
    type SymbolStructuralAnalysis,
    type TraceRelationshipPathInput,
} from "@satori-code/core";

import {
    repairSourceBackedPythonSpan,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import {
    ArchitecturePackageOwnershipError,
    buildArchitectureOverview,
    type ArchitectureOverviewResult,
    type ArchitectureOverviewScope,
} from "./architecture-overview.js";
import {
    PublishedFileAuthorizationError,
} from "./published-file-authorization.js";
import {
    AuthorizedSourceReadError,
    readAuthorizedPublishedSource,
    type AuthorizedSourceRead,
} from "./published-source-reader.js";
import {
    findExactPublishedSourceReferences,
    type ExactReferenceSearchResult,
    type ExactReferenceSourceRead,
} from "./exact-reference-search.js";
import {
    findReferencesScopeIdentity,
    InvalidFindReferencesContinuationError,
    parseFindReferencesCursor,
    serializeFindReferencesCursor,
    type FindReferencesCursorIdentity,
} from "./find-references-continuation.js";
import {
    WorkspaceAuthorizationError,
    type SessionWorkspacePolicy,
} from "./session-workspace-policy.js";
import {
    buildRegistryFileOutlinePayload,
    FILE_OUTLINE_RESPONSE_MAX_UTF8_BYTES,
    fitFileOutlineResponseBudget,
    findExactRegistrySymbols,
} from "./registry-file-outline.js";
import {
    buildCurrentSourceEvidenceFromBytes,
    mapPublishedSymbolsToCurrentSpans,
} from "./current-source-symbols.js";
import { prepareRelationshipTraversals } from "./prepared-relationship-traversal.js";
import { PreparedPublicationReadSession } from "./prepared-publication-read-session.js";
import {
    InvalidCallGraphEvidenceContinuationError,
    projectCallGraphEvidence,
    type CallGraphEvidenceRequest,
} from "./call-graph-evidence-projection.js";
import type { PublishedPathScope } from "./navigation-path-scope.js";
import {
    candidateWithinRequestedSubdirectory,
    resolveRequestedSearchSubdirectory,
} from "./search-requested-scope.js";
import type {
    CompletionProbeDebugHint,
    TrackedRootReadiness,
    TrackedRootReadinessState,
} from "./tracked-root-readiness.js";
import {
    resolveCallGraphNavigationAuthority,
    type RelationshipBackedCallGraphResult,
} from "./relationship-backed-call-graph.js";
import { ToolResponseBuilders } from "./tool-response-builders.js";
import type { FreshnessDecision } from "./sync.js";
import { buildFreshnessWarningCodes } from "./warnings.js";
import type {
    AmbiguousSymbolCandidate,
    CallGraphDirection,
    CallGraphEdgeResult as CallGraphEdge,
    CallGraphHint,
    CallGraphResponseEnvelope,
    CallGraphSymbolRef,
    FileOutlineInput,
    FileOutlineResponseEnvelope,
    FileOutlineStatus,
} from "./search-types.js";
import {
    requireAbsoluteFilesystemPath,
    requireRepoRelativeFilePath,
    trackCodebasePath,
    type RepoRelativeFileResult,
} from "../utils.js";

const AMBIGUOUS_SYMBOL_CANDIDATES_LIMIT = 20;

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

function canonicalizeBoundaryRoot(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

/**
 * Canonicalize existing ancestor directories while preserving the final path
 * component untouched so a final symlink is never dereferenced when mapping
 * an in-root absolute path to a repo-relative path.
 */
function canonicalizeParentPreservingBasename(resolvedPath: string): string {
    const parentDir = path.dirname(resolvedPath);
    if (parentDir === resolvedPath) {
        return resolvedPath;
    }
    const missingParts: string[] = [];
    let current = parentDir;
    for (;;) {
        try {
            const real = fs.realpathSync.native(current);
            return missingParts.length === 0
                ? path.join(real, path.basename(resolvedPath))
                : path.join(real, ...missingParts.reverse(), path.basename(resolvedPath));
        } catch {
            const nextParent = path.dirname(current);
            if (nextParent === current) {
                return resolvedPath;
            }
            missingParts.push(path.basename(current));
            current = nextParent;
        }
    }
}

function isBoundaryPathInsideRoot(targetPath: string, rootPath: string): boolean {
    return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

type BoundaryFileInputValidation =
    | { ok: true; isAbsolute: false; relativePath: string }
    | { ok: true; isAbsolute: true; rawPath: string }
    | { ok: false; path: string; message: string };

function validateBoundaryFileInput(inputPath: unknown, fieldName: string): BoundaryFileInputValidation {
    if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
        return {
            ok: false,
            path: typeof inputPath === "string" ? inputPath : "",
            message: `${fieldName} is required.`,
        };
    }
    const trimmed = inputPath.trim();
    if (trimmed.includes("\0")) {
        return {
            ok: false,
            path: trimmed,
            message: `Error: '${fieldName}' must not contain NUL bytes.`,
        };
    }
    if (trimmed.split(/[\\/]/).includes("..")) {
        return {
            ok: false,
            path: trimmed,
            message: `Error: '${fieldName}' must stay inside the codebase root (path escape segments are not allowed).`,
        };
    }
    if (/^[A-Za-z]:(?![\\/])/.test(trimmed)) {
        return {
            ok: false,
            path: trimmed,
            message: `Error: '${fieldName}' must be a repo-relative path or an absolute path inside the codebase root, not a drive-relative path.`,
        };
    }
    if (path.isAbsolute(trimmed)) {
        const resolved = path.resolve(trimmed);
        if (path.basename(resolved).length === 0) {
            return {
                ok: false,
                path: trimmed,
                message: `Error: '${fieldName}' must point to a file inside the codebase root.`,
            };
        }
        return { ok: true, isAbsolute: true, rawPath: trimmed };
    }
    const rel = requireRepoRelativeFilePath(trimmed, fieldName);
    if (!rel.ok) {
        return rel;
    }
    return { ok: true, isAbsolute: false, relativePath: rel.relativePath };
}

function resolveBoundaryFileToRepoRelative(
    inputPath: unknown,
    rootPath: string,
    fieldName: string,
): RepoRelativeFileResult {
    const validated = validateBoundaryFileInput(inputPath, fieldName);
    if (!validated.ok) {
        return validated;
    }
    if (!validated.isAbsolute) {
        return { ok: true, relativePath: validated.relativePath };
    }
    const resolvedFile = path.resolve(validated.rawPath);
    const canonicalRoot = canonicalizeBoundaryRoot(rootPath);
    const canonicalParentFile = canonicalizeParentPreservingBasename(resolvedFile);
    if (canonicalParentFile === canonicalRoot || !isBoundaryPathInsideRoot(canonicalParentFile, canonicalRoot)) {
        return {
            ok: false,
            path: validated.rawPath,
            message: `Error: '${fieldName}' must resolve inside the indexed codebase root '${rootPath}'.`,
        };
    }
    const relativePath = path.relative(canonicalRoot, canonicalParentFile).replace(/\\/g, "/");
    return requireRepoRelativeFilePath(relativePath, fieldName);
}

function projectAmbiguousSymbolCandidates(
    symbols: readonly SymbolRecord[],
    fallbackFile: string,
): AmbiguousSymbolCandidate[] {
    const sorted = [...symbols].sort((a, b) => {
        const lineCmp = a.span.startLine - b.span.startLine;
        if (lineCmp !== 0) return lineCmp;
        return compareContractStrings(a.symbolInstanceId, b.symbolInstanceId);
    });
    return sorted.slice(0, AMBIGUOUS_SYMBOL_CANDIDATES_LIMIT).map((symbol) => ({
        symbolId: symbol.symbolInstanceId,
        symbolLabel: symbol.label,
        kind: symbol.kind,
        file: symbol.file || fallbackFile,
        span: {
            startLine: symbol.span.startLine,
            endLine: symbol.span.endLine,
        },
    }));
}

type SymbolRefResolutionResult =
    | { status: "resolved"; symbol: SymbolRecord }
    | { status: "missing" }
    | { status: "ambiguous"; candidates: AmbiguousSymbolCandidate[]; totalCandidateCount: number };

function resolveSymbolRefInFile(input: {
    symbols: SymbolRecord[];
    symbolId?: string;
    symbolLabel?: string;
    file: string;
}): SymbolRefResolutionResult {
    const symbolId = typeof input.symbolId === "string" ? input.symbolId.trim() : "";
    const symbolLabel = typeof input.symbolLabel === "string" ? input.symbolLabel.trim() : "";
    if (symbolId.length > 0) {
        const exactById = findExactRegistrySymbols({
            symbols: input.symbols,
            symbolIdExact: symbolId,
        });
        if (exactById.length === 1) {
            return { status: "resolved", symbol: exactById[0]! };
        }
        if (exactById.length === 0) {
            return { status: "missing" };
        }
        return {
            status: "ambiguous",
            candidates: projectAmbiguousSymbolCandidates(exactById, input.file),
            totalCandidateCount: exactById.length,
        };
    }

    if (symbolLabel.length === 0) {
        return { status: "missing" };
    }

    let labelMatches = findExactRegistrySymbols({
        symbols: input.symbols,
        symbolLabelExact: symbolLabel,
    });
    if (labelMatches.length === 0) {
        const hasExtractedSymbols = input.symbols.some((symbol) => symbol.kind !== "file");
        labelMatches = input.symbols.filter((symbol) => {
            if (hasExtractedSymbols && symbol.kind === "file") {
                return false;
            }
            return symbol.name === symbolLabel || symbol.qualifiedName === symbolLabel;
        });
    }

    if (labelMatches.length === 1) {
        return { status: "resolved", symbol: labelMatches[0]! };
    }
    if (labelMatches.length === 0) {
        return { status: "missing" };
    }
    return {
        status: "ambiguous",
        candidates: projectAmbiguousSymbolCandidates(labelMatches, input.file),
        totalCandidateCount: labelMatches.length,
    };
}

export type NavigationSourceOptions = {
    publishedSource?: Buffer;
    requireCurrentSource?: boolean;
    signal?: AbortSignal;
};

type ToolArgs = Record<string, unknown>;

type ToolTextResponse = {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
};

type CallGraphUnavailableReason = "missing_symbol" | "stale_symbol_ref" | "unsupported_language" | "missing_relationship_navigation" | "incompatible_relationship_navigation" | "missing_symbol_registry" | "incompatible_symbol_registry";

const OUTLINE_SUPPORTED_EXTENSIONS = getSupportedExtensionsForCapability("fileOutline");
const PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_DETAIL = "Partial index/search data may exist, but Publication navigation was not published because indexing stopped before completion.";

type NavigationHandlersHost = {
    toolResponseBuilders: ToolResponseBuilders;


    trackedRootReadiness: Pick<
        TrackedRootReadiness,
        | "prepareTrackedRootForRead"
        | "buildIndexFailedFileOutlinePayload"
        | "buildMissingLocalCollectionFileOutlinePayload"
        | "buildIndexFailedCallGraphPayload"
        | "buildMissingLocalCollectionCallGraphPayload"
    >;


    prepareNavigationRead(absolutePath: string): Promise<TrackedRootReadinessState>;


    acquirePublicationLease(codebasePath: string, publicationId?: string): PublicationLease | undefined;
    isPublicationAdmitted(publication: PublicationRef): Promise<boolean>;
    getPublicationPackageOwnership(publication: PublicationRef): PublicationPackageOwnership | null;
    getPublicationNavigationAddress(publication: PublicationRef): {
        publicationId: string;
        navigationRoot: string;
    } | null;
    getPublicationNavigationStatus(publication: PublicationRef): Promise<import("@satori-code/core").PublicationNavigationStatus>;
    tracePath?: (input: TraceRelationshipPathInput) => ReturnType<typeof traceRelationshipPath>;
    loadPreparedNavigationSymbolsByFile(
        preparedRead: Extract<TrackedRootReadinessState, { state: "ready" }>,
        file: string,
    ): ReturnType<JsonNavigationStore["getSymbolsByFile"]>;
    loadPreparedNavigationManifest(
        preparedRead: Extract<TrackedRootReadinessState, { state: "ready" }>,
    ): ReturnType<JsonNavigationStore["getManifest"]>;


    loadPreparedNavigationCompatibility(
        preparedRead: Extract<TrackedRootReadinessState, { state: "ready" }>,
        expectedSymbolRegistryManifestHash: string,
    ): ReturnType<JsonNavigationStore["getCompatibilityState"]>;
    loadPreparedNavigationAnalysisEvidence(
        preparedRead: Extract<TrackedRootReadinessState, { state: "ready" }>,
        expectedSymbolRegistryManifestHash: string,
        files: readonly string[],
    ): ReturnType<JsonNavigationStore["getAnalysisEvidenceForFiles"]>;
    loadPreparedNavigationResolutionClaims(
        preparedRead: Extract<TrackedRootReadinessState, { state: "ready" }>,
        expectedSymbolRegistryManifestHash: string,
    ): ReturnType<JsonNavigationStore["getAllResolutionClaims"]>;
    stringifyToolJson(value: unknown): string;


    normalizeRelativeFilePath(relativeFilePath: string): string;


    buildRequiresReindexFileOutlinePayload(codebasePath: string, args: Record<string, unknown>, detail?: string, reason?: string): object;


    withProofDebugHint<T extends object>(payload: T, proofDebugHint?: CompletionProbeDebugHint): T;


    isPartialIndexNavigationUnavailable(info: unknown): boolean;


    getRegistryFileFreshness(input: {
        symbols: SymbolRecord[];
        absoluteFile: string;
        sourceBytes: Buffer;
    }): { status: "fresh" | "stale" | "unknown" | "inconsistent"; registryHash?: string; currentHash?: string };


    /**
     * Whole-file byte ceiling for navigation source reads (config
     * READ_FILE_MAX_BYTES; the reader defaults to 8 MiB when absent).
     */
    readFileMaxBytes?: number;


    buildStaleSymbolRefFileOutlinePayload(codebasePath: string, args: Record<string, unknown>, detail?: string): FileOutlineResponseEnvelope;


    loadRegistryValidatedRelationshipNavigation(input: {
        codebaseRoot: string;
        registryManifestHash?: string;
        registryUnavailableReason?: CallGraphUnavailableReason;
        preparedRead?: Extract<TrackedRootReadinessState, { state: "ready" }>;
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
    buildSyncHint(codebasePath: string): { tool: string; args: { action: string; path: string } };


    getOutlineStatusForLanguage(relativeFilePath: string): FileOutlineStatus;


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
        publicationId: string;
        navigationRoot: string;
        registry: SymbolRegistry;
        registryManifestHash: string;
        resolvedSymbol: SymbolRecord;
        sourceSpanRepair?: PythonSourceBackedSpanRepair;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
        pathScope?: PublishedPathScope;
        readAuthorizedSourceLines?: (codebaseRoot: string, relativeFilePath: string) => Promise<string[] | undefined>;
        findExactSourceReferences?: (target: SymbolRecord) => Promise<ExactReferenceSearchResult>;
    }): Promise<RelationshipBackedCallGraphResult | null>;
};

function buildSourceStateUnverifiedFileOutlinePayload(
    host: Pick<NavigationHandlersHost, "buildSyncHint">,
    codebasePath: string,
    file: string,
    reason: "source_state_unverified" | "source_changed_during_request"
        = "source_state_unverified",
    retryArgs?: FileOutlineInput,
): FileOutlineResponseEnvelope {
    return {
        status: "not_ready",
        reason,
        path: codebasePath,
        file,
        outline: null,
        hasMore: false,
        message: reason === "source_changed_during_request"
            ? "Source changed while Satori was preparing this outline."
            : "Satori could not verify this outline against the current source.",
        hints: {
            ...(reason === "source_changed_during_request" && retryArgs
                ? {
                    retry: {
                        tool: "file_outline",
                        args: retryArgs,
                    },
                }
                : { sync: host.buildSyncHint(codebasePath) }),
        },
    };
}

function buildSourceStateUnverifiedCallGraphPayload(
    host: Pick<NavigationHandlersHost, "buildSyncHint">,
    codebasePath: string,
    context: {
        symbolRef: CallGraphSymbolRef;
        direction: CallGraphDirection;
        depth: number;
        limit: number;
        requestedPath?: string;
    },
): CallGraphResponseEnvelope {
    return {
        status: "not_ready",
        supported: true,
        reason: "source_state_unverified",
        path: context.requestedPath ?? codebasePath,
        codebaseRoot: codebasePath,
        symbolRef: context.symbolRef,
        direction: context.direction,
        depth: context.depth,
        limit: context.limit,
        nodes: [],
        edges: [],
        notes: [],
        message: "Satori could not verify this call graph against the current source.",
        hints: {
            sync: host.buildSyncHint(codebasePath),
        },
    };
}

function buildAnalysisUnavailableFileOutlinePayload(
    codebasePath: string,
    file: string,
    message: string,
    reason: "analysis_unavailable" | "unsupported_language" | "unsupported_symbol_kind"
        = "analysis_unavailable",
): FileOutlineResponseEnvelope {
    return {
        status: reason === "analysis_unavailable" ? "not_ready" : "unsupported",
        reason,
        path: codebasePath,
        file,
        outline: null,
        hasMore: false,
        message,
    };
}

function withNavigationFreshness<T extends FileOutlineResponseEnvelope | CallGraphResponseEnvelope>(
    payload: T,
    freshnessDecision: FreshnessDecision | undefined,
): T {
    if (!freshnessDecision) return payload;
    const warnings = Array.from(new Set([
        ...(payload.warnings ?? []),
        ...buildFreshnessWarningCodes(freshnessDecision),
    ])).sort();
    return {
        ...payload,
        freshnessDecision,
        ...(warnings.length > 0 ? { warnings } : {}),
    } as T;
}

function withStructuralAnalysis(
    payload: FileOutlineResponseEnvelope,
    analysis: SymbolStructuralAnalysis,
): FileOutlineResponseEnvelope {
    if (payload.status !== "ok" || payload.outline?.symbols.length !== 1) {
        return payload;
    }
    return {
        ...payload,
        outline: {
            symbols: [{
                ...payload.outline.symbols[0],
                analysis,
            }],
        },
    };
}

type FileOutlineRelationshipMetadata =
    NonNullable<NonNullable<FileOutlineResponseEnvelope["outline"]>["symbols"][number]["relationships"]>;

function unavailableRelationshipMetadata(
    coverage: "unsupported" | "unavailable",
): FileOutlineRelationshipMetadata {
    return {
        directCallerCount: null,
        directCalleeCount: null,
        recursionState: "unknown",
        relationshipCoverage: coverage,
    };
}

function withRelationshipMetadata(
    payload: FileOutlineResponseEnvelope,
    relationships: FileOutlineRelationshipMetadata,
): FileOutlineResponseEnvelope {
    if (payload.status !== "ok" || payload.outline?.symbols.length !== 1) {
        return payload;
    }
    return {
        ...payload,
        outline: {
            symbols: [{
                ...payload.outline.symbols[0],
                relationships,
            }],
        },
    };
}

function buildPartialRelationshipMetadata(input: {
    targetSymbolId: string;
    callers: readonly CallGraphEdge[];
    callees: readonly CallGraphEdge[];
}): FileOutlineRelationshipMetadata {
    const callerIds = new Set(input.callers
        .filter((edge) => edge.dstSymbolId === input.targetSymbolId)
        .map((edge) => edge.srcSymbolId));
    const calleeIds = new Set(input.callees
        .filter((edge) => edge.srcSymbolId === input.targetSymbolId)
        .map((edge) => edge.dstSymbolId));
    return {
        directCallerCount: callerIds.size > 0 ? callerIds.size : null,
        directCalleeCount: calleeIds.size > 0 ? calleeIds.size : null,
        recursionState: callerIds.has(input.targetSymbolId) || calleeIds.has(input.targetSymbolId)
            ? "confirmed"
            : "not_observed",
        relationshipCoverage: "partial",
    };
}

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

/**
 * Bounded LRU read. A hit refreshes recency; a miss returns undefined.
 * Map iteration order is insertion order, so the first key is the coldest.
 */
function readBoundedLru<T>(cache: Map<string, T>, key: string): T | undefined {
    const value = cache.get(key);
    if (value === undefined) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function writeBoundedLru<T>(cache: Map<string, T>, key: string, value: T, maxEntries: number): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxEntries) {
        const coldest = cache.keys().next();
        if (coldest.done) break;
        cache.delete(coldest.value);
    }
}

/** One digest per published file; a large repository still fits in a few MiB. */
const SOURCE_DIGEST_CACHE_MAX_ENTRIES = 16_384;
/**
 * A stat observed this close to the moment its bytes are hashed cannot prove
 * anything: a same-size in-place write inside the same filesystem timestamp
 * tick leaves the witness identical while the content changed. Mirrors the
 * racy-index rule in index-policy-input-observer.ts.
 */
const RACY_SOURCE_DIGEST_MARGIN_MS = 2_000;
/** Overviews are large, so only the most recent distinct request scopes are kept. */
const ARCHITECTURE_OVERVIEW_CACHE_MAX_ENTRIES = 16;

/**
 * Freeze a cached overview body and every nested array and object, so a later
 * request that reads the entry back cannot mutate what another request sees.
 */
function deepFreezeArchitectureOverview<T>(value: T): T {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
        deepFreezeArchitectureOverview(nested);
    }
    return value;
}

export class NavigationHandlers {
    /**
     * SHA-256 digests of authorized source bytes, witnessed by the descriptor
     * stat that produced them. find_references re-reads every eligible file on
     * each page, so an unchanged file must not be re-hashed. Entries are keyed
     * by codebase root plus repo-relative path, and only aged stats are stored.
     */
    private readonly sourceDigestCache = new Map<string, { signature: string; sha256: string }>();
    /**
     * Immutable architecture overviews, witnessed by the Publication identity,
     * the symbol-registry and relationship-navigation manifest hashes, the
     * package-ownership root, and the request scope. A warm call therefore
     * skips the full-disk resolution-claim scan and the aggregation.
     *
     * Lease admission plus the immutable Publication navigation guarantee is
     * what makes a hit sound: an admitted publication's navigation inputs
     * cannot change, so a cached body still claims presence for exactly the
     * files that publication published. Bodies are deep-frozen on write.
     */
    private readonly architectureOverviewCache = new Map<string, ArchitectureOverviewResult>();

    constructor(private readonly host: NavigationHandlersHost) {}

    public async handleTracePath(args: ToolArgs): Promise<ToolTextResponse> {
        const requestedPath = String(args.path);
        const respond = (payload: Record<string, unknown>): ToolTextResponse => ({
            content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
        });
        const session = new PreparedPublicationReadSession<TrackedRootReadinessState, PublicationLease | null>({
            prepareReadiness: () => this.host.prepareNavigationRead(requestedPath),
            acquirePublicationLease: (prepared) => prepared.state === "ready"
                ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                : null,
            isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
        });
        const outcome = await session.read(async (prepared, lease) => {
            if (prepared.state !== "ready" || lease === null) {
                return respond({ status: "not_ready", reason: prepared.state, path: requestedPath });
            }
            if (lease.id !== prepared.publication.id
                || lease.publication.canonicalRoot !== prepared.root.path) {
                return respond({ status: "not_ready", reason: "publication_identity_changed", path: requestedPath });
            }
            const navigation = this.host.getPublicationNavigationAddress(lease);
            if (!navigation || navigation.publicationId !== lease.id) {
                return respond({
                    status: "not_ready", reason: "missing_publication_navigation", path: requestedPath,
                });
            }
            let scopeSubtree: string | undefined;
            try {
                scopeSubtree = resolveRequestedSearchSubdirectory({
                    indexedRoot: lease.publication.canonicalRoot,
                    requestedPath,
                })?.relativePrefix;
            } catch {
                return respond({ status: "error", reason: "path_outside_indexed_root", path: requestedPath });
            }
            const result = await (this.host.tracePath ?? traceRelationshipPath)({
                normalizedRootPath: lease.publication.canonicalRoot,
                publicationId: lease.id,
                navigationRoot: navigation.navigationRoot,
                sourceSymbolId: String(args.sourceSymbolId),
                targetSymbolId: String(args.targetSymbolId),
                allowedTypes: args.relationshipKinds as TraceRelationshipPathInput["allowedTypes"],
                ...(scopeSubtree ? { scopeSubtree } : {}),
                maxDepth: Number(args.maxDepth),
                maxVisitedNodes: Number(args.maxVisitedNodes),
                maxTraversedEdges: Number(args.maxTraversedEdges),
            });
            if (result.status === "missing_symbol") {
                return respond({
                    status: "not_found", reason: "missing_symbol", symbol: result.symbol,
                    path: requestedPath, publicationId: lease.id,
                });
            }
            if (result.status !== "ok") {
                return respond({
                    status: "not_ready", reason: `${result.status}_navigation`,
                    path: requestedPath, publicationId: lease.id, message: result.reason,
                });
            }
            const freshnessDecision = prepared.freshnessDecision;
            const warnings = freshnessDecision
                ? Array.from(new Set([...result.warnings, ...buildFreshnessWarningCodes(freshnessDecision)])).sort()
                : result.warnings;
            return respond({
                status: "ok",
                path: requestedPath,
                codebaseRoot: lease.publication.canonicalRoot,
                publicationId: lease.id,
                sourceSymbolId: args.sourceSymbolId,
                targetSymbolId: args.targetSymbolId,
                relationshipKinds: args.relationshipKinds,
                maxDepth: args.maxDepth,
                maxVisitedNodes: args.maxVisitedNodes,
                maxTraversedEdges: args.maxTraversedEdges,
                found: result.path !== null,
                shortestPath: result.path && {
                    nodes: result.path.nodes.map((node) => ({
                        symbolId: node.symbolInstanceId,
                        label: node.label,
                        kind: node.kind,
                        file: node.file,
                        language: node.language,
                        span: node.span,
                    })),
                    edges: result.path.edges.map((edge) => ({
                        kind: edge.type,
                        sourceSymbolId: edge.sourceInstanceId,
                        targetSymbolId: edge.targetInstanceId,
                        site: { file: edge.file, span: edge.span },
                        confidence: edge.confidence,
                        ...(edge.strategy ? { strategy: edge.strategy } : {}),
                        ...(edge.resolutionAuthority ? { resolutionAuthority: edge.resolutionAuthority } : {}),
                        ...(edge.type === 'CALLS' ? {
                            targetProofBacked: isProofBackedAuthoritativeCall(edge),
                        } : {}),
                    })),
                },
                coverage: result.coverage,
                ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
                warnings,
                ...(freshnessDecision ? { freshnessDecision } : {}),
                message: result.path
                    ? "One shortest path found in the selected Publication and relationship scope."
                    : "No path found within this Publication, path scope, relationship kinds, and traversal budgets.",
            });
        });
        return outcome.status === "completed"
            ? outcome.result
            : respond({ status: "not_ready", reason: "publication_read_not_admitted", path: requestedPath });
    }

    public async handleArchitectureOverview(
        args: ToolArgs,
    ): Promise<ToolTextResponse> {
        const absolutePathResult = typeof args.path === "string"
            ? requireAbsoluteFilesystemPath(args.path, "path")
            : { ok: false as const, path: "", message: "path is required." };
        if (!absolutePathResult.ok) {
            return {
                content: [{
                    type: "text",
                    text: this.host.stringifyToolJson({
                        status: "error",
                        reason: "invalid_path",
                        message: absolutePathResult.message,
                    }),
                }],
                isError: true,
            };
        }

        const scope: ArchitectureOverviewScope = args.scope === "all" ? "all" : "runtime";
        const limit = Number.isFinite(args.limit)
            ? Math.max(1, Math.min(50, Math.floor(Number(args.limit))))
            : 15;
        const subtree = typeof args.subtree === "string" ? args.subtree : undefined;
        const excludePaths = Array.isArray(args.excludePaths)
            ? args.excludePaths.filter((value): value is string => typeof value === "string")
            : undefined;
        const requestedRoot = absolutePathResult.absolutePath;
        trackCodebasePath(requestedRoot);

        const session = new PreparedPublicationReadSession<TrackedRootReadinessState, PublicationLease | null>({
            prepareReadiness: () => this.host.prepareNavigationRead(requestedRoot),
            acquirePublicationLease: (prepared) => (
                prepared.state === "ready"
                    ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                    : null
            ),
            isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
        });

        const outcome = await session.read(async (trackedRootState, lease): Promise<ToolTextResponse> => {
            if (trackedRootState.state !== "ready" || lease === null) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: trackedRootState.state,
                            path: requestedRoot,
                            message: "A compatible completed Publication with navigation is required.",
                        }),
                    }],
                };
            }

            const leasedRootState: Extract<TrackedRootReadinessState, { state: "ready" }> = {
                ...trackedRootState,
                publication: lease,
                navigationStatus: await this.host.getPublicationNavigationStatus(lease),
            };
            let packageOwnership: PublicationPackageOwnership | null;
            try {
                packageOwnership = this.host.getPublicationPackageOwnership(lease);
            } catch (error) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: "incompatible_package_ownership",
                            path: leasedRootState.root.path,
                            message: `Publication package ownership could not be read: ${formatUnknownError(error)}`,
                        }),
                    }],
                };
            }
            if (!packageOwnership) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: "missing_package_ownership",
                            path: leasedRootState.root.path,
                            message: "The leased Publication is missing its package ownership snapshot.",
                        }),
                    }],
                };
            }
            if (packageOwnership.canonicalRoot !== lease.publication.canonicalRoot) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: "incompatible_package_ownership",
                            path: leasedRootState.root.path,
                            message: "The leased Publication package ownership root is incompatible.",
                        }),
                    }],
                };
            }

            const manifest = await this.host.loadPreparedNavigationManifest(leasedRootState);
            if (manifest.status !== "ok") {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: manifest.status === "missing"
                                ? "missing_symbol_registry"
                                : "incompatible_symbol_registry",
                            path: leasedRootState.root.path,
                            message: `Symbol registry is ${manifest.status}: ${manifest.reason}`,
                        }),
                    }],
                };
            }

            const compatibility = await this.host.loadPreparedNavigationCompatibility(
                leasedRootState,
                manifest.manifestHash,
            );
            if (compatibility.relationships.status !== "ok") {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: compatibility.relationships.status === "missing"
                                ? "missing_relationship_navigation"
                                : "incompatible_relationship_navigation",
                            path: leasedRootState.root.path,
                            message: `Relationship navigation is ${compatibility.relationships.status}: ${compatibility.relationships.reason}`,
                        }),
                    }],
                };
            }

            const requestedSubdirectory = resolveRequestedSearchSubdirectory({
                indexedRoot: leasedRootState.root.path,
                requestedPath: requestedRoot,
            });
            const effectiveSubtree = subtree ?? requestedSubdirectory?.relativePrefix;
            // The overview is a pure function of the immutable Publication
            // navigation inputs and the request scope, so the witness is the
            // Publication identity plus every manifest hash it was built from.
            // Missing or incompatible navigation already failed closed above.
            const overviewCacheKey = JSON.stringify({
                publicationId: lease.id,
                manifestHash: manifest.manifestHash,
                relationshipManifestHash: compatibility.relationships.manifestHash,
                ownershipCanonicalRoot: packageOwnership.canonicalRoot,
                requestedRoot,
                scope,
                limit,
                effectiveSubtree: effectiveSubtree ?? null,
                excludePaths: excludePaths ? [...excludePaths].sort() : [],
            });
            const cachedOverview = readBoundedLru(this.architectureOverviewCache, overviewCacheKey);
            if (cachedOverview) {
                return this.architectureOverviewResponse({
                    overview: cachedOverview,
                    requestedRoot,
                    publicationId: lease.id,
                    freshnessDecision: leasedRootState.freshnessDecision,
                });
            }

            const resolutionClaims = await this.host.loadPreparedNavigationResolutionClaims(
                leasedRootState,
                manifest.manifestHash,
            );
            if (resolutionClaims.status !== "ok") {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: resolutionClaims.status === "missing"
                                ? "missing_relationship_navigation"
                                : "incompatible_relationship_navigation",
                            path: leasedRootState.root.path,
                            message: `Relationship navigation is ${resolutionClaims.status}: ${resolutionClaims.reason}`,
                        }),
                    }],
                };
            }

            let architectureManifest = manifest.registry.manifest;
            let architectureSymbols = manifest.registry.symbols;
            let architectureRelationships = compatibility.relationships.records;
            let architectureClaims = resolutionClaims.claims;
            if (requestedSubdirectory) {
                // Authorization covers the requested directory, not its ancestor Publication.
                // Restrict inputs before aggregation so counts and ownership metadata cannot leak siblings.
                const withinRequest = (file: string) => candidateWithinRequestedSubdirectory(file, requestedSubdirectory);
                const symbolsById = new Map(architectureSymbols.map((symbol) => [symbol.symbolInstanceId, symbol]));
                architectureManifest = {
                    ...architectureManifest,
                    files: architectureManifest.files.filter((file) => withinRequest(file.path)),
                };
                architectureSymbols = architectureSymbols.filter((symbol) => withinRequest(symbol.file));
                architectureRelationships = architectureRelationships.filter((relationship) => {
                    const source = relationship.sourceInstanceId ? symbolsById.get(relationship.sourceInstanceId) : undefined;
                    const target = relationship.targetInstanceId ? symbolsById.get(relationship.targetInstanceId) : undefined;
                    const sourceFile = source?.file ?? relationship.file;
                    const targetFile = target?.file ?? relationship.targetPath;
                    return Boolean(sourceFile && targetFile && withinRequest(sourceFile) && withinRequest(targetFile));
                });
                architectureClaims = architectureClaims.filter((claim) => withinRequest(claim.sourceFile));
                const files = packageOwnership.files.filter((file) => withinRequest(file.path));
                // Owning package identities describe authorized files even when their manifest is above the request.
                const packageRoots = new Set(files.map((file) => file.packageRoot));
                packageOwnership = {
                    ...packageOwnership,
                    workspace: packageOwnership.workspace && withinRequest(packageOwnership.workspace.manifestPath)
                        ? packageOwnership.workspace : null,
                    cargoWorkspaces: (packageOwnership.cargoWorkspaces ?? []).filter((workspace) => withinRequest(workspace.manifestPath)),
                    packages: packageOwnership.packages.filter((pkg) => packageRoots.has(pkg.root)),
                    files,
                };
            }
            let overview;
            try {
                overview = buildArchitectureOverview({
                    manifest: architectureManifest,
                    packageOwnership,
                    symbols: architectureSymbols,
                    relationships: architectureRelationships,
                    resolutionClaims: architectureClaims,
                    scope,
                    limit,
                    ...(effectiveSubtree ? { subtree: effectiveSubtree } : {}),
                    ...(excludePaths ? { excludePaths } : {}),
                });
            } catch (error) {
                if (!(error instanceof ArchitecturePackageOwnershipError)) throw error;
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: "incompatible_package_ownership",
                            path: leasedRootState.root.path,
                            message: error.message,
                        }),
                    }],
                };
            }
            writeBoundedLru(
                this.architectureOverviewCache,
                overviewCacheKey,
                deepFreezeArchitectureOverview(overview),
                ARCHITECTURE_OVERVIEW_CACHE_MAX_ENTRIES,
            );
            return this.architectureOverviewResponse({
                overview,
                requestedRoot,
                publicationId: lease.id,
                freshnessDecision: leasedRootState.freshnessDecision,
            });
        });

        return outcome.status === "stale"
            ? {
                content: [{
                    type: "text",
                    text: this.host.stringifyToolJson({
                        status: "not_ready",
                        reason: "source_state_unverified",
                        path: requestedRoot,
                        message: "Publication authority changed while architecture evidence was being read; retry the request.",
                    }),
                }],
            }
            : outcome.result;
    }

    public async handleFindReferences(
        args: ToolArgs,
        workspacePolicy: SessionWorkspacePolicy,
        signal?: AbortSignal,
    ): Promise<ToolTextResponse> {
        signal?.throwIfAborted();
        const absolutePathResult = typeof args.path === "string"
            ? requireAbsoluteFilesystemPath(args.path, "path")
            : { ok: false as const, path: "", message: "path is required." };
        const rawSymbolRef = args.symbolRef as CallGraphSymbolRef | undefined;
        const symbolFileValidation = validateBoundaryFileInput(rawSymbolRef?.file, "symbolRef.file");
        const rawSymbolId = typeof rawSymbolRef?.symbolId === "string" ? rawSymbolRef.symbolId.trim() : "";
        const rawSymbolLabel = typeof rawSymbolRef?.symbolLabel === "string" ? rawSymbolRef.symbolLabel.trim() : "";
        if (!absolutePathResult.ok || !rawSymbolRef || !symbolFileValidation.ok || (!rawSymbolId && !rawSymbolLabel)) {
            return {
                content: [{
                    type: "text",
                    text: this.host.stringifyToolJson({
                        status: "error",
                        reason: "invalid_request",
                        path: absolutePathResult.ok ? absolutePathResult.absolutePath : (typeof args.path === "string" ? args.path : ""),
                        message: !absolutePathResult.ok
                            ? absolutePathResult.message
                            : !symbolFileValidation.ok
                                ? symbolFileValidation.message
                                : "symbolRef with { file, symbolId } or { file, symbolLabel } is required.",
                    }),
                }],
                isError: true,
            };
        }

        const requestedRoot = absolutePathResult.absolutePath;
        if (symbolFileValidation.isAbsolute) {
            const preliminaryFileResult = resolveBoundaryFileToRepoRelative(
                symbolFileValidation.rawPath,
                requestedRoot,
                "symbolRef.file",
            );
            if (!preliminaryFileResult.ok) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "error",
                            reason: "invalid_request",
                            path: requestedRoot,
                            message: preliminaryFileResult.message,
                        }),
                    }],
                    isError: true,
                };
            }
        }
        trackCodebasePath(requestedRoot);
        const limit = Number.isFinite(args.limit)
            ? Math.max(1, Math.min(500, Math.floor(Number(args.limit))))
            : 100;
        const scope = {
            ...(typeof args.subtree === "string" ? { subtree: args.subtree } : {}),
            ...(Array.isArray(args.includePaths)
                ? { includePaths: args.includePaths.filter((value): value is string => typeof value === "string") }
                : {}),
            ...(Array.isArray(args.excludePaths)
                ? { excludePaths: args.excludePaths.filter((value): value is string => typeof value === "string") }
                : {}),
        };

        const session = new PreparedPublicationReadSession<TrackedRootReadinessState, PublicationLease | null>({
            prepareReadiness: () => this.host.prepareNavigationRead(requestedRoot),
            acquirePublicationLease: (prepared) => (
                prepared.state === "ready"
                    ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                    : null
            ),
            isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
        });

        const outcome = await session.read(async (trackedRootState, lease): Promise<ToolTextResponse> => {
            signal?.throwIfAborted();
            if (trackedRootState.state !== "ready" || lease === null) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: trackedRootState.state,
                            path: requestedRoot,
                            message: "A compatible completed Publication with symbol navigation is required.",
                        }),
                    }],
                };
            }

            const leasedRootState: Extract<TrackedRootReadinessState, { state: "ready" }> = {
                ...trackedRootState,
                publication: lease,
                navigationStatus: await this.host.getPublicationNavigationStatus(lease),
            };
            const manifest = await this.host.loadPreparedNavigationManifest(leasedRootState);
            if (manifest.status !== "ok") {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_ready",
                            reason: manifest.status === "missing"
                                ? "missing_symbol_registry"
                                : "incompatible_symbol_registry",
                            path: leasedRootState.root.path,
                            message: "Symbol registry is " + manifest.status + ": " + manifest.reason,
                        }),
                    }],
                };
            }

            const resolvedSymbolFile = resolveBoundaryFileToRepoRelative(
                rawSymbolRef.file,
                leasedRootState.root.path,
                "symbolRef.file",
            );
            if (!resolvedSymbolFile.ok) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "error",
                            reason: "invalid_request",
                            path: leasedRootState.root.path,
                            message: resolvedSymbolFile.message,
                        }),
                    }],
                    isError: true,
                };
            }
            const normalizedSymbolFile = this.host.normalizeRelativeFilePath(resolvedSymbolFile.relativePath);
            const resolvedInputSymbolRef: CallGraphSymbolRef = {
                file: normalizedSymbolFile,
                ...(rawSymbolId ? { symbolId: rawSymbolId } : {}),
                ...(rawSymbolLabel ? { symbolLabel: rawSymbolLabel } : {}),
                ...(rawSymbolRef.span ? { span: rawSymbolRef.span } : {}),
            };
            const canonicalRequestedRoot = canonicalizeBoundaryRoot(requestedRoot);
            const canonicalIndexedRoot = canonicalizeBoundaryRoot(leasedRootState.root.path);
            const requestedSubdirectory = isBoundaryPathInsideRoot(canonicalRequestedRoot, canonicalIndexedRoot)
                ? resolveRequestedSearchSubdirectory({
                    indexedRoot: canonicalIndexedRoot,
                    requestedPath: canonicalRequestedRoot,
                })
                : null;
            if (!candidateWithinRequestedSubdirectory(normalizedSymbolFile, requestedSubdirectory)) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_found",
                            reason: "symbol_outside_scope",
                            path: leasedRootState.root.path,
                            symbolRef: resolvedInputSymbolRef,
                            message: `Symbol '${normalizedSymbolFile}' is outside the requested find_references path scope '${requestedRoot}'.`,
                        }),
                    }],
                };
            }
            const symbolsInFile = manifest.registry.symbolsByFile.get(normalizedSymbolFile) ?? [];
            const symbolResolution = resolveSymbolRefInFile({
                symbols: symbolsInFile,
                symbolId: rawSymbolId || undefined,
                symbolLabel: rawSymbolLabel || undefined,
                file: normalizedSymbolFile,
            });
            if (symbolResolution.status === "missing") {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_found",
                            reason: "missing_symbol",
                            path: leasedRootState.root.path,
                            symbolRef: resolvedInputSymbolRef,
                            message: "No exact canonical symbol matched symbolRef.",
                        }),
                    }],
                };
            }
            if (symbolResolution.status === "ambiguous") {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_found",
                            reason: "ambiguous_symbol",
                            path: leasedRootState.root.path,
                            symbolRef: resolvedInputSymbolRef,
                            candidates: symbolResolution.candidates,
                            totalCandidateCount: symbolResolution.totalCandidateCount,
                            message: rawSymbolLabel
                                ? `Ambiguous symbolLabel '${rawSymbolLabel}' in '${normalizedSymbolFile}' matched ${symbolResolution.totalCandidateCount} symbols. Re-run with one of the candidate symbolId values.`
                                : `Ambiguous symbolId '${rawSymbolId}' in '${normalizedSymbolFile}' matched ${symbolResolution.totalCandidateCount} symbols. Re-run with one of the candidate symbolId values.`,
                        }),
                    }],
                };
            }

            const resolvedSymbol = symbolResolution.symbol;
            const canonicalSymbolRef: CallGraphSymbolRef = {
                file: normalizedSymbolFile,
                symbolId: resolvedSymbol.symbolInstanceId,
                ...(resolvedSymbol.label
                    ? { symbolLabel: resolvedSymbol.label }
                    : rawSymbolLabel
                        ? { symbolLabel: rawSymbolLabel }
                        : {}),
                ...(resolvedInputSymbolRef.span ? { span: resolvedInputSymbolRef.span } : {}),
            };

            const cursorIdentity: FindReferencesCursorIdentity = {
                publicationId: lease.id,
                symbolId: resolvedSymbol.symbolInstanceId,
                scopeIdentity: findReferencesScopeIdentity(scope),
            };
            let offset = 0;
            if (typeof args.cursor === "string") {
                try {
                    offset = parseFindReferencesCursor(args.cursor, cursorIdentity);
                } catch (error) {
                    if (!(error instanceof InvalidFindReferencesContinuationError)) throw error;
                    return {
                        content: [{
                            type: "text",
                            text: this.host.stringifyToolJson({
                                status: "not_found",
                                reason: "invalid_continuation",
                                path: leasedRootState.root.path,
                                symbolRef: canonicalSymbolRef,
                                message: error.message,
                            }),
                        }],
                        isError: true,
                    };
                }
            }

            const publishedRelativePaths = new Set(
                manifest.registry.manifest.files.map((file) => file.path),
            );
            // The matcher only matches the literal identifier, so bytes without
            // it cannot contribute an occurrence. Searching the raw bytes keeps
            // the UTF-8 decode off the path for every non-matching file.
            const targetIdentifier = resolvedSymbol.name.trim();
            const identifierBytes = targetIdentifier.length > 0
                ? Buffer.from(targetIdentifier, "utf8")
                : null;
            const readPublishedSource = async (relativeFilePath: string): Promise<ExactReferenceSourceRead> => {
                signal?.throwIfAborted();
                try {
                    const sourceRead = await readAuthorizedPublishedSource({
                        workspacePolicy,
                        codebaseRoot: leasedRootState.root.path,
                        requestedPath: path.resolve(leasedRootState.root.path, relativeFilePath),
                        publishedRelativePaths,
                        maxBytes: this.host.readFileMaxBytes,
                    });
                    signal?.throwIfAborted();
                    const sourceSha256 = this.sourceDigestFor(
                        leasedRootState.root.path,
                        relativeFilePath,
                        sourceRead,
                    );
                    if (identifierBytes && sourceRead.bytes.indexOf(identifierBytes) === -1) {
                        // An empty text still carries the digest, so the caller
                        // validates the Publication hash and counts the file as
                        // inspected exactly as it does for a scanned file.
                        return { status: "ok", text: "", sourceSha256 };
                    }
                    return {
                        status: "ok",
                        text: sourceRead.bytes.toString("utf8"),
                        sourceSha256,
                    };
                } catch (error) {
                    if (error instanceof AuthorizedSourceReadError) {
                        return {
                            status: "skipped",
                            code: error.code === "FILE_TOO_LARGE"
                                ? "source_too_large"
                                : "source_replaced",
                            detail: error.message,
                        };
                    }
                    if (
                        error instanceof PublishedFileAuthorizationError
                        || error instanceof WorkspaceAuthorizationError
                    ) {
                        return {
                            status: "skipped",
                            code: "source_unreadable",
                            detail: error.code,
                        };
                    }
                    throw error;
                }
            };

            const result = await findExactPublishedSourceReferences({
                registry: manifest.registry,
                target: resolvedSymbol,
                scope,
                limit,
                offset,
                readPublishedSource,
                signal,
            });
            const { nextOffset, ...page } = result;
            const nextCursor = nextOffset === undefined
                ? undefined
                : serializeFindReferencesCursor(cursorIdentity, nextOffset);
            await this.host.touchWatchedCodebase(leasedRootState.root.path);
            signal?.throwIfAborted();
            const freshnessDecision = leasedRootState.freshnessDecision;
            const warnings = freshnessDecision
                ? buildFreshnessWarningCodes(freshnessDecision)
                : [];
            return {
                content: [{
                    type: "text",
                    text: this.host.stringifyToolJson({
                        status: "ok",
                        path: leasedRootState.root.path,
                        publicationId: lease.id,
                        rankingIndependent: true,
                        scope: {
                            subtree: typeof args.subtree === "string" ? args.subtree : null,
                            includePaths: Array.isArray(args.includePaths) ? args.includePaths : [],
                            excludePaths: Array.isArray(args.excludePaths) ? args.excludePaths : [],
                        },
                        ...page,
                        ...(nextCursor ? {
                            nextCursor,
                            hints: {
                                nextPage: {
                                    tool: "find_references",
                                    args: {
                                        path: requestedRoot,
                                        symbolRef: canonicalSymbolRef,
                                        ...scope,
                                        limit,
                                        cursor: nextCursor,
                                    },
                                },
                            },
                        } : {}),
                        ...(freshnessDecision ? { freshnessDecision } : {}),
                        ...(warnings.length > 0 ? { warnings } : {}),
                    }),
                }],
            };
        });

        return outcome.status === "stale"
            ? {
                content: [{
                    type: "text",
                    text: this.host.stringifyToolJson({
                        status: "not_ready",
                        reason: "source_state_unverified",
                        path: requestedRoot,
                        message: "Publication authority changed while exact references were being inspected; retry the request.",
                    }),
                }],
            }
            : outcome.result;
    }

    public async handleFileOutline(
        args: FileOutlineInput,
        workspacePolicy: SessionWorkspacePolicy,
        sourceOptions?: NavigationSourceOptions,
    ): Promise<ToolTextResponse> {
        const signal = sourceOptions?.signal;
        signal?.throwIfAborted();
        const limitSymbols = Number.isFinite(args?.limitSymbols)
            ? Math.max(1, Number(args.limitSymbols))
            : 500;
        const requestedStartLine = Number.isFinite(args?.start_line) ? Math.max(1, Number(args.start_line)) : undefined;
        const requestedEndLine = Number.isFinite(args?.end_line) ? Math.max(1, Number(args.end_line)) : undefined;
        const resolveMode = args?.resolveMode === "exact" ? "exact" : "outline";
        const symbolIdExact = typeof args?.symbolIdExact === "string" ? args.symbolIdExact.trim() : undefined;
        const symbolLabelExact = typeof args?.symbolLabelExact === "string" ? args.symbolLabelExact.trim() : undefined;
        const detail = args?.detail === "analysis"
            || args?.detail === "relationships"
            || args?.detail === "relationship_coverage"
            ? args.detail
            : "summary";

        let effectiveRoot = "";
        try {
            const absoluteRootResult = requireAbsoluteFilesystemPath(args.path, "path");
            if (!absoluteRootResult.ok) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
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
            const fileValidation = validateBoundaryFileInput(args.file, "file");
            if (!fileValidation.ok) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    fileValidation.path,
                    fileValidation.message,
                    "not_found",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }
            let normalizedFile: string;
            if (fileValidation.isAbsolute) {
                const preliminaryRelative = resolveBoundaryFileToRepoRelative(
                    fileValidation.rawPath,
                    absoluteRoot,
                    "file",
                );
                if (!preliminaryRelative.ok) {
                    const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
                        absoluteRoot,
                        fileValidation.rawPath,
                        preliminaryRelative.message,
                        "not_found",
                        "invalid_request",
                    );
                    return {
                        content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                        isError: true,
                    };
                }
                normalizedFile = this.host.normalizeRelativeFilePath(preliminaryRelative.relativePath);
            } else {
                normalizedFile = this.host.normalizeRelativeFilePath(fileValidation.relativePath);
            }
            if (
                (detail === "analysis" || detail === "relationships")
                && (resolveMode !== "exact" || !symbolIdExact)
            ) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    normalizedFile,
                    `detail="${detail}" requires resolveMode="exact" and symbolIdExact.`,
                    "not_ready",
                    "invalid_request",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            if (
                requestedStartLine !== undefined
                && requestedEndLine !== undefined
                && requestedStartLine > requestedEndLine
            ) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
                    absoluteRoot,
                    normalizedFile,
                    `start_line (${requestedStartLine}) must not exceed end_line (${requestedEndLine}).`,
                    "not_ready",
                    "invalid_request",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            if (!fs.existsSync(absoluteRoot)) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
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
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
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

            const session = new PreparedPublicationReadSession<TrackedRootReadinessState, PublicationLease | null>({
                prepareReadiness: () => this.host.prepareNavigationRead(absoluteRoot),
                acquirePublicationLease: (prepared) => (
                    prepared.state === 'ready'
                        ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                        : null
                ),
                isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
            });
            const outcome = await session.read(async (trackedRootState, lease): Promise<ToolTextResponse> => {
            signal?.throwIfAborted();
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
                const payload = this.host.toolResponseBuilders.buildNotIndexedFileOutlinePayload(normalizedFile, absoluteRoot);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "indexing") {
                const payload = this.host.toolResponseBuilders.buildNotReadyFileOutlinePayload(trackedRootState.codebasePath, normalizedFile, absoluteRoot);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "stale_local") {
                const payload = this.host.toolResponseBuilders.buildNotIndexedFileOutlinePayload(normalizedFile, absoluteRoot, {
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

            if (lease === null) {
                throw new Error("Ready navigation readiness must hold a Publication lease.");
            }
            const leasedRootState: Extract<TrackedRootReadinessState, { state: 'ready' }> = {
                ...trackedRootState,
                publication: lease,
                navigationStatus: await this.host.getPublicationNavigationStatus(lease),
            };
            const matchedRoot = leasedRootState.root;
            effectiveRoot = matchedRoot.path;
            const effectiveFileResult = resolveBoundaryFileToRepoRelative(
                args.file,
                effectiveRoot,
                "file",
            );
            if (!effectiveFileResult.ok) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
                    effectiveRoot,
                    normalizedFile,
                    effectiveFileResult.message,
                    "not_found",
                    "invalid_request",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }
            normalizedFile = this.host.normalizeRelativeFilePath(effectiveFileResult.relativePath);
            const canonicalRequestedOutlineRoot = canonicalizeBoundaryRoot(absoluteRoot);
            const canonicalEffectiveOutlineRoot = canonicalizeBoundaryRoot(effectiveRoot);
            const requestedSubdirectory = isBoundaryPathInsideRoot(canonicalRequestedOutlineRoot, canonicalEffectiveOutlineRoot)
                ? resolveRequestedSearchSubdirectory({
                    indexedRoot: canonicalEffectiveOutlineRoot,
                    requestedPath: canonicalRequestedOutlineRoot,
                })
                : null;
            if (!candidateWithinRequestedSubdirectory(normalizedFile, requestedSubdirectory)) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
                    effectiveRoot,
                    normalizedFile,
                    `File '${normalizedFile}' is outside the requested file_outline path scope '${absoluteRoot}'.`,
                    "not_found",
                    "invalid_request",
                );
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }
            const absoluteFile = path.resolve(effectiveRoot, normalizedFile);

            const proofDebugHint = leasedRootState.proofDebugHint;

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

            const windowStart = requestedStartLine;
            const windowEnd = requestedEndLine && requestedStartLine
                ? Math.max(requestedEndLine, requestedStartLine)
                : requestedEndLine;

            const registryState = await this.host.loadPreparedNavigationSymbolsByFile(
                leasedRootState,
                normalizedFile,
            );
            signal?.throwIfAborted();
            if (registryState.status !== "ok") {
                // No navigation publication authority exists for this root.
                // Fail closed through the session workspace policy before any
                // existence probe or content read: a workspace denial is
                // surfaced deterministically, and in-workspace files keep the
                // existing missing-file / missing-registry contract.
                try {
                    workspacePolicy.authorizePath(absoluteFile);
                } catch (error) {
                    return this.mapNavigationAuthorizationDenial({
                        error,
                        effectiveRoot,
                        normalizedFile,
                        args,
                        proofDebugHint,
                        fallbackStatus: "not_found",
                        fallbackMessage: `File '${normalizedFile}' is not readable under codebase root '${effectiveRoot}'.`,
                    });
                }
                if (!fs.existsSync(absoluteFile) || !fs.statSync(absoluteFile).isFile()) {
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
            } else {
                const publishedRelativePaths = new Set(
                    registryState.registry.manifest.files.map((file) => file.path),
                );
                let sourceBytes: Buffer;
                try {
                    const sourceRead = await readAuthorizedPublishedSource({
                        workspacePolicy,
                        codebaseRoot: effectiveRoot,
                        requestedPath: absoluteFile,
                        publishedRelativePaths,
                        maxBytes: this.host.readFileMaxBytes,
                    });
                    sourceBytes = sourceRead.bytes;
                } catch (error) {
                    return this.mapNavigationAuthorizationDenial({
                        error,
                        effectiveRoot,
                        normalizedFile,
                        args,
                        proofDebugHint,
                        fallbackStatus: "not_found",
                        fallbackMessage: `File '${normalizedFile}' is not readable under codebase root '${effectiveRoot}'.`,
                    });
                }
                signal?.throwIfAborted();
                return await this.buildFileOutlineFromAuthorizedFile({
                    args,
                    effectiveRoot,
                    normalizedFile,
                    absoluteFile,
                    sourceBytes,
                    registryState,
                    trackedRootState: leasedRootState,
                    proofDebugHint,
                    limitSymbols,
                    resolveMode,
                    symbolIdExact,
                    symbolLabelExact,
                    windowStart,
                    windowEnd,
                    detail,
                    lease,
                    workspacePolicy,
                    publishedRelativePaths,
                    sourceOptions,
                });
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

            let outlineSupported = this.host.getOutlineStatusForLanguage(normalizedFile) === "ok";
            if (pathDeterminedLanguageId(normalizedFile) === undefined) {
                const probe = readBoundedLanguageProbe(absoluteFile);
                if (probe !== undefined) {
                    const detectedLanguage = detectLanguageId(normalizedFile, probe, "");
                    outlineSupported = detectedLanguage !== ""
                        && isLanguageCapabilitySupportedForLanguage(detectedLanguage, "fileOutline");
                }
            }
            if (!outlineSupported) {
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
            });
            signal?.throwIfAborted();
            return outcome.status === 'stale'
                ? {
                    content: [{ type: "text" as const, text: this.host.stringifyToolJson(
                        buildSourceStateUnverifiedFileOutlinePayload(this.host, effectiveRoot, normalizedFile),
                    ) }],
                }
                : outcome.result;
        } catch (error: unknown) {
            signal?.throwIfAborted();
            const pathResult = typeof args?.path === "string"
                ? requireAbsoluteFilesystemPath(args.path)
                : null;
            const pathForError = pathResult?.ok ? pathResult.absolutePath : (typeof args?.path === "string" ? args.path : "");
            const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
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

    public async handleCallGraph(
        args: ToolArgs,
        workspacePolicy: SessionWorkspacePolicy,
        signal?: AbortSignal,
        sourceOptions?: NavigationSourceOptions,
    ): Promise<ToolTextResponse> {
        const result = await this.executeCallGraph(args, workspacePolicy, signal, sourceOptions, true);
        return {
            content: [{ type: "text", text: this.host.stringifyToolJson(result.payload) }],
            ...(result.isError ? { isError: true } : {}),
        };
    }

    public async resolveUnprojectedCallGraph(
        args: ToolArgs,
        workspacePolicy: SessionWorkspacePolicy,
        signal?: AbortSignal,
        sourceOptions?: NavigationSourceOptions,
    ): Promise<CallGraphResponseEnvelope> {
        const result = await this.executeCallGraph(args, workspacePolicy, signal, sourceOptions, false);
        return result.payload;
    }

    private async executeCallGraph(
        args: ToolArgs,
        workspacePolicy: SessionWorkspacePolicy,
        signal: AbortSignal | undefined,
        sourceOptions: NavigationSourceOptions | undefined,
        projectEvidence: boolean,
    ): Promise<{ payload: CallGraphResponseEnvelope; isError?: boolean }> {
        signal?.throwIfAborted();
        const rawDirection = args?.direction;
        const direction: CallGraphDirection = rawDirection === "callers" || rawDirection === "callees" || rawDirection === "both"
            ? rawDirection
            : "both";
        const depth = Number.isFinite(args?.depth) ? Math.max(1, Math.min(3, Number(args.depth))) : 1;
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Number(args.limit)) : 20;
        const evidenceInput = args?.evidence as {
            kind?: CallGraphEvidenceRequest["kind"];
            cursor?: string;
            limit?: number;
        } | undefined;
        const evidenceRequest: CallGraphEvidenceRequest | undefined = evidenceInput?.kind
            ? {
                kind: evidenceInput.kind,
                limit: Number.isFinite(evidenceInput.limit)
                    ? Math.max(1, Math.min(50, Number(evidenceInput.limit)))
                    : 10,
                ...(typeof evidenceInput.cursor === "string"
                    ? { cursor: evidenceInput.cursor }
                    : {}),
            }
            : undefined;
        const symbolRef = args?.symbolRef as CallGraphSymbolRef | undefined;
        const symbolFileValidation = validateBoundaryFileInput(symbolRef?.file, "symbolRef.file");
        const rawSymbolId = typeof symbolRef?.symbolId === "string" ? symbolRef.symbolId.trim() : "";
        const rawSymbolLabel = typeof symbolRef?.symbolLabel === "string" ? symbolRef.symbolLabel.trim() : "";
        const absolutePathResult = typeof args?.path === "string"
            ? requireAbsoluteFilesystemPath(args.path, "path")
            : { ok: false as const, path: "", message: "path is required." };
        const preliminarySymbolFile = (!symbolFileValidation.ok)
            ? (typeof symbolRef?.file === "string" ? this.host.normalizeRelativeFilePath(symbolRef.file) : "")
            : !symbolFileValidation.isAbsolute
                ? this.host.normalizeRelativeFilePath(symbolFileValidation.relativePath)
                : absolutePathResult.ok
                    ? (() => {
                        const rel = resolveBoundaryFileToRepoRelative(
                            symbolFileValidation.rawPath,
                            absolutePathResult.absolutePath,
                            "symbolRef.file",
                        );
                        return rel.ok ? this.host.normalizeRelativeFilePath(rel.relativePath) : symbolFileValidation.rawPath;
                    })()
                    : symbolFileValidation.rawPath;
        const normalizedSymbolRef: CallGraphSymbolRef = {
            file: preliminarySymbolFile,
            ...(rawSymbolId ? { symbolId: rawSymbolId } : {}),
            ...(rawSymbolLabel ? { symbolLabel: rawSymbolLabel } : {}),
            ...(symbolRef?.span ? { span: symbolRef.span } : {}),
        };
        const invalidSymbolRefContext = {
            path: absolutePathResult.ok ? absolutePathResult.absolutePath : (typeof args?.path === "string" ? args.path : ""),
            symbolRef: normalizedSymbolRef,
            direction,
            depth,
            limit,
        };

        if (!absolutePathResult.ok) {
            const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
                invalidSymbolRefContext,
                absolutePathResult.message,
                "not_indexed",
                "not_indexed",
            );
            return { payload, isError: true };
        }

        if (!symbolFileValidation.ok) {
            const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
                invalidSymbolRefContext,
                symbolFileValidation.message,
                "not_found",
                "invalid_symbol_ref",
            );
            return { payload, isError: true };
        }

        if (symbolFileValidation.isAbsolute) {
            const preliminaryBoundaryCheck = resolveBoundaryFileToRepoRelative(
                symbolFileValidation.rawPath,
                absolutePathResult.absolutePath,
                "symbolRef.file",
            );
            if (!preliminaryBoundaryCheck.ok) {
                const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
                    invalidSymbolRefContext,
                    preliminaryBoundaryCheck.message,
                    "not_found",
                    "invalid_symbol_ref",
                );
                return { payload, isError: true };
            }
        }

        if (!symbolRef || typeof symbolRef.file !== "string" || (!rawSymbolId && !rawSymbolLabel)) {
            const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
                invalidSymbolRefContext,
                "symbolRef with { file, symbolId } or { file, symbolLabel } is required.",
                "not_found",
                "invalid_symbol_ref",
            );
            return { payload, isError: true };
        }

        let effectiveRoot = "";
        try {
            const absolutePath = absolutePathResult.absolutePath;
            if (!fs.existsSync(absolutePath)) {
                const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
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
                return { payload, isError: true };
            }

            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
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
                return { payload, isError: true };
            }

            trackCodebasePath(absolutePath);

            const session = new PreparedPublicationReadSession<TrackedRootReadinessState, PublicationLease | null>({
                prepareReadiness: () => this.host.prepareNavigationRead(absolutePath),
                acquirePublicationLease: (prepared) => (
                    prepared.state === 'ready'
                        ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                        : null
                ),
                isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
            });
            const outcome = await session.read(async (trackedRootState, lease): Promise<{ payload: CallGraphResponseEnvelope; isError?: boolean }> => {
            if (trackedRootState.state === "requires_reindex") {
                const payload = this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
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
                return { payload };
            }

            if (trackedRootState.state === "indexing") {
                const payload = this.host.toolResponseBuilders.buildNotReadyCallGraphPayload(trackedRootState.codebasePath, {
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit,
                });
                return { payload };
            }

            if (trackedRootState.state === "index_failed") {
                const payload = this.host.trackedRootReadiness.buildIndexFailedCallGraphPayload(trackedRootState.codebasePath, {
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit,
                }, trackedRootState.info);
                return { payload };
            }

            if (trackedRootState.state === "not_indexed") {
                const payload = this.host.toolResponseBuilders.buildNotIndexedCallGraphPayload({
                    path: absolutePath,
                    symbolRef,
                    direction,
                    depth,
                    limit,
                });
                return { payload };
            }

            if (trackedRootState.state === "stale_local") {
                const payload = this.host.toolResponseBuilders.buildNotIndexedCallGraphPayload(
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
                return { payload };
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
                return { payload };
            }

            if (lease === null) {
                throw new Error("Ready navigation readiness must hold a Publication lease.");
            }
            const leasedRootState: Extract<TrackedRootReadinessState, { state: 'ready' }> = {
                ...trackedRootState,
                publication: lease,
                navigationStatus: await this.host.getPublicationNavigationStatus(lease),
            };
            const searchableRoot = leasedRootState.root;
            effectiveRoot = searchableRoot.path;
            const proofDebugHint = leasedRootState.proofDebugHint;
            const requestedSubdirectory = resolveRequestedSearchSubdirectory({
                indexedRoot: effectiveRoot,
                requestedPath: absolutePath,
            });
            const callGraphPathScope: PublishedPathScope | undefined = requestedSubdirectory
                ? { subtree: requestedSubdirectory.relativePrefix }
                : undefined;

            if (this.host.isPartialIndexNavigationUnavailable(searchableRoot.info)) {
                const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
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
                return { payload };
            }

            const resolvedSymbolFile = resolveBoundaryFileToRepoRelative(
                symbolRef.file,
                effectiveRoot,
                "symbolRef.file",
            );
            if (!resolvedSymbolFile.ok) {
                const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
                    {
                        path: absolutePath,
                        symbolRef: normalizedSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    resolvedSymbolFile.message,
                    "not_found",
                    "invalid_symbol_ref",
                );
                return { payload, isError: true };
            }
            const normalizedSymbolFile = this.host.normalizeRelativeFilePath(resolvedSymbolFile.relativePath);
            const resolvedInputSymbolRef: CallGraphSymbolRef = {
                file: normalizedSymbolFile,
                ...(rawSymbolId ? { symbolId: rawSymbolId } : {}),
                ...(rawSymbolLabel ? { symbolLabel: rawSymbolLabel } : {}),
                ...(symbolRef.span ? { span: symbolRef.span } : {}),
            };
            if (!candidateWithinRequestedSubdirectory(normalizedSymbolFile, requestedSubdirectory)) {
                const payload = withNavigationFreshness(this.host.withProofDebugHint({
                    status: "not_found" as const,
                    path: absolutePath,
                    codebaseRoot: effectiveRoot,
                    symbolRef: resolvedInputSymbolRef,
                    supported: false,
                    reason: "symbol_outside_scope",
                    message: `Symbol '${normalizedSymbolFile}' is outside the requested call_graph path scope '${absolutePath}'.`,
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint), leasedRootState.freshnessDecision);
                return { payload };
            }
            const registryState = await this.host.loadPreparedNavigationSymbolsByFile(
                leasedRootState,
                normalizedSymbolFile,
            );
            if (registryState.status !== "ok") {
                const reason = registryState.status === "missing"
                    ? "missing_symbol_registry"
                    : "incompatible_symbol_registry";
                const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    `Symbol registry is ${registryState.status}: ${registryState.reason}`,
                    {
                        path: absolutePath,
                        symbolRef: resolvedInputSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    reason,
                ), proofDebugHint);
                return { payload };
            }

            const symbolResolution = resolveSymbolRefInFile({
                symbols: registryState.symbols,
                symbolId: rawSymbolId || undefined,
                symbolLabel: rawSymbolLabel || undefined,
                file: normalizedSymbolFile,
            });
            if (symbolResolution.status === "missing") {
                const payload = withNavigationFreshness(this.host.withProofDebugHint({
                    status: "not_found" as const,
                    path: effectiveRoot,
                    symbolRef: resolvedInputSymbolRef,
                    supported: false,
                    reason: "missing_symbol",
                    message: "No exact symbol match found in relationship-backed navigation state.",
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint), leasedRootState.freshnessDecision);
                return { payload };
            }

            if (symbolResolution.status === "ambiguous") {
                const payload = withNavigationFreshness(this.host.withProofDebugHint({
                    status: "not_found" as const,
                    path: effectiveRoot,
                    symbolRef: resolvedInputSymbolRef,
                    supported: false,
                    reason: "ambiguous_symbol",
                    candidates: symbolResolution.candidates,
                    totalCandidateCount: symbolResolution.totalCandidateCount,
                    message: rawSymbolLabel
                        ? `Ambiguous symbolLabel '${rawSymbolLabel}' in '${normalizedSymbolFile}' matched ${symbolResolution.totalCandidateCount} symbols. Re-run with one of the candidate symbolId values.`
                        : `Ambiguous symbolId '${rawSymbolId}' in '${normalizedSymbolFile}' matched ${symbolResolution.totalCandidateCount} symbols. Re-run with one of the candidate symbolId values.`,
                    nodes: [],
                    edges: [],
                    notes: [],
                    notesTruncated: false,
                    totalNoteCount: 0,
                    returnedNoteCount: 0,
                } satisfies CallGraphResponseEnvelope, proofDebugHint), leasedRootState.freshnessDecision);
                return { payload };
            }

            const exactSeedSymbol = symbolResolution.symbol;
            const canonicalSymbolRef: CallGraphSymbolRef = {
                file: normalizedSymbolFile,
                symbolId: exactSeedSymbol.symbolInstanceId,
                ...(exactSeedSymbol.label
                    ? { symbolLabel: exactSeedSymbol.label }
                    : rawSymbolLabel
                        ? { symbolLabel: rawSymbolLabel }
                        : {}),
                ...(resolvedInputSymbolRef.span ? { span: resolvedInputSymbolRef.span } : {}),
            };

            const publishedRelativePaths = new Set(
                registryState.registry.manifest.files.map((file) => file.path),
            );
            const readAuthorizedSourceLines = async (
                codebaseRoot: string,
                relativeFilePath: string,
            ): Promise<string[] | undefined> => {
                if (!candidateWithinRequestedSubdirectory(relativeFilePath, requestedSubdirectory)) {
                    return undefined;
                }
                try {
                    const sourceRead = await readAuthorizedPublishedSource({
                        workspacePolicy,
                        codebaseRoot,
                        requestedPath: path.resolve(codebaseRoot, relativeFilePath),
                        publishedRelativePaths,
                        maxBytes: this.host.readFileMaxBytes,
                    });
                    const bytes = relativeFilePath === normalizedSymbolFile && sourceOptions?.publishedSource !== undefined
                        ? sourceOptions.publishedSource : sourceRead.bytes;
                    const freshness = this.host.getRegistryFileFreshness({
                        symbols: registryState.registry.symbolsByFile.get(relativeFilePath) ?? [],
                        absoluteFile: path.resolve(codebaseRoot, relativeFilePath),
                        sourceBytes: bytes,
                    });
                    return freshness.status === "fresh" ? bytes.toString("utf8").split(/\r?\n/) : undefined;
                } catch (error) {
                    if (error instanceof PublishedFileAuthorizationError
                        || error instanceof WorkspaceAuthorizationError
                        || error instanceof AuthorizedSourceReadError) {
                        return undefined;
                    }
                    throw error;
                }
            };
            const readExactPublishedSource = async (
                relativeFilePath: string,
            ): Promise<ExactReferenceSourceRead> => {
                try {
                    const sourceRead = await readAuthorizedPublishedSource({
                        workspacePolicy,
                        codebaseRoot: effectiveRoot,
                        requestedPath: path.resolve(effectiveRoot, relativeFilePath),
                        publishedRelativePaths,
                        maxBytes: this.host.readFileMaxBytes,
                    });
                    return {
                        status: "ok",
                        text: sourceRead.bytes.toString("utf8"),
                        sourceSha256: crypto.createHash("sha256").update(sourceRead.bytes).digest("hex"),
                    };
                } catch (error) {
                    if (error instanceof AuthorizedSourceReadError) {
                        return {
                            status: "skipped",
                            code: error.code === "FILE_TOO_LARGE"
                                ? "source_too_large"
                                : "source_replaced",
                            detail: error.message,
                        };
                    }
                    if (
                        error instanceof PublishedFileAuthorizationError
                        || error instanceof WorkspaceAuthorizationError
                    ) {
                        return {
                            status: "skipped",
                            code: "source_unreadable",
                            detail: error instanceof Error ? error.message : String(error),
                        };
                    }
                    throw error;
                }
            };
            const findExactSourceReferences = (target: SymbolRecord) => (
                findExactPublishedSourceReferences({
                    registry: registryState.registry,
                    target,
                    ...(callGraphPathScope ? { scope: callGraphPathScope } : {}),
                    limit: Number.MAX_SAFE_INTEGER,
                    readPublishedSource: readExactPublishedSource,
                    signal,
                })
            );

            const absoluteSymbolFile = path.resolve(effectiveRoot, normalizedSymbolFile);
            let symbolSourceBytes: Buffer | undefined;
            try {
                const sourceRead = await readAuthorizedPublishedSource({
                    workspacePolicy,
                    codebaseRoot: effectiveRoot,
                    requestedPath: absoluteSymbolFile,
                    publishedRelativePaths,
                    maxBytes: this.host.readFileMaxBytes,
                });
                symbolSourceBytes = sourceRead.bytes;
            } catch (error) {
                if (!(error instanceof PublishedFileAuthorizationError)
                    && !(error instanceof WorkspaceAuthorizationError)
                    && !(error instanceof AuthorizedSourceReadError)) {
                    throw error;
                }
            }

            let seedSourceState: "fresh" | "stale" | "unknown" | "inconsistent";
            if (symbolSourceBytes === undefined) {
                const payload = this.host.withProofDebugHint(this.host.buildStaleSymbolRefCallGraphPayload({
                    codebaseRoot: effectiveRoot,
                    context: {
                        path: absolutePath,
                        symbolRef: canonicalSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    message: `Symbol reference points at '${normalizedSymbolFile}', but the current file is unavailable or not authorized. Refresh the index before using exact call graph navigation.`,
                }), proofDebugHint);
                return { payload };
            } else {
                const fileFreshness = this.host.getRegistryFileFreshness({
                    symbols: [exactSeedSymbol],
                    absoluteFile: absoluteSymbolFile,
                    sourceBytes: symbolSourceBytes,
                });
                seedSourceState = fileFreshness.status;
                if (fileFreshness.status === "inconsistent") {
                    const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
                        effectiveRoot,
                        `Symbol registry contains inconsistent file hashes for '${normalizedSymbolFile}'.`,
                        {
                            path: absolutePath,
                            symbolRef: canonicalSymbolRef,
                            direction,
                            depth,
                            limit,
                        },
                        "incompatible_symbol_registry",
                    ), proofDebugHint);
                    return { payload };
                }
                const witnessFreshness = sourceOptions?.publishedSource !== undefined
                    ? this.host.getRegistryFileFreshness({
                        symbols: [exactSeedSymbol],
                        absoluteFile: absoluteSymbolFile,
                        sourceBytes: sourceOptions.publishedSource,
                    }).status : undefined;
                if ((witnessFreshness !== undefined && witnessFreshness !== "fresh")
                    || (sourceOptions?.requireCurrentSource && fileFreshness.status === "stale" && witnessFreshness !== "fresh")) {
                    const payload = this.host.withProofDebugHint(this.host.buildStaleSymbolRefCallGraphPayload({
                        codebaseRoot: effectiveRoot,
                        context: {
                            path: absolutePath,
                            symbolRef: canonicalSymbolRef,
                            direction,
                            depth,
                            limit,
                        },
                        message: `Symbol reference for '${normalizedSymbolFile}' is stale relative to the current file contents. Refresh the index before using exact call graph navigation.`,
                    }), proofDebugHint);
                    return { payload };
                }
            }

            // Repair only hash-matched bytes. Dirty bytes cannot change published identity or spans.
            const resolvedSymbolRepair = seedSourceState === "fresh" ? repairSourceBackedPythonSpan({
                codebaseRoot: effectiveRoot, symbol: exactSeedSymbol,
                sourceLines: symbolSourceBytes!.toString("utf8").split(/\r?\n/),
            }) : undefined;
            const resolvedSymbol = resolvedSymbolRepair?.symbol ?? exactSeedSymbol;

            if (!this.host.isCallGraphLanguageSupported(resolvedSymbol.language, resolvedSymbol.file)) {
                const payload = this.host.withProofDebugHint({
                    status: "unsupported" as const,
                    path: effectiveRoot,
                    symbolRef: canonicalSymbolRef,
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
                return { payload };
            }

            const compatibility = await this.host.loadPreparedNavigationCompatibility(
                leasedRootState,
                registryState.manifestHash,
            );
            if (compatibility.relationships.status !== "ok") {
                const reason = compatibility.relationships.status === "missing"
                    ? "missing_relationship_navigation"
                    : "incompatible_relationship_navigation";
                const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    `Relationship navigation is ${compatibility.relationships.status}: ${compatibility.relationships.reason}`,
                    {
                        path: absolutePath,
                        symbolRef: canonicalSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                    reason,
                ), proofDebugHint);
                return { payload };
            }

            const servingNavigation = this.host.getPublicationNavigationAddress(lease);
            if (!servingNavigation) {
                const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    "Publication navigation identity is unavailable for call-graph traversal.",
                    {
                        path: absolutePath,
                        symbolRef: canonicalSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                ), proofDebugHint);
                return { payload };
            }

            const relationshipBackedGraph = await this.host.buildRelationshipBackedCallGraph({
                codebaseRoot: effectiveRoot,
                publicationId: servingNavigation.publicationId,
                navigationRoot: servingNavigation.navigationRoot,
                registry: registryState.registry,
                registryManifestHash: registryState.manifestHash,
                resolvedSymbol,
                sourceSpanRepair: resolvedSymbolRepair,
                direction,
                depth,
                limit,
                // Internal unprojected callers (detect_changes) inspect full blast radius;
                // public call_graph caps excess test callers to keep responses compact.
                ...(!projectEvidence ? { maxTestCallers: null } : {}),
                ...(callGraphPathScope ? { pathScope: callGraphPathScope } : {}),
                readAuthorizedSourceLines,
                findExactSourceReferences,
            });
            if (!relationshipBackedGraph) {
                const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    "Relationship-backed call graph traversal could not load a compatible navigation snapshot.",
                    {
                        path: absolutePath,
                        symbolRef: canonicalSymbolRef,
                        direction,
                        depth,
                        limit,
                    },
                ), proofDebugHint);
                return { payload };
            }

            const fileFreshnessByPath = new Map<string, NonNullable<CallGraphResponseEnvelope["nodes"][number]["freshness"]>>();
            for (const node of relationshipBackedGraph.nodes) {
                let freshness = fileFreshnessByPath.get(node.file);
                if (!freshness) {
                    let sourceState: "fresh" | "stale" | "unknown" | "inconsistent" = "unknown";
                    try {
                        const sourceRead = await readAuthorizedPublishedSource({
                            workspacePolicy, codebaseRoot: effectiveRoot,
                            requestedPath: path.resolve(effectiveRoot, node.file), publishedRelativePaths,
                            maxBytes: this.host.readFileMaxBytes,
                        });
                        sourceState = this.host.getRegistryFileFreshness({
                            symbols: registryState.registry.symbolsByFile.get(node.file) ?? [],
                            absoluteFile: path.resolve(effectiveRoot, node.file), sourceBytes: sourceRead.bytes,
                        }).status;
                    } catch (error) {
                        if (!(error instanceof PublishedFileAuthorizationError)
                            && !(error instanceof WorkspaceAuthorizationError)
                            && !(error instanceof AuthorizedSourceReadError)) throw error;
                    }
                    freshness = { sourceState };
                    fileFreshnessByPath.set(node.file, freshness);
                }
                node.freshness = freshness;
            }
            relationshipBackedGraph.graph = {
                ...relationshipBackedGraph.graph,
                registryBuiltAt: registryState.registry.manifest.builtAt,
            };
            if ([...fileFreshnessByPath.values()].some(value => value.sourceState !== "fresh")) {
                relationshipBackedGraph.warnings = [...(relationshipBackedGraph.warnings ?? []), "CALL_GRAPH_SOURCE_FRESHNESS_PARTIAL"];
            }
            if ([...fileFreshnessByPath.values()].some(value => value.sourceState === "stale")) {
                relationshipBackedGraph.warnings = [...(relationshipBackedGraph.warnings ?? []),
                    "NAVIGATION_SOURCE_DRIFT_DETECTED", "CALL_GRAPH_PUBLISHED_SPANS"];
            }
            signal?.throwIfAborted();
            await this.host.touchWatchedCodebase(effectiveRoot);
            signal?.throwIfAborted();
            const navigationAuthority = resolveCallGraphNavigationAuthority({
                publicationId: servingNavigation.publicationId,
                relationshipManifestHash: compatibility.relationships.manifestHash,
                relationshipBuiltAt: compatibility.relationships.manifest.builtAt,
                publicationCompletedAt: lease.publication.createdAt,
            });
            const fullPayload = withNavigationFreshness(this.host.withProofDebugHint({
                status: "ok" as const,
                path: absolutePath,
                codebaseRoot: effectiveRoot,
                symbolRef: canonicalSymbolRef,
                ...(navigationAuthority ? { navigationAuthority } : {}),
                ...relationshipBackedGraph,
            } satisfies CallGraphResponseEnvelope, proofDebugHint), leasedRootState.freshnessDecision);
            const payload = projectEvidence
                ? projectCallGraphEvidence(fullPayload, evidenceRequest)
                : fullPayload;
            return { payload };
            });
            return outcome.status === 'stale'
                ? {
                    payload: buildSourceStateUnverifiedCallGraphPayload(
                        this.host,
                        effectiveRoot,
                        { symbolRef: normalizedSymbolRef, direction, depth, limit, requestedPath: absolutePath },
                    ),
                }
                : outcome.result;
        } catch (error: unknown) {
            signal?.throwIfAborted();
            const pathResult = typeof args?.path === "string"
                ? requireAbsoluteFilesystemPath(args.path)
                : null;
            const invalidEvidenceContinuation = error instanceof InvalidCallGraphEvidenceContinuationError;
            const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
                {
                    path: pathResult?.ok ? pathResult.absolutePath : (typeof args?.path === "string" ? args.path : ""),
                    symbolRef: normalizedSymbolRef,
                    direction,
                    depth,
                    limit,
                },
                invalidEvidenceContinuation
                    ? error.message
                    : `Unexpected call_graph failure: ${formatUnknownError(error)}`,
                invalidEvidenceContinuation ? "not_found" : "not_ready",
                invalidEvidenceContinuation ? "invalid_evidence_continuation" : undefined,
            );
            return {
                payload,
                isError: true,
            };
        }
    }

    /**
     * SHA-256 of authorized source bytes, reused while the descriptor stat
     * witness proves the same content. find_references re-reads every eligible
     * file on each page, so re-hashing unchanged bytes is pure cost.
     *
     * The cache key is the codebase root plus the repo-relative path: the same
     * relative path under two roots is two different files, and a filesystem
     * with unstable inodes must never let one root's digest answer for another.
     */
    private sourceDigestFor(
        codebaseRoot: string,
        relativeFilePath: string,
        sourceRead: AuthorizedSourceRead,
        nowMs: number = Date.now(),
    ): string {
        // A digest may only be reused when the bytes it was computed from are
        // provably the same: an exact length plus the same dev/ino/size/mtime/
        // ctime witness the reader already trusts to prove a file did not change.
        const witnessed = sourceRead.bytes.length === sourceRead.observedStat.size;
        // A stat observed within the racy margin of the moment it is hashed
        // proves nothing, because a same-size in-place write inside the same
        // filesystem timestamp tick would leave the witness identical while the
        // bytes changed. Such a digest is computed but never stored, and a
        // stored digest is only trusted while its stat is aged.
        const aged = nowMs - Math.max(sourceRead.observedStat.mtimeMs, sourceRead.observedStat.ctimeMs)
            > RACY_SOURCE_DIGEST_MARGIN_MS;
        const cacheable = witnessed && aged;
        const cacheKey = `${codebaseRoot}\0${relativeFilePath}`;
        const signature = `${sourceRead.observedStat.dev}:${sourceRead.observedStat.ino}:${sourceRead.observedStat.size}:${sourceRead.observedStat.mtimeMs}:${sourceRead.observedStat.ctimeMs}`;
        if (cacheable) {
            const cached = readBoundedLru(this.sourceDigestCache, cacheKey);
            if (cached?.signature === signature) return cached.sha256;
        }
        const sha256 = crypto.createHash("sha256").update(sourceRead.bytes).digest("hex");
        if (cacheable) {
            writeBoundedLru(
                this.sourceDigestCache,
                cacheKey,
                { signature, sha256 },
                SOURCE_DIGEST_CACHE_MAX_ENTRIES,
            );
        }
        return sha256;
    }

    /**
     * Build the architecture_overview success envelope. Freshness and warnings
     * are request-time facts, so they are attached here rather than cached with
     * the immutable overview body.
     */
    private architectureOverviewResponse(input: {
        overview: ArchitectureOverviewResult;
        requestedRoot: string;
        publicationId: string;
        freshnessDecision: FreshnessDecision | undefined;
    }): ToolTextResponse {
        const warnings = input.freshnessDecision
            ? buildFreshnessWarningCodes(input.freshnessDecision)
            : [];
        return {
            content: [{
                type: "text",
                text: this.host.stringifyToolJson({
                    status: "ok",
                    path: input.requestedRoot,
                    publicationId: input.publicationId,
                    ...input.overview,
                    ...(input.freshnessDecision?.sourceFreshness
                        ? { sourceFreshness: input.freshnessDecision.sourceFreshness }
                        : {}),
                    ...(warnings.length > 0 ? { warnings } : {}),
                }),
            }],
        };
    }

    /**
     * Map a workspace or publication authorization denial onto the existing
     * file_outline denial contract: a structured `not_found` envelope with a
     * stable message. Never raw content, never a permissive fallback.
     */
    private mapNavigationAuthorizationDenial(input: {
        error: unknown;
        effectiveRoot: string;
        normalizedFile: string;
        args: FileOutlineInput;
        proofDebugHint?: CompletionProbeDebugHint;
        fallbackStatus: FileOutlineStatus;
        fallbackMessage: string;
    }): ToolTextResponse {
        const payload: FileOutlineResponseEnvelope = {
            status: input.fallbackStatus,
            path: input.effectiveRoot,
            file: input.normalizedFile,
            outline: null,
            hasMore: false,
            message: input.fallbackMessage,
        };
        return {
            content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(payload, input.proofDebugHint)) }],
            isError: true,
        };
    }

    /**
     * Build the file_outline response from source bytes already read through
     * the publication-authorized descriptor. Every structural, freshness,
     * and analysis read in this method consumes the authorized bytes or the
     * injected authorized reader; no pathname-based read happens here.
     */
    private async buildFileOutlineFromAuthorizedFile(input: {
        args: FileOutlineInput;
        effectiveRoot: string;
        normalizedFile: string;
        absoluteFile: string;
        sourceBytes: Buffer;
        registryState: Extract<
            Awaited<ReturnType<NavigationHandlersHost["loadPreparedNavigationSymbolsByFile"]>>,
            { status: "ok" }
        >;
        trackedRootState: Extract<TrackedRootReadinessState, { state: "ready" }>;
        proofDebugHint?: CompletionProbeDebugHint;
        limitSymbols: number;
        resolveMode: "exact" | "outline";
        symbolIdExact?: string;
        symbolLabelExact?: string;
        windowStart?: number;
        windowEnd?: number;
        detail: "summary" | "analysis" | "relationships" | "relationship_coverage";
        lease: PublicationLease;
        workspacePolicy: SessionWorkspacePolicy;
        publishedRelativePaths: ReadonlySet<string>;
        sourceOptions?: NavigationSourceOptions;
    }): Promise<ToolTextResponse> {
        const {
            args,
            effectiveRoot,
            normalizedFile,
            absoluteFile,
            sourceBytes,
            registryState,
            trackedRootState,
            proofDebugHint,
            limitSymbols,
            resolveMode,
            symbolIdExact,
            symbolLabelExact,
            windowStart,
            windowEnd,
            detail,
            lease,
            workspacePolicy,
            publishedRelativePaths,
        } = input;
        const registrySymbols = registryState.symbols;

        const fileFreshness = this.host.getRegistryFileFreshness({
            symbols: registrySymbols,
            absoluteFile,
            sourceBytes,
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
        const witnessFreshness = input.sourceOptions?.publishedSource !== undefined
            ? this.host.getRegistryFileFreshness({
                symbols: registrySymbols, absoluteFile, sourceBytes: input.sourceOptions.publishedSource,
            }).status : undefined;
        const publishedSpans = fileFreshness.status === "stale" || witnessFreshness === "fresh";
        if ((witnessFreshness !== undefined && witnessFreshness !== "fresh")
            || (fileFreshness.status === "stale" && (detail === "analysis"
                || (input.sourceOptions?.requireCurrentSource && witnessFreshness !== "fresh")))) {
            const payload = this.host.withProofDebugHint(this.host.buildStaleSymbolRefFileOutlinePayload(effectiveRoot, {
                ...args,
                file: normalizedFile,
            }, `File '${normalizedFile}' has changed since the symbol registry snapshot was published.`), proofDebugHint);
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
            };
        }

        const manifestFile = registryState.registry.manifest.files.find((file) => file.path === normalizedFile);
        if (manifestFile?.definitionStatus === "structural_unavailable") {
            const detectedLanguage = detectLanguageId(normalizedFile, sourceBytes.toString("utf8"), "");
            if (!detectedLanguage || !isLanguageCapabilitySupportedForLanguage(detectedLanguage, "fileOutline")) {
                await this.host.touchWatchedCodebase(effectiveRoot);
                const payload: FileOutlineResponseEnvelope = {
                    status: "unsupported",
                    reason: "unsupported_language",
                    path: effectiveRoot,
                    file: normalizedFile,
                    outline: null,
                    hasMore: false,
                    message: `File '${normalizedFile}' (${detectedLanguage || "unknown"}) is not supported for sidecar outline.`,
                };
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(payload, proofDebugHint)) }],
                };
            }
            await this.host.touchWatchedCodebase(effectiveRoot);
            const payload = withNavigationFreshness({
                status: "not_ready",
                reason: "structural_evidence_unavailable",
                path: effectiveRoot,
                file: normalizedFile,
                outline: null,
                hasMore: false,
                message: `The current Publication includes '${normalizedFile}', but structural evidence is unavailable for this file. Source remains readable and searchable.`,
                hints: {
                    readFile: {
                        tool: "read_file",
                        args: { path: absoluteFile },
                    },
                    structuralCoverage: {
                        tool: "manage_index",
                        args: { action: "status", path: effectiveRoot, detail: "full" },
                    },
                },
                freshness: {
                    indexedAt: null,
                    stalenessBucket: "unknown",
                    registryBuiltAt: registryState.registry.manifest.builtAt,
                    sourceState: fileFreshness.status,
                },
            }, trackedRootState.freshnessDecision);
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(
                    this.host.withProofDebugHint(payload, proofDebugHint),
                ) }],
            };
        }

        const readSourceLines = async (
            codebaseRoot: string,
            relativeFilePath: string,
        ): Promise<string[] | undefined> => {
            try {
                const sourceRead = await readAuthorizedPublishedSource({
                    workspacePolicy,
                    codebaseRoot,
                    requestedPath: path.resolve(codebaseRoot, relativeFilePath),
                    publishedRelativePaths,
                    maxBytes: this.host.readFileMaxBytes,
                });
                return sourceRead.bytes.toString("utf8").split(/\r?\n/);
            } catch (error) {
                if (error instanceof PublishedFileAuthorizationError
                    || error instanceof WorkspaceAuthorizationError
                    || error instanceof AuthorizedSourceReadError) {
                    return undefined;
                }
                throw error;
            }
        };

        const relationshipGraph = await this.host.loadRegistryValidatedRelationshipNavigation({
            codebaseRoot: effectiveRoot,
            registryManifestHash: registryState.manifestHash,
            preparedRead: trackedRootState,
        });
        const outlineWarnings: string[] = fileFreshness.status === "stale"
            ? ["NAVIGATION_SOURCE_DRIFT_DETECTED", "OUTLINE_PUBLISHED_SPANS"] : [];
        if (relationshipGraph.warning) {
            outlineWarnings.push(`OUTLINE_${relationshipGraph.warning}`);
        }
        if (manifestFile?.structuralStatus === "recovered") {
            outlineWarnings.push(`OUTLINE_PARTIAL_STRUCTURAL_COVERAGE:${manifestFile.structuralReason ?? "unknown"}`);
        }
        const continuationArgs = {
            path: effectiveRoot,
            file: normalizedFile,
            detail,
            resolveMode,
            limitSymbols,
            ...(symbolIdExact !== undefined ? { symbolIdExact } : {}),
            ...(symbolLabelExact !== undefined ? { symbolLabelExact } : {}),
            ...(windowEnd !== undefined ? { end_line: windowEnd } : {}),
        };
        // A drifted file keeps the published span as the registry view. The
        // current span is a separate projection proven against the current
        // bytes, so an edited file can show where the declaration is now.
        const currentSpans = fileFreshness.status === "stale"
            ? (await mapPublishedSymbolsToCurrentSpans({
                codebaseRoot: effectiveRoot,
                symbols: registrySymbols,
                evidence: buildCurrentSourceEvidenceFromBytes({
                    canonicalRoot: effectiveRoot,
                    relativeFile: normalizedFile,
                    sourceBytes,
                }),
            })).mappings
            : undefined;
        const payload = await buildRegistryFileOutlinePayload({
            codebaseRoot: effectiveRoot,
            file: normalizedFile,
            symbols: registrySymbols,
            publishedSpans,
            currentSpans,
            limitSymbols,
            resolveMode,
            symbolIdExact,
            symbolLabelExact,
            windowStart,
            windowEnd,
            continuationArgs,
            warnings: outlineWarnings.length > 0 ? outlineWarnings : undefined,
            buildCallGraphHint: (symbol) => this.host.buildRegistrySymbolCallGraphHint(symbol, normalizedFile, relationshipGraph),
            buildOutlineSpanWarningCodes: (repair) => this.host.buildOutlineSpanWarningCodes(repair),
            readSourceLines,
        });
        await this.host.touchWatchedCodebase(effectiveRoot);
        let projectedPayload = payload;
        if (detail === "analysis" && payload.status === "ok") {
            const selectedSymbol = payload.outline?.symbols[0];
            if (!selectedSymbol) {
                projectedPayload = buildAnalysisUnavailableFileOutlinePayload(
                    effectiveRoot,
                    normalizedFile,
                    "No exact canonical symbol was available for structural analysis.",
                );
            } else if (selectedSymbol.language !== "python" && selectedSymbol.language !== "go") {
                projectedPayload = buildAnalysisUnavailableFileOutlinePayload(
                    effectiveRoot,
                    normalizedFile,
                    "Structural analysis v1 is available only for Python and Go symbols.",
                    "unsupported_language",
                );
            } else {
                const structuralInput = {
                    content: sourceBytes.toString("utf8"),
                    symbol: {
                        kind: selectedSymbol.kind,
                        name: selectedSymbol.name,
                        qualifiedName: selectedSymbol.qualifiedName,
                        span: selectedSymbol.span,
                    },
                };
                const analysisResult = selectedSymbol.language === "python"
                    ? await analyzePythonSymbolStructure(structuralInput)
                    : await analyzeGoSymbolStructure(structuralInput);
                if (analysisResult.status === "ok") {
                    projectedPayload = withStructuralAnalysis(payload, analysisResult.analysis);
                } else {
                    const languageLabel = selectedSymbol.language === "python" ? "Python" : "Go";
                    projectedPayload = buildAnalysisUnavailableFileOutlinePayload(
                        effectiveRoot,
                        normalizedFile,
                        analysisResult.reason === "unsupported_symbol_kind"
                            ? "Structural analysis v1 supports functions and methods only."
                            : `${languageLabel} structural analysis is unavailable (${analysisResult.reason}).`,
                        analysisResult.reason === "unsupported_symbol_kind"
                            ? "unsupported_symbol_kind"
                            : "analysis_unavailable",
                    );
                }
            }
        }
        if (detail === "relationship_coverage" && payload.status === "ok") {
            const navigationBinding = this.host.getPublicationNavigationAddress(lease);
            const compatibility = navigationBinding
                ? await this.host.loadPreparedNavigationCompatibility(
                    trackedRootState,
                    registryState.manifestHash,
                )
                : undefined;
            const relationshipState = compatibility?.relationships;
            const fileEvidence = relationshipState?.status === "ok"
                ? await this.host.loadPreparedNavigationAnalysisEvidence(
                    trackedRootState,
                    registryState.manifestHash,
                    [normalizedFile],
                )
                : undefined;
            if (relationshipState?.status === "ok" && fileEvidence?.status === "ok") {
                const claims = fileEvidence.analysisByFile.get(normalizedFile)?.resolutionClaims ?? [];
                projectedPayload = {
                    ...payload,
                    relationshipEvidence: {
                        resolutionClaimCount: claims.length,
                        resolvedClaimCount: claims.filter((claim) => claim.decision === "resolved").length,
                        ambiguousClaimCount: claims.filter((claim) => claim.decision === "ambiguous").length,
                        unresolvedClaimCount: claims.filter((claim) => claim.decision === "unresolved").length,
                        constructCoverage: summarizeResolutionConstructCoverage(claims, {
                            gapLimit: 10,
                            relationships: relationshipState.records,
                        }),
                    },
                };
            } else {
                projectedPayload = {
                    ...payload,
                    relationshipEvidence: {
                        resolutionClaimCount: 0,
                        resolvedClaimCount: 0,
                        ambiguousClaimCount: 0,
                        unresolvedClaimCount: 0,
                        constructCoverage: [],
                    },
                    warnings: [
                        ...(payload.warnings ?? []),
                        "OUTLINE_RELATIONSHIP_COVERAGE_UNAVAILABLE",
                    ],
                };
            }
        }
        if (detail === "relationships" && payload.status === "ok") {
            const selectedSymbol = payload.outline?.symbols[0];
            const target = selectedSymbol
                ? registryState.registry.symbolsByInstanceId.get(selectedSymbol.symbolId)
                : undefined;
            if (!selectedSymbol || !target) {
                projectedPayload = withRelationshipMetadata(
                    payload,
                    unavailableRelationshipMetadata("unavailable"),
                );
            } else if (!this.host.isCallGraphLanguageSupported(
                selectedSymbol.language,
                selectedSymbol.file,
            )) {
                projectedPayload = withRelationshipMetadata(
                    payload,
                    unavailableRelationshipMetadata("unsupported"),
                );
            } else {
                const navigationBinding = this.host.getPublicationNavigationAddress(lease);
                const compatibility = navigationBinding
                    ? await this.host.loadPreparedNavigationCompatibility(
                        trackedRootState,
                        registryState.manifestHash,
                    )
                    : undefined;
                const relationshipState = compatibility?.relationships;
                const traversals = navigationBinding && relationshipState?.status === "ok"
                    ? await prepareRelationshipTraversals({
                        rootPath: effectiveRoot,
                        publicationId: navigationBinding.publicationId,
                        navigationRoot: navigationBinding.navigationRoot,
                        registryManifestIdentity: registryState.manifestHash,
                        relationshipManifestIdentity: relationshipState.manifestHash,
                        registry: registryState.registry,
                        target,
                        relationshipManifest: relationshipState.manifest,
                        relationshipRecords: relationshipState.records,
                        relationshipWarnings: relationshipState.warnings || [],
                    })
                    : undefined;
                if (!traversals) {
                    projectedPayload = withRelationshipMetadata(
                        payload,
                        unavailableRelationshipMetadata("unavailable"),
                    );
                } else {
                    projectedPayload = withRelationshipMetadata(
                        payload,
                        buildPartialRelationshipMetadata({
                            targetSymbolId: target.symbolInstanceId,
                            callers: traversals.callers.edges,
                            callees: traversals.callees.edges,
                        }),
                    );
                }
            }
        }
        const freshnessProjectedPayload = withNavigationFreshness(
            { ...projectedPayload, freshness: {
                indexedAt: null, stalenessBucket: "unknown",
                registryBuiltAt: registryState.registry.manifest.builtAt,
                sourceState: fileFreshness.status,
            } },
            trackedRootState.freshnessDecision,
        );
        const budgetedPayload = fitFileOutlineResponseBudget({
            payload: this.host.withProofDebugHint(freshnessProjectedPayload, proofDebugHint),
            maxResponseBytes: FILE_OUTLINE_RESPONSE_MAX_UTF8_BYTES,
            continuationArgs,
            requestedStartLine: windowStart,
            stringify: (payload) => this.host.stringifyToolJson(payload),
        });
        return {
            content: [{ type: "text", text: this.host.stringifyToolJson(budgetedPayload) }],
        };
    }
}
