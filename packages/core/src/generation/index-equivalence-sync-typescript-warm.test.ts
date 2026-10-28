import test from 'node:test';

import { SYNC_EQUIVALENCE_SETTINGS, TS_CROSS_PROJECT_EDITS, assertSyncMatchesFullIndex, tsCrossProject } from './index-equivalence-harness';

/** Warm sync after cross-project TypeScript edits matches a full index (see index-equivalence-harness.ts). */

test('serial warm sync after cross-project TypeScript edits publishes the same state as a full index', { timeout: 300_000 }, async () => {
    await assertSyncMatchesFullIndex('typescript-warm', tsCrossProject(), TS_CROSS_PROJECT_EDITS, false, false, [SYNC_EQUIVALENCE_SETTINGS.baseline]);
});
