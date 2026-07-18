import crypto from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION_ID = /^[a-zA-Z0-9_-]+$/;
const SYMBOL_MANIFEST_HASH = /^symmanifest_[a-f0-9]{32}$/;

export const EMBEDDING_NORMALIZATION_POLICY_VERSION = 'provider_output_v1';

export interface IndexFingerprint {
    embeddingProvider: string;
    embeddingModel: string;
    embeddingDimension: number;
    /** Absent only on fingerprints created before local artifact identity was frozen. */
    embeddingArtifactDigest?: string | null;
    /** Absent only on fingerprints created before normalization policy was explicit. */
    embeddingNormalizationPolicy?: string;
    vectorStoreProvider: string;
    schemaVersion: string;
    /** Absent only on legacy persisted fingerprints. */
    parserVersion?: string;
    extractorVersion?: string;
    relationshipVersion?: string;
    /** Absent only on indexes created before Core-owned projections. */
    embeddingProjectionVersion?: string;
    lexicalProjectionVersion?: string;
}

export interface CanonicalCompletionFingerprint extends IndexFingerprint {
    embeddingArtifactDigest: string | null;
    embeddingNormalizationPolicy: string;
    parserVersion: string;
    extractorVersion: string;
    relationshipVersion: string;
    embeddingProjectionVersion: string;
    lexicalProjectionVersion: string;
}

const LEGACY_BASE_INDEX_FINGERPRINT_FIELDS = [
    'embeddingProvider',
    'embeddingModel',
    'embeddingDimension',
    'vectorStoreProvider',
    'schemaVersion',
] as const;

const LEGACY_ANALYSIS_INDEX_FINGERPRINT_FIELDS = [
    ...LEGACY_BASE_INDEX_FINGERPRINT_FIELDS,
    'parserVersion',
    'extractorVersion',
    'relationshipVersion',
] as const;

const LEGACY_PROJECTION_INDEX_FINGERPRINT_FIELDS = [
    ...LEGACY_ANALYSIS_INDEX_FINGERPRINT_FIELDS,
    'embeddingProjectionVersion',
    'lexicalProjectionVersion',
] as const;

export const INDEX_FINGERPRINT_FIELDS = [
    'embeddingProvider',
    'embeddingModel',
    'embeddingDimension',
    'embeddingArtifactDigest',
    'embeddingNormalizationPolicy',
    'vectorStoreProvider',
    'schemaVersion',
    'parserVersion',
    'extractorVersion',
    'relationshipVersion',
    'embeddingProjectionVersion',
    'lexicalProjectionVersion',
] as const satisfies readonly (keyof IndexFingerprint)[];

export type IndexFingerprintField = typeof INDEX_FINGERPRINT_FIELDS[number];

export type IndexCompatibility =
    | { status: 'compatible'; differingFields: [] }
    | { status: 'requires_reindex'; differingFields: IndexFingerprintField[] }
    | { status: 'malformed'; reason: string };

export type CanonicalNavigationBinding =
    | { status: 'not_bound' }
    | {
        status: 'sealed';
        generationId: string;
        symbolRegistryManifestHash: string;
        relationshipManifestHash: string;
        sealHash: string;
    };

export interface CanonicalCompletionMarker {
    kind: 'satori_index_completion_v3';
    codebasePath: string;
    fingerprint: CanonicalCompletionFingerprint;
    indexedFiles: number;
    totalChunks: number;
    completedAt: string;
    runId: string;
    indexPolicyHash: string;
    indexStatus: 'completed' | 'limit_reached';
    navigation: CanonicalNavigationBinding;
}

export type RetiredCompletionMarkerOwnership = Readonly<{
    kind: 'satori_index_completion_v1' | 'satori_index_completion_v2';
    codebasePath: string;
}>;

export type CompletionMarkerInspection =
    | { status: 'current'; value: CanonicalCompletionMarker }
    | {
        status: 'requires_reindex';
        reason: string;
        /** Present only when the retired marker's stable ownership envelope is valid. */
        ownership?: RetiredCompletionMarkerOwnership;
    }
    | { status: 'corrupt' | 'unsupported'; reason: string };

export type CanonicalPolicyNavigationBinding =
    | { status: 'not_bound' }
    | { status: 'sealed'; generationId: string; sealHash: string };

