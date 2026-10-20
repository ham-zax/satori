import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexingPipeline } from './indexing-pipeline';
import { createLanguageAnalysisService } from '../language-analysis';
import type { LanguageAnalysisPort } from '../language-analysis/types';
import { noopSemanticProjectAnalyzer } from '../semantic/noop-analyzer';
import type { SemanticProjectAnalyzer, SemanticProjectInput, SemanticProjectEvidence } from '../semantic';
import type { VectorDatabase } from '../vectordb/types';
import type { Embedding } from '../embedding';
import { buildSymbolRecordsForFile } from '../symbols/registry';
import { IndexingResourcePlanner } from '../indexing/resources';
import { createParallelLanguageAnalysisService } from '../language-analysis';
import { hasIndexingAnalysisCapability } from '../language-analysis/indexing-analysis';

function createMockVectorDb(): VectorDatabase {
    return {
        writeDocuments: async () => {},
        insertVector: async () => {},
        insertVectors: async () => {},
        searchVectors: async () => [],
        searchHybrid: async () => [],
        countVectors: async () => 0,
        createCollection: async () => {},
        deleteCollection: async () => {},
        hasCollection: async () => true,
        collectionExists: async () => true,
    } as unknown as VectorDatabase;
}


function createMockEmbedding(): Embedding {
    return {
        getDimension: () => 768,
        getProvider: () => 'test',
        detectDimension: async () => 768,
        embedQuery: async () => ({ vector: new Array(768).fill(0), dimension: 768 }),
        embedDocuments: async (texts: string[]) => texts.map(() => ({ vector: new Array(768).fill(0), dimension: 768 })),
        getIdentity: () => ({
            provider: 'test',
            model: 'test',
            dimension: 768,
            artifactDigest: null,
            normalizationPolicy: 'none',
        }),
    } as unknown as Embedding;
}

function createEagerOnlyAnalyzer(
    analyze: LanguageAnalysisPort['analyze'],
): LanguageAnalysisPort {
    return {
        getDescription: () => 'eager test analyzer',
        getStrategyForLanguage: () => ({ backend: 'bounded_text', structural: false }),
        analyze,
    };
}


import { isRepositoryRelativePath, type RepositoryRelativePath } from '../paths/repository-path';
import { createIndexIgnoreMatcher } from './ignore-matcher';
import { isIndexableFileByPolicy, MAX_INDEXED_SOURCE_FILE_BYTES } from '../config/index-policy';
import { ALL_TEXT_INDEX_MARKER, DEFAULT_SUPPORTED_EXTENSIONS } from '../config/defaults';
import { compareContractStrings } from '../utils/compare-contract-strings';

test('IndexingPipeline has no full-source semantic retention channel when semantic analyzer supports no languages', async () => {
    const languageAnalyzer = createLanguageAnalysisService();
    const resourcePlan = new IndexingResourcePlanner({
        platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory observation'); },
        totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 64 * 1024 ** 3, cpuCount: () => 16,
    }, () => ({ diagnostics: [] })).createPlan();
    let received = false;
    let disposed = false;
    const pipeline = new IndexingPipeline({
        getVectorDatabase: () => createMockVectorDb(),
        languageAnalyzer,
        createIndexingAnalyzer: (plan) => {
            assert.equal(plan, resourcePlan);
            received = true;
            const pool = createParallelLanguageAnalysisService({}, plan.analysisWorkers);
            assert.equal(pool.concurrency, plan.analysisWorkers);
            const dispose = pool.dispose.bind(pool);
            pool.dispose = async () => { await dispose(); disposed = true; };
            return pool;
        },
        semanticAnalyzer: noopSemanticProjectAnalyzer,
        getEmbedding: () => createMockEmbedding(),
        assertEmbeddingIdentityCurrent: () => ({
            provider: 'test',
            model: 'test',
            dimension: 768,
            artifactDigest: null,
            normalizationPolicy: 'none',
        }),
        isHybridEnabled: () => false,
        canonicalizeCodebasePath: (p) => p,
        normalizeRelativePathForCodebase: (_cb, p) => p as unknown as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => ['.go', '.ts', '.py'],
        matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'extractor-v1',
    });



    const result = await pipeline.processFileList({
        filePaths: [],
        codebasePath: '/repo',
        collectionName: 'test_col',
        resourcePlan,
    });

    assert.equal(result.processedFiles, 0);
    assert.equal('semanticSources' in result, false);
    assert.equal(received, true);
    assert.equal(disposed, true, 'operation pool must exit before the pipeline settles');
});


import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// These tests pin the TypeScript projection path and its backpressure bounds.
// indexing-pipeline.native-projections.test.ts owns the native path, the linux-x64 default.
process.env.SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS = '';

