import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRecordsForFile,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    resetSharedRuntimeNavigationStoreForTests,
    resolveNavigationSidecarRoot,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from '@zokizuan/satori-core';
import type { RelationshipRecord, SymbolRecord, SymbolRegistryManifest } from '@zokizuan/satori-core';
import { readFileTool } from '../tools/read_file.js';
import type { ToolContext } from '../tools/types.js';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

const CAPABILITIES = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

type GoldenContext = {
    repoPath: string;
    stateRoot?: string;
    symbols?: SymbolRecord[];
};

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type ToolTextResponse = { content?: Array<{ text?: string }> };
type SearchFixtureResult = {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
    indexedAt: string;
    symbolId: string;
    symbolLabel: string;
};
type ToolHandlersTestOverrides = {
    validateCompletionProof: (repoPath: string) => Promise<{ outcome: 'ok' }>;
};

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-golden-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

async function withTempStateRoot<T>(fn: (stateRoot: string) => Promise<T>): Promise<T> {
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-golden-state-'));
    process.env.SATORI_STATE_ROOT = stateRoot;
    resetSharedRuntimeNavigationStoreForTests();
    try {
        return await fn(stateRoot);
    } finally {
        resetSharedRuntimeNavigationStoreForTests();
        if (previousStateRoot === undefined) {
            delete process.env.SATORI_STATE_ROOT;
        } else {
            process.env.SATORI_STATE_ROOT = previousStateRoot;
        }
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }
}

function createFunctionSymbol(input: {
    file: string;
    name: string;
    startLine: number;
    endLine: number;
    fileHash: string;
    language?: string;
    label?: string;
    kind?: SymbolRecord['kind'];
}): SymbolRecord {
    const language = input.language || 'typescript';
    const kind = input.kind || 'function';
    const qualifiedName = input.name;
    const parentQualifiedNamePath: string[] = [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language,
        kind,
        qualifiedName,
        parentQualifiedNamePath,
    });
    const span = { startLine: input.startLine, endLine: input.endLine };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash: input.fileHash,
            span,
            extractorVersion: 'test-extractor-v1',
        }),
        language,
        kind,
        name: input.name,
        qualifiedName,
        label: input.label || `function ${input.name}()`,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: 'test-extractor-v1',
    };
}

