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
        getIndexedExtensionsForCodebase: () => ['.go', '.ts', '.py'],
        matchesIgnorePattern: () => false,
        getSymbolExtractorVersion: () => 'extractor-v1',
    });



    const result = await pipeline.processFileList({
        filePaths: [],
        codebasePath: '/repo',
        collectionName: 'test_col',
    });

    assert.equal(result.processedFiles, 0);
    assert.equal('semanticSources' in result, false);
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

