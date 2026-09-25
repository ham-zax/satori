import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_INDEXED_SOURCE_FILE_BYTES,
    isIndexableFileObservationByPolicy,
} from './index-policy';

test('explicitly supported source extensions respect the searchable per-file byte budget', async () => {
    const probe = async () => Buffer.from('export const value = 1;');

    assert.equal(
        await isIndexableFileObservationByPolicy(
            'src/value.ts',
            MAX_INDEXED_SOURCE_FILE_BYTES,
            ['.ts'],
            probe,
        ),
        true,
    );
    assert.equal(
        await isIndexableFileObservationByPolicy(
            'src/generated.ts',
            MAX_INDEXED_SOURCE_FILE_BYTES + 1,
            ['.ts'],
            probe,
        ),
        false,
    );
});