interface CanonicalIndexPolicyBase {
    canonicalRoot: string;
    customExtensions: string[];
    customIgnorePatterns: string[];
    fileBasedIgnorePatterns: string[];
    profile: 'default' | 'minimal' | 'all-text';
    supportedExtensions: string[];
    effectiveIgnorePatterns: string[];
    policyHash: string;
    collectionName: string;
    navigation: CanonicalPolicyNavigationBinding;
}

export interface CanonicalPublicationBinding {
    activationId: string;
    sourceCheckpoint: {
        collectionName: string;
        markerRunId: string;
        indexPolicyHash: string;
        merkleRoot: string;
        documentDigest: string;
    };
    graph: {
        kind: 'relationship_manifest_v2';
        manifestHash: string;
    };
    receipt: {
        ownerId: string;
        generation: number;
        operationId: string;
    };
}

export interface CanonicalIndexPolicyV3Payload extends CanonicalIndexPolicyBase {
    schemaVersion: 'satori_index_policy_v3';
}

export interface CanonicalIndexPolicyV4Payload extends CanonicalIndexPolicyBase {
    schemaVersion: 'satori_index_policy_v4';
    publication: CanonicalPublicationBinding;
}

export type CanonicalIndexPolicyPayload = CanonicalIndexPolicyV3Payload | CanonicalIndexPolicyV4Payload;

export type CanonicalIndexPolicyDocument = CanonicalIndexPolicyPayload & {
    documentDigest: string;
};

