import test from 'node:test';
import { IndexingResourcePlanner } from '../indexing/resources';
import { assertResourcePlanEquivalence, tsMonorepo } from './index-equivalence-harness';

test('small and large plans reach full-index and sync stages and publish identical evidence', { timeout: 120_000 }, async () => {
    const plans = [2, 64].map((gib) => new IndexingResourcePlanner({
        platform: () => 'darwin', readFile: () => { throw new Error('stages must not read proc'); },
        totalMemory: () => 64 * 1024 ** 3, freeMemory: () => gib * 1024 ** 3, cpuCount: () => 16,
    }, () => ({ diagnostics: [] })).createPlan());
    await assertResourcePlanEquivalence({
        ...tsMonorepo(['core']),
        'loose.ts': 'export const loose = 7;\n',
        'broken/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'invalid-target', types: [] }, include: ['*.ts'] }),
        'broken/run.ts': 'export const broken = 9;\n',
    }, plans);
});
