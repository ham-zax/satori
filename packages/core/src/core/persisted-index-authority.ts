import crypto from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION_ID = /^[a-zA-Z0-9_-]+$/;
const SYMBOL_MANIFEST_HASH = /^symmanifest_[a-f0-9]{32}$/;

export interface CanonicalCompletionFingerprint {
    embeddingProvider: string;
    embeddingModel: string;
    embeddingDimension: number;
    vectorStoreProvider: string;
    schemaVersion: string;
    parserVersion: string;
    extractorVersion: string;
    relationshipVersion: string;
}

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

export type CompletionMarkerInspection =
    | { status: 'current'; value: CanonicalCompletionMarker }
    | { status: 'requires_reindex' | 'corrupt' | 'unsupported'; reason: string };

export type CanonicalPolicyNavigationBinding =
    | { status: 'not_bound' }
    | { status: 'sealed'; generationId: string; sealHash: string };

export interface CanonicalIndexPolicyPayload {
    schemaVersion: 'satori_index_policy_v3';
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

export interface CanonicalIndexPolicyDocument extends CanonicalIndexPolicyPayload {
    documentDigest: string;
}

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

function parseFingerprint(value: unknown): CanonicalCompletionFingerprint | null {
    if (!isRecord(value)) return null;
    if (
        !hasExactKeys(value, [
            'embeddingProvider',
            'embeddingModel',
            'embeddingDimension',
            'vectorStoreProvider',
            'schemaVersion',
            'parserVersion',
            'extractorVersion',
            'relationshipVersion',
        ])
        || !isNonemptyString(value.embeddingProvider)
        || !isNonemptyString(value.embeddingModel)
        || !isNonNegativeInteger(value.embeddingDimension)
        || value.embeddingDimension === 0
        || !isNonemptyString(value.vectorStoreProvider)
        || !isNonemptyString(value.schemaVersion)
        || !isNonemptyString(value.parserVersion)
        || !isNonemptyString(value.extractorVersion)
        || !isNonemptyString(value.relationshipVersion)
    ) return null;
    return {
        embeddingProvider: value.embeddingProvider,
        embeddingModel: value.embeddingModel,
        embeddingDimension: value.embeddingDimension,
        vectorStoreProvider: value.vectorStoreProvider,
        schemaVersion: value.schemaVersion,
        parserVersion: value.parserVersion,
        extractorVersion: value.extractorVersion,
        relationshipVersion: value.relationshipVersion,
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

export function inspectCompletionMarker(value: unknown): CompletionMarkerInspection {
    if (!isRecord(value)) {
        return { status: 'corrupt', reason: 'completion marker is not an object' };
    }
    if (value.kind === 'satori_index_completion_v1') {
        return { status: 'requires_reindex', reason: 'completion marker v1 requires reindex' };
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
        return { status: 'requires_reindex', reason: 'completion marker v2 requires reindex' };
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

function parsePolicyPayload(
    value: Record<string, unknown>,
    expectedRoot: string,
): CanonicalIndexPolicyPayload | null {
    const payloadKeys = [
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
    if (
        (!hasExactKeys(value, payloadKeys)
            && !hasExactKeys(value, [...payloadKeys, 'documentDigest']))
        || value.schemaVersion !== 'satori_index_policy_v3'
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
    return {
        schemaVersion: 'satori_index_policy_v3',
        canonicalRoot: expectedRoot,
        customExtensions: [...value.customExtensions],
        customIgnorePatterns: [...value.customIgnorePatterns],
        fileBasedIgnorePatterns: [...value.fileBasedIgnorePatterns],
        profile: value.profile,
        supportedExtensions: [...value.supportedExtensions],
        effectiveIgnorePatterns: [...value.effectiveIgnorePatterns],
        policyHash: value.policyHash,
        collectionName: value.collectionName,
        navigation,
    };
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
    if (value.schemaVersion !== 'satori_index_policy_v3') {
        const futureVersion = typeof value.schemaVersion === 'string'
            ? /^satori_index_policy_v([1-9]\d*)$/.exec(value.schemaVersion)
            : null;
        return futureVersion && Number(futureVersion[1]) > 3
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
