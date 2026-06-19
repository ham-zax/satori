import type {
    RelationshipManifest,
    RelationshipRecord,
    RelationshipType,
} from '../symbols';
import { createRuntimeNavigationStore } from './runtime';
import type {
    NavigationRelationshipsState,
    NavigationStore,
} from './store';

type RelationshipQueryFailure = Extract<NavigationRelationshipsState, { status: 'missing' | 'incompatible' }>;

type RelationshipQueryOk = {
    status: 'ok';
    rootPath: string;
    manifest: RelationshipManifest;
    records: RelationshipRecord[];
    warnings: string[];
};

export type RelationshipQueryResult = RelationshipQueryOk | RelationshipQueryFailure;

export interface GetRelationshipManifestInput {
    normalizedRootPath: string;
    expectedSymbolRegistryManifestHash: string;
    stateRoot?: string;
    navigationStore?: NavigationStore;
}

export interface GetRelationshipsForSymbolInput extends GetRelationshipManifestInput {
    sourceInstanceId?: string;
    sourceKey?: string;
    targetInstanceId?: string;
    targetKey?: string;
    direction: 'callers' | 'callees' | 'both';
    types?: RelationshipType[];
}

export interface GetRelationshipsForFileInput extends GetRelationshipManifestInput {
    file: string;
    types?: RelationshipType[];
}

export interface GetGraphNeighborsInput extends GetRelationshipManifestInput {
    symbolInstanceId: string;
    depth: number;
    direction: 'callers' | 'callees' | 'both';
    allowedTypes?: RelationshipType[];
    allowedConfidences?: Array<RelationshipRecord['confidence']>;
    limit?: number;
}

export interface GetGraphNeighborsOk {
    status: 'ok';
    rootPath: string;
    manifest: RelationshipManifest;
    records: RelationshipRecord[];
    suppressedLowConfidenceRecords: RelationshipRecord[];
    visitedSymbolInstanceIds: string[];
    warnings: string[];
}

export type GetGraphNeighborsResult = GetGraphNeighborsOk | RelationshipQueryFailure;

function matchesType(record: RelationshipRecord, types?: RelationshipType[]): boolean {
    return !types || types.length === 0 || types.includes(record.type);
}

function matchesSourceSelector(record: RelationshipRecord, input: GetRelationshipsForSymbolInput): boolean {
    if (input.sourceInstanceId && record.sourceInstanceId !== input.sourceInstanceId) {
        return false;
    }
    if (input.sourceKey && record.sourceKey !== input.sourceKey) {
        return false;
    }
    return Boolean(input.sourceInstanceId || input.sourceKey);
}

function matchesTargetSelector(record: RelationshipRecord, input: GetRelationshipsForSymbolInput): boolean {
    if (input.targetInstanceId && record.targetInstanceId !== input.targetInstanceId) {
        return false;
    }
    if (input.targetKey && record.targetKey !== input.targetKey) {
        return false;
    }
    return Boolean(input.targetInstanceId || input.targetKey);
}

function getNavigationStore(store?: NavigationStore): NavigationStore {
    return store || createRuntimeNavigationStore();
}

async function readCompatibleRelationshipState(input: GetRelationshipManifestInput): Promise<RelationshipQueryResult> {
    const result = await getNavigationStore(input.navigationStore).getRelationships({
        stateRoot: input.stateRoot,
        normalizedRootPath: input.normalizedRootPath,
        expectedSymbolRegistryManifestHash: input.expectedSymbolRegistryManifestHash,
    });
    if (result.status !== 'ok') {
        return result;
    }
    return {
        status: 'ok',
        rootPath: result.rootPath,
        manifest: result.manifest,
        records: result.records,
        warnings: result.warnings,
    };
}

function buildRelationshipRecordKey(record: RelationshipRecord): string {
    return [
        record.file,
        record.type,
        record.sourceKey,
        record.sourceInstanceId || '',
        record.targetKey || '',
        record.targetInstanceId || '',
        record.targetPath || '',
        String(record.span?.startLine || 0),
        String(record.span?.endLine || 0),
        record.confidence,
    ].join('|');
}

function appendToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const existing = map.get(key);
    if (existing) {
        existing.push(value);
        return;
    }
    map.set(key, [value]);
}

function uniqSortedWarnings(warnings: string[]): string[] {
    return [...new Set(warnings)].sort((a, b) => a.localeCompare(b));
}

function appendToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
    const existing = map.get(key);
    if (existing) {
        existing.add(value);
        return;
    }
    map.set(key, new Set([value]));
}

function compareRelationshipQueryRecords(a: RelationshipRecord, b: RelationshipRecord): number {
    if (a.file !== b.file) {
        return a.file.localeCompare(b.file);
    }
    const aStartLine = a.span?.startLine || 0;
    const bStartLine = b.span?.startLine || 0;
    if (aStartLine !== bStartLine) {
        return aStartLine - bStartLine;
    }
    const aEndLine = a.span?.endLine || 0;
    const bEndLine = b.span?.endLine || 0;
    if (aEndLine !== bEndLine) {
        return aEndLine - bEndLine;
    }
    if (a.type !== b.type) {
        return a.type.localeCompare(b.type);
    }
    const aSource = a.sourceInstanceId || a.sourceKey;
    const bSource = b.sourceInstanceId || b.sourceKey;
    if (aSource !== bSource) {
        return aSource.localeCompare(bSource);
    }
    const aTarget = a.targetInstanceId || a.targetKey || a.targetPath || '';
    const bTarget = b.targetInstanceId || b.targetKey || b.targetPath || '';
    return aTarget.localeCompare(bTarget);
}

