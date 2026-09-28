import assert from 'node:assert/strict';
import test from 'node:test';
import { createLanguageAnalysisService } from './service';
import { createParallelLanguageAnalysisService } from './parallel-service';

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
