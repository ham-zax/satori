import test from 'node:test';

import { POLYGLOT, SCRIPTED_EDITS, assertSyncMatchesFullIndex, tsMonorepo } from './index-equivalence-harness';

/** Cold sync after scripted edits matches a full index (see index-equivalence-harness.ts). */

test('cold sync after scripted edits publishes the same state as a full index of the edited tree', { timeout: 300_000 }, async () => {
    await assertSyncMatchesFullIndex('scripted-cold', { ...POLYGLOT, ...tsMonorepo(['lib']) }, SCRIPTED_EDITS, true);
});
