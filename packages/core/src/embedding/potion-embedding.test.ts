import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    POTION_DIMENSION,
    POTION_MODEL_ID,
    POTION_RETAINED_TOKEN_LIMIT,
    POTION_SEMANTIC_VERSION,
    PotionEmbedding,
    restoreVerifiedOwnerExecutableBit,
} from './potion-embedding.js';
import { EmbeddingProviderError } from './base-embedding.js';

type TestPotionEmbeddingConstructor = new (config: {
    helperPath: string;
    modelPath: string;
    requestTimeoutMs: number;
    startupTimeoutMs: number;
    maxBatchItems: number;
    maxPendingItems?: number;
}) => PotionEmbedding;

const TestPotionEmbedding = PotionEmbedding as unknown as TestPotionEmbeddingConstructor;

const FAKE_WORKER = String.raw`#!/usr/bin/env node
const readline = require('node:readline');

process.stdout.write(JSON.stringify({
  ready: true,
  modelLoadedOnce: true,
  retainedTokenLimit: 4096,
  networkBlocked: true,
}) + '\n');

function encodeSingle(text) {
  if (text === '__timeout__') return { timeout: true };
  if (text === '__crash__') process.exit(17);
  if (text.trim() === '') {
    return { ok: false, errorCode: 'EMPTY_INPUT' };
  }
  if (text === '__all_unknown__' || text === '__oversized__') {
    const errorCode = text === '__all_unknown__' ? 'ALL_UNKNOWN_INPUT' : 'OVERSIZED_INPUT';
    return { ok: false, errorCode };
  }
  let vector;
  if (text === '__wrong_dimensions__') {
    vector = [1];
  } else if (text === '__zero__') {
    vector = Array(256).fill(0);
  } else if (text === '__non_finite__') {
    vector = [null, ...Array(255).fill(0)];
  } else if (text === '__unnormalized__') {
    vector = [2, ...Array(255).fill(0)];
  } else {
    const angle = (Buffer.byteLength(text, 'utf8') % 100) / 100;
    vector = [Math.cos(angle), Math.sin(angle), ...Array(254).fill(0)];
  }
  return {
    ok: true,
    retainedTokenCount: 1,
    vector,
  };
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.op === 'shutdown') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\n', () => process.exit(0));
    return;
  }
  if (request.op === 'encode_batch') {
    const delayMatch = request.texts.find((t) => typeof t === 'string' && t.startsWith('__delay_'));
    const delayMs = delayMatch ? parseInt(delayMatch.match(/__delay_(\d+)ms__/)[1], 10) : 0;
    const sendBatch = () => {
      const items = [];
      for (const text of request.texts) {
        const res = encodeSingle(text);
        if (res.timeout) return;
        if (!res.ok) {
          process.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: res.errorCode }) + '\n');
          return;
        }
        items.push({ retainedTokenCount: res.retainedTokenCount, vector: res.vector });
      }
      process.stdout.write(JSON.stringify({
        id: request.id,
        ok: true,
        items,
      }) + '\n');
    };
    if (delayMs > 0) {
      setTimeout(sendBatch, delayMs);
    } else {
      sendBatch();
    }
    return;
  }
  const delayMatch = typeof request.text === 'string' && request.text.startsWith('__delay_') ? request.text : null;
  const delayMs = delayMatch ? parseInt(delayMatch.match(/__delay_(\d+)ms__/)[1], 10) : 0;
  const sendSingle = () => {
    const res = encodeSingle(request.text);
    if (res.timeout) return;
    if (!res.ok) {
      process.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: res.errorCode }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: true,
      retainedTokenCount: res.retainedTokenCount,
      vector: res.vector,
    }) + '\n');
  };
  if (delayMs > 0) {
    setTimeout(sendSingle, delayMs);
  } else {
    sendSingle();
  }
});
`;

