import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileSynchronizer } from './synchronizer';

function diagnostic(error: unknown): Record<string, unknown> {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Source observation changed/);
    const details = /Details: (\{.*\})$/.exec(error.message);
    assert.ok(details, error.message);
    return JSON.parse(details[1]!);
}

test('POSIX literal-backslash entries do not block or alias supported source observations', {
    skip: process.platform === 'win32',
}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-source-observation-'));
    try {
        const supportedSources = new Map([
            ['normal.ts', 'export const normal = 1;\n'],
            ['a/b.ts', 'export const represented = 2;\n'],
        ]);
        fs.mkdirSync(path.join(root, 'a'));
        for (const [file, source] of supportedSources) {
            fs.writeFileSync(path.join(root, file), source);
        }
        const expectedHashes = new Map([...supportedSources].map(([file, source]) => [
            file,
            createHash('sha256').update(source).digest('hex'),
        ]));
        const synchronizer = new FileSynchronizer(root, [], ['.ts']);
        const baseline = await synchronizer.prepareChanges();
        assert.deepEqual(baseline.fileHashes, expectedHashes);

        fs.writeFileSync(path.join(root, 'a\\b.ts'), 'export const unrepresentable = 300;\n');
        const unsupportedDirectory = path.join(root, 'a\\nested');
        fs.mkdirSync(unsupportedDirectory);
        fs.writeFileSync(path.join(unsupportedDirectory, 'source.ts'), 'export const hidden = 400;\n');

        const prepared = await synchronizer.prepareChanges();
        assert.deepEqual(prepared.fileHashes, expectedHashes);
        assert.equal(prepared.changes.partialScan, false);
        assert.deepEqual(prepared.changes.unscannedDirPrefixes, []);
        await prepared.assertSourceObservationCurrent();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

for (const mutation of ['modify', 'add'] as const) {
    test(`captured source refusal identifies the ${mutation} stage and path`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-source-observation-'));
        try {
            fs.writeFileSync(path.join(root, 'original.ts'), 'export const value = 1;\n');
            const synchronizer = new FileSynchronizer(root, [], ['.ts']);
            const captured = await synchronizer.prepareChanges();
            const changedPath = mutation === 'modify' ? 'original.ts' : 'added.ts';
            fs.writeFileSync(path.join(root, changedPath), 'export const changedValue = 200;\n');
            await assert.rejects(synchronizer.prepareChanges({
                capturedFullIndexSource: {
                    fileHashes: captured.fileHashes,
                    fileStats: new Map(captured.sourceCheckpoint.fileStats),
                },
            }), (error: unknown) => {
                const details = diagnostic(error);
                assert.equal(details.stage, mutation === 'modify' ? 'captured_hash_validation' : 'captured_file_set_validation');
                assert.deepEqual(details.changedPaths, [changedPath]);
                assert.equal(details.omittedPathCount, 0);
                return true;
            });
            assert.deepEqual(synchronizer.getTrackedRelativePaths(), []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('final source refusal bounds and sorts path details without committing a checkpoint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-source-observation-'));
    try {
        const paths = Array.from({ length: 12 }, (_, i) => `file-${String(i).padStart(2, '0')}.ts`);
        for (const file of paths) fs.writeFileSync(path.join(root, file), 'export const value = 1;\n');
        const synchronizer = new FileSynchronizer(root, [], ['.ts']);
        const prepared = await synchronizer.prepareChanges();
        await prepared.assertSourceObservationCurrent();
        for (const file of [...paths].reverse()) {
            fs.writeFileSync(path.join(root, file), 'export const changedValue = 200;\n');
        }
        fs.unlinkSync(path.join(root, paths[0]!));
        fs.writeFileSync(path.join(root, 'new.ts'), 'export const newValue = 1;\n');
        await assert.rejects(prepared.assertSourceObservationCurrent(), (error: unknown) => {
            const details = diagnostic(error);
            assert.equal(details.stage, 'final_observation');
            assert.deepEqual(details.changedPaths, paths.slice(0, 10));
            assert.equal(details.omittedPathCount, 3);
            assert.equal(details.partialScan, false);
            return true;
        });
        assert.deepEqual(synchronizer.getTrackedRelativePaths(), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
