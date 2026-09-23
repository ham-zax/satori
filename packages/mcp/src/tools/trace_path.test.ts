import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceAuthorizationError } from '../core/session-workspace-policy.js';
import { tracePathTool } from './trace_path.js';

test('trace_path rejects unsupported relationship kinds and unbounded limits', async () => {
    const base = {
        path: '/repo', sourceSymbolId: 'a', targetSymbolId: 'b', relationshipKinds: ['CALLS'],
    };
    const ctx = {} as Parameters<typeof tracePathTool.execute>[1];
    for (const change of [{ relationshipKinds: ['REFERENCES'] }, { maxDepth: 7 }, { maxVisitedNodes: 501 }, { maxTraversedEdges: 2001 }]) {
        const response = await tracePathTool.execute({ ...base, ...change }, ctx);
        assert.equal(response.isError, true);
        assert.match(response.content[0]!.text, /Invalid arguments/);
    }
});

test('trace_path denies unauthorized paths before handler dispatch', async () => {
    let handled = false;
    const ctx = {
        workspacePolicy: {
            authorizePath: () => { throw new WorkspaceAuthorizationError('ROOT_NOT_AUTHORIZED', 'blocked'); },
        },
        toolHandlers: {
            handleTracePath: async () => { handled = true; throw new Error('must not dispatch'); },
        },
    } as unknown as Parameters<typeof tracePathTool.execute>[1];
    const response = await tracePathTool.execute({
        path: '/repo', sourceSymbolId: 'a', targetSymbolId: 'b', relationshipKinds: ['CALLS'],
    }, ctx);
    assert.equal(response.isError, true);
    assert.equal(handled, false);
});

test('trace_path dispatches canonical path and default bounds', async () => {
    let forwarded: Record<string, unknown> | undefined;
    const ctx = {
        workspacePolicy: { authorizePath: () => ({ canonicalPath: '/repo/canonical' }) },
        toolHandlers: {
            handleTracePath: async (input: Record<string, unknown>) => {
                forwarded = input;
                return { content: [{ type: 'text', text: '{"status":"ok"}' }] };
            },
        },
    } as unknown as Parameters<typeof tracePathTool.execute>[1];
    const response = await tracePathTool.execute({
        path: '/repo/requested', sourceSymbolId: 'a', targetSymbolId: 'b',
    }, ctx);
    assert.equal(response.isError, undefined);
    assert.deepEqual(forwarded, {
        path: '/repo/canonical',
        sourceSymbolId: 'a',
        targetSymbolId: 'b',
        relationshipKinds: ['CALLS', 'IMPORTS', 'EXPORTS'],
        maxDepth: 3,
        maxVisitedNodes: 100,
        maxTraversedEdges: 500,
    });
});

test('trace_path stays available when the vector provider is unavailable', async () => {
    let providerRequested = false;
    let handled = false;
    const ctx = {
        workspacePolicy: { authorizePath: () => ({ canonicalPath: '/repo/canonical' }) },
        providerRuntime: {
            requireToolContext: async () => {
                providerRequested = true;
                throw new Error('vector backend must not be consulted');
            },
        },
        toolHandlers: {
            handleTracePath: async () => {
                handled = true;
                return { content: [{ type: 'text', text: '{"status":"ok"}' }] };
            },
        },
    } as unknown as Parameters<typeof tracePathTool.execute>[1];

    const response = await tracePathTool.execute({
        path: '/repo/requested', sourceSymbolId: 'a', targetSymbolId: 'b',
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(providerRequested, false);
    assert.equal(handled, true);
});
