import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    IndexGenerationWorkflow,
    type IndexGenerationWorkflowPorts,
} from './index-generation-workflow';
import { buildSymbolRegistry, SYMBOL_REGISTRY_SCHEMA_VERSION, type SymbolRecord, type SymbolRegistryManifestFile } from '../symbols';
import { DefaultSemanticLanguageRegistry } from '../semantic/descriptor';
import { WasmSemanticProjectAnalyzer } from '../semantic/wasm/wasm-analyzer';

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

test('IndexGenerationWorkflow delta rebuild: source-only delta triggers semantic reanalysis and updates relationships', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-semantic-delta-src-'));
    const stateRoot = path.join(tmpDir, '.satori-state');
    fs.mkdirSync(stateRoot, { recursive: true });

    try {
        const fileA = 'pkg/a.go';
        const fileB = 'pkg/b.go';
        fs.mkdirSync(path.join(tmpDir, 'pkg'), { recursive: true });

        const contentA1 = 'package pkg\n\nfunc Helper() int {\n\treturn 42\n}\n';
        const contentB1 = 'package pkg\n\nfunc Main() {\n\tHelper()\n}\n';

        fs.writeFileSync(path.join(tmpDir, fileA), contentA1, 'utf8');
        fs.writeFileSync(path.join(tmpDir, fileB), contentB1, 'utf8');

        const analyzer = new WasmSemanticProjectAnalyzer();
        let analyzeCallCount = 0;
        const trackingAnalyzer = {
            supportsLanguage: (lang: string) => analyzer.supportsLanguage(lang),
            analyze: async (input: Parameters<typeof analyzer.analyze>[0]) => {
                analyzeCallCount++;
                return analyzer.analyze(input);
            },
        };

        const manifestA1: SymbolRegistryManifestFile = {
            path: fileA,
            language: 'go',
            hash: sha256(contentA1),
            symbolCount: 1,
            definitionStatus: 'definitions_present',
        };
        const manifestB1: SymbolRegistryManifestFile = {
            path: fileB,
            language: 'go',
            hash: sha256(contentB1),
            symbolCount: 1,
            definitionStatus: 'definitions_present',
        };

        const symHelper1: SymbolRecord = {
            symbolKey: 'pkg/a.go#Helper',
            symbolInstanceId: 'inst-helper-1',
            name: 'Helper',
            label: 'Helper',
            qualifiedName: 'pkg.Helper',
            kind: 'function',
            file: fileA,
            language: 'go',
            span: { startByte: 13, endByte: 45, startLine: 3, endLine: 5, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: manifestA1.hash,
            extractorVersion: 'e-1',
        };
        const symMain1: SymbolRecord = {
            symbolKey: 'pkg/b.go#Main',
            symbolInstanceId: 'inst-main-1',
            name: 'Main',
            label: 'Main',
            qualifiedName: 'pkg.Main',
            kind: 'function',
            file: fileB,
            language: 'go',
            span: { startByte: 13, endByte: 39, startLine: 3, endLine: 5, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: manifestB1.hash,
            extractorVersion: 'e-1',
        };

        const initialRegistry = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: tmpDir,
                rootFingerprint: 'fp-1',
                indexPolicyHash: 'policy-1',
                languageRouterVersion: 'r-1',
                extractorVersion: 'e-1',
                relationshipVersion: 'rel-1',
                builtAt: new Date().toISOString(),
                files: [manifestA1, manifestB1],
            },
            symbols: [symHelper1, symMain1],
        });

        const mockPorts: Partial<IndexGenerationWorkflowPorts> = {
            canonicalizeCodebasePath: (p) => p,
            buildRootFingerprint: () => 'fp-1',
            buildIndexPolicyHash: () => 'policy-1',
            getLanguageRouterVersion: () => 'r-1',
            getSymbolExtractorVersion: () => 'e-1',
            getRelationshipVersion: () => 'rel-1',
            readIndexableFileInsideRoot: async (filePath) => fs.readFileSync(filePath, 'utf8'),
            languageAnalyzer: {
                analyze: async () => ({
                    moduleBindings: [],
                    callSites: [],
                    receiverTypeBindings: [],
                    pythonFlowFacts: [],
                }),
                supportedExtensions: ['.go'],
                canAnalyze: () => true,
            } as unknown as IndexGenerationWorkflowPorts['languageAnalyzer'],
            publishNavigationCandidate: async () => {},
            symbolRegistryStateRoot: stateRoot,
            semanticAnalyzer: trackingAnalyzer as unknown as IndexGenerationWorkflowPorts['semanticAnalyzer'],
            semanticLanguageRegistry: new DefaultSemanticLanguageRegistry(),
        };

        const workflow = new IndexGenerationWorkflow(mockPorts as IndexGenerationWorkflowPorts);
        const internals = workflow as unknown as {
            stageSymbolRegistryForCompletedIndex: (
                root: string,
                symbols: readonly SymbolRecord[],
                files: readonly SymbolRegistryManifestFile[],
                previousGenerationId?: string,
                options?: unknown,
                signal?: unknown,
                forceFull?: boolean,
                evidence?: unknown,
                sourceFiles?: readonly { path: string; source: string; sourceHash: string }[],
            ) => Promise<{ generationId: string } | null>;
            rebuildNavigationArtifactsForSyncDelta: (
                root: string,
                registry: unknown,
                changedRelativePaths: readonly string[],
                rebuiltSymbols: readonly SymbolRecord[],
                rebuiltManifestFiles: readonly SymbolRegistryManifestFile[],
                options?: unknown,
                evidence?: unknown,
                signal?: unknown,
                previousGenerationId?: string,
                forceFull?: boolean,
                sidecars?: unknown,
            ) => Promise<{ candidate: unknown }>;
        };

        // 1. Initial full navigation generation
        const initialGeneration = await internals.stageSymbolRegistryForCompletedIndex(
            tmpDir,
            initialRegistry.symbols,
            initialRegistry.manifest.files,
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            [
                { path: fileA, source: contentA1, sourceHash: manifestA1.hash },
                { path: fileB, source: contentB1, sourceHash: manifestB1.hash },
            ],
        );
        assert.ok(initialGeneration);
        assert.equal(analyzeCallCount, 1);

        // 2. Modify Helper in a.go (source-only change)
        const contentA2 = 'package pkg\n\nfunc Helper() int {\n\t// Updated body\n\treturn 100\n}\n';
        fs.writeFileSync(path.join(tmpDir, fileA), contentA2, 'utf8');

        const manifestA2: SymbolRegistryManifestFile = {
            path: fileA,
            language: 'go',
            hash: sha256(contentA2),
            symbolCount: 1,
            definitionStatus: 'definitions_present',
        };
        const symHelper2: SymbolRecord = {
            symbolKey: 'pkg/a.go#Helper',
            symbolInstanceId: 'inst-helper-2',
            name: 'Helper',
            label: 'Helper',
            qualifiedName: 'pkg.Helper',
            kind: 'function',
            file: fileA,
            language: 'go',
            span: { startByte: 13, endByte: 65, startLine: 3, endLine: 6, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: manifestA2.hash,
            extractorVersion: 'e-1',
        };

        // 3. Rebuild navigation artifacts for sync delta
        const deltaResult = await internals.rebuildNavigationArtifactsForSyncDelta(
            tmpDir,
            initialRegistry,
            [fileA],
            [symHelper2],
            [manifestA2],
            undefined,
            new Map([[fileA, { moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [] }]]),
            undefined,
            initialGeneration.generationId,
            false,
            {
                canonicalRoot: tmpDir,
                generationId: initialGeneration.generationId,
                records: [
                    {
                        sourceKey: symMain1.symbolKey,
                        sourceInstanceId: symMain1.symbolInstanceId,
                        targetKey: symHelper1.symbolKey,
                        targetInstanceId: symHelper1.symbolInstanceId,
                        type: 'CALLS',
                        file: fileB,
                        span: { startByte: 28, endByte: 36, startLine: 4, endLine: 4, startColumn: 1, endColumn: 9 },
                        confidence: 'high',
                        resolutionAuthority: 'direct_binding',
                    },
                ],
                analysisByFile: new Map([
                    [fileA, { moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [] }],
                    [fileB, { moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [] }],
                ]),
            },
        );

        assert.ok(deltaResult.candidate);
        // Semantic analysis was triggered for the affected Go project
        assert.equal(analyzeCallCount, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('IndexGenerationWorkflow delta rebuild: auxiliary-only delta (go.mod) triggers semantic reanalysis without vector payload churn', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-semantic-delta-aux-'));
    const stateRoot = path.join(tmpDir, '.satori-state');
    fs.mkdirSync(stateRoot, { recursive: true });

    try {
        const fileA = 'main.go';
        const auxMod = 'go.mod';

        const contentA = 'package main\n\nfunc main() {\n\tprintln("hello")\n}\n';
        const contentMod1 = 'module example.com/app\n\ngo 1.21\n';

        fs.writeFileSync(path.join(tmpDir, fileA), contentA, 'utf8');
        fs.writeFileSync(path.join(tmpDir, auxMod), contentMod1, 'utf8');

        const analyzer = new WasmSemanticProjectAnalyzer();
        let analyzeCallCount = 0;
        let lastAuxiliaryFiles: string[] = [];

        const trackingAnalyzer = {
            supportsLanguage: (lang: string) => analyzer.supportsLanguage(lang),
            analyze: async (input: Parameters<typeof analyzer.analyze>[0]) => {
                analyzeCallCount++;
                lastAuxiliaryFiles = (input.auxiliaryFiles ?? []).map((f) => f.path);
                return analyzer.analyze(input);
            },
        };

        const manifestA: SymbolRegistryManifestFile = {
            path: fileA,
            language: 'go',
            hash: sha256(contentA),
            symbolCount: 1,
            definitionStatus: 'definitions_present',
        };

        const symMain: SymbolRecord = {
            symbolKey: 'main.go#main',
            symbolInstanceId: 'inst-main',
            name: 'main',
            label: 'main',
            qualifiedName: 'main.main',
            kind: 'function',
            file: fileA,
            language: 'go',
            span: { startByte: 14, endByte: 49, startLine: 3, endLine: 5, startColumn: 0, endColumn: 1 },
            parentQualifiedNamePath: [],
            fileHash: manifestA.hash,
            extractorVersion: 'e-1',
        };

        // Notice: go.mod is NOT in the symbol registry manifest or symbols! (Not an indexed document)
        const initialRegistry = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: tmpDir,
                rootFingerprint: 'fp-1',
                indexPolicyHash: 'policy-1',
                languageRouterVersion: 'r-1',
                extractorVersion: 'e-1',
                relationshipVersion: 'rel-1',
                builtAt: new Date().toISOString(),
                files: [manifestA],
            },
            symbols: [symMain],
        });

        const mockPorts: Partial<IndexGenerationWorkflowPorts> = {
            canonicalizeCodebasePath: (p) => p,
            buildRootFingerprint: () => 'fp-1',
            buildIndexPolicyHash: () => 'policy-1',
            getLanguageRouterVersion: () => 'r-1',
            getSymbolExtractorVersion: () => 'e-1',
            getRelationshipVersion: () => 'rel-1',
            readIndexableFileInsideRoot: async (filePath) => fs.readFileSync(filePath, 'utf8'),
            languageAnalyzer: {
                analyze: async () => ({
                    moduleBindings: [],
                    callSites: [],
                    receiverTypeBindings: [],
                    pythonFlowFacts: [],
                }),
                supportedExtensions: ['.go'],
                canAnalyze: () => true,
            } as unknown as IndexGenerationWorkflowPorts['languageAnalyzer'],
            publishNavigationCandidate: async () => {},
            symbolRegistryStateRoot: stateRoot,
            semanticAnalyzer: trackingAnalyzer as unknown as IndexGenerationWorkflowPorts['semanticAnalyzer'],
            semanticLanguageRegistry: new DefaultSemanticLanguageRegistry(),
        };

        const workflow = new IndexGenerationWorkflow(mockPorts as IndexGenerationWorkflowPorts);
        const internals = workflow as unknown as {
            stageSymbolRegistryForCompletedIndex: (
                root: string,
                symbols: readonly SymbolRecord[],
                files: readonly SymbolRegistryManifestFile[],
                previousGenerationId?: string,
                options?: unknown,
                signal?: unknown,
                forceFull?: boolean,
                evidence?: unknown,
                sourceFiles?: readonly { path: string; source: string; sourceHash: string }[],
            ) => Promise<{ generationId: string } | null>;
            rebuildNavigationArtifactsForSyncDelta: (
                root: string,
                registry: unknown,
                changedRelativePaths: readonly string[],
                rebuiltSymbols: readonly SymbolRecord[],
                rebuiltManifestFiles: readonly SymbolRegistryManifestFile[],
                options?: unknown,
                evidence?: unknown,
                signal?: unknown,
                previousGenerationId?: string,
                forceFull?: boolean,
                sidecars?: unknown,
            ) => Promise<{ candidate: unknown }>;
        };

        // 1. Initial navigation build observes auxiliary go.mod
        const initialGeneration = await internals.stageSymbolRegistryForCompletedIndex(
            tmpDir,
            initialRegistry.symbols,
            initialRegistry.manifest.files,
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            [{ path: fileA, source: contentA, sourceHash: manifestA.hash }],
        );
        assert.ok(initialGeneration);
        assert.equal(analyzeCallCount, 1);
        assert.deepEqual(lastAuxiliaryFiles, ['go.mod']);

        // 2. Modify go.mod (auxiliary-only change, 0 source files modified)
        const contentMod2 = 'module example.com/app\n\ngo 1.22\n';
        fs.writeFileSync(path.join(tmpDir, auxMod), contentMod2, 'utf8');

        // 3. Reindex delta where only go.mod is reported in changedRelativePaths
        // (rebuiltSymbolRecords is empty, rebuiltManifestFiles is empty)
        const deltaResult = await internals.rebuildNavigationArtifactsForSyncDelta(
            tmpDir,
            initialRegistry,
            [auxMod],
            [],
            [],
            undefined,
            undefined,
            undefined,
            initialGeneration.generationId,
            false,
            {
                canonicalRoot: tmpDir,
                generationId: initialGeneration.generationId,
                records: [],
                analysisByFile: new Map([
                    [fileA, { moduleBindings: [], callSites: [], receiverTypeBindings: [], pythonFlowFacts: [] }],
                ]),
            },
        );

        assert.ok(deltaResult.candidate);
        // Semantic reanalysis was triggered for Go due to go.mod auxiliary change
        assert.equal(analyzeCallCount, 2);
        assert.deepEqual(lastAuxiliaryFiles, ['go.mod']);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

import ignore from 'ignore';
import { scanSynchronizerState } from '../sync/sync-scan';
import { isIndexableFileByPolicy, isObservableFileByPolicy } from '../config/index-policy';

test('Synchronizer observes and hashes semantic auxiliaries while vector indexing policy excludes them', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-aux-'));
    try {
        const goSrc = 'pkg/app.go';
        const goMod = 'go.mod';
        fs.mkdirSync(path.join(tmpDir, 'pkg'), { recursive: true });

        const srcContent = 'package pkg\n\nfunc Run() {}\n';
        const modContent = 'module example.com/app\n\ngo 1.22\n';

        fs.writeFileSync(path.join(tmpDir, goSrc), srcContent, 'utf8');
        fs.writeFileSync(path.join(tmpDir, goMod), modContent, 'utf8');

        // 1. Synchronizer scan should observe both .go and go.mod
        const scanOutput = await scanSynchronizerState({
            rootDir: tmpDir,
            ignoreMatcher: ignore(),
            supportedExtensions: ['.go'],
            forceFullHash: true,
            hashConcurrency: 4,
            previousHashes: new Map(),
            previousStats: new Map(),
        });

        assert.equal(scanOutput.fileHashes.has(goSrc), true);
        assert.equal(scanOutput.fileHashes.has(goMod), true);
        assert.equal(scanOutput.fileHashes.get(goMod), sha256(modContent));

        // 2. Vector indexing policy rejects go.mod from chunking / vector DB
        const modStat = fs.statSync(path.join(tmpDir, goMod));
        const srcStat = fs.statSync(path.join(tmpDir, goSrc));

        const isSrcIndexable = await isIndexableFileByPolicy(goSrc, path.join(tmpDir, goSrc), srcStat.size, ['.go']);
        const isModIndexable = await isIndexableFileByPolicy(goMod, path.join(tmpDir, goMod), modStat.size, ['.go']);

        assert.equal(isSrcIndexable, true);
        assert.equal(isModIndexable, false);

        // 3. Observable policy accepts both
        const isSrcObservable = await isObservableFileByPolicy(goSrc, path.join(tmpDir, goSrc), srcStat.size, ['.go']);
        const isModObservable = await isObservableFileByPolicy(goMod, path.join(tmpDir, goMod), modStat.size, ['.go']);

        assert.equal(isSrcObservable, true);
        assert.equal(isModObservable, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('WasmSemanticProjectAnalyzer resolves Go calls with module-bound unique package identities across directories', async () => {
    const analyzer = new WasmSemanticProjectAnalyzer();
    const result = await analyzer.analyze({
        language: 'go',
        sourceFiles: [
            {
                path: 'main.go',
                source: `package main

import (
	"example.com/app/pkg/auth"
	"example.com/app/pkg/api"
)

func Run() {
	auth.Login()
	api.Login()
}
`,
                sourceHash: 'hash-main',
            },
            {
                path: 'pkg/auth/login.go',
                source: `package auth

func Login() bool {
	return true
}
`,
                sourceHash: 'hash-auth',
            },
            {
                path: 'pkg/api/login.go',
                source: `package api

func Login() string {
	return "ok"
}
`,
                sourceHash: 'hash-api',
            },
        ],
        auxiliaryFiles: [
            {
                path: 'go.mod',
                role: 'manifest',
                source: 'module example.com/app\n\ngo 1.22\n',
                sourceHash: 'hash-mod',
            },
        ],
    });

    assert.equal(result.language, 'go');
    const mainOccurrences = result.occurrencesByFile.get('main.go') ?? [];
    assert.equal(mainOccurrences.length, 2);

    const authCall = mainOccurrences.find((r) => r.targetProvenance?.name === 'Login' && r.targetProvenance?.file === 'pkg/auth/login.go');
    const apiCall = mainOccurrences.find((r) => r.targetProvenance?.name === 'Login' && r.targetProvenance?.file === 'pkg/api/login.go');

    assert.ok(authCall, 'Should resolve call to pkg/auth/login.go');
    assert.ok(apiCall, 'Should resolve call to pkg/api/login.go');
    assert.equal(authCall.decision, 'resolved');
    assert.equal(apiCall.decision, 'resolved');
    assert.equal(authCall.sourceFile, 'main.go');
    assert.equal(apiCall.sourceFile, 'main.go');
});
