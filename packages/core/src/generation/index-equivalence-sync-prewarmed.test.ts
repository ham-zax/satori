import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ThreadedWasmSemanticProjectAnalyzer } from '../semantic/wasm/wasm-threaded-analyzer';
import type { SemanticProjectInput } from '../semantic/contracts';
import { POLYGLOT, TS_CROSS_PROJECT_EDITS, assertSyncMatchesFullIndex, tsCrossProject } from './index-equivalence-harness';

test('cold prewarmed sync matches a fresh index after Go and TypeScript edits', { timeout: 300_000 }, async (t) => {
    const native = Object.fromEntries(Object.entries(POLYGLOT).filter(([file]) => file === 'go.mod' || file.endsWith('.go')));
    const original = ThreadedWasmSemanticProjectAnalyzer.prototype.prepareSourceTrees;
    let preparations = 0;
    t.mock.method(ThreadedWasmSemanticProjectAnalyzer.prototype, 'prepareSourceTrees', function (
        this: ThreadedWasmSemanticProjectAnalyzer, input: SemanticProjectInput, signal?: AbortSignal,
    ) {
        preparations++;
        return original.call(this, input, signal);
    });
    const editFile = (file: string, change: (source: string) => string) => (root: string) => {
        const fullPath = path.join(root, file);
        fs.writeFileSync(fullPath, change(fs.readFileSync(fullPath, 'utf8')));
    };
    await assertSyncMatchesFullIndex('prewarmed', { ...native, ...tsCrossProject() }, [
        ['trailing Go comment', editFile('cmd/app/main.go', source => `${source}// comment\n`)],
        ['line before a Go declaration', editFile('pkg/greet/greet.go', source => source.replace('func Hello', '\nfunc Hello'))],
        ['changed Go call', editFile('pkg/greet/greet.go', source => source.replace('fmt.Println(format(name))', 'fmt.Println(name)'))],
        TS_CROSS_PROJECT_EDITS[1],
    ], true, true);
    assert.ok(preparations > 0, 'the fixture must prepare native sources');
});
