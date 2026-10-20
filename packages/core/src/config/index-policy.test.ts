import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_INDEXED_SOURCE_FILE_BYTES,
    classifyFilePathByPolicy,
    isIndexableFileObservationByPolicy,
} from './index-policy';
import { ALL_TEXT_INDEX_MARKER, DEFAULT_SUPPORTED_EXTENSIONS } from './defaults';

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
    const binary = Buffer.concat([Buffer.from('#!/bin/sh\n'), Buffer.from([0, 1, 2, 0xff])]);
    assert.equal(await isIndexableFileObservationByPolicy('bin/installer', binary.length, ['.ts'], async () => binary), false);
});

test('path-only policy rejects only files whose observation cannot admit them', async () => {
    const fixtures = [
        { filePath: 'known.ts', extensions: ['.ts'], decision: 'unsure' },
        { filePath: 'excluded.py', extensions: ['.ts'], decision: 'reject' },
        { filePath: 'unknown.cgi', extensions: ['.ts'], decision: 'unsure' },
        { filePath: 'script', extensions: ['.ts'], decision: 'unsure' },
        { filePath: 'Makefile', extensions: ['.ts'], decision: 'unsure' },
        { filePath: 'go.mod', extensions: DEFAULT_SUPPORTED_EXTENSIONS, decision: 'unsure' },
        { filePath: 'Cargo.toml', extensions: ['.ts'], decision: 'unsure' },
        { filePath: 'excluded.py', extensions: [ALL_TEXT_INDEX_MARKER], decision: 'unsure' },
        { filePath: 'asset.js', extensions: ['.js'], decision: 'unsure' },
    ];
    for (const fixture of fixtures) {
        assert.equal(classifyFilePathByPolicy(fixture.filePath, fixture.extensions), fixture.decision, fixture.filePath);
        if (fixture.decision === 'reject') {
            for (const content of ['plain text\n', '#!/usr/bin/env python3\nprint(1)\n']) {
                const bytes = Buffer.from(content);
                assert.equal(await isIndexableFileObservationByPolicy(
                    fixture.filePath, bytes.length, fixture.extensions, async () => bytes,
                ), false);
            }
        }
    }
});
