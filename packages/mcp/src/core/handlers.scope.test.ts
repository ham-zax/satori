import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { IndexFingerprint } from '../config.js';
import { SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES } from './search-constants.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-handlers-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(vars)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        await fn();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function createHandlers(repoPath: string, searchResults: any[]) {
    const context = {
        getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
        semanticSearch: async () => searchResults
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

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
    return handlers;
}

test('handleSearchCode grouped output includes symbol metadata and callGraphHint', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'return session.isValid();',
            relativePath: 'src/auth.ts',
            startLine: 3,
            endLine: 6,
            language: 'typescript',
            score: 0.99,
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: 'sym_auth_validate',
            symbolLabel: 'method validateSession(token: string)',
            breadcrumbs: ['class SessionManager', 'method validateSession(token: string)']
        }]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        assert.equal(response.isError, undefined);
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.resultMode, 'grouped');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].symbolId, 'sym_auth_validate');
        assert.equal(payload.results[0].callGraphHint.supported, true);
        assert.equal(payload.results[0].callGraphHint.symbolRef.symbolId, 'sym_auth_validate');
    });
});

test('handleSearchCode runtime scope excludes docs and tests', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const run = () => true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.9,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: '# docs',
                relativePath: 'docs/runtime.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'describe("runtime", () => {})',
                relativePath: 'src/runtime.test.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'export const offlineFixture = true;',
                relativePath: 'tests/fixtures/offline-corpus/credit-fallback.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.resultMode, 'raw');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/runtime.ts');
    });
});

test('handleSearchCode docs scope only returns docs and tests', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const run = () => true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.9,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: '# docs',
                relativePath: 'docs/runtime.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'export const docHelper = true;',
                relativePath: 'docs/runtime-helper.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z'
            },
            {
                content: 'describe("runtime", () => {})',
                relativePath: 'src/runtime.test.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'docs',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const files = payload.results.map((r: any) => r.file).sort();
        assert.deepEqual(files, ['docs/runtime-helper.ts', 'docs/runtime.md', 'src/runtime.test.ts']);
    });
});

test('handleSearchCode parses operators from query prefix and applies deterministic filters', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'throw new Error("ERR_CODE_42");',
                relativePath: 'src/auth.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            },
            {
                content: 'ERR_CODE_42 explained in docs',
                relativePath: 'docs/auth.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs',
                symbolLabel: 'auth docs'
            },
            {
                content: 'legacy fallback',
                relativePath: 'src/legacy.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_legacy',
                symbolLabel: 'function legacy()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'lang:typescript path:"src/**" must:ERR_CODE_42 exclude:legacy\n\nauth failure',
            scope: 'mixed',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 10,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/auth.ts');
        assert.equal(Array.isArray(payload.warnings) && payload.warnings.includes('FILTER_MUST_UNSATISFIED'), false);
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.lang?.[0], 'typescript');
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.path?.[0], 'src/**');
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.must?.[0], 'ERR_CODE_42');
        assert.equal(payload.hints?.debugSearch?.operatorSummary?.exclude?.[0], 'legacy');
        assert.equal(payload.hints?.debugSearch?.mustRetry?.satisfied, true);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.finalCount, 1);
    });
});

test('handleSearchCode emits FILTER_MUST_UNSATISFIED after bounded retries', async () => {
    await withTempRepo(async (repoPath) => {
        const denseResults = Array.from({ length: 140 }, (_, idx) => ({
            content: `candidate ${idx}`,
            relativePath: `src/candidate-${idx}.ts`,
            startLine: 1,
            endLine: 2,
            language: 'typescript',
            score: 0.99 - (idx * 0.0001),
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: `sym_candidate_${idx}`,
            symbolLabel: `function candidate${idx}()`
        }));

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (_root: string, _query: string, topK: number) => denseResults.slice(0, topK)
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'must:NEVER_PRESENT runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 0);
        assert.ok(Array.isArray(payload.warnings));
        assert.equal(payload.warnings.includes('FILTER_MUST_UNSATISFIED'), true);
    });
});

test('handleSearchCode does not emit FILTER_MUST_UNSATISFIED when must succeeds after retry expansion', async () => {
    await withTempRepo(async (repoPath) => {
        const denseResults = Array.from({ length: 80 }, (_, idx) => ({
            content: idx === 40 ? 'contains NEEDLE_TOKEN' : `candidate ${idx}`,
            relativePath: `src/retry-${idx}.ts`,
            startLine: 1,
            endLine: 2,
            language: 'typescript',
            score: 0.99 - (idx * 0.0001),
            indexedAt: '2026-01-01T00:30:00.000Z',
            symbolId: `sym_retry_${idx}`,
            symbolLabel: `function retry${idx}()`
        }));

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (_root: string, _query: string, topK: number) => denseResults.slice(0, topK)
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'must:NEEDLE_TOKEN runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/retry-40.ts');
        assert.equal(Array.isArray(payload.warnings) && payload.warnings.includes('FILTER_MUST_UNSATISFIED'), false);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.attempts, 2);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.satisfied, true);
        assert.equal(payload.hints?.debugSearch?.mustRetry?.finalCount, 1);
    });
});

