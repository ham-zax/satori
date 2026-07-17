import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import { SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES } from './search-constants.js';
import { createLocalOnlyContext } from '../server/provider-runtime.js';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
    resolveNavigationSidecarRoot,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
    COLLECTION_LIMIT_MESSAGE,
} from '@zokizuan/satori-core';
import type { SymbolRecord, SymbolRegistryManifest } from '@zokizuan/satori-core';

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type HandlerCallGraphManager = NonNullable<ConstructorParameters<typeof ToolHandlers>[6]>;
type HandlerReranker = NonNullable<ConstructorParameters<typeof ToolHandlers>[7]>;
type SearchFixtureResult = {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    indexedAt: string;
    symbolId?: string;
    symbolLabel?: string;
    symbolKey?: string;
    symbolInstanceId?: string;
    symbolKind?: string;
    ownerSymbolKey?: string;
    ownerSymbolInstanceId?: string;
    breadcrumbs?: string[];
    backendScore?: number;
    backendScoreKind?: string;
};
type SidecarNodeFixture = {
    symbolId: string;
    symbolLabel?: string;
    file: string;
    language: string;
    span: { startLine: number; endLine: number };
};
type SemanticSearchRequestView = {
    codebasePath?: string;
    query?: string;
    topK?: number;
    retrievalMode?: string;
    scorePolicy?: unknown;
};
type ParsedSemanticSearchInvocation = {
    root: string;
    query: string;
    topK: number;
    request: SemanticSearchRequestView | null;
};
type SearchPayloadResultView = {
    file?: string;
    target?: {
        file: string;
        span: { startLine: number; endLine: number };
        symbolId?: string;
    };
    symbolId?: string;
    symbolInstanceId?: string;
    symbolLabel?: string;
    displayLabel?: string;
    debug?: {
        lexicalScore?: number;
        exactLexicalMatch?: boolean;
        changedFilesMultiplier?: number;
        provenance?: {
            retrievalPasses?: string[];
            exactMatchPinned?: boolean;
            semanticCandidate?: boolean;
            lexicalCandidate?: boolean;
        };
    };
};
type ChangedFilesState = { available: boolean; files: Set<string> };
type ChangedFilesCacheEntry = ChangedFilesState & { expiresAtMs: number };
type SearchFreshnessDecisionPayload = {
    status: string;
    reason?: string;
    message: string;
    hints?: {
        reindex?: { tool?: string; args?: { action?: string } };
        [key: string]: unknown;
    };
    recommendedNextAction?: { tool?: string; args?: { action?: string } };
    results: SearchPayloadResultView[];
};
type DebugProjectionPayload = {
    hints?: {
        debugSummary?: unknown;
        debugSearch?: Record<string, unknown>;
    };
    results?: Array<{ debug?: Record<string, unknown> }>;
};
type MutableHandlerContext = HandlerContext & {
    semanticSearch: (...args: unknown[]) => Promise<SearchFixtureResult[]> | SearchFixtureResult[];
    getTrackedRelativePaths?: () => string[];
    getActiveIgnorePatterns?: () => string[];
    recreateSynchronizerForCodebase?: (repoPath: string) => Promise<void> | void;
};
type SortableGroupedSearchResult = {
    file: string;
    debug?: {
        provenance?: {
            exactMatchPinned?: boolean;
        };
    };
    [key: string]: unknown;
};
type ToolHandlersTestOverrides = {
    context: MutableHandlerContext;
    syncManager: HandlerSyncManager;
    getChangedFilesForCodebase: (repoPath: string) => ChangedFilesState;
    parseGitStatusChangedPaths: (status: string) => Set<string>;
    changedFilesCache: Map<string, ChangedFilesCacheEntry>;
    validateCompletionProof: () => Promise<{
        outcome: string;
        reason?: string;
        navigationStatus?: string;
        generationReceipt?: unknown;
    }>;
    probeLocalSearchCollectionState: (codebasePath: string) => Promise<{ state: string; collectionName?: string }>;
    sortGroupedSearchResults: (grouped: SortableGroupedSearchResult[], debug: boolean) => boolean;
};

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    embeddingArtifactDigest: null,
    embeddingNormalizationPolicy: 'provider_output_v1',
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3',
    parserVersion: 'parser-v1',
    extractorVersion: 'extractor-v1',
    relationshipVersion: 'relationships-v1',
    embeddingProjectionVersion: 'embedding-projection-v1',
    lexicalProjectionVersion: 'lexical-projection-v1',
};

const DENSE_RUNTIME_FINGERPRINT: IndexFingerprint = {
    ...RUNTIME_FINGERPRINT,
    schemaVersion: 'dense_v3'
};

const CAPABILITIES_NO_RERANK = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
    executionProfile: 'connected',
    networkPolicy: { kind: 'remote-allowed' },
    vectorStoreProvider: 'Milvus',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

function warningCodes(payload: { warnings?: Array<string | { code?: string }> }): string[] {
    return (payload.warnings || [])
        .map((warning) => typeof warning === 'string' ? warning : warning.code)
        .filter((code): code is string => typeof code === 'string');
}

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-handlers-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(vars)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        await fn();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function withTempStateRoot<T>(fn: (stateRoot: string) => Promise<T>): Promise<T> {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-state-'));
    process.env.SATORI_STATE_ROOT = stateRoot;
    try {
        return await fn(stateRoot);
    } finally {
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

async function writeSearchSymbolRegistry(input: {
    repoPath: string;
    relativePath: string;
    content: string;
    language?: string;
    chunks: Array<{
        content: string;
        startLine: number;
        endLine: number;
        symbolLabel?: string;
        breadcrumbs?: string[];
    }>;
    extractedSymbols?: Parameters<typeof buildSymbolRecordsForFile>[0]['extractedSymbols'];
}) {
    const fileHash = crypto.createHash('sha256').update(input.content, 'utf8').digest('hex');
    const language = input.language || 'typescript';
    const symbols = buildSymbolRecordsForFile({
        relativePath: input.relativePath,
        language,
        content: input.content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
        chunks: input.chunks.map((chunk) => ({
            content: chunk.content,
            metadata: {
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language,
                filePath: input.relativePath,
                ...(chunk.symbolLabel ? { symbolLabel: chunk.symbolLabel } : {}),
                ...(chunk.breadcrumbs ? { breadcrumbs: chunk.breadcrumbs } : {}),
            },
        })),
        extractedSymbols: input.extractedSymbols,
    });
    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: input.repoPath,
        rootFingerprint: 'test-root-fingerprint',
        indexPolicyHash: 'test-policy',
        languageRouterVersion: 'test-router-v1',
        extractorVersion: 'test-extractor-v1',
        relationshipVersion: 'test-relationships-v1',
        builtAt: '2026-01-01T00:00:00.000Z',
        files: [{
            path: input.relativePath,
            hash: fileHash,
            language,
            symbolCount: symbols.length,
        }],
    };

    const result = await writeSymbolRegistrySidecar({
        registry: buildSymbolRegistry({ manifest, symbols }),
    });
    await writeRelationshipSidecar({
        normalizedRootPath: input.repoPath,
        symbolRegistryManifestHash: result.manifestHash,
        relationshipVersion: manifest.relationshipVersion,
        builtAt: manifest.builtAt,
        files: manifest.files,
        records: [],
        analysisByFile: new Map([[input.relativePath, {
            moduleBindings: [],
            callSites: [],
        }]]),
    });

    return symbols;
}

async function writeSearchSymbolRegistryForFiles(input: {
    repoPath: string;
    files: Array<{
        relativePath: string;
        content: string;
        language?: string;
        chunks: Array<{
            content: string;
            startLine: number;
            endLine: number;
            symbolLabel?: string;
            breadcrumbs?: string[];
        }>;
        extractedSymbols?: Parameters<typeof buildSymbolRecordsForFile>[0]['extractedSymbols'];
    }>;
    relationships?: (
        symbols: SymbolRecord[],
    ) => Parameters<typeof writeRelationshipSidecar>[0]['records'];
}) {
    const allSymbols: SymbolRecord[] = [];
    const manifestFiles: SymbolRegistryManifest['files'] = [];
    for (const file of input.files) {
        const fileHash = crypto.createHash('sha256').update(file.content, 'utf8').digest('hex');
        const language = file.language || 'typescript';
        const symbols = buildSymbolRecordsForFile({
            relativePath: file.relativePath,
            language,
            content: file.content,
            fileHash,
            extractorVersion: 'test-extractor-v1',
            chunks: file.chunks.map((chunk) => ({
                content: chunk.content,
                metadata: {
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    language,
                    filePath: file.relativePath,
                    ...(chunk.symbolLabel ? { symbolLabel: chunk.symbolLabel } : {}),
                    ...(chunk.breadcrumbs ? { breadcrumbs: chunk.breadcrumbs } : {}),
                },
            })),
            extractedSymbols: file.extractedSymbols,
        });
        allSymbols.push(...symbols);
        manifestFiles.push({
            path: file.relativePath,
            hash: fileHash,
            language,
            symbolCount: symbols.length,
        });
    }

    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: input.repoPath,
        rootFingerprint: 'test-root-fingerprint',
        indexPolicyHash: 'test-policy',
        languageRouterVersion: 'test-router-v1',
        extractorVersion: 'test-extractor-v1',
        relationshipVersion: 'test-relationships-v1',
        builtAt: '2026-01-01T00:00:00.000Z',
        files: manifestFiles,
    };

    const result = await writeSymbolRegistrySidecar({
        registry: buildSymbolRegistry({ manifest, symbols: allSymbols }),
    });
    await writeRelationshipSidecar({
        normalizedRootPath: input.repoPath,
        symbolRegistryManifestHash: result.manifestHash,
        relationshipVersion: manifest.relationshipVersion,
        builtAt: manifest.builtAt,
        files: manifest.files,
        records: input.relationships?.(allSymbols) ?? [],
        analysisByFile: new Map(manifest.files.map((file) => [file.path, {
            moduleBindings: [],
            callSites: [],
        }])),
    });

    return allSymbols;
}

async function writeCallerSearchFixture(
    repoPath: string,
    options?: { includeRelationship?: boolean },
) {
    const targetPath = 'src/checkpoints/checkpoint-store.ts';
    const callerPath = 'src/checkpoints/checkpoint-service.ts';
    const targetContent = [
        'export function writeSourceCheckpoint() {',
        '  return "saved";',
        '}',
    ].join('\n');
    const callerContent = [
        'import { writeSourceCheckpoint } from "./checkpoint-store";',
        '',
        'export function refreshCheckpoint() {',
        '  return writeSourceCheckpoint();',
        '}',
    ].join('\n');
    fs.mkdirSync(path.join(repoPath, 'src/checkpoints'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, targetPath), targetContent, 'utf8');
    fs.writeFileSync(path.join(repoPath, callerPath), callerContent, 'utf8');
    const symbols = await writeSearchSymbolRegistryForFiles({
        repoPath,
        files: [{
            relativePath: targetPath,
            content: targetContent,
            chunks: [{
                content: targetContent,
                startLine: 1,
                endLine: 3,
                symbolLabel: 'function writeSourceCheckpoint()',
            }],
        }, {
            relativePath: callerPath,
            content: callerContent,
            chunks: [{
                content: callerContent.split('\n').slice(2).join('\n'),
                startLine: 3,
                endLine: 5,
                symbolLabel: 'function refreshCheckpoint()',
            }],
        }],
        relationships: options?.includeRelationship === false
            ? undefined
            : (records) => {
                const target = records.find((symbol) => symbol.name === 'writeSourceCheckpoint');
                const caller = records.find((symbol) => symbol.name === 'refreshCheckpoint');
                assert.ok(target);
                assert.ok(caller);
                return [{
                    sourceKey: caller.symbolKey,
                    sourceInstanceId: caller.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    type: 'CALLS',
                    file: caller.file,
                    span: { startLine: 4, endLine: 4 },
                    confidence: 'high',
                }];
            },
    });
    const target = symbols.find((symbol) => symbol.name === 'writeSourceCheckpoint');
    const caller = symbols.find((symbol) => symbol.name === 'refreshCheckpoint');
    assert.ok(target);
    assert.ok(caller);
    return { targetPath, callerPath, target, caller };
}

async function writeSearchRelationshipSidecar(input: {
    repoPath: string;
    relativePath: string;
    fileHash: string;
    language: string;
    symbolCount: number;
    symbolRegistryManifestHash: string;
    records: Parameters<typeof writeRelationshipSidecar>[0]['records'];
}) {
    await writeRelationshipSidecar({
        normalizedRootPath: input.repoPath,
        symbolRegistryManifestHash: input.symbolRegistryManifestHash,
        relationshipVersion: 'test-relationships-v1',
        builtAt: '2026-01-01T00:00:00.000Z',
        files: [{
            path: input.relativePath,
            hash: input.fileHash,
            language: input.language,
            symbolCount: input.symbolCount,
        }],
        records: input.records,
        analysisByFile: new Map([[input.relativePath, {
            moduleBindings: [],
            callSites: [],
        }]]),
    });
}

async function writeSearchNavigationSidecars(input: {
    repoPath: string;
    relativePath: string;
    content: string;
    language?: string;
    chunks: Array<{
        content: string;
        startLine: number;
        endLine: number;
        symbolLabel?: string;
        breadcrumbs?: string[];
    }>;
    extractedSymbols?: Parameters<typeof buildSymbolRecordsForFile>[0]['extractedSymbols'];
}) {
    const fileHash = 'test-search-file-hash';
    const language = input.language || 'typescript';
    const symbols = buildSymbolRecordsForFile({
        relativePath: input.relativePath,
        language,
        content: input.content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
        chunks: input.chunks.map((chunk) => ({
            content: chunk.content,
            metadata: {
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language,
                filePath: input.relativePath,
                ...(chunk.symbolLabel ? { symbolLabel: chunk.symbolLabel } : {}),
                ...(chunk.breadcrumbs ? { breadcrumbs: chunk.breadcrumbs } : {}),
            },
        })),
        extractedSymbols: input.extractedSymbols,
    });
    const manifest: SymbolRegistryManifest = {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: input.repoPath,
        rootFingerprint: 'test-root-fingerprint',
        indexPolicyHash: 'test-policy',
        languageRouterVersion: 'test-router-v1',
        extractorVersion: 'test-extractor-v1',
        relationshipVersion: 'test-relationships-v1',
        builtAt: '2026-01-01T00:00:00.000Z',
        files: [{
            path: input.relativePath,
            hash: fileHash,
            language,
            symbolCount: symbols.length,
        }],
    };
    const registry = buildSymbolRegistry({ manifest, symbols });
    const result = await writeSymbolRegistrySidecar({ registry });
    await writeSearchRelationshipSidecar({
        repoPath: input.repoPath,
        relativePath: input.relativePath,
        fileHash,
        language,
        symbolCount: symbols.length,
        symbolRegistryManifestHash: result.manifestHash,
        records: [],
    });
    return { symbols, manifestHash: result.manifestHash };
}

function createHandlers(
    repoPath: string,
    searchResults: SearchFixtureResult[],
    reranker?: HandlerReranker,
    options?: {
        gitignoreForceReloadEveryN?: number;
        sidecarReady?: boolean;
        sidecarNodes?: SidecarNodeFixture[];
        sidecarBuiltAt?: string;
    }
) {
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        semanticSearch: async () => searchResults,
        semanticSearchInProvenGeneration: async () => searchResults,
    } as unknown as HandlerContext;

    const snapshotManager = {
        getAllCodebases: () => [],
        getIndexedCodebases: () => [repoPath],
        getIndexingCodebases: () => [],
        getCodebaseCallGraphSidecar: () => options?.sidecarReady === false ? undefined : ({ version: 'v3' }),
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
    } as unknown as HandlerSnapshotManager;

    const syncManager = {
        ensureFreshness: async () => ({
            mode: 'skipped_recent',
            checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            thresholdMs: 180000
        })
    } as unknown as HandlerSyncManager;

    const capabilities = new CapabilityResolver({
        name: 'test',
        version: '0.0.0',
        executionProfile: 'connected',
        networkPolicy: { kind: 'remote-allowed' },
        vectorStoreProvider: 'Milvus',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        ...(reranker ? { voyageKey: 'test' } : {}),
    });

    const sidecarNodes = options?.sidecarNodes ?? searchResults
        .filter((result) => typeof result.symbolId === 'string')
        .map((result) => ({
            symbolId: result.symbolId,
            symbolLabel: result.symbolLabel,
            file: result.relativePath,
            language: result.language || 'typescript',
            span: {
                startLine: result.startLine || 1,
                endLine: result.endLine || result.startLine || 1
            }
        }));
    const callGraphManager = {
        loadSidecar: () => options?.sidecarReady === false
            ? null
            : ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: options?.sidecarBuiltAt || '2026-01-01T00:45:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: sidecarNodes,
                edges: [],
                notes: []
            })
    } as unknown as HandlerCallGraphManager;

    const handlers = new ToolHandlers(
        context,
        snapshotManager,
        syncManager,
        RUNTIME_FINGERPRINT,
        capabilities,
        () => Date.parse('2026-01-01T01:00:00.000Z'),
        callGraphManager,
        reranker || null,
        options?.gitignoreForceReloadEveryN
    );
    (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({
        outcome: 'valid',
        navigationStatus: 'valid',
        generationReceipt: {
            navigation: { navigationSealHash: 'a'.repeat(64) },
        },
    });
    return handlers;
}

test('handleSearchCode falls back from structural ownership when completion proof omits navigation evidence', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/legacy.ts';
            const content = 'export function orphanedRegistryOwner() { return true; }\n';
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                chunks: [{
                    content: content.trim(),
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function orphanedRegistryOwner()',
                    breadcrumbs: ['function orphanedRegistryOwner()'],
                }],
            });
            const handlers = createHandlers(repoPath, [{
                content: 'return true;',
                relativePath,
                startLine: 1,
                endLine: 1,
                language: 'typescript',
                score: 0.99,
            }]);
            (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({
                outcome: 'valid',
            });

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'who owns orphanedRegistryOwner',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'ranking',
            });
            const payload = JSON.parse(response.content[0]?.text || '{}');

            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0]?.target?.symbolId, undefined);
            assert.notEqual(payload.hints?.debugSearch?.exactRegistry?.status, 'hit');
            assert.ok(payload.warnings?.some(
                (warning: { code?: string }) => warning.code === 'NAVIGATION_REPAIR_REQUIRED',
            ));
            const repairWarning = payload.warnings?.find(
                (warning: { code?: string }) => warning.code === 'NAVIGATION_REPAIR_REQUIRED',
            );
            assert.match(repairWarning?.action ?? '', /^Run manage_index repair/i);
        });
    });
});

test('canonical not_bound navigation stays vector-readable without repair guidance', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const handlers = createHandlers(repoPath, [{
                content: 'return session.isValid();',
                relativePath: 'src/auth.ts',
                startLine: 3,
                endLine: 6,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
            }]);
            (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({
                outcome: 'valid',
                navigationStatus: 'not_bound',
            });

            const searchResponse = await handlers.handleSearchCode({
                path: repoPath,
                query: 'validate session',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
            });
            const searchPayload = JSON.parse(searchResponse.content[0]?.text || '{}');
            const statusResponse = await handlers.handleGetIndexingStatus({ path: repoPath });
            const statusPayload = JSON.parse(statusResponse.content[0]?.text || '{}');

            assert.equal(searchPayload.status, 'ok');
            assert.ok(!warningCodes(searchPayload).includes('NAVIGATION_REPAIR_REQUIRED'));
            assert.ok(!warningCodes(statusPayload).includes('NAVIGATION_REPAIR_REQUIRED'));
            assert.doesNotMatch(statusPayload.humanText ?? '', /navigation requires manage_index repair/i);
        });
    });
});

function parseSemanticSearchInvocation(args: unknown[]): ParsedSemanticSearchInvocation {
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const request = args[0] as SemanticSearchRequestView;
        return {
            root: request.codebasePath ?? '',
            query: request.query ?? '',
            topK: request.topK ?? 5,
            request
        };
    }

    const root = typeof args[0] === 'string' ? args[0] : '';
    const query = typeof args[1] === 'string' ? args[1] : '';
    const topK = typeof args[2] === 'number' ? args[2] : 5;
    return {
        root,
        query,
        topK,
        request: null
    };
}

function assertClosedDebugProjection(
    payload: DebugProjectionPayload,
    mode: 'none' | 'summary' | 'ranking' | 'freshness' | 'full',
): void {
    const hints = payload.hints;
    const resultDebug = payload.results?.[0]?.debug;
    if (mode === 'none') {
        assert.equal(hints?.debugSummary, undefined);
        assert.equal(hints?.debugSearch, undefined);
        assert.equal(resultDebug, undefined);
        return;
    }
    assert.ok(hints?.debugSummary);
    if (mode === 'summary') {
        assert.equal(hints?.debugSearch, undefined);
        assert.equal(resultDebug, undefined);
        return;
    }
    assert.ok(hints?.debugSearch);
    if (mode === 'ranking') {
        assert.equal(hints.debugSearch.phaseTimingsMs, undefined);
        assert.equal(hints.debugSearch.readiness, undefined);
        assert.equal(hints.debugSearch.changedCode, undefined);
        assert.ok(resultDebug);
        assert.equal(resultDebug.freshness, undefined);
        assert.equal(resultDebug.graphEvidence, undefined);
        return;
    }
    if (mode === 'freshness') {
        assert.ok(hints.debugSearch.phaseTimingsMs);
        assert.ok(hints.debugSearch.readiness);
        assert.equal(hints.debugSearch.queryIntent, undefined);
        assert.equal(hints.debugSearch.rankingProvenance, undefined);
        assert.equal(resultDebug, undefined);
        return;
    }
    assert.ok(hints.debugSearch.phaseTimingsMs);
    assert.ok(hints.debugSearch.readiness);
    assert.ok(hints.debugSearch.queryIntent);
    assert.ok(resultDebug);
}

test('handleSearchCode semantic path publishes closed debug projections for every mode', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_auth_validate',
            symbolLabel: 'method validateSession(token: string)',
            breadcrumbs: ['class SessionManager', 'method validateSession(token: string)'],
        }]);
        for (const mode of ['none', 'summary', 'ranking', 'freshness', 'full'] as const) {
            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'where is session validation handled',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                ...(mode === 'none' ? {} : { debugMode: mode }),
            });
            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assertClosedDebugProjection(payload, mode);
        }
    });
});

test('handleSearchCode reports warm proof reuse and forces a cold recount after absolute proof expiry', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
        }]);
        const vectorReceipt = { collectionName: 'committed-v3' } as never;
        let nowMs = 0;
        let navigationAuthority = 'navigation-1';
        const observation = JSON.stringify({
            vectorAuthority: 'vector-1',
            navigationAuthority: 'navigation-1',
            freshnessEpoch: 1,
            mutationGeneration: 1,
        });
        const internals = handlers as unknown as {
            now: () => number;
            context: HandlerContext & {
                getIndexAuthorityObservations: () => { vector: string; navigation: string };
                revalidatePreparedGeneration: () => Promise<{
                    vectorReceipt: never;
                    navigationProof: { status: 'not_bound' };
                }>;
            };
            syncManager: HandlerSyncManager & {
                getPreparedReadObservation: () => {
                    available: false;
                    reason: 'watcher_manager_not_started';
                    freshnessEpoch: number;
                };
            };
            mutationLeaseCoordinator: {
                observe: () => { mutationActive: boolean; generation: number };
                getActiveLease: () => null;
            };
            preparedReadCache: {
                seed: (root: string, state: unknown, authority: string, now: number) => void;
            };
            validateCompletionProof: () => Promise<{
                outcome: 'valid';
                navigationStatus: 'not_bound';
                vectorReceipt: never;
            }>;
        };
        internals.now = () => nowMs;
        internals.context.getIndexAuthorityObservations = () => ({
            vector: 'vector-1',
            navigation: navigationAuthority,
        });
        internals.context.revalidatePreparedGeneration = async () => ({
            vectorReceipt,
            navigationProof: { status: 'not_bound' },
        });
        internals.syncManager.getPreparedReadObservation = () => ({
            available: false,
            reason: 'watcher_manager_not_started',
            freshnessEpoch: 1,
        });
        internals.mutationLeaseCoordinator = {
            observe: () => ({ mutationActive: false, generation: 1 }),
            getActiveLease: () => null,
        };
        internals.validateCompletionProof = async () => ({
            outcome: 'valid',
            navigationStatus: 'not_bound',
            vectorReceipt,
        });
        internals.preparedReadCache.seed(repoPath, {
            state: 'ready',
            root: { path: repoPath, info: { status: 'indexed' } },
            vectorReceipt,
            navigationStatus: 'not_bound',
            preparedObservation: observation,
        }, observation, nowMs);

        const search = async () => {
            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'where is session validation handled',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'freshness',
            });
            return JSON.parse(response.content[0]?.text || '{}').hints.debugSearch.readiness;
        };

        nowMs = 1;
        assert.deepEqual(await search(), {
            proofMode: 'warm',
            invalidationReason: 'none',
            operations: {
                preparedCacheLookups: 1,
                preparedCacheHits: 1,
                coldReadinessChecks: 0,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 1,
                exactPayloadRecounts: 0,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        });

        navigationAuthority = 'navigation-2';
        nowMs = 14 * 60_000;
        assert.deepEqual(await search(), {
            proofMode: 'warm',
            invalidationReason: 'none',
            operations: {
                preparedCacheLookups: 1,
                preparedCacheHits: 1,
                coldReadinessChecks: 0,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 1,
                exactPayloadRecounts: 0,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        });

        navigationAuthority = 'navigation-3';
        nowMs = 28 * 60_000;
        assert.deepEqual(await search(), {
            proofMode: 'warm',
            invalidationReason: 'none',
            operations: {
                preparedCacheLookups: 1,
                preparedCacheHits: 1,
                coldReadinessChecks: 0,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 1,
                exactPayloadRecounts: 0,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        });

        nowMs = 30 * 60_000;
        assert.deepEqual(await search(), {
            proofMode: 'cold',
            invalidationReason: 'proof_expired',
            auditClassification: 'proof_expiry_audit',
            operations: {
                preparedCacheLookups: 1,
                preparedCacheHits: 0,
                coldReadinessChecks: 1,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 0,
                exactPayloadRecounts: 1,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        });
    });
});

