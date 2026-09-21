import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileOutlineTool } from './file_outline.js';
import { ToolContext } from './types.js';
import {
    createSessionWorkspacePolicy,
    type SessionWorkspacePolicy,
} from '../core/session-workspace-policy.js';

function buildWorkspacePolicy(roots: readonly string[]): SessionWorkspacePolicy {
    return createSessionWorkspacePolicy({
        roots,
        homeDirectory: os.homedir(),
        stateRoot: path.join(os.tmpdir(), 'file-outline-test-state'),
    });
}

/** Session policy authorizing the synthetic '/repo' fixture used by existing tests. */
const REPO_WORKSPACE_POLICY = buildWorkspacePolicy(['/repo']);

function buildContext(): ToolContext {
    return {
        workspacePolicy: REPO_WORKSPACE_POLICY,
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

test('file_outline rejects relative codebase path', async () => {
    const response = await fileOutlineTool.execute({
        path: 'relative/repo',
        file: 'src/runtime.ts',
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /absolute filesystem path|Invalid arguments for 'file_outline'/i);
});

test('file_outline rejects absolute repo-relative file field', async () => {
    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: '/etc/passwd',
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /repo-relative|Invalid arguments for 'file_outline'/i);
});

test('file_outline rejects file path escape segments', async () => {
    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: '../secret.ts',
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /escape|repo-relative|Invalid arguments for 'file_outline'/i);
});

test('file_outline rejects Windows drive-relative file C:secret.ts', async () => {
    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'C:secret.ts',
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /repo-relative|drive-relative|Invalid arguments for 'file_outline'/i);
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

test('file_outline requires a canonical exact symbol for structural analysis', async () => {
    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.py',
        resolveMode: 'exact',
        symbolLabelExact: 'function run()',
        detail: 'analysis',
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /detail="analysis".*symbolIdExact/);
});

test('file_outline requires a canonical exact symbol for relationship metadata', async () => {
    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.ts',
        detail: 'relationships',
    }, buildContext());

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /detail="relationships".*symbolIdExact/);
});

test('file_outline delegates to handlers with parsed input', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
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

test('file_outline delegates an exact structural-analysis request unchanged', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleFileOutline: async (args: Record<string, unknown>) => {
                receivedArgs = args;
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'ok',
                            path: '/repo',
                            file: 'src/runtime.py',
                            outline: { symbols: [] },
                            hasMore: false,
                        }),
                    }],
                };
            },
        },
    } as unknown as ToolContext;

    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.py',
        resolveMode: 'exact',
        symbolIdExact: 'syminst_python_run',
        detail: 'analysis',
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(receivedArgs?.resolveMode, 'exact');
    assert.equal(receivedArgs?.symbolIdExact, 'syminst_python_run');
    assert.equal(receivedArgs?.detail, 'analysis');
});

test('file_outline delegates an exact relationship request unchanged', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleFileOutline: async (args: Record<string, unknown>) => {
                receivedArgs = args;
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'ok',
                            path: '/repo',
                            file: 'src/runtime.ts',
                            outline: { symbols: [] },
                            hasMore: false,
                        }),
                    }],
                };
            },
        },
    } as unknown as ToolContext;

    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.ts',
        resolveMode: 'exact',
        symbolIdExact: 'syminst_typescript_run',
        detail: 'relationships',
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(receivedArgs?.resolveMode, 'exact');
    assert.equal(receivedArgs?.symbolIdExact, 'syminst_typescript_run');
    assert.equal(receivedArgs?.detail, 'relationships');
});

test('file_outline delegates file-wide relationship coverage without a symbol selector', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleFileOutline: async (args: Record<string, unknown>) => {
                receivedArgs = args;
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            status: 'ok',
                            path: '/repo',
                            file: 'src/runtime.ts',
                            outline: { symbols: [] },
                            relationshipEvidence: {
                                resolutionClaimCount: 2,
                                resolvedClaimCount: 1,
                                ambiguousClaimCount: 1,
                                unresolvedClaimCount: 0,
                                constructCoverage: [],
                            },
                            hasMore: false,
                        }),
                    }],
                };
            },
        },
    } as unknown as ToolContext;

    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.ts',
        detail: 'relationship_coverage',
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(receivedArgs?.resolveMode, undefined);
    assert.equal(receivedArgs?.symbolIdExact, undefined);
    assert.equal(receivedArgs?.detail, 'relationship_coverage');
});

