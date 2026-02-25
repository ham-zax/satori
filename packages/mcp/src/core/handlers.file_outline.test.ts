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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-file-outline-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), 'export function run() { return true; }\n');
    fs.writeFileSync(path.join(repoPath, 'docs.md'), '# docs\n');
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function baseContext() {
    return {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        getVectorStore: () => ({ listCollections: async () => [] })
    } as any;
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
        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleFileOutline({
            path: repoPath,
            file: 'src/runtime.ts'
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.file, 'src/runtime.ts');
        assert.equal(payload.hints.reindex.args.path, repoPath);
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

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, undefined, callGraphManager);
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

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, undefined, callGraphManager);
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
        assert.equal(payload.warnings[0], 'OUTLINE_MISSING_SYMBOL_METADATA:1');
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

        const handlers = new ToolHandlers(baseContext(), snapshotManager, {} as any, RUNTIME_FINGERPRINT, undefined, callGraphManager);
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