function sha256Content(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function writeNavigationSidecars(input: {
    stateRoot: string;
    repoPath: string;
    symbols: SymbolRecord[];
    records?: RelationshipRecord[];
    relationshipManifestHash?: string;
}) {
    const filesByPath = new Map<string, { hash: string; language: string; symbolCount: number }>();
    for (const symbol of input.symbols) {
        const existing = filesByPath.get(symbol.file);
        if (existing) {
            existing.symbolCount += 1;
        } else {
            filesByPath.set(symbol.file, {
                hash: symbol.fileHash,
                language: symbol.language,
                symbolCount: 1,
            });
        }
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
        files: [...filesByPath.entries()].map(([file, metadata]) => ({
            path: file,
            hash: metadata.hash,
            language: metadata.language,
            symbolCount: metadata.symbolCount,
        })),
    };

    const registry = buildSymbolRegistry({ manifest, symbols: input.symbols });
    const registryResult = await writeSymbolRegistrySidecar({
        stateRoot: input.stateRoot,
        registry,
    });
    await writeRelationshipSidecar({
        stateRoot: input.stateRoot,
        normalizedRootPath: input.repoPath,
        symbolRegistryManifestHash: input.relationshipManifestHash || registryResult.manifestHash,
        relationshipVersion: 'test-relationships-v1',
        builtAt: '2026-01-01T00:00:00.000Z',
        files: manifest.files,
        records: input.records || [],
    });
    return { registry, manifestHash: registryResult.manifestHash };
}

async function writeSearchNavigationSidecars(input: {
    stateRoot: string;
    repoPath: string;
    relativePath: string;
    content: string;
    chunks: Array<{
        content: string;
        startLine: number;
        endLine: number;
        symbolLabel: string;
    }>;
}) {
    const fileHash = 'test-search-file-hash';
    const symbols = buildSymbolRecordsForFile({
        relativePath: input.relativePath,
        language: 'typescript',
        content: input.content,
        fileHash,
        extractorVersion: 'test-extractor-v1',
        chunks: input.chunks.map((chunk) => ({
            content: chunk.content,
            metadata: {
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                language: 'typescript',
                filePath: input.relativePath,
                symbolLabel: chunk.symbolLabel,
            },
        })),
    });
    const { manifestHash } = await writeNavigationSidecars({
        stateRoot: input.stateRoot,
        repoPath: input.repoPath,
        symbols,
        records: [],
    });
    return { symbols, manifestHash, fileHash };
}

function createSnapshotManager(repoPath: string, info: Record<string, unknown> = { status: 'indexed' }): HandlerSnapshotManager {
    return {
        getAllCodebases: () => [{ path: repoPath, info }],
        getIndexedCodebases: () => [repoPath],
        getIndexingCodebases: () => [],
        getCodebaseInfo: () => info,
        getCodebaseStatus: () => info.status || 'indexed',
        getCodebaseCallGraphSidecar: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined,
    } as unknown as HandlerSnapshotManager;
}

function createHandlers(repoPath: string, searchResults: SearchFixtureResult[] = []) {
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getVectorStore: () => ({ listCollections: async () => [] }),
        semanticSearch: async () => searchResults,
    } as unknown as HandlerContext;
    const syncManager = {
        ensureFreshness: async () => ({
            mode: 'skipped_recent',
            checkedAt: '2026-01-01T00:00:00.000Z',
            thresholdMs: 180000,
        }),
        touchWatchedCodebase: async () => undefined,
    } as unknown as HandlerSyncManager;

    const snapshotManager = createSnapshotManager(repoPath);
    const handlers = new ToolHandlers(
        context,
        snapshotManager,
        syncManager,
        RUNTIME_FINGERPRINT,
        CAPABILITIES,
        () => Date.parse('2026-01-01T01:00:00.000Z'),
    );
    (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({ outcome: 'ok' });
    return { handlers, snapshotManager, syncManager };
}

function createFailedIndexHandlers(repoPath: string) {
    const failedInfo = {
        status: 'indexfailed',
        errorMessage: 'Interrupted indexing detected without completion marker proof.',
        lastAttemptedPercentage: 0,
        lastUpdated: '2026-06-19T12:15:18.574Z',
    };
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getVectorStore: () => ({ listCollections: async () => [] }),
        semanticSearch: async () => {
            throw new Error('semanticSearch should not run for failed indexes');
        },
    } as unknown as HandlerContext;
    const snapshotManager = {
        getAllCodebases: () => [{ path: repoPath, info: failedInfo }],
        getIndexedCodebases: () => [],
        getIndexingCodebases: () => [],
        getCodebaseInfo: () => failedInfo,
        getCodebaseStatus: () => 'indexfailed',
        getCodebaseCallGraphSidecar: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined,
    } as unknown as HandlerSnapshotManager;
    const syncManager = {
        ensureFreshness: async () => {
            throw new Error('ensureFreshness should not run for failed indexes');
        },
        touchWatchedCodebase: async () => undefined,
    } as unknown as HandlerSyncManager;

    return {
        handlers: new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-06-19T12:20:00.000Z'),
        ),
        snapshotManager,
        syncManager,
    };
}

function createReadFileToolContext(input: {
    handlers: ToolHandlers;
    snapshotManager: ToolContext['snapshotManager'];
    syncManager: ToolContext['syncManager'];
    readFileMaxLines?: number;
}): ToolContext {
    return {
        context: {} as ToolContext['context'],
        snapshotManager: input.snapshotManager,
        syncManager: input.syncManager,
        capabilities: CAPABILITIES,
        reranker: null,
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        toolHandlers: input.handlers,
        readFileMaxLines: input.readFileMaxLines ?? 1000,
    };
}

