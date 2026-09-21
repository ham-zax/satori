import {
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveOwnerSymbolForChunk,
} from '../symbols';
import type { RelationshipAnalysisEvidence } from '../relationships';
import type { ResolutionClaim } from '../relationships/resolution';
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
    analysisByFile: Map<string, RelationshipAnalysisEvidence>;
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
    publicationId: string;
    navigationRoot: string;
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

export type NavigationResolutionEvidenceMatchKind =
    | 'source_call'
    | 'resolved_target'
    | 'candidate_target';

export interface NavigationResolutionEvidenceQueryInput extends NavigationStoreInput {
    expectedSymbolRegistryManifestHash?: string;
    sourceFile?: string;
    sourceInstanceId?: string;
    symbolInstanceId?: string;
    symbolQualifiedName?: string;
}

export interface NavigationResolutionEvidenceMatch {
    claim: ResolutionClaim;
    matchKind: NavigationResolutionEvidenceMatchKind;
}

export type NavigationResolutionEvidenceState =
    | {
        status: 'ok';
        rootPath: string;
        manifestHash: string;
        manifest: RelationshipManifest;
        matches: NavigationResolutionEvidenceMatch[];
        warnings: string[];
    }
    | NavigationStoreFailure;

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

function relationshipQueryCacheIdentity(input: NavigationRelationshipsQueryInput): string | undefined {
    if (!input.publicationId || !input.expectedSymbolRegistryManifestHash) {
        return undefined;
    }
    return [
        input.publicationId,
        input.expectedSymbolRegistryManifestHash,
        input.direction || 'both',
        input.sourceInstanceId || '',
        input.sourceKey || '',
        input.targetInstanceId || '',
        input.targetKey || '',
        [...(input.types ?? [])].sort(compareStrings).join(','),
    ].join('\0');
}

function relationshipQueryCacheRoot(input: NavigationRelationshipsQueryInput): string {
    return `${input.publicationId}\0${input.navigationRoot}\0${input.normalizedRootPath}`;
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
        publicationId: input.publicationId,
        navigationRoot: input.navigationRoot,
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
        analysisByFile: result.analysisByFile,
        warnings: result.warnings,
    };
}

export class JsonNavigationStore {
    private readonly relationshipStateByRoot = new Map<string, {
        identity: string;
        result: Promise<NavigationRelationshipsState>;
    }>();

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
        const identity = relationshipQueryCacheIdentity(input);
        if (!identity) {
            return readRelationshipState(input);
        }
        const root = relationshipQueryCacheRoot(input);
        const cached = this.relationshipStateByRoot.get(root);
        if (cached?.identity === identity) {
            return cached.result;
        }

        // Publication navigation directories are immutable. Cache only reads
        // bound to one Publication and registry manifest.
        const result = readRelationshipState(input);
        this.relationshipStateByRoot.set(root, { identity, result });
        const resolved = await result;
        if (
            resolved.status !== 'ok'
            && this.relationshipStateByRoot.get(root)?.result === result
        ) {
            this.relationshipStateByRoot.delete(root);
        }
        return resolved;
    }

    public async getResolutionEvidence(
        input: NavigationResolutionEvidenceQueryInput,
    ): Promise<NavigationResolutionEvidenceState> {
        const relationshipState = await this.getRelationships({
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            expectedSymbolRegistryManifestHash: input.expectedSymbolRegistryManifestHash,
        });
        if (relationshipState.status !== 'ok') return relationshipState;

        const sourceFile = input.sourceFile ? normalizeRelativeFilePath(input.sourceFile) : undefined;
        const matches: NavigationResolutionEvidenceMatch[] = [];
        const claims = sourceFile
            ? relationshipState.analysisByFile.get(sourceFile)?.resolutionClaims ?? []
            : [...relationshipState.analysisByFile.values()].flatMap((evidence) => evidence.resolutionClaims ?? []);
        for (const claim of claims) {
            let matchKind: NavigationResolutionEvidenceMatchKind | undefined;
            if (input.sourceInstanceId && claim.sourceInstanceId === input.sourceInstanceId) {
                matchKind = 'source_call';
            } else if (
                (input.symbolInstanceId && claim.targetInstanceId === input.symbolInstanceId)
                || (input.symbolQualifiedName && claim.targetSymbol === input.symbolQualifiedName)
            ) {
                matchKind = 'resolved_target';
            } else if (
                claim.decision !== 'resolved'
                && claim.observation.candidates.some((candidate) => (
                    (input.symbolInstanceId && candidate.symbolInstanceId === input.symbolInstanceId)
                    || (input.symbolQualifiedName && candidate.qualifiedName === input.symbolQualifiedName)
                ))
            ) {
                matchKind = 'candidate_target';
            }
            if (matchKind) matches.push({ claim, matchKind });
        }
        matches.sort((left, right) => (
            compareStrings(left.claim.sourceFile, right.claim.sourceFile)
            || left.claim.callSpan.startByte - right.claim.callSpan.startByte
            || left.claim.callSpan.endByte - right.claim.callSpan.endByte
            || compareStrings(left.matchKind, right.matchKind)
        ));
        return {
            status: 'ok',
            rootPath: relationshipState.rootPath,
            manifestHash: relationshipState.manifestHash,
            manifest: relationshipState.manifest,
            matches,
            warnings: relationshipState.warnings,
        };
    }

    public async getCompatibilityState(input: NavigationCompatibilityInput): Promise<NavigationCompatibilityState> {
        const rootPath = input.navigationRoot;
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

        const relationships = await this.getRelationships({
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            expectedSymbolRegistryManifestHash: expectedManifestHash,
        });

        return {
            rootPath,
            registry,
            relationships,
        };
    }
}
