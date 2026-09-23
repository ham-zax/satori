import assert from 'node:assert/strict';
import test from 'node:test';
import type { RelationshipRecord, SymbolRecord } from '../symbols/contracts';
import type { JsonNavigationStore } from './store';
import type { TracePathRelationshipKind } from './trace-path';
import { traceRelationshipPath } from './trace-path';

function symbol(id: string, file: string): SymbolRecord {
    return {
        symbolKey: `key-${id}`,
        symbolInstanceId: id,
        language: 'typescript',
        kind: 'function',
        name: id,
        qualifiedName: id,
        label: id,
        file,
        span: { startLine: 1, endLine: 2 },
        parentQualifiedNamePath: [],
        fileHash: 'hash',
        extractorVersion: 'test',
    };
}

function edge(source: SymbolRecord, target: SymbolRecord, type: RelationshipRecord['type'], line = 1): RelationshipRecord {
    return {
        sourceKey: source.symbolKey,
        sourceInstanceId: source.symbolInstanceId,
        targetKey: target.symbolKey,
        targetInstanceId: target.symbolInstanceId,
        type,
        file: source.file,
        span: { startLine: line, endLine: line },
        confidence: 'high',
    };
}

function fixture(symbols: SymbolRecord[], records: RelationshipRecord[], warnings: string[] = []) {
    const calls: Array<{ publicationId: string; expectedHash?: string }> = [];
    const navigationStore = {
        getManifest: async ({ publicationId }: { publicationId: string }) => {
            calls.push({ publicationId });
            return {
                status: 'ok' as const,
                rootPath: '/repo',
                manifestHash: 'registry-hash',
                registryManifestHash: 'registry-hash',
                registry: {
                    manifest: { files: [] },
                    symbols,
                    symbolsByInstanceId: new Map(symbols.map((item) => [item.symbolInstanceId, item])),
                },
                warnings,
            };
        },
        getRelationships: async ({ publicationId, expectedSymbolRegistryManifestHash }: {
            publicationId: string;
            expectedSymbolRegistryManifestHash?: string;
        }) => {
            calls.push({ publicationId, expectedHash: expectedSymbolRegistryManifestHash });
            return {
                status: 'ok' as const,
                rootPath: '/repo',
                manifestHash: 'relationship-hash',
                manifest: { symbolRegistryManifestHash: 'registry-hash', files: [] },
                records,
                analysisByFile: new Map(),
                warnings,
            };
        },
    } as unknown as Pick<JsonNavigationStore, 'getManifest' | 'getRelationships'>;
    return { navigationStore, calls };
}

function request(navigationStore: Pick<JsonNavigationStore, 'getManifest' | 'getRelationships'>, extra: Record<string, unknown> = {}) {
    return {
        normalizedRootPath: '/repo',
        publicationId: 'publication-1',
        navigationRoot: '/snapshot/publication-1/navigation',
        sourceSymbolId: 'a',
        targetSymbolId: 'd',
        allowedTypes: ['CALLS', 'IMPORTS', 'EXPORTS'] as TracePathRelationshipKind[],
        maxDepth: 4,
        maxVisitedNodes: 10,
        maxTraversedEdges: 20,
        navigationStore,
        ...extra,
    };
}

test('trace path returns one deterministic shortest path from exact Publication relationships', async () => {
    const [a, b, c, d] = [symbol('a', 'foo/a.ts'), symbol('b', 'foo/b.ts'), symbol('c', 'foo/c.ts'), symbol('d', 'foo/d.ts')];
    const records = [edge(c, d, 'EXPORTS'), edge(a, c, 'CALLS', 2), edge(b, d, 'IMPORTS'), edge(a, b, 'CALLS', 1), edge(b, a, 'CALLS')];
    const { navigationStore, calls } = fixture([a, b, c, d], records);

    const result = await traceRelationshipPath(request(navigationStore));

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.deepEqual(result.path?.nodes.map((node) => node.symbolInstanceId), ['a', 'b', 'd']);
    assert.deepEqual(result.path?.edges.map((item) => item.type), ['CALLS', 'IMPORTS']);
    assert.equal(result.coverage.truncated, false);
    assert.deepEqual(calls, [
        { publicationId: 'publication-1' },
        { publicationId: 'publication-1', expectedHash: 'registry-hash' },
    ]);
});

