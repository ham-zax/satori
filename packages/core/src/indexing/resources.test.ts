import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexingResourcePlanner, restoreIndexingResourcePlan } from './resources';
import { readIndexingResourceOverrides } from '../config/indexing-resources';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

for (const scenario of [
    { name: 'unlimited cgroup', limit: 'max', host: 16, workers: 8, ts: 3 },
    { name: '2 GiB cgroup', limit: String(2 * GIB), host: 64, workers: 1, ts: 1 },
    { name: '3 GiB cgroup', limit: String(3 * GIB), host: 64, workers: 2, ts: 1 },
    { name: '4 GiB cgroup', limit: String(4 * GIB), host: 64, workers: 3, ts: 1 },
    { name: 'usage near limit', limit: String(4 * GIB), current: 3.9 * GIB, host: 64, workers: 1, ts: 1 },
    { name: 'missing cgroup (portable)', platform: 'darwin', host: 16, workers: 8, ts: 3 },
    { name: 'missing Linux files', missing: true, host: 16, workers: 1, ts: 1, warning: true },
    { name: 'small override', host: 64, override: '2048', workers: 1, ts: 1 },
    { name: 'oversized override', host: 16, override: '131072', workers: 8, ts: 3 },
    { name: 'invalid override', host: 64, override: '12oops', workers: 8, ts: 3, warning: true },
    { name: '64 GiB host', host: 64, workers: 8, ts: 3 },
    { name: '32 GiB host', host: 32, workers: 8, ts: 3 },
    { name: '2 CPUs', host: 64, cpus: 2, workers: 1, ts: 1 },
    { name: '16 CPUs', host: 64, cpus: 16, workers: 8, ts: 3 },
    { name: 'parser override precedence', limit: String(2 * GIB), host: 64, parser: '8', workers: 8, ts: 1 },
    { name: 'zero parser override', host: 64, parser: '0', workers: 0, ts: 3 },
] as const) {
    test(`resource plan: ${scenario.name}`, () => {
        const row: { platform?: string; missing?: boolean; host: number; cpus?: number; limit?: string; current?: number; override?: string; parser?: string; warning?: boolean; workers: number; ts: number } = scenario;
        const warnings: string[] = [];
        const reads: string[] = [];
        const env = { get: (name: string) => name === 'SATORI_INDEX_MEMORY_BUDGET_MB' ? row.override : row.parser };
        const plan = new IndexingResourcePlanner({
            platform: () => row.platform ?? 'linux',
            totalMemory: () => row.host * GIB,
            freeMemory: () => row.host * GIB,
            cpuCount: () => row.cpus ?? 16,
            readFile: (file) => {
                reads.push(file);
                if (row.missing) throw new Error('missing');
                if (file === '/proc/meminfo') return `MemAvailable: ${row.host * GIB / 1024} kB\n`;
                if (file === '/proc/self/cgroup') return '0::/scope/job\n';
                if (file === '/sys/fs/cgroup/scope/job/memory.max') return row.limit ?? 'max';
                if (file === '/sys/fs/cgroup/scope/job/memory.current') return String(Math.floor(row.current ?? 0));
                return 'max';
            },
        }, () => readIndexingResourceOverrides(env), (message) => warnings.push(message)).createPlan();
        assert.equal(plan.analysisWorkers, row.workers);
        assert.equal(plan.typescriptProjectConcurrency, row.ts);
        assert.equal(warnings.length, row.warning ? 1 : 0);
        if (row.warning) assert.match(warnings[0], row.missing ? /Cgroup.*conservative/ : /positive integer.*derived memory budget/);
        assert.ok(Object.isFrozen(plan));
        assert.ok(Object.isFrozen(plan.memoryBudget));
        assert.equal(plan.analysisWorkerMode, plan.budgetBytes <= 4 * GIB && plan.analysisWorkers > 0 ? 'process' : 'thread');
        assert.equal(plan.analysisProcessMaxFiles, 128);
        assert.ok(plan.analysisProcessMaxSourceBytes >= 256 * 1024 && plan.analysisProcessMaxSourceBytes <= 8 * MIB);
        assert.equal(plan.analysisLargeFileBytes, Math.floor(plan.analysisProcessMaxSourceBytes / 2));
        assert.equal(plan.burstReserveBytes, Math.ceil(plan.budgetBytes * 0.2));
        assert.ok(plan.budgetBytes <= row.host * GIB);
        if (row.override === '2048') assert.equal(plan.budgetBytes, 2 * GIB);
        if (row.platform) assert.deepEqual(reads, []);
        assert.ok(plan.queuedEmbeddingTextBytes >= MIB && plan.queuedEmbeddingTextBytes <= 64 * MIB);
    });
}

