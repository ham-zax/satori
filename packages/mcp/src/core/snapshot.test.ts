import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnapshotManager } from './snapshot.js';
import { IndexFingerprint } from '../config.js';

const FINGERPRINT_A: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

const FINGERPRINT_B: IndexFingerprint = {
    embeddingProvider: 'OpenAI',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimension: 1536,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

function withTempHome<T>(fn: (homeDir: string) => T): T {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-test-'));
    process.env.HOME = tempHome;
    try {
        return fn(tempHome);
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
}

test('v2 snapshot migrates to v3 and first access hard-blocks assumed_v2 entries', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo');
        fs.mkdirSync(codebase, { recursive: true });

        const snapshotDir = path.join(homeDir, '.satori');
        fs.mkdirSync(snapshotDir, { recursive: true });
        const snapshotFile = path.join(snapshotDir, 'mcp-codebase-snapshot.json');

        fs.writeFileSync(snapshotFile, JSON.stringify({
            formatVersion: 'v2',
            codebases: {
                [codebase]: {
                    status: 'indexed',
                    indexedFiles: 10,
                    totalChunks: 40,
                    indexStatus: 'completed',
                    lastUpdated: new Date().toISOString()
                }
            },
            lastUpdated: new Date().toISOString()
        }, null, 2));

        const manager = new SnapshotManager(FINGERPRINT_A);
        manager.loadCodebaseSnapshot();

        const migrated = manager.getCodebaseInfo(codebase);
        assert.ok(migrated);
        assert.equal(migrated?.status, 'indexed');
        assert.equal(migrated?.fingerprintSource, 'assumed_v2');

        const gate = manager.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.changed, true);
        assert.equal(gate.reason, 'legacy_unverified_fingerprint');

        const updated = manager.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'requires_reindex');
    });
});

test('fingerprint mismatch transitions searchable entry to requires_reindex', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo');
        fs.mkdirSync(codebase, { recursive: true });

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 3,
            totalChunks: 12,
            status: 'completed'
        }, FINGERPRINT_A, 'verified');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_B);
        reader.loadCodebaseSnapshot();

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.reason, 'fingerprint_mismatch');

        const updated = reader.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'requires_reindex');
    });
});

test('legacy schemaVersion v2 fingerprint transitions entry to requires_reindex under v3 runtime', () => {
    withTempHome((homeDir) => {
        const codebase = path.join(homeDir, 'repo');
        fs.mkdirSync(codebase, { recursive: true });

        const legacyFingerprint = {
            ...FINGERPRINT_A,
            schemaVersion: 'hybrid_v2'
        } as unknown as IndexFingerprint;

        const writer = new SnapshotManager(FINGERPRINT_A);
        writer.setCodebaseIndexed(codebase, {
            indexedFiles: 5,
            totalChunks: 20,
            status: 'completed'
        }, legacyFingerprint, 'verified');
        writer.saveCodebaseSnapshot();

        const reader = new SnapshotManager(FINGERPRINT_A);
        reader.loadCodebaseSnapshot();

        const gate = reader.ensureFingerprintCompatibilityOnAccess(codebase);
        assert.equal(gate.allowed, false);
        assert.equal(gate.reason, 'fingerprint_mismatch');

        const updated = reader.getCodebaseInfo(codebase);
        assert.ok(updated);
        assert.equal(updated?.status, 'requires_reindex');
    });
});
