import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRegistry,
    createSymbolInstanceId,
    createSymbolKey,
    createSynthesizedFileSymbol,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from '@zokizuan/satori-core';
import type { RelationshipRecord, SymbolRecord, SymbolRegistryManifest } from '@zokizuan/satori-core';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type HandlerCallGraphManager = NonNullable<ConstructorParameters<typeof ToolHandlers>[6]>;
type HandlerNavigationStore = NonNullable<ConstructorParameters<typeof ToolHandlers>[9]>;
type ToolHandlersTestOverrides = {
    validateCompletionProof: (codebasePath: string) => Promise<unknown>;
    buildRelationshipBackedCallGraph: (...args: unknown[]) => Promise<unknown>;
};
type CallGraphNoteView = { type?: string; detail?: string; symbolId?: string; symbolLabel?: string; file?: string; startLine?: number };
type CallGraphNodeView = { symbolId?: string };

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
    executionProfile: 'connected',
    networkPolicy: { kind: 'remote-allowed' },
    vectorStoreProvider: 'Milvus',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-call-graph-handler-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), 'export function run() { return true; }\n');
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

function navigationManifest(files: SymbolRegistryManifest['files']): SymbolRegistryManifest {
    return {
        schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
        normalizedRootPath: '/repo',
        rootFingerprint: 'root-fingerprint',
        indexPolicyHash: 'policy-hash',
        languageRouterVersion: 'router-v1',
        extractorVersion: 'extractor-v1',
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files,
    };
}

function createFunctionSymbol(input: {
    file: string;
    name: string;
    qualifiedName?: string;
    label?: string;
    startLine: number;
    endLine: number;
    fileHash: string;
    language?: string;
    kind?: SymbolRecord['kind'];
}): SymbolRecord {
    const qualifiedName = input.qualifiedName || input.name;
    const label = input.label || `function ${input.name}()`;
    const language = input.language || 'typescript';
    const kind = input.kind || 'function';
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
            extractorVersion: 'extractor-v1',
        }),
        language,
        kind,
        name: input.name,
        qualifiedName,
        label,
        file: input.file,
        span,
        parentQualifiedNamePath,
        fileHash: input.fileHash,
        extractorVersion: 'extractor-v1',
    };
}

function sha256Content(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function writeTestNavigation(input: {
    stateRoot: string;
    repoPath: string;
    symbols: SymbolRecord[];
    records: RelationshipRecord[];
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

    const registry = buildSymbolRegistry({
        manifest: {
            ...navigationManifest([...filesByPath.entries()].map(([file, metadata]) => ({
                path: file,
                hash: metadata.hash,
                language: metadata.language,
                symbolCount: metadata.symbolCount,
            }))),
            normalizedRootPath: input.repoPath,
        },
        symbols: input.symbols,
    });
    const registryResult = await writeSymbolRegistrySidecar({
        stateRoot: input.stateRoot,
        registry,
    });
    await writeRelationshipSidecar({
        stateRoot: input.stateRoot,
        normalizedRootPath: input.repoPath,
        symbolRegistryManifestHash: registryResult.manifestHash,
        relationshipVersion: 'relationship-v1',
        builtAt: '2026-06-17T00:00:00.000Z',
        files: registry.manifest.files,
        records: input.records,
    });
    return { registry, registryResult };
}

function createHandlers(repoPath: string) {
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getVectorStore: () => ({ listCollections: async () => [] })
    } as unknown as HandlerContext;

    const snapshotManager = {
        getIndexedCodebases: () => [repoPath],
        getCodebaseInfo: () => undefined,
        getCodebaseStatus: () => 'indexed',
        getCodebaseCallGraphSidecar: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({
            allowed: false,
            changed: false,
            message: 'Legacy v2 index detected.'
        }),
        saveCodebaseSnapshot: () => undefined,
        getAllCodebases: () => []
    } as unknown as HandlerSnapshotManager;

    const syncManager = {} as unknown as HandlerSyncManager;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
    return handlers;
}

test('handleCallGraph returns requires_reindex envelope with explicit freshnessDecision', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run',
                symbolLabel: 'function run()',
                span: { startLine: 1, endLine: 1 }
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        assert.equal(response.isError, undefined);
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.supported, false);
        assert.equal(payload.reason, 'requires_reindex');
        assert.equal(payload.freshnessDecision.mode, 'skipped_requires_reindex');
        assert.deepEqual(payload.nodes, []);
        assert.deepEqual(payload.edges, []);
        assert.deepEqual(payload.notes, []);
        assert.equal(payload.hints.reindex.tool, 'manage_index');
        assert.equal(payload.hints.reindex.args.action, 'reindex');
        assert.equal(payload.hints.reindex.args.path, repoPath);
        assert.equal(payload.compatibility.runtimeFingerprint.schemaVersion, 'hybrid_v3');
        assert.equal(payload.compatibility.statusAtCheck, 'indexed');
    });
});

test('handleCallGraph allows source-backed traversal under runtime fingerprint mismatch', async () => {
    await withTempRepo(async (repoPath) => {
        const fileHash = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(repoPath, 'src', 'runtime.ts')))
            .digest('hex');
        const symbol = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'run',
            qualifiedName: 'src.runtime.run',
            label: 'function run()',
            startLine: 1,
            endLine: 1,
            fileHash,
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] }),
        } as unknown as HandlerContext;

        const snapshotManager = {
            getAllCodebases: () => [{
                path: repoPath,
                info: {
                    status: 'indexed',
                    indexedFiles: 1,
                    totalChunks: 1,
                    indexStatus: 'completed',
                    lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                }
            }],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => undefined,
            getCodebaseStatus: () => 'indexed',
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: false,
                changed: false,
                reason: 'fingerprint_mismatch',
                message: 'Index fingerprint mismatch.',
            }),
            saveCodebaseSnapshot: () => undefined,
        } as unknown as HandlerSnapshotManager;

        const navigationStore = {
            getSymbolsByFile: async () => ({
                status: 'ok',
                symbols: [symbol],
                manifestHash: 'manifest-hash',
                warnings: [],
                registry: { manifest: { builtAt: new Date('2026-01-01T00:00:00.000Z').toISOString() } },
            }),
            getCompatibilityState: async () => ({
                relationships: {
                    status: 'ok',
                    manifest: { builtAt: new Date('2026-01-01T00:00:00.000Z').toISOString() },
                },
            }),
        } as unknown as HandlerNavigationStore;

        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            undefined,
            undefined,
            undefined,
            navigationStore,
        );
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({
            outcome: 'fingerprint_mismatch',
        });
        (handlers as unknown as ToolHandlersTestOverrides).buildRelationshipBackedCallGraph = async () => ({
            supported: true,
            direction: 'callees',
            depth: 1,
            limit: 5,
            nodes: [{
                symbolId: symbol.symbolInstanceId,
                symbolLabel: symbol.label,
                file: symbol.file,
                language: symbol.language,
                span: symbol.span,
            }],
            edges: [],
            notes: [],
            notesTruncated: false,
            totalNoteCount: 0,
            returnedNoteCount: 0,
        });

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: symbol.symbolInstanceId,
                symbolLabel: symbol.label,
                span: { startLine: 1, endLine: 1 },
            },
            direction: 'callees',
            depth: 1,
            limit: 5,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.supported, true);
        assert.equal(payload.path, repoPath);
        assert.equal(payload.nodes[0]?.symbolId, symbol.symbolInstanceId);
    });
});