test('warm prepared-read revalidation returns the authority snapshot it actually validated', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const vectorReceipt = { collectionName: 'committed-v3' } as never;
        const oldObservation = JSON.stringify({
            vectorAuthority: 'vector-1',
            navigationAuthority: 'navigation-1',
            mutationGeneration: 1,
        });
        const newObservation = JSON.stringify({
            vectorAuthority: 'vector-2',
            navigationAuthority: 'navigation-2',
            mutationGeneration: 2,
        });
        let authorityReads = 0;
        const internals = handlers as unknown as {
            context: HandlerContext & {
                revalidatePreparedGeneration: () => Promise<{
                    vectorReceipt: never;
                    navigationProof: { status: 'not_bound' };
                }>;
            };
            syncManager: HandlerSyncManager & {
                getPreparedReadObservation: () => {
                    available: false;
                    reason: 'watcher_manager_not_started';
                    freshnessEpoch: number;
                };
            };
            preparedReadCache: {
                seed: (root: string, state: unknown, observation: string, now: number) => void;
            };
            getPreparedAuthorityObservation: () => string;
            getCachedPreparedRead: (
                root: string,
                operations: {
                    preparedCacheLookups: number;
                    preparedCacheHits: number;
                    coldReadinessChecks: number;
                    postFreshnessColdChecks: number;
                    warmReceiptRevalidations: number;
                    exactPayloadRecounts: number;
                },
            ) => Promise<{ status: 'hit'; state: { preparedObservation?: string } } | { status: 'miss' }>;
        };
        internals.getPreparedAuthorityObservation = () => {
            authorityReads += 1;
            return authorityReads <= 2 ? oldObservation : newObservation;
        };
        internals.context.revalidatePreparedGeneration = async () => ({
            vectorReceipt,
            navigationProof: { status: 'not_bound' },
        });
        internals.syncManager.getPreparedReadObservation = () => ({
            available: false,
            reason: 'watcher_manager_not_started',
            freshnessEpoch: 1,
        });
        internals.preparedReadCache.seed(repoPath, {
            state: 'ready',
            root: { path: repoPath, info: { status: 'indexed' } },
            vectorReceipt,
            navigationStatus: 'not_bound',
            preparedObservation: oldObservation,
        }, oldObservation, Date.now());

        const result = await internals.getCachedPreparedRead(repoPath, {
            preparedCacheLookups: 0,
            preparedCacheHits: 0,
            coldReadinessChecks: 0,
            postFreshnessColdChecks: 0,
            warmReceiptRevalidations: 0,
            exactPayloadRecounts: 0,
        });

        assert.equal(result.status, 'hit');
        if (result.status === 'hit') {
            assert.equal(result.state.preparedObservation, oldObservation);
        }
        assert.equal(authorityReads, 2);
    });
});

test('prepared-read seeding uses one authority snapshot and source observation failures stay diagnostic', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const oldObservation = JSON.stringify({
            vectorAuthority: 'vector-1',
            navigationAuthority: 'navigation-1',
            mutationGeneration: 1,
        });
        const newObservation = JSON.stringify({
            vectorAuthority: 'vector-2',
            navigationAuthority: 'navigation-2',
            mutationGeneration: 2,
        });
        let authorityReads = 0;
        let seededObservation: string | undefined;
        const internals = handlers as unknown as {
            syncManager: HandlerSyncManager & {
                getPreparedReadObservation: () => never;
            };
            preparedReadCache: {
                seed: (_root: string, _state: unknown, observation: string) => void;
                evict: (_root: string) => void;
            };
            getPreparedAuthorityObservation: () => string;
            getPreparedReadCacheObservation: (root: string) => {
                observation: string | null;
                unavailableReason?: string;
            };
            seedPreparedRead: (state: unknown, preserveProofAge: boolean) => void;
        };
        internals.getPreparedAuthorityObservation = () => {
            authorityReads += 1;
            return authorityReads === 1 ? oldObservation : newObservation;
        };
        internals.syncManager.getPreparedReadObservation = () => {
            throw new Error('source observation failed');
        };
        internals.preparedReadCache.seed = (_root, _state, observation) => {
            seededObservation = observation;
        };

        internals.seedPreparedRead({
            state: 'ready',
            root: { path: repoPath, info: { status: 'indexed' } },
            vectorReceipt: { collectionName: 'committed-v3' },
            preparedObservation: oldObservation,
        }, false);

        assert.equal(authorityReads, 1);
        assert.equal(seededObservation, oldObservation);

        const failedObservation = internals.getPreparedReadCacheObservation(repoPath);
        assert.equal(failedObservation.observation, newObservation);
        assert.equal(failedObservation.unavailableReason, 'source_observation_failed');
    });
});

test('warm prepared-read reseed does not evict when end-of-search observation drifts', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const stableObservation = JSON.stringify({
            vectorAuthority: 'vector-1',
            navigationAuthority: 'navigation-1',
            mutationGeneration: 1,
        });
        const driftedObservation = JSON.stringify({
            vectorAuthority: 'vector-1',
            navigationAuthority: 'navigation-changed-mid-search',
            mutationGeneration: 1,
        });
        let evicted = false;
        let seeded = false;
        const internals = handlers as unknown as {
            preparedReadCache: {
                seed: () => void;
                evict: () => void;
            };
            getPreparedReadCacheObservation: () => { observation: string | null };
            seedPreparedRead: (state: unknown, preserveProofAge: boolean) => void;
        };
        internals.preparedReadCache.seed = () => {
            seeded = true;
        };
        internals.preparedReadCache.evict = () => {
            evicted = true;
        };
        internals.getPreparedReadCacheObservation = () => ({ observation: driftedObservation });

        // Cold seed still fails closed on drift.
        internals.seedPreparedRead({
            state: 'ready',
            root: { path: repoPath, info: { status: 'indexed' } },
            vectorReceipt: { collectionName: 'committed-v3' },
            preparedObservation: stableObservation,
        }, false);
        assert.equal(seeded, false);
        assert.equal(evicted, true);

        evicted = false;
        seeded = false;
        // Warm reseed after a successful hit must not discard the prior entry when
        // mid-search registry/navigation work changes the live observation snapshot.
        internals.seedPreparedRead({
            state: 'ready',
            root: { path: repoPath, info: { status: 'indexed' } },
            vectorReceipt: { collectionName: 'committed-v3' },
            preparedObservation: stableObservation,
        }, true);
        assert.equal(seeded, false);
        assert.equal(evicted, false);
    });
});

test('source observation failure preserves vector results with an unverified-freshness warning', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'export function owner() { return true; }',
            relativePath: 'src/owner.ts',
            startLine: 1,
            endLine: 1,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
        }]);
        const internals = handlers as unknown as {
            context: HandlerContext & {
                getIndexAuthorityObservations: () => { vector: string; navigation: string };
            };
            syncManager: HandlerSyncManager & {
                getPreparedReadObservation: () => never;
            };
            mutationLeaseCoordinator: {
                observe: () => { mutationActive: boolean; generation: number };
                getActiveLease: () => null;
            };
        };
        internals.context.getIndexAuthorityObservations = () => ({
            vector: 'vector-1',
            navigation: 'navigation-1',
        });
        internals.syncManager.getPreparedReadObservation = () => {
            throw new Error('source observation failed');
        };
        internals.mutationLeaseCoordinator = {
            observe: () => ({ mutationActive: false, generation: 1 }),
            getActiveLease: () => null,
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is owner behavior handled',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full',
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');

        assert.equal(payload.status, 'ok');
        assert.ok(warningCodes(payload).includes('SOURCE_FRESHNESS_UNVERIFIED'));
        assert.equal(
            payload.hints?.debugSearch?.readiness?.observationUnavailableReason,
            'source_observation_failed',
        );
    });
});

test('handleSearchCode reports the exact recount used by fallback collection proof', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
        }]);
        let fallbackProofs = 0;
        const internals = handlers as unknown as {
            context: HandlerContext & {
                getActiveIndexedCollectionName: () => Promise<string>;
                getVectorStore: () => { hasCollection: () => Promise<boolean> };
                getIndexAuthorityObservations: () => { vector: string; navigation: string };
            };
            syncManager: HandlerSyncManager & {
                getPreparedReadObservation: () => {
                    available: false;
                    reason: 'watcher_disabled';
                    freshnessEpoch: number;
                };
            };
            mutationLeaseCoordinator: {
                observe: () => { mutationActive: boolean; generation: number };
                getActiveLease: () => null;
            };
            validateCompletionProof: () => Promise<{ outcome: 'probe_failed' }>;
        };
        internals.validateCompletionProof = async () => ({ outcome: 'probe_failed' });
        internals.context.getActiveIndexedCollectionName = async () => {
            fallbackProofs += 1;
            return 'committed-v3';
        };
        internals.context.getVectorStore = () => ({ hasCollection: async () => true });
        internals.context.getIndexAuthorityObservations = () => ({
            vector: 'vector-stable',
            navigation: 'navigation-stable',
        });
        internals.syncManager.getPreparedReadObservation = () => ({
            available: false,
            reason: 'watcher_disabled',
            freshnessEpoch: 0,
        });
        internals.mutationLeaseCoordinator = {
            observe: () => ({ mutationActive: false, generation: 1 }),
            getActiveLease: () => null,
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is session validation handled',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'freshness',
        });
        const readiness = JSON.parse(response.content[0]?.text || '{}').hints.debugSearch.readiness;

        assert.equal(fallbackProofs, 1);
        assert.deepEqual(readiness, {
            proofMode: 'cold',
            invalidationReason: 'cache_miss',
            operations: {
                preparedCacheLookups: 1,
                preparedCacheHits: 0,
                coldReadinessChecks: 1,
                postFreshnessColdChecks: 0,
                warmReceiptRevalidations: 0,
                exactPayloadRecounts: 1,
                registryLoads: 0,
                navigationValidationRuns: 0,
            },
        });
    });
});

test('handleSearchCode ignores the retired internal debug boolean alias', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
        }]);
        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is session validation handled',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debug: true,
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assertClosedDebugProjection(payload, 'none');
    });
});

test('handleSearchCode raw semantic path publishes closed debug projections for every mode', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
        }]);
        for (const mode of ['none', 'summary', 'ranking', 'freshness', 'full'] as const) {
            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'where is session validation handled',
                scope: 'runtime',
                resultMode: 'raw',
                groupBy: 'symbol',
                limit: 5,
                ...(mode === 'none' ? {} : { debugMode: mode }),
            });
            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assertClosedDebugProjection(payload, mode);
        }
    });
});

test('handleSearchCode grouped output omits unproven chunk identity from its compact target', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_auth_validate',
            symbolLabel: 'method validateSession(token: string)',
            breadcrumbs: ['class SessionManager', 'method validateSession(token: string)']
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        assert.equal(response.isError, undefined);
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.resultMode, 'grouped');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.symbolId, undefined);
        assert.equal(payload.results[0].navigation.graph, 'missing_symbol');
    });
});

test('handleSearchCode grouped symbol mode emits a graph-ready concrete target without a legacy sidecar', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const fileContent = [
            'class SessionManager {',
            '  validateSession(token: string) {',
            '    return token.trim().length > 0;',
            '  }',
            '}',
            '',
        ].join('\n');
        const { symbols } = await writeSearchNavigationSidecars({
            repoPath,
            relativePath: 'src/auth.ts',
            content: fileContent,
            chunks: [{
                content: 'return token.trim().length > 0;',
                startLine: 2,
                endLine: 4,
                symbolLabel: 'method validateSession(token: string)',
                breadcrumbs: ['class SessionManager', 'method validateSession(token: string)'],
            }],
        });
        const validateSymbol = symbols.find((symbol) => symbol.kind !== 'file');
        assert.ok(validateSymbol);

        const handlers = createHandlers(repoPath, [{
            content: 'return token.trim().length > 0;',
            relativePath: 'src/auth.ts',
            startLine: 2,
            endLine: 4,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: validateSymbol!.label,
            ownerSymbolKey: validateSymbol!.symbolKey,
            ownerSymbolInstanceId: validateSymbol!.symbolInstanceId,
            symbolKind: validateSymbol!.kind,
        }], undefined, { sidecarReady: false });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const result = payload.results[0];
        assert.equal(result.navigation.graph, 'ready');
        assert.equal(result.target.symbolId, validateSymbol!.symbolInstanceId);
        assert.equal(result.debug.graphEvidence.sidecarBuiltAt, '2026-01-01T00:00:00.000Z');
    }));
});

test('handleSearchCode does not promote stale chunk identity and recommends its validated span', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const fileContent = [
            'function currentSession(token: string) {',
            '  return token.trim().length > 0;',
            '}',
            '',
        ].join('\n');
        await writeSearchNavigationSidecars({
            repoPath,
            relativePath: 'src/current.ts',
            content: fileContent,
            chunks: [{
                content: 'return token.trim().length > 0;',
                startLine: 1,
                endLine: 3,
                symbolLabel: 'function currentSession(token: string)',
            }],
        });

        const handlers = createHandlers(repoPath, [{
            content: 'return staleToken.trim().length > 0;',
            relativePath: 'src/stale.ts',
            startLine: 1,
            endLine: 3,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: 'function staleSession(token: string)',
            ownerSymbolKey: 'sym_key_stale_session',
            ownerSymbolInstanceId: 'sym_instance_stale_session',
            symbolKind: 'function',
        }], undefined, { sidecarReady: false });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'stale session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const result = payload.results[0];
        assert.equal(result.target.symbolId, undefined);
        assert.equal(result.navigation.graph, 'stale_symbol_ref');
        assert.equal(payload.recommendedNextAction?.tool, 'read_file');
        assert.deepEqual(payload.recommendedNextAction?.args, {
            path: path.join(repoPath, 'src/stale.ts'),
            start_line: 1,
            end_line: 3,
        });
    }));
});

test('handleSearchCode grouped symbol mode keeps Go read identity while graph is unsupported', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'src', 'service.go'), [
            'package svc',
            '',
            'func add(a, b int) int {',
            '  return a + b',
            '}',
            '',
        ].join('\n'));
        const { symbols } = await writeSearchNavigationSidecars({
            repoPath,
            relativePath: 'src/service.go',
            language: 'go',
            content: fs.readFileSync(path.join(repoPath, 'src', 'service.go'), 'utf8'),
            chunks: [{
                content: 'func add(a, b int) int {\n  return a + b\n}',
                startLine: 3,
                endLine: 5,
                symbolLabel: 'function add',
            }],
        });
        const addSymbol = symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'add');
        assert.ok(addSymbol);

        const handlers = createHandlers(repoPath, [{
            content: 'return a + b',
            relativePath: 'src/service.go',
            startLine: 4,
            endLine: 4,
            language: 'go',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: addSymbol!.label,
            ownerSymbolKey: addSymbol!.symbolKey,
            ownerSymbolInstanceId: addSymbol!.symbolInstanceId,
            symbolKind: addSymbol!.kind,
        }], undefined, { sidecarReady: false });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'add',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const result = payload.results[0];
        assert.equal(result.target.symbolId, addSymbol!.symbolInstanceId);
        assert.equal(result.navigation.graph, 'unsupported_language');
        assert.equal(payload.recommendedNextAction?.args?.open_symbol?.symbolId, addSymbol!.symbolInstanceId);
    }));
});

test('handleSearchCode grouped symbol mode keeps Rust read identity while graph is unsupported', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'src', 'stack.rs'), [
            'pub struct Stack { value: i32 }',
            '',
            'impl Stack {',
            '  pub fn push(&mut self, value: i32) {',
            '    self.value = value;',
            '  }',
            '}',
            '',
        ].join('\n'));
        const { symbols } = await writeSearchNavigationSidecars({
            repoPath,
            relativePath: 'src/stack.rs',
            language: 'rust',
            content: fs.readFileSync(path.join(repoPath, 'src', 'stack.rs'), 'utf8'),
            chunks: [{
                content: 'pub fn push(&mut self, value: i32) {\n    self.value = value;\n  }',
                startLine: 4,
                endLine: 6,
                symbolLabel: 'method push',
                breadcrumbs: ['type Stack'],
            }],
        });
        const pushSymbol = symbols.find((symbol) => symbol.kind === 'method' && symbol.name === 'push');
        assert.ok(pushSymbol);

        const handlers = createHandlers(repoPath, [{
            content: 'self.value = value',
            relativePath: 'src/stack.rs',
            startLine: 5,
            endLine: 5,
            language: 'rust',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: pushSymbol!.label,
            ownerSymbolKey: pushSymbol!.symbolKey,
            ownerSymbolInstanceId: pushSymbol!.symbolInstanceId,
            symbolKind: pushSymbol!.kind,
        }], undefined, { sidecarReady: false });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'push',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const result = payload.results[0];
        assert.equal(result.target.symbolId, pushSymbol!.symbolInstanceId);
        assert.equal(result.navigation.graph, 'unsupported_language');
        assert.equal(payload.recommendedNextAction?.args?.open_symbol?.symbolId, pushSymbol!.symbolInstanceId);
    }));
});

test('handleSearchCode compact target works end to end with call_graph without a legacy sidecar', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const fileContent = [
            'function normalizeToken(token: string) {',
            '  return token.trim();',
            '}',
            '',
            'function validateSession(token: string) {',
            '  return normalizeToken(token).length > 0;',
            '}',
            '',
        ].join('\n');
        const { symbols, manifestHash } = await writeSearchNavigationSidecars({
            repoPath,
            relativePath: 'src/auth.ts',
            content: fileContent,
            chunks: [
                {
                    content: 'function normalizeToken(token: string) {\n  return token.trim();\n}',
                    startLine: 1,
                    endLine: 3,
                    symbolLabel: 'function normalizeToken(token: string)',
                },
                {
                    content: 'function validateSession(token: string) {\n  return normalizeToken(token).length > 0;\n}',
                    startLine: 5,
                    endLine: 7,
                    symbolLabel: 'function validateSession(token: string)',
                },
            ],
        });
        const normalizeSymbol = symbols.find((symbol) => symbol.kind !== 'file' && symbol.name === 'normalizeToken');
        const validateSymbol = symbols.find((symbol) => symbol.kind !== 'file' && symbol.name === 'validateSession');
        assert.ok(normalizeSymbol);
        assert.ok(validateSymbol);

        await writeSearchRelationshipSidecar({
            repoPath,
            relativePath: 'src/auth.ts',
            fileHash: 'test-search-file-hash',
            language: 'typescript',
            symbolCount: symbols.length,
            symbolRegistryManifestHash: manifestHash,
            records: [{
                sourceKey: validateSymbol!.symbolKey,
                sourceInstanceId: validateSymbol!.symbolInstanceId,
                targetKey: normalizeSymbol!.symbolKey,
                targetInstanceId: normalizeSymbol!.symbolInstanceId,
                type: 'CALLS',
                file: 'src/auth.ts',
                span: { startLine: 6, endLine: 6 },
                confidence: 'high',
            }],
        });

        const handlers = createHandlers(repoPath, [{
            content: 'return normalizeToken(token).length > 0;',
            relativePath: 'src/auth.ts',
            startLine: 5,
            endLine: 7,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: validateSymbol!.label,
            ownerSymbolKey: validateSymbol!.symbolKey,
            ownerSymbolInstanceId: validateSymbol!.symbolInstanceId,
            symbolKind: validateSymbol!.kind,
        }], undefined, { sidecarReady: false });

        const searchResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        });

        const searchPayload = JSON.parse(searchResponse.content[0]?.text || '{}');
        const result = searchPayload.results[0];
        assert.equal(result.navigation.graph, 'ready');
        assert.equal(result.target.symbolId, validateSymbol!.symbolInstanceId);

        const callGraphResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: result.target,
            direction: 'both',
            depth: 1,
            limit: 20,
        });

        const graphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
        assert.equal(graphPayload.status, 'ok');
        assert.equal(graphPayload.supported, true);
        assert.deepEqual(
            graphPayload.nodes.map((node: { symbolId: string }) => node.symbolId).sort(),
            [
                validateSymbol!.symbolInstanceId,
                normalizeSymbol!.symbolInstanceId,
            ].sort(),
        );
        assert.equal(graphPayload.edges.length, 1);
        assert.equal(graphPayload.edges[0].srcSymbolId, validateSymbol!.symbolInstanceId);
        assert.equal(graphPayload.edges[0].dstSymbolId, normalizeSymbol!.symbolInstanceId);
    }));
});

test('handleSearchCode grouped symbol mode collapses chunks by owner symbol identity and emits owner-backed navigation ids', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'return token.trim();',
                relativePath: 'src/auth.ts',
                startLine: 10,
                endLine: 12,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_chunk_symbol_a',
                symbolLabel: 'method login(token: string)',
                ownerSymbolKey: 'owner_auth_login_key',
                ownerSymbolInstanceId: 'owner_auth_login_instance',
                symbolKind: 'method',
            },
            {
                content: 'return session.issue(token);',
                relativePath: 'src/auth.ts',
                startLine: 13,
                endLine: 16,
                language: 'typescript',
                score: 0.97,
                indexedAt: '2026-01-01T00:31:00.000Z',
                symbolId: 'legacy_chunk_symbol_b',
                symbolLabel: 'method login(token: string)',
                ownerSymbolKey: 'owner_auth_login_key',
                ownerSymbolInstanceId: 'owner_auth_login_instance',
                symbolKind: 'method',
            },
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'login token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].evidenceChunks, 2);
        assert.equal(payload.results[0].target.symbolId, undefined);
        assert.equal(payload.results[0].navigation.graph, 'missing_symbol_registry');
        assert.equal('symbolKey' in payload.results[0], false);
        assert.equal(payload.results[0].debug.symbolAggregation.ownerSource, 'owner_metadata');
    });
});

test('handleSearchCode grouped symbol mode repairs legacy chunks from compatible symbol registry ownership', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/auth.ts';
            const content = [
                'export class AuthService {',
                '  login(token: string) {',
                '    const normalized = token.trim();',
                '    return this.issue(normalized);',
                '  }',
                '}',
                '',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content);
            const symbols = await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                chunks: [{
                    content: 'login(token: string) { const normalized = token.trim(); return this.issue(normalized); }',
                    startLine: 2,
                    endLine: 5,
                    symbolLabel: 'method login(token: string)',
                    breadcrumbs: ['class AuthService', 'method login(token: string)'],
                }],
            });
            const owner = symbols.find((symbol) => symbol.kind === 'method');
            assert.ok(owner);

            const handlers = createHandlers(repoPath, [
                {
                    content: 'const normalized = token.trim();',
                    relativePath,
                    startLine: 3,
                    endLine: 3,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'legacy_chunk_symbol_a',
                    symbolLabel: 'method login(token: string)',
                },
                {
                    content: 'return this.issue(normalized);',
                    relativePath,
                    startLine: 4,
                    endLine: 4,
                    language: 'typescript',
                    score: 0.97,
                    indexedAt: '2026-01-01T00:31:00.000Z',
                    symbolId: 'legacy_chunk_symbol_b',
                    symbolLabel: 'method login(token: string)',
                },
            ]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'login token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].evidenceChunks, 2);
            assert.equal(payload.results[0].symbolKind, 'method');
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.equal(payload.results[0].navigation.graph, 'ready');
            assert.equal('symbolKey' in payload.results[0], false);
            assert.equal(payload.results[0].debug.symbolAggregation.ownerSource, 'registry_repair');
        });
    });
});

test('handleSearchCode ranks exact warning-code emission above tests and generic helpers', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: "assert.ok(payload.warnings.includes('SEARCH_PARTIAL_INDEX:limit_reached'));",
                relativePath: 'packages/mcp/src/core/handlers.index_state_stability.test.ts',
                startLine: 149,
                endLine: 150,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_partial_warning_test',
                symbolLabel: 'function semanticSearch()',
            },
            {
                content: [
                    'const partialIndexSearchWarnings = this.isPartialIndexNavigationUnavailable(searchableRoot?.info)',
                    '  ? [',
                    '      SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING,',
                    '      SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING,',
                    '    ]',
                    '  : [];',
                ].join('\n'),
                relativePath: 'packages/mcp/src/core/handlers.ts',
                startLine: 4983,
                endLine: 4989,
                language: 'typescript',
                score: 0.45,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_handle_search_code',
                symbolLabel: 'async method handleSearchCode(args: any)',
            },
            {
                content: 'private buildReindexHint(codebasePath: string) { return { tool: "manage_index" }; }',
                relativePath: 'packages/mcp/src/core/handlers.ts',
                startLine: 428,
                endLine: 432,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_build_reindex_hint',
                symbolLabel: 'method buildReindexHint(codebasePath: string)',
            },
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is SEARCH_PARTIAL_INDEX emitted',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].target.file, 'packages/mcp/src/core/handlers.ts');
        assert.equal(payload.results[0].displayLabel, 'async method handleSearchCode(args: any)');
        assert.notEqual(payload.results[0].target.file, 'packages/mcp/src/core/handlers.index_state_stability.test.ts');
        assert.notEqual(payload.results[0].displayLabel, 'method buildReindexHint(codebasePath: string)');
        assert.equal(payload.hints?.debugSearch?.queryIntent?.reasons.includes('writer_seeking_query'), true);
    });
});

