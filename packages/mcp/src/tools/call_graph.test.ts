import test from 'node:test';
import assert from 'node:assert/strict';
import { callGraphTool } from './call_graph.js';
import { ToolContext } from './types.js';

test('call_graph rejects relative path', async () => {
    const ctx = {
        toolHandlers: {
            handleCallGraph: async () => {
                throw new Error('handler must not run');
            }
        }
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: 'relative/repo',
        symbolRef: {
            file: 'src/runtime.ts',
            symbolId: 'sym_runtime_run'
        },
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /absolute filesystem path|Invalid arguments for 'call_graph'/i);
});

test('call_graph rejects absolute symbolRef.file', async () => {
    const ctx = {
        toolHandlers: {
            handleCallGraph: async () => {
                throw new Error('handler must not run');
            }
        }
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: '/repo',
        symbolRef: {
            file: '/abs/runtime.ts',
            symbolId: 'sym_runtime_run'
        },
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /repo-relative|Invalid arguments for 'call_graph'/i);
});

test('call_graph normalizes direction bidirectional to both before validation/dispatch', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        toolHandlers: {
            handleCallGraph: async (args: Record<string, unknown>) => {
                receivedArgs = args;
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ status: 'ok' })
                    }]
                };
            }
        }
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: '/repo',
        symbolRef: {
            file: 'src/runtime.ts',
            symbolId: 'sym_runtime_run'
        },
        direction: 'bidirectional',
        depth: 1,
        limit: 20
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(receivedArgs?.direction, 'both');
});

test('call_graph keeps strict validation for invalid direction values', async () => {
    const ctx = {
        toolHandlers: {
            handleCallGraph: async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify({ status: 'ok' })
                }]
            })
        }
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: '/repo',
        symbolRef: {
            file: 'src/runtime.ts',
            symbolId: 'sym_runtime_run'
        },
        direction: 'bi'
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /Invalid arguments for 'call_graph'/);
    assert.match(response.content[0]?.text || '', /direction/);
});

test('call_graph uses provider vector context when available', async () => {
    let requestedOperation: string | undefined;
    let receivedArgs: Record<string, unknown> | undefined;
    const providerContext = {
        toolHandlers: {
            handleCallGraph: async (args: Record<string, unknown>) => {
                receivedArgs = args;
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ status: 'ok', supported: true, nodes: [], edges: [], notes: [] })
                    }]
                };
            }
        }
    } as unknown as ToolContext;
    const ctx = {
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperation = operation;
                return providerContext;
            }
        },
        toolHandlers: {
            handleCallGraph: async () => {
                throw new Error('startup context should not handle call_graph when provider context is available');
            }
        }
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: '/repo',
        symbolRef: {
            file: 'src/runtime.ts',
            symbolId: 'sym_runtime_run'
        },
        direction: 'both'
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(requestedOperation, 'vector_only');
    assert.equal(receivedArgs?.path, '/repo');
    assert.equal((receivedArgs?.symbolRef as { symbolId?: string } | undefined)?.symbolId, 'sym_runtime_run');
});