test('handleCallGraph returns requires_reindex when snapshot marks codebase blocked for a non-recoverable reason', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;

        const snapshotManager = {
            getIndexedCodebases: () => [],
            getCodebaseInfo: () => undefined,
            getCodebaseStatus: () => 'requires_reindex',
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: false,
                changed: false,
                reason: 'missing_fingerprint',
                message: 'Index has no fingerprint metadata.',
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => [{
                path: repoPath,
                info: {
                    status: 'requires_reindex',
                    message: 'Index has no fingerprint metadata.',
                    lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString()
                }
            }]
        } as unknown as HandlerSnapshotManager;

        const syncManager = {} as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run'
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'requires_reindex');
        assert.equal(payload.freshnessDecision.mode, 'skipped_requires_reindex');
        assert.equal(payload.hints.reindex.args.path, repoPath);
        assert.equal(payload.compatibility.runtimeFingerprint.schemaVersion, 'hybrid_v3');
        assert.equal(payload.compatibility.statusAtCheck, 'requires_reindex');
    });
});

test('handleCallGraph reports partial index navigation unavailable for limit_reached indexes', async () => {
    await withTempRepo(async (repoPath) => {
        const info = {
            status: 'indexed',
            indexStatus: 'limit_reached',
            lastUpdated: '2026-06-17T00:00:00.000Z',
        };
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;

        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => info,
            getCodebaseStatus: () => 'indexed',
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => [{ path: repoPath, info }]
        } as unknown as HandlerSnapshotManager;

        const syncManager = {} as unknown as HandlerSyncManager;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run'
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.supported, false);
        assert.equal(payload.reason, 'partial_index_navigation_unavailable');
        assert.deepEqual(payload.nodes, []);
        assert.deepEqual(payload.edges, []);
        assert.match(payload.message, /partial index\/search data may exist/i);
        assert.match(payload.message, /navigation sidecars were not published/i);
        assert.equal(payload.hints.reindex.args.path, repoPath);
    });
});

test('handleCallGraph returns requires_reindex for indexed roots that only have legacy v3 graph state', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;

        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 1,
                edgeCount: 0,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const syncManager = {} as unknown as HandlerSyncManager;
        const callGraphManager = {
            queryGraph: () => {
                throw new Error('legacy call graph fallback should not run');
            }
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run'
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.supported, false);
    });
});

test('handleCallGraph traverses compatible relationship sidecars without requiring a legacy graph sidecar', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const login = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
        });
        const normalize = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'normalize',
            startLine: 5,
            endLine: 7,
            fileHash: 'hash-runtime',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [login, normalize],
            records: [{
                sourceKey: login.symbolKey,
                sourceInstanceId: login.symbolInstanceId,
                targetKey: normalize.symbolKey,
                targetInstanceId: normalize.symbolInstanceId,
                type: 'CALLS',
                file: 'src/runtime.ts',
                span: { startLine: 2, endLine: 2 },
                confidence: 'high',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const callGraphManager = {
            queryGraph: () => {
                throw new Error('legacy call graph fallback should not run');
            }
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: login.symbolInstanceId,
                symbolLabel: login.label,
            },
            direction: 'callees',
            depth: 2,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.supported, true);
        assert.deepEqual(payload.nodes.map((node: { symbolId: string }) => node.symbolId), [
            login.symbolInstanceId,
            normalize.symbolInstanceId,
        ]);
        assert.equal(payload.edges.length, 1);
        assert.equal(payload.edges[0].srcSymbolId, login.symbolInstanceId);
        assert.equal(payload.edges[0].dstSymbolId, normalize.symbolInstanceId);
    }));
});

test('handleCallGraph synthesizes source-backed Python callees when stored span only covers multiline signature', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
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
        fs.writeFileSync(path.join(repoPath, 'src', 'phases.py'), source);
        const fileHash = sha256Content(source);
        const attach = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_attach_entry_telemetry',
            label: 'function _attach_entry_telemetry(',
            startLine: 2,
            endLine: 9,
            fileHash,
            language: 'python',
        });
        const build = createFunctionSymbol({
            file: 'src/phases.py',
            name: 'build_entry_telemetry',
            label: 'function build_entry_telemetry(',
            startLine: 17,
            endLine: 18,
            fileHash,
            language: 'python',
        });
        const renameOutputs = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_rename_outputs',
            label: 'function _rename_outputs(',
            startLine: 1,
            endLine: 2,
            fileHash,
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [attach, build, renameOutputs],
            records: [{
                sourceKey: attach.symbolKey,
                sourceInstanceId: attach.symbolInstanceId,
                targetKey: renameOutputs.symbolKey,
                targetInstanceId: renameOutputs.symbolInstanceId,
                type: 'CALLS',
                file: 'src/phases.py',
                span: { startLine: 2, endLine: 2 },
                confidence: 'high',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/phases.py',
                symbolId: attach.symbolInstanceId,
                symbolLabel: attach.label,
            },
            direction: 'callees',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.supported, true);
        assert.deepEqual(payload.nodes.map((node: { symbolId: string }) => node.symbolId), [
            attach.symbolInstanceId,
            build.symbolInstanceId,
        ]);
        assert.equal(payload.edges.length, 1);
        assert.equal(payload.edges[0].srcSymbolId, attach.symbolInstanceId);
        assert.equal(payload.edges[0].dstSymbolId, build.symbolInstanceId);
        assert.equal(payload.edges[0].site.startLine, 10);
        assert.ok(payload.warnings.includes('CALL_GRAPH_EDGE_OUTSIDE_SOURCE_SPAN:1'));
        assert.ok(payload.warnings.includes('SOURCE_BACKED_DYNAMIC_CALLEES:1'));
        assert.equal(payload.notes[0].type, 'dynamic_edge');
    }));
});

