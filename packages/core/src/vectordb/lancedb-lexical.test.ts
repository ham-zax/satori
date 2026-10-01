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

test('LanceDB scopes with large path lists return the same candidates as the pushed-down filter', async () => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-post-filter-'));
    const database = new LanceDbVectorDatabase({ databasePath });
    try {
        await database.createHybridCollection('post_filter', 2);
        const words = ['cache', 'invalidation', 'render', 'effect', 'hook'];
        const files = Array.from({ length: 12 }, (_, index) => `src/file-${index}.${index % 3 === 0 ? 'md' : 'ts'}`);
        const documents = files.flatMap((relativePath, fileIndex) => Array.from({ length: 6 }, (_, chunkIndex) => {
            // Few distinct vectors and texts, so scores tie across files and at limit boundaries.
            const variant = (fileIndex + chunkIndex) % 4;
            const content = words.slice(0, variant + 2).join(' ');
            return {
                document: {
                    id: `doc-${fileIndex}-${chunkIndex}`, vector: [1, variant / 4], content, relativePath,
                    startLine: chunkIndex + 1, endLine: chunkIndex + 1,
                    fileExtension: path.extname(relativePath), metadata: {},
                },
                projections: buildSearchProjections({
                    relativePath,
                    chunk: { content, metadata: { startLine: chunkIndex + 1, endLine: chunkIndex + 1 } },
                }),
            };
        }));
        await database.writeDocuments('post_filter', documents);
        await database.finalizeCollectionForSearch('post_filter');

        const absent = Array.from({ length: 300 }, (_, index) => `absent/file-${index}.ts`);
        const scopes = [files.slice(0, 9), files.slice(4, 5), files.filter((_, index) => index % 2 === 0)];
        for (const scope of scopes) {
            for (const withExtension of [false, true]) {
                const filterFor = (values: string[]) => {
                    const paths = { kind: 'in' as const, field: 'relativePath' as const, values };
                    return withExtension
                        ? { kind: 'and' as const, operands: [paths, { kind: 'comparison' as const, field: 'fileExtension' as const, operator: 'ne' as const, value: '.md' }] }
                        : paths;
                };
                // The padded list crosses the in-memory threshold; the bare list is pushed down.
                const pushedDown = filterFor(scope);
                const postFiltered = filterFor([...absent, ...scope]);
                for (const limit of [1, 3, 10, 80]) {
                    const label = `${scope.length} files, extension=${withExtension}, limit=${limit}`;
                    for (const minimumScore of [undefined, 0.99]) {
                        const request = { vector: [1, 0.3], limit, minimumScore };
                        assertSameCandidates(
                            await database.retrieveDense('post_filter', { ...request, filter: postFiltered }),
                            await database.retrieveDense('post_filter', { ...request, filter: pushedDown }),
                            `dense ${label}, minimumScore=${minimumScore}`,
                        );
                    }
                    for (const matchMode of ['all_terms', 'any_terms'] as const) {
                        const request = { query: 'cache render effect', limit, matchMode };
                        assertSameCandidates(
                            await database.retrieveLexical('post_filter', { ...request, filter: postFiltered }),
                            await database.retrieveLexical('post_filter', { ...request, filter: pushedDown }),
                            `lexical ${label}, ${matchMode}`,
                        );
                    }
                }
            }
        }
    } finally {
        await database.close();
        fs.rmSync(databasePath, { recursive: true, force: true });
    }
});

test('LanceDB falls back to the pushed-down filter when a large scope is too selective for the in-memory window', async () => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-lancedb-post-filter-fallback-'));
    const database = new LanceDbVectorDatabase({ databasePath });
    try {
        await database.createHybridCollection('post_filter_fallback', 2);
        // Dense score falls as the index rises; the scope holds only the lowest-scoring files.
        const rowCount = 4400;
        const relativePathOf = (index: number) => `src/file-${String(index).padStart(5, '0')}.ts`;
        await database.writeDocuments('post_filter_fallback', Array.from({ length: rowCount }, (_, index) => {
            const relativePath = relativePathOf(index);
            const content = `chunk ${index}`;
            return {
                document: {
                    id: `doc-${String(index).padStart(5, '0')}`, vector: [1, index / 100], content, relativePath,
                    startLine: 1, endLine: 1, fileExtension: '.ts', metadata: {},
                },
                projections: buildSearchProjections({ relativePath, chunk: { content, metadata: { startLine: 1, endLine: 1 } } }),
            };
        }));
        await database.finalizeCollectionForSearch('post_filter_fallback');

        const scope = Array.from({ length: 300 }, (_, offset) => relativePathOf(rowCount - 300 + offset));
        const dense = await database.retrieveDense('post_filter_fallback', {
            vector: [1, 0], limit: 5, filter: { kind: 'in', field: 'relativePath', values: scope },
        });
        assert.deepEqual(dense.map((candidate) => candidate.document.relativePath), scope.slice(0, 5));
    } finally {
        await database.close();
        fs.rmSync(databasePath, { recursive: true, force: true });
    }
});

function assertSameCandidates(
    actual: readonly { document: { id: string }; score: number }[],
    expected: readonly { document: { id: string }; score: number }[],
    label: string,
): void {
    assert.deepEqual(actual.map((candidate) => candidate.document.id), expected.map((candidate) => candidate.document.id), label);
    assert.deepEqual(actual.map((candidate) => candidate.score), expected.map((candidate) => candidate.score), label);
}