test('file_outline uses provider vector context when available', async () => {
    let requestedOperation: string | undefined;
    let receivedArgs: Record<string, unknown> | undefined;
    const providerContext = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
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
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperation = operation;
                return providerContext;
            }
        },
        toolHandlers: {
            handleFileOutline: async () => {
                throw new Error('startup context should not handle file_outline when provider context is available');
            }
        }
    } as unknown as ToolContext;

    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.ts',
        resolveMode: 'outline'
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.equal(requestedOperation, 'vector_only');
    assert.equal(receivedArgs?.path, '/repo');
    assert.equal(receivedArgs?.file, 'src/runtime.ts');
});

test('file_outline denies an unauthorized path before provider resolution, handler invocation, or snapshot probes', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-auth-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-auth-b-'));
    try {
        let providerResolved = false;
        let handlerRan = false;
        let snapshotProbes = 0;
        const ctx = {
            workspacePolicy: buildWorkspacePolicy([rootA]),
            providerRuntime: {
                requireToolContext: async () => {
                    providerResolved = true;
                    throw new Error('provider resolution must not run for a denied path');
                },
            },
            snapshotManager: {
                getAllCodebases: () => {
                    snapshotProbes += 1;
                    return [];
                },
            },
            toolHandlers: {
                handleFileOutline: async () => {
                    handlerRan = true;
                    throw new Error('handler must not run for an unauthorized path');
                },
            },
        } as unknown as ToolContext;

        const response = await fileOutlineTool.execute({
            path: rootB,
            file: 'src/runtime.ts',
        }, ctx);
        const payload = JSON.parse(response.content[0].text);

        assert.equal(response.isError, true);
        assert.equal(payload.status, 'error');
        assert.equal(payload.code, 'ROOT_NOT_AUTHORIZED');
        assert.equal(payload.reason, 'root_not_authorized');
        assert.equal(payload.path, rootB);
        assert.equal(typeof payload.message, 'string');
        assert.equal(providerResolved, false);
        assert.equal(handlerRan, false);
        assert.equal(snapshotProbes, 0);
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});

test('file_outline fails closed with WORKSPACE_POLICY_NOT_BOUND when no session policy is bound', async () => {
    let providerResolved = false;
    let handlerRan = false;
    const ctx = {
        providerRuntime: {
            requireToolContext: async () => {
                providerResolved = true;
                throw new Error('provider resolution must not run without a workspace policy');
            },
        },
        toolHandlers: {
            handleFileOutline: async () => {
                handlerRan = true;
                throw new Error('handler must not run without a workspace policy');
            },
        },
    } as unknown as ToolContext;

    const response = await fileOutlineTool.execute({
        path: '/repo',
        file: 'src/runtime.ts',
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(response.isError, true);
    assert.equal(payload.status, 'error');
    assert.equal(payload.code, 'WORKSPACE_POLICY_NOT_BOUND');
    assert.equal(payload.reason, 'workspace_policy_not_bound');
    assert.equal(payload.path, '/repo');
    assert.equal(typeof payload.message, 'string');
    assert.equal(providerResolved, false);
    assert.equal(handlerRan, false);
});

test('file_outline substitutes the authorized canonical path before handler dispatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-canon-'));
    try {
        const receivedPaths: string[] = [];
        const ctx = {
            workspacePolicy: buildWorkspacePolicy([root]),
            toolHandlers: {
                handleFileOutline: async (args: Record<string, unknown>) => {
                    receivedPaths.push(String(args.path));
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                status: 'ok',
                                path: String(args.path),
                                file: 'src/runtime.ts',
                                outline: { symbols: [] },
                                hasMore: false,
                            }),
                        }],
                    };
                },
            },
        } as unknown as ToolContext;

        const response = await fileOutlineTool.execute({
            path: root,
            file: 'src/runtime.ts',
        }, ctx);

        assert.equal(response.isError, undefined);
        // The handler receives the authorized canonical (real) path, never a
        // lexically different caller spelling.
        assert.deepEqual(receivedPaths, [fs.realpathSync(root)]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