test('handleCallGraph does not synthesize Python callee fallback for unbound cross-file bare calls', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        fs.mkdirSync(path.join(repoPath, 'src', 'cli'), { recursive: true });
        fs.mkdirSync(path.join(repoPath, 'src', 'python', 'core'), { recursive: true });
        const source = [
            'def build_paper_runtime_harness_admission(values):',
            '    unique_values = set(values)',
            '    materialized_values = list(values)',
            '    return external_helper(materialized_values)',
            '',
        ].join('\n');
        const configSource = [
            'class ConfigManager:',
            '    def set(self, key, value):',
            '        return None',
            '',
        ].join('\n');
        const shadowSource = [
            'class ShadowExecutionStore:',
            '    def list(self):',
            '        return []',
            '',
        ].join('\n');
        const externalSource = [
            'def external_helper(values):',
            '    return values',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'phases.py'), source);
        fs.writeFileSync(path.join(repoPath, 'src', 'cli', 'config.py'), configSource);
        fs.writeFileSync(path.join(repoPath, 'src', 'python', 'core', 'helpers.py'), shadowSource);
        fs.writeFileSync(path.join(repoPath, 'src', 'external.py'), externalSource);
        const sourceHash = sha256Content(source);
        const configHash = sha256Content(configSource);
        const shadowHash = sha256Content(shadowSource);
        const externalHash = sha256Content(externalSource);
        const owner = createFunctionSymbol({
            file: 'src/phases.py',
            name: 'build_paper_runtime_harness_admission',
            label: 'function build_paper_runtime_harness_admission(',
            startLine: 1,
            endLine: 1,
            fileHash: sourceHash,
            language: 'python',
        });
        const configSet = createFunctionSymbol({
            file: 'src/cli/config.py',
            name: 'set',
            qualifiedName: 'ConfigManager.set',
            label: 'method ConfigManager.set(',
            startLine: 2,
            endLine: 3,
            fileHash: configHash,
            language: 'python',
            kind: 'method',
        });
        const shadowList = createFunctionSymbol({
            file: 'src/python/core/helpers.py',
            name: 'list',
            qualifiedName: 'ShadowExecutionStore.list',
            label: 'method ShadowExecutionStore.list(',
            startLine: 2,
            endLine: 3,
            fileHash: shadowHash,
            language: 'python',
            kind: 'method',
        });
        const externalHelper = createFunctionSymbol({
            file: 'src/external.py',
            name: 'external_helper',
            label: 'function external_helper(',
            startLine: 1,
            endLine: 2,
            fileHash: externalHash,
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [owner, configSet, shadowList, externalHelper],
            records: [],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/phases.py',
                symbolId: owner.symbolInstanceId,
                symbolLabel: owner.label,
            },
            direction: 'callees',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.supported, true);
        assert.equal(payload.edges.length, 0);
        assert.deepEqual(payload.nodes.map((node: CallGraphNodeView) => node.symbolId), [owner.symbolInstanceId]);
        assert.ok(!payload.warnings?.some((warning: string) => warning.startsWith('SOURCE_BACKED_DYNAMIC_CALLEES:')));
        assert.ok(!payload.notes.some((note: CallGraphNoteView) => note.type === 'dynamic_edge'));
    }));
});

test('handleCallGraph surfaces suppressed low-confidence Python candidates and recovers callees when validated spans have no usable sidecar edge', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
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
        fs.writeFileSync(path.join(repoPath, 'src', 'phases.py'), source);
        const fileHash = sha256Content(source);
        const attach = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_attach_entry_telemetry',
            label: 'function _attach_entry_telemetry(',
            startLine: 4,
            endLine: 15,
            fileHash,
            language: 'python',
        });
        const build = createFunctionSymbol({
            file: 'src/phases.py',
            name: 'build_entry_telemetry',
            label: 'function build_entry_telemetry(',
            startLine: 17,
            endLine: 18,
            fileHash,
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [attach, build],
            records: [{
                sourceKey: attach.symbolKey,
                sourceInstanceId: attach.symbolInstanceId,
                targetKey: build.symbolKey,
                targetInstanceId: build.symbolInstanceId,
                type: 'CALLS',
                file: 'src/phases.py',
                span: { startLine: 10, endLine: 10 },
                confidence: 'low',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const calleesResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/phases.py',
                symbolId: attach.symbolInstanceId,
                symbolLabel: attach.label,
            },
            direction: 'callees',
            depth: 1,
            limit: 20
        });

        const calleesPayload = JSON.parse(calleesResponse.content[0]?.text || '{}');
        assert.equal(calleesPayload.status, 'ok');
        assert.equal(calleesPayload.edges.length, 1);
        assert.equal(calleesPayload.edges[0].kind, 'dynamic');
        assert.equal(calleesPayload.edges[0].srcSymbolId, attach.symbolInstanceId);
        assert.equal(calleesPayload.edges[0].dstSymbolId, build.symbolInstanceId);
        assert.equal(calleesPayload.edges[0].site.startLine, 10);
        assert.ok(calleesPayload.warnings.includes('RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1'));
        assert.ok(calleesPayload.warnings.includes('SOURCE_BACKED_DYNAMIC_CALLEES:1'));
        assert.ok(calleesPayload.notes.some((note: CallGraphNoteView) => (
            note.type === 'suppressed_edge'
            && note.symbolId === build.symbolInstanceId
            && note.symbolLabel === build.label
            && note.confidence === 0.35
            && note.startLine === 10
            && note.detail.includes('src/phases.py:10')
        )));
        assert.ok(calleesPayload.notes.some((note: CallGraphNoteView) => note.type === 'dynamic_edge'));

        const callersResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/phases.py',
                symbolId: build.symbolInstanceId,
                symbolLabel: build.label,
            },
            direction: 'callers',
            depth: 1,
            limit: 20
        });

        const callersPayload = JSON.parse(callersResponse.content[0]?.text || '{}');
        assert.equal(callersPayload.status, 'ok');
        assert.equal(callersPayload.edges.length, 1);
        assert.equal(callersPayload.edges[0].kind, 'dynamic');
        assert.equal(callersPayload.edges[0].srcSymbolId, attach.symbolInstanceId);
        assert.equal(callersPayload.edges[0].dstSymbolId, build.symbolInstanceId);
        assert.equal(callersPayload.edges[0].site.startLine, 10);
        assert.ok(callersPayload.warnings.includes('RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1'));
        assert.ok(callersPayload.warnings.includes('SOURCE_BACKED_DYNAMIC_CALLERS:1'));
        assert.deepEqual(
            callersPayload.nodes.map((node: CallGraphNodeView) => node.symbolId).sort(),
            [attach.symbolInstanceId, build.symbolInstanceId].sort()
        );
        assert.equal(callersPayload.sidecar.nodeCount, callersPayload.nodes.length);
        assert.ok(callersPayload.notes.some((note: CallGraphNoteView) => (
            note.type === 'suppressed_edge'
            && note.symbolId === attach.symbolInstanceId
            && note.symbolLabel === attach.label
            && note.confidence === 0.35
            && note.startLine === 10
            && note.detail.includes('src/phases.py:10')
        )));
        assert.ok(callersPayload.notes.some((note: CallGraphNoteView) => (
            note.type === 'dynamic_edge'
            && note.symbolId === attach.symbolInstanceId
        )));
    }));
});