test('trace path treats subtree as a hard node and relationship evidence boundary', async () => {
    const [a, outside, d] = [symbol('a', 'foo/a.ts'), symbol('x', 'bar/x.ts'), symbol('d', 'foo/d.ts')];
    const { navigationStore } = fixture([a, outside, d], [edge(a, outside, 'CALLS'), edge(outside, d, 'CALLS')]);
    const result = await traceRelationshipPath(request(navigationStore, { scopeSubtree: 'foo' }));
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.path, null);
    assert.equal(result.coverage.traversedEdges, 0);
    assert.equal(result.coverage.truncated, false);

    const leakedSite = { ...edge(a, d, 'CALLS'), file: 'bar/outside.ts' };
    const second = fixture([a, d], [leakedSite]);
    const siteResult = await traceRelationshipPath(request(second.navigationStore, { scopeSubtree: 'foo' }));
    assert.equal(siteResult.status, 'ok');
    if (siteResult.status === 'ok') assert.equal(siteResult.path, null);
});

test('trace path reports node, edge, and depth budgets without claiming an exhaustive miss', async () => {
    const [a, b, c, d] = [symbol('a', 'foo/a.ts'), symbol('b', 'foo/b.ts'), symbol('c', 'foo/c.ts'), symbol('d', 'foo/d.ts')];
    const { navigationStore } = fixture([a, b, c, d], [edge(a, b, 'CALLS'), edge(a, c, 'CALLS'), edge(c, d, 'CALLS')]);

    for (const [budget, limit] of [['maxVisitedNodes', 2], ['maxTraversedEdges', 1], ['maxDepth', 1]] as const) {
        const result = await traceRelationshipPath(request(navigationStore, { [budget]: limit }));
        assert.equal(result.status, 'ok');
        if (result.status !== 'ok') continue;
        assert.equal(result.path, null);
        assert.equal(result.coverage.truncated, true);
        assert.ok(result.coverage.truncatedBy.includes(budget));
    }
});

test('trace path ignores unselected and unresolved relationship records', async () => {
    const [a, d] = [symbol('a', 'foo/a.ts'), symbol('d', 'foo/d.ts')];
    const { navigationStore } = fixture([a, d], [
        edge(a, d, 'TESTS'),
        { ...edge(a, d, 'CALLS'), targetInstanceId: undefined },
    ]);
    const result = await traceRelationshipPath(request(navigationStore, { allowedTypes: ['CALLS'] }));
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
        assert.equal(result.path, null);
        assert.equal(result.coverage.truncated, false);
    }
});

test('trace path rejects relationship kinds outside the persisted path vocabulary', async () => {
    const [a, d] = [symbol('a', 'foo/a.ts'), symbol('d', 'foo/d.ts')];
    const { navigationStore } = fixture([a, d], [edge(a, d, 'EXTENDS')]);
    await assert.rejects(
        traceRelationshipPath(request(navigationStore, { allowedTypes: ['EXTENDS'] })),
        /unsupported relationship kind/i,
    );
});

test('trace path chooses the same edge evidence when equivalent paths arrive in different record order', async () => {
    const [a, d] = [symbol('a', 'foo/a.ts'), symbol('d', 'foo/d.ts')];
    const rule = { ...edge(a, d, 'CALLS'), strategy: 'rule' as const };
    const heuristic = { ...edge(a, d, 'CALLS'), strategy: 'heuristic' as const };
    const first = fixture([a, d], [rule, heuristic]);
    const second = fixture([a, d], [heuristic, rule]);
    const firstResult = await traceRelationshipPath(request(first.navigationStore));
    const secondResult = await traceRelationshipPath(request(second.navigationStore));
    assert.equal(firstResult.status, 'ok');
    assert.equal(secondResult.status, 'ok');
    if (firstResult.status === 'ok' && secondResult.status === 'ok') {
        assert.deepEqual(firstResult.path?.edges, secondResult.path?.edges);
    }
});

test('scoped path results do not disclose unrelated sidecar warnings', async () => {
    const [a, d] = [symbol('a', 'foo/a.ts'), symbol('d', 'foo/d.ts')];
    const { navigationStore } = fixture([a, d], [], ['bar/outside.ts: relationship shard warning']);
    const result = await traceRelationshipPath(request(navigationStore, { scopeSubtree: 'foo' }));
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') assert.deepEqual(result.warnings, []);
});
