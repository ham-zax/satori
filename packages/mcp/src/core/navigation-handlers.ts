import * as crypto from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import {
    analyzeGoSymbolStructure,
    analyzePythonSymbolStructure,
    getSupportedExtensionsForCapability,
    JsonNavigationStore,
    summarizeResolutionConstructCoverage,
    type PublicationLease,
    type PublicationRef,
    type SymbolRecord,
    type SymbolRegistry,
    type SymbolStructuralAnalysis,
} from "@zokizuan/satori-core";

import {
    repairSourceBackedPythonSpan,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import {
    buildArchitectureOverview,
    type ArchitectureOverviewScope,
} from "./architecture-overview.js";
import {
    PublishedFileAuthorizationError,
} from "./published-file-authorization.js";
import {
    AuthorizedSourceReadError,
    readAuthorizedPublishedSource,
} from "./published-source-reader.js";
import {
    findExactPublishedSourceReferences,
    type ExactReferenceSearchResult,
    type ExactReferenceSourceRead,
} from "./exact-reference-search.js";
import {
    WorkspaceAuthorizationError,
    type SessionWorkspacePolicy,
} from "./session-workspace-policy.js";
import {
    buildRegistryFileOutlinePayload,
    findExactRegistrySymbols,
} from "./registry-file-outline.js";
import { prepareRelationshipTraversals } from "./prepared-relationship-traversal.js";
import { PreparedPublicationReadSession } from "./prepared-publication-read-session.js";
import {
    InvalidCallGraphEvidenceContinuationError,
    projectCallGraphEvidence,
    type CallGraphEvidenceRequest,
} from "./call-graph-evidence-projection.js";
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
    CallGraphDirection,
    CallGraphEdgeResult as CallGraphEdge,
    CallGraphHint,
    CallGraphResponseEnvelope,
    CallGraphSymbolRef,
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
    getPublicationNavigationAddress(publication: PublicationRef): {
        publicationId: string;
        navigationRoot: string;
    } | null;
    getPublicationNavigationStatus(publication: PublicationRef): Promise<import("@zokizuan/satori-core").PublicationNavigationStatus>;
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
    },
): CallGraphResponseEnvelope {
    return {
        status: "not_ready",
        supported: true,
        reason: "source_state_unverified",
        path: codebasePath,
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

export class NavigationHandlers {
    constructor(private readonly host: NavigationHandlersHost) {}

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

        const session = new PreparedPublicationReadSession<TrackedRootReadinessState>({
            prepareReadiness: () => this.host.prepareNavigationRead(requestedRoot),
            acquirePublicationLease: (prepared) => (
                prepared.state === "ready"
                    ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                    : undefined
            ),
            isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
        });

        const outcome = await session.read(async (trackedRootState, lease): Promise<ToolTextResponse> => {
            if (trackedRootState.state !== "ready") {
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

            const overview = buildArchitectureOverview({
                manifest: manifest.registry.manifest,
                symbols: manifest.registry.symbols,
                relationships: compatibility.relationships.records,
                resolutionClaims: [...compatibility.relationships.analysisByFile.values()]
                    .flatMap((evidence) => evidence.resolutionClaims ?? []),
                scope,
                limit,
                ...(subtree ? { subtree } : {}),
                ...(excludePaths ? { excludePaths } : {}),
            });
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
                        ...overview,
                        ...(freshnessDecision?.sourceFreshness
                            ? { sourceFreshness: freshnessDecision.sourceFreshness }
                            : {}),
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
                        message: "Publication authority changed while architecture evidence was being read; retry the request.",
                    }),
                }],
            }
            : outcome.result;
    }

    public async handleFindReferences(
        args: ToolArgs,
        workspacePolicy: SessionWorkspacePolicy,
    ): Promise<ToolTextResponse> {
        const absolutePathResult = typeof args.path === "string"
            ? requireAbsoluteFilesystemPath(args.path, "path")
            : { ok: false as const, path: "", message: "path is required." };
        const rawSymbolRef = args.symbolRef as CallGraphSymbolRef | undefined;
        const symbolFileResult = typeof rawSymbolRef?.file === "string"
            ? requireRepoRelativeFilePath(rawSymbolRef.file, "symbolRef.file")
            : { ok: false as const, path: "", message: "symbolRef.file is required." };
        if (!absolutePathResult.ok || !symbolFileResult.ok || !rawSymbolRef?.symbolId) {
            return {
                content: [{
                    type: "text",
                    text: this.host.stringifyToolJson({
                        status: "error",
                        reason: "invalid_request",
                        path: absolutePathResult.ok ? absolutePathResult.absolutePath : (typeof args.path === "string" ? args.path : ""),
                        message: !absolutePathResult.ok
                            ? absolutePathResult.message
                            : !symbolFileResult.ok
                                ? symbolFileResult.message
                                : "symbolRef with { file, symbolId } is required.",
                    }),
                }],
                isError: true,
            };
        }

        const requestedRoot = absolutePathResult.absolutePath;
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

        const session = new PreparedPublicationReadSession<TrackedRootReadinessState>({
            prepareReadiness: () => this.host.prepareNavigationRead(requestedRoot),
            acquirePublicationLease: (prepared) => (
                prepared.state === "ready"
                    ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                    : undefined
            ),
            isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
        });

        const outcome = await session.read(async (trackedRootState, lease): Promise<ToolTextResponse> => {
            if (trackedRootState.state !== "ready") {
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

            const normalizedSymbolFile = this.host.normalizeRelativeFilePath(symbolFileResult.relativePath);
            const symbolsInFile = manifest.registry.symbolsByFile.get(normalizedSymbolFile) ?? [];
            const exactSymbols = findExactRegistrySymbols({
                symbols: symbolsInFile,
                symbolIdExact: rawSymbolRef.symbolId,
            });
            if (exactSymbols.length !== 1) {
                return {
                    content: [{
                        type: "text",
                        text: this.host.stringifyToolJson({
                            status: "not_found",
                            reason: "missing_symbol",
                            path: leasedRootState.root.path,
                            symbolRef: rawSymbolRef,
                            message: exactSymbols.length === 0
                                ? "No exact canonical symbol matched symbolRef."
                                : "symbolRef matched more than one canonical symbol.",
                        }),
                    }],
                };
            }

            const publishedRelativePaths = new Set(
                manifest.registry.manifest.files.map((file) => file.path),
            );
            const readPublishedSource = async (relativeFilePath: string): Promise<ExactReferenceSourceRead> => {
                try {
                    const sourceRead = await readAuthorizedPublishedSource({
                        workspacePolicy,
                        codebaseRoot: leasedRootState.root.path,
                        requestedPath: path.resolve(leasedRootState.root.path, relativeFilePath),
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

            const result = await findExactPublishedSourceReferences({
                registry: manifest.registry,
                target: exactSymbols[0]!,
                scope,
                limit,
                readPublishedSource,
            });
            await this.host.touchWatchedCodebase(leasedRootState.root.path);
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
                        ...result,
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
    ): Promise<ToolTextResponse> {
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
            const relativeFileResult = requireRepoRelativeFilePath(
                typeof args.file === "string" ? args.file : "",
                "file",
            );
            if (!relativeFileResult.ok) {
                const payload = this.host.toolResponseBuilders.buildInvalidFileOutlineRequestPayload(
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

            const session = new PreparedPublicationReadSession<TrackedRootReadinessState>({
                prepareReadiness: () => this.host.prepareNavigationRead(absoluteRoot),
                acquirePublicationLease: (prepared) => (
                    prepared.state === 'ready'
                        ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                        : undefined
                ),
                isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
            });
            const outcome = await session.read(async (trackedRootState, lease): Promise<ToolTextResponse> => {
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

            const leasedRootState: Extract<TrackedRootReadinessState, { state: 'ready' }> = {
                ...trackedRootState,
                publication: lease,
                navigationStatus: await this.host.getPublicationNavigationStatus(lease),
            };
            const matchedRoot = leasedRootState.root;
            effectiveRoot = matchedRoot.path;
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
            });
            return outcome.status === 'stale'
                ? {
                    content: [{ type: "text" as const, text: this.host.stringifyToolJson(
                        buildSourceStateUnverifiedFileOutlinePayload(this.host, effectiveRoot, normalizedFile),
                    ) }],
                }
                : outcome.result;
        } catch (error: unknown) {
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
    ): Promise<ToolTextResponse> {
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
            const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
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
            const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
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
            const payload = this.host.toolResponseBuilders.buildInvalidCallGraphRequestPayload(
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
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
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
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    isError: true,
                };
            }

            trackCodebasePath(absolutePath);

            const session = new PreparedPublicationReadSession<TrackedRootReadinessState>({
                prepareReadiness: () => this.host.prepareNavigationRead(absolutePath),
                acquirePublicationLease: (prepared) => (
                    prepared.state === 'ready'
                        ? this.host.acquirePublicationLease(prepared.root.path, prepared.publication.id)
                        : undefined
                ),
                isLeaseAdmitted: (_prepared, lease) => this.host.isPublicationAdmitted(lease),
            });
            const outcome = await session.read(async (trackedRootState, lease): Promise<ToolTextResponse> => {
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
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (trackedRootState.state === "indexing") {
                const payload = this.host.toolResponseBuilders.buildNotReadyCallGraphPayload(trackedRootState.codebasePath, {
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
                const payload = this.host.toolResponseBuilders.buildNotIndexedCallGraphPayload({
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

            const leasedRootState: Extract<TrackedRootReadinessState, { state: 'ready' }> = {
                ...trackedRootState,
                publication: lease,
                navigationStatus: await this.host.getPublicationNavigationStatus(lease),
            };
            const searchableRoot = leasedRootState.root;
            effectiveRoot = searchableRoot.path;
            const proofDebugHint = leasedRootState.proofDebugHint;

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
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const normalizedSymbolFile = this.host.normalizeRelativeFilePath(symbolRef.file);
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
            });
            if (exactRegistrySymbols.length === 0) {
                const payload = withNavigationFreshness(this.host.withProofDebugHint({
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
                } satisfies CallGraphResponseEnvelope, proofDebugHint), leasedRootState.freshnessDecision);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            if (exactRegistrySymbols.length > 1) {
                const payload = withNavigationFreshness(this.host.withProofDebugHint({
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
                } satisfies CallGraphResponseEnvelope, proofDebugHint), leasedRootState.freshnessDecision);
                return {
                    content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                };
            }

            const publishedRelativePaths = new Set(
                registryState.registry.manifest.files.map((file) => file.path),
            );
            const readAuthorizedSourceLines = async (
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
                    limit: Number.MAX_SAFE_INTEGER,
                    readPublishedSource: readExactPublishedSource,
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

            const resolvedSymbolRepair = repairSourceBackedPythonSpan({
                codebaseRoot: effectiveRoot,
                symbol: exactRegistrySymbols[0],
                // Always supply source lines (empty when unauthorized) so the
                // single-symbol repair can never fall back to a pathname read.
                sourceLines: symbolSourceBytes !== undefined
                    ? symbolSourceBytes.toString("utf8").split(/\r?\n/)
                    : [],
            });
            const resolvedSymbol = resolvedSymbolRepair.symbol;
            if (symbolSourceBytes === undefined) {
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
                        message: `Symbol reference points at '${normalizedSymbolFile}', but the current file is unavailable or not authorized. Refresh the index before using exact call graph navigation.`,
                    }), proofDebugHint);
                    return {
                        content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                    };
                }
            } else {
                const fileFreshness = this.host.getRegistryFileFreshness({
                    symbols: exactRegistrySymbols,
                    absoluteFile: absoluteSymbolFile,
                    sourceBytes: symbolSourceBytes,
                });
                if (fileFreshness.status === "inconsistent") {
                    const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
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

            const servingNavigation = this.host.getPublicationNavigationAddress(lease);
            if (!servingNavigation) {
                const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
                    effectiveRoot,
                    "Publication navigation identity is unavailable for call-graph traversal.",
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
                readAuthorizedSourceLines,
                findExactSourceReferences,
            });
            if (!relationshipBackedGraph) {
                const payload = this.host.withProofDebugHint(this.host.toolResponseBuilders.buildRequiresReindexCallGraphPayload(
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
                    freshness = { indexedAt: null, stalenessBucket: "unknown",
                        registryBuiltAt: registryState.registry.manifest.builtAt, sourceState };
                    fileFreshnessByPath.set(node.file, freshness);
                }
                node.freshness = freshness;
            }
            if ([...fileFreshnessByPath.values()].some(value => value.sourceState !== "fresh")) {
                relationshipBackedGraph.warnings = [...(relationshipBackedGraph.warnings ?? []), "CALL_GRAPH_SOURCE_FRESHNESS_PARTIAL"];
            }
            await this.host.touchWatchedCodebase(effectiveRoot);
            const navigationAuthority = resolveCallGraphNavigationAuthority({
                publicationId: servingNavigation.publicationId,
                relationshipManifestHash: compatibility.relationships.manifestHash,
                relationshipBuiltAt: compatibility.relationships.manifest.builtAt,
                publicationCompletedAt: lease.publication.createdAt,
            });
            const fullPayload = withNavigationFreshness(this.host.withProofDebugHint({
                status: "ok" as const,
                path: effectiveRoot,
                symbolRef,
                ...(navigationAuthority ? { navigationAuthority } : {}),
                ...relationshipBackedGraph,
            } satisfies CallGraphResponseEnvelope, proofDebugHint), leasedRootState.freshnessDecision);
            const payload = projectCallGraphEvidence(fullPayload, evidenceRequest);
            return {
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
            };
            });
            return outcome.status === 'stale'
                ? {
                    content: [{ type: "text" as const, text: this.host.stringifyToolJson(
                        buildSourceStateUnverifiedCallGraphPayload(
                            this.host,
                            effectiveRoot,
                            { symbolRef, direction, depth, limit },
                        ),
                    ) }],
                }
                : outcome.result;
        } catch (error: unknown) {
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
                content: [{ type: "text", text: this.host.stringifyToolJson(payload) }],
                isError: true,
            };
        }
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
        if (fileFreshness.status === "stale") {
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
        const outlineWarnings: string[] = [];
        if (relationshipGraph.warning) {
            outlineWarnings.push(`OUTLINE_${relationshipGraph.warning}`);
        }
        const payload = await buildRegistryFileOutlinePayload({
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
            if (relationshipState?.status === "ok") {
                const claims = relationshipState.analysisByFile.get(normalizedFile)?.resolutionClaims ?? [];
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
        return {
            content: [{ type: "text", text: this.host.stringifyToolJson(this.host.withProofDebugHint(freshnessProjectedPayload, proofDebugHint)) }],
        };
    }
}