test('IndexingPipeline retains only source snapshot metadata when semantic analyzer supports language', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-indexing-pipeline-test-'));
    try {
        const goContent = 'package main\n\nfunc main() {\n    println("hello")\n}\n';
        const goFile = path.join(tempDir, 'main.go');
        fs.writeFileSync(goFile, goContent, 'utf8');

        const languageAnalyzer = createLanguageAnalysisService();
        const testSemanticAnalyzer: SemanticProjectAnalyzer = {
            supportsLanguage(lang: string) {
                return lang === 'go';
            },
            async analyze(_input: SemanticProjectInput): Promise<SemanticProjectEvidence> {
                return { language: 'go', occurrencesByFile: new Map() };
            },
        };

        const pipeline = new IndexingPipeline({
            getVectorDatabase: () => createMockVectorDb(),
            languageAnalyzer,
            semanticAnalyzer: testSemanticAnalyzer,
            getEmbedding: () => createMockEmbedding(),
            assertEmbeddingIdentityCurrent: () => ({
                provider: 'test',
                model: 'test',
                dimension: 768,
                artifactDigest: null,
                normalizationPolicy: 'none',
            }),

            isHybridEnabled: () => false,
            canonicalizeCodebasePath: (p) => p,
            normalizeRelativePathForCodebase: (_cb, p) => path.relative(tempDir, p) as unknown as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.go', '.ts', '.py'],
            matchesIgnorePattern: () => false,
            getSymbolExtractorVersion: () => 'extractor-v1',
        });

        const result = await pipeline.processFileList({
            filePaths: [goFile],
            codebasePath: tempDir,
            collectionName: 'test_col',
        });

        assert.equal(result.processedFiles, 1);
        assert.equal('semanticSources' in result, false);
        assert.equal(result.sourceFiles.length, 1);
        assert.equal(result.sourceFiles[0].path, 'main.go');
        const expectedHash = crypto.createHash('sha256').update(goContent, 'utf8').digest('hex');
        assert.equal(result.sourceFiles[0].sourceHash, expectedHash);
        assert.equal('source' in result.sourceFiles[0], false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('analysis source-byte reservations bound read-ahead and always admit the current file', async () => {
    const base = new IndexingResourcePlanner({
        platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
        totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 64 * 1024 ** 3, cpuCount: () => 16,
    }, () => ({ diagnostics: [] })).createPlan();

    for (const [windowBytes, expectedInitial] of [[8 * 1024 ** 2, 1], [16 * 1024 ** 2, 2], [1, 1]] as const) {
        let releaseInitial!: () => void;
        const initialGate = new Promise<void>(resolve => { releaseInitial = resolve; });
        const analyzer = Object.assign(createLanguageAnalysisService(), { concurrency: 4 });
        const pipeline = new IndexingPipeline({
            getVectorDatabase: createMockVectorDb,
            languageAnalyzer: analyzer,
            semanticAnalyzer: noopSemanticProjectAnalyzer,
            getEmbedding: createMockEmbedding,
            assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
            isHybridEnabled: () => false,
            canonicalizeCodebasePath: p => p,
            normalizeRelativePathForCodebase: (_base, p) => p as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.ts'],
            matchesIgnorePattern: () => false,
            getSymbolExtractorVersion: () => 'fixture',
        });
        let started = 0;
        pipeline.readIndexableFileObservationInsideRoot = async filePath => {
            started++;
            if (started <= expectedInitial) await initialGate;
            return {
                content: '', sourceHash: filePath,
                sourceStat: { size: 0, mtimeMs: 0, ctimeMs: 0 },
            };
        };
        const operation = pipeline.processFileList({
            filePaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
            codebasePath: '/repo',
            collectionName: 'fixture',
            resourcePlan: {
                ...base,
                analysisWindowFiles: 4,
                analysisWindowSourceBytes: windowBytes,
            },
        });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(started, expectedInitial, `window ${windowBytes} admitted an unexpected number of reads`);
            releaseInitial();
            const result = await operation;
            await result.payloadSettled;
            assert.equal(result.processedFiles, 4);
        } finally {
            releaseInitial();
            await operation.catch(() => undefined);
            await analyzer.dispose?.();
        }
    }
});

for (const [observedSize, expectedAdmitted] of [[1, 16], [8 * 1024 ** 2, 8]] as const) {
    test(`verified ${observedSize}-byte observations admit ${expectedAdmitted} files while the first analysis is blocked`, async () => {
        let releaseReads!: () => void;
        const readGate = new Promise<void>(resolve => { releaseReads = resolve; });
        let releaseAnalysis!: () => void;
        const analysisGate = new Promise<void>(resolve => { releaseAnalysis = resolve; });
        const analyzer = Object.assign(createLanguageAnalysisService(), { concurrency: 8 });
        assert.ok(hasIndexingAnalysisCapability(analyzer));
        const analyze = analyzer.analyzeForIndexing.bind(analyzer);
        const analyzedPaths: string[] = [];
        analyzer.analyzeForIndexing = async input => {
            analyzedPaths.push(input.relativePath);
            if (input.relativePath === '0.ts') await analysisGate;
            return analyze(input);
        };
        const pipeline = new IndexingPipeline({
            getVectorDatabase: createMockVectorDb, languageAnalyzer: analyzer,
            semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: createMockEmbedding,
            assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
            isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
            normalizeRelativePathForCodebase: (_base, p) => p as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
            getSymbolExtractorVersion: () => 'fixture',
        });
        const startedPaths: string[] = [];
        pipeline.readIndexableFileObservationInsideRoot = async filePath => {
            startedPaths.push(filePath);
            await readGate;
            return {
                content: '', sourceHash: filePath,
                sourceStat: { size: observedSize, mtimeMs: 0, ctimeMs: 0 },
            };
        };
        const filePaths = Array.from({ length: 20 }, (_, index) => `${index}.ts`);
        const operation = pipeline.processFileList({
            filePaths, codebasePath: '/repo', collectionName: 'fixture',
            resourcePlan: {
                ...new IndexingResourcePlanner({
                    platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
                    totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 64 * 1024 ** 3, cpuCount: () => 16,
                }, () => ({ diagnostics: [] })).createPlan(),
                analysisWindowFiles: 16, analysisWindowSourceBytes: 64 * 1024 ** 2,
            },
        });
        try {
            assert.equal(startedPaths.length, 8, 'unobserved sources must retain conservative reservations');
            releaseReads();
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.deepEqual(startedPaths, filePaths.slice(0, expectedAdmitted));
            assert.deepEqual(analyzedPaths, filePaths.slice(0, expectedAdmitted));
            releaseAnalysis();
            const result = await operation;
            await result.payloadSettled;
            assert.equal(result.processedFiles, filePaths.length);
            assert.deepEqual(result.sourceFiles.map(file => file.path), filePaths);
        } finally {
            releaseReads();
            releaseAnalysis();
            await operation.catch(() => undefined);
            await analyzer.dispose?.();
        }
    });
}

for (const mode of ['eager', 'deferred'] as const) {
    test(`${mode} observation callbacks stop refilling and drain every started read after failure`, async () => {
        let releaseReads!: () => void;
        const readGate = new Promise<void>(resolve => { releaseReads = resolve; });
        let releaseLastRead!: () => void;
        const lastReadGate = new Promise<void>(resolve => { releaseLastRead = resolve; });
        const firstError = new Error('injected first read failure');
        const analyzer = Object.assign(mode === 'deferred'
            ? createLanguageAnalysisService()
            : createEagerOnlyAnalyzer(async () => { throw new Error('unexpected eager analysis'); }),
        { concurrency: 8 });
        const pipeline = new IndexingPipeline({
            getVectorDatabase: createMockVectorDb, languageAnalyzer: analyzer,
            semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: createMockEmbedding,
            assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
            isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
            normalizeRelativePathForCodebase: (_base, p) => p as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
            getSymbolExtractorVersion: () => 'fixture',
        });
        const startedPaths: string[] = [];
        const finishedPaths: string[] = [];
        const observe = async (filePath: string) => {
            startedPaths.push(filePath);
            if (filePath === '0.ts') {
                throw firstError;
            } else {
                await (filePath === '7.ts' ? lastReadGate : readGate);
            }
            finishedPaths.push(filePath);
            return {
                content: '', sourceHash: filePath,
                sourceStat: { size: 1, mtimeMs: 0, ctimeMs: 0 },
            };
        };
        if (mode === 'deferred') pipeline.readIndexableFileObservationInsideRoot = observe;
        else pipeline.analyzeIndexedFile = async filePath => {
            const observation = await observe(filePath);
            return {
                relativePath: filePath as RepositoryRelativePath, source: observation.content,
                sourceHash: observation.sourceHash, sourceStat: observation.sourceStat,
                language: 'typescript', structuralStatus: 'complete', chunks: [], extractedSymbols: [],
                moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [],
            };
        };
        const operation = pipeline.processFileList({
            filePaths: Array.from({ length: 20 }, (_, index) => `${index}.ts`),
            codebasePath: '/repo', collectionName: 'fixture',
        });
        const outcome = assert.rejects(operation, error => error === firstError);
        let settled = false;
        operation.then(() => { settled = true; }, () => { settled = true; });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(startedPaths.length, 8);
            assert.equal(settled, false);
            releaseReads();
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(startedPaths.length, 8, 'late observations must not refill the stopped window');
            assert.equal(finishedPaths.filter(file => file !== '0.ts').length, 6);
            assert.equal(settled, false, 'the last started read is still owned by the operation');
            releaseLastRead();
            await outcome;
            assert.equal(finishedPaths.filter(file => file !== '0.ts').length, 7);
        } finally {
            releaseReads();
            releaseLastRead();
            await operation.catch(() => undefined);
            await analyzer.dispose?.();
        }
    });
}

test('deferred analysis failure waits for every already-started source read', async () => {
    const firstError = new Error('injected deferred read failure');
    let releaseLaterRead!: () => void;
    const laterReadGate = new Promise<void>(resolve => { releaseLaterRead = resolve; });
    const analyzer = Object.assign(createLanguageAnalysisService(), { concurrency: 4 });
    const pipeline = new IndexingPipeline({
        getVectorDatabase: createMockVectorDb,
        languageAnalyzer: analyzer,
        semanticAnalyzer: noopSemanticProjectAnalyzer,
        getEmbedding: createMockEmbedding,
        assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
        isHybridEnabled: () => false,
        canonicalizeCodebasePath: p => p,
        normalizeRelativePathForCodebase: (_base, p) => p as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => ['.ts'],
        matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'fixture',
    });
    let laterReadFinished = false;
    pipeline.readIndexableFileObservationInsideRoot = async filePath => {
        if (filePath === 'a.ts') throw firstError;
        await laterReadGate;
        laterReadFinished = true;
        return null;
    };
    const operation = pipeline.processFileList({
        filePaths: ['a.ts', 'b.ts'], codebasePath: '/repo', collectionName: 'fixture',
        resourcePlan: {
            ...new IndexingResourcePlanner({
                platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
                totalMemory: () => 16 * 1024 ** 3, freeMemory: () => 16 * 1024 ** 3, cpuCount: () => 8,
            }, () => ({ diagnostics: [] })).createPlan(),
            analysisWorkers: 2,
            analysisWindowFiles: 2,
            analysisWindowSourceBytes: 64 * 1024 ** 2,
        },
    });
    const rejection = assert.rejects(operation, error => error === firstError);
    let settled = false;
    operation.then(() => { settled = true; }, () => { settled = true; });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'returned while a prefetched deferred read was in flight');
        releaseLaterRead();
        await rejection;
        assert.equal(laterReadFinished, true);
    } finally {
        releaseLaterRead();
        await operation.catch(() => undefined);
        await analyzer.dispose?.();
    }
});

