import type { RelationshipRecord, SymbolRecord } from '../symbols/contracts';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { JsonNavigationStore } from './store';

type NavigationReader = Pick<JsonNavigationStore, 'getManifest' | 'getRelationships'>;

export const TRACE_PATH_RELATIONSHIP_KINDS = ['CALLS', 'IMPORTS', 'EXPORTS', 'TESTS'] as const;
export type TracePathRelationshipKind = typeof TRACE_PATH_RELATIONSHIP_KINDS[number];
const TRACE_PATH_KIND_SET: ReadonlySet<string> = new Set(TRACE_PATH_RELATIONSHIP_KINDS);

export interface TraceRelationshipPathInput {
    normalizedRootPath: string;
    publicationId: string;
    navigationRoot: string;
    sourceSymbolId: string;
    targetSymbolId: string;
    allowedTypes: readonly TracePathRelationshipKind[];
    scopeSubtree?: string;
    maxDepth: number;
    maxVisitedNodes: number;
    maxTraversedEdges: number;
    navigationStore?: NavigationReader;
}

export type TraceRelationshipPathResult =
    | {
        status: 'ok';
        path: { nodes: SymbolRecord[]; edges: RelationshipRecord[] } | null;
        coverage: {
            visitedNodes: number;
            traversedEdges: number;
            truncated: boolean;
            truncatedBy: Array<'maxDepth' | 'maxVisitedNodes' | 'maxTraversedEdges'>;
        };
        warnings: string[];
    }
    | { status: 'missing_symbol'; symbol: 'source' | 'target' }
    | { status: 'missing' | 'incompatible'; reason: string };

const defaultNavigationStore = new JsonNavigationStore();

function inScope(file: string, subtree?: string): boolean {
    if (!subtree) return true;
    return file === subtree || file.startsWith(`${subtree}/`);
}

function compareEdges(left: RelationshipRecord, right: RelationshipRecord): number {
    return compareContractStrings(left.targetInstanceId ?? '', right.targetInstanceId ?? '')
        || compareContractStrings(left.type, right.type)
        || compareContractStrings(left.file, right.file)
        || (left.span?.startLine ?? 0) - (right.span?.startLine ?? 0)
        || (left.span?.endLine ?? 0) - (right.span?.endLine ?? 0)
        || (left.span?.startByte ?? 0) - (right.span?.startByte ?? 0)
        || (left.span?.endByte ?? 0) - (right.span?.endByte ?? 0)
        || (left.span?.startColumn ?? 0) - (right.span?.startColumn ?? 0)
        || (left.span?.endColumn ?? 0) - (right.span?.endColumn ?? 0)
        || compareContractStrings(left.sourceInstanceId ?? '', right.sourceInstanceId ?? '')
        || compareContractStrings(left.confidence, right.confidence)
        || compareContractStrings(left.sourceKey, right.sourceKey)
        || compareContractStrings(left.targetKey ?? '', right.targetKey ?? '')
        || compareContractStrings(left.targetPath ?? '', right.targetPath ?? '')
        || compareContractStrings(left.strategy ?? '', right.strategy ?? '')
        || compareContractStrings(left.resolutionAuthority ?? '', right.resolutionAuthority ?? '')
        || compareContractStrings(JSON.stringify(left.args ?? []), JSON.stringify(right.args ?? []));
}

function bounded(value: number, maximum: number): number {
    return Number.isInteger(value) ? Math.max(1, Math.min(value, maximum)) : 1;
}

