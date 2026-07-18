import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
    writeNavigationSidecarGeneration,
    writeRelationshipSidecar,
    writeSymbolRegistrySidecar,
} from '@zokizuan/satori-core';
import type { SymbolRecord, SymbolRegistryManifest } from '@zokizuan/satori-core';
import { ToolHandlers } from './handlers.js';
import { buildRegistryFileOutlinePayload } from './registry-file-outline.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';

type HandlerContext = ConstructorParameters<typeof ToolHandlers>[0];
type HandlerSnapshotManager = ConstructorParameters<typeof ToolHandlers>[1];
type HandlerSyncManager = ConstructorParameters<typeof ToolHandlers>[2];
type HandlerCallGraphManager = NonNullable<ConstructorParameters<typeof ToolHandlers>[6]>;
type HandlerNavigationStore = NonNullable<ConstructorParameters<typeof ToolHandlers>[9]>;
type ToolHandlersTestOverrides = {
    validateCompletionProof: (codebasePath: string) => Promise<unknown>;
};
type SnapshotStub = Record<string, unknown>;

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

function baseContext(): HandlerContext {
    return {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getVectorStore: () => ({ listCollections: async () => [] })
    } as unknown as HandlerContext;
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
    parentQualifiedNamePath?: string[];
}): SymbolRecord {
    const fileHash = input.fileHash || 'hash_runtime';
    const language = input.language || 'typescript';
    const kind = input.kind || 'function';
    const parentQualifiedNamePath = input.parentQualifiedNamePath || [];
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

async function writeTestSymbolRegistry(
    repoPath: string,
    symbols: SymbolRecord[],
    options: { generation?: boolean } = {},
) {
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
    const analysisByFile = new Map(manifest.files.map((file) => [file.path, {
        moduleBindings: [],
        callSites: [],
    }]));
    if (options.generation) {
        const result = await writeNavigationSidecarGeneration({
            registry,
            records: [],
            analysisByFile,
        });
        return { registry, result };
    }
    const result = await writeSymbolRegistrySidecar({ registry });
    await writeRelationshipSidecar({
        normalizedRootPath: repoPath,
        symbolRegistryManifestHash: result.manifestHash,
        relationshipVersion: manifest.relationshipVersion,
        builtAt: manifest.builtAt,
        files: manifest.files,
        records: [],
        analysisByFile,
    });
    return { registry, result };
}

function baseSnapshotManager(repoPath: string): SnapshotStub {
    return {
        getIndexedCodebases: () => [repoPath],
        getCodebaseInfo: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined,
        getAllCodebases: () => []
    };
}

function sha256Content(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

test('handleFileOutline returns requires_reindex when sidecar metadata is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.reason, 'missing_symbol_registry');
        assert.equal(payload.file, 'src/runtime.ts');
        assert.equal(payload.hints.reindex.args.path, repoPath);
    });
});

