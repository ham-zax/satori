import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import type {
    Embedding,
    EmbeddingIdentity,
    EmbeddingVector,
} from '../embedding';
import {
    isIndexableFileByPolicy,
    isIndexableFileObservationByPolicy,
} from '../config/index-policy';
import type {
    CodeChunk,
    LanguageAnalysisPort,
    LanguageAnalysisResult,
} from '../language-analysis';
import { getLanguageIdFromFilename } from '../language';
import { buildSearchProjections } from './search-projections';
import { buildIndexedChunkId } from './indexed-chunk-identity';
import {
    buildSymbolRecordsForFile,
    resolveOwnerSymbolForChunk,
} from '../symbols';
import type {
    SymbolRecord,
    SymbolRegistryManifestFile,
} from '../symbols';
import type { RepositoryRelativePath } from '../paths/repository-path';
import type { RelationshipAnalysisEvidence } from '../relationships';
import { defaultSemanticLanguageRegistry, type SemanticLanguageRegistry } from '../semantic/descriptor';
import {
    openRegularFileInsideRoot,
    readFileHandleExactly,
} from '../sync/root-bound-fs';
import type {
    IndexedVectorDocument,
    SearchProjections,
    VectorDatabase,
} from '../vectordb';
import { envManager } from '../utils/env-manager';
import { compareContractStrings } from '../utils/compare-contract-strings';

const DEFAULT_EMBEDDING_BATCH_SIZE = 100;
const MAX_EMBEDDING_BATCH_SIZE = 1000;
const INDEX_CHUNK_LIMIT = 450_000;

export type IndexingPipelineMetrics = {
    analysisMs: number;
    embeddedInputBytes: number;
    logicalEmbeddingRequests: number;
    logicalEmbeddingDurationMs: number;
    logicalVectorWriteRequests: number;
    logicalVectorWriteDurationMs: number;
};

export interface AnalyzedIndexedFile {
    readonly relativePath: RepositoryRelativePath;
    readonly source: string;
    readonly sourceHash: string;
    readonly contentHash: string;
    readonly language: string;
    readonly structuralStatus: LanguageAnalysisResult['structuralStatus'];
    readonly chunks: CodeChunk[];
    readonly extractedSymbols: LanguageAnalysisResult['symbols'];
    readonly moduleBindings: LanguageAnalysisResult['moduleBindings'];
    readonly callSites: LanguageAnalysisResult['callSites'];
    readonly receiverTypeBindings: LanguageAnalysisResult['receiverTypeBindings'];
    readonly pythonFlowFacts: LanguageAnalysisResult['pythonFlowFacts'];
}

export interface AnalyzedFileSymbolFacts {
    readonly symbolRecords: SymbolRecord[];
    readonly manifestFile: SymbolRegistryManifestFile;
    readonly relationshipEvidence: RelationshipAnalysisEvidence;
}

export type ExpectedIndexedChunk = Readonly<{
    id: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    content: string;
    language: string;
    chunkIndex: number;
}>;

import type { SemanticProjectAnalyzer, SemanticSourceFile } from '../semantic';

type IgnoreMatcher = ReturnType<typeof ignore>;

export type ProcessedFileList = Readonly<{
    processedFiles: number;
    totalChunks: number;
    status: 'completed' | 'limit_reached';
    symbolRecords: SymbolRecord[];
    symbolManifestFiles: SymbolRegistryManifestFile[];
    analysisByFile: Map<string, RelationshipAnalysisEvidence>;
    semanticSources?: readonly SemanticSourceFile[];
    indexedFileHashes: ReadonlyMap<string, string>;
    performance: IndexingPipelineMetrics;
}>;

export type ExpectedChunksAndSymbols = Readonly<{
    expectedChunks: ExpectedIndexedChunk[];
    symbolRecords: SymbolRecord[];
    symbolManifestFiles: SymbolRegistryManifestFile[];
    analysisByFile: Map<string, RelationshipAnalysisEvidence>;
}>;

export type IndexingPolicy = Readonly<{
    supportedExtensions: string[];
    effectiveIgnorePatterns: string[];
}>;

