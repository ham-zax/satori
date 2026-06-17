import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    importNavigationToSqlite,
    RuntimeNavigationStore,
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    resetSharedRuntimeNavigationStoreForTests,
    resolveNavigationSidecarRoot,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from '@zokizuan/satori-core';
import type { SymbolRecord, SymbolRegistryManifest } from '@zokizuan/satori-core';
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

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-file-outline-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), 'export function run() { return true; }\n');
    fs.writeFileSync(path.join(repoPath, 'src', 'runtime.js'), 'export function run() { return true; }\n');
    fs.writeFileSync(path.join(repoPath, 'docs.md'), '# docs\n');
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
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

async function withNavigationEnv<T>(
    env: Partial<Record<'SATORI_NAVIGATION_BACKEND' | 'SATORI_NAVIGATION_DUAL_READ', string | undefined>>,
    fn: () => Promise<T>,
): Promise<T> {
    const previousBackend = process.env.SATORI_NAVIGATION_BACKEND;
    const previousDualRead = process.env.SATORI_NAVIGATION_DUAL_READ;
    resetSharedRuntimeNavigationStoreForTests();
    if (env.SATORI_NAVIGATION_BACKEND === undefined) {
        delete process.env.SATORI_NAVIGATION_BACKEND;
    } else {
        process.env.SATORI_NAVIGATION_BACKEND = env.SATORI_NAVIGATION_BACKEND;
    }
    if (env.SATORI_NAVIGATION_DUAL_READ === undefined) {
        delete process.env.SATORI_NAVIGATION_DUAL_READ;
    } else {
        process.env.SATORI_NAVIGATION_DUAL_READ = env.SATORI_NAVIGATION_DUAL_READ;
    }
    try {
        return await fn();
    } finally {
        resetSharedRuntimeNavigationStoreForTests();
        if (previousBackend === undefined) {
            delete process.env.SATORI_NAVIGATION_BACKEND;
        } else {
            process.env.SATORI_NAVIGATION_BACKEND = previousBackend;
        }
        if (previousDualRead === undefined) {
            delete process.env.SATORI_NAVIGATION_DUAL_READ;
        } else {
            process.env.SATORI_NAVIGATION_DUAL_READ = previousDualRead;
        }
    }
}

function baseContext() {
    return {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getVectorStore: () => ({ listCollections: async () => [] })
    } as any;
}

function createTestSymbol(input: {
    file: string;
    label: string;
    name: string;
    qualifiedName: string;
    startLine: number;
    endLine: number;
    fileHash?: string;
    language?: string;
    kind?: SymbolRecord['kind'];
}): SymbolRecord {
    const fileHash = input.fileHash || 'hash_runtime';
    const language = input.language || 'typescript';
    const kind = input.kind || 'function';
    const parentQualifiedNamePath: string[] = [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language,
        kind,
        qualifiedName: input.qualifiedName,
        parentQualifiedNamePath,
    });
    const span = {
        startLine: input.startLine,
        endLine: input.endLine,
    };
    return {
        symbolKey,
        symbolInstanceId: createSymbolInstanceId({
            symbolKey,
            fileHash,
            span,
            extractorVersion: 'test-extractor-v1',
        }),
        language,
        kind,
        name: input.name,
        qualifiedName: input.qualifiedName,
        label: input.label,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash,
        extractorVersion: 'test-extractor-v1',
    };
}

async function writeTestSymbolRegistry(repoPath: string, symbols: SymbolRecord[]) {
    const filesByPath = new Map<string, { hash: string; language: string; symbolCount: number }>();
    for (const symbol of symbols) {
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
        normalizedRootPath: repoPath,
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

    const registry = buildSymbolRegistry({ manifest, symbols });
    const result = await writeSymbolRegistrySidecar({ registry });
    return { registry, result };
}

function baseSnapshotManager(repoPath: string) {
    return {
        getIndexedCodebases: () => [repoPath],
        getCodebaseInfo: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined,
        getAllCodebases: () => []
    } as any;
}

test('handleFileOutline returns requires_reindex when sidecar metadata is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'requires_reindex');
        assert.equal(payload.file, 'src/runtime.ts');
        assert.equal(payload.hints.reindex.args.path, repoPath);
    });
});

