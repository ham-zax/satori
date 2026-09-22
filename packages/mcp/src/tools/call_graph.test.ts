import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callGraphTool } from './call_graph.js';
import { ToolContext } from './types.js';
import {
    createSessionWorkspacePolicy,
    type SessionWorkspacePolicy,
} from '../core/session-workspace-policy.js';

function buildWorkspacePolicy(roots: readonly string[]): SessionWorkspacePolicy {
    return createSessionWorkspacePolicy({
        roots,
        homeDirectory: os.homedir(),
        stateRoot: path.join(os.tmpdir(), 'call-graph-test-state'),
    });
}

/** Session policy authorizing the synthetic '/repo' fixture used by existing tests. */
const REPO_WORKSPACE_POLICY = buildWorkspacePolicy(['/repo']);

test('call_graph rejects relative path', async () => {
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
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
        workspacePolicy: REPO_WORKSPACE_POLICY,
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

test('call_graph rejects Windows drive-relative symbolRef.file C:secret.ts', async () => {
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleCallGraph: async () => {
                throw new Error('handler must not run');
            }
        }
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: '/repo',
        symbolRef: {
            file: 'C:secret.ts',
            symbolId: 'sym_runtime_run'
        },
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /repo-relative|drive-relative|Invalid arguments for 'call_graph'/i);
});

test('call_graph normalizes direction bidirectional to both before validation/dispatch', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
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

test('call_graph forwards bounded evidence paging requests', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
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
        evidence: {
            kind: 'exact_references',
            limit: 7,
            cursor: '{"cursor":"fixture"}'
        }
    }, ctx);

    assert.equal(response.isError, undefined);
    assert.deepEqual(receivedArgs?.evidence, {
        kind: 'exact_references',
        limit: 7,
        cursor: '{"cursor":"fixture"}'
    });
});

test('call_graph rejects unbounded evidence page sizes', async () => {
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleCallGraph: async () => {
                throw new Error('handler must not run');
            }
        }
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: '/repo',
        symbolRef: {
            file: 'src/runtime.ts',
            symbolId: 'sym_runtime_run'
        },
        evidence: {
            kind: 'construct_gaps',
            limit: 51
        }
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /Invalid arguments for 'call_graph'/);
    assert.match(response.content[0]?.text || '', /evidence/);
});

test('call_graph keeps strict validation for invalid direction values', async () => {
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
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
        workspacePolicy: REPO_WORKSPACE_POLICY,
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
        workspacePolicy: REPO_WORKSPACE_POLICY,
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

test('call_graph denies an unauthorized path before provider resolution, handler invocation, or snapshot probes', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'call-graph-auth-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'call-graph-auth-b-'));
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
                handleCallGraph: async () => {
                    handlerRan = true;
                    throw new Error('handler must not run for an unauthorized path');
                },
            },
        } as unknown as ToolContext;

        const response = await callGraphTool.execute({
            path: rootB,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run',
            },
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

test('call_graph fails closed with WORKSPACE_POLICY_NOT_BOUND when no session policy is bound', async () => {
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
            handleCallGraph: async () => {
                handlerRan = true;
                throw new Error('handler must not run without a workspace policy');
            },
        },
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: '/repo',
        symbolRef: {
            file: 'src/runtime.ts',
            symbolId: 'sym_runtime_run',
        },
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

test('call_graph substitutes the authorized canonical path before handler dispatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'call-graph-canon-'));
    try {
        const receivedPaths: string[] = [];
        const ctx = {
            workspacePolicy: buildWorkspacePolicy([root]),
            toolHandlers: {
                handleCallGraph: async (args: Record<string, unknown>) => {
                    receivedPaths.push(String(args.path));
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                status: 'ok',
                                path: String(args.path),
                                supported: true,
                                nodes: [],
                                edges: [],
                                notes: [],
                            }),
                        }],
                    };
                },
            },
        } as unknown as ToolContext;

        const response = await callGraphTool.execute({
            path: root,
            symbolRef: {
                file: 'src/runtime.ts',
                symbolId: 'sym_runtime_run',
            },
        }, ctx);

        assert.equal(response.isError, undefined);
        // The handler receives the authorized canonical (real) path, never a
        // lexically different caller spelling.
        assert.deepEqual(receivedPaths, [fs.realpathSync(root)]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