export type IndexPolicyDocumentInspection =
    | { status: 'current'; value: CanonicalIndexPolicyDocument }
    | { status: 'requires_reindex' | 'corrupt' | 'unsupported'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function parseIndexFingerprint(value: unknown): IndexFingerprint | null {
    if (!isRecord(value)) return null;
    if (
        (!hasExactKeys(value, LEGACY_BASE_INDEX_FINGERPRINT_FIELDS)
            && !hasExactKeys(value, LEGACY_ANALYSIS_INDEX_FINGERPRINT_FIELDS)
            && !hasExactKeys(value, LEGACY_PROJECTION_INDEX_FINGERPRINT_FIELDS)
            && !hasExactKeys(value, INDEX_FINGERPRINT_FIELDS))
        || !isNonemptyString(value.embeddingProvider)
        || !isNonemptyString(value.embeddingModel)
        || !isNonNegativeInteger(value.embeddingDimension)
        || value.embeddingDimension === 0
        || (value.embeddingArtifactDigest !== undefined
            && value.embeddingArtifactDigest !== null
            && (typeof value.embeddingArtifactDigest !== 'string'
                || !SHA256.test(value.embeddingArtifactDigest)))
        || (value.embeddingNormalizationPolicy !== undefined
            && !isNonemptyString(value.embeddingNormalizationPolicy))
        || !isNonemptyString(value.vectorStoreProvider)
        || !isNonemptyString(value.schemaVersion)
        || (value.parserVersion !== undefined && !isNonemptyString(value.parserVersion))
        || (value.extractorVersion !== undefined && !isNonemptyString(value.extractorVersion))
        || (value.relationshipVersion !== undefined && !isNonemptyString(value.relationshipVersion))
        || (value.embeddingProjectionVersion !== undefined
            && !isNonemptyString(value.embeddingProjectionVersion))
        || (value.lexicalProjectionVersion !== undefined
            && !isNonemptyString(value.lexicalProjectionVersion))
        || ((value.embeddingProjectionVersion === undefined)
            !== (value.lexicalProjectionVersion === undefined))
    ) return null;
    return {
        embeddingProvider: value.embeddingProvider,
        embeddingModel: value.embeddingModel,
        embeddingDimension: value.embeddingDimension,
        ...(value.embeddingArtifactDigest !== undefined
            ? { embeddingArtifactDigest: value.embeddingArtifactDigest as string | null }
            : {}),
        ...(value.embeddingNormalizationPolicy !== undefined
            ? { embeddingNormalizationPolicy: value.embeddingNormalizationPolicy }
            : {}),
        vectorStoreProvider: value.vectorStoreProvider,
        schemaVersion: value.schemaVersion,
        ...(value.parserVersion !== undefined ? { parserVersion: value.parserVersion } : {}),
        ...(value.extractorVersion !== undefined ? { extractorVersion: value.extractorVersion } : {}),
        ...(value.relationshipVersion !== undefined ? { relationshipVersion: value.relationshipVersion } : {}),
        ...(value.embeddingProjectionVersion !== undefined
            ? { embeddingProjectionVersion: value.embeddingProjectionVersion }
            : {}),
        ...(value.lexicalProjectionVersion !== undefined
            ? { lexicalProjectionVersion: value.lexicalProjectionVersion }
            : {}),
    };
}

function parseCurrentRuntimeFingerprint(value: unknown): CanonicalCompletionFingerprint | null {
    if (!isRecord(value) || !hasExactKeys(value, INDEX_FINGERPRINT_FIELDS)) return null;
    const parsed = parseIndexFingerprint(value);
    if (
        !parsed?.parserVersion
        || parsed.embeddingArtifactDigest === undefined
        || !parsed.embeddingNormalizationPolicy
        || !parsed.extractorVersion
        || !parsed.relationshipVersion
        || !parsed.embeddingProjectionVersion
        || !parsed.lexicalProjectionVersion
    ) return null;
    return {
        ...parsed,
        embeddingArtifactDigest: parsed.embeddingArtifactDigest,
        embeddingNormalizationPolicy: parsed.embeddingNormalizationPolicy,
        parserVersion: parsed.parserVersion,
        extractorVersion: parsed.extractorVersion,
        relationshipVersion: parsed.relationshipVersion,
        embeddingProjectionVersion: parsed.embeddingProjectionVersion,
        lexicalProjectionVersion: parsed.lexicalProjectionVersion,
    };
}

export function compareIndexCompatibility(
    indexed: unknown,
    runtime: IndexFingerprint,
): IndexCompatibility {
    const indexedFingerprint = parseIndexFingerprint(indexed);
    if (!indexedFingerprint) {
        return { status: 'malformed', reason: 'persisted index fingerprint is malformed' };
    }
    const runtimeFingerprint = parseCurrentRuntimeFingerprint(runtime);
    if (!runtimeFingerprint) {
        return { status: 'malformed', reason: 'runtime index fingerprint is malformed' };
    }
    const differingFields = INDEX_FINGERPRINT_FIELDS.filter(
        (field) => indexedFingerprint[field] !== runtimeFingerprint[field],
    );
    return differingFields.length === 0
        ? { status: 'compatible', differingFields: [] }
        : { status: 'requires_reindex', differingFields };
}

export function indexFingerprintsEqual(left: unknown, right: IndexFingerprint): boolean {
    return compareIndexCompatibility(left, right).status === 'compatible';
}

function parseFingerprint(value: unknown): CanonicalCompletionFingerprint | null {
    if (!isRecord(value)) return null;
    const parsed = parseIndexFingerprint(value);
    if (
        (!hasExactKeys(value, LEGACY_ANALYSIS_INDEX_FINGERPRINT_FIELDS)
            && !hasExactKeys(value, LEGACY_PROJECTION_INDEX_FINGERPRINT_FIELDS)
            && !hasExactKeys(value, INDEX_FINGERPRINT_FIELDS))
        || !parsed
        || !parsed.parserVersion
        || !parsed.extractorVersion
        || !parsed.relationshipVersion
    ) return null;
    return {
        ...parsed,
        embeddingArtifactDigest: parsed.embeddingArtifactDigest ?? null,
        embeddingNormalizationPolicy: parsed.embeddingNormalizationPolicy
            ?? 'legacy_unspecified',
        parserVersion: parsed.parserVersion,
        extractorVersion: parsed.extractorVersion,
        relationshipVersion: parsed.relationshipVersion,
        embeddingProjectionVersion: parsed.embeddingProjectionVersion
            ?? 'legacy_unspecified',
        lexicalProjectionVersion: parsed.lexicalProjectionVersion
            ?? 'legacy_unspecified',
    };
}

function parseCanonicalNavigationBinding(value: unknown): CanonicalNavigationBinding | null {
    if (!isRecord(value)) return null;
    if (value.status === 'not_bound' && Object.keys(value).length === 1) {
        return { status: 'not_bound' };
    }
    if (
        !hasExactKeys(value, [
            'status',
            'generationId',
            'symbolRegistryManifestHash',
            'relationshipManifestHash',
            'sealHash',
        ])
        || value.status !== 'sealed'
        || !isNonemptyString(value.generationId)
        || !GENERATION_ID.test(value.generationId)
        || typeof value.symbolRegistryManifestHash !== 'string'
        || !SYMBOL_MANIFEST_HASH.test(value.symbolRegistryManifestHash)
        || typeof value.relationshipManifestHash !== 'string'
        || !SHA256.test(value.relationshipManifestHash)
        || typeof value.sealHash !== 'string'
        || !SHA256.test(value.sealHash)
    ) return null;
    return {
        status: 'sealed',
        generationId: value.generationId,
        symbolRegistryManifestHash: value.symbolRegistryManifestHash,
        relationshipManifestHash: value.relationshipManifestHash,
        sealHash: value.sealHash,
    };
}

function hasValidMarkerEnvelope(record: Record<string, unknown>): boolean {
    return hasExactKeys(record, [
        'kind',
        'codebasePath',
        'fingerprint',
        'indexedFiles',
        'totalChunks',
        'completedAt',
        'runId',
        'indexPolicyHash',
        'indexStatus',
        'navigation',
    ])
        && isNonemptyString(record.codebasePath)
        && isNonNegativeInteger(record.indexedFiles)
        && isNonNegativeInteger(record.totalChunks)
        && typeof record.completedAt === 'string'
        && !Number.isNaN(Date.parse(record.completedAt))
        && isNonemptyString(record.runId)
        && typeof record.indexPolicyHash === 'string'
        && SHA256.test(record.indexPolicyHash);
}

function parseRetiredCompletionMarkerOwnership(
    value: Record<string, unknown>,
    kind: RetiredCompletionMarkerOwnership['kind'],
): RetiredCompletionMarkerOwnership | null {
    if (
        value.kind !== kind
        || !isNonemptyString(value.codebasePath)
        || !parseIndexFingerprint(value.fingerprint)
        || !isNonNegativeInteger(value.indexedFiles)
        || !isNonNegativeInteger(value.totalChunks)
        || typeof value.completedAt !== 'string'
        || Number.isNaN(Date.parse(value.completedAt))
        || !isNonemptyString(value.runId)
        || (kind === 'satori_index_completion_v2' && !isNonemptyString(value.indexPolicyHash))
    ) {
        return null;
    }
    return { kind, codebasePath: value.codebasePath };
}

export function inspectCompletionMarker(value: unknown): CompletionMarkerInspection {
    if (!isRecord(value)) {
        return { status: 'corrupt', reason: 'completion marker is not an object' };
    }
    if (value.kind === 'satori_index_completion_v1') {
        const ownership = parseRetiredCompletionMarkerOwnership(value, value.kind);
        return {
            status: 'requires_reindex',
            reason: 'completion marker v1 requires reindex',
            ...(ownership ? { ownership } : {}),
        };
    }
    if (value.kind === 'satori_index_completion_v3') {
        if (!hasValidMarkerEnvelope(value)) {
            return { status: 'corrupt', reason: 'canonical completion marker envelope is invalid' };
        }
        const fingerprint = parseFingerprint(value.fingerprint);
        if (!fingerprint) {
            return { status: 'corrupt', reason: 'canonical completion marker fingerprint is invalid' };
        }
        if (value.indexStatus !== 'completed' && value.indexStatus !== 'limit_reached') {
            return { status: 'corrupt', reason: 'canonical completion marker status is invalid' };
        }
        const navigation = parseCanonicalNavigationBinding(value.navigation);
        if (!navigation || (value.indexStatus === 'limit_reached' && navigation.status === 'sealed')) {
            return { status: 'corrupt', reason: 'canonical completion marker navigation binding is invalid' };
        }
        return {
            status: 'current',
            value: {
                kind: 'satori_index_completion_v3',
                codebasePath: value.codebasePath as string,
                fingerprint,
                indexedFiles: value.indexedFiles as number,
                totalChunks: value.totalChunks as number,
                completedAt: value.completedAt as string,
                runId: value.runId as string,
                indexPolicyHash: value.indexPolicyHash as string,
                indexStatus: value.indexStatus,
                navigation,
            },
        };
    }
    if (value.kind === 'satori_index_completion_v2') {
        const ownership = parseRetiredCompletionMarkerOwnership(value, value.kind);
        return {
            status: 'requires_reindex',
            reason: 'completion marker v2 requires reindex',
            ...(ownership ? { ownership } : {}),
        };
    }
    const futureVersion = typeof value.kind === 'string'
        ? /^satori_index_completion_v([1-9]\d*)$/.exec(value.kind)
        : null;
    if (futureVersion && Number(futureVersion[1]) > 3) {
        return { status: 'unsupported', reason: 'completion marker schema is unsupported' };
    }
    return { status: 'corrupt', reason: 'completion marker schema is invalid' };
}

function parsePolicyNavigation(value: unknown): CanonicalPolicyNavigationBinding | null {
    if (!isRecord(value)) return null;
    if (value.status === 'not_bound' && Object.keys(value).length === 1) {
        return { status: 'not_bound' };
    }
    if (
        !hasExactKeys(value, ['status', 'generationId', 'sealHash'])
        || value.status !== 'sealed'
        || !isNonemptyString(value.generationId)
        || !GENERATION_ID.test(value.generationId)
        || typeof value.sealHash !== 'string'
        || !SHA256.test(value.sealHash)
    ) return null;
    return { status: 'sealed', generationId: value.generationId, sealHash: value.sealHash };
}

function parsePublicationBinding(value: unknown): CanonicalPublicationBinding | null {
    if (!isRecord(value) || !hasExactKeys(value, [
        'activationId',
        'sourceCheckpoint',
        'graph',
        'receipt',
    ])) return null;
    const checkpoint = value.sourceCheckpoint;
    const graph = value.graph;
    const receipt = value.receipt;
    if (
        !isNonemptyString(value.activationId)
        || !GENERATION_ID.test(value.activationId)
        || !isRecord(checkpoint)
        || !hasExactKeys(checkpoint, ['collectionName', 'markerRunId', 'indexPolicyHash', 'merkleRoot', 'documentDigest'])
        || !isNonemptyString(checkpoint.collectionName)
        || !isNonemptyString(checkpoint.markerRunId)
        || typeof checkpoint.indexPolicyHash !== 'string'
        || !SHA256.test(checkpoint.indexPolicyHash)
        || typeof checkpoint.merkleRoot !== 'string'
        || !SHA256.test(checkpoint.merkleRoot)
        || typeof checkpoint.documentDigest !== 'string'
        || !SHA256.test(checkpoint.documentDigest)
        || !isRecord(graph)
        || !hasExactKeys(graph, ['kind', 'manifestHash'])
        || graph.kind !== 'relationship_manifest_v2'
        || typeof graph.manifestHash !== 'string'
        || !SHA256.test(graph.manifestHash)
        || !isRecord(receipt)
        || !hasExactKeys(receipt, ['ownerId', 'generation', 'operationId'])
        || !isNonemptyString(receipt.ownerId)
        || !isNonNegativeInteger(receipt.generation)
        || receipt.generation < 1
        || !isNonemptyString(receipt.operationId)
    ) return null;
    return {
        activationId: value.activationId,
        sourceCheckpoint: {
            collectionName: checkpoint.collectionName,
            markerRunId: checkpoint.markerRunId,
            indexPolicyHash: checkpoint.indexPolicyHash,
            merkleRoot: checkpoint.merkleRoot,
            documentDigest: checkpoint.documentDigest,
        },
        graph: {
            kind: 'relationship_manifest_v2',
            manifestHash: graph.manifestHash,
        },
        receipt: {
            ownerId: receipt.ownerId,
            generation: receipt.generation,
            operationId: receipt.operationId,
        },
    };
}

function parsePolicyPayload(
    value: Record<string, unknown>,
    expectedRoot: string,
): CanonicalIndexPolicyPayload | null {
    const basePayloadKeys = [
        'schemaVersion',
        'canonicalRoot',
        'customExtensions',
        'customIgnorePatterns',
        'fileBasedIgnorePatterns',
        'profile',
        'supportedExtensions',
        'effectiveIgnorePatterns',
        'policyHash',
        'collectionName',
        'navigation',
    ] as const;
    const isV4 = value.schemaVersion === 'satori_index_policy_v4';
    const payloadKeys = isV4 ? [...basePayloadKeys, 'publication'] : basePayloadKeys;
    if (
        (!hasExactKeys(value, payloadKeys)
            && !hasExactKeys(value, [...payloadKeys, 'documentDigest']))
        || (value.schemaVersion !== 'satori_index_policy_v3' && !isV4)
        || value.canonicalRoot !== expectedRoot
        || !isStringArray(value.customExtensions)
        || !isStringArray(value.customIgnorePatterns)
        || !isStringArray(value.fileBasedIgnorePatterns)
        || !isStringArray(value.supportedExtensions)
        || !isStringArray(value.effectiveIgnorePatterns)
        || (value.profile !== 'default' && value.profile !== 'minimal' && value.profile !== 'all-text')
        || typeof value.policyHash !== 'string'
        || !SHA256.test(value.policyHash)
        || !isNonemptyString(value.collectionName)
    ) return null;
    const navigation = parsePolicyNavigation(value.navigation);
    if (!navigation) return null;
    const publication = isV4 ? parsePublicationBinding(value.publication) : null;
    if (isV4 && !publication) return null;
    if (
        publication
        && (
            publication.sourceCheckpoint.collectionName !== value.collectionName
            || publication.sourceCheckpoint.indexPolicyHash !== value.policyHash
            || navigation.status !== 'sealed'
            || publication.graph.manifestHash.length === 0
        )
    ) return null;
    const base = {
        canonicalRoot: expectedRoot,
        customExtensions: [...value.customExtensions],
        customIgnorePatterns: [...value.customIgnorePatterns],
        fileBasedIgnorePatterns: [...value.fileBasedIgnorePatterns],
        profile: value.profile as CanonicalIndexPolicyBase['profile'],
        supportedExtensions: [...value.supportedExtensions],
        effectiveIgnorePatterns: [...value.effectiveIgnorePatterns],
        policyHash: value.policyHash,
        collectionName: value.collectionName,
        navigation,
    };
    return publication
        ? { ...base, schemaVersion: 'satori_index_policy_v4', publication }
        : { ...base, schemaVersion: 'satori_index_policy_v3' };
}

function digestPolicyPayload(payload: CanonicalIndexPolicyPayload): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

export function buildCanonicalIndexPolicyDocument(
    payload: CanonicalIndexPolicyPayload,
): CanonicalIndexPolicyDocument {
    const parsed = parsePolicyPayload(payload as unknown as Record<string, unknown>, payload.canonicalRoot);
    if (!parsed) throw new Error('Canonical index policy payload is invalid.');
    return { ...parsed, documentDigest: digestPolicyPayload(parsed) };
}

export function inspectIndexPolicyDocument(
    value: unknown,
    expectedRoot: string,
): IndexPolicyDocumentInspection {
    if (!isRecord(value)) {
        return { status: 'corrupt', reason: 'index policy document is not an object' };
    }
    if (value.schemaVersion === 'satori_index_policy_v2') {
        return { status: 'requires_reindex', reason: 'index policy v2 requires reindex' };
    }
    if (value.schemaVersion !== 'satori_index_policy_v3' && value.schemaVersion !== 'satori_index_policy_v4') {
        const futureVersion = typeof value.schemaVersion === 'string'
            ? /^satori_index_policy_v([1-9]\d*)$/.exec(value.schemaVersion)
            : null;
        return futureVersion && Number(futureVersion[1]) > 4
            ? { status: 'unsupported', reason: 'index policy schema is unsupported' }
            : { status: 'corrupt', reason: 'index policy schema is invalid' };
    }
    const payload = parsePolicyPayload(value, expectedRoot);
    if (!payload) {
        return { status: 'corrupt', reason: 'canonical index policy payload is invalid' };
    }
    if (value.documentDigest !== digestPolicyPayload(payload)) {
        return { status: 'corrupt', reason: 'canonical index policy document digest is invalid' };
    }
    return { status: 'current', value: { ...payload, documentDigest: value.documentDigest as string } };
}
