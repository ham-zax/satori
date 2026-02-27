import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-manage-blocking-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function createHandlers(repoPath: string): ToolHandlers {
    const context = {
        clearIndex: async () => undefined,
        reindexByChange: async () => ({ added: 0, removed: 0, modified: 0 })
    } as any;

    const snapshotManager = {
        getAllCodebases: () => [{ path: repoPath, info: { status: 'indexing' } }],
        getIndexingCodebases: () => [repoPath],
        getIndexedCodebases: () => [],
        getCodebaseStatus: () => 'indexing',
        getCodebaseInfo: () => ({
            status: 'indexing',
            indexingPercentage: 37,
            lastUpdated: '2026-02-27T23:57:03.000Z'
        }),
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
        saveCodebaseSnapshot: () => undefined
    } as any;

    const syncManager = {
        getWatchDebounceMs: () => 2000
    } as any;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES);
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
    return handlers;
}

function assertBlockedText(text: string, repoPath: string, action: 'create' | 'sync' | 'clear') {
    assert.match(text, new RegExp(`action='${action}'`));
    assert.match(text, /reason=indexing/);
    assert.match(
        text,
        new RegExp(`hints\\.status=\\{"tool":"manage_index","args":\\{"action":"status","path":"${repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\}\\}`)
    );
    assert.match(text, /retryAfterMs=2000/);
}

test('handleIndexCodebase returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleIndexCodebase({ path: repoPath });
        assert.equal(response.isError, true);
        const text = response.content[0]?.text || '';
        assertBlockedText(text, repoPath, 'create');
    });
});

test('handleSyncCodebase returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleSyncCodebase({ path: repoPath });
        assert.equal(response.isError, true);
        const text = response.content[0]?.text || '';
        assertBlockedText(text, repoPath, 'sync');
    });
});

test('handleClearIndex returns blocked manage message with status hint and retryAfterMs while indexing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath);
        const response = await handlers.handleClearIndex({ path: repoPath });
        assert.equal(response.isError, true);
        const text = response.content[0]?.text || '';
        assertBlockedText(text, repoPath, 'clear');
    });
});

