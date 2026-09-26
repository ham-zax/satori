import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION,
    RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
} from './contracts';
import {
    computeSymbolRegistryManifestHash,
} from './registry';
import type {
    RelationshipManifest,
    RelationshipManifestFile,
    RelationshipRecord,
    SymbolRecord,
    SymbolRegistryManifestFile,
} from './contracts';
import type { SymbolRegistry } from './registry';
import type { RelationshipAnalysisEvidence } from '../relationships';
import type {
    SymbolIndexFileEntry,
} from './sidecar-validators';
import type {
    PythonFlowFact,
    SourceSpan,
} from '../language-analysis';
import type { SemanticProviderCoverage } from '../semantic/contracts';
import type {
    ResolutionCallObservation,
    ResolutionClaim,
    ResolutionProofStep,
} from '../relationships/resolution';
import {
    RELATIONSHIPS_DIR_NAME,
    SYMBOL_FILE_CONTRIBUTION_SCHEMA_VERSION,
    SYMBOLS_DIR_NAME,
    buildSymbolIndex,
    compareRelationshipRecords,
    compareStrings,
    fileShardName,
    hashSerializedJson,
    hashSerializedString,
    serializeJson,
} from './sidecar-reads';

const TEMP_ENTRY_PREFIX = '.satori-tmp-';
const BACKUP_ENTRY_PREFIX = '.satori-backup-';
export const SHARD_IO_CONCURRENCY = 64;
const RELATIONSHIP_SHARD_IO_CONCURRENCY = 8;
export interface WriteSymbolRegistrySidecarInput {
    registry: SymbolRegistry;
    navigationRoot: string;
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
    providerCoverage?: readonly SemanticProviderCoverage[];
    files?: SymbolRegistryManifestFile[];
    navigationRoot: string;
    beforePublish?: () => void;
}

export interface WriteRelationshipSidecarResult {
    rootPath: string;
    manifestHash: string;
    fileShardCount: number;
    relationshipCount: number;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, serializeJson(value), 'utf8');
}

async function writeSerializedJson(filePath: string, serialized: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, serialized, 'utf8');
}

