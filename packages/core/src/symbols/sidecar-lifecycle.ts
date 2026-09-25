import fs from 'node:fs';
import path from 'node:path';
import {
    RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION,
    isRelationshipManifest,
} from './contracts';
import type { RelationshipRecord } from './contracts';
import { isRepositoryRelativePath } from '../paths/repository-path';
import type { SymbolRegistry } from './registry';
import type { RelationshipAnalysisEvidence } from '../relationships';
import type { SemanticProviderCoverage } from '../semantic/contracts';
import {
    SYMBOL_INDEX_SCHEMA_VERSION,
    isSymbolIndexFile,
} from './sidecar-validators';
import {
    RELATIONSHIPS_DIR_NAME,
    SYMBOLS_DIR_NAME,
    compareStrings,
    computeNavigationSourceFilesDigest,
    hashSerializedString,
    readJson,
} from './sidecar-reads';
import type { WriteSymbolRegistrySidecarResult } from './sidecar-writes';
import {
    SHARD_IO_CONCURRENCY,
    TEMP_ENTRY_PREFIX,
    fsyncPath,
    getRelationshipAnalysisEvidence,
    samePathIdentity,
    uniqueSidecarEntryName,
    writeRelationshipSidecarInternal,
    writeSymbolRegistrySidecarInternal,
} from './sidecar-writes';
import type {
    RelationshipShardReuse,
    SymbolShardReuse,
} from './sidecar-writes';

const CLEANUP_ENTRY_PREFIX = '.satori-cleanup-';

export class PublicationNavigationStagingCleanupError extends Error {
    readonly cleanupStatus = 'unresolved' as const;

    constructor(
        readonly cleanupPath: string,
        readonly stagingCause: unknown,
        readonly cleanupCause: unknown,
    ) {
        super(
            `Publication navigation staging failed and cleanup is unresolved for '${cleanupPath}': ${
                cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
            }`,
        );
        this.name = 'PublicationNavigationStagingCleanupError';
    }
}

export interface StagePublicationNavigationInput {
    publicationId: string;
    navigationRoot: string;
    registry: SymbolRegistry;
    records: RelationshipRecord[];
    analysisByFile: Map<string, RelationshipAnalysisEvidence> | Record<string, RelationshipAnalysisEvidence>;
    providerCoverage?: readonly SemanticProviderCoverage[];
    deltaReuse?: {
        basePublicationId: string;
        baseNavigationRoot: string;
        symbolFilesToRewrite: readonly string[];
        relationshipFilesToRewrite: readonly string[];
    };
}

export interface StagedPublicationNavigation extends WriteSymbolRegistrySidecarResult {
    publicationId: string;
    navigationRoot: string;
    normalizedRootPath: string;
    relationshipManifestHash: string;
    relationshipCount: number;
    relationshipFileShardCount: number;
    sourceFileCount: number;
    sourceFilesDigest: string;
    physical: {
        logicalBytes: number;
        physicallyWrittenBytes: number;
        sharedFiles: number;
        writtenFiles: number;
    };
}

const stagedNavigationIdentities = new WeakMap<StagedPublicationNavigation, fs.Stats>();

