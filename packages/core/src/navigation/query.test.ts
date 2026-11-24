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
                warnings: [],
                manifest: { schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
                    symbolRegistryManifestHash: 'fixture', relationshipVersion: 'fixture', builtAt: '2026-09-09',
                    providerCoverage: [], files: [] },
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
                warnings: [],
                manifest: {
                    schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
                    symbolRegistryManifestHash: 'fixture',
                    relationshipVersion: 'fixture',
                    builtAt: '2026-09-22',
                    providerCoverage: [],
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

test('getGraphNeighbors prioritizes production callers ahead of test callers under bounded limits', async () => {
    const target = 'syminst_target';
    const makeCall = (source: string, file: string, line: number): RelationshipRecord => ({
        sourceKey: source,
        sourceInstanceId: source,
        targetKey: target,
        targetInstanceId: target,
        type: 'CALLS',
        confidence: 'high',
        file,
        span: { startLine: line, endLine: line },
    });
    const records: RelationshipRecord[] = [
        // Lexicographically earlier test callers outnumber the shared limit
        ...Array.from({ length: 15 }, (_, i) =>
            makeCall(`test-caller-${i}`, 'packages/mcp/src/core/alpha-target.test.ts', 10 + i),
        ),
        // Production caller sorts lexicographically after the test file
        makeCall('runtime-caller', 'packages/mcp/src/core/zeta-coordinator.ts', 42),
        // Outgoing callees to exercise direction="both" interleaving
        ...Array.from({ length: 12 }, (_, i) => ({
            sourceKey: target,
            sourceInstanceId: target,
            targetKey: `callee-${i}`,
            targetInstanceId: `callee-${i}`,
            type: 'CALLS' as const,
            confidence: 'high' as const,
            file: 'packages/mcp/src/core/alpha-target.ts',
            span: { startLine: 100 + i, endLine: 100 + i },
        })),
    ];

    const input: GetGraphNeighborsInput = {
        normalizedRootPath: '/repo',
        publicationId: 'fixture',
        navigationRoot: '/fixture/navigation',
        expectedSymbolRegistryManifestHash: 'fixture',
        symbolInstanceId: target,
        direction: 'both',
        depth: 1,
        allowedTypes: ['CALLS'],
        limit: 10,
        navigationStore: {
            getManifest: async () => { throw new Error('unused'); },
            getRelationships: async () => ({
                status: 'ok',
                rootPath: '/repo',
                manifestHash: 'fixture',
                records,
                warnings: [],
                manifest: {
                    schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
                    symbolRegistryManifestHash: 'fixture',
                    relationshipVersion: 'fixture',
                    builtAt: '2026-11-24',
                    providerCoverage: [],
                    files: [],
                },
            }),
        },
    };

    const both = await getGraphNeighbors(input);
    assert.equal(both.status, 'ok');
    if (both.status !== 'ok') return;
    assert.equal(both.records.length, 10);
    assert.ok(
        both.records.some((r) => r.sourceInstanceId === 'runtime-caller' && r.file === 'packages/mcp/src/core/zeta-coordinator.ts'),
        'production caller must be preserved ahead of test callers under direction=both limit',
    );

    const callersOnly = await getGraphNeighbors({ ...input, direction: 'callers', limit: 3 });
    assert.equal(callersOnly.status, 'ok');
    if (callersOnly.status !== 'ok') return;
    assert.equal(callersOnly.records[0]?.sourceInstanceId, 'runtime-caller');

    // maxTestCallers caps test/fixture caller edges without truncating production callers or callees.
    const capped = await getGraphNeighbors({ ...input, direction: 'both', limit: 25, maxTestCallers: 3 });
    assert.equal(capped.status, 'ok');
    if (capped.status !== 'ok') return;
    const cappedTestCallers = capped.records.filter(
        (r) => r.targetInstanceId === target && r.file.includes('.test.'),
    );
    const cappedProdCallers = capped.records.filter(
        (r) => r.targetInstanceId === target && !r.file.includes('.test.'),
    );
    const cappedCallees = capped.records.filter((r) => r.sourceInstanceId === target);
    assert.equal(cappedProdCallers.length, 1);
    assert.equal(cappedTestCallers.length, 3);
    assert.equal(cappedCallees.length, 12);
    assert.ok(capped.warnings.includes('RELATIONSHIP_TEST_CALLERS_CAPPED:12'));
    assert.equal(capped.warnings.includes('RELATIONSHIP_TRAVERSAL_LIMIT_REACHED'), false);
    assert.equal(capped.warnings.includes('RELATIONSHIP_TRAVERSAL_TRUNCATED'), false);
});

test('getGraphNeighbors preserves depth-two production callers reachable through capped test edges and prunes unused nodes', async () => {
    const target = 'syminst_target';
    const makeCall = (source: string, destination: string, file: string, line: number): RelationshipRecord => ({
        sourceKey: source,
        sourceInstanceId: source,
        targetKey: destination,
        targetInstanceId: destination,
        type: 'CALLS',
        confidence: 'high',
        file,
        span: { startLine: line, endLine: line },
    });
    const records: RelationshipRecord[] = [
        // Depth-1 test callers: test-0, test-1 fill maxTestCallers=2; test-2 is a leaf;
        // test-3 is only called by another test; test-4 bridges to a depth-2 production caller.
        makeCall('test-0', target, 'packages/mcp/src/alpha.test.ts', 10),
        makeCall('test-1', target, 'packages/mcp/src/alpha.test.ts', 11),
        makeCall('test-2', target, 'packages/mcp/src/alpha.test.ts', 12),
        makeCall('test-3', target, 'packages/mcp/src/alpha.test.ts', 13),
        makeCall('test-4', target, 'packages/mcp/src/alpha.test.ts', 14),
        // Depth-2 callers: only test-4 reaches a production caller.
        makeCall('test-depth2', 'test-3', 'packages/mcp/src/beta.test.ts', 20),
        makeCall('prod-depth2', 'test-4', 'packages/mcp/src/prod-entry.ts', 30),
        // Callees on target that should still fit in normal output slots.
        ...Array.from({ length: 4 }, (_, i) =>
            makeCall(target, `callee-${i}`, 'packages/mcp/src/target.ts', 100 + i),
        ),
    ];
    const input: GetGraphNeighborsInput = {
        normalizedRootPath: '/repo',
        publicationId: 'fixture',
        navigationRoot: '/fixture/navigation',
        expectedSymbolRegistryManifestHash: 'fixture',
        symbolInstanceId: target,
        direction: 'callers',
        depth: 2,
        allowedTypes: ['CALLS'],
        limit: 8,
        maxTestCallers: 2,
        navigationStore: {
            getManifest: async () => { throw new Error('unused'); },
            getRelationships: async () => ({
                status: 'ok',
                rootPath: '/repo',
                manifestHash: 'fixture',
                records,
                warnings: [],
                manifest: {
                    schemaVersion: RELATIONSHIP_MANIFEST_SCHEMA_VERSION,
                    symbolRegistryManifestHash: 'fixture',
                    relationshipVersion: 'fixture',
                    builtAt: '2026-11-25',
                    providerCoverage: [],
                    files: [],
                },
            }),
        },
    };

    const callers = await getGraphNeighbors(input);
    assert.equal(callers.status, 'ok');
    if (callers.status !== 'ok') return;

    const edgePairs = callers.records.map((r) => `${r.sourceInstanceId}->${r.targetInstanceId}`);
    assert.deepEqual(edgePairs, [
        'test-0->syminst_target',
        'test-1->syminst_target',
        'test-4->syminst_target',
        'prod-depth2->test-4',
    ]);
    assert.ok(callers.warnings.includes('RELATIONSHIP_TEST_CALLERS_CAPPED:3'));
    assert.equal(callers.warnings.includes('RELATIONSHIP_TRAVERSAL_LIMIT_REACHED'), false);
    assert.deepEqual(callers.visitedSymbolInstanceIds, [
        target,
        'test-0',
        'test-1',
        'test-4',
        'prod-depth2',
    ]);
    assert.equal(callers.visitedSymbolInstanceIds.includes('test-2'), false);
    assert.equal(callers.visitedSymbolInstanceIds.includes('test-3'), false);
    assert.equal(callers.visitedSymbolInstanceIds.includes('test-depth2'), false);

    // Under direction="both" with a tight limit matching kept callers + callees, all callees still fit.
    const both = await getGraphNeighbors({ ...input, direction: 'both', limit: 8 });
    assert.equal(both.status, 'ok');
    if (both.status !== 'ok') return;
    assert.equal(both.records.length, 8);
    assert.equal(both.records.filter((r) => r.sourceInstanceId === target).length, 4);
    assert.ok(both.records.some((r) => r.sourceInstanceId === 'prod-depth2' && r.targetInstanceId === 'test-4'));
    assert.ok(both.warnings.includes('RELATIONSHIP_TEST_CALLERS_CAPPED:3'));
    assert.equal(both.warnings.includes('RELATIONSHIP_TRAVERSAL_LIMIT_REACHED'), false);
    assert.equal(both.warnings.includes('RELATIONSHIP_TRAVERSAL_TRUNCATED'), false);

    const tightBoth = await getGraphNeighbors({ ...input, direction: 'both', limit: 4 });
    assert.equal(tightBoth.status, 'ok');
    if (tightBoth.status !== 'ok') return;
    assert.ok(tightBoth.records.some((r) => r.sourceInstanceId === 'test-4'));
    assert.ok(tightBoth.records.some((r) => r.sourceInstanceId === 'prod-depth2'));
    assert.equal(tightBoth.records.filter((r) => r.sourceInstanceId === target).length, 2);
});
