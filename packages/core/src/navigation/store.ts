import {
    readRelationshipAnalysisEvidence,
    readRelationshipManifestSidecar,
    readRelationshipSidecar,
    readSymbolRegistrySidecar,
    resolveOwnerSymbolForChunk,
    verifyRelationshipSidecarChecksums,
} from '../symbols';
import { PublicationStateCache } from './publication-state-cache';
import type { RelationshipAnalysisEvidence } from '../relationships';
import type { ResolutionClaim } from '../relationships/resolution';
import type {
    ReadSymbolRegistrySidecarResult,
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
    /** Preserve the sidecar reader's corruption status for publication validation. */
    sourceStatus?: 'corrupt';
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

export type NavigationAnalysisEvidenceState =
    | {
        status: 'ok';
        rootPath: string;
        manifestHash: string;
        analysisByFile: Map<string, RelationshipAnalysisEvidence>;
    }
    | NavigationStoreFailure;

export type NavigationResolutionClaimsState =
    | {
        status: 'ok';
        rootPath: string;
        manifestHash: string;
        claims: ResolutionClaim[];
    }
    | NavigationStoreFailure;
export type NavigationRelationshipsState = NavigationStoreRelationshipsOk | NavigationStoreFailure;

export type NavigationRelationshipManifestState =
    | {
        status: 'ok';
        rootPath: string;
        manifestHash: string;
        manifest: RelationshipManifest;
    }
    | NavigationStoreFailure;

export type NavigationRelationshipVerificationState = NavigationRelationshipManifestState;

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

function buildFailure(
    rootPath: string,
    reason: string,
    status: 'missing' | 'incompatible',
    sourceStatus?: 'corrupt',
): NavigationStoreFailure {
    return {
        status,
        rootPath,
        reason,
        ...(sourceStatus ? { sourceStatus } : {}),
    };
}

type RelationshipSelector = Pick<
    NavigationRelationshipsQueryInput,
    'sourceInstanceId' | 'sourceKey' | 'targetInstanceId' | 'targetKey' | 'direction' | 'types'
>;

function hasRelationshipFilter(input: RelationshipSelector): boolean {
    return Boolean(
        (input.direction && input.direction !== 'both')
        || input.sourceInstanceId
        || input.sourceKey
        || input.targetInstanceId
        || input.targetKey
        || (input.types && input.types.length > 0),
    );
}

function selectRelationshipRecords(
    records: readonly RelationshipRecord[],
    input: NavigationRelationshipsQueryInput,
): RelationshipRecord[] {
    const direction = input.direction || 'both';
    const hasSelector = Boolean(
        input.sourceInstanceId
        || input.sourceKey
        || input.targetInstanceId
        || input.targetKey
    );
    return records.filter((record) => {
        if (!matchesType(record, input.types)) {
            return false;
        }
        if (direction === 'callees') {
            return matchesSourceSelector(record, input);
        }
        if (direction === 'callers') {
            return matchesTargetSelector(record, input);
        }
        if (!hasSelector) {
            return true;
        }
        return matchesSourceSelector(record, input) || matchesTargetSelector(record, input);
    });
}

// Resolution-claim locator keys. A claim is indexed under every value that
// getResolutionEvidence can match it by, so the locator selects a superset of
// the shards that contain matches and the exact match logic still decides.
function sourceClaimKey(sourceInstanceId: string): string {
    return `s\0${sourceInstanceId}`;
}

function symbolIdClaimKey(symbolInstanceId: string): string {
    return `i\0${symbolInstanceId}`;
}

function symbolNameClaimKey(qualifiedName: string): string {
    return `n\0${qualifiedName}`;
}

function resolutionClaimKeys(claim: ResolutionClaim): string[] {
    const keys: string[] = [];
    if (claim.sourceInstanceId) keys.push(sourceClaimKey(claim.sourceInstanceId));
    if (claim.targetInstanceId) keys.push(symbolIdClaimKey(claim.targetInstanceId));
    if (claim.targetSymbol) keys.push(symbolNameClaimKey(claim.targetSymbol));
    for (const candidate of claim.observation.candidates) {
        if (candidate.symbolInstanceId) keys.push(symbolIdClaimKey(candidate.symbolInstanceId));
        if (candidate.qualifiedName) keys.push(symbolNameClaimKey(candidate.qualifiedName));
    }
    return keys;
}

function matchResolutionClaim(
    claim: ResolutionClaim,
    input: NavigationResolutionEvidenceQueryInput,
): NavigationResolutionEvidenceMatchKind | undefined {
    if (input.sourceInstanceId && claim.sourceInstanceId === input.sourceInstanceId) {
        return 'source_call';
    }
    if (
        (input.symbolInstanceId && claim.targetInstanceId === input.symbolInstanceId)
        || (input.symbolQualifiedName && claim.targetSymbol === input.symbolQualifiedName)
    ) {
        return 'resolved_target';
    }
    if (
        claim.decision !== 'resolved'
        && claim.observation.candidates.some((candidate) => (
            (input.symbolInstanceId && candidate.symbolInstanceId === input.symbolInstanceId)
            || (input.symbolQualifiedName && candidate.qualifiedName === input.symbolQualifiedName)
        ))
    ) {
        return 'candidate_target';
    }
    return undefined;
}

/**
 * The resident relationship state for one Publication: query edges plus a
 * compact locator of which files hold resolution claims for a symbol. Bulky
 * analysis evidence (call sites, claims, flow facts) stays on disk and is read
 * per file on demand.
 */
type LoadedRelationshipState =
    | NavigationStoreFailure
    | (NavigationStoreRelationshipsOk & {
        claimFilesByKey: Map<string, string[]>;
        /** Per-shard projection by reuse key; detached on retention expiry so in-flight reads stay intact. */
        shardsByReuseKey?: Map<string, RelationshipShardProjection>;
    });

type RelationshipShardProjection = {
    records: readonly RelationshipRecord[];
    claimKeys: readonly string[];
};

async function readRelationshipState(
    input: NavigationStoreInput & { expectedSymbolRegistryManifestHash: string },
    previousShards?: ReadonlyMap<string, RelationshipShardProjection>,
): Promise<LoadedRelationshipState> {
    const claimFilesByKey = new Map<string, string[]>();
    const shardsByReuseKey = new Map<string, RelationshipShardProjection>();
    const parsedClaimKeysByFile = new Map<string, string[]>();
    const result = await readRelationshipSidecar({
        normalizedRootPath: input.normalizedRootPath,
        expectedSymbolRegistryManifestHash: input.expectedSymbolRegistryManifestHash,
        publicationId: input.publicationId,
        navigationRoot: input.navigationRoot,
        visitAnalysisEvidence: (filePath, evidence) => {
            const keys = new Set<string>();
            for (const claim of evidence.resolutionClaims ?? []) {
                for (const key of resolutionClaimKeys(claim)) keys.add(key);
            }
            parsedClaimKeysByFile.set(filePath, [...keys]);
        },
        shardReuse: {
            lookup: (key) => previousShards?.get(key)?.records,
            // Runs in manifest order, so each key lists its files in manifest order.
            visitShard: (filePath, key, records, reused) => {
                const claimKeys = reused
                    ? previousShards!.get(key)!.claimKeys
                    : parsedClaimKeysByFile.get(filePath) ?? [];
                parsedClaimKeysByFile.delete(filePath);
                shardsByReuseKey.set(key, { records, claimKeys });
                for (const claimKey of claimKeys) {
                    const files = claimFilesByKey.get(claimKey);
                    if (!files) {
                        claimFilesByKey.set(claimKey, [filePath]);
                    } else {
                        files.push(filePath);
                    }
                }
            },
        },
    });
    if (result.status !== 'ok') {
        return buildFailure(
            result.rootPath,
            result.reason,
            result.status === 'corrupt' ? 'incompatible' : result.status,
            result.status === 'corrupt' ? 'corrupt' : undefined,
        );
    }
    return {
        status: 'ok',
        rootPath: result.rootPath,
        manifestHash: result.manifestHash,
        manifest: result.manifest,
        records: result.records.sort(compareRelationshipRecords),
        warnings: result.warnings,
        claimFilesByKey,
        shardsByReuseKey,
    };
}

function publicRelationshipState(state: LoadedRelationshipState): NavigationRelationshipsState {
    if (state.status !== 'ok') return state;
    return {
        status: 'ok',
        rootPath: state.rootPath,
        manifestHash: state.manifestHash,
        manifest: state.manifest,
        records: state.records,
        warnings: state.warnings,
    };
}

async function readRelationshipManifestState(
    input: NavigationStoreInput & { expectedSymbolRegistryManifestHash: string },
): Promise<NavigationRelationshipManifestState> {
    const result = await readRelationshipManifestSidecar({
        normalizedRootPath: input.normalizedRootPath,
        expectedSymbolRegistryManifestHash: input.expectedSymbolRegistryManifestHash,
        publicationId: input.publicationId,
        navigationRoot: input.navigationRoot,
    });
    if (result.status !== 'ok') {
        return buildFailure(
            result.rootPath,
            result.reason,
            result.status === 'corrupt' ? 'incompatible' : result.status,
            result.status === 'corrupt' ? 'corrupt' : undefined,
        );
    }
    return {
        status: 'ok',
        rootPath: result.rootPath,
        manifestHash: result.manifestHash,
        manifest: result.manifest,
    };
}

async function readRegistryState(input: NavigationStoreInput): Promise<NavigationRegistryState> {
    const result = await readSymbolRegistrySidecar(input);
    if (result.status !== 'ok') {
        return buildFailure(
            result.rootPath,
            result.reason,
            result.status === 'corrupt' ? 'incompatible' : result.status,
            result.status === 'corrupt' ? 'corrupt' : undefined,
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

export interface JsonNavigationStoreOptions {
    /** Codebase roots whose symbol registry stays resident. */
    maxRegistryRoots?: number;
    /** Codebase roots whose relationship graph stays resident. */
    maxRelationshipRoots?: number;
    /** Resident state is released after this long without use. 0 disables idle release. */
    idleMs?: number;
    /** Release per-shard reuse maps after this window to free V8 heap on query-only hosts. 0 disables. */
    shardReuseRetentionMs?: number;
    /** Available memory threshold below which each cache trims to 1 resident root. 0 disables. */
    lowMemoryThresholdBytes?: number;
    /** Injectable available-memory probe for deterministic tests. */
    availableMemoryBytes?: () => number;
}

const DEFAULT_MAX_REGISTRY_ROOTS = 4;
const DEFAULT_MAX_RELATIONSHIP_ROOTS = 2;
const DEFAULT_NAVIGATION_IDLE_MS = 5 * 60_000;
const DEFAULT_SHARD_REUSE_RETENTION_MS = 60_000;
const DEFAULT_NAVIGATION_LOW_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
// Bounds the transient evidence held while streaming every claim.
const RESOLUTION_CLAIM_SCAN_FILES_PER_READ = 64;

/**
 * Sole owner of parsed navigation state in a process. Publication navigation
 * directories are immutable, so each root keeps one shared registry and one
 * shared relationship graph for its current Publication; superseded, idle and
 * least-recently-used roots are released.
 */
export class JsonNavigationStore {
    private readonly registries: PublicationStateCache<NavigationRegistryState>;
    private readonly relationshipManifests: PublicationStateCache<NavigationRelationshipManifestState>;
    private readonly relationshipVerifications: PublicationStateCache<NavigationRelationshipVerificationState>;
    private readonly relationships: PublicationStateCache<LoadedRelationshipState>;
    private readonly shardReuseRetentionMs: number;

    public constructor(options: JsonNavigationStoreOptions = {}) {
        const idleMs = options.idleMs ?? DEFAULT_NAVIGATION_IDLE_MS;
        const lowMemoryThresholdBytes = options.lowMemoryThresholdBytes ?? DEFAULT_NAVIGATION_LOW_MEMORY_BYTES;
        this.shardReuseRetentionMs = Math.max(0, options.shardReuseRetentionMs ?? DEFAULT_SHARD_REUSE_RETENTION_MS);
        this.registries = new PublicationStateCache({
            maxRoots: options.maxRegistryRoots ?? DEFAULT_MAX_REGISTRY_ROOTS,
            idleMs,
            maxRootsUnderPressure: 1,
            lowMemoryThresholdBytes,
            availableMemoryBytes: options.availableMemoryBytes,
        });
        this.relationshipManifests = new PublicationStateCache({
            maxRoots: options.maxRegistryRoots ?? DEFAULT_MAX_REGISTRY_ROOTS,
            idleMs,
            maxRootsUnderPressure: 1,
            lowMemoryThresholdBytes,
            availableMemoryBytes: options.availableMemoryBytes,
        });
        this.relationshipVerifications = new PublicationStateCache({
            maxRoots: options.maxRegistryRoots ?? DEFAULT_MAX_REGISTRY_ROOTS,
            idleMs,
            maxRootsUnderPressure: 1,
            lowMemoryThresholdBytes,
            availableMemoryBytes: options.availableMemoryBytes,
        });
        this.relationships = new PublicationStateCache({
            maxRoots: options.maxRelationshipRoots ?? DEFAULT_MAX_RELATIONSHIP_ROOTS,
            idleMs,
            maxRootsUnderPressure: 1,
            lowMemoryThresholdBytes,
            availableMemoryBytes: options.availableMemoryBytes,
        });
    }

    public hasResidentRegistry(input: NavigationStoreInput): boolean {
        return this.registries.has(input.normalizedRootPath, registryIdentity(input));
    }

    public hasResidentRelationships(
        input: NavigationStoreInput & { expectedSymbolRegistryManifestHash: string },
    ): boolean {
        return this.relationships.has(input.normalizedRootPath, relationshipIdentity(input));
    }

    public async getManifest(input: NavigationStoreInput): Promise<NavigationRegistryState> {
        return this.readRegistry(input);
    }

    public async getSymbolRegistrySidecarRead(input: NavigationStoreInput): Promise<ReadSymbolRegistrySidecarResult> {
        // Publication navigation directories are immutable, so the cache entry
        // for a publication identity is the sidecar read.
        const state = await this.readRegistry(input);
        if (state.status !== 'ok') {
            return {
                status: state.sourceStatus === 'corrupt' ? 'corrupt' : state.status,
                rootPath: state.rootPath,
                reason: state.reason,
            };
        }
        return {
            status: 'ok',
            publicationId: input.publicationId,
            rootPath: state.rootPath,
            manifestHash: state.manifestHash,
            registry: state.registry,
            warnings: state.warnings,
        };
    }

    public async getSymbolsByFile(input: NavigationSymbolsByFileInput): Promise<NavigationSymbolsByFileResult> {
        const registryState = await this.readRegistry(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbols: registryState.registry.symbolsByFile.get(normalizeRelativeFilePath(input.file)) || [],
        };
    }

    public async getSymbolByInstanceId(input: NavigationSymbolByInstanceIdInput): Promise<NavigationSymbolByInstanceIdResult> {
        const registryState = await this.readRegistry(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbol: registryState.registry.symbolsByInstanceId.get(input.symbolInstanceId) || null,
        };
    }

    public async getSymbolCandidatesByKey(input: NavigationSymbolCandidatesByKeyInput): Promise<NavigationSymbolCandidatesByKeyResult> {
        const registryState = await this.readRegistry(input);
        if (registryState.status !== 'ok') {
            return registryState;
        }
        return {
            ...registryState,
            symbols: registryState.registry.symbolsByKey.get(input.symbolKey) || [],
        };
    }

    public async findOwnerForSpan(input: NavigationOwnerForSpanInput): Promise<NavigationOwnerForSpanResult> {
        const registryState = await this.readRegistry(input);
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

    /**
     * Validate and return the relationship manifest + shard layout without
     * decompressing every per-file relationship shard. Callers that need
     * relationship edges or resolution claims still go through `getRelationships`.
     */
    public async getRelationshipManifest(
        input: NavigationStoreInput & { expectedSymbolRegistryManifestHash?: string },
    ): Promise<NavigationRelationshipManifestState> {
        let expectedSymbolRegistryManifestHash = input.expectedSymbolRegistryManifestHash;
        if (!expectedSymbolRegistryManifestHash) {
            const registryState = await this.readRegistry(input);
            if (registryState.status !== 'ok') return registryState;
            expectedSymbolRegistryManifestHash = registryState.manifestHash;
        }
        const relationshipInput = {
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            expectedSymbolRegistryManifestHash,
        };
        const identity = relationshipIdentity(relationshipInput);
        if (this.relationships.has(input.normalizedRootPath, identity)) {
            const loaded = await this.readRelationships(relationshipInput);
            if (loaded.status !== 'ok') return loaded;
            return {
                status: 'ok',
                rootPath: loaded.rootPath,
                manifestHash: loaded.manifestHash,
                manifest: loaded.manifest,
            };
        }
        return this.relationshipManifests.get(
            input.normalizedRootPath,
            identity,
            () => readRelationshipManifestState(relationshipInput),
            (state) => state.status === 'ok',
        );
    }

    /**
     * Verifies relationship sidecar integrity without hydrating the in-memory
     * relationship graph when publication-bound shard checksums are present.
     * Legacy Publications without checksums fall back to full parsing.
     */
    public async verifyRelationships(
        input: NavigationStoreInput & {
            expectedSymbolRegistryManifestHash: string;
            expectedRelationshipManifestHash?: string;
        },
        onValidation?: () => void,
    ): Promise<NavigationRelationshipVerificationState> {
        const identity = relationshipIdentity(input);
        if (this.relationships.has(input.normalizedRootPath, identity)) {
            const loaded = await this.readRelationships(input);
            if (loaded.status !== 'ok') return loaded;
            if (
                input.expectedRelationshipManifestHash !== undefined
                && loaded.manifestHash !== input.expectedRelationshipManifestHash
            ) {
                return buildFailure(
                    loaded.rootPath,
                    'relationship manifest hash does not match Publication navigation descriptor',
                    'incompatible',
                    'corrupt',
                );
            }
            return {
                status: 'ok',
                rootPath: loaded.rootPath,
                manifestHash: loaded.manifestHash,
                manifest: loaded.manifest,
            };
        }

        const expectedRelationshipManifestHash = input.expectedRelationshipManifestHash;
        if (expectedRelationshipManifestHash === undefined) {
            onValidation?.();
            const full = await this.getRelationships(input);
            if (full.status !== 'ok') return full;
            return {
                status: 'ok',
                rootPath: full.rootPath,
                manifestHash: full.manifestHash,
                manifest: full.manifest,
            };
        }

        return this.relationshipVerifications.get(
            input.normalizedRootPath,
            relationshipVerificationIdentity({ ...input, expectedRelationshipManifestHash }),
            async () => {
                onValidation?.();
                const verified = await verifyRelationshipSidecarChecksums({
                    normalizedRootPath: input.normalizedRootPath,
                    expectedSymbolRegistryManifestHash: input.expectedSymbolRegistryManifestHash,
                    expectedRelationshipManifestHash,
                    publicationId: input.publicationId,
                    navigationRoot: input.navigationRoot,
                });
                if (verified.status === 'ok') {
                    return {
                        status: 'ok',
                        rootPath: verified.rootPath,
                        manifestHash: verified.manifestHash,
                        manifest: verified.manifest,
                    };
                }
                if (verified.status === 'fallback_required') {
                    const full = await this.getRelationships(input);
                    if (full.status !== 'ok') return full;
                    return {
                        status: 'ok',
                        rootPath: full.rootPath,
                        manifestHash: full.manifestHash,
                        manifest: full.manifest,
                    };
                }
                return buildFailure(
                    verified.rootPath,
                    verified.reason,
                    verified.status === 'corrupt' ? 'incompatible' : verified.status,
                    verified.status === 'corrupt' ? 'corrupt' : undefined,
                );
            },
            (state) => state.status === 'ok',
        );
    }

    public async getRelationships(input: NavigationRelationshipsQueryInput): Promise<NavigationRelationshipsState> {
        const state = await this.readRelationships(input);
        if (state.status !== 'ok') return state;
        const publicState = publicRelationshipState(state);
        if (publicState.status !== 'ok' || !hasRelationshipFilter(input)) return publicState;
        return {
            ...publicState,
            records: selectRelationshipRecords(publicState.records, input),
        };
    }

    /**
     * Reads the analysis evidence of the given files from the Publication's
     * relationship shards. Not retained: callers hold it only as long as needed.
     */
    public async getAnalysisEvidenceForFiles(
        input: NavigationStoreInput & { expectedSymbolRegistryManifestHash?: string; files: readonly string[] },
    ): Promise<NavigationAnalysisEvidenceState> {
        const state = await this.readRelationships(input);
        if (state.status !== 'ok') return state;
        return this.readAnalysisEvidence(input, state, input.files.map(normalizeRelativeFilePath));
    }

    /**
     * Streams every resolution claim of the Publication. The result is not
     * retained; per-file evidence other than claims is dropped while reading.
     */
    public async getAllResolutionClaims(
        input: NavigationStoreInput & { expectedSymbolRegistryManifestHash?: string },
    ): Promise<NavigationResolutionClaimsState> {
        const state = await this.readRelationships(input);
        if (state.status !== 'ok') return state;
        const files = state.manifest.files
            .filter((file) => file.analysisEvidencePresent)
            .map((file) => file.path);
        const claims: ResolutionClaim[] = [];
        for (let offset = 0; offset < files.length; offset += RESOLUTION_CLAIM_SCAN_FILES_PER_READ) {
            const evidence = await this.readAnalysisEvidence(
                input,
                state,
                files.slice(offset, offset + RESOLUTION_CLAIM_SCAN_FILES_PER_READ),
            );
            if (evidence.status !== 'ok') return evidence;
            for (const fileEvidence of evidence.analysisByFile.values()) {
                for (const claim of fileEvidence.resolutionClaims ?? []) claims.push(claim);
            }
        }
        return {
            status: 'ok',
            rootPath: state.rootPath,
            manifestHash: state.manifestHash,
            claims,
        };
    }

    public async getResolutionEvidence(
        input: NavigationResolutionEvidenceQueryInput,
    ): Promise<NavigationResolutionEvidenceState> {
        const relationshipState = await this.readRelationships(input);
        if (relationshipState.status !== 'ok') return relationshipState;

        const sourceFile = input.sourceFile ? normalizeRelativeFilePath(input.sourceFile) : undefined;
        let files: string[];
        if (sourceFile) {
            files = [sourceFile];
        } else {
            const selected = new Set<string>();
            const keys = [
                ...(input.sourceInstanceId ? [sourceClaimKey(input.sourceInstanceId)] : []),
                ...(input.symbolInstanceId ? [symbolIdClaimKey(input.symbolInstanceId)] : []),
                ...(input.symbolQualifiedName ? [symbolNameClaimKey(input.symbolQualifiedName)] : []),
            ];
            for (const key of keys) {
                for (const file of relationshipState.claimFilesByKey.get(key) ?? []) selected.add(file);
            }
            files = [...selected];
        }
        const evidence = await this.readAnalysisEvidence(input, relationshipState, files);
        if (evidence.status !== 'ok') return evidence;

        const matches: NavigationResolutionEvidenceMatch[] = [];
        for (const fileEvidence of evidence.analysisByFile.values()) {
            for (const claim of fileEvidence.resolutionClaims ?? []) {
                const matchKind = matchResolutionClaim(claim, input);
                if (matchKind) matches.push({ claim, matchKind });
            }
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
        const registry = await this.readRegistry(input);
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

    private readRegistry(input: NavigationStoreInput): Promise<NavigationRegistryState> {
        const storeInput: NavigationStoreInput = {
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
        };
        return this.registries.get(
            input.normalizedRootPath,
            registryIdentity(input),
            () => readRegistryState(storeInput),
            (state) => state.status === 'ok',
        );
    }

    private async readRelationships(
        input: NavigationStoreInput & { expectedSymbolRegistryManifestHash?: string },
    ): Promise<LoadedRelationshipState> {
        let expectedSymbolRegistryManifestHash = input.expectedSymbolRegistryManifestHash;
        if (!expectedSymbolRegistryManifestHash) {
            const registryState = await this.readRegistry(input);
            if (registryState.status !== 'ok') return registryState;
            expectedSymbolRegistryManifestHash = registryState.manifestHash;
        }
        const relationshipInput = {
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            expectedSymbolRegistryManifestHash,
        };
        return this.relationships.get(
            input.normalizedRootPath,
            relationshipIdentity(relationshipInput),
            (previous) => readRelationshipState(
                relationshipInput,
                previous?.status === 'ok' ? previous.shardsByReuseKey : undefined,
            ),
            (state) => state.status === 'ok',
            (state) => {
                if (state.status !== 'ok' || this.shardReuseRetentionMs === 0 || !state.shardsByReuseKey?.size) {
                    return undefined;
                }
                const releaseShards = () => { state.shardsByReuseKey = undefined; };
                const timer = setTimeout(releaseShards, this.shardReuseRetentionMs);
                timer.unref?.();
                return () => {
                    clearTimeout(timer);
                    releaseShards();
                };
            },
        );
    }

    private async readAnalysisEvidence(
        input: NavigationStoreInput,
        state: NavigationStoreRelationshipsOk,
        files: readonly string[],
    ): Promise<NavigationAnalysisEvidenceState> {
        if (files.length === 0) {
            return { status: 'ok', rootPath: state.rootPath, manifestHash: state.manifestHash, analysisByFile: new Map() };
        }
        const result = await readRelationshipAnalysisEvidence({
            normalizedRootPath: input.normalizedRootPath,
            publicationId: input.publicationId,
            navigationRoot: input.navigationRoot,
            manifest: state.manifest,
            files,
        });
        if (result.status !== 'ok') {
            return buildFailure(
                result.rootPath,
                result.reason,
                result.status === 'corrupt' ? 'incompatible' : result.status,
            );
        }
        return {
            status: 'ok',
            rootPath: state.rootPath,
            manifestHash: state.manifestHash,
            analysisByFile: result.analysisByFile,
        };
    }
}

function registryIdentity(input: NavigationStoreInput): string {
    return `${input.publicationId}\0${input.navigationRoot}`;
}

function relationshipIdentity(
    input: NavigationStoreInput & { expectedSymbolRegistryManifestHash: string },
): string {
    return `${input.publicationId}\0${input.navigationRoot}\0${input.expectedSymbolRegistryManifestHash}`;
}

function relationshipVerificationIdentity(
    input: NavigationStoreInput & {
        expectedSymbolRegistryManifestHash: string;
        expectedRelationshipManifestHash: string;
    },
): string {
    return `${input.publicationId}\0${input.navigationRoot}\0${input.expectedSymbolRegistryManifestHash}\0${input.expectedRelationshipManifestHash}`;
}
