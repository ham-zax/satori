import {
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveNavigationSidecarRoot,
    resolveOwnerSymbolForChunk,
} from '../symbols';
import type {
    RelationshipManifest,
    RelationshipRecord,
    RelationshipType,
    SymbolRecord,
    SymbolRegistry,
    SymbolSpan,
} from '../symbols';

type NavigationStoreFailure = {
    status: 'missing' | 'incompatible';
    rootPath: string;
    reason: string;
};

type NavigationStoreRegistryOk = {
    status: 'ok';
    rootPath: string;
    manifestHash: string;
    registryManifestHash: string;
    registry: SymbolRegistry;
    warnings: string[];
};

type NavigationStoreRelationshipsOk = {
    status: 'ok';
    rootPath: string;
    manifestHash: string;
    manifest: RelationshipManifest;
    records: RelationshipRecord[];
    warnings: string[];
};

type NavigationStoreRelationshipsNotChecked = {
    status: 'not_checked';
    rootPath: string;
    reason: string;
};

export type NavigationRegistryState = NavigationStoreRegistryOk | NavigationStoreFailure;
export type NavigationRelationshipsState = NavigationStoreRelationshipsOk | NavigationStoreFailure;

export interface NavigationStoreInput {
    normalizedRootPath: string;
    stateRoot?: string;
    generationId?: string;
}

export interface NavigationSymbolsByFileInput extends NavigationStoreInput {
    file: string;
}

export type NavigationSymbolsByFileResult =
    | (NavigationStoreRegistryOk & { symbols: SymbolRecord[] })
    | NavigationStoreFailure;

export interface NavigationSymbolByInstanceIdInput extends NavigationStoreInput {
    symbolInstanceId: string;
}

export type NavigationSymbolByInstanceIdResult =
    | (NavigationStoreRegistryOk & { symbol: SymbolRecord | null })
    | NavigationStoreFailure;

export interface NavigationSymbolCandidatesByKeyInput extends NavigationStoreInput {
    symbolKey: string;
}

export type NavigationSymbolCandidatesByKeyResult =
    | (NavigationStoreRegistryOk & { symbols: SymbolRecord[] })
    | NavigationStoreFailure;

export interface NavigationOwnerForSpanInput extends NavigationStoreInput {
    file: string;
    span: SymbolSpan;
}

export type NavigationOwnerForSpanResult =
    | (NavigationStoreRegistryOk & { owner: SymbolRecord | null })
    | NavigationStoreFailure;

export interface NavigationRelationshipsQueryInput extends NavigationStoreInput {
    expectedSymbolRegistryManifestHash?: string;
    sourceInstanceId?: string;
    sourceKey?: string;
    targetInstanceId?: string;
    targetKey?: string;
    direction?: 'callers' | 'callees' | 'both';
    types?: RelationshipType[];
}

export interface NavigationCompatibilityState {
    rootPath: string;
    registry: NavigationRegistryState;
    relationships: NavigationRelationshipsState | NavigationStoreRelationshipsNotChecked;
}

export interface NavigationCompatibilityInput extends NavigationStoreInput {
    expectedSymbolRegistryManifestHash?: string;
}

export interface NavigationStore {
    getManifest(input: NavigationStoreInput): Promise<NavigationRegistryState>;
    getSymbolsByFile(input: NavigationSymbolsByFileInput): Promise<NavigationSymbolsByFileResult>;
    getSymbolByInstanceId(input: NavigationSymbolByInstanceIdInput): Promise<NavigationSymbolByInstanceIdResult>;
    getSymbolCandidatesByKey(input: NavigationSymbolCandidatesByKeyInput): Promise<NavigationSymbolCandidatesByKeyResult>;
    findOwnerForSpan(input: NavigationOwnerForSpanInput): Promise<NavigationOwnerForSpanResult>;
    getRelationships(input: NavigationRelationshipsQueryInput): Promise<NavigationRelationshipsState>;
    getCompatibilityState(input: NavigationCompatibilityInput): Promise<NavigationCompatibilityState>;
}

