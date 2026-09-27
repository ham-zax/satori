import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicationStateCache } from './publication-state-cache';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const retainOk = (value: string) => value === 'ok';

test('concurrent reads share one load and a non-retainable result is retried', async () => {
    const cache = new PublicationStateCache<string>({ maxRoots: 4, idleMs: 0 });
    const gate = deferred<string>();
    let loads = 0;
    const load = () => { loads += 1; return loads === 1 ? gate.promise : Promise.resolve('ok'); };
    const first = cache.get('/repo', 'a', load, retainOk);
    const second = cache.get('/repo', 'a', load, retainOk);
    assert.equal(loads, 1);
    gate.resolve('missing');
    assert.deepEqual(await Promise.all([first, second]), ['missing', 'missing']);
    assert.equal(await cache.get('/repo', 'a', load, retainOk), 'ok');
    assert.equal(loads, 2);
    await cache.get('/repo', 'a', load, retainOk);
    assert.equal(loads, 2);
});

test('a rejected load is shared and evicted for retry', async () => {
    const cache = new PublicationStateCache<string>({ maxRoots: 4, idleMs: 0 });
    const gate = deferred<string>();
    let loads = 0;
    const load = () => { loads += 1; return loads === 1 ? gate.promise : Promise.resolve('ok'); };
    const outcomes = Promise.allSettled([
        cache.get('/repo', 'a', load, retainOk),
        cache.get('/repo', 'a', load, retainOk),
    ]);
    gate.reject(new Error('read failed'));
    assert.deepEqual((await outcomes).map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(await cache.get('/repo', 'a', load, retainOk), 'ok');
    assert.equal(loads, 2);
});

test('a newer Publication replaces the older one and a stale load cannot evict it', async () => {
    const cache = new PublicationStateCache<string>({ maxRoots: 4, idleMs: 0 });
    const old = deferred<string>();
    const stale = cache.get('/repo', 'a', () => old.promise, retainOk);
    await cache.get('/repo', 'b', async () => 'ok', retainOk);
    assert.equal(cache.has('/repo', 'a'), false);
    old.resolve('missing');
    await stale;
    assert.equal(cache.has('/repo', 'b'), true);
    assert.equal(cache.size, 1);
});

test('roots beyond the cap are released least-recently-used first', async () => {
    const cache = new PublicationStateCache<string>({ maxRoots: 2, idleMs: 0 });
    const load = async () => 'ok';
    await cache.get('/a', 'p', load, retainOk);
    await cache.get('/b', 'p', load, retainOk);
    await cache.get('/a', 'p', load, retainOk);
    await cache.get('/c', 'p', load, retainOk);
    assert.equal(cache.has('/a', 'p'), true);
    assert.equal(cache.has('/b', 'p'), false);
    assert.equal(cache.has('/c', 'p'), true);
});

test('idle state is released after the idle window', async () => {
    const cache = new PublicationStateCache<string>({ maxRoots: 2, idleMs: 20 });
    await cache.get('/repo', 'a', async () => 'ok', retainOk);
    assert.equal(cache.has('/repo', 'a'), true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(cache.has('/repo', 'a'), false);
});
