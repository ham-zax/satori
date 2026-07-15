import {
    compareContractStrings,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import type { CallGraphEdge, CallGraphNote } from "./call-graph.js";
import {
    BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
    selectBoundedSource,
    type BoundedSourceBudgets,
    type SelectedSourceProjection,
    type SourceSelectionCapabilities,
} from "./bounded-source-selector.js";
import {
    projectCanonicalSymbolIdentity,
    type CanonicalSymbolRegistryView,
} from "./canonical-symbol-identity.js";
import {
    validateCurrentSourceSymbolSpansFromEvidence,
    type CurrentSourceEvidence,
    type CurrentSourceSpanResolutionEvidence,
    type CurrentSourceSymbolValidation,
} from "./current-source-symbols.js";
import {
    prepareInspectableSource,
    type InspectableSourceFailureReason,
    type InspectableSourceFinalizer,
    type PrepareInspectableSourceResult,
} from "./inspectable-source.js";
import {
    InvalidRelationshipContinuationError,
    paginateRelationshipEdges,
    buildRelationshipTraversalFingerprint,
    type RelationshipTraversalFingerprint,
} from "./relationship-continuation.js";
import {
    projectRelationshipEvidence,
    type RelationshipEvidenceKind,
    type RelationshipEvidenceProjection,
    type RelationshipEvidenceLimitation,
} from "./relationship-evidence.js";
import { findExactRegistrySymbols } from "./registry-file-outline.js";
import {
    buildSourceContinuationFingerprint,
    type SourceContinuationFingerprint,
    type SourceContinuationIdentity,
} from "./source-continuation-fingerprint.js";
import type { CanonicalSymbolIdentity } from "./search-types.js";

export type NavigationEvidenceAuthority =
    | "remote_generation_proven"
    | "local_navigation_validated"
    | "degraded";

export type RelationshipEvidenceAuthority =
    | "remote_generation_proven"
    | "local_navigation_validated"
    | "degraded"
    | "unavailable";

export type PreparedRelationshipSnapshot = {
    status: "available";
    authority: Exclude<RelationshipEvidenceAuthority, "unavailable">;
    manifestIdentity: string;
    callers: PreparedRelationshipDirectionSnapshot;
    callees: PreparedRelationshipDirectionSnapshot;
} | {
    status: "unavailable";
    authority: "unavailable" | "degraded";
    reason: string;
};

export interface PreparedRelationshipDirectionSnapshot {
    edges: readonly CallGraphEdge[];
    availableCount: number;
    suppressedCount: number;
    suppressionNotes: readonly CallGraphNote[];
    limitations?: readonly RelationshipEvidenceLimitation[];
}

export interface PreparedSymbolContextSnapshot {
    canonicalRoot: string;
    registryManifestIdentity: string;
    registry: SymbolRegistry;
    navigationAuthority: NavigationEvidenceAuthority;
    relationships: PreparedRelationshipSnapshot;
    validateAuthority(): Promise<boolean>;
}

export type PrepareSymbolContextSnapshotResult = {
    status: "ready";
    snapshot: PreparedSymbolContextSnapshot;
} | {
    status: "unavailable";
    reason: string;
};

export interface SymbolContextComposerDependencies {
    prepareSnapshot(input: {
        codebaseRoot: string;
        relativeFile: string;
        symbolId?: string;
        symbolLabel?: string;
    }): Promise<PrepareSymbolContextSnapshotResult>;
    prepareSource?: typeof prepareInspectableSource;
    resolveCurrentSpans?: typeof validateCurrentSourceSymbolSpansFromEvidence;
}

export interface SymbolContextInclude {
    source: boolean;
    siblings: boolean;
    callers: boolean;
    callees: boolean;
}

export interface SymbolContextBudgets {
    source: BoundedSourceBudgets;
    maxInspectableBytes: number;
    maxSiblings: number;
    maxEdgesPerDirection: number;
    maxSerializedResponseBytes: number;
}

export type SymbolContextContinuationRequest = {
    kind: "source_range";
    fingerprint: string;
    startLine: number;
    endLine: number;
} | {
    kind: "caller_page" | "callee_page";
    fingerprint: string;
    cursor: string;
    pageSize: number;
};

type ExactSymbolTarget = {
    symbolId: string;
    symbolLabel?: never;
} | {
    symbolId?: never;
    symbolLabel: string;
};

export type ComposeSymbolContextInput = ExactSymbolTarget & {
    codebaseRoot: string;
    relativeFile: string;
    include: SymbolContextInclude;
    budgets: SymbolContextBudgets;
    query?: string;
    continuation?: SymbolContextContinuationRequest;
};

export type SourceSpanResolution =
    | "index_snapshot_matched"
    | "current_symbol_validated"
    | "unavailable"
    | "not_requested";

export type SourceFreshness =
    | "current_at_final_observation"
    | "stale"
    | "unavailable"
    | "not_requested";

export type UnavailableSourceProjection = {
    mode: "bounded";
    status: "unavailable" | "stale";
    completeSymbolReturned: false;
    excerpts: [];
    omittedRanges: [];
    truncated: true;
    emptyReason: InspectableSourceFailureReason
        | "current_symbol_span_unavailable"
        | "source_encoding_invalid";
    selectionCapabilities?: SourceSelectionCapabilities;
};

export type SymbolContextSourceProjection =
    | SelectedSourceProjection
    | UnavailableSourceProjection
    | { status: "not_requested" };

export type SymbolContextRelationshipProjection =
    | RelationshipEvidenceProjection
    | { status: "not_requested"; relationship: RelationshipEvidenceKind };

export type SymbolContextContinuation = {
    kind: "source_range";
    domains: ["symbol", "source"];
    fingerprint: string;
    startLine: number;
    endLine: number;
} | {
    kind: "caller_page" | "callee_page";
    domains: ["symbol", "relationships"];
    fingerprint: string;
    cursor: string;
    pageSize: number;
    terminal: false;
};

export interface ComposedSymbolContext {
    status: "ok";
    symbol: CanonicalSymbolIdentity;
    outline: {
        siblings: {
            items: CanonicalSymbolIdentity[];
            returnedCount: number;
            availableCount: number;
            truncated: boolean;
        };
    };
    source: SymbolContextSourceProjection;
    relationships: {
        callers: SymbolContextRelationshipProjection;
        callees: SymbolContextRelationshipProjection;
    };
    authority: {
        vector: "not_required";
        navigation: NavigationEvidenceAuthority;
        source: {
            freshness: SourceFreshness;
            spanResolution: SourceSpanResolution;
        };
        relationships: RelationshipEvidenceAuthority | "not_requested";
    };
    continuations: SymbolContextContinuation[];
    limitations: string[];
}

export type ComposeSymbolContextResult = {
    status: "ok";
    context: ComposedSymbolContext;
} | {
    status: "symbol_not_found" | "ambiguous_symbol" | "navigation_unavailable";
    reason: string;
} | {
    status: "stale";
    reason: "prepared_authority_changed";
} | {
    status: "stale_continuation";
    reason: "continuation_identity_changed";
} | {
    status: "invalid_relationship_continuation";
    reason: "cursor_invalid_for_prepared_traversal";
} | {
    status: "safety_error";
    reason: "root_binding_invalid";
    diagnosticCode: "ROOT_BINDING_INVALID";
} | {
    status: "resource_limit";
    symbolId: string;
    minimumRequiredResponseBytes: number;
    hardResponseLimitBytes: number;
};

type SourceComposition = {
    source: SymbolContextSourceProjection;
    freshness: SourceFreshness;
    spanResolution: SourceSpanResolution;
    continuationFingerprint?: SourceContinuationFingerprint;
    resolvedSymbol?: SymbolRecord;
    snapshotMatched: boolean;
    validatedRelativeFile?: string;
    selectionCapabilities?: SourceSelectionCapabilities;
    finalizer?: InspectableSourceFinalizer;
};

type RelationshipComposition = {
    relationship: RelationshipEvidenceKind;
    requested: boolean;
    allEdges: CallGraphEdge[];
    availableCount: number;
    limitations: RelationshipEvidenceLimitation[];
    suppressedCount: number;
    suppressionNotes: CallGraphNote[];
    status: "ok" | "degraded";
    fingerprint?: RelationshipTraversalFingerprint;
    unavailable?: SymbolContextRelationshipProjection;
};

class PreparedAuthorityChangedError extends Error {}

function assertNonNegativeInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
}