test('handleSearchCode grouped diversity keeps multi-file coverage by default', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const a = 1;',
                relativePath: 'src/one.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one_a',
                symbolLabel: 'const a'
            },
            {
                content: 'export const b = 2;',
                relativePath: 'src/one.ts',
                startLine: 10,
                endLine: 12,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one_b',
                symbolLabel: 'const b'
            },
            {
                content: 'export const c = 3;',
                relativePath: 'src/one.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one_c',
                symbolLabel: 'const c'
            },
            {
                content: 'export const z = 9;',
                relativePath: 'src/two.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_two_z',
                symbolLabel: 'const z'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'constants',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const files = payload.results.map((result: any) => result.file);
        assert.equal(files.includes('src/two.ts'), true);
        assert.equal(payload.hints?.debugSearch?.diversitySummary?.maxPerFile, 2);
        assert.equal(payload.hints?.debugSearch?.diversitySummary?.maxPerSymbol, 1);
    });
});

test('handleSearchCode applies changed-files boost in auto mode and skips boost in default mode', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const unchanged = true;',
                relativePath: 'src/unchanged.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unchanged',
                symbolLabel: 'const unchanged'
            },
            {
                content: 'export const changed = true;',
                relativePath: 'src/changed.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_changed',
                symbolLabel: 'const changed'
            }
        ]);

        (handlers as any).getChangedFilesForCodebase = () => ({
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const autoResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2
        });
        const autoPayload = JSON.parse(autoResponse.content[0]?.text || '{}');
        assert.equal(autoPayload.results[0].file, 'src/changed.ts');

        const defaultResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            rankingMode: 'default',
            limit: 2
        });
        const defaultPayload = JSON.parse(defaultResponse.content[0]?.text || '{}');
        assert.equal(defaultPayload.results[0].file, 'src/unchanged.ts');
    });
});

test('handleSearchCode auto_changed_first skips boost when changed file set exceeds threshold', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const unchanged = true;',
                relativePath: 'src/unchanged.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_unchanged',
                symbolLabel: 'const unchanged'
            },
            {
                content: 'export const changed = true;',
                relativePath: 'src/changed.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_changed',
                symbolLabel: 'const changed'
            }
        ]);

        const changedPaths = new Set<string>();
        changedPaths.add('src/changed.ts');
        for (let i = 0; i < SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES; i++) {
            changedPaths.add(`src/extra-${i}.ts`);
        }

        (handlers as any).getChangedFilesForCodebase = () => ({
            available: true,
            files: changedPaths
        });

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'changed symbol',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/unchanged.ts');
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.applied, false);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.changedCount, SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES + 1);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.maxChangedFilesForBoost, SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES);
        assert.equal(payload.hints?.debugSearch?.changedFilesBoost?.skippedForLargeChangeSet, true);
    });
});

test('handleSearchCode emits deterministic noiseMitigation hint when top grouped results are noise-dominant', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'describe("auth", () => {})',
                relativePath: 'tests/auth.test.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_test',
                symbolLabel: 'function testAuth()'
            },
            {
                content: 'export const fixture = true;',
                relativePath: 'src/__fixtures__/auth-fixture.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_fixture',
                symbolLabel: 'const fixture'
            },
            {
                content: '# auth docs',
                relativePath: 'docs/auth.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs',
                symbolLabel: 'doc auth'
            },
            {
                content: 'TN:coverage',
                relativePath: 'coverage/lcov.info',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.92,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_generated',
                symbolLabel: 'coverage'
            },
            {
                content: 'export const runtime = true;',
                relativePath: 'src/runtime.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime',
                symbolLabel: 'const runtime'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.version, 1);
        assert.equal(payload.hints?.noiseMitigation?.reason, 'top_results_noise_dominant');
        assert.equal(payload.hints?.noiseMitigation?.topK, 5);
        assert.deepEqual(payload.hints?.noiseMitigation?.ratios, {
            tests: 0.2,
            fixtures: 0.2,
            docs: 0.2,
            generated: 0.2,
            runtime: 0.2
        });
        assert.equal(payload.hints?.noiseMitigation?.recommendedScope, 'runtime');
        assert.equal(payload.hints?.noiseMitigation?.debounceMs, 5000);
        assert.deepEqual(payload.hints?.noiseMitigation?.suggestedIgnorePatterns, [
            '**/*.test.*',
            '**/*.spec.*',
            '**/__tests__/**',
            '**/__fixtures__/**',
            '**/fixtures/**',
            'coverage/**'
        ]);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /scope=\"runtime\"/);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /scope=\"mixed\"/);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /\"action\":\"sync\"/);
    });
});