test('handleCallGraph does not synthesize Python caller fallback when the suppressed record has no site line', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
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
        fs.writeFileSync(path.join(repoPath, 'src', 'phases.py'), source);
        const fileHash = sha256Content(source);
        const attach = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_attach_entry_telemetry',
            label: 'function _attach_entry_telemetry(',
            startLine: 4,
            endLine: 15,
            fileHash,
            language: 'python',
        });
        const build = createFunctionSymbol({
            file: 'src/phases.py',
            name: 'build_entry_telemetry',
            label: 'function build_entry_telemetry(',
            startLine: 17,
            endLine: 18,
            fileHash,
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [attach, build],
            records: [{
                sourceKey: attach.symbolKey,
                sourceInstanceId: attach.symbolInstanceId,
                targetKey: build.symbolKey,
                targetInstanceId: build.symbolInstanceId,
                type: 'CALLS',
                file: 'src/phases.py',
                span: undefined,
                confidence: 'low',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const callersResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/phases.py',
                symbolId: build.symbolInstanceId,
                symbolLabel: build.label,
            },
            direction: 'callers',
            depth: 1,
            limit: 20
        });

        const callersPayload = JSON.parse(callersResponse.content[0]?.text || '{}');
        assert.equal(callersPayload.status, 'ok');
        assert.equal(callersPayload.edges.length, 0);
        assert.ok(callersPayload.warnings.includes('RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1'));
        assert.ok(!callersPayload.warnings.includes('SOURCE_BACKED_DYNAMIC_CALLERS:1'));
        assert.ok(callersPayload.notes.some((note: CallGraphNoteView) => (
            note.type === 'suppressed_edge'
            && note.symbolId === attach.symbolInstanceId
            && note.detail.includes('src/phases.py:4')
        )));
        assert.ok(!callersPayload.notes.some((note: CallGraphNoteView) => note.type === 'dynamic_edge'));
        // C1: notes-only inbound promotes executable must: identifier search.
        const nextStep = callersPayload.hints?.nextSteps?.[0];
        assert.equal(nextStep?.tool, 'search_codebase');
        assert.match(String(nextStep?.args?.query || ''), /^must:[A-Za-z_$][\w$]* /);
        // Same-file suppressed site: path: is the call-site file (not a different callee file).
        assert.match(String(nextStep?.args?.query || ''), / path:src\/phases\.py$/);
        assert.equal(nextStep?.args?.path, repoPath);
        assert.equal(nextStep?.args?.scope, 'runtime');
    }));
});

test('handleCallGraph notes-only inbound fallback path uses unique cross-file caller site, not callee file', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        // TypeScript avoids Python source-backed caller recovery so the graph stays notes-only.
        const calleeSource = [
            'export function targetSymbol() {',
            '  return 1;',
            '}',
            '',
        ].join('\n');
        const callerSource = [
            'import { targetSymbol } from "./target";',
            '',
            'export function invokeTarget() {',
            '  return targetSymbol();',
            '}',
            '',
        ].join('\n');
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'src', 'target.ts'), calleeSource);
        fs.writeFileSync(path.join(repoPath, 'src', 'caller.ts'), callerSource);
        const calleeHash = sha256Content(calleeSource);
        const callerHash = sha256Content(callerSource);
        const target = createFunctionSymbol({
            file: 'src/target.ts',
            name: 'targetSymbol',
            label: 'function targetSymbol()',
            startLine: 1,
            endLine: 3,
            fileHash: calleeHash,
            language: 'typescript',
        });
        const invoke = createFunctionSymbol({
            file: 'src/caller.ts',
            name: 'invokeTarget',
            label: 'function invokeTarget()',
            startLine: 3,
            endLine: 5,
            fileHash: callerHash,
            language: 'typescript',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [target, invoke],
            records: [{
                sourceKey: invoke.symbolKey,
                sourceInstanceId: invoke.symbolInstanceId,
                targetKey: target.symbolKey,
                targetInstanceId: target.symbolInstanceId,
                type: 'CALLS',
                // Call site lives in the caller file — recovery path: must use this, not target.ts.
                file: 'src/caller.ts',
                span: { startLine: 4, endLine: 4 },
                confidence: 'low',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] }),
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false,
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => [],
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/target.ts',
                symbolId: target.symbolInstanceId,
                symbolLabel: target.label,
            },
            direction: 'callers',
            depth: 1,
            limit: 20,
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.edges.length, 0);
        assert.ok(payload.notes.some((note: CallGraphNoteView) => (
            note.type === 'suppressed_edge'
            && note.file === 'src/caller.ts'
            && note.detail.includes('caller candidate')
        )));
        const nextStep = payload.hints?.nextSteps?.[0];
        assert.equal(nextStep?.tool, 'search_codebase');
        const query = String(nextStep?.args?.query || '');
        assert.match(query, /must:targetSymbol targetSymbol/);
        assert.match(query, / path:src\/caller\.ts$/);
        assert.doesNotMatch(query, /path:src\/target\.ts/);
    }));
});

test('handleCallGraph notes-only inbound omits path: when suppressed callers span multiple files', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const calleeSource = 'export function multiTarget() { return 1; }\n';
        const aSource = 'import { multiTarget } from "./target";\nexport function a() { return multiTarget(); }\n';
        const bSource = 'import { multiTarget } from "./target";\nexport function b() { return multiTarget(); }\n';
        fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoPath, 'src', 'target.ts'), calleeSource);
        fs.writeFileSync(path.join(repoPath, 'src', 'a.ts'), aSource);
        fs.writeFileSync(path.join(repoPath, 'src', 'b.ts'), bSource);
        const target = createFunctionSymbol({
            file: 'src/target.ts',
            name: 'multiTarget',
            label: 'function multiTarget()',
            startLine: 1,
            endLine: 1,
            fileHash: sha256Content(calleeSource),
            language: 'typescript',
        });
        const a = createFunctionSymbol({
            file: 'src/a.ts',
            name: 'a',
            label: 'function a()',
            startLine: 2,
            endLine: 2,
            fileHash: sha256Content(aSource),
            language: 'typescript',
        });
        const b = createFunctionSymbol({
            file: 'src/b.ts',
            name: 'b',
            label: 'function b()',
            startLine: 2,
            endLine: 2,
            fileHash: sha256Content(bSource),
            language: 'typescript',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [target, a, b],
            records: [
                {
                    sourceKey: a.symbolKey,
                    sourceInstanceId: a.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/a.ts',
                    span: { startLine: 2, endLine: 2 },
                    confidence: 'low',
                },
                {
                    sourceKey: b.symbolKey,
                    sourceInstanceId: b.symbolInstanceId,
                    targetKey: target.symbolKey,
                    targetInstanceId: target.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/b.ts',
                    span: { startLine: 2, endLine: 2 },
                    confidence: 'low',
                },
            ],
        });

        const handlers = new ToolHandlers(
            {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                getVectorStore: () => ({ listCollections: async () => [] }),
            } as unknown as HandlerContext,
            {
                getIndexedCodebases: () => [repoPath],
                getCodebaseInfo: () => undefined,
                getCodebaseCallGraphSidecar: () => undefined,
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
                saveCodebaseSnapshot: () => undefined,
                getAllCodebases: () => [],
            } as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/target.ts',
                symbolId: target.symbolInstanceId,
                symbolLabel: target.label,
            },
            direction: 'callers',
            depth: 1,
            limit: 20,
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.edges.length, 0);
        const query = String(payload.hints?.nextSteps?.[0]?.args?.query || '');
        assert.match(query, /must:multiTarget multiTarget/);
        assert.doesNotMatch(query, / path:/);
    }));
});

