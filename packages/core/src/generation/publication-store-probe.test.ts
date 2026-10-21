import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeCurrentPublicationForPath, resolvePublicationGenerationRoot } from './publication-store';

function writeCurrent(stateRoot: string, canonicalRoot: string, version = 2): void {
    const generationRoot = resolvePublicationGenerationRoot(canonicalRoot, 'current', stateRoot);
    fs.mkdirSync(generationRoot, { recursive: true });
    fs.writeFileSync(path.join(generationRoot, 'publication.json'), JSON.stringify({
        version,
        id: 'current',
        canonicalRoot,
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'partial',
        policy: {
            profile: 'default', customExtensions: [], customIgnorePatterns: [],
            fileBasedIgnorePatterns: [], supportedExtensions: ['.ts'], effectiveIgnorePatterns: [],
            policyHash: 'test-policy', controlSignature: 'test-control',
        },
        format: { indexFormatVersion: 'test', embeddingIdentity: 'test', relationshipVersion: 'test' },
        vector: { collectionName: 'test-collection', indexedFiles: 0, totalChunks: 0 },
        packageOwnership: false,
        navigation: null,
    }));
    fs.writeFileSync(
        path.join(path.dirname(path.dirname(generationRoot)), 'current.json'),
        JSON.stringify({ version: 1, publicationId: 'current' }),
    );
}

function listFiles(directory: string): string[] {
    return fs.readdirSync(directory, { recursive: true, encoding: 'utf8' }).sort();
}

test('probe resolves the nearest indexed ancestor without writing state', (t) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-probe-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateRoot = path.join(directory, 'state');
    const root = path.join(directory, 'repo');
    const nested = path.join(root, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    writeCurrent(stateRoot, root);
    const before = listFiles(stateRoot);

    assert.deepEqual(probeCurrentPublicationForPath(nested, { stateRoot }), {
        kind: 'current', canonicalRoot: root, publicationId: 'current',
    });
    assert.deepEqual(probeCurrentPublicationForPath(root, { stateRoot }), {
        kind: 'current', canonicalRoot: root, publicationId: 'current',
    });
    assert.deepEqual(probeCurrentPublicationForPath(path.join(directory, 'other'), { stateRoot }), { kind: 'missing' });
    assert.deepEqual(listFiles(stateRoot), before);
});

test('probe reports an incompatible current Publication as incompatible', (t) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-probe-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateRoot = path.join(directory, 'state');
    const root = path.join(directory, 'repo');
    fs.mkdirSync(root);
    writeCurrent(stateRoot, root, 1);

    assert.deepEqual(probeCurrentPublicationForPath(root, { stateRoot }), {
        kind: 'incompatible', canonicalRoot: root, publicationId: 'current',
    });
});

test('probe reports missing when no state root exists', (t) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-probe-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.deepEqual(
        probeCurrentPublicationForPath(directory, { stateRoot: path.join(directory, 'absent') }),
        { kind: 'missing' },
    );
});
