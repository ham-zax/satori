import test from 'node:test';
import assert from 'node:assert/strict';
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
} from '@zokizuan/satori-core';
import type { SymbolRecord, SymbolRegistryManifest } from '@zokizuan/satori-core';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

const DENSE_RUNTIME_FINGERPRINT: IndexFingerprint = {
    ...RUNTIME_FINGERPRINT,
    schemaVersion: 'dense_v3'
};

const CAPABILITIES_NO_RERANK = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
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

    await writeSymbolRegistrySidecar({
        registry: buildSymbolRegistry({ manifest, symbols }),
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
}) {
    const allSymbols: SymbolRecord[] = [];
    const manifestFiles: SymbolRegistryManifest['files'] = [];
    for (const file of input.files) {
        const fileHash = `test-search-file-hash-${file.relativePath}`;
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

    await writeSymbolRegistrySidecar({
        registry: buildSymbolRegistry({ manifest, symbols: allSymbols }),
    });

    return allSymbols;
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
    searchResults: any[],
    reranker?: any,
    options?: {
        gitignoreForceReloadEveryN?: number;
        sidecarReady?: boolean;
        sidecarNodes?: any[];
        sidecarBuiltAt?: string;
    }
) {
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        semanticSearch: async () => searchResults
    } as any;

    const snapshotManager = {
        getAllCodebases: () => [],
        getIndexedCodebases: () => [repoPath],
        getIndexingCodebases: () => [],
        getCodebaseCallGraphSidecar: () => options?.sidecarReady === false ? undefined : ({ version: 'v3' }),
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
    } as any;

    const syncManager = {
        ensureFreshness: async () => ({
            mode: 'skipped_recent',
            checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            thresholdMs: 180000
        })
    } as any;

    const capabilities = new CapabilityResolver({
        name: 'test',
        version: '0.0.0',
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
    } as any;

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
    return handlers;
}

function parseSemanticSearchInvocation(args: any[]): { root: string; query: string; topK: number; request: any | null } {
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        return {
            root: args[0].codebasePath,
            query: args[0].query,
            topK: args[0].topK ?? 5,
            request: args[0]
        };
    }

    return {
        root: args[0],
        query: args[1],
        topK: args[2] ?? 5,
        request: null
    };
}

test('handleSearchCode grouped output includes symbol metadata and callGraphHint', async () => {
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
        assert.equal(payload.results[0].symbolId, undefined);
        assert.equal(payload.results[0].callGraphHint.supported, false);
        assert.equal(payload.results[0].callGraphHint.reason, 'missing_symbol');
    });
});

test('handleSearchCode grouped symbol mode emits relationship-backed callGraphHint without a legacy sidecar', async () => {
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
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const result = payload.results[0];
        assert.equal(result.callGraphHint.supported, true);
        assert.equal(result.callGraphHint.symbolRef.symbolId, validateSymbol!.symbolInstanceId);
        assert.equal(result.callGraphHint.sidecarBuiltAt, '2026-01-01T00:00:00.000Z');
        assert.deepEqual(result.nextActions.callGraph.args.symbolRef, result.callGraphHint.symbolRef);
    }));
});

test('handleSearchCode does not emit supported callGraphHint from stale ownerSymbolInstanceId metadata when the current registry has no matching symbol', async () => {
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
        assert.equal(result.callGraphHint.supported, false);
        assert.equal(result.callGraphHint.reason, 'stale_symbol_ref');
        assert.equal(result.nextActions, undefined);
        assert.deepEqual(result.navigationFallback.readSpan, {
            tool: 'read_file',
            args: {
                path: path.resolve(repoPath, 'src/stale.ts'),
                start_line: 1,
                end_line: 3
            }
        });
    }));
});

test('handleSearchCode grouped symbol mode does not emit nextActions.callGraph for Go symbol-only results', async () => {
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
        assert.equal(result.callGraphHint.supported, false);
        assert.equal(result.callGraphHint.reason, 'unsupported_language');
        assert.equal(result.nextActions, undefined);
        assert.equal(result.navigationFallback.readSpan.tool, 'read_file');
    }));
});

