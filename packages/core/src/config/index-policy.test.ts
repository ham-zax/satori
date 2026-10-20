import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
    MAX_INDEXED_SOURCE_FILE_BYTES,
    classifyFilePathByPolicy,
    isIndexableFileByPolicy,
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

// The promise-based probe that the synchronous probe replaced.
async function referenceIsIndexableFileByPolicy(
    relativePath: string,
    absolutePath: string,
    size: number,
    supportedExtensions: readonly string[],
): Promise<boolean> {
    let handle: fsp.FileHandle | undefined;
    try {
        return await isIndexableFileObservationByPolicy(relativePath, size, supportedExtensions, async () => {
            handle ??= await fsp.open(absolutePath, 'r');
            const buffer = Buffer.alloc(Math.min(size, 8192));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return buffer.subarray(0, bytesRead);
        });
    } finally {
        await handle?.close();
    }
}

async function outcome(run: () => Promise<boolean>): Promise<boolean | string> {
    try {
        return await run();
    } catch (error) {
        return `error:${(error as NodeJS.ErrnoException).code}`;
    }
}

test('the synchronous file probe admits exactly what the promise probe admits', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-policy-probe-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixtures: Record<string, string | Buffer> = {
        'bin/deploy': '#!/usr/bin/env python3\nprint("hi")\n',
        'bin/notes': 'just some notes\n',
        'bin/tk': '#!/usr/bin/env tclsh\n',
        'icons/fake.png': '#!/usr/bin/env python3\nprint("png")\n',
        'icons/real.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
        'docs/empty.txt': '',
        'docs/readme.unknown': 'plain text\n',
        'docs/binary.unknown': Buffer.from([0x61, 0x00, 0x62]),
        'web/bundle.min.js': `var a=${'1+'.repeat(40_000)}1;`,
        'src/value.ts': 'export const value = 1;\n',
    };
    for (const [relativePath, content] of Object.entries(fixtures)) {
        fs.mkdirSync(path.join(root, path.dirname(relativePath)), { recursive: true });
        fs.writeFileSync(path.join(root, relativePath), content);
    }
    const cases = [...Object.keys(fixtures), 'bin/missing'];
    const profiles = [['.ts', '.js'], [...DEFAULT_SUPPORTED_EXTENSIONS], [ALL_TEXT_INDEX_MARKER]];
    for (const supportedExtensions of profiles) {
        for (const relativePath of cases) {
            const absolutePath = path.join(root, relativePath);
            const size = fixtures[relativePath] === undefined ? 16 : fs.statSync(absolutePath).size;
            assert.deepEqual(
                await outcome(() => isIndexableFileByPolicy(relativePath, absolutePath, size, supportedExtensions)),
                await outcome(() => referenceIsIndexableFileByPolicy(relativePath, absolutePath, size, supportedExtensions)),
                `${relativePath} with ${supportedExtensions.slice(0, 2).join(',')}`,
            );
        }
    }
});