function parsePayload(response: ToolTextResponse): unknown {
    return JSON.parse(response.content?.[0]?.text || '{}');
}

function symbolPlaceholder(symbol: SymbolRecord): string {
    return `<symbol:${symbol.kind}:${symbol.name}>`;
}

function symbolKeyPlaceholder(symbol: SymbolRecord): string {
    return `<symbol-key:${symbol.kind}:${symbol.name}>`;
}

function scrubGolden(value: unknown, context: GoldenContext): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => scrubGolden(entry, context));
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, raw] of Object.entries(value)) {
            if (key === 'score' && typeof raw === 'number') {
                result[key] = '<score>';
                continue;
            }
            result[key] = scrubGolden(raw, context);
        }
        return result;
    }
    if (typeof value !== 'string') {
        return value;
    }

    let output = value;
    output = output.replaceAll(context.repoPath, '<repo>');
    if (context.stateRoot) {
        output = output.replaceAll(context.stateRoot, '<state>');
    }
    for (const symbol of context.symbols || []) {
        output = output.replaceAll(symbol.symbolInstanceId, symbolPlaceholder(symbol));
        output = output.replaceAll(symbol.symbolKey, symbolKeyPlaceholder(symbol));
    }
    output = output.replace(/[a-f0-9]{64}/g, '<hash>');
    return output;
}