test('handleSearchCode ranks natural-language emitted warning site above generic reindex helper', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'private buildReindexHint(codebasePath: string) { return { tool: "manage_index" }; }',
                relativePath: 'packages/mcp/src/core/handlers.ts',
                startLine: 428,
                endLine: 432,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_build_reindex_hint',
                symbolLabel: 'method buildReindexHint(codebasePath: string)',
            },
            {
                content: [
                    'const partialIndexSearchWarnings = this.isPartialIndexNavigationUnavailable(searchableRoot?.info)',
                    '  ? [',
                    '      SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING,',
                    '      SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING,',
                    '    ]',
                    '  : [];',
                ].join('\n'),
                relativePath: 'packages/mcp/src/core/handlers.ts',
                startLine: 4983,
                endLine: 4989,
                language: 'typescript',
                score: 0.40,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_handle_search_code',
                symbolLabel: 'async method handleSearchCode(args: any)',
            },
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is partial index search warning emitted',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].displayLabel, 'async method handleSearchCode(args: any)');
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
        assert.equal(payload.results[1].displayLabel, 'method buildReindexHint(codebasePath: string)');
    });
});

test('handleSearchCode supplements exact warning-code retrieval from tracked lexical evidence when semantic search misses it', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'packages/mcp/src/core/handlers.ts';
        fs.mkdirSync(path.join(repoPath, 'packages/mcp/src/core'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, relativePath),
            [
                'export async function handleSearchCode() {',
                '  return [',
                '    SEARCH_PARTIAL_INDEX_LIMIT_REACHED_WARNING,',
                '    SEARCH_PARTIAL_INDEX_NAVIGATION_UNAVAILABLE_WARNING,',
                '  ];',
                '}',
            ].join('\n'),
            'utf8'
        );

        const handlers = createHandlers(repoPath, [
            {
                content: 'private buildReindexHint(codebasePath: string) { return { tool: "manage_index" }; }',
                relativePath: 'packages/mcp/src/core/helpers.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_build_reindex_hint',
                symbolLabel: 'method buildReindexHint(codebasePath: string)',
            },
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => [relativePath];

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is SEARCH_PARTIAL_INDEX emitted',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].target.file, relativePath);
        assert.match(payload.results[0].preview, /SEARCH_PARTIAL_INDEX/);
        assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.semanticCandidate, false);
        assert.equal(payload.results[0].debug?.provenance?.lexicalCandidate, true);
    });
});

test('handleSearchCode supplements quoted exact literal retrieval from tracked lexical evidence when semantic search misses it', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'packages/mcp/src/core/handlers.ts';
        fs.mkdirSync(path.join(repoPath, 'packages/mcp/src/core'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, relativePath),
            [
                'export async function handleSearchCode() {',
                '  return "partial index search warning";',
                '}',
            ].join('\n'),
            'utf8'
        );

        const handlers = createHandlers(repoPath, [
            {
                content: 'private buildReindexHint(codebasePath: string) { return { tool: "manage_index" }; }',
                relativePath: 'packages/mcp/src/core/helpers.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_build_reindex_hint',
                symbolLabel: 'method buildReindexHint(codebasePath: string)',
            },
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => [relativePath];

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: '"partial index search warning"',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].target.file, relativePath);
        assert.match(payload.results[0].preview, /partial index search warning/i);
        assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('lexical_files'), true);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.reasons?.includes('quoted_literal_query'), true);
        assert.deepEqual(payload.hints?.debugSearch?.providerWork, {
            semanticSearchAttempts: 1,
            embeddingCallsByCurrentContract: 0,
            denseQueriesByCurrentContract: 0,
            sparseQueriesByCurrentContract: 1,
            rerankerCalls: 0,
            rerankerCandidates: 0,
            rerankerInputBytes: 0,
            candidatesWithSemanticEvidence: 0,
            candidatesWithLexicalEvidence: 2,
            candidatesWithCurrentSourceEvidence: 0,
        });
        assert.deepEqual(payload.hints?.debugSearch?.semanticExpansion, {
            expand: false,
            attempted: false,
            reason: 'lexical_route',
            primaryScopedCandidateCount: 1,
        });
    });
});

test('handleSearchCode exact registry fast path returns a grouped symbol despite watcher maintenance failure', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'packages/mcp/src/core/handlers.ts';
            const content = [
                'export class ToolHandlers {',
                '  async prepareTrackedRootForRead(path: string) {',
                '    return path;',
                '  }',
                '}',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'packages/mcp/src/core'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const symbols = await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                chunks: [{
                    content: 'async prepareTrackedRootForRead(path: string) { return path; }',
                    startLine: 2,
                    endLine: 4,
                    symbolLabel: 'method prepareTrackedRootForRead(path: string)',
                    breadcrumbs: ['class ToolHandlers', 'method prepareTrackedRootForRead(path: string)'],
                }],
            });
            const owner = symbols.find((symbol) => symbol.name === 'prepareTrackedRootForRead');
            assert.ok(owner);

            let semanticSearchCalls = 0;
            let rerankCalls = 0;
            const handlers = createHandlers(repoPath, [], {
                rerank: async () => {
                    rerankCalls += 1;
                    return [];
                }
            });
            (handlers as unknown as ToolHandlersTestOverrides).syncManager = {
                ensureFreshness: async () => ({ mode: 'skipped_recent', changed: false }),
                touchWatchedCodebase: async () => { throw new Error('watch boom'); },
            };
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                throw new Error('semanticSearch should not run for exact registry hits');
            };
            (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => {
                throw new Error('tracked lexical scan should not run for exact registry hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'prepareTrackedRootForRead',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const rawText = response.content[0]?.text || '{}';
            const payload = JSON.parse(rawText);
            assert.equal(payload.status, 'ok');
            assert.doesNotMatch(rawText, /\n\s+"/);
            assert.equal(semanticSearchCalls, 0);
            assert.equal(rerankCalls, 0);
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.match(payload.results[0].preview, /return path/);
            assert.doesNotMatch(payload.results[0].preview, /export class ToolHandlers/);
            assert.equal(typeof payload.results[0].navigation?.graph, 'string');
            assert.equal(payload.results[0].recommendedNextAction, undefined);
            assert.equal(payload.recommendedNextAction?.tool, 'read_file');
            assert.equal(payload.recommendedNextAction?.args?.open_symbol?.symbolId, owner.symbolInstanceId);
            assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('exact_registry'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('exact_registry'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), false);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.status, 'hit');
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.matchedSymbolInstanceId, owner.symbolInstanceId);
            assert.deepEqual(payload.hints?.debugSearch?.providerWork, {
                semanticSearchAttempts: 0,
                embeddingCallsByCurrentContract: 0,
                denseQueriesByCurrentContract: 0,
                sparseQueriesByCurrentContract: 0,
                rerankerCalls: 0,
                rerankerCandidates: 0,
                rerankerInputBytes: 0,
                candidatesWithSemanticEvidence: 0,
                candidatesWithLexicalEvidence: 0,
                candidatesWithCurrentSourceEvidence: 0,
            });
            const phaseTimings = payload.hints?.debugSearch?.phaseTimingsMs || {};
            for (const phase of ['prepareRead', 'ensureFreshness', 'exactRegistry', 'semanticSearch', 'trackedLexical', 'rerank', 'registryLoad', 'grouping', 'navigationValidation']) {
                assert.equal(typeof phaseTimings[phase], 'number');
            }
            assert.equal(phaseTimings.semanticSearch, 0);
            assert.equal(phaseTimings.trackedLexical, 0);
            assert.equal(phaseTimings.rerank, 0);

            for (const mode of ['none', 'summary', 'ranking', 'freshness', 'full'] as const) {
                const modeResponse = await handlers.handleSearchCode({
                    path: repoPath,
                    query: 'prepareTrackedRootForRead',
                    scope: 'runtime',
                    resultMode: 'grouped',
                    groupBy: 'symbol',
                    limit: 5,
                    ...(mode === 'none' ? {} : { debugMode: mode }),
                });
                const modePayload = JSON.parse(modeResponse.content[0]?.text || '{}');
                assert.equal(modePayload.status, 'ok');
                assert.equal(modePayload.results[0].target.symbolId, owner.symbolInstanceId);
                assertClosedDebugProjection(modePayload, mode);
            }
        });
    });
});

test('handleSearchCode resolves explicit ownership through the registry without provider work', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/search/ranking.ts';
            const content = 'export function rankCandidates() { return []; }\n';
            fs.mkdirSync(path.join(repoPath, 'src/search'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const symbols = await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                chunks: [{
                    content: content.trim(),
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function rankCandidates()',
                }],
            });
            const owner = symbols.find((symbol) => symbol.name === 'rankCandidates');
            assert.ok(owner);

            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                throw new Error('semanticSearch should not run for deterministic ownership hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'who owns rankCandidates',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 2,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.equal(payload.hints?.debugSearch?.route?.kind, 'ownership');
            assert.deepEqual(payload.hints?.debugSearch?.providerWork, {
                semanticSearchAttempts: 0,
                embeddingCallsByCurrentContract: 0,
                denseQueriesByCurrentContract: 0,
                sparseQueriesByCurrentContract: 0,
                rerankerCalls: 0,
                rerankerCandidates: 0,
                rerankerInputBytes: 0,
                candidatesWithSemanticEvidence: 0,
                candidatesWithLexicalEvidence: 0,
                candidatesWithCurrentSourceEvidence: 0,
            });
        });
    });
});

test('handleSearchCode resolves exact caller relationships before provider-backed search', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const { target, caller } = await writeCallerSearchFixture(repoPath);

            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                throw new Error('semanticSearch should not run for deterministic caller hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'who calls writeSourceCheckpoint',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 2,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.deepEqual(
                payload.results.map((result: { target: { symbolId?: string } }) => result.target.symbolId),
                [caller.symbolInstanceId, target.symbolInstanceId],
            );
            assert.equal(payload.hints?.debugSearch?.route?.kind, 'references');
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('relationships'), true);
            assert.deepEqual(payload.hints?.debugSearch?.providerWork, {
                semanticSearchAttempts: 0,
                embeddingCallsByCurrentContract: 0,
                denseQueriesByCurrentContract: 0,
                sparseQueriesByCurrentContract: 0,
                rerankerCalls: 0,
                rerankerCandidates: 0,
                rerankerInputBytes: 0,
                candidatesWithSemanticEvidence: 0,
                candidatesWithLexicalEvidence: 0,
                candidatesWithCurrentSourceEvidence: 0,
            });

            const boundedResponse = await handlers.handleSearchCode({
                path: repoPath,
                query: 'who calls writeSourceCheckpoint',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 1,
            });
            const boundedPayload = JSON.parse(boundedResponse.content[0]?.text || '{}');
            assert.deepEqual(
                boundedPayload.results.map((result: { target: { symbolId?: string } }) => result.target.symbolId),
                [caller.symbolInstanceId],
            );
        });
    });
});

test('handleSearchCode falls back when exact caller relationship evidence is empty', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            await writeCallerSearchFixture(repoPath, { includeRelationship: false });
            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [];
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'who calls writeSourceCheckpoint',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 2,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls > 0, true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('relationships'), false);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('primary'), true);
        });
    });
});

test('handleSearchCode falls back when exact caller relationship participants are dirty', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const { targetPath, callerPath } = await writeCallerSearchFixture(repoPath);

            for (const dirtyPath of [targetPath, callerPath]) {
                let semanticSearchCalls = 0;
                const handlers = createHandlers(repoPath, []);
                (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
                    available: true,
                    files: new Set([dirtyPath]),
                });
                (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                    semanticSearchCalls += 1;
                    return [];
                };

                const response = await handlers.handleSearchCode({
                    path: repoPath,
                    query: 'who calls writeSourceCheckpoint',
                    scope: 'runtime',
                    resultMode: 'grouped',
                    groupBy: 'symbol',
                    limit: 2,
                });

                const payload = JSON.parse(response.content[0]?.text || '{}');
                assert.equal(payload.status, 'ok');
                assert.equal(semanticSearchCalls > 0, true, `expected fallback for dirty ${dirtyPath}`);
            }
        });
    });
});

test('handleSearchCode exact registry fast path repairs a dirty symbol span from current source', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/dirty-exact.ts';
            const indexedContent = [
                'export function exactDirtyOwner() {',
                '  return true;',
                '}',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), indexedContent, 'utf8');
            const symbols = await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content: indexedContent,
                chunks: [{
                    content: indexedContent,
                    startLine: 1,
                    endLine: 3,
                    symbolLabel: 'function exactDirtyOwner()',
                }],
            });
            const owner = symbols.find((symbol) => symbol.name === 'exactDirtyOwner');
            assert.ok(owner);

            fs.writeFileSync(path.join(repoPath, relativePath), [
                'const inserted = true;',
                '',
                indexedContent,
            ].join('\n'), 'utf8');
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
                available: true,
                files: new Set([relativePath]),
            });
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                throw new Error('semanticSearch should not run for a validated dirty exact registry hit');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'exactDirtyOwner',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.deepEqual(payload.results[0].target.span, { startLine: 3, endLine: 5 });
            assert.equal(payload.results[0].preview, '');
        });
    });
});

test('handleSearchCode exact registry fast path rejects a dirty symbol missing from current source', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/removed-exact.ts';
            const indexedContent = 'export function removedExactOwner() { return true; }\n';
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), indexedContent, 'utf8');
            await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content: indexedContent,
                chunks: [{
                    content: indexedContent,
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function removedExactOwner()',
                }],
            });
            fs.writeFileSync(path.join(repoPath, relativePath), 'export const replacement = true;\n', 'utf8');

            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
                available: true,
                files: new Set([relativePath]),
            });
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [];
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'removedExactOwner',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls > 0, true);
            assert.equal(payload.results.some((result: { symbolLabel?: string }) => result.symbolLabel?.includes('removedExactOwner')), false);
        });
    });
});

test('handleSearchCode declines an invalid exact registry target and continues normal retrieval', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const manifest: SymbolRegistryManifest = {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: repoPath,
                rootFingerprint: 'test-root-fingerprint',
                indexPolicyHash: 'test-policy',
                languageRouterVersion: 'test-router-v1',
                extractorVersion: 'test-extractor-v1',
                relationshipVersion: 'test-relationships-v1',
                builtAt: '2026-01-01T00:00:00.000Z',
                files: [{
                    path: 'src/invalid-registry.ts',
                    hash: 'invalid-registry-hash',
                    language: 'typescript',
                    symbolCount: 1,
                }],
            };
            const invalidSymbol: SymbolRecord = {
                symbolKey: 'symkey_malformed_exact_owner',
                symbolInstanceId: 'syminst_malformed_exact_owner',
                language: 'typescript',
                kind: 'function',
                name: 'malformedExactOwner',
                qualifiedName: 'malformedExactOwner',
                label: 'function malformedExactOwner()',
                file: 'src/invalid-registry.ts',
                span: { startLine: 0, endLine: 0 },
                parentQualifiedNamePath: [],
                fileHash: 'invalid-registry-hash',
                extractorVersion: 'test-extractor-v1',
            } as SymbolRecord;
            const invalidRegistry = buildSymbolRegistry({
                manifest,
                symbols: [invalidSymbol],
            });

            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            const navigationStore = (handlers as unknown as {
                navigationStore: {
                    getManifest: () => Promise<{
                        status: 'ok';
                        registry: ReturnType<typeof buildSymbolRegistry>;
                        manifestHash: string;
                    }>;
                };
            }).navigationStore;
            const originalGetManifest = navigationStore.getManifest;
            try {
                navigationStore.getManifest = async () => ({
                    status: 'ok',
                    registry: invalidRegistry,
                    manifestHash: 'invalid-registry-manifest-hash',
                });
                (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                    semanticSearchCalls += 1;
                    return [{
                        content: 'export function malformedExactOwner() { return "fallback"; }',
                        relativePath: 'src/fallback.ts',
                        startLine: 1,
                        endLine: 1,
                        language: 'typescript',
                        score: 0.9,
                        indexedAt: '2026-01-01T00:30:00.000Z',
                        symbolLabel: 'function malformedExactOwner()',
                    }];
                };

                const response = await handlers.handleSearchCode({
                    path: repoPath,
                    query: 'malformedExactOwner',
                    scope: 'runtime',
                    resultMode: 'grouped',
                    groupBy: 'symbol',
                    limit: 5,
                });

                const payload = JSON.parse(response.content[0]?.text || '{}');
                assert.equal(payload.status, 'ok');
                assert.equal(semanticSearchCalls > 0, true);
                assert.equal(payload.results.length, 1);
                assert.equal(payload.results[0].target.file, 'src/fallback.ts');
                assert.equal(
                    warningCodes(payload).includes('SEARCH_INVALID_GROUP_TARGET_OMITTED'),
                    true,
                );
            } finally {
                navigationStore.getManifest = originalGetManifest;
            }
        });
    });
});

test('handleSearchCode does not shortcut vague one-word semantic queries through exact registry', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/runtime.ts';
            const content = 'export function runtime() { return true; }';
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                chunks: [{
                    content,
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function runtime()',
                }],
            });

            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [];
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'runtime',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 2);
            assert.equal(payload.hints?.debugSearch?.exactRegistry, undefined);
            assert.equal(payload.hints?.debugSearch?.phaseTimingsMs?.exactRegistry, 0);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('primary'), true);
        });
    });
});

test('handleSearchCode explains exact registry fallback when the symbol registry is unavailable', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, 'src/runtime.ts'), 'export function prepareTrackedRootForRead() { return true; }', 'utf8');

            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [];
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'prepareTrackedRootForRead',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 1);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.attempted, true);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.status, 'miss');
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.reason, 'registry_unavailable');
            assert.equal(typeof payload.hints?.debugSearch?.exactRegistry?.registryUnavailableReason, 'string');
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('primary'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('expanded'), false);
        });
    });
});

test('handleSearchCode exact registry fast path uses normal runtime scope filtering for registry candidates', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'docs/runtime.ts';
            const content = 'export function prepareTrackedRootForRead() { return true; }';
            fs.mkdirSync(path.join(repoPath, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                chunks: [{
                    content,
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function prepareTrackedRootForRead()',
                }],
            });

            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [];
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'prepareTrackedRootForRead',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 1);
            assert.equal(payload.results.length, 0);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.status, 'miss');
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.filteredSymbolCount, 0);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('expanded'), false);
        });
    });
});

test('handleSearchCode exact registry fast path limits path-scoped lookup to the requested file', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const targetPath = 'packages/mcp/src/core/handlers.ts';
            const otherPath = 'packages/mcp/src/core/other.ts';
            fs.mkdirSync(path.join(repoPath, 'packages/mcp/src/core'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, targetPath), [
                'export function prepareTrackedRootForRead() {',
                '  return "target";',
                '}',
            ].join('\n'), 'utf8');
            fs.writeFileSync(path.join(repoPath, otherPath), [
                'export function prepareTrackedRootForRead() {',
                '  return "other";',
                '}',
            ].join('\n'), 'utf8');
            const symbols = await writeSearchSymbolRegistryForFiles({
                repoPath,
                files: [{
                    relativePath: targetPath,
                    content: fs.readFileSync(path.join(repoPath, targetPath), 'utf8'),
                    chunks: [{
                        content: 'export function prepareTrackedRootForRead() { return "target"; }',
                        startLine: 1,
                        endLine: 3,
                        symbolLabel: 'function prepareTrackedRootForRead()',
                    }],
                }, {
                    relativePath: otherPath,
                    content: fs.readFileSync(path.join(repoPath, otherPath), 'utf8'),
                    chunks: [{
                        content: 'export function prepareTrackedRootForRead() { return "other"; }',
                        startLine: 1,
                        endLine: 3,
                        symbolLabel: 'function prepareTrackedRootForRead()',
                    }],
                }],
            });
            const targetSymbols = symbols.filter((symbol) => symbol.file === targetPath);
            const owner = targetSymbols.find((symbol) => symbol.name === 'prepareTrackedRootForRead');
            assert.ok(owner);

            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                throw new Error('semanticSearch should not run for path-scoped exact registry hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: `path:${targetPath} prepareTrackedRootForRead`,
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.file, targetPath);
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.candidateSet, 'path_exact_file');
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.inspectedSymbolCount, targetSymbols.length);
        });
    });
});

test('handleSearchCode exact registry miss still allows bounded tracked lexical recovery', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            const registryPath = 'src/unrelated.ts';
            const lexicalPath = 'src/constants.ts';
            const registryContent = 'export function unrelatedSymbol() { return true; }';
            const lexicalContent = 'export const missingExactIdentifier = true;';
            fs.writeFileSync(path.join(repoPath, registryPath), registryContent, 'utf8');
            fs.writeFileSync(path.join(repoPath, lexicalPath), lexicalContent, 'utf8');
            await writeSearchSymbolRegistry({
                repoPath,
                relativePath: registryPath,
                content: registryContent,
                chunks: [{
                    content: registryContent,
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function unrelatedSymbol()',
                }],
            });

            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [];
            };
            (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => [lexicalPath];

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'missingExactIdentifier',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 1);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.status, 'miss');
            assert.equal(payload.hints?.debugSearch?.trackedLexical?.enabled, true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('expanded'), false);
            assert.equal(payload.results[0].target.file, lexicalPath);
            assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('lexical_files'), true);
        });
    });
});

test('handleSearchCode tracked lexical recovery reads active ignore patterns once per request', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            const registryPath = 'src/unrelated.ts';
            const trackedPaths = ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'];
            fs.writeFileSync(path.join(repoPath, registryPath), 'export function unrelatedSymbol() { return true; }', 'utf8');
            fs.writeFileSync(path.join(repoPath, trackedPaths[0]), 'export const alpha = true;', 'utf8');
            fs.writeFileSync(path.join(repoPath, trackedPaths[1]), 'export const missingExactIdentifier = true;', 'utf8');
            fs.writeFileSync(path.join(repoPath, trackedPaths[2]), 'export const gamma = true;', 'utf8');
            await writeSearchSymbolRegistry({
                repoPath,
                relativePath: registryPath,
                content: fs.readFileSync(path.join(repoPath, registryPath), 'utf8'),
                chunks: [{
                    content: 'export function unrelatedSymbol() { return true; }',
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function unrelatedSymbol()',
                }],
            });

            let getActiveIgnorePatternsCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => [];
            (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => trackedPaths;
            (handlers as unknown as ToolHandlersTestOverrides).context.getActiveIgnorePatterns = () => {
                getActiveIgnorePatternsCalls += 1;
                return ['node_modules/**'];
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'missingExactIdentifier',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.file, trackedPaths[1]);
            assert.equal(getActiveIgnorePatternsCalls, 1);
        });
    });
});

test('handleSearchCode tracked lexical recovery short-circuits exact-ish line scoring', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const registryPath = 'src/unrelated.ts';
            const lexicalPath = 'src/large.ts';
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, registryPath), 'export function unrelatedSymbol() { return true; }', 'utf8');
            const lexicalLines = [
                'export const filler_0 = true;',
                'export const missingExactIdentifier = true;',
                ...Array.from({ length: 250 }, (_, index) => `export const filler_${index + 1} = ${index};`),
            ];
            const lexicalContent = lexicalLines.join('\n');
            fs.writeFileSync(path.join(repoPath, lexicalPath), lexicalContent, 'utf8');
            await writeSearchSymbolRegistry({
                repoPath,
                relativePath: registryPath,
                content: fs.readFileSync(path.join(repoPath, registryPath), 'utf8'),
                chunks: [{
                    content: 'export function unrelatedSymbol() { return true; }',
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function unrelatedSymbol()',
                }],
            });

            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => [];
            (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => [lexicalPath];

            const searchQuerySupport = (handlers as unknown as {
                searchQuerySupport: {
                    scoreCandidateLexicalEvidence: (plan: unknown, result: unknown) => unknown;
                };
            }).searchQuerySupport;
            const originalScoreCandidateLexicalEvidence = searchQuerySupport.scoreCandidateLexicalEvidence.bind(searchQuerySupport);
            let scoreCandidateCalls = 0;
            searchQuerySupport.scoreCandidateLexicalEvidence = (plan, result) => {
                scoreCandidateCalls += 1;
                return originalScoreCandidateLexicalEvidence(plan, result);
            };
            const originalSplit = String.prototype.split;
            let trackedNewlineSplitCalls = 0;
            String.prototype.split = function(this: string, separator: string | RegExp, limit?: number): string[] {
                const isTrackedLexicalContent = String(this) === lexicalContent;
                const isLineSplit = separator instanceof RegExp && separator.source === '\\r?\\n';
                if (isTrackedLexicalContent && isLineSplit) {
                    trackedNewlineSplitCalls += 1;
                }
                return originalSplit.call(this, separator as string & RegExp, limit);
            };

            let response;
            try {
                response = await handlers.handleSearchCode({
                    path: repoPath,
                    query: 'missingExactIdentifier',
                    scope: 'runtime',
                    resultMode: 'grouped',
                    groupBy: 'symbol',
                    limit: 5,
                    debugMode: 'full',
                });
            } finally {
                String.prototype.split = originalSplit;
            }

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.file, lexicalPath);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
            assert.equal(scoreCandidateCalls <= 3, true);
            assert.equal(trackedNewlineSplitCalls, 0);
        });
    });
});

test('handleSearchCode exact symbolInstanceId fast path only uses current registry ids', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/runtime.ts';
            const content = 'export function cli_entry_point() { return true; }';
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const symbols = await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                language: 'typescript',
                chunks: [{
                    content,
                    startLine: 1,
                    endLine: 1,
                    symbolLabel: 'function cli_entry_point()',
                }],
            });
            const owner = symbols.find((symbol) => symbol.name === 'cli_entry_point');
            assert.ok(owner);

            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                throw new Error('semanticSearch should not run for exact symbolInstanceId hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: owner.symbolInstanceId,
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.reason, 'symbol_instance_id');
        });
    });
});

