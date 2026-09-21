import {
    compareContractStrings,
    getGraphNeighbors,
    type GetRelationshipManifestInput,
    type RelationshipManifest,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
} from "@zokizuan/satori-core";
import type {
    CallGraphEdgeResult as CallGraphEdge,
    CallGraphNoteResult as CallGraphNote,
} from "./search-types.js";

type PreparedNavigationReader = NonNullable<GetRelationshipManifestInput["navigationStore"]>;

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
    relationshipRecords: RelationshipRecord[];
    relationshipWarnings: readonly string[];
}): PreparedNavigationReader {
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
        records: input.relationshipRecords,
        analysisByFile: new Map(),
        warnings: [...input.relationshipWarnings],
    });
    return {
        getManifest: async () => registryState(),
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
        strategy: record.strategy ?? (record.resolutionAuthority === "direct_binding" || record.resolutionAuthority === "origin_flow" ? "rule" : "heuristic"),
        ...(record.resolutionAuthority ? { resolutionAuthority: record.resolutionAuthority } : {}),
        ...(record.args !== undefined ? { args: record.args } : {}),
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
    registry: SymbolRegistry;
    target: SymbolRecord;
    records: readonly RelationshipRecord[];
    suppressedRecords: readonly RelationshipRecord[];
}): Promise<PreparedRelationshipDirectionTraversal> {
    const records = input.records.filter((record) => (
        input.direction === "callers"
            ? record.targetInstanceId === input.target.symbolInstanceId
            : record.sourceInstanceId === input.target.symbolInstanceId
    ));
    const edges = records.flatMap((record) => {
        const edge = relationshipEdge(record, input.registry);
        return edge ? [edge] : [];
    });
    const suppressedRecords = input.suppressedRecords.filter((record) => (
        input.direction === "callers"
            ? record.targetInstanceId === input.target.symbolInstanceId
            : record.sourceInstanceId === input.target.symbolInstanceId
    ));
    const suppressionNotes = suppressedRecords
        .flatMap((record) => {
            const note = suppressionNote(record, input.target, input.registry);
            return note ? [note] : [];
        })
        .sort(compareNotes);
    return {
        edges,
        availableCount: edges.length,
        suppressedCount: suppressedRecords.length,
        suppressionNotes,
    };
}

export async function prepareRelationshipTraversals(input: {
    rootPath: string;
    publicationId: string;
    navigationRoot: string;
    registryManifestIdentity: string;
    relationshipManifestIdentity: string;
    registry: SymbolRegistry;
    target: SymbolRecord;
    relationshipManifest: RelationshipManifest;
    relationshipRecords: RelationshipRecord[];
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
    const neighbors = await getGraphNeighbors({
        normalizedRootPath: input.rootPath,
        publicationId: input.publicationId,
        navigationRoot: input.navigationRoot,
        expectedSymbolRegistryManifestHash: input.registryManifestIdentity,
        navigationStore,
        symbolInstanceId: input.target.symbolInstanceId,
        depth: 1,
        direction: "both",
        allowedTypes: ["CALLS"],
        limit: Number.MAX_SAFE_INTEGER,
    });
    if (neighbors.status !== "ok") return undefined;
    const [callers, callees] = await Promise.all([
        prepareDirection({
            direction: "callers",
            registry: input.registry,
            target: input.target,
            records: neighbors.records,
            suppressedRecords: neighbors.suppressedLowConfidenceRecords,
        }),
        prepareDirection({
            direction: "callees",
            registry: input.registry,
            target: input.target,
            records: neighbors.records,
            suppressedRecords: neighbors.suppressedLowConfidenceRecords,
        }),
    ]);
    return { callers, callees };
}
