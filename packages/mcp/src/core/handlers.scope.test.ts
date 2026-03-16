import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolHandlers } from './handlers.js';
import { CapabilityResolver } from './capabilities.js';
import { IndexFingerprint } from '../config.js';
import { SEARCH_CHANGED_FIRST_MAX_CHANGED_FILES } from './search-constants.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

const DENSE_RUNTIME_FINGERPRINT: IndexFingerprint = {
    ...RUNTIME_FINGERPRINT,
    schemaVersion: 'dense_v3'
};

const CAPABILITIES_NO_RERANK = new CapabilityResolver({
    name: 'test',
    version: '0.0.0',
    encoderProvider: 'VoyageAI',
    encoderModel: 'voyage-4-large',
});

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

function createHandlers(
    repoPath: string,
    searchResults: any[],
    reranker?: any,
    options?: { gitignoreForceReloadEveryN?: number }
) {
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

    const capabilities = new CapabilityResolver({
        name: 'test',
        version: '0.0.0',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        ...(reranker ? { voyageKey: 'test' } : {}),
    });

    const handlers = new ToolHandlers(
        context,
        snapshotManager,
        syncManager,
        RUNTIME_FINGERPRINT,
        capabilities,
        () => Date.parse('2026-01-01T01:00:00.000Z'),
        undefined,
        reranker || null,
        options?.gitignoreForceReloadEveryN
    );
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
    return handlers;
}

function parseSemanticSearchInvocation(args: any[]): { root: string; query: string; topK: number; request: any | null } {
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        return {
            root: args[0].codebasePath,
            query: args[0].query,
            topK: args[0].topK ?? 5,
            request: args[0]
        };
    }

    return {
        root: args[0],
        query: args[1],
        topK: args[2] ?? 5,
        request: null
    };
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
            semanticSearch: async (...args: any[]) => denseResults.slice(0, parseSemanticSearchInvocation(args).topK)
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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
            semanticSearch: async (...args: any[]) => denseResults.slice(0, parseSemanticSearchInvocation(args).topK)
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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

test('handleSearchCode grouped representative prefers must-matching chunk within the same symbol group', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function auth() { return "no token"; }',
                relativePath: 'src/auth.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            },
            {
                content: 'export function auth() { return "ERR_CODE_42"; }',
                relativePath: 'src/auth.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.80,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'must:ERR_CODE_42 auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/auth.ts');
        assert.equal(payload.results[0].span?.startLine, 20);
        assert.equal(payload.results[0].debug?.matchesMust, true);
        assert.match(payload.results[0].preview, /ERR_CODE_42/);
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

test('getChangedFilesForCodebase ignores untracked git status entries for deterministic boost input', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const parsed = (handlers as any).parseGitStatusChangedPaths([
            ' M src/changed.ts',
            'R  src/old.ts -> src/renamed.ts',
            '?? .satori/mcp-codebase-snapshot.json',
            '?? coverage/lcov.info',
        ].join('\n'));

        assert.deepEqual(Array.from(parsed).sort(), ['src/changed.ts', 'src/renamed.ts']);
    });
});

test('getChangedFilesForCodebase reuses stale cache on git status failure to avoid ranking flaps', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, []);
        const cacheKey = path.resolve(repoPath);
        (handlers as any).changedFilesCache.set(cacheKey, {
            expiresAtMs: 0,
            available: true,
            files: new Set(['src/changed.ts'])
        });

        const state = (handlers as any).getChangedFilesForCodebase(repoPath);
        assert.equal(state.available, true);
        assert.deepEqual(Array.from(state.files).sort(), ['src/changed.ts']);
    });
});

test('handleSearchCode policy mode skips reranker for docs scope even when capability is present', async () => {
    await withTempRepo(async (repoPath) => {
        let rerankCalls = 0;
        const reranker = {
            rerank: async () => {
                rerankCalls += 1;
                return [
                    { index: 1, relevanceScore: 0.9 },
                    { index: 0, relevanceScore: 0.8 }
                ];
            }
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'first docs',
                relativePath: 'docs/one.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs_one',
                symbolLabel: 'docs one'
            },
            {
                content: 'second docs',
                relativePath: 'docs/two.md',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_docs_two',
                symbolLabel: 'docs two'
            }
        ], reranker);

        const autoResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'docs query',
            scope: 'docs',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });
        const autoPayload = JSON.parse(autoResponse.content[0]?.text || '{}');
        assert.equal(rerankCalls, 0);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.rerankerPresent, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.skippedByScopeDocs, true);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(autoPayload.hints?.debugSearch?.rerank?.applied, false);
    });
});