test('handleFileOutline allows source-backed navigation under runtime fingerprint mismatch', async () => {
    await withTempRepo(async (repoPath) => {
        const fileHash = crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(repoPath, 'src', 'runtime.ts')))
            .digest('hex');
        const symbol = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function run()',
            name: 'run',
            qualifiedName: 'src.runtime.run',
            startLine: 1,
            endLine: 1,
            fileHash,
        });

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
            }),
            getCompatibilityState: async () => ({
                relationships: {
                    status: 'ok',
                    manifest: { builtAt: new Date('2026-01-01T00:00:00.000Z').toISOString() },
                },
            }),
        } as unknown as HandlerNavigationStore;

        const handlers = new ToolHandlers(
            baseContext(),
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

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'outline',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.file, 'src/runtime.ts');
        assert.equal(payload.outline.symbols[0]?.symbolId, symbol.symbolInstanceId);
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        for (const file of ['src/service.go', 'src/stack.rs']) {
            const response = await handlers.handleFileOutline({ path: repoPath, file });
            const payload = JSON.parse(response.content[0]?.text || '{}');

            assert.equal(payload.status, 'requires_reindex');
            assert.equal(payload.reason, 'missing_symbol_registry');
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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

test('handleFileOutline failed-index payload preserves failure diagnostics', async () => {
    await withTempRepo(async (repoPath) => {
        const failedInfo = {
            status: 'indexfailed',
            errorMessage: 'Interrupted indexing detected without completion marker proof.',
            lastAttemptedPercentage: 0,
            lastUpdated: '2026-06-19T12:15:18.574Z'
        };
        const snapshotManager = {
            getAllCodebases: () => [{ path: repoPath, info: failedInfo }],
            getIndexedCodebases: () => [],
            getIndexingCodebases: () => [],
            getCodebaseInfo: () => failedInfo,
            getCodebaseStatus: () => 'indexfailed',
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'index_failed');
        assert.equal(payload.codebaseRoot, repoPath);
        assert.equal(payload.file, 'src/runtime.ts');
        assert.match(payload.message, /Interrupted indexing detected without completion marker proof/i);
        assert.match(payload.message, /0\.0%/);
        assert.equal(payload.indexingFailure?.errorMessage, failedInfo.errorMessage);
        assert.deepEqual(payload.hints?.create?.args, { action: 'create', path: repoPath });
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
        } as unknown as HandlerSnapshotManager;
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
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );

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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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

test('handleFileOutline reuses navigation evidence only within the same marker generation', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const symbol = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function run()',
            name: 'run',
            qualifiedName: 'run',
            startLine: 1,
            endLine: 1,
        });
        const { result: registryResult } = await writeTestSymbolRegistry(repoPath, [symbol], { generation: true });

        const vectorReceipt = { collectionName: 'generation-1' } as never;
        let markerRunId = 'run-1';
        const createGenerationReceipt = () => ({
            collectionName: 'generation-1',
            marker: { runId: markerRunId },
            policy: {
                canonicalRoot: repoPath,
                policyHash: 'policy-hash-1',
            },
            policyDocumentDigest: '1'.repeat(64),
            exactPayloadCount: 1,
            navigation: {
                generationId: registryResult.generationId,
                generationRoot: path.join(
                    resolveNavigationSidecarRoot(undefined, repoPath),
                    'generations',
                    registryResult.generationId,
                ),
                symbolRegistryManifestHash: registryResult.manifestHash,
                relationshipManifestHash: registryResult.relationshipManifestHash,
                navigationSealHash: registryResult.navigationSealHash,
            },
            observations: {
                profileFileToken: null,
                policyFileToken: 'policy-token-1',
                navigationToken: 'navigation-token-1',
            },
        }) as never;
        let coldCompletionProofs = 0;
        let warmReceiptRevalidations = 0;
        let registryLoads = 0;
        let navigationValidationRuns = 0;
        const backingNavigationStore = new RuntimeNavigationStore();
        const navigationStore = {
            getSymbolsByFile: async (...args: Parameters<HandlerNavigationStore['getSymbolsByFile']>) => {
                registryLoads += 1;
                return backingNavigationStore.getSymbolsByFile(...args);
            },
            getCompatibilityState: async (...args: Parameters<HandlerNavigationStore['getCompatibilityState']>) => {
                navigationValidationRuns += 1;
                return backingNavigationStore.getCompatibilityState(...args);
            },
        } as unknown as HandlerNavigationStore;
        const context = {
            ...baseContext(),
            getIndexAuthorityObservations: () => ({
                vector: 'vector-authority-1',
                navigation: 'navigation-authority-1',
            }),
            revalidatePreparedGeneration: async () => {
                warmReceiptRevalidations += 1;
                return {
                    vectorReceipt,
                    navigationProof: { status: 'valid' as const },
                    generationReceipt: createGenerationReceipt(),
                };
            },
        } as unknown as HandlerContext;
        const syncManager = {
            getPreparedReadObservation: () => ({
                available: false as const,
                reason: 'watcher_manager_not_started' as const,
                freshnessEpoch: 1,
            }),
        } as unknown as HandlerSyncManager;
        const mutationLeaseCoordinator = {
            observe: () => ({ mutationActive: false, generation: 1 }),
            getActiveLease: () => null,
        };
        const handlers = new ToolHandlers(
            context,
            baseSnapshotManager(repoPath) as unknown as HandlerSnapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            navigationStore,
            null,
            mutationLeaseCoordinator as never,
        );
        (handlers as unknown as ToolHandlersTestOverrides).validateCompletionProof = async () => {
            coldCompletionProofs += 1;
            return {
                outcome: 'valid',
                collectionName: 'generation-1',
                navigationStatus: 'valid',
                vectorReceipt,
                generationReceipt: createGenerationReceipt(),
            };
        };

        const firstResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
        });
        const secondResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
        });

        markerRunId = 'run-2';
        const thirdResponse = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
        });

        assert.equal(JSON.parse(firstResponse.content[0]?.text || '{}').status, 'ok');
        assert.equal(JSON.parse(secondResponse.content[0]?.text || '{}').status, 'ok');
        assert.equal(JSON.parse(thirdResponse.content[0]?.text || '{}').status, 'ok');
        assert.equal(coldCompletionProofs, 1);
        assert.equal(warmReceiptRevalidations, 2);
        assert.equal(registryLoads, 2);
        assert.equal(navigationValidationRuns, 2);
    }));
});