test('handleCallGraph node ordering is independent of String.prototype.localeCompare', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const source = [
            'def beta():',
            '    return 1',
            '',
            'def alpha():',
            '    return beta()',
            '',
            'def gamma():',
            '    return beta()',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), source); // keep extension from fixture
        fs.writeFileSync(path.join(repoPath, 'src', 'order.py'), source);
        const hash = sha256Content(source);
        const beta = createFunctionSymbol({
            file: 'src/order.py',
            name: 'beta',
            label: 'function beta()',
            startLine: 1,
            endLine: 2,
            fileHash: hash,
            language: 'python',
        });
        const alpha = createFunctionSymbol({
            file: 'src/order.py',
            name: 'alpha',
            label: 'function alpha()',
            startLine: 4,
            endLine: 5,
            fileHash: hash,
            language: 'python',
        });
        const gamma = createFunctionSymbol({
            file: 'src/order.py',
            name: 'gamma',
            label: 'function gamma()',
            startLine: 7,
            endLine: 8,
            fileHash: hash,
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [beta, alpha, gamma],
            records: [
                {
                    sourceKey: alpha.symbolKey,
                    sourceInstanceId: alpha.symbolInstanceId,
                    targetKey: beta.symbolKey,
                    targetInstanceId: beta.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/order.py',
                    span: { startLine: 5, endLine: 5 },
                    confidence: 'high',
                },
                {
                    sourceKey: gamma.symbolKey,
                    sourceInstanceId: gamma.symbolInstanceId,
                    targetKey: beta.symbolKey,
                    targetInstanceId: beta.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/order.py',
                    span: { startLine: 8, endLine: 8 },
                    confidence: 'high',
                },
            ],
        });

        const handlers = new ToolHandlers(
            {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                getVectorStore: () => ({ listCollections: async () => [] }),
            } as unknown as HandlerContext,
            {
                getIndexedCodebases: () => [repoPath],
                getCodebaseInfo: () => undefined,
                getCodebaseCallGraphSidecar: () => undefined,
                ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
                saveCodebaseSnapshot: () => undefined,
                getAllCodebases: () => [],
            } as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );

        const original = String.prototype.localeCompare;
        String.prototype.localeCompare = function patchedLocaleCompare(this: string): number {
            return -original.call(this, arguments[0] as string);
        };
        try {
            const response = await handlers.handleCallGraph({
                path: repoPath,
                symbolRef: {
                    file: 'src/order.py',
                    symbolId: beta.symbolInstanceId,
                    symbolLabel: beta.label,
                },
                direction: 'callers',
                depth: 1,
                limit: 20,
            });
            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.edges.length, 2);
            // Contract order: src by symbolId (instance ids are deterministic hashes) — at least
            // edge order must not reverse relative to a second poisoned call.
            const first = payload.edges.map((edge: { srcSymbolId: string; dstSymbolId: string }) => (
                `${edge.srcSymbolId}->${edge.dstSymbolId}`
            ));
            const response2 = await handlers.handleCallGraph({
                path: repoPath,
                symbolRef: {
                    file: 'src/order.py',
                    symbolId: beta.symbolInstanceId,
                    symbolLabel: beta.label,
                },
                direction: 'callers',
                depth: 1,
                limit: 20,
            });
            const second = JSON.parse(response2.content[0]?.text || '{}').edges.map(
                (edge: { srcSymbolId: string; dstSymbolId: string }) => `${edge.srcSymbolId}->${edge.dstSymbolId}`,
            );
            assert.deepEqual(first, second);
            // Node order stable under poison (code-unit, not localeCompare).
            const nodeIds = payload.nodes.map((node: CallGraphNodeView) => node.symbolId);
            const expectedNodeOrder = [...nodeIds].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0));
            // Nodes sort by file, span, label, then id — file equal; span start alpha=4 before beta=1? 
            // Actually sort is file, startLine, label, id. alpha start 4, beta 1, gamma 7 → beta, alpha, gamma by startLine.
            assert.deepEqual(
                payload.nodes.map((n: CallGraphNodeView) => n.symbolLabel),
                ['function beta()', 'function alpha()', 'function gamma()'],
            );
            assert.deepEqual(nodeIds, payload.nodes.map((n: CallGraphNodeView) => n.symbolId));
            void expectedNodeOrder;
        } finally {
            String.prototype.localeCompare = original;
        }
    }));
});

test('handleCallGraph does not synthesize Python caller fallback when the recorded site is outside the repaired source span', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
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
        fs.writeFileSync(path.join(repoPath, 'src', 'phases.py'), source);
        const fileHash = sha256Content(source);
        const attach = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_attach_entry_telemetry',
            label: 'function _attach_entry_telemetry(',
            startLine: 4,
            endLine: 15,
            fileHash,
            language: 'python',
        });
        const build = createFunctionSymbol({
            file: 'src/phases.py',
            name: 'build_entry_telemetry',
            label: 'function build_entry_telemetry(',
            startLine: 17,
            endLine: 18,
            fileHash,
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [attach, build],
            records: [{
                sourceKey: attach.symbolKey,
                sourceInstanceId: attach.symbolInstanceId,
                targetKey: build.symbolKey,
                targetInstanceId: build.symbolInstanceId,
                type: 'CALLS',
                file: 'src/phases.py',
                span: { startLine: 3, endLine: 3 },
                confidence: 'low',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const callersResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/phases.py',
                symbolId: build.symbolInstanceId,
                symbolLabel: build.label,
            },
            direction: 'callers',
            depth: 1,
            limit: 20
        });

        const callersPayload = JSON.parse(callersResponse.content[0]?.text || '{}');
        assert.equal(callersPayload.status, 'ok');
        assert.equal(callersPayload.edges.length, 0);
        assert.ok(callersPayload.warnings.includes('RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1'));
        assert.ok(!callersPayload.warnings.includes('SOURCE_BACKED_DYNAMIC_CALLERS:1'));
        assert.ok(callersPayload.notes.some((note: CallGraphNoteView) => (
            note.type === 'suppressed_edge'
            && note.symbolId === attach.symbolInstanceId
            && note.detail.includes('src/phases.py:3')
        )));
        assert.ok(!callersPayload.notes.some((note: CallGraphNoteView) => note.type === 'dynamic_edge'));
    }));
});

