import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallGraphSidecarManager, SupportedSourceDeltaPolicy } from './call-graph.js';
import { IndexFingerprint } from '../config.js';

type TestableCallGraphSidecarManager = CallGraphSidecarManager & {
    getSidecarPath(codebasePath: string): string;
};

const RUNTIME_FINGERPRINT: IndexFingerprint = {
    embeddingProvider: 'VoyageAI',
    embeddingModel: 'voyage-4-large',
    embeddingDimension: 1024,
    vectorStoreProvider: 'Milvus',
    schemaVersion: 'hybrid_v3'
};

function withTempRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-mcp-call-graph-'));
    const repoPath = path.join(tempDir, 'repo');
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = tempDir;
    return fn(repoPath).finally(() => {
        if (prevHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = prevHome;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function sortEdgesForAssertion(edges: Array<{ srcSymbolId: string; dstSymbolId: string; kind: string; site: { startLine: number } }>) {
    return [...edges].sort((a, b) => {
        const srcCmp = a.srcSymbolId.localeCompare(b.srcSymbolId);
        if (srcCmp !== 0) return srcCmp;
        const dstCmp = a.dstSymbolId.localeCompare(b.dstSymbolId);
        if (dstCmp !== 0) return dstCmp;
        const kindCmp = a.kind.localeCompare(b.kind);
        if (kindCmp !== 0) return kindCmp;
        return a.site.startLine - b.site.startLine;
    });
}

function getSidecarPathForTest(manager: CallGraphSidecarManager, codebasePath: string): string {
    return (manager as unknown as TestableCallGraphSidecarManager).getSidecarPath(codebasePath);
}

test('call graph sidecar builds and query traversal is deterministic on TS fixture', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, [
            'class RuntimeGraph {',
            '  beta() {',
            '    return true;',
            '  }',
            '',
            '  gamma() {',
            '    return this.beta();',
            '  }',
            '',
            '  alpha() {',
            '    this.beta();',
            '    this.gamma();',
            '    this.beta();',
            '  }',
            '}',
            ''
        ].join('\n'));

        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT, {
            now: () => Date.parse('2026-01-01T00:00:00.000Z')
        });

        const sidecarInfo = await manager.rebuildForCodebase(repoPath);
        assert.equal(sidecarInfo.version, 'v3');
        assert.ok(sidecarInfo.nodeCount >= 3);

        const sidecar = manager.loadSidecar(repoPath);
        assert.ok(sidecar);

        const alphaNode = sidecar!.nodes.find((node) => (node.symbolLabel || '').includes('method alpha'));
        assert.ok(alphaNode);

        const response = manager.queryGraph(repoPath, {
            file: 'src/runtime.ts',
            symbolId: alphaNode!.symbolId,
            symbolLabel: alphaNode!.symbolLabel,
            span: alphaNode!.span,
        }, {
            direction: 'callees',
            depth: 2,
            limit: 20
        });

        assert.equal(response.supported, true);
        if (!response.supported) {
            return;
        }

        assert.ok(response.nodes.length >= 2);
        assert.ok(response.edges.length >= 2);
        assert.deepEqual(response.edges, sortEdgesForAssertion(response.edges));

        for (const edge of response.edges) {
            assert.ok(edge.site.startLine > 0);
            assert.ok(edge.kind === 'call' || edge.kind === 'import' || edge.kind === 'dynamic');
            assert.ok(edge.confidence > 0);
        }
    });
});

test('call graph sidecar assigns same-line calls to byte-containing symbols', async () => {
    await withTempRepo(async (repoPath) => {
        fs.writeFileSync(path.join(repoPath, 'src', 'runtime.ts'), [
            'function targetA() {}',
            'function targetB() {}',
            'function first() { targetA(); } function second() { targetB(); }',
        ].join('\n'));

        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
        await manager.rebuildForCodebase(repoPath);
        const sidecar = manager.loadSidecar(repoPath);
        assert.ok(sidecar);

        const idByName = new Map(sidecar!.nodes.map((node) => [
            node.symbolLabel?.replace(/^function /, ''),
            node.symbolId,
        ]));
        assert.notEqual(idByName.get('first'), idByName.get('second'));
        const actualEdges = sidecar!.edges
            .map((edge) => [edge.srcSymbolId, edge.dstSymbolId])
            .sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''));
        const expectedEdges = [
            [idByName.get('first'), idByName.get('targetA')],
            [idByName.get('second'), idByName.get('targetB')],
        ].sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''));
        assert.deepEqual(actualEdges, expectedEdges);
    });
});

test('call graph query returns structured unsupported response for unsupported language', async () => {
    const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
    const response = manager.queryGraph('/tmp/repo', {
        file: 'docs/readme.md',
        symbolId: 'sym_missing'
    }, {
        direction: 'both',
        depth: 1,
        limit: 20
    });

    assert.equal(response.supported, false);
    if (!response.supported) {
        assert.equal(response.reason, 'unsupported_language');
        assert.ok(response.hints);
    }
});

