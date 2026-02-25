import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AstCodeSplitter } from '@zokizuan/satori-core';
import { CallGraphSidecarManager, SupportedSourceDeltaPolicy } from './call-graph.js';
import { IndexFingerprint } from '../config.js';

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
    return fn(repoPath).finally(() => {
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

test('call graph sidecar emits missing_symbol_metadata notes without synthetic node ids', async () => {
    await withTempRepo(async (repoPath) => {
        const splitter = new AstCodeSplitter();
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

        const chunks = await splitter.split(content, 'typescript', filePath);
        const metadataSymbolIds = new Set(
            chunks
                .map((chunk) => chunk.metadata.symbolId)
                .filter((symbolId): symbolId is string => typeof symbolId === 'string')
        );

        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
        await manager.rebuildForCodebase(repoPath);
        const sidecar = manager.loadSidecar(repoPath);
        assert.ok(sidecar);

        const missingMetadataNotes = sidecar!.notes.filter((note) => note.type === 'missing_symbol_metadata');
        assert.ok(missingMetadataNotes.length >= 1);
        assert.equal(sidecar!.edges.length, 0);
        for (const node of sidecar!.nodes) {
            assert.ok(metadataSymbolIds.has(node.symbolId), `Unexpected node symbolId without splitter metadata: ${node.symbolId}`);
        }
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

test('call graph notes are deterministically sorted by file, line, and type', async () => {
    await withTempRepo(async (repoPath) => {
        const manager = new CallGraphSidecarManager(RUNTIME_FINGERPRINT);
        const sidecarPath = (manager as any).getSidecarPath(repoPath) as string;
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
                'src/runtime.ts:5:missing_symbol_metadata',
                'src/runtime.ts:10:dynamic_edge',
                'src/runtime.ts:10:unresolved_edge'
            ]
        );
    });
});
