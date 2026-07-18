import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    POTION_DIMENSION,
    POTION_INFERENCE_CONTRACT_DIGEST,
    POTION_MODEL_ID,
    PotionEmbedding,
} from './potion-embedding.js';
import { EmbeddingProviderError } from './base-embedding.js';

type TestPotionEmbeddingConstructor = new (config: {
    helperPath: string;
    modelPath: string;
    requestTimeoutMs: number;
    startupTimeoutMs: number;
    maxBatchItems: number;
}) => PotionEmbedding;

const TestPotionEmbedding = PotionEmbedding as unknown as TestPotionEmbeddingConstructor;

test('committed L1 inference manifest matches the provider identity digest', () => {
    const manifestPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../experiments/potion-l0-l1/fixtures/inference-contract.canonical.json',
    );
    const digest = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
    assert.equal(digest, POTION_INFERENCE_CONTRACT_DIGEST);
});

const FAKE_WORKER = String.raw`#!/usr/bin/env node
const readline = require('node:readline');

process.stdout.write(JSON.stringify({
  ready: true,
  modelLoadedOnce: true,
  retainedTokenLimit: 4096,
  networkBlocked: true,
}) + '\n');

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.op === 'shutdown') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\n', () => process.exit(0));
    return;
  }
  if (request.text === '__timeout__') return;
  if (request.text === '__crash__') process.exit(17);
  if (request.text.trim() === '') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode: 'EMPTY_INPUT' }) + '\n');
    return;
  }
  if (request.text === '__all_unknown__' || request.text === '__oversized__') {
    const errorCode = request.text === '__all_unknown__' ? 'ALL_UNKNOWN_INPUT' : 'OVERSIZED_INPUT';
    process.stdout.write(JSON.stringify({ id: request.id, ok: false, errorCode }) + '\n');
    return;
  }
  let vector;
  if (request.text === '__wrong_dimensions__') {
    vector = [1];
  } else if (request.text === '__zero__') {
    vector = Array(256).fill(0);
  } else if (request.text === '__non_finite__') {
    vector = [null, ...Array(255).fill(0)];
  } else if (request.text === '__unnormalized__') {
    vector = [2, ...Array(255).fill(0)];
  } else {
    const angle = (Buffer.byteLength(request.text, 'utf8') % 100) / 100;
    vector = [Math.cos(angle), Math.sin(angle), ...Array(254).fill(0)];
  }
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    retainedTokenCount: 1,
    vector,
  }) + '\n');
});
`;

async function createFakeEmbedding(
    t: TestContext,
    overrides: { requestTimeoutMs?: number; maxBatchItems?: number } = {},
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
});

test('Potion provider preserves the frozen identity and exact symmetric input', async (t) => {
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
        model: POTION_MODEL_ID,
        dimension: POTION_DIMENSION,
        artifactDigest: POTION_INFERENCE_CONTRACT_DIGEST,
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

test('Potion provider classifies native invalid input without exposing source text', async (t) => {
    const embedding = await createFakeEmbedding(t);
    for (const input of ['', '__all_unknown__', '__oversized__']) {
        await assert.rejects(
            embedding.embedQuery(input),
            (error: unknown) => error instanceof EmbeddingProviderError
                && error.code === 'EMBEDDING_PROVIDER_INVALID_REQUEST'
                && !error.message.includes(input || 'source text'),
        );
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

test('Potion artifact verification fails closed before worker startup', async () => {
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

const realHelperPath = process.env.SATORI_POTION_TEST_HELPER;
const realModelPath = process.env.SATORI_POTION_TEST_MODEL;

test('pinned L1 helper satisfies the Core provider contract', {
    skip: !realHelperPath || !realModelPath,
}, async (t) => {
    const embedding = await PotionEmbedding.create({
        helperPath: realHelperPath as string,
        modelPath: realModelPath as string,
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