test('handleSearchCode uses must-only exact identifier queries for exact registry lookup', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/cli/main.py';
            const content = [
                'def cli_entry_point():',
                '    return 0',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src/cli'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const symbols = await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                language: 'python',
                chunks: [{
                    content,
                    startLine: 1,
                    endLine: 2,
                    symbolLabel: 'function cli_entry_point()',
                }],
            });
            const owner = symbols.find((symbol) => symbol.name === 'cli_entry_point');
            assert.ok(owner);

            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                throw new Error('semanticSearch should not run for must-only exact identifier hits');
            };
            (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => {
                throw new Error('tracked lexical scan should not run for must-only exact identifier hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'must:cli_entry_point',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 1,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 0);
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].target.file, relativePath);
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.equal(payload.hints?.debugSearch?.queryIntent?.semanticQuery, 'cli_entry_point');
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('exact_registry'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('primary'), false);
        });
    });
});

test('handleSearchCode ambiguous structural ownership falls back to existing semantic search path', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, 'src/stack.ts'), 'export function runTask() { return "stack"; }', 'utf8');
            fs.writeFileSync(path.join(repoPath, 'src/builder.ts'), 'export function runTask() { return "builder"; }', 'utf8');
            await writeSearchSymbolRegistryForFiles({
                repoPath,
                files: [{
                    relativePath: 'src/stack.ts',
                    content: fs.readFileSync(path.join(repoPath, 'src/stack.ts'), 'utf8'),
                    chunks: [{
                        content: 'export function runTask() { return "stack"; }',
                        startLine: 1,
                        endLine: 1,
                        symbolLabel: 'function runTask()',
                    }],
                }, {
                    relativePath: 'src/builder.ts',
                    content: fs.readFileSync(path.join(repoPath, 'src/builder.ts'), 'utf8'),
                    chunks: [{
                        content: 'export function runTask() { return "builder"; }',
                        startLine: 1,
                        endLine: 1,
                        symbolLabel: 'function runTask()',
                    }],
                }],
            });
            let semanticSearchCalls = 0;
            const handlers = createHandlers(repoPath, [{
                content: 'export function runTask() { return "stack"; }',
                relativePath: 'src/stack.ts',
                startLine: 1,
                endLine: 1,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_runTask',
                symbolLabel: 'function runTask()',
            }]);
            (handlers as unknown as ToolHandlersTestOverrides).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [{
                    content: 'export function runTask() { return "stack"; }',
                    relativePath: 'src/stack.ts',
                    startLine: 1,
                    endLine: 1,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'legacy_runTask',
                    symbolLabel: 'function runTask()',
                }];
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'who owns runTask',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 1);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.status, 'ambiguous');
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('primary'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('expanded'), false);
        });
    });
});

test('sortGroupedSearchResults preserves exactMatchPinned provenance when exact pinning changes the grouped winner', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const grouped = [
            {
                kind: 'group',
                groupId: 'grp_helper',
                file: 'packages/mcp/src/core/helper.ts',
                span: { startLine: 1, endLine: 1 },
                language: 'typescript',
                symbolLabel: 'function emitWarning()',
                score: 5,
                indexedAt: '2026-01-01T00:30:00.000Z',
                stalenessBucket: 'fresh',
                collapsedChunkCount: 1,
                confidence: 'medium',
                callGraphHint: { supported: false, reason: 'missing_symbol' },
                preview: 'export function emitWarning() {}',
                __exactLexicalMatch: false,
                debug: {
                    representativeChunkCount: 1,
                    pathCategory: 'core',
                    pathMultiplier: 1.1,
                    topChunkScore: 5,
                    lexicalScore: 0.2,
                    changedFilesMultiplier: 1,
                    agentFitMultiplier: 1,
                    agentFitReason: 'neutral',
                    matchesMust: true,
                    exactLexicalMatch: false,
                    symbolAggregation: {
                        ownerSource: 'fallback',
                        evidenceChunkCount: 1,
                        supportBoost: 0,
                    },
                    provenance: {
                        retrievalPasses: ['primary'],
                        backendScoreKinds: ['unknown'],
                        semanticCandidate: true,
                        lexicalCandidate: false,
                        rerankAdjusted: false,
                        exactMatchPinned: false,
                        ownerRepairApplied: false,
                    },
                },
            },
            {
                kind: 'group',
                groupId: 'grp_exact',
                file: 'docs/exact.md',
                span: { startLine: 1, endLine: 1 },
                language: 'markdown',
                symbolLabel: 'const SEARCH_PARTIAL_INDEX',
                score: 1,
                indexedAt: '2026-01-01T00:30:00.000Z',
                stalenessBucket: 'fresh',
                collapsedChunkCount: 1,
                confidence: 'low',
                callGraphHint: { supported: false, reason: 'missing_symbol' },
                preview: 'const SEARCH_PARTIAL_INDEX = true;',
                __exactLexicalMatch: true,
                debug: {
                    representativeChunkCount: 1,
                    pathCategory: 'docs',
                    pathMultiplier: 0.9,
                    topChunkScore: 1,
                    lexicalScore: 0.5,
                    changedFilesMultiplier: 1,
                    agentFitMultiplier: 1,
                    agentFitReason: 'neutral',
                    matchesMust: true,
                    exactLexicalMatch: true,
                    symbolAggregation: {
                        ownerSource: 'fallback',
                        evidenceChunkCount: 1,
                        supportBoost: 0,
                    },
                    provenance: {
                        retrievalPasses: ['primary'],
                        backendScoreKinds: ['unknown'],
                        semanticCandidate: true,
                        lexicalCandidate: false,
                        rerankAdjusted: false,
                        exactMatchPinned: false,
                        ownerRepairApplied: false,
                    },
                },
            },
        ] as SortableGroupedSearchResult[];

        const applied = (handlers as unknown as ToolHandlersTestOverrides).sortGroupedSearchResults(grouped, true);
        assert.equal(applied, true);
        assert.equal(grouped[0].file, 'docs/exact.md');
        assert.equal(grouped[0].debug?.provenance?.exactMatchPinned, true);
    });
});

test('handleSearchCode debug exposes tracked lexical scan caps when the bounded file scan truncates recovery', async () => {
    await withTempRepo(async (repoPath) => {
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        const trackedPaths = Array.from({ length: 129 }, (_, index) => {
            const relativePath = `src/file-${String(index).padStart(3, '0')}.ts`;
            fs.writeFileSync(
                path.join(repoPath, relativePath),
                `export const TRACKED_NEEDLE_${index} = "trackedneedle";\n`,
                'utf8',
            );
            return relativePath;
        });

        const handlers = createHandlers(repoPath, []);
        (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => trackedPaths;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is TRACKED_NEEDLE emitted',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 20,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.trackedPathCount, 129);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.filesConsidered, 128);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.filesScanned, 128);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.cappedByFiles, true);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.cappedByBytes, false);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.returnedResults, 16);
    });
});

test('handleSearchCode tracked lexical supplement respects ignore rules and deterministic operators', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/path-scoped.test.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, relativePath),
            [
                'describe("tracked lexical evidence", () => {',
                '  it("keeps exact span metadata", () => {',
                '    const span = { startLine: 7, endColumn: 42 };',
                '    assert.equal(span.endColumn, 42);',
                '  });',
                '});',
            ].join('\n'),
            'utf8',
        );

        const cases = [
            {
                name: 'active ignore rule',
                query: `path:${relativePath} endColumn`,
                ignorePatterns: [relativePath],
            },
            {
                name: 'lang operator',
                query: `lang:javascript path:${relativePath} endColumn`,
            },
            {
                name: 'exclude path operator',
                query: `path:${relativePath} -path:${relativePath} endColumn`,
            },
            {
                name: 'exclude token operator',
                query: `path:${relativePath} exclude:endColumn endColumn`,
            },
            {
                name: 'must token operator',
                query: `path:${relativePath} must:missing endColumn`,
            },
        ];

        for (const testCase of cases) {
            const handlers = createHandlers(repoPath, []);
            (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => [relativePath];
            (handlers as unknown as ToolHandlersTestOverrides).context.getActiveIgnorePatterns = () => testCase.ignorePatterns || [];

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: testCase.query,
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok', testCase.name);
            assert.equal(payload.results.length, 0, testCase.name);
            assert.equal(payload.hints?.debugSearch?.trackedLexical?.enabled, true, testCase.name);
        }
    });
});

test('handleSearchCode ignores tracked lexical paths that resolve outside the repo root', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => ['../escape.ts'];

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'path:src/path-scoped.test.ts endColumn',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 0);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.trackedPathCount, 1);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.filesConsidered, 0);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.filesScanned, 0);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.returnedResults, 0);
    });
});

test('handleSearchCode does not read tracked lexical symlinks whose targets are outside the repo root', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/external.ts';
        const outsidePath = path.join(path.dirname(repoPath), 'external-secret.ts');
        fs.writeFileSync(outsidePath, 'export const EXTERNAL_TRACKED_SECRET = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.symlinkSync(outsidePath, path.join(repoPath, relativePath));

        const handlers = createHandlers(repoPath, []);
        (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => [relativePath];

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: `path:${relativePath} EXTERNAL_TRACKED_SECRET`,
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 0);
        assert.equal(payload.hints?.debugSearch?.trackedLexical?.filesScanned, 0);
    });
});

test('handleSearchCode does not promote broad file-owned evidence to a nested outline symbol', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/stack.rs';
            const content = [
                'pub struct Stack { value: i32 }',
                '',
                'impl Stack {',
                '  pub fn new() -> Self { Stack { value: 0 } }',
                '  pub fn push(&mut self, value: i32) { self.value = value; }',
                '}',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const { symbols } = await writeSearchNavigationSidecars({
                repoPath,
                relativePath,
                content,
                language: 'rust',
                chunks: [{ content, startLine: 1, endLine: 6 }],
                extractedSymbols: [
                    { kind: 'type', name: 'Stack', label: 'type Stack', qualifiedName: 'Stack', span: { startLine: 1, endLine: 1 } },
                    { kind: 'method', name: 'new', label: 'method new', qualifiedName: 'Stack.new', parentQualifiedNamePath: ['type Stack'], span: { startLine: 4, endLine: 4 } },
                    { kind: 'method', name: 'push', label: 'method push', qualifiedName: 'Stack.push', parentQualifiedNamePath: ['type Stack'], span: { startLine: 5, endLine: 5 } },
                ],
            });
            const fileOwner = symbols.find((symbol) => symbol.kind === 'file');
            const push = symbols.find((symbol) => symbol.kind === 'method' && symbol.name === 'push');
            assert.ok(fileOwner);
            assert.ok(push);
            const handlers = createHandlers(repoPath, [{
                content,
                relativePath,
                startLine: 1,
                endLine: 6,
                language: 'rust',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_stack_file_chunk',
                symbolKind: 'file',
                ownerSymbolKey: fileOwner.symbolKey,
                ownerSymbolInstanceId: fileOwner.symbolInstanceId,
            }]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'push Stack',
                scope: 'mixed',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 3,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, undefined);
            assert.deepEqual(payload.results[0].target.span, { startLine: 1, endLine: 6 });
            assert.equal(payload.results[0].symbolKind, 'file');
            assert.equal(payload.results[0].navigation.graph, 'missing_symbol');
            assert.equal(payload.results[0].nextActions, undefined);
            assert.equal(payload.results[0].navigationFallback, undefined);
            assert.equal(payload.results[0].debug?.symbolAggregation?.ownerSource, 'fallback');
        });
    });
});

test('handleSearchCode does not repair file-owner chunks to arbitrary nested methods for broad type queries', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/stack.rs';
            const content = [
                'pub struct Stack { value: i32 }',
                '',
                'impl Stack {',
                '  pub fn new() -> Self { Stack { value: 0 } }',
                '  pub fn push(&mut self, value: i32) { self.value = value; }',
                '}',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const { symbols } = await writeSearchNavigationSidecars({
                repoPath,
                relativePath,
                content,
                language: 'rust',
                chunks: [{ content, startLine: 1, endLine: 6 }],
                extractedSymbols: [
                    { kind: 'type', name: 'Stack', label: 'type Stack', qualifiedName: 'Stack', span: { startLine: 1, endLine: 1 } },
                    { kind: 'method', name: 'new', label: 'method new', qualifiedName: 'Stack.new', parentQualifiedNamePath: ['type Stack'], span: { startLine: 4, endLine: 4 } },
                    { kind: 'method', name: 'push', label: 'method push', qualifiedName: 'Stack.push', parentQualifiedNamePath: ['type Stack'], span: { startLine: 5, endLine: 5 } },
                ],
            });
            const fileOwner = symbols.find((symbol) => symbol.kind === 'file');
            const stack = symbols.find((symbol) => symbol.kind === 'type' && symbol.name === 'Stack');
            assert.ok(fileOwner);
            assert.ok(stack);
            const handlers = createHandlers(repoPath, [{
                content,
                relativePath,
                startLine: 1,
                endLine: 6,
                language: 'rust',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_stack_file_chunk',
                symbolKind: 'file',
                ownerSymbolKey: fileOwner.symbolKey,
                ownerSymbolInstanceId: fileOwner.symbolInstanceId,
            }]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'Stack',
                scope: 'mixed',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 3,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, stack.symbolInstanceId);
            assert.equal(payload.results[0].symbolKind, 'type');
            assert.notEqual(payload.results[0].displayLabel, 'method new');
            assert.notEqual(payload.results[0].displayLabel, 'method push');
        });
    });
});

test('handleSearchCode does not repair ambiguous broad file-owner matches to executable methods', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/warnings.ts';
            const content = [
                'export function warningLogin() {',
                '  return "login warning";',
                '}',
                '',
                'export function warningLogout() {',
                '  return "logout warning";',
                '}',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const { symbols } = await writeSearchNavigationSidecars({
                repoPath,
                relativePath,
                content,
                chunks: [{ content, startLine: 1, endLine: 7 }],
                extractedSymbols: [
                    { kind: 'function', name: 'warningLogin', label: 'function warningLogin()', qualifiedName: 'warningLogin', span: { startLine: 1, endLine: 3 } },
                    { kind: 'function', name: 'warningLogout', label: 'function warningLogout()', qualifiedName: 'warningLogout', span: { startLine: 5, endLine: 7 } },
                ],
            });
            const fileOwner = symbols.find((symbol) => symbol.kind === 'file');
            assert.ok(fileOwner);
            const handlers = createHandlers(repoPath, [{
                content,
                relativePath,
                startLine: 1,
                endLine: 7,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_warning_file_chunk',
                symbolKind: 'file',
                ownerSymbolKey: fileOwner.symbolKey,
                ownerSymbolInstanceId: fileOwner.symbolInstanceId,
            }]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'warning',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 3,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, undefined);
            assert.equal(payload.results[0].symbolKind, 'file');
            assert.equal(payload.results[0].navigation.graph, 'missing_symbol');
            assert.equal(payload.results[0].debug?.symbolAggregation?.ownerSource, 'fallback');
        });
    });
});

test('handleSearchCode does not emit method graph hints from weak graph-capable file-owner repair', async () => {
    await withTempStateRoot(async () => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/runtime.ts';
            const content = [
                'export function emitLogin() {',
                '  return "warning";',
                '}',
                '',
                'export function emitLogout() {',
                '  return "done";',
                '}',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content, 'utf8');
            const { symbols } = await writeSearchNavigationSidecars({
                repoPath,
                relativePath,
                content,
                chunks: [{ content, startLine: 1, endLine: 7 }],
                extractedSymbols: [
                    { kind: 'function', name: 'emitLogin', label: 'function emitLogin()', qualifiedName: 'emitLogin', span: { startLine: 1, endLine: 3 } },
                    { kind: 'function', name: 'emitLogout', label: 'function emitLogout()', qualifiedName: 'emitLogout', span: { startLine: 5, endLine: 7 } },
                ],
            });
            const fileOwner = symbols.find((symbol) => symbol.kind === 'file');
            const emitLogin = symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'emitLogin');
            assert.ok(fileOwner);
            assert.ok(emitLogin);
            const handlers = createHandlers(repoPath, [{
                content,
                relativePath,
                startLine: 1,
                endLine: 7,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_file_chunk',
                symbolKind: 'file',
                ownerSymbolKey: fileOwner.symbolKey,
                ownerSymbolInstanceId: fileOwner.symbolInstanceId,
            }]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'warning',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 3,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, undefined);
            assert.equal(payload.results[0].symbolKind, 'file');
            assert.equal(payload.results[0].navigation.graph, 'missing_symbol');
            assert.notEqual(payload.results[0].target.symbolId, emitLogin.symbolInstanceId);
            assert.equal(payload.results[0].debug?.symbolAggregation?.ownerSource, 'fallback');
        });
    });
});

test('handleSearchCode grouped symbol mode disables call graph hints when relationship sidecar is incompatible', async () => {
    await withTempStateRoot(async (stateRoot) => {
        await withTempRepo(async (repoPath) => {
            const relativePath = 'src/auth.ts';
            const content = [
                'export class AuthService {',
                '  login(token: string) {',
                '    return token.trim();',
                '  }',
                '}',
                '',
            ].join('\n');
            fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoPath, relativePath), content);
            const symbols = await writeSearchSymbolRegistry({
                repoPath,
                relativePath,
                content,
                chunks: [{
                    content: 'login(token: string) { return token.trim(); }',
                    startLine: 2,
                    endLine: 4,
                    symbolLabel: 'method login(token: string)',
                    breadcrumbs: ['class AuthService', 'method login(token: string)'],
                }],
            });
            const owner = symbols.find((symbol) => symbol.kind === 'method');
            assert.ok(owner);

            const navigationRoot = resolveNavigationSidecarRoot(stateRoot, repoPath);
            fs.writeFileSync(
                path.join(navigationRoot, 'relationships', 'manifest.json'),
                JSON.stringify({
                    schemaVersion: 'relationship_v1',
                    symbolRegistryManifestHash: 'wrong-manifest-hash',
                    relationshipVersion: 'test-relationships-v1',
                    builtAt: '2026-01-01T00:00:00.000Z',
                }),
                'utf8'
            );

            const handlers = createHandlers(repoPath, [{
                content: 'return token.trim();',
                relativePath,
                startLine: 3,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_chunk_symbol_a',
                symbolLabel: 'method login(token: string)',
            }]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'login token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
            assert.equal(payload.results[0].navigation.graph, 'incompatible_relationship_sidecar');
            assert.equal(payload.results[0].recommendedNextAction, undefined);
            assert.equal(payload.recommendedNextAction?.tool, 'read_file');
            assert.equal(payload.recommendedNextAction?.args?.open_symbol?.symbolId, owner.symbolInstanceId);
            assert.ok(warningCodes(payload).includes('SEARCH_RELATIONSHIP_SIDECAR_UNAVAILABLE:incompatible'));
        });
    });
});

test('handleSearchCode grouped symbol mode does not require registry when owner metadata is complete', async () => {
    await withTempStateRoot(async (stateRoot) => {
        await withTempRepo(async (repoPath) => {
            const rootPath = resolveNavigationSidecarRoot(stateRoot, repoPath);
            fs.mkdirSync(rootPath, { recursive: true });
            fs.writeFileSync(path.join(rootPath, 'manifest.json'), '{"schemaVersion":"wrong"}\n');

            const handlers = createHandlers(repoPath, [
                {
                    content: 'return token.trim();',
                    relativePath: 'src/auth.ts',
                    startLine: 10,
                    endLine: 12,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'legacy_chunk_symbol_a',
                    symbolLabel: 'method login(token: string)',
                    ownerSymbolKey: 'owner_auth_login_key',
                    ownerSymbolInstanceId: 'owner_auth_login_instance',
                    symbolKind: 'method',
                },
                {
                    content: 'return session.issue(token);',
                    relativePath: 'src/auth.ts',
                    startLine: 13,
                    endLine: 16,
                    language: 'typescript',
                    score: 0.97,
                    indexedAt: '2026-01-01T00:31:00.000Z',
                    symbolId: 'legacy_chunk_symbol_b',
                    symbolLabel: 'method login(token: string)',
                    ownerSymbolKey: 'owner_auth_login_key',
                    ownerSymbolInstanceId: 'owner_auth_login_instance',
                    symbolKind: 'method',
                },
            ]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'login token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debugMode: 'full',
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].evidenceChunks, 2);
            assert.equal(payload.results[0].target.symbolId, undefined);
            assert.equal(payload.results[0].navigation.graph, 'incompatible_symbol_registry');
            assert.equal(payload.results[0].debug.symbolAggregation.ownerSource, 'owner_metadata');
            assert.equal(payload.results[0].nextActions, undefined);
            assert.equal(payload.results[0].navigationFallback, undefined);
            assert.equal(payload.results[0].recommendedNextAction, undefined);
            assert.equal(payload.results[0].fallbacks, undefined);
            assert.equal(payload.recommendedNextAction?.tool, 'read_file');
        });
    });
});

test('handleSearchCode grouped symbol mode requires reindex for incompatible symbol registry repair state', async () => {
    await withTempStateRoot(async (stateRoot) => {
        await withTempRepo(async (repoPath) => {
            const rootPath = resolveNavigationSidecarRoot(stateRoot, repoPath);
            fs.mkdirSync(rootPath, { recursive: true });
            fs.writeFileSync(path.join(rootPath, 'manifest.json'), '{"schemaVersion":"wrong"}\n');

            const handlers = createHandlers(repoPath, [{
                content: 'const normalized = token.trim();',
                relativePath: 'src/auth.ts',
                startLine: 3,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_chunk_symbol_a',
                symbolLabel: 'method login(token: string)',
            }]);

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'login token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'requires_reindex');
            assert.equal(payload.reason, 'requires_reindex');
            assert.equal(payload.results.length, 0);
            assert.match(payload.message, /Symbol registry is incompatible/);
            assert.deepEqual(payload.hints.reindex.args, { action: 'reindex', path: repoPath });
        });
    });
});

test('handleSearchCode keeps same-label declaration groups separate when owner symbols differ', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function helper() { return "source"; }',
                relativePath: 'src/helpers.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_helper_source',
                symbolLabel: 'function helper()',
                ownerSymbolKey: 'owner_helper_source_key',
                ownerSymbolInstanceId: 'owner_helper_source_instance',
                symbolKind: 'function',
            },
            {
                content: 'export function helper() { return "test"; }',
                relativePath: 'src/helpers.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:31:00.000Z',
                symbolId: 'legacy_helper_test',
                symbolLabel: 'function helper()',
                ownerSymbolKey: 'owner_helper_test_key',
                ownerSymbolInstanceId: 'owner_helper_test_instance',
                symbolKind: 'function',
            },
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'helper',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 2);
        const results = payload.results as Array<{ target: { span: { startLine: number; endLine: number } } }>;
        assert.deepEqual(
            results.map((result) => result.target.span.startLine).sort((left, right) => left - right),
            [1, 20]
        );
        assert.equal(results.every((result) => !('symbolId' in result.target)), true);
    });
});

test('handleSearchCode grouped output derives one envelope action from compact navigation facts', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_auth_validate',
            symbolLabel: 'method validateSession(token: string)'
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const result = payload.results[0];

        assert.equal(result.navigation.graph, 'missing_symbol');
        assert.equal(result.nextActions, undefined);
        assert.equal(result.navigationFallback, undefined);
        assert.deepEqual(payload.recommendedNextAction, {
            resultIndex: 0,
            tool: 'read_file',
            args: {
                path: path.resolve(repoPath, 'src/auth.ts'),
                start_line: 3,
                end_line: 6,
            },
            reason: 'Read the highest-ranked validated span before inferring symbol ownership.',
        });
        assert.equal(payload.hints?.navigation, undefined);
    });
});

test('handleSearchCode grouped output caps previews for compact default responses', async () => {
    await withTempRepo(async (repoPath) => {
        const longPreview = 'x'.repeat(1200);
        const handlers = createHandlers(repoPath, [{
            content: longPreview,
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_auth_validate',
            symbolLabel: 'method validateSession(token: string)'
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.doesNotMatch(payload.results[0].preview, /method validateSession\(token: string\)/);
        assert.match(payload.results[0].preview, /^x+/);
        assert.equal(Buffer.byteLength(payload.results[0].preview, 'utf8') <= 768, true);
        assert.equal(payload.results[0].preview.split('\n').length <= 5, true);
    });
});

test('handleSearchCode normalizes malformed labels and removes noisy duplicate preview lines', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: [
                '@cached',
                'function qap_spread_type(',
                'function qap_spread_type(',
                '  return qap_spread_type(frame)',
                '}',
                'function unrelatedOwner() {',
                '  return "neighbor";',
                '}',
            ].join('\n'),
            relativePath: 'src/spread.ts',
            startLine: 10,
            endLine: 18,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_qap_spread',
            symbolLabel: 'function qap_spread_type(',
            symbolKind: 'function',
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'qap_spread_type',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].displayLabel, 'function qap_spread_type');
        assert.doesNotMatch(payload.results[0].preview, /^function qap_spread_type$/m);
        assert.match(payload.results[0].preview, /return qap_spread_type\(frame\)/);
        assert.doesNotMatch(payload.results[0].preview, /@cached/);
        assert.doesNotMatch(payload.results[0].preview, /unrelatedOwner/);
        assert.equal((payload.results[0].preview.match(/function qap_spread_type/g) || []).length, 0);
    });
});