test('handleSearchCode grouped symbol mode does not emit nextActions.callGraph for Rust symbol-only results', async () => {
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
        assert.equal(result.callGraphHint.supported, false);
        assert.equal(result.callGraphHint.reason, 'unsupported_language');
        assert.equal(result.nextActions, undefined);
        assert.equal(result.navigationFallback.readSpan.tool, 'read_file');
    }));
});

test('handleSearchCode relationship-backed callGraphHint works end to end with call_graph without a legacy sidecar', async () => {
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
        assert.equal(result.callGraphHint.supported, true);
        assert.deepEqual(result.nextActions.callGraph.args.symbolRef, result.callGraphHint.symbolRef);

        const callGraphResponse = await handlers.handleCallGraph({
            path: repoPath,
            ...result.nextActions.callGraph.args,
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
            debug: true,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].collapsedChunkCount, 2);
        assert.equal(payload.results[0].symbolKey, 'owner_auth_login_key');
        assert.equal(payload.results[0].symbolInstanceId, 'owner_auth_login_instance');
        assert.equal(payload.results[0].symbolId, 'owner_auth_login_instance');
        assert.equal(payload.results[0].callGraphHint.supported, false);
        assert.equal(payload.results[0].callGraphHint.reason, 'missing_symbol_registry');
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
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].collapsedChunkCount, 2);
            assert.equal(payload.results[0].symbolKey, owner.symbolKey);
            assert.equal(payload.results[0].symbolInstanceId, owner.symbolInstanceId);
            assert.equal(payload.results[0].symbolKind, 'method');
            assert.equal(payload.results[0].symbolId, owner.symbolInstanceId);
            assert.equal(payload.results[0].callGraphHint.supported, true);
            assert.equal(payload.results[0].callGraphHint.symbolRef.symbolId, owner.symbolInstanceId);
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
            debug: true,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].file, 'packages/mcp/src/core/handlers.ts');
        assert.equal(payload.results[0].symbolLabel, 'async method handleSearchCode(args: any)');
        assert.notEqual(payload.results[0].file, 'packages/mcp/src/core/handlers.index_state_stability.test.ts');
        assert.notEqual(payload.results[0].symbolLabel, 'method buildReindexHint(codebasePath: string)');
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
            debug: true,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].symbolLabel, 'async method handleSearchCode(args: any)');
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
        assert.equal(payload.results[1].symbolLabel, 'method buildReindexHint(codebasePath: string)');
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

        (handlers as any).context.getTrackedRelativePaths = () => [relativePath];

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is SEARCH_PARTIAL_INDEX emitted',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debug: true,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].file, relativePath);
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

        (handlers as any).context.getTrackedRelativePaths = () => [relativePath];

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: '"partial index search warning"',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debug: true,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results[0].file, relativePath);
        assert.match(payload.results[0].preview, /partial index search warning/i);
        assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
        assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('lexical_files'), true);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.reasons?.includes('quoted_literal_query'), true);
    });
});

