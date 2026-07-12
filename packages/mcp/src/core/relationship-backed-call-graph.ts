import {
    compareContractStrings,
    getGraphNeighbors,
    type NavigationStore,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import type { SnapshotManager } from "./snapshot.js";
import type {
    CallGraphDirection,
    CallGraphEdge,
    CallGraphNode,
    CallGraphNote,
    CallGraphSidecarManager,
    CallGraphTestReference,
} from "./call-graph.js";
import {
    buildSourceBackedPythonCalleeFallback,
    buildSourceBackedPythonCallerFallback,
    type PythonSourceBackedSpanRepair,
} from "./python-call-fallback.js";
import { buildInboundNotesOnlySearchQuery } from "./search-response-helpers.js";

type RelationshipBackedCallGraphHost = {
    navigationStore: NavigationStore;
    callGraphManager: CallGraphSidecarManager;
    snapshotManager: Pick<SnapshotManager, "setCodebaseCallGraphSidecar" | "commitCodebaseCallGraphSidecar" | "saveCodebaseSnapshot">;
    saveSnapshotIfSupported(): void;
    getContextActiveIgnorePatterns(codebasePath: string): string[];
};

type RelationshipBackedCallGraphInput = {
    codebaseRoot: string;
    registry: SymbolRegistry;
    registryManifestHash: string;
    resolvedSymbol: SymbolRecord;
    sourceSpanRepair?: PythonSourceBackedSpanRepair;
    direction: CallGraphDirection;
    depth: number;
    limit: number;
};

type RelationshipBackedCallGraphResult = {
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
};

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

/** True when a repo-relative path looks like a test/fixture site (not production call graph signal). */
export function isTestOrFixtureCallerFile(file: string): boolean {
    const normalized = file.trim().replace(/\\/g, "/");
    if (!normalized) {
        return false;
    }
    const base = normalized.split("/").pop() || normalized;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) {
        return true;
    }
    if (/(^|\/)(__tests__|__mocks__|fixtures|testdata|test-data)(\/|$)/i.test(normalized)) {
        return true;
    }
    if (/(^|\/)tests?(\/|$)/i.test(normalized) && !/(^|\/)packages\/[^/]+\/src\//i.test(normalized)) {
        return true;
    }
    return false;
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
        if (!file) {
            continue;
        }
        allSites.add(file);
        if (!isTestOrFixtureCallerFile(file)) {
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
        if (isTestOrFixtureCallerFile(file)) {
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

function formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
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
            && (Boolean(input.sourceSpanRepair?.repaired) || hasSuppressedOutgoingLowConfidence);
        const dynamicCalleeFallback = shouldAttemptDynamicCalleeFallback
            ? buildSourceBackedPythonCalleeFallback({
                codebaseRoot: input.codebaseRoot,
                registry: input.registry,
                source: input.resolvedSymbol,
                sortEdges: (fallbackEdges) => this.sortEdges(fallbackEdges),
            })
            : { edges: [], symbols: [], notes: [] };

        const shouldAttemptDynamicCallerFallback = (input.direction === "callers" || input.direction === "both")
            && hasSuppressedIncomingLowConfidence;
        const dynamicCallerFallback = shouldAttemptDynamicCallerFallback
            ? buildSourceBackedPythonCallerFallback({
                codebaseRoot: input.codebaseRoot,
                registry: input.registry,
                resolvedTarget: input.resolvedSymbol,
                suppressedRecords: suppressedLowConfidenceRecords,
                sortEdges: (fallbackEdges) => this.sortEdges(fallbackEdges),
                sortNotes: (fallbackNotes) => this.sortNotes(fallbackNotes),
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
        const combinedEdges = this.sortEdges([...edges, ...addedDynamicEdges]);
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
        const warnings = [...new Set([
            ...neighbors.warnings,
            ...(droppedEdgesOutsideSourceSpan > 0 ? [`CALL_GRAPH_EDGE_OUTSIDE_SOURCE_SPAN:${droppedEdgesOutsideSourceSpan}`] : []),
            ...(addedDynamicCalleeEdges.length > 0 ? [`SOURCE_BACKED_DYNAMIC_CALLEES:${addedDynamicCalleeEdges.length}`] : []),
            ...(addedDynamicCallerEdges.length > 0 ? [`SOURCE_BACKED_DYNAMIC_CALLERS:${addedDynamicCallerEdges.length}`] : []),
        ])].sort(compareContractStrings);
        // Sort first for determinism within bands, then production-first inbound note priority.
        const combinedNotes = prioritizeInboundSuppressedNotes(this.sortNotes([
            ...suppressedLowConfidenceNotes,
            ...(addedDynamicCalleeEdges.length > 0 ? dynamicCalleeFallback.notes : []),
            ...(addedDynamicCallerEdges.length > 0 ? dynamicCallerFallback.notes : []),
        ]));

        const wantsInbound = input.direction === "callers" || input.direction === "both";
        const inboundEdgeCount = combinedEdges.filter((edge) => (
            edge.dstSymbolId === input.resolvedSymbol.symbolInstanceId
        )).length;
        const hasInboundSuppressedNotes = combinedNotes.some((note) => (
            note.type === "suppressed_edge"
            && typeof note.detail === "string"
            && note.detail.includes("caller candidate")
        ));
        // Notes-only inbound: promote executable must: identifier search (no fake edges).
        // path: uses unique suppressed *caller site* file when available — prefer production
        // over test/fixture sites (never the callee defining file alone).
        let hints: Record<string, unknown> | undefined;
        if (wantsInbound && inboundEdgeCount === 0 && hasInboundSuppressedNotes) {
            const constructed = buildInboundNotesOnlySearchQuery({
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
                            reason: "Inbound graph edges were suppressed as low-confidence or incomplete; use deterministic must: search to find production call sites.",
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
            sidecar: {
                builtAt: neighbors.manifest.builtAt,
                nodeCount: combinedNodes.length,
                edgeCount: combinedEdges.length,
            },
            ...(hints ? { hints } : {}),
        };
    }

    public async rebuildForIndex(codebasePath: string, assertMutationCurrent?: () => void): Promise<void> {
        try {
            const sidecar = await this.host.callGraphManager.rebuildForCodebase(
                codebasePath,
                this.host.getContextActiveIgnorePatterns(codebasePath),
                assertMutationCurrent,
            );
            assertMutationCurrent?.();
            this.commitCallGraphSidecar(codebasePath, sidecar, assertMutationCurrent);
            console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' (${sidecar.nodeCount} nodes, ${sidecar.edgeCount} edges).`);
        } catch (error) {
            assertMutationCurrent?.();
            console.warn(`[CALL-GRAPH] Failed to rebuild sidecar after indexing '${codebasePath}': ${formatUnknownError(error)}`);
            throw error;
        }
    }

    public async rebuildForSyncDelta(
        codebasePath: string,
        changedFiles: string[],
        assertMutationCurrent?: () => void,
    ): Promise<boolean> {
        try {
            const sidecar = await this.host.callGraphManager.rebuildIfSupportedDelta(
                codebasePath,
                changedFiles,
                this.host.getContextActiveIgnorePatterns(codebasePath),
                assertMutationCurrent,
            );
            if (!sidecar) {
                return false;
            }
            assertMutationCurrent?.();
            this.commitCallGraphSidecar(codebasePath, sidecar, assertMutationCurrent);
            console.log(`[CALL-GRAPH] Rebuilt sidecar for '${codebasePath}' from sync delta (${sidecar.nodeCount} nodes, ${sidecar.edgeCount} edges).`);
            return true;
        } catch (error) {
            assertMutationCurrent?.();
            console.warn(`[CALL-GRAPH] Failed to rebuild sidecar after sync '${codebasePath}': ${formatUnknownError(error)}`);
            return false;
        }
    }

    private commitCallGraphSidecar(
        codebasePath: string,
        sidecar: Parameters<SnapshotManager["setCodebaseCallGraphSidecar"]>[1],
        assertMutationCurrent?: () => void,
    ): void {
        if (typeof this.host.snapshotManager.commitCodebaseCallGraphSidecar === "function") {
            const committed = this.host.snapshotManager.commitCodebaseCallGraphSidecar(
                codebasePath,
                sidecar,
                assertMutationCurrent,
            );
            if (!committed) {
                throw new Error(`Failed to persist call-graph sidecar for '${codebasePath}'.`);
            }
            return;
        }
        this.host.snapshotManager.setCodebaseCallGraphSidecar(codebasePath, sidecar);
        if (typeof this.host.snapshotManager.saveCodebaseSnapshot === "function") {
            if (this.host.snapshotManager.saveCodebaseSnapshot(false, assertMutationCurrent) === false) {
                throw new Error(`Failed to persist call-graph sidecar for '${codebasePath}'.`);
            }
            return;
        }
        this.host.saveSnapshotIfSupported();
    }
}