test('handleFileOutline repairs stale Python multiline-signature spans from source without reindex', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
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
        const attach = createTestSymbol({
            file: 'src/phases.py',
            label: 'function _attach_entry_telemetry(',
            name: '_attach_entry_telemetry',
            qualifiedName: '_attach_entry_telemetry',
            startLine: 2,
            endLine: 9,
            fileHash,
            language: 'python',
            kind: 'function',
        });
        const build = createTestSymbol({
            file: 'src/phases.py',
            label: 'function build_entry_telemetry(',
            name: 'build_entry_telemetry',
            qualifiedName: 'build_entry_telemetry',
            startLine: 17,
            endLine: 18,
            fileHash,
            language: 'python',
            kind: 'function',
        });
        const { registry, result } = await writeTestSymbolRegistry(repoPath, [attach, build]);
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/phases.py',
            resolveMode: 'exact',
            symbolIdExact: attach.symbolInstanceId,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols.length, 1);
        assert.deepEqual({
            startLine: payload.outline.symbols[0].span.startLine,
            endLine: payload.outline.symbols[0].span.endLine,
        }, { startLine: 4, endLine: 15 });
        assert.deepEqual(payload.outline.symbols[0].callGraphHint.symbolRef.span, { startLine: 4, endLine: 15 });
        assert.equal(payload.outline.symbols[0].callGraphHint.symbolRef.symbolId, attach.symbolInstanceId);
        assert.ok(payload.warnings.includes('OUTLINE_SPAN_START_BEFORE_DEF'));
        assert.ok(payload.warnings.includes('OUTLINE_TRUNCATED_SYMBOL_SPAN'));
    }));
});

test('handleFileOutline exact mode repairs stale TypeScript spans from current source', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const source = [
            'const before = true;',
            '',
            'export function currentOwner(value: string) {',
            '    const normalized = value.trim();',
            '    return normalized;',
            '}',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), source);
        const owner = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function currentOwner(value: string)',
            name: 'currentOwner',
            qualifiedName: 'currentOwner',
            startLine: 1,
            endLine: 4,
            fileHash: sha256Content(source),
        });
        await writeTestSymbolRegistry(repoPath, [owner]);

        const handlers = new ToolHandlers(
            baseContext(),
            baseSnapshotManager(repoPath) as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );
        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: owner.symbolInstanceId,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols[0].symbolId, owner.symbolInstanceId);
        assert.deepEqual({
            startLine: payload.outline.symbols[0].span.startLine,
            endLine: payload.outline.symbols[0].span.endLine,
        }, { startLine: 3, endLine: 6 });
        assert.deepEqual(payload.outline.symbols[0].callGraphHint.symbolRef.span, { startLine: 3, endLine: 6 });
    }));
});