test('finite ancestor usage constrains an unlimited leaf; missing finite usage proves no headroom', () => {
    let unreadable = false;
    const planner = new IndexingResourcePlanner({
        platform: () => 'linux', totalMemory: () => 64 * GIB, freeMemory: () => 64 * GIB, cpuCount: () => 16,
        readFile: (file) => {
            if (file === '/proc/self/cgroup') return '0::/parent/leaf';
            if (file === '/sys/fs/cgroup/parent/memory.max') return String(4 * GIB);
            if (file === '/sys/fs/cgroup/parent/memory.current') {
                if (unreadable) throw new Error('unreadable');
                return String(3 * GIB);
            }
            return 'max';
        },
    }, () => ({ diagnostics: [] }));
    assert.equal(planner.createPlan().budgetBytes, GIB);
    unreadable = true;
    const plan = planner.createPlan();
    assert.equal(plan.budgetBytes, 0);
    assert.equal(plan.analysisWorkers, 1);
    assert.equal(plan.typescriptProjectConcurrency, 1);
});

test('root cgroup and fully unavailable OS data fall back without looping or raising concurrency', () => {
    const planner = new IndexingResourcePlanner({
        platform: () => 'linux', totalMemory: () => NaN, freeMemory: () => NaN, cpuCount: () => 2,
        readFile: (file) => file === '/proc/self/cgroup' ? '0::/' : 'max',
    }, () => ({ diagnostics: [] }));
    const plan = planner.createPlan();
    assert.equal(plan.budgetBytes, 2 * GIB - 256 * MIB);
    assert.equal(plan.analysisWorkers, 1);
});

for (const invalid of ['0', '-1', '1.5', '1e3', 'Infinity', ' ', '9007199254740991']) {
    test(`invalid memory override: ${JSON.stringify(invalid)}`, () => {
        const result = readIndexingResourceOverrides({ get: (name) => name === 'SATORI_INDEX_MEMORY_BUDGET_MB' ? invalid : undefined });
        assert.equal(result.budgetBytes, undefined);
        assert.equal(result.diagnostics.length, 1);
    });
}

test('the cgroup v2 hierarchy root has no memory.max; it must not mask a readable scope limit', () => {
    const warnings: string[] = [];
    const plan = new IndexingResourcePlanner({
        platform: () => 'linux', totalMemory: () => 64 * GIB, freeMemory: () => 64 * GIB, cpuCount: () => 16,
        readFile: (file) => {
            if (file === '/proc/self/cgroup') return '0::/scope';
            if (file === '/sys/fs/cgroup/scope/memory.max') return String(7 * GIB);
            if (file === '/sys/fs/cgroup/scope/memory.current') return String(GIB);
            throw Object.assign(new Error('hierarchy root has no controller files'), { code: 'ENOENT' });
        },
    }, () => ({ diagnostics: [] }), (warning) => warnings.push(warning)).createPlan();
    assert.equal(plan.budgetBytes, 6 * GIB);
    assert.equal(plan.typescriptProjectConcurrency, 3);
    assert.equal(plan.analysisWorkers, 7);
    assert.deepEqual(warnings, []);
});


test('permission errors at the hierarchy root retain the conservative fallback', () => {
    const warnings: string[] = [];
    const plan = new IndexingResourcePlanner({
        platform: () => 'linux', totalMemory: () => 64 * GIB, freeMemory: () => 64 * GIB, cpuCount: () => 16,
        readFile: (file) => {
            if (file === '/proc/self/cgroup') return '0::/scope';
            if (file === '/sys/fs/cgroup/scope/memory.max') return 'max';
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        },
    }, () => ({ diagnostics: [] }), warning => warnings.push(warning)).createPlan();
    assert.equal(plan.budgetBytes, 2 * GIB);
    assert.equal(plan.typescriptProjectConcurrency, 1);
    assert.equal(warnings.length, 1);
});