interface RelationshipSupportIndex {
    ownerIdsByFile: Map<string, Set<string>>;
    importedOwnerIdsByOwner: Map<string, Set<string>>;
    reExportedOwnerIdsByOwner: Map<string, Set<string>>;
    exportedSymbolIdsByOwner: Map<string, Set<string>>;
}

function buildRelationshipSupportIndex(records: RelationshipRecord[]): RelationshipSupportIndex {
    const ownerIdsByFile = new Map<string, Set<string>>();
    const importedOwnerIdsByOwner = new Map<string, Set<string>>();
    const reExportedOwnerIdsByOwner = new Map<string, Set<string>>();
    const exportedSymbolIdsByOwner = new Map<string, Set<string>>();

    for (const record of records) {
        if (record.sourceInstanceId) {
            appendToSetMap(ownerIdsByFile, record.file, record.sourceInstanceId);
        }
        if (!record.sourceInstanceId || !record.targetInstanceId) {
            continue;
        }
        if (record.type === 'IMPORTS') {
            appendToSetMap(importedOwnerIdsByOwner, record.sourceInstanceId, record.targetInstanceId);
            continue;
        }
        if (record.type !== 'EXPORTS') {
            continue;
        }
        if (record.targetPath) {
            appendToSetMap(reExportedOwnerIdsByOwner, record.sourceInstanceId, record.targetInstanceId);
            continue;
        }
        appendToSetMap(exportedSymbolIdsByOwner, record.sourceInstanceId, record.targetInstanceId);
    }

    return {
        ownerIdsByFile,
        importedOwnerIdsByOwner,
        reExportedOwnerIdsByOwner,
        exportedSymbolIdsByOwner,
    };
}

function isImportExportSupportedLowConfidenceCall(
    record: RelationshipRecord,
    index: RelationshipSupportIndex
): boolean {
    if (record.type !== 'CALLS' || record.confidence !== 'low' || !record.targetInstanceId) {
        return false;
    }
    const sourceOwnerIds = index.ownerIdsByFile.get(record.file);
    if (!sourceOwnerIds || sourceOwnerIds.size === 0) {
        return false;
    }

    const frontier = Array.from(sourceOwnerIds)
        .flatMap((ownerId) => Array.from(index.importedOwnerIdsByOwner.get(ownerId) || []))
        .sort((a, b) => a.localeCompare(b));
    const visited = new Set<string>();

    while (frontier.length > 0) {
        const ownerId = frontier.shift()!;
        if (visited.has(ownerId)) {
            continue;
        }
        visited.add(ownerId);

        if (index.exportedSymbolIdsByOwner.get(ownerId)?.has(record.targetInstanceId)) {
            return true;
        }

        const reExports = Array.from(index.reExportedOwnerIdsByOwner.get(ownerId) || []).sort((a, b) => a.localeCompare(b));
        for (const nextOwnerId of reExports) {
            if (!visited.has(nextOwnerId)) {
                frontier.push(nextOwnerId);
            }
        }
    }

    return false;
}

export async function getRelationshipManifest(input: GetRelationshipManifestInput): Promise<RelationshipQueryResult> {
    return readCompatibleRelationshipState(input);
}

export async function getRelationshipsForSymbol(input: GetRelationshipsForSymbolInput): Promise<RelationshipQueryResult> {
    const relationshipSidecar = await readCompatibleRelationshipState(input);
    if (relationshipSidecar.status !== 'ok') {
        return relationshipSidecar;
    }

    const records = relationshipSidecar.records.filter((record) => {
        if (!matchesType(record, input.types)) {
            return false;
        }
        if (input.direction === 'callees') {
            return matchesSourceSelector(record, input);
        }
        if (input.direction === 'callers') {
            return matchesTargetSelector(record, input);
        }
        return matchesSourceSelector(record, input) || matchesTargetSelector(record, input);
    });

    return {
        status: 'ok',
        rootPath: relationshipSidecar.rootPath,
        manifest: relationshipSidecar.manifest,
        records: [...records].sort(compareRelationshipQueryRecords),
        warnings: relationshipSidecar.warnings,
    };
}

export async function getRelationshipsForFile(input: GetRelationshipsForFileInput): Promise<RelationshipQueryResult> {
    const relationshipSidecar = await readCompatibleRelationshipState(input);
    if (relationshipSidecar.status !== 'ok') {
        return relationshipSidecar;
    }

    const records = relationshipSidecar.records.filter((record) => (
        record.file === input.file && matchesType(record, input.types)
    ));

    return {
        status: 'ok',
        rootPath: relationshipSidecar.rootPath,
        manifest: relationshipSidecar.manifest,
        records: [...records].sort(compareRelationshipQueryRecords),
        warnings: relationshipSidecar.warnings,
    };
}