test('handleFileOutline exact mode repairs stale JavaScript spans from current source', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const source = [
            'const before = true;',
            '',
            'export function currentOwner(value) {',
            '    return value.trim();',
            '}',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.js'), source);
        const owner = createTestSymbol({
            file: 'src/runtime.js',
            label: 'function currentOwner(value)',
            name: 'currentOwner',
            qualifiedName: 'currentOwner',
            startLine: 1,
            endLine: 3,
            fileHash: sha256Content(source),
            language: 'javascript',
        });
        await writeTestSymbolRegistry(repoPath, [owner]);

        const handlers = new ToolHandlers(
            baseContext(),
            baseSnapshotManager(repoPath) as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );
        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.js',
            resolveMode: 'exact',
            symbolIdExact: owner.symbolInstanceId,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols[0].symbolId, owner.symbolInstanceId);
        assert.deepEqual({
            startLine: payload.outline.symbols[0].span.startLine,
            endLine: payload.outline.symbols[0].span.endLine,
        }, { startLine: 3, endLine: 5 });
    }));
});

test('handleFileOutline exact mode fails closed when the persisted symbol is absent from current source', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const source = 'export function replacementOwner() { return true; }\n';
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), source);
        const removed = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function removedOwner()',
            name: 'removedOwner',
            qualifiedName: 'removedOwner',
            startLine: 1,
            endLine: 1,
            fileHash: sha256Content(source),
        });
        await writeTestSymbolRegistry(repoPath, [removed]);

        const handlers = new ToolHandlers(
            baseContext(),
            baseSnapshotManager(repoPath) as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );
        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: removed.symbolInstanceId,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.reason, 'missing_symbol');
        assert.equal(payload.outline, null);
    }));
});

test('handleFileOutline exact mode preserves ambiguous current-source validation', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const currentSource = [
            'export function duplicateOwner() { return true; }',
            'export function duplicateOwner() { return false; }',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), currentSource);
        const owner = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function duplicateOwner()',
            name: 'duplicateOwner',
            qualifiedName: 'duplicateOwner',
            startLine: 1,
            endLine: 1,
            fileHash: sha256Content(currentSource),
        });
        await writeTestSymbolRegistry(repoPath, [owner]);

        const handlers = new ToolHandlers(
            baseContext(),
            baseSnapshotManager(repoPath) as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );
        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: owner.symbolInstanceId,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ambiguous');
        assert.equal(payload.outline, null);
        assert.match(payload.message, /current source|ambiguous/i);
    }));
});

test('handleFileOutline exact symbol id validates its full duplicate-key cohort before selecting', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const source = [
            'function duplicateOwner() { return 1; }',
            '',
            'function duplicateOwner() { return 2; }',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), source);
        const fileHash = sha256Content(source);
        const first = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function duplicateOwner()',
            name: 'duplicateOwner',
            qualifiedName: 'duplicateOwner',
            startLine: 10,
            endLine: 10,
            fileHash,
        });
        const second = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function duplicateOwner()',
            name: 'duplicateOwner',
            qualifiedName: 'duplicateOwner',
            startLine: 20,
            endLine: 20,
            fileHash,
        });
        await writeTestSymbolRegistry(repoPath, [first, second]);

        const handlers = new ToolHandlers(
            baseContext(),
            baseSnapshotManager(repoPath) as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );
        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: second.symbolInstanceId,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.outline.symbols[0].symbolId, second.symbolInstanceId);
        assert.deepEqual({
            startLine: payload.outline.symbols[0].span.startLine,
            endLine: payload.outline.symbols[0].span.endLine,
        }, { startLine: 3, endLine: 3 });
    }));
});