export interface ProjectedChunkEntry {
    readonly chunk: CodeChunk;
    readonly relativePath: RepositoryRelativePath;
    readonly fileChunkIndex: number;
    readonly projections: SearchProjections;
}

interface PendingIndexedChunk extends ProjectedChunkEntry {
    readonly codebasePath: string;
}

type IndexingPipelineConfig = Readonly<{
    getVectorDatabase: () => VectorDatabase;
    languageAnalyzer: LanguageAnalysisPort;
    semanticAnalyzer?: SemanticProjectAnalyzer;
    semanticLanguageRegistry?: SemanticLanguageRegistry;
    getEmbedding: () => Embedding;
    assertEmbeddingIdentityCurrent: () => Readonly<EmbeddingIdentity>;
    isHybridEnabled: () => boolean;
    canonicalizeCodebasePath: (codebasePath: string) => string;
    normalizeRelativePathForCodebase: (
        codebasePath: string,
        filePath: string,
    ) => RepositoryRelativePath | null;
    getIndexedExtensionsForCodebase: (codebasePath: string) => string[];
    matchesIgnorePattern: (
        filePath: string,
        codebasePath: string,
        isDirectory: boolean,
        matcher?: IgnoreMatcher,
    ) => boolean;
    getSymbolExtractorVersion: () => string;
}>;


function resolveEmbeddingBatchSize(
    rawValue: string | undefined,
    preferredSize: number = DEFAULT_EMBEDDING_BATCH_SIZE,
    hardMaxSize: number = MAX_EMBEDDING_BATCH_SIZE,
): number {
    const boundedPreferredSize = Math.min(
        preferredSize,
        hardMaxSize,
        MAX_EMBEDDING_BATCH_SIZE,
    );
    if (!rawValue) return boundedPreferredSize;
    const parsed = Number(rawValue);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return boundedPreferredSize;
    return Math.min(parsed, hardMaxSize, MAX_EMBEDDING_BATCH_SIZE);
}

function estimateEmbeddingTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function chunksWithTrustedRelativePath(
    chunks: readonly CodeChunk[],
    relativePath: RepositoryRelativePath,
): CodeChunk[] {
    return chunks.map((chunk) => ({
        ...chunk,
        metadata: { ...chunk.metadata, filePath: relativePath },
    }));
}

function chunksWithResolvedOwners(
    chunks: readonly CodeChunk[],
    symbols: SymbolRecord[],
): CodeChunk[] {
    return chunks.map((chunk) => {
        const owner = resolveOwnerSymbolForChunk({ chunk, symbols });
        return {
            ...chunk,
            metadata: {
                ...chunk.metadata,
                ownerSymbolKey: owner.symbolKey,
                ownerSymbolInstanceId: owner.symbolInstanceId,
                symbolKind: owner.kind,
            },
        };
    });
}

export class IndexingPipeline {
    private readonly getVectorDatabase: () => VectorDatabase;
    private readonly languageAnalyzer: LanguageAnalysisPort;
    private readonly semanticAnalyzer?: SemanticProjectAnalyzer;
    private readonly semanticLanguageRegistry: SemanticLanguageRegistry;
    private readonly getEmbedding: () => Embedding;
    private readonly assertEmbeddingIdentityCurrent: () => Readonly<EmbeddingIdentity>;
    private readonly isHybridEnabled: () => boolean;
    private readonly canonicalizeCodebasePath: (codebasePath: string) => string;
    private readonly normalizeRelativePathForCodebase: IndexingPipelineConfig[
        'normalizeRelativePathForCodebase'
    ];
    private readonly getIndexedExtensionsForCodebase: (
        codebasePath: string,
    ) => string[];
    private readonly matchesIgnorePattern: IndexingPipelineConfig['matchesIgnorePattern'];
    private readonly getSymbolExtractorVersion: () => string;