test('handleSearchCode debug exposes missing reranker capability without warning noise', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'runtime one',
                relativePath: 'src/one.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one',
                symbolLabel: 'one'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debug: true
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.warnings, undefined);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.capabilityPresent, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.rerankerPresent, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, false);
    });
});

test('handleSearchCode degrades gracefully when reranker fails', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => {
                throw new Error('rerank failed');
            }
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'runtime one',
                relativePath: 'src/one.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_one',
                symbolLabel: 'one'
            },
            {
                content: 'runtime two',
                relativePath: 'src/two.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_two',
                symbolLabel: 'two'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });
        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(Array.isArray(payload.warnings), true);
        assert.equal(payload.warnings.includes('RERANKER_FAILED'), true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.rerankerPresent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.errorCode, 'RERANKER_FAILED');
        assert.equal(payload.hints?.debugSearch?.rerank?.failurePhase, 'api_call');
    });
});

test('handleSearchCode marks rerank.enabled=false when reranker instance is missing', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'runtime one',
                    relativePath: 'src/one.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.99,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_one',
                    symbolLabel: 'one'
                }
            ])
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

        const capabilities = new CapabilityResolver({
            name: 'test',
            version: '0.0.0',
            encoderProvider: 'VoyageAI',
            encoderModel: 'voyage-4-large',
            voyageKey: 'test'
        });

        // No reranker instance provided => should clamp enabled=false.
        const handlers = new ToolHandlers(
            context,
            snapshotManager,
            syncManager,
            RUNTIME_FINGERPRINT,
            capabilities,
            () => Date.parse('2026-01-01T01:00:00.000Z'),
            undefined,
            null
        );
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.rerankerPresent, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, false);
    });
});

test('handleSearchCode exposes identifier query intent and skips reranker for exact identifier lookups', async () => {
    await withTempRepo(async (repoPath) => {
        let rerankCalls = 0;
        const reranker = {
            rerank: async () => {
                rerankCalls += 1;
                return [];
            }
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export type HurstGateState = "open" | "blocked";',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'type HurstGateState'
            },
            {
                content: 'export type RegimeGateState = "open" | "blocked";',
                relativePath: 'src/regime_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_regime_gate_state',
                symbolLabel: 'type RegimeGateState'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'HurstGateState',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(rerankCalls, 0);
        assert.equal(payload.results[0].file, 'src/hurst_gate.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, true);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.classification, 'identifier');
        assert.equal(payload.hints?.debugSearch?.retrieval?.mode, 'lexical');
        assert.equal(payload.hints?.debugSearch?.retrieval?.scorePolicyKind, 'topk_only');
        assert.equal(payload.hints?.debugSearch?.retrieval?.backendScoreKinds?.includes('rrf_fusion'), true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.skippedByIdentifierIntent, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningEnabled, true);
    });
});

test('handleSearchCode promotes lexical exact matches for hurst-style single-token queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function checkRegimeGate() { return "trend persistence"; }',
                relativePath: 'src/regime_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_regime_gate',
                symbolLabel: 'function checkRegimeGate()'
            },
            {
                content: 'export function check_hurst_gate() { return "hurst gate"; }',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate',
                symbolLabel: 'function check_hurst_gate()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'hurst',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/hurst_gate.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, true);
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
        assert.equal(payload.hints?.debugSearch?.retrieval?.backendScoreKinds?.includes('rrf_fusion'), true);
    });
});

test('handleSearchCode prefers usage hits over declarations for reference-seeking mixed queries', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 1, relevanceScore: 0.95 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export type HurstGateState = "open" | "blocked";',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'type HurstGateState'
            },
            {
                content: 'const gate = new HurstGateState(config); return explainWhereUsed(gate);',
                relativePath: 'src/runtime_usage.ts',
                startLine: 10,
                endLine: 14,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function explainRuntimeUsage()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, false);
        assert.equal(payload.hints?.debugSearch?.queryIntent?.classification, 'mixed');
        assert.equal(payload.hints?.debugSearch?.queryIntent?.reasons?.includes('reference_seeking_query'), true);
        assert.equal(payload.hints?.debugSearch?.rerank?.enabled, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.attempted, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.applied, true);
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningEnabled, false);
        assert.equal(payload.hints?.debugSearch?.rerank?.exactMatchPinningApplied, false);
    });
});