test('golden MCP search_codebase grouped symbol result shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const relativePath = 'src/auth.ts';
        const filePath = path.join(repoPath, relativePath);
        const content = [
            'function normalizeToken(token: string) {',
            '  return token.trim();',
            '}',
            '',
            'function validateSession(token: string) {',
            '  return normalizeToken(token).length > 0;',
            '}',
            '',
        ].join('\n');
        fs.writeFileSync(filePath, content, 'utf8');
        const { symbols, manifestHash, fileHash } = await writeSearchNavigationSidecars({
            stateRoot,
            repoPath,
            relativePath,
            content,
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
        const normalizeSymbol = symbols.find((symbol) => symbol.name === 'normalizeToken');
        const validateSymbol = symbols.find((symbol) => symbol.name === 'validateSession');
        assert.ok(normalizeSymbol);
        assert.ok(validateSymbol);
        await writeRelationshipSidecar({
            stateRoot,
            normalizedRootPath: repoPath,
            symbolRegistryManifestHash: manifestHash,
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: [{
                path: relativePath,
                hash: fileHash,
                language: 'typescript',
                symbolCount: symbols.length,
            }],
            records: [{
                sourceKey: validateSymbol.symbolKey,
                sourceInstanceId: validateSymbol.symbolInstanceId,
                targetKey: normalizeSymbol.symbolKey,
                targetInstanceId: normalizeSymbol.symbolInstanceId,
                type: 'CALLS',
                file: relativePath,
                span: { startLine: 6, endLine: 6 },
                confidence: 'high',
            }],
        });

        const { handlers } = createHandlers(repoPath, [{
            content: 'return normalizeToken(token).length > 0;',
            relativePath,
            startLine: 5,
            endLine: 7,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolLabel: validateSymbol.label,
            ownerSymbolKey: validateSymbol.symbolKey,
            ownerSymbolInstanceId: validateSymbol.symbolInstanceId,
            symbolKind: validateSymbol.kind,
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        });

        const payload = scrubGolden(parsePayload(response), {
            repoPath,
            stateRoot,
            symbols,
        });
        assert.deepEqual(payload, {
            status: 'ok',
            path: '<repo>',
            query: 'validate session',
            scope: 'runtime',
            groupBy: 'symbol',
            limit: 5,
            resultMode: 'grouped',
            freshnessDecision: {
                mode: 'skipped_recent',
                checkedAt: '2026-01-01T00:00:00.000Z',
                thresholdMs: 180000,
            },
            freshnessSummary: {
                syncMode: 'skipped_recent',
                lastSyncAt: null,
                changedFileCount: 0,
                gitDirtyFilesConsidered: false,
                changedFilesBoostApplied: false,
                changedFilesBoostSkippedForLargeChangeSet: false,
            },
            hints: {
                version: 1,
                navigation: {
                    nextStep: 'Use recommendedNextAction when present. Call call_graph only when nextActions.callGraph is present and callGraphHint.supported=true.',
                },
            },
            recommendedNextAction: {
                resultIndex: 0,
                tool: 'read_file',
                args: {
                    path: '<repo>/src/auth.ts',
                    open_symbol: {
                        symbolId: '<symbol:function:validateSession>',
                        symbolLabel: 'function validateSession(token: string)',
                    },
                },
                reason: 'Open the selected owner before graph traversal so edits are grounded in source.',
            },
            results: [{
                kind: 'group',
                groupId: '<symbol:function:validateSession>',
                file: 'src/auth.ts',
                span: { startLine: 5, endLine: 7 },
                previewSpan: { startLine: 5, endLine: 7 },
                symbolSpan: { startLine: 5, endLine: 7 },
                language: 'typescript',
                symbolId: '<symbol:function:validateSession>',
                symbolLabel: 'function validateSession(token: string)',
                symbolKey: '<symbol-key:function:validateSession>',
                symbolInstanceId: '<symbol:function:validateSession>',
                symbolKind: 'function',
                confidence: 'medium',
                score: '<score>',
                indexedAt: '2026-01-01T00:30:00.000Z',
                stalenessBucket: 'fresh',
                collapsedChunkCount: 1,
                callGraphHint: {
                    supported: true,
                    validated: true,
                    validatedAt: '2026-01-01T01:00:00.000Z',
                    sidecarBuiltAt: '2026-01-01T00:00:00.000Z',
                    symbolRef: {
                        file: 'src/auth.ts',
                        symbolId: '<symbol:function:validateSession>',
                        symbolLabel: 'function validateSession(token: string)',
                        span: { startLine: 5, endLine: 7 },
                    },
                },
                capabilities: {
                    openSymbol: 'medium',
                    callGraphCallers: 'low',
                    callGraphCallees: 'medium',
                    semanticMatch: 'medium',
                },
                nextActions: {
                    openSymbol: {
                        tool: 'read_file',
                        args: {
                            path: '<repo>/src/auth.ts',
                            open_symbol: {
                                symbolId: '<symbol:function:validateSession>',
                                symbolLabel: 'function validateSession(token: string)',
                            },
                        },
                    },
                    callGraph: {
                        tool: 'call_graph',
                        args: {
                            path: '<repo>',
                            symbolRef: {
                                file: 'src/auth.ts',
                                symbolId: '<symbol:function:validateSession>',
                                symbolLabel: 'function validateSession(token: string)',
                                span: { startLine: 5, endLine: 7 },
                            },
                            depth: 1,
                            limit: 20,
                        },
                        directions: ['callers', 'callees'],
                    },
                    outlineWindow: {
                        tool: 'file_outline',
                        args: {
                            path: '<repo>',
                            file: 'src/auth.ts',
                            start_line: 5,
                            end_line: 7,
                            resolveMode: 'outline',
                        },
                    },
                },
                recommendedNextAction: {
                    tool: 'read_file',
                    args: {
                        path: '<repo>/src/auth.ts',
                        open_symbol: {
                            symbolId: '<symbol:function:validateSession>',
                            symbolLabel: 'function validateSession(token: string)',
                        },
                    },
                    reason: 'Open the selected owner before graph traversal so edits are grounded in source.',
                },
                fallbacks: [{
                    when: 'call_graph returns no edges or relationship confidence is lower than the edit needs',
                    tool: 'search_codebase',
                    args: {
                        path: '<repo>',
                        query: 'must:validateSession validateSession',
                        scope: 'runtime',
                        resultMode: 'grouped',
                        groupBy: 'symbol',
                        limit: 5,
                    },
                    reason: 'Inbound graph coverage can be incomplete; exact lexical search verifies references before impact analysis.',
                }],
                preview: 'function validateSession(token: string)\nreturn normalizeToken(token).length > 0;',
            }],
        });
    }));
});