test('handleSearchCode omits noiseMitigation hint when top grouped results are runtime-dominant', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export const runtimeA = true;',
                relativePath: 'src/runtime-a.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_a',
                symbolLabel: 'const runtimeA'
            },
            {
                content: 'export const runtimeB = true;',
                relativePath: 'src/runtime-b.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_b',
                symbolLabel: 'const runtimeB'
            },
            {
                content: 'export const runtimeC = true;',
                relativePath: 'src/runtime-c.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.97,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_c',
                symbolLabel: 'const runtimeC'
            },
            {
                content: 'export const runtimeD = true;',
                relativePath: 'src/runtime-d.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.96,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_d',
                symbolLabel: 'const runtimeD'
            },
            {
                content: '# docs',
                relativePath: 'docs/runtime.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs',
                symbolLabel: 'docs'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.noiseMitigation, undefined);
    });
});

test('handleSearchCode grouped fallback emits stable hash groupId and unsupported callGraphHint when symbol is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [{
            content: 'const value = computeToken();',
            relativePath: 'src/runtime.ts',
            startLine: 42,
            endLine: 45,
            language: 'typescript',
            score: 0.88,
            indexedAt: '2026-01-01T00:30:00.000Z'
        }]);

        const args = {
            path: repoPath,
            query: 'compute token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        };

        const firstResponse = await handlers.handleSearchCode(args);
        const secondResponse = await handlers.handleSearchCode(args);

        const firstPayload = JSON.parse(firstResponse.content[0]?.text || '{}');
        const secondPayload = JSON.parse(secondResponse.content[0]?.text || '{}');

        assert.equal(firstPayload.results.length, 1);
        assert.equal(secondPayload.results.length, 1);
        assert.match(firstPayload.results[0].groupId, /^grp_[a-f0-9]{16}$/);
        assert.equal(firstPayload.results[0].groupId, secondPayload.results[0].groupId);
        assert.equal(firstPayload.results[0].callGraphHint.supported, false);
        assert.equal(firstPayload.results[0].callGraphHint.reason, 'missing_symbol');
    });
});

test('handleSearchCode grouped sorting places null symbolLabel last for deterministic tie-breaking', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'return verifyToken(token);',
                relativePath: 'src/auth.ts',
                startLine: 10,
                endLine: 12,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_with_label',
                symbolLabel: 'function withLabel(token: string)'
            },
            {
                content: 'return verifyToken(token);',
                relativePath: 'src/auth.ts',
                startLine: 10,
                endLine: 13,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_without_label'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'verify token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results.length, 2);
        assert.equal(payload.results[0].symbolId, 'sym_with_label');
        assert.equal(payload.results[1].symbolId, 'sym_without_label');
    });
});

test('handleSearchCode runs semantic passes concurrently and emits warnings on partial failure', async () => {
    await withTempRepo(async (repoPath) => {
        const started: string[] = [];
        let releaseSearchPasses: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            releaseSearchPasses = resolve;
        });

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (_root: string, query: string) => {
                const passId = query.includes('implementation runtime source entrypoint') ? 'expanded' : 'primary';
                started.push(passId);
                await gate;
                if (passId === 'expanded') {
                    throw new Error('expanded failed');
                }
                return [{
                    content: 'return session.isValid();',
                    relativePath: 'src/auth.ts',
                    startLine: 3,
                    endLine: 6,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_auth_validate',
                    symbolLabel: 'method validateSession(token: string)'
                }];
            }
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const responsePromise = handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(new Set(started), new Set(['primary', 'expanded']));

        releaseSearchPasses?.();
        const response = await responsePromise;
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.ok(Array.isArray(payload.warnings));
        assert.equal(payload.warnings[0], 'SEARCH_PASS_FAILED:expanded - expanded semantic search pass failed; results may be degraded.');
    });
});

test('handleSearchCode returns error when all semantic passes fail', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => {
                throw new Error('backend unavailable');
            }
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        assert.equal(response.isError, true);
        assert.match(response.content[0]?.text || '', /all semantic search passes failed/i);
    });
});

