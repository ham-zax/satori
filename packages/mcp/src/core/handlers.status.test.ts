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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-status-handler-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

test('handleGetIndexingStatus includes fingerprint diagnostics for requires_reindex status', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedFingerprint: IndexFingerprint = {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-lite',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'dense_v3'
        };

        const context = {} as any;
        const snapshotManager = {
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseStatus: () => 'requires_reindex',
            getCodebaseInfo: () => ({
                status: 'requires_reindex',
                message: 'Legacy fingerprint mismatch.',
                lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                indexFingerprint: indexedFingerprint,
                fingerprintSource: 'verified',
                reindexReason: 'fingerprint_mismatch'
            })
        } as any;
        const syncManager = {} as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT);
        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const text = response.content[0]?.text || '';

        assert.match(text, /must be rebuilt/i);
        assert.match(text, /Runtime fingerprint: VoyageAI\/voyage-4-large\/1024\/Milvus\/hybrid_v3/i);
        assert.match(text, /Indexed fingerprint: VoyageAI\/voyage-4-lite\/1024\/Milvus\/dense_v3/i);
        assert.match(text, /Fingerprint source: verified/i);
        assert.match(text, /Reindex reason: fingerprint_mismatch/i);
    });
});

test('handleGetIndexingStatus includes fingerprint diagnostics when access gate blocks', async () => {
    await withTempRepo(async (repoPath) => {
        const indexedFingerprint: IndexFingerprint = {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-large',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'dense_v3'
        };

        const context = {} as any;
        const snapshotManager = {
            ensureFingerprintCompatibilityOnAccess: () => ({
                allowed: false,
                changed: false,
                message: 'Legacy v2 index detected.'
            }),
            getCodebaseStatus: () => 'requires_reindex',
            getCodebaseInfo: () => ({
                status: 'requires_reindex',
                message: 'Legacy v2 index detected.',
                lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                indexFingerprint: indexedFingerprint,
                fingerprintSource: 'assumed_v2',
                reindexReason: 'legacy_unverified_fingerprint'
            })
        } as any;
        const syncManager = {} as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT);
        const response = await handlers.handleGetIndexingStatus({ path: repoPath });
        const text = response.content[0]?.text || '';

        assert.match(text, /Legacy v2 index detected/i);
        assert.match(text, /Runtime fingerprint: VoyageAI\/voyage-4-large\/1024\/Milvus\/hybrid_v3/i);
        assert.match(text, /Indexed fingerprint: VoyageAI\/voyage-4-large\/1024\/Milvus\/dense_v3/i);
        assert.match(text, /Fingerprint source: assumed_v2/i);
        assert.match(text, /Reindex reason: legacy_unverified_fingerprint/i);
    });
});