test('handleCallGraph does not synthesize Python caller fallback when the validated direct call resolves to a different target', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const phasesContent = [
            'def build_entry_telemetry():',
            '    return "local"',
            '',
            'def _attach_entry_telemetry():',
            '    return build_entry_telemetry()',
            '',
        ].join('\n');
        const telemetryContent = [
            'def build_entry_telemetry():',
            '    return "external"',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'phases.py'), phasesContent);
        fs.writeFileSync(path.join(repoPath, 'src', 'telemetry.py'), telemetryContent);
        const phasesHash = sha256Content(phasesContent);
        const telemetryHash = sha256Content(telemetryContent);
        const localBuild = createFunctionSymbol({
            file: 'src/phases.py',
            name: 'build_entry_telemetry',
            label: 'function build_entry_telemetry(',
            startLine: 1,
            endLine: 2,
            fileHash: phasesHash,
            language: 'python',
        });
        const attach = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_attach_entry_telemetry',
            label: 'function _attach_entry_telemetry(',
            startLine: 4,
            endLine: 5,
            fileHash: phasesHash,
            language: 'python',
        });
        const externalBuild = createFunctionSymbol({
            file: 'src/telemetry.py',
            name: 'build_entry_telemetry',
            label: 'function build_entry_telemetry(',
            startLine: 1,
            endLine: 2,
            fileHash: telemetryHash,
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [localBuild, attach, externalBuild],
            records: [{
                sourceKey: attach.symbolKey,
                sourceInstanceId: attach.symbolInstanceId,
                targetKey: externalBuild.symbolKey,
                targetInstanceId: externalBuild.symbolInstanceId,
                type: 'CALLS',
                file: 'src/phases.py',
                span: { startLine: 5, endLine: 5 },
                confidence: 'low',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        const callersResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/telemetry.py',
                symbolId: externalBuild.symbolInstanceId,
                symbolLabel: externalBuild.label,
            },
            direction: 'callers',
            depth: 1,
            limit: 20
        });

        const callersPayload = JSON.parse(callersResponse.content[0]?.text || '{}');
        assert.equal(callersPayload.status, 'ok');
        assert.equal(callersPayload.edges.length, 0);
        assert.ok(callersPayload.warnings.includes('RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1'));
        assert.ok(!callersPayload.warnings.includes('SOURCE_BACKED_DYNAMIC_CALLERS:1'));
        assert.ok(callersPayload.notes.some((note: CallGraphNoteView) => (
            note.type === 'suppressed_edge'
            && note.symbolId === attach.symbolInstanceId
            && note.detail.includes('src/phases.py:5')
        )));
        assert.ok(!callersPayload.notes.some((note: CallGraphNoteView) => note.type === 'dynamic_edge'));
    }));
});

test('handleCallGraph does not accept legacy v3 symbol ids as steady-state exact inputs', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const login = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
        });
        const normalize = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'normalize',
            startLine: 5,
            endLine: 7,
            fileHash: 'hash-runtime',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [login, normalize],
            records: [{
                sourceKey: login.symbolKey,
                sourceInstanceId: login.symbolInstanceId,
                targetKey: normalize.symbolKey,
                targetInstanceId: normalize.symbolInstanceId,
                type: 'CALLS',
                file: 'src/runtime.ts',
                span: { startLine: 2, endLine: 2 },
                confidence: 'high',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 2,
                edgeCount: 1,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [
                    { symbolId: 'legacy_sym_login', symbolLabel: login.label, file: 'src/runtime.ts', language: 'typescript', span: { startLine: 1, endLine: 3 } },
                    { symbolId: 'legacy_sym_normalize', symbolLabel: normalize.label, file: 'src/runtime.ts', language: 'typescript', span: { startLine: 5, endLine: 7 } },
                ],
                edges: [],
                notes: []
            }),
            queryGraph: () => {
                throw new Error('legacy call graph fallback should not run');
            }
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'legacy_sym_login',
                symbolLabel: login.label,
            },
            direction: 'callees',
            depth: 2,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.supported, false);
        assert.deepEqual(payload.nodes, []);
        assert.deepEqual(payload.edges, []);
    }));
});

test('handleCallGraph does not accept symbolKey as a steady-state exact input', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const login = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
        });
        const normalize = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'normalize',
            startLine: 5,
            endLine: 7,
            fileHash: 'hash-runtime',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [login, normalize],
            records: [{
                sourceKey: login.symbolKey,
                sourceInstanceId: login.symbolInstanceId,
                targetKey: normalize.symbolKey,
                targetInstanceId: normalize.symbolInstanceId,
                type: 'CALLS',
                file: 'src/runtime.ts',
                span: { startLine: 2, endLine: 2 },
                confidence: 'high',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: login.symbolKey,
                symbolLabel: login.label,
            },
            direction: 'callees',
            depth: 2,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.supported, false);
        assert.deepEqual(payload.nodes, []);
        assert.deepEqual(payload.edges, []);
    }));
});

test('handleCallGraph treats an optional symbol label as advisory to the exact symbol ID', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const login = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [login],
            records: [],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 2,
                edgeCount: 1,
                noteCount: 0,
                fingerprint: RUNTIME_FINGERPRINT
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [
                    { symbolId: 'legacy_sym_login', symbolLabel: login.label, file: 'src/runtime.ts', language: 'typescript', span: { startLine: 1, endLine: 3 } },
                    { symbolId: 'legacy_sym_helper', symbolLabel: 'function helper()', file: 'src/runtime.ts', language: 'typescript', span: { startLine: 5, endLine: 7 } },
                ],
                edges: [],
                notes: []
            }),
            queryGraph: () => {
                throw new Error('legacy call graph fallback should not run');
            },
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        for (const symbolLabel of [undefined, login.label, 'login', 'stale display label']) {
            const response = await handlers.handleCallGraph({
                path: repoPath,
                symbolRef: {
                    file: 'src/runtime.ts',
                    symbolId: login.symbolInstanceId,
                    ...(symbolLabel ? { symbolLabel } : {}),
                },
                direction: 'callees',
                depth: 2,
                limit: 20
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok', symbolLabel);
            assert.equal(payload.supported, true, symbolLabel);
            assert.deepEqual(payload.nodes.map((node: { symbolId: string }) => node.symbolId), [
                login.symbolInstanceId,
            ]);
            assert.equal(payload.edges.length, 0);
            assert.equal(typeof payload.sidecar?.builtAt, 'string');
            assert.equal(payload.sidecar?.nodeCount, 1);
            assert.equal(payload.sidecar?.edgeCount, 0);
            assert.deepEqual(payload.notes, []);
        }
    }));
});

