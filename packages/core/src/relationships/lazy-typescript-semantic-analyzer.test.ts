import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { LazyTypeScriptSemanticProjectAnalyzer } from './lazy-typescript-semantic-analyzer';
import type { ResolutionProjectInput } from './resolution';
import { SYMBOL_REGISTRY_SCHEMA_VERSION } from '../symbols/contracts';
import { buildSymbolRegistry } from '../symbols/registry';
import { TypeScriptSemanticProjectAnalyzer } from './typescript-semantic-analyzer';
import { IndexingResourcePlanner } from '../indexing/resources';

test('a parallel full-index failure drains other project jobs and keeps failure precedence', { timeout: 30_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-parallel-failure-'));
    for (const project of ['one', 'two']) {
        fs.mkdirSync(path.join(root, project));
        fs.writeFileSync(path.join(root, project, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
        fs.writeFileSync(path.join(root, project, 'a.ts'), 'export const a = 1;');
    }
    const resourcePlan = new IndexingResourcePlanner({
        platform: () => 'darwin', readFile: () => { throw new Error('no proc'); },
        totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 64 * 1024 ** 3, cpuCount: () => 16,
    }, () => ({ diagnostics: [] })).createPlan();
    const analyzer = new LazyTypeScriptSemanticProjectAnalyzer();
    const original = Worker.prototype.postMessage;
    const jobs: Worker[] = [];
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => { started = resolve; });
    let secondId = 0;
    Worker.prototype.postMessage = function (message, ...args) {
        if (message.method === 'analyze') {
            jobs.push(this);
            if (jobs.length === 1) this.emit('message', { id: message.id, ok: false, error: 'first project failed' });
            else { secondId = message.id; started(); }
            return;
        }
        return original.call(this, message, ...args);
    };
    try {
        let settled = false;
        const operation = analyzer.analyze({ ...inputFor(root, ['one/a.ts', 'two/a.ts']), resourcePlan });
        operation.then(() => { settled = true; }, () => { settled = true; });
        const rejection = assert.rejects(operation, /first project failed/);
        await bothStarted;
        assert.ok(jobs.every((worker) => worker.threadId !== -1), 'plan concurrency was ignored');
        assert.equal(settled, false, 'returned while the second project was in flight');
        jobs[1].emit('message', { id: secondId, ok: false, error: 'second project failed' });
        await rejection;
        assert.ok(jobs.every((worker) => worker.threadId === -1), 'returned before project workers exited');
    } finally {
        Worker.prototype.postMessage = original;
        await analyzer.dispose();
        // Also drain explicitly recorded handles if a cleanup mutation fails.
        await Promise.all(jobs.map((worker) => worker.terminate()));
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function inputFor(root: string, files: readonly string[]): ResolutionProjectInput {
    return {
        rootPath: root,
        language: 'typescript',
        registry: buildSymbolRegistry({ manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: root,
            rootFingerprint: 'fixture', indexPolicyHash: 'fixture', languageRouterVersion: 'fixture',
            extractorVersion: 'fixture', relationshipVersion: 'fixture', builtAt: '2026-10-14T00:00:00.000Z',
            files: files.map((file) => ({ path: file, language: 'typescript', symbolCount: 0,
                definitionStatus: 'definitions_present' as const,
                hash: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })),
        }, symbols: [] }),
    };
}

test('a failed project job stops every worker before rejecting and releases no evidence', async () => {
    const analyzer = new LazyTypeScriptSemanticProjectAnalyzer();
    await analyzer.getProviderMetadata('typescript');
    const inner = await (analyzer as unknown as {
        analyzerPromise: Promise<{ shards: { worker?: Worker; analyzeShard: (input: ResolutionProjectInput) => Promise<unknown> }[] }>;
    }).analyzerPromise;
    // Inject at the job boundary, after a real worker was started. No sleeps or
    // compiler-dependent timing: the throw must drain the worker owner.
    const prototype = Object.getPrototypeOf(inner.shards[0]);
    const original = prototype.analyzeShard;
    prototype.analyzeShard = async () => { throw new Error('injected project failure'); };
    let releasedEvidence = false;
    try {
        await assert.rejects(async () => {
            await analyzer.analyze(inputFor(os.tmpdir(), []));
            releasedEvidence = true;
        }, /injected project failure/);
        assert.equal(releasedEvidence, false);
        assert.ok(inner.shards.every((shard) => shard.worker === undefined), 'failed analysis retained a worker');
    } finally {
        prototype.analyzeShard = original;
        await analyzer.dispose();
    }
});

for (const failure of ['cancellation', 'worker death'] as const) {
    test(`${failure} drains a pending full-index job without releasing evidence`, { timeout: 30_000 }, async () => {
        const analyzer = new LazyTypeScriptSemanticProjectAnalyzer();
        const original = Worker.prototype.postMessage;
        let started!: (worker: Worker) => void;
        const jobStarted = new Promise<Worker>((resolve) => { started = resolve; });
        Worker.prototype.postMessage = function (message, ...args) {
            if (message.method === 'analyze') {
                // Hold the real request in its owner's pending map, without
                // sending it. Death/cancellation is injected at a fixed boundary.
                started(this);
                return;
            }
            return original.call(this, message, ...args);
        };
        let releasedEvidence = false;
        try {
            const operation = analyzer.analyze(inputFor(os.tmpdir(), [])).then((value) => {
                releasedEvidence = true;
                return value;
            });
            const rejection = assert.rejects(operation, failure === 'cancellation' ? /disposed/ : /worker exited/);
            const worker = await jobStarted;
            if (failure === 'cancellation') await analyzer.dispose();
            else await worker.terminate();
            await rejection;
            const inner = await (analyzer as unknown as {
                analyzerPromise: Promise<{ shards: { worker?: Worker }[]; activeJobs: Set<unknown> }>;
            }).analyzerPromise;
            assert.equal(worker.threadId, -1);
            assert.equal(inner.activeJobs.size, 0);
            assert.ok(inner.shards.every((shard) => shard.worker === undefined));
            assert.equal(releasedEvidence, false);
        } finally {
            Worker.prototype.postMessage = original;
            await analyzer.dispose();
        }
    });
}

test('project jobs preserve dependency-pass failure precedence within a legacy shard', async () => {
    const analyzer = new LazyTypeScriptSemanticProjectAnalyzer(4, undefined, 1);
    await analyzer.getProviderMetadata('typescript');
    const inner = await (analyzer as unknown as {
        analyzerPromise: Promise<{ shards: { worker?: Worker }[] }>;
    }).analyzerPromise;
    const prototype = Object.getPrototypeOf(inner.shards[0]);
    const originalAnalyze = prototype.analyzeShard;
    const originalJobs = prototype.getProjectJobs;
    const baseline = new TypeScriptSemanticProjectAnalyzer();
    const empty = await baseline.analyze(inputFor(os.tmpdir(), []));
    const resource = { ...empty, coverage: { ...empty.coverage!, status: 'unavailable' as const,
        failureReason: 'resource_limit' as const, failureMessage: 'dependency pass resource failure' } };
    prototype.getProjectJobs = async () => [{ key: 'early', shardIndex: 0 }, { key: 'late', shardIndex: 0 }];
    try {
        prototype.analyzeShard = async function () {
            if (this.projectKey === 'early') throw Object.assign(new Error('claims pass failure'), { projectFailureRank: [2, 0] });
            return { evidence: resource, resourceFailure: [1, 1] };
        };
        assert.deepEqual(await analyzer.analyze(inputFor(os.tmpdir(), [])), resource);
        prototype.analyzeShard = async function () {
            throw Object.assign(new Error(this.projectKey === 'early' ? 'claims pass failure' : 'dependency pass failure'), {
                projectFailureRank: this.projectKey === 'early' ? [2, 0] : [1, 1],
            });
        };
        await assert.rejects(analyzer.analyze(inputFor(os.tmpdir(), [])), /dependency pass failure/);
    } finally {
        prototype.analyzeShard = originalAnalyze;
        prototype.getProjectJobs = originalJobs;
        await analyzer.dispose();
        await baseline.dispose();
    }
});

test('full project jobs exit before the next job, and seed the existing warm delta snapshots', { timeout: 60_000 }, async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-ts-jobs-')));
    const files = ['one/a.ts', 'one/b.ts', 'two/c.ts', 'loose.ts'];
    const write = (file: string, source: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), source);
    };
    for (const project of ['one', 'two']) {
        write(`${project}/tsconfig.json`, JSON.stringify({ compilerOptions: { types: [], target: 'ES2022' }, include: ['*.ts'] }));
    }
    write('one/a.ts', 'export function a() { return 1; }');
    write('one/b.ts', 'import { a } from "./a"; export const b = a();');
    write('two/c.ts', 'export function c() { return 2; }');
    write('loose.ts', 'export const loose = 3;');
    const analyzer = new LazyTypeScriptSemanticProjectAnalyzer(4, path.join(root, 'state'), 2);
    const baseline = new TypeScriptSemanticProjectAnalyzer(4, undefined, 0);
    await analyzer.getProviderMetadata('typescript');
    const inner = await (analyzer as unknown as {
        analyzerPromise: Promise<{ shards: { worker?: Worker }[]; activeJobs: Set<{ worker?: Worker }> }>;
    }).analyzerPromise;
    const prototype = Object.getPrototypeOf(inner.shards[0]);
    const original = prototype.analyzeShard;
    const workers: Worker[] = [];
    prototype.analyzeShard = function (input: ResolutionProjectInput) {
        if (input.changedFiles === undefined) {
            assert.ok(workers.every((worker) => worker.threadId === -1), 'a previous project isolate is still resident');
            const result = original.call(this, input);
            workers.push(this.worker);
            return result;
        }
        return original.call(this, input);
    };
    try {
        const before = inputFor(root, files);
        assert.deepEqual(await analyzer.analyze(before), await baseline.analyze(before));
        assert.equal(workers.length, 3, 'two configured projects and one inferred project');
        assert.ok(workers.every((worker) => worker.threadId === -1));
        assert.equal(inner.activeJobs.size, 0);
        write('one/a.ts', 'export function a() { return 4; }');
        const delta = { ...inputFor(root, files), previousRegistry: before.registry, changedFiles: new Set(['one/a.ts']) };
        assert.deepEqual(await analyzer.analyze(delta), await baseline.analyze(delta));
        // Also prove persistence survives an entirely fresh coordinator.
        const fresh = new LazyTypeScriptSemanticProjectAnalyzer(4, path.join(root, 'state'), 2);
        try {
            const next = { ...inputFor(root, files), previousRegistry: delta.registry, changedFiles: new Set<string>() };
            assert.deepEqual(await fresh.analyze(next), await baseline.analyze(next));
        } finally { await fresh.dispose(); }
    } finally {
        prototype.analyzeShard = original;
        await analyzer.dispose();
        await baseline.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the TypeScript resolution worker is replaced after it dies', { timeout: 30_000 }, async () => {
    const analyzer = new LazyTypeScriptSemanticProjectAnalyzer();
    try {
        const before = await analyzer.getProviderMetadata('typescript');
        assert.ok(before?.providerId);

        const inner = await (analyzer as unknown as {
            analyzerPromise: Promise<{ shards: readonly { worker?: Worker }[] }>;
        }).analyzerPromise;
        const worker = inner.shards[0]?.worker;
        assert.ok(worker, 'expected the worker-backed analyzer');
        await worker.terminate();

        assert.deepEqual(await analyzer.getProviderMetadata('typescript'), before);
    } finally {
        await analyzer.dispose();
    }
});
