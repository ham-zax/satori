import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PotionEmbedding } from './potion-embedding';
import { PotionEmbeddingPool, defaultPotionHelperCount } from './potion-embedding-pool';

interface FakeMember {
    member: PotionEmbedding;
    maxInFlight: number;
    closed: boolean;
    release(): void;
}

// A helper that holds batches until released and, like the real worker,
// rejects a batch beyond its pending capacity of 2 batches.
function fakeMember(id: number): FakeMember {
    let inFlight = 0;
    let waiting: Array<() => void> = [];
    const state: FakeMember = {
        maxInFlight: 0,
        closed: false,
        release: () => { for (const done of waiting.splice(0)) done(); },
        member: {
            getBatchPolicy: () => ({ preferredMaxItems: 64, hardMaxItems: 64, maxConcurrentRequests: 2 }),
            getIdentity: () => ({ provider: 'Potion', model: 'fake', dimension: 256, artifactDigest: null, normalizationPolicy: 'provider_output_v1' }),
            getProvider: () => 'Potion',
            embedQuery: async () => ({ vector: [id], dimension: 256 }),
            embedDocuments: async (texts: string[]) => {
                if (inFlight >= 2) throw new Error('Potion worker queue is full.');
                inFlight++;
                state.maxInFlight = Math.max(state.maxInFlight, inFlight);
                await new Promise<void>(resolve => waiting.push(resolve));
                inFlight--;
                return texts.map(text => ({ vector: [Number(text)], dimension: 256 }));
            },
            close: async () => { state.closed = true; waiting = []; },
        } as unknown as PotionEmbedding,
    };
    return state;
}

const settle = async () => {
    for (let tick = 0; tick < 10; tick++) await new Promise(resolve => setImmediate(resolve));
};

test('defaultPotionHelperCount uses one helper per five CPUs, between 1 and 3', () => {
    assert.deepEqual([1, 4, 9, 10, 14, 15, 64].map(defaultPotionHelperCount), [1, 1, 1, 2, 2, 3, 3]);
});

test('Potion pool starts helpers only under load and never over-fills one', async () => {
    const fakes = [fakeMember(0)];
    const pool = new PotionEmbeddingPool(fakes[0].member, 3, async () => {
        const fake = fakeMember(fakes.length);
        fakes.push(fake);
        return fake.member;
    });
    assert.equal(pool.getBatchPolicy().maxConcurrentRequests, 6);

    const results = Array.from({ length: 8 }, (_, index) => pool.embedDocuments([String(index)]));
    await settle();
    assert.equal(fakes.length, 3);
    let done = false;
    void Promise.all(results).then(() => { done = true; });
    for (let round = 0; round < 20 && !done; round++) {
        for (const fake of fakes) fake.release();
        await settle();
    }
    assert.deepEqual((await Promise.all(results)).map(([vector]) => vector.vector[0]), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(fakes.every(fake => fake.maxInFlight <= 2));
    assert.ok(fakes.every(fake => fake.maxInFlight > 0), 'every started helper serves batches');
    await pool.close();
    assert.ok(fakes.every(fake => fake.closed));
});

test('Potion pool keeps serving on the running helper when another cannot start', async () => {
    const first = fakeMember(0);
    let attempts = 0;
    const pool = new PotionEmbeddingPool(first.member, 3, async () => {
        attempts++;
        throw new Error('injected helper start failure');
    });
    const results = Array.from({ length: 5 }, (_, index) => pool.embedDocuments([String(index)]));
    for (let round = 0; round < 5; round++) {
        await settle();
        first.release();
    }
    assert.deepEqual((await Promise.all(results)).map(([vector]) => vector.vector[0]), [0, 1, 2, 3, 4]);
    assert.equal(attempts, 1);
    assert.equal(first.maxInFlight, 2);
    await pool.close();
});

test('Potion pool closes a helper that finishes starting after close', async () => {
    const first = fakeMember(0);
    const late = fakeMember(1);
    let finishStart!: () => void;
    const pool = new PotionEmbeddingPool(first.member, 2, async () => {
        await new Promise<void>(resolve => { finishStart = resolve; });
        return late.member;
    });
    const results = [pool.embedDocuments(['0']), pool.embedDocuments(['1'])];
    await settle();
    const closing = pool.close();
    finishStart();
    await closing;
    assert.equal(first.closed, true);
    assert.equal(late.closed, true);
    void results;
});

const defaultRealHelperPath = path.resolve(__dirname, '../../../mcp/assets/potion/linux-x64/satori-potion');
const defaultRealModelPath = path.resolve(__dirname, '../../../mcp/assets/potion/linux-x64/model');
const realHelperPath = process.env.SATORI_POTION_TEST_HELPER
    || (process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(defaultRealHelperPath) ? defaultRealHelperPath : undefined);
const realModelPath = process.env.SATORI_POTION_TEST_MODEL
    || (process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(defaultRealModelPath) ? defaultRealModelPath : undefined);

test('pinned helper pool returns the same vectors as one helper', {
    skip: !realHelperPath || !realModelPath,
    timeout: 120_000,
}, async (t) => {
    const config = { helperPath: realHelperPath!, modelPath: realModelPath!, startupTimeoutMs: 30_000, requestTimeoutMs: 30_000 };
    const single = await PotionEmbedding.create(config);
    t.after(() => single.close());
    const pool = await PotionEmbeddingPool.create(config, 3);
    t.after(() => pool.close());
    const source = fs.readFileSync(path.join(__dirname, 'potion-embedding.ts'), 'utf8');
    const texts = Array.from({ length: 640 }, (_, index) => source.slice(index * 37, index * 37 + 200 + (index % 7) * 90));
    const batches = Array.from({ length: 10 }, (_, index) => texts.slice(index * 64, index * 64 + 64));

    const expected: number[][] = [];
    for (const batch of batches) expected.push(...(await single.embedDocuments(batch)).map(({ vector }) => vector));
    // The first round starts the extra helpers; the second round spreads over them.
    const internals = pool as unknown as { members: unknown[]; growing: Promise<void> | null };
    for (let round = 0; round < 2; round++) {
        const actual = (await Promise.all(batches.map(batch => pool.embedDocuments(batch)))).flat().map(({ vector }) => vector);
        assert.deepEqual(actual, expected);
        while (internals.growing) await internals.growing;
    }
    assert.ok(internals.members.length > 1, `pool must use more than one helper, used ${internals.members.length}`);
});
