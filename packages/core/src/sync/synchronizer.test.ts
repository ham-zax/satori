import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareContractStrings } from '../utils/compare-contract-strings';
import { FileSynchronizer } from './synchronizer';

// F-D2: snapshot JSON array order must use compareContractStrings, not localeCompare.
test('FileSynchronizer snapshot JSON key order is independent of String.prototype.localeCompare', async () => {
    const prevHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-snap-home-'));
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-sync-snap-repo-'));

    try {
        process.env.HOME = tempHome;
        const names = [
            'å.ts',
            'z.ts',
            'A.ts',
            'a.ts',
            'file-2.ts',
            'file-10.ts',
            'café.ts',
            'cafe.ts',
        ];
        for (const name of names) {
            fs.writeFileSync(path.join(tempRepo, name), `export const x = '${name}';\n`, 'utf8');
        }

        const syncA = new FileSynchronizer(tempRepo, [], ['.ts']);
        await syncA.initialize();
        const snapshotPath = FileSynchronizer.getSnapshotPathForCodebase(tempRepo);
        const baselineRaw = fs.readFileSync(snapshotPath, 'utf8');
        const baseline = JSON.parse(baselineRaw) as { fileHashes: Array<[string, string]> };
        const baselineKeys = baseline.fileHashes.map(([relPath]) => relPath);
        const expectedKeys = [...names].sort(compareContractStrings);
        assert.deepEqual(baselineKeys, expectedKeys);

        fs.unlinkSync(snapshotPath);

        const original = String.prototype.localeCompare;
        String.prototype.localeCompare = function patchedLocaleCompare(that: string): number {
            if (String(this) === that) {
                return 0;
            }
            return String(this) < that ? 1 : -1;
        };

        try {
            const syncB = new FileSynchronizer(tempRepo, [], ['.ts']);
            await syncB.initialize();
            const poisonedRaw = fs.readFileSync(snapshotPath, 'utf8');
            const poisoned = JSON.parse(poisonedRaw) as { fileHashes: Array<[string, string]> };
            assert.deepEqual(
                poisoned.fileHashes.map(([relPath]) => relPath),
                baselineKeys,
                'snapshot fileHashes order must not depend on String.prototype.localeCompare',
            );
            assert.equal(poisonedRaw, baselineRaw);
        } finally {
            String.prototype.localeCompare = original;
        }
    } finally {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempRepo, { recursive: true, force: true });
        fs.rmSync(tempHome, { recursive: true, force: true });
    }
});
