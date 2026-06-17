import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
    isRelationshipManifest,
    isSymbolRegistryManifest,
} from './contracts';
import {
    buildSymbolRegistry,
    computeSymbolRegistryManifestHash,
} from './registry';
import type {
    RelationshipManifest,
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistryManifest,
    SymbolRegistryManifestFile,
} from './contracts';
import type { SymbolRegistry } from './registry';

const NAVIGATION_DIR_NAME = 'navigation';
const SYMBOLS_DIR_NAME = 'symbols';
const RELATIONSHIPS_DIR_NAME = 'relationships';
const SYMBOL_INDEX_SCHEMA_VERSION = 'symbol_index_v1';
const TEMP_ENTRY_PREFIX = '.satori-tmp-';
const BACKUP_ENTRY_PREFIX = '.satori-backup-';

interface SymbolIndexFileEntry {
    path: string;
    hash: string;
    language: string;
    symbolCount: number;
    shardPath: string;
}

interface SymbolIndexFile {
    schemaVersion: typeof SYMBOL_INDEX_SCHEMA_VERSION;
    manifestHash: string;
    files: SymbolIndexFileEntry[];
}

export interface WriteSymbolRegistrySidecarInput {
    registry: SymbolRegistry;
    stateRoot?: string;
}

export interface WriteSymbolRegistrySidecarResult {
    rootPath: string;
    manifestHash: string;
    fileShardCount: number;
    symbolCount: number;
}

export interface WriteRelationshipSidecarInput {
    normalizedRootPath: string;
    symbolRegistryManifestHash: string;
    relationshipVersion: string;
    builtAt: string;
    records: RelationshipRecord[];
    files?: SymbolRegistryManifestFile[];
    stateRoot?: string;
}

export interface WriteRelationshipSidecarResult {
    rootPath: string;
    fileShardCount: number;
    relationshipCount: number;
}

export interface ClearSymbolRegistrySidecarInput {
    normalizedRootPath: string;
    stateRoot?: string;
}

export interface ReadSymbolRegistrySidecarInput {
    normalizedRootPath: string;
    stateRoot?: string;
}

export type ReadSymbolRegistrySidecarResult =
    | {
        status: 'ok';
        rootPath: string;
        manifestHash: string;
        registry: SymbolRegistry;
        warnings: string[];
    }
    | {
        status: 'missing' | 'incompatible';
        rootPath: string;
        reason: string;
        registry?: undefined;
        warnings?: undefined;
        manifestHash?: undefined;
    };

export interface ReadRelationshipSidecarInput {
    normalizedRootPath: string;
    expectedSymbolRegistryManifestHash: string;
    stateRoot?: string;
}

