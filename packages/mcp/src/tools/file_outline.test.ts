import test from 'node:test';
import assert from 'node:assert/strict';
import { fileOutlineTool } from './file_outline.js';
import { ToolContext } from './types.js';

function buildContext(): ToolContext {
    return {
        toolHandlers: {
            handleFileOutline: async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'ok',
                        path: '/repo',
                        file: 'src/runtime.ts',
                        outline: { symbols: [] },
                        hasMore: false
                    })
                }]
            })
        }
    } as unknown as ToolContext;
}

test('file_outline validates required fields', async () => {
    const response = await fileOutlineTool.execute({
        path: '/repo'
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /Invalid arguments for 'file_outline'/);
    assert.match(response.content[0]?.text || '', /file/);
});

test('file_outline validates resolveMode=exact requirements', async () => {
    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.ts',
        resolveMode: 'exact'
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /symbolIdExact|resolveMode/);
});

test('file_outline delegates to handlers with parsed input', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        toolHandlers: {
            handleFileOutline: async (args: Record<string, unknown>) => {
                receivedArgs = args;
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ status: 'ok', path: '/repo', file: 'src/runtime.ts', outline: { symbols: [] }, hasMore: false })
                    }]
                };
            }
        }
    } as unknown as ToolContext;

    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.ts',
        start_line: 1,
        end_line: 20,
        limitSymbols: 25,
        resolveMode: 'exact',
        symbolLabelExact: 'function run()'
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(receivedArgs?.path, '/repo');
    assert.equal(receivedArgs?.file, 'src/runtime.ts');
    assert.equal(receivedArgs?.limitSymbols, 25);
    assert.equal(receivedArgs?.resolveMode, 'exact');
    assert.equal(receivedArgs?.symbolLabelExact, 'function run()');
});