test('handleFileOutline returns requires_reindex, not unsupported, for Go/Rust when the symbol registry is missing', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, 'src', 'service.go'), [
            'package svc',
            '',
            'func add(a int, b int) int {',
            '  return a + b',
            '}',
            '',
        ].join('\n'));
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

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        for (const file of ['src/service.go', 'src/stack.rs']) {
            const response = await handlers.handleFileOutline({ path: repoPath, file });
            const payload = JSON.parse(response.content[0]?.text || '{}');

            assert.equal(payload.status, 'requires_reindex');
            assert.equal(payload.reason, 'requires_reindex');
            assert.equal(payload.file, file);
            assert.notEqual(payload.status, 'unsupported');
            assert.equal(payload.hints.reindex.args.path, repoPath);
        }
    }));
});

test('handleFileOutline reports partial index navigation unavailable for limit_reached indexes', async () => {
    await withTempRepo(async (repoPath) => {
        const info = {
            status: 'indexed',
            indexStatus: 'limit_reached',
            lastUpdated: '2026-06-17T00:00:00.000Z',
        };
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseInfo: () => info,
            getAllCodebases: () => [{ path: repoPath, info }],
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'partial_index_navigation_unavailable');
        assert.match(payload.message, /partial index\/search data may exist/i);
        assert.match(payload.message, /navigation sidecars were not published/i);
        assert.equal(payload.hints.reindex.args.path, repoPath);
    });
});

test('handleFileOutline returns not_ready envelope when codebase is indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [repoPath],
            getAllCodebases: () => [{
                path: repoPath,
                info: {
                    status: 'indexing',
                    indexingPercentage: 55,
                    lastUpdated: '2026-02-27T23:57:03.000Z'
                }
            }],
            getCodebaseInfo: () => ({
                status: 'indexing',
                indexingPercentage: 55,
                lastUpdated: '2026-02-27T23:57:03.000Z'
            }),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'indexing');
        assert.equal(payload.codebaseRoot, repoPath);
        assert.equal(payload.indexing.progressPct, 55);
        assert.equal(payload.indexing.lastUpdated, '2026-02-27T23:57:03.000Z');
        assert.equal(payload.hints.status.tool, 'manage_index');
        assert.equal(payload.hints.status.args.action, 'status');
        assert.equal(payload.hints.status.args.path, repoPath);
    });
});

test('handleFileOutline returns unsupported for unsupported file extensions', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 0,
                edgeCount: 0,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
        } as any;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as any,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'docs.md'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'unsupported');
        assert.equal(payload.outline, null);
    });
});

test('handleFileOutline supports JavaScript extensions for sidecar-backed outline flow', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.js'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.file, 'src/runtime.js');
    });
});

test('handleFileOutline returns registry-backed outline when call graph sidecar is absent', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        const beta = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function beta()',
            name: 'beta',
            qualifiedName: 'beta',
            startLine: 10,
            endLine: 13,
        });
        await writeTestSymbolRegistry(repoPath, [beta, alpha]);

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hasMore, false);
        assert.equal(payload.outline.symbols.length, 2);
        assert.equal(payload.outline.symbols[0].symbolId, alpha.symbolInstanceId);
        assert.equal(payload.outline.symbols[1].symbolId, beta.symbolInstanceId);
        assert.equal(payload.outline.symbols[0].callGraphHint.supported, true);
        assert.equal(payload.outline.symbols[0].callGraphHint.symbolRef.symbolId, alpha.symbolInstanceId);
        assert.equal(payload.warnings, undefined);
    }));
});

test('handleFileOutline returns relationship-backed call graph hints when legacy sidecar is absent but navigation sidecars are compatible', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        const { registry, result } = await writeTestSymbolRegistry(repoPath, [alpha]);
        await writeRelationshipSidecar({
            normalizedRootPath: repoPath,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: registry.manifest.files,
            records: [],
        });

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols[0].callGraphHint.supported, true);
        assert.equal(payload.outline.symbols[0].callGraphHint.symbolRef.symbolId, alpha.symbolInstanceId);
        assert.equal(payload.outline.symbols[0].callGraphHint.sidecarBuiltAt, '2026-01-01T00:00:00.000Z');
        assert.equal(payload.warnings, undefined);
    }));
});