export type ReadRelationshipSidecarResult =
    | {
        status: 'ok';
        rootPath: string;
        manifest: RelationshipManifest;
        records: RelationshipRecord[];
        warnings: string[];
        reason?: undefined;
    }
    | {
        status: 'missing' | 'incompatible';
        rootPath: string;
        reason: string;
        manifest?: undefined;
        records?: undefined;
        warnings?: undefined;
    };

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRootPath(rootPath: string): string {
    const normalized = path.resolve(rootPath).replace(/\\/g, '/');
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function hashRootPath(rootPath: string): string {
    return crypto.createHash('md5').update(normalizeRootPath(rootPath), 'utf8').digest('hex');
}

function defaultStateRoot(): string {
    return process.env.SATORI_STATE_ROOT || path.join(os.homedir(), '.satori');
}

export function resolveNavigationSidecarRoot(stateRoot: string | undefined, normalizedRootPath: string): string {
    return path.join(stateRoot || defaultStateRoot(), NAVIGATION_DIR_NAME, hashRootPath(normalizedRootPath));
}

function fileShardName(filePath: string, fileHash: string): string {
    const digest = crypto.createHash('sha256')
        .update(`${filePath}\0${fileHash}`, 'utf8')
        .digest('hex')
        .slice(0, 32);
    return `${digest}.json`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uniqueSidecarEntryName(kind: string): string {
    return `${kind}${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    try {
        await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function replaceDirectoryWithRollback(
    finalPath: string,
    temporaryPath: string,
    afterReplace?: () => Promise<void>
): Promise<void> {
    const parentDirectory = path.dirname(finalPath);
    const backupPath = path.join(parentDirectory, uniqueSidecarEntryName(BACKUP_ENTRY_PREFIX));
    let backupCreated = false;

    try {
        await fs.promises.rename(finalPath, backupPath);
        backupCreated = true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            await fs.promises.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }

    try {
        await fs.promises.rename(temporaryPath, finalPath);
        if (afterReplace) {
            await afterReplace();
        }
        if (backupCreated) {
            await fs.promises.rm(backupPath, { recursive: true, force: true });
        }
    } catch (error) {
        await fs.promises.rm(finalPath, { recursive: true, force: true }).catch(() => undefined);
        if (backupCreated) {
            await fs.promises.rename(backupPath, finalPath).catch(() => undefined);
        }
        await fs.promises.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

function groupSymbolsByFile(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
    const grouped = new Map<string, SymbolRecord[]>();
    for (const symbol of symbols) {
        const existing = grouped.get(symbol.file);
        if (existing) {
            existing.push(symbol);
            continue;
        }
        grouped.set(symbol.file, [symbol]);
    }
    return grouped;
}

function buildSymbolIndex(manifest: SymbolRegistryManifest, manifestHash: string): SymbolIndexFile {
    return {
        schemaVersion: SYMBOL_INDEX_SCHEMA_VERSION,
        manifestHash,
        files: [...manifest.files]
            .map((file) => ({
                path: file.path,
                hash: file.hash,
                language: file.language,
                symbolCount: file.symbolCount,
                shardPath: path.posix.join(SYMBOLS_DIR_NAME, 'by-file', fileShardName(file.path, file.hash)),
            }))
            .sort((a, b) => compareStrings(a.path, b.path)),
    };
}

function buildRelationshipManifest(registryManifestHash: string, relationshipVersion: string, builtAt: string): RelationshipManifest {
    return {
        schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
        symbolRegistryManifestHash: registryManifestHash,
        relationshipVersion,
        builtAt,
    };
}

function compareRelationshipRecords(a: RelationshipRecord, b: RelationshipRecord): number {
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

function groupRelationshipsByFile(records: RelationshipRecord[]): Map<string, RelationshipRecord[]> {
    const grouped = new Map<string, RelationshipRecord[]>();
    for (const record of records) {
        const existing = grouped.get(record.file);
        if (existing) {
            existing.push(record);
            continue;
        }
        grouped.set(record.file, [record]);
    }
    return grouped;
}

export async function writeSymbolRegistrySidecar(input: WriteSymbolRegistrySidecarInput): Promise<WriteSymbolRegistrySidecarResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.registry.manifest.normalizedRootPath);
    const symbolsDir = path.join(rootPath, SYMBOLS_DIR_NAME);
    const relationshipsDir = path.join(rootPath, RELATIONSHIPS_DIR_NAME);
    const temporarySymbolsDir = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    const temporaryRelationshipsDir = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    const byFileDir = path.join(temporarySymbolsDir, 'by-file');
    const relationshipByFileDir = path.join(temporaryRelationshipsDir, 'by-file');
    const manifestHash = computeSymbolRegistryManifestHash(input.registry.manifest);
    const groupedSymbols = groupSymbolsByFile(input.registry.symbols);
    const relationshipManifestExists = await fs.promises.access(path.join(relationshipsDir, 'manifest.json'), fs.constants.R_OK)
        .then(() => true)
        .catch(() => false);

    try {
        await fs.promises.mkdir(rootPath, { recursive: true });
        await fs.promises.mkdir(byFileDir, { recursive: true });

        await writeJson(path.join(temporarySymbolsDir, 'index.json'), buildSymbolIndex(input.registry.manifest, manifestHash));
        for (const file of input.registry.manifest.files) {
            const symbols = groupedSymbols.get(file.path) || [];
            await writeJson(path.join(byFileDir, fileShardName(file.path, file.hash)), {
                manifestHash,
                path: file.path,
                hash: file.hash,
                language: file.language,
                symbols,
            });
        }

        await replaceDirectoryWithRollback(
            symbolsDir,
            temporarySymbolsDir,
            () => writeJsonAtomically(path.join(rootPath, 'manifest.json'), input.registry.manifest)
        );

        if (!relationshipManifestExists) {
            await fs.promises.mkdir(relationshipByFileDir, { recursive: true });
            await writeJson(
                path.join(temporaryRelationshipsDir, 'manifest.json'),
                buildRelationshipManifest(manifestHash, input.registry.manifest.relationshipVersion, input.registry.manifest.builtAt)
            );
            await replaceDirectoryWithRollback(relationshipsDir, temporaryRelationshipsDir);
        }
    } catch (error) {
        await fs.promises.rm(temporarySymbolsDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.promises.rm(temporaryRelationshipsDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }

    return {
        rootPath,
        manifestHash,
        fileShardCount: input.registry.manifest.files.length,
        symbolCount: input.registry.symbols.length,
    };
}

export async function writeRelationshipSidecar(input: WriteRelationshipSidecarInput): Promise<WriteRelationshipSidecarResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    const relationshipsDir = path.join(rootPath, RELATIONSHIPS_DIR_NAME);
    const temporaryRelationshipsDir = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    const relationshipByFileDir = path.join(temporaryRelationshipsDir, 'by-file');
    const groupedRelationships = groupRelationshipsByFile([...input.records].sort(compareRelationshipRecords));
    const filesByPath = new Map((input.files || []).map((file) => [file.path, file.hash]));

    try {
        await fs.promises.mkdir(rootPath, { recursive: true });
        await fs.promises.mkdir(relationshipByFileDir, { recursive: true });
        await writeJson(
            path.join(temporaryRelationshipsDir, 'manifest.json'),
            buildRelationshipManifest(input.symbolRegistryManifestHash, input.relationshipVersion, input.builtAt)
        );

        for (const [filePath, records] of [...groupedRelationships.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
            const shardHash = filesByPath.get(filePath) || input.symbolRegistryManifestHash;
            await writeJson(path.join(relationshipByFileDir, fileShardName(filePath, shardHash)), {
                manifestHash: input.symbolRegistryManifestHash,
                path: filePath,
                relationships: records,
            });
        }

        await replaceDirectoryWithRollback(relationshipsDir, temporaryRelationshipsDir);
    } catch (error) {
        await fs.promises.rm(temporaryRelationshipsDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }

    return {
        rootPath,
        fileShardCount: groupedRelationships.size,
        relationshipCount: input.records.length,
    };
}

export async function clearSymbolRegistrySidecar(input: ClearSymbolRegistrySidecarInput): Promise<void> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    await fs.promises.rm(rootPath, { recursive: true, force: true });
}

function isSymbolIndexFile(value: unknown): value is SymbolIndexFile {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return record.schemaVersion === SYMBOL_INDEX_SCHEMA_VERSION
        && typeof record.manifestHash === 'string'
        && Array.isArray(record.files);
}

async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

export async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput): Promise<ReadSymbolRegistrySidecarResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    const manifestPath = path.join(rootPath, 'manifest.json');
    const indexPath = path.join(rootPath, SYMBOLS_DIR_NAME, 'index.json');

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
                status: 'incompatible',
                rootPath,
                reason: 'symbol registry manifest is invalid or incompatible',
            };
        }
        manifest = rawManifest;

        const rawIndex = await readJson(indexPath);
        if (!isSymbolIndexFile(rawIndex)) {
            return {
                status: 'incompatible',
                rootPath,
                reason: 'symbol registry index is invalid or incompatible',
            };
        }
        indexFile = rawIndex;
    } catch (error) {
        return {
            status: 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    const manifestHash = computeSymbolRegistryManifestHash(manifest);
    if (indexFile.manifestHash !== manifestHash) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'symbol registry index hash does not match manifest',
        };
    }

    try {
        const symbols: SymbolRecord[] = [];
        for (const file of indexFile.files) {
            const shardPath = path.join(rootPath, file.shardPath);
            const shard = await readJson(shardPath) as { manifestHash?: unknown; symbols?: unknown };
            if (shard.manifestHash !== manifestHash || !Array.isArray(shard.symbols)) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `symbol registry shard is invalid for ${file.path}`,
                };
            }
            symbols.push(...(shard.symbols as SymbolRecord[]));
        }
        const registry = buildSymbolRegistry({ manifest, symbols });
        return {
            status: 'ok',
            rootPath,
            manifestHash,
            registry,
            warnings: registry.warnings,
        };
    } catch (error) {
        return {
            status: 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

function isRelationshipRecord(value: unknown): value is RelationshipRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.sourceKey === 'string'
        && typeof record.type === 'string'
        && typeof record.file === 'string'
        && (record.confidence === 'high' || record.confidence === 'medium' || record.confidence === 'low');
}

export async function readRelationshipSidecar(input: ReadRelationshipSidecarInput): Promise<ReadRelationshipSidecarResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    const relationshipsRoot = path.join(rootPath, RELATIONSHIPS_DIR_NAME);
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
    try {
        const rawManifest = await readJson(manifestPath);
        if (!isRelationshipManifest(rawManifest)) {
            return {
                status: 'incompatible',
                rootPath,
                reason: 'relationship manifest is invalid or incompatible',
            };
        }
        manifest = rawManifest;
    } catch (error) {
        return {
            status: 'incompatible',
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
    const warnings: string[] = [];
    try {
        const entries = await fs.promises.readdir(byFileDir, { withFileTypes: true });
        for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json')).sort((a, b) => compareStrings(a.name, b.name))) {
            const shardPath = path.join(byFileDir, entry.name);
            const rawShard = await readJson(shardPath);
            if (typeof rawShard !== 'object' || rawShard === null || Array.isArray(rawShard)) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `relationship shard is invalid for ${entry.name}`,
                };
            }
            const shard = rawShard as { manifestHash?: unknown; relationships?: unknown; records?: unknown };
            if (shard.manifestHash !== input.expectedSymbolRegistryManifestHash) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `relationship shard hash does not match manifest for ${entry.name}`,
                };
            }
            const shardRecords = Array.isArray(shard.relationships) ? shard.relationships : shard.records;
            if (!Array.isArray(shardRecords)) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `relationship shard records are invalid for ${entry.name}`,
                };
            }
            for (const record of shardRecords) {
                if (isRelationshipRecord(record)) {
                    records.push(record);
                } else {
                    warnings.push(`RELATIONSHIP_RECORD_SKIPPED:${entry.name}`);
                }
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return {
                status: 'incompatible',
                rootPath,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }

    return {
        status: 'ok',
        rootPath,
        manifest,
        records: records.sort(compareRelationshipRecords),
        warnings: [...new Set(warnings)].sort(compareStrings),
    };
}