function validateBudgets(budgets: SymbolContextBudgets): void {
    assertNonNegativeInteger(budgets.maxInspectableBytes, "maxInspectableBytes");
    assertNonNegativeInteger(budgets.maxSiblings, "maxSiblings");
    if (!Number.isSafeInteger(budgets.maxEdgesPerDirection) || budgets.maxEdgesPerDirection < 1) {
        throw new RangeError("maxEdgesPerDirection must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(budgets.maxSerializedResponseBytes) || budgets.maxSerializedResponseBytes < 1) {
        throw new RangeError("maxSerializedResponseBytes must be a positive safe integer.");
    }
}

function validateContinuationRequest(input: ComposeSymbolContextInput): void {
    const continuation = input.continuation;
    if (!continuation) return;
    if (!continuation.fingerprint.trim()) {
        throw new TypeError("A continuation fingerprint must be non-empty.");
    }
    if (continuation.kind === "source_range") {
        if (
            !Number.isSafeInteger(continuation.startLine)
            || !Number.isSafeInteger(continuation.endLine)
            || continuation.startLine < 1
            || continuation.endLine < continuation.startLine
        ) {
            throw new RangeError("A source continuation requires a valid line range.");
        }
        if (
            !input.include.source
            || input.include.siblings
            || input.include.callers
            || input.include.callees
        ) {
            throw new TypeError("A source continuation may request only source evidence.");
        }
        return;
    }
    if (!continuation.cursor || !Number.isSafeInteger(continuation.pageSize) || continuation.pageSize < 1) {
        throw new RangeError("A relationship continuation requires a cursor and positive page size.");
    }
    const requestsCallers = continuation.kind === "caller_page";
    if (
        input.include.source
        || input.include.siblings
        || input.include.callers !== requestsCallers
        || input.include.callees === requestsCallers
    ) {
        throw new TypeError("A relationship continuation may request only its matching direction.");
    }
}

function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function unavailableSource(
    status: "unavailable" | "stale",
    emptyReason: UnavailableSourceProjection["emptyReason"],
    capabilities?: SourceSelectionCapabilities,
): UnavailableSourceProjection {
    return {
        mode: "bounded",
        status,
        completeSymbolReturned: false,
        excerpts: [],
        omittedRanges: [],
        truncated: true,
        emptyReason,
        ...(capabilities ? { selectionCapabilities: { ...capabilities } } : {}),
    };
}

function projectSiblings(input: {
    target: SymbolRecord;
    registry: CanonicalSymbolRegistryView;
    allSymbols: readonly SymbolRecord[];
}): CanonicalSymbolIdentity[] {
    const targetParent = input.target.parentKey || input.target.parentQualifiedNamePath.join("\0");
    return input.allSymbols
        .filter((symbol) => {
            if (symbol.symbolInstanceId === input.target.symbolInstanceId) return false;
            const parent = symbol.parentKey || symbol.parentQualifiedNamePath.join("\0");
            return symbol.file === input.target.file && parent === targetParent;
        })
        .sort((left, right) => (
            left.span.startLine - right.span.startLine
            || left.span.endLine - right.span.endLine
            || compareContractStrings(left.symbolInstanceId, right.symbolInstanceId)
        ))
        .map((symbol) => projectCanonicalSymbolIdentity({ symbol, registry: input.registry }));
}

function currentEvidenceFromInspectable(
    evidence: Extract<PrepareInspectableSourceResult, { status: "available" }>["evidence"],
): CurrentSourceEvidence {
    return {
        canonicalRoot: evidence.canonicalRoot,
        relativeFile: evidence.relativeFile,
        sourceBytes: evidence.sourceBytes,
        source: evidence.source,
        observedHash: evidence.observedHash,
        ...(evidence.measurementObservation
            ? { measurementObservation: evidence.measurementObservation }
            : {}),
    };
}

function snapshotMatchedContinuationIdentity(input: {
    snapshot: PreparedSymbolContextSnapshot;
    symbol: SymbolRecord;
}): SourceContinuationIdentity {
    return {
        canonicalRoot: input.snapshot.canonicalRoot,
        selectionPolicyVersion: BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
        spanResolution: "index_snapshot_matched",
        registryManifestIdentity: input.snapshot.registryManifestIdentity,
        indexedSourceIdentity: input.symbol.fileHash,
        symbolInstanceId: input.symbol.symbolInstanceId,
        indexedSpan: input.symbol.span,
    };
}

function currentValidatedContinuationIdentity(input: {
    snapshot: PreparedSymbolContextSnapshot;
    symbol: SymbolRecord;
    observedHash: string;
    resolutionEvidence: CurrentSourceSpanResolutionEvidence;
}): SourceContinuationIdentity {
    return {
        canonicalRoot: input.snapshot.canonicalRoot,
        selectionPolicyVersion: BOUNDED_SOURCE_SELECTION_POLICY_VERSION,
        spanResolution: "current_symbol_validated",
        currentSourceHash: input.observedHash,
        currentSpanIdentity: input.resolutionEvidence.currentSpanIdentity,
        resolvedSpan: input.symbol.span,
        spanResolutionPolicyVersion: input.resolutionEvidence.spanResolutionPolicyVersion,
        extractorLanguageImplementationVersion:
            input.resolutionEvidence.extractorLanguageImplementationVersion,
        resolutionDerivation: input.resolutionEvidence.resolutionDerivation,
    };
}

async function resolveSourceSpan(input: {
    snapshot: PreparedSymbolContextSnapshot;
    persistedSymbol: SymbolRecord;
    evidence: Extract<PrepareInspectableSourceResult, { status: "available" }>["evidence"];
    resolveCurrentSpans: typeof validateCurrentSourceSymbolSpansFromEvidence;
}): Promise<{
    symbol?: SymbolRecord;
    spanResolution: Exclude<SourceSpanResolution, "not_requested">;
    continuationIdentity?: SourceContinuationIdentity;
    snapshotMatched: boolean;
}> {
    if (
        /^[a-f0-9]{64}$/.test(input.persistedSymbol.fileHash)
        && input.persistedSymbol.fileHash === input.evidence.observedHash
    ) {
        return {
            symbol: input.persistedSymbol,
            spanResolution: "index_snapshot_matched",
            continuationIdentity: snapshotMatchedContinuationIdentity({
                snapshot: input.snapshot,
                symbol: input.persistedSymbol,
            }),
            snapshotMatched: true,
        };
    }

    const fileSymbols = input.snapshot.registry.symbolsByFile.get(input.persistedSymbol.file) || [];
    const validation = await input.resolveCurrentSpans({
        symbols: fileSymbols,
        evidence: currentEvidenceFromInspectable(input.evidence),
    });
    const current = validation.validations.find(
        (candidate: CurrentSourceSymbolValidation) => (
            candidate.symbol.symbolInstanceId === input.persistedSymbol.symbolInstanceId
        ),
    );
    if (!current?.validated || current.match !== "matched") {
        return { spanResolution: "unavailable", snapshotMatched: false };
    }
    return {
        symbol: current.symbol,
        spanResolution: "current_symbol_validated",
        continuationIdentity: currentValidatedContinuationIdentity({
            snapshot: input.snapshot,
            symbol: current.symbol,
            observedHash: input.evidence.observedHash,
            resolutionEvidence: current.resolutionEvidence,
        }),
        snapshotMatched: false,
    };
}

function relationshipComposition(input: {
    requested: boolean;
    relationship: RelationshipEvidenceKind;
    snapshot: PreparedSymbolContextSnapshot;
    target: SymbolRecord;
}): RelationshipComposition {
    if (!input.requested) {
        return {
            relationship: input.relationship,
            requested: false,
            allEdges: [],
            availableCount: 0,
            limitations: [],
            suppressedCount: 0,
            suppressionNotes: [],
            status: "ok",
        };
    }
    if (input.snapshot.relationships.status === "unavailable") {
        return {
            relationship: input.relationship,
            requested: true,
            allEdges: [],
            availableCount: 0,
            limitations: [],
            suppressedCount: 0,
            suppressionNotes: [],
            status: "degraded",
            unavailable: projectRelationshipEvidence({
                status: "unavailable",
                relationship: input.relationship,
                reason: input.snapshot.relationships.reason,
            }),
        };
    }

    const preparedTraversal = input.relationship === "caller"
        ? input.snapshot.relationships.callers
        : input.snapshot.relationships.callees;
    const scopedEdges = preparedTraversal.edges.filter((edge) => (
        input.relationship === "caller"
            ? edge.dstSymbolId === input.target.symbolInstanceId
            : edge.srcSymbolId === input.target.symbolInstanceId
    ));
    const staticEdges = scopedEdges.filter((edge) => edge.kind !== "dynamic");
    const hasDynamicEdges = staticEdges.length !== scopedEdges.length;
    const fingerprint = buildRelationshipTraversalFingerprint({
        canonicalRoot: input.snapshot.canonicalRoot,
        targetSymbolInstanceId: input.target.symbolInstanceId,
        registryManifestIdentity: input.snapshot.registryManifestIdentity,
        relationshipManifestIdentity: input.snapshot.relationships.manifestIdentity,
        relationship: input.relationship,
        depth: 1,
    });
    const ordered = paginateRelationshipEdges({
        edges: staticEdges,
        traversalFingerprint: fingerprint.fingerprint,
        pageSize: Math.max(1, staticEdges.length),
    });
    return {
        relationship: input.relationship,
        requested: true,
        allEdges: ordered.edges,
        availableCount: Math.min(preparedTraversal.availableCount, ordered.availableCount),
        limitations: [
            ...(preparedTraversal.limitations || []),
            ...(hasDynamicEdges ? ["dynamic_relationship_continuation_ineligible" as const] : []),
        ],
        suppressedCount: preparedTraversal.suppressedCount,
        suppressionNotes: preparedTraversal.suppressionNotes.map((note) => ({ ...note })),
        status: input.snapshot.relationships.authority === "degraded" ? "degraded" : "ok",
        fingerprint,
    };
}

function projectRelationshipPage(input: {
    composition: RelationshipComposition;
    returnedCount: number;
    pageSize: number;
    cursor?: string;
    currentSiteFile?: string;
}): {
    projection: SymbolContextRelationshipProjection;
    continuation?: SymbolContextContinuation;
} {
    const value = input.composition;
    if (!value.requested) {
        return {
            projection: { status: "not_requested", relationship: value.relationship },
        };
    }
    if (value.unavailable) return { projection: value.unavailable };

    const page = paginateRelationshipEdges({
        edges: value.allEdges,
        traversalFingerprint: value.fingerprint?.fingerprint || "",
        pageSize: Math.max(1, input.returnedCount || 1),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const edges = input.returnedCount === 0 ? [] : page.edges;
    const truncated = input.returnedCount === 0
        ? value.availableCount > 0
        : !page.terminal;
    const siteStatusByFile = input.currentSiteFile
        ? new Map([[input.currentSiteFile, "current_source_validated" as const]])
        : undefined;
    const projection = projectRelationshipEvidence({
        status: value.status,
        relationship: value.relationship,
        edges,
        truncated,
        availableCount: value.availableCount,
        suppressedCount: value.suppressedCount,
        suppressionNotes: value.suppressionNotes,
        limitations: value.limitations,
        siteStatusByFile,
    });
    if (!truncated || edges.length === 0 || !value.fingerprint || !page.nextCursor) {
        return { projection };
    }
    return {
        projection,
        continuation: {
            kind: value.fingerprint.kind,
            domains: value.fingerprint.domains,
            fingerprint: value.fingerprint.fingerprint,
            cursor: page.nextCursor,
            pageSize: input.pageSize,
            terminal: false,
        },
    };
}

function sourceContinuation(
    source: SelectedSourceProjection,
    fingerprint: SourceContinuationFingerprint | undefined,
): SymbolContextContinuation | undefined {
    const firstOmission = source.omittedRanges[0];
    if (!source.truncated || !firstOmission || !fingerprint || source.status === "unavailable") {
        return undefined;
    }
    return {
        kind: "source_range",
        domains: fingerprint.domains,
        fingerprint: fingerprint.fingerprint,
        startLine: firstOmission.startLine,
        endLine: firstOmission.endLine,
    };
}

function buildBaseContext(input: {
    symbol: CanonicalSymbolIdentity;
    siblingsAvailable: number;
    source: SourceComposition;
    callers: ReturnType<typeof projectRelationshipPage>;
    callees: ReturnType<typeof projectRelationshipPage>;
    navigationAuthority: NavigationEvidenceAuthority;
    relationshipAuthority: RelationshipEvidenceAuthority | "not_requested";
}): ComposedSymbolContext {
    const sourceHandle = "selectionPolicyVersion" in input.source.source
        ? sourceContinuation(input.source.source, input.source.continuationFingerprint)
        : undefined;
    return {
        status: "ok",
        symbol: input.symbol,
        outline: {
            siblings: {
                items: [],
                returnedCount: 0,
                availableCount: input.siblingsAvailable,
                truncated: input.siblingsAvailable > 0,
            },
        },
        source: input.source.source,
        relationships: {
            callers: input.callers.projection,
            callees: input.callees.projection,
        },
        authority: {
            vector: "not_required",
            navigation: input.navigationAuthority,
            source: {
                freshness: input.source.freshness,
                spanResolution: input.source.spanResolution,
            },
            relationships: input.relationshipAuthority,
        },
        continuations: sourceHandle ? [sourceHandle] : [],
        limitations: [],
    };
}

function withSibling(context: ComposedSymbolContext, sibling: CanonicalSymbolIdentity): ComposedSymbolContext {
    const items = [...context.outline.siblings.items, sibling];
    return {
        ...context,
        outline: {
            siblings: {
                ...context.outline.siblings,
                items,
                returnedCount: items.length,
                truncated: items.length < context.outline.siblings.availableCount,
            },
        },
    };
}

function withRelationshipPage(input: {
    context: ComposedSymbolContext;
    relationship: RelationshipEvidenceKind;
    page: ReturnType<typeof projectRelationshipPage>;
}): ComposedSymbolContext {
    const relationshipKey = input.relationship === "caller" ? "callers" : "callees";
    const continuationKind = input.relationship === "caller" ? "caller_page" : "callee_page";
    return {
        ...input.context,
        relationships: {
            ...input.context.relationships,
            [relationshipKey]: input.page.projection,
        },
        continuations: [
            ...input.context.continuations.filter((entry) => entry.kind !== continuationKind),
            ...(input.page.continuation ? [input.page.continuation] : []),
        ],
    };
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value as Record<string, unknown>)) {
            deepFreeze(nested);
        }
    }
    return value;
}

