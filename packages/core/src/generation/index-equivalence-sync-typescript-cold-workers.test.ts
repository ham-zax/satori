import test from 'node:test';

import { SYNC_EQUIVALENCE_SETTINGS, TS_CROSS_PROJECT_EDITS, assertSyncMatchesFullIndex, tsCrossProject } from './index-equivalence-harness';

test('worker cold sync after cross-project TypeScript edits publishes the same state as a full index', { timeout: 300_000 }, async () => {
    await assertSyncMatchesFullIndex('typescript-cold-workers', tsCrossProject(), TS_CROSS_PROJECT_EDITS, true, false, [SYNC_EQUIVALENCE_SETTINGS.workers]);
});