test('handleSearchCode exact registry fast path returns a grouped symbol without semantic search, tracked lexical, or rerank', async () => {
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
            (handlers as any).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                throw new Error('semanticSearch should not run for exact registry hits');
            };
            (handlers as any).context.getTrackedRelativePaths = () => {
                throw new Error('tracked lexical scan should not run for exact registry hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'prepareTrackedRootForRead',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debug: true,
            });

            const rawText = response.content[0]?.text || '{}';
            const payload = JSON.parse(rawText);
            assert.equal(payload.status, 'ok');
            assert.doesNotMatch(rawText, /\n\s+"/);
            assert.equal(semanticSearchCalls, 0);
            assert.equal(rerankCalls, 0);
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].symbolInstanceId, owner.symbolInstanceId);
            assert.equal(typeof payload.results[0].callGraphHint?.supported, 'boolean');
            assert.equal(payload.results[0].nextActions?.openSymbol?.tool, 'read_file');
            assert.equal(payload.results[0].recommendedNextAction?.tool, 'read_file');
            assert.equal(payload.results[0].recommendedNextAction?.args?.open_symbol?.symbolId, owner.symbolInstanceId);
            assert.equal(payload.recommendedNextAction?.tool, 'read_file');
            assert.equal(payload.recommendedNextAction?.args?.open_symbol?.symbolId, owner.symbolInstanceId);
            assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('exact_registry'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('exact_registry'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), false);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.status, 'hit');
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.matchedSymbolInstanceId, owner.symbolInstanceId);
            const phaseTimings = payload.hints?.debugSearch?.phaseTimingsMs || {};
            for (const phase of ['prepareRead', 'ensureFreshness', 'exactRegistry', 'semanticSearch', 'trackedLexical', 'rerank', 'registryLoad', 'grouping', 'navigationValidation']) {
                assert.equal(typeof phaseTimings[phase], 'number');
            }
            assert.equal(phaseTimings.semanticSearch, 0);
            assert.equal(phaseTimings.trackedLexical, 0);
            assert.equal(phaseTimings.rerank, 0);
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
            (handlers as any).context.semanticSearch = async () => {
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
                debug: true,
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
            (handlers as any).context.semanticSearch = async () => {
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
                debug: true,
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
            (handlers as any).context.semanticSearch = async () => {
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
                debug: true,
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
            (handlers as any).context.semanticSearch = async () => {
                throw new Error('semanticSearch should not run for path-scoped exact registry hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: `path:${targetPath} prepareTrackedRootForRead`,
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].file, targetPath);
            assert.equal(payload.results[0].symbolInstanceId, owner.symbolInstanceId);
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
            (handlers as any).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                return [];
            };
            (handlers as any).context.getTrackedRelativePaths = () => [lexicalPath];

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'missingExactIdentifier',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 1);
            assert.equal(payload.hints?.debugSearch?.exactRegistry?.status, 'miss');
            assert.equal(payload.hints?.debugSearch?.trackedLexical?.enabled, true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('lexical_files'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('expanded'), false);
            assert.equal(payload.results[0].file, lexicalPath);
            assert.equal(payload.results[0].debug?.provenance?.retrievalPasses?.includes('lexical_files'), true);
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
            (handlers as any).context.semanticSearch = async () => {
                throw new Error('semanticSearch should not run for exact symbolInstanceId hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: owner.symbolInstanceId,
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].symbolInstanceId, owner.symbolInstanceId);
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
            (handlers as any).context.semanticSearch = async () => {
                semanticSearchCalls += 1;
                throw new Error('semanticSearch should not run for must-only exact identifier hits');
            };
            (handlers as any).context.getTrackedRelativePaths = () => {
                throw new Error('tracked lexical scan should not run for must-only exact identifier hits');
            };

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'must:cli_entry_point',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 1,
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(semanticSearchCalls, 0);
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].file, relativePath);
            assert.equal(payload.results[0].symbolInstanceId, owner.symbolInstanceId);
            assert.equal(payload.hints?.debugSearch?.queryIntent?.semanticQuery, 'cli_entry_point');
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('exact_registry'), true);
            assert.equal(payload.hints?.debugSearch?.passesUsed?.includes('primary'), false);
        });
    });
});

