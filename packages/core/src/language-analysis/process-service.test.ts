import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { IndexingResourcePlanner } from '../indexing/resources';
import { createLanguageAnalysisService } from './service';
import { createProcessLanguageAnalysisService } from './process-service';

const plan = Object.freeze({ ...new IndexingResourcePlanner({
    platform: () => 'darwin', readFile: () => { throw new Error('no proc'); },
    totalMemory: () => 64 * 1024 ** 3, freeMemory: () => 2 * 1024 ** 3, cpuCount: () => 16,
}, () => ({ diagnostics: [] })).createPlan(), analysisProcessMaxFiles: 1 });
const input = { relativePath: 'app.ts', language: 'typescript', content: 'export const value = 7;\n' };
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

test('recycle every file preserves parser evidence and waits for process exit', async () => {
    const original = childProcess.fork;
    const children: ChildProcess[] = [];
    childProcess.fork = ((...args: Parameters<typeof original>) => {
        assert.ok(args[2]?.execArgv?.includes('--liftoff-only'));
        if (children.length) assert.ok(exited(children[children.length - 1]), 'reused a slot before exit');
        const child = original(...args); children.push(child); return child;
    }) as typeof original;
    syncBuiltinESMExports();
    const pool = createProcessLanguageAnalysisService({}, plan);
    const local = createLanguageAnalysisService();
    try {
        for (const sample of [input,
            { relativePath: 'app.py', language: 'python', content: 'def run():\n    return 7\n' },
            { relativePath: 'tool.rb', language: 'ruby', content: 'class Tool\n  def run\n    7\n  end\nend\n' },
        ]) assert.deepEqual(await pool.analyze(sample), await local.analyze(sample));
        assert.equal(children.length, 3);
        assert.ok(children.every(exited));
    } finally {
        await pool.dispose(); await local.dispose?.(); childProcess.fork = original; syncBuiltinESMExports();
    }
});

for (const fault of ['death', 'startup', 'cancel recycling'] as const) {
    test(`parser process ${fault} drains every child before settling`, async () => {
        const original = childProcess.fork;
        const children: ChildProcess[] = [];
        let cancel!: () => void;
        const reached = new Promise<void>(resolve => { cancel = resolve; });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        childProcess.fork = ((...args: Parameters<typeof original>) => {
            const child = original(...(fault === 'startup' && children.length === 1
                ? [args[0], args[1], { ...args[2], execArgv: ['--invalid-parser-startup-flag'] }] as Parameters<typeof original> : args));
            children.push(child);
            if ((fault === 'death' || fault === 'cancel recycling') && children.length === 2) {
                const send = child.send.bind(child);
                child.send = ((message: unknown, ...rest: unknown[]) => {
                    if (fault === 'death') { child.kill('SIGKILL'); return true; }
                    cancel();
                    // A deterministic cancellation boundary while the next
                    // parser has been started but its file has not completed.
                    void gate.then(() => { if (!exited(child)) send(message as object, ...rest as []); });
                    return true;
                }) as typeof child.send;
            }
            return child;
        }) as typeof original;
        syncBuiltinESMExports();
        const pool = createProcessLanguageAnalysisService({}, plan);
        try {
            await pool.analyze(input);
            assert.ok(exited(children[0]));
            const operation = pool.analyze(input);
            const rejection = assert.rejects(operation, fault === 'cancel recycling' ? /disposed/ : /process exited/);
            if (fault === 'cancel recycling') { await reached; await pool.dispose(); release(); }
            await rejection;
            assert.equal(children.length, 2);
            assert.ok(children.every(exited), 'parser call settled before child exit');
        } finally {
            release(); await pool.dispose(); childProcess.fork = original; syncBuiltinESMExports();
        }
    });
}

for (const fault of ['death', 'startup'] as const) {
    test(`${fault} waits for another in-flight parser to exit before rejecting`, async () => {
        const original = childProcess.fork;
        const children: ChildProcess[] = [];
        let releaseHeld: () => void = () => {};
        let terminating!: () => void;
        const terminationStarted = new Promise<void>(resolve => { terminating = resolve; });
        childProcess.fork = ((...args: Parameters<typeof original>) => {
            if (fault === 'startup' && children.length === 2) args[2] = { ...args[2], execArgv: ['--invalid-parser-startup-flag'] };
            const child = original(...args); children.push(child);
            if (children.length === 2) {
                child.send = (() => true) as typeof child.send;
                const kill = child.kill.bind(child);
                // Hold OS termination at the owning boundary, rather than
                // sleeping and hoping another child stays alive long enough.
                child.kill = () => { terminating(); return true; };
                releaseHeld = () => { child.kill = kill; kill(); };
            } else if (children.length === 3 && fault === 'death') {
                child.send = (() => { child.kill('SIGKILL'); return true; }) as typeof child.send;
            }
            return child;
        }) as typeof original;
        syncBuiltinESMExports();
        const pool = createProcessLanguageAnalysisService({}, { ...plan, analysisWorkers: 2 });
        try {
            await pool.analyze(input);
            const held = pool.analyze(input);
            const failed = pool.analyze(input);
            const heldRejection = assert.rejects(held);
            const failedRejection = assert.rejects(failed);
            let settled = false;
            failed.then(() => { settled = true; }, () => { settled = true; });
            await terminationStarted;
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(settled, false, 'returned while another parser termination was in flight');
            releaseHeld();
            await Promise.all([heldRejection, failedRejection]);
            assert.equal(children.length, 3);
            assert.ok(children.every(exited));
        } finally {
            releaseHeld(); await pool.dispose(); childProcess.fork = original; syncBuiltinESMExports();
            await Promise.all(children.map(child => exited(child) ? Promise.resolve() : new Promise<void>(resolve => { child.kill(); child.once('close', () => resolve()); })));
        }
    });
}
