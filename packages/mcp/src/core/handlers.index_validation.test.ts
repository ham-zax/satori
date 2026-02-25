import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { COLLECTION_LIMIT_MESSAGE } from '@zokizuan/satori-core';
import { ToolHandlers } from './handlers.js';
import { IndexFingerprint } from '../config.js';

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

type BackendProvider = 'zilliz' | 'milvus';

interface ValidationHarnessOptions {
    checkCollectionLimitImpl: () => Promise<boolean>;
    backendProvider?: BackendProvider;
    collectionDetails?: Array<{ name: string; createdAt?: string }>;
    metadataByCollection?: Record<string, { codebasePath?: string }>;
    hasIndexedCollectionImpl?: (codebasePath: string) => Promise<boolean>;
    hasCollectionImpl?: (collectionName: string) => Promise<boolean>;
    dropCollectionImpl?: (collectionName: string) => Promise<void>;
}

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-index-validation-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    return fn(repoPath).finally(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function resolveCollectionName(codebasePath: string): string {
    const normalized = path.resolve(codebasePath);
    const digest = crypto.createHash('md5').update(normalized).digest('hex').slice(0, 8);
    return `hybrid_code_chunks_${digest}`;
}

function createHandlersForValidation(options: ValidationHarnessOptions): { handlers: ToolHandlers; droppedCollections: string[] } {
    const droppedCollections: string[] = [];
    const backendProvider = options.backendProvider || 'milvus';
    const collectionDetails = options.collectionDetails || [];
    const metadataByCollection = options.metadataByCollection || {};

    const vectorStore = {
        checkCollectionLimit: options.checkCollectionLimitImpl,
        getBackendInfo: () => ({ provider: backendProvider, transport: 'grpc' as const, address: 'in03.example.cloud.zilliz.com' }),
        listCollectionDetails: async () => collectionDetails,
        listCollections: async () => collectionDetails.map((detail) => detail.name),
        query: async (collectionName: string) => {
            const metadata = metadataByCollection[collectionName];
            if (!metadata?.codebasePath) {
                return [];
            }

            return [{ metadata: JSON.stringify({ codebasePath: metadata.codebasePath }) }];
        },
        hasCollection: async (collectionName: string) => {
            if (options.hasCollectionImpl) {
                return options.hasCollectionImpl(collectionName);
            }
            return collectionDetails.some((detail) => detail.name === collectionName);
        },
        dropCollection: async (collectionName: string) => {
            droppedCollections.push(collectionName);
            if (options.dropCollectionImpl) {
                await options.dropCollectionImpl(collectionName);
            }
        }
    };

    const context = {
        hasIndexedCollection: async (codebasePath: string) => {
            if (options.hasIndexedCollectionImpl) {
                return options.hasIndexedCollectionImpl(codebasePath);
            }
            return false;
        },
        getVectorStore: () => vectorStore,
        resolveCollectionName,
        addCustomExtensions: () => undefined,
        addCustomIgnorePatterns: () => undefined,
        clearIndex: async () => undefined,
    } as any;

    const snapshotManager = {
        getIndexingCodebases: () => [],
        getCodebaseInfo: () => undefined,
        getIndexedCodebases: () => [],
        getCodebaseStatus: () => 'not_found',
        removeCodebaseCompletely: () => undefined,
        setCodebaseIndexing: () => undefined,
        saveCodebaseSnapshot: () => undefined,
        getAllCodebases: () => [],
    } as any;

    const syncManager = {
        unregisterCodebaseWatcher: async () => undefined,
    } as any;

    const handlers = new ToolHandlers(context, snapshotManager, syncManager, RUNTIME_FINGERPRINT);
    (handlers as any).syncIndexedCodebasesFromCloud = async () => undefined;
    (handlers as any).startBackgroundIndexing = async () => undefined;
    return { handlers, droppedCollections };
}

test('handleIndexCodebase returns Zilliz eviction guidance with free-tier reason and agent instructions', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => false,
            collectionDetails: [
                { name: 'hybrid_code_chunks_old11111', createdAt: '2026-01-10T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_mid22222', createdAt: '2026-02-10T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_new33333', createdAt: '2026-02-20T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_new44444', createdAt: '2026-02-24T10:00:00.000Z' },
                { name: 'hybrid_code_chunks_new55555', createdAt: '2026-02-25T10:00:00.000Z' },
            ],
            metadataByCollection: {
                hybrid_code_chunks_old11111: { codebasePath: '/repo/oldest' },
                hybrid_code_chunks_mid22222: { codebasePath: '/repo/mid' },
                hybrid_code_chunks_new33333: { codebasePath: '/repo/newer' },
                hybrid_code_chunks_new44444: { codebasePath: '/repo/newest-1' },
                hybrid_code_chunks_new55555: { codebasePath: '/repo/newest-2' },
            }
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        assert.equal(response.isError, true);
        const text = response.content[0]?.text || '';

        assert.match(text, /Reason: Zilliz free-tier clusters are capped at 5 collections/i);
        assert.match(text, /Current Satori-managed collections \(oldest -> newest\):/i);
        assert.match(text, /\[oldest\]/i);
        assert.match(text, /\[newest\]/i);
        assert.match(text, /manage_index \{"action":"create","path":".*","zillizDropCollection":"<collection_name>"\}/i);
        assert.match(text, /Agent instructions:/i);
        assert.match(text, /Do not auto-delete without explicit user confirmation/i);
    });
});