test('handleFileOutline returns Go symbols without enabling call_graph even when relationship sidecars exist', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, 'src', 'service.go'), [
            'package svc',
            '',
            'func add(a, b int) int {',
            '  return a + b',
            '}',
            '',
        ].join('\n'));
        const add = createTestSymbol({
            file: 'src/service.go',
            label: 'function add',
            name: 'add',
            qualifiedName: 'add',
            startLine: 3,
            endLine: 5,
            language: 'go',
            kind: 'function',
        });
        const { registry, result } = await writeTestSymbolRegistry(repoPath, [add]);
        await writeRelationshipSidecar({
            normalizedRootPath: repoPath,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: registry.manifest.files,
            records: [],
        });

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const outlineResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/service.go'
        });

        const outlinePayload = JSON.parse(outlineResponse.content[0]?.text || '{}');
        assert.equal(outlinePayload.status, 'ok');
        assert.equal(outlinePayload.outline.symbols.length, 1);
        assert.equal(outlinePayload.outline.symbols[0].symbolId, add.symbolInstanceId);
        assert.equal(outlinePayload.outline.symbols[0].callGraphHint.supported, false);
        assert.equal(outlinePayload.outline.symbols[0].callGraphHint.reason, 'unsupported_language');
        assert.ok(outlinePayload.warnings.includes('OUTLINE_CALL_GRAPH_UNAVAILABLE:unsupported_language'));

        const callGraphResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/service.go',
                symbolId: add.symbolInstanceId,
            },
            direction: 'callees',
            depth: 1,
            limit: 20,
        });
        const callGraphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
        assert.equal(callGraphPayload.status, 'unsupported');
        assert.equal(callGraphPayload.supported, false);
        assert.equal(callGraphPayload.reason, 'unsupported_language');
    }));
});

test('handleFileOutline returns Rust symbols without enabling call_graph even when relationship sidecars exist', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
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
        const push = createTestSymbol({
            file: 'src/stack.rs',
            label: 'method push',
            name: 'push',
            qualifiedName: 'Stack.push',
            startLine: 4,
            endLine: 6,
            language: 'rust',
            kind: 'method',
        });
        const { registry, result } = await writeTestSymbolRegistry(repoPath, [push]);
        await writeRelationshipSidecar({
            normalizedRootPath: repoPath,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: registry.manifest.files,
            records: [],
        });

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const outlineResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/stack.rs'
        });

        const outlinePayload = JSON.parse(outlineResponse.content[0]?.text || '{}');
        assert.equal(outlinePayload.status, 'ok');
        assert.equal(outlinePayload.outline.symbols.length, 1);
        assert.equal(outlinePayload.outline.symbols[0].symbolId, push.symbolInstanceId);
        assert.equal(outlinePayload.outline.symbols[0].callGraphHint.supported, false);
        assert.equal(outlinePayload.outline.symbols[0].callGraphHint.reason, 'unsupported_language');
        assert.ok(outlinePayload.warnings.includes('OUTLINE_CALL_GRAPH_UNAVAILABLE:unsupported_language'));

        const callGraphResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/stack.rs',
                symbolId: push.symbolInstanceId,
            },
            direction: 'callees',
            depth: 1,
            limit: 20,
        });
        const callGraphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
        assert.equal(callGraphPayload.status, 'unsupported');
        assert.equal(callGraphPayload.supported, false);
        assert.equal(callGraphPayload.reason, 'unsupported_language');
    }));
});

