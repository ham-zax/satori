import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    resolveNavigationSidecarRoot,
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
}): SymbolRecord {
    const fileHash = input.fileHash || 'hash_runtime';
    const parentQualifiedNamePath: string[] = [];
    const symbolKey = createSymbolKey({
        relativePath: input.file,
        language: 'typescript',
        kind: 'function',
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
        language: 'typescript',
        kind: 'function',
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

    await writeSymbolRegistrySidecar({
        registry: buildSymbolRegistry({ manifest, symbols }),
    });
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
        assert.equal(payload.outline.symbols[0].callGraphHint.supported, false);
        assert.equal(payload.outline.symbols[0].callGraphHint.reason, 'missing_sidecar');
        assert.deepEqual(payload.warnings, ['OUTLINE_CALL_GRAPH_UNAVAILABLE:missing_sidecar']);
    }));
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

test('handleFileOutline registry-backed outline preserves legacy call graph jump handles when available', async () => {
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
        assert.equal(payload.outline.symbols[0].callGraphHint.symbolRef.symbolId, 'legacy_sym_alpha');
        assert.equal(payload.outline.symbols[0].callGraphHint.validatedAt, '2026-01-01T01:00:00.000Z');
    }));
});

test('handleFileOutline registry exact mode resolves a legacy call graph symbol id', async () => {
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
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols.length, 1);
        assert.equal(payload.outline.symbols[0].symbolId, alpha.symbolInstanceId);
        assert.equal(payload.outline.symbols[0].symbolLabel, 'function alpha()');
    }));
});

test('handleFileOutline downgrades registry graph hints when relationship sidecar is incompatible', async () => {
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
        assert.equal(payload.outline.symbols[0].callGraphHint.reason, 'missing_sidecar');
        assert.ok(payload.warnings.includes('OUTLINE_RELATIONSHIP_SIDECAR_UNAVAILABLE:incompatible'));
    }));
});

test('handleFileOutline returns deterministic symbols with hasMore and warning codes', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 3,
                edgeCount: 0,
                noteCount: 1,
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
                    { symbolId: 'sym_b', symbolLabel: 'function zebra()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 10, endLine: 12 } },
                    { symbolId: 'sym_c', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 20, endLine: 21 } },
                    { symbolId: 'sym_a', symbolLabel: 'function alpha()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 10, endLine: 11 } },
                ],
                edges: [],
                notes: [
                    { type: 'missing_symbol_metadata', file: 'src/runtime.ts', startLine: 30, detail: 'missing metadata' }
                ]
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
            limitSymbols: 2
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hasMore, true);
        assert.equal(payload.outline.symbols.length, 2);
        assert.equal(payload.outline.symbols[0].symbolId, 'sym_a');
        assert.equal(payload.outline.symbols[1].symbolId, 'sym_b');
        assert.equal(payload.outline.symbols[0].callGraphHint.supported, true);
        assert.equal(payload.outline.symbols[0].callGraphHint.validated, true);
        assert.equal(payload.outline.symbols[0].callGraphHint.validatedAt, '2026-01-01T01:00:00.000Z');
        assert.equal(payload.outline.symbols[0].callGraphHint.sidecarBuiltAt, '2026-01-01T00:00:00.000Z');
        assert.equal(payload.warnings[0], 'OUTLINE_MISSING_SYMBOL_METADATA:1');
    });
});

test('handleFileOutline exact mode resolves a unique symbol deterministically', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 2,
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
                    { symbolId: 'sym_alpha', symbolLabel: 'function alpha()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 4, endLine: 7 } },
                    { symbolId: 'sym_beta', symbolLabel: 'function beta()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 10, endLine: 13 } },
                ],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolLabelExact: 'function beta()'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols.length, 1);
        assert.equal(payload.outline.symbols[0].symbolId, 'sym_beta');
    });
});

test('handleFileOutline exact mode returns ambiguous with deterministic candidates', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 2,
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
                    { symbolId: 'sym_b', symbolLabel: 'function same()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 20, endLine: 21 } },
                    { symbolId: 'sym_a', symbolLabel: 'function same()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 2, endLine: 3 } },
                ],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);
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
        assert.equal(payload.outline.symbols[0].symbolId, 'sym_a');
        assert.equal(payload.outline.symbols[1].symbolId, 'sym_b');
    });
});

test('handleFileOutline exact mode returns not_found when no exact symbol matches exist in file', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 2,
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
                    { symbolId: 'sym_alpha', symbolLabel: 'function alpha()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 4, endLine: 7 } },
                    { symbolId: 'sym_beta', symbolLabel: 'function beta()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 10, endLine: 13 } },
                ],
                edges: [],
                notes: []
            })
        } as any;

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolLabelExact: 'function gamma()'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.outline, null);
        assert.equal(payload.hasMore, false);
    });
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