test('handleSearchCode compacts multiline signatures without leaking parameter fragments into previews', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: [
                'def check_survival(',
                '    hreshold_violated="ADF",',
                '    mi_2_given_1=None,',
                '    tau=None,',
                ') -> SurvivalCheck:',
                '    survives = hreshold_violated != "ADF"',
                '    return survives',
            ].join('\n'),
            relativePath: 'src/regime/jit_veto.py',
            startLine: 47,
            endLine: 157,
            language: 'python',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_check_survival',
            symbolLabel: 'function check_survival(',
            symbolKind: 'function',
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'check_survival',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].displayLabel, 'function check_survival');
        assert.doesNotMatch(payload.results[0].preview, /^function check_survival$/m);
        assert.match(payload.results[0].preview, /return survives/);
        assert.doesNotMatch(payload.results[0].preview, /^hreshold_violated="ADF",$/m);
        assert.doesNotMatch(payload.results[0].preview, /^.*mi_2_given_1/m);
        assert.doesNotMatch(payload.results[0].preview, /^\) -> SurvivalCheck:/m);
    });
});

test('handleSearchCode repairs registry-owned Python multiline spans before exposing navigation actions', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const relativePath = 'src/phases.py';
        const source = [
            'def previous_phase():',
            '    return _rename_outputs(signal)',
            '',
            'def _attach_entry_telemetry(',
            '    *,',
            '    signal=None,',
            '    entry_decision=None,',
            '    pending=None,',
            ') -> None:',
            '    telemetry = build_entry_telemetry(',
            '        signal=signal,',
            '        entry_decision=entry_decision,',
            '        pending=pending,',
            '    )',
            '    return telemetry',
            '',
            'def build_entry_telemetry(*, signal=None, entry_decision=None, pending=None):',
            '    return (signal, entry_decision, pending)',
            '',
        ].join('\n');
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, relativePath), source, 'utf8');

        const { symbols } = await writeSearchNavigationSidecars({
            repoPath,
            relativePath,
            content: source,
            language: 'python',
            chunks: [{
                content: source.split('\n').slice(1, 9).join('\n'),
                startLine: 2,
                endLine: 9,
                symbolLabel: 'function _attach_entry_telemetry(',
            }],
        });
        const owner = symbols.find((symbol) => symbol.name === '_attach_entry_telemetry');
        assert.ok(owner);
        assert.equal(owner.span.startLine, 2);
        assert.equal(owner.span.endLine, 9);

        const handlers = createHandlers(repoPath, [{
            content: source.split('\n').slice(1, 9).join('\n'),
            relativePath,
            startLine: 2,
            endLine: 9,
            language: 'python',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: owner.label,
            ownerSymbolKey: owner.symbolKey,
            ownerSymbolInstanceId: owner.symbolInstanceId,
            symbolKind: owner.kind,
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where attach entry telemetry is assembled',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].target.span.startLine, 4);
        assert.equal(payload.results[0].target.span.endLine, 15);
        assert.deepEqual(payload.results[0].evidenceSpan, { startLine: 4, endLine: 9 });
        assert.equal(payload.results[0].target.symbolId, owner.symbolInstanceId);
        assert.equal(payload.results[0].quality.owner, 'high');
        assert.equal(payload.results[0].navigation.graph, 'ready');
        assert.equal(payload.recommendedNextAction?.args?.open_symbol?.symbolId, owner.symbolInstanceId);
        assert.equal(payload.results[0].nextActions, undefined);
        assert.ok(warningCodes(payload).includes('SEARCH_SPAN_START_BEFORE_DEF'));
        assert.ok(warningCodes(payload).includes('SEARCH_TRUNCATED_SYMBOL_SPAN'));
    }));
});

test('handleSearchCode downgrades openSymbol capability when Python span validation fails', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const relativePath = 'src/phases.py';
        const currentSource = [
            'def renamed_owner(',
            '    *,',
            '    signal=None,',
            ') -> None:',
            '    return signal',
            '',
        ].join('\n');
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, relativePath), currentSource, 'utf8');

        const staleChunk = [
            'def _attach_entry_telemetry(',
            '    *,',
            '    signal=None,',
            '    pending=None,',
            ') -> None:',
            '    return signal',
        ].join('\n');
        const { symbols } = await writeSearchNavigationSidecars({
            repoPath,
            relativePath,
            content: currentSource,
            language: 'python',
            chunks: [{
                content: staleChunk,
                startLine: 1,
                endLine: 6,
                symbolLabel: 'function _attach_entry_telemetry(',
            }],
        });
        const owner = symbols.find((symbol) => symbol.name === '_attach_entry_telemetry');
        assert.ok(owner);

        const handlers = createHandlers(repoPath, [{
            content: staleChunk,
            relativePath,
            startLine: 1,
            endLine: 6,
            language: 'python',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: owner.label,
            ownerSymbolKey: owner.symbolKey,
            ownerSymbolInstanceId: owner.symbolInstanceId,
            symbolKind: owner.kind,
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'attach entry telemetry',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].target.span.startLine, 1);
        assert.equal(payload.results[0].target.span.endLine, 6);
        assert.equal(payload.results[0].quality.owner, 'medium');
        assert.equal(payload.results[0].capabilities, undefined);
        assert.ok(warningCodes(payload).includes('SEARCH_SYMBOL_SPAN_UNVERIFIED'));
    }));
});

test('handleSearchCode publishes compact ready state for supported graph handles', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const fileContent = [
            'export function build_entry_telemetry() {',
            '  return EntryTelemetry.create();',
            '}',
            '',
        ].join('\n');
        const { symbols } = await writeSearchNavigationSidecars({
            repoPath,
            relativePath: 'src/telemetry.ts',
            content: fileContent,
            chunks: [{
                content: 'return EntryTelemetry.create();',
                startLine: 1,
                endLine: 3,
                symbolLabel: 'function build_entry_telemetry()',
            }],
        });
        const owner = symbols.find((symbol) => symbol.kind !== 'file');
        assert.ok(owner);

        const handlers = createHandlers(repoPath, [{
            content: 'return EntryTelemetry.create();',
            relativePath: 'src/telemetry.ts',
            startLine: 1,
            endLine: 3,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: owner!.label,
            ownerSymbolKey: owner!.symbolKey,
            ownerSymbolInstanceId: owner!.symbolInstanceId,
            symbolKind: owner!.kind,
        }], undefined, { sidecarReady: false });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'build_entry_telemetry',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].navigation.graph, 'ready');
        assert.equal(payload.results[0].navigation.callerSearchTerm, 'build_entry_telemetry');
        assert.equal(payload.results[0].capabilities, undefined);
    }));
});

test('handleSearchCode downgrades stale search symbol refs to navigation fallback', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_stale_auth_validate',
            symbolLabel: 'method validateSession(token: string)'
        }], undefined, {
            sidecarNodes: [{
                symbolId: 'sym_current_auth_validate',
                symbolLabel: 'method validateSession(token: string)',
                file: 'src/auth.ts',
                language: 'typescript',
                span: { startLine: 30, endLine: 36 }
            }]
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const result = payload.results[0];

        assert.equal(result.navigation.graph, 'missing_symbol');
        assert.deepEqual(result.target.span, { startLine: 3, endLine: 6 });
        assert.equal(result.evidenceSpan, undefined);
        assert.equal(result.target.symbolId, undefined);
        assert.equal(result.nextActions, undefined);
        assert.equal(result.navigationFallback, undefined);
        assert.deepEqual(payload.recommendedNextAction?.args, {
            path: path.resolve(repoPath, 'src/auth.ts'),
            start_line: 3,
            end_line: 6,
        });
    });
});

test('handleSearchCode runtime scope includes tests but excludes docs and artifacts', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const run = () => true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.9,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: '# docs',
                relativePath: 'docs/runtime.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'describe("runtime", () => {})',
                relativePath: 'src/runtime.test.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'export const generated = true;',
                relativePath: 'dist/runtime.js',
                startLine: 1,
                endLine: 2,
                language: 'javascript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'implementation report',
                relativePath: 'reports/runtime-audit.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'export class RuntimeReportService {}',
                relativePath: 'src/reports/runtime-report-service.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'investigation notes',
                relativePath: 'investigations/runtime-notes.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'landing page code',
                relativePath: 'satori-landing/src/App.tsx',
                startLine: 1,
                endLine: 2,
                language: 'tsx',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.resultMode, 'raw');
        const files = payload.results.map((r: SearchPayloadResultView) => r.file).sort();
        assert.deepEqual(files, ['src/reports/runtime-report-service.ts', 'src/runtime.test.ts', 'src/runtime.ts']);
    });
});

test('handleSearchCode docs scope only returns docs (excludes tests)', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const run = () => true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.9,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: '# docs',
                relativePath: 'docs/runtime.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'export const docHelper = true;',
                relativePath: 'docs/runtime-helper.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'describe("runtime", () => {})',
                relativePath: 'src/runtime.test.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'docs',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const files = payload.results.map((r: SearchPayloadResultView) => r.file).sort();
        assert.deepEqual(files, ['docs/runtime-helper.ts', 'docs/runtime.md']);
        assert.ok(!files.includes('src/runtime.test.ts'));
        assert.ok(!files.includes('src/runtime.ts'));
    });
});

test('handleSearchCode parses operators from query prefix and applies deterministic filters', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'throw new Error("ERR_CODE_42");',
                relativePath: 'src/auth.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            },
            {
                content: 'ERR_CODE_42 explained in docs',
                relativePath: 'docs/auth.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs',
                symbolLabel: 'auth docs'
            },
            {
                content: 'legacy fallback',
                relativePath: 'src/legacy.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_legacy',
                symbolLabel: 'function legacy()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'lang:typescript path:"src/**" must:ERR_CODE_42 exclude:legacy\n\nauth failure',
            scope: 'mixed',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 10,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/auth.ts');
        assert.equal(warningCodes(payload).includes('FILTER_MUST_UNSATISFIED'), false);
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.lang?.[0], 'typescript');
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.path?.[0], 'src/**');
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.must?.[0], 'ERR_CODE_42');
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.exclude?.[0], 'legacy');
        assert.equal(payload.hints?.debugSearch?.mustRetry?.satisfied, true);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.finalCount, 1);
    });
});

test('handleSearchCode emits FILTER_MUST_UNSATISFIED after bounded retries', async () => {
    await withTempRepo(async (repoPath) => {
        const denseResults = Array.from({ length: 140 }, (_, idx) => ({
            content: `candidate ${idx}`,
            relativePath: `src/candidate-${idx}.ts`,
            startLine: 1,
            endLine: 2,
            language: 'typescript',
            score: 0.99 - (idx * 0.0001),
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: `sym_candidate_${idx}`,
            symbolLabel: `function candidate${idx}()`
        }));

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (...args: unknown[]) => denseResults.slice(0, parseSemanticSearchInvocation(args).topK)
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'must:NEVER_PRESENT runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 0);
        assert.ok(Array.isArray(payload.warnings));
        assert.equal(warningCodes(payload).includes('FILTER_MUST_UNSATISFIED'), true);
    });
});

test('handleSearchCode does not emit FILTER_MUST_UNSATISFIED when must succeeds after retry expansion', async () => {
    await withTempRepo(async (repoPath) => {
        const denseResults = Array.from({ length: 80 }, (_, idx) => ({
            content: idx === 40 ? 'contains NEEDLE_TOKEN' : `candidate ${idx}`,
            relativePath: `src/retry-${idx}.ts`,
            startLine: 1,
            endLine: 2,
            language: 'typescript',
            score: 0.99 - (idx * 0.0001),
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: `sym_retry_${idx}`,
            symbolLabel: `function retry${idx}()`
        }));

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (...args: unknown[]) => denseResults.slice(0, parseSemanticSearchInvocation(args).topK)
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'must:NEEDLE_TOKEN runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, 'src/retry-40.ts');
        assert.equal(warningCodes(payload).includes('FILTER_MUST_UNSATISFIED'), false);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.attempts, 2);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.satisfied, true);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.finalCount, 1);
    });
});

test('handleSearchCode grouped representative prefers must-matching chunk within the same symbol group', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function auth() { return "no token"; }',
                relativePath: 'src/auth.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            },
            {
                content: 'export function auth() { return "ERR_CODE_42"; }',
                relativePath: 'src/auth.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.80,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'must:ERR_CODE_42 auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, 'src/auth.ts');
        assert.equal(payload.results[0].target.span?.startLine, 20);
        assert.equal(payload.results[0].debug?.matchesMust, true);
        assert.match(payload.results[0].preview, /ERR_CODE_42/);
    });
});

test('handleSearchCode grouped diversity keeps multi-file coverage by default', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const a = 1;',
                relativePath: 'src/one.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one_a',
                symbolLabel: 'const a'
            },
            {
                content: 'export const b = 2;',
                relativePath: 'src/one.ts',
                startLine: 10,
                endLine: 12,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one_b',
                symbolLabel: 'const b'
            },
            {
                content: 'export const c = 3;',
                relativePath: 'src/one.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one_c',
                symbolLabel: 'const c'
            },
            {
                content: 'export const z = 9;',
                relativePath: 'src/two.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_two_z',
                symbolLabel: 'const z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'constants',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const files = payload.results.map((result: SearchPayloadResultView) => result.target?.file);
        assert.equal(files.includes('src/two.ts'), true);
        assert.equal(payload.hints?.debugSearch?.diversitySummary?.maxPerFile, 2);
        assert.equal(payload.hints?.debugSearch?.diversitySummary?.maxPerSymbol, 1);
    });
});

test('handleSearchCode grouped diversity keeps distinct symbol instances that share a symbol key', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function login(token: string) { return token.trim(); }',
                relativePath: 'src/auth.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_login_overload_a',
                symbolLabel: 'function login(token: string)',
                ownerSymbolKey: 'owner_login_key',
                ownerSymbolInstanceId: 'owner_login_instance_a',
                symbolKind: 'function',
            },
            {
                content: 'export function login(token: Buffer) { return token.toString(); }',
                relativePath: 'src/auth.ts',
                startLine: 5,
                endLine: 7,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:31:00.000Z',
                symbolId: 'legacy_login_overload_b',
                symbolLabel: 'function login(token: Buffer)',
                ownerSymbolKey: 'owner_login_key',
                ownerSymbolInstanceId: 'owner_login_instance_b',
                symbolKind: 'function',
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'login',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 2);
        assert.deepEqual(
            payload.results.map((result: SearchPayloadResultView) => result.target?.span.startLine),
            [1, 5]
        );
        assert.equal(payload.results.every((result: SearchPayloadResultView) => result.target?.symbolId === undefined), true);
    });
});

test('handleSearchCode applies changed-files boost in auto mode and skips boost in default mode', async () => {
    await withTempRepo(async (repoPath) => {
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'src', 'changed.ts'), 'export const changed = true;\n');
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const unchanged = true;',
                relativePath: 'src/unchanged.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unchanged',
                symbolLabel: 'const unchanged'
            },
            {
                content: 'export const changed = true;',
                relativePath: 'src/changed.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_changed',
                symbolLabel: 'const changed'
            }
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const autoResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });
        const autoPayload = JSON.parse(autoResponse.content[0]?.text || '{}');
        assert.equal(autoPayload.results[0].target.file, 'src/changed.ts');
        assert.equal(autoPayload.freshnessSummary.changedFileCount, 1);
        assert.equal(autoPayload.freshnessSummary.gitDirtyFilesConsidered, true);
        assert.equal(autoPayload.freshnessSummary.changedFilesBoostApplied, true);

        const defaultResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            rankingMode: 'default',
            limit: 2,
            debugMode: 'full'
        });
        const defaultPayload = JSON.parse(defaultResponse.content[0]?.text || '{}');
        const defaultChanged = defaultPayload.results.find((result: SearchPayloadResultView) => result.target?.file === 'src/changed.ts');
        assert.equal(defaultChanged?.debug?.changedFilesMultiplier, 1);
        assert.equal(defaultPayload.freshnessSummary.changedFileCount, 1);
        assert.equal(defaultPayload.freshnessSummary.gitDirtyFilesConsidered, true);
        assert.equal(defaultPayload.freshnessSummary.changedFilesBoostApplied, false);
    });
});

test('handleSearchCode probes changed files once per grouped search request', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const unchanged = true;',
                relativePath: 'src/unchanged.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unchanged',
                symbolLabel: 'const unchanged'
            },
            {
                content: 'export const changed = true;',
                relativePath: 'src/changed.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_changed',
                symbolLabel: 'const changed'
            }
        ]);

        let getChangedFilesCalls = 0;
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => {
            getChangedFilesCalls += 1;
            return {
                available: true,
                files: new Set(['src/changed.ts'])
            };
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            debugMode: 'full',
            limit: 2
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(getChangedFilesCalls, 1);
    });
});

test('handleSearchCode freshness summary only marks changed-files boost applied when a candidate was boosted', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const unchanged = true;',
                relativePath: 'src/unchanged.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unchanged',
                symbolLabel: 'const unchanged'
            }
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['src/dirty-but-not-returned.ts'])
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'unchanged symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            debugMode: 'full',
            limit: 2
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.freshnessSummary.changedFileCount, 1);
        assert.equal(payload.freshnessSummary.changedFilesBoostApplied, false);
        assert.equal(payload.hints.debugSearch.changedFilesBoost.enabled, true);
        assert.equal(payload.hints.debugSearch.changedFilesBoost.applied, false);
        assert.equal(payload.hints.debugSearch.changedFilesBoost.boostedCandidates, 0);
    });
});

test('handleSearchCode exposes freshness summary and warns when dirty files were not synced', async () => {
    await withTempRepo(async (repoPath) => {
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'src', 'changed.ts'), 'export const changed = true;\n');
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const changed = true;',
                relativePath: 'src/changed.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_changed',
                symbolLabel: 'const changed'
            }
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).syncManager = {
            ensureFreshness: async () => ({ mode: 'skipped_recent', changed: false })
        };
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.freshnessSummary.syncMode, 'skipped_recent');
        assert.equal(payload.freshnessSummary.lastSyncAt, null);
        assert.equal(payload.freshnessSummary.changedFileCount, 1);
        assert.equal(payload.freshnessSummary.gitDirtyFilesConsidered, true);
        assert.equal(payload.freshnessSummary.changedFilesBoostApplied, true);
        assert.equal(payload.freshnessSummary.changedFilesBoostSkippedForLargeChangeSet, false);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_WORKTREE_NOT_SYNCED'), true);
        assert.equal(payload.warnings[0].severity, 'caution');
        assert.match(payload.warnings[0].message, /dirty or untracked files may have changed after the last sync/i);
        assert.match(payload.warnings[0].action, /manage_index sync/);
    });
});

test('handleSearchCode preserves successful results when watcher maintenance fails', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'export const result = true;',
            relativePath: 'src/result.ts',
            startLine: 1,
            endLine: 1,
            language: 'typescript',
            score: 0.99,
            symbolId: 'sym_result',
            symbolLabel: 'const result',
        }]);
        (handlers as unknown as ToolHandlersTestOverrides).syncManager = {
            ensureFreshness: async () => ({ mode: 'skipped_recent', changed: false }),
            touchWatchedCodebase: async () => { throw new Error('watch boom'); },
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'result',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');

        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, 'src/result.ts');
    });
});

test('handleSearchCode supplements exact path-scoped dirty file evidence when indexed retrieval misses it', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/path-scoped.test.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, relativePath),
            [
                'const earlierFragment = { startLine: 1, endLine: 2 };',
                'test("captures exact span metadata", () => {',
                '    const span = { startLine: 7, endColumn: 42 };',
                '    assert.equal(span.endColumn, 42);',
                '});',
            ].join('\n')
        );

        const handlers = createHandlers(repoPath, [
            {
                content: 'const staleSpan = { startLine: 7, endLine: 9 };',
                relativePath,
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
            },
            {
                content: 'export const unrelated = true;',
                relativePath: 'src/unrelated.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unrelated',
                symbolLabel: 'const unrelated'
            }
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).syncManager = {
            ensureFreshness: async () => ({ mode: 'skipped_recent', changed: false })
        };
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set([relativePath])
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: `path:${relativePath} endColumn`,
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, relativePath);
        assert.match(payload.results[0].preview, /endColumn/);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_WORKTREE_NOT_SYNCED'), true);
    });
});

test('handleSearchCode replaces stale dirty-file candidates with current identifier evidence', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/dirty-owner.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, relativePath), [
            'export function FreshCurrentIdentifier(value: string) {',
            '    return value.trim();',
            '}',
            '',
        ].join('\n'));

        const handlers = createHandlers(repoPath, [{
            content: 'export function RemovedStaleIdentifier() { return false; }',
            relativePath,
            startLine: 20,
            endLine: 22,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_removed_stale',
            symbolLabel: 'function RemovedStaleIdentifier()',
        }]);
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set([relativePath]),
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'FreshCurrentIdentifier',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, relativePath);
        assert.equal(payload.results[0].displayLabel, 'function FreshCurrentIdentifier');
        assert.deepEqual(payload.results[0].target.span, { startLine: 1, endLine: 3 });
        assert.doesNotMatch(payload.results[0].preview, /RemovedStaleIdentifier/);
        assert.ok(payload.results[0].debug.provenance.retrievalPasses.includes('dirty_overlay'));
    });
});

test('handleSearchCode caps dirty path attempts before probing a later valid file', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/zz-current.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, relativePath), [
            'export function BoundedCurrentIdentifier() {',
            '    return true;',
            '}',
            '',
        ].join('\n'));
        const changedFiles = new Set<string>();
        for (let index = 0; index < 16; index += 1) {
            changedFiles.add(`src/${String(index).padStart(2, '0')}-missing.ts`);
        }
        changedFiles.add(relativePath);

        const handlers = createHandlers(repoPath, [{
            content: 'export function StaleIndexedIdentifier() { return false; }',
            relativePath,
            startLine: 20,
            endLine: 22,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
        }]);
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: changedFiles,
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'BoundedCurrentIdentifier',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 0);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_WORKTREE_NOT_SYNCED'), true);
    });
});

test('handleSearchCode warns when a suppressed dirty result has no current-source replacement', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/oversized-dirty.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, relativePath), `${'x'.repeat(300 * 1024)}\n`, 'utf8');
        const handlers = createHandlers(repoPath, [{
            content: 'export function staleDirtyOwner() { return true; }',
            relativePath,
            startLine: 1,
            endLine: 1,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_stale_dirty_owner',
            symbolLabel: 'function staleDirtyOwner()',
        }]);
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set([relativePath]),
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'staleDirtyOwner',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.some((result: { file?: string }) => result.file === relativePath), false);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_FILE_EVIDENCE_UNAVAILABLE'), true);
        const warning = payload.warnings.find((item: { code?: string }) => item.code === 'SEARCH_DIRTY_FILE_EVIDENCE_UNAVAILABLE');
        assert.match(warning?.action || '', /manage_index sync|read_file|narrow/i);
    });
});

test('handleSearchCode supplements exact path-scoped dirty file evidence after sync when indexed retrieval misses it', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/synced-path-scoped.test.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, relativePath),
            [
                'const earlierFragment = { startLine: 1, endLine: 2 };',
                'test("captures synced exact span metadata", () => {',
                '    const span = { startLine: 11, endColumn: 84 };',
                '    assert.equal(span.endColumn, 84);',
                '});',
            ].join('\n')
        );

        const handlers = createHandlers(repoPath, [
            {
                content: 'const staleSpan = { startLine: 11, endLine: 13 };',
                relativePath,
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
            }
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).syncManager = {
            ensureFreshness: async () => ({
                mode: 'synced',
                changed: true,
                stats: { added: 0, removed: 0, modified: 1 },
            })
        };
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set([relativePath])
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: `path:${relativePath} endColumn`,
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, relativePath);
        assert.match(payload.results[0].preview, /endColumn/);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_WORKTREE_NOT_SYNCED'), false);
        assert.equal(payload.hints.debugSearch.passesUsed.includes('live_path'), true);
    });
});

test('handleSearchCode does not read dirty live-path symlinks whose targets are outside the repo root', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/external-live.ts';
        const outsidePath = path.join(path.dirname(repoPath), 'external-live-secret.ts');
        fs.writeFileSync(outsidePath, 'export const EXTERNAL_LIVE_SECRET = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.symlinkSync(outsidePath, path.join(repoPath, relativePath));

        const handlers = createHandlers(repoPath, []);
        (handlers as unknown as ToolHandlersTestOverrides).syncManager = {
            ensureFreshness: async () => ({ mode: 'synced', changed: true, stats: { added: 0, removed: 0, modified: 1 } })
        };
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set([relativePath]),
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: `path:${relativePath} EXTERNAL_LIVE_SECRET`,
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 0);
    });
});

test('handleSearchCode supplements exact path-scoped tracked test evidence without dirty-file live path fallback', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/path-scoped.test.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, relativePath),
            [
                'describe("tracked lexical evidence", () => {',
                '  it("keeps exact span metadata", () => {',
                '    const span = { startLine: 7, endColumn: 42 };',
                '    assert.equal(span.endColumn, 42);',
                '  });',
                '});',
            ].join('\n'),
            'utf8'
        );

        const handlers = createHandlers(repoPath, [
            {
                content: 'export const unrelated = true;',
                relativePath: 'src/unrelated.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unrelated',
                symbolLabel: 'const unrelated',
            }
        ]);

        (handlers as unknown as ToolHandlersTestOverrides).context.getTrackedRelativePaths = () => [relativePath, 'src/unrelated.ts'];
        (handlers as unknown as ToolHandlersTestOverrides).syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        };
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set<string>()
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: `path:${relativePath} endColumn`,
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, relativePath);
        assert.match(payload.results[0].preview, /endColumn/);
        assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('live_path'), false);
        assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('live_path'), false);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_WORKTREE_NOT_SYNCED'), false);
    });
});

