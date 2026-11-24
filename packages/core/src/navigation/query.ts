import type {
    RelationshipManifest,
    RelationshipRecord,
    RelationshipType,
} from '../symbols';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { isProofBackedAuthoritativeCall } from '../relationships/resolution';
import { isTestOrFixturePath } from '../relationships/test-path';
import {
    JsonNavigationStore,
    type NavigationRelationshipsState,
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

type RelationshipNavigationReader = Pick<
    JsonNavigationStore,
    'getManifest' | 'getRelationships'
>;

export interface GetRelationshipManifestInput {
    normalizedRootPath: string;
    expectedSymbolRegistryManifestHash: string;
    publicationId: string;
    navigationRoot: string;
    navigationStore?: RelationshipNavigationReader;
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
    recordFilter?: (record: RelationshipRecord) => boolean;
    limit?: number;
    /**
     * Optional cap on admitted incoming caller edges from test/fixture files.
     * Production callers are ordered first, so capping excess test callers keeps
     * bounded responses compact without starving runtime callers or callees.
     */
    maxTestCallers?: number;
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

const jsonNavigationStore = new JsonNavigationStore();

function getNavigationStore(store?: RelationshipNavigationReader): RelationshipNavigationReader {
    return store || jsonNavigationStore;
}

async function readCompatibleRelationshipState(input: GetRelationshipManifestInput): Promise<RelationshipQueryResult> {
    const result = await getNavigationStore(input.navigationStore).getRelationships({
        normalizedRootPath: input.normalizedRootPath,
        publicationId: input.publicationId,
        navigationRoot: input.navigationRoot,
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
    return [...new Set(warnings)].sort(compareContractStrings);
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
        return compareContractStrings(a.file, b.file);
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
        return compareContractStrings(a.type, b.type);
    }
    const aSource = a.sourceInstanceId || a.sourceKey;
    const bSource = b.sourceInstanceId || b.sourceKey;
    if (aSource !== bSource) {
        return compareContractStrings(aSource, bSource);
    }
    const aTarget = a.targetInstanceId || a.targetKey || a.targetPath || '';
    const bTarget = b.targetInstanceId || b.targetKey || b.targetPath || '';
    return compareContractStrings(aTarget, bTarget);
}

interface RelationshipSupportIndex {
    ownerIdsByFile: Map<string, Set<string>>;
    importedOwnerIdsByOwner: Map<string, Set<string>>;
    reExportedOwnerIdsByOwner: Map<string, Set<string>>;
    exportedSymbolIdsByOwner: Map<string, Set<string>>;
    /** File-owner instance id → repo-relative file path (from IMPORTS targetPath / file-owner CALLS sites). */
    fileByOwnerInstanceId: Map<string, string>;
}

interface PreparedRelationshipIndex {
    support: RelationshipSupportIndex;
    outgoing: ReadonlyMap<string, readonly RelationshipRecord[]>;
    incoming: ReadonlyMap<string, readonly RelationshipRecord[]>;
}

const preparedRelationshipIndexByRecords = new WeakMap<RelationshipRecord[], PreparedRelationshipIndex>();

/**
 * Names that are too ambiguous for import-unique method promotion without EXPORTS evidence.
 * Keeps CALLS v0 from linking e.g. Array.push to unrelated fixtures.
 */
const GENERIC_CALL_NAMES_FOR_UNIQUE_IMPORT_UPGRADE = new Set([
    'push', 'pop', 'shift', 'unshift', 'get', 'set', 'has', 'add', 'delete', 'clear',
    'map', 'filter', 'find', 'findindex', 'foreach', 'reduce', 'sort', 'includes',
    'indexof', 'slice', 'splice', 'concat', 'join', 'split', 'keys', 'values', 'entries',
    'next', 'then', 'catch', 'finally', 'apply', 'call', 'bind', 'tostring', 'valueof',
    'size', 'length', 'update', 'create', 'remove', 'insert', 'write', 'read', 'close',
    'open', 'start', 'stop', 'run', 'init', 'load', 'save', 'parse', 'format', 'error',
]);

interface SymbolSupportIndex {
    fileByInstanceId: Map<string, string>;
    nameByInstanceId: Map<string, string>;
    /** file → lower(name) → instance ids (non-file symbols only) */
    instanceIdsByFileAndName: Map<string, Map<string, string[]>>;
}

function buildRelationshipSupportIndex(records: RelationshipRecord[]): RelationshipSupportIndex {
    const ownerIdsByFile = new Map<string, Set<string>>();
    const importedOwnerIdsByOwner = new Map<string, Set<string>>();
    const reExportedOwnerIdsByOwner = new Map<string, Set<string>>();
    const exportedSymbolIdsByOwner = new Map<string, Set<string>>();
    const fileByOwnerInstanceId = new Map<string, string>();

    for (const record of records) {
        if (record.sourceInstanceId) {
            appendToSetMap(ownerIdsByFile, record.file, record.sourceInstanceId);
        }
        if (!record.sourceInstanceId || !record.targetInstanceId) {
            continue;
        }
        if (record.type === 'IMPORTS') {
            appendToSetMap(importedOwnerIdsByOwner, record.sourceInstanceId, record.targetInstanceId);
            // Importer file-owner is the source of IMPORTS; file is the importer path.
            fileByOwnerInstanceId.set(record.sourceInstanceId, record.file);
            if (record.targetPath) {
                fileByOwnerInstanceId.set(record.targetInstanceId, record.targetPath);
            }
            continue;
        }
        if (record.type !== 'EXPORTS') {
            continue;
        }
        if (record.targetPath) {
            appendToSetMap(reExportedOwnerIdsByOwner, record.sourceInstanceId, record.targetInstanceId);
            fileByOwnerInstanceId.set(record.sourceInstanceId, record.file);
            continue;
        }
        appendToSetMap(exportedSymbolIdsByOwner, record.sourceInstanceId, record.targetInstanceId);
        fileByOwnerInstanceId.set(record.sourceInstanceId, record.file);
    }

    return {
        ownerIdsByFile,
        importedOwnerIdsByOwner,
        reExportedOwnerIdsByOwner,
        exportedSymbolIdsByOwner,
        fileByOwnerInstanceId,
    };
}

function prepareRelationshipIndex(records: RelationshipRecord[]): PreparedRelationshipIndex {
    const cached = preparedRelationshipIndexByRecords.get(records);
    if (cached) return cached;
    const outgoing = new Map<string, RelationshipRecord[]>();
    const incoming = new Map<string, RelationshipRecord[]>();
    for (const record of records) {
        if (record.sourceInstanceId) {
            appendToMap(outgoing, record.sourceInstanceId, record);
        }
        if (record.targetInstanceId) {
            appendToMap(incoming, record.targetInstanceId, record);
        }
    }
    // Keep production callers ahead of test/fixture callers so bounded caller
    // traversals (including `direction: "both"`) do not crowd out runtime callers.
    for (const [targetId, list] of incoming) {
        if (list.length <= 1) continue;
        const production: RelationshipRecord[] = [];
        const tests: RelationshipRecord[] = [];
        for (const record of list) {
            if (isTestOrFixturePath(record.file)) {
                tests.push(record);
            } else {
                production.push(record);
            }
        }
        if (production.length > 0 && tests.length > 0) {
            incoming.set(targetId, [...production, ...tests]);
        }
    }
    const prepared = {
        support: buildRelationshipSupportIndex(records),
        outgoing,
        incoming,
    };
    preparedRelationshipIndexByRecords.set(records, prepared);
    return prepared;
}

function buildSymbolSupportIndex(symbols: Iterable<{
    symbolInstanceId: string;
    file: string;
    name: string;
    kind: string;
}>): SymbolSupportIndex {
    const fileByInstanceId = new Map<string, string>();
    const nameByInstanceId = new Map<string, string>();
    const instanceIdsByFileAndName = new Map<string, Map<string, string[]>>();

    for (const symbol of symbols) {
        if (symbol.kind === 'file') {
            continue;
        }
        fileByInstanceId.set(symbol.symbolInstanceId, symbol.file);
        const nameKey = symbol.name.toLowerCase();
        nameByInstanceId.set(symbol.symbolInstanceId, nameKey);
        let byName = instanceIdsByFileAndName.get(symbol.file);
        if (!byName) {
            byName = new Map();
            instanceIdsByFileAndName.set(symbol.file, byName);
        }
        const existing = byName.get(nameKey);
        if (existing) {
            existing.push(symbol.symbolInstanceId);
        } else {
            byName.set(nameKey, [symbol.symbolInstanceId]);
        }
    }

    return { fileByInstanceId, nameByInstanceId, instanceIdsByFileAndName };
}

function collectImportedOwnerFrontier(
    record: RelationshipRecord,
    index: RelationshipSupportIndex
): string[] {
    const sourceOwnerIds = index.ownerIdsByFile.get(record.file);
    if (!sourceOwnerIds || sourceOwnerIds.size === 0) {
        return [];
    }

    const frontier = Array.from(sourceOwnerIds)
        .flatMap((ownerId) => Array.from(index.importedOwnerIdsByOwner.get(ownerId) || []))
        .sort(compareContractStrings);
    const visited = new Set<string>();
    const ordered: string[] = [];

    while (frontier.length > 0) {
        const ownerId = frontier.shift()!;
        if (visited.has(ownerId)) {
            continue;
        }
        visited.add(ownerId);
        ordered.push(ownerId);

        const reExports = Array.from(index.reExportedOwnerIdsByOwner.get(ownerId) || []).sort(compareContractStrings);
        for (const nextOwnerId of reExports) {
            if (!visited.has(nextOwnerId)) {
                frontier.push(nextOwnerId);
            }
        }
    }

    return ordered;
}

/**
 * Whether a low CALLS edge may be promoted to medium for traversal.
 *
 * Path 1: IMPORTS/EXPORTS evidence that the target is an exported symbol of an imported module.
 * Path 2: imported file has a unique same-name non-file symbol (class methods without top-level EXPORTS).
 *
 * Path 2 does NOT prove receiver binding (e.g. `other.checkMutation()` may still match a unique
 * `checkMutation` in an imported file). It only reduces name-ambiguity enough for medium, never high.
 */
function isExportsBackedLowConfidenceCall(
    record: RelationshipRecord,
    index: RelationshipSupportIndex,
): boolean {
    if (record.type !== 'CALLS' || record.confidence !== 'low' || !record.targetInstanceId) {
        return false;
    }
    const importedOwners = collectImportedOwnerFrontier(record, index);
    if (importedOwners.length === 0) {
        return false;
    }
    for (const ownerId of importedOwners) {
        if (index.exportedSymbolIdsByOwner.get(ownerId)?.has(record.targetInstanceId)) {
            return true;
        }
    }
    return false;
}

function isImportUniqueMethodLowConfidenceCall(
    record: RelationshipRecord,
    index: RelationshipSupportIndex,
    symbolSupport: SymbolSupportIndex,
): boolean {
    if (record.type !== 'CALLS' || record.confidence !== 'low' || !record.targetInstanceId) {
        return false;
    }
    const importedOwners = collectImportedOwnerFrontier(record, index);
    if (importedOwners.length === 0) {
        return false;
    }
    // Path 2 does not prove the call receiver came from the import — only file-level uniqueness.
    const targetFile = symbolSupport.fileByInstanceId.get(record.targetInstanceId);
    const targetName = symbolSupport.nameByInstanceId.get(record.targetInstanceId);
    if (!targetFile || !targetName) {
        return false;
    }
    if (GENERIC_CALL_NAMES_FOR_UNIQUE_IMPORT_UPGRADE.has(targetName)) {
        return false;
    }
    const sameNameIds = symbolSupport.instanceIdsByFileAndName.get(targetFile)?.get(targetName) || [];
    if (sameNameIds.length !== 1 || sameNameIds[0] !== record.targetInstanceId) {
        return false;
    }
    for (const ownerId of importedOwners) {
        const ownerFile = index.fileByOwnerInstanceId.get(ownerId);
        if (ownerFile === targetFile) {
            return true;
        }
    }
    return false;
}

/**
 * Load symbol registry only when needed for Path 2 (import-unique method) upgrades.
 * Uniqueness evidence must come from the same Publication navigation as the relationship JSON.
 */
async function loadMatchingSymbolSupportIndex(input: {
    normalizedRootPath: string;
    publicationId: string;
    navigationRoot: string;
    navigationStore?: RelationshipNavigationReader;
    relationshipSymbolRegistryManifestHash: string;
}): Promise<SymbolSupportIndex | undefined> {
    try {
        const registryState = await getNavigationStore(input.navigationStore).getManifest({
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
        });
        if (registryState.status !== 'ok') {
            return undefined;
        }
        if (registryState.manifestHash !== input.relationshipSymbolRegistryManifestHash) {
            // Stale/mismatched registry must not prove uniqueness for this relationship generation.
            return undefined;
        }
        return buildSymbolSupportIndex(registryState.registry.symbols);
    } catch {
        return undefined;
    }
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

    if (input.direction !== 'both') {
        return traverseGraphNeighbors(input, relationshipSidecar);
    }
    // Keep each traversal directional. Switching direction at an intermediate
    // node would include siblings that are neither callers nor callees.
    const [callers, callees] = await Promise.all([
        traverseGraphNeighbors({ ...input, direction: 'callers' }, relationshipSidecar, true),
        traverseGraphNeighbors({ ...input, direction: 'callees' }, relationshipSidecar),
    ]);
    const limit = Number.isFinite(input.limit) ? Math.max(1, Number(input.limit)) : Number.MAX_SAFE_INTEGER;
    const merged = new Map<string, RelationshipRecord>();
    // Alternate so a large outgoing slice cannot consume the inbound budget.
    for (let i = 0; i < Math.max(callers.records.length, callees.records.length); i += 1) {
        for (const record of [callers.records[i], callees.records[i]]) {
            if (record) merged.set(buildRelationshipRecordKey(record), record);
        }
    }
    const records = [...merged.values()].slice(0, limit);
    const suppressed = new Map([...callers.suppressedLowConfidenceRecords, ...callees.suppressedLowConfidenceRecords]
        .map(record => [buildRelationshipRecordKey(record), record]));
    return {
        ...callers,
        records,
        visitedSymbolInstanceIds: [...new Set([input.symbolInstanceId, ...records.flatMap(record =>
            [record.sourceInstanceId, record.targetInstanceId].filter((id): id is string => Boolean(id)))])],
        suppressedLowConfidenceRecords: [...suppressed.values()].sort(compareRelationshipQueryRecords),
        warnings: uniqSortedWarnings([...callers.warnings, ...callees.warnings,
            ...(merged.size > limit ? ['RELATIONSHIP_TRAVERSAL_TRUNCATED'] : [])]),
    };
}

async function traverseGraphNeighbors(
    input: GetGraphNeighborsInput,
    relationshipSidecar: RelationshipQueryOk,
    prioritizeConnectedCallers = false,
): Promise<GetGraphNeighborsOk> {

    const includeCallers = input.direction === 'callers' || input.direction === 'both';
    const includeCallees = input.direction === 'callees' || input.direction === 'both';
    const maxDepth = Math.max(1, Math.min(3, Number.isFinite(input.depth) ? input.depth : 1));
    const maxRecords = Number.isFinite(input.limit) ? Math.max(1, Number(input.limit)) : Number.MAX_SAFE_INTEGER;
    // Default: high only. Supported low CALLS are promoted to medium via the upgrade path below.
    // Raw medium edges are not included unless the caller passes allowedConfidences including medium.
    const allowedConfidences = new Set(input.allowedConfidences && input.allowedConfidences.length > 0
        ? input.allowedConfidences
        : ['high']);
    const preparedIndex = prepareRelationshipIndex(relationshipSidecar.records);
    const supportIndex = preparedIndex.support;

    // Lazy: only load matching registry when Path 2 (import-unique method) may be needed.
    let symbolSupport: SymbolSupportIndex | undefined;
    let symbolSupportLoadState: 'unloaded' | 'loaded' | 'unavailable' = 'unloaded';
    const ensureSymbolSupport = async (): Promise<SymbolSupportIndex | undefined> => {
        if (symbolSupportLoadState !== 'unloaded') {
            return symbolSupport;
        }
        symbolSupport = await loadMatchingSymbolSupportIndex({
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            navigationStore: input.navigationStore,
            relationshipSymbolRegistryManifestHash: relationshipSidecar.manifest.symbolRegistryManifestHash,
        });
        symbolSupportLoadState = symbolSupport ? 'loaded' : 'unavailable';
        return symbolSupport;
    };

    const visited = new Set<string>([input.symbolInstanceId]);
    const visitedSymbolInstanceIds = [input.symbolInstanceId];
    const selectedRecords = new Map<string, RelationshipRecord>();
    const testCallerEdgeKeys = new Set<string>();
    const parentEdgeByNode = new Map<string, { key: string; parent: string }>();
    const skippedLowConfidence = new Set<string>();
    const suppressedLowConfidenceRecords = new Map<string, RelationshipRecord>();
    const maxTestCallers = typeof input.maxTestCallers === 'number' && Number.isFinite(input.maxTestCallers)
        ? Math.max(0, Math.floor(input.maxTestCallers))
        : Number.MAX_SAFE_INTEGER;
    const hasTestCallerCap = maxTestCallers < Number.MAX_SAFE_INTEGER;
    const traversalLimit = hasTestCallerCap && Number.isFinite(maxRecords)
        ? Math.max(maxRecords * 4, maxRecords + maxTestCallers * 4)
        : maxRecords;
    let nonTestSelectedCount = 0;
    let traversalLimitReached = false;
    const omittedTestCallerKeys = new Set<string>();
    const isTestCallerEdge = (record: RelationshipRecord, currentSymbolId: string): boolean => (
        includeCallers
        && record.targetInstanceId === currentSymbolId
        && isTestOrFixturePath(record.file)
    );
    let frontier = [input.symbolInstanceId];

    for (let depth = 1; depth <= maxDepth; depth += 1) {
        const nextFrontier: string[] = [];

        for (const symbolInstanceId of frontier) {
            const recordList: RelationshipRecord[] = [];
            if (includeCallees) {
                recordList.push(...(preparedIndex.outgoing.get(symbolInstanceId) || []));
            }
            if (includeCallers) {
                recordList.push(...(preparedIndex.incoming.get(symbolInstanceId) || []));
            }

            for (const record of recordList) {
                if (input.recordFilter && !input.recordFilter(record)) {
                    continue;
                }
                if (!matchesType(record, input.allowedTypes)) {
                    continue;
                }
                const recordKey = buildRelationshipRecordKey(record);
                let effectiveRecord = record;
                if (!allowedConfidences.has(record.confidence)) {
                    let supported = isProofBackedAuthoritativeCall(record);
                    // Categorical proof authority lets a proof-backed edge cross the
                    // low-confidence boundary. Current writers omit it on non-proof
                    // CALLS, and those use the import/export support paths.
                    if (!record.resolutionAuthority) {
                        supported = isExportsBackedLowConfidenceCall(record, supportIndex);
                        if (!supported && record.type === 'CALLS' && record.confidence === 'low') {
                            const loaded = await ensureSymbolSupport();
                            if (loaded) {
                                supported = isImportUniqueMethodLowConfidenceCall(record, supportIndex, loaded);
                            }
                        }
                    }
                    if (!supported) {
                        skippedLowConfidence.add(recordKey);
                        suppressedLowConfidenceRecords.set(recordKey, record);
                        continue;
                    }
                    effectiveRecord = {
                        ...record,
                        confidence: 'medium',
                        strategy: 'rule',
                    };
                }

                if (!selectedRecords.has(recordKey)) {
                    if (
                        (hasTestCallerCap ? nonTestSelectedCount >= maxRecords : selectedRecords.size >= maxRecords)
                        || selectedRecords.size >= traversalLimit
                    ) {
                        traversalLimitReached = true;
                        break;
                    }
                    const testCaller = isTestCallerEdge(effectiveRecord, symbolInstanceId);
                    selectedRecords.set(recordKey, effectiveRecord);
                    if (testCaller) {
                        testCallerEdgeKeys.add(recordKey);
                    } else {
                        nonTestSelectedCount += 1;
                    }
                }

                const peerSymbolInstanceId = effectiveRecord.sourceInstanceId === symbolInstanceId
                    ? effectiveRecord.targetInstanceId
                    : effectiveRecord.sourceInstanceId;
                if (!peerSymbolInstanceId || visited.has(peerSymbolInstanceId)) {
                    continue;
                }
                visited.add(peerSymbolInstanceId);
                visitedSymbolInstanceIds.push(peerSymbolInstanceId);
                parentEdgeByNode.set(peerSymbolInstanceId, { key: recordKey, parent: symbolInstanceId });
                nextFrontier.push(peerSymbolInstanceId);
            }

            if (traversalLimitReached || (!hasTestCallerCap && selectedRecords.size >= maxRecords)) {
                break;
            }
        }

        frontier = [...new Set(nextFrontier)];
        if (frontier.length === 0 || traversalLimitReached || (!hasTestCallerCap && selectedRecords.size >= maxRecords)) {
            break;
        }
    }

    let finalRecords: RelationshipRecord[];
    if (!hasTestCallerCap || testCallerEdgeKeys.size === 0) {
        finalRecords = Array.from(selectedRecords.values());
    } else {
        // Preserve any test caller edges that bridge to a production caller at deeper hops.
        const bridgingTestEdgeKeys = new Set<string>();
        for (const [key, record] of selectedRecords) {
            if (testCallerEdgeKeys.has(key)) continue;
            let cursor = record.targetInstanceId;
            while (cursor && cursor !== input.symbolInstanceId) {
                const parentLink = parentEdgeByNode.get(cursor);
                if (!parentLink) break;
                if (testCallerEdgeKeys.has(parentLink.key)) {
                    bridgingTestEdgeKeys.add(parentLink.key);
                }
                cursor = parentLink.parent;
            }
        }

        const compactedRecords = new Map<string, RelationshipRecord>();
        const reachableFromRoot = new Set<string>([input.symbolInstanceId]);
        let includedNonBridgingTestCallers = 0;

        for (const [key, record] of selectedRecords) {
            if (!testCallerEdgeKeys.has(key) || bridgingTestEdgeKeys.has(key)) {
                compactedRecords.set(key, record);
                if (record.sourceInstanceId) reachableFromRoot.add(record.sourceInstanceId);
                if (record.targetInstanceId) reachableFromRoot.add(record.targetInstanceId);
                continue;
            }
            if (!record.targetInstanceId || !reachableFromRoot.has(record.targetInstanceId)) {
                omittedTestCallerKeys.add(key);
                continue;
            }
            if (includedNonBridgingTestCallers >= maxTestCallers) {
                omittedTestCallerKeys.add(key);
                continue;
            }
            compactedRecords.set(key, record);
            includedNonBridgingTestCallers += 1;
            if (record.sourceInstanceId) reachableFromRoot.add(record.sourceInstanceId);
        }

        if (compactedRecords.size <= maxRecords) {
            finalRecords = Array.from(compactedRecords.values());
        } else {
            const priorityEntries: Array<[string, RelationshipRecord]> = [];
            const nonBridgingTestEntries: Array<[string, RelationshipRecord]> = [];
            for (const entry of compactedRecords.entries()) {
                if (testCallerEdgeKeys.has(entry[0]) && !bridgingTestEdgeKeys.has(entry[0])) {
                    nonBridgingTestEntries.push(entry);
                } else {
                    priorityEntries.push(entry);
                }
            }
            const keptKeySet = new Set<string>();
            const keptNodes = new Set<string>([input.symbolInstanceId]);
            for (const [key, record] of priorityEntries) {
                if (keptKeySet.size >= maxRecords) {
                    traversalLimitReached = true;
                    break;
                }
                keptKeySet.add(key);
                if (record.sourceInstanceId) keptNodes.add(record.sourceInstanceId);
                if (record.targetInstanceId) keptNodes.add(record.targetInstanceId);
            }
            for (const [key, record] of nonBridgingTestEntries) {
                if (
                    keptKeySet.size >= maxRecords
                    || !record.targetInstanceId
                    || !keptNodes.has(record.targetInstanceId)
                ) {
                    omittedTestCallerKeys.add(key);
                    continue;
                }
                keptKeySet.add(key);
                if (record.sourceInstanceId) keptNodes.add(record.sourceInstanceId);
            }
            finalRecords = [];
            for (const [key, record] of compactedRecords.entries()) {
                if (keptKeySet.has(key)) finalRecords.push(record);
            }
        }
        if (prioritizeConnectedCallers) {
            // The shared caller/callee limit takes a prefix of this direction.
            // Keep paths to production callers ahead of optional test leaves.
            const requiredCallers: RelationshipRecord[] = [];
            const testLeaves: RelationshipRecord[] = [];
            for (const record of finalRecords) {
                const key = buildRelationshipRecordKey(record);
                if (testCallerEdgeKeys.has(key) && !bridgingTestEdgeKeys.has(key)) {
                    testLeaves.push(record);
                } else {
                    requiredCallers.push(record);
                }
            }
            finalRecords = [...requiredCallers, ...testLeaves];
        }
    }

    const usedNodeIds = new Set<string>([input.symbolInstanceId]);
    for (const record of finalRecords) {
        if (record.sourceInstanceId) usedNodeIds.add(record.sourceInstanceId);
        if (record.targetInstanceId) usedNodeIds.add(record.targetInstanceId);
    }
    const finalVisitedSymbolInstanceIds = visitedSymbolInstanceIds.filter((id) => usedNodeIds.has(id));

    const warnings = [...relationshipSidecar.warnings];
    if (skippedLowConfidence.size > 0) {
        warnings.push(`RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:${skippedLowConfidence.size}`);
    }
    if (omittedTestCallerKeys.size > 0) {
        warnings.push(`RELATIONSHIP_TEST_CALLERS_CAPPED:${omittedTestCallerKeys.size}`);
    }
    if (traversalLimitReached || finalRecords.length >= maxRecords) {
        warnings.push('RELATIONSHIP_TRAVERSAL_LIMIT_REACHED');
    }

    return {
        status: 'ok',
        rootPath: relationshipSidecar.rootPath,
        manifest: relationshipSidecar.manifest,
        records: finalRecords,
        suppressedLowConfidenceRecords: Array.from(suppressedLowConfidenceRecords.values()).sort(compareRelationshipQueryRecords),
        visitedSymbolInstanceIds: finalVisitedSymbolInstanceIds,
        warnings: uniqSortedWarnings(warnings),
    };
}