function withRelationshipSiteCurrentness(
    context: ComposedSymbolContext,
    currentSourceFile?: string,
): ComposedSymbolContext {
    const project = (
        relationship: SymbolContextRelationshipProjection,
    ): SymbolContextRelationshipProjection => {
        if (
            relationship.status !== "ok"
            && relationship.status !== "degraded"
        ) return relationship;
        if (relationship.items.length === 0) return relationship;
        return {
            ...relationship,
            items: relationship.items.map((item) => ({
                ...item,
                sites: {
                    ...item.sites,
                    status: currentSourceFile
                        && item.sites.items.length > 0
                        && item.sites.items.every((site) => site.file === currentSourceFile)
                        ? "current_source_validated"
                        : "not_current_source_validated",
                },
            })),
        };
    };
    return {
        ...context,
        relationships: {
            callers: project(context.relationships.callers),
            callees: project(context.relationships.callees),
        },
    };
}

function withInvalidatedSource(input: {
    context: ComposedSymbolContext;
    indexedSymbol: CanonicalSymbolIdentity;
    status: "stale" | "unavailable";
    reason: InspectableSourceFailureReason;
    selectionCapabilities?: SourceSelectionCapabilities;
}): ComposedSymbolContext {
    return {
        ...withRelationshipSiteCurrentness(input.context),
        symbol: input.indexedSymbol,
        source: unavailableSource(input.status, input.reason, input.selectionCapabilities),
        authority: {
            ...input.context.authority,
            source: {
                freshness: input.status,
                spanResolution: "unavailable",
            },
        },
        continuations: input.context.continuations.filter((entry) => entry.kind !== "source_range"),
    };
}

