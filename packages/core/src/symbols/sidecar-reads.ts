import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION,
    isRelationshipManifest,
    isSymbolRegistryManifest,
} from './contracts';
import { buildSymbolRegistry, computeSymbolRegistryManifestHash } from './registry';
import type {
    RelationshipManifest,
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistryManifest,
    SymbolRegistryManifestFile,
} from './contracts';
import type { SymbolRegistry } from './registry';
import type { RelationshipAnalysisEvidence } from '../relationships';
import {
    SYMBOL_INDEX_SCHEMA_VERSION,
    isRecord,
    isRelationshipAnalysisEvidence,
    isRelationshipRecord,
    isSymbolIndexFile,
    isSymbolRecord,
} from './sidecar-validators';
import type { SymbolIndexFile } from './sidecar-validators';

// Sidecar layout constants shared by reads and the write lifecycle
export const NAVIGATION_DIR_NAME = 'navigation';
export const SYMBOLS_DIR_NAME = 'symbols';
export const RELATIONSHIPS_DIR_NAME = 'relationships';
export const SYMBOL_FILE_CONTRIBUTION_SCHEMA_VERSION = 'symbol_file_contribution_v1';

const SYMBOL_SHARD_READ_CONCURRENCY = 64;
const RELATIONSHIP_SHARD_READ_CONCURRENCY = 8;

// Read boundary input/result contracts
export interface PublicationNavigation {
    publicationId: string;
    navigationRoot: string;
    symbolRegistryManifestHash: string;
    relationshipManifestHash: string;
}

export interface ReadSymbolRegistrySidecarInput {
    normalizedRootPath: string;
    publicationId: string;
    navigationRoot: string;
}

export type ReadSymbolRegistrySidecarResult =
    | {
        status: 'ok';
        publicationId: string;
        rootPath: string;
        manifestHash: string;
        registry: SymbolRegistry;
        warnings: string[];
    }
    | {
        status: 'missing' | 'incompatible' | 'corrupt';
        rootPath: string;
        reason: string;
        registry?: undefined;
        warnings?: undefined;
        manifestHash?: undefined;
    };

export interface ReadRelationshipSidecarInput {
    normalizedRootPath: string;
    expectedSymbolRegistryManifestHash: string;
    publicationId: string;
    navigationRoot: string;
}

export type ReadRelationshipSidecarResult =
    | {
        status: 'ok';
        rootPath: string;
        manifestHash: string;
        manifest: RelationshipManifest;
        records: RelationshipRecord[];
        analysisByFile: Map<string, RelationshipAnalysisEvidence>;
        warnings: string[];
        reason?: undefined;
    }
    | {
        status: 'missing' | 'incompatible' | 'corrupt';
        rootPath: string;
        reason: string;
        manifestHash?: undefined;
        manifest?: undefined;
        records?: undefined;
        analysisByFile?: undefined;
        warnings?: undefined;
    };