test('handleFileOutline relationship-backed callGraphHint works end to end with call_graph without a legacy sidecar', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        const beta = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function beta()',
            name: 'beta',
            qualifiedName: 'beta',
            startLine: 10,
            endLine: 13,
        });
        const { registry, result } = await writeTestSymbolRegistry(repoPath, [alpha, beta]);
        await writeRelationshipSidecar({
            normalizedRootPath: repoPath,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: registry.manifest.files,
            records: [{
                sourceKey: alpha.symbolKey,
                sourceInstanceId: alpha.symbolInstanceId,
                targetKey: beta.symbolKey,
                targetInstanceId: beta.symbolInstanceId,
                type: 'CALLS',
                file: 'src/runtime.ts',
                span: { startLine: 5, endLine: 5 },
                confidence: 'high',
            }],
        });

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const outlineResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const outlinePayload = JSON.parse(outlineResponse.content[0]?.text || '{}');
        assert.equal(outlinePayload.status, 'ok', JSON.stringify(outlinePayload));
        const symbolRef = outlinePayload.outline.symbols[0].callGraphHint.symbolRef;
        assert.equal(outlinePayload.outline.symbols[0].callGraphHint.supported, true);
        assert.equal(symbolRef.symbolId, alpha.symbolInstanceId);

        const callGraphResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef,
            direction: 'callees',
            depth: 2,
            limit: 20,
        });

        const graphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
        assert.equal(graphPayload.status, 'ok');
        assert.equal(graphPayload.supported, true);
        assert.deepEqual(graphPayload.nodes.map((node: { symbolId: string }) => node.symbolId), [
            alpha.symbolInstanceId,
            beta.symbolInstanceId,
        ]);
        assert.equal(graphPayload.edges.length, 1);
        assert.equal(graphPayload.edges[0].srcSymbolId, alpha.symbolInstanceId);
        assert.equal(graphPayload.edges[0].dstSymbolId, beta.symbolInstanceId);
    }));
});

test('handleFileOutline relationship-backed callGraphHint works end to end with call_graph through explicit sqlite backend after JSON sidecars are removed', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        const beta = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function beta()',
            name: 'beta',
            qualifiedName: 'beta',
            startLine: 10,
            endLine: 13,
        });
        const { registry, result } = await writeTestSymbolRegistry(repoPath, [alpha, beta]);
        await writeRelationshipSidecar({
            normalizedRootPath: repoPath,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: registry.manifest.files,
            records: [{
                sourceKey: alpha.symbolKey,
                sourceInstanceId: alpha.symbolInstanceId,
                targetKey: beta.symbolKey,
                targetInstanceId: beta.symbolInstanceId,
                type: 'CALLS',
                file: 'src/runtime.ts',
                span: { startLine: 5, endLine: 5 },
                confidence: 'high',
            }],
        });
        await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: repoPath,
        });

        const navigationRoot = resolveNavigationSidecarRoot(stateRoot, repoPath);
        await fs.promises.rm(path.join(navigationRoot, 'manifest.json'), { force: true });
        await fs.promises.rm(path.join(navigationRoot, 'symbols'), { recursive: true, force: true });
        await fs.promises.rm(path.join(navigationRoot, 'relationships'), { recursive: true, force: true });

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as any,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            new RuntimeNavigationStore({ servingBackend: 'sqlite' })
        );
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const outlineResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const outlinePayload = JSON.parse(outlineResponse.content[0]?.text || '{}');
        const symbolRef = outlinePayload.outline.symbols[0].callGraphHint.symbolRef;
        assert.equal(outlinePayload.outline.symbols[0].callGraphHint.supported, true);
        assert.equal(symbolRef.symbolId, alpha.symbolInstanceId);

        const callGraphResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef,
            direction: 'callees',
            depth: 2,
            limit: 20,
        });

        const callGraphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
        assert.equal(callGraphPayload.status, 'ok');
        assert.equal(callGraphPayload.supported, true);
        assert.deepEqual(callGraphPayload.nodes.map((node: { symbolId: string }) => node.symbolId), [
            alpha.symbolInstanceId,
            beta.symbolInstanceId,
        ]);
        assert.equal(callGraphPayload.edges.length, 1);
        assert.equal(callGraphPayload.edges[0].srcSymbolId, alpha.symbolInstanceId);
        assert.equal(callGraphPayload.edges[0].dstSymbolId, beta.symbolInstanceId);
    }));
});