async function createFakeEmbedding(
    t: TestContext,
    overrides: { requestTimeoutMs?: number; maxBatchItems?: number; maxPendingItems?: number } = {},
): Promise<PotionEmbedding> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-potion-worker-'));
    const helperPath = path.join(root, 'fake-worker.cjs');
    const modelPath = path.join(root, 'model');
    fs.mkdirSync(modelPath);
    fs.writeFileSync(helperPath, FAKE_WORKER, { mode: 0o755 });
    const embedding = new TestPotionEmbedding({
        helperPath,
        modelPath,
        requestTimeoutMs: overrides.requestTimeoutMs ?? 500,
        startupTimeoutMs: 1_000,
        maxBatchItems: overrides.maxBatchItems ?? 4,
        maxPendingItems: overrides.maxPendingItems,
    });
    await (embedding as unknown as { start(): Promise<void> }).start();
    t.after(async () => {
        await embedding.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return embedding;
}

test('Potion worker limits remain bounded', () => {
    assert.throws(() => new TestPotionEmbedding({
        helperPath: '/tmp/helper',
        modelPath: '/tmp/model',
        requestTimeoutMs: 300_001,
        startupTimeoutMs: 1_000,
        maxBatchItems: 32,
    }), /no greater than 300000/);
    assert.throws(() => new TestPotionEmbedding({
        helperPath: '/tmp/helper',
        modelPath: '/tmp/model',
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
        maxBatchItems: 65,
    }), /no greater than 64/);
    assert.throws(() => new TestPotionEmbedding({
        helperPath: '/tmp/helper',
        modelPath: '/tmp/model',
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
        maxBatchItems: 1,
        maxPendingItems: 0,
    }), /pending capacity/);
    assert.throws(() => new TestPotionEmbedding({
        helperPath: '/tmp/helper',
        modelPath: '/tmp/model',
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
        maxBatchItems: 1,
        maxPendingItems: 257,
    }), /no greater than 256/);
    assert.throws(() => new TestPotionEmbedding({
        helperPath: '/tmp/helper',
        modelPath: '/tmp/model',
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
        maxBatchItems: 32,
        maxPendingItems: 8,
    }), /no smaller than the maximum batch size/);
});

test('Potion provider preserves the frozen semantic identity and exact symmetric input', async (t) => {
    const embedding = await createFakeEmbedding(t);
    const query = await embedding.embedQuery('symmetric witness');
    const [document] = await embedding.embedDocuments(['symmetric witness']);

    assert.equal(query.dimension, POTION_DIMENSION);
    assert.equal(query.vector.length, POTION_DIMENSION);
    assert.deepEqual(document, query);
    assert.ok(query.vector.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...query.vector) - 1) <= 1e-5);
    assert.deepEqual(embedding.getIdentity(), {
        provider: 'Potion',
        model: `${POTION_MODEL_ID}+${POTION_SEMANTIC_VERSION}`,
        dimension: POTION_DIMENSION,
        artifactDigest: null,
        normalizationPolicy: 'provider_output_v1',
    });
});

test('Potion provider batches on one bounded worker and preserves input order', async (t) => {
    const embedding = await createFakeEmbedding(t, { maxBatchItems: 2 });
    const vectors = await embedding.embedDocuments(['a', 'longer input']);

    assert.equal(vectors.length, 2);
    assert.notDeepEqual(vectors[0], vectors[1]);
    assert.deepEqual(await embedding.embedDocuments([]), []);
    await assert.rejects(
        embedding.embedDocuments(['a', 'b', 'c']),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_INVALID_REQUEST',
    );
});

test('Potion worker pending capacity bounds total outstanding work and recovers on completion', async (t) => {
    const embedding = await createFakeEmbedding(t, { maxBatchItems: 4, maxPendingItems: 8 });

    // Keep two 4-item batches in flight to occupy the full pending capacity
    const firstBatch = embedding.embedDocuments(['__delay_100ms__doc1', 'doc2', 'doc3', 'doc4']);
    const secondBatch = embedding.embedDocuments(['doc5', 'doc6', 'doc7', 'doc8']);

    // A 9th item while 8 are pending must immediately reject with queue full
    await assert.rejects(
        embedding.embedDocuments(['doc9']),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_INVALID_REQUEST'
            && error.message.includes('queue is full'),
    );

    // Wait for the in-flight batches to finish
    assert.equal((await firstBatch).length, 4);
    assert.equal((await secondBatch).length, 4);

    // Pending capacity is now available again
    const subsequentDocs = await embedding.embedDocuments(['doc9']);
    assert.equal(subsequentDocs.length, 1);
});