test('handleSearchCode uses real synchronizer tracked paths for exact path-scoped lexical evidence', async () => {
    await withTempRepo(async (repoPath) => {
        const relativePath = 'src/path-scoped-real.test.ts';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, relativePath),
            [
                'describe("tracked lexical evidence", () => {',
                '  it("keeps exact span metadata", () => {',
                '    const span = { startLine: 7, endColumn: 42 };',
                '    assert.equal(span.endColumn, 42);',
                '  });',
                '});',
            ].join('\n'),
            'utf8'
        );

        const context = createLocalOnlyContext({
            name: 'test',
            version: '0.0.0',
            executionProfile: 'connected',
            networkPolicy: { kind: 'remote-allowed' },
            vectorStoreProvider: 'Milvus',
            encoderProvider: 'VoyageAI',
            encoderModel: 'voyage-4-large',
            encoderOutputDimension: 1024,
            milvusEndpoint: 'http://127.0.0.1:19530',
        }) as unknown as MutableHandlerContext;
        await context.recreateSynchronizerForCodebase(repoPath);
        context.getActiveIndexedCollectionName = async () => context.resolveCollectionName(repoPath);
        context.getVectorStore = () => ({
            hasCollection: async () => true,
        }) as ReturnType<MutableHandlerContext['getVectorStore']>;
        context.semanticSearch = async () => ([
            {
                content: 'export const unrelated = true;',
                relativePath: 'src/unrelated.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unrelated',
                symbolLabel: 'const unrelated',
            }
        ]);

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES_NO_RERANK,
            () => Date.parse('2026-01-01T01:00:00.000Z')
        );
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({ outcome: 'valid' });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: `path:${relativePath} endColumn`,
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, relativePath);
        assert.match(payload.results[0].preview, /endColumn/);
        assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.semanticCandidate, false);
        assert.equal(payload.results[0].debug?.provenance?.lexicalCandidate, true);
    });
});

test('handleSearchCode debug exposes changed tracked symbols and direct callers from sidecar data', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'export function changed() { return true; }',
                    relativePath: 'src/changed.ts',
                    startLine: 1,
                    endLine: 3,
                    language: 'typescript',
                    score: 0.98,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_changed',
                    symbolLabel: 'function changed()'
                }
            ])
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const callGraphManager = {
            loadSidecar: () => ({
                nodes: [
                    {
                        symbolId: 'sym_changed',
                        symbolLabel: 'function changed()',
                        file: 'src/changed.ts',
                        language: 'typescript',
                        span: { startLine: 1, endLine: 3 }
                    },
                    {
                        symbolId: 'sym_caller',
                        symbolLabel: 'function caller()',
                        file: 'src/caller.ts',
                        language: 'typescript',
                        span: { startLine: 5, endLine: 7 }
                    }
                ],
                edges: [
                    {
                        srcSymbolId: 'sym_caller',
                        dstSymbolId: 'sym_changed',
                        kind: 'call',
                        site: { file: 'src/caller.ts', startLine: 6 },
                        confidence: 0.8
                    }
                ],
                notes: []
            })
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            DENSE_RUNTIME_FINGERPRINT,
            CAPABILITIES_NO_RERANK,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.deepEqual(payload.hints?.debugSearch?.changedCode?.files, ['src/changed.ts']);
        assert.deepEqual(payload.hints?.debugSearch?.changedCode?.symbols, [
            {
                file: 'src/changed.ts',
                symbolId: 'sym_changed',
                symbolLabel: 'function changed()',
                span: { startLine: 1, endLine: 3 }
            }
        ]);
        assert.deepEqual(payload.hints?.debugSearch?.changedCode?.directCallers, [
            {
                targetSymbolId: 'sym_changed',
                file: 'src/caller.ts',
                symbolId: 'sym_caller',
                symbolLabel: 'function caller()',
                span: { startLine: 5, endLine: 7 },
                site: { file: 'src/caller.ts', startLine: 6 },
                kind: 'call',
                confidence: 0.8
            }
        ]);
    });
});

test('handleSearchCode debug changed-code payload is capped with totals and truncation flag', async () => {
    await withTempRepo(async (repoPath) => {
        const changedFiles = Array.from({ length: 12 }, (_, index) => `src/changed-${index}.ts`);
        const changedNodes = Array.from({ length: 25 }, (_, index) => ({
            symbolId: `sym_changed_${index.toString().padStart(2, '0')}`,
            symbolLabel: `function changed_${index}(`,
            file: changedFiles[index % changedFiles.length],
            language: 'typescript',
            span: { startLine: index + 1, endLine: index + 2 }
        }));
        const callerNodes = Array.from({ length: 25 }, (_, index) => ({
            symbolId: `sym_caller_${index.toString().padStart(2, '0')}`,
            symbolLabel: `function caller_${index}()`,
            file: `src/caller-${index}.ts`,
            language: 'typescript',
            span: { startLine: index + 30, endLine: index + 31 }
        }));

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'export function changed_0() { return true; }',
                    relativePath: changedFiles[0],
                    startLine: 1,
                    endLine: 3,
                    language: 'typescript',
                    score: 0.98,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_changed_00',
                    symbolLabel: 'function changed_0()'
                }
            ])
        } as unknown as HandlerContext;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;
        const callGraphManager = {
            loadSidecar: () => ({
                nodes: [...changedNodes, ...callerNodes],
                edges: changedNodes.map((node, index) => ({
                    srcSymbolId: callerNodes[index].symbolId,
                    dstSymbolId: node.symbolId,
                    kind: 'call',
                    site: { file: callerNodes[index].file, startLine: index + 30 },
                    confidence: 0.8
                })),
                notes: []
            })
        } as unknown as HandlerCallGraphManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            DENSE_RUNTIME_FINGERPRINT,
            CAPABILITIES_NO_RERANK,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(changedFiles)
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const changedCode = payload.hints?.debugSearch?.changedCode;
        assert.equal(changedCode?.files.length, 10);
        assert.equal(changedCode?.symbols.length, 20);
        assert.equal(changedCode?.directCallers.length, 20);
        assert.equal(changedCode?.totalFiles, 12);
        assert.equal(changedCode?.totalSymbols, 25);
        assert.equal(changedCode?.totalDirectCallers, 25);
        assert.equal(changedCode?.truncated, true);
        assert.equal(payload.hints?.debugSummary?.changedCodeTruncated, true);
        assert.equal(changedCode?.symbols[0].symbolLabel, 'function changed_0');
    });
});

test('handleSearchCode auto_changed_first skips boost when changed file set exceeds threshold', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const unchanged = true;',
                relativePath: 'src/unchanged.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unchanged',
                symbolLabel: 'const unchanged'
            },
            {
                content: 'export const changed = true;',
                relativePath: 'src/changed.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_changed',
                symbolLabel: 'const changed'
            }
        ]);

        const changedPaths = new Set<string>();
        changedPaths.add('src/changed.ts');
        for (let i = 0; i < SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES; i++) {
            changedPaths.add(`src/extra-${i}.ts`);
        }

        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: changedPaths
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'src/unchanged.ts');
        assert.equal(payload.freshnessSummary.changedFileCount, SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES + 1);
        assert.equal(payload.freshnessSummary.gitDirtyFilesConsidered, true);
        assert.equal(payload.freshnessSummary.changedFilesBoostApplied, false);
        assert.equal(payload.freshnessSummary.changedFilesBoostSkippedForLargeChangeSet, true);
        assert.equal(warningCodes(payload).includes('SEARCH_CHANGED_FILES_BOOST_SKIPPED'), true);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.applied, false);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.changedCount, SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES + 1);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.maxChangedFilesForBoost, SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.skippedForLargeChangeSet, true);
    });
});

test('getChangedFilesForCodebase ignores untracked git status entries for deterministic boost input', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const parsed = (handlers as unknown as ToolHandlersTestOverrides).parseGitStatusChangedPaths([
            ' M src/changed.ts',
            'R  src/old.ts -> src/renamed.ts',
            '?? .satori/mcp-codebase-snapshot.json',
            '?? coverage/lcov.info',
        ].join('\n'));

        assert.deepEqual(Array.from(parsed).sort(), ['src/changed.ts', 'src/renamed.ts']);
    });
});

test('getChangedFilesForCodebase reuses stale cache on git status failure to avoid ranking flaps', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const cacheKey = path.resolve(repoPath);
        (handlers as unknown as ToolHandlersTestOverrides).changedFilesCache.set(cacheKey, {
            expiresAtMs: 0,
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const state = (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase(repoPath);
        assert.equal(state.available, true);
        assert.deepEqual(Array.from(state.files).sort(), ['src/changed.ts']);
    });
});

test('handleSearchCode policy mode skips reranker for docs scope even when capability is present', async () => {
    await withTempRepo(async (repoPath) => {
        let rerankCalls = 0;
        const reranker = {
            rerank: async () => {
                rerankCalls += 1;
                return [
                    { index: 1, relevanceScore: 0.9 },
                    { index: 0, relevanceScore: 0.8 }
                ];
            }
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'first docs',
                relativePath: 'docs/one.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs_one',
                symbolLabel: 'docs one'
            },
            {
                content: 'second docs',
                relativePath: 'docs/two.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs_two',
                symbolLabel: 'docs two'
            }
        ], reranker);

        const autoResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'docs query',
            scope: 'docs',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });
        const autoPayload = JSON.parse(autoResponse.content[0]?.text || '{}');
        assert.equal(rerankCalls, 0);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.rerankerPresent, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.skippedByScopeDocs, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.applied, false);
    });
});

test('handleSearchCode debug exposes missing reranker capability without warning noise', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'runtime one',
                relativePath: 'src/one.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one',
                symbolLabel: 'one'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debugMode: 'full'
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.warnings, undefined);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.capabilityPresent, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.rerankerPresent, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, false);
    });
});

test('handleSearchCode reranks family-diverse candidates and exposes the adaptive budget', async () => {
    await withTempRepo(async (repoPath) => {
        let rerankDocuments: string[] = [];
        const reranker = {
            rerank: async (_query: string, documents: string[]) => {
                rerankDocuments = documents;
                return documents.map((_document, index) => ({ index, relevanceScore: 1 - (index * 0.01) }));
            }
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'primary runtime behavior',
                relativePath: 'src/owner-a-primary.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'chunk_owner_a_primary',
                symbolLabel: 'ownerA',
                ownerSymbolKey: 'owner_a_key',
                ownerSymbolInstanceId: 'owner_a_instance'
            },
            {
                content: 'duplicate runtime behavior',
                relativePath: 'src/owner-a-duplicate.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'chunk_owner_a_duplicate',
                symbolLabel: 'ownerA',
                ownerSymbolKey: 'owner_a_key',
                ownerSymbolInstanceId: 'owner_a_instance'
            },
            {
                content: 'secondary runtime behavior',
                relativePath: 'src/owner-b.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'chunk_owner_b',
                symbolLabel: 'ownerB',
                ownerSymbolKey: 'owner_b_key',
                ownerSymbolInstanceId: 'owner_b_instance'
            },
            {
                content: 'tertiary runtime behavior',
                relativePath: 'src/owner-c.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'chunk_owner_c',
                symbolLabel: 'ownerC',
                ownerSymbolKey: 'owner_c_key',
                ownerSymbolInstanceId: 'owner_c_instance'
            },
            {
                content: 'quaternary runtime behavior',
                relativePath: 'src/owner-d.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'chunk_owner_d',
                symbolLabel: 'ownerD',
                ownerSymbolKey: 'owner_d_key',
                ownerSymbolInstanceId: 'owner_d_instance'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime behavior',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');

        assert.equal(payload.status, 'ok');
        assert.equal(rerankDocuments.length, 5);
        assert.deepEqual(rerankDocuments.map((document) => document.split('\n', 1)[0]), [
            'src/owner-a-primary.ts',
            'src/owner-b.ts',
            'src/owner-c.ts',
            'src/owner-d.ts',
            'src/owner-a-duplicate.ts',
        ]);
        assert.equal(payload.hints?.debugSearch?.rerank?.candidatesIn, 5);
        assert.equal(payload.hints?.debugSearch?.rerank?.familyCount, 4);
        assert.equal(payload.hints?.debugSearch?.rerank?.supplementalCandidates, 1);
        assert.equal(payload.hints?.debugSearch?.rerank?.candidatePoolCount, 5);
        assert.equal(payload.hints?.debugSearch?.rerank?.candidatesReranked, 5);
        assert.equal(payload.hints?.debugSearch?.rerank?.budgetReason, 'complete_family_pool');
        assert.deepEqual(payload.hints?.debugSearch?.providerWork, {
            semanticSearchAttempts: 1,
            embeddingCallsByCurrentContract: 1,
            denseQueriesByCurrentContract: 1,
            sparseQueriesByCurrentContract: 1,
            rerankerCalls: 1,
            rerankerCandidates: 5,
            rerankerInputBytes: rerankDocuments.reduce(
                (total, document) => total + Buffer.byteLength(document, 'utf8'),
                0,
            ),
            candidatesWithSemanticEvidence: 5,
            candidatesWithLexicalEvidence: 0,
            candidatesWithCurrentSourceEvidence: 0,
        });
        assert.deepEqual(payload.hints?.debugSearch?.semanticExpansion, {
            expand: false,
            attempted: false,
            reason: 'primary_candidate_pool_sufficient',
            primaryScopedCandidateCount: 5,
        });
    });
});

test('handleSearchCode degrades gracefully when reranker fails', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => {
                throw new Error('rerank failed');
            }
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'runtime one',
                relativePath: 'src/one.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one',
                symbolLabel: 'one'
            },
            {
                content: 'runtime two',
                relativePath: 'src/two.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_two',
                symbolLabel: 'two'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.deepEqual(
            payload.results.map((result: { target: { file: string } }) => result.target.file),
            ['src/one.ts', 'src/two.ts'],
        );
        assert.equal(Array.isArray(payload.warnings), true);
        assert.equal(warningCodes(payload).includes('RERANKER_FAILED'), true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.rerankerPresent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.errorCode, 'RERANKER_FAILED');
        assert.equal(payload.hints?.debugSearch?.rerank?.failurePhase, 'api_call');
    });
});

test('handleSearchCode marks rerank.enabled=false when reranker instance is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'runtime one',
                    relativePath: 'src/one.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_one',
                    symbolLabel: 'one'
                }
            ])
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const capabilities = new CapabilityResolver({
            name: 'test',
            version: '0.0.0',
            executionProfile: 'connected',
            networkPolicy: { kind: 'remote-allowed' },
            vectorStoreProvider: 'Milvus',
            encoderProvider: 'VoyageAI',
            encoderModel: 'voyage-4-large',
            voyageKey: 'test'
        });

        // No reranker instance provided => should clamp enabled=false.
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            capabilities,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            undefined,
            null
        );

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.rerankerPresent, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, false);
    });
});

test('handleSearchCode exposes identifier query intent and skips reranker for exact identifier lookups', async () => {
    await withTempRepo(async (repoPath) => {
        let rerankCalls = 0;
        const reranker = {
            rerank: async () => {
                rerankCalls += 1;
                return [];
            }
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export type HurstGateState = "open" | "blocked";',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'type HurstGateState'
            },
            {
                content: 'export type RegimeGateState = "open" | "blocked";',
                relativePath: 'src/regime_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_regime_gate_state',
                symbolLabel: 'type RegimeGateState'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'HurstGateState',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(rerankCalls, 0);
        assert.equal(payload.results[0].file, 'src/hurst_gate.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, true);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.classification, 'identifier');
        assert.equal(payload.hints?.debugSearch?.retrieval?.mode, 'lexical');
        assert.equal(payload.hints?.debugSearch?.retrieval?.scorePolicyKind, 'topk_only');
        assert.equal(payload.hints?.debugSearch?.retrieval?.backendScoreKinds?.includes('rrf_fusion'), true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.skippedByIdentifierIntent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningEnabled, true);
    });
});

test('handleSearchCode promotes lexical exact matches for hurst-style single-token queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function checkRegimeGate() { return "trend persistence"; }',
                relativePath: 'src/regime_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_regime_gate',
                symbolLabel: 'function checkRegimeGate()'
            },
            {
                content: 'export function check_hurst_gate() { return "hurst gate"; }',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate',
                symbolLabel: 'function check_hurst_gate()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'hurst',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/hurst_gate.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, true);
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
        assert.equal(payload.hints?.debugSearch?.retrieval?.backendScoreKinds?.includes('rrf_fusion'), true);
    });
});

test('handleSearchCode prefers usage hits over declarations for reference-seeking mixed queries', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 1, relevanceScore: 0.95 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export type HurstGateState = "open" | "blocked";',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'type HurstGateState'
            },
            {
                content: 'const gate = new HurstGateState(config); return explainWhereUsed(gate);',
                relativePath: 'src/runtime_usage.ts',
                startLine: 10,
                endLine: 14,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function explainRuntimeUsage()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'src/runtime_usage.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, false);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.classification, 'mixed');
        assert.equal(payload.hints?.debugSearch?.queryIntent?.reasons?.includes('reference_seeking_query'), true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningEnabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningApplied, false);
    });
});

test('handleSearchCode ranks canonical owners above tool wrappers for implementation queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export async function searchCodebase(args) { return handlers.handleSearchCode(args); }',
                relativePath: 'packages/mcp/src/tools/search_codebase.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'vector',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_tool_search_codebase',
                symbolLabel: 'function searchCodebase(args)'
            },
            {
                content: 'async handleSearchCode(input) { const results = await this.searchRuntime(input); return results; }',
                relativePath: 'packages/mcp/src/core/handlers.ts',
                startLine: 4000,
                endLine: 4040,
                language: 'typescript',
                score: 0.80,
                backendScore: 0.80,
                backendScoreKind: 'vector',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_core_handle_search_code',
                symbolLabel: 'method handleSearchCode(input)'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'search codebase implementation owner',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/mcp/src/core/handlers.ts');
        assert.equal(payload.results[0].debug?.pathCategory, 'core');
        assert.equal(payload.results[0].debug?.agentFitReason, 'implementation_symbol');
        assert.equal(payload.results[1].debug?.pathCategory, 'adapter');
        assert.equal(payload.results[1].debug?.agentFitReason, 'adapter_not_canonical_owner');
    });
});

test('handleSearchCode keeps a provider adapter eligible as the canonical implementation owner', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'async function executeSparseSearch(query) { return vectorDatabase.sparseSearch(query); }',
                relativePath: 'packages/core/src/search/execution.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.90,
                backendScore: 0.90,
                backendScoreKind: 'vector',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_execute_sparse_search',
                symbolLabel: 'function executeSparseSearch(query)'
            },
            {
                content: 'async method sparseSearch(query) { return this.client.search({ anns_field: "sparse_vector", query }); }',
                relativePath: 'packages/core/src/vectordb/adapters/milvus-rest.ts',
                startLine: 80,
                endLine: 95,
                language: 'typescript',
                score: 0.95,
                backendScore: 0.95,
                backendScoreKind: 'vector',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_milvus_rest_sparse_search',
                symbolLabel: 'method sparseSearch(query)'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'Milvus REST sparse request implementation',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/core/src/vectordb/adapters/milvus-rest.ts');
        assert.equal(payload.results[0].debug?.pathCategory, 'adapter');
        assert.equal(payload.results[0].debug?.agentFitReason, 'implementation_symbol');
    });
});

test('handleSearchCode demotes tests below implementation owners unless test intent is explicit', async () => {
    await withTempRepo(async (repoPath) => {
        const searchResults = [
            {
                content: 'test("installs the Codex guidance hook", () => expect(block).toContain("SessionStart"));',
                relativePath: 'packages/cli/src/install.test.ts',
                startLine: 260,
                endLine: 322,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_install_test',
                symbolLabel: 'async function <anonymous>()'
            },
            {
                content: 'function ensureCodexGuidanceHook(config) { return buildCodexGuidanceHookBlock(config); }',
                relativePath: 'packages/cli/src/install.ts',
                startLine: 466,
                endLine: 475,
                language: 'typescript',
                score: 0.98,
                backendScore: 0.98,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_ensure_codex_guidance_hook',
                symbolLabel: 'function ensureCodexGuidanceHook(config)'
            }
        ];
        const handlers = createHandlers(repoPath, searchResults);

        const ownerResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is codex guidance hook installed',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });
        const ownerPayload = JSON.parse(ownerResponse.content[0]?.text || '{}');
        assert.equal(ownerPayload.results[0].target.file, 'packages/cli/src/install.ts');
        assert.equal(ownerPayload.results[0].debug?.agentFitReason, 'writer_owner');
        assert.equal(ownerPayload.results[1].debug?.agentFitReason, 'implementation_query_test_demotion');

        const testResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'codex guidance hook test coverage',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });
        const testPayload = JSON.parse(testResponse.content[0]?.text || '{}');
        assert.equal(testPayload.results[0].target.file, 'packages/cli/src/install.test.ts');
        assert.equal(testPayload.results[0].debug?.agentFitReason, 'test_intent');
    });
});

test('handleSearchCode strongly demotes test helpers for implementation freshness queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'async function ensureFreshness() { return { mode: "skipped_recent", thresholdMs: 180000 }; }',
                relativePath: 'packages/mcp/src/core/handlers.index_state_stability.test.ts',
                startLine: 77,
                endLine: 82,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_test_ensure_freshness',
                symbolLabel: 'async function ensureFreshness()'
            },
            {
                content: 'export class SyncManager { async ensureFreshness(codebasePath) { return this.reconcileControlFiles(codebasePath, "satori.toml"); } }',
                relativePath: 'packages/mcp/src/core/sync.ts',
                startLine: 110,
                endLine: 209,
                language: 'typescript',
                score: 0.97,
                backendScore: 0.97,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_sync_ensure_freshness',
                symbolLabel: 'method SyncManager.ensureFreshness(codebasePath)'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'satori.toml freshness reconciliation control file ensureFreshness',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/mcp/src/core/sync.ts');
        assert.equal(payload.results[0].debug?.agentFitReason, 'implementation_symbol');
        assert.equal(payload.results[1].debug?.agentFitReason, 'implementation_query_test_demotion');
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningEnabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningApplied, false);
    });
});

test('handleSearchCode ranks script runtime owners above package installability helpers for script queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'function verifyManagedPackageInstallability() { return npmView(packageName); }',
                relativePath: 'packages/cli/src/package-installability.ts',
                startLine: 94,
                endLine: 127,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_verify_installability',
                symbolLabel: 'function verifyManagedPackageInstallability()'
            },
            {
                content: 'function findStalePackageVersionReferences(packageJson, docs) { return staleReferences; }',
                relativePath: 'scripts/check-version-freshness.mjs',
                startLine: 55,
                endLine: 78,
                language: 'javascript',
                score: 0.98,
                backendScore: 0.98,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_find_stale_versions',
                symbolLabel: 'function findStalePackageVersionReferences(packageJson, docs)'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'script that checks package version references are fresh',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'scripts/check-version-freshness.mjs');
        assert.equal(payload.results[0].debug?.pathCategory, 'scriptRuntime');
        assert.equal(payload.results[0].debug?.agentFitReason, 'script_implementation');
    });
});

test('handleSearchCode boosts exact phase/path anchors for broad semantic queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: [
                    'def build_pair_relationship_object(pair):',
                    '    readiness = measure_runtime_readiness(pair)',
                    '    return {"relationship": pair, "admission": readiness}',
                ].join('\n'),
                relativePath: 'scripts/ops/phase6m_pair_relationship_object.py',
                startLine: 568,
                endLine: 590,
                language: 'python',
                score: 0.31445,
                backendScore: 0.31445,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_phase6m_pair_relationship_object',
                symbolLabel: 'function build_pair_relationship_object('
            },
            {
                content: [
                    'def build_phase6av_independent_descriptor_target(pair):',
                    '    observation_source = load_phase6p_relationship_observation_source(pair)',
                    '    readiness = evaluate_runtime_pair_relationship_readiness(pair)',
                    '    return admit_descriptor_target(pair, observation_source, readiness)',
                ].join('\n'),
                relativePath: 'scripts/ops/phase6p_pair_relationship_observation_source.py',
                startLine: 4909,
                endLine: 4960,
                language: 'python',
                score: 0.27803,
                backendScore: 0.27803,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_phase6p_descriptor_target',
                symbolLabel: 'function build_phase6av_independent_descriptor_target('
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'phase6p relationship observation source runtime pair relationship readiness admission',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'scripts/ops/phase6p_pair_relationship_observation_source.py');
        assert.equal(payload.results[1].target.file, 'scripts/ops/phase6m_pair_relationship_object.py');
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.classification, 'mixed');
    });
});

test('handleSearchCode demotes sibling structural-anchor near misses below a neutral parallel control', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: [
                    'def build_phase6av_independent_descriptor_target(pair):',
                    '    observation_source = load_phase6p_relationship_observation_source(pair)',
                    '    readiness = evaluate_runtime_pair_relationship_readiness(pair)',
                    '    return admit_pair_relationship_runtime_admission(pair, observation_source, readiness)',
                ].join('\n'),
                relativePath: 'scripts/ops/phase6p_pair_relationship_observation_source.py',
                startLine: 4909,
                endLine: 4960,
                language: 'python',
                score: 0.27803,
                backendScore: 0.27803,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_phase6p_descriptor_target',
                symbolLabel: 'function build_phase6av_independent_descriptor_target('
            },
            {
                content: [
                    'def build_phase6m_independent_descriptor_target(pair):',
                    '    observation_source = load_phase6m_relationship_observation_source(pair)',
                    '    readiness = evaluate_runtime_pair_relationship_readiness(pair)',
                    '    return admit_pair_relationship_runtime_admission(pair, observation_source, readiness)',
                ].join('\n'),
                relativePath: 'scripts/ops/phase6m_pair_relationship_observation_source.py',
                startLine: 4909,
                endLine: 4960,
                language: 'python',
                score: 0.27803,
                backendScore: 0.27803,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_phase6m_descriptor_target',
                symbolLabel: 'function build_phase6m_independent_descriptor_target('
            },
            {
                content: [
                    'def build_independent_descriptor_target_runtime_admission(pair):',
                    '    observation_source = load_relationship_observation_source(pair)',
                    '    readiness = evaluate_runtime_pair_relationship_readiness(pair)',
                    '    return admit_pair_relationship_runtime_admission(pair, observation_source, readiness)',
                ].join('\n'),
                relativePath: 'scripts/ops/pair_relationship_observation_source_runtime_admission.py',
                startLine: 4909,
                endLine: 4960,
                language: 'python',
                score: 0.27803,
                backendScore: 0.27803,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_parallel_runtime_admission_target',
                symbolLabel: 'function build_independent_descriptor_target_runtime_admission('
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'phase6p relationship observation source runtime pair relationship readiness admission',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'scripts/ops/phase6p_pair_relationship_observation_source.py');
        assert.equal(payload.results[1].target.file, 'scripts/ops/pair_relationship_observation_source_runtime_admission.py');
        assert.equal(payload.results[2].target.file, 'scripts/ops/phase6m_pair_relationship_observation_source.py');
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
        assert.equal(payload.results[1].debug?.lexicalScore > payload.results[2].debug?.lexicalScore, true);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.classification, 'mixed');
    });
});

