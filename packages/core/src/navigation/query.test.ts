import test from 'node:test';
import assert from 'node:assert/strict';
import { getGraphNeighbors, type GetGraphNeighborsInput } from './query';
import { RELATIONSHIP_MANIFEST_SCHEMA_VERSION, type RelationshipRecord } from '../symbols/contracts';

test('evaluateTradeOffer both preserves callers under the shared edge limit and unions directional traversals', async () => {
    const target = 'syminst_145417fc9f24000b149bb740b332b65f';
    const call = (source: string, destination: string, line: number): RelationshipRecord => ({
        sourceKey: source, sourceInstanceId: source, targetKey: destination,
        targetInstanceId: destination, type: 'CALLS', confidence: 'high',
        file: source === target ? 'src/core/trades.ts' : 'src/content/overlay.ts',
        span: { startLine: line, endLine: line },
    });
    const records = [
        ...Array.from({ length: 20 }, (_, i) => call(target, `callee-${i}`, 558 + i)),
        call('scheduleTradeVerdicts', target, 2600),
        call('nextClick', target, 3897),
        call('unrelatedCaller', 'callee-0', 1),
    ];
    const input: GetGraphNeighborsInput = {
        normalizedRootPath: '/fixture/colonist-assistant', publicationId: 'fixture',
        navigationRoot: '/fixture/navigation', expectedSymbolRegistryManifestHash: 'fixture',
        symbolInstanceId: target, direction: 'both', depth: 2, limit: 20,
        navigationStore: {
            getManifest: async () => { throw new Error('unused'); },
            getRelationships: async () => ({
                status: 'ok', rootPath: '/fixture/colonist-assistant', manifestHash: 'fixture', records,
                analysisByFile: new Map(), warnings: [],
                manifest: { schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
                    symbolRegistryManifestHash: 'fixture', relationshipVersion: 'fixture', builtAt: '2026-09-09', files: [] },
            }),
        },
    };
    const bounded = await getGraphNeighbors(input);
    assert.equal(bounded.status, 'ok');
    if (bounded.status !== 'ok') return;
    assert.equal(bounded.records.length, 20);
    assert.equal(bounded.records.filter(r => r.targetInstanceId === target).length, 2);
    assert.ok(bounded.warnings.includes('RELATIONSHIP_TRAVERSAL_TRUNCATED'));
    const [both, callers, callees] = await Promise.all(['both', 'callers', 'callees'].map(direction =>
        getGraphNeighbors({ ...input, direction: direction as GetGraphNeighborsInput['direction'], limit: 100 })));
    assert.equal(both.status, 'ok'); assert.equal(callers.status, 'ok'); assert.equal(callees.status, 'ok');
    if (both.status !== 'ok' || callers.status !== 'ok' || callees.status !== 'ok') return;
    const keys = (rows: RelationshipRecord[]) => new Set(rows.map(r => `${r.sourceInstanceId}:${r.targetInstanceId}`));
    assert.deepEqual(keys(both.records), keys([...callers.records, ...callees.records]));
    assert.ok(!both.visitedSymbolInstanceIds.includes('unrelatedCaller'));
});

test('recordFilter constrains traversal without narrowing low-confidence qualification evidence', async () => {
    const caller = 'caller';
    const target = 'target';
    const callerOwner = 'caller-file-owner';
    const importedOwner = 'imported-file-owner';
    const records: RelationshipRecord[] = [
        {
            sourceKey: caller,
            sourceInstanceId: caller,
            targetKey: target,
            targetInstanceId: target,
            type: 'CALLS',
            confidence: 'low',
            file: 'packages/a/src/caller.ts',
            span: { startLine: 5, endLine: 5 },
        },
        {
            sourceKey: callerOwner,
            sourceInstanceId: callerOwner,
            targetKey: importedOwner,
            targetInstanceId: importedOwner,
            targetPath: 'packages/a/src/target.ts',
            type: 'IMPORTS',
            confidence: 'high',
            file: 'packages/a/src/caller.ts',
        },
        {
            sourceKey: importedOwner,
            sourceInstanceId: importedOwner,
            targetKey: target,
            targetInstanceId: target,
            type: 'EXPORTS',
            confidence: 'high',
            file: 'packages/a/src/target.ts',
        },
    ];
    const result = await getGraphNeighbors({
        normalizedRootPath: '/repo',
        publicationId: 'fixture',
        navigationRoot: '/fixture/navigation',
        expectedSymbolRegistryManifestHash: 'fixture',
        symbolInstanceId: target,
        direction: 'callers',
        depth: 1,
        allowedTypes: ['CALLS'],
        recordFilter: (record) => record.type === 'CALLS',
        limit: 20,
        navigationStore: {
            getManifest: async () => { throw new Error('unused'); },
            getRelationships: async () => ({
                status: 'ok',
                rootPath: '/repo',
                manifestHash: 'fixture',
                records,
                analysisByFile: new Map(),
                warnings: [],
                manifest: {
                    schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
                    symbolRegistryManifestHash: 'fixture',
                    relationshipVersion: 'fixture',
                    builtAt: '2026-09-22',
                    files: [],
                },
            }),
        },
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.type, 'CALLS');
    assert.equal(result.records[0]?.confidence, 'medium');
    assert.equal(result.suppressedLowConfidenceRecords.length, 0);
});