test('eager custom and deferred built-in indexing publish identical ordered rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-indexing-deferred-equivalence-'));
    try {
        fs.writeFileSync(path.join(root, 'a.ts'), [
            'const before = 1;',
            'function outer() {',
            '  function inner() { return "😀"; }',
            '  return inner();',
            '}',
            'const after = 2;',
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(root, 'b.ts'), 'export const message = "雪と🚀";\n');

        const basePlan = new IndexingResourcePlanner({
            platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
            totalMemory: () => 16 * 1024 ** 3, freeMemory: () => 16 * 1024 ** 3, cpuCount: () => 8,
        }, () => ({ diagnostics: [] })).createPlan();

        const run = async (mode: 'eager' | 'deferred', files: number, sourceBytes: number) => {
            const local = createLanguageAnalysisService({ chunkSize: 48, chunkOverlap: 11 });
            const rows: unknown[] = [];
            const database = createMockVectorDb();
            database.writeDocuments = async (_collection, documents) => {
                rows.push(...documents.map(({ document, projections }) => {
                    const metadata = Object.fromEntries(Object.entries(document.metadata)
                        .filter(([key]) => key !== 'indexedAt'));
                    return { document: { ...document, metadata }, projections };
                }));
            };
            const pipeline = new IndexingPipeline({
                getVectorDatabase: () => database,
                languageAnalyzer: mode === 'eager'
                    ? createEagerOnlyAnalyzer(input => local.analyze(input))
                    : local,
                semanticAnalyzer: noopSemanticProjectAnalyzer,
                getEmbedding: createMockEmbedding,
                assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
                isHybridEnabled: () => false,
                canonicalizeCodebasePath: p => p,
                normalizeRelativePathForCodebase: (base, file) => path.relative(base, file) as RepositoryRelativePath,
                getIndexedExtensionsForCodebase: () => ['.ts'],
                matchesIgnorePattern: () => false,
                getSymbolExtractorVersion: () => 'fixture',
            });
            try {
                const result = await pipeline.processFileList({
                    filePaths: [path.join(root, 'a.ts'), path.join(root, 'b.ts')],
                    codebasePath: root,
                    collectionName: 'fixture',
                    resourcePlan: {
                        ...basePlan,
                        analysisWindowFiles: files,
                        analysisWindowSourceBytes: sourceBytes,
                    },
                });
                await result.payloadSettled;
                return {
                    processedFiles: result.processedFiles,
                    totalChunks: result.totalChunks,
                    status: result.status,
                    sourceFiles: result.sourceFiles,
                    symbolRecords: result.symbolRecords,
                    symbolManifestFiles: result.symbolManifestFiles,
                    analysisByFile: [...result.analysisByFile],
                    rows,
                };
            } finally {
                await local.dispose?.();
            }
        };

        const eager = await run('eager', 4, 64 * 1024 ** 2);
        const deferredWide = await run('deferred', 4, 64 * 1024 ** 2);
        const deferredNarrow = await run('deferred', 1, 8 * 1024 ** 2);
        assert.ok(eager.totalChunks > 2);
        assert.deepEqual(deferredWide, eager);
        assert.deepEqual(deferredNarrow, eager);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('eager and deferred indexing publish every chunk past 450,000 in the same order', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-indexing-chunk-limit-'));
    try {
        const source = `function huge() {\n${' \n'.repeat(225_000)}}\n`;
        const filePath = path.join(root, 'huge.ts');
        fs.writeFileSync(filePath, source);
        const basePlan = new IndexingResourcePlanner({
            platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
            totalMemory: () => 16 * 1024 ** 3, freeMemory: () => 16 * 1024 ** 3, cpuCount: () => 8,
        }, () => ({ diagnostics: [] })).createPlan();

        const run = async (mode: 'eager' | 'deferred') => {
            const local = createLanguageAnalysisService({ chunkSize: 1, chunkOverlap: 0 });
            const rowDigest = crypto.createHash('sha256');
            let rowCount = 0;
            let firstChunkIndex: unknown;
            let lastChunkIndex: unknown;
            const database = createMockVectorDb();
            database.writeDocuments = async (_collection, documents) => {
                for (const { document, projections } of documents) {
                    const metadata = Object.fromEntries(
                        Object.entries(document.metadata).filter(([key]) => key !== 'indexedAt'),
                    );
                    rowDigest.update(JSON.stringify({
                        id: document.id,
                        content: document.content,
                        relativePath: document.relativePath,
                        startLine: document.startLine,
                        endLine: document.endLine,
                        fileExtension: document.fileExtension,
                        metadata,
                        projections,
                    }));
                    rowDigest.update('\n');
                    const chunkIndex = document.metadata.chunkIndex;
                    if (rowCount === 0) firstChunkIndex = chunkIndex;
                    lastChunkIndex = chunkIndex;
                    rowCount++;
                }
            };
            const pipeline = new IndexingPipeline({
                getVectorDatabase: () => database,
                languageAnalyzer: mode === 'eager'
                    ? createEagerOnlyAnalyzer(input => local.analyze(input))
                    : local,
                semanticAnalyzer: noopSemanticProjectAnalyzer,
                getEmbedding: createMockEmbedding,
                assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
                isHybridEnabled: () => false,
                canonicalizeCodebasePath: p => p,
                normalizeRelativePathForCodebase: (base, file) => path.relative(base, file) as RepositoryRelativePath,
                getIndexedExtensionsForCodebase: () => ['.ts'],
                matchesIgnorePattern: () => false,
                getSymbolExtractorVersion: () => 'fixture',
            });
            try {
                const result = await pipeline.processFileList({
                    filePaths: [filePath],
                    codebasePath: root,
                    collectionName: 'fixture',
                    resourcePlan: {
                        ...basePlan,
                        analysisWindowFiles: 2,
                        analysisWindowSourceBytes: 64 * 1024 ** 2,
                        embeddingBatchMaxItems: 1000,
                        vectorWriteMaxRows: 256,
                    },
                });
                await result.payloadSettled;
                return {
                    result: {
                        status: result.status,
                        processedFiles: result.processedFiles,
                        totalChunks: result.totalChunks,
                        sourceFiles: result.sourceFiles,
                    },
                    rowCount,
                    firstChunkIndex,
                    lastChunkIndex,
                    rowDigest: rowDigest.digest('hex'),
                };
            } finally {
                await local.dispose?.();
            }
        };

        const eager = await run('eager');
        const deferred = await run('deferred');
        // No fixed chunk count stops a full index (the old cap was 450,000).
        assert.equal(eager.result.status, 'completed');
        assert.equal(eager.result.processedFiles, 1);
        assert.ok(eager.result.totalChunks > 450_000, `expected more than 450,000 chunks, got ${eager.result.totalChunks}`);
        assert.equal(eager.rowCount, eager.result.totalChunks);
        assert.equal(eager.firstChunkIndex, 0);
        assert.equal(eager.lastChunkIndex, eager.result.totalChunks - 1);
        assert.deepEqual(deferred, eager);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});


test('getCodeFiles keeps built-in denylisted files excluded despite policy re-include rules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-code-files-'));
    try {
        fs.mkdirSync(path.join(root, 'vendor'));
        fs.writeFileSync(path.join(root, 'vendor', 'x.min.js'), 'var a = 1;\n');
        fs.writeFileSync(path.join(root, 'vendor', 'y.js'), 'var b = 2;\n');
        const pipeline = new IndexingPipeline({
            getVectorDatabase: () => createMockVectorDb(),
            languageAnalyzer: createLanguageAnalysisService(),
            semanticAnalyzer: noopSemanticProjectAnalyzer,
            getEmbedding: () => createMockEmbedding(),
            assertEmbeddingIdentityCurrent: () => ({
                provider: 'test',
                model: 'test',
                dimension: 768,
                artifactDigest: null,
                normalizationPolicy: 'none',
            }),
            isHybridEnabled: () => false,
            canonicalizeCodebasePath: (p) => p,
            normalizeRelativePathForCodebase: (_cb, p) => p as unknown as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.js'],
            matchesIgnorePattern: (filePath, codebasePath, _isDirectory, matcher) => (
                matcher?.ignores(path.relative(codebasePath, filePath).split(path.sep).join('/')) ?? false
            ),
            getSymbolExtractorVersion: () => 'extractor-v1',
        });
        const files = await pipeline.getCodeFiles(root, {
            supportedExtensions: ['.js'],
            effectiveIgnorePatterns: ['*.min.js', '!vendor/x.min.js'],
        });
        assert.deepEqual(files.map((file) => path.relative(root, file)), ['vendor/y.js']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('getCodeFiles skips unrepresentable POSIX names before they can alias supported paths', {
    skip: process.platform === 'win32',
}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-code-files-portable-'));
    try {
        fs.mkdirSync(path.join(root, 'a'));
        fs.writeFileSync(path.join(root, 'normal.ts'), 'export const normal = 1;\n');
        fs.writeFileSync(path.join(root, 'a', 'b.ts'), 'export const represented = 2;\n');
        fs.writeFileSync(path.join(root, 'a\\b.ts'), 'export const unrepresentable = 3;\n');
        fs.mkdirSync(path.join(root, 'a\\nested'));
        fs.writeFileSync(path.join(root, 'a\\nested', 'hidden.ts'), 'export const hidden = 4;\n');
        const pipeline = new IndexingPipeline({
            getVectorDatabase: () => createMockVectorDb(),
            languageAnalyzer: createLanguageAnalysisService(),
            semanticAnalyzer: noopSemanticProjectAnalyzer,
            getEmbedding: () => createMockEmbedding(),
            assertEmbeddingIdentityCurrent: () => ({
                provider: 'test', model: 'test', dimension: 768,
                artifactDigest: null, normalizationPolicy: 'none',
            }),
            isHybridEnabled: () => false,
            canonicalizeCodebasePath: (value) => value,
            normalizeRelativePathForCodebase: (_root, value) => value as unknown as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.ts'],
            matchesIgnorePattern: () => false,
            getSymbolExtractorVersion: () => 'extractor-v1',
        });
        const files = await pipeline.getCodeFiles(root);
        assert.deepEqual(files.map((file) => path.relative(root, file)), ['a/b.ts', 'normal.ts']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function createScanPipeline(extensions: string[]) {
    return new IndexingPipeline({
        getVectorDatabase: () => createMockVectorDb(),
        languageAnalyzer: createLanguageAnalysisService(),
        semanticAnalyzer: noopSemanticProjectAnalyzer,
        getEmbedding: () => createMockEmbedding(),
        assertEmbeddingIdentityCurrent: () => ({
            provider: 'test', model: 'test', dimension: 768,
            artifactDigest: null, normalizationPolicy: 'none',
        }),
        isHybridEnabled: () => false,
        canonicalizeCodebasePath: (value) => value,
        normalizeRelativePathForCodebase: (_root, value) => value as unknown as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => extensions,
        matchesIgnorePattern: (filePath, codebasePath, isDirectory, matcher) => {
            const relativePath = path.relative(codebasePath, filePath).split(path.sep).join('/');
            return isDirectory
                ? (matcher?.ignores(relativePath) || matcher?.ignores(`${relativePath}/`)) ?? false
                : matcher?.ignores(relativePath) ?? false;
        },
        getSymbolExtractorVersion: () => 'extractor-v1',
    });
}

// The one-at-a-time walk getCodeFiles used before its scan became concurrent.
async function serialReferenceCodeFiles(
    root: string,
    policy: { supportedExtensions: string[]; effectiveIgnorePatterns: string[] },
): Promise<string[]> {
    const matcher = createIndexIgnoreMatcher(policy.effectiveIgnorePatterns);
    const ignored = (fullPath: string, isDirectory: boolean) => {
        const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
        return isDirectory
            ? matcher.ignores(relativePath) || matcher.ignores(`${relativePath}/`)
            : matcher.ignores(relativePath);
    };
    const files: string[] = [];
    const traverse = async (currentPath: string): Promise<void> => {
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        entries.sort((left, right) => compareContractStrings(left.name, right.name));
        for (const entry of entries) {
            if (!isRepositoryRelativePath(entry.name)) continue;
            const fullPath = path.join(currentPath, entry.name);
            if (ignored(fullPath, entry.isDirectory())) continue;
            if (entry.isDirectory()) {
                await traverse(fullPath);
            } else if (entry.isFile()) {
                const stat = await fs.promises.stat(fullPath);
                const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
                if (await isIndexableFileByPolicy(relativePath, fullPath, stat.size, policy.supportedExtensions)) {
                    files.push(fullPath);
                }
            }
        }
    };
    await traverse(root);
    return files.sort((left, right) => compareContractStrings(
        path.relative(root, left).replace(/\\/g, '/'),
        path.relative(root, right).replace(/\\/g, '/'),
    ));
}

test('getCodeFiles rejects before stat and preserves the reference scan across admission branches', {
    skip: process.platform === 'win32',
}, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-code-files-admission-'));
    const root = path.join(directory, 'repo');
    fs.mkdirSync(root);
    try {
        const write = (name: string, content: string) => fs.writeFileSync(path.join(root, name), content);
        write('known.ts', 'export const known = 1;\n');
        write('excluded.py', '#!/usr/bin/env python3\nprint(1)\n');
        write('unknown.cgi', '#!/usr/bin/env python3\nprint(1)\n');
        write('unknown.data', 'ordinary notes\n');
        write('script', '#!/usr/bin/env python3\nprint(1)\n');
        write('ignored.ts', 'export const ignored = 1;\n');
        write('Makefile', 'all:\n\techo hello\n');
        write('Cargo.toml', '[package]\nname = "fixture"\n');
        write('asset.js', 'x'.repeat(128 * 1024));
        write('binary.data', '\0binary');
        write('oversize.ts', '');
        fs.truncateSync(path.join(root, 'oversize.ts'), MAX_INDEXED_SOURCE_FILE_BYTES + 1);
        fs.writeFileSync(path.join(directory, 'outside.ts'), 'export const outside = 1;\n');
        fs.symlinkSync(path.join(root, 'known.ts'), path.join(root, 'inside-link.ts'));
        fs.symlinkSync(path.join(directory, 'outside.ts'), path.join(root, 'outside-link.ts'));
        fs.symlinkSync(directory, path.join(root, 'outside-dir'));

        const originalStat = fs.promises.stat;
        let recording = false;
        const statPaths: string[] = [];
        t.mock.method(fs.promises, 'stat', async (...args: Parameters<typeof fs.promises.stat>) => {
            if (recording) statPaths.push(String(args[0]));
            return originalStat(...args);
        });
        for (const extensions of [
            ['.ts', '.js'],
            [...DEFAULT_SUPPORTED_EXTENSIONS],
            [...DEFAULT_SUPPORTED_EXTENSIONS, ALL_TEXT_INDEX_MARKER],
        ]) {
            const policy = { supportedExtensions: extensions, effectiveIgnorePatterns: ['ignored.ts'] };
            recording = false;
            const expected = await serialReferenceCodeFiles(root, policy);
            statPaths.length = 0;
            recording = true;
            const actual = await createScanPipeline(extensions).getCodeFiles(root, policy);
            recording = false;
            assert.deepEqual(actual, expected, 'selected paths and their order must match the old walk');
            const relative = actual.map((file) => path.relative(root, file));
            for (const admitted of ['known.ts', 'unknown.cgi', 'script', 'Makefile']) {
                assert.ok(relative.includes(admitted), admitted);
            }
            for (const rejected of ['ignored.ts', 'inside-link.ts', 'outside-link.ts', 'oversize.ts', 'asset.js', 'Cargo.toml', 'binary.data']) {
                assert.ok(!relative.includes(rejected), rejected);
            }
            assert.equal(relative.includes('unknown.data'), extensions.includes(ALL_TEXT_INDEX_MARKER));
            if (!extensions.includes('.py')) {
                assert.ok(!relative.includes('excluded.py'));
                assert.ok(!statPaths.includes(path.join(root, 'excluded.py')), 'a proven rejection must not call stat');
            }
            assert.ok(statPaths.includes(path.join(root, 'unknown.cgi')), 'unrecognized suffixes still need a shebang probe');
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('concurrent getCodeFiles returns the same sorted files as the one-at-a-time walk', {
    skip: process.platform === 'win32',
}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-code-files-concurrent-'));
    try {
        const write = (relativePath: string, content: string | Buffer) => {
            fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
            fs.writeFileSync(path.join(root, relativePath), content);
        };
        // Depth-first visit order differs from sorted path order here: 'a-c.ts' < 'a/b.ts'.
        write('a.ts', 'export const a = 1;\n');
        write('a-c.ts', 'export const ac = 1;\n');
        write('a/b.ts', 'export const b = 1;\n');
        write('a/nested/deep.ts', 'export const deep = 1;\n');
        write('ignored/x.ts', 'x\n');
        write('skip.gen.ts', 'export const gen = 1;\n');
        write('script', '#!/usr/bin/env python3\nprint(1)\n');
        write('notes', 'plain text without a shebang\n');
        write('data.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
        write('a\\b.ts', 'export const unrepresentable = 1;\n');
        fs.mkdirSync(path.join(root, 'empty'));
        fs.symlinkSync(path.join(root, 'a.ts'), path.join(root, 'link-file.ts'));
        fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link-dir'));
        for (let directory = 0; directory < 10; directory++) {
            for (let file = 0; file < 6; file++) {
                write(`many/dir${directory}/f${file}.ts`, `export const v${directory}_${file} = 1;\n`);
            }
        }
        const policy = { supportedExtensions: ['.ts', '.py'], effectiveIgnorePatterns: ['ignored/', '*.gen.ts'] };
        const pipeline = createScanPipeline(policy.supportedExtensions);

        const expected = await serialReferenceCodeFiles(root, policy);
        const actual = await pipeline.getCodeFiles(root, policy);
        assert.deepEqual(actual, expected);
        const relative = actual.map((file) => path.relative(root, file));
        assert.equal(relative.length, 64 + (relative.includes('script') ? 1 : 0));
        assert.ok(relative.indexOf('a-c.ts') < relative.indexOf('a/b.ts'));
        assert.ok(!relative.includes('ignored/x.ts') && !relative.includes('skip.gen.ts'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('concurrent getCodeFiles reports the first failure in walk order after in-flight probes settle', {
    skip: process.platform === 'win32',
    timeout: 10_000,
}, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-code-files-failure-'));
    try {
        fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
        fs.mkdirSync(path.join(root, 'b'));
        fs.writeFileSync(path.join(root, 'b', 'x.ts'), 'x\n');
        fs.writeFileSync(path.join(root, 'c.ts'), 'export const c = 1;\n');
        fs.mkdirSync(path.join(root, 'd'));
        fs.writeFileSync(path.join(root, 'd', 'y.ts'), 'export const y = 1;\n');

        const realReaddir = fs.promises.readdir.bind(fs.promises);
        const realStat = fs.promises.stat.bind(fs.promises);
        let failD!: () => void;
        const dFailed = new Promise<void>((resolve) => { failD = resolve; });
        let bFailed = false;
        let releaseA!: () => void;
        const aReleased = new Promise<void>((resolve) => { releaseA = resolve; });
        // 'd' fails first in time, 'b' fails later but first in walk order,
        // and the probe of 'a.ts' stays in flight after both failures.
        t.mock.method(fs.promises, 'readdir', async (target: string, options: unknown) => {
            if (target === path.join(root, 'd')) {
                failD();
                throw new Error('injected readdir failure: d');
            }
            if (target === path.join(root, 'b')) {
                await dFailed;
                bFailed = true;
                throw new Error('injected readdir failure: b');
            }
            return realReaddir(target, options as { withFileTypes: true });
        });
        t.mock.method(fs.promises, 'stat', async (target: string) => {
            if (target === path.join(root, 'a.ts')) await aReleased;
            return realStat(target);
        });

        let settled = false;
        const scan = createScanPipeline(['.ts']).getCodeFiles(root);
        scan.then(() => { settled = true; }, () => { settled = true; });
        while (!bFailed) await new Promise((resolve) => setImmediate(resolve));
        for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'getCodeFiles must wait for the in-flight probe');
        releaseA();
        await assert.rejects(scan, /injected readdir failure: b/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('IndexingPipeline publishes the analyzer outcome without losing recovery reasons', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-index-parser-outcome-'));
    try {
        const file = path.join(root, 'broken.ts');
        fs.writeFileSync(file, 'export function broken(');
        const pipeline = new IndexingPipeline({
            getVectorDatabase: createMockVectorDb,
            languageAnalyzer: { getDescription: () => 'fixture', getStrategyForLanguage: () => ({ backend: 'bounded_text', structural: false }), analyze: async () => ({ backend: 'bounded_text', structuralStatus: 'recovered', structuralReason: 'syntax_error', symbols: [], chunks: [], moduleBindings: [], callSites: [], receiverTypeBindings: [] }) },
            semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: createMockEmbedding,
            assertEmbeddingIdentityCurrent: () => ({ provider: 'test', model: 'test', dimension: 768, artifactDigest: null, normalizationPolicy: 'none' }),
            isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
            normalizeRelativePathForCodebase: (base, p) => path.relative(base, p) as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
            getSymbolExtractorVersion: () => 'extractor-v1',
        });
        const analyzed = await pipeline.analyzeIndexedFile(file, root);
        assert.ok(analyzed);
        const facts = pipeline.buildAnalyzedFileSymbolFacts(analyzed);
        assert.equal(facts.manifestFile.definitionStatus, 'structural_unavailable');
        assert.equal(facts.manifestFile.structuralStatus, 'recovered');
        assert.equal(facts.manifestFile.structuralReason, 'syntax_error');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('IndexingPipeline vocabulary is default-off and preserves legacy symbol bytes', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-index-vocabulary-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previous = process.env.SATORI_REPOSITORY_VOCABULARY_INDEX;
    delete process.env.SATORI_REPOSITORY_VOCABULARY_INDEX;
    t.after(() => {
        if (previous === undefined) delete process.env.SATORI_REPOSITORY_VOCABULARY_INDEX;
        else process.env.SATORI_REPOSITORY_VOCABULARY_INDEX = previous;
    });
    const languageAnalyzer = createLanguageAnalysisService();
    t.after(() => languageAnalyzer.dispose?.());
    const createPipeline = (repositoryVocabularyEnabled?: boolean) => new IndexingPipeline({
        getVectorDatabase: createMockVectorDb, languageAnalyzer,
        semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: createMockEmbedding,
        assertEmbeddingIdentityCurrent: () => ({ provider: 'test', model: 'test', dimension: 768,
            artifactDigest: null, normalizationPolicy: 'none' }),
        isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
        normalizeRelativePathForCodebase: (base, p) => path.relative(base, p) as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'extractor-v1', repositoryVocabularyEnabled,
    });
    const file = path.join(root, 'effects.ts');
    fs.writeFileSync(file, '// Release subscriptions during cleanup.\nfunction releaseSubscription() {}\n');
    const defaultPipeline = createPipeline();
    const analyzed = await defaultPipeline.analyzeIndexedFile(file, root);
    assert.ok(analyzed);
    const legacy = buildSymbolRecordsForFile({ relativePath: analyzed.relativePath,
        language: analyzed.language, content: analyzed.source, fileHash: analyzed.sourceHash,
        extractorVersion: 'extractor-v1', extractedSymbols: analyzed.extractedSymbols,
        chunks: analyzed.chunks });
    for (const pipeline of [defaultPipeline, createPipeline(false)]) {
        const facts = pipeline.buildAnalyzedFileSymbolFacts(analyzed);
        assert.equal(JSON.stringify(facts.symbolRecords), JSON.stringify(legacy));
        assert.ok(facts.symbolRecords.every(symbol => !('vocabulary' in symbol)));
    }
    const enabled = createPipeline(true).buildAnalyzedFileSymbolFacts(analyzed);
    assert.ok(enabled.symbolRecords.some(symbol => symbol.vocabulary?.terms.length));
    assert.deepEqual(enabled.manifestFile, defaultPipeline.buildAnalyzedFileSymbolFacts(analyzed).manifestFile);
    assert.deepEqual(enabled.relationshipEvidence, defaultPipeline.buildAnalyzedFileSymbolFacts(analyzed).relationshipEvidence);
    process.env.SATORI_REPOSITORY_VOCABULARY_INDEX = '1';
    const optedIn = createPipeline();
    const forcedOff = createPipeline(false);
    process.env.SATORI_REPOSITORY_VOCABULARY_INDEX = '0';
    assert.equal(optedIn.isRepositoryVocabularyIndexingEnabled(), true,
        'the policy is captured at startup, not re-read for every file');
    assert.ok(optedIn.buildAnalyzedFileSymbolFacts(analyzed).symbolRecords.some(symbol => symbol.vocabulary));
    assert.equal(forcedOff.isRepositoryVocabularyIndexingEnabled(), false);
    assert.equal(JSON.stringify(forcedOff.buildAnalyzedFileSymbolFacts(analyzed).symbolRecords), JSON.stringify(legacy));
});

test('operation plan bounds analysis read-ahead, queued text, embedding batches and vector writes', { timeout: 10_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pipeline-budget-'));
    const local = createLanguageAnalysisService();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const embeddingStarted = new Promise<void>(resolve => { started = resolve; });
    let analyses = 0;
    const batchSizes: number[] = [];
    const writeSizes: number[] = [];
    const embedding = createMockEmbedding();
    const embed = embedding.embedDocuments.bind(embedding);
    embedding.embedDocuments = async texts => {
        batchSizes.push(texts.length);
        started();
        await gate;
        return embed(texts);
    };
    const database = createMockVectorDb();
    database.getWriteAggregationPolicy = () => ({ preferredMaxRows: 256 });
    database.writeDocuments = async (_collection, documents) => { writeSizes.push(documents.length); };
    const base = new IndexingResourcePlanner({
        platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
        totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 64 * 1024 ** 3, cpuCount: () => 16,
    }, () => ({ diagnostics: [] })).createPlan();
    const resourcePlan = Object.freeze({ ...base, analysisWindowFiles: 1, queuedEmbeddingTextBytes: 1,
        embeddingBatchMaxItems: 2, vectorWriteMaxRows: 2 });
    const pipeline = new IndexingPipeline({
        getVectorDatabase: () => database,
        languageAnalyzer: Object.assign(createEagerOnlyAnalyzer(input => {
            analyses++;
            return local.analyze(input);
        }), { concurrency: 16 }),
        semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: () => embedding,
        assertEmbeddingIdentityCurrent: () => embedding.getIdentity(),
        isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
        normalizeRelativePathForCodebase: (base, p) => path.relative(base, p) as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'extractor-v1',
    });
    const filePaths = Array.from({ length: 12 }, (_, index) => {
        const file = path.join(root, `${index}.ts`);
        fs.writeFileSync(file, `export const value${index} = ${index};\n`);
        return file;
    });
    const operation = pipeline.processFileList({ filePaths, codebasePath: root, collectionName: 'fixture', resourcePlan });
    operation.catch(() => undefined);
    try {
        await embeddingStarted;
        assert.equal(analyses, 1, 'queued text must block the file loop and plan must bound read-ahead');
        release();
        const result = await operation;
        await result.payloadSettled;
        assert.equal(result.processedFiles, 12);
        assert.ok(batchSizes.length > 0);
        assert.ok(batchSizes.every(size => size === 2));
        assert.equal(batchSizes.reduce((sum, size) => sum + size, 0), result.totalChunks);
        assert.ok(writeSizes.length > 0);
        assert.ok(writeSizes.every(size => size === 2));
        assert.equal(writeSizes.reduce((sum, size) => sum + size, 0), result.totalChunks);
    } finally {
        release();
        await operation.catch(() => undefined);
        await local.dispose?.();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a failed file drains already-started analysis reads before the pipeline rejects', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pipeline = new IndexingPipeline({
        getVectorDatabase: createMockVectorDb, languageAnalyzer: createEagerOnlyAnalyzer(async () => {
            throw new Error('analyzeIndexedFile override should own this test');
        }),
        semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: createMockEmbedding,
        assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
        isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
        normalizeRelativePathForCodebase: (_base, p) => p as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'fixture',
    });
    let readFinished = false;
    pipeline.analyzeIndexedFile = async file => {
        if (file === 'a.ts') throw new Error('injected file failure');
        await gate;
        readFinished = true;
        return null;
    };
    const operation = pipeline.processFileList({ filePaths: ['a.ts', 'b.ts'], codebasePath: '/repo', collectionName: 'fixture' });
    const rejection = assert.rejects(operation, /injected file failure/);
    let settled = false;
    operation.then(() => { settled = true; }, () => { settled = true; });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'returned while a prefetched analysis read was in flight');
        release();
        await rejection;
        assert.equal(readFinished, true);
    } finally { release(); await operation.catch(() => undefined); }
});

for (const stop of ['analysis failure', 'cancellation'] as const) {
    test(`${stop} drains later read failures without replacing the first outcome`, async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const firstError = new Error(stop);
        if (stop === 'cancellation') firstError.name = 'AbortError';
        const pipeline = new IndexingPipeline({
            getVectorDatabase: createMockVectorDb, languageAnalyzer: createEagerOnlyAnalyzer(async () => {
                throw new Error('analyzeIndexedFile override should own this test');
            }),
            semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: createMockEmbedding,
            assertEmbeddingIdentityCurrent: () => createMockEmbedding().getIdentity(),
            isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
            normalizeRelativePathForCodebase: (_base, p) => p as RepositoryRelativePath,
            getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
            getSymbolExtractorVersion: () => 'fixture',
        });
        let readFinished = false;
        pipeline.analyzeIndexedFile = async file => {
            if (file === 'b.ts') {
                await gate;
                readFinished = true;
                throw new Error('later read failure');
            }
            if (stop === 'analysis failure') throw firstError;
            return {
                relativePath: file as RepositoryRelativePath, source: '', sourceHash: 'fixture',
                sourceStat: { size: 1, mtimeMs: 0, ctimeMs: 0 },
                language: 'typescript', structuralStatus: 'complete', chunks: [], extractedSymbols: [],
                moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [],
            };
        };
        const operation = pipeline.processFileList({
            filePaths: ['a.ts', 'b.ts'], codebasePath: '/repo', collectionName: 'fixture',
            onFileProcessed: () => { if (stop === 'cancellation') throw firstError; },
        });
        const outcome = assert.rejects(operation, error => error === firstError);
        let settled = false;
        operation.then(() => { settled = true; }, () => { settled = true; });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(settled, false, 'returned while a later analysis read was in flight');
            release();
            await outcome;
            assert.equal(readFinished, true);
        } finally { release(); await operation.catch(() => undefined); }
    });
}

function createConcurrencyFixture(files: number) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-pipeline-embedding-concurrency-'));
    const filePaths = Array.from({ length: files }, (_, index) => {
        const file = path.join(root, `${String(index).padStart(2, '0')}.ts`);
        fs.writeFileSync(file, `export const value${index} = ${index};\nexport function f${index}() { return ${index}; }\n`);
        return file;
    });
    const plan = new IndexingResourcePlanner({
        platform: () => 'darwin', readFile: () => { throw new Error('unexpected memory read'); },
        totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 64 * 1024 ** 3, cpuCount: () => 16,
    }, () => ({ diagnostics: [] })).createPlan();
    // Batches of 3 and writes of 5 rows: write boundaries cross embedding batches.
    const resourcePlan = Object.freeze({ ...plan, embeddingBatchMaxItems: 3, vectorWriteMaxRows: 5 });
    return { root, filePaths, resourcePlan };
}

function createConcurrencyPipeline(embedding: Embedding, database: VectorDatabase, local: LanguageAnalysisPort) {
    return new IndexingPipeline({
        getVectorDatabase: () => database,
        languageAnalyzer: createEagerOnlyAnalyzer(input => local.analyze(input)),
        semanticAnalyzer: noopSemanticProjectAnalyzer, getEmbedding: () => embedding,
        assertEmbeddingIdentityCurrent: () => embedding.getIdentity(),
        isHybridEnabled: () => false, canonicalizeCodebasePath: p => p,
        normalizeRelativePathForCodebase: (base, p) => path.relative(base, p) as RepositoryRelativePath,
        getIndexedExtensionsForCodebase: () => ['.ts'], matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'fixture',
    });
}

test('concurrent embedding requests publish the same ordered rows and write batches as one at a time', { timeout: 10_000 }, async () => {
    const { root, filePaths, resourcePlan } = createConcurrencyFixture(14);
    const local = createLanguageAnalysisService({ chunkSize: 40, chunkOverlap: 0 });
    try {
        const run = async (maxConcurrentRequests: number | undefined, totalCalls: number) => {
            const embedding = createMockEmbedding();
            let calls = 0;
            let maxInFlight = 0;
            const waiting: Array<() => void> = [];
            embedding.getBatchPolicy = () => ({ preferredMaxItems: 3, hardMaxItems: 3, maxConcurrentRequests });
            embedding.embedDocuments = async texts => {
                calls++;
                await new Promise<void>(resolve => {
                    waiting.push(resolve);
                    maxInFlight = Math.max(maxInFlight, waiting.length);
                    // Hold requests until the provider limit is in flight (or
                    // none can follow), then complete the newest first.
                    if (waiting.length === (maxConcurrentRequests ?? 1) || calls === totalCalls) {
                        void (async () => {
                            for (const done of waiting.splice(0).reverse()) {
                                done();
                                await new Promise(next => setImmediate(next));
                            }
                        })();
                    }
                });
                return texts.map(text => {
                    const digest = crypto.createHash('sha256').update(text).digest();
                    return { vector: Array.from({ length: 768 }, (_, index) => digest[index % 32] / 255), dimension: 768 };
                });
            };
            const database = createMockVectorDb();
            const writes: unknown[][] = [];
            database.getWriteAggregationPolicy = () => ({ preferredMaxRows: 256 });
            database.writeDocuments = async (_collection, documents) => {
                writes.push(documents.map(({ document, projections }) => {
                    const metadata = Object.fromEntries(Object.entries(document.metadata)
                        .filter(([key]) => key !== 'indexedAt'));
                    return { document: { ...document, metadata }, projections };
                }));
            };
            const result = await createConcurrencyPipeline(embedding, database, local)
                .processFileList({ filePaths, codebasePath: root, collectionName: 'fixture', resourcePlan });
            await result.payloadSettled;
            return { writes, maxInFlight, calls, totalChunks: result.totalChunks };
        };

        const serial = await run(undefined, Infinity);
        const concurrent = await run(4, serial.calls);
        assert.ok(serial.calls >= 8, 'fixture must produce several embedding batches');
        assert.equal(serial.maxInFlight, 1);
        assert.equal(concurrent.maxInFlight, 4);
        assert.ok(serial.writes.some(batch => batch.length === 5));
        assert.deepEqual(concurrent.writes, serial.writes);
        assert.equal(concurrent.totalChunks, serial.totalChunks);
    } finally {
        await local.dispose?.();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a failed concurrent embedding request waits for in-flight requests and writes nothing after it', { timeout: 10_000 }, async () => {
    const { root, filePaths, resourcePlan } = createConcurrencyFixture(14);
    const local = createLanguageAnalysisService({ chunkSize: 40, chunkOverlap: 0 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fail!: () => void;
    const failGate = new Promise<void>(resolve => { fail = resolve; });
    try {
        const embedding = createMockEmbedding();
        const embed = embedding.embedDocuments.bind(embedding);
        let calls = 0;
        let inFlight = 0;
        embedding.getBatchPolicy = () => ({ preferredMaxItems: 3, hardMaxItems: 3, maxConcurrentRequests: 3 });
        embedding.embedDocuments = async texts => {
            const call = calls++;
            inFlight++;
            try {
                if (call === 1) {
                    await failGate;
                    throw new Error('injected embedding failure');
                }
                if (call === 2) await gate;
                return await embed(texts);
            } finally {
                inFlight--;
            }
        };
        const database = createMockVectorDb();
        const writtenIds: string[] = [];
        database.getWriteAggregationPolicy = () => ({ preferredMaxRows: 256 });
        database.writeDocuments = async (_collection, documents) => {
            writtenIds.push(...documents.map(({ document }) => document.id));
        };
        // The file loop finishes while requests 1 and 2 are held, so only
        // payload settlement remains: no file I/O can delay the check below.
        const result = await createConcurrencyPipeline(embedding, database, local)
            .processFileList({ filePaths, codebasePath: root, collectionName: 'fixture', resourcePlan });
        assert.ok(calls >= 3);
        let inFlightAtSettle: number | undefined;
        result.payloadSettled.then(() => { inFlightAtSettle = inFlight; }, () => { inFlightAtSettle = inFlight; });
        const rejection = assert.rejects(result.payloadSettled, /injected embedding failure/);
        fail();
        for (let tick = 0; tick < 20; tick++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(inFlightAtSettle, undefined, 'payload settled while a later embedding request was in flight');
        release();
        await rejection;
        assert.equal(inFlightAtSettle, 0);
        // Only the first batch (3 rows) precedes the failure; one write of 5
        // rows cannot have filled, so nothing is written.
        assert.deepEqual(writtenIds, []);
    } finally {
        fail();
        release();
        await local.dispose?.();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a failed final chunk flush waits for in-flight embedding requests and writes nothing after the failure', { timeout: 10_000 }, async () => {
    const { root, filePaths, resourcePlan } = createConcurrencyFixture(13);
    const local = createLanguageAnalysisService({ chunkSize: 40, chunkOverlap: 0 });
    const lastFile = path.basename(filePaths[filePaths.length - 1]);
    fs.writeFileSync(filePaths[filePaths.length - 1], 'x\n');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fail!: () => void;
    const failGate = new Promise<void>(resolve => { fail = resolve; });
    let releaseLast!: () => void;
    const lastGate = new Promise<void>(resolve => { releaseLast = resolve; });
    let reachLastFile!: () => void;
    const loopAtLastFile = new Promise<void>(resolve => { reachLastFile = resolve; });
    try {
        const embedding = createMockEmbedding();
        const embed = embedding.embedDocuments.bind(embedding);
        let calls = 0;
        let inFlight = 0;
        embedding.getBatchPolicy = () => ({ preferredMaxItems: 3, hardMaxItems: 3, maxConcurrentRequests: 3 });
        embedding.embedDocuments = async texts => {
            const call = calls++;
            inFlight++;
            try {
                if (call === 0) {
                    await failGate;
                    throw new Error('injected embedding failure');
                }
                if (call === 1) await gate;
                return await embed(texts);
            } finally {
                inFlight--;
            }
        };
        const database = createMockVectorDb();
        const writtenIds: string[] = [];
        database.getWriteAggregationPolicy = () => ({ preferredMaxRows: 256 });
        database.writeDocuments = async (_collection, documents) => {
            writtenIds.push(...documents.map(({ document }) => document.id));
        };
        // Each fixture file has four chunks. The last file has one, so it stays in
        // the buffer for the final flush. The last file is held so the loop is
        // parked before it when request 0 fails: the failure is recorded before
        // the final flush, which then throws while request 1 is still pending.
        const gatedLocal: LanguageAnalysisPort = {
            ...local,
            analyze: async input => {
                if (input.relativePath === lastFile) await lastGate;
                return local.analyze(input);
            },
        };
        let settled = false;
        let inFlightAtSettle: number | undefined;
        const processing = createConcurrencyPipeline(embedding, database, gatedLocal)
            .processFileList({
                filePaths,
                codebasePath: root,
                collectionName: 'fixture',
                resourcePlan,
                onFileProcessed: (_file, processed) => { if (processed === filePaths.length - 1) reachLastFile(); },
            });
        const rejection = assert.rejects(processing, /injected embedding failure/);
        processing.then(() => { settled = true; inFlightAtSettle = inFlight; }, () => { settled = true; inFlightAtSettle = inFlight; });
        // Request 0 is held, so only the first requests start; the loop still
        // submits every earlier batch and parks on the held last file.
        await loopAtLastFile;
        assert.ok(calls >= 2, 'requests 0 and 1 must be pending before the failure');
        fail();
        for (let tick = 0; tick < 20; tick++) await new Promise(resolve => setImmediate(resolve));
        releaseLast();
        for (let tick = 0; tick < 20; tick++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'processFileList rejected while an embedding request was in flight');
        release();
        await rejection;
        assert.equal(inFlightAtSettle, 0);
        assert.deepEqual(writtenIds, []);
    } finally {
        fail();
        release();
        releaseLast();
        await local.dispose?.();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
