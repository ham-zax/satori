import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PublicationStore, resolvePublicationGenerationRoot } from './publication-store';
import { RootMutationRuntime, getRootMutationCoordinator } from './root-mutation-runtime';

const INCOMPATIBLE_ID = 'legacy-publication';

/** Lays out a current Publication whose descriptor is from a previous format version. */
function writeIncompatibleCurrent(tempRoot: string, repoRoot: string): { stateRoot: string; generationRoot: string } {
    const stateRoot = path.join(tempRoot, 'state');
    const generationRoot = resolvePublicationGenerationRoot(repoRoot, INCOMPATIBLE_ID, stateRoot);
    fs.mkdirSync(generationRoot, { recursive: true });
    fs.writeFileSync(
        path.join(generationRoot, 'publication.json'),
        JSON.stringify({ version: 1, id: INCOMPATIBLE_ID, canonicalRoot: repoRoot }),
    );
    fs.writeFileSync(
        path.join(path.dirname(path.dirname(generationRoot)), 'current.json'),
        JSON.stringify({ version: 1, publicationId: INCOMPATIBLE_ID }),
    );
    return { stateRoot, generationRoot };
}

function withFixture(run: (input: {
    repoRoot: string;
    stateRoot: string;
    generationRoot: string;
    createStore: () => PublicationStore;
}) => void | Promise<void>): () => Promise<void> {
    return async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-incompatible-publication-'));
        const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'repo-')));
        const runtime = new RootMutationRuntime({
            stateDir: path.join(tempRoot, 'mutations'),
            ownerId: 'incompatible-publication-test',
        });
        try {
            const { stateRoot, generationRoot } = writeIncompatibleCurrent(tempRoot, repoRoot);
            await run({
                repoRoot,
                stateRoot,
                generationRoot,
                createStore: () => new PublicationStore({
                    stateRoot,
                    mutationCoordinator: getRootMutationCoordinator(runtime),
                }),
            });
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    };
}

test('a store starts with an incompatible current Publication and leaves its generation on disk', withFixture(
    ({ createStore, generationRoot }) => {
        assert.doesNotThrow(() => createStore());
        assert.ok(fs.existsSync(path.join(generationRoot, 'publication.json')));
    },
));

test('the current-state reader reports an incompatible current Publication without parsing it', withFixture(
    ({ createStore, repoRoot }) => {
        const store = createStore();
        assert.deepEqual(store.getCurrentState(repoRoot), { kind: 'incompatible', publicationId: INCOMPATIBLE_ID });
        assert.equal(store.getCurrent(repoRoot), null);
        assert.equal(store.acquireCurrentRead(repoRoot), null);
        assert.deepEqual(store.listCurrent(), []);
    },
));

test('an unindexed root reports a missing current state', withFixture(({ createStore, repoRoot }) => {
    const store = createStore();
    const otherRoot = path.join(repoRoot, 'other');
    fs.mkdirSync(otherRoot);
    assert.deepEqual(store.getCurrentState(otherRoot), { kind: 'missing' });
}));
