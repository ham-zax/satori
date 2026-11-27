import type { PublicationLease, SymbolRecord, SymbolRegistry } from '@satori-code/core';
import { ToolHandlers } from '../core/handlers.js';
import { ToolResponseBuilders } from "../core/tool-response-builders.js";
import { NavigationHandlers } from '../core/navigation-handlers.js';
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

test('call_graph rejects edge limits over 50', async () => {
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
        limit: 51
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /Invalid arguments for 'call_graph'/);
    assert.match(response.content[0]?.text || '', /limit/);
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

test('call_graph distinguishes an out-of-scope symbol and releases its lease', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'satori-call-graph-scope-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const subtree = path.join(root, 'worker');
    fs.mkdirSync(subtree);
    let released = false;
    const lease = {
        id: 'publication-1', publication: { id: 'publication-1', canonicalRoot: root },
        release: () => { released = true; },
    } as PublicationLease;
    const handlers = new NavigationHandlers({
        prepareNavigationRead: async () => ({ state: 'ready', root: { path: root }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: () => true,
        getPublicationNavigationStatus: async () => 'valid',
        isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload,
        normalizeRelativeFilePath: (file: string) => file,
        stringifyToolJson: JSON.stringify,
        touchWatchedCodebase: async () => undefined,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);
    const result = await handlers.handleCallGraph({
        path: subtree, symbolRef: { file: 'content/client.ts', symbolId: 'client' },
    }, buildWorkspacePolicy([root]));
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    assert.equal(payload.status, 'not_found');
    assert.equal(payload.reason, 'symbol_outside_scope');
    assert.match(payload.message, /outside the requested call_graph path scope/);
    assert.deepEqual(payload.nodes, []);
    assert.deepEqual(payload.edges, []);
    assert.equal(released, true);
});

test("call_graph cancellation stops source scanning and releases the publication lease", async (t) => {
    const root = fs.mkdtempSync(path.resolve("satori-call-graph-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, "0")}.ts`);
    for (const file of files) fs.writeFileSync(path.join(root, file), "request();\n");
    const target = {
        symbolInstanceId: "target", name: "request", file: files[0]!, language: "typescript",
        kind: "function", label: "request", qualifiedName: "request", parentQualifiedNamePath: [],
        span: { startLine: 1, endLine: 1 },
        symbolKey: "target", fileHash: "fixture", extractorVersion: "fixture",
    } as SymbolRecord;
    const registry = {
        manifest: { files: files.map((file) => ({ path: file })) },
        symbolsByFile: new Map([[target.file, [target]]]),
    } as unknown as SymbolRegistry;
    let released = false;
    let published = false;
    let sourceReads = 0;
    let scanning = false;
    const controller = new AbortController();
    const abortReason = new Error("deterministic scan cancellation");
    const lease = {
        id: "publication-1", publication: { id: "publication-1", canonicalRoot: root },
        release: () => { released = true; },
    } as PublicationLease;
    const policy = createSessionWorkspacePolicy({ roots: [root], homeDirectory: path.dirname(root), stateRoot: path.join(root, "state") });
    const navigationHandlers = new NavigationHandlers({
        prepareNavigationRead: async () => ({ state: "ready", root: { path: root }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: () => true,
        getPublicationNavigationStatus: async () => "valid",
        isPartialIndexNavigationUnavailable: () => false,
        isCallGraphLanguageSupported: () => true,
        loadPreparedNavigationSymbolsByFile: async () => ({ status: "ok", registry, symbols: [target] }),
        loadPreparedNavigationCompatibility: async () => ({ relationships: { status: "ok" } }),
        getRegistryFileFreshness: () => ({ status: "fresh" }),
        getPublicationNavigationAddress: () => ({ publicationId: lease.id, navigationRoot: root }),
        buildRelationshipBackedCallGraph: async (input: { findExactSourceReferences: (symbol: SymbolRecord) => Promise<unknown> }) => {
            scanning = true;
            await input.findExactSourceReferences(target);
            throw new Error("cancelled scan must not finish");
        },
        toolResponseBuilders: { buildInvalidCallGraphRequestPayload: (_context: unknown, message: string) => { throw new Error(message); } },
        normalizeRelativeFilePath: (file: string) => file,
        touchWatchedCodebase: async () => { published = true; },
        stringifyToolJson: JSON.stringify,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);
    const toolHandlers = {
        navigationHandlers,
        handleCallGraph: ToolHandlers.prototype.handleCallGraph,
    } as unknown as ToolHandlers;
    const ctx = {
        toolHandlers,
        requestSignal: controller.signal,
        workspacePolicy: {
            ...policy,
            authorizePath(file: string) {
                if (scanning) {
                    sourceReads += 1;
                    controller.abort(abortReason);
                }
                return policy.authorizePath(file);
            },
        },
    } as unknown as ToolContext;
    await assert.rejects(callGraphTool.execute({
        path: root, symbolRef: { file: target.file, symbolId: "target" },
    }, ctx), (error: unknown) => error === abortReason);
    assert.equal(released, true);
    assert.equal(published, false);
    assert.equal(sourceReads, 1);
});

test("call_graph rejects symbolRef missing both symbolId and symbolLabel", async () => {
    const ctx = {
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleCallGraph: async () => {
                throw new Error("handler must not run");
            },
        },
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: "/repo",
        symbolRef: { file: "src/runtime.ts" },
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || "", /symbolId or symbolLabel|Invalid arguments for 'call_graph'/i);
});

test("call_graph resolves unique symbolLabel (bare name and formatted label) and in-root absolute symbolRef.file", async (t) => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "satori-call-graph-label-"));
    t.after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));
    const realRoot = path.join(tmpBase, "real-repo");
    const linkRoot = path.join(tmpBase, "link-repo");
    fs.mkdirSync(path.join(realRoot, "src"), { recursive: true });
    fs.symlinkSync(realRoot, linkRoot, "dir");

    const sourceText = "export function runTarget() {\n  return 1;\n}\n";
    const absFile = path.join(realRoot, "src", "target.ts");
    fs.writeFileSync(absFile, sourceText);

    const targetSymbol = {
        symbolInstanceId: "syminst_run_target",
        name: "runTarget",
        file: "src/target.ts",
        language: "typescript",
        kind: "function",
        label: "function runTarget()",
        qualifiedName: "runTarget",
        parentQualifiedNamePath: [],
        span: { startLine: 1, endLine: 3 },
        symbolKey: "key_run_target",
        fileHash: "hash_target",
        extractorVersion: "1.0.0",
    } as SymbolRecord;
    const registry = {
        manifest: {
            builtAt: "2026-01-01T00:00:00.000Z",
            files: [{ path: "src/target.ts" }],
        },
        symbolsByFile: new Map([["src/target.ts", [targetSymbol]]]),
    } as unknown as SymbolRegistry;
    const lease = {
        id: "publication-1",
        publication: { id: "publication-1", canonicalRoot: fs.realpathSync(realRoot), createdAt: "2026-01-01T00:00:00.000Z" },
        release: () => {},
    } as PublicationLease;
    const canonicalRoot = fs.realpathSync(realRoot);
    const policy = buildWorkspacePolicy([canonicalRoot, linkRoot]);
    const traversedIds: string[] = [];

    const navigationHandlers = new NavigationHandlers({
        prepareNavigationRead: async () => ({ state: "ready", root: { path: canonicalRoot }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload,
        isCallGraphLanguageSupported: () => true,
        loadPreparedNavigationSymbolsByFile: async () => ({
            status: "ok",
            registry,
            symbols: [targetSymbol],
            manifestHash: "manifest-hash-1",
        }),
        loadPreparedNavigationCompatibility: async () => ({
            relationships: { status: "ok", manifestHash: "rel-hash-1", manifest: { builtAt: "2026-01-01T00:00:00.000Z" } },
        }),
        getRegistryFileFreshness: () => ({ status: "fresh" }),
        getPublicationNavigationAddress: () => ({ publicationId: lease.id, navigationRoot: canonicalRoot }),
        buildRelationshipBackedCallGraph: async (input: { resolvedSymbol: SymbolRecord }) => {
            traversedIds.push(input.resolvedSymbol.symbolInstanceId);
            return {
                supported: true,
                nodes: [{
                    symbolId: input.resolvedSymbol.symbolInstanceId,
                    symbolLabel: input.resolvedSymbol.label,
                    file: input.resolvedSymbol.file,
                    language: input.resolvedSymbol.language,
                    span: input.resolvedSymbol.span,
                }],
                edges: [],
                notes: [],
                notesTruncated: false,
                totalNoteCount: 0,
                returnedNoteCount: 0,
            };
        },
        toolResponseBuilders: { buildInvalidCallGraphRequestPayload: ToolResponseBuilders.prototype.buildInvalidCallGraphRequestPayload },
        normalizeRelativeFilePath: (file: string) => file,
        touchWatchedCodebase: async () => {},
        stringifyToolJson: JSON.stringify,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);

    const ctx = {
        workspacePolicy: policy,
        toolHandlers: {
            navigationHandlers,
            handleCallGraph: ToolHandlers.prototype.handleCallGraph,
        } as unknown as ToolHandlers,
    } as unknown as ToolContext;

    // 1. Bare symbol name with repo-relative file
    const byName = await callGraphTool.execute({
        path: linkRoot,
        symbolRef: { file: "src/target.ts", symbolLabel: "runTarget" },
    }, ctx);
    assert.equal(byName.isError, undefined);
    const byNamePayload = JSON.parse(byName.content[0]!.text);
    assert.equal(byNamePayload.status, "ok");
    assert.equal(byNamePayload.symbolRef.symbolId, "syminst_run_target");
    assert.equal(byNamePayload.symbolRef.file, "src/target.ts");

    // 2. Formatted symbolLabel with symlinked-workspace absolute symbolRef.file
    const byFormatted = await callGraphTool.execute({
        path: linkRoot,
        symbolRef: { file: path.join(linkRoot, "src", "target.ts"), symbolLabel: "function runTarget()" },
    }, ctx);
    assert.equal(byFormatted.isError, undefined);
    const byFormattedPayload = JSON.parse(byFormatted.content[0]!.text);
    assert.equal(byFormattedPayload.status, "ok");
    assert.equal(byFormattedPayload.symbolRef.symbolId, "syminst_run_target");
    assert.equal(byFormattedPayload.symbolRef.file, "src/target.ts");
    assert.deepEqual(traversedIds, ["syminst_run_target", "syminst_run_target"]);

    const missingLabel = await callGraphTool.execute({
        path: canonicalRoot, symbolRef: { file: "src/target.ts", symbolLabel: "unextractedName" },
    }, ctx);
    const missingLabelPayload = JSON.parse(missingLabel.content[0]!.text);
    assert.equal(missingLabelPayload.reason, "missing_symbol");
    assert.deepEqual(missingLabelPayload.recommendedNextAction.args, {
        path: canonicalRoot, query: 'path:"src/target.ts" must:"unextractedName"', scope: "mixed",
    });
    assert.equal(missingLabelPayload.symbolRef.symbolId, undefined);
    const missingId = await callGraphTool.execute({
        path: canonicalRoot, symbolRef: { file: "src/target.ts", symbolId: "unknown-id" },
    }, ctx);
    const missingIdPayload = JSON.parse(missingId.content[0]!.text);
    assert.equal(missingIdPayload.reason, "missing_symbol");
    assert.equal(missingIdPayload.recommendedNextAction, undefined);
    assert.equal(missingIdPayload.symbolRef.symbolId, "unknown-id");

    for (const [requestRoot, fileRoot] of [[linkRoot, canonicalRoot], [canonicalRoot, linkRoot]]) {
        const mixed = await callGraphTool.execute({
            path: requestRoot,
            symbolRef: { file: path.join(fileRoot, "src", "target.ts"), symbolLabel: "function runTarget()" },
        }, ctx);
        assert.equal(mixed.isError, undefined, mixed.content[0]!.text);
        assert.deepEqual(JSON.parse(mixed.content[0]!.text), byFormattedPayload);
    }
    const outside = await callGraphTool.execute({
        path: linkRoot,
        symbolRef: { file: path.join(tmpBase, "outside.ts"), symbolLabel: "runTarget" },
    }, ctx);
    assert.equal(outside.isError, true);
    const outsidePayload = JSON.parse(outside.content[0]!.text);
    assert.equal(outsidePayload.reason, "invalid_symbol_ref");
    assert.match(outsidePayload.message, /must resolve inside the indexed codebase root/);
    assert.deepEqual(traversedIds, Array(4).fill("syminst_run_target"));
});

test("call_graph fails closed with ambiguous_symbol and capped deterministic candidates when symbolLabel matches multiple symbols", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-call-graph-ambig-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "overloads.ts"), "export function parse(a: string): string;\nexport function parse(a: number): number;\n");

    const symbols: SymbolRecord[] = Array.from({ length: 25 }, (_, index) => ({
        symbolInstanceId: `syminst_parse_${String(25 - index).padStart(2, "0")}`,
        name: "parse",
        file: "overloads.ts",
        language: "typescript",
        kind: "function",
        label: `function parse(v${index})`,
        qualifiedName: "parse",
        parentQualifiedNamePath: [],
        span: { startLine: index + 1, endLine: index + 1 },
        symbolKey: `key_parse_${index}`,
        fileHash: "hash_overloads",
        extractorVersion: "1.0.0",
    } as SymbolRecord));

    const registry = {
        manifest: { builtAt: "2026-01-01T00:00:00.000Z", files: [{ path: "overloads.ts" }] },
        symbolsByFile: new Map([["overloads.ts", symbols]]),
    } as unknown as SymbolRegistry;
    const lease = {
        id: "publication-1",
        publication: { id: "publication-1", canonicalRoot: fs.realpathSync(root) },
        release: () => {},
    } as PublicationLease;
    const canonicalRoot = fs.realpathSync(root);
    let traversalCalled = false;

    const navigationHandlers = new NavigationHandlers({
        prepareNavigationRead: async () => ({ state: "ready", root: { path: canonicalRoot }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => "valid",
        isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload,
        loadPreparedNavigationSymbolsByFile: async () => ({
            status: "ok",
            registry,
            symbols,
            manifestHash: "manifest-hash-1",
        }),
        buildRelationshipBackedCallGraph: async () => {
            traversalCalled = true;
            throw new Error("traversal must not run on ambiguous_symbol");
        },
        normalizeRelativeFilePath: (file: string) => file,
        stringifyToolJson: JSON.stringify,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);

    const ctx = {
        workspacePolicy: buildWorkspacePolicy([canonicalRoot]),
        toolHandlers: {
            navigationHandlers,
            handleCallGraph: ToolHandlers.prototype.handleCallGraph,
        } as unknown as ToolHandlers,
    } as unknown as ToolContext;

    const response = await callGraphTool.execute({
        path: canonicalRoot,
        symbolRef: { file: "overloads.ts", symbolLabel: "parse" },
    }, ctx);

    assert.equal(response.isError, undefined);
    const payload = JSON.parse(response.content[0]!.text);
    assert.equal(payload.status, "not_found");
    assert.equal(payload.reason, "ambiguous_symbol");
    assert.equal(payload.supported, false);
    assert.deepEqual(payload.nodes, []);
    assert.deepEqual(payload.edges, []);
    assert.equal(traversalCalled, false);
    assert.equal(payload.totalCandidateCount, 25);
    assert.equal(payload.candidates.length, 20);
    assert.deepEqual(payload.candidates[0], {
        symbolId: "syminst_parse_25",
        symbolLabel: "function parse(v0)",
        kind: "function",
        file: "overloads.ts",
        span: { startLine: 1, endLine: 1 },
    });
});