for (const scenario of [
    { name: 'v2 missing leaf limit uses ancestor headroom', membership: '0::/parent/leaf', files: {
        '/sys/fs/cgroup/parent/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/parent/memory.current': String(2 * GIB),
    }, budget: 6 * GIB, warnings: 0 },
    { name: 'v2 inactive file cache is reclaimable headroom', membership: '0::/parent/leaf', files: {
        '/sys/fs/cgroup/parent/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/parent/memory.current': String(7 * GIB),
        '/sys/fs/cgroup/parent/memory.stat': `anon ${GIB}\ninactive_file ${4 * GIB}\nactive_file ${2 * GIB}\n`,
    }, budget: 5 * GIB, warnings: 0 },
    { name: 'v2 inactive file above usage cannot exceed the limit', membership: '0::/parent/leaf', files: {
        '/sys/fs/cgroup/parent/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/parent/memory.current': String(2 * GIB),
        '/sys/fs/cgroup/parent/memory.stat': `inactive_file ${4 * GIB}\n`,
    }, budget: 8 * GIB, warnings: 0 },
    { name: 'v2 finite limit with missing usage stays zero despite cache stats', membership: '0::/parent/leaf', files: {
        '/sys/fs/cgroup/parent/memory.max': String(8 * GIB),
        '/sys/fs/cgroup/parent/memory.stat': `inactive_file ${4 * GIB}\n`,
    }, budget: 0, warnings: 0 },
    { name: 'v1 inactive file cache is reclaimable headroom', membership: '7:memory:/scope', files: {
        '/sys/fs/cgroup/memory/scope/memory.limit_in_bytes': String(8 * GIB),
        '/sys/fs/cgroup/memory/scope/memory.usage_in_bytes': String(7 * GIB),
        '/sys/fs/cgroup/memory/scope/memory.stat': `inactive_file ${GIB}\ntotal_inactive_file ${4 * GIB}\n`,
    }, budget: 5 * GIB, warnings: 0 },
    { name: 'v2 no controller files uses MemAvailable', membership: '0::/parent/leaf', files: {}, budget: 63 * GIB, warnings: 0 },
    { name: 'v2 permission error keeps conservative fallback', membership: '0::/parent/leaf', files: {
        '/sys/fs/cgroup/parent/leaf/memory.max': 'EACCES',
    }, budget: 2 * GIB, warnings: 1 },
    { name: 'v1 limited memory controller in comma list', membership: '5:cpu,cpuacct:/unrelated\n7:memory,devices:/scope', files: {
        '/sys/fs/cgroup/memory/scope/memory.limit_in_bytes': String(8 * GIB),
        '/sys/fs/cgroup/memory/scope/memory.usage_in_bytes': String(2 * GIB),
    }, budget: 6 * GIB, warnings: 0 },
    { name: 'v1 unlimited sentinel', membership: '7:memory:/scope', files: {
        '/sys/fs/cgroup/memory/scope/memory.limit_in_bytes': '9223372036854771712',
    }, budget: 63 * GIB, warnings: 0 },
    { name: 'v1 mount-root fallback', membership: '7:memory:/container/own', files: {
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(8 * GIB),
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(2 * GIB),
    }, budget: 6 * GIB, warnings: 0 },
    { name: 'neither cgroup version readable', membership: '7:memory:/scope', files: {}, budget: 2 * GIB, warnings: 1 },
    { name: 'v1 finite limit with missing usage proves zero headroom', membership: '7:memory:/scope', files: {
        '/sys/fs/cgroup/memory/scope/memory.limit_in_bytes': String(8 * GIB),
    }, budget: 0, warnings: 0 },
    { name: 'v1 permission error does not hide behind mount-root fallback', membership: '7:memory:/scope', files: {
        '/sys/fs/cgroup/memory/scope/memory.limit_in_bytes': 'EACCES',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(8 * GIB),
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(2 * GIB),
    }, budget: 2 * GIB, warnings: 1 },
    { name: 'v2 malformed content remains unknown', membership: '0::/scope', files: {
        '/sys/fs/cgroup/scope/memory.max': 'invalid',
    }, budget: 2 * GIB, warnings: 1 },
] as const) {
    test(`cgroup discovery: ${scenario.name}`, () => {
        const warnings: string[] = [];
        const files: Readonly<Record<string, string | undefined>> = scenario.files;
        const plan = new IndexingResourcePlanner({
            platform: () => 'linux', totalMemory: () => 64 * GIB, freeMemory: () => 32 * GIB, cpuCount: () => 16,
            readFile: file => {
                if (file === '/proc/self/cgroup') return scenario.membership;
                if (file === '/proc/meminfo') return `MemAvailable: ${64 * GIB / 1024} kB\n`;
                const content = files[file];
                if (content === 'EACCES') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
                if (content === undefined) throw Object.assign(new Error('missing controller file'), { code: 'ENOENT' });
                return content;
            },
        }, () => ({ diagnostics: [] }), warning => warnings.push(warning)).createPlan();
        assert.equal(plan.budgetBytes, scenario.budget);
        assert.equal(warnings.length, scenario.warnings);
        if (scenario.warnings) assert.match(warnings[0], /Cgroup.*conservative 2 GiB/);
    });
}

test('mutation IPC restores the same frozen resource plan and rejects malformed limits', async () => {
    const planner = new IndexingResourcePlanner({
        platform: () => 'linux', readFile: file => file === '/proc/self/cgroup' ? '0::/' : 'max',
        totalMemory: () => 64 * GIB, freeMemory: () => 2 * GIB, cpuCount: () => 16,
    }, () => ({ diagnostics: [] }));
    const plan = planner.createPlan();
    assert.equal(plan.mutationMallocArenaMax, 2);
    assert.equal(plan.releaseSemanticBeforeResolution, true);
    const restored = restoreIndexingResourcePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(restored, plan);
    assert.ok(Object.isFrozen(restored));
    assert.ok(Object.isFrozen(restored.memoryBudget));
    for (const invalid of [undefined, { ...plan, analysisProcessMaxFiles: 0 }, { ...plan, analysisWorkerMode: 'invalid' }, { ...plan, mutationMallocArenaMax: -1 }]) {
        assert.throws(() => restoreIndexingResourcePlan(invalid), /Invalid indexing resource plan/);
    }
});
