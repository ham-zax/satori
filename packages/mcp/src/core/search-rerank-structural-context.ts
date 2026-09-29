import {
    compareContractStrings,
    isProofBackedAuthoritativeCall,
    type RelationshipRecord,
    type SymbolRecord,
    type SymbolRegistry,
} from "@satori-code/core";
import type { SearchResultLike } from "./search-lexical-scoring.js";
import { resolveCanonicalOwner } from "./search-rerank-projection.js";


export const SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY = Object.freeze({
    exactInstanceIdentityRequired: true,
    callAdmission: "high_confidence_or_proof_backed_authoritative_call_v1",
    proofBackedAuthorities: ["direct_binding", "origin_flow"] as const,
    testAdmission: "high_confidence_exact_instance_v1",
    maxDirectCallers: 3,
    maxDirectCallees: 3,
    maxSupportingTests: 2,
    orderBy: ["relation", "repository_relative_path", "canonical_symbol_label"] as const,
    referenceSourceText: false,
});

export type SearchRerankStructuralReference = Readonly<{
    repository_relative_path: string;
    canonical_symbol_label: string;
    relation: "caller" | "callee" | "test_support";
}>;

export interface SearchRerankStructuralContext {
    directCallers: readonly SearchRerankStructuralReference[];
    directCallees: readonly SearchRerankStructuralReference[];
    supportingTests: readonly SearchRerankStructuralReference[];
}

/**
 * Request-scoped lookup indexes for one sealed relationship generation. The
 * indexes retain only exact-instance, trusted records so per-candidate packet
 * construction is proportional to local degree rather than all relationships.
 */
export type PreparedSearchRerankStructuralRelationships = Readonly<{
    incomingCallsByTargetInstanceId: ReadonlyMap<string, readonly RelationshipRecord[]>;
    outgoingCallsBySourceInstanceId: ReadonlyMap<string, readonly RelationshipRecord[]>;
    testsByTargetInstanceId: ReadonlyMap<string, readonly RelationshipRecord[]>;
}>;

const RELATION_ORDER: Record<SearchRerankStructuralReference["relation"], number> = {
    caller: 0,
    callee: 1,
    test_support: 2,
};

function referenceFor(
    relation: SearchRerankStructuralReference["relation"],
    symbol: SymbolRecord,
): SearchRerankStructuralReference {
    return {
        repository_relative_path: symbol.file,
        canonical_symbol_label: symbol.label || symbol.qualifiedName || symbol.name,
        relation,
    };
}

function sortReferences(references: readonly SearchRerankStructuralReference[]): SearchRerankStructuralReference[] {
    return [...references].sort((left, right) => (
        RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation]
        || compareContractStrings(left.repository_relative_path, right.repository_relative_path)
        || compareContractStrings(left.canonical_symbol_label, right.canonical_symbol_label)
    ));
}

function emptyContext(): SearchRerankStructuralContext {
    return {
        directCallers: [],
        directCallees: [],
        supportingTests: [],
    };
}

function appendRecord(
    index: Map<string, RelationshipRecord[]>,
    instanceId: string,
    record: RelationshipRecord,
): void {
    const records = index.get(instanceId);
    if (records) records.push(record);
    else index.set(instanceId, [record]);
}

function freezeIndex(index: ReadonlyMap<string, readonly RelationshipRecord[]>): ReadonlyMap<string, readonly RelationshipRecord[]> {
    return new Map(
        [...index].map(([key, records]) => [key, Object.freeze([...records])] as const),
    );
}

/**
 * Prepare exact-instance structural relationships once for a search. A low
 * confidence CALLS record is admitted only when the relationship resolver
 * independently proved its binding (`direct_binding` or `origin_flow`).
 */
