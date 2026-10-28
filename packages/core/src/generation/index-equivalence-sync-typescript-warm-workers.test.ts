import test from 'node:test';

import { SYNC_EQUIVALENCE_SETTINGS, TS_CROSS_PROJECT_EDITS, assertSyncMatchesFullIndex, tsCrossProject } from './index-equivalence-harness';

test('worker warm sync after cross-project TypeScript edits publishes the same state as a full index', { timeout: 300_000 }, async () => {
    await assertSyncMatchesFullIndex('typescript-warm-workers', tsCrossProject(), TS_CROSS_PROJECT_EDITS, false, false, [SYNC_EQUIVALENCE_SETTINGS.workers]);
});
