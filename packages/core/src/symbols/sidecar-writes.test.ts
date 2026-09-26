import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRelationshipSidecar } from './sidecar-reads';
import { writeRelationshipSidecar } from './sidecar-writes';

test('relationship sidecar preserves skipped semantic source files in provider coverage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-skipped-coverage-'));
    const publicationId = 'fixture-publication';
    const navigationRoot = path.join(root, publicationId, 'navigation');
    const symbolRegistryManifestHash = 'fixture-symbol-hash';
    try {
        await writeRelationshipSidecar({
            normalizedRootPath: root,
            navigationRoot,
            symbolRegistryManifestHash,
            relationshipVersion: 'fixture-version',
            builtAt: new Date(0).toISOString(),
            records: [],
            providerCoverage: [{
                language: 'rust',
                providerId: 'fixture',
                providerVersion: '1',
                status: 'degraded',
                sourceFileCount: 2,
                analyzedSourceFileCount: 1,
                skippedFiles: [
                    { path: 'z.rs', reason: 'source_too_large', bytes: 10 },
                    { path: 'a.rs', reason: 'source_too_large', bytes: 20 },
                ],
            }],
        });
        const read = await readRelationshipSidecar({
            normalizedRootPath: root,
            navigationRoot,
            publicationId,
            expectedSymbolRegistryManifestHash: symbolRegistryManifestHash,
        });
        assert.equal(read.status, 'ok');
        assert.deepEqual(read.manifest.providerCoverage[0]?.skippedFiles, [
            { path: 'a.rs', reason: 'source_too_large', bytes: 20 },
            { path: 'z.rs', reason: 'source_too_large', bytes: 10 },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