test('call graph query accepts JavaScript symbols for query routing', async () => {
    const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
    const response = manager.queryGraph('/tmp/repo', {
        file: 'src/runtime.js',
        symbolId: 'sym_missing'
    }, {
        direction: 'both',
        depth: 1,
        limit: 20
    });

    assert.equal(response.supported, false);
    if (!response.supported) {
        assert.equal(response.reason, 'missing_sidecar');
    }
});

test('call graph sidecar does not synthesize nodes for structurally invalid source', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'broken.ts');
        const content = [
            'export const handler = () => {',
            '  if (true) {',
            '    doWork(',
            '  }',
            '};',
            ''
        ].join('\n');
        fs.writeFileSync(filePath, content);

        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
        await manager.rebuildForCodebase(repoPath);
        const sidecar = manager.loadSidecar(repoPath);
        assert.ok(sidecar);

        assert.equal(sidecar!.edges.length, 0);
        assert.equal(sidecar!.nodes.length, 0);
    });
});

test('call graph does not emit declaration self-loop edges for non-recursive symbols', async () => {
    await withTempRepo(async (repoPath) => {
        const filePath = path.join(repoPath, 'src', 'runtime.ts');
        fs.writeFileSync(filePath, [
            'export function helper() {',
            '  return true;',
            '}',
            '',
            'export function runtimeEntry() {',
            '  return helper();',
            '}',
            ''
        ].join('\n'));

        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT, {
            now: () => Date.parse('2026-01-01T00:00:00.000Z')
        });

        await manager.rebuildForCodebase(repoPath);
        const sidecar = manager.loadSidecar(repoPath);
        assert.ok(sidecar);

        const runtimeEntryNode = sidecar!.nodes.find((node) => (node.symbolLabel || '').toLowerCase().includes('function runtimeentry'));
        assert.ok(runtimeEntryNode);

        const selfLoop = sidecar!.edges.find((edge) =>
            edge.srcSymbolId === runtimeEntryNode!.symbolId && edge.dstSymbolId === runtimeEntryNode!.symbolId
        );

        assert.equal(selfLoop, undefined);
    });
});

test('supported source delta policy only rebuilds for source file changes', () => {
    const policy = new SupportedSourceDeltaPolicy();
    assert.equal(policy.shouldRebuild(['README.md', 'docs/notes.txt']), false);
    assert.equal(policy.shouldRebuild(['src/app.ts']), true);
    assert.equal(policy.shouldRebuild(['python/app.py']), true);
});

test('call graph notes are deterministically sorted by file, type, symbolId, and line', async () => {
    await withTempRepo(async (repoPath) => {
        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
        const sidecarPath = getSidecarPathForTest(manager, repoPath);
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

        fs.writeFileSync(sidecarPath, JSON.stringify({
            formatVersion: 'v3',
            codebasePath: repoPath,
            builtAt: '2026-01-01T00:00:00.000Z',
            fingerprint: RUNTIME_FINGERPRINT,
            nodes: [{
                symbolId: 'sym_root',
                symbolLabel: 'function root()',
                file: 'src/runtime.ts',
                language: 'typescript',
                span: { startLine: 1, endLine: 1 }
            }],
            edges: [],
            notes: [
                {
                    type: 'unresolved_edge',
                    file: 'src/runtime.ts',
                    startLine: 10,
                    symbolId: 'sym_root',
                    detail: 'z unresolved'
                },
                {
                    type: 'dynamic_edge',
                    file: 'src/runtime.ts',
                    startLine: 10,
                    symbolId: 'sym_root',
                    detail: 'a dynamic'
                },
                {
                    type: 'missing_symbol_metadata',
                    file: 'src/runtime.ts',
                    startLine: 5,
                    detail: 'metadata missing'
                }
            ]
        }, null, 2));

        const response = manager.queryGraph(repoPath, {
            file: 'src/runtime.ts',
            symbolId: 'sym_root',
        }, {
            direction: 'both',
            depth: 1,
            limit: 20
        });

        assert.equal(response.supported, true);
        if (!response.supported) {
            return;
        }

        assert.deepEqual(
            response.notes.map((note) => `${note.file}:${note.startLine}:${note.type}`),
            [
                'src/runtime.ts:10:dynamic_edge',
                'src/runtime.ts:5:missing_symbol_metadata',
                'src/runtime.ts:10:unresolved_edge'
            ]
        );
    });
});