test('handleSearchCode collapses duplicate declaration groups for reference-seeking queries', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 2, relevanceScore: 0.99 },
                { index: 0, relevanceScore: 0.98 },
                { index: 1, relevanceScore: 0.97 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_a',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'class HurstGateState { /* duplicate chunk */ }',
                relativePath: 'src/hurst_gate.ts',
                startLine: 2,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_b',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'const gate = new HurstGateState(config); return gate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 10,
                endLine: 14,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function explainRuntimeUsage()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/hurst_gate.ts' && result.symbolLabel === 'class HurstGateState');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode identifier query does not treat fragment-only matches as exact lexical matches', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'export function current_state() { return GateState.NORMAL; }',
                relativePath: 'src/risk_state.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_current_state',
                symbolLabel: 'function current_state()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'HurstGateState',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/hurst_gate.ts');
        assert.equal(payload.results[0].debug?.exactLexicalMatch, true);
        assert.equal(payload.results[1].file, 'src/risk_state.ts');
        assert.equal(payload.results[1].debug?.exactLexicalMatch, false);
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
    });
});

test('handleSearchCode collapses duplicate declaration groups for identifier queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_a',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'class HurstGateState { /* duplicate chunk */ }',
                relativePath: 'src/hurst_gate.ts',
                startLine: 2,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state_b',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'export function current_state() { return GateState.NORMAL; }',
                relativePath: 'src/risk_state.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_current_state',
                symbolLabel: 'function current_state()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'HurstGateState',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/hurst_gate.ts' && result.symbolLabel === 'class HurstGateState');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode reference-seeking queries downweight fragment-only matches below real usage', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 1, relevanceScore: 0.99 },
                { index: 0, relevanceScore: 0.98 },
                { index: 2, relevanceScore: 0.97 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: 'export class HurstGateState {}',
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'export function current_state_gate() { return gateState; }',
                relativePath: 'src/check_gate_state.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.20,
                backendScore: 0.20,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_current_state_gate',
                symbolLabel: 'function current_state_gate()'
            },
            {
                content: 'const gate = HurstGateState(config); return gate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 10,
                endLine: 14,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function explainRuntimeUsage()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].file !== 'src/check_gate_state.ts', true);
    });
});

test('handleSearchCode reference-seeking queries rank runtime usage above declaration chunks with usage examples', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 0, relevanceScore: 0.99 },
                { index: 1, relevanceScore: 0.98 }
            ]
        };
        const handlers = createHandlers(repoPath, [
            {
                content: [
                    'export class HurstGateState {',
                    '  /**',
                    '   * Usage:',
                    '   *   const gate = HurstGateState(config);',
                    '   */',
                    '}'
                ].join('\n'),
                relativePath: 'src/hurst_gate.ts',
                startLine: 1,
                endLine: 6,
                language: 'typescript',
                score: 0.020,
                backendScore: 0.020,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_hurst_gate_state',
                symbolLabel: 'class HurstGateState'
            },
            {
                content: 'this.hurstGate = HurstGateState(config); return this.hurstGate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function initializeRuntimeGate()'
            }
        ], reranker);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].file, 'src/hurst_gate.ts');
    });
});

test('handleSearchCode reference-seeking function declarations do not receive usage-match boost', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function check_hurst_gate(config) { return config; }',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate',
                symbolLabel: 'function check_hurst_gate('
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declaration = payload.results.find((result: any) => result.file === 'src/check_hurst_gate.ts');
        assert.ok(declaration);
        assert.equal(declaration.debug?.lexicalScore < 0.05, true);
    });
});

test('handleSearchCode reference-seeking queries rank executable usage above import-only references', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'import { HurstGateState } from "./hurst_gate"; export { HurstGateState };',
                relativePath: 'src/runtime_import.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.021,
                backendScore: 0.021,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_import',
                symbolLabel: 'module runtime_import'
            },
            {
                content: 'const gate = new HurstGateState(config); return gate;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function initializeRuntimeGate()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is HurstGateState used',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        assert.equal(payload.results[1].file, 'src/runtime_import.ts');
        assert.equal(payload.results[0].debug?.lexicalScore > payload.results[1].debug?.lexicalScore, true);
    });
});