/** One shortest path over resolved, directed relationship facts from one Publication. */
export async function traceRelationshipPath(input: TraceRelationshipPathInput): Promise<TraceRelationshipPathResult> {
    if (input.allowedTypes.length === 0
        || input.allowedTypes.some((kind) => !TRACE_PATH_KIND_SET.has(kind))) {
        throw new RangeError('Unsupported relationship kind in trace path request.');
    }
    const store = input.navigationStore ?? defaultNavigationStore;
    const address = {
        normalizedRootPath: input.normalizedRootPath,
        publicationId: input.publicationId,
        navigationRoot: input.navigationRoot,
    };
    const registryState = await store.getManifest(address);
    if (registryState.status !== 'ok') {
        return { status: registryState.status, reason: registryState.reason };
    }

    const symbols = registryState.registry.symbolsByInstanceId;
    const source = symbols.get(input.sourceSymbolId);
    const target = symbols.get(input.targetSymbolId);
    if (!source || !inScope(source.file, input.scopeSubtree)) {
        return { status: 'missing_symbol', symbol: 'source' };
    }
    if (!target || !inScope(target.file, input.scopeSubtree)) {
        return { status: 'missing_symbol', symbol: 'target' };
    }

    const relationshipState = await store.getRelationships({
        ...address,
        expectedSymbolRegistryManifestHash: registryState.manifestHash,
    });
    if (relationshipState.status !== 'ok') {
        return { status: relationshipState.status, reason: relationshipState.reason };
    }

    const allowedTypes: ReadonlySet<string> = new Set(input.allowedTypes);
    const outgoing = new Map<string, RelationshipRecord[]>();
    for (const record of relationshipState.records) {
        if (!allowedTypes.has(record.type) || !record.sourceInstanceId || !record.targetInstanceId) continue;
        const from = symbols.get(record.sourceInstanceId);
        const to = symbols.get(record.targetInstanceId);
        if (!from || !to) continue;
        if (!inScope(from.file, input.scopeSubtree)
            || !inScope(to.file, input.scopeSubtree)
            || !inScope(record.file, input.scopeSubtree)
            || (record.targetPath && !inScope(record.targetPath, input.scopeSubtree))) continue;
        const records = outgoing.get(record.sourceInstanceId) ?? [];
        records.push(record);
        outgoing.set(record.sourceInstanceId, records);
    }
    for (const records of outgoing.values()) records.sort(compareEdges);

    const maxDepth = bounded(input.maxDepth, 6);
    const maxVisitedNodes = bounded(input.maxVisitedNodes, 500);
    const maxTraversedEdges = bounded(input.maxTraversedEdges, 2000);
    const visited = new Set<string>([source.symbolInstanceId]);
    const predecessor = new Map<string, { from: string; edge: RelationshipRecord }>();
    const queue: Array<{ id: string; depth: number }> = [{ id: source.symbolInstanceId, depth: 0 }];
    const truncatedBy = new Set<'maxDepth' | 'maxVisitedNodes' | 'maxTraversedEdges'>();
    let traversedEdges = 0;
    let found = source.symbolInstanceId === target.symbolInstanceId;

    search: for (let index = 0; index < queue.length && !found; index += 1) {
        const current = queue[index]!;
        const records = outgoing.get(current.id) ?? [];
        if (current.depth >= maxDepth) {
            if (records.some((record) => !visited.has(record.targetInstanceId!))) truncatedBy.add('maxDepth');
            continue;
        }
        for (const record of records) {
            if (traversedEdges >= maxTraversedEdges) {
                truncatedBy.add('maxTraversedEdges');
                break search;
            }
            traversedEdges += 1;
            const peer = record.targetInstanceId!;
            if (visited.has(peer)) continue;
            if (visited.size >= maxVisitedNodes) {
                truncatedBy.add('maxVisitedNodes');
                break search;
            }
            visited.add(peer);
            predecessor.set(peer, { from: current.id, edge: record });
            queue.push({ id: peer, depth: current.depth + 1 });
            if (peer === target.symbolInstanceId) {
                found = true;
                break search;
            }
        }
    }

    let path: { nodes: SymbolRecord[]; edges: RelationshipRecord[] } | null = null;
    if (found) {
        const ids = [target.symbolInstanceId];
        const edges: RelationshipRecord[] = [];
        while (ids[0] !== source.symbolInstanceId) {
            const previous = predecessor.get(ids[0]!);
            if (!previous) throw new Error('Path predecessor missing from Publication traversal.');
            ids.unshift(previous.from);
            edges.unshift(previous.edge);
        }
        path = { nodes: ids.map((id) => symbols.get(id)!), edges };
    }

    const reasons = [...truncatedBy].sort(compareContractStrings);
    return {
        status: 'ok',
        path,
        coverage: {
            visitedNodes: visited.size,
            traversedEdges,
            truncated: reasons.length > 0,
            truncatedBy: reasons,
        },
        // Sidecar warnings can name files outside a requested subtree.
        warnings: input.scopeSubtree
            ? []
            : [...new Set([...registryState.warnings, ...relationshipState.warnings])].sort(compareContractStrings),
    };
}