export async function getGraphNeighbors(input: GetGraphNeighborsInput): Promise<GetGraphNeighborsResult> {
    const relationshipSidecar = await readCompatibleRelationshipState(input);
    if (relationshipSidecar.status !== 'ok') {
        return relationshipSidecar;
    }

    const includeCallers = input.direction === 'callers' || input.direction === 'both';
    const includeCallees = input.direction === 'callees' || input.direction === 'both';
    const maxDepth = Math.max(1, Math.min(3, Number.isFinite(input.depth) ? input.depth : 1));
    const maxRecords = Number.isFinite(input.limit) ? Math.max(1, Number(input.limit)) : Number.MAX_SAFE_INTEGER;
    const allowedConfidences = new Set(input.allowedConfidences && input.allowedConfidences.length > 0
        ? input.allowedConfidences
        : ['high']);
    const supportIndex = buildRelationshipSupportIndex(relationshipSidecar.records);

    const outgoing = new Map<string, RelationshipRecord[]>();
    const incoming = new Map<string, RelationshipRecord[]>();

    for (const record of relationshipSidecar.records) {
        if (!matchesType(record, input.allowedTypes)) {
            continue;
        }
        if (record.sourceInstanceId) {
            appendToMap(outgoing, record.sourceInstanceId, record);
        }
        if (record.targetInstanceId) {
            appendToMap(incoming, record.targetInstanceId, record);
        }
    }

    const visited = new Set<string>([input.symbolInstanceId]);
    const visitedSymbolInstanceIds = [input.symbolInstanceId];
    const selectedRecords = new Map<string, RelationshipRecord>();
    const skippedLowConfidence = new Set<string>();
    const suppressedLowConfidenceRecords = new Map<string, RelationshipRecord>();
    let frontier = [input.symbolInstanceId];

    for (let depth = 1; depth <= maxDepth; depth += 1) {
        const nextFrontier: string[] = [];

        for (const symbolInstanceId of frontier) {
            const recordList: RelationshipRecord[] = [];
            if (includeCallees) {
                recordList.push(...(outgoing.get(symbolInstanceId) || []));
            }
            if (includeCallers) {
                recordList.push(...(incoming.get(symbolInstanceId) || []));
            }

            for (const record of recordList) {
                const recordKey = buildRelationshipRecordKey(record);
                if (!allowedConfidences.has(record.confidence)) {
                    if (isImportExportSupportedLowConfidenceCall(record, supportIndex)) {
                        const supportedLowConfidenceRecord: RelationshipRecord = {
                            ...record,
                            confidence: 'medium',
                        };
                        if (!selectedRecords.has(recordKey)) {
                            if (selectedRecords.size >= maxRecords) {
                                break;
                            }
                            selectedRecords.set(recordKey, supportedLowConfidenceRecord);
                        }

                        const peerSymbolInstanceId = supportedLowConfidenceRecord.sourceInstanceId === symbolInstanceId
                            ? supportedLowConfidenceRecord.targetInstanceId
                            : supportedLowConfidenceRecord.sourceInstanceId;
                        if (peerSymbolInstanceId && !visited.has(peerSymbolInstanceId)) {
                            visited.add(peerSymbolInstanceId);
                            visitedSymbolInstanceIds.push(peerSymbolInstanceId);
                            nextFrontier.push(peerSymbolInstanceId);
                        }
                        continue;
                    }
                    skippedLowConfidence.add(recordKey);
                    suppressedLowConfidenceRecords.set(recordKey, record);
                    continue;
                }

                if (!selectedRecords.has(recordKey)) {
                    if (selectedRecords.size >= maxRecords) {
                        break;
                    }
                    selectedRecords.set(recordKey, record);
                }

                const peerSymbolInstanceId = record.sourceInstanceId === symbolInstanceId
                    ? record.targetInstanceId
                    : record.sourceInstanceId;
                if (!peerSymbolInstanceId || visited.has(peerSymbolInstanceId)) {
                    continue;
                }
                visited.add(peerSymbolInstanceId);
                visitedSymbolInstanceIds.push(peerSymbolInstanceId);
                nextFrontier.push(peerSymbolInstanceId);
            }

            if (selectedRecords.size >= maxRecords) {
                break;
            }
        }

        frontier = [...new Set(nextFrontier)];
        if (frontier.length === 0 || selectedRecords.size >= maxRecords) {
            break;
        }
    }

    const warnings = [...relationshipSidecar.warnings];
    if (skippedLowConfidence.size > 0) {
        warnings.push(`RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:${skippedLowConfidence.size}`);
    }

    return {
        status: 'ok',
        rootPath: relationshipSidecar.rootPath,
        manifest: relationshipSidecar.manifest,
        records: Array.from(selectedRecords.values()),
        suppressedLowConfidenceRecords: Array.from(suppressedLowConfidenceRecords.values()).sort(compareRelationshipQueryRecords),
        visitedSymbolInstanceIds,
        warnings: uniqSortedWarnings(warnings),
    };
}
