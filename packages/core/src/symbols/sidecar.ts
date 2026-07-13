import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
    isRepositoryRelativePath,
    isRelationshipManifest,
    isSymbolKind,
    isSymbolRegistryManifest,
} from './contracts';
import {
    buildSymbolRegistry,
    computeSymbolRegistryManifestHash,
} from './registry';
import type {
    RelationshipManifest,
    RelationshipManifestFile,
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistryManifest,
    SymbolRegistryManifestFile,
} from './contracts';
import type { SymbolRegistry } from './registry';
import type { RelationshipAnalysisEvidence } from '../relationships';

const NAVIGATION_DIR_NAME = 'navigation';
const SYMBOLS_DIR_NAME = 'symbols';
const RELATIONSHIPS_DIR_NAME = 'relationships';
const SYMBOL_INDEX_SCHEMA_VERSION = 'symbol_index_v2';
const TEMP_ENTRY_PREFIX = '.satori-tmp-';
const BACKUP_ENTRY_PREFIX = '.satori-backup-';
const GENERATIONS_DIR_NAME = 'generations';
const CURRENT_GENERATION_FILE_NAME = 'current.json';
const CURRENT_GENERATION_SCHEMA_VERSION = 'navigation_current_v3';
const NAVIGATION_GENERATION_SEAL_SCHEMA_VERSION = 'navigation_generation_seal_v1';
const NAVIGATION_GENERATION_SEAL_FILE_NAME = 'seal.json';

export class RetiredNavigationPointerError extends Error {}

export class UnsupportedNavigationPointerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsupportedNavigationPointerError';
    }
}

export interface NavigationSymbolQualityAggregate {
    indexedFileCount: number;
    languages: Array<{
        language: string;
        indexedFiles: number;
        filesWithNonFileSymbols: number;
        nonFileSymbolCount: number;
    }>;
}

export interface NavigationGenerationSeal {
    schemaVersion: typeof NAVIGATION_GENERATION_SEAL_SCHEMA_VERSION;
    generationId: string;
    symbolRegistryManifestHash: string;
    relationshipManifestHash: string;
    artifactSetHash: string;
    symbolQuality: NavigationSymbolQualityAggregate;
}

interface SymbolIndexFileEntry {
    path: string;
    hash: string;
    language: string;
    symbolCount: number;
    shardPath: string;
    shardHash: string;
}

interface SymbolIndexFile {
    schemaVersion: typeof SYMBOL_INDEX_SCHEMA_VERSION;
    manifestHash: string;
    files: SymbolIndexFileEntry[];
}

export interface WriteSymbolRegistrySidecarInput {
    registry: SymbolRegistry;
    stateRoot?: string;
    beforePublish?: () => void;
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
    analysisByFile?: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>;
    files?: SymbolRegistryManifestFile[];
    stateRoot?: string;
    beforePublish?: () => void;
}

export interface WriteRelationshipSidecarResult {
    rootPath: string;
    manifestHash: string;
    fileShardCount: number;
    relationshipCount: number;
}

export interface ClearSymbolRegistrySidecarInput {
    normalizedRootPath: string;
    stateRoot?: string;
    beforeDelete?: () => void;
    publishMutation?: (publish: () => void) => void;
}

export interface WriteNavigationSidecarGenerationInput {
    registry: SymbolRegistry;
    records: RelationshipRecord[];
    analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>;
    stateRoot?: string;
    beforePublish?: () => void;
    publishMutation?: (publish: () => void) => void;
}

export interface WriteNavigationSidecarGenerationResult extends WriteSymbolRegistrySidecarResult {
    generationId: string;
    relationshipCount: number;
    relationshipFileShardCount: number;
}

export interface StagedNavigationSidecarGeneration extends WriteNavigationSidecarGenerationResult {
    normalizedRootPath: string;
    relationshipManifestHash: string;
    navigationSealHash: string;
}

export type NavigationGenerationPointerCandidate = Pick<
    StagedNavigationSidecarGeneration,
    'rootPath' | 'normalizedRootPath' | 'generationId' | 'manifestHash' | 'relationshipManifestHash' | 'navigationSealHash'
>;

export interface CurrentNavigationGeneration {
    generationId: string;
    generationRoot: string;
    symbolRegistryManifestHash: string;
    relationshipManifestHash: string;
    navigationSealHash: string;
}

export type ReadNavigationGenerationSealResult =
    | { status: 'ok'; rootPath: string; seal: NavigationGenerationSeal }
    | { status: 'missing' | 'incompatible' | 'corrupt'; rootPath: string; reason: string };

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
    stateRoot?: string;
}

export type ReadRelationshipSidecarResult =
    | {
        status: 'ok';
        rootPath: string;
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
        manifest?: undefined;
        records?: undefined;
        analysisByFile?: undefined;
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
    await fs.promises.writeFile(filePath, serializeJson(value), 'utf8');
}

