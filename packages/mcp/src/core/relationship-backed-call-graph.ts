import {
    compareContractStrings,
    getGraphNeighbors,
    getRelationshipsForSymbol,
    isTestOrFixturePath,
    JsonNavigationStore,
    summarizeResolutionConstructCoverage,
    type NavigationResolutionEvidenceMatch,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import type {
    CallGraphDirection,
    CallGraphEdgeResult as CallGraphEdge,
    CallGraphExactReferenceResult as CallGraphExactReference,
    CallGraphNodeResult as CallGraphNode,
    CallGraphNoteResult as CallGraphNote,
    CallGraphSourceReferenceResult as CallGraphSourceReference,
    CallGraphTestReferenceResult as CallGraphTestReference,
    InboundCoverageEvidence,
    InboundCoverageReason,
} from "./search-types.js";
import {
    buildSourceBackedPythonCalleeFallback,
    buildSourceBackedPythonCallerFallback,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import type { ExactReferenceSearchResult } from "./exact-reference-search.js";
import {
    matchesPublishedPathScope,
    type PublishedPathScope,
} from "./navigation-path-scope.js";
import { buildInboundVerificationSearchQuery } from "./search-response-helpers.js";

type RelationshipBackedCallGraphHost = {
    navigationStore: JsonNavigationStore;
};

export type RelationshipBackedCallGraphInput = {
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
    /**
     * Publication-authorized source reader for the Python source-backed
     * fallback. When absent the dynamic fallback is SKIPPED entirely (no
     * edges from source reconstruction, never a legacy pathname read).
     * The navigation tool boundary always supplies it; other callers that
     * cannot bind a session policy therefore fail closed by losing the
     * dynamic fallback rather than reading unauthenticated source.
     */
    readAuthorizedSourceLines?: (codebaseRoot: string, relativeFilePath: string) => Promise<string[] | undefined>;
    findExactSourceReferences?: (target: SymbolRecord) => Promise<ExactReferenceSearchResult>;
};

export type CallGraphNavigationAuthority = Readonly<{
    publicationId: string;
    relationshipManifestSha256: string;
    relationshipBuiltAt: string;
    publicationCompletedAt: string;
}>;

/**
 * Resolve the serving Publication navigation attribution for a call-graph
 * traversal. Attribution is emitted only when the complete identity is
 * known: Publication identity, relationship manifest, the
 * relationship artifact build time, and publication completion time. Partial
 * evidence yields no attribution rather than a guessed one.
 */
export function resolveCallGraphNavigationAuthority(input: {
    publicationId: string | undefined;
    relationshipManifestHash: string | undefined;
    relationshipBuiltAt: string | undefined;
    publicationCompletedAt: string | undefined;
}): CallGraphNavigationAuthority | null {
    if (
        !input.publicationId
        || !input.relationshipManifestHash
        || !input.relationshipBuiltAt
        || !input.publicationCompletedAt
    ) {
        return null;
    }
    return Object.freeze({
        publicationId: input.publicationId,
        relationshipManifestSha256: input.relationshipManifestHash,
        relationshipBuiltAt: input.relationshipBuiltAt,
        publicationCompletedAt: input.publicationCompletedAt,
    });
}

export type RelationshipBackedCallGraphResult = {
    supported: true;
    direction: CallGraphDirection;
    depth: number;
    limit: number;
    nodes: CallGraphNode[];
    edges: CallGraphEdge[];
    notes: CallGraphNote[];
    warnings?: string[];
    exactReferences?: CallGraphExactReference[];
    sourceReferences?: CallGraphSourceReference[];
    sourceReferenceCoverage?: ExactReferenceSearchResult["coverage"];
    constructCoverage?: import("@zokizuan/satori-core").ResolutionConstructCoverage[];
    testReferences?: CallGraphTestReference[];
    notesTruncated: boolean;
    totalNoteCount: number;
    returnedNoteCount: number;
    graph: {
        builtAt: string;
        nodeCount: number;
        edgeCount: number;
    };
    hints?: Record<string, unknown>;
    inboundCoverageEvidence?: InboundCoverageEvidence;
};

/**
 * Deterministic precedence for the empty-inbound coverage reason. Kept as a
 * pure function so every branch is testable independently of the traversal.
 */
export function resolveInboundCoverageReason(input: {
    suppressedRelationshipCount: number;
    nonAuthoritativeReferenceCount: number;
    fallbackAttempted: boolean;
    fallbackRecoveredCount: number;
    sourceReferenceCount?: number;
    traversalBounded?: boolean;
}): InboundCoverageReason {
    if (input.nonAuthoritativeReferenceCount > 0) {
        return "non_authoritative_resolution_evidence";
    }
    if ((input.sourceReferenceCount ?? 0) > 0) {
        return "observational_source_references";
    }
    if (input.traversalBounded) {
        return "bounded_relationship_navigation";
    }
    if (input.suppressedRelationshipCount > 0 && input.fallbackRecoveredCount === 0) {
        return input.fallbackAttempted
            ? "fallback_failed"
            : "suppressed_low_confidence";
    }
    return "no_relationships_extracted";
}

function compareNullableNumbersAsc(a?: number | null, b?: number | null): number {
    const left = typeof a === "number" ? a : Number.POSITIVE_INFINITY;
    const right = typeof b === "number" ? b : Number.POSITIVE_INFINITY;
    return left - right;
}

function compareNullableStringsAsc(a?: string | null, b?: string | null): number {
    const left = typeof a === "string" ? a : "";
    const right = typeof b === "string" ? b : "";
    return compareContractStrings(left, right);
}

/**
 * Prefer a single unique suppressed inbound caller *site* file for recovery search.
 * Prefer production files when both production and test sites exist.
 * Never use the callee defining file when sites disagree or are multi-file.
 */
export function uniqueInboundCallerSiteFile(notes: readonly CallGraphNote[]): string | undefined {
    const productionSites = new Set<string>();
    const allSites = new Set<string>();
    for (const note of notes) {
        if (note.type !== "suppressed_edge") {
            continue;
        }
        if (typeof note.detail !== "string" || !note.detail.includes("caller candidate")) {
            continue;
        }
        const file = typeof note.file === "string" ? note.file.trim() : "";
        if (!file || file === "(aggregate)") {
            continue;
        }
        allSites.add(file);
        if (!isTestOrFixturePath(file)) {
            productionSites.add(file);
        }
    }
    const preferred = productionSites.size > 0 ? productionSites : allSites;
    if (preferred.size !== 1) {
        return undefined;
    }
    return [...preferred][0];
}

function hasPublishedPathScope(scope: PublishedPathScope | undefined): scope is PublishedPathScope {
    return Boolean(
        scope?.subtree
        || (scope?.includePaths?.length ?? 0) > 0
        || (scope?.excludePaths?.length ?? 0) > 0
    );
}

function relationshipWithinPathScope(
    record: RelationshipRecord,
    registry: SymbolRegistry,
    scope: PublishedPathScope | undefined,
): boolean {
    if (!hasPublishedPathScope(scope)) return true;
    if (!matchesPublishedPathScope(record.file, scope)) return false;
    if (record.sourceInstanceId) {
        const source = registry.symbolsByInstanceId.get(record.sourceInstanceId);
        if (!source || !matchesPublishedPathScope(source.file, scope)) return false;
    }
    if (record.targetInstanceId) {
        const target = registry.symbolsByInstanceId.get(record.targetInstanceId);
        if (!target || !matchesPublishedPathScope(target.file, scope)) return false;
    }
    return true;
}

function resolutionEvidenceWithinPathScope(
    match: NavigationResolutionEvidenceMatch,
    registry: SymbolRegistry,
    scope: PublishedPathScope | undefined,
): boolean {
    if (!hasPublishedPathScope(scope)) return true;
    if (!matchesPublishedPathScope(match.claim.sourceFile, scope)) return false;
    if (
        match.matchKind === "source_call"
        && match.claim.decision === "resolved"
        && match.claim.targetInstanceId
    ) {
        const target = registry.symbolsByInstanceId.get(match.claim.targetInstanceId);
        if (!target || !matchesPublishedPathScope(target.file, scope)) return false;
    }
    return true;
}

const MAX_DETAILED_TEST_SUPPRESSED_CALLER_NOTES = 3;
const INBOUND_COVERAGE_PARTIAL_WARNING = "CALL_GRAPH_INBOUND_COVERAGE_PARTIAL";

export function shouldInspectInboundSourceReferences(input: {
    direction: CallGraphDirection;
    hasNoInboundEdges: boolean;
    suppressedInboundCount: number;
    warnings: readonly string[];
}): boolean {
    const inboundRequested = input.direction === "callers" || input.direction === "both";
    if (!inboundRequested) return false;
    return input.hasNoInboundEdges
        || input.suppressedInboundCount > 0
        || input.warnings.some((warning) => (
            warning === "RELATIONSHIP_TRAVERSAL_LIMIT_REACHED"
            || warning === "RELATIONSHIP_TRAVERSAL_TRUNCATED"
        ));
}

/**
 * Production suppressed callers first; collapse excess test/fixture caller notes into one summary.
 */
export function prioritizeInboundSuppressedNotes(notes: readonly CallGraphNote[]): CallGraphNote[] {
    const productionCallerNotes: CallGraphNote[] = [];
    const testCallerNotes: CallGraphNote[] = [];
    const otherNotes: CallGraphNote[] = [];

    for (const note of notes) {
        const isCallerSuppressed = note.type === "suppressed_edge"
            && typeof note.detail === "string"
            && note.detail.includes("caller candidate");
        if (!isCallerSuppressed) {
            otherNotes.push(note);
            continue;
        }
        const file = typeof note.file === "string" ? note.file : "";
        if (isTestOrFixturePath(file)) {
            testCallerNotes.push(note);
        } else {
            productionCallerNotes.push(note);
        }
    }

    const keptTestNotes = testCallerNotes.slice(0, MAX_DETAILED_TEST_SUPPRESSED_CALLER_NOTES);
    const collapsedTestCount = testCallerNotes.length - keptTestNotes.length;
    const summaryNotes: CallGraphNote[] = collapsedTestCount > 0
        ? [{
            type: "suppressed_edge",
            file: "(aggregate)",
            startLine: 0,
            confidence: 0.35,
            detail: `Suppressed ${collapsedTestCount} additional low-confidence test/fixture caller candidate(s); prefer production callers and must: recovery search for call sites.`,
        }]
        : [];

    return [...productionCallerNotes, ...keptTestNotes, ...summaryNotes, ...otherNotes];
}

export class RelationshipBackedCallGraph {
    constructor(private readonly host: RelationshipBackedCallGraphHost) {}

    private sortNodes(nodes: CallGraphNode[]): CallGraphNode[] {
        return [...nodes].sort((a, b) => {
            const fileCmp = compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            return compareNullableStringsAsc(a.symbolId, b.symbolId);
        });
    }

    private compareEdges(a: CallGraphEdge, b: CallGraphEdge): number {
        const srcCmp = compareNullableStringsAsc(a.srcSymbolId, b.srcSymbolId);
        if (srcCmp !== 0) return srcCmp;
        const dstCmp = compareNullableStringsAsc(a.dstSymbolId, b.dstSymbolId);
        if (dstCmp !== 0) return dstCmp;
        const kindCmp = compareNullableStringsAsc(a.kind, b.kind);
        if (kindCmp !== 0) return kindCmp;
        const fileCmp = compareNullableStringsAsc(a.site?.file, b.site?.file);
        if (fileCmp !== 0) return fileCmp;
        return compareNullableNumbersAsc(a.site?.startLine, b.site?.startLine);
    }

    private sortEdges(edges: CallGraphEdge[]): CallGraphEdge[] {
        return [...edges].sort((a, b) => this.compareEdges(a, b));
    }

    private sortExactReferences(references: CallGraphExactReference[]): CallGraphExactReference[] {
        return [...references].sort((a, b) => {
            const fileCmp = compareNullableStringsAsc(a.site.file, b.site.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = compareNullableNumbersAsc(a.site.startLine, b.site.startLine);
            if (startCmp !== 0) return startCmp;
            const relationshipCmp = compareNullableStringsAsc(a.relationship, b.relationship);
            if (relationshipCmp !== 0) return relationshipCmp;
            const decisionCmp = compareNullableStringsAsc(a.decision, b.decision);
            if (decisionCmp !== 0) return decisionCmp;
            return compareNullableStringsAsc(a.calleeText, b.calleeText);
        });
    }

    private buildExactReferences(input: {
        matches: readonly NavigationResolutionEvidenceMatch[];
        relationship: "caller" | "callee";
        registry: SymbolRegistry;
        pathScope?: PublishedPathScope;
        targetSymbolId?: string;
    }): CallGraphExactReference[] {
        const references = input.matches.map(({ claim, matchKind }): CallGraphExactReference => {
            const source = claim.sourceInstanceId
                ? input.registry.symbolsByInstanceId.get(claim.sourceInstanceId)
                : undefined;
            const scopedSource = source && (
                !hasPublishedPathScope(input.pathScope)
                || matchesPublishedPathScope(source.file, input.pathScope)
            )
                ? source
                : undefined;
            return {
                relationship: input.relationship,
                matchKind,
                decision: claim.decision,
                resolutionAuthority: claim.resolutionAuthority,
                construct: claim.observation.construct,
                providerId: claim.providerId,
                providerVersion: claim.providerVersion,
                ...(scopedSource ? { sourceSymbolId: scopedSource.symbolInstanceId } : {}),
                ...(scopedSource?.label ? { sourceSymbolLabel: scopedSource.label } : {}),
                ...(input.targetSymbolId
                    ? { targetSymbolId: input.targetSymbolId }
                    : claim.targetInstanceId
                        ? { targetSymbolId: claim.targetInstanceId }
                        : {}),
                calleeName: claim.observation.calleeName,
                calleeText: claim.observation.calleeText,
                site: {
                    file: claim.sourceFile,
                    startLine: claim.callSpan.startLine,
                    ...(claim.callSpan.endLine !== claim.callSpan.startLine
                        ? { endLine: claim.callSpan.endLine }
                        : {}),
                    startColumn: claim.callSpan.startColumn,
                    endColumn: claim.callSpan.endColumn,
                },
                candidates: claim.observation.candidates
                    .filter((candidate) => !hasPublishedPathScope(input.pathScope)
                        || matchesPublishedPathScope(candidate.file, input.pathScope))
                    .map((candidate) => ({
                        ...(candidate.symbolInstanceId ? { symbolId: candidate.symbolInstanceId } : {}),
                        ...(candidate.qualifiedName ? { qualifiedName: candidate.qualifiedName } : {}),
                        name: candidate.name,
                        file: candidate.file,
                        span: {
                            startLine: candidate.span.startLine,
                            endLine: candidate.span.endLine,
                        },
                    })),
            };
        });
        return this.sortExactReferences(references);
    }

    private sortTestReferences(references: CallGraphTestReference[]): CallGraphTestReference[] {
        return [...references].sort((a, b) => {
            const fileCmp = compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = compareNullableNumbersAsc(a.span?.startLine, b.span?.startLine);
            if (startCmp !== 0) return startCmp;
            const labelCmp = compareNullableStringsAsc(a.symbolLabel, b.symbolLabel);
            if (labelCmp !== 0) return labelCmp;
            const symbolCmp = compareNullableStringsAsc(a.symbolId, b.symbolId);
            if (symbolCmp !== 0) return symbolCmp;
            const targetCmp = compareNullableStringsAsc(a.targetSymbolId, b.targetSymbolId);
            if (targetCmp !== 0) return targetCmp;
            const siteFileCmp = compareNullableStringsAsc(a.site?.file, b.site?.file);
            if (siteFileCmp !== 0) return siteFileCmp;
            return compareNullableNumbersAsc(a.site?.startLine, b.site?.startLine);
        });
    }

    private buildTestReferences(
        records: readonly RelationshipRecord[],
        registry: SymbolRegistry,
        targetSymbolId: string,
    ): CallGraphTestReference[] {
        const referencesByKey = new Map<string, CallGraphTestReference>();
        for (const record of records) {
            if (
                record.type !== "TESTS"
                || !record.sourceInstanceId
                || record.targetInstanceId !== targetSymbolId
            ) {
                continue;
            }
            const source = registry.symbolsByInstanceId.get(record.sourceInstanceId);
            if (!source) {
                continue;
            }
            const startLine = record.span?.startLine ?? source.span.startLine;
            const reference: CallGraphTestReference = {
                file: source.file,
                symbolId: source.symbolInstanceId,
                symbolLabel: source.label,
                span: {
                    startLine: source.span.startLine,
                    endLine: source.span.endLine,
                },
                site: {
                    file: record.file,
                    startLine,
                    ...(record.span?.endLine ? { endLine: record.span.endLine } : {}),
                },
                targetSymbolId,
                kind: "call",
                confidence: this.mapRelationshipConfidence(record.confidence),
            };
            const key = [
                reference.symbolId,
                reference.targetSymbolId,
                reference.kind,
                reference.site.file,
                reference.site.startLine,
            ].join("\0");
            referencesByKey.set(key, reference);
        }
        return this.sortTestReferences([...referencesByKey.values()]);
    }

    private sortNotes(notes: CallGraphNote[]): CallGraphNote[] {
        return [...notes].sort((a, b) => {
            const fileCmp = compareNullableStringsAsc(a.file, b.file);
            if (fileCmp !== 0) return fileCmp;
            const startCmp = compareNullableNumbersAsc(a.startLine, b.startLine);
            if (startCmp !== 0) return startCmp;
            const typeCmp = compareNullableStringsAsc(a.type, b.type);
            if (typeCmp !== 0) return typeCmp;
            const symbolCmp = compareNullableStringsAsc(a.symbolId, b.symbolId);
            if (symbolCmp !== 0) return symbolCmp;
            return compareNullableStringsAsc(a.detail, b.detail);
        });
    }

    private mapRelationshipConfidence(confidence: "high" | "medium" | "low"): number {
        switch (confidence) {
            case "high":
                return 0.95;
            case "medium":
                return 0.65;
            case "low":
            default:
                return 0.35;
        }
    }

    private createNode(symbol: SymbolRecord): CallGraphNode {
        return {
            symbolId: symbol.symbolInstanceId,
            symbolLabel: symbol.label,
            file: symbol.file,
            language: symbol.language,
            span: {
                startLine: symbol.span.startLine,
                endLine: symbol.span.endLine,
            },
        };
    }

    private buildSuppressedNotes(input: {
        resolvedSymbol: SymbolRecord;
        suppressedRecords: RelationshipRecord[];
        registry: SymbolRegistry;
    }): CallGraphNote[] {
        const notes = input.suppressedRecords.flatMap((record) => {
            if (!record.sourceInstanceId || !record.targetInstanceId) {
                return [];
            }

            const source = record.sourceInstanceId === input.resolvedSymbol.symbolInstanceId
                ? input.resolvedSymbol
                : input.registry.symbolsByInstanceId.get(record.sourceInstanceId);
            const target = record.targetInstanceId === input.resolvedSymbol.symbolInstanceId
                ? input.resolvedSymbol
                : input.registry.symbolsByInstanceId.get(record.targetInstanceId);
            const siteStartLine = record.span?.startLine || source?.span.startLine || input.resolvedSymbol.span.startLine;
            const siteLocation = `${record.file}:${siteStartLine}`;
            const confidence = this.mapRelationshipConfidence(record.confidence);

            if (record.sourceInstanceId === input.resolvedSymbol.symbolInstanceId) {
                const label = target?.label || target?.qualifiedName || target?.name || record.targetInstanceId;
                return [{
                    type: "suppressed_edge" as const,
                    file: record.file,
                    startLine: siteStartLine,
                    symbolId: record.targetInstanceId,
                    ...(target?.label ? { symbolLabel: target.label } : {}),
                    confidence,
                    detail: `Suppressed low-confidence callee candidate ${label} at ${siteLocation}.`,
                }];
            }

            if (record.targetInstanceId === input.resolvedSymbol.symbolInstanceId) {
                const label = source?.label || source?.qualifiedName || source?.name || record.sourceInstanceId;
                return [{
                    type: "suppressed_edge" as const,
                    file: record.file,
                    startLine: siteStartLine,
                    symbolId: record.sourceInstanceId,
                    ...(source?.label ? { symbolLabel: source.label } : {}),
                    confidence,
                    detail: `Suppressed low-confidence caller candidate ${label} at ${siteLocation}.`,
                }];
            }

            const sourceLabel = source?.label || source?.qualifiedName || source?.name || record.sourceInstanceId;
            const targetLabel = target?.label || target?.qualifiedName || target?.name || record.targetInstanceId;
            return [{
                type: "suppressed_edge" as const,
                file: record.file,
                startLine: siteStartLine,
                confidence,
                detail: `Suppressed low-confidence relationship candidate ${sourceLabel} -> ${targetLabel} at ${siteLocation}.`,
            }];
        });

        return this.sortNotes(notes);
    }

    public async build(input: RelationshipBackedCallGraphInput): Promise<RelationshipBackedCallGraphResult | null> {
        const neighbors = await getGraphNeighbors({
            normalizedRootPath: input.codebaseRoot,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            expectedSymbolRegistryManifestHash: input.registryManifestHash,
            navigationStore: this.host.navigationStore,
            symbolInstanceId: input.resolvedSymbol.symbolInstanceId,
            depth: input.depth,
            direction: input.direction,
            allowedTypes: ["CALLS"],
            ...(hasPublishedPathScope(input.pathScope)
                ? {
                    recordFilter: (record: RelationshipRecord) => (
                        relationshipWithinPathScope(record, input.registry, input.pathScope)
                    ),
                }
                : {}),
            limit: input.limit,
        });
        if (neighbors.status !== "ok") {
            return null;
        }
        const [testRelationshipResult, sourceCallRelationshipResult] = await Promise.all([
            getRelationshipsForSymbol({
                normalizedRootPath: input.codebaseRoot,
                publicationId: input.publicationId,
                navigationRoot: input.navigationRoot,
                expectedSymbolRegistryManifestHash: input.registryManifestHash,
                navigationStore: this.host.navigationStore,
                targetInstanceId: input.resolvedSymbol.symbolInstanceId,
                direction: "callers",
                types: ["TESTS"],
            }),
            getRelationshipsForSymbol({
                normalizedRootPath: input.codebaseRoot,
                publicationId: input.publicationId,
                navigationRoot: input.navigationRoot,
                expectedSymbolRegistryManifestHash: input.registryManifestHash,
                navigationStore: this.host.navigationStore,
                sourceInstanceId: input.resolvedSymbol.symbolInstanceId,
                direction: "callees",
                types: ["CALLS"],
            }),
        ]);
        if (testRelationshipResult.status !== "ok" || sourceCallRelationshipResult.status !== "ok") {
            return null;
        }
        const scopedTestRelationships = testRelationshipResult.records.filter((record) => (
            relationshipWithinPathScope(record, input.registry, input.pathScope)
        ));
        const scopedSourceCallRelationships = sourceCallRelationshipResult.records.filter((record) => (
            relationshipWithinPathScope(record, input.registry, input.pathScope)
        ));
        const testReferences = this.buildTestReferences(
            scopedTestRelationships,
            input.registry,
            input.resolvedSymbol.symbolInstanceId,
        );
        const [sourceEvidence, inboundEvidence] = await Promise.all([
            this.host.navigationStore.getResolutionEvidence({
                normalizedRootPath: input.codebaseRoot,
                publicationId: input.publicationId,
                navigationRoot: input.navigationRoot,
                expectedSymbolRegistryManifestHash: input.registryManifestHash,
                sourceInstanceId: input.resolvedSymbol.symbolInstanceId,
            }),
            this.host.navigationStore.getResolutionEvidence({
                normalizedRootPath: input.codebaseRoot,
                publicationId: input.publicationId,
                navigationRoot: input.navigationRoot,
                expectedSymbolRegistryManifestHash: input.registryManifestHash,
                symbolInstanceId: input.resolvedSymbol.symbolInstanceId,
                symbolQualifiedName: input.resolvedSymbol.qualifiedName,
            }),
        ]);
        if (sourceEvidence.status !== "ok" || inboundEvidence.status !== "ok") {
            return null;
        }
        const sourceEvidenceMatches = sourceEvidence.matches.filter((match) => (
            resolutionEvidenceWithinPathScope(match, input.registry, input.pathScope)
        ));
        const inboundEvidenceMatches = inboundEvidence.matches.filter((match) => (
            resolutionEvidenceWithinPathScope(match, input.registry, input.pathScope)
        ));
        const outboundExactReferences = (input.direction === "callees" || input.direction === "both")
            ? this.buildExactReferences({
                matches: sourceEvidenceMatches,
                relationship: "callee",
                registry: input.registry,
                pathScope: input.pathScope,
            })
            : [];
        const inboundExactReferences = (input.direction === "callers" || input.direction === "both")
            ? this.buildExactReferences({
                matches: inboundEvidenceMatches,
                relationship: "caller",
                registry: input.registry,
                pathScope: input.pathScope,
                targetSymbolId: input.resolvedSymbol.symbolInstanceId,
            })
            : [];
        const exactReferences = this.sortExactReferences([
            ...outboundExactReferences,
            ...inboundExactReferences,
        ]);
        const constructCoverage = summarizeResolutionConstructCoverage(
            sourceEvidenceMatches.map((match) => match.claim),
            {
                gapLimit: Number.MAX_SAFE_INTEGER,
                relationships: scopedSourceCallRelationships,
            },
        );

        const suppressedLowConfidenceRecords = neighbors.suppressedLowConfidenceRecords || [];
        const resolveNodeSymbol = (symbolInstanceId: string): SymbolRecord | undefined => (
            symbolInstanceId === input.resolvedSymbol.symbolInstanceId
                ? input.resolvedSymbol
                : input.registry.symbolsByInstanceId.get(symbolInstanceId)
        );

        let droppedEdgesOutsideSourceSpan = 0;
        const nodes = this.sortNodes(
            neighbors.visitedSymbolInstanceIds
                .map((symbolInstanceId) => resolveNodeSymbol(symbolInstanceId))
                .filter((symbol): symbol is SymbolRecord => Boolean(symbol))
                .map((symbol) => this.createNode(symbol))
        );
        const edges = this.sortEdges(
            neighbors.records.flatMap((record) => {
                if (!record.sourceInstanceId || !record.targetInstanceId) {
                    return [];
                }
                const source = resolveNodeSymbol(record.sourceInstanceId);
                const target = resolveNodeSymbol(record.targetInstanceId);
                if (!source || !target) {
                    return [];
                }
                const siteStartLine = record.span?.startLine || source.span.startLine;
                const siteEndLine = record.span?.endLine || siteStartLine;
                if (
                    record.sourceInstanceId === input.resolvedSymbol.symbolInstanceId
                    && input.sourceSpanRepair?.validated
                    && (
                        record.file !== input.resolvedSymbol.file
                        || siteStartLine < input.resolvedSymbol.span.startLine
                        || siteEndLine > input.resolvedSymbol.span.endLine
                    )
                ) {
                    droppedEdgesOutsideSourceSpan += 1;
                    return [];
                }
                return [{
                    srcSymbolId: source.symbolInstanceId,
                    dstSymbolId: target.symbolInstanceId,
                    kind: "call" as const,
                    site: {
                        file: record.file,
                        startLine: siteStartLine,
                        ...(record.span?.endLine ? { endLine: record.span.endLine } : {}),
                    },
                    confidence: this.mapRelationshipConfidence(record.confidence),
                    strategy: record.strategy ?? (record.resolutionAuthority === "direct_binding" || record.resolutionAuthority === "origin_flow" ? "rule" as const : "heuristic" as const),
                    ...(record.resolutionAuthority ? { resolutionAuthority: record.resolutionAuthority } : {}),
                    ...(record.args !== undefined ? { args: record.args } : {}),
                }];
            })
        );

        const suppressedLowConfidenceNotes = this.buildSuppressedNotes({
            resolvedSymbol: input.resolvedSymbol,
            suppressedRecords: suppressedLowConfidenceRecords,
            registry: input.registry,
        });
        const hasSuppressedOutgoingLowConfidence = suppressedLowConfidenceRecords.some((record) => (
            record.sourceInstanceId === input.resolvedSymbol.symbolInstanceId
        ));
        const hasSuppressedIncomingLowConfidence = suppressedLowConfidenceRecords.some((record) => (
            record.targetInstanceId === input.resolvedSymbol.symbolInstanceId
        ));

        const shouldAttemptDynamicCalleeFallback = (input.direction === "callees" || input.direction === "both")
            && Boolean(input.readAuthorizedSourceLines)
            && (Boolean(input.sourceSpanRepair?.repaired) || hasSuppressedOutgoingLowConfidence);
        const dynamicCalleeFallback = shouldAttemptDynamicCalleeFallback && input.readAuthorizedSourceLines
            ? await buildSourceBackedPythonCalleeFallback({
                codebaseRoot: input.codebaseRoot,
                registry: input.registry,
                source: input.resolvedSymbol,
                sortEdges: (fallbackEdges) => this.sortEdges(fallbackEdges),
                readSourceLines: input.readAuthorizedSourceLines,
            })
            : { edges: [], symbols: [], notes: [] };

        const shouldAttemptDynamicCallerFallback = (input.direction === "callers" || input.direction === "both")
            && Boolean(input.readAuthorizedSourceLines)
            && hasSuppressedIncomingLowConfidence;
        const dynamicCallerFallback = shouldAttemptDynamicCallerFallback && input.readAuthorizedSourceLines
            ? await buildSourceBackedPythonCallerFallback({
                codebaseRoot: input.codebaseRoot,
                registry: input.registry,
                resolvedTarget: input.resolvedSymbol,
                suppressedRecords: suppressedLowConfidenceRecords,
                sortEdges: (fallbackEdges) => this.sortEdges(fallbackEdges),
                sortNotes: (fallbackNotes) => this.sortNotes(fallbackNotes),
                readSourceLines: input.readAuthorizedSourceLines,
            })
            : { edges: [], symbols: [], notes: [] };

        const existingEdgeKeys = new Set(edges.map((edge) => [
            edge.srcSymbolId,
            edge.dstSymbolId,
            edge.site.file,
            edge.site.startLine,
        ].join("\0")));
        const addUniqueDynamicEdges = (fallbackEdges: CallGraphEdge[]): CallGraphEdge[] => fallbackEdges.filter((edge) => {
            const key = [
                edge.srcSymbolId,
                edge.dstSymbolId,
                edge.site.file,
                edge.site.startLine,
            ].join("\0");
            if (existingEdgeKeys.has(key)) {
                return false;
            }
            existingEdgeKeys.add(key);
            return true;
        });

        const addedDynamicCalleeEdges = addUniqueDynamicEdges(dynamicCalleeFallback.edges);
        const addedDynamicCallerEdges = addUniqueDynamicEdges(dynamicCallerFallback.edges);
        const addedDynamicEdges = [...addedDynamicCalleeEdges, ...addedDynamicCallerEdges];
        const combinedEdges = this.sortEdges([...edges, ...addedDynamicEdges].map(edge => ({
            ...edge, strategy: edge.strategy ?? "heuristic",
        })));
        const nodeById = new Map(nodes.map((node) => [node.symbolId, node]));
        const referencedDynamicSymbolIds = new Set<string>(addedDynamicEdges.flatMap((edge) => [edge.srcSymbolId, edge.dstSymbolId]));
        for (const symbol of [...dynamicCalleeFallback.symbols, ...dynamicCallerFallback.symbols]) {
            if (!nodeById.has(symbol.symbolInstanceId) && referencedDynamicSymbolIds.has(symbol.symbolInstanceId)) {
                nodeById.set(symbol.symbolInstanceId, this.createNode(symbol));
            }
        }
        const referencedNodeIds = new Set<string>([
            input.resolvedSymbol.symbolInstanceId,
            ...combinedEdges.flatMap((edge) => [edge.srcSymbolId, edge.dstSymbolId]),
        ]);
        const combinedNodes = this.sortNodes(
            [...nodeById.values()].filter((node) => referencedNodeIds.has(node.symbolId))
        );
        const hasNoInboundEdges = (
            input.direction === "callers" || input.direction === "both"
        ) && !combinedEdges.some((edge) => (
            edge.dstSymbolId === input.resolvedSymbol.symbolInstanceId
        ));

        const retrievedInboundCount = neighbors.records.filter((record) => (
            record.targetInstanceId === input.resolvedSymbol.symbolInstanceId
        )).length;
        const suppressedInboundCount = suppressedLowConfidenceRecords.filter((record) => (
            record.targetInstanceId === input.resolvedSymbol.symbolInstanceId
        )).length;
        const ambiguousInboundReferenceCount = inboundExactReferences.filter((reference) => (
            reference.decision === "ambiguous"
        )).length;
        const unresolvedInboundReferenceCount = inboundExactReferences.filter((reference) => (
            reference.decision === "unresolved"
        )).length;
        const nonAuthoritativeInboundReferenceCount = ambiguousInboundReferenceCount + unresolvedInboundReferenceCount;
        const traversalBounded = neighbors.warnings.some((warning) => (
            warning === "RELATIONSHIP_TRAVERSAL_LIMIT_REACHED"
            || warning === "RELATIONSHIP_TRAVERSAL_TRUNCATED"
        ));
        const inboundObservationalCoverageIncomplete = shouldInspectInboundSourceReferences({
            direction: input.direction,
            hasNoInboundEdges,
            suppressedInboundCount,
            warnings: neighbors.warnings,
        });
        const exactSourceResult = inboundObservationalCoverageIncomplete && input.findExactSourceReferences
            ? await input.findExactSourceReferences(input.resolvedSymbol)
            : undefined;
        const sourceReferences: CallGraphSourceReference[] = (exactSourceResult?.references ?? [])
            .filter((reference) => (
                reference.occurrenceKind !== "declaration"
                && (!hasPublishedPathScope(input.pathScope)
                    || (
                        matchesPublishedPathScope(reference.file, input.pathScope)
                        && (
                            !reference.owningSymbol
                            || matchesPublishedPathScope(reference.owningSymbol.file, input.pathScope)
                        )
                    ))
            ))
            .map((reference) => ({
                relationship: "caller" as const,
                evidenceClass: reference.evidenceClass,
                occurrenceKind: reference.occurrenceKind as "member" | "identifier",
                ...(reference.owningSymbol?.symbolId
                    ? { sourceSymbolId: reference.owningSymbol.symbolId }
                    : {}),
                ...(reference.owningSymbol?.symbolLabel
                    ? { sourceSymbolLabel: reference.owningSymbol.symbolLabel }
                    : {}),
                matchedText: reference.matchedText,
                ...(reference.member ? { member: reference.member } : {}),
                site: {
                    file: reference.file,
                    ...reference.span,
                },
            }));
        const inboundCoverageEvidence: InboundCoverageEvidence | undefined = inboundObservationalCoverageIncomplete
            ? {
                reason: resolveInboundCoverageReason({
                    suppressedRelationshipCount: suppressedInboundCount,
                    nonAuthoritativeReferenceCount: nonAuthoritativeInboundReferenceCount,
                    fallbackAttempted: shouldAttemptDynamicCallerFallback,
                    fallbackRecoveredCount: addedDynamicCallerEdges.length,
                    sourceReferenceCount: sourceReferences.length,
                    traversalBounded,
                }),
                retrievedRelationshipCount: retrievedInboundCount,
                suppressedRelationshipCount: suppressedInboundCount,
                fallbackAttempted: shouldAttemptDynamicCallerFallback,
                fallbackRecoveredCount: addedDynamicCallerEdges.length,
                exactReferenceCount: inboundExactReferences.length,
                ambiguousReferenceCount: ambiguousInboundReferenceCount,
                unresolvedReferenceCount: unresolvedInboundReferenceCount,
                sourceReferenceCount: sourceReferences.length,
                sourceReferenceCoverage: exactSourceResult?.coverage.status ?? "not_attempted",
                // Constructor-receiver resolution is the index-time extraction
                // path that produces inbound CALLS for Python class symbols.
                // "Applicable" records that the path exists for this symbol,
                // never that resolution was attempted or succeeded.
                constructorResolutionApplicable: input.resolvedSymbol.kind === "class"
                    && input.resolvedSymbol.language === "python",
            }
            : undefined;
        const warnings = [...new Set([
            ...neighbors.warnings,
            ...(droppedEdgesOutsideSourceSpan > 0 ? [`CALL_GRAPH_EDGE_OUTSIDE_SOURCE_SPAN:${droppedEdgesOutsideSourceSpan}`] : []),
            ...(addedDynamicCalleeEdges.length > 0 ? [`SOURCE_BACKED_DYNAMIC_CALLEES:${addedDynamicCalleeEdges.length}`] : []),
            ...(addedDynamicCallerEdges.length > 0 ? [`SOURCE_BACKED_DYNAMIC_CALLERS:${addedDynamicCallerEdges.length}`] : []),
            ...(inboundObservationalCoverageIncomplete ? [INBOUND_COVERAGE_PARTIAL_WARNING] : []),
            ...(inboundObservationalCoverageIncomplete && nonAuthoritativeInboundReferenceCount > 0
                ? [`CALL_GRAPH_NON_AUTHORITATIVE_INBOUND_REFERENCES:${nonAuthoritativeInboundReferenceCount}`]
                : []),
            ...(sourceReferences.length > 0
                ? [`CALL_GRAPH_OBSERVATIONAL_SOURCE_REFERENCES:${sourceReferences.length}`]
                : []),
            ...(exactSourceResult?.coverage.status === "partial"
                ? ["CALL_GRAPH_SOURCE_REFERENCE_COVERAGE_PARTIAL"]
                : []),
        ])].sort(compareContractStrings);
        // Sort first for determinism within bands, then production-first inbound note priority.
        const combinedNotes = prioritizeInboundSuppressedNotes(this.sortNotes([
            ...suppressedLowConfidenceNotes,
            ...(addedDynamicCalleeEdges.length > 0 ? dynamicCalleeFallback.notes : []),
            ...(addedDynamicCallerEdges.length > 0 ? dynamicCallerFallback.notes : []),
        ]));

        // Incomplete inbound traversal: persisted claims are already surfaced above,
        // then the exact published-source floor runs before any ranked discovery hint.
        // The must: query remains optional discovery only and never substitutes for
        // observational coverage or fabricates an edge.
        let hints: Record<string, unknown> | undefined;
        if (inboundObservationalCoverageIncomplete) {
            const constructed = buildInboundVerificationSearchQuery({
                symbolName: input.resolvedSymbol.name,
                symbolLabel: input.resolvedSymbol.label,
                symbolId: input.resolvedSymbol.symbolInstanceId,
                file: uniqueInboundCallerSiteFile(combinedNotes),
            });
            if (constructed.query) {
                hints = {
                    nextSteps: [
                        {
                            tool: "search_codebase",
                            args: {
                                path: input.codebaseRoot,
                                query: constructed.query,
                                scope: "runtime",
                                resultMode: "grouped",
                            },
                            reason: "Inbound CALLS coverage is incomplete. Persisted claim evidence and exact published-source occurrences were checked first; ranked must: search is optional discovery only.",
                        },
                    ],
                };
            }
        }

        return {
            supported: true,
            direction: input.direction,
            depth: Math.max(1, Math.min(3, input.depth)),
            limit: Math.max(1, input.limit),
            nodes: combinedNodes,
            edges: combinedEdges,
            notes: combinedNotes,
            ...(warnings.length > 0 ? { warnings } : {}),
            notesTruncated: false,
            totalNoteCount: combinedNotes.length,
            returnedNoteCount: combinedNotes.length,
            graph: {
                builtAt: neighbors.manifest.builtAt,
                nodeCount: combinedNodes.length,
                edgeCount: combinedEdges.length,
            },
            ...(exactReferences.length > 0 ? { exactReferences } : {}),
            ...(sourceReferences.length > 0 ? { sourceReferences } : {}),
            ...(exactSourceResult ? { sourceReferenceCoverage: exactSourceResult.coverage } : {}),
            ...(constructCoverage.length > 0 ? { constructCoverage } : {}),
            ...(testReferences.length > 0 ? { testReferences } : {}),
            ...(hints ? { hints } : {}),
            ...(inboundCoverageEvidence ? { inboundCoverageEvidence } : {}),
        };
    }
}
