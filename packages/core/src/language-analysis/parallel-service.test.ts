import assert from 'node:assert/strict';
import test from 'node:test';
import { createLanguageAnalysisService } from './service';
import { createParallelLanguageAnalysisService } from './parallel-service';
import { createIndexingChunkPlan, type IndexingAnalysisCapability } from './indexing-analysis';

const inputs = [
    { relativePath: 'src/app.ts', language: 'typescript', content: 'import { b } from "./b";\nexport class A {\n  run(x: number) { return b(x); }\n}\n' },
    { relativePath: 'pkg/main.py', language: 'python', content: 'import os\n\nclass Worker:\n    def run(self):\n        return os.getcwd()\n' },
    { relativePath: 'cmd/main.go', language: 'go', content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(helper())\n}\n\nfunc helper() string { return "x" }\n' },
    { relativePath: 'lib/tool.rb', language: 'ruby', content: 'class Tool\n  def call\n    1\n  end\nend\n' },
    { relativePath: 'notes.txt', language: 'text', content: 'plain text without structure\n' },
];

test('worker-pool analysis is identical to in-process analysis across backends', async () => {
    const options = { chunkSize: 2500, chunkOverlap: 300 };
    const local = createLanguageAnalysisService(options);
    const pool = createParallelLanguageAnalysisService(options, 2);
    try {
        assert.equal(pool.concurrency, 2);
        const [expected, actual] = await Promise.all([
            Promise.all(inputs.map((input) => local.analyze(input))),
            Promise.all(inputs.map((input) => pool.analyze(input))),
        ]);
        assert.deepStrictEqual(actual, expected);
    } finally {
        await pool.dispose();
    }
});

test('zero workers analyze in-process and dispose is safe', async () => {
    const pool = createParallelLanguageAnalysisService({}, 0);
    assert.equal(pool.concurrency, 1);
    const result = await pool.analyze(inputs[0]);
    assert.equal(result.structuralStatus, 'complete');
    await pool.dispose();
    assert.equal((await pool.analyze(inputs[0])).structuralStatus, 'complete');
});

test('thread workers return structural indexing evidence without chunk strings', async () => {
    const options = { chunkSize: 24, chunkOverlap: 7 };
    const local = createLanguageAnalysisService(options);
    const pool = createParallelLanguageAnalysisService(options, 1);
    const indexing = pool as typeof pool & IndexingAnalysisCapability;
    try {
        const input = inputs[0];
        const [expected, deferred] = await Promise.all([
            local.analyze(input),
            indexing.analyzeForIndexing(input),
        ]);
        assert.equal('chunks' in deferred, false);
        assert.deepEqual(
            [...createIndexingChunkPlan({
                content: input.content,
                relativePath: input.relativePath,
                language: input.language,
                symbols: deferred.symbols,
                result: deferred,
            }).chunks()],
            expected.chunks,
        );
    } finally {
        await pool.dispose();
        await local.dispose?.();
    }
});

test('failed parser workers remain owned until disposal has awaited their exit', async () => {
    const { Worker } = await import('node:worker_threads');
    const originalPost = Worker.prototype.postMessage;
    const originalTerminate = Worker.prototype.terminate;
    const workers: InstanceType<typeof Worker>[] = [];
    let failed!: () => void;
    const failure = new Promise<void>(resolve => { failed = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Worker.prototype.postMessage = function () {
        workers.push(this);
        this.emit('error', new Error('injected parser death'));
        failed();
    };
    Worker.prototype.terminate = async function () { await gate; return originalTerminate.call(this); };
    const pool = createParallelLanguageAnalysisService({}, 1);
    try {
        const operation = pool.analyze(inputs[0]);
        const rejected = assert.rejects(operation, /injected parser death/);
        await failure;
        let disposed = false;
        const disposal = pool.dispose().then(() => { disposed = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(disposed, false, 'disposal returned while failed parser termination was in flight');
        release();
        await disposal;
        await rejected;
        assert.equal(workers.length, 1);
        assert.equal(workers[0].threadId, -1);
    } finally {
        release();
        Worker.prototype.postMessage = originalPost;
        Worker.prototype.terminate = originalTerminate;
        await pool.dispose();
        await Promise.all(workers.map(worker => originalTerminate.call(worker)));
    }
});
