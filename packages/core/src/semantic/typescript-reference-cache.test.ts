import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TypeScriptFsObservationRecorder, type TypeScriptFsObservation } from './typescript-fs-observation';
import {
    TypeScriptReferenceDeclarationCache, REFERENCE_DECLARATION_FORMAT, REFERENCE_DECLARATION_METADATA_BYTES,
    type TypeScriptReferenceCacheWitness, type TypeScriptReferenceDeclarationState,
} from './typescript-reference-cache';

const state: TypeScriptReferenceDeclarationState = { outputs: ['/lib/index.d.ts'], references: [], unproven: false };

const TEST_BUDGET = { maxFileBytes: 4 * 1024 * 1024, maxProjectBytes: 64 * 1024 * 1024 };

test('reference cache evicts the least recently used proof at its entry bound', () => {
    const cache = new TypeScriptReferenceDeclarationCache(2, 1024);
    cache.set('a', 'one', state);
    cache.set('b', 'one', state);
    assert.equal(cache.get('a', 'one'), state);
    cache.set('c', 'one', state);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('b', 'one'), undefined);
    assert.equal(cache.get('a', 'one'), state);
    assert.equal(cache.get('c', 'one'), state);
});

test('reference cache bounds retained bytes and skips oversized proofs', () => {
    const cache = new TypeScriptReferenceDeclarationCache(128, 300);
    cache.set('a', 'one', state);
    cache.set('b', 'one', state);
    assert.ok(cache.bytes <= 300);
    assert.equal(cache.size, 1);
    cache.set('huge', 'one', { ...state, outputs: ['x'.repeat(1024)] });
    assert.equal(cache.get('huge', 'one'), undefined);
    assert.equal(cache.get('b', 'one'), state);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
});

test('reference cache invalidates changed fingerprints and replaces byte accounting', () => {
    const cache = new TypeScriptReferenceDeclarationCache(2, 1024);
    cache.set('a', 'old', state);
    const bytes = cache.bytes;
    cache.set('a', 'new', state);
    assert.equal(cache.bytes, bytes);
    assert.equal(cache.get('a', 'old'), undefined);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
});

const WITNESS: TypeScriptReferenceCacheWitness = { providerVersion: 'provider-v1', compilerVersion: '7.1.0-beta' };

function tempRoot(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-reference-cache-')));
}

function write(root: string, file: string, text: string): void {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
}

/** The saved document of one discovery root; the cache owns this naming. */
function metadataPath(stateDirectory: string, root: string): string {
    const normalized = path.resolve(root).replace(/\\/g, '/');
    return path.join(stateDirectory, `${createHash('sha256').update(normalized).digest('hex')}.reference-declarations.json`);
}

type ObservationRead = string | {
    readonly path: string;
    readonly role?: 'source' | 'metadata';
    readonly content?: string | Buffer;
};

function observe(
    root: string,
    input: {
        paths?: readonly string[];
        realpaths?: readonly string[];
        reads?: readonly ObservationRead[];
        listings?: readonly string[];
    } = {},
): TypeScriptFsObservation {
    const recorder = new TypeScriptFsObservationRecorder();
    for (const file of input.paths ?? []) recorder.recordPath(path.join(root, file));
    for (const file of input.realpaths ?? []) recorder.recordRealpath(path.join(root, file));
    for (const read of input.reads ?? []) {
        const file = typeof read === 'string' ? read : read.path;
        const role = typeof read === 'string' ? 'source' : read.role ?? 'source';
        const content = typeof read === 'string' || read.content === undefined
            ? fs.readFileSync(path.join(root, file))
            : read.content;
        recorder.recordRead(path.join(root, file), content);
        if (role === 'source') recorder.recordSourceRead(path.join(root, file));
    }
    for (const directory of input.listings ?? []) recorder.recordListing(path.join(root, directory));
    const observation = recorder.capture();
    assert.ok(observation, 'the fixture stays inside the witness bounds');
    return observation;
}

/** Writes one proven entry for `root` and returns the saved document path. */
function warm(stateDirectory: string, root: string, entry = state): { readonly config: string; readonly fingerprint: string; readonly observation: TypeScriptFsObservation; readonly file: string } {
    const config = path.join(root, 'lib/tsconfig.json');
    const fingerprint = 'fingerprint-one';
    const observation = observe(root, {
        paths: ['lib/src/index.ts', 'lib/src/math.ts', 'lib/dist/missing.d.ts'],
        realpaths: ['lib/src/index.ts'],
        reads: ['lib/src/index.ts', 'lib/src/math.ts'],
        listings: ['lib', 'lib/src'],
    });
    const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
        stateDirectory,
        resourceBudget: TEST_BUDGET,
    });
    cache.load(root, WITNESS);
    cache.set(config, fingerprint, entry, observation);
    cache.flush();
    return { config, fingerprint, observation, file: metadataPath(stateDirectory, root) };
}