async function fsyncPath(targetPath: string): Promise<void> {
    const handle = await fs.promises.open(targetPath, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function samePathIdentity(expected: fs.Stats, actual: fs.Stats): boolean {
    return expected.dev === actual.dev && expected.ino === actual.ino;
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

async function writeSymbolRegistrySidecarInternal(
    input: WriteSymbolRegistrySidecarInput,
    reuse?: SymbolShardReuse,
): Promise<WriteSymbolRegistrySidecarResult> {
    const rootPath = path.resolve(input.navigationRoot);
    const symbolsDir = path.join(rootPath, SYMBOLS_DIR_NAME);
    const temporarySymbolsDir = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    const byFileDir = path.join(temporarySymbolsDir, 'by-file');
    const manifestHash = computeSymbolRegistryManifestHash(input.registry.manifest);
    const groupedSymbols = groupSymbolsByFile(
        reuse
            ? input.registry.symbols.filter((symbol) => reuse.filesToRewrite.has(symbol.file))
            : input.registry.symbols,
    );

    try {
        await fs.promises.mkdir(rootPath, { recursive: true });
        await fs.promises.mkdir(byFileDir, { recursive: true });

        const shardHashes = new Map<string, string>();
        for (let offset = 0; offset < input.registry.manifest.files.length; offset += SHARD_IO_CONCURRENCY) {
            const batch = input.registry.manifest.files.slice(offset, offset + SHARD_IO_CONCURRENCY);
            await Promise.all(batch.map(async (file) => {
                const shardFileName = fileShardName(file.path, file.hash);
                const targetPath = path.join(byFileDir, shardFileName);
                if (reuse && !reuse.filesToRewrite.has(file.path)) {
                    const source = reuse.filesByPath.get(file.path);
                    if (
                        !source
                        || source.hash !== file.hash
                        || source.language !== file.language
                        || source.symbolCount !== file.symbolCount
                        || source.definitionStatus !== file.definitionStatus
                        || path.basename(source.shardPath) !== shardFileName
                    ) {
                        throw new Error(`Reusable symbol contribution is incompatible for '${file.path}'; reindex is required.`);
                    }
                    // The base Publication is immutable. The shard hash remains
                    // reuse metadata so unchanged files can be hard-linked without
                    // serializing the same contribution again; it is not read authority.
                    shardHashes.set(file.path, source.shardHash);
                    const sharedSize = await linkReusableShard(
                        path.join(reuse.sourceRoot, source.shardPath),
                        targetPath,
                    );
                    reuse.sharedFileSizes.set(source.shardPath, sharedSize);
                } else {
                    const symbols = groupedSymbols.get(file.path) || [];
                    const shard = {
                        schemaVersion: SYMBOL_FILE_CONTRIBUTION_SCHEMA_VERSION,
                        path: file.path,
                        hash: file.hash,
                        language: file.language,
                        symbols,
                    };
                    const shardHash = hashSerializedJson(shard);
                    shardHashes.set(file.path, shardHash);
                    await writeJson(targetPath, shard);
                }
            }));
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

export async function writeSymbolRegistrySidecar(
    input: WriteSymbolRegistrySidecarInput,
): Promise<WriteSymbolRegistrySidecarResult> {
    return writeSymbolRegistrySidecarInternal(input);
}

function buildRelationshipManifest(
    registryManifestHash: string,
    relationshipVersion: string,
    builtAt: string,
    files: RelationshipManifestFile[],
    providerCoverage: readonly SemanticProviderCoverage[] = [],
): RelationshipManifest {
    return {
        schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
        fileContributionSchemaVersion: RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION,
        symbolRegistryManifestHash: registryManifestHash,
        relationshipVersion,
        builtAt,
        providerCoverage: [...providerCoverage]
            .map((coverage) => ({
                language: coverage.language,
                providerId: coverage.providerId,
                providerVersion: coverage.providerVersion,
                ...(coverage.environmentConfigId
                    ? { environmentConfigId: coverage.environmentConfigId }
                    : {}),
                status: coverage.status,
                sourceFileCount: coverage.sourceFileCount,
                analyzedSourceFileCount: coverage.analyzedSourceFileCount,
                ...(coverage.skippedFiles ? {
                    skippedFiles: [...coverage.skippedFiles]
                        .map((file) => ({ path: file.path, reason: file.reason, bytes: file.bytes }))
                        .sort((left, right) => compareStrings(left.path, right.path)),
                } : {}),
                ...(coverage.failureReason ? { failureReason: coverage.failureReason } : {}),
                ...(coverage.failureMessage
                    ? { failureMessage: coverage.failureMessage.slice(0, 1024) }
                    : {}),
            }))
            .sort((left, right) => (
                compareStrings(left.language, right.language)
                || compareStrings(left.providerId, right.providerId)
                || compareStrings(left.providerVersion, right.providerVersion)
            )),
        files: [...files].sort((a, b) => compareStrings(a.path, b.path)),
    };
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

function canonicalizeSourceSpan(span: SourceSpan): SourceSpan {
    return { ...span };
}

function canonicalizePythonFlowFact(fact: PythonFlowFact): PythonFlowFact {
    if (fact.kind === 'assignment_origin') {
        return {
            kind: fact.kind,
            targetText: fact.targetText,
            valueText: fact.valueText,
            valueKind: fact.valueKind,
            ...(fact.constructorTypeName === undefined ? {} : { constructorTypeName: fact.constructorTypeName }),
            ...(fact.calleeName === undefined ? {} : { calleeName: fact.calleeName }),
            span: canonicalizeSourceSpan(fact.span),
            contextSpan: canonicalizeSourceSpan(fact.contextSpan),
        };
    }
    if (fact.kind === 'call_argument') {
        return {
            kind: fact.kind,
            calleeText: fact.calleeText,
            ...(fact.argumentName === undefined ? {} : { argumentName: fact.argumentName }),
            ...(fact.argumentIndex === undefined ? {} : { argumentIndex: fact.argumentIndex }),
            valueText: fact.valueText,
            span: canonicalizeSourceSpan(fact.span),
            contextSpan: canonicalizeSourceSpan(fact.contextSpan),
        };
    }
    if (fact.kind === 'callable_signature') {
        return {
            kind: fact.kind,
            callableName: fact.callableName,
            parameterNames: [...fact.parameterNames],
            positionalExact: fact.positionalExact,
            decorated: fact.decorated,
            span: canonicalizeSourceSpan(fact.span),
            contextSpan: canonicalizeSourceSpan(fact.contextSpan),
        };
    }
    return {
        kind: fact.kind,
        className: fact.className,
        baseNames: [...fact.baseNames],
        span: canonicalizeSourceSpan(fact.span),
        contextSpan: canonicalizeSourceSpan(fact.contextSpan),
    };
}

function compareResolutionClaims(left: ResolutionClaim, right: ResolutionClaim): number {
    if (left.sourceFile !== right.sourceFile) return compareStrings(left.sourceFile, right.sourceFile);
    if (left.callSpan.startByte !== right.callSpan.startByte) return left.callSpan.startByte - right.callSpan.startByte;
    if (left.callSpan.endByte !== right.callSpan.endByte) return left.callSpan.endByte - right.callSpan.endByte;
    if (left.decision !== right.decision) return compareStrings(left.decision, right.decision);
    return compareStrings(left.targetSymbol ?? '', right.targetSymbol ?? '');
}

function canonicalizeResolutionProofStep(step: ResolutionProofStep): ResolutionProofStep {
    return {
        kind: step.kind,
        subject: step.subject,
        ...(step.detail === undefined ? {} : { detail: step.detail }),
        ...(step.span === undefined ? {} : { span: canonicalizeSourceSpan(step.span) }),
        ...(step.hop === undefined ? {} : { hop: step.hop }),
    };
}

function canonicalizeResolutionCallObservation(
    observation: ResolutionCallObservation,
): ResolutionCallObservation {
    return {
        kind: 'call',
        calleeName: observation.calleeName,
        calleeText: observation.calleeText,
        ...(observation.receiverText === undefined ? {} : { receiverText: observation.receiverText }),
        ...(observation.receiverType === undefined ? {} : { receiverType: observation.receiverType }),
        construct: observation.construct,
        candidates: [...observation.candidates]
            .map((candidate) => ({
                file: candidate.file,
                span: canonicalizeSourceSpan(candidate.span),
                name: candidate.name,
                ...(candidate.qualifiedName === undefined ? {} : { qualifiedName: candidate.qualifiedName }),
                ...(candidate.symbolInstanceId === undefined ? {} : { symbolInstanceId: candidate.symbolInstanceId }),
            }))
            .sort((left, right) => (
                compareStrings(left.file, right.file)
                || left.span.startByte - right.span.startByte
                || left.span.endByte - right.span.endByte
                || compareStrings(left.name, right.name)
                || compareStrings(left.symbolInstanceId ?? '', right.symbolInstanceId ?? '')
            )),
    };
}

function canonicalizeResolutionClaim(claim: ResolutionClaim): ResolutionClaim {
    return {
        providerId: claim.providerId,
        providerVersion: claim.providerVersion,
        environmentConfigId: claim.environmentConfigId,
        sourceFile: claim.sourceFile,
        ...(claim.sourceInstanceId === undefined ? {} : { sourceInstanceId: claim.sourceInstanceId }),
        ...(claim.targetInstanceId === undefined ? {} : { targetInstanceId: claim.targetInstanceId }),
        ...(claim.targetSymbol === undefined ? {} : { targetSymbol: claim.targetSymbol }),
        callSpan: canonicalizeSourceSpan(claim.callSpan),
        observation: canonicalizeResolutionCallObservation(claim.observation),
        decision: claim.decision,
        relationshipType: claim.relationshipType,
        resolutionAuthority: claim.resolutionAuthority,
        proofSteps: claim.proofSteps.map((step) => canonicalizeResolutionProofStep(step)),
        dependencyKeys: [...claim.dependencyKeys].sort(compareStrings),
        flowHops: claim.flowHops,
    };
}

function canonicalizeRelationshipAnalysisEvidence(
    evidence: RelationshipAnalysisEvidence | undefined,
): RelationshipAnalysisEvidence | undefined {
    if (!evidence) return undefined;
    return {
        moduleBindings: [...evidence.moduleBindings],
        callSites: [...evidence.callSites],
        receiverTypeBindings: [...(evidence.receiverTypeBindings ?? [])],
        ...(evidence.pythonFlowFacts && evidence.pythonFlowFacts.length > 0
            ? { pythonFlowFacts: evidence.pythonFlowFacts.map((fact) => canonicalizePythonFlowFact(fact)) }
            : {}),
        ...(evidence.resolutionClaims === undefined
            ? {}
            : {
                resolutionClaims: [...evidence.resolutionClaims]
                    .sort(compareResolutionClaims)
                    .map((claim) => canonicalizeResolutionClaim(claim)),
            }),
    };
}

export type SymbolShardReuse = Readonly<{
    sourceRoot: string;
    filesByPath: ReadonlyMap<string, SymbolIndexFileEntry>;
    filesToRewrite: ReadonlySet<string>;
    sharedFileSizes: Map<string, number>;
}>;

export type RelationshipShardReuse = Readonly<{
    sourceRoot: string;
    filesByPath: ReadonlyMap<string, RelationshipManifestFile>;
    filesToRewrite: ReadonlySet<string>;
    sharedFileSizes: Map<string, number>;
}>;

function shardSharingError(sourcePath: string, targetPath: string, error: unknown): Error {
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : 'unknown';
    return new Error(
        'Atomic navigation delta requires same-filesystem hard-link support; '
        + `cannot share '${sourcePath}' into '${targetPath}' (${code}). `
        + 'Run a safe full rebuild instead.',
    );
}

async function linkReusableShard(sourcePath: string, targetPath: string): Promise<number> {
    try {
        const sourceStat = await fs.promises.lstat(sourcePath);
        if (!sourceStat.isFile()) {
            throw new Error('source contribution is not a regular file');
        }
        await fs.promises.link(sourcePath, targetPath);
        return sourceStat.size;
    } catch (error) {
        throw shardSharingError(sourcePath, targetPath, error);
    }
}

async function writeRelationshipSidecarInternal(
    input: WriteRelationshipSidecarInput,
    reuse?: RelationshipShardReuse,
): Promise<WriteRelationshipSidecarResult> {
    const rootPath = path.resolve(input.navigationRoot);
    const relationshipsDir = path.join(rootPath, RELATIONSHIPS_DIR_NAME);
    const temporaryRelationshipsDir = path.join(rootPath, uniqueSidecarEntryName(TEMP_ENTRY_PREFIX));
    const relationshipByFileDir = path.join(temporaryRelationshipsDir, 'by-file');
    const groupedRelationships = groupRelationshipsByFile(
        (reuse
            ? input.records.filter((record) => reuse.filesToRewrite.has(record.file))
            : [...input.records]
        ).sort(compareRelationshipRecords),
    );
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

        const sortedShardPaths = [...shardPaths].sort(compareStrings);
        for (
            let offset = 0;
            offset < sortedShardPaths.length;
            offset += RELATIONSHIP_SHARD_IO_CONCURRENCY
        ) {
            const batch = sortedShardPaths.slice(offset, offset + RELATIONSHIP_SHARD_IO_CONCURRENCY);
            const batchFiles = await Promise.all(batch.map(async (filePath): Promise<RelationshipManifestFile> => {
                const fileHash = filesByPath.get(filePath)?.hash || input.symbolRegistryManifestHash;
                const shardPath = path.posix.join(RELATIONSHIPS_DIR_NAME, 'by-file', fileShardName(filePath, fileHash));
                const targetPath = path.join(temporaryRelationshipsDir, 'by-file', path.basename(shardPath));
                if (reuse && !reuse.filesToRewrite.has(filePath)) {
                    const source = reuse.filesByPath.get(filePath);
                    if (
                        !source
                        || source.hash !== fileHash
                        || source.shardPath !== shardPath
                    ) {
                        throw new Error(`Reusable relationship contribution is incompatible for '${filePath}'; reindex is required.`);
                    }
                    // As with symbol shards, this hash is reuse metadata for an
                    // immutable base Publication, not an independent authority.
                    const sharedSize = await linkReusableShard(
                        path.join(reuse.sourceRoot, source.shardPath),
                        targetPath,
                    );
                    reuse.sharedFileSizes.set(source.shardPath, sharedSize);
                    return { ...source };
                }

                const records = groupedRelationships.get(filePath) ?? [];
                const analysisEvidence = !allowedEvidencePaths || allowedEvidencePaths.has(filePath)
                    ? canonicalizeRelationshipAnalysisEvidence(
                        getRelationshipAnalysisEvidence(input.analysisByFile, filePath),
                    )
                    : undefined;
                const shard = {
                    schemaVersion: RELATIONSHIP_FILE_CONTRIBUTION_SCHEMA_VERSION,
                    path: filePath,
                    hash: fileHash,
                    relationships: records,
                    analysisEvidence,
                };
                const serializedShard = serializeJson(shard);
                const shardHash = hashSerializedString(serializedShard);
                await writeSerializedJson(targetPath, serializedShard);
                return {
                    path: filePath,
                    hash: fileHash,
                    shardPath,
                    shardHash,
                    relationshipCount: records.length,
                    analysisEvidencePresent: analysisEvidence !== undefined,
                };
            }));
            manifestFiles.push(...batchFiles);
        }

        const manifest = buildRelationshipManifest(
            input.symbolRegistryManifestHash,
            input.relationshipVersion,
            input.builtAt,
            manifestFiles,
            input.providerCoverage,
        );
        const serializedManifest = serializeJson(manifest);
        manifestHash = hashSerializedString(serializedManifest);
        await writeSerializedJson(
            path.join(temporaryRelationshipsDir, 'manifest.json'),
            serializedManifest,
        );

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

export async function writeRelationshipSidecar(
    input: WriteRelationshipSidecarInput,
): Promise<WriteRelationshipSidecarResult> {
    return writeRelationshipSidecarInternal(input);
}

// Internal contract with the generation lifecycle: staging reuses the artifact
// write owners and the sidecar entry-naming/durability primitives.
export {
    TEMP_ENTRY_PREFIX,
    BACKUP_ENTRY_PREFIX,
    writeJson,
    fsyncPath,
    samePathIdentity,
    uniqueSidecarEntryName,
    getRelationshipAnalysisEvidence,
    writeSymbolRegistrySidecarInternal,
    writeRelationshipSidecarInternal,
};