test('concurrent foreground query is accepted while a full 32-item background batch is pending', async (t) => {
    const embedding = await createFakeEmbedding(t, { maxBatchItems: 32 });

    // Hold a full 32-item document batch in flight (delayed first item keeps the
    // worker busy while the client has all 32 items pending).
    const batchTexts = ['__delay_150ms__item0', ...Array.from({ length: 31 }, (_, i) => `item${i + 1}`)];
    const batchPromise = embedding.embedDocuments(batchTexts);

    // The batch dispatch is synchronous, so all 32 items are pending here.
    // A foreground query must not be rejected as "queue is full".
    const queryPromise = embedding.embedQuery('foreground query');

    const [batchDocs, queryDoc] = await Promise.all([batchPromise, queryPromise]);
    assert.equal(batchDocs.length, 32);
    assert.equal(queryDoc.vector.length, POTION_DIMENSION);
    assert.ok(queryDoc.vector.every(Number.isFinite));
    for (const doc of batchDocs) {
        assert.equal(doc.vector.length, POTION_DIMENSION);
        assert.ok(doc.vector.every(Number.isFinite));
    }
});

test('concurrent foreground query is accepted while two full 32-item background batches are pending', async (t) => {
    const embedding = await createFakeEmbedding(t, { maxBatchItems: 32 });

    // Hold two full 32-item document batches in flight (64 items total, consuming full background pending capacity)
    const batch1Texts = ['__delay_150ms__item0', ...Array.from({ length: 31 }, (_, i) => `b1_item${i + 1}`)];
    const batch2Texts = Array.from({ length: 32 }, (_, i) => `b2_item${i}`);
    const batch1Promise = embedding.embedDocuments(batch1Texts);
    const batch2Promise = embedding.embedDocuments(batch2Texts);

    // Both batches are dispatched synchronously, so 64 items are pending.
    // A 3rd document request must be rejected as queue full:
    await assert.rejects(
        embedding.embedDocuments(['b3_item0']),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_INVALID_REQUEST'
            && error.message.includes('queue is full'),
    );

    // But a foreground query must be accepted using the reserved foreground capacity:
    const queryPromise = embedding.embedQuery('foreground query');

    const [batch1Docs, batch2Docs, queryDoc] = await Promise.all([
        batch1Promise,
        batch2Promise,
        queryPromise,
    ]);
    assert.equal(batch1Docs.length, 32);
    assert.equal(batch2Docs.length, 32);
    assert.equal(queryDoc.vector.length, POTION_DIMENSION);
    assert.ok(queryDoc.vector.every(Number.isFinite));
    for (const doc of [...batch1Docs, ...batch2Docs]) {
        assert.equal(doc.vector.length, POTION_DIMENSION);
        assert.ok(doc.vector.every(Number.isFinite));
    }
});

test('Potion provider classifies native invalid input without exposing source text', async (t) => {
    const embedding = await createFakeEmbedding(t);
    for (const input of ['', '__all_unknown__', '__oversized__']) {
        await assert.rejects(
            embedding.embedQuery(input),
            (error: unknown) => error instanceof EmbeddingProviderError
                && error.code === 'EMBEDDING_PROVIDER_INVALID_REQUEST'
                && (input.length === 0 || !error.message.includes(input)),
        );
    }
});

test('Potion provider classifies worker timeout with retryable flag', async (t) => {
    const embedding = await createFakeEmbedding(t, { requestTimeoutMs: 50 });
    await assert.rejects(
        embedding.embedQuery('__timeout__'),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_TIMEOUT'
            && error.retryable === true,
    );
});