async function confirmPathAbsent(targetPath: string): Promise<void> {
    try {
        await fs.promises.lstat(targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    throw new Error(`Publication navigation still exists after cleanup: ${targetPath}`);
}

async function cleanupOwnedNavigationRoot(
    navigationRoot: string,
    expectedStat: fs.Stats,
): Promise<void> {
    const cleanupPath = path.join(
        path.dirname(navigationRoot),
        uniqueSidecarEntryName(CLEANUP_ENTRY_PREFIX),
    );
    try {
        await fs.promises.rename(navigationRoot, cleanupPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    const detachedStat = await fs.promises.lstat(cleanupPath);
    if (
        !detachedStat.isDirectory()
        || detachedStat.isSymbolicLink()
        || !samePathIdentity(expectedStat, detachedStat)
    ) {
        await fs.promises.rename(cleanupPath, navigationRoot).catch(() => undefined);
        throw new Error(`Publication navigation identity changed at '${navigationRoot}'.`);
    }
    await fs.promises.rm(cleanupPath, { recursive: true, force: false });
    await confirmPathAbsent(cleanupPath);
    await fsyncPath(path.dirname(navigationRoot));
}

async function collectDirectoryTreePaths(
    rootPath: string,
    files: string[],
    directories: string[],
): Promise<void> {
    const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            await collectDirectoryTreePaths(entryPath, files, directories);
        } else if (entry.isFile()) {
            files.push(entryPath);
        } else {
            throw new Error(`Publication navigation contains unsupported filesystem entry '${entryPath}'.`);
        }
    }
    directories.push(rootPath);
}

async function fsyncDirectoryTree(
    rootPath: string,
    sharedFileSizes: ReadonlyMap<string, number> = new Map(),
): Promise<StagedPublicationNavigation['physical']> {
    const files: string[] = [];
    const directories: string[] = [];
    await collectDirectoryTreePaths(rootPath, files, directories);
    let logicalBytes = 0;
    let physicallyWrittenBytes = 0;
    let sharedFiles = 0;
    const writtenFiles: string[] = [];
    for (let offset = 0; offset < files.length; offset += SHARD_IO_CONCURRENCY) {
        const batch = files.slice(offset, offset + SHARD_IO_CONCURRENCY);
        const stats = await Promise.all(batch.map(async (filePath) => {
            const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
            const sharedSize = sharedFileSizes.get(relativePath);
            return sharedSize === undefined
                ? { filePath, size: (await fs.promises.stat(filePath)).size, shared: false }
                : { filePath, size: sharedSize, shared: true };
        }));
        for (const { filePath, size, shared } of stats) {
            logicalBytes += size;
            if (shared) sharedFiles += 1;
            else {
                physicallyWrittenBytes += size;
                writtenFiles.push(filePath);
            }
        }
    }
    for (let offset = 0; offset < writtenFiles.length; offset += SHARD_IO_CONCURRENCY) {
        await Promise.all(writtenFiles.slice(offset, offset + SHARD_IO_CONCURRENCY).map(fsyncPath));
    }
    for (const directory of directories) await fsyncPath(directory);
    return {
        logicalBytes,
        physicallyWrittenBytes,
        sharedFiles,
        writtenFiles: writtenFiles.length,
    };
}

function validateRewritePaths(paths: readonly string[], kind: string): Set<string> {
    const normalized = new Set<string>();
    for (const filePath of paths) {
        const candidate = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!isRepositoryRelativePath(candidate)) {
            throw new Error(`Atomic navigation delta ${kind} rewrite path '${filePath}' is invalid.`);
        }
        normalized.add(candidate);
    }
    return normalized;
}

async function verifyReusableShardHash(sourceRoot: string, shardPath: string, expectedHash: string): Promise<void> {
    const serialized = await fs.promises.readFile(path.join(sourceRoot, shardPath), 'utf8');
    if (hashSerializedString(serialized) !== expectedHash) {
        throw new Error(`Atomic navigation delta source shard '${shardPath}' is corrupt; reindex is required.`);
    }
}

async function loadPublicationNavigationReuse(
    normalizedRootPath: string,
    input: NonNullable<StagePublicationNavigationInput['deltaReuse']>,
): Promise<{ symbols: SymbolShardReuse; relationships: RelationshipShardReuse }> {
    const sourceRoot = path.resolve(input.baseNavigationRoot);
    if (path.basename(path.dirname(sourceRoot)) !== input.basePublicationId) {
        throw new Error('Atomic navigation delta source path does not belong to the declared base Publication.');
    }
    const rawSymbolIndex = await readJson(path.join(sourceRoot, SYMBOLS_DIR_NAME, 'index.json'));
    if (!isSymbolIndexFile(rawSymbolIndex) || rawSymbolIndex.schemaVersion !== SYMBOL_INDEX_SCHEMA_VERSION) {
        throw new Error('Atomic navigation delta source lacks reusable symbol contributions; reindex is required.');
    }
    const rawManifest = await readJson(path.join(sourceRoot, 'manifest.json')) as { normalizedRootPath?: unknown };
    if (rawManifest?.normalizedRootPath !== normalizedRootPath) {
        throw new Error('Atomic navigation delta source belongs to a different codebase root; reindex is required.');
    }

    const rawRelationshipManifest = await readJson(path.join(sourceRoot, RELATIONSHIPS_DIR_NAME, 'manifest.json'));
    if (
        !isRelationshipManifest(rawRelationshipManifest)
        || rawRelationshipManifest.fileContributionSchemaVersion !== RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION
        || rawRelationshipManifest.symbolRegistryManifestHash !== rawSymbolIndex.manifestHash
    ) {
        throw new Error('Atomic navigation delta source relationship metadata is incompatible; reindex is required.');
    }

    await Promise.all([
        ...rawSymbolIndex.files.map((file) => verifyReusableShardHash(sourceRoot, file.shardPath, file.shardHash)),
        ...rawRelationshipManifest.files.map((file) => verifyReusableShardHash(sourceRoot, file.shardPath, file.shardHash)),
    ]);

    const sharedFileSizes = new Map<string, number>();
    return {
        symbols: {
            sourceRoot,
            filesByPath: new Map(rawSymbolIndex.files.map((file) => [file.path, file])),
            filesToRewrite: validateRewritePaths(input.symbolFilesToRewrite, 'symbol'),
            sharedFileSizes,
        },
        relationships: {
            sourceRoot,
            filesByPath: new Map(rawRelationshipManifest.files.map((file) => [file.path, file])),
            filesToRewrite: validateRewritePaths(input.relationshipFilesToRewrite, 'relationship'),
            sharedFileSizes,
        },
    };
}

export async function stagePublicationNavigation(
    input: StagePublicationNavigationInput,
): Promise<StagedPublicationNavigation> {
    const navigationRoot = path.resolve(input.navigationRoot);
    if (path.basename(path.dirname(navigationRoot)) !== input.publicationId) {
        throw new Error(`Publication '${input.publicationId}' navigation path does not belong to that Publication.`);
    }
    for (const file of input.registry.manifest.files) {
        if (!getRelationshipAnalysisEvidence(input.analysisByFile, file.path)) {
            throw new Error(`Relationship analysis evidence is missing for manifest file '${file.path}'.`);
        }
    }
    try {
        await fs.promises.lstat(navigationRoot);
        throw new Error(`Publication '${input.publicationId}' navigation is immutable and already exists.`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const reuse = input.deltaReuse
        ? await loadPublicationNavigationReuse(input.registry.manifest.normalizedRootPath, input.deltaReuse)
        : undefined;
    const buildRoot = path.join(path.dirname(navigationRoot), uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    let navigationStat: fs.Stats | undefined;
    let renamed = false;
    try {
        const symbolResult = await writeSymbolRegistrySidecarInternal({
            navigationRoot: buildRoot,
            registry: input.registry,
        }, reuse?.symbols);
        const relationshipResult = await writeRelationshipSidecarInternal({
            navigationRoot: buildRoot,
            normalizedRootPath: input.registry.manifest.normalizedRootPath,
            symbolRegistryManifestHash: symbolResult.manifestHash,
            relationshipVersion: input.registry.manifest.relationshipVersion,
            builtAt: input.registry.manifest.builtAt,
            files: input.registry.manifest.files,
            records: input.records,
            analysisByFile: input.analysisByFile,
            providerCoverage: input.providerCoverage,
        }, reuse?.relationships);

        const physical = await fsyncDirectoryTree(buildRoot, reuse?.symbols.sharedFileSizes);
        await fs.promises.mkdir(path.dirname(navigationRoot), { recursive: true });
        await fs.promises.rename(buildRoot, navigationRoot);
        renamed = true;
        navigationStat = await fs.promises.lstat(navigationRoot);
        await fsyncPath(path.dirname(navigationRoot));

        const candidate: StagedPublicationNavigation = {
            rootPath: navigationRoot,
            navigationRoot,
            normalizedRootPath: input.registry.manifest.normalizedRootPath,
            publicationId: input.publicationId,
            manifestHash: symbolResult.manifestHash,
            fileShardCount: symbolResult.fileShardCount,
            symbolCount: symbolResult.symbolCount,
            relationshipManifestHash: relationshipResult.manifestHash,
            relationshipCount: relationshipResult.relationshipCount,
            relationshipFileShardCount: relationshipResult.fileShardCount,
            sourceFileCount: input.registry.manifest.files.length,
            sourceFilesDigest: computeNavigationSourceFilesDigest(input.registry.manifest.files),
            physical,
        };
        stagedNavigationIdentities.set(candidate, navigationStat);
        return candidate;
    } catch (error) {
        if (renamed && navigationStat) {
            try {
                await cleanupOwnedNavigationRoot(navigationRoot, navigationStat);
            } catch (cleanupError) {
                throw new PublicationNavigationStagingCleanupError(
                    navigationRoot,
                    error,
                    cleanupError,
                );
            }
        }
        throw error;
    } finally {
        await fs.promises.rm(buildRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

export async function discardPublicationNavigation(
    candidate: StagedPublicationNavigation,
    beforeDelete?: () => void,
): Promise<void> {
    const expectedStat = stagedNavigationIdentities.get(candidate);
    if (!expectedStat) {
        throw new Error(`Publication navigation '${candidate.publicationId}' is not an owned staged candidate.`);
    }
    beforeDelete?.();
    await cleanupOwnedNavigationRoot(candidate.navigationRoot, expectedStat);
    stagedNavigationIdentities.delete(candidate);
}