test('handleIndexCodebase keeps generic limit message for non-Zilliz backend', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers } = createHandlersForValidation({
            backendProvider: 'milvus',
            checkCollectionLimitImpl: async () => false,
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        assert.equal(response.isError, true);
        assert.equal(response.content[0]?.text, COLLECTION_LIMIT_MESSAGE);
    });
});

test('handleIndexCodebase supports explicit zillizDropCollection for user-selected eviction', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers, droppedCollections } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            collectionDetails: [
                { name: 'hybrid_code_chunks_deadbeef', createdAt: '2026-01-01T00:00:00.000Z' }
            ],
            metadataByCollection: {
                hybrid_code_chunks_deadbeef: { codebasePath: '/repo/stale' }
            },
            hasCollectionImpl: async (collectionName) => collectionName === 'hybrid_code_chunks_deadbeef',
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            zillizDropCollection: 'hybrid_code_chunks_deadbeef'
        });

        assert.equal(response.isError, undefined);
        const text = response.content[0]?.text || '';
        assert.match(text, /Dropped Zilliz collection 'hybrid_code_chunks_deadbeef'/i);
        assert.equal(droppedCollections.length, 1);
        assert.equal(droppedCollections[0], 'hybrid_code_chunks_deadbeef');
    });
});

test('handleIndexCodebase force reindex drops all prior collections for the same codebase hash', async () => {
    await withTempRepo(async (repoPath) => {
        const resolvedCollection = resolveCollectionName(repoPath);
        const hash = resolvedCollection.split('_').pop()!;
        const legacyCollection = `code_chunks_${hash}`;
        const modernCollection = `hybrid_code_chunks_${hash}`;
        const existingCollections = new Set<string>([legacyCollection, modernCollection]);

        const { handlers, droppedCollections } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => true,
            collectionDetails: [
                { name: legacyCollection, createdAt: '2026-01-01T00:00:00.000Z' },
                { name: modernCollection, createdAt: '2026-01-02T00:00:00.000Z' },
                { name: 'hybrid_code_chunks_unrelated', createdAt: '2026-01-03T00:00:00.000Z' },
            ],
            hasCollectionImpl: async (collectionName) => existingCollections.has(collectionName),
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            force: true
        });

        assert.equal(response.isError, undefined);
        const text = response.content[0]?.text || '';
        assert.match(text, /Force reindex cleanup dropped 2 prior collection\(s\)/i);
        assert.deepEqual(new Set(droppedCollections), new Set([legacyCollection, modernCollection]));
    });
});

test('handleIndexCodebase rejects zillizDropCollection for non-Zilliz backend', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers, droppedCollections } = createHandlersForValidation({
            backendProvider: 'milvus',
            checkCollectionLimitImpl: async () => true,
            hasCollectionImpl: async () => true,
        });

        const response = await handlers.handleIndexCodebase({
            path: repoPath,
            zillizDropCollection: 'hybrid_code_chunks_deadbeef'
        });

        assert.equal(response.isError, true);
        const text = response.content[0]?.text || '';
        assert.match(text, /only supported when connected to a Zilliz Cloud backend/i);
        assert.equal(droppedCollections.length, 0);
    });
});

test('handleIndexCodebase surfaces structured Zilliz validation errors without [object Object]', async () => {
    await withTempRepo(async (repoPath) => {
        const { handlers } = createHandlersForValidation({
            backendProvider: 'zilliz',
            checkCollectionLimitImpl: async () => {
                throw {
                    code: 401,
                    reason: 'permission denied while creating collection',
                    details: {
                        message: 'token is invalid'
                    }
                };
            }
        });

        const response = await handlers.handleIndexCodebase({ path: repoPath });
        assert.equal(response.isError, true);
        const text = response.content[0]?.text || '';
        assert.match(text, /permission denied while creating collection/i);
        assert.match(text, /token is invalid/i);
        assert.ok(!text.includes('[object Object]'));
    });
});