test('handleFileOutline exact symbol id rejects duplicate ordinal pairing without current file proof', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const source = [
            'function duplicateOwner() { return 1; }',
            '',
            'function duplicateOwner() { return 2; }',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), source);
        const first = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function duplicateOwner()',
            name: 'duplicateOwner',
            qualifiedName: 'duplicateOwner',
            startLine: 10,
            endLine: 10,
            fileHash: 'stale-file-hash',
        });
        const second = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function duplicateOwner()',
            name: 'duplicateOwner',
            qualifiedName: 'duplicateOwner',
            startLine: 20,
            endLine: 20,
            fileHash: 'stale-file-hash',
        });
        await writeTestSymbolRegistry(repoPath, [first, second]);

        const handlers = new ToolHandlers(
            baseContext(),
            baseSnapshotManager(repoPath) as unknown as HandlerSnapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
        );
        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts',
            resolveMode: 'exact',
            symbolIdExact: second.symbolInstanceId,
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ambiguous');
        assert.equal(payload.outline, null);
    }));
});

test('handleFileOutline exact mode reports unverified current-source validation', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const source = 'export function unavailableOwner() { return true; }\n';
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), source);
        const owner = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function unavailableOwner()',
            name: 'unavailableOwner',
            qualifiedName: 'unavailableOwner',
            startLine: 1,
            endLine: 1,
            fileHash: sha256Content(source),
        });
        fs.rmSync(path.join(repoPath, 'src', 'runtime.ts'));

        const payload = await buildRegistryFileOutlinePayload({
            codebaseRoot: repoPath,
            file: 'src/runtime.ts',
            symbols: [owner],
            limitSymbols: 20,
            resolveMode: 'exact',
            symbolIdExact: owner.symbolInstanceId,
            buildCallGraphHint: () => ({ supported: false, reason: 'missing_relationship_sidecar' }),
            buildOutlineSpanWarningCodes: () => [],
        });
        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, undefined);
        assert.equal(payload.warnings?.includes('OUTLINE_SYMBOL_SPAN_UNVERIFIED'), true);
        assert.match(payload.message, /could not be verified/i);
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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