test('handleSearchCode ranks writer owners above repo config readers for write-intent queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'function parseSatoriRepoConfig(content, configPath) { const profile = readTomlProfile(content); return { configPath, profile }; }',
                relativePath: 'packages/core/src/config/repo-config.ts',
                startLine: 33,
                endLine: 75,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_parse_repo_config',
                symbolLabel: 'function parseSatoriRepoConfig(content, configPath)'
            },
            {
                content: 'function updateSatoriProjectConfig(current, profile) { lines.splice(indexTableLine + 1, 0, `profile = ${profile}`); return normalizeTrailingNewline(lines.join("\\n")); }',
                relativePath: 'packages/cli/src/install.ts',
                startLine: 232,
                endLine: 308,
                language: 'typescript',
                score: 0.97,
                backendScore: 0.97,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_update_satori_project_config',
                symbolLabel: 'function updateSatoriProjectConfig(current, profile)'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'what writes repo-local satori.toml profile during install',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/cli/src/install.ts');
        assert.equal(payload.results[0].debug?.agentFitReason, 'writer_owner');
    });
});

test('handleSearchCode treats class-qualified mutator methods as writer owners', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'function parseSatoriRepoConfig(content, configPath) { const profile = readTomlProfile(content); return { configPath, profile }; }',
                relativePath: 'packages/core/src/config/repo-config.ts',
                startLine: 33,
                endLine: 75,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_parse_repo_config',
                symbolLabel: 'function parseSatoriRepoConfig(content, configPath)'
            },
            {
                content: 'class ProjectConfigWriter { updateSatoriProjectConfig(current, profile) { return normalizeTrailingNewline(current); } }',
                relativePath: 'packages/cli/src/install.ts',
                startLine: 232,
                endLine: 308,
                language: 'typescript',
                score: 0.97,
                backendScore: 0.97,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_project_config_writer_update',
                symbolLabel: 'method ProjectConfigWriter.updateSatoriProjectConfig(current, profile)'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'what updates repo-local satori.toml profile during install',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/cli/src/install.ts');
        assert.equal(payload.results[0].debug?.agentFitReason, 'writer_owner');
    });
});

test('handleSearchCode does not treat formatter pushes as writer owners', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: [
                    'const lines: string[] = [];',
                    'lines.push("## Codebases");',
                    'lines.push("");',
                    'return lines.join("\\n");'
                ].join('\n'),
                relativePath: 'packages/mcp/src/tools/list_codebases.ts',
                startLine: 28,
                endLine: 142,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_list_codebases_description',
                symbolLabel: 'function description()'
            },
            {
                content: 'function ensureCodexGuidanceHook(content) { const block = buildCodexGuidanceHookBlock(); return content.includes("SessionStart") ? content : `${content}\\n${block}`; }',
                relativePath: 'packages/cli/src/install.ts',
                startLine: 529,
                endLine: 597,
                language: 'typescript',
                score: 0.97,
                backendScore: 0.97,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_ensure_codex_guidance_hook',
                symbolLabel: 'function ensureCodexGuidanceHook(content)'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is codex guidance hook installed',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/cli/src/install.ts');
        assert.equal(payload.results[0].debug?.agentFitReason, 'writer_owner');
        assert.equal(payload.results[1].target.file, 'packages/mcp/src/tools/list_codebases.ts');
        assert.equal(payload.results[1].debug?.agentFitReason, 'writer_query_non_writer');
    });
});

test('handleSearchCode ranks implementation chunks above type-only results for owner queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export interface SearchGroupResult { preview: string; nextActions?: SearchNextActions; }',
                relativePath: 'packages/mcp/src/core/search-types.ts',
                startLine: 83,
                endLine: 121,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_search_group_result',
                symbolLabel: 'interface SearchGroupResult'
            },
            {
                content: 'groupedResults.push({ preview: truncateContent(content, SEARCH_GROUP_PREVIEW_MAX_CHARS), nextActions });',
                relativePath: 'packages/mcp/src/core/handlers.ts',
                startLine: 4705,
                endLine: 4751,
                language: 'typescript',
                score: 0.98,
                backendScore: 0.98,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where does Satori cap grouped search previews',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/mcp/src/core/handlers.ts');
        assert.equal(payload.results[0].debug?.agentFitReason, 'implementation_chunk');
        assert.equal(payload.results[1].debug?.agentFitReason, 'type_not_owner');
    });
});

test('handleSearchCode does not boost dirty tests for non-test implementation queries', async () => {
    await withTempRepo(async (repoPath) => {
        fs.mkdirSync(path.join(repoPath, 'packages', 'cli', 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(repoPath, 'packages', 'cli', 'src', 'install.test.ts'),
            'test("installs the hook", () => expect(block).toContain("SessionStart"));\n',
        );
        const handlers = createHandlers(repoPath, [
            {
                content: 'test("installs the hook", () => expect(block).toContain("SessionStart"));',
                relativePath: 'packages/cli/src/install.test.ts',
                startLine: 260,
                endLine: 322,
                language: 'typescript',
                score: 0.99,
                backendScore: 0.99,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_install_test_dirty',
                symbolLabel: 'async function <anonymous>()'
            },
            {
                content: 'function ensureCodexGuidanceHook(config) { return buildCodexGuidanceHookBlock(config); }',
                relativePath: 'packages/cli/src/install.ts',
                startLine: 466,
                endLine: 475,
                language: 'typescript',
                score: 0.98,
                backendScore: 0.98,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_install_owner_clean',
                symbolLabel: 'function ensureCodexGuidanceHook(config)'
            }
        ]);
        (handlers as unknown as ToolHandlersTestOverrides).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['packages/cli/src/install.test.ts'])
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is codex guidance hook installed',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'packages/cli/src/install.ts');
        assert.equal(payload.freshnessSummary.changedFilesBoostApplied, false);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.boostedCandidates, 0);
        assert.equal(payload.results[1].debug?.changedFilesMultiplier, 1);
    });
});

test('handleSearchCode collapses duplicate declaration groups for reference-seeking queries', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 2, relevanceScore: 0.99 },
                { index: 0, relevanceScore: 0.98 },
                { index: 1, relevanceScore: 0.97 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_a',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'class HurstGateState { /* duplicate chunk */ }',
                relativePath: 'src/hurst_gate.ts',
                startLine: 2,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_b',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'const gate = new HurstGateState(config); return gate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 10,
                endLine: 14,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function explainRuntimeUsage()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'src/runtime_usage.ts');
        const declarationHits = payload.results.filter((result: SearchPayloadResultView) => result.target?.file === 'src/hurst_gate.ts' && result.displayLabel === 'class HurstGateState');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode identifier query does not treat fragment-only matches as exact lexical matches', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'export function current_state() { return GateState.NORMAL; }',
                relativePath: 'src/risk_state.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_current_state',
                symbolLabel: 'function current_state()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'HurstGateState',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/hurst_gate.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, true);
        assert.equal(payload.results[1].file, 'src/risk_state.ts');
        assert.equal(payload.results[1].debug?.exactLexicalMatch, false);
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
    });
});

test('handleSearchCode collapses duplicate declaration groups for identifier queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_a',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'class HurstGateState { /* duplicate chunk */ }',
                relativePath: 'src/hurst_gate.ts',
                startLine: 2,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_b',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'export function current_state() { return GateState.NORMAL; }',
                relativePath: 'src/risk_state.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_current_state',
                symbolLabel: 'function current_state()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'HurstGateState',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const declarationHits = payload.results.filter((result: SearchPayloadResultView) => result.target?.file === 'src/hurst_gate.ts' && result.displayLabel === 'class HurstGateState');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode reference-seeking queries downweight fragment-only matches below real usage', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 1, relevanceScore: 0.99 },
                { index: 0, relevanceScore: 0.98 },
                { index: 2, relevanceScore: 0.97 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'export function current_state_gate() { return gateState; }',
                relativePath: 'src/check_gate_state.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.20,
                backendScore: 0.20,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_current_state_gate',
                symbolLabel: 'function current_state_gate()'
            },
            {
                content: 'const gate = HurstGateState(config); return gate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 10,
                endLine: 14,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function explainRuntimeUsage()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].target.file !== 'src/check_gate_state.ts', true);
    });
});

test('handleSearchCode reference-seeking queries rank runtime usage above declaration chunks with usage examples', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 0, relevanceScore: 0.99 },
                { index: 1, relevanceScore: 0.98 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: [
                    'export class HurstGateState {',
                    '  /**',
                    '   * Usage:',
                    '   *   const gate = HurstGateState(config);',
                    '   */',
                    '}'
                ].join('\n'),
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 6,
                language: 'typescript',
                score: 0.020,
                backendScore: 0.020,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'this.hurstGate = HurstGateState(config); return this.hurstGate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function initializeRuntimeGate()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].target.file, 'src/hurst_gate.ts');
    });
});

test('handleSearchCode reference-seeking function declarations do not receive usage-match boost', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function check_hurst_gate(config) { return config; }',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate',
                symbolLabel: 'function check_hurst_gate('
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declaration = payload.results.find((result: SearchPayloadResultView) => result.file === 'src/check_hurst_gate.ts');
        assert.ok(declaration);
        assert.equal(declaration.debug?.lexicalScore < 0.05, true);
    });
});

test('handleSearchCode reference-seeking queries rank executable usage above import-only references', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'import { HurstGateState } from "./hurst_gate"; export { HurstGateState };',
                relativePath: 'src/runtime_import.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_import',
                symbolLabel: 'module runtime_import'
            },
            {
                content: 'const gate = new HurstGateState(config); return gate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function initializeRuntimeGate()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].file, 'src/runtime_import.ts');
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
    });
});

test('handleSearchCode treats arrow function declarations as declarations for reference-seeking queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'const check_hurst_gate = (config) => config;',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_arrow_a',
                symbolLabel: 'const check_hurst_gate ='
            },
            {
                content: 'const check_hurst_gate = async (config) => config.value;',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 3,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_arrow_b',
                symbolLabel: 'const check_hurst_gate ='
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].target.file, 'src/runtime_usage.ts');
        const declarationHits = payload.results.filter((result: SearchPayloadResultView) => result.target?.file === 'src/check_hurst_gate.ts' && result.displayLabel === 'const check_hurst_gate =');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode treats arrow declarations with n-containing parameter names as declarations', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'const check_hurst_gate = (next) => next;',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_arrow_next',
                symbolLabel: 'const check_hurst_gate ='
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declaration = payload.results.find((result: SearchPayloadResultView) => result.file === 'src/check_hurst_gate.ts');
        assert.ok(declaration);
        assert.equal(declaration.debug?.lexicalScore < 0.05, true);
    });
});

test('handleSearchCode collapses duplicate function declaration groups for reference-seeking queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function check_hurst_gate(config) { return config; }',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_a',
                symbolLabel: 'function check_hurst_gate('
            },
            {
                content: 'function check_hurst_gate(config) { return config.value; }',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 2,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_b',
                symbolLabel: 'function check_hurst_gate('
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const declarationHits = payload.results.filter((result: SearchPayloadResultView) => result.target?.file === 'src/check_hurst_gate.ts' && result.displayLabel === 'function check_hurst_gate');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode reranker can change grouped representative chunk selection before grouping', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 1, relevanceScore: 0.9 },
                { index: 0, relevanceScore: 0.8 }
            ]
        };
        const searchResults = [
            {
                content: 'legacy auth flow',
                relativePath: 'src/auth.ts',
                startLine: 3,
                endLine: 5,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            },
            {
                content: 'critical token validation path',
                relativePath: 'src/auth.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            }
        ];
        const handlersWithoutReranker = createHandlers(repoPath, searchResults);
        const handlersWithReranker = createHandlers(repoPath, searchResults, reranker);

        const baselineResponse = await handlersWithoutReranker.handleSearchCode({
            path: repoPath,
            query: 'auth path',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1
        });
        const baselinePayload = JSON.parse(baselineResponse.content[0]?.text || '{}');
        assert.equal(baselinePayload.results[0].preview.includes('legacy auth flow'), true);

        const rerankedResponse = await handlersWithReranker.handleSearchCode({
            path: repoPath,
            query: 'auth path',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debugMode: 'full'
        });
        const rerankedPayload = JSON.parse(rerankedResponse.content[0]?.text || '{}');
        assert.equal(rerankedPayload.results[0].preview.includes('critical token validation path'), true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.rerankerPresent, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.enabled, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.applied, true);
    });
});

test('handleSearchCode leaves reranker applied false when no returned indexes are usable', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 99, relevanceScore: 0.9 },
                { index: -1, relevanceScore: 0.8 },
                { index: 1.5, relevanceScore: 0.7 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'primary runtime path',
                relativePath: 'src/one.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one',
                symbolLabel: 'function one()'
            },
            {
                content: 'secondary runtime path',
                relativePath: 'src/two.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_two',
                symbolLabel: 'function two()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime path',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debugMode: 'full'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].preview.includes('primary runtime path'), true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, false);
    });
});

test('handleSearchCode emits deterministic noiseMitigation hint when top grouped results are noise-dominant', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'describe("auth", () => {})',
                relativePath: 'tests/auth.test.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_test',
                symbolLabel: 'function testAuth()'
            },
            {
                content: 'export const fixture = true;',
                relativePath: 'src/__fixtures__/auth-fixture.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_fixture',
                symbolLabel: 'const fixture'
            },
            {
                content: '# auth docs',
                relativePath: 'docs/auth.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs',
                symbolLabel: 'doc auth'
            },
            {
                content: 'TN:coverage',
                relativePath: 'coverage/lcov.info',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.92,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_generated',
                symbolLabel: 'coverage'
            },
            {
                content: 'export const runtime = true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime',
                symbolLabel: 'const runtime'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.version, 1);
        assert.equal(payload.hints?.noiseMitigation?.reason, 'top_results_noise_dominant');
        assert.equal(payload.hints?.noiseMitigation?.topK, 5);
        assert.deepEqual(payload.hints?.noiseMitigation?.ratios, {
            tests: 0.2,
            fixtures: 0.2,
            docs: 0.2,
            generated: 0.2,
            runtime: 0.2
        });
        assert.equal(payload.hints?.noiseMitigation?.recommendedScope, 'runtime');
        assert.equal(payload.hints?.noiseMitigation?.debounceMs, 5000);
        assert.deepEqual(payload.hints?.noiseMitigation?.suggestedIgnorePatterns, [
            '**/*.test.*',
            '**/*.spec.*',
            '**/__tests__/**',
            '**/__fixtures__/**',
            '**/fixtures/**',
            'coverage/**'
        ]);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /scope=\"runtime\"/);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /\"action\":\"sync\"/);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /Reindex is only required when you see requires_reindex/i);
        assert.doesNotMatch(payload.hints?.noiseMitigation?.nextStep || '', /already covered by root \.gitignore/i);
    });
});

test('handleSearchCode does not emit noiseMitigation hint for docs scope docs results', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: '# install profile minimal',
                relativePath: 'README.md',
                startLine: 1,
                endLine: 12,
                language: 'text',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: '# CLI install profile docs',
                relativePath: 'packages/cli/README.md',
                startLine: 1,
                endLine: 20,
                language: 'text',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: '# MCP install profile docs',
                relativePath: 'packages/mcp/README.md',
                startLine: 1,
                endLine: 20,
                language: 'text',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'install --client all --profile minimal documented usage',
            scope: 'docs',
            resultMode: 'grouped',
            groupBy: 'file',
            limit: 3
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.noiseMitigation, undefined);
    });
});

test('handleSearchCode emits generic verification hint for generated output results', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const runtime = true;',
                relativePath: 'src/app.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime',
                symbolLabel: 'const runtime'
            },
            {
                content: 'const bundled = true;',
                relativePath: 'dist/app.js',
                startLine: 1,
                endLine: 2,
                language: 'javascript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_dist',
                symbolLabel: 'const bundled'
            },
            {
                content: 'const output = true;',
                relativePath: '.output/app.js',
                startLine: 1,
                endLine: 2,
                language: 'javascript',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_output',
                symbolLabel: 'const output'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'verify generated output for app',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.deepEqual(payload.hints?.verification?.generatedArtifacts, {
            reason: 'generated_outputs_present',
            message: 'Generated or build output appeared in search context. Source matches do not prove generated output is current; verify the artifact directly when behavior depends on it.',
            files: ['.output/app.js', 'dist/app.js'],
            nextSteps: [
                {
                    tool: 'read_file',
                    args: {
                        path: path.resolve(repoPath, '.output/app.js'),
                        start_line: 1,
                        end_line: 2
                    }
                },
                {
                    tool: 'read_file',
                    args: {
                        path: path.resolve(repoPath, 'dist/app.js'),
                        start_line: 1,
                        end_line: 2
                    }
                }
            ]
        });
    });
});

test('handleSearchCode suppresses redundant ignore suggestions when top noisy files are already covered by root .gitignore', async () => {
    await withTempRepo(async (repoPath) => {
        fs.writeFileSync(
            path.join(repoPath, '.gitignore'),
            ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__fixtures__/**', 'coverage/**'].join('\n') + '\n',
            'utf8'
        );

        const handlers = createHandlers(repoPath, [
            {
                content: 'describe("auth", () => {})',
                relativePath: 'tests/auth.test.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_test',
                symbolLabel: 'function testAuth()'
            },
            {
                content: 'describe("auth", () => {})',
                relativePath: 'src/__tests__/auth.spec.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_spec',
                symbolLabel: 'function authSpec()'
            },
            {
                content: 'export const fixture = true;',
                relativePath: 'src/__fixtures__/auth-fixture.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_fixture',
                symbolLabel: 'const fixture'
            },
            {
                content: 'TN:coverage',
                relativePath: 'coverage/lcov.info',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.92,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_generated',
                symbolLabel: 'coverage'
            },
            {
                content: 'export const runtime = true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime',
                symbolLabel: 'const runtime'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.deepEqual(payload.hints?.noiseMitigation?.suggestedIgnorePatterns, []);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /already covered by root \.gitignore/i);
    });
});

test('handleSearchCode keeps only non-redundant ignore suggestions and preserves deterministic order', async () => {
    await withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, '.gitignore'), 'coverage/**\n', 'utf8');

        const handlers = createHandlers(repoPath, [
            {
                content: 'describe("auth", () => {})',
                relativePath: 'src/__tests__/auth.spec.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_spec',
                symbolLabel: 'function authSpec()'
            },
            {
                content: 'export const fixture = true;',
                relativePath: 'src/__fixtures__/auth-fixture.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_fixture',
                symbolLabel: 'const fixture'
            },
            {
                content: 'TN:coverage',
                relativePath: 'coverage/lcov.info',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_generated',
                symbolLabel: 'coverage'
            },
            {
                content: 'export const runtime = true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.92,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_1',
                symbolLabel: 'const runtime1'
            },
            {
                content: 'export const runtime2 = true;',
                relativePath: 'src/runtime2.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_2',
                symbolLabel: 'const runtime2'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.deepEqual(payload.hints?.noiseMitigation?.suggestedIgnorePatterns, [
            '**/*.spec.*',
            '**/__tests__/**',
            '**/__fixtures__/**'
        ]);
        assert.doesNotMatch(payload.hints?.noiseMitigation?.nextStep || '', /already covered by root \.gitignore/i);
    });
});

test('handleSearchCode reloads root .gitignore on forced cadence when mtime and size stay unchanged', async () => {
    await withTempRepo(async (repoPath) => {
        const gitignorePath = path.join(repoPath, '.gitignore');
        const firstContent = 'coverage/**\n#same\n';
        const secondContent = '**/*.spec.*\n#same\n';
        const fixedDate = new Date('2026-03-01T00:00:00.000Z');

        fs.writeFileSync(gitignorePath, firstContent, 'utf8');
        fs.utimesSync(gitignorePath, fixedDate, fixedDate);

        const handlers = createHandlers(
            repoPath,
            [
                {
                    content: 'describe("auth", () => {})',
                    relativePath: 'src/__tests__/auth.spec.ts',
                    startLine: 1,
                    endLine: 3,
                    language: 'typescript',
                    score: 0.95,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_spec',
                    symbolLabel: 'function authSpec()'
                },
                {
                    content: 'TN:coverage',
                    relativePath: 'coverage/lcov.info',
                    startLine: 1,
                    endLine: 2,
                    language: 'text',
                    score: 0.94,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_generated',
                    symbolLabel: 'coverage'
                },
                {
                    content: '# auth docs',
                    relativePath: 'docs/auth.md',
                    startLine: 1,
                    endLine: 2,
                    language: 'text',
                    score: 0.93,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_docs',
                    symbolLabel: 'doc auth'
                },
                {
                    content: 'export const runtime = true;',
                    relativePath: 'src/runtime.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.92,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_runtime_1',
                    symbolLabel: 'const runtime1'
                },
                {
                    content: 'export const runtime2 = true;',
                    relativePath: 'src/runtime2.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.91,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_runtime_2',
                    symbolLabel: 'const runtime2'
                }
            ],
            undefined,
            { gitignoreForceReloadEveryN: 2 }
        );

        const firstResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const firstPayload = JSON.parse(firstResponse.content[0]?.text || '{}');
        assert.deepEqual(firstPayload.hints?.noiseMitigation?.suggestedIgnorePatterns, ['**/*.spec.*', '**/__tests__/**']);

        fs.writeFileSync(gitignorePath, secondContent, 'utf8');
        fs.utimesSync(gitignorePath, fixedDate, fixedDate);

        const secondResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const secondPayload = JSON.parse(secondResponse.content[0]?.text || '{}');
        assert.deepEqual(secondPayload.hints?.noiseMitigation?.suggestedIgnorePatterns, ['**/*.spec.*', '**/__tests__/**']);

        const thirdResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const thirdPayload = JSON.parse(thirdResponse.content[0]?.text || '{}');
        assert.deepEqual(thirdPayload.hints?.noiseMitigation?.suggestedIgnorePatterns, ['coverage/**']);
    });
});

test('handleSearchCode omits noiseMitigation hint when top grouped results are runtime-dominant', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const runtimeA = true;',
                relativePath: 'src/runtime-a.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_a',
                symbolLabel: 'const runtimeA'
            },
            {
                content: 'export const runtimeB = true;',
                relativePath: 'src/runtime-b.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_b',
                symbolLabel: 'const runtimeB'
            },
            {
                content: 'export const runtimeC = true;',
                relativePath: 'src/runtime-c.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_c',
                symbolLabel: 'const runtimeC'
            },
            {
                content: 'export const runtimeD = true;',
                relativePath: 'src/runtime-d.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_d',
                symbolLabel: 'const runtimeD'
            },
            {
                content: '# docs',
                relativePath: 'docs/runtime.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs',
                symbolLabel: 'docs'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.noiseMitigation, undefined);
    });
});

test('handleSearchCode grouped fallback omits internal identity and emits compact missing-symbol navigation', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'const value = computeToken();',
            relativePath: 'src/runtime.ts',
            startLine: 42,
            endLine: 45,
            language: 'typescript',
            score: 0.88,
            indexedAt: '2026-01-01T00:30:00.000Z'
        }], undefined, { sidecarReady: false });

        const args = {
            path: repoPath,
            query: 'compute token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        };

        const firstResponse = await handlers.handleSearchCode(args);
        const secondResponse = await handlers.handleSearchCode(args);

        const firstPayload = JSON.parse(firstResponse.content[0]?.text || '{}');
        const secondPayload = JSON.parse(secondResponse.content[0]?.text || '{}');

        assert.equal(firstPayload.results.length, 1);
        assert.equal(secondPayload.results.length, 1);
        assert.deepEqual(firstPayload.results[0], secondPayload.results[0]);
        assert.equal(firstPayload.results[0].groupId, undefined);
        assert.equal(firstPayload.results[0].navigation.graph, 'missing_symbol');
        assert.deepEqual(firstPayload.results[0].target, {
            file: 'src/runtime.ts',
            span: { startLine: 42, endLine: 45 },
        });
        assert.equal(firstPayload.results[0].navigationFallback, undefined);
        assert.equal(firstPayload.results[0].fallbacks, undefined);
        assert.equal(firstPayload.results[0].recommendedNextAction, undefined);
        assert.deepEqual(firstPayload.recommendedNextAction?.args, {
            path: path.resolve(repoPath, 'src/runtime.ts'),
            start_line: 42,
            end_line: 45,
        });
    });
});

test('handleSearchCode emits fileOutlineWindow navigation fallback when sidecar is v3 and file supports outline', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'const value = computeToken();',
                    relativePath: 'src/runtime.ts',
                    startLine: 10,
                    endLine: 14,
                    language: 'typescript',
                    score: 0.88,
                    indexedAt: '2026-01-01T00:30:00.000Z'
                }
            ])
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'compute token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].navigation.graph, 'missing_symbol');
        assert.equal(payload.results[0].navigationFallback, undefined);
    });
});