test('handleFileOutline relationship-backed callGraphHint works through the env-selected shared sqlite runtime store after JSON sidecars are removed', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        const beta = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function beta()',
            name: 'beta',
            qualifiedName: 'beta',
            startLine: 10,
            endLine: 13,
        });
        const { registry, result } = await writeTestSymbolRegistry(repoPath, [alpha, beta]);
        await writeRelationshipSidecar({
            normalizedRootPath: repoPath,
            symbolRegistryManifestHash: result.manifestHash,
            relationshipVersion: 'test-relationships-v1',
            builtAt: '2026-01-01T00:00:00.000Z',
            files: registry.manifest.files,
            records: [{
                sourceKey: alpha.symbolKey,
                sourceInstanceId: alpha.symbolInstanceId,
                targetKey: beta.symbolKey,
                targetInstanceId: beta.symbolInstanceId,
                type: 'CALLS',
                file: 'src/runtime.ts',
                span: { startLine: 5, endLine: 5 },
                confidence: 'high',
            }],
        });
        await importNavigationToSqlite({
            stateRoot,
            normalizedRootPath: repoPath,
        });

        const navigationRoot = resolveNavigationSidecarRoot(stateRoot, repoPath);
        await fs.promises.rm(path.join(navigationRoot, 'manifest.json'), { force: true });
        await fs.promises.rm(path.join(navigationRoot, 'symbols'), { recursive: true, force: true });
        await fs.promises.rm(path.join(navigationRoot, 'relationships'), { recursive: true, force: true });

        await withNavigationEnv({
            SATORI_NAVIGATION_BACKEND: 'sqlite',
        }, async () => {
            const snapshotManager = {
                ...baseSnapshotManager(repoPath),
                getCodebaseCallGraphSidecar: () => undefined,
            } as any;
            const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
            (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

            const outlineResponse = await handlers.handleFileOutline({
                path: repoPath,
                file: 'src/runtime.ts'
            });

            const outlinePayload = JSON.parse(outlineResponse.content[0]?.text || '{}');
            const symbolRef = outlinePayload.outline.symbols[0].callGraphHint.symbolRef;
            assert.equal(outlinePayload.outline.symbols[0].callGraphHint.supported, true);
            assert.equal(symbolRef.symbolId, alpha.symbolInstanceId);

            const callGraphResponse = await handlers.handleCallGraph({
                path: repoPath,
                symbolRef,
                direction: 'callees',
                depth: 2,
                limit: 20,
            });

            const callGraphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
            assert.equal(callGraphPayload.status, 'ok');
            assert.equal(callGraphPayload.supported, true);
            assert.deepEqual(callGraphPayload.nodes.map((node: { symbolId: string }) => node.symbolId), [
                alpha.symbolInstanceId,
                beta.symbolInstanceId,
            ]);
            assert.equal(callGraphPayload.edges.length, 1);
            assert.equal(callGraphPayload.edges[0].srcSymbolId, alpha.symbolInstanceId);
            assert.equal(callGraphPayload.edges[0].dstSymbolId, beta.symbolInstanceId);
        });
    }));
});

test('handleFileOutline can read registry-backed outline from an injected navigation store', async () => {
    await withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        const registry = buildSymbolRegistry({
            manifest: {
                schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
                normalizedRootPath: repoPath,
                rootFingerprint: 'test-root-fingerprint',
                indexPolicyHash: 'test-policy',
                languageRouterVersion: 'test-router-v1',
                extractorVersion: 'test-extractor-v1',
                relationshipVersion: 'test-relationships-v1',
                builtAt: '2026-01-01T00:00:00.000Z',
                files: [{
                    path: 'src/runtime.ts',
                    hash: alpha.fileHash,
                    language: alpha.language,
                    symbolCount: 1,
                }],
            },
            symbols: [alpha],
        });
        const fakeNavigationStore = {
            getManifest: async () => ({
                status: 'ok',
                rootPath: '/virtual/navigation',
                manifestHash: 'symmanifest_test',
                registryManifestHash: 'symmanifest_test',
                registry,
                warnings: [],
            }),
            getSymbolsByFile: async () => ({
                status: 'ok',
                rootPath: '/virtual/navigation',
                manifestHash: 'symmanifest_test',
                registryManifestHash: 'symmanifest_test',
                registry,
                warnings: [],
                symbols: [alpha],
            }),
            getCompatibilityState: async () => ({
                rootPath: '/virtual/navigation',
                registry: {
                    status: 'ok',
                    rootPath: '/virtual/navigation',
                    manifestHash: 'symmanifest_test',
                    registryManifestHash: 'symmanifest_test',
                    registry,
                    warnings: [],
                },
                relationships: {
                    status: 'missing',
                    rootPath: '/virtual/navigation',
                    reason: 'relationship manifest is missing',
                },
            }),
        };
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as any,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            fakeNavigationStore as any
        );
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols.length, 1);
        assert.equal(payload.outline.symbols[0].symbolId, alpha.symbolInstanceId);
        assert.equal(payload.outline.symbols[0].callGraphHint.supported, false);
        assert.equal(payload.outline.symbols[0].callGraphHint.reason, 'missing_relationship_sidecar');
    });
});