test('handleFileOutline exactly resolves Java, C#, C++, and Scala symbols without enabling call_graph', async () => {
    const fixtures = [
        {
            language: 'java',
            file: 'src/Service.java',
            source: 'class Service {\n  int run() {\n    return 1;\n  }\n}\n',
            label: 'method run',
            name: 'run',
            qualifiedName: 'Service.run',
            kind: 'method',
            startLine: 2,
            endLine: 4,
            parentQualifiedNamePath: ['Service'],
        },
        {
            language: 'csharp',
            file: 'src/Service.cs',
            source: 'class Service {\n  int Run() {\n    return 1;\n  }\n}\n',
            label: 'method Run',
            name: 'Run',
            qualifiedName: 'Service.Run',
            kind: 'method',
            startLine: 2,
            endLine: 4,
            parentQualifiedNamePath: ['Service'],
        },
        {
            language: 'cpp',
            file: 'src/service.cpp',
            source: 'class Service {\n};\nint run() {\n  return 1;\n}\n',
            label: 'function run',
            name: 'run',
            qualifiedName: 'run',
            kind: 'function',
            startLine: 3,
            endLine: 5,
            parentQualifiedNamePath: [],
        },
        {
            language: 'scala',
            file: 'src/Service.scala',
            source: 'class Service {\n  def run(): Int = {\n    1\n  }\n}\n',
            label: 'method run',
            name: 'run',
            qualifiedName: 'Service.run',
            kind: 'method',
            startLine: 2,
            endLine: 4,
            parentQualifiedNamePath: ['Service'],
        },
    ] as const;

    await withTempStateRoot(async () => {
        for (const fixture of fixtures) {
            await withTempRepo(async (repoPath) => {
                const absoluteFile = path.join(repoPath, fixture.file);
                fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
                fs.writeFileSync(absoluteFile, fixture.source);
                const symbol = createTestSymbol({
                    file: fixture.file,
                    label: fixture.label,
                    name: fixture.name,
                    qualifiedName: fixture.qualifiedName,
                    startLine: fixture.startLine,
                    endLine: fixture.endLine,
                    language: fixture.language,
                    kind: fixture.kind,
                    parentQualifiedNamePath: fixture.parentQualifiedNamePath,
                });
                await writeTestSymbolRegistry(repoPath, [symbol]);

                const handlers = new ToolHandlers(
                    baseContext(),
                    baseSnapshotManager(repoPath),
                    {} as unknown as HandlerSyncManager,
                    RUNTIME_FINGERPRINT,
                    CAPABILITIES,
                );
                const response = await handlers.handleFileOutline({
                    path: repoPath,
                    file: fixture.file,
                    resolveMode: 'exact',
                    symbolIdExact: symbol.symbolInstanceId,
                });
                const payload = JSON.parse(response.content[0]?.text || '{}');

                assert.equal(payload.status, 'ok', fixture.language);
                assert.equal(payload.outline.symbols.length, 1, fixture.language);
                assert.equal(payload.outline.symbols[0].symbolId, symbol.symbolInstanceId, fixture.language);
                assert.deepEqual({
                    startLine: payload.outline.symbols[0].span.startLine,
                    endLine: payload.outline.symbols[0].span.endLine,
                }, {
                    startLine: fixture.startLine,
                    endLine: fixture.endLine,
                }, fixture.language);
                assert.equal(payload.outline.symbols[0].callGraphHint.supported, false, fixture.language);
                assert.equal(payload.outline.symbols[0].callGraphHint.reason, 'unsupported_language', fixture.language);
            });
        }
    });
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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

test('handleFileOutline explicit sqlite backend does not serve navigation after JSON sidecars are removed', async () => {
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            new RuntimeNavigationStore({ servingBackend: 'sqlite' })
        );

        const warnings: string[] = [];
        const previousWarn = console.warn;
        console.warn = (message?: unknown, ...args: unknown[]) => {
            warnings.push([message, ...args].map((entry) => String(entry)).join(' '));
        };
        try {
            const outlineResponse = await handlers.handleFileOutline({
                path: repoPath,
                file: 'src/runtime.ts'
            });

            const outlinePayload = JSON.parse(outlineResponse.content[0]?.text || '{}');
            assert.equal(outlinePayload.status, 'requires_reindex');
            assert.equal(outlinePayload.outline, null);
            assert.match(outlinePayload.message, /symbol registry manifest is missing/);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0] || '', /SQLite backend fallback to JSON/);
            assert.match(warnings[0] || '', /canonical JSON registry is unavailable/);

            const callGraphResponse = await handlers.handleCallGraph({
                path: repoPath,
                symbolRef: {
                    file: 'src/runtime.ts',
                    symbolId: alpha.symbolInstanceId,
                    symbolLabel: alpha.symbolLabel,
                },
                direction: 'callees',
                depth: 2,
                limit: 20,
            });

            const callGraphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
            assert.equal(callGraphPayload.status, 'requires_reindex');
            assert.equal(callGraphPayload.supported, false);
            assert.match(callGraphPayload.message, /symbol registry manifest is missing/);
        } finally {
            console.warn = previousWarn;
        }
    }));
});

