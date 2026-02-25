import test from 'node:test';
import assert from 'node:assert/strict';
import { callGraphTool } from './call_graph.js';
import { ToolContext } from './types.js';

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
