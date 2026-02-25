import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { IndexFingerprint } from '../config.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-call-graph-handler-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), 'export function run() { return true; }\n');
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function createHandlers(repoPath: string) {
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getVectorStore: () => ({ listCollections: async () => [] })
    } as any;

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
    } as any;

    const syncManager = {} as any;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT);
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
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

test('handleCallGraph returns requires_reindex when snapshot marks codebase blocked but not indexed', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as any;

        const snapshotManager = {
            getIndexedCodebases: () => [],
            getCodebaseInfo: () => undefined,
            getCodebaseStatus: () => 'requires_reindex',
            getCodebaseCallGraphSidecar: () => undefined,
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: true,
                changed: false
            }),
            saveCodebaseSnapshot: () => undefined,
            getAllCodebases: () => [{
                path: repoPath,
                info: {
                    status: 'requires_reindex',
                    message: 'Legacy v2 index detected.',
                    lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString()
                }
            }]
        } as any;

        const syncManager = {} as any;
        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

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

test('handleCallGraph returns status ok for v3-compatible indexed call graph query', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as any;

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
        } as any;

        const syncManager = {} as any;
        const callGraphManager = {
            queryGraph: () => ({
                supported: true,
                direction: 'both',
                depth: 1,
                limit: 20,
                nodes: [],
                edges: [],
                notes: [],
                sidecar: {
                    builtAt: '2026-01-01T00:00:00.000Z',
                    nodeCount: 1,
                    edgeCount: 0
                }
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, undefined, callGraphManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

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
        assert.equal(payload.status, 'ok');
        assert.equal(payload.supported, true);
    });
});

test('handleCallGraph maps missing_symbol to status not_found', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as any;

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
        } as any;

        const syncManager = {} as any;
        const callGraphManager = {
            queryGraph: () => ({
                supported: false,
                reason: 'missing_symbol',
                hints: {
                    message: 'Symbol not found'
                }
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, undefined, callGraphManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

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
    });
});

test('handleCallGraph maps unsupported_language to status unsupported', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getVectorStore: () => ({ listCollections: async () => [] })
        } as any;

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
        } as any;

        const syncManager = {} as any;
        const callGraphManager = {
            queryGraph: () => ({
                supported: false,
                reason: 'unsupported_language',
                hints: {
                    supportedExtensions: ['.ts', '.tsx', '.py']
                }
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, undefined, callGraphManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleCallGraph({
            path: repoPath,
            symbolRef: {
                file: 'docs/readme.md',
                symbolId: 'sym_doc'
            },
            direction: 'both',
            depth: 1,
            limit: 20
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'unsupported');
        assert.equal(payload.supported, false);
        assert.equal(payload.reason, 'unsupported_language');
    });
});