function reload(stateDirectory: string, root: string): TypeScriptReferenceDeclarationCache {
    const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
        stateDirectory,
        resourceBudget: TEST_BUDGET,
    });
    cache.load(root, WITNESS);
    return cache;
}

function fixture(): string {
    const root = tempRoot();
    write(root, 'lib/tsconfig.json', JSON.stringify({ compilerOptions: { composite: true } }));
    write(root, 'lib/src/index.ts', 'export const index = 1;\n');
    write(root, 'lib/src/math.ts', 'export const math = 2;\n');
    return root;
}

test('reference cache loads the saved proof of its discovery root into a new instance', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    try {
        const saved = warm(stateDirectory, root);
        assert.ok(fs.statSync(saved.file).isFile(), 'a proven entry is saved');

        const reloaded = reload(stateDirectory, root);
        assert.deepEqual(reloaded.get(saved.config, saved.fingerprint), state);
        assert.equal(reloaded.size, 1);
        assert.equal(reloaded.get(saved.config, 'other-fingerprint'), undefined);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache treats a malformed saved document as empty', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    const config = path.join(root, 'lib/tsconfig.json');
    const observation = observe(root, { reads: ['lib/src/index.ts'] });
    try {
        const saved = warm(stateDirectory, root);
        const document = JSON.parse(fs.readFileSync(saved.file, 'utf8')) as { witness: string };
        assert.equal(typeof document.witness, 'string');
        const headers = [
            'not json at all',
            '{"format":2,"witness":"x","entries":[',
            JSON.stringify({ format: REFERENCE_DECLARATION_FORMAT + 1, witness: document.witness, entries: [] }),
            JSON.stringify({ format: 1, witness: document.witness, entries: [] }),
            JSON.stringify({ format: REFERENCE_DECLARATION_FORMAT, witness: 'foreign-root', entries: [] }),
            JSON.stringify({ format: REFERENCE_DECLARATION_FORMAT, witness: document.witness, entries: { config } }),
        ];
        const entries = [
            { configPath: config, fingerprint: 'p', outputs: 'nope', references: [], observation },
            {
                configPath: config, fingerprint: 'p', outputs: [], references: [],
                observation: { ...observation, reads: [['x']] },
            },
            {
                configPath: config, fingerprint: 'p', outputs: [], references: [],
                observation: { ...observation, readDigest: 'nope' },
            },
            {
                configPath: config, fingerprint: 'p', outputs: [], references: [],
                observation: { probes: [['/tmp/x', 'unknown-kind']], realpaths: [], reads: [], readDigest: observation.readDigest, listings: [] },
            },
            { configPath: '', fingerprint: 'p', outputs: [], references: [], observation },
        ].map((entry) => JSON.stringify({
            format: REFERENCE_DECLARATION_FORMAT,
            witness: document.witness,
            entries: [entry],
        }));
        for (const body of [...headers, ...entries]) {
            fs.writeFileSync(saved.file, body, 'utf8');
            const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
                stateDirectory,
                resourceBudget: TEST_BUDGET,
            });
            cache.load(root, WITNESS);
            assert.equal(cache.get(saved.config, saved.fingerprint), undefined, body.slice(0, 40));
            assert.equal(cache.size, 0, body.slice(0, 40));
        }
        fs.writeFileSync(saved.file, 'a'.repeat(REFERENCE_DECLARATION_METADATA_BYTES + 1), 'utf8');
        const oversized = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory });
        oversized.load(root, WITNESS);
        assert.equal(oversized.size, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache rejects a saved proof from another compiler, provider or root', () => {
    const root = fixture();
    const other = tempRoot();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    try {
        const saved = warm(stateDirectory, root);
        const witnesses: TypeScriptReferenceCacheWitness[] = [
            { ...WITNESS, compilerVersion: '7.2.0' },
            { ...WITNESS, providerVersion: 'provider-v2' },
        ];
        for (const witness of witnesses) {
            const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory });
            cache.load(root, witness);
            assert.equal(cache.get(saved.config, saved.fingerprint), undefined);
        }
        const movedRoot = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory });
        movedRoot.load(other, WITNESS);
        assert.equal(movedRoot.size, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(other, { recursive: true, force: true });
    }
});

