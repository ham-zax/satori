import {
    compareContractStrings,
    getGraphNeighbors,
    getRelationshipsForSymbol,
    isTestOrFixturePath,
    JsonNavigationStore,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import type {
    CallGraphDirection,
    CallGraphEdgeResult as CallGraphEdge,
    CallGraphNodeResult as CallGraphNode,
    CallGraphNoteResult as CallGraphNote,
    CallGraphTestReferenceResult as CallGraphTestReference,
    InboundCoverageEvidence,
    InboundCoverageReason,
} from "./search-types.js";
import {
    buildSourceBackedPythonCalleeFallback,
    buildSourceBackedPythonCallerFallback,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import { buildInboundVerificationSearchQuery } from "./search-response-helpers.js";

type RelationshipBackedCallGraphHost = {
    navigationStore: JsonNavigationStore;
};

const DEFAULT_CALL_GRAPH_TEST_REFERENCE_LIMIT = 50;

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
    /**
     * Publication-authorized source reader for the Python source-backed
     * fallback. When absent the dynamic fallback is SKIPPED entirely (no
     * edges from source reconstruction, never a legacy pathname read).
     * The navigation tool boundary always supplies it; other callers that
     * cannot bind a session policy therefore fail closed by losing the
     * dynamic fallback rather than reading unauthenticated source.
     */
    readAuthorizedSourceLines?: (codebaseRoot: string, relativeFilePath: string) => Promise<string[] | undefined>;
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
    fallbackAttempted: boolean;
    fallbackRecoveredCount: number;
}): InboundCoverageReason {
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

const MAX_DETAILED_TEST_SUPPRESSED_CALLER_NOTES = 3;
const INBOUND_COVERAGE_PARTIAL_WARNING = "CALL_GRAPH_INBOUND_COVERAGE_PARTIAL";

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
        return this.sortTestReferences([...referencesByKey.values()])
            .slice(0, DEFAULT_CALL_GRAPH_TEST_REFERENCE_LIMIT);
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
            limit: input.limit,
        });
        if (neighbors.status !== "ok") {
            return null;
        }
        const testRelationshipResult = await getRelationshipsForSymbol({
            normalizedRootPath: input.codebaseRoot,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            expectedSymbolRegistryManifestHash: input.registryManifestHash,
            navigationStore: this.host.navigationStore,
            targetInstanceId: input.resolvedSymbol.symbolInstanceId,
            direction: "callers",
            types: ["TESTS"],
        });
        if (testRelationshipResult.status !== "ok") {
            return null;
        }
        const testReferences = this.buildTestReferences(
            testRelationshipResult.records,
            input.registry,
            input.resolvedSymbol.symbolInstanceId,
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
        const inboundCoverageEvidence: InboundCoverageEvidence | undefined = hasNoInboundEdges
            ? {
                reason: resolveInboundCoverageReason({
                    suppressedRelationshipCount: suppressedInboundCount,
                    fallbackAttempted: shouldAttemptDynamicCallerFallback,
                    fallbackRecoveredCount: addedDynamicCallerEdges.length,
                }),
                retrievedRelationshipCount: retrievedInboundCount,
                suppressedRelationshipCount: suppressedInboundCount,
                fallbackAttempted: shouldAttemptDynamicCallerFallback,
                fallbackRecoveredCount: addedDynamicCallerEdges.length,
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
            ...(hasNoInboundEdges ? [INBOUND_COVERAGE_PARTIAL_WARNING] : []),
        ])].sort(compareContractStrings);
        // Sort first for determinism within bands, then production-first inbound note priority.
        const combinedNotes = prioritizeInboundSuppressedNotes(this.sortNotes([
            ...suppressedLowConfidenceNotes,
            ...(addedDynamicCalleeEdges.length > 0 ? dynamicCalleeFallback.notes : []),
            ...(addedDynamicCallerEdges.length > 0 ? dynamicCallerFallback.notes : []),
        ]));

        // Empty inbound traversal: disclose advisory coverage and promote executable
        // must: identifier search without fabricating an edge. path: uses a unique
        // suppressed caller site when proven, never the callee defining file alone.
        let hints: Record<string, unknown> | undefined;
        if (hasNoInboundEdges) {
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
                            reason: "Inbound graph coverage is partial and returned no callers; use deterministic must: search to verify production call sites.",
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
            ...(testReferences.length > 0 ? { testReferences } : {}),
            ...(hints ? { hints } : {}),
            ...(inboundCoverageEvidence ? { inboundCoverageEvidence } : {}),
        };
    }
}