test('handleCallGraph does not merge legacy notes or test references into relationship-backed results', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const login = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-runtime',
        });
        const normalize = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'normalize',
            startLine: 5,
            endLine: 7,
            fileHash: 'hash-runtime',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [login, normalize],
            records: [{
                sourceKey: login.symbolKey,
                sourceInstanceId: login.symbolInstanceId,
                targetKey: normalize.symbolKey,
                targetInstanceId: normalize.symbolInstanceId,
                type: 'CALLS',
                file: 'src/runtime.ts',
                span: { startLine: 2, endLine: 2 },
                confidence: 'high',
            }],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => ({
                version: 'v3',
                sidecarPath: '/tmp/sidecar.json',
                builtAt: '2026-01-01T00:00:00.000Z',
                nodeCount: 2,
                edgeCount: 1,
                noteCount: 1,
                fingerprint: RUNTIME_FINGERPRINT
            }),
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const callGraphManager = {
            loadSidecar: () => ({
                formatVersion: 'v3',
                codebasePath: repoPath,
                builtAt: '2026-01-01T00:00:00.000Z',
                fingerprint: RUNTIME_FINGERPRINT,
                nodes: [
                    { symbolId: 'legacy_sym_login', symbolLabel: login.label, file: 'src/runtime.ts', language: 'typescript', span: { startLine: 1, endLine: 3 } },
                    { symbolId: 'legacy_sym_normalize', symbolLabel: normalize.label, file: 'src/runtime.ts', language: 'typescript', span: { startLine: 5, endLine: 7 } },
                ],
                edges: [],
                notes: []
            }),
            queryGraph: () => {
                throw new Error('legacy call graph fallback should not run');
            },
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: login.symbolInstanceId,
                symbolLabel: login.label,
            },
            direction: 'callees',
            depth: 2,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.supported, true);
        assert.equal(payload.edges.length, 1);
        assert.deepEqual(payload.notes, []);
        assert.equal(payload.testReferences, undefined);
        assert.equal(payload.notesTruncated, false);
        assert.equal(payload.totalNoteCount, 0);
        assert.equal(payload.returnedNoteCount, 0);
        assert.equal(typeof payload.sidecar?.builtAt, 'string');
        assert.equal(payload.sidecar?.nodeCount, 2);
        assert.equal(payload.sidecar?.edgeCount, 1);
    }));
});

test('handleCallGraph includes import/export-backed cross-file CALLS v0 edges in relationship traversal', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const authContent = [
            'export function login(token: string) {',
            '  return token;',
            '}',
        ].join('\n');
        const routesContent = [
            'import { login } from "./auth";',
            'export function route(token: string) {',
            '  return login(token);',
            '}',
        ].join('\n');
        const authFile = createSynthesizedFileSymbol({
            relativePath: 'src/auth.ts',
            language: 'typescript',
            content: authContent,
            fileHash: 'hash-auth',
            extractorVersion: 'extractor-v1',
        });
        const routesFile = createSynthesizedFileSymbol({
            relativePath: 'src/routes.ts',
            language: 'typescript',
            content: routesContent,
            fileHash: 'hash-routes',
            extractorVersion: 'extractor-v1',
        });
        const login = createFunctionSymbol({
            file: 'src/auth.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'hash-auth',
        });
        const route = createFunctionSymbol({
            file: 'src/routes.ts',
            name: 'route',
            startLine: 2,
            endLine: 4,
            fileHash: 'hash-routes',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [authFile, login, routesFile, route],
            records: [
                {
                    sourceKey: routesFile.symbolKey,
                    sourceInstanceId: routesFile.symbolInstanceId,
                    targetKey: authFile.symbolKey,
                    targetInstanceId: authFile.symbolInstanceId,
                    targetPath: authFile.file,
                    type: 'IMPORTS',
                    file: 'src/routes.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: authFile.symbolKey,
                    sourceInstanceId: authFile.symbolInstanceId,
                    targetKey: login.symbolKey,
                    targetInstanceId: login.symbolInstanceId,
                    type: 'EXPORTS',
                    file: 'src/auth.ts',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: route.symbolKey,
                    sourceInstanceId: route.symbolInstanceId,
                    targetKey: login.symbolKey,
                    targetInstanceId: login.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/routes.ts',
                    span: { startLine: 3, endLine: 3 },
                    confidence: 'low',
                },
            ],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const callGraphManager = {
            queryGraph: () => {
                throw new Error('legacy call graph fallback should not run');
            }
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/routes.ts',
                symbolId: route.symbolInstanceId,
                symbolLabel: route.label,
            },
            direction: 'callees',
            depth: 2,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.supported, true);
        assert.deepEqual(payload.nodes.map((node: { symbolId: string }) => node.symbolId), [
            login.symbolInstanceId,
            route.symbolInstanceId,
        ]);
        assert.equal(payload.edges.length, 1);
        assert.equal(payload.edges[0].srcSymbolId, route.symbolInstanceId);
        assert.equal(payload.edges[0].dstSymbolId, login.symbolInstanceId);
        assert.equal(payload.edges[0].confidence, 0.65);
    }));
});

