import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    PublicationLease,
    RelationshipRecord,
    SymbolRecord,
    TraceRelationshipPathInput,
} from '@zokizuan/satori-core';
import { NavigationHandlers } from './navigation-handlers.js';

type Host = ConstructorParameters<typeof NavigationHandlers>[0];

test('trace_path binds scope and both navigation reads to the exact admitted lease', async () => {
    const observed: Record<string, unknown>[] = [];
    let released = false;
    const lease = {
        id: 'leased-publication',
        publication: { id: 'leased-publication', canonicalRoot: '/repo' },
        release: () => { released = true; },
    } as PublicationLease;
    const handler = new NavigationHandlers({
        prepareNavigationRead: async (requested: string) => {
            observed.push({ requested });
            return {
                state: 'ready',
                root: { path: '/repo', info: { status: 'indexed' } },
                publication: { id: 'leased-publication' },
                navigationStatus: 'valid',
            } as Awaited<ReturnType<Host['prepareNavigationRead']>>;
        },
        acquirePublicationLease: (_root: string, id?: string) => {
            observed.push({ acquiredId: id });
            return lease;
        },
        isPublicationAdmitted: async (admitted: PublicationLease) => admitted === lease,
        getPublicationNavigationAddress: (publication: PublicationLease) => {
            observed.push({ navigationFor: publication.id });
            return { publicationId: publication.id, navigationRoot: '/snap/leased-publication/navigation' };
        },
        tracePath: async (input: TraceRelationshipPathInput) => {
            observed.push({
                publicationId: input.publicationId,
                navigationRoot: input.navigationRoot,
                scopeSubtree: input.scopeSubtree,
                sourceSymbolId: input.sourceSymbolId,
                targetSymbolId: input.targetSymbolId,
            });
            return {
                status: 'ok',
                path: {
                    nodes: [
                        { symbolInstanceId: 'source-id', label: 'Source', kind: 'function', file: 'packages/foo/src.ts', language: 'typescript', span: { startLine: 1, endLine: 2 } },
                        { symbolInstanceId: 'middle-id', label: 'Middle', kind: 'file', file: 'packages/foo/mid.ts', language: 'typescript', span: { startLine: 1, endLine: 3 } },
                        { symbolInstanceId: 'target-id', label: 'Target', kind: 'function', file: 'packages/foo/dst.ts', language: 'typescript', span: { startLine: 4, endLine: 6 } },
                    ] as SymbolRecord[],
                    edges: [
                        { sourceInstanceId: 'source-id', targetInstanceId: 'middle-id', type: 'CALLS', file: 'packages/foo/src.ts', span: { startLine: 2, endLine: 2 }, confidence: 'high' },
                        { sourceInstanceId: 'middle-id', targetInstanceId: 'target-id', type: 'EXPORTS', file: 'packages/foo/mid.ts', span: { startLine: 3, endLine: 3 }, confidence: 'medium' },
                    ] as RelationshipRecord[],
                },
                coverage: { visitedNodes: 3, traversedEdges: 2, truncated: false, truncatedBy: [] },
                warnings: [],
            };
        },
        stringifyToolJson: JSON.stringify,
    } as unknown as Host);

    const response = await handler.handleTracePath({
        path: '/repo/packages/foo',
        sourceSymbolId: 'source-id',
        targetSymbolId: 'target-id',
        relationshipKinds: ['CALLS'],
        maxDepth: 3,
        maxVisitedNodes: 100,
        maxTraversedEdges: 500,
    });
    const payload = JSON.parse(response.content[0]!.text);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.publicationId, 'leased-publication');
    assert.equal(payload.found, true);
    assert.deepEqual(payload.shortestPath.nodes.map((node: { file: string }) => node.file), [
        'packages/foo/src.ts', 'packages/foo/mid.ts', 'packages/foo/dst.ts',
    ]);
    assert.deepEqual(payload.shortestPath.edges.map((edge: { kind: string }) => edge.kind), ['CALLS', 'EXPORTS']);
    assert.deepEqual(payload.shortestPath.edges[1].site, {
        file: 'packages/foo/mid.ts', span: { startLine: 3, endLine: 3 },
    });
    assert.equal(released, true);
    assert.deepEqual(observed, [
        { requested: '/repo/packages/foo' },
        { acquiredId: 'leased-publication' },
        { navigationFor: 'leased-publication' },
        {
            publicationId: 'leased-publication',
            navigationRoot: '/snap/leased-publication/navigation',
            scopeSubtree: 'packages/foo',
            sourceSymbolId: 'source-id',
            targetSymbolId: 'target-id',
        },
    ]);
});

test('trace_path does not read navigation when the Publication lease is not admitted', async () => {
    let read = false;
    let released = false;
    const lease = {
        id: 'publication-1',
        publication: { id: 'publication-1', canonicalRoot: '/repo' },
        release: () => { released = true; },
    } as PublicationLease;
    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => ({
            state: 'ready', root: { path: '/repo', info: { status: 'indexed' } },
            publication: { id: 'publication-1' }, navigationStatus: 'valid',
        }) as Awaited<ReturnType<Host['prepareNavigationRead']>>,
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => false,
        tracePath: async () => { read = true; throw new Error('must not read'); },
        stringifyToolJson: JSON.stringify,
    } as unknown as Host);
    const response = await handler.handleTracePath({
        path: '/repo', sourceSymbolId: 'a', targetSymbolId: 'b',
        relationshipKinds: ['CALLS'], maxDepth: 3, maxVisitedNodes: 100, maxTraversedEdges: 500,
    });
    assert.equal(JSON.parse(response.content[0]!.text).status, 'not_ready');
    assert.equal(read, false);
    assert.equal(released, true);
});

test('trace_path rejects a lease that differs from the prepared Publication', async () => {
    let read = false;
    let released = false;
    const lease = {
        id: 'other-publication',
        publication: { id: 'other-publication', canonicalRoot: '/repo' },
        release: () => { released = true; },
    } as PublicationLease;
    const handler = new NavigationHandlers({
        prepareNavigationRead: async () => ({
            state: 'ready', root: { path: '/repo', info: { status: 'indexed' } },
            publication: { id: 'prepared-publication' }, navigationStatus: 'valid',
        }) as Awaited<ReturnType<Host['prepareNavigationRead']>>,
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationAddress: () => { read = true; throw new Error('must not read'); },
        stringifyToolJson: JSON.stringify,
    } as unknown as Host);
    const response = await handler.handleTracePath({
        path: '/repo', sourceSymbolId: 'a', targetSymbolId: 'b',
        relationshipKinds: ['CALLS'], maxDepth: 3, maxVisitedNodes: 100, maxTraversedEdges: 500,
    });
    assert.equal(JSON.parse(response.content[0]!.text).status, 'not_ready');
    assert.equal(read, false);
    assert.equal(released, true);
});
