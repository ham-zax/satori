import test from 'node:test';
import assert from 'node:assert/strict';
import {
    IndexingPipeline,
    MAX_INDEXED_SOURCE_BYTES_PER_PUBLICATION,
    type AnalyzedIndexedFile,
} from './indexing-pipeline';
import { createLanguageAnalysisService } from '../language-analysis';
import { noopSemanticProjectAnalyzer } from '../semantic/noop-analyzer';
import type { SemanticProjectAnalyzer, SemanticProjectInput, SemanticProjectEvidence } from '../semantic';
import type { VectorDatabase } from '../vectordb/types';
import type { Embedding } from '../embedding';
import { buildSymbolRecordsForFile } from '../symbols/registry';
import { IndexingResourcePlanner } from '../indexing/resources';
import { createParallelLanguageAnalysisService } from '../language-analysis';

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


import type { RepositoryRelativePath } from '../paths/repository-path';

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

test('IndexingPipeline stops with limit_reached before aggregate searchable source bytes exceed the budget', async () => {
    const languageAnalyzer = createLanguageAnalysisService();
    const pipeline = new IndexingPipeline({
        getVectorDatabase: () => createMockVectorDb(),
        languageAnalyzer,
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
        getIndexedExtensionsForCodebase: () => ['.ts'],
        matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'extractor-v1',
    });

    let analyzedCount = 0;
    pipeline.analyzeIndexedFile = async (filePath): Promise<AnalyzedIndexedFile> => {
        analyzedCount += 1;
        return {
            relativePath: filePath as unknown as RepositoryRelativePath,
            source: '',
            sourceHash: `hash-${analyzedCount}`,
            sourceStat: {
                size: analyzedCount === 1
                    ? MAX_INDEXED_SOURCE_BYTES_PER_PUBLICATION
                    : 1,
                mtimeMs: 0,
                ctimeMs: 0,
            },
            language: 'typescript',
            structuralStatus: 'complete',
            chunks: [],
            extractedSymbols: [],
            moduleBindings: [],
            callSites: [],
            receiverTypeBindings: [],
            pythonFlowFacts: [],
        };
    };

    const result = await pipeline.processFileList({
        filePaths: ['first.ts', 'second.ts'],
        codebasePath: '/repo',
        collectionName: 'test_col',
    });

    assert.equal(analyzedCount, 2);
    assert.equal(result.status, 'limit_reached');
    assert.equal(result.processedFiles, 1);
    assert.deepEqual(result.sourceFiles.map((file) => file.path), ['first.ts']);
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
        languageAnalyzer: { ...local, concurrency: 16, analyze: input => { analyses++; return local.analyze(input); } },
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
    const analyzer = createLanguageAnalysisService();
    const pipeline = new IndexingPipeline({
        getVectorDatabase: createMockVectorDb, languageAnalyzer: analyzer,
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
    } finally { release(); await operation.catch(() => undefined); await analyzer.dispose?.(); }
});

for (const stop of ['analysis failure', 'cancellation', 'source byte limit'] as const) {
    test(`${stop} drains later read failures without replacing the first outcome`, async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const firstError = new Error(stop);
        if (stop === 'cancellation') firstError.name = 'AbortError';
        const analyzer = createLanguageAnalysisService();
        const pipeline = new IndexingPipeline({
            getVectorDatabase: createMockVectorDb, languageAnalyzer: analyzer,
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
                sourceStat: { size: stop === 'source byte limit' ? MAX_INDEXED_SOURCE_BYTES_PER_PUBLICATION + 1 : 1, mtimeMs: 0, ctimeMs: 0 },
                language: 'typescript', structuralStatus: 'complete', chunks: [], extractedSymbols: [],
                moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [],
            };
        };
        const operation = pipeline.processFileList({
            filePaths: ['a.ts', 'b.ts'], codebasePath: '/repo', collectionName: 'fixture',
            onFileProcessed: () => { if (stop === 'cancellation') throw firstError; },
        });
        const outcome = stop === 'source byte limit' ? operation : assert.rejects(operation, error => error === firstError);
        let settled = false;
        operation.then(() => { settled = true; }, () => { settled = true; });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(settled, false, 'returned while a later analysis read was in flight');
            release();
            await outcome;
            assert.equal(readFinished, true);
            if (stop === 'source byte limit') {
                const result = await operation;
                assert.equal(result.status, 'limit_reached');
                assert.equal(result.processedFiles, 0);
                assert.deepEqual(result.sourceFiles, []);
                await result.payloadSettled;
            }
        } finally { release(); await operation.catch(() => undefined); await analyzer.dispose?.(); }
    });
}