test('handleSearchCode treats arrow function declarations as declarations for reference-seeking queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'const check_hurst_gate = (config) => config;',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_arrow_a',
                symbolLabel: 'const check_hurst_gate ='
            },
            {
                content: 'const check_hurst_gate = async (config) => config.value;',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 3,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_arrow_b',
                symbolLabel: 'const check_hurst_gate ='
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/check_hurst_gate.ts' && result.symbolLabel === 'const check_hurst_gate =');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode treats arrow declarations with n-containing parameter names as declarations', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'const check_hurst_gate = (next) => next;',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_arrow_next',
                symbolLabel: 'const check_hurst_gate ='
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'raw',
            groupBy: 'symbol',
            limit: 2,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results[0].file, 'src/runtime_usage.ts');
        const declaration = payload.results.find((result: any) => result.file === 'src/check_hurst_gate.ts');
        assert.ok(declaration);
        assert.equal(declaration.debug?.lexicalScore < 0.05, true);
    });
});

test('handleSearchCode collapses duplicate function declaration groups for reference-seeking queries', async () => {
    await withTempRepo(async (repoPath) => {
        const handlers = createHandlers(repoPath, [
            {
                content: 'export function check_hurst_gate(config) { return config; }',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.019,
                backendScore: 0.019,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_a',
                symbolLabel: 'function check_hurst_gate('
            },
            {
                content: 'function check_hurst_gate(config) { return config.value; }',
                relativePath: 'src/check_hurst_gate.ts',
                startLine: 2,
                endLine: 4,
                language: 'typescript',
                score: 0.0185,
                backendScore: 0.0185,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_check_hurst_gate_b',
                symbolLabel: 'function check_hurst_gate('
            },
            {
                content: 'const result = check_hurst_gate(config); return result;',
                relativePath: 'src/runtime_usage.ts',
                startLine: 20,
                endLine: 22,
                language: 'typescript',
                score: 0.017,
                backendScore: 0.017,
                backendScoreKind: 'rrf_fusion',
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_usage',
                symbolLabel: 'function runGateCheck()'
            }
        ]);

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'where is check_hurst_gate used',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 3,
            debug: true
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        const declarationHits = payload.results.filter((result: any) => result.file === 'src/check_hurst_gate.ts' && result.symbolLabel === 'function check_hurst_gate(');
        assert.equal(declarationHits.length, 1);
    });
});

test('handleSearchCode reranker can change grouped representative chunk selection before grouping', async () => {
    await withTempRepo(async (repoPath) => {
        const reranker = {
            rerank: async () => [
                { index: 1, relevanceScore: 0.9 },
                { index: 0, relevanceScore: 0.8 }
            ]
        };
        const searchResults = [
            {
                content: 'legacy auth flow',
                relativePath: 'src/auth.ts',
                startLine: 3,
                endLine: 5,
                language: 'typescript',
                score: 0.99,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            },
            {
                content: 'critical token validation path',
                relativePath: 'src/auth.ts',
                startLine: 20,
                endLine: 24,
                language: 'typescript',
                score: 0.98,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_auth',
                symbolLabel: 'function auth()'
            }
        ];
        const handlersWithoutReranker = createHandlers(repoPath, searchResults);
        const handlersWithReranker = createHandlers(repoPath, searchResults, reranker);

        const baselineResponse = await handlersWithoutReranker.handleSearchCode({
            path: repoPath,
            query: 'auth path',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1
        });
        const baselinePayload = JSON.parse(baselineResponse.content[0]?.text || '{}');
        assert.equal(baselinePayload.results[0].preview.includes('legacy auth flow'), true);

        const rerankedResponse = await handlersWithReranker.handleSearchCode({
            path: repoPath,
            query: 'auth path',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 1,
            debug: true
        });
        const rerankedPayload = JSON.parse(rerankedResponse.content[0]?.text || '{}');
        assert.equal(rerankedPayload.results[0].preview.includes('critical token validation path'), true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.enabledByPolicy, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.capabilityPresent, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.rerankerPresent, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.enabled, true);
        assert.equal(rerankedPayload.hints?.debugSearch?.rerank?.applied, true);
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
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /\"action\":\"sync\"/);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /Reindex is only required when you see requires_reindex/i);
        assert.doesNotMatch(payload.hints?.noiseMitigation?.nextStep || '', /already covered by root \.gitignore/i);
    });
});

