import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileSynchronizer } from './synchronizer';
import { SynchronizerRegistry, type PublicationSourceComparison } from './synchronizer-registry';
import type { PublicationSourceCheckpoint } from './snapshot-codec';

function freeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
function registry(): SynchronizerRegistry {
    return new SynchronizerRegistry({
        canonicalizeCodebasePath: (root) => root,
        getCurrentPublicationSourceCheckpoint: () => null,
        getActiveIgnorePatterns: () => [],
        getIndexedExtensionsForCodebase: () => ['.ts'],
        loadIndexProfileForCodebase: () => undefined,
        resolveCollectionName: (root) => root,
    });
}
async function fixture(run: (root: string, checkpoint: PublicationSourceCheckpoint) => Promise<void>): Promise<void> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-registry-')));
    try {
        fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;\n');
        await run(root, (await new FileSynchronizer(root, [], ['.ts']).prepareChanges()).sourceCheckpoint);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
async function results(comparison: PublicationSourceComparison) {
    return Promise.all([
        comparison.comparePathsToOwnedCheckpoint(['source.ts']),
        comparison.compareAllSourceToOwnedCheckpoint(),
        comparison.compareSourceObservationToOwnedCheckpoint(),
    ]);
}

test('frozen identity reuses construction while comparisons observe real changes and deletion', async () => {
    await fixture(async (root, checkpoint) => {
        freeze(checkpoint);
        const owner = registry();
        const cached = owner.getPublicationSourceComparison(root, checkpoint, [], ['.ts']);
        assert.equal(owner.getPublicationSourceComparison(root, checkpoint, [], ['.ts']), cached);
        const uncached = () => new FileSynchronizer(root, [], ['.ts'], { sourceCheckpoint: checkpoint });
        assert.deepEqual(await results(cached), await results(uncached()));
        assert.deepEqual(await results(cached), Array(3).fill({ status: 'matches' }));
        fs.writeFileSync(path.join(root, 'source.ts'), 'export const changed = 200;\n');
        assert.deepEqual(await results(cached), await results(uncached()));
        assert.deepEqual(await results(cached), Array(3).fill({ status: 'differs' }));
        fs.unlinkSync(path.join(root, 'source.ts'));
        assert.deepEqual(await results(cached), await results(uncached()));
    });
});

test('reload and pinned/current checkpoint generations remain independent and root checked', async () => {
    await fixture(async (root, checkpoint) => {
        freeze(checkpoint);
        const owner = registry();
        const pinned = owner.getPublicationSourceComparison(root, checkpoint, [], ['.ts']);
        const reload = freeze(JSON.parse(JSON.stringify(checkpoint)) as PublicationSourceCheckpoint);
        assert.notEqual(owner.getPublicationSourceComparison(root, reload, [], ['.ts']), pinned);
        fs.writeFileSync(path.join(root, 'source.ts'), 'export const nextGeneration = 200;\n');
        const next = freeze((await new FileSynchronizer(root, [], ['.ts']).prepareChanges()).sourceCheckpoint);
        const current = owner.getPublicationSourceComparison(root, next, [], ['.ts']);
        assert.notEqual(current, pinned);
        assert.deepEqual(await results(current), await results(new FileSynchronizer(root, [], ['.ts'], { sourceCheckpoint: next })));
        assert.deepEqual(await results(current), Array(3).fill({ status: 'matches' }));
        assert.deepEqual(await results(pinned), Array(3).fill({ status: 'differs' }));
        assert.equal(owner.getPublicationSourceComparison(root, checkpoint, [], ['.ts']), pinned);
        assert.throws(() => owner.getPublicationSourceComparison(path.join(root, 'other'), checkpoint, [], ['.ts']), /root does not match/);
    });
});

test('ignore and extension policy changes rebuild and match uncached results', async () => {
    await fixture(async (root, checkpoint) => {
        freeze(checkpoint);
        const owner = registry();
        let previous = owner.getPublicationSourceComparison(root, checkpoint, [], ['.ts']);
        for (const [ignores, extensions] of [[['source.ts'], ['.ts']], [[], ['.js']]] as const) {
            const changed = owner.getPublicationSourceComparison(root, checkpoint, ignores, extensions);
            assert.notEqual(changed, previous);
            assert.equal(owner.getPublicationSourceComparison(root, checkpoint, [...ignores], [...extensions]), changed);
            assert.deepEqual(await results(changed), await results(new FileSynchronizer(root, [...ignores], [...extensions], { sourceCheckpoint: checkpoint })));
            assert.deepEqual(await results(changed), Array(3).fill({ status: 'differs' }));
            previous = changed;
        }
    });
});

test('mutable and shallow frozen checkpoints never cache and hash mutation changes admission', async () => {
    await fixture(async (root, checkpoint) => {
        const owner = registry();
        for (const shallow of [false, true]) {
            const mutable = JSON.parse(JSON.stringify(checkpoint)) as PublicationSourceCheckpoint;
            if (shallow) Object.freeze(mutable);
            const first = owner.getPublicationSourceComparison(root, mutable, [], ['.ts']);
            assert.notEqual(owner.getPublicationSourceComparison(root, mutable, [], ['.ts']), first);
            mutable.fileHashes[0]![1] = '0'.repeat(64);
            const changed = owner.getPublicationSourceComparison(root, mutable, [], ['.ts']);
            assert.deepEqual(await first.comparePathsToOwnedCheckpoint(['source.ts']), { status: 'matches' });
            assert.deepEqual(await results(changed), await results(new FileSynchronizer(root, [], ['.ts'], { sourceCheckpoint: mutable })));
            assert.deepEqual(await changed.comparePathsToOwnedCheckpoint(['source.ts']), { status: 'differs' });
        }
    });
});

test('registered mutable synchronizer commits cannot advance comparison source authority', async () => {
    await fixture(async (root, checkpoint) => {
        freeze(checkpoint);
        const owner = registry();
        const mutable = new FileSynchronizer(root, [], ['.ts'], { sourceCheckpoint: checkpoint });
        owner.registerSynchronizerForPublication('collection', 'pinned', mutable);
        const comparison = owner.getPublicationSourceComparison(root, checkpoint, [], ['.ts']);
        assert.notEqual(comparison, mutable);
        assert.equal(owner.getSynchronizerForPublication('collection', 'pinned'), mutable);
        fs.writeFileSync(path.join(root, 'source.ts'), 'export const advanced = 200;\n');
        await (await mutable.prepareChanges()).commit();
        assert.deepEqual(await mutable.comparePathsToOwnedCheckpoint(['source.ts']), { status: 'matches' });
        assert.deepEqual(await comparison.comparePathsToOwnedCheckpoint(['source.ts']), { status: 'differs' });
        owner.clearSynchronizerForCollection('collection');
        assert.equal(owner.getPublicationSourceComparison(root, checkpoint, [], ['.ts']), comparison);
        assert.equal(owner.getActiveSynchronizers().size, 0);
    });
});

test('uncertain frozen accessor witnesses stay uncached and frozen invalid checkpoints still validate', async () => {
    await fixture(async (root, checkpoint) => {
        const owner = registry();
        freeze(checkpoint);
        const accessor = Object.freeze({
            ...checkpoint,
            get fileHashes() { return checkpoint.fileHashes; },
        });
        assert.notEqual(
            owner.getPublicationSourceComparison(root, accessor, [], ['.ts']),
            owner.getPublicationSourceComparison(root, accessor, [], ['.ts']),
        );
        const invalid = freeze({ ...checkpoint, fileHashes: [['source.ts', 'invalid']] }) as PublicationSourceCheckpoint;
        assert.throws(() => owner.getPublicationSourceComparison(root, invalid, [], ['.ts']), /Invalid publication source hash/);
    });
});

// Alias ownership depends only on object identity, with no filesystem state.
function fakeSynchronizer(): FileSynchronizer {
    return {} as FileSynchronizer;
}

test('four fresh generations retain only two current aliases and clearing family retires both', () => {
    const owner = registry();
    for (let generation = 0; generation < 4; generation++) {
        const synchronizer = fakeSynchronizer();
        const physical = `physical-${generation}`;
        const publicationId = `publication-${generation}`;
        owner.registerSynchronizerForPublication(physical, publicationId, synchronizer);
        owner.registerSynchronizerForPublication('family', publicationId, synchronizer);
        assert.deepEqual(owner.getActiveSynchronizers(), new Map([[physical, synchronizer], ['family', synchronizer]]));
        for (let previous = 0; previous < generation; previous++) {
            assert.equal(owner.getMutationTarget(`physical-${previous}`), undefined);
        }
        assert.equal(owner.getMutationTarget('family'), undefined);
        owner.setMutationTarget(physical, 'target');
        owner.setMutationTarget('family', 'target');
    }
    owner.clearSynchronizerForCollection('family');
    assert.equal(owner.getActiveSynchronizers().size, 0);
    for (let generation = 0; generation < 4; generation++) {
        assert.equal(owner.getMutationTarget(`physical-${generation}`), undefined);
    }
    assert.equal(owner.getMutationTarget('family'), undefined);
});

test('clearing physical retires its family and preserves other roots and unrelated targets', () => {
    const owner = registry();
    const first = fakeSynchronizer();
    const other = fakeSynchronizer();
    for (const [key, synchronizer] of [['physical', first], ['family', first], ['other-physical', other], ['other-family', other]] as const) {
        owner.registerSynchronizerForPublication(key, 'publication', synchronizer);
        owner.setMutationTarget(key, 'destination');
    }
    owner.setMutationTarget('unrelated', 'physical');
    owner.clearSynchronizerForCollection('physical');
    assert.deepEqual(owner.getActiveSynchronizers(), new Map([['other-physical', other], ['other-family', other]]));
    assert.equal(owner.getMutationTarget('physical'), undefined);
    assert.equal(owner.getMutationTarget('family'), undefined);
    assert.equal(owner.getMutationTarget('other-physical'), 'destination');
    assert.equal(owner.getMutationTarget('other-family'), 'destination');
    assert.equal(owner.getMutationTarget('unrelated'), 'physical');
    owner.setMutationTarget('unregistered', 'destination');
    owner.clearSynchronizerForCollection('unregistered');
    assert.equal(owner.getMutationTarget('unregistered'), undefined);
    assert.equal(owner.getMutationTarget('unrelated'), 'physical');
    assert.equal(owner.getActiveSynchronizers().size, 2);
});

test('same object and publication preserve sibling aliases and their targets', () => {
    const owner = registry();
    const synchronizer = fakeSynchronizer();
    owner.registerSynchronizerForPublication('physical', 'publication', synchronizer);
    owner.registerSynchronizerForPublication('family', 'publication', synchronizer);
    owner.setMutationTarget('physical', 'physical-target');
    owner.setMutationTarget('family', 'family-target');
    owner.registerSynchronizerForPublication('family', 'publication', synchronizer);
    assert.deepEqual(owner.getActiveSynchronizers(), new Map([['physical', synchronizer], ['family', synchronizer]]));
    assert.equal(owner.getMutationTarget('physical'), 'physical-target');
    assert.equal(owner.getMutationTarget('family'), undefined);
});

test('same object advancing publication retires old aliases and their targets only', () => {
    const owner = registry();
    const synchronizer = fakeSynchronizer();
    const other = fakeSynchronizer();
    owner.registerSynchronizerForPublication('physical-old', 'old', synchronizer);
    owner.registerSynchronizerForPublication('family', 'old', synchronizer);
    owner.registerSynchronizerForPublication('other-root', 'other', other);
    for (const key of ['physical-old', 'family', 'other-root']) owner.setMutationTarget(key, 'target');
    owner.registerSynchronizerForPublication('physical-new', 'new', synchronizer);
    assert.deepEqual(owner.getActiveSynchronizers(), new Map([['other-root', other], ['physical-new', synchronizer]]));
    assert.equal(owner.getSynchronizerForPublication('physical-new', 'new'), synchronizer);
    assert.equal(owner.getMutationTarget('physical-old'), undefined);
    assert.equal(owner.getMutationTarget('family'), undefined);
    assert.equal(owner.getMutationTarget('other-root'), 'target');
});

test('replacement retires displaced object but preserves candidate aliases and other roots', () => {
    const owner = registry();
    const active = fakeSynchronizer();
    const candidate = fakeSynchronizer();
    const other = fakeSynchronizer();
    owner.registerSynchronizerForPublication('active-physical', 'active', active);
    owner.registerSynchronizerForPublication('family', 'active', active);
    owner.registerSynchronizerForPublication('candidate-physical', 'candidate', candidate);
    owner.registerSynchronizerForPublication('other-root', 'other', other);
    for (const key of ['active-physical', 'family', 'candidate-physical', 'other-root', 'unrelated']) {
        owner.setMutationTarget(key, `${key}-target`);
    }
    owner.registerSynchronizerForPublication('family', 'candidate', candidate);
    assert.deepEqual(owner.getActiveSynchronizers(), new Map([
        ['candidate-physical', candidate], ['other-root', other], ['family', candidate],
    ]));
    assert.equal(owner.getMutationTarget('active-physical'), undefined);
    assert.equal(owner.getMutationTarget('family'), undefined);
    for (const key of ['candidate-physical', 'other-root', 'unrelated']) {
        assert.equal(owner.getMutationTarget(key), `${key}-target`);
    }
});

test('recreate without authority retires aliases; required authority failure preserves them', async () => {
    const owner = registry();
    const synchronizer = fakeSynchronizer();
    const other = fakeSynchronizer();
    owner.registerSynchronizerForPublication('physical', 'publication', synchronizer);
    owner.registerSynchronizerForPublication('family', 'publication', synchronizer);
    owner.registerSynchronizerForPublication('other-root', 'other', other);
    for (const key of ['physical', 'family', 'other-root']) owner.setMutationTarget(key, 'target');
    await assert.rejects(owner.recreateSynchronizerForCodebase('family', () => assert.fail('no authority'), {
        requireAuthorityCheckpoint: true,
    }), /no current Publication source checkpoint/);
    assert.equal(owner.getActiveSynchronizers().size, 3);
    await owner.recreateSynchronizerForCodebase('family', () => assert.fail('no authority'));
    assert.deepEqual(owner.getActiveSynchronizers(), new Map([['other-root', other]]));
    assert.equal(owner.getMutationTarget('physical'), undefined);
    assert.equal(owner.getMutationTarget('family'), undefined);
    assert.equal(owner.getMutationTarget('other-root'), 'target');
});