async function composeSource(input: {
    request: ComposeSymbolContextInput;
    snapshot: PreparedSymbolContextSnapshot;
    persistedSymbol: SymbolRecord;
    prepareSource: typeof prepareInspectableSource;
    resolveCurrentSpans: typeof validateCurrentSourceSymbolSpansFromEvidence;
    reservedResponseBytesForSource(input: {
        symbol: SymbolRecord;
        freshness: SourceFreshness;
        spanResolution: SourceSpanResolution;
    }): number;
}): Promise<SourceComposition | ComposeSymbolContextResult> {
    if (!input.request.include.source) {
        return {
            source: { status: "not_requested" },
            freshness: "not_requested",
            spanResolution: "not_requested",
            snapshotMatched: false,
        };
    }

    let prepared: PrepareInspectableSourceResult;
    try {
        prepared = await input.prepareSource({
            codebaseRoot: input.snapshot.canonicalRoot,
            relativeFile: input.persistedSymbol.file,
            maxInspectableBytes: input.request.budgets.maxInspectableBytes,
        });
    } catch (error) {
        if (error instanceof PreparedAuthorityChangedError) {
            return { status: "stale", reason: "prepared_authority_changed" };
        }
        throw error;
    }
    if (prepared.status === "safety_error") {
        return prepared;
    }
    if (prepared.status !== "available") {
        if (input.request.continuation?.kind === "source_range") {
            return {
                status: "stale_continuation",
                reason: "continuation_identity_changed",
            };
        }
        return {
            source: unavailableSource(prepared.status, prepared.reason),
            freshness: prepared.status,
            spanResolution: "unavailable",
            snapshotMatched: false,
        };
    }

    let transferFinalizer = false;
    try {
        const resolution = await resolveSourceSpan({
            snapshot: input.snapshot,
            persistedSymbol: input.persistedSymbol,
            evidence: prepared.evidence,
            resolveCurrentSpans: input.resolveCurrentSpans,
        });
        if (!resolution.symbol || !resolution.continuationIdentity) {
            if (input.request.continuation?.kind === "source_range") {
                return {
                    status: "stale_continuation",
                    reason: "continuation_identity_changed",
                };
            }
            transferFinalizer = true;
            return {
                source: unavailableSource(
                    "unavailable",
                    "current_symbol_span_unavailable",
                    prepared.evidence.selectionCapabilities,
                ),
                freshness: "current_at_final_observation",
                spanResolution: "unavailable",
                snapshotMatched: false,
                validatedRelativeFile: prepared.evidence.relativeFile,
                selectionCapabilities: prepared.evidence.selectionCapabilities,
                finalizer: prepared.finalizer,
            };
        }
        const resolvedSymbol = resolution.symbol;
        const continuationIdentity = resolution.continuationIdentity;
        const reservedResponseBytes = input.reservedResponseBytesForSource({
            symbol: resolvedSymbol,
            freshness: "current_at_final_observation",
            spanResolution: resolution.spanResolution,
        });

        const continuationFingerprint = buildSourceContinuationFingerprint(
            continuationIdentity,
        );
        const requestedContinuation = input.request.continuation?.kind === "source_range"
            ? input.request.continuation
            : undefined;
        if (
            requestedContinuation
            && requestedContinuation.fingerprint !== continuationFingerprint.fingerprint
        ) {
            return {
                status: "stale_continuation",
                reason: "continuation_identity_changed",
            };
        }
        if (
            requestedContinuation
            && (
                requestedContinuation.startLine < resolvedSymbol.span.startLine
                || requestedContinuation.endLine > resolvedSymbol.span.endLine
            )
        ) {
            return {
                status: "stale_continuation",
                reason: "continuation_identity_changed",
            };
        }
        const selectionSpan = requestedContinuation
            ? {
                startLine: requestedContinuation.startLine,
                endLine: requestedContinuation.endLine,
            }
            : resolvedSymbol.span;
        const selectWithBudget = (maxSerializedSourceBytes: number) => selectBoundedSource({
            sourceBytes: prepared.evidence.sourceBytes,
            symbolSpan: selectionSpan,
            budgets: {
                ...input.request.budgets.source,
                maxSerializedSourceBytes,
            },
            capabilities: prepared.evidence.selectionCapabilities,
            ...(input.request.query ? { query: input.request.query } : {}),
        });
        const continuationBytesForSource = (source: SelectedSourceProjection): number => {
            const continuation = sourceContinuation(source, continuationFingerprint);
            return continuation ? serializedBytes([continuation]) - serializedBytes([]) : 0;
        };
        const selectMinimumRepresentableSource = (
            firstFailure?: Extract<ReturnType<typeof selectBoundedSource>, {
                status: "minimum_projection_exceeds_budget";
            }>,
        ): Extract<ReturnType<typeof selectBoundedSource>, { status: "selected" }> => {
            let requiredBytes = firstFailure?.minimumRequiredSerializedSourceBytes ?? 1;
            while (true) {
                const candidate = selectWithBudget(requiredBytes);
                if (candidate.status === "selected") return candidate;
                if (candidate.minimumRequiredSerializedSourceBytes <= requiredBytes) {
                    throw new Error("Bounded source selector did not converge on its minimum projection.");
                }
                requiredBytes = candidate.minimumRequiredSerializedSourceBytes;
            }
        };
        const minimumResourceLimit = (
            firstFailure?: Extract<ReturnType<typeof selectBoundedSource>, {
                status: "minimum_projection_exceeds_budget";
            }>,
        ): ComposeSymbolContextResult => {
            // The diagnostic is a retryable envelope size, not a lower-bound estimate.
            const minimum = selectMinimumRepresentableSource(firstFailure);
            return {
                status: "resource_limit",
                symbolId: resolvedSymbol.symbolInstanceId,
                minimumRequiredResponseBytes: reservedResponseBytes
                    + minimum.serializedSourceBytes
                    + continuationBytesForSource(minimum.source),
                hardResponseLimitBytes: input.request.budgets.maxSerializedResponseBytes,
            };
        };

        const maximumWithoutContinuation = Math.min(
            input.request.budgets.source.maxSerializedSourceBytes,
            input.request.budgets.maxSerializedResponseBytes - reservedResponseBytes,
        );
        let selection: Extract<ReturnType<typeof selectBoundedSource>, { status: "selected" }>;
        try {
            if (maximumWithoutContinuation < 1) return minimumResourceLimit();

            let selectionBudget = maximumWithoutContinuation;
            const visitedBudgets = new Set<number>();
            let fittingSelection: typeof selection | undefined;
            while (!visitedBudgets.has(selectionBudget)) {
                visitedBudgets.add(selectionBudget);
                const candidate = selectWithBudget(selectionBudget);
                if (candidate.status !== "selected") return minimumResourceLimit(candidate);

                const continuationBytes = continuationBytesForSource(candidate.source);
                const candidateBytes = reservedResponseBytes
                    + candidate.serializedSourceBytes
                    + continuationBytes;
                if (candidateBytes <= input.request.budgets.maxSerializedResponseBytes) {
                    if (
                        !fittingSelection
                        || candidate.serializedSourceBytes > fittingSelection.serializedSourceBytes
                    ) {
                        fittingSelection = candidate;
                    }
                }

                const nextBudget = Math.min(
                    input.request.budgets.source.maxSerializedSourceBytes,
                    input.request.budgets.maxSerializedResponseBytes
                        - reservedResponseBytes
                        - continuationBytes,
                );
                if (nextBudget < 1 || nextBudget === selectionBudget) break;
                selectionBudget = nextBudget;
            }
            if (!fittingSelection) return minimumResourceLimit();
            selection = fittingSelection;
        } catch (error) {
            if (error instanceof TypeError && /UTF-8|encoded data/i.test(error.message)) {
                transferFinalizer = true;
                return {
                    source: unavailableSource(
                        "unavailable",
                        "source_encoding_invalid",
                        prepared.evidence.selectionCapabilities,
                    ),
                    freshness: "current_at_final_observation",
                    spanResolution: resolution.spanResolution,
                    snapshotMatched: resolution.snapshotMatched,
                    validatedRelativeFile: prepared.evidence.relativeFile,
                    selectionCapabilities: prepared.evidence.selectionCapabilities,
                    finalizer: prepared.finalizer,
                };
            }
            throw error;
        }
        transferFinalizer = true;
        return {
            source: selection.source,
            freshness: "current_at_final_observation",
            spanResolution: resolution.spanResolution,
            continuationFingerprint,
            resolvedSymbol,
            snapshotMatched: resolution.snapshotMatched,
            validatedRelativeFile: prepared.evidence.relativeFile,
            selectionCapabilities: prepared.evidence.selectionCapabilities,
            finalizer: prepared.finalizer,
        };
    } finally {
        if (!transferFinalizer) {
            await prepared.finalizer.release();
        }
    }
}