test('handleSearchCode suppresses redundant ignore suggestions when top noisy files are already covered by root .gitignore', async () => {
    await withTempRepo(async (repoPath) => {
        fs.writeFileSync(
            path.join(repoPath, '.gitignore'),
            ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/__fixtures__/**', 'coverage/**'].join('\n') + '\n',
            'utf8'
        );

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
                content: 'describe("auth", () => {})',
                relativePath: 'src/__tests__/auth.spec.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.94,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_spec',
                symbolLabel: 'function authSpec()'
            },
            {
                content: 'export const fixture = true;',
                relativePath: 'src/__fixtures__/auth-fixture.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.93,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_fixture',
                symbolLabel: 'const fixture'
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
        assert.deepEqual(payload.hints?.noiseMitigation?.suggestedIgnorePatterns, []);
        assert.match(payload.hints?.noiseMitigation?.nextStep || '', /already covered by root \.gitignore/i);
    });
});

test('handleSearchCode keeps only non-redundant ignore suggestions and preserves deterministic order', async () => {
    await withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, '.gitignore'), 'coverage/**\n', 'utf8');

        const handlers = createHandlers(repoPath, [
            {
                content: 'describe("auth", () => {})',
                relativePath: 'src/__tests__/auth.spec.ts',
                startLine: 1,
                endLine: 3,
                language: 'typescript',
                score: 0.95,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_spec',
                symbolLabel: 'function authSpec()'
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
                content: 'TN:coverage',
                relativePath: 'coverage/lcov.info',
                startLine: 1,
                endLine: 2,
                language: 'text',
                score: 0.93,
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
                score: 0.92,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_1',
                symbolLabel: 'const runtime1'
            },
            {
                content: 'export const runtime2 = true;',
                relativePath: 'src/runtime2.ts',
                startLine: 1,
                endLine: 2,
                language: 'typescript',
                score: 0.91,
                indexedAt: '2026-01-01T00:30:00.000Z',
                symbolId: 'sym_runtime_2',
                symbolLabel: 'const runtime2'
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
        assert.deepEqual(payload.hints?.noiseMitigation?.suggestedIgnorePatterns, [
            '**/*.spec.*',
            '**/__tests__/**',
            '**/__fixtures__/**'
        ]);
        assert.doesNotMatch(payload.hints?.noiseMitigation?.nextStep || '', /already covered by root \.gitignore/i);
    });
});