function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function hashSerializedJson(value: unknown): string {
    return crypto.createHash('sha256').update(serializeJson(value), 'utf8').digest('hex');
}

export function computeNavigationGenerationSealHash(seal: NavigationGenerationSeal): string {
    return hashSerializedJson(seal);
}

function buildNavigationSymbolQualityAggregate(registry: SymbolRegistry): NavigationSymbolQualityAggregate {
    const nonFileSymbolsByPath = new Map<string, number>();
    for (const symbol of registry.symbols) {
        if (symbol.kind !== 'file') {
            nonFileSymbolsByPath.set(symbol.file, (nonFileSymbolsByPath.get(symbol.file) ?? 0) + 1);
        }
    }
    const languageStats = new Map<string, NavigationSymbolQualityAggregate['languages'][number]>();
    for (const file of registry.manifest.files) {
        const language = file.language.trim().toLowerCase() || 'unknown';
        const stats = languageStats.get(language) ?? {
            language,
            indexedFiles: 0,
            filesWithNonFileSymbols: 0,
            nonFileSymbolCount: 0,
        };
        const nonFileSymbolCount = nonFileSymbolsByPath.get(file.path) ?? 0;
        stats.indexedFiles += 1;
        stats.filesWithNonFileSymbols += nonFileSymbolCount > 0 ? 1 : 0;
        stats.nonFileSymbolCount += nonFileSymbolCount;
        languageStats.set(language, stats);
    }
    return {
        indexedFileCount: registry.manifest.files.length,
        languages: [...languageStats.values()].sort((left, right) => compareStrings(left.language, right.language)),
    };
}