test('golden MCP file_outline ok shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src/runtime.ts');
        fs.writeFileSync(filePath, 'export function run() {\n  return true;\n}\n', 'utf8');
        const run = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'run',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
            label: 'function run()',
        });
        await writeNavigationSidecars({ stateRoot, repoPath, symbols: [run] });
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot, symbols: [run] });
        assert.deepEqual(payload, {
            status: 'ok',
            path: '<repo>',
            file: 'src/runtime.ts',
            outline: {
                symbols: [{
                    symbolId: '<symbol:function:run>',
                    symbolLabel: 'function run()',
                    span: { startLine: 1, endLine: 3 },
                    callGraphHint: {
                        supported: true,
                        validated: true,
                        validatedAt: '2026-01-01T01:00:00.000Z',
                        sidecarBuiltAt: '2026-01-01T00:00:00.000Z',
                        symbolRef: {
                            file: 'src/runtime.ts',
                            symbolId: '<symbol:function:run>',
                            symbolLabel: 'function run()',
                            span: { startLine: 1, endLine: 3 },
                        },
                    },
                }],
            },
            hasMore: false,
        });
    }));
});

test('golden MCP file_outline missing registry requires_reindex shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, 'src/runtime.ts'), 'export function run() {}\n', 'utf8');
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'requires_reindex',
            reason: 'missing_symbol_registry',
            path: '<repo>',
            file: 'src/runtime.ts',
            outline: null,
            hasMore: false,
            message: "symbol registry manifest is missing\n\nRelationship-backed navigation sidecars are missing or incompatible. Please run manage_index with {\"action\":\"reindex\",\"path\":\"<repo>\"}.",
            hints: {
                reindex: {
                    tool: 'manage_index',
                    args: { action: 'reindex', path: '<repo>' },
                },
            },
        });
    }));
});

test('golden MCP file_outline unsupported language shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, 'src/notes.txt'), 'plain text notes\n', 'utf8');
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/notes.txt',
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'unsupported',
            reason: 'unsupported_language',
            path: '<repo>',
            file: 'src/notes.txt',
            outline: null,
            hasMore: false,
            message: "File 'src/notes.txt' is not supported for sidecar outline. Supported extensions: .cjs, .cts, .go, .js, .jsx, .mjs, .mts, .py, .rs, .ts, .tsx.",
        });
    }));
});

test('golden MCP call_graph invalid symbol ref shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: repoPath,
        });

        assert.equal(response.isError, true);
        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'not_found',
            supported: false,
            reason: 'invalid_symbol_ref',
            path: '<repo>',
            symbolRef: {
                file: '',
                symbolId: '',
            },
            direction: 'both',
            depth: 1,
            limit: 20,
            nodes: [],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
            message: 'symbolRef with { file, symbolId } is required.',
        });
    }));
});

test('golden MCP search_codebase invalid root shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const missingRoot = path.join(repoPath, 'missing-root');
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleSearchCode({
            path: missingRoot,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            rankingMode: 'auto_changed_first',
            limit: 10,
        });

        assert.equal(response.isError, true);
        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'not_indexed',
            reason: 'not_indexed',
            path: '<repo>/missing-root',
            query: 'runtime',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 10,
            freshnessDecision: null,
            message: "Path '<repo>/missing-root' does not exist. search_codebase requires an existing directory root or subdirectory.",
            results: [],
        });
    }));
});