test('handleSearchCode ambiguous exact registry lookup falls back to existing semantic search path', async () => {
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
            (handlers as any).context.semanticSearch = async () => {
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
                query: 'runTask',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debug: true,
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
        ] as any[];

        const applied = (handlers as any).sortGroupedSearchResults(grouped, true);
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
        (handlers as any).context.getTrackedRelativePaths = () => trackedPaths;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is TRACKED_NEEDLE emitted',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 20,
            debug: true,
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
            (handlers as any).context.getTrackedRelativePaths = () => [relativePath];
            (handlers as any).context.getActiveIgnorePatterns = () => testCase.ignorePatterns || [];

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: testCase.query,
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5,
                debug: true,
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
        (handlers as any).context.getTrackedRelativePaths = () => ['../escape.ts'];

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'path:src/path-scoped.test.ts endColumn',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debug: true,
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

test('handleSearchCode repairs symbol-only file-owner results to tighter outline symbols with strong evidence', async () => {
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
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].symbolInstanceId, push.symbolInstanceId);
            assert.equal(payload.results[0].symbolKind, 'method');
            assert.equal(payload.results[0].callGraphHint.supported, false);
            assert.equal(payload.results[0].callGraphHint.reason, 'unsupported_language');
            assert.equal(payload.results[0].navigationFallback.fileOutlineWindow.args.file, relativePath);
            assert.equal(payload.results[0].debug?.symbolAggregation?.ownerSource, 'registry_repair');
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
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].symbolInstanceId, stack.symbolInstanceId);
            assert.equal(payload.results[0].symbolKind, 'type');
            assert.notEqual(payload.results[0].symbolLabel, 'method new');
            assert.notEqual(payload.results[0].symbolLabel, 'method push');
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
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].symbolInstanceId, fileOwner.symbolInstanceId);
            assert.equal(payload.results[0].symbolKind, 'file');
            assert.equal(payload.results[0].debug?.symbolAggregation?.ownerSource, 'owner_metadata');
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
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results[0].symbolInstanceId, fileOwner.symbolInstanceId);
            assert.equal(payload.results[0].symbolKind, 'file');
            assert.equal(payload.results[0].callGraphHint.supported, false);
            assert.equal(payload.results[0].callGraphHint.reason, 'missing_symbol');
            assert.equal(payload.results[0].nextActions, undefined);
            assert.notEqual(payload.results[0].callGraphHint?.symbolRef?.symbolId, emitLogin.symbolInstanceId);
            assert.equal(payload.results[0].debug?.symbolAggregation?.ownerSource, 'owner_metadata');
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
            assert.equal(payload.results[0].symbolId, owner.symbolInstanceId);
            assert.equal(payload.results[0].symbolInstanceId, owner.symbolInstanceId);
            assert.equal(payload.results[0].callGraphHint.supported, false);
            assert.equal(payload.results[0].callGraphHint.reason, 'incompatible_relationship_sidecar');
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
                debug: true,
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].collapsedChunkCount, 2);
            assert.equal(payload.results[0].symbolKey, 'owner_auth_login_key');
            assert.equal(payload.results[0].debug.symbolAggregation.ownerSource, 'owner_metadata');
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
        const results = payload.results as Array<{ symbolKey?: string }>;
        assert.deepEqual(
            results.map((result) => result.symbolKey).sort(),
            ['owner_helper_source_key', 'owner_helper_test_key']
        );
    });
});

test('handleSearchCode grouped output includes compact nextActions for supported symbols', async () => {
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

        assert.equal(result.callGraphHint.supported, false);
        assert.equal(result.callGraphHint.reason, 'missing_symbol');
        assert.equal(result.nextActions, undefined);
        assert.deepEqual(result.navigationFallback.readSpan, {
            tool: 'read_file',
            args: {
                path: path.resolve(repoPath, 'src/auth.ts'),
                start_line: 3,
                end_line: 6
            }
        });
        assert.equal(payload.hints?.navigation?.nextStep, 'Open the selected result, then call call_graph with nextActions.callGraph args and a listed direction when callGraphHint.supported=true; otherwise use navigationFallback.readSpan.');
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
        assert.match(payload.results[0].preview, /^method validateSession\(token: string\)\n/);
        assert.equal(payload.results[0].preview.length, 803);
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
        assert.equal(payload.results[0].symbolLabel, 'function qap_spread_type');
        assert.match(payload.results[0].preview, /^function qap_spread_type\n/);
        assert.match(payload.results[0].preview, /return qap_spread_type\(frame\)/);
        assert.doesNotMatch(payload.results[0].preview, /@cached/);
        assert.doesNotMatch(payload.results[0].preview, /unrelatedOwner/);
        assert.equal((payload.results[0].preview.match(/function qap_spread_type/g) || []).length, 1);
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
        assert.equal(payload.results[0].symbolLabel, 'function check_survival');
        assert.match(payload.results[0].preview, /^function check_survival\n/);
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
        assert.equal(payload.results[0].span.startLine, 4);
        assert.equal(payload.results[0].span.endLine, 15);
        assert.equal(payload.results[0].callGraphHint.symbolRef.span.startLine, 4);
        assert.equal(payload.results[0].callGraphHint.symbolRef.span.endLine, 15);
        assert.equal(payload.results[0].nextActions.openSymbol.args.open_symbol.symbolId, owner.symbolInstanceId);
        assert.equal(payload.results[0].nextActions.openSymbol.args.open_symbol.end_line, undefined);
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
        assert.equal(payload.results[0].span.startLine, 1);
        assert.equal(payload.results[0].span.endLine, 6);
        assert.equal(payload.results[0].capabilities.openSymbol, 'low');
        assert.ok(warningCodes(payload).includes('SEARCH_SYMBOL_SPAN_UNVERIFIED'));
    }));
});