function uniqueSidecarEntryName(kind: string): string {
    return `${kind}${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

async function writeJsonAtomically(filePath: string, value: unknown, beforePublish?: () => void): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    try {
        await fs.promises.writeFile(temporaryPath, serializeJson(value), 'utf8');
        beforePublish?.();
        await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function replaceDirectoryWithRollback(
    finalPath: string,
    temporaryPath: string,
    afterReplace?: () => Promise<void>,
    beforePublish?: () => void,
): Promise<void> {
    const parentDirectory = path.dirname(finalPath);
    const backupPath = path.join(parentDirectory, uniqueSidecarEntryName(BACKUP_ENTRY_PREFIX));
    let backupCreated = false;

    beforePublish?.();
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
        beforePublish?.();
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

function buildSymbolIndex(
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
                shardPath: path.posix.join(SYMBOLS_DIR_NAME, 'by-file', fileShardName(file.path, file.hash)),
                shardHash: shardHashes.get(file.path) ?? '',
            }))
            .sort((a, b) => compareStrings(a.path, b.path)),
    };
}

function buildRelationshipManifest(
    registryManifestHash: string,
    relationshipVersion: string,
    builtAt: string,
    files: RelationshipManifestFile[],
): RelationshipManifest {
    return {
        schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
        symbolRegistryManifestHash: registryManifestHash,
        relationshipVersion,
        builtAt,
        files: [...files].sort((a, b) => compareStrings(a.path, b.path)),
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

function getRelationshipAnalysisEvidence(
    analysisByFile: WriteRelationshipSidecarInput['analysisByFile'],
    filePath: string,
): RelationshipAnalysisEvidence | undefined {
    if (!analysisByFile) return undefined;
    return analysisByFile instanceof Map ? analysisByFile.get(filePath) : analysisByFile[filePath];
}

function getRelationshipAnalysisEvidencePaths(
    analysisByFile: WriteRelationshipSidecarInput['analysisByFile'],
): string[] {
    if (!analysisByFile) return [];
    return analysisByFile instanceof Map
        ? [...analysisByFile.keys()]
        : Object.keys(analysisByFile);
}

export async function writeSymbolRegistrySidecar(input: WriteSymbolRegistrySidecarInput): Promise<WriteSymbolRegistrySidecarResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.registry.manifest.normalizedRootPath);
    const symbolsDir = path.join(rootPath, SYMBOLS_DIR_NAME);
    const temporarySymbolsDir = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    const byFileDir = path.join(temporarySymbolsDir, 'by-file');
    const manifestHash = computeSymbolRegistryManifestHash(input.registry.manifest);
    const groupedSymbols = groupSymbolsByFile(input.registry.symbols);

    try {
        await fs.promises.mkdir(rootPath, { recursive: true });
        await fs.promises.mkdir(byFileDir, { recursive: true });

        const shardHashes = new Map<string, string>();
        for (const file of input.registry.manifest.files) {
            const symbols = groupedSymbols.get(file.path) || [];
            const shard = {
                manifestHash,
                path: file.path,
                hash: file.hash,
                language: file.language,
                symbols,
            };
            shardHashes.set(file.path, hashSerializedJson(shard));
            await writeJson(path.join(byFileDir, fileShardName(file.path, file.hash)), shard);
        }
        await writeJson(path.join(temporarySymbolsDir, 'index.json'), buildSymbolIndex(input.registry.manifest, manifestHash, shardHashes));

        await replaceDirectoryWithRollback(
            symbolsDir,
            temporarySymbolsDir,
            () => writeJsonAtomically(path.join(rootPath, 'manifest.json'), input.registry.manifest, input.beforePublish),
            input.beforePublish,
        );

    } catch (error) {
        await fs.promises.rm(temporarySymbolsDir, { recursive: true, force: true }).catch(() => undefined);
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
    const filesByPath = new Map((input.files || []).map((file) => [file.path, file]));
    const allowedEvidencePaths = input.files ? new Set(filesByPath.keys()) : undefined;
    if (allowedEvidencePaths) {
        const foreignRecord = input.records.find((record) => !allowedEvidencePaths.has(record.file));
        if (foreignRecord) {
            throw new Error(`Relationship record for '${foreignRecord.file}' is outside the supplied symbol manifest.`);
        }
    }
    const shardPaths = allowedEvidencePaths
        ? new Set(allowedEvidencePaths)
        : new Set(groupedRelationships.keys());
    for (const filePath of getRelationshipAnalysisEvidencePaths(input.analysisByFile)) {
        if (!allowedEvidencePaths || allowedEvidencePaths.has(filePath)) {
            shardPaths.add(filePath);
        }
    }

    let manifestHash = '';
    try {
        await fs.promises.mkdir(rootPath, { recursive: true });
        await fs.promises.mkdir(relationshipByFileDir, { recursive: true });
        const manifestFiles: RelationshipManifestFile[] = [];

        for (const filePath of [...shardPaths].sort(compareStrings)) {
            const records = groupedRelationships.get(filePath) ?? [];
            const fileHash = filesByPath.get(filePath)?.hash || input.symbolRegistryManifestHash;
            const analysisEvidence = !allowedEvidencePaths || allowedEvidencePaths.has(filePath)
                ? getRelationshipAnalysisEvidence(input.analysisByFile, filePath)
                : undefined;
            const shard = {
                manifestHash: input.symbolRegistryManifestHash,
                path: filePath,
                hash: fileHash,
                relationships: records,
                analysisEvidence,
            };
            const shardPath = path.posix.join(RELATIONSHIPS_DIR_NAME, 'by-file', fileShardName(filePath, fileHash));
            await writeJson(path.join(temporaryRelationshipsDir, 'by-file', path.basename(shardPath)), shard);
            manifestFiles.push({
                path: filePath,
                hash: fileHash,
                shardPath,
                shardHash: hashSerializedJson(shard),
                relationshipCount: records.length,
                analysisEvidencePresent: analysisEvidence !== undefined,
            });
        }

        const manifest = buildRelationshipManifest(
            input.symbolRegistryManifestHash,
            input.relationshipVersion,
            input.builtAt,
            manifestFiles,
        );
        manifestHash = hashSerializedJson(manifest);
        await writeJson(path.join(temporaryRelationshipsDir, 'manifest.json'), manifest);

        await replaceDirectoryWithRollback(relationshipsDir, temporaryRelationshipsDir, undefined, input.beforePublish);
    } catch (error) {
        await fs.promises.rm(temporaryRelationshipsDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }

    return {
        rootPath,
        manifestHash,
        fileShardCount: shardPaths.size,
        relationshipCount: input.records.length,
    };
}

async function publishCurrentGenerationPointer(
    rootPath: string,
    pointer: {
        schemaVersion: typeof CURRENT_GENERATION_SCHEMA_VERSION;
        generationId: string;
        symbolRegistryManifestHash: string;
        relationshipManifestHash: string;
        navigationSealHash: string;
    },
    beforePublish?: () => void,
    publishMutation?: (publish: () => void) => void,
): Promise<void> {
    await fs.promises.mkdir(rootPath, { recursive: true });
    const pointerPath = path.join(rootPath, CURRENT_GENERATION_FILE_NAME);
    const temporaryPath = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    let published = false;
    let publicationCount = 0;
    try {
        await fs.promises.writeFile(temporaryPath, serializeJson(pointer), 'utf8');
        if (publishMutation) {
            publishMutation(() => {
                publicationCount += 1;
                if (publicationCount > 1) {
                    throw new Error('Navigation generation publication callback invoked publish more than once.');
                }
                fs.renameSync(temporaryPath, pointerPath);
                published = true;
            });
            if (!published || publicationCount !== 1) {
                throw new Error('Navigation generation publication callback returned without publishing the pointer.');
            }
        } else {
            beforePublish?.();
            await fs.promises.rename(temporaryPath, pointerPath);
            published = true;
        }
    } finally {
        if (!published) {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
    }
}

export async function writeNavigationSidecarGeneration(
    input: WriteNavigationSidecarGenerationInput,
): Promise<WriteNavigationSidecarGenerationResult> {
    const staged = await stageNavigationSidecarGeneration(input);
    await publishNavigationSidecarGeneration(staged, {
        beforePublish: input.beforePublish,
        publishMutation: input.publishMutation,
    });
    return staged;
}

export async function stageNavigationSidecarGeneration(
    input: Omit<WriteNavigationSidecarGenerationInput, 'beforePublish' | 'publishMutation'>,
): Promise<StagedNavigationSidecarGeneration> {
    const rootPath = resolveNavigationSidecarRoot(
        input.stateRoot,
        input.registry.manifest.normalizedRootPath,
    );
    for (const file of input.registry.manifest.files) {
        if (!getRelationshipAnalysisEvidence(input.analysisByFile, file.path)) {
            throw new Error(`Relationship analysis evidence is missing for manifest file '${file.path}'.`);
        }
    }

    const buildStateRoot = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    let generationRoot: string | undefined;
    try {
        const symbolResult = await writeSymbolRegistrySidecar({
            stateRoot: buildStateRoot,
            registry: input.registry,
        });
        const relationshipResult = await writeRelationshipSidecar({
            stateRoot: buildStateRoot,
            normalizedRootPath: input.registry.manifest.normalizedRootPath,
            symbolRegistryManifestHash: symbolResult.manifestHash,
            relationshipVersion: input.registry.manifest.relationshipVersion,
            builtAt: input.registry.manifest.builtAt,
            files: input.registry.manifest.files,
            records: input.records,
            analysisByFile: input.analysisByFile,
        });

        const builtRoot = symbolResult.rootPath;
        const generationId = `${symbolResult.manifestHash.slice(0, 16)}-${crypto.randomBytes(8).toString('hex')}`;
        generationRoot = path.join(rootPath, GENERATIONS_DIR_NAME, generationId);
        await fs.promises.mkdir(path.dirname(generationRoot), { recursive: true });
        await fs.promises.rename(builtRoot, generationRoot);

        const symbolIndex = await readJson(path.join(generationRoot, SYMBOLS_DIR_NAME, 'index.json'));
        const relationshipManifest = await readJson(path.join(generationRoot, RELATIONSHIPS_DIR_NAME, 'manifest.json'));
        if (!isSymbolIndexFile(symbolIndex) || !isRelationshipManifest(relationshipManifest)) {
            throw new Error('Staged navigation generation cannot be sealed because its artifact manifests are invalid.');
        }
        const artifactSet = [
            ...symbolIndex.files.map((file) => ({ path: file.shardPath, hash: file.shardHash })),
            ...relationshipManifest.files.map((file) => ({ path: file.shardPath, hash: file.shardHash })),
        ].sort((left, right) => compareStrings(left.path, right.path));
        const seal: NavigationGenerationSeal = {
            schemaVersion: NAVIGATION_GENERATION_SEAL_SCHEMA_VERSION,
            generationId,
            symbolRegistryManifestHash: symbolResult.manifestHash,
            relationshipManifestHash: relationshipResult.manifestHash,
            artifactSetHash: hashSerializedJson(artifactSet),
            symbolQuality: buildNavigationSymbolQualityAggregate(input.registry),
        };
        await writeJson(path.join(generationRoot, NAVIGATION_GENERATION_SEAL_FILE_NAME), seal);
        const navigationSealHash = computeNavigationGenerationSealHash(seal);

        return {
            rootPath,
            normalizedRootPath: input.registry.manifest.normalizedRootPath,
            manifestHash: symbolResult.manifestHash,
            fileShardCount: symbolResult.fileShardCount,
            symbolCount: symbolResult.symbolCount,
            generationId,
            relationshipManifestHash: relationshipResult.manifestHash,
            relationshipCount: relationshipResult.relationshipCount,
            relationshipFileShardCount: relationshipResult.fileShardCount,
            navigationSealHash,
        };
    } finally {
        await fs.promises.rm(buildStateRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

export async function publishNavigationSidecarGeneration(
    candidate: NavigationGenerationPointerCandidate,
    options: Pick<WriteNavigationSidecarGenerationInput, 'beforePublish' | 'publishMutation'> = {},
): Promise<void> {
    await publishCurrentGenerationPointer(
        candidate.rootPath,
        {
            schemaVersion: CURRENT_GENERATION_SCHEMA_VERSION,
            generationId: candidate.generationId,
            symbolRegistryManifestHash: candidate.manifestHash,
            relationshipManifestHash: candidate.relationshipManifestHash,
            navigationSealHash: candidate.navigationSealHash,
        },
        options.beforePublish,
        options.publishMutation,
    );
}

export async function discardNavigationSidecarGeneration(
    candidate: StagedNavigationSidecarGeneration,
    beforeDelete?: () => void,
): Promise<void> {
    beforeDelete?.();
    await fs.promises.rm(
        path.join(candidate.rootPath, GENERATIONS_DIR_NAME, candidate.generationId),
        { recursive: true, force: true },
    );
}

export async function clearSymbolRegistrySidecar(input: ClearSymbolRegistrySidecarInput): Promise<void> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    if (input.publishMutation) {
        const detachedPath = path.join(
            path.dirname(rootPath),
            uniqueSidecarEntryName(BACKUP_ENTRY_PREFIX),
        );
        let detached = false;
        input.publishMutation(() => {
            try {
                fs.renameSync(rootPath, detachedPath);
                detached = true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
        });
        if (detached) {
            await fs.promises.rm(detachedPath, { recursive: true, force: true });
        }
        return;
    }
    input.beforeDelete?.();
    await fs.promises.rm(rootPath, { recursive: true, force: true });
}

function isSymbolIndexFile(value: unknown): value is SymbolIndexFile {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return record.schemaVersion === SYMBOL_INDEX_SCHEMA_VERSION
        && isNonEmptyString(record.manifestHash)
        && Array.isArray(record.files)
        && record.files.every((file) => (
            isRecord(file)
            && isRepositoryRelativePath(file.path)
            && isNonEmptyString(file.hash)
            && isNonEmptyString(file.language)
            && isNonNegativeInteger(file.symbolCount)
            && isRepositoryRelativePath(file.shardPath)
            && typeof file.shardHash === 'string'
            && /^[a-f0-9]{64}$/.test(file.shardHash)
        ));
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
        indexFile.schemaVersion !== expected.schemaVersion
        || indexFile.manifestHash !== expected.manifestHash
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
            && actual.shardPath === file.shardPath;
    });
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

function isPositiveInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 1;
}

function isOptionalNonEmptyString(value: unknown): boolean {
    return value === undefined || isNonEmptyString(value);
}

function isSymbolSpan(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    if (!isPositiveInteger(value.startLine) || !isPositiveInteger(value.endLine)) {
        return false;
    }
    if (value.endLine < value.startLine) {
        return false;
    }
    for (const field of ['startByte', 'endByte', 'startColumn', 'endColumn']) {
        if (value[field] !== undefined && !isNonNegativeInteger(value[field])) {
            return false;
        }
    }
    if (
        typeof value.startByte === 'number'
        && typeof value.endByte === 'number'
        && value.endByte < value.startByte
    ) {
        return false;
    }
    if (
        value.startLine === value.endLine
        && typeof value.startColumn === 'number'
        && typeof value.endColumn === 'number'
        && value.endColumn < value.startColumn
    ) {
        return false;
    }
    return true;
}

const VALID_RELATIONSHIP_TYPES = new Set([
    'CALLS',
    'IMPORTS',
    'EXPORTS',
    'EXTENDS',
    'IMPLEMENTS',
    'REFERENCES',
    'TESTS',
    'GENERATES',
    'CONFIGURES',
]);

export function isSymbolRecord(value: unknown): value is SymbolRecord {
    if (!isRecord(value)) {
        return false;
    }
    for (const field of [
        'symbolKey',
        'symbolInstanceId',
        'language',
        'name',
        'qualifiedName',
        'label',
        'file',
        'fileHash',
        'extractorVersion',
    ]) {
        if (!isNonEmptyString(value[field])) {
            return false;
        }
    }
    if (!isSymbolKind(value.kind)) {
        return false;
    }
    if (!isSymbolSpan(value.span)) {
        return false;
    }
    if (!isOptionalNonEmptyString(value.parentKey)) {
        return false;
    }
    if (!Array.isArray(value.parentQualifiedNamePath) || !value.parentQualifiedNamePath.every((item) => typeof item === 'string')) {
        return false;
    }
    if (value.exported !== undefined && typeof value.exported !== 'boolean') {
        return false;
    }
    if (value.ontologyTags !== undefined && (!Array.isArray(value.ontologyTags) || !value.ontologyTags.every(isNonEmptyString))) {
        return false;
    }
    return true;
}

async function readJson(filePath: string): Promise<unknown> {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

function isCurrentGenerationPointer(value: unknown): value is {
    schemaVersion: typeof CURRENT_GENERATION_SCHEMA_VERSION;
    generationId: string;
    symbolRegistryManifestHash: string;
    relationshipManifestHash: string;
    navigationSealHash: string;
} {
    return isRecord(value)
        && Object.keys(value).length === 5
        && [
            'schemaVersion',
            'generationId',
            'symbolRegistryManifestHash',
            'relationshipManifestHash',
            'navigationSealHash',
        ].every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && value.schemaVersion === CURRENT_GENERATION_SCHEMA_VERSION
        && isNonEmptyString(value.generationId)
        && /^[a-zA-Z0-9_-]+$/.test(value.generationId)
        && isNonEmptyString(value.symbolRegistryManifestHash)
        && isNonEmptyString(value.relationshipManifestHash)
        && typeof value.navigationSealHash === 'string'
        && /^[a-f0-9]{64}$/.test(value.navigationSealHash);
}

export function parseNavigationGenerationSeal(value: unknown): NavigationGenerationSeal | null {
    if (!isRecord(value)) return null;
    const quality = value.symbolQuality;
    const structurallyValid = value.schemaVersion === NAVIGATION_GENERATION_SEAL_SCHEMA_VERSION
        && isNonEmptyString(value.generationId)
        && /^[a-zA-Z0-9_-]+$/.test(value.generationId)
        && typeof value.symbolRegistryManifestHash === 'string'
        && /^symmanifest_[a-f0-9]{32}$/.test(value.symbolRegistryManifestHash)
        && typeof value.relationshipManifestHash === 'string'
        && /^[a-f0-9]{64}$/.test(value.relationshipManifestHash)
        && typeof value.artifactSetHash === 'string'
        && /^[a-f0-9]{64}$/.test(value.artifactSetHash)
        && isRecord(quality)
        && isNonNegativeInteger(quality.indexedFileCount)
        && Array.isArray(quality.languages)
        && quality.languages.every((entry) => isRecord(entry)
            && isNonEmptyString(entry.language)
            && isNonNegativeInteger(entry.indexedFiles)
            && isNonNegativeInteger(entry.filesWithNonFileSymbols)
            && entry.filesWithNonFileSymbols <= entry.indexedFiles
            && isNonNegativeInteger(entry.nonFileSymbolCount)
            && entry.nonFileSymbolCount >= entry.filesWithNonFileSymbols);
    if (!structurallyValid || !isRecord(quality) || !Array.isArray(quality.languages)) return null;
    let indexedFileTotal = 0;
    let previousLanguage: string | null = null;
    for (const rawEntry of quality.languages) {
        const entry = rawEntry as NavigationSymbolQualityAggregate['languages'][number];
        if (previousLanguage !== null && compareStrings(previousLanguage, entry.language) >= 0) return null;
        previousLanguage = entry.language;
        indexedFileTotal += entry.indexedFiles;
        if (!Number.isSafeInteger(indexedFileTotal)) return null;
    }
    if (indexedFileTotal !== quality.indexedFileCount) return null;
    return value as unknown as NavigationGenerationSeal;
}

export async function readNavigationGenerationSeal(
    stateRoot: string | undefined,
    normalizedRootPath: string,
): Promise<ReadNavigationGenerationSealResult> {
    const rootPath = resolveNavigationSidecarRoot(stateRoot, normalizedRootPath);
    let generation: CurrentNavigationGeneration | null;
    try {
        generation = await resolveCurrentNavigationGeneration(stateRoot, normalizedRootPath);
    } catch (error) {
        return {
            status: error instanceof RetiredNavigationPointerError
                || error instanceof UnsupportedNavigationPointerError
                ? 'incompatible'
                : 'corrupt',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
    if (!generation) return { status: 'missing', rootPath, reason: 'navigation generation pointer is missing' };
    let value: unknown;
    try {
        value = await readJson(path.join(generation.generationRoot, NAVIGATION_GENERATION_SEAL_FILE_NAME));
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? { status: 'missing', rootPath, reason: 'navigation generation seal is missing' }
            : { status: 'corrupt', rootPath, reason: error instanceof Error ? error.message : String(error) };
    }
    const seal = parseNavigationGenerationSeal(value);
    if (!seal) {
        return { status: 'corrupt', rootPath, reason: 'navigation generation seal is invalid' };
    }
    if (
        seal.generationId !== generation.generationId
        || seal.symbolRegistryManifestHash !== generation.symbolRegistryManifestHash
        || seal.relationshipManifestHash !== generation.relationshipManifestHash
        || computeNavigationGenerationSealHash(seal) !== generation.navigationSealHash
    ) {
        return { status: 'incompatible', rootPath, reason: 'navigation generation seal does not match current pointer' };
    }
    return { status: 'ok', rootPath, seal };
}

export async function verifyNavigationGenerationSealArtifacts(input: {
    stateRoot?: string;
    normalizedRootPath: string;
    registry: SymbolRegistry;
    relationshipManifest: RelationshipManifest;
}): Promise<ReadNavigationGenerationSealResult> {
    const sealRead = await readNavigationGenerationSeal(input.stateRoot, input.normalizedRootPath);
    if (sealRead.status !== 'ok') return sealRead;
    const generation = await resolveCurrentNavigationGeneration(input.stateRoot, input.normalizedRootPath);
    if (!generation) {
        return { status: 'missing', rootPath: sealRead.rootPath, reason: 'navigation generation pointer is missing' };
    }
    let symbolIndex: unknown;
    try {
        symbolIndex = await readJson(path.join(generation.generationRoot, SYMBOLS_DIR_NAME, 'index.json'));
    } catch (error) {
        return { status: 'corrupt', rootPath: sealRead.rootPath, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!isSymbolIndexFile(symbolIndex) || !isRelationshipManifest(input.relationshipManifest)) {
        return { status: 'corrupt', rootPath: sealRead.rootPath, reason: 'navigation artifact manifests are invalid' };
    }
    const artifactSet = [
        ...symbolIndex.files.map((file) => ({ path: file.shardPath, hash: file.shardHash })),
        ...input.relationshipManifest.files.map((file) => ({ path: file.shardPath, hash: file.shardHash })),
    ].sort((left, right) => compareStrings(left.path, right.path));
    const expectedSeal: NavigationGenerationSeal = {
        schemaVersion: NAVIGATION_GENERATION_SEAL_SCHEMA_VERSION,
        generationId: generation.generationId,
        symbolRegistryManifestHash: generation.symbolRegistryManifestHash,
        relationshipManifestHash: generation.relationshipManifestHash,
        artifactSetHash: hashSerializedJson(artifactSet),
        symbolQuality: buildNavigationSymbolQualityAggregate(input.registry),
    };
    if (computeNavigationGenerationSealHash(expectedSeal) !== computeNavigationGenerationSealHash(sealRead.seal)) {
        return { status: 'incompatible', rootPath: sealRead.rootPath, reason: 'navigation generation seal does not match validated artifacts' };
    }
    return sealRead;
}

export async function resolveCurrentNavigationGeneration(
    stateRoot: string | undefined,
    normalizedRootPath: string,
): Promise<CurrentNavigationGeneration | null> {
    const rootPath = resolveNavigationSidecarRoot(stateRoot, normalizedRootPath);
    const pointerPath = path.join(rootPath, CURRENT_GENERATION_FILE_NAME);
    let rawPointer: unknown;
    try {
        rawPointer = await readJson(pointerPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    if (!isCurrentGenerationPointer(rawPointer)) {
        if (
            isRecord(rawPointer)
            && (rawPointer.schemaVersion === 'navigation_current_v1'
                || rawPointer.schemaVersion === 'navigation_current_v2')
        ) {
            throw new RetiredNavigationPointerError(
                `retired ${rawPointer.schemaVersion} pointer requires reindex`,
            );
        }
        const pointerSchemaVersion = isRecord(rawPointer)
            && typeof rawPointer.schemaVersion === 'string'
            ? rawPointer.schemaVersion
            : null;
        const futureVersion = pointerSchemaVersion
            ? /^navigation_current_v([1-9]\d*)$/.exec(pointerSchemaVersion)
            : null;
        if (futureVersion && Number(futureVersion[1]) > 3) {
            throw new UnsupportedNavigationPointerError(
                `unsupported ${pointerSchemaVersion} pointer requires a newer runtime`,
            );
        }
        throw new Error('navigation current-generation pointer is invalid or incompatible');
    }
    const generationsRoot = path.join(rootPath, GENERATIONS_DIR_NAME);
    const generationRoot = path.resolve(generationsRoot, rawPointer.generationId);
    const relative = path.relative(generationsRoot, generationRoot);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('navigation current-generation pointer escapes the generations root');
    }
    await fs.promises.access(generationRoot, fs.constants.R_OK);
    return {
        generationId: rawPointer.generationId,
        generationRoot,
        symbolRegistryManifestHash: rawPointer.symbolRegistryManifestHash,
        relationshipManifestHash: rawPointer.relationshipManifestHash,
        navigationSealHash: rawPointer.navigationSealHash,
    };
}

async function resolveReadableNavigationRoot(
    stateRoot: string | undefined,
    normalizedRootPath: string,
): Promise<{ rootPath: string; readableRoot: string; generation: CurrentNavigationGeneration | null }> {
    const rootPath = resolveNavigationSidecarRoot(stateRoot, normalizedRootPath);
    const generation = await resolveCurrentNavigationGeneration(stateRoot, normalizedRootPath);
    return { rootPath, readableRoot: generation?.generationRoot || rootPath, generation };
}

export async function readSymbolRegistrySidecar(input: ReadSymbolRegistrySidecarInput): Promise<ReadSymbolRegistrySidecarResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    let readableRoot: string;
    let generation: CurrentNavigationGeneration | null;
    try {
        ({ readableRoot, generation } = await resolveReadableNavigationRoot(input.stateRoot, input.normalizedRootPath));
    } catch (error) {
        return {
            status: 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
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
    if (generation && generation.symbolRegistryManifestHash !== manifestHash) {
        return {
            status: 'incompatible',
            rootPath,
            reason: 'navigation generation pointer hash does not match symbol registry manifest',
        };
    }
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
        for (const file of indexFile.files) {
            const shardPath = path.join(readableRoot, file.shardPath);
            const serializedShard = await fs.promises.readFile(shardPath, 'utf8');
            if (crypto.createHash('sha256').update(serializedShard, 'utf8').digest('hex') !== file.shardHash) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `symbol registry shard hash does not match index for ${file.path}`,
                };
            }
            const shard = JSON.parse(serializedShard) as {
                manifestHash?: unknown;
                path?: unknown;
                hash?: unknown;
                language?: unknown;
                symbols?: unknown;
            };
            const shardSymbols = shard.symbols;
            if (
                shard.manifestHash !== manifestHash
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
            status: error instanceof SyntaxError ? 'corrupt' : 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

export function isRelationshipRecord(value: unknown): value is RelationshipRecord {
    if (!isRecord(value)) {
        return false;
    }
    const hasTarget = isNonEmptyString(value.targetKey)
        || isNonEmptyString(value.targetInstanceId)
        || isNonEmptyString(value.targetPath);
    return isNonEmptyString(value.sourceKey)
        && hasTarget
        && isNonEmptyString(value.type)
        && VALID_RELATIONSHIP_TYPES.has(value.type)
        && isNonEmptyString(value.file)
        && isOptionalNonEmptyString(value.sourceInstanceId)
        && isOptionalNonEmptyString(value.targetKey)
        && isOptionalNonEmptyString(value.targetInstanceId)
        && isOptionalNonEmptyString(value.targetPath)
        && (value.span === undefined || isSymbolSpan(value.span))
        && (value.confidence === 'high' || value.confidence === 'medium' || value.confidence === 'low');
}

function isSourceSpan(value: unknown): boolean {
    if (!isSymbolSpan(value) || !isRecord(value)) return false;
    return ['startByte', 'endByte', 'startColumn', 'endColumn']
        .every((field) => isNonNegativeInteger(value[field]));
}

function isRelationshipAnalysisEvidence(value: unknown): value is RelationshipAnalysisEvidence {
    if (!isRecord(value) || !Array.isArray(value.moduleBindings) || !Array.isArray(value.callSites)) {
        return false;
    }
    const bindingsValid = value.moduleBindings.every((binding) => {
        if (!isRecord(binding)) return false;
        if (binding.kind !== 'import' && binding.kind !== 'reexport' && binding.kind !== 'export') return false;
        if (typeof binding.typeOnly !== 'boolean' || !isSourceSpan(binding.span)) return false;
        return ['moduleSpecifier', 'importedName', 'localName', 'exportedName']
            .every((field) => isOptionalNonEmptyString(binding[field]));
    });
    const callsValid = value.callSites.every((call) => (
        isRecord(call)
        && isNonEmptyString(call.calleeName)
        && isSourceSpan(call.span)
    ));
    return bindingsValid && callsValid;
}

export async function readRelationshipSidecar(input: ReadRelationshipSidecarInput): Promise<ReadRelationshipSidecarResult> {
    const rootPath = resolveNavigationSidecarRoot(input.stateRoot, input.normalizedRootPath);
    let readableRoot: string;
    let generation: CurrentNavigationGeneration | null;
    try {
        ({ readableRoot, generation } = await resolveReadableNavigationRoot(input.stateRoot, input.normalizedRootPath));
    } catch (error) {
        return {
            status: 'incompatible',
            rootPath,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
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
    try {
        const serializedManifest = await fs.promises.readFile(manifestPath, 'utf8');
        const rawManifest = JSON.parse(serializedManifest) as unknown;
        if (
            generation
            && crypto.createHash('sha256').update(serializedManifest, 'utf8').digest('hex') !== generation.relationshipManifestHash
        ) {
            return {
                status: 'incompatible',
                rootPath,
                reason: 'navigation generation pointer hash does not match relationship manifest',
            };
        }
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
        for (const file of manifest.files) {
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
            const shardPath = path.join(readableRoot, file.shardPath);
            const rawText = await fs.promises.readFile(shardPath, 'utf8');
            const actualShardHash = crypto.createHash('sha256').update(rawText, 'utf8').digest('hex');
            const rawShard = JSON.parse(rawText) as unknown;
            if (typeof rawShard !== 'object' || rawShard === null || Array.isArray(rawShard)) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `relationship shard is invalid for ${file.path}`,
                };
            }
            const shard = rawShard as {
                manifestHash?: unknown;
                path?: unknown;
                hash?: unknown;
                relationships?: unknown;
                records?: unknown;
                analysisEvidence?: unknown;
            };
            if (shard.manifestHash !== input.expectedSymbolRegistryManifestHash) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `relationship shard hash does not match manifest for ${file.path}`,
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
                analysisByFile.set(shard.path, shard.analysisEvidence);
            }
            if (actualShardHash !== file.shardHash) {
                return {
                    status: 'incompatible',
                    rootPath,
                    reason: `relationship shard content hash does not match manifest for ${file.path}`,
                };
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
        manifest,
        records: records.sort(compareRelationshipRecords),
        analysisByFile,
        warnings: [...new Set(warnings)].sort(compareStrings),
    };
}