test('handleFileOutline env-selected sqlite backend does not serve navigation after JSON sidecars are removed', async () => {
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
            } as unknown as HandlerSnapshotManager;
            const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

            const warnings: string[] = [];
            const previousWarn = console.warn;
            console.warn = (message?: unknown, ...args: unknown[]) => {
                warnings.push([message, ...args].map((entry) => String(entry)).join(' '));
            };
            try {
                const outlineResponse = await handlers.handleFileOutline({
                    path: repoPath,
                    file: 'src/runtime.ts'
                });

                const outlinePayload = JSON.parse(outlineResponse.content[0]?.text || '{}');
                assert.equal(outlinePayload.status, 'requires_reindex');
                assert.equal(outlinePayload.outline, null);
                assert.match(outlinePayload.message, /symbol registry manifest is missing/);
                assert.equal(warnings.length, 1);
                assert.match(warnings[0] || '', /SQLite backend fallback to JSON/);
                assert.match(warnings[0] || '', /canonical JSON registry is unavailable/);

                const callGraphResponse = await handlers.handleCallGraph({
                    path: repoPath,
                    symbolRef: {
                        file: 'src/runtime.ts',
                        symbolId: alpha.symbolInstanceId,
                        symbolLabel: alpha.symbolLabel,
                    },
                    direction: 'callees',
                    depth: 2,
                    limit: 20,
                });

                const callGraphPayload = JSON.parse(callGraphResponse.content[0]?.text || '{}');
                assert.equal(callGraphPayload.status, 'requires_reindex');
                assert.equal(callGraphPayload.supported, false);
                assert.match(callGraphPayload.message, /symbol registry manifest is missing/);
            } finally {
                console.warn = previousWarn;
            }
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            undefined,
            undefined,
            undefined,
            undefined,
            fakeNavigationStore as unknown as HandlerNavigationStore
        );

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
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), [
            'const before = true;',
            '',
            '',
            'function alpha() { return true; }',
            '',
            '',
            '',
            '',
            '',
            'function beta() {',
            '    return true;',
            '}',
            '',
        ].join('\n'));
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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        assert.equal(payload.outline.symbols[0].symbolKey, beta.symbolKey);
        assert.equal(payload.outline.symbols[0].name, 'beta');
        assert.equal(payload.outline.symbols[0].qualifiedName, 'beta');
        assert.equal(payload.outline.symbols[0].symbolLabel, 'function beta()');
        assert.equal(payload.outline.symbols[0].kind, 'function');
        assert.equal(payload.outline.symbols[0].language, 'typescript');
        assert.equal(payload.outline.symbols[0].file, 'src/runtime.ts');
        assert.deepEqual(payload.outline.symbols[0].parentQualifiedNamePath, []);
        assert.equal(payload.outline.symbols[0].parentResolution, 'not_applicable');
    }));
});

test('handleFileOutline registry exact mode returns ambiguous for duplicate exact labels', async () => {
    await withTempStateRoot(async () => withTempRepo(async (repoPath) => {
        const source = [
            '',
            '',
            '',
            'function same() { return 1; }',
            '',
            '',
            '',
            '',
            '',
            'function same() {',
            '    return 2;',
            '}',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), source);
        const fileHash = sha256Content(source);
        const first = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function same()',
            name: 'same',
            qualifiedName: 'same',
            startLine: 4,
            endLine: 7,
            fileHash,
        });
        const second = createTestSymbol({
            file: 'src/runtime.ts',
            label: 'function same()',
            name: 'same',
            qualifiedName: 'same',
            startLine: 10,
            endLine: 13,
            fileHash,
        });
        await writeTestSymbolRegistry(repoPath, [second, first]);

        const snapshotManager = {
            ...baseSnapshotManager(repoPath),
            getCodebaseCallGraphSidecar: () => undefined,
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        } as unknown as HandlerSnapshotManager;
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
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );

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
        } as unknown as HandlerSnapshotManager;
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
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );

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
        } as unknown as HandlerSnapshotManager;
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES);

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
        } as unknown as HandlerSnapshotManager;
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
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(
            baseContext(),
            snapshotManager,
            {} as unknown as HandlerSyncManager,
            RUNTIME_FINGERPRINT,
            CAPABILITIES,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            callGraphManager
        );

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
        } as unknown as HandlerSnapshotManager;
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
        } as unknown as HandlerCallGraphManager;

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as unknown as HandlerSyncManager, RUNTIME_FINGERPRINT, CAPABILITIES, undefined, callGraphManager);

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/missing.ts',
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_found');
        assert.equal(payload.outline, null);
    });
});
