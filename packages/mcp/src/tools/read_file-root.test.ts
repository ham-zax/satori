import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileTool } from './read_file.js';
import type { ToolContext } from './types.js';
import { createSessionWorkspacePolicy } from '../core/session-workspace-policy.js';
import { buildSearchGroupRecommendedAction } from '../core/search-response-helpers.js';
import type { ComposeSymbolContextInput } from '../core/symbol-context-composer.js';
import type { SearchGroupResult } from '../core/search-types.js';

test('recommended symbol reads and continuations retain their root across overlapping publications', async () => {
    const parent = '/workspace/root';
    const child = `${parent}/child`;
    const file = `${child}/file.ts`;
    let indexingRoot: string | undefined;
    let composed = 0;
    const ctx = {
        workspacePolicy: createSessionWorkspacePolicy({ roots: [parent], homeDirectory: '/home/user', stateRoot: '/state' }),
        context: {
            listCurrentPublications: () => [parent, child].map((root) => ({ publication: { canonicalRoot: root } })),
        },
        mutationRuntime: {
            listActiveMutations: () => indexingRoot ? [{ action: 'reindex', canonicalRoot: indexingRoot }] : [],
            getOperation: () => undefined,
        },
        syncManager: { touchWatchedCodebase: async () => undefined },
        toolHandlers: {
            composeSymbolContext: async (input: ComposeSymbolContextInput) => {
                composed += 1;
                const expectedRoot = input.symbolId === 'parent-symbol' ? parent : child;
                assert.equal(input.codebaseRoot, expectedRoot);
                assert.equal(input.relativeFile, expectedRoot === parent ? 'child/file.ts' : 'file.ts');
                return { status: 'ok', context: { status: 'ok', symbol: { symbolId: input.symbolId }, continuations: [], limitations: [] } };
            },
        },
    } as unknown as ToolContext;
    const read = async (args: Record<string, unknown>) => {
        const response = await readFileTool.execute(args, ctx);
        return JSON.parse(response.content[0].text);
    };
    for (const root of [parent, child]) {
        const symbolId = root === parent ? 'parent-symbol' : 'child-symbol';
        const group = {
            target: { file: root === parent ? 'child/file.ts' : 'file.ts', symbolId, span: { startLine: 1, endLine: 3 } },
        } as SearchGroupResult;
        const action = buildSearchGroupRecommendedAction(root, group)!;
        assert.equal(action.args.codebaseRoot, root);
        // A different overlapping root cannot block this explicitly bound read.
        indexingRoot = root === parent ? child : parent;
        const opened = await read(action.args);
        assert.equal(opened.status, 'ok');
        assert.equal(opened.codebaseRoot, root);
        const continued = await read({
            path: file, codebaseRoot: opened.codebaseRoot, mode: 'plain',
            open_symbol: { contractVersion: 2, symbolId,
                continuation: { kind: 'source_range', fingerprint: 'fixture', startLine: 2, endLine: 3 } },
        });
        assert.equal(continued.status, 'ok');
        assert.equal(continued.codebaseRoot, root);
        indexingRoot = root;
        assert.equal((await read(action.args)).code, 'NAVIGATION_UNAVAILABLE');
    }
    indexingRoot = undefined;
    const beforeDenied = composed;
    const request = { path: file, mode: 'plain', open_symbol: {
        contractVersion: 2, symbolId: 'parent-symbol', context: { preset: 'definition' },
    } };
    assert.equal((await read({ ...request, codebaseRoot: '/elsewhere' })).code, 'ROOT_NOT_AUTHORIZED');
    assert.equal((await read({ ...request, codebaseRoot: `${parent}/other` })).code, 'ROOT_BINDING_INVALID');
    assert.equal((await read({ ...request, path: `${child}/missing/file.ts`, codebaseRoot: `${child}/missing` })).code, 'NAVIGATION_UNAVAILABLE');
    assert.equal(composed, beforeDenied);
});