export async function composeSymbolContext(
    input: ComposeSymbolContextInput,
    dependencies: SymbolContextComposerDependencies,
): Promise<ComposeSymbolContextResult> {
    validateBudgets(input.budgets);
    validateContinuationRequest(input);
    const prepared = await dependencies.prepareSnapshot({
        codebaseRoot: input.codebaseRoot,
        relativeFile: input.relativeFile,
        ...(input.symbolId ? { symbolId: input.symbolId } : {}),
        ...(input.symbolLabel ? { symbolLabel: input.symbolLabel } : {}),
    });
    if (prepared.status !== "ready") {
        return { status: "navigation_unavailable", reason: prepared.reason };
    }
    const snapshot = prepared.snapshot;
    const fileSymbols = snapshot.registry.symbolsByFile.get(input.relativeFile) || [];
    const exactMatches = findExactRegistrySymbols({
        symbols: fileSymbols,
        ...(input.symbolId ? { symbolIdExact: input.symbolId } : {}),
        ...(input.symbolLabel ? { symbolLabelExact: input.symbolLabel } : {}),
    });
    if (exactMatches.length === 0) {
        return { status: "symbol_not_found", reason: "No exact symbol matched the prepared registry." };
    }
    if (exactMatches.length > 1) {
        return { status: "ambiguous_symbol", reason: "The exact symbol label is ambiguous." };
    }

    const persistedSymbol = exactMatches[0];
    const registryView = snapshot.registry.symbolsByKey as CanonicalSymbolRegistryView;
    const symbol = projectCanonicalSymbolIdentity({
        symbol: persistedSymbol,
        registry: registryView,
    });
    const allSiblings = input.include.siblings
        ? projectSiblings({
            target: persistedSymbol,
            registry: registryView,
            allSymbols: fileSymbols,
        })
        : [];
    const siblings = allSiblings.slice(0, input.budgets.maxSiblings);

    const relationshipAuthority = input.include.callers || input.include.callees
        ? snapshot.relationships.authority
        : "not_requested";
    const provisionalSource: SourceComposition = input.include.source
        ? {
            source: unavailableSource("unavailable", "current_symbol_span_unavailable"),
            freshness: "unavailable",
            spanResolution: "unavailable",
            snapshotMatched: false,
        }
        : {
            source: { status: "not_requested" },
            freshness: "not_requested",
            spanResolution: "not_requested",
            snapshotMatched: false,
        };
    const provisionalCallers = relationshipComposition({
        requested: input.include.callers,
        relationship: "caller",
        snapshot,
        target: persistedSymbol,
    });
    const provisionalCallees = relationshipComposition({
        requested: input.include.callees,
        relationship: "callee",
        snapshot,
        target: persistedSymbol,
    });
    const emptyCallers = projectRelationshipPage({
        composition: provisionalCallers,
        returnedCount: 0,
        pageSize: input.budgets.maxEdgesPerDirection,
    });
    const emptyCallees = projectRelationshipPage({
        composition: provisionalCallees,
        returnedCount: 0,
        pageSize: input.budgets.maxEdgesPerDirection,
    });
    const reservedResponseBytesForSource = (resolvedSource: {
        symbol: SymbolRecord;
        freshness: SourceFreshness;
        spanResolution: SourceSpanResolution;
    }): number => {
        // Current coordinates and authority labels can be wider than the indexed placeholders.
        const resolvedIdentity = projectCanonicalSymbolIdentity({
            symbol: resolvedSource.symbol,
            registry: registryView,
        });
        const budgetedSource: SourceComposition = {
            ...provisionalSource,
            freshness: resolvedSource.freshness,
            spanResolution: resolvedSource.spanResolution,
        };
        const sourceBudgetSkeleton: ComposedSymbolContext = {
            ...buildBaseContext({
                symbol: resolvedIdentity,
                siblingsAvailable: allSiblings.length,
                source: budgetedSource,
                callers: emptyCallers,
                callees: emptyCallees,
                navigationAuthority: snapshot.navigationAuthority,
                relationshipAuthority,
            }),
            source: null as unknown as SymbolContextSourceProjection,
            continuations: [],
        };
        return serializedBytes(sourceBudgetSkeleton) - serializedBytes(null);
    };
    const sourceResult = await composeSource({
        request: input,
        snapshot,
        persistedSymbol,
        prepareSource: dependencies.prepareSource || prepareInspectableSource,
        resolveCurrentSpans: dependencies.resolveCurrentSpans
            || validateCurrentSourceSymbolSpansFromEvidence,
        reservedResponseBytesForSource,
    });
    if ("status" in sourceResult && (
        sourceResult.status === "stale"
        || sourceResult.status === "stale_continuation"
        || sourceResult.status === "safety_error"
        || sourceResult.status === "resource_limit"
    )) {
        return sourceResult;
    }
    const source = sourceResult as SourceComposition;
    const resolvedIdentity = source.resolvedSymbol
        ? projectCanonicalSymbolIdentity({
            symbol: source.resolvedSymbol,
            registry: registryView,
        })
        : symbol;

    const callers = relationshipComposition({
        requested: input.include.callers,
        relationship: "caller",
        snapshot,
        target: persistedSymbol,
    });
    const callees = relationshipComposition({
        requested: input.include.callees,
        relationship: "callee",
        snapshot,
        target: persistedSymbol,
    });
    let context = buildBaseContext({
        symbol: resolvedIdentity,
        siblingsAvailable: allSiblings.length,
        source,
        callers: projectRelationshipPage({
            composition: callers,
            returnedCount: 0,
            pageSize: input.budgets.maxEdgesPerDirection,
        }),
        callees: projectRelationshipPage({
            composition: callees,
            returnedCount: 0,
            pageSize: input.budgets.maxEdgesPerDirection,
        }),
        navigationAuthority: snapshot.navigationAuthority,
        relationshipAuthority,
    });
    if (serializedBytes(context) > input.budgets.maxSerializedResponseBytes) {
        return {
            status: "resource_limit",
            symbolId: resolvedIdentity.symbolId,
            minimumRequiredResponseBytes: serializedBytes(context),
            hardResponseLimitBytes: input.budgets.maxSerializedResponseBytes,
        };
    }

    const relationshipContinuation = input.continuation?.kind === "caller_page"
        || input.continuation?.kind === "callee_page"
        ? input.continuation
        : undefined;
    if (relationshipContinuation) {
        const composition = relationshipContinuation.kind === "caller_page"
            ? callers
            : callees;
        if (
            !composition.fingerprint
            || composition.fingerprint.fingerprint !== relationshipContinuation.fingerprint
        ) {
            return {
                status: "stale_continuation",
                reason: "continuation_identity_changed",
            };
        }
        let page: ReturnType<typeof projectRelationshipPage>;
        try {
            page = projectRelationshipPage({
                composition,
                returnedCount: relationshipContinuation.pageSize,
                pageSize: relationshipContinuation.pageSize,
                cursor: relationshipContinuation.cursor,
            });
        } catch (error) {
            if (error instanceof InvalidRelationshipContinuationError) {
                return {
                    status: "invalid_relationship_continuation",
                    reason: "cursor_invalid_for_prepared_traversal",
                };
            }
            throw error;
        }
        context = withRelationshipPage({
            context,
            relationship: composition.relationship,
            page,
        });
        if (serializedBytes(context) > input.budgets.maxSerializedResponseBytes) {
            return {
                status: "resource_limit",
                symbolId: resolvedIdentity.symbolId,
                minimumRequiredResponseBytes: serializedBytes(context),
                hardResponseLimitBytes: input.budgets.maxSerializedResponseBytes,
            };
        }
        if (!await snapshot.validateAuthority()) {
            return { status: "stale", reason: "prepared_authority_changed" };
        }
        return {
            status: "ok",
            context: deepFreeze({
                ...context,
                continuations: [...context.continuations],
            }),
        };
    }

    for (const sibling of siblings) {
        const candidate = withSibling(context, sibling);
        if (serializedBytes(candidate) > input.budgets.maxSerializedResponseBytes) break;
        context = candidate;
    }

    for (const composition of [callers, callees]) {
        const maximum = Math.min(
            composition.availableCount,
            input.budgets.maxEdgesPerDirection,
        );
        for (let returnedCount = 1; returnedCount <= maximum; returnedCount += 1) {
            const page = projectRelationshipPage({
                composition,
                returnedCount,
                pageSize: input.budgets.maxEdgesPerDirection,
            });
            const candidate = withRelationshipPage({
                context,
                relationship: composition.relationship,
                page,
            });
            if (serializedBytes(candidate) > input.budgets.maxSerializedResponseBytes) break;
            context = candidate;
        }
    }

    if (!source.finalizer) {
        if (!await snapshot.validateAuthority()) {
            return { status: "stale", reason: "prepared_authority_changed" };
        }
        return {
            status: "ok",
            context: deepFreeze({
                ...context,
                continuations: [...context.continuations],
            }),
        };
    }

    try {
        let finalObservation: Awaited<ReturnType<InspectableSourceFinalizer["finalize"]>>;
        try {
            finalObservation = await source.finalizer.finalize({
                validatePreparedAuthority: async () => {
                    if (!await snapshot.validateAuthority()) {
                        throw new PreparedAuthorityChangedError();
                    }
                },
            });
        } catch (error) {
            if (error instanceof PreparedAuthorityChangedError) {
                return { status: "stale", reason: "prepared_authority_changed" };
            }
            throw error;
        }
        if (finalObservation.status === "safety_error") {
            return finalObservation;
        }
        const finalContext = finalObservation.status === "available"
            ? withRelationshipSiteCurrentness(
                context,
                source.snapshotMatched ? source.validatedRelativeFile : undefined,
            )
            : withInvalidatedSource({
                context,
                indexedSymbol: symbol,
                status: finalObservation.status,
                reason: finalObservation.reason,
                selectionCapabilities: source.selectionCapabilities,
            });
        return {
            status: "ok",
            context: deepFreeze({
                ...finalContext,
                continuations: [...finalContext.continuations],
            }),
        };
    } finally {
        await source.finalizer.release();
    }
}