function normalizeRelativeFilePath(filePath: string): string {
    return filePath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareRelationshipRecords(a: RelationshipRecord, b: RelationshipRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    const aStart = a.span?.startLine ?? 0;
    const bStart = b.span?.startLine ?? 0;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = a.span?.endLine ?? 0;
    const bEnd = b.span?.endLine ?? 0;
    if (aEnd !== bEnd) return aEnd - bEnd;
    if (a.type !== b.type) return compareStrings(a.type, b.type);
    const aSource = a.sourceInstanceId || a.sourceKey;
    const bSource = b.sourceInstanceId || b.sourceKey;
    if (aSource !== bSource) return compareStrings(aSource, bSource);
    const aTarget = a.targetInstanceId || a.targetKey || a.targetPath || '';
    const bTarget = b.targetInstanceId || b.targetKey || b.targetPath || '';
    return compareStrings(aTarget, bTarget);
}

function matchesType(record: RelationshipRecord, types?: RelationshipType[]): boolean {
    return !types || types.length === 0 || types.includes(record.type);
}

function matchesSourceSelector(record: RelationshipRecord, input: NavigationRelationshipsQueryInput): boolean {
    if (input.sourceInstanceId && record.sourceInstanceId !== input.sourceInstanceId) {
        return false;
    }
    if (input.sourceKey && record.sourceKey !== input.sourceKey) {
        return false;
    }
    return Boolean(input.sourceInstanceId || input.sourceKey);
}

function matchesTargetSelector(record: RelationshipRecord, input: NavigationRelationshipsQueryInput): boolean {
    if (input.targetInstanceId && record.targetInstanceId !== input.targetInstanceId) {
        return false;
    }
    if (input.targetKey && record.targetKey !== input.targetKey) {
        return false;
    }
    return Boolean(input.targetInstanceId || input.targetKey);
}

function buildFailure(rootPath: string, reason: string, status: 'missing' | 'incompatible'): NavigationStoreFailure {
    return {
        status,
        rootPath,
        reason,
    };
}

async function readRegistryState(input: NavigationStoreInput): Promise<NavigationRegistryState> {
    const result = await readSymbolRegistrySidecar(input);
    if (result.status !== 'ok') {
        return buildFailure(
            result.rootPath,
            result.reason,
            result.status === 'corrupt' ? 'incompatible' : result.status,
        );
    }
    return {
        status: 'ok',
        rootPath: result.rootPath,
        manifestHash: result.manifestHash,
        registryManifestHash: result.manifestHash,
        registry: result.registry,
        warnings: result.warnings,
    };
}

async function readRelationshipState(input: NavigationRelationshipsQueryInput): Promise<NavigationRelationshipsState> {
    let expectedManifestHash = input.expectedSymbolRegistryManifestHash;
    if (!expectedManifestHash) {
        const registryState = await readRegistryState(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        expectedManifestHash = registryState.manifestHash;
    }

    const result = await readRelationshipSidecar({
        normalizedRootPath: input.normalizedRootPath,
        stateRoot: input.stateRoot,
        generationId: input.generationId,
        expectedSymbolRegistryManifestHash: expectedManifestHash,
    });
    if (result.status !== 'ok') {
        return buildFailure(
            result.rootPath,
            result.reason,
            result.status === 'corrupt' ? 'incompatible' : result.status,
        );
    }

    const direction = input.direction || 'both';
    const records = result.records.filter((record) => {
        if (!matchesType(record, input.types)) {
            return false;
        }
        if (direction === 'callees') {
            return matchesSourceSelector(record, input);
        }
        if (direction === 'callers') {
            return matchesTargetSelector(record, input);
        }
        const hasSelector = Boolean(
            input.sourceInstanceId
            || input.sourceKey
            || input.targetInstanceId
            || input.targetKey
        );
        if (!hasSelector) {
            return true;
        }
        return matchesSourceSelector(record, input) || matchesTargetSelector(record, input);
    });

    return {
        status: 'ok',
        rootPath: result.rootPath,
        manifestHash: result.manifestHash,
        manifest: result.manifest,
        records: [...records].sort(compareRelationshipRecords),
        warnings: result.warnings,
    };
}

export class JsonNavigationStore implements NavigationStore {
    public async getManifest(input: NavigationStoreInput): Promise<NavigationRegistryState> {
        return readRegistryState(input);
    }

    public async getSymbolsByFile(input: NavigationSymbolsByFileInput): Promise<NavigationSymbolsByFileResult> {
        const registryState = await readRegistryState(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbols: registryState.registry.symbolsByFile.get(normalizeRelativeFilePath(input.file)) || [],
        };
    }

    public async getSymbolByInstanceId(input: NavigationSymbolByInstanceIdInput): Promise<NavigationSymbolByInstanceIdResult> {
        const registryState = await readRegistryState(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbol: registryState.registry.symbolsByInstanceId.get(input.symbolInstanceId) || null,
        };
    }

    public async getSymbolCandidatesByKey(input: NavigationSymbolCandidatesByKeyInput): Promise<NavigationSymbolCandidatesByKeyResult> {
        const registryState = await readRegistryState(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbols: registryState.registry.symbolsByKey.get(input.symbolKey) || [],
        };
    }

    public async findOwnerForSpan(input: NavigationOwnerForSpanInput): Promise<NavigationOwnerForSpanResult> {
        const registryState = await readRegistryState(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }

        const symbols = registryState.registry.symbolsByFile.get(normalizeRelativeFilePath(input.file)) || [];
        if (symbols.length === 0) {
            return {
                ...registryState,
                owner: null,
            };
        }

        try {
            const owner = resolveOwnerSymbolForChunk({
                chunk: {
                    content: '',
                    metadata: {
                        startLine: input.span.startLine,
                        endLine: input.span.endLine,
                        ...(input.span.startByte !== undefined ? { startByte: input.span.startByte } : {}),
                        ...(input.span.endByte !== undefined ? { endByte: input.span.endByte } : {}),
                        ...(input.span.startColumn !== undefined ? { startColumn: input.span.startColumn } : {}),
                        ...(input.span.endColumn !== undefined ? { endColumn: input.span.endColumn } : {}),
                        filePath: normalizeRelativeFilePath(input.file),
                    },
                },
                symbols,
            });
            return {
                ...registryState,
                owner,
            };
        } catch {
            return {
                ...registryState,
                owner: null,
            };
        }
    }

    public async getRelationships(input: NavigationRelationshipsQueryInput): Promise<NavigationRelationshipsState> {
        return readRelationshipState(input);
    }

    public async getCompatibilityState(input: NavigationCompatibilityInput): Promise<NavigationCompatibilityState> {
        const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
        const registry = await readRegistryState(input);
        const expectedManifestHash = input.expectedSymbolRegistryManifestHash
            || (registry.status === 'ok' ? registry.manifestHash : undefined);

        if (!expectedManifestHash) {
            return {
                rootPath,
                registry,
                relationships: {
                    status: 'not_checked',
                    rootPath,
                    reason: 'symbol registry is unavailable; relationship compatibility was not checked',
                },
            };
        }

        const relationships = await readRelationshipState({
            normalizedRootPath: input.normalizedRootPath,
            stateRoot: input.stateRoot,
            generationId: input.generationId,
            expectedSymbolRegistryManifestHash: expectedManifestHash,
        });

        return {
            rootPath,
            registry,
            relationships,
        };
    }
}