test('handleSearchCode supports deterministic test-only fault injection for expanded pass', { concurrency: false }, async () => {
    await withTempRepo(async (repoPath) => {
        await withEnv({
            NODE_ENV: 'test',
            SATORI_TEST_FAIL_SEARCH_PASS: 'expanded'
        }, async () => {
            const context = {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                semanticSearch: async (_root: string, query: string) => {
                    if (query.includes('implementation runtime source entrypoint')) {
                        return [{
                            content: 'expanded pass hit',
                            relativePath: 'src/expanded.ts',
                            startLine: 1,
                            endLine: 2,
                            language: 'typescript',
                            score: 0.95,
                            indexedAt: '2026-01-01T00:30:00.000Z',
                            symbolId: 'sym_expanded',
                            symbolLabel: 'function expandedPass()'
                        }];
                    }
                    return [{
                        content: 'primary pass hit',
                        relativePath: 'src/primary.ts',
                        startLine: 1,
                        endLine: 2,
                        language: 'typescript',
                        score: 0.99,
                        indexedAt: '2026-01-01T00:30:00.000Z',
                        symbolId: 'sym_primary',
                        symbolLabel: 'function primaryPass()'
                    }];
                }
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

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
            (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'session token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 1);
            assert.equal(payload.results[0].symbolId, 'sym_primary');
            assert.deepEqual(payload.warnings, [
                'SEARCH_PASS_FAILED:expanded - expanded semantic search pass failed; results may be degraded.'
            ]);
            assert.equal(response.meta?.searchDiagnostics?.searchPassFailureCount, 1);
        });
    });
});

test('handleSearchCode ignores fault injection env outside test mode', { concurrency: false }, async () => {
    await withTempRepo(async (repoPath) => {
        await withEnv({
            NODE_ENV: 'production',
            SATORI_TEST_FAIL_SEARCH_PASS: 'both'
        }, async () => {
            const context = {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                semanticSearch: async (_root: string, query: string) => {
                    if (query.includes('implementation runtime source entrypoint')) {
                        return [{
                            content: 'expanded pass hit',
                            relativePath: 'src/expanded.ts',
                            startLine: 1,
                            endLine: 2,
                            language: 'typescript',
                            score: 0.95,
                            indexedAt: '2026-01-01T00:30:00.000Z',
                            symbolId: 'sym_expanded',
                            symbolLabel: 'function expandedPass()'
                        }];
                    }
                    return [{
                        content: 'primary pass hit',
                        relativePath: 'src/primary.ts',
                        startLine: 1,
                        endLine: 2,
                        language: 'typescript',
                        score: 0.99,
                        indexedAt: '2026-01-01T00:30:00.000Z',
                        symbolId: 'sym_primary',
                        symbolLabel: 'function primaryPass()'
                    }];
                }
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

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
            (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'session token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5
            });

            const payload = JSON.parse(response.content[0]?.text || '{}');
            assert.equal(payload.status, 'ok');
            assert.equal(payload.results.length, 2);
            assert.equal(payload.warnings, undefined);
            assert.equal(response.meta?.searchDiagnostics?.searchPassFailureCount, 0);
        });
    });
});

test('handleSearchCode returns deterministic all-pass error when test fault injection forces both passes', { concurrency: false }, async () => {
    await withTempRepo(async (repoPath) => {
        await withEnv({
            NODE_ENV: 'test',
            SATORI_TEST_FAIL_SEARCH_PASS: 'both'
        }, async () => {
            const context = {
                getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
                semanticSearch: async () => [{
                    content: 'primary pass hit',
                    relativePath: 'src/primary.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_primary',
                    symbolLabel: 'function primaryPass()'
                }]
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

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
            (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

            const response = await handlers.handleSearchCode({
                path: repoPath,
                query: 'session token',
                scope: 'runtime',
                resultMode: 'grouped',
                groupBy: 'symbol',
                limit: 5
            });

            assert.equal(response.isError, true);
            assert.match(response.content[0]?.text || '', /all semantic search passes failed/i);
        });
    });
});

test('handleSearchCode requires_reindex payload includes compatibility diagnostics', async () => {
    await withTempRepo(async (repoPath) => {
        const legacyFingerprint: IndexFingerprint = {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-lite',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'dense_v3'
        };

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => []
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [{
                path: repoPath,
                info: {
                    status: 'requires_reindex',
                    message: 'Legacy fingerprint mismatch.',
                    lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                    indexFingerprint: legacyFingerprint,
                    fingerprintSource: 'verified',
                    reindexReason: 'fingerprint_mismatch'
                }
            }],
            getCodebaseInfo: () => ({
                status: 'requires_reindex',
                message: 'Legacy fingerprint mismatch.',
                lastUpdated: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                indexFingerprint: legacyFingerprint,
                fingerprintSource: 'verified',
                reindexReason: 'fingerprint_mismatch'
            }),
            getCodebaseStatus: () => 'requires_reindex',
            getIndexedCodebases: () => [],
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'legacy mismatch',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'requires_reindex');
        assert.equal(payload.freshnessDecision.mode, 'skipped_requires_reindex');
        assert.equal(payload.compatibility.runtimeFingerprint.schemaVersion, 'hybrid_v3');
        assert.equal(payload.compatibility.indexedFingerprint.schemaVersion, 'dense_v3');
        assert.equal(payload.compatibility.reindexReason, 'fingerprint_mismatch');
    });
});
