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

test('extensionless scripts with a recognized shebang are admitted by every profile', async () => {
    const script = Buffer.from('#!/usr/bin/env python3\nprint("hi")\n');
    const plain = Buffer.from('just some notes\n');
    assert.equal(await isIndexableFileObservationByPolicy('bin/deploy', script.length, ['.ts'], async () => script), true);
    assert.equal(await isIndexableFileObservationByPolicy('bin/notes', plain.length, ['.ts'], async () => plain), false);
    const unknown = Buffer.from('#!/usr/bin/env tclsh\n');
    assert.equal(await isIndexableFileObservationByPolicy('bin/tk', unknown.length, ['.ts'], async () => unknown), false);
    assert.equal(await isIndexableFileObservationByPolicy('cgi/report.cgi', script.length, ['.ts'], async () => script), true);
});