test('handleCallGraph includes Python relative-import-backed cross-file CALLS v0 edges in relationship traversal', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const telemetryContent = [
            'def build_entry_telemetry():',
            '    return None',
        ].join('\n');
        const phasesContent = [
            'from .telemetry import build_entry_telemetry',
            '',
            'def _attach_entry_telemetry():',
            '    return build_entry_telemetry()',
        ].join('\n');
        const telemetryFile = createSynthesizedFileSymbol({
            relativePath: 'src/telemetry.py',
            language: 'python',
            content: telemetryContent,
            fileHash: 'hash-telemetry',
            extractorVersion: 'extractor-v1',
        });
        const phasesFile = createSynthesizedFileSymbol({
            relativePath: 'src/phases.py',
            language: 'python',
            content: phasesContent,
            fileHash: 'hash-phases',
            extractorVersion: 'extractor-v1',
        });
        const buildEntryTelemetry = createFunctionSymbol({
            file: 'src/telemetry.py',
            name: 'build_entry_telemetry',
            startLine: 1,
            endLine: 2,
            fileHash: 'hash-telemetry',
            language: 'python',
        });
        const attachEntryTelemetry = createFunctionSymbol({
            file: 'src/phases.py',
            name: '_attach_entry_telemetry',
            startLine: 3,
            endLine: 4,
            fileHash: 'hash-phases',
            language: 'python',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [phasesFile, attachEntryTelemetry, telemetryFile, buildEntryTelemetry],
            records: [
                {
                    sourceKey: phasesFile.symbolKey,
                    sourceInstanceId: phasesFile.symbolInstanceId,
                    targetKey: telemetryFile.symbolKey,
                    targetInstanceId: telemetryFile.symbolInstanceId,
                    targetPath: telemetryFile.file,
                    type: 'IMPORTS',
                    file: 'src/phases.py',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: phasesFile.symbolKey,
                    sourceInstanceId: phasesFile.symbolInstanceId,
                    targetKey: attachEntryTelemetry.symbolKey,
                    targetInstanceId: attachEntryTelemetry.symbolInstanceId,
                    type: 'EXPORTS',
                    file: 'src/phases.py',
                    span: { startLine: 3, endLine: 3 },
                    confidence: 'high',
                },
                {
                    sourceKey: telemetryFile.symbolKey,
                    sourceInstanceId: telemetryFile.symbolInstanceId,
                    targetKey: buildEntryTelemetry.symbolKey,
                    targetInstanceId: buildEntryTelemetry.symbolInstanceId,
                    type: 'EXPORTS',
                    file: 'src/telemetry.py',
                    span: { startLine: 1, endLine: 1 },
                    confidence: 'high',
                },
                {
                    sourceKey: attachEntryTelemetry.symbolKey,
                    sourceInstanceId: attachEntryTelemetry.symbolInstanceId,
                    targetKey: buildEntryTelemetry.symbolKey,
                    targetInstanceId: buildEntryTelemetry.symbolInstanceId,
                    type: 'CALLS',
                    file: 'src/phases.py',
                    span: { startLine: 4, endLine: 4 },
                    confidence: 'low',
                },
            ],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const callGraphManager = {
            queryGraph: () => {
                throw new Error('legacy call graph fallback should not run');
            }
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        const calleesResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/phases.py',
                symbolId: attachEntryTelemetry.symbolInstanceId,
                symbolLabel: attachEntryTelemetry.label,
            },
            direction: 'callees',
            depth: 1,
            limit: 20
        });

        const calleesPayload = JSON.parse(calleesResponse.content[0]?.text || '{}');
        assert.equal(calleesPayload.status, 'ok');
        assert.equal(calleesPayload.edges.length, 1);
        assert.equal(calleesPayload.edges[0].kind, 'call');
        assert.equal(calleesPayload.edges[0].srcSymbolId, attachEntryTelemetry.symbolInstanceId);
        assert.equal(calleesPayload.edges[0].dstSymbolId, buildEntryTelemetry.symbolInstanceId);
        assert.equal(calleesPayload.edges[0].site.startLine, 4);
        assert.equal(calleesPayload.edges[0].confidence, 0.65);
        assert.ok(!calleesPayload.warnings?.includes('RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1'));
        assert.ok(!calleesPayload.warnings?.includes('SOURCE_BACKED_DYNAMIC_CALLEES:1'));
        assert.ok(!calleesPayload.notes.some((note: CallGraphNoteView) => note.type === 'suppressed_edge'));

        const callersResponse = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/telemetry.py',
                symbolId: buildEntryTelemetry.symbolInstanceId,
                symbolLabel: buildEntryTelemetry.label,
            },
            direction: 'callers',
            depth: 1,
            limit: 20
        });

        const callersPayload = JSON.parse(callersResponse.content[0]?.text || '{}');
        assert.equal(callersPayload.status, 'ok');
        assert.equal(callersPayload.edges.length, 1);
        assert.equal(callersPayload.edges[0].kind, 'call');
        assert.equal(callersPayload.edges[0].srcSymbolId, attachEntryTelemetry.symbolInstanceId);
        assert.equal(callersPayload.edges[0].dstSymbolId, buildEntryTelemetry.symbolInstanceId);
        assert.equal(callersPayload.edges[0].site.startLine, 4);
        assert.equal(callersPayload.edges[0].confidence, 0.65);
        assert.ok(!callersPayload.warnings?.includes('RELATIONSHIP_LOW_CONFIDENCE_SKIPPED:1'));
        assert.ok(!callersPayload.notes.some((note: CallGraphNoteView) => note.type === 'suppressed_edge'));
    }));
});

test('handleCallGraph maps missing_symbol to status not_found', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const login = createFunctionSymbol({
            file: 'src/runtime.ts',
            name: 'login',
            startLine: 1,
            endLine: 3,
            fileHash: 'runtime-hash',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [login],
            records: [],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({ outcome: 'valid' });

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_missing'
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.supported, false);
        assert.equal(payload.reason, 'missing_symbol');
    }));
});

test('handleCallGraph maps unsupported_language to status unsupported', async () => {
    await withTempStateRoot(async (stateRoot) => withTempRepo(async (repoPath) => {
        const docsPath = path.join(repoPath, 'docs');
        fs.mkdirSync(docsPath, { recursive: true });
        fs.writeFileSync(path.join(docsPath, 'readme.md'), '# docs\n', 'utf8');

        const docSymbol = createSynthesizedFileSymbol({
            relativePath: 'docs/readme.md',
            language: 'markdown',
            fileHash: 'docs-hash',
            extractorVersion: 'extractor-v1',
            content: '# docs\n',
        });
        await writeTestNavigation({
            stateRoot,
            repoPath,
            symbols: [docSymbol],
            records: [],
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [repoPath],
            getCodebaseInfo: () => undefined,
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => []
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => ({ outcome: 'valid' });

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'docs/readme.md',
                symbolId: docSymbol.symbolInstanceId
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'unsupported');
        assert.equal(payload.supported, false);
        assert.equal(payload.reason, 'unsupported_language');
    }));
});

test('handleCallGraph returns not_ready envelope when codebase is indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;

        const snapshotManager = {
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [repoPath],
            getCodebaseInfo: () => ({
                status: 'indexing',
                indexingPercentage: 79,
                lastUpdated: '2026-02-27T23:57:03.000Z'
            }),
            getCodebaseStatus: () => 'indexing',
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => [{
                path: repoPath,
                info: {
                    status: 'indexing',
                    indexingPercentage: 79,
                    lastUpdated: '2026-02-27T23:57:03.000Z'
                }
            }]
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run'
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'indexing');
        assert.equal(payload.codebaseRoot, repoPath);
        assert.equal(payload.indexing.progressPct, 79);
        assert.equal(payload.indexing.lastUpdated, '2026-02-27T23:57:03.000Z');
        assert.equal(payload.hints.status.tool, 'manage_index');
        assert.equal(payload.hints.status.args.action, 'status');
        assert.equal(payload.hints.status.args.path, repoPath);
    });
});

test('handleCallGraph failed-index payload preserves failure diagnostics', async () => {
    await withTempRepo(async (repoPath) => {
        const failedInfo = {
            status: 'indexfailed',
            errorMessage: 'Interrupted indexing detected without completion marker proof.',
            lastAttemptedPercentage: 0,
            lastUpdated: '2026-06-19T12:15:18.574Z'
        };
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as unknown as HandlerContext;
        const snapshotManager = {
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => failedInfo,
            getCodebaseStatus: () => 'indexfailed',
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => [{ path: repoPath, info: failedInfo }]
        } as unknown as HandlerSnapshotManager;

        const handlers = new ToolHandlers(context, snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run'
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.supported, false);
        assert.equal(payload.reason, 'index_failed');
        assert.equal(payload.codebaseRoot, repoPath);
        assert.match(payload.message, /Interrupted indexing detected without completion marker proof/i);
        assert.match(payload.message, /0\.0%/);
        assert.equal(payload.indexingFailure?.errorMessage, failedInfo.errorMessage);
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
    });
});