test('handleSearchCode reports caller graph confidence conservatively for supported graph handles', async () => {
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
        assert.equal(payload.results[0].callGraphHint.supported, true);
        assert.equal(payload.results[0].capabilities.callGraphCallers, 'low');
        assert.equal(payload.results[0].capabilities.callGraphCallees, 'medium');
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

        assert.equal(result.callGraphHint.supported, false);
        assert.equal(result.callGraphHint.reason, 'missing_symbol');
        assert.equal(result.nextActions, undefined);
        assert.deepEqual(result.navigationFallback.readSpan, {
            tool: 'read_file',
            args: {
                path: path.resolve(repoPath, 'src/auth.ts'),
                start_line: 3,
                end_line: 6
            }
        });
        assert.equal(result.navigationFallback.fileOutlineWindow, undefined);
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
        const files = payload.results.map((r: any) => r.file).sort();
        assert.deepEqual(files, ['src/reports/runtime-report-service.ts', 'src/runtime.test.ts', 'src/runtime.ts']);
    });
});

test('handleSearchCode docs scope only returns docs and tests', async () => {
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
        const files = payload.results.map((r: any) => r.file).sort();
        assert.deepEqual(files, ['docs/runtime-helper.ts', 'docs/runtime.md', 'src/runtime.test.ts']);
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
            debug: true
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
            semanticSearch: async (...args: any[]) => denseResults.slice(0, parseSemanticSearchInvocation(args).topK)
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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
            semanticSearch: async (...args: any[]) => denseResults.slice(0, parseSemanticSearchInvocation(args).topK)
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'must:NEEDLE_TOKEN runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/retry-40.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/auth.ts');
        assert.equal(payload.results[0].span?.startLine, 20);
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const files = payload.results.map((result: any) => result.file);
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 2);
        assert.deepEqual(
            payload.results.map((result: any) => result.symbolInstanceId),
            ['owner_login_instance_a', 'owner_login_instance_b']
        );
    });
});