test('golden MCP search_codebase failed index shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const { handlers } = createFailedIndexHandlers(repoPath);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'not_indexed',
            reason: 'index_failed',
            codebasePath: '<repo>',
            path: '<repo>',
            query: 'runtime',
            scope: 'runtime',
            groupBy: 'symbol',
            resultMode: 'grouped',
            limit: 5,
            freshnessDecision: null,
            message: "Codebase '<repo>' has a failed indexing attempt. Error: Interrupted indexing detected without completion marker proof. Failed at: 0.0% progress. Failed at: 2026-06-19T12:15:18.574Z. Satori will not serve semantic results from an unproven partial index. Run manage_index with {\"action\":\"create\",\"path\":\"<repo>\"} to restart indexing for this failed state.",
            indexingFailure: {
                errorMessage: 'Interrupted indexing detected without completion marker proof.',
                lastAttemptedPercentage: 0,
                lastUpdated: '2026-06-19T12:15:18.574Z',
            },
            recommendedNextAction: {
                tool: 'manage_index',
                args: { action: 'create', path: '<repo>' },
                reason: 'Restart indexing because the previous attempt failed before completion marker proof.',
            },
            hints: {
                create: {
                    tool: 'manage_index',
                    args: { action: 'create', path: '<repo>' },
                },
                status: {
                    tool: 'manage_index',
                    args: { action: 'status', path: '<repo>' },
                },
            },
            results: [],
        });
    }));
});

test('golden MCP file_outline invalid root shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const missingRoot = path.join(repoPath, 'missing-root');
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleFileOutline({
            path: missingRoot,
            file: 'src/runtime.ts',
        });

        assert.equal(response.isError, true);
        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'not_indexed',
            reason: 'not_indexed',
            path: '<repo>/missing-root',
            file: 'src/runtime.ts',
            outline: null,
            hasMore: false,
            message: "Path '<repo>/missing-root' does not exist. file_outline requires an indexed codebase directory root.",
        });
    }));
});

test('golden MCP file_outline failed index shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const { handlers } = createFailedIndexHandlers(repoPath);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'not_indexed',
            reason: 'index_failed',
            path: '<repo>',
            codebaseRoot: '<repo>',
            file: 'src/runtime.ts',
            outline: null,
            hasMore: false,
            message: "Codebase '<repo>' has a failed indexing attempt. Error: Interrupted indexing detected without completion marker proof. Failed at: 0.0% progress. Failed at: 2026-06-19T12:15:18.574Z. Satori will not serve semantic results from an unproven partial index. Run manage_index with {\"action\":\"create\",\"path\":\"<repo>\"} to restart indexing for this failed state.",
            indexingFailure: {
                errorMessage: 'Interrupted indexing detected without completion marker proof.',
                lastAttemptedPercentage: 0,
                lastUpdated: '2026-06-19T12:15:18.574Z',
            },
            hints: {
                create: {
                    tool: 'manage_index',
                    args: { action: 'create', path: '<repo>' },
                },
                status: {
                    tool: 'manage_index',
                    args: { action: 'status', path: '<repo>' },
                },
            },
        });
    }));
});

test('golden MCP call_graph invalid root shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const missingRoot = path.join(repoPath, 'missing-root');
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: missingRoot,
            symbolRef: { file: 'src/runtime.ts', symbolId: 'sym_runtime' },
        });

        assert.equal(response.isError, true);
        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'not_indexed',
            supported: false,
            reason: 'not_indexed',
            path: '<repo>/missing-root',
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime',
            },
            direction: 'both',
            depth: 1,
            limit: 20,
            nodes: [],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
            message: "Path '<repo>/missing-root' does not exist. call_graph requires an indexed codebase directory root.",
        });
    }));
});