test('reference cache never saves an unproven or failed proof', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    try {
        const config = path.join(root, 'lib/tsconfig.json');
        const observation = observe(root, { reads: ['lib/src/index.ts'] });
        const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory });
        cache.load(root, WITNESS);
        cache.set(config, 'unproven', { outputs: [], references: [], unproven: true }, observation);
        cache.set(`${config}-failure`, 'failed', {
            outputs: [], references: [], unproven: true, resourceFailure: 'TypeScript semantic source is too large.',
        }, observation);
        cache.set(`${config}-plain`, 'plain', { outputs: ['/lib/index.d.ts'], references: [], unproven: false });
        cache.flush();
        assert.equal(fs.existsSync(metadataPath(stateDirectory, root)), false);
        assert.equal(cache.get(config, 'unproven')?.unproven, true, 'memory still serves the unproven proof');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache leaves no partial or temporary document when saving fails', (t) => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    try {
        const saved = warm(stateDirectory, root);
        const document = fs.readFileSync(saved.file, 'utf8');
        fs.rmSync(saved.file);
        t.mock.method(console, 'warn', () => undefined);

        const save = () => {
            const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory });
            cache.load(root, WITNESS);
            cache.set(saved.config, saved.fingerprint, state, saved.observation);
            cache.flush();
        };

        t.mock.method(fs, 'writeFileSync', () => { throw new Error('disk is full'); });
        save();
        t.mock.restoreAll();
        assert.equal(fs.existsSync(saved.file), false, 'a failed write leaves no document');
        assert.deepEqual(fs.readdirSync(stateDirectory), [], 'a failed write leaves no temporary file');

        t.mock.method(console, 'warn', () => undefined);
        t.mock.method(fs, 'renameSync', () => { throw new Error('rename is not permitted'); });
        save();
        t.mock.restoreAll();
        assert.equal(fs.existsSync(saved.file), false, 'a failed rename leaves no document');
        assert.deepEqual(fs.readdirSync(stateDirectory), [], 'a failed rename removes its temporary file');

        fs.writeFileSync(saved.file, document, 'utf8');
        const reloaded = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: TEST_BUDGET,
        });
        reloaded.load(root, WITNESS);
        assert.deepEqual(reloaded.get(saved.config, saved.fingerprint), state);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache serves only one complete document when two writers race', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    try {
        const saved = warm(stateDirectory, root);
        const other = path.join(root, 'app/tsconfig.json');
        const otherState: TypeScriptReferenceDeclarationState = { outputs: ['/app/main.d.ts'], references: [], unproven: false };
        const second = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: TEST_BUDGET,
        });
        second.load(root, WITNESS);
        second.set(other, 'fingerprint-two', otherState, saved.observation);
        second.flush();
        const third = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: TEST_BUDGET,
        });
        third.load(root, WITNESS);
        assert.deepEqual(third.get(other, 'fingerprint-two'), otherState, 'the last complete snapshot wins');
        const document = fs.readFileSync(saved.file, 'utf8');
        assert.doesNotThrow(() => JSON.parse(document) as unknown);
        fs.writeFileSync(saved.file, document.slice(0, Math.floor(document.length / 2)), 'utf8');
        const partial = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: TEST_BUDGET,
        });
        partial.load(root, WITNESS);
        assert.equal(partial.size, 0, 'a partially written document is never read');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache revalidates an observed path, listing, realpath and admission before reuse', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    const config = path.join(root, 'lib/tsconfig.json');
    const observation = observe(root, {
        paths: ['lib/src/index.ts', 'lib/dist/absent.d.ts'],
        realpaths: ['lib/src/math.ts'],
        reads: ['lib/src/index.ts', 'lib/src/math.ts'],
        listings: ['lib/src'],
    });
    const budget = { maxFileBytes: 4 * 1024 * 1024, maxProjectBytes: 64 * 1024 * 1024 };
    const reuse = (limits = budget) => {
        const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: limits,
        });
        cache.load(root, WITNESS);
        cache.set(config, 'p', state, observation);
        cache.flush();
        const reloaded = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: limits,
        });
        reloaded.load(root, WITNESS);
        return reloaded.get(config, 'p');
    };
    try {
        assert.deepEqual(reuse(), state, 'an unchanged project reuses its proof');

        write(root, 'lib/src/index.ts', 'export const index = 1;\nexport const more = 2;\n');
        assert.equal(reuse(), undefined, 'changed read contents invalidate the proof');
        write(root, 'lib/src/index.ts', 'export const index = 1;\n');
        assert.deepEqual(reuse(), state, 'restoring the observed contents restores reuse');

        write(root, 'lib/dist/absent.d.ts', 'export {};\n');
        assert.equal(reuse(), undefined, 'a new file at a probed path invalidates the proof');
        fs.rmSync(path.join(root, 'lib/dist/absent.d.ts'));

        write(root, 'lib/src/extra.ts', 'export const extra = 3;\n');
        assert.equal(reuse(), undefined, 'a changed directory listing invalidates the proof');
        fs.rmSync(path.join(root, 'lib/src/extra.ts'));

        fs.rmSync(path.join(root, 'lib/src/math.ts'));
        assert.equal(reuse(), undefined, 'a removed read file invalidates the proof');
        write(root, 'lib/src/math.ts', 'export const math = 2;\n');

        fs.mkdirSync(path.join(root, 'lib/src/linked'), { recursive: true });
        fs.symlinkSync(path.join(root, 'lib/src/index.ts'), path.join(root, 'lib/src/linked/alias.ts'));
        const linked = observe(root, {
            paths: ['lib/src/index.ts', 'lib/dist/absent.d.ts'],
            realpaths: ['lib/src/linked/alias.ts'],
            reads: ['lib/src/index.ts'],
            listings: ['lib/src'],
        });
        const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory, resourceBudget: budget });
        cache.load(root, WITNESS);
        cache.set(config, 'p', state, linked);
        cache.flush();
        const before = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory, resourceBudget: budget });
        before.load(root, WITNESS);
        assert.deepEqual(before.get(config, 'p'), state);
        fs.rmSync(path.join(root, 'lib/src/linked/alias.ts'));
        fs.symlinkSync(path.join(root, 'lib/src/math.ts'), path.join(root, 'lib/src/linked/alias.ts'));
        const retargeted = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory, resourceBudget: budget });
        retargeted.load(root, WITNESS);
        assert.equal(retargeted.get(config, 'p'), undefined, 'a retargeted symlink invalidates the proof');
        fs.rmSync(path.join(root, 'lib/src/linked/alias.ts'));

        write(root, 'lib/src/big.ts', 'x'.repeat(2048));
        const bigObservation = observe(root, { reads: ['lib/src/big.ts'] });
        const tight = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: { maxFileBytes: 1024, maxProjectBytes: 64 * 1024 * 1024 },
        });
        tight.load(root, WITNESS);
        tight.set(config, 'p', state, bigObservation);
        tight.flush();
        const tightReload = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: { maxFileBytes: 1024, maxProjectBytes: 64 * 1024 * 1024 },
        });
        tightReload.load(root, WITNESS);
        assert.equal(tightReload.get(config, 'p'), undefined, 'a proof a fresh computation could not admit is not reused');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache rejects a proof after a same-size read edit', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    try {
        // `index = 1` and `index = 9` are the same byte length, so only the
        // content digest can tell the computation's input apart.
        const saved = warm(stateDirectory, root);
        assert.deepEqual(reload(stateDirectory, root).get(saved.config, saved.fingerprint), state);

        fs.writeFileSync(path.join(root, 'lib/src/index.ts'), 'export const index = 9;\n');
        assert.equal(
            reload(stateDirectory, root).get(saved.config, saved.fingerprint),
            undefined,
            'a source edit can add an import or reference, so it must invalidate the proof',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache charges a JSON program input to the source budget', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    const config = path.join(root, 'lib/tsconfig.json');
    write(root, 'lib/data.json', JSON.stringify({ filled: 'x'.repeat(200) }));
    try {
        const budget = { maxFileBytes: 64, maxProjectBytes: 8 * 1024 };
        const source = observe(root, { reads: [{ path: 'lib/data.json', role: 'source' }] });
        const metadata = observe(root, { reads: [{ path: 'lib/data.json', role: 'metadata' }] });
        const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, {
            stateDirectory,
            resourceBudget: budget,
        });
        cache.load(root, WITNESS);
        cache.set(config, 'source', state, source);
        assert.equal(
            cache.get(config, 'source'),
            undefined,
            'an imported JSON file is a program input and must fit the source budget',
        );
        cache.set(config, 'metadata', state, metadata);
        assert.deepEqual(cache.get(config, 'metadata'), state, 'package metadata keeps the transport budget');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('reference cache saves nothing when a computation observed more paths than a witness may keep', () => {
    const root = fixture();
    const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
    try {
        const recorder = new TypeScriptFsObservationRecorder();
        for (let index = 0; index < 20_001; index += 1) recorder.recordPath(path.join(root, `lib/src/generated-${index}.ts`));
        assert.equal(recorder.capture(), undefined);
        const cache = new TypeScriptReferenceDeclarationCache(128, 4 * 1024 * 1024, { stateDirectory });
        cache.load(root, WITNESS);
        cache.set(path.join(root, 'lib/tsconfig.json'), 'p', state, recorder.capture());
        cache.flush();
        assert.equal(fs.existsSync(metadataPath(stateDirectory, root)), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