test('handleSearchCode applies changed-files boost in auto mode and skips boost in default mode', async () => {
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

        (handlers as any).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const autoResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2
        });
        const autoPayload = JSON.parse(autoResponse.content[0]?.text || '{}');
        assert.equal(autoPayload.results[0].file, 'src/changed.ts');
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
            limit: 2
        });
        const defaultPayload = JSON.parse(defaultResponse.content[0]?.text || '{}');
        assert.equal(defaultPayload.results[0].file, 'src/unchanged.ts');
        assert.equal(defaultPayload.freshnessSummary.changedFileCount, 1);
        assert.equal(defaultPayload.freshnessSummary.gitDirtyFilesConsidered, true);
        assert.equal(defaultPayload.freshnessSummary.changedFilesBoostApplied, false);
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

        (handlers as any).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['src/dirty-but-not-returned.ts'])
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'unchanged symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            debug: true,
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

        (handlers as any).syncManager = {
            ensureFreshness: async () => ({ mode: 'skipped_recent', changed: false })
        };
        (handlers as any).getChangedFilesForCodebase = () => ({
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

        (handlers as any).syncManager = {
            ensureFreshness: async () => ({ mode: 'skipped_recent', changed: false })
        };
        (handlers as any).getChangedFilesForCodebase = () => ({
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
        assert.equal(payload.results[0].file, relativePath);
        assert.match(payload.results[0].preview, /endColumn/);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_WORKTREE_NOT_SYNCED'), true);
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

        (handlers as any).syncManager = {
            ensureFreshness: async () => ({
                mode: 'synced',
                changed: true,
                stats: { added: 0, removed: 0, modified: 1 },
            })
        };
        (handlers as any).getChangedFilesForCodebase = () => ({
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, relativePath);
        assert.match(payload.results[0].preview, /endColumn/);
        assert.equal(warningCodes(payload).includes('SEARCH_DIRTY_WORKTREE_NOT_SYNCED'), false);
        assert.equal(payload.hints.debugSearch.passesUsed.includes('live_path'), true);
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

        (handlers as any).context.getTrackedRelativePaths = () => [relativePath, 'src/unrelated.ts'];
        (handlers as any).syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        };
        (handlers as any).getChangedFilesForCodebase = () => ({
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, relativePath);
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
            encoderProvider: 'VoyageAI',
            encoderModel: 'voyage-4-large',
            encoderOutputDimension: 1024,
            milvusEndpoint: 'http://127.0.0.1:19530',
        }) as any;
        await context.recreateSynchronizerForCodebase(repoPath);
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
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES_NO_RERANK,
            () => Date.parse('2026-01-01T01:00:00.000Z')
        );

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: `path:${relativePath} endColumn`,
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, relativePath);
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
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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
        } as any;

        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            DENSE_RUNTIME_FINGERPRINT,
            CAPABILITIES_NO_RERANK,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as any).getChangedFilesForCodebase = () => ({
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
            debug: true
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
        } as any;
        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' }),
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;
        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;
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
        } as any;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            DENSE_RUNTIME_FINGERPRINT,
            CAPABILITIES_NO_RERANK,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as any).getChangedFilesForCodebase = () => ({
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
            debug: true
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

        (handlers as any).getChangedFilesForCodebase = () => ({
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
            debug: true
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/unchanged.ts');
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
        const parsed = (handlers as any).parseGitStatusChangedPaths([
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
        (handlers as any).changedFilesCache.set(cacheKey, {
            expiresAtMs: 0,
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const state = (handlers as any).getChangedFilesForCodebase(repoPath);
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
            debug: true
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
            debug: true
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
            debug: true
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
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
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

        const capabilities = new CapabilityResolver({
            name: 'test',
            version: '0.0.0',
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
            debug: true
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
            debug: true
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
            debug: true
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'packages/mcp/src/core/handlers.ts');
        assert.equal(payload.results[0].debug?.pathCategory, 'core');
        assert.equal(payload.results[1].debug?.pathCategory, 'adapter');
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
            debug: true
        });
        const ownerPayload = JSON.parse(ownerResponse.content[0]?.text || '{}');
        assert.equal(ownerPayload.results[0].file, 'packages/cli/src/install.ts');
        assert.equal(ownerPayload.results[0].debug?.agentFitReason, 'writer_owner');
        assert.equal(ownerPayload.results[1].debug?.agentFitReason, 'implementation_query_test_demotion');

        const testResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'codex guidance hook test coverage',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });
        const testPayload = JSON.parse(testResponse.content[0]?.text || '{}');
        assert.equal(testPayload.results[0].file, 'packages/cli/src/install.test.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'packages/mcp/src/core/sync.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'scripts/check-version-freshness.mjs');
        assert.equal(payload.results[0].debug?.pathCategory, 'scriptRuntime');
        assert.equal(payload.results[0].debug?.agentFitReason, 'script_implementation');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'packages/cli/src/install.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'packages/cli/src/install.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'packages/cli/src/install.ts');
        assert.equal(payload.results[0].debug?.agentFitReason, 'writer_owner');
        assert.equal(payload.results[1].file, 'packages/mcp/src/tools/list_codebases.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'packages/mcp/src/core/handlers.ts');
        assert.equal(payload.results[0].debug?.agentFitReason, 'implementation_chunk');
        assert.equal(payload.results[1].debug?.agentFitReason, 'type_not_owner');
    });
});

test('handleSearchCode does not boost dirty tests for non-test implementation queries', async () => {
    await withTempRepo(async (repoPath) => {
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
        (handlers as any).getChangedFilesForCodebase = () => ({
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'packages/cli/src/install.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/hurst_gate.ts' && result.symbolLabel === 'class HurstGateState');
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
            debug: true
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/hurst_gate.ts' && result.symbolLabel === 'class HurstGateState');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].file !== 'src/check_gate_state.ts', true);
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].file, 'src/hurst_gate.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declaration = payload.results.find((result: any) => result.file === 'src/check_hurst_gate.ts');
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
            debug: true
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/check_hurst_gate.ts' && result.symbolLabel === 'const check_hurst_gate =');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declaration = payload.results.find((result: any) => result.file === 'src/check_hurst_gate.ts');
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
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/check_hurst_gate.ts' && result.symbolLabel === 'function check_hurst_gate');
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
            debug: true
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
            debug: true
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

test('handleSearchCode grouped fallback emits stable hash groupId and unsupported callGraphHint when symbol is missing', async () => {
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
        assert.match(firstPayload.results[0].groupId, /^grp_[a-f0-9]{16}$/);
        assert.equal(firstPayload.results[0].groupId, secondPayload.results[0].groupId);
        assert.equal(firstPayload.results[0].callGraphHint.supported, false);
        assert.equal(firstPayload.results[0].callGraphHint.reason, 'missing_symbol');
        assert.equal(firstPayload.results[0].navigationFallback.message, 'Call graph not available for this result; use readSpan or fileOutlineWindow to navigate.');
        assert.equal(firstPayload.results[0].navigationFallback.context.codebaseRoot, repoPath);
        assert.equal(firstPayload.results[0].navigationFallback.context.relativeFile, 'src/runtime.ts');
        assert.equal(firstPayload.results[0].navigationFallback.context.absolutePath, undefined);
        assert.deepEqual(firstPayload.results[0].navigationFallback.readSpan, {
            tool: 'read_file',
            args: {
                path: path.resolve(repoPath, 'src/runtime.ts'),
                start_line: 42,
                end_line: 45
            }
        });
        assert.equal(firstPayload.results[0].recommendedNextAction.tool, 'read_file');
        assert.deepEqual(
            firstPayload.results[0].recommendedNextAction.args,
            firstPayload.results[0].navigationFallback.readSpan.args
        );
        assert.equal(firstPayload.results[0].fallbacks[0].tool, 'read_file');
        assert.deepEqual(
            firstPayload.results[0].fallbacks[0].args,
            firstPayload.results[0].navigationFallback.readSpan.args
        );
        assert.equal(firstPayload.results[0].navigationFallback.fileOutlineWindow, undefined);
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
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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
        assert.equal(payload.results[0].callGraphHint.supported, false);
        assert.equal(payload.results[0].callGraphHint.reason, 'missing_symbol');
        assert.equal(payload.results[0].navigationFallback.fileOutlineWindow, undefined);
    });
});

test('handleSearchCode subdirectory query builds navigationFallback from effectiveRoot and preserves relative file', async () => {
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
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: sidecarForPath
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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
        assert.equal(payload.results[0].file, 'src/runtime.ts');
        assert.equal(payload.results[0].navigationFallback.context.codebaseRoot, repoPath);
        assert.equal(payload.results[0].navigationFallback.context.relativeFile, 'src/runtime.ts');
        assert.equal(payload.results[0].navigationFallback.context.absolutePath, undefined);
        assert.equal(payload.results[0].navigationFallback.readSpan.args.path, path.resolve(repoPath, 'src/runtime.ts'));
        assert.equal(payload.results[0].navigationFallback.fileOutlineWindow, undefined);
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
        assert.equal(payload.results[0].symbolId, 'owner_with_label_instance');
        assert.equal(payload.results[1].symbolId, 'owner_without_label_instance');
        assert.equal(typeof payload.results[1].symbolLabel, 'string');
        assert.notEqual(payload.results[1].symbolLabel, null);
    });
});

test('handleSearchCode builds explicit hybrid semantic search requests with topk_only policy', async () => {
    await withTempRepo(async (repoPath) => {
        const calls: Array<{ root: string; query: string; topK: number; request: any | null }> = [];
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (...args: any[]) => {
                calls.push(parseSemanticSearchInvocation(args));
                return [];
            }
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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
            semanticSearch: async (...args: any[]) => {
                calls.push(parseSemanticSearchInvocation(args));
                return [];
            }
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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

test('handleSearchCode runs semantic passes concurrently and emits warnings on partial failure', async () => {
    await withTempRepo(async (repoPath) => {
        const started: string[] = [];
        let releaseSearchPasses: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseSearchPasses = resolve;
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (...args: any[]) => {
                const { query } = parseSemanticSearchInvocation(args);
                const passId = query.includes('implementation runtime source entrypoint') ? 'expanded' : 'primary';
                started.push(passId);
                await gate;
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
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));

        const responsePromise = handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(new Set(started), new Set(['primary', 'expanded']));

        releaseSearchPasses?.();
        const response = await responsePromise;
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.ok(Array.isArray(payload.warnings));
        assert.equal(payload.warnings[0].code, 'SEARCH_PASS_FAILED:expanded');
        assert.equal(payload.warnings[0].severity, 'degraded');
        assert.match(payload.warnings[0].message, /expanded semantic search pass failed/);
    });
});

test('handleSearchCode returns error when all semantic passes fail', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('backend unavailable');
            }
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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
        assert.match(response.content[0]?.text || '', /all semantic search passes failed/i);
    });
});