test('handleSearchCode subdirectory query publishes the effective root once and preserves relative target file', async () => {
    await withTempRepo(async (repoPath) => {
        const subdirPath = path.join(repoPath, 'src');
        fs.mkdirSync(subdirPath, { recursive: true });
        const sidecarForPath = (requestedPath: string) => {
            if (requestedPath === repoPath) {
                return { version: 'v3' as const };
            }
            if (requestedPath === subdirPath) {
                return undefined;
            }
            return undefined;
        };
        assert.deepEqual(sidecarForPath(repoPath), { version: 'v3' });
        assert.equal(sidecarForPath(subdirPath), undefined);

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'const value = computeToken();',
                    relativePath: 'src/runtime.ts',
                    startLine: 10,
                    endLine: 14,
                    language: 'typescript',
                    score: 0.88,
                    indexedAt: '2026-01-01T00:30:00.000Z'
                }
            ])
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: sidecarForPath
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: subdirPath,
            query: 'compute token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].target.file, 'src/runtime.ts');
        assert.equal(payload.path, subdirPath);
        assert.equal(payload.codebaseRoot, repoPath);
        assert.equal(payload.results[0].navigationFallback, undefined);
        assert.equal(payload.recommendedNextAction.args.path, path.resolve(repoPath, 'src/runtime.ts'));
    });
});

test('handleSearchCode grouped sorting places null symbolLabel last for deterministic tie-breaking', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'return verifyToken(token);',
                relativePath: 'src/auth.ts',
                startLine: 10,
                endLine: 12,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_sym_with_label',
                symbolLabel: 'function withLabel(token: string)',
                ownerSymbolKey: 'owner_with_label_key',
                ownerSymbolInstanceId: 'owner_with_label_instance',
                symbolKind: 'function',
            },
            {
                content: 'return verifyToken(token);',
                relativePath: 'src/auth.ts',
                startLine: 10,
                endLine: 13,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'legacy_sym_without_label',
                ownerSymbolKey: 'owner_without_label_key',
                ownerSymbolInstanceId: 'owner_without_label_instance',
                symbolKind: 'function',
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'verify token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results.length, 2);
        assert.equal(payload.results[0].target.symbolId, undefined);
        assert.equal(payload.results[1].target.symbolId, undefined);
        assert.equal(payload.results[0].displayLabel, 'function withLabel(token: string)');
        assert.equal(typeof payload.results[1].displayLabel, 'string');
        assert.notEqual(payload.results[1].displayLabel, null);
    });
});

test('handleSearchCode builds explicit hybrid semantic search requests with topk_only policy', async () => {
    await withTempRepo(async (repoPath) => {
        const calls: ParsedSemanticSearchInvocation[] = [];
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (...args: unknown[]) => {
                calls.push(parseSemanticSearchInvocation(args));
                return [];
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map((call) => call.query), [
            'validate session',
            'validate session\nimplementation runtime source entrypoint'
        ]);
        for (const call of calls) {
            assert.ok(call.request);
            assert.equal(call.request.codebasePath, repoPath);
            assert.equal(call.request.topK, 40);
            assert.equal(call.request.retrievalMode, 'hybrid');
            assert.deepEqual(call.request.scorePolicy, { kind: 'topk_only' });
        }
    });
});

test('handleSearchCode falls back to dense retrieval when hybrid mode is disabled', async () => {
    await withTempRepo(async (repoPath) => {
        const calls: Array<ReturnType<typeof parseSemanticSearchInvocation>> = [];
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getIsHybrid: () => false,
            semanticSearch: async (...args: unknown[]) => {
                calls.push(parseSemanticSearchInvocation(args));
                return [];
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.ok(call.request);
            assert.equal(call.request.codebasePath, repoPath);
            assert.equal(call.request.topK, 40);
            assert.equal(call.request.retrievalMode, 'dense');
            assert.deepEqual(call.request.scorePolicy, { kind: 'topk_only' });
        }
    });
});

test('handleSearchCode runs evidence-triggered expansion after the primary pass and warns on partial failure', async () => {
    await withTempRepo(async (repoPath) => {
        const started: string[] = [];

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (...args: unknown[]) => {
                const { query } = parseSemanticSearchInvocation(args);
                const passId = query.includes('implementation runtime source entrypoint') ? 'expanded' : 'primary';
                started.push(passId);
                if (passId === 'expanded') {
                    throw new Error('expanded failed');
                }
                return [{
                    content: 'return session.isValid();',
                    relativePath: 'src/auth.ts',
                    startLine: 3,
                    endLine: 6,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_auth_validate',
                    symbolLabel: 'method validateSession(token: string)'
                }];
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debugMode: 'full'
        });

        assert.deepEqual(started, ['primary', 'expanded']);
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.ok(Array.isArray(payload.warnings));
        assert.deepEqual(warningCodes(payload), [
            'NAVIGATION_REPAIR_REQUIRED',
            'SEARCH_PASS_FAILED:expanded'
        ]);
        const passWarning = payload.warnings.find(
            (warning: { code?: string }) => warning.code === 'SEARCH_PASS_FAILED:expanded'
        );
        assert.equal(passWarning?.severity, 'degraded');
        assert.match(passWarning?.message ?? '', /expanded semantic search pass failed/);
        assert.deepEqual(payload.hints?.debugSearch?.providerWork, {
            semanticSearchAttempts: 2,
            embeddingCallsByCurrentContract: 2,
            denseQueriesByCurrentContract: 2,
            sparseQueriesByCurrentContract: 2,
            rerankerCalls: 0,
            rerankerCandidates: 0,
            rerankerInputBytes: 0,
            candidatesWithSemanticEvidence: 1,
            candidatesWithLexicalEvidence: 0,
            candidatesWithCurrentSourceEvidence: 0,
        });
        assert.deepEqual(payload.hints?.debugSearch?.semanticExpansion, {
            expand: true,
            attempted: true,
            reason: 'primary_candidate_pool_small',
            primaryScopedCandidateCount: 1,
        });
    });
});

test('handleSearchCode returns error when all semantic passes fail', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('backend unavailable');
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'search_backend_failed');
        assert.equal(payload.resultMode, 'grouped');
        assert.deepEqual(payload.results, []);
        assert.match(payload.message, /all semantic search passes failed/i);
    });
});

test('handleSearchCode returns structured backend diagnostics when all semantic passes fail with stopped cluster', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('16 UNAUTHENTICATED: The action is unavailable under current cluster status STOPPED.');
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        assert.equal(response.isError, undefined);
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'vector_backend_unavailable');
        assert.equal(payload.code, 'ZILLIZ_CLUSTER_STOPPED');
        assert.equal(payload.freshnessDecision, null);
        assert.deepEqual(payload.results, []);
        assert.match(payload.hints.backend.nextSteps.join(' '), /Resume the Zilliz Cloud cluster/);
    });
});

test('handleSearchCode returns json envelope for collection limit errors', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => {
                throw new Error(COLLECTION_LIMIT_MESSAGE);
            },
            semanticSearch: async () => []
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        assert.equal(response.isError, true);
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'vector_backend_unavailable');
        assert.equal(payload.message, COLLECTION_LIMIT_MESSAGE);
        assert.deepEqual(payload.results, []);
        assert.equal(payload.hints?.backend?.provider, 'zilliz');
    });
});

test('handleSearchCode supports deterministic test-only fault injection for expanded pass', { concurrency: false }, async () => {
    await withTempRepo(async (repoPath) => {
        await withEnv({
            NODE_ENV: 'test',
            SATORI_TEST_FAIL_SEARCH_PASS: 'expanded'
        }, async () => {
            const context = {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                semanticSearch: async (...args: unknown[]) => {
                    const { query } = parseSemanticSearchInvocation(args);
                    if (query.includes('implementation runtime source entrypoint')) {
                        return [{
                            content: 'expanded pass hit',
                            relativePath: 'src/expanded.ts',
                            startLine: 1,
                            endLine: 2,
                            language: 'typescript',
                            score: 0.95,
                            indexedAt: '2026-01-01T00:30:00.000Z',
                            symbolId: 'sym_expanded',
                            symbolLabel: 'function expandedPass()'
                        }];
                    }
                    return [{
                        content: 'primary pass hit',
                        relativePath: 'src/primary.ts',
                        startLine: 1,
                        endLine: 2,
                        language: 'typescript',
                        score: 0.99,
                        indexedAt: '2026-01-01T00:30:00.000Z',
                        symbolId: 'sym_primary',
                        symbolLabel: 'function primaryPass()'
                    }];
                }
            } as unknown as HandlerContext;

            const snapshotManager = {
                getAllCodebases: () => [],
                getIndexedCodebases: () => [repoPath],
                getIndexingCodebases: () => [],
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
            } as unknown as HandlerSnapshotManager;

            const syncManager = {
                ensureFreshness: async () => ({
                    mode: 'skipped_recent',
                    checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    thresholdMs: 180000
                })
            } as unknown as HandlerSyncManager;

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'session token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].target.symbolId, undefined);
            assert.equal(payload.results[0].target.file, 'src/primary.ts');
            assert.deepEqual(warningCodes(payload), [
                'NAVIGATION_REPAIR_REQUIRED',
                'SEARCH_PASS_FAILED:expanded'
            ]);
            const passWarning = payload.warnings.find(
                (warning: { code?: string }) => warning.code === 'SEARCH_PASS_FAILED:expanded'
            );
            assert.equal(passWarning?.severity, 'degraded');
            assert.equal(response.meta?.searchDiagnostics?.searchPassFailureCount, 1);
        });
    });
});

test('handleSearchCode ignores fault injection env outside test mode', { concurrency: false }, async () => {
    await withTempRepo(async (repoPath) => {
        await withEnv({
            NODE_ENV: 'production',
            SATORI_TEST_FAIL_SEARCH_PASS: 'both'
        }, async () => {
            const context = {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                semanticSearch: async (...args: unknown[]) => {
                    const { query } = parseSemanticSearchInvocation(args);
                    if (query.includes('implementation runtime source entrypoint')) {
                        return [{
                            content: 'expanded pass hit',
                            relativePath: 'src/expanded.ts',
                            startLine: 1,
                            endLine: 2,
                            language: 'typescript',
                            score: 0.95,
                            indexedAt: '2026-01-01T00:30:00.000Z',
                            symbolId: 'sym_expanded',
                            symbolLabel: 'function expandedPass()'
                        }];
                    }
                    return [{
                        content: 'primary pass hit',
                        relativePath: 'src/primary.ts',
                        startLine: 1,
                        endLine: 2,
                        language: 'typescript',
                        score: 0.99,
                        indexedAt: '2026-01-01T00:30:00.000Z',
                        symbolId: 'sym_primary',
                        symbolLabel: 'function primaryPass()'
                    }];
                }
            } as unknown as HandlerContext;

            const snapshotManager = {
                getAllCodebases: () => [],
                getIndexedCodebases: () => [repoPath],
                getIndexingCodebases: () => [],
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
            } as unknown as HandlerSnapshotManager;

            const syncManager = {
                ensureFreshness: async () => ({
                    mode: 'skipped_recent',
                    checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    thresholdMs: 180000
                })
            } as unknown as HandlerSyncManager;

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'session token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 2);
            assert.deepEqual(warningCodes(payload), ['NAVIGATION_REPAIR_REQUIRED']);
            assert.equal(response.meta?.searchDiagnostics?.searchPassFailureCount, 0);
        });
    });
});

test('handleSearchCode returns deterministic all-pass error when test fault injection forces both passes', { concurrency: false }, async () => {
    await withTempRepo(async (repoPath) => {
        await withEnv({
            NODE_ENV: 'test',
            SATORI_TEST_FAIL_SEARCH_PASS: 'both'
        }, async () => {
            const context = {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                semanticSearch: async () => [{
                    content: 'primary pass hit',
                    relativePath: 'src/primary.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_primary',
                    symbolLabel: 'function primaryPass()'
                }]
            } as unknown as HandlerContext;

            const snapshotManager = {
                getAllCodebases: () => [],
                getIndexedCodebases: () => [repoPath],
                getIndexingCodebases: () => [],
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
            } as unknown as HandlerSnapshotManager;

            const syncManager = {
                ensureFreshness: async () => ({
                    mode: 'skipped_recent',
                    checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    thresholdMs: 180000
                })
            } as unknown as HandlerSyncManager;

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'session token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5
            });

            assert.equal(response.isError, true);
            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'not_ready');
            assert.equal(payload.reason, 'search_backend_failed');
            assert.equal(payload.resultMode, 'grouped');
            assert.deepEqual(payload.results, []);
            assert.match(payload.message, /all semantic search passes failed/i);
        });
    });
});

test('handleSearchCode requires_reindex payload includes compatibility diagnostics', async () => {
    await withTempRepo(async (repoPath) => {
        const legacyFingerprint: IndexFingerprint = {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-lite',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'dense_v3'
        };

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => []
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{
                path: repoPath,
                info: {
                    status: 'indexed',
                    indexedFiles: 10,
                    totalChunks: 40,
                    indexStatus: 'completed',
                    lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    indexFingerprint: legacyFingerprint,
                    fingerprintSource: 'verified',
                }
            }],
            getCodebaseInfo: () => ({
                status: 'indexed',
                indexedFiles: 10,
                totalChunks: 40,
                indexStatus: 'completed',
                lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                indexFingerprint: legacyFingerprint,
                fingerprintSource: 'verified',
            }),
            getCodebaseStatus: () => 'indexed',
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: false,
                changed: false,
                reason: 'fingerprint_mismatch',
                message: 'Legacy fingerprint mismatch.',
            })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'legacy mismatch',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'requires_reindex');
        assert.equal(payload.freshnessDecision.mode, 'skipped_requires_reindex');
        assert.equal(payload.compatibility.runtimeFingerprint.schemaVersion, 'hybrid_v3');
        assert.equal(payload.compatibility.indexedFingerprint.schemaVersion, 'dense_v3');
        assert.equal(payload.compatibility.reindexReason, 'fingerprint_mismatch');
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.equal(payload.recommendedNextAction?.args?.action, 'status');
        assert.equal(payload.recommendedNextAction?.args?.path, repoPath);
        assert.equal(payload.hints?.runtimeMismatch?.reason, 'runtime_fingerprint_mismatch');
        assert.match(payload.message, /restart Satori with VoyageAI\/voyage-4-lite\/1024\/Milvus\/dense_v3/i);
    });
});

async function runSearchFreshnessDecisionCase(
    decision: Record<string, unknown>,
    expected: {
        status: string;
        reason?: string;
        semanticSearchCalls: number;
        messageIncludes?: string;
        completionProofCalls?: number;
    }
): Promise<SearchFreshnessDecisionPayload> {
    let semanticSearchCalls = 0;
    let ensureFreshnessCalls = 0;
    let completionProofCalls = 0;

    return withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                semanticSearchCalls += 1;
                return [{
                    content: 'export function freshRuntime() { return true; }',
                    relativePath: 'src/runtime.ts',
                    startLine: 1,
                    endLine: 1,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'fresh_runtime',
                    symbolLabel: 'function freshRuntime()'
                }];
            }
        } as unknown as HandlerContext;

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return decision;
            }
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => {
            completionProofCalls += 1;
            return { outcome: 'ok' };
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(ensureFreshnessCalls, 1);
        assert.equal(completionProofCalls, expected.completionProofCalls ?? 2);
        assert.equal(semanticSearchCalls, expected.semanticSearchCalls);
        assert.equal(payload.status, expected.status);
        if (expected.reason) {
            assert.equal(payload.reason, expected.reason);
        }
        assert.equal(payload.freshnessDecision?.mode, decision.mode);
        if (expected.messageIncludes) {
            assert.match(String(payload.message || ''), new RegExp(expected.messageIncludes));
        }
        return payload;
    });
}

test('handleSearchCode blocks skipped_requires_reindex freshness before vector search', async () => {
    const payload = await runSearchFreshnessDecisionCase({
        mode: 'skipped_requires_reindex',
        checkedAt: '2026-01-01T00:00:00.000Z',
        thresholdMs: 180000,
        errorMessage: 'navigation recovery failed'
    }, {
        status: 'requires_reindex',
        reason: 'requires_reindex',
        semanticSearchCalls: 0
    });

    assert.equal(payload.hints?.reindex?.tool, 'manage_index');
    assert.equal(payload.hints?.reindex?.args?.action, 'reindex');
    assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
    assert.equal(payload.recommendedNextAction?.args?.action, 'reindex');
});

test('handleSearchCode blocks skipped_missing_path freshness before vector search', async () => {
    const payload = await runSearchFreshnessDecisionCase({
        mode: 'skipped_missing_path',
        checkedAt: '2026-01-01T00:00:00.000Z',
        thresholdMs: 180000
    }, {
        status: 'not_indexed',
        reason: 'not_indexed',
        semanticSearchCalls: 0,
        messageIncludes: 'no longer exists'
    });

    assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
    assert.equal(payload.recommendedNextAction?.args?.action, 'create');
});

test('handleSearchCode blocks ignore_reload_failed freshness before vector search', async () => {
    const payload = await runSearchFreshnessDecisionCase({
        mode: 'ignore_reload_failed',
        checkedAt: '2026-01-01T00:00:00.000Z',
        thresholdMs: 180000,
        errorMessage: 'forced ignore reload failure',
        fallbackSyncExecuted: true
    }, {
        status: 'requires_reindex',
        reason: 'requires_reindex',
        semanticSearchCalls: 0,
        messageIncludes: 'ignore-rule reconciliation failed'
    });

    assert.match(payload.message, /Fallback incremental sync was executed/);
    assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
    assert.equal(payload.recommendedNextAction?.args?.action, 'reindex');
});

test('handleSearchCode blocks failed coalesced freshness before vector search', async () => {
    const payload = await runSearchFreshnessDecisionCase({
        mode: 'coalesced',
        checkedAt: '2026-01-01T00:00:00.000Z',
        thresholdMs: 180000,
        errorMessage: 'coalesced sync failed'
    }, {
        status: 'requires_reindex',
        reason: 'requires_reindex',
        semanticSearchCalls: 0,
        messageIncludes: 'coalesced in-flight sync failed'
    });

    assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
    assert.equal(payload.recommendedNextAction?.args?.action, 'reindex');
});

test('handleSearchCode allows successful coalesced freshness reuse', async () => {
    const payload = await runSearchFreshnessDecisionCase({
        mode: 'coalesced',
        checkedAt: '2026-01-01T00:00:00.000Z',
        thresholdMs: 180000
    }, {
        status: 'ok',
        semanticSearchCalls: 2,
        completionProofCalls: 2
    });

    assert.equal(payload.results.length, 1);
});

test('handleSearchCode syncs missing completion marker when snapshot is verified', async () => {
    let semanticSearchCalls = 0;
    let ensureFreshnessCalls = 0;
    let completionProofCalls = 0;

    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                semanticSearchCalls += 1;
                return [{
                    content: 'export function syncedRuntime() { return true; }',
                    relativePath: 'src/runtime.ts',
                    startLine: 1,
                    endLine: 1,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'synced_runtime',
                    symbolLabel: 'function syncedRuntime()'
                }];
            }
        } as unknown as HandlerContext;

        const codebaseInfo = {
            status: 'indexed',
            indexedFiles: 1,
            totalChunks: 1,
            indexStatus: 'completed',
            lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified',
            collectionName: 'hybrid_code_chunks_committed',
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseCollectionName: () => 'hybrid_code_chunks_committed',
            getCodebaseStatus: () => 'indexed',
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return {
                    mode: 'synced',
                    checkedAt: '2026-01-01T00:00:00.000Z',
                    thresholdMs: 180000,
                    changed: true,
                    lastSyncAt: '2026-01-01T00:00:00.000Z'
                };
            }
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => {
            completionProofCalls += 1;
            return completionProofCalls === 1
                ? { outcome: 'stale_local', reason: 'missing_marker_doc' }
                : { outcome: 'valid' };
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(ensureFreshnessCalls, 1);
        assert.equal(completionProofCalls, 2);
        assert.equal(semanticSearchCalls > 0, true);
        assert.equal(payload.status, 'ok');
        assert.equal(payload.freshnessDecision?.mode, 'synced');
    });
});

test('handleSearchCode fails closed when readiness degrades to stale_local after freshness', async () => {
    let semanticSearchCalls = 0;
    let ensureFreshnessCalls = 0;
    let completionProofCalls = 0;

    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                semanticSearchCalls += 1;
                throw new Error('semanticSearch should not run after post-freshness stale_local degradation');
            }
        } as unknown as HandlerContext;

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return {
                    mode: 'synced',
                    checkedAt: '2026-01-01T00:00:00.000Z',
                    thresholdMs: 180000,
                    changed: false,
                    lastSyncAt: '2026-01-01T00:00:00.000Z'
                };
            }
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => {
            completionProofCalls += 1;
            return completionProofCalls === 1
                ? { outcome: 'valid' }
                : { outcome: 'stale_local', reason: 'missing_marker_doc' };
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(ensureFreshnessCalls, 1);
        assert.equal(completionProofCalls, 2);
        assert.equal(semanticSearchCalls, 0);
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.match(String(payload.message || ''), /stale local index metadata/i);
        assert.equal(payload.hints?.staleLocal?.completionProof, 'missing_marker_doc');
        assert.equal(payload.hints?.create?.tool, 'manage_index');
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.deepEqual(payload.recommendedNextAction?.args, { action: 'repair', path: repoPath });
        assert.equal(payload.hints?.sync, undefined);
    });
});

test('handleSearchCode fails closed when collection disappears after freshness recheck', async () => {
    let semanticSearchCalls = 0;
    let ensureFreshnessCalls = 0;
    let collectionProbeCalls = 0;

    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                semanticSearchCalls += 1;
                throw new Error('semanticSearch should not run after post-freshness missing collection degradation');
            }
        } as unknown as HandlerContext;

        const codebaseInfo = {
            status: 'indexed',
            lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            indexFingerprint: RUNTIME_FINGERPRINT,
            fingerprintSource: 'verified'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: codebaseInfo }],
            getCodebaseInfo: () => codebaseInfo,
            getCodebaseStatus: () => 'indexed',
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return {
                    mode: 'synced',
                    checkedAt: '2026-01-01T00:00:00.000Z',
                    thresholdMs: 180000,
                    changed: false,
                    lastSyncAt: '2026-01-01T00:00:00.000Z'
                };
            }
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({ outcome: 'valid' });
        (handlers as unknown as ToolHandlersTestOverrides).probeLocalSearchCollectionState = async () => {
            collectionProbeCalls += 1;
            return collectionProbeCalls === 1
                ? { state: 'ready', collectionName: 'test_collection' }
                : { state: 'missing', collectionName: 'test_collection' };
        };

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(ensureFreshnessCalls, 1);
        assert.equal(collectionProbeCalls, 2);
        assert.equal(semanticSearchCalls, 0);
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.match(String(payload.message || ''), /stale local index metadata/i);
        assert.match(String(payload.message || ''), /test_collection/i);
        assert.equal(payload.hints?.create?.tool, 'manage_index');
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.deepEqual(payload.recommendedNextAction?.args, { action: 'create', path: repoPath });
    });
});

test('handleSearchCode not_indexed payload includes stable reason code', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => []
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [],
            getCodebaseInfo: () => undefined,
            getCodebaseStatus: () => 'not_found',
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.equal(payload.hints?.create?.tool, 'manage_index');
        assert.equal(payload.hints?.create?.args?.action, 'create');
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.equal(payload.recommendedNextAction?.args?.action, 'create');
        assert.equal(payload.recommendedNextAction?.args?.path, repoPath);
    });
});

test('handleSearchCode failed-index payload preserves failure diagnostics', async () => {
    await withTempRepo(async (repoPath) => {
        const failedInfo = {
            status: 'indexfailed',
            errorMessage: 'Interrupted indexing detected without completion marker proof.',
            lastAttemptedPercentage: 0,
            lastUpdated: '2026-06-19T12:15:18.574Z'
        };
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('semanticSearch should not run for failed indexes');
            }
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: failedInfo }],
            getCodebaseInfo: () => failedInfo,
            getCodebaseStatus: () => 'indexfailed',
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => {
                throw new Error('ensureFreshness should not run for failed indexes');
            }
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-06-19T12:20:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'index_failed');
        assert.equal(payload.codebasePath, repoPath);
        assert.match(payload.message, /Interrupted indexing detected without completion marker proof/i);
        assert.match(payload.message, /0\.0%/);
        assert.equal(payload.indexingFailure?.errorMessage, failedInfo.errorMessage);
        assert.equal(payload.indexingFailure?.lastAttemptedPercentage, 0);
        assert.equal(payload.indexingFailure?.lastUpdated, failedInfo.lastUpdated);
        assert.equal(payload.hints?.create?.tool, 'manage_index');
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.deepEqual(payload.recommendedNextAction?.args, { action: 'create', path: repoPath });
    });
});

test('handleSearchCode indexing payload recommends manage_index status', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('semanticSearch should not run while indexing');
            }
        } as unknown as HandlerContext;

        const indexingInfo = {
            status: 'indexing',
            indexingPercentage: 42,
            lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString()
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: indexingInfo }],
            getCodebaseInfo: () => indexingInfo,
            getCodebaseStatus: () => 'indexing',
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [repoPath],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;

        const syncManager = {
            ensureFreshness: async () => {
                throw new Error('ensureFreshness should not run while indexing');
            }
        } as unknown as HandlerSyncManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'indexing');
        assert.equal(payload.recommendedNextAction?.tool, 'manage_index');
        assert.equal(payload.recommendedNextAction?.args?.action, 'status');
        assert.equal(payload.recommendedNextAction?.args?.path, repoPath);
        assert.equal(payload.indexing?.progressPct, 42);
    });
});
