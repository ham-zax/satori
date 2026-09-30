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
