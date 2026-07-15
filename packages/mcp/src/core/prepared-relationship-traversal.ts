import {
    compareContractStrings,
    getGraphNeighbors,
    type NavigationStore,
    type RelationshipManifest,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import type { CallGraphEdge, CallGraphNote } from "./call-graph.js";

export interface PreparedRelationshipDirectionTraversal {
    edges: CallGraphEdge[];
    availableCount: number;
    suppressedCount: number;
    suppressionNotes: CallGraphNote[];
}

export interface PreparedRelationshipTraversals {
    callers: PreparedRelationshipDirectionTraversal;
    callees: PreparedRelationshipDirectionTraversal;
}

function confidenceScore(confidence: RelationshipRecord["confidence"]): number {
    switch (confidence) {
        case "high": return 0.95;
        case "medium": return 0.65;
        case "low": return 0.35;
    }
}

function compareNotes(left: CallGraphNote, right: CallGraphNote): number {
    return compareContractStrings(left.file || "", right.file || "")
        || (left.startLine || 0) - (right.startLine || 0)
        || compareContractStrings(left.symbolId || "", right.symbolId || "")
        || compareContractStrings(left.detail || "", right.detail || "");
}

function createPreparedNavigationStore(input: {
    rootPath: string;
    registryManifestIdentity: string;
    relationshipManifestIdentity: string;
    registry: SymbolRegistry;
    relationshipManifest: RelationshipManifest;
    relationshipRecords: readonly RelationshipRecord[];
    relationshipWarnings: readonly string[];
}): NavigationStore {
    const registryState = () => ({
        status: "ok" as const,
        rootPath: input.rootPath,
        manifestHash: input.registryManifestIdentity,
        registryManifestHash: input.registryManifestIdentity,
        registry: input.registry,
        warnings: [] as string[],
    });
    const relationshipsState = () => ({
        status: "ok" as const,
        rootPath: input.rootPath,
        manifestHash: input.relationshipManifestIdentity,
        manifest: input.relationshipManifest,
        records: [...input.relationshipRecords],
        warnings: [...input.relationshipWarnings],
    });
    return {
        getManifest: async () => registryState(),
        getSymbolsByFile: async ({ file }) => ({
            ...registryState(),
            symbols: [...(input.registry.symbolsByFile.get(file) || [])],
        }),
        getSymbolByInstanceId: async ({ symbolInstanceId }) => ({
            ...registryState(),
            symbol: input.registry.symbolsByInstanceId.get(symbolInstanceId) || null,
        }),
        getSymbolCandidatesByKey: async ({ symbolKey }) => ({
            ...registryState(),
            symbols: [...(input.registry.symbolsByKey.get(symbolKey) || [])],
        }),
        findOwnerForSpan: async () => {
            throw new Error("Prepared relationship traversal does not resolve source-span owners.");
        },
        getRelationships: async ({ expectedSymbolRegistryManifestHash }) => {
            if (
                expectedSymbolRegistryManifestHash
                && expectedSymbolRegistryManifestHash !== input.registryManifestIdentity
            ) {
                return {
                    status: "incompatible",
                    rootPath: input.rootPath,
                    reason: "symbol_registry_manifest_mismatch",
                };
            }
            return relationshipsState();
        },
        getCompatibilityState: async () => ({
            rootPath: input.rootPath,
            registry: registryState(),
            relationships: relationshipsState(),
        }),
    };
}

function relationshipEdge(
    record: RelationshipRecord,
    registry: SymbolRegistry,
): CallGraphEdge | undefined {
    if (
        record.type !== "CALLS"
        || !record.sourceInstanceId
        || !record.targetInstanceId
        || !record.span
        || !registry.symbolsByInstanceId.has(record.sourceInstanceId)
        || !registry.symbolsByInstanceId.has(record.targetInstanceId)
    ) {
        return undefined;
    }
    return {
        srcSymbolId: record.sourceInstanceId,
        dstSymbolId: record.targetInstanceId,
        kind: "call",
        site: {
            file: record.file,
            startLine: record.span.startLine,
            ...(record.span.endLine !== undefined ? { endLine: record.span.endLine } : {}),
        },
        confidence: confidenceScore(record.confidence),
    };
}

function suppressionNote(
    record: RelationshipRecord,
    target: SymbolRecord,
    registry: SymbolRegistry,
): CallGraphNote | undefined {
    if (!record.sourceInstanceId || !record.targetInstanceId) return undefined;
    const isCaller = record.targetInstanceId === target.symbolInstanceId;
    const peerId = isCaller ? record.sourceInstanceId : record.targetInstanceId;
    const peer = registry.symbolsByInstanceId.get(peerId);
    const siteStartLine = record.span?.startLine || target.span.startLine;
    const relationship = isCaller ? "caller" : "callee";
    const label = peer?.label || peer?.qualifiedName || peer?.name || peerId;
    return {
        type: "suppressed_edge",
        file: record.file,
        startLine: siteStartLine,
        symbolId: peerId,
        ...(peer?.label ? { symbolLabel: peer.label } : {}),
        confidence: confidenceScore(record.confidence),
        detail: `Suppressed low-confidence ${relationship} candidate ${label} at ${record.file}:${siteStartLine}.`,
    };
}

async function prepareDirection(input: {
    direction: "callers" | "callees";
    rootPath: string;
    registryManifestIdentity: string;
    registry: SymbolRegistry;
    target: SymbolRecord;
    navigationStore: NavigationStore;
}): Promise<PreparedRelationshipDirectionTraversal | undefined> {
    const neighbors = await getGraphNeighbors({
        normalizedRootPath: input.rootPath,
        expectedSymbolRegistryManifestHash: input.registryManifestIdentity,
        navigationStore: input.navigationStore,
        symbolInstanceId: input.target.symbolInstanceId,
        depth: 1,
        direction: input.direction,
        allowedTypes: ["CALLS"],
        limit: Number.MAX_SAFE_INTEGER,
    });
    if (neighbors.status !== "ok") return undefined;
    const edges = neighbors.records.flatMap((record) => {
        const edge = relationshipEdge(record, input.registry);
        return edge ? [edge] : [];
    });
    const suppressionNotes = neighbors.suppressedLowConfidenceRecords
        .flatMap((record) => {
            const note = suppressionNote(record, input.target, input.registry);
            return note ? [note] : [];
        })
        .sort(compareNotes);
    return {
        edges,
        availableCount: edges.length,
        suppressedCount: neighbors.suppressedLowConfidenceRecords.length,
        suppressionNotes,
    };
}

export async function prepareRelationshipTraversals(input: {
    rootPath: string;
    registryManifestIdentity: string;
    relationshipManifestIdentity: string;
    registry: SymbolRegistry;
    target: SymbolRecord;
    relationshipManifest: RelationshipManifest;
    relationshipRecords: readonly RelationshipRecord[];
    relationshipWarnings?: readonly string[];
}): Promise<PreparedRelationshipTraversals | undefined> {
    if (input.relationshipManifest.symbolRegistryManifestHash !== input.registryManifestIdentity) {
        return undefined;
    }
    const navigationStore = createPreparedNavigationStore({
        rootPath: input.rootPath,
        registryManifestIdentity: input.registryManifestIdentity,
        relationshipManifestIdentity: input.relationshipManifestIdentity,
        registry: input.registry,
        relationshipManifest: input.relationshipManifest,
        relationshipRecords: input.relationshipRecords,
        relationshipWarnings: input.relationshipWarnings || [],
    });
    const [callers, callees] = await Promise.all([
        prepareDirection({ ...input, direction: "callers", navigationStore }),
        prepareDirection({ ...input, direction: "callees", navigationStore }),
    ]);
    if (!callers || !callees) return undefined;
    return { callers, callees };
}