test('handleSearchCode reloads root .gitignore on forced cadence when mtime and size stay unchanged', async () => {
    await withTempRepo(async (repoPath) => {
        const gitignorePath = path.join(repoPath, '.gitignore');
        const firstContent = 'coverage/**\n#same\n';
        const secondContent = '**/*.spec.*\n#same\n';
        const fixedDate = new Date('2026-03-01T00:00:00.000Z');

        fs.writeFileSync(gitignorePath, firstContent, 'utf8');
        fs.utimesSync(gitignorePath, fixedDate, fixedDate);

        const handlers = createHandlers(
            repoPath,
            [
                {
                    content: 'describe("auth", () => {})',
                    relativePath: 'src/__tests__/auth.spec.ts',
                    startLine: 1,
                    endLine: 3,
                    language: 'typescript',
                    score: 0.95,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_spec',
                    symbolLabel: 'function authSpec()'
                },
                {
                    content: 'TN:coverage',
                    relativePath: 'coverage/lcov.info',
                    startLine: 1,
                    endLine: 2,
                    language: 'text',
                    score: 0.94,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_generated',
                    symbolLabel: 'coverage'
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
                    content: 'export const runtime = true;',
                    relativePath: 'src/runtime.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.92,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_runtime_1',
                    symbolLabel: 'const runtime1'
                },
                {
                    content: 'export const runtime2 = true;',
                    relativePath: 'src/runtime2.ts',
                    startLine: 1,
                    endLine: 2,
                    language: 'typescript',
                    score: 0.91,
                    indexedAt: '2026-01-01T00:30:00.000Z',
                    symbolId: 'sym_runtime_2',
                    symbolLabel: 'const runtime2'
                }
            ],
            undefined,
            { gitignoreForceReloadEveryN: 2 }
        );

        const firstResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const firstPayload = JSON.parse(firstResponse.content[0]?.text || '{}');
        assert.deepEqual(firstPayload.hints?.noiseMitigation?.suggestedIgnorePatterns, ['**/*.spec.*', '**/__tests__/**']);

        fs.writeFileSync(gitignorePath, secondContent, 'utf8');
        fs.utimesSync(gitignorePath, fixedDate, fixedDate);

        const secondResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const secondPayload = JSON.parse(secondResponse.content[0]?.text || '{}');
        assert.deepEqual(secondPayload.hints?.noiseMitigation?.suggestedIgnorePatterns, ['**/*.spec.*', '**/__tests__/**']);

        const thirdResponse = await handlers.handleSearchCode({
            path: repoPath,
            query: 'auth flow',
            scope: 'mixed',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });
        const thirdPayload = JSON.parse(thirdResponse.content[0]?.text || '{}');
        assert.deepEqual(thirdPayload.hints?.noiseMitigation?.suggestedIgnorePatterns, ['coverage/**']);
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
        assert.equal(firstPayload.results[0].navigationFallback.message, 'Call graph not available for this result; use readSpan or fileOutlineWindow to navigate.');
        assert.equal(firstPayload.results[0].navigationFallback.context.codebaseRoot, repoPath);
        assert.equal(firstPayload.results[0].navigationFallback.context.relativeFile, 'src/runtime.ts');
        assert.equal(firstPayload.results[0].navigationFallback.context.absolutePath, path.resolve(repoPath, 'src/runtime.ts'));
        assert.deepEqual(firstPayload.results[0].navigationFallback.readSpan, {
            tool: 'read_file',
            args: {
                path: path.resolve(repoPath, 'src/runtime.ts'),
                start_line: 42,
                end_line: 45
            }
        });
        assert.equal(firstPayload.results[0].navigationFallback.fileOutlineWindow, undefined);
    });
});

test('handleSearchCode emits fileOutlineWindow navigation fallback when sidecar is v3 and file supports outline', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'const value = computeToken();',
                    relativePath: 'src/runtime.ts',
                    startLine: 10,
                    endLine: 14,
                    language: 'typescript',
                    score: 0.88,
                    indexedAt: '2026-01-01T00:30:00.000Z'
                }
            ])
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: () => ({ version: 'v3' })
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'compute token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].callGraphHint.supported, false);
        assert.equal(payload.results[0].callGraphHint.reason, 'missing_symbol');
        assert.deepEqual(payload.results[0].navigationFallback.fileOutlineWindow, {
            tool: 'file_outline',
            args: {
                path: repoPath,
                file: 'src/runtime.ts',
                start_line: 10,
                end_line: 14,
                resolveMode: 'outline'
            }
        });
    });
});

