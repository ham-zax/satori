import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSearchProjections } from '../core/search-projections.js';
import { LanceDbVectorDatabase } from './lancedb-vectordb.js';

test('LanceDB lexical retrieval folds case and stems, so lowercase terms match camelCase identifiers and word forms', async () => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-lexical-'));
    const database = new LanceDbVectorDatabase({ databasePath });
    try {
        const content = 'function commitHookEffectListUnmount(flags) {\n  // Skips re-rendering.\n  useEffect(destroy);\n}';
        const chunk = {
            content,
            metadata: { startLine: 1, endLine: 4, language: 'javascript', symbolLabel: 'commitHookEffectListUnmount' },
        };
        await database.createHybridCollection('lexical_case', 2);
        await database.writeDocuments('lexical_case', [{
            document: {
                id: 'doc-1',
                vector: [1, 0],
                content,
                relativePath: 'src/effects.js',
                startLine: 1,
                endLine: 4,
                fileExtension: '.js',
                metadata: {},
            },
            projections: buildSearchProjections({ chunk: chunk as never, relativePath: 'src/effects.js' }),
        }]);
        await database.finalizeCollectionForSearch('lexical_case');

        for (const query of ['useeffect', 'unmount', 'effect', 'CommitHookEffectListUnmount', 'renders']) {
            const candidates = await database.retrieveLexical('lexical_case', { query, limit: 5, matchMode: 'any_terms' });
            assert.deepEqual(candidates.map((candidate) => candidate.document.id), ['doc-1'], query);
        }
    } finally {
        await database.close();
        fs.rmSync(databasePath, { recursive: true, force: true });
    }
});

test('LanceDB retrieves identifier prefixes and joined compounds without requiring an exact whole token', async () => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-prefix-'));
    const database = new LanceDbVectorDatabase({ databasePath });
    try {
        await database.createHybridCollection('prefix_compound', 2);
        const content = 'function bailoutOnAlreadyFinishedWork() { return keep_alive; }';
        await database.writeDocuments('prefix_compound', [{
            document: {
                id: 'owner', vector: [1, 0], content, relativePath: 'src/work.js',
                startLine: 1, endLine: 1, fileExtension: '.js', metadata: {},
            },
            projections: buildSearchProjections({
                relativePath: 'src/work.js',
                chunk: { content, metadata: { startLine: 1, endLine: 1, symbolLabel: 'bailoutOnAlreadyFinishedWork' } },
            }),
        }]);
        await database.finalizeCollectionForSearch('prefix_compound');
        for (const query of ['bail', 'bailout', 'keepalive', 'keep alive']) {
            const candidates = await database.retrieveLexical('prefix_compound', { query, limit: 5, matchMode: 'all_terms' });
            assert.deepEqual(candidates.map((candidate) => candidate.document.id), ['owner'], query);
        }
    } finally {
        await database.close();
        fs.rmSync(databasePath, { recursive: true, force: true });
    }
});

test('LanceDB applies a scoped file filter before limiting dense and lexical candidates', async () => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-scope-'));
    const database = new LanceDbVectorDatabase({ databasePath });
    try {
        await database.createHybridCollection('scoped', 2);
        await database.writeDocuments('scoped', ['src/cache.ts', 'docs/cache.md'].map((relativePath, index) => {
            const content = 'cache invalidation';
            return {
                document: {
                    id: `doc-${index}`, vector: index === 0 ? [1, 0] : [0.9, 0.1],
                    content, relativePath, startLine: 1, endLine: 1,
                    fileExtension: index === 0 ? '.ts' : '.md', metadata: {},
                },
                projections: buildSearchProjections({ relativePath, chunk: { content, metadata: { startLine: 1, endLine: 1 } } }),
            };
        }));
        await database.finalizeCollectionForSearch('scoped');
        const filter = { kind: 'in' as const, field: 'relativePath' as const, values: ['docs/cache.md'] };
        const dense = await database.retrieveDense('scoped', { vector: [1, 0], limit: 1, filter });
        const lexical = await database.retrieveLexical('scoped', { query: 'cache invalidation', limit: 1, filter });
        assert.deepEqual(dense.map((candidate) => candidate.document.relativePath), ['docs/cache.md']);
        assert.deepEqual(lexical.map((candidate) => candidate.document.relativePath), ['docs/cache.md']);
    } finally {
        await database.close();
        fs.rmSync(databasePath, { recursive: true, force: true });
    }
});