test('call graph query filters notes to returned scope and emits truncation metadata deterministically', async () => {
    await withTempRepo(async (repoPath) => {
        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT, {
            noteLimit: 2
        });
        const sidecarPath = getSidecarPathForTest(manager, repoPath);
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

        fs.writeFileSync(sidecarPath, JSON.stringify({
            formatVersion: 'v3',
            codebasePath: repoPath,
            builtAt: '2026-01-01T00:00:00.000Z',
            fingerprint: RUNTIME_FINGERPRINT,
            nodes: [
                {
                    symbolId: 'sym_root',
                    symbolLabel: 'function root()',
                    file: 'src/runtime.ts',
                    language: 'typescript',
                    span: { startLine: 1, endLine: 1 }
                },
                {
                    symbolId: 'sym_other',
                    symbolLabel: 'function other()',
                    file: 'src/runtime.ts',
                    language: 'typescript',
                    span: { startLine: 20, endLine: 20 }
                }
            ],
            edges: [],
            notes: [
                {
                    type: 'unresolved_edge',
                    file: 'src/runtime.ts',
                    startLine: 10,
                    symbolId: 'sym_root',
                    detail: 'z unresolved'
                },
                {
                    type: 'dynamic_edge',
                    file: 'src/runtime.ts',
                    startLine: 10,
                    symbolId: 'sym_root',
                    detail: 'a dynamic'
                },
                {
                    type: 'missing_symbol_metadata',
                    file: 'src/runtime.ts',
                    startLine: 5,
                    detail: 'metadata missing'
                },
                {
                    type: 'unresolved_edge',
                    file: 'src/runtime.ts',
                    startLine: 12,
                    symbolId: 'sym_other',
                    detail: 'should drop by symbol scope'
                },
                {
                    type: 'unresolved_edge',
                    file: 'src/other.ts',
                    startLine: 1,
                    symbolId: 'sym_root',
                    detail: 'should drop by file scope'
                }
            ]
        }, null, 2));

        const response = manager.queryGraph(repoPath, {
            file: 'src/runtime.ts',
            symbolId: 'sym_root',
        }, {
            direction: 'both',
            depth: 1,
            limit: 20
        });

        assert.equal(response.supported, true);
        if (!response.supported) return;

        assert.equal(response.totalNoteCount, 3);
        assert.equal(response.returnedNoteCount, 2);
        assert.equal(response.notesTruncated, true);
        assert.deepEqual(response.warnings, ['CALL_GRAPH_NOTES_TRUNCATED']);
        assert.deepEqual(
            response.notes.map((note) => `${note.file}:${note.startLine}:${note.type}`),
            [
                'src/runtime.ts:10:dynamic_edge',
                'src/runtime.ts:5:missing_symbol_metadata'
            ]
        );
    });
});

test('call graph query exposes static test references for symbols referenced by test files', async () => {
    await withTempRepo(async (repoPath) => {
        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
        const sidecarPath = getSidecarPathForTest(manager, repoPath);
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

        fs.writeFileSync(sidecarPath, JSON.stringify({
            formatVersion: 'v3',
            codebasePath: repoPath,
            builtAt: '2026-01-01T00:00:00.000Z',
            fingerprint: RUNTIME_FINGERPRINT,
            nodes: [
                {
                    symbolId: 'sym_runtime',
                    symbolLabel: 'function runtime()',
                    file: 'src/runtime.ts',
                    language: 'typescript',
                    span: { startLine: 1, endLine: 3 }
                },
                {
                    symbolId: 'sym_runtime_test',
                    symbolLabel: 'test runtime behavior',
                    file: 'src/runtime.test.ts',
                    language: 'typescript',
                    span: { startLine: 5, endLine: 9 }
                }
            ],
            edges: [
                {
                    srcSymbolId: 'sym_runtime_test',
                    dstSymbolId: 'sym_runtime',
                    kind: 'call',
                    site: {
                        file: 'src/runtime.test.ts',
                        startLine: 7
                    },
                    confidence: 0.8
                }
            ],
            notes: []
        }, null, 2));

        const response = manager.queryGraph(repoPath, {
            file: 'src/runtime.ts',
            symbolId: 'sym_runtime',
            symbolLabel: 'function runtime()'
        }, {
            direction: 'callees',
            depth: 1,
            limit: 20
        });

        assert.equal(response.supported, true);
        if (!response.supported) return;

        assert.deepEqual(response.testReferences, [
            {
                file: 'src/runtime.test.ts',
                symbolId: 'sym_runtime_test',
                symbolLabel: 'test runtime behavior',
                span: { startLine: 5, endLine: 9 },
                site: { file: 'src/runtime.test.ts', startLine: 7 },
                targetSymbolId: 'sym_runtime',
                kind: 'call',
                confidence: 0.8
            }
        ]);
    });
});

test('call graph collector includes hidden directories when not ignored', async () => {
    await withTempRepo(async (repoPath) => {
        const hiddenDir = path.join(repoPath, '.hidden');
        fs.mkdirSync(hiddenDir, { recursive: true });
        fs.writeFileSync(path.join(hiddenDir, 'runtime.ts'), [
            'export function hiddenEntry() {',
            '  return true;',
            '}',
            ''
        ].join('\n'));

        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
        await manager.rebuildForCodebase(repoPath, []);
        const sidecar = manager.loadSidecar(repoPath);
        assert.ok(sidecar);

        const hasHiddenNode = sidecar!.nodes.some((node) => node.file.startsWith('.hidden/'));
        assert.equal(hasHiddenNode, true);
    });
});