// Shared path and file helpers
export function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRootPath(rootPath: string): string {
    const normalized = path.resolve(rootPath).replace(/\\/g, '/');
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function fileShardName(filePath: string, fileHash: string): string {
    const digest = crypto.createHash('sha256')
        .update(`${filePath}\0${fileHash}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `${digest}.json`;
}

// Shared serialization/hash helpers
export function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashSerializedJson(value: unknown): string {
    return crypto.createHash('sha256').update(serializeJson(value), 'utf8').digest('hex');
}

export function hashSerializedString(serialized: string): string {
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

// Generation/seal digest helpers
export function computeNavigationSourceFilesDigest(
    files: readonly Pick<SymbolRegistryManifestFile, 'path' | 'hash'>[],
): string {
    return hashSerializedJson(
        files
            .map((file) => ({ path: file.path, hash: file.hash }))
            .sort((left, right) => compareStrings(left.path, right.path)),
    );
}

export function computeRelationshipManifestHash(manifest: RelationshipManifest): string {
    return hashSerializedJson(manifest);
}

// Deterministic relationship record ordering
export function compareRelationshipRecords(a: RelationshipRecord, b: RelationshipRecord): number {
    if (a.file !== b.file) return compareStrings(a.file, b.file);
    if (a.type !== b.type) return compareStrings(a.type, b.type);
    if (a.sourceKey !== b.sourceKey) return compareStrings(a.sourceKey, b.sourceKey);
    const aTarget = a.targetKey || a.targetInstanceId || a.targetPath || '';
    const bTarget = b.targetKey || b.targetInstanceId || b.targetPath || '';
    if (aTarget !== bTarget) return compareStrings(aTarget, bTarget);
    const aLine = a.span?.startLine ?? 0;
    const bLine = b.span?.startLine ?? 0;
    if (aLine !== bLine) return aLine - bLine;
    return compareStrings(a.sourceInstanceId || '', b.sourceInstanceId || '');
}

// Symbol registry reads
export function buildSymbolIndex(
    manifest: SymbolRegistryManifest,
    manifestHash: string,
    shardHashes: ReadonlyMap<string, string>,
): SymbolIndexFile {
    return {
        schemaVersion: SYMBOL_INDEX_SCHEMA_VERSION,
        manifestHash,
        files: [...manifest.files]
            .map((file) => ({
                path: file.path,
                hash: file.hash,
                language: file.language,
                symbolCount: file.symbolCount,
                definitionStatus: file.definitionStatus,
                shardPath: path.posix.join(SYMBOLS_DIR_NAME, 'by-file', fileShardName(file.path, file.hash)),
                shardHash: shardHashes.get(file.path) ?? '',
            }))
            .sort((a, b) => compareStrings(a.path, b.path)),
    };
}

function symbolIndexMatchesManifest(
    indexFile: SymbolIndexFile,
    manifest: SymbolRegistryManifest,
    manifestHash: string,
): boolean {
    const expected = buildSymbolIndex(
        manifest,
        manifestHash,
        new Map(indexFile.files.map((file) => [file.path, file.shardHash])),
    );
    if (
        indexFile.manifestHash !== expected.manifestHash
        || indexFile.files.length !== expected.files.length
    ) {
        return false;
    }
    return expected.files.every((file, index) => {
        const actual = indexFile.files[index];
        return actual?.path === file.path
            && actual.hash === file.hash
            && actual.language === file.language
            && actual.symbolCount === file.symbolCount
            && actual.definitionStatus === file.definitionStatus
            && actual.shardPath === file.shardPath;
    });
}

export async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

function publicationNavigationPathMatchesIdentity(navigationRoot: string, publicationId: string): boolean {
    return path.basename(navigationRoot) === NAVIGATION_DIR_NAME
        && path.basename(path.dirname(navigationRoot)) === publicationId;
}

export async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput): Promise<ReadSymbolRegistrySidecarResult> {
    const rootPath = path.resolve(input.navigationRoot);
    if (!publicationNavigationPathMatchesIdentity(rootPath, input.publicationId)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'Publication navigation path does not match the requested Publication ID',
        };
    }
    const readableRoot = rootPath;
    const manifestPath = path.join(readableRoot, 'manifest.json');
    const indexPath = path.join(readableRoot, SYMBOLS_DIR_NAME, 'index.json');

    try {
        await fs.promises.access(manifestPath, fs.constants.R_OK);
    } catch {
        return {
            status: 'missing',
            rootPath,
            reason: 'symbol registry manifest is missing',
        };
    }

    let manifest: SymbolRegistryManifest;
    let indexFile: SymbolIndexFile;
    try {
        const rawManifest = await readJson(manifestPath);
        if (!isSymbolRegistryManifest(rawManifest)) {
            return {
                status: isRecord(rawManifest) && typeof rawManifest.schemaVersion === 'string'
                    ? 'incompatible'
                    : 'corrupt',
                rootPath,
                reason: 'symbol registry manifest is invalid or incompatible',
            };
        }
        manifest = rawManifest;

        const rawIndex = await readJson(indexPath);
        if (!isSymbolIndexFile(rawIndex)) {
            return {
                status: 'corrupt',
                rootPath,
                reason: 'symbol registry index is invalid or incompatible',
            };
        }
        indexFile = rawIndex;
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    const manifestHash = computeSymbolRegistryManifestHash(manifest);
    if (normalizeRootPath(manifest.normalizedRootPath) !== normalizeRootPath(input.normalizedRootPath)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'symbol registry manifest root does not match requested codebase root',
        };
    }
    if (!symbolIndexMatchesManifest(indexFile, manifest, manifestHash)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'symbol registry index does not exactly match the manifest and deterministic shard layout',
        };
    }

    try {
        const expectedShardNames = indexFile.files
            .map((file) => path.basename(file.shardPath))
            .sort(compareStrings);
        const actualShardNames = (await fs.promises.readdir(path.join(readableRoot, SYMBOLS_DIR_NAME, 'by-file'), { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .sort(compareStrings);
        if (
            actualShardNames.length !== expectedShardNames.length
            || actualShardNames.some((name, index) => name !== expectedShardNames[index])
        ) {
            return {
                status: 'incompatible',
                rootPath,
                reason: 'symbol registry shard set does not exactly match the manifest index',
            };
        }
        const symbols: SymbolRecord[] = [];
        for (let offset = 0; offset < indexFile.files.length; offset += SYMBOL_SHARD_READ_CONCURRENCY) {
            const batch = indexFile.files.slice(offset, offset + SYMBOL_SHARD_READ_CONCURRENCY);
            const serializedShards = await Promise.all(batch.map((file) => (
                fs.promises.readFile(path.join(readableRoot, file.shardPath), 'utf8')
            )));
            for (let index = 0; index < batch.length; index += 1) {
                const file = batch[index]!;
                const serializedShard = serializedShards[index]!;
                const shard = JSON.parse(serializedShard) as {
                    schemaVersion?: unknown;
                    manifestHash?: unknown;
                    path?: unknown;
                    hash?: unknown;
                    language?: unknown;
                    symbols?: unknown;
                };
                const shardSymbols = shard.symbols;
                const contributionIdentityValid = shard.schemaVersion === SYMBOL_FILE_CONTRIBUTION_SCHEMA_VERSION;
                if (
                    !contributionIdentityValid
                    || shard.path !== file.path
                    || shard.hash !== file.hash
                    || shard.language !== file.language
                    || !Array.isArray(shardSymbols)
                ) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `symbol registry shard is invalid for ${file.path}`,
                    };
                }
                if (shardSymbols.length !== file.symbolCount) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `symbol registry shard symbol count does not match manifest for ${file.path}`,
                    };
                }
                if (!shardSymbols.every((symbol) =>
                    isSymbolRecord(symbol)
                    && symbol.file === file.path
                    && symbol.fileHash === file.hash
                    && symbol.language === file.language
                )) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `symbol registry shard record is invalid for ${file.path}`,
                    };
                }
                symbols.push(...(shardSymbols as SymbolRecord[]));
            }
        }
        const registry = buildSymbolRegistry({ manifest, symbols });
        return {
            status: 'ok',
            publicationId: input.publicationId,
            rootPath,
            manifestHash,
            registry,
            warnings: registry.warnings,
        };
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

// Relationship reads
export async function readRelationshipSidecar(input: ReadRelationshipSidecarInput): Promise<ReadRelationshipSidecarResult> {
    const rootPath = path.resolve(input.navigationRoot);
    if (!publicationNavigationPathMatchesIdentity(rootPath, input.publicationId)) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'Publication navigation path does not match the requested Publication ID',
        };
    }
    const readableRoot = rootPath;
    const relationshipsRoot = path.join(readableRoot, RELATIONSHIPS_DIR_NAME);
    const manifestPath = path.join(relationshipsRoot, 'manifest.json');
    const byFileDir = path.join(relationshipsRoot, 'by-file');

    try {
        await fs.promises.access(manifestPath, fs.constants.R_OK);
    } catch {
        return {
            status: 'missing',
            rootPath,
            reason: 'relationship manifest is missing',
        };
    }

    let manifest: RelationshipManifest;
    let manifestHash: string;
    try {
        const serializedManifest = await fs.promises.readFile(manifestPath, 'utf8');
        const rawManifest = JSON.parse(serializedManifest) as unknown;
        manifestHash = crypto.createHash('sha256').update(serializedManifest, 'utf8').digest('hex');
        if (!isRelationshipManifest(rawManifest)) {
            return {
                status: isRecord(rawManifest) && typeof rawManifest.schemaVersion === 'string'
                    ? 'incompatible'
                    : 'corrupt',
                rootPath,
                reason: 'relationship manifest is invalid or incompatible',
            };
        }
        manifest = rawManifest;
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    if (manifest.symbolRegistryManifestHash !== input.expectedSymbolRegistryManifestHash) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'relationship manifest hash does not match symbol registry manifest hash',
        };
    }

    const records: RelationshipRecord[] = [];
    const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();
    const warnings: string[] = [];
    try {
        const expectedShardNames = manifest.files.map((file) => path.basename(file.shardPath)).sort(compareStrings);
        const actualShardNames = (await fs.promises.readdir(byFileDir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name)
            .sort(compareStrings);
        if (
            actualShardNames.length !== expectedShardNames.length
            || actualShardNames.some((name, index) => name !== expectedShardNames[index])
        ) {
            return {
                status: 'incompatible',
                rootPath,
                reason: 'relationship shard set does not exactly match the relationship manifest',
            };
        }
        for (let offset = 0; offset < manifest.files.length; offset += RELATIONSHIP_SHARD_READ_CONCURRENCY) {
            const batch = manifest.files.slice(offset, offset + RELATIONSHIP_SHARD_READ_CONCURRENCY);
            const serializedShards = await Promise.all(batch.map((file) => (
                fs.promises.readFile(path.join(readableRoot, file.shardPath), 'utf8')
            )));
            for (let index = 0; index < batch.length; index += 1) {
                const file = batch[index]!;
                const expectedShardPath = path.posix.join(
                    RELATIONSHIPS_DIR_NAME,
                    'by-file',
                    fileShardName(file.path, file.hash),
                );
                if (file.shardPath !== expectedShardPath) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `relationship manifest has a non-deterministic shard path for ${file.path}`,
                    };
                }
                const rawShard = JSON.parse(serializedShards[index]!) as unknown;
                if (typeof rawShard !== 'object' || rawShard === null || Array.isArray(rawShard)) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `relationship shard is invalid for ${file.path}`,
                    };
                }
                const shard = rawShard as {
                    schemaVersion?: unknown;
                    manifestHash?: unknown;
                    path?: unknown;
                    hash?: unknown;
                    relationships?: unknown;
                    records?: unknown;
                    analysisEvidence?: unknown;
                };
                const contributionIdentityValid = manifest.fileContributionSchemaVersion
                    === RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION
                    ? shard.schemaVersion === RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION
                    : shard.manifestHash === input.expectedSymbolRegistryManifestHash;
                if (!contributionIdentityValid) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `relationship shard contribution identity does not match manifest for ${file.path}`,
                    };
                }
                if (shard.path !== file.path || shard.hash !== file.hash) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `relationship shard metadata is invalid for ${file.path}`,
                    };
                }
                const shardRecords = Array.isArray(shard.relationships) ? shard.relationships : shard.records;
                if (!Array.isArray(shardRecords) || shardRecords.length !== file.relationshipCount) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `relationship shard record count is invalid for ${file.path}`,
                    };
                }
                for (const record of shardRecords) {
                    if (!isRelationshipRecord(record) || record.file !== shard.path) {
                        return {
                            status: 'incompatible',
                            rootPath,
                            reason: `relationship shard record is invalid for ${file.path}`,
                        };
                    }
                    records.push(record);
                }
                if ((shard.analysisEvidence !== undefined) !== file.analysisEvidencePresent) {
                    return {
                        status: 'incompatible',
                        rootPath,
                        reason: `relationship analysis evidence presence does not match manifest for ${file.path}`,
                    };
                }
                if (shard.analysisEvidence !== undefined) {
                    if (!isRelationshipAnalysisEvidence(shard.analysisEvidence)) {
                        return {
                            status: 'incompatible',
                            rootPath,
                            reason: `relationship analysis evidence is invalid for ${file.path}`,
                        };
                    }
                    if ((shard.analysisEvidence.resolutionClaims ?? []).some((claim) => claim.sourceFile !== shard.path)) {
                        return {
                            status: 'incompatible',
                            rootPath,
                            reason: `relationship resolution claim source does not match ${file.path}`,
                        };
                    }
                    analysisByFile.set(shard.path, shard.analysisEvidence);
                }
            }
        }
    } catch (error) {
        return {
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    return {
        status: 'ok',
        rootPath,
        manifestHash,
        manifest,
        records: records.sort(compareRelationshipRecords),
        analysisByFile,
        warnings: [...new Set(warnings)].sort(compareStrings),
    };
}