test('handleFileOutline registry exact mode resolves a unique symbolInstanceId', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        const beta = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function beta()',
            name: 'beta',
            qualifiedName: 'beta',
            startLine: 10,
            endLine: 13,
        });
        await writeTestSymbolRegistry(repoPath, [alpha, beta]);

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: beta.symbolInstanceId
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols.length, 1);
        assert.equal(payload.outline.symbols[0].symbolId, beta.symbolInstanceId);
        assert.equal(payload.outline.symbols[0].symbolLabel, 'function beta()');
    }));
});

test('handleFileOutline registry exact mode returns ambiguous for duplicate exact labels', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const first = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function same()',
            name: 'same',
            qualifiedName: 'same',
            startLine: 4,
            endLine: 7,
        });
        const second = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function same()',
            name: 'same',
            qualifiedName: 'same',
            startLine: 10,
            endLine: 13,
        });
        await writeTestSymbolRegistry(repoPath, [second, first]);

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolLabelExact: 'function same()'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ambiguous');
        assert.equal(payload.outline.symbols.length, 2);
        assert.equal(payload.outline.symbols[0].symbolId, first.symbolInstanceId);
        assert.equal(payload.outline.symbols[1].symbolId, second.symbolInstanceId);
    }));
});

test('handleFileOutline registry-backed outline emits symbolInstanceId call graph handles even when a legacy sidecar exists', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        await writeTestSymbolRegistry(repoPath, [alpha]);

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 1,
                edgeCount: 0,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
        } as any;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [
                    { symbolId: 'legacy_sym_alpha', symbolLabel: 'function alpha()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 4, endLine: 7 } },
                ],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as any,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols[0].symbolId, alpha.symbolInstanceId);
        assert.equal(payload.outline.symbols[0].callGraphHint.supported, true);
        assert.equal(payload.outline.symbols[0].callGraphHint.symbolRef.symbolId, alpha.symbolInstanceId);
        assert.equal(payload.outline.symbols[0].callGraphHint.validatedAt, '2026-01-01T01:00:00.000Z');
    }));
});

test('handleFileOutline registry exact mode does not resolve legacy call graph symbol ids', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        await writeTestSymbolRegistry(repoPath, [alpha]);

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 1,
                edgeCount: 0,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
        } as any;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [
                    { symbolId: 'legacy_sym_alpha', symbolLabel: 'function alpha()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 4, endLine: 7 } },
                ],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as any,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: 'legacy_sym_alpha'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.outline, null);
    }));
});

test('handleFileOutline registry exact mode does not treat symbolKey as an exact identifier', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        await writeTestSymbolRegistry(repoPath, [alpha]);

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as any;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: alpha.symbolKey
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.outline, null);
    }));
});

test('handleFileOutline returns unsupported graph hints when relationship sidecar is incompatible', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const alpha = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function alpha()',
            name: 'alpha',
            qualifiedName: 'alpha',
            startLine: 4,
            endLine: 7,
        });
        await writeTestSymbolRegistry(repoPath, [alpha]);
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

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 1,
                edgeCount: 0,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
        } as any;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [
                    { symbolId: 'legacy_sym_alpha', symbolLabel: 'function alpha()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 4, endLine: 7 } },
                ],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as any,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols[0].callGraphHint.supported, false);
        assert.equal(payload.outline.symbols[0].callGraphHint.reason, 'incompatible_relationship_sidecar');
        assert.ok(payload.warnings.includes('OUTLINE_RELATIONSHIP_SIDECAR_UNAVAILABLE:incompatible'));
    }));
});

test('handleFileOutline returns not_found for missing files under root', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 0,
                edgeCount: 0,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
        } as any;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/missing.ts',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.outline, null);
    });
});
