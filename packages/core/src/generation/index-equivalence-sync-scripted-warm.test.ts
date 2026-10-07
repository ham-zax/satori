import test from 'node:test';

import { POLYGLOT, SCRIPTED_EDITS, assertSyncMatchesFullIndex, tsMonorepo } from './index-equivalence-harness';

/** Warm sync after scripted edits matches a full index (see index-equivalence-harness.ts). */

test('warm sync after scripted edits publishes the same state as a full index of the edited tree', { timeout: 300_000 }, async () => {
    await assertSyncMatchesFullIndex('scripted-warm', { ...POLYGLOT, ...tsMonorepo(['lib']) }, SCRIPTED_EDITS, false);
});