export function prepareSearchRerankStructuralRelationships(
    relationships: readonly RelationshipRecord[],
): PreparedSearchRerankStructuralRelationships {
    const incomingCallsByTargetInstanceId = new Map<string, RelationshipRecord[]>();
    const outgoingCallsBySourceInstanceId = new Map<string, RelationshipRecord[]>();
    const testsByTargetInstanceId = new Map<string, RelationshipRecord[]>();
    for (const record of relationships) {
        const sourceInstanceId = typeof record.sourceInstanceId === "string"
            ? record.sourceInstanceId
            : "";
        const targetInstanceId = typeof record.targetInstanceId === "string"
            ? record.targetInstanceId
            : "";
        if (!sourceInstanceId || !targetInstanceId) continue;
        if (
            record.type === "CALLS"
            && (record.confidence === "high" || isProofBackedAuthoritativeCall(record))
        ) {
            appendRecord(incomingCallsByTargetInstanceId, targetInstanceId, record);
            appendRecord(outgoingCallsBySourceInstanceId, sourceInstanceId, record);
        } else if (record.type === "TESTS" && record.confidence === "high") {
            appendRecord(testsByTargetInstanceId, targetInstanceId, record);
        }
    }
    return Object.freeze({
        incomingCallsByTargetInstanceId: freezeIndex(incomingCallsByTargetInstanceId),
        outgoingCallsBySourceInstanceId: freezeIndex(outgoingCallsBySourceInstanceId),
        testsByTargetInstanceId: freezeIndex(testsByTargetInstanceId),
    });
}

function collectReferences(input: {
    records: readonly RelationshipRecord[];
    registry: SymbolRegistry;
    referenceInstanceId: (record: RelationshipRecord) => string | undefined;
    relation: SearchRerankStructuralReference["relation"];
}): SearchRerankStructuralReference[] {
    const references: SearchRerankStructuralReference[] = [];
    const seenInstanceIds = new Set<string>();
    for (const record of input.records) {
        const instanceId = input.referenceInstanceId(record);
        if (!instanceId || seenInstanceIds.has(instanceId)) continue;
        const symbol = input.registry.symbolsByInstanceId.get(instanceId);
        if (!symbol) continue;
        seenInstanceIds.add(instanceId);
        references.push(referenceFor(input.relation, symbol));
    }
    return sortReferences(references);
}

/**
 * Build the trusted structural answer context for one reranker candidate.
 *
 * The candidate and every reference must resolve to exact instance identities
 * in the serving registry. Key-only, unresolved, and ordinary low-confidence
 * records are never turned into fuzzy matches. Proof-backed authoritative
 * CALLS records are the sole low-confidence exception.
 */
export function buildSearchRerankStructuralContext(input: {
    candidate: SearchResultLike;
    registry: SymbolRegistry;
    relationships?: readonly RelationshipRecord[];
    preparedRelationships?: PreparedSearchRerankStructuralRelationships;
}): SearchRerankStructuralContext {
    const owner = resolveCanonicalOwner(input.candidate, input.registry);
    if (!owner) return emptyContext();

    const relationships = input.preparedRelationships
        ?? prepareSearchRerankStructuralRelationships(input.relationships ?? []);
    const ownerInstanceId = owner.symbolInstanceId;
    return {
        directCallers: collectReferences({
            records: relationships.incomingCallsByTargetInstanceId.get(ownerInstanceId) ?? [],
            registry: input.registry,
            referenceInstanceId: (record) => record.sourceInstanceId,
            relation: "caller",
        }).slice(0, SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY.maxDirectCallers),
        directCallees: collectReferences({
            records: relationships.outgoingCallsBySourceInstanceId.get(ownerInstanceId) ?? [],
            registry: input.registry,
            referenceInstanceId: (record) => record.targetInstanceId,
            relation: "callee",
        }).slice(0, SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY.maxDirectCallees),
        supportingTests: collectReferences({
            records: relationships.testsByTargetInstanceId.get(ownerInstanceId) ?? [],
            registry: input.registry,
            referenceInstanceId: (record) => record.sourceInstanceId,
            relation: "test_support",
        }).slice(0, SEARCH_RERANK_STRUCTURAL_CONTEXT_POLICY.maxSupportingTests),
    };
}
