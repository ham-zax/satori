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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-eval-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function createHandlers(repoPath: string, searchResults: any[]) {
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        semanticSearch: async (_root: string, _query: string, topK: number) => searchResults.slice(0, topK)
    } as any;

    const snapshotManager = {
        getAllCodebases: () => [],
        getIndexedCodebases: () => [repoPath],
        getIndexingCodebases: () => [],
        ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false })
    } as any;

    const syncManager = {
        ensureFreshness: async () => ({
            mode: 'skipped_recent',
            checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            thresholdMs: 180000
        })
    } as any;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES, () => Date.parse('2026-01-01T01:00:00.000Z'));
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
    return handlers;
}

const FIXTURE_RESULTS = [
    {
        content: 'export const runtimeAuth = true;',
        relativePath: 'src/auth/runtime.ts',
        startLine: 1,
        endLine: 2,
        language: 'typescript',
        score: 0.99,
        indexedAt: '2026-01-01T00:30:00.000Z',
        symbolId: 'sym_runtime_auth',
        symbolLabel: 'const runtimeAuth'
    },
    {
        content: 'export const runtimeSession = true;',
        relativePath: 'src/session/runtime.ts',
        startLine: 1,
        endLine: 2,
        language: 'typescript',
        score: 0.98,
        indexedAt: '2026-01-01T00:30:00.000Z',
        symbolId: 'sym_runtime_session',
        symbolLabel: 'const runtimeSession'
    },
    {
        content: '# auth docs',
        relativePath: 'docs/auth.md',
        startLine: 1,
        endLine: 2,
        language: 'text',
        score: 0.97,
        indexedAt: '2026-01-01T00:30:00.000Z',
        symbolId: 'sym_docs_auth',
        symbolLabel: 'auth docs'
    },
    {
        content: 'describe("auth", () => {})',
        relativePath: 'src/auth/auth.test.ts',
        startLine: 1,
        endLine: 2,
        language: 'typescript',
        score: 0.96,
        indexedAt: '2026-01-01T00:30:00.000Z',
        symbolId: 'sym_test_auth',
        symbolLabel: 'auth test'
    },
    {
        content: 'fixture token',
        relativePath: 'src/__fixtures__/auth-fixture.ts',
        startLine: 1,
        endLine: 2,
        language: 'typescript',
        score: 0.95,
        indexedAt: '2026-01-01T00:30:00.000Z',
        symbolId: 'sym_fixture_auth',
        symbolLabel: 'fixture auth'
    }
];

test('search eval matrix invariants hold for runtime/docs scope and deterministic ordering', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, FIXTURE_RESULTS);
        const matrix = [
            {
                name: 'runtime scope excludes docs/tests',
                args: { scope: 'runtime', resultMode: 'raw', groupBy: 'symbol', query: 'auth flow', limit: 5 },
                expectedIn: ['src/auth/runtime.ts'],
                expectedNotIn: ['docs/auth.md', 'src/auth/auth.test.ts']
            },
            {
                name: 'docs scope includes docs and tests only',
                args: { scope: 'docs', resultMode: 'raw', groupBy: 'symbol', query: 'auth docs', limit: 5 },
                expectedIn: ['docs/auth.md', 'src/auth/auth.test.ts'],
                expectedNotIn: ['src/auth/runtime.ts']
            }
        ] as const;

        for (const row of matrix) {
            const response = await handlers.handleSearchCode({
                path: repoPath,
                ...row.args
            });
            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok', row.name);
            const files = payload.results.map((result: any) => result.file);
            for (const includeFile of row.expectedIn) {
                assert.equal(files.includes(includeFile), true, `${row.name} expected file '${includeFile}'`);
            }
            for (const excludeFile of row.expectedNotIn) {
                assert.equal(files.includes(excludeFile), false, `${row.name} excluded file '${excludeFile}'`);
            }
        }

        const first = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const second = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const firstPayload = JSON.parse(first.content[0]?.text || '{}');
        const secondPayload = JSON.parse(second.content[0]?.text || '{}');
        const firstOrder = firstPayload.results.map((result: any) => `${result.groupId}:${result.file}`);
        const secondOrder = secondPayload.results.map((result: any) => `${result.groupId}:${result.file}`);
        assert.deepEqual(firstOrder, secondOrder);
    });
});
