import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import type { ManageIndexResponseEnvelope } from './manage-types.js';
import { WARNING_CODES } from './warnings.js';

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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-manage-preflight-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function initGitRepo(repoPath: string): void {
    execFileSync('git', ['init', repoPath], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseManageEnvelope(response: any): ManageIndexResponseEnvelope {
    const payload = response?.content?.[0]?.text;
    assert.equal(typeof payload, 'string');
    return JSON.parse(payload) as ManageIndexResponseEnvelope;
}

function createHandlers(repoPath: string): ToolHandlers {
    const vectorStore = {
        checkCollectionLimit: async () => true,
        listCollections: async () => [],
        listCollectionDetails: async () => [],
        getBackendInfo: () => ({ provider: 'milvus', transport: 'grpc' as const, address: 'localhost:19530' }),
        hasCollection: async () => false,
        dropCollection: async () => undefined,
    };

    const context = {
        getVectorStore: () => vectorStore,
        resolveCollectionName: (codebasePath: string) => {
            const normalized = path.resolve(codebasePath);
            return `hybrid_code_chunks_${Buffer.from(normalized).toString('hex').slice(0, 8)}`;
        },
        addCustomExtensions: () => undefined,
        addCustomIgnorePatterns: () => undefined,
        clearIndex: async () => undefined,
    } as any;

    const snapshotManager = {
        getAllCodebases: () => [],
        getIndexingCodebases: () => [],
        getIndexedCodebases: () => [],
        getCodebaseStatus: () => 'indexed',
        getCodebaseInfo: () => undefined,
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        removeCodebaseCompletely: () => undefined,
        setCodebaseIndexing: () => undefined,
        saveCodebaseSnapshot: () => undefined,
    } as any;

    const syncManager = {
        unregisterCodebaseWatcher: async () => undefined,
        getWatchDebounceMs: () => 2000
    } as any;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
    (handlers as any).startBackgroundIndexing = () => undefined;
    return handlers;
}

test('handleReindexCodebase blocks ignore-only churn unless override is provided', async () => {
    await withTempRepo(async (repoPath) => {
        initGitRepo(repoPath);
        fs.writeFileSync(path.join(repoPath, '.gitignore'), 'coverage/**\n', 'utf8');

        const handlers = createHandlers(repoPath);
        const response = await handlers.handleReindexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'reindex');
        assert.equal(envelope.status, 'blocked');
        assert.equal(envelope.reason, 'unnecessary_reindex_ignore_only');
        assert.deepEqual(envelope.warnings, [WARNING_CODES.REINDEX_UNNECESSARY_IGNORE_ONLY]);
        assert.equal(envelope.preflight?.outcome, 'reindex_unnecessary_ignore_only');
        assert.equal(envelope.preflight?.confidence, 'high');
        assert.deepEqual(envelope.hints?.sync, {
            tool: 'manage_index',
            args: { action: 'sync', path: repoPath }
        });
        assert.deepEqual(envelope.hints?.overrideReindex, {
            tool: 'manage_index',
            args: { action: 'reindex', path: repoPath, allowUnnecessaryReindex: true }
        });
    });
});

test('handleReindexCodebase honors allowUnnecessaryReindex override for ignore-only churn', async () => {
    await withTempRepo(async (repoPath) => {
        initGitRepo(repoPath);
        fs.writeFileSync(path.join(repoPath, '.gitignore'), 'coverage/**\n', 'utf8');

        const handlers = createHandlers(repoPath);
        const response = await handlers.handleReindexCodebase({
            path: repoPath,
            allowUnnecessaryReindex: true
        });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'reindex');
        assert.equal(envelope.status, 'ok');
        assert.equal(envelope.reason, undefined);
        assert.equal(envelope.preflight, undefined);
        assert.match(envelope.humanText, /Started background indexing/i);
    });
});

test('handleReindexCodebase surfaces probe_failed preflight diagnostics without blocking', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleReindexCodebase({ path: repoPath });
        const envelope = parseManageEnvelope(response);

        assert.equal(envelope.action, 'reindex');
        assert.equal(envelope.status, 'ok');
        assert.deepEqual(envelope.warnings, [WARNING_CODES.IGNORE_POLICY_PROBE_FAILED]);
        assert.equal(envelope.preflight?.outcome, 'probe_failed');
        assert.equal(envelope.preflight?.confidence, 'low');
        assert.equal(envelope.preflight?.probeFailed, true);
    });
});
