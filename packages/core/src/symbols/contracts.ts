export const SYMBOL_REGISTRY_SCHEMA_VERSION = 'symbol_registry_v1';
export const RELATIONSHIP_MANIFEST_SCHEMA_VERSION = 'relationship_v1';

export type SymbolKind =
    | 'file'
    | 'module'
    | 'namespace'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'trait'
    | 'macro'
    | 'function'
    | 'method'
    | 'property'
    | 'component'
    | 'hook'
    | 'config'
    | 'test';

export type RepositoryOntologyTag =
    | 'API'
    | 'CONTROLLER'
    | 'SERVICE'
    | 'MODEL'
    | 'SCHEMA'
    | 'CONFIG'
    | 'MIGRATION'
    | 'TEST'
    | 'GENERATED'
    | 'HOOK'
    | 'COMPONENT'
    | 'UTILITY';

export interface SymbolSpan {
    startLine: number;
    endLine: number;
    startByte?: number;
    endByte?: number;
    startColumn?: number;
    endColumn?: number;
}

export interface SymbolRecord {
    symbolKey: string;
    symbolInstanceId: string;
    language: string;
    kind: SymbolKind;
    name: string;
    qualifiedName: string;
    label: string;
    file: string;
    span: SymbolSpan;
    parentKey?: string;
    parentQualifiedNamePath: string[];
    exported?: boolean;
    fileHash: string;
    extractorVersion: string;
    ontologyTags?: RepositoryOntologyTag[];
}

export interface SymbolRegistryManifestFile {
    path: string;
    hash: string;
    language: string;
    symbolCount: number;
}

export interface SymbolRegistryManifest {
    schemaVersion: typeof SYMBOL_REGISTRY_SCHEMA_VERSION;
    normalizedRootPath: string;
    rootFingerprint: string;
    repoIdentity?: string;
    indexPolicyHash: string;
    languageRouterVersion: string;
    extractorVersion: string;
    relationshipVersion: string;
    builtAt: string;
    files: SymbolRegistryManifestFile[];
}

export type RelationshipType =
    | 'CALLS'
    | 'IMPORTS'
    | 'EXPORTS'
    | 'EXTENDS'
    | 'IMPLEMENTS'
    | 'REFERENCES'
    | 'TESTS'
    | 'GENERATES'
    | 'CONFIGURES';

export interface RelationshipRecord {
    sourceKey: string;
    sourceInstanceId?: string;
    targetKey?: string;
    targetInstanceId?: string;
    targetPath?: string;
    type: RelationshipType;
    file: string;
    span?: SymbolSpan;
    confidence: 'high' | 'medium' | 'low';
}

export interface RelationshipManifest {
    schemaVersion: typeof RELATIONSHIP_MANIFEST_SCHEMA_VERSION;
    symbolRegistryManifestHash: string;
    relationshipVersion: string;
    builtAt: string;
}

export function canonicalizeSymbolSpanForHash(span: SymbolSpan): string {
    const canonical: Record<string, number> = {
        startLine: span.startLine,
        endLine: span.endLine,
    };
    if (span.startByte !== undefined) {
        canonical.startByte = span.startByte;
    }
    if (span.endByte !== undefined) {
        canonical.endByte = span.endByte;
    }
    if (span.startColumn !== undefined) {
        canonical.startColumn = span.startColumn;
    }
    if (span.endColumn !== undefined) {
        canonical.endColumn = span.endColumn;
    }
    return JSON.stringify(canonical);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0;
}

export function isSymbolRegistryManifest(value: unknown): value is SymbolRegistryManifest {
    if (!isRecord(value)) {
        return false;
    }
    if (value.schemaVersion !== SYMBOL_REGISTRY_SCHEMA_VERSION) {
        return false;
    }
    for (const field of [
        'normalizedRootPath',
        'rootFingerprint',
        'indexPolicyHash',
        'languageRouterVersion',
        'extractorVersion',
        'relationshipVersion',
        'builtAt',
    ]) {
        if (!isNonEmptyString(value[field])) {
            return false;
        }
    }
    if (value.repoIdentity !== undefined && typeof value.repoIdentity !== 'string') {
        return false;
    }
    if (!Array.isArray(value.files)) {
        return false;
    }
    return value.files.every((file) => (
        isRecord(file)
        && isNonEmptyString(file.path)
        && isNonEmptyString(file.hash)
        && isNonEmptyString(file.language)
        && isNonNegativeInteger(file.symbolCount)
    ));
}

export function isRelationshipManifest(value: unknown): value is RelationshipManifest {
    return isRecord(value)
        && value.schemaVersion === RELATIONSHIP_MANIFEST_SCHEMA_VERSION
        && isNonEmptyString(value.symbolRegistryManifestHash)
        && isNonEmptyString(value.relationshipVersion)
        && isNonEmptyString(value.builtAt);
}
