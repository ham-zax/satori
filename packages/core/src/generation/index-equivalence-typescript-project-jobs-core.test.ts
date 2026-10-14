import test from 'node:test';
import { assertToggleEquivalence, tsMonorepo } from './index-equivalence-harness';

// Branch inputs: several configured projects; built, missing and partially
// built reference outputs; an inferred project; and a config-diagnostic failure.
// The baseline is the unchanged in-process analyzer. Compare all published
// symbols, relationships, shard manifests, claims, and coverage diagnostics.
// Each built state has its own file so each file stays inside the time budget.
test('isolated project jobs preserve publication with references built: core', { timeout: 120_000 }, async () => {
    await assertToggleEquivalence('ts-jobs-core', {
        ...tsMonorepo(['core']),
        'loose.ts': 'export function loose() { return 7; }\nexport const value = loose();\n',
        'broken/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'invalid-target', types: [] }, include: ['*.ts'] }),
        'broken/run.ts': 'export function broken() { return 9; }\nexport const value = broken();\n',
    });
});
