import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPublicationSourceCheckpoint,
    publicationSourceCheckpointState,
} from './snapshot-codec';

const HASH = 'a'.repeat(64);

test('source checkpoint round-trips pre-epoch timestamps', () => {
    const root = '/repo';
    const signature = { size: 3, mtimeMs: -315619200000, ctimeMs: -315619200000 };
    const checkpoint = buildPublicationSourceCheckpoint(root, {
        fileHashes: new Map([['old.ts', HASH]]),
        fileStats: new Map([['old.ts', signature]]),
        unprocessedPaths: [],
    });
    assert.deepEqual(publicationSourceCheckpointState(checkpoint).fileStats.get('old.ts'), signature);
});

test('source checkpoint still rejects non-finite timestamps and negative sizes', () => {
    for (const signature of [
        { size: -1, mtimeMs: 1, ctimeMs: 1 },
        { size: 1, mtimeMs: Number.NaN, ctimeMs: 1 },
        { size: 1, mtimeMs: 1, ctimeMs: Number.POSITIVE_INFINITY },
    ]) {
        assert.throws(() => buildPublicationSourceCheckpoint('/repo', {
            fileHashes: new Map([['a.ts', HASH]]),
            fileStats: new Map([['a.ts', signature]]),
            unprocessedPaths: [],
        }), /Invalid publication source stat/);
    }
});