    constructor(config: IndexingPipelineConfig) {
        this.getVectorDatabase = config.getVectorDatabase;
        this.languageAnalyzer = config.languageAnalyzer;
        this.semanticAnalyzer = config.semanticAnalyzer;
        this.semanticLanguageRegistry = config.semanticLanguageRegistry ?? defaultSemanticLanguageRegistry;
        this.getEmbedding = config.getEmbedding;
        this.assertEmbeddingIdentityCurrent = config.assertEmbeddingIdentityCurrent;
        this.isHybridEnabled = config.isHybridEnabled;
        this.canonicalizeCodebasePath = config.canonicalizeCodebasePath;
        this.normalizeRelativePathForCodebase = config.normalizeRelativePathForCodebase;
        this.getIndexedExtensionsForCodebase = config.getIndexedExtensionsForCodebase;
        this.matchesIgnorePattern = config.matchesIgnorePattern;
        this.getSymbolExtractorVersion = config.getSymbolExtractorVersion;
    }


    async getCodeFiles(
        codebasePath: string,
        indexPolicy?: IndexingPolicy,
    ): Promise<string[]> {
        const files: string[] = [];
        const supportedExtensions = indexPolicy?.supportedExtensions
            ?? this.getIndexedExtensionsForCodebase(codebasePath);
        const policyMatcher = indexPolicy
            ? ignore().add([...indexPolicy.effectiveIgnorePatterns])
            : null;

        const traverseDirectory = async (currentPath: string): Promise<void> => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
            entries.sort((left, right) => compareContractStrings(left.name, right.name));
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (this.matchesIgnorePattern(
                    fullPath,
                    codebasePath,
                    entry.isDirectory(),
                    policyMatcher ?? undefined,
                )) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await traverseDirectory(fullPath);
                } else if (entry.isFile()) {
                    const stat = await fs.promises.stat(fullPath);
                    const relativePath = path.relative(codebasePath, fullPath).replace(/\\/g, '/');
                    if (await isIndexableFileByPolicy(
                        relativePath,
                        fullPath,
                        stat.size,
                        supportedExtensions,
                    )) {
                        files.push(fullPath);
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        return files.sort((left, right) => compareContractStrings(
            path.relative(codebasePath, left).replace(/\\/g, '/'),
            path.relative(codebasePath, right).replace(/\\/g, '/'),
        ));
    }

    async readIndexableFileObservationInsideRoot(
        filePath: string,
        codebasePath: string,
        indexPolicy?: IndexingPolicy,
    ): Promise<{ content: string; sourceHash: string } | null> {
        const canonicalRoot = this.canonicalizeCodebasePath(codebasePath);
        const handle = await openRegularFileInsideRoot(filePath, canonicalRoot);
        try {
            const before = await handle.stat();
            const relativePath = this.normalizeRelativePathForCodebase(
                canonicalRoot,
                filePath,
            );
            if (!relativePath || !before.isFile()) {
                throw new Error(
                    `Indexed source is not a regular file inside the codebase root: ${filePath}`,
                );
            }
            const indexable = await isIndexableFileObservationByPolicy(
                relativePath,
                before.size,
                indexPolicy?.supportedExtensions
                    ?? this.getIndexedExtensionsForCodebase(canonicalRoot),
                async () => {
                    const buffer = Buffer.alloc(Math.min(before.size, 8192));
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                    return buffer.subarray(0, bytesRead);
                },
            );
            if (!indexable) return null;

            const sourceBytes = await readFileHandleExactly(handle, before.size);
            const content = sourceBytes.toString('utf8');
            const after = await handle.stat();
            if (
                after.dev !== before.dev
                || after.ino !== before.ino
                || after.size !== before.size
                || after.mtimeMs !== before.mtimeMs
                || after.ctimeMs !== before.ctimeMs
            ) {
                throw new Error(`Indexed source changed while being read: ${filePath}`);
            }
            const currentPathHandle = await openRegularFileInsideRoot(filePath, canonicalRoot);
            try {
                const currentPathStat = await currentPathHandle.stat();
                if (currentPathStat.dev !== after.dev || currentPathStat.ino !== after.ino) {
                    throw new Error(`Indexed source path was replaced while being read: ${filePath}`);
                }
            } finally {
                await currentPathHandle.close().catch(() => undefined);
            }
            return {
                content,
                sourceHash: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
            };
        } finally {
            await handle.close().catch(() => undefined);
        }
    }

    async readIndexableFileInsideRoot(
        filePath: string,
        codebasePath: string,
        indexPolicy?: IndexingPolicy,
    ): Promise<string | null> {
        const observation = await this.readIndexableFileObservationInsideRoot(
            filePath,
            codebasePath,
            indexPolicy,
        );
        return observation?.content ?? null;
    }

    async analyzeIndexedFile(
        filePath: string,
        codebasePath: string,
        indexPolicy?: IndexingPolicy,
    ): Promise<AnalyzedIndexedFile | null> {
        const sourceObservation = await this.readIndexableFileObservationInsideRoot(
            filePath,
            codebasePath,
            indexPolicy,
        );
        if (sourceObservation === null) return null;

        const relativePath = this.normalizeRelativePathForCodebase(
            codebasePath,
            filePath,
        );
        if (!relativePath) {
            throw new Error(`Unable to derive relative path for indexed file ${filePath}`);
        }
        const source = sourceObservation.content;
        const language = getLanguageIdFromFilename(filePath, 'text');
        const analysis = await this.languageAnalyzer.analyze({
            content: source,
            language,
            relativePath,
        });
        return {
            relativePath,
            source,
            sourceHash: sourceObservation.sourceHash,
            contentHash: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
            language,
            structuralStatus: analysis.structuralStatus,
            chunks: chunksWithTrustedRelativePath(analysis.chunks, relativePath),
            extractedSymbols: analysis.symbols,
            moduleBindings: analysis.moduleBindings,
            callSites: analysis.callSites,
            receiverTypeBindings: analysis.receiverTypeBindings,
            pythonFlowFacts: analysis.pythonFlowFacts ?? [],
        };
    }

    buildAnalyzedFileSymbolFacts(
        analyzed: AnalyzedIndexedFile,
    ): AnalyzedFileSymbolFacts {
        const symbolRecords = buildSymbolRecordsForFile({
            relativePath: analyzed.relativePath,
            language: analyzed.language,
            content: analyzed.source,
            fileHash: analyzed.contentHash,
            extractorVersion: this.getSymbolExtractorVersion(),
            extractedSymbols: analyzed.extractedSymbols,
            chunks: analyzed.chunks,
        });
        const hasDefinitions = symbolRecords.some((symbol) => symbol.kind !== 'file');
        const definitionStatus = analyzed.structuralStatus !== 'complete'
            ? 'structural_unavailable'
            : hasDefinitions
                ? 'definitions_present'
                : 'definition_free';
        return {
            symbolRecords,
            manifestFile: {
                path: analyzed.relativePath,
                hash: analyzed.contentHash,
                language: analyzed.language,
                symbolCount: symbolRecords.length,
                definitionStatus,
            },
            relationshipEvidence: {
                moduleBindings: analyzed.moduleBindings,
                callSites: analyzed.callSites,
                receiverTypeBindings: analyzed.receiverTypeBindings,
                pythonFlowFacts: analyzed.pythonFlowFacts ?? [],
            },
        };
    }

    async processFileList(input: {
        filePaths: string[];
        codebasePath: string;
        collectionName: string;
        onFileProcessed?: (
            filePath: string,
            fileIndex: number,
            totalFiles: number,
        ) => void;
        assertMutationCurrent?: () => void;
        indexPolicy?: IndexingPolicy;
    }): Promise<ProcessedFileList> {
        const isHybrid = this.isHybridEnabled();
        const embedding = this.getEmbedding();
        const batchPolicy = embedding.getBatchPolicy?.() ?? null;
        const embeddingBatchSize = resolveEmbeddingBatchSize(
            envManager.get('EMBEDDING_BATCH_SIZE'),
            batchPolicy?.preferredMaxItems ?? DEFAULT_EMBEDDING_BATCH_SIZE,
            batchPolicy?.hardMaxItems ?? MAX_EMBEDDING_BATCH_SIZE,
        );
        const targetEstimatedTokens = batchPolicy?.targetEstimatedTokens;
        const hardTokenLimit = batchPolicy?.hardTokenLimit;
        console.log(
            `[Context] 🔧 Embedding batch policy: max_items=${embeddingBatchSize}`
            + `${targetEstimatedTokens ? `, target_estimated_tokens=${targetEstimatedTokens}` : ''}`,
        );

        const writeAggregationPolicy = this.getVectorDatabase().getWriteAggregationPolicy?.();
        if (writeAggregationPolicy) {
            if (
                !Number.isSafeInteger(writeAggregationPolicy.preferredMaxRows)
                || writeAggregationPolicy.preferredMaxRows <= 0
            ) {
                throw new Error(
                    `Invalid VectorWriteAggregationPolicy preferredMaxRows: ${writeAggregationPolicy.preferredMaxRows}. Must be a positive safe integer.`,
                );
            }
        }
        let pendingVectorWrites: IndexedVectorDocument[] = [];
        let chunkBuffer: PendingIndexedChunk[] = [];
        let chunkBufferEstimatedTokens = 0;
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];
        const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();
        const semanticSources: SemanticSourceFile[] = [];
        const indexedFileHashes = new Map<string, string>();
        const performance: IndexingPipelineMetrics = {
            analysisMs: 0,
            embeddedInputBytes: 0,
            logicalEmbeddingRequests: 0,
            logicalEmbeddingDurationMs: 0,
            logicalVectorWriteRequests: 0,
            logicalVectorWriteDurationMs: 0,
        };
        const describeError = (error: unknown): string => (
            error instanceof Error ? error.message : String(error)
        );
        const flushChunkBuffer = async (failureContext: string): Promise<void> => {
            if (chunkBuffer.length === 0) return;
            const searchType = isHybrid ? 'hybrid' : 'regular';
            try {
                const documents = await this.processChunkBuffer(
                    chunkBuffer,
                    input.collectionName,
                    performance,
                );
                pendingVectorWrites.push(...documents);
                if (writeAggregationPolicy) {
                    while (pendingVectorWrites.length >= writeAggregationPolicy.preferredMaxRows) {
                        const batch = pendingVectorWrites.splice(0, writeAggregationPolicy.preferredMaxRows);
                        await this.flushVectorWriteBuffer(
                            input.collectionName,
                            batch,
                            input.assertMutationCurrent,
                            performance,
                        );
                    }
                } else {
                    const batch = pendingVectorWrites.splice(0, pendingVectorWrites.length);
                    await this.flushVectorWriteBuffer(
                        input.collectionName,
                        batch,
                        input.assertMutationCurrent,
                        performance,
                    );
                }
            } catch (error) {
                console.error(
                    `[Context] ❌ Failed to process ${failureContext} for ${searchType}:`,
                    error,
                );
                if (error instanceof Error) console.error('[Context] Stack trace:', error.stack);
                pendingVectorWrites = [];
                throw new Error(
                    `Failed to persist ${failureContext} for ${searchType}: ${describeError(error)}`,
                );
            } finally {
                chunkBuffer = [];
                chunkBufferEstimatedTokens = 0;
            }
        };

        for (let fileIndex = 0; fileIndex < input.filePaths.length; fileIndex++) {
            const filePath = input.filePaths[fileIndex];
            try {
                const analysisStartedAt = Date.now();
                const analyzed = await this.analyzeIndexedFile(
                    filePath,
                    input.codebasePath,
                    input.indexPolicy,
                );
                if (analyzed === null) continue;
                const symbolFacts = this.buildAnalyzedFileSymbolFacts(analyzed);
                const chunks = chunksWithResolvedOwners(
                    analyzed.chunks,
                    symbolFacts.symbolRecords,
                );
                const { relativePath } = analyzed;
                analysisByFile.set(relativePath, symbolFacts.relationshipEvidence);
                indexedFileHashes.set(relativePath, analyzed.sourceHash);
                if (this.semanticAnalyzer?.supportsLanguage(analyzed.language)) {
                    semanticSources.push({
                        path: analyzed.relativePath,
                        source: analyzed.source,
                        sourceHash: analyzed.sourceHash,
                    });
                }
                symbolRecords.push(...symbolFacts.symbolRecords);
                symbolManifestFiles.push(symbolFacts.manifestFile);
                performance.analysisMs += Date.now() - analysisStartedAt;

                if (chunks.length > 50) {
                    console.warn(
                        `[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(analyzed.source.length / 1024)}KB)`,
                    );
                } else if (analyzed.source.length > 100_000) {
                    console.log(
                        `📄 Large file ${filePath}: ${Math.round(analyzed.source.length / 1024)}KB -> ${chunks.length} chunks`,
                    );
                }

                let fileFullyIncluded = true;
                for (
                    let fileChunkIndex = 0;
                    fileChunkIndex < chunks.length;
                    fileChunkIndex++
                ) {
                    const chunk = chunks[fileChunkIndex];
                    const projections = buildSearchProjections({ chunk, relativePath });
                    const chunkEstimatedTokens = estimateEmbeddingTokens(
                        projections.embeddingText,
                    );
                    if (
                        hardTokenLimit !== undefined
                        && chunkEstimatedTokens > hardTokenLimit
                    ) {
                        throw new Error(
                            `Embedding projection for '${relativePath}' chunk ${fileChunkIndex} is estimated at ${chunkEstimatedTokens} tokens, exceeding the provider hard limit of ${hardTokenLimit}.`,
                        );
                    }
                    if (
                        chunkBuffer.length > 0
                        && targetEstimatedTokens !== undefined
                        && chunkBufferEstimatedTokens + chunkEstimatedTokens
                            > targetEstimatedTokens
                    ) {
                        await flushChunkBuffer(`chunk batch while indexing ${filePath}`);
                    }
                    chunkBuffer.push({
                        chunk,
                        codebasePath: input.codebasePath,
                        relativePath,
                        fileChunkIndex,
                        projections,
                    });
                    chunkBufferEstimatedTokens += chunkEstimatedTokens;
                    totalChunks++;

                    if (chunkBuffer.length >= embeddingBatchSize) {
                        await flushChunkBuffer(`chunk batch while indexing ${filePath}`);
                    }
                    if (totalChunks >= INDEX_CHUNK_LIMIT) {
                        console.warn(
                            `[Context] ⚠️  Chunk limit of ${INDEX_CHUNK_LIMIT} reached. Stopping indexing.`,
                        );
                        limitReached = true;
                        fileFullyIncluded = fileChunkIndex === chunks.length - 1;
                        break;
                    }
                }

                if (fileFullyIncluded) {
                    processedFiles++;
                    input.onFileProcessed?.(
                        filePath,
                        processedFiles,
                        input.filePaths.length,
                    );
                }
                if (limitReached) break;
            } catch (error) {
                console.error(
                    `[Context] ❌ Failed to index file ${filePath}: ${describeError(error)}`,
                );
                throw error;
            }

        }

        if (chunkBuffer.length > 0) {
            const searchType = isHybrid ? 'hybrid' : 'regular';
            console.log(
                `📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`,
            );
            await flushChunkBuffer('final chunk batch');
        }
        if (pendingVectorWrites.length > 0) {
            const batch = pendingVectorWrites.splice(0, pendingVectorWrites.length);
            await this.flushVectorWriteBuffer(
                input.collectionName,
                batch,
                input.assertMutationCurrent,
                performance,
            );
        }
        if (!limitReached && indexedFileHashes.size !== processedFiles) {
            throw new Error(
                `Completed full index source coverage is inconsistent: ${processedFiles} processed files but ${indexedFileHashes.size} source identities.`,
            );
        }
        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed',
            symbolRecords,
            symbolManifestFiles,
            analysisByFile,
            ...(semanticSources.length > 0 ? { semanticSources } : {}),
            indexedFileHashes,
            performance,
        };
    }

    async getExpectedChunksAndSymbols(
        filePaths: string[],
        codebasePath: string,
        indexPolicy?: IndexingPolicy,
    ): Promise<ExpectedChunksAndSymbols> {
        const expectedChunks: ExpectedIndexedChunk[] = [];
        const symbolRecords: SymbolRecord[] = [];
        const symbolManifestFiles: SymbolRegistryManifestFile[] = [];
        const analysisByFile = new Map<string, RelationshipAnalysisEvidence>();

        for (const filePath of filePaths) {
            const analyzed = await this.analyzeIndexedFile(
                filePath,
                codebasePath,
                indexPolicy,
            );
            if (analyzed === null) {
                throw new Error(
                    `Indexed source no longer satisfies the active policy: ${filePath}`,
                );
            }
            const symbolFacts = this.buildAnalyzedFileSymbolFacts(analyzed);
            const chunks = chunksWithResolvedOwners(
                analyzed.chunks,
                symbolFacts.symbolRecords,
            );
            const { relativePath } = analyzed;
            analysisByFile.set(relativePath, symbolFacts.relationshipEvidence);
            for (let index = 0; index < chunks.length; index++) {
                const chunk = chunks[index];
                expectedChunks.push({
                    id: buildIndexedChunkId(relativePath, chunk, index),
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    content: chunk.content,
                    language: chunk.metadata.language || 'unknown',
                    chunkIndex: index,
                });
            }
            symbolRecords.push(...symbolFacts.symbolRecords);
            symbolManifestFiles.push(symbolFacts.manifestFile);
        }
        return {
            expectedChunks,
            symbolRecords,
            symbolManifestFiles,
            analysisByFile,
        };
    }

    async embedChunkBatch(
        chunkEntries: ProjectedChunkEntry[],
        codebasePath: string,
        collectionName: string,
        performance?: IndexingPipelineMetrics,
    ): Promise<IndexedVectorDocument[]> {
        const indexedAt = new Date().toISOString();
        const chunks = chunkEntries.map(({ chunk }) => chunk);
        const projections = chunkEntries.map((entry) => entry.projections);
        const embeddingTexts = projections.map(({ embeddingText }) => embeddingText);
        const embeddingIdentity = this.assertEmbeddingIdentityCurrent();
        const embedding = this.getEmbedding();
        const batchPolicy = embedding.getBatchPolicy?.() ?? null;
        if (batchPolicy && chunkEntries.length > batchPolicy.hardMaxItems) {
            throw new Error(
                `Embedding batch contains ${chunkEntries.length} items, exceeding the provider hard limit of ${batchPolicy.hardMaxItems}.`,
            );
        }
        const hardTokenLimit = batchPolicy?.hardTokenLimit;
        if (hardTokenLimit !== undefined) {
            const tokenEstimates = embeddingTexts.map(estimateEmbeddingTokens);
            const oversizedIndex = tokenEstimates.findIndex((estimatedTokens) => (
                estimatedTokens > hardTokenLimit
            ));
            if (oversizedIndex >= 0) {
                const entry = chunkEntries[oversizedIndex];
                throw new Error(
                    `Embedding projection for '${entry.relativePath}' chunk ${entry.fileChunkIndex} is estimated at ${tokenEstimates[oversizedIndex]} tokens, exceeding the provider hard limit of ${hardTokenLimit}.`,
                );
            }
            const batchEstimatedTokens = tokenEstimates.reduce(
                (total, estimate) => total + estimate,
                0,
            );
            if (batchEstimatedTokens > hardTokenLimit) {
                throw new Error(
                    `Embedding batch is estimated at ${batchEstimatedTokens} tokens, exceeding the provider hard limit of ${hardTokenLimit}.`,
                );
            }
        }
        if (performance) {
            performance.embeddedInputBytes += embeddingTexts.reduce(
                (total, content) => total + Buffer.byteLength(content, 'utf8'),
                0,
            );
            performance.logicalEmbeddingRequests += 1;
        }
        const embeddingStartedAt = Date.now();
        let embeddings: EmbeddingVector[];
        try {
            embeddings = await embedding.embedDocuments(embeddingTexts);
        } finally {
            if (performance) {
                performance.logicalEmbeddingDurationMs += Date.now() - embeddingStartedAt;
            }
        }
        this.assertEmbeddingIdentityCurrent();
        const expectedDimension = embeddingIdentity.dimension;
        if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
            throw new Error(
                `Embedding batch returned ${Array.isArray(embeddings) ? embeddings.length : 'a non-array result'} for ${chunks.length} chunks.`,
            );
        }
        for (let index = 0; index < embeddings.length; index++) {
            const embeddingResult = embeddings[index] as unknown;
            if (
                !embeddingResult
                || typeof embeddingResult !== 'object'
                || Array.isArray(embeddingResult)
            ) {
                throw new Error(
                    `Embedding batch result ${index} is not a valid embedding object.`,
                );
            }
            const record = embeddingResult as { vector?: unknown; dimension?: unknown };
            if (!Array.isArray(record.vector)) {
                throw new Error(`Embedding batch result ${index} has no vector array.`);
            }
            if (
                record.vector.length !== expectedDimension
                || record.dimension !== expectedDimension
            ) {
                throw new Error(
                    `Embedding batch result ${index} has dimension ${record.vector.length}; expected ${expectedDimension}.`,
                );
            }
            if (
                !record.vector.every((value) => (
                    typeof value === 'number' && Number.isFinite(value)
                ))
            ) {
                throw new Error(
                    `Embedding batch result ${index} contains a non-finite vector value.`,
                );
            }
        }

        const documentIds = chunkEntries.map(({ chunk, relativePath, fileChunkIndex }) => (
            buildIndexedChunkId(relativePath, chunk, fileChunkIndex)
        ));
        if (new Set(documentIds).size !== documentIds.length) {
            throw new Error(
                `Duplicate chunk identities generated for collection '${collectionName}'.`,
            );
        }
        return chunks.map((chunk, index) => {
            const relativePath = chunkEntries[index].relativePath;
            const fileExtension = path.extname(relativePath);
            const {
                filePath: omittedFilePath,
                startLine: omittedStartLine,
                endLine: omittedEndLine,
                ...restMetadata
            } = chunk.metadata;
            void omittedFilePath;
            void omittedStartLine;
            void omittedEndLine;
            return {
                document: {
                    id: documentIds[index],
                    content: chunk.content,
                    vector: embeddings[index].vector,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: chunkEntries[index].fileChunkIndex,
                        indexedAt,
                    },
                },
                projections: projections[index],
            };
        });
    }

    async flushVectorWriteBuffer(
        collectionName: string,
        documents: IndexedVectorDocument[],
        assertMutationCurrent?: () => void,
        performance?: IndexingPipelineMetrics,
    ): Promise<void> {
        if (documents.length === 0) return;
        assertMutationCurrent?.();
        this.assertEmbeddingIdentityCurrent();
        if (performance) performance.logicalVectorWriteRequests += 1;
        const writeStartedAt = Date.now();
        try {
            await this.getVectorDatabase().writeDocuments(collectionName, documents);
        } finally {
            if (performance) {
                performance.logicalVectorWriteDurationMs += Date.now() - writeStartedAt;
            }
        }
    }

    async processChunkBatch(
        chunkEntries: ProjectedChunkEntry[],
        codebasePath: string,
        collectionName: string,
        assertMutationCurrent?: () => void,
        performance?: IndexingPipelineMetrics,
    ): Promise<void> {
        const documents = await this.embedChunkBatch(
            chunkEntries,
            codebasePath,
            collectionName,
            performance,
        );
        await this.flushVectorWriteBuffer(
            collectionName,
            documents,
            assertMutationCurrent,
            performance,
        );
    }

    private async processChunkBuffer(
        chunkBuffer: PendingIndexedChunk[],
        collectionName: string,
        performance?: IndexingPipelineMetrics,
    ): Promise<IndexedVectorDocument[]> {
        if (chunkBuffer.length === 0) return [];
        const chunks = chunkBuffer.map((item) => item.chunk);
        const codebasePath = chunkBuffer[0].codebasePath;
        const estimatedTokens = chunkBuffer.reduce(
            (sum, { projections }) => (
                sum + estimateEmbeddingTokens(projections.embeddingText)
            ),
            0,
        );
        const searchType = this.isHybridEnabled() ? 'hybrid' : 'regular';
        console.log(
            `[Context] 🔄 Processing batch of ${chunks.length} chunks (~${estimatedTokens} tokens) for ${searchType}`,
        );
        return this.embedChunkBatch(
            chunkBuffer,
            codebasePath,
            collectionName,
            performance,
        );
    }
}