test('golden MCP call_graph failed index shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const { handlers } = createFailedIndexHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: { file: 'src/runtime.ts', symbolId: 'sym_runtime_run' },
            direction: 'both',
            depth: 1,
            limit: 20,
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot });
        assert.deepEqual(payload, {
            status: 'not_indexed',
            supported: false,
            reason: 'index_failed',
            path: '<repo>',
            codebaseRoot: '<repo>',
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run',
            },
            direction: 'both',
            depth: 1,
            limit: 20,
            nodes: [],
            edges: [],
            notes: [],
            message: "Codebase '<repo>' has a failed indexing attempt. Error: Interrupted indexing detected without completion marker proof. Failed at: 0.0% progress. Failed at: 2026-06-19T12:15:18.574Z. Satori will not serve semantic results from an unproven partial index. Run manage_index with {\"action\":\"create\",\"path\":\"<repo>\"} to restart indexing for this failed state.",
            indexingFailure: {
                errorMessage: 'Interrupted indexing detected without completion marker proof.',
                lastAttemptedPercentage: 0,
                lastUpdated: '2026-06-19T12:15:18.574Z',
            },
            hints: {
                create: {
                    tool: 'manage_index',
                    args: { action: 'create', path: '<repo>' },
                },
                status: {
                    tool: 'manage_index',
                    args: { action: 'status', path: '<repo>' },
                },
            },
        });
    }));
});

test('golden MCP call_graph unsupported_language shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src/service.go');
        fs.writeFileSync(filePath, 'package svc\n\nfunc add() int {\n  return 1\n}\n', 'utf8');
        const add = createFunctionSymbol({
            file: 'src/service.go',
            name: 'add',
            startLine: 3,
            endLine: 5,
            fileHash: 'hash-go',
            language: 'go',
            label: 'function add',
        });
        await writeNavigationSidecars({ stateRoot, repoPath, symbols: [add] });
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: { file: 'src/service.go', symbolId: add.symbolInstanceId },
            direction: 'both',
            depth: 1,
            limit: 20,
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot, symbols: [add] });
        assert.deepEqual(payload, {
            status: 'unsupported',
            path: '<repo>',
            symbolRef: {
                file: 'src/service.go',
                symbolId: '<symbol:function:add>',
            },
            supported: false,
            reason: 'unsupported_language',
            message: "Language 'go' does not support relationship-backed call graph traversal.",
            nodes: [],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
        });
    }));
});

test('golden MCP call_graph stale symbol id shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const originalContent = 'export function run() {\n  return true;\n}\n';
        const filePath = path.join(repoPath, 'src/runtime.ts');
        fs.writeFileSync(filePath, originalContent, 'utf8');
        const run = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'run',
            startLine: 1,
            endLine: 3,
            fileHash: sha256Content(originalContent),
            label: 'function run()',
        });
        await writeNavigationSidecars({ stateRoot, repoPath, symbols: [run] });
        fs.writeFileSync(filePath, 'export function run() {\n  return false;\n}\n', 'utf8');
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: { file: 'src/runtime.ts', symbolId: run.symbolInstanceId },
            direction: 'both',
            depth: 1,
            limit: 20,
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot, symbols: [run] });
        assert.deepEqual(payload, {
            status: 'not_found',
            path: '<repo>',
            symbolRef: { file: 'src/runtime.ts', symbolId: '<symbol:function:run>' },
            direction: 'both',
            depth: 1,
            limit: 20,
            supported: false,
            reason: 'stale_symbol_ref',
            message: "Symbol reference for 'src/runtime.ts' is stale relative to the current file contents. Refresh the index before using exact call graph navigation.",
            nodes: [],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
        });
    }));
});

test('golden MCP call_graph missing relationship sidecar shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const run = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'run',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
            label: 'function run()',
        });
        await writeNavigationSidecars({ stateRoot, repoPath, symbols: [run] });
        const navigationRoot = resolveNavigationSidecarRoot(stateRoot, repoPath);
        await fs.promises.rm(path.join(navigationRoot, 'relationships'), { recursive: true, force: true });
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: { file: 'src/runtime.ts', symbolId: run.symbolInstanceId },
            direction: 'both',
            depth: 1,
            limit: 20,
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot, symbols: [run] });
        assert.deepEqual(payload, {
            status: 'requires_reindex',
            supported: false,
            reason: 'missing_relationship_sidecar',
            path: '<repo>',
            codebasePath: '<repo>',
            symbolRef: { file: 'src/runtime.ts', symbolId: '<symbol:function:run>' },
            direction: 'both',
            depth: 1,
            limit: 20,
            nodes: [],
            edges: [],
            notes: [],
            freshnessDecision: { mode: 'skipped_requires_reindex' },
            message: "Relationship sidecar is missing: relationship manifest is missing\n\nThe index at '<repo>' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {\"action\":\"reindex\",\"path\":\"<repo>\"}.",
            hints: {
                reindex: {
                    tool: 'manage_index',
                    args: { action: 'reindex', path: '<repo>' },
                },
            },
            compatibility: {
                runtimeFingerprint: RUNTIME_FINGERPRINT,
                statusAtCheck: 'indexed',
            },
        });
    }));
});