test('handleSearchCode subdirectory query builds navigationFallback from effectiveRoot and preserves relative file', async () => {
    await withTempRepo(async (repoPath) => {
        const subdirPath = path.join(repoPath, 'src');
        fs.mkdirSync(subdirPath, { recursive: true });
        const sidecarForPath = (requestedPath: string) => {
            if (requestedPath === repoPath) {
                return { version: 'v3' as const };
            }
            if (requestedPath === subdirPath) {
                return undefined;
            }
            return undefined;
        };
        assert.deepEqual(sidecarForPath(repoPath), { version: 'v3' });
        assert.equal(sidecarForPath(subdirPath), undefined);

        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => ([
                {
                    content: 'const value = computeToken();',
                    relativePath: 'src/runtime.ts',
                    startLine: 10,
                    endLine: 14,
                    language: 'typescript',
                    score: 0.88,
                    indexedAt: '2026-01-01T00:30:00.000Z'
                }
            ])
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getIndexedCodebases: () => [repoPath],
            getIndexingCodebases: () => [],
            ensureFingerprintCompatibilityOnAccess: () => ({ allowed: true, changed: false }),
            getCodebaseCallGraphSidecar: sidecarForPath
        } as any;

        const syncManager = {
            ensureFreshness: async () => ({
                mode: 'skipped_recent',
                checkedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
                thresholdMs: 180000
            })
        } as any;

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: subdirPath,
            query: 'compute token',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.results.length, 1);
        assert.equal(payload.results[0].file, 'src/runtime.ts');
        assert.equal(payload.results[0].navigationFallback.context.codebaseRoot, repoPath);
        assert.equal(payload.results[0].navigationFallback.context.relativeFile, 'src/runtime.ts');
        assert.equal(payload.results[0].navigationFallback.context.absolutePath, path.resolve(repoPath, 'src/runtime.ts'));
        assert.equal(payload.results[0].navigationFallback.readSpan.args.path, path.resolve(repoPath, 'src/runtime.ts'));
        assert.deepEqual(payload.results[0].navigationFallback.fileOutlineWindow, {
            tool: 'file_outline',
            args: {
                path: repoPath,
                file: 'src/runtime.ts',
                start_line: 10,
                end_line: 14,
                resolveMode: 'outline'
            }
        });
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

test('handleSearchCode builds explicit hybrid semantic search requests with topk_only policy', async () => {
    await withTempRepo(async (repoPath) => {
        const calls: Array<{ root: string; query: string; topK: number; request: any | null }> = [];
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async (...args: any[]) => {
                calls.push(parseSemanticSearchInvocation(args));
                return [];
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map((call) => call.query), [
            'validate session',
            'validate session\nimplementation runtime source entrypoint'
        ]);
        for (const call of calls) {
            assert.ok(call.request);
            assert.equal(call.request.codebasePath, repoPath);
            assert.equal(call.request.topK, 40);
            assert.equal(call.request.retrievalMode, 'hybrid');
            assert.deepEqual(call.request.scorePolicy, { kind: 'topk_only' });
        }
    });
});

test('handleSearchCode falls back to dense retrieval when hybrid mode is disabled', async () => {
    await withTempRepo(async (repoPath) => {
        const calls: Array<ReturnType<typeof parseSemanticSearchInvocation>> = [];
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            getIsHybrid: () => false,
            semanticSearch: async (...args: any[]) => {
                calls.push(parseSemanticSearchInvocation(args));
                return [];
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, DENSE_RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'validate session',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'ok');
        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.ok(call.request);
            assert.equal(call.request.codebasePath, repoPath);
            assert.equal(call.request.topK, 40);
            assert.equal(call.request.retrievalMode, 'dense');
            assert.deepEqual(call.request.scorePolicy, { kind: 'topk_only' });
        }
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
            semanticSearch: async (...args: any[]) => {
                const { query } = parseSemanticSearchInvocation(args);
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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
                semanticSearch: async (...args: any[]) => {
                    const { query } = parseSemanticSearchInvocation(args);
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

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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
                semanticSearch: async (...args: any[]) => {
                    const { query } = parseSemanticSearchInvocation(args);
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

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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

            const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
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
        assert.equal(payload.reason, 'requires_reindex');
        assert.equal(payload.freshnessDecision.mode, 'skipped_requires_reindex');
        assert.equal(payload.compatibility.runtimeFingerprint.schemaVersion, 'hybrid_v3');
        assert.equal(payload.compatibility.indexedFingerprint.schemaVersion, 'dense_v3');
        assert.equal(payload.compatibility.reindexReason, 'fingerprint_mismatch');
    });
});

test('handleSearchCode not_indexed payload includes stable reason code', async () => {
    await withTempRepo(async (repoPath) => {
        const context = {
            getEmbeddingEngine: () => ({ getProvider: () => 'VoyageAI' }),
            semanticSearch: async () => []
        } as any;

        const snapshotManager = {
            getAllCodebases: () => [],
            getCodebaseInfo: () => undefined,
            getCodebaseStatus: () => 'not_found',
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

        const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT, CAPABILITIES_NO_RERANK, () => Date.parse('2026-01-01T01:00:00.000Z'));
        (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;

        const response = await handlers.handleSearchCode({
            path: repoPath,
            query: 'runtime',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 5
        });

        const payload = JSON.parse(response.content[0]?.text || '{}');
        assert.equal(payload.status, 'not_indexed');
        assert.equal(payload.reason, 'not_indexed');
        assert.equal(payload.hints?.create?.tool, 'manage_index');
        assert.equal(payload.hints?.create?.args?.action, 'create');
    });
});
