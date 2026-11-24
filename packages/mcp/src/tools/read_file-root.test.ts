import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFileTool } from './read_file.js';
import type { ToolContext } from './types.js';
import { createSessionWorkspacePolicy } from '../core/session-workspace-policy.js';
import {
    buildSearchGroupRecommendedAction,
    buildTopRecommendedRawSearchAction,
} from '../core/search-response-helpers.js';
import type { ComposeSymbolContextInput } from '../core/symbol-context-composer.js';
import type { SearchGroupResult } from '../core/search-types.js';

test('recommended symbol reads and continuations retain their root across overlapping publications', async () => {
    const parent = '/workspace/root';
    const child = `${parent}/child`;
    const file = `${child}/file.ts`;
    let indexingRoot: string | undefined;
    let indexingAction: 'create' | 'reindex' = 'reindex';
    let composed = 0;
    const ctx = {
        workspacePolicy: createSessionWorkspacePolicy({ roots: [parent], homeDirectory: '/home/user', stateRoot: '/state' }),
        context: {
            listCurrentPublications: () => [parent, child].map((root) => ({ publication: { canonicalRoot: root } })),
        },
        mutationRuntime: {
            listActiveMutations: () => indexingRoot ? [{ action: indexingAction, canonicalRoot: indexingRoot }] : [],
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
        assert.equal((await read(action.args)).status, 'ok');
        indexingAction = 'create';
        assert.equal((await read(action.args)).code, 'NAVIGATION_UNAVAILABLE');
        indexingAction = 'reindex';
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

test('range reads bind to codebaseRoot and serve the requested lines', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-read-range-root-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'range.ts'), 'line one\nline two\nline three\nline four\n');
    const publication = { publication: { canonicalRoot: root } };
    const ctx = {
        workspacePolicy: createSessionWorkspacePolicy({ roots: [root], homeDirectory: '/home/user', stateRoot: '/state' }),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({ fileHashes: [['range.ts', 'hash']] }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
    } as unknown as ToolContext;
    const response = await readFileTool.execute({
        path: path.join(root, 'range.ts'),
        codebaseRoot: root,
        start_line: 2,
        end_line: 3,
    }, ctx);
    assert.notEqual(response.isError, true);
    assert.equal(response.content[0].text, 'line two\nline three');
});

test('range reads reject a codebaseRoot that does not contain the path', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-read-range-root-')));
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-read-range-other-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    t.after(() => fs.rmSync(other, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'range.ts'), 'line one\nline two\nline three\nline four\n');
    const publication = { publication: { canonicalRoot: root } };
    const ctx = {
        workspacePolicy: createSessionWorkspacePolicy({ roots: [root, other], homeDirectory: '/home/user', stateRoot: '/state' }),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({ fileHashes: [['range.ts', 'hash']] }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
    } as unknown as ToolContext;
    const response = await readFileTool.execute({
        path: path.join(root, 'range.ts'),
        codebaseRoot: other,
        start_line: 2,
        end_line: 3,
    }, ctx);
    assert.equal(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.code, 'ROOT_BINDING_INVALID');
    assert.equal(payload.reason, 'root_binding_invalid');
    assert.equal(payload.kind, undefined);
    assert.equal(payload.formatVersion, undefined);
    assert.doesNotMatch(response.content[0].text, /line two/);
});

test('recommended plain-range reads retain their bound root across overlapping publications and preserve unpinned backward compatibility', async (t) => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-read-overlap-parent-')));
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const filePath = path.join(child, 'file.ts');
    fs.writeFileSync(filePath, 'line 1\nline 2\nline 3\nline 4\n');

    const parentPub = { publication: { canonicalRoot: parent } };
    const childPub = { publication: { canonicalRoot: child } };
    let publishedRoots = [parent, child];
    let indexingRoot: string | undefined;

    const ctx = {
        workspacePolicy: createSessionWorkspacePolicy({ roots: [parent], homeDirectory: '/home/user', stateRoot: '/state' }),
        context: {
            listCurrentPublications: () => publishedRoots.map((root) => ({ publication: { canonicalRoot: root } })),
            getCurrentPublication: (codebaseRoot: string) => {
                if (!publishedRoots.includes(codebaseRoot)) return undefined;
                return codebaseRoot === parent ? parentPub : childPub;
            },
            getPublicationSourceCheckpoint: (pub: { publication: { canonicalRoot: string } }) => ({
                fileHashes: [[pub.publication.canonicalRoot === parent ? 'child/file.ts' : 'file.ts', 'hash']],
            }),
        },
        mutationRuntime: {
            listActiveMutations: () => indexingRoot ? [{ action: 'reindex', canonicalRoot: indexingRoot }] : [],
            getOperation: () => undefined,
        },
        syncManager: { touchWatchedCodebase: async () => undefined },
    } as unknown as ToolContext;

    const oversizedAction = buildSearchGroupRecommendedAction(parent, {
        target: { file: 'child/file.ts', symbolId: 'big-sym', span: { startLine: 1, endLine: 500 } },
        evidenceSpan: { startLine: 2, endLine: 3 },
    } as SearchGroupResult)!;
    const spanOnlyAction = buildSearchGroupRecommendedAction(parent, {
        target: { file: 'child/file.ts', span: { startLine: 1, endLine: 2 } },
    } as SearchGroupResult)!;
    const rawAction = buildTopRecommendedRawSearchAction(parent, [{
        file: 'child/file.ts',
        span: { startLine: 3, endLine: 4 },
        score: 0.9,
        content: 'line 3\nline 4',
    } as Parameters<typeof buildTopRecommendedRawSearchAction>[1][number]])!;

    assert.equal(oversizedAction.args.codebaseRoot, parent);
    assert.equal(spanOnlyAction.args.codebaseRoot, parent);
    assert.equal(rawAction.args.codebaseRoot, parent);

    // Child indexing must not block plain-range recommendations pinned to parent.
    indexingRoot = child;
    const oversizedRead = await readFileTool.execute(oversizedAction.args, ctx);
    assert.notEqual(oversizedRead.isError, true);
    assert.equal(oversizedRead.content[0].text, 'line 2\nline 3');

    const spanOnlyRead = await readFileTool.execute(spanOnlyAction.args, ctx);
    assert.notEqual(spanOnlyRead.isError, true);
    assert.equal(spanOnlyRead.content[0].text, 'line 1\nline 2');

    const rawRead = await readFileTool.execute(rawAction.args, ctx);
    assert.notEqual(rawRead.isError, true);
    assert.equal(rawRead.content[0].text, 'line 3\nline 4');

    // Reindex keeps the child's previous Publication readable for pinned recommendations.
    const childBoundAction = buildSearchGroupRecommendedAction(child, {
        target: { file: 'file.ts', span: { startLine: 1, endLine: 2 } },
    } as SearchGroupResult)!;
    assert.equal(childBoundAction.args.codebaseRoot, child);
    const childReindex = await readFileTool.execute(childBoundAction.args, ctx);
    assert.equal(childReindex.content[0].text, 'line 1\nline 2');

    // Without a previous child Publication the indexing response remains scoped to the child.
    publishedRoots = [parent];
    const childBlocked = await readFileTool.execute(childBoundAction.args, ctx);
    const childBlockedPayload = JSON.parse(childBlocked.content[0].text);
    assert.equal(childBlockedPayload.status, 'not_ready');
    assert.equal(childBlockedPayload.codebaseRoot, child);

    // When child has no publication at all, a child-pinned read must not silently fall back to parent.
    indexingRoot = undefined;
    const childUnindexed = await readFileTool.execute(childBoundAction.args, ctx);
    assert.equal(childUnindexed.isError, true);
    assert.equal(JSON.parse(childUnindexed.content[0].text).status, 'outside_indexed_root');

    // Manual range read without codebaseRoot remains backward-compatible and resolves the indexed parent.
    const manualRead = await readFileTool.execute({ path: filePath, start_line: 2, end_line: 3 }, ctx);
    assert.notEqual(manualRead.isError, true);
    assert.equal(manualRead.content[0].text, 'line 2\nline 3');
});

test('annotated reads bound to codebaseRoot resolve outline against allowedRoot instead of switching to an overlapping child root', async (t) => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-read-annotated-parent-')));
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const filePath = path.join(child, 'file.ts');
    fs.writeFileSync(filePath, 'export function greet() {\n  return "hi";\n}\n');

    const outlineCalls: Array<{ path: string; file: string }> = [];
    const parentPub = { publication: { canonicalRoot: parent } };
    const childPub = { publication: { canonicalRoot: child } };
    const ctx = {
        readFileMaxLines: 200,
        workspacePolicy: createSessionWorkspacePolicy({ roots: [parent], homeDirectory: '/home/user', stateRoot: '/state' }),
        context: {
            listCurrentPublications: () => [parentPub, childPub],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === parent ? parentPub : childPub,
            getPublicationSourceCheckpoint: (pub: { publication: { canonicalRoot: string } }) => ({
                fileHashes: [[pub.publication.canonicalRoot === parent ? 'child/file.ts' : 'file.ts', 'hash']],
            }),
            hasSearchableGeneration: () => true,
            getCurrentSearchGeneration: () => ({ generationId: 'gen-1', compatibility: 'compatible' }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
        toolHandlers: {
            handleFileOutline: async (input: { path: string; file: string }) => {
                outlineCalls.push({ path: input.path, file: input.file });
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'ok',
                            outline: { symbols: [{ name: 'greet', kind: 'function', startLine: 1, endLine: 3 }] },
                            hasMore: false,
                        }),
                    }],
                };
            },
        },
    } as unknown as ToolContext;

    const response = await readFileTool.execute({
        path: filePath,
        codebaseRoot: parent,
        mode: 'annotated',
        start_line: 1,
        end_line: 3,
    }, ctx);
    assert.notEqual(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.outlineStatus, 'ok');
    assert.deepEqual(outlineCalls, [{ path: parent, file: 'child/file.ts' }]);
});

test('plain reads reject a final symlink even when its target is published in the same root', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'satori-read-symlink-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'target.ts'), 'export const published = 1;\n');
    fs.symlinkSync(path.join(root, 'target.ts'), path.join(root, 'link.ts'));
    const publication = { publication: { canonicalRoot: root } };
    const ctx = {
        workspacePolicy: createSessionWorkspacePolicy({ roots: [root], homeDirectory: '/home/user', stateRoot: '/state' }),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({ fileHashes: [['target.ts', 'hash']] }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
    } as unknown as ToolContext;
    const target = await readFileTool.execute({ path: path.join(root, 'target.ts') }, ctx);
    assert.match(target.content[0].text, /export const published = 1;/);
    const link = await readFileTool.execute({ path: path.join(root, 'link.ts') }, ctx);
    assert.match(link.content[0].text, /symlink_rejected/);
    assert.doesNotMatch(link.content[0].text, /export const published/);
});