test('Potion provider fails all pending requests when the worker crashes', async (t) => {
    const embedding = await createFakeEmbedding(t, { requestTimeoutMs: 1_000 });
    const pendingWork = embedding.embedQuery('__delay_200ms__');
    const crashTrigger = embedding.embedQuery('__crash__');

    await assert.rejects(
        crashTrigger,
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
    );
    await assert.rejects(
        pendingWork,
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
    );
    await assert.rejects(
        embedding.embedQuery('later work'),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
    );
});

test('repairs only the owner execute bit after exact helper verification', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-mode-'));
    try {
        const helper = path.join(root, 'satori-potion');
        fs.writeFileSync(helper, Buffer.from('trusted-helper'));
        fs.chmodSync(helper, 0o644);
        const expected = crypto.createHash('sha256').update('trusted-helper').digest('hex');

        await restoreVerifiedOwnerExecutableBit({
            filePath: helper,
            expectedSha256: expected,
            label: 'helper',
        });

        assert.equal(fs.statSync(helper).mode & 0o777, 0o744);
        fs.accessSync(helper, fs.constants.X_OK);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('checksum mismatch does not chmod the helper', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-mode-'));
    try {
        const helper = path.join(root, 'satori-potion');
        fs.writeFileSync(helper, Buffer.from('trusted-helper'));
        fs.chmodSync(helper, 0o644);

        await assert.rejects(
            restoreVerifiedOwnerExecutableBit({
                filePath: helper,
                expectedSha256: '0'.repeat(64),
                label: 'helper',
            }),
            (error: unknown) => error instanceof EmbeddingProviderError
                && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
        );
        assert.equal(fs.statSync(helper).mode & 0o777, 0o644);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('symlink helper is rejected before any mode repair', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-mode-'));
    try {
        const target = path.join(root, 'target');
        fs.writeFileSync(target, Buffer.from('trusted-helper'));
        fs.chmodSync(target, 0o644);
        const helper = path.join(root, 'satori-potion');
        fs.symlinkSync(target, helper);
        const expected = crypto.createHash('sha256').update('trusted-helper').digest('hex');

        await assert.rejects(
            restoreVerifiedOwnerExecutableBit({
                filePath: helper,
                expectedSha256: expected,
                label: 'helper',
            }),
            (error: unknown) => error instanceof EmbeddingProviderError
                && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
        );
        assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('directory helper is rejected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-mode-'));
    try {
        const helper = path.join(root, 'satori-potion');
        fs.mkdirSync(helper);
        await assert.rejects(
            restoreVerifiedOwnerExecutableBit({
                filePath: helper,
                expectedSha256: '0'.repeat(64),
                label: 'helper',
            }),
            (error: unknown) => error instanceof EmbeddingProviderError
                && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an already executable helper keeps its exact mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-mode-'));
    try {
        const helper = path.join(root, 'satori-potion');
        fs.writeFileSync(helper, Buffer.from('trusted-helper'));
        fs.chmodSync(helper, 0o744);
        const expected = crypto.createHash('sha256').update('trusted-helper').digest('hex');

        await restoreVerifiedOwnerExecutableBit({
            filePath: helper,
            expectedSha256: expected,
            label: 'helper',
        });

        assert.equal(fs.statSync(helper).mode & 0o777, 0o744);
        fs.accessSync(helper, fs.constants.X_OK);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Potion provider rejects malformed, zero, non-finite, and unnormalized output', async (t) => {
    const embedding = await createFakeEmbedding(t);
    for (const input of ['__wrong_dimensions__', '__zero__', '__non_finite__', '__unnormalized__']) {
        await assert.rejects(
            embedding.embedQuery(input),
            (error: unknown) => error instanceof EmbeddingProviderError
                && error.code === 'EMBEDDING_PROVIDER_ERROR',
        );
    }
});

test('Potion timeout terminates the worker and rejects later work', async (t) => {
    const embedding = await createFakeEmbedding(t, { requestTimeoutMs: 30 });
    await assert.rejects(
        embedding.embedQuery('__timeout__'),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_TIMEOUT',
    );
    await assert.rejects(
        embedding.embedQuery('later work'),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
    );
});

test('Potion worker isolation contains a native process failure', async (t) => {
    const embedding = await createFakeEmbedding(t);
    await assert.rejects(
        embedding.embedQuery('__crash__'),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
    );
    await assert.rejects(
        embedding.embedQuery('later work'),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE',
    );
});

test('Potion runtime file validation fails closed when assets are missing', {
    skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async () => {
    await assert.rejects(
        PotionEmbedding.create({
            helperPath: path.join(os.tmpdir(), 'missing-potion-helper'),
            modelPath: path.join(os.tmpdir(), 'missing-potion-model'),
        }),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE'
            && !error.message.includes(os.tmpdir()),
    );
});

test('Potion runtime file validation rejects symlink assets', {
    skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potion-validation-'));
    try {
        const realHelper = path.join(root, 'real-helper');
        const helperSymlink = path.join(root, 'satori-potion');
        const modelDir = path.join(root, 'model');
        fs.mkdirSync(modelDir);
        fs.writeFileSync(realHelper, 'helper', { mode: 0o755 });
        fs.symlinkSync(realHelper, helperSymlink);
        fs.writeFileSync(path.join(modelDir, 'model.safetensors'), 'model');
        fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), 'tokenizer');
        fs.writeFileSync(path.join(modelDir, 'config.json'), 'config');

        await assert.rejects(
            PotionEmbedding.create({
                helperPath: helperSymlink,
                modelPath: modelDir,
            }),
            (error: unknown) => error instanceof EmbeddingProviderError
                && error.code === 'EMBEDDING_PROVIDER_UNAVAILABLE'
                && error.message.includes('must be a regular file'),
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Potion batch packing correctly handles pathological escaping and near-limit inputs', async (t) => {
    const embedding = await createFakeEmbedding(t, { maxBatchItems: 32 });
    const pathological = [
        'normal text',
        'text with "quotes" and \\backslashes\\ and \n newlines \r\n and \t tabs',
        'unicode \u0000 \u001f \ufffd symbols',
        JSON.stringify({ complex: 'json', nested: { array: [1, 2, 3] } }),
    ];
    const docs = await embedding.embedDocuments(pathological);
    assert.equal(docs.length, pathological.length);

    // Single item exceeding 1 MiB is rejected
    const hugeItem = 'a'.repeat(1_048_576);
    await assert.rejects(
        embedding.embedDocuments([hugeItem]),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_INVALID_REQUEST',
    );
});

test('Potion batch subbatches and concurrent queries reserve unique request IDs without collision', async (t) => {
    const embedding = await createFakeEmbedding(t, { maxBatchItems: 64 });
    // 33 items splits into 2 native subbatches (limit 32): batch 1 has 32 items, batch 2 has 1 item.
    // batch 1 has a delayed first item so it stays in-flight while we issue a concurrent query.
    const batchTexts = ['__delay_50ms__item0', ...Array.from({ length: 32 }, (_, i) => `item${i + 1}`)];

    const batchPromise = embedding.embedDocuments(batchTexts);
    // Allow batchPromise to execute synchronous subbatch ID planning and dispatch batch 1:
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Concurrent embedQuery executes while batch 1 is in-flight:
    const queryPromise = embedding.embedQuery('concurrent query');

    const [batchDocs, queryDoc] = await Promise.all([batchPromise, queryPromise]);
    assert.equal(batchDocs.length, 33);
    assert.equal(queryDoc.vector.length, POTION_DIMENSION);
    assert.ok(queryDoc.vector.every(Number.isFinite));
    for (const doc of batchDocs) {
        assert.equal(doc.vector.length, POTION_DIMENSION);
        assert.ok(doc.vector.every(Number.isFinite));
    }
});

// @ts-expect-error TS1470: import.meta is available at test runtime under tsx.
const testModuleDirectory = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const defaultRealHelperPath = path.resolve(
    testModuleDirectory,
    '../../../mcp/assets/potion/linux-x64/satori-potion',
);
const defaultRealModelPath = path.resolve(
    testModuleDirectory,
    '../../../mcp/assets/potion/linux-x64/model',
);
const realHelperPath = process.env.SATORI_POTION_TEST_HELPER || (
    process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(defaultRealHelperPath)
        ? defaultRealHelperPath
        : undefined
);
const realModelPath = process.env.SATORI_POTION_TEST_MODEL || (
    process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(defaultRealModelPath)
        ? defaultRealModelPath
        : undefined
);
const REAL_HELPER_TEST_TIMEOUT_MS = 30_000;

test('pinned L1 helper satisfies the Core provider contract', {
    skip: !realHelperPath || !realModelPath,
}, async (t) => {
    const embedding = await PotionEmbedding.create({
        helperPath: realHelperPath as string,
        modelPath: realModelPath as string,
        startupTimeoutMs: REAL_HELPER_TEST_TIMEOUT_MS,
        requestTimeoutMs: REAL_HELPER_TEST_TIMEOUT_MS,
    });
    t.after(() => embedding.close());

    const query = await embedding.embedQuery('where is runtime configuration resolved?');
    const [document] = await embedding.embedDocuments([
        'export function resolveRuntimeConfiguration() { return config; }',
    ]);
    assert.equal(query.vector.length, POTION_DIMENSION);
    assert.equal(document.vector.length, POTION_DIMENSION);
    assert.ok(query.vector.every(Number.isFinite));
    assert.ok(document.vector.every(Number.isFinite));
});

interface RawWorkerClient {
    send(payload: Record<string, unknown>): Promise<{
        id: string;
        ok: boolean;
        items?: Array<{ retainedTokenCount: number; vector: number[] }>;
        retainedTokenCount?: number;
        vector?: number[];
        errorCode?: string;
    }>;
    close(): Promise<void>;
}

async function createRawWorkerClient(helperPath: string, modelPath: string): Promise<RawWorkerClient> {
    const child = spawn(helperPath, ['worker', modelPath, '--block-network'], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);

    let readyResolve: () => void;
    const readyPromise = new Promise<void>((resolve) => {
        readyResolve = resolve;
    });

    const pending = new Map<string, {
        resolve: (res: {
            id: string;
            ok: boolean;
            items?: Array<{ retainedTokenCount: number; vector: number[] }>;
            retainedTokenCount?: number;
            vector?: number[];
            errorCode?: string;
        }) => void;
        reject: (err: Error) => void;
    }>();
    let stdoutBuffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        while (true) {
            let leading = 0;
            while (leading < stdoutBuffer.length && stdoutBuffer[leading] <= 0x20) {
                leading += 1;
            }
            if (leading > 0) {
                stdoutBuffer = stdoutBuffer.subarray(leading);
            }
            if (stdoutBuffer.length === 0) break;
            if (stdoutBuffer[0] !== 0x7b) break;

            let depth = 0;
            let inString = false;
            let escaped = false;
            let frameEnd = -1;
            for (let i = 0; i < stdoutBuffer.length; i += 1) {
                const byte = stdoutBuffer[i];
                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (byte === 0x5c) {
                        escaped = true;
                    } else if (byte === 0x22) {
                        inString = false;
                    }
                    continue;
                }
                if (byte === 0x22) {
                    inString = true;
                } else if (byte === 0x7b || byte === 0x5b) {
                    depth += 1;
                } else if (byte === 0x7d || byte === 0x5d) {
                    depth -= 1;
                    if (depth === 0) {
                        frameEnd = i + 1;
                        break;
                    }
                    if (depth < 0) break;
                }
            }
            if (frameEnd < 0) break;
            const frame = stdoutBuffer.subarray(0, frameEnd);
            stdoutBuffer = stdoutBuffer.subarray(frameEnd);
            try {
                const parsed = JSON.parse(frame.toString('utf8'));
                if (parsed.ready === true) {
                    readyResolve();
                    continue;
                }
                if (typeof parsed.id === 'string' && pending.has(parsed.id)) {
                    const handler = pending.get(parsed.id)!;
                    pending.delete(parsed.id);
                    handler.resolve(parsed);
                }
            } catch {
                // Ignore parse errors
            }
        }
    });

    await readyPromise;

    let seq = 0;
    return {
        send(payload: Record<string, unknown>) {
            return new Promise((resolve, reject) => {
                const id = (payload.id as string) || `raw-${++seq}`;
                pending.set(id, { resolve, reject });
                child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
            });
        },
        async close() {
            child.kill('SIGKILL');
        },
    };
}

test('pinned L1 helper satisfies legacy single-encode vs native batch-encode parity and failure classification via raw worker protocol', {
    skip: !realHelperPath || !realModelPath,
}, async (t) => {
    const rawWorker = await createRawWorkerClient(realHelperPath as string, realModelPath as string);
    t.after(() => rawWorker.close());

    const testTexts = [
        'function parseChunk(content: string): Chunk[] { return []; }',
        'export const MAX_WRITE_BATCH_SIZE = 256;',
        'class LanceDbVectorDatabase implements VectorDatabase { }',
        'import * as path from "node:path";',
        'const escaped = "quotes: \\"hello\\" \\n newlines";',
        'let sum = 0; for (let i = 0; i < 100; i++) { sum += i; }',
        'SELECT symbol_key, file_path FROM symbols WHERE start_line >= 10;',
    ];

    // 1. Single op: "encode" vs single-item batch op: "encode_batch"
    for (let i = 0; i < testTexts.length; i++) {
        const text = testTexts[i];
        const singleRes = await rawWorker.send({ op: 'encode', role: 'document', text });
        const batchRes = await rawWorker.send({ op: 'encode_batch', texts: [text] });

        assert.equal(singleRes.ok, true, `singleRes must be ok for text ${i}`);
        assert.equal(batchRes.ok, true, `batchRes must be ok for text ${i}`);
        assert.equal(Array.isArray(batchRes.items), true);
        assert.equal(batchRes.items?.length, 1);

        const singleVec = singleRes.vector!;
        const batchVec = batchRes.items![0].vector;
        assert.equal(singleRes.retainedTokenCount, batchRes.items![0].retainedTokenCount);
        assert.equal(singleVec.length, POTION_DIMENSION);
        assert.equal(batchVec.length, POTION_DIMENSION);

        let maxDiff = 0;
        let dotProduct = 0;
        let normSingleSq = 0;
        let normBatchSq = 0;
        for (let j = 0; j < POTION_DIMENSION; j++) {
            const diff = Math.abs(singleVec[j] - batchVec[j]);
            if (diff > maxDiff) maxDiff = diff;
            dotProduct += singleVec[j] * batchVec[j];
            normSingleSq += singleVec[j] * singleVec[j];
            normBatchSq += batchVec[j] * batchVec[j];
        }
        const cosineSim = dotProduct / (Math.sqrt(normSingleSq) * Math.sqrt(normBatchSq));

        assert.ok(maxDiff <= 1e-6, `Max diff ${maxDiff} must be <= 1e-6 for item ${i}`);
        assert.ok(cosineSim >= 0.999999, `Cosine similarity ${cosineSim} must be >= 0.999999 for item ${i}`);
    }

    // 2. Multi-item batch against sequential singles
    const multiBatchRes = await rawWorker.send({ op: 'encode_batch', texts: testTexts });
    assert.equal(multiBatchRes.ok, true);
    assert.equal(multiBatchRes.items?.length, testTexts.length);

    for (let i = 0; i < testTexts.length; i++) {
        const singleRes = await rawWorker.send({ op: 'encode', role: 'document', text: testTexts[i] });
        const batchItem: { retainedTokenCount: number; vector: number[] } = multiBatchRes.items![i];
        assert.equal(singleRes.retainedTokenCount, batchItem.retainedTokenCount);
        assert.equal(singleRes.vector!.length, POTION_DIMENSION);
        assert.equal(batchItem.vector.length, POTION_DIMENSION);
        for (let j = 0; j < POTION_DIMENSION; j++) {
            assert.ok(
                Math.abs(singleRes.vector![j] - batchItem.vector[j]) <= 1e-6,
                `Multi-batch item ${i} dim ${j} difference exceeds 1e-6`,
            );
        }
    }

    // 3. Exact native error code parity on invalid input
    const singleEmpty = await rawWorker.send({ op: 'encode', role: 'document', text: '' });
    assert.equal(singleEmpty.ok, false);
    assert.equal(singleEmpty.errorCode, 'EMPTY_INPUT');

    const batchEmpty = await rawWorker.send({ op: 'encode_batch', texts: ['valid text', ''] });
    assert.equal(batchEmpty.ok, false);
    assert.equal(batchEmpty.errorCode, 'EMPTY_INPUT');

    // 4. Public TS adapter error classification on real helper
    const embedding = await PotionEmbedding.create({
        helperPath: realHelperPath as string,
        modelPath: realModelPath as string,
        startupTimeoutMs: REAL_HELPER_TEST_TIMEOUT_MS,
        requestTimeoutMs: REAL_HELPER_TEST_TIMEOUT_MS,
    });
    t.after(() => embedding.close());
    await assert.rejects(
        embedding.embedDocuments(['valid text', '']),
        (error: unknown) => error instanceof EmbeddingProviderError
            && error.code === 'EMBEDDING_PROVIDER_INVALID_REQUEST'
            && error.message.includes('EMPTY_INPUT'),
    );
});

test('pinned L1 helper satisfies frozen reference fixtures contract for potion_semantics_v1', {
    skip: !realHelperPath || !realModelPath,
}, async (t) => {
    const fixturesPath = path.resolve(
        testModuleDirectory,
        '../../../../experiments/potion-l0-l1/fixtures/reference-fixtures.json',
    );
    assert.ok(fs.existsSync(fixturesPath), 'Reference fixtures file must exist.');
    const fixturesContent = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

    // Assert fixture metadata matches frozen authority
    assert.equal(fixturesContent.schemaVersion, 1);
    assert.equal(fixturesContent.retainedTokenLimit, POTION_RETAINED_TOKEN_LIMIT);
    assert.equal(fixturesContent.normalization, true);
    assert.equal(fixturesContent.modelRevision, 'e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b');

    const embedding = await PotionEmbedding.create({
        helperPath: realHelperPath as string,
        modelPath: realModelPath as string,
        startupTimeoutMs: REAL_HELPER_TEST_TIMEOUT_MS,
        requestTimeoutMs: REAL_HELPER_TEST_TIMEOUT_MS,
    });
    t.after(() => embedding.close());

    for (const testCase of fixturesContent.cases) {
        let actualVector: number[];
        if (testCase.role === 'query') {
            const res = await embedding.embedQuery(testCase.text);
            actualVector = res.vector;
        } else {
            const [res] = await embedding.embedDocuments([testCase.text]);
            actualVector = res.vector;
        }

        assert.equal(actualVector.length, POTION_DIMENSION);
        assert.equal(testCase.vector.length, POTION_DIMENSION);

        let maxDiff = 0;
        let dotProduct = 0;
        let normActualSq = 0;
        let normExpectedSq = 0;

        for (let j = 0; j < POTION_DIMENSION; j++) {
            const diff = Math.abs(actualVector[j] - testCase.vector[j]);
            if (diff > maxDiff) maxDiff = diff;
            dotProduct += actualVector[j] * testCase.vector[j];
            normActualSq += actualVector[j] * actualVector[j];
            normExpectedSq += testCase.vector[j] * testCase.vector[j];
        }
        const cosineSim = dotProduct / (Math.sqrt(normActualSq) * Math.sqrt(normExpectedSq));

        assert.ok(
            maxDiff <= fixturesContent.tolerance.maxAbsoluteDifference,
            `Case ${testCase.id}: max absolute difference ${maxDiff} exceeds tolerance ${fixturesContent.tolerance.maxAbsoluteDifference}`,
        );
        assert.ok(
            cosineSim >= fixturesContent.tolerance.minimumCosineSimilarity,
            `Case ${testCase.id}: cosine similarity ${cosineSim} below minimum ${fixturesContent.tolerance.minimumCosineSimilarity}`,
        );
    }
});
