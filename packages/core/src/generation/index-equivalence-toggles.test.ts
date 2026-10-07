import test from 'node:test';

import { POLYGLOT, assertToggleEquivalence, tsMonorepo } from './index-equivalence-harness';

/** Execution-toggle equivalence (see index-equivalence-harness.ts). */

test('execution toggles publish identical results for Go, Rust, and Python', { timeout: 300_000 }, async () => {
    await assertToggleEquivalence('polyglot', POLYGLOT);
});

for (const [state, built] of [
    ['built', ['core', 'lib']],
    ['unbuilt', []],
    ['partly built', ['core']],
    ['indirect chain unbuilt', ['lib']],
] as const) {
    test(`execution toggles publish identical results for a TypeScript monorepo (${state})`, { timeout: 300_000 }, async () => {
        await assertToggleEquivalence(`ts-${state.replace(/\s+/g, '-')}`, tsMonorepo(built));
    });
}