test('golden MCP call_graph incompatible relationship sidecar shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const run = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'run',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
            label: 'function run()',
        });
        await writeNavigationSidecars({
            stateRoot,
            repoPath,
            symbols: [run],
            relationshipManifestHash: 'wrong-symbol-registry-manifest-hash',
        });
        const { handlers } = createHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: { file: 'src/runtime.ts', symbolId: run.symbolInstanceId },
            direction: 'both',
            depth: 1,
            limit: 20,
        });

        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot, symbols: [run] });
        assert.deepEqual(payload, {
            status: 'requires_reindex',
            supported: false,
            reason: 'incompatible_relationship_sidecar',
            path: '<repo>',
            codebasePath: '<repo>',
            symbolRef: { file: 'src/runtime.ts', symbolId: '<symbol:function:run>' },
            direction: 'both',
            depth: 1,
            limit: 20,
            nodes: [],
            edges: [],
            notes: [],
            freshnessDecision: { mode: 'skipped_requires_reindex' },
            message: "Relationship sidecar is incompatible: relationship manifest hash does not match symbol registry manifest hash\n\nThe index at '<repo>' is incompatible with the current runtime and must be rebuilt. Please run manage_index with {\"action\":\"reindex\",\"path\":\"<repo>\"}.",
            hints: {
                reindex: {
                    tool: 'manage_index',
                    args: { action: 'reindex', path: '<repo>' },
                },
            },
            compatibility: {
                runtimeFingerprint: RUNTIME_FINGERPRINT,
                statusAtCheck: 'indexed',
            },
        });
    }));
});

test('golden MCP read_file open_symbol success shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src/runtime.ts');
        fs.writeFileSync(filePath, 'export function run() {\n  return true;\n}\n', 'utf8');
        const run = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'run',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
            label: 'function run()',
        });
        await writeNavigationSidecars({ stateRoot, repoPath, symbols: [run] });
        const { handlers, snapshotManager, syncManager } = createHandlers(repoPath);

        const response = await readFileTool.execute({
            path: filePath,
            open_symbol: { symbolId: run.symbolInstanceId },
        }, createReadFileToolContext({
            handlers,
            snapshotManager,
            syncManager,
        }));

        const payload = scrubGolden(response, { repoPath, stateRoot, symbols: [run] });
        assert.deepEqual(payload, {
            content: [{
                type: 'text',
                text: 'export function run() {\n  return true;\n}',
            }],
        });
    }));
});

test('golden MCP read_file open_symbol stale id shape', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src/runtime.ts');
        fs.writeFileSync(filePath, 'export function run() {\n  return true;\n}\n', 'utf8');
        const run = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'run',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
            label: 'function run()',
        });
        await writeNavigationSidecars({ stateRoot, repoPath, symbols: [run] });
        const { handlers, snapshotManager, syncManager } = createHandlers(repoPath);

        const response = await readFileTool.execute({
            path: filePath,
            open_symbol: { symbolId: 'sym_stale_runtime_run' },
        }, createReadFileToolContext({
            handlers,
            snapshotManager,
            syncManager,
        }));

        assert.equal(response.isError, true);
        const payload = scrubGolden(parsePayload(response), { repoPath, stateRoot, symbols: [run] });
        assert.deepEqual(payload, {
            status: 'not_found',
            reason: 'missing_symbol',
            message: 'No exact symbol match found in file outline.',
            file: 'src/runtime.ts',
        });
    }));
});