test('handleSearchCode returns structured backend diagnostics when all semantic passes fail with stopped cluster', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('16 UNAUTHENTICATED: The action is unavailable under current cluster status STOPPED.');
            }
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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

test('handleSearchCode supports deterministic test-only fault injection for expanded pass', { concurrency: false }, async () => {
    await withTempRepo(async (repoPath) => {
        await withEnv({
            NODE_ENV: 'test',
            SATORI_TEST_FAIL_SEARCH_PASS: 'expanded'
        }, async () => {
            const context = {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                semanticSearch: async (...args: any[]) => {
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
            } as any;

            const snapshotManager = {
                getAllCodebases: () => [],
                getIndexedCodebases: () => [repoPath],
                getIndexingCodebases: () => [],
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
            } as any;

            const syncManager = {
                ensureFreshness: async () => ({
                    mode: 'skipped_recent',
                    checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    thresholdMs: 180000
                })
            } as any;

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
            assert.equal(payload.results[0].symbolId, undefined);
            assert.equal(payload.results[0].file, 'src/primary.ts');
            assert.deepEqual(warningCodes(payload), ['SEARCH_PASS_FAILED:expanded']);
            assert.equal(payload.warnings[0].severity, 'degraded');
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
                semanticSearch: async (...args: any[]) => {
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
            } as any;

            const snapshotManager = {
                getAllCodebases: () => [],
                getIndexedCodebases: () => [repoPath],
                getIndexingCodebases: () => [],
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
            } as any;

            const syncManager = {
                ensureFreshness: async () => ({
                    mode: 'skipped_recent',
                    checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    thresholdMs: 180000
                })
            } as any;

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
            assert.equal(payload.warnings, undefined);
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
            } as any;

            const snapshotManager = {
                getAllCodebases: () => [],
                getIndexedCodebases: () => [repoPath],
                getIndexingCodebases: () => [],
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
            } as any;

            const syncManager = {
                ensureFreshness: async () => ({
                    mode: 'skipped_recent',
                    checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    thresholdMs: 180000
                })
            } as any;

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
            assert.match(response.content[0]?.text || '', /all semantic search passes failed/i);
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
        } as any;

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
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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
    decision: any,
    expected: {
        status: string;
        reason?: string;
        semanticSearchCalls: number;
        messageIncludes?: string;
    }
): Promise<any> {
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
        } as any;

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
        } as any;

        const syncManager = {
            ensureFreshness: async () => {
                ensureFreshnessCalls += 1;
                return decision;
            }
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).validateCompletionProof = async () => {
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
        assert.equal(completionProofCalls, 1);
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
        semanticSearchCalls: 2
    });

    assert.equal(payload.results.length, 1);
});

test('handleSearchCode not_indexed payload includes stable reason code', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => []
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getCodebaseInfo: () => undefined,
            getCodebaseStatus: () => 'not_found',
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

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

test('handleSearchCode indexing payload recommends manage_index status', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('semanticSearch should not run while indexing');
            }
        } as any;

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
        } as any;

        const syncManager = {
            ensureFreshness: async () => {
                throw new Error('ensureFreshness should not run while indexing');
            }
        } as any;

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
