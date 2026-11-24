import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SYMBOL_REGISTRY_SCHEMA_VERSION,
    buildSymbolRecordsForFile,
    createLanguageAnalysisService,
    detectLanguageId,
    type PublicationLease,
    type SymbolRecord,
    type SymbolRegistry,
} from '@satori-code/core';
import { ToolHandlers } from '../core/handlers.js';
import { ToolResponseBuilders } from '../core/tool-response-builders.js';
import { NavigationHandlers } from '../core/navigation-handlers.js';
import { buildRegistryFileOutlinePayload } from '../core/registry-file-outline.js';
import type { FileOutlineSymbolResult } from '../core/search-types.js';
import {
    composeSymbolContext,
    type ComposeSymbolContextInput,
    type PreparedSymbolContextSnapshot,
} from '../core/symbol-context-composer.js';
import { fileOutlineTool } from './file_outline.js';
import { readFileTool } from './read_file.js';
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

test('file_outline rejects exact symbol filters outside resolveMode=exact', async () => {
    for (const filter of [{ symbolIdExact: 'sym-1' }, { symbolLabelExact: 'method add' }]) {
        const response = await fileOutlineTool.execute({
            path: '/repo',
            file: 'src/runtime.ts',
            ...filter,
        }, buildContext());

        assert.equal(response.isError, true);
        assert.match(response.content[0]?.text || '', /require resolveMode="exact"/);
    }
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

test('file_outline accepts in-root absolute paths (including under symlinked workspace roots), enforces subdirectory scope, and still rejects final-component symlinks', async (t) => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-boundary-abs-'));
    t.after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

    const realRoot = path.join(tmpBase, 'real-repo');
    const linkRoot = path.join(tmpBase, 'link-repo');
    const outsideFile = path.join(tmpBase, 'outside.ts');
    fs.mkdirSync(path.join(realRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(realRoot, 'other'), { recursive: true });
    fs.symlinkSync(realRoot, linkRoot, 'dir');
    fs.writeFileSync(outsideFile, 'export const secret = 1;\n');

    const sourceA = 'export function alpha() {\n  return 42;\n}\n';
    const sourceOther = 'export function beta() {\n  return 7;\n}\n';
    const fileA = path.join(realRoot, 'src', 'a.ts');
    const fileOther = path.join(realRoot, 'other', 'b.ts');
    fs.writeFileSync(fileA, sourceA);
    fs.writeFileSync(fileOther, sourceOther);

    // Final-component symlinks inside the repo: one pointing inside, one pointing outside
    const finalSymlinkInside = path.join(realRoot, 'src', 'link-inside.ts');
    const finalSymlinkOutside = path.join(realRoot, 'src', 'link-outside.ts');
    fs.symlinkSync(fileA, finalSymlinkInside);
    fs.symlinkSync(outsideFile, finalSymlinkOutside);

    const hashA = crypto.createHash('sha256').update(sourceA).digest('hex');
    const hashOther = crypto.createHash('sha256').update(sourceOther).digest('hex');
    const symbolA = {
        symbolInstanceId: 'syminst_alpha',
        name: 'alpha',
        file: 'src/a.ts',
        language: 'typescript',
        kind: 'function',
        label: 'function alpha()',
        qualifiedName: 'alpha',
        parentQualifiedNamePath: [],
        span: { startLine: 1, endLine: 3 },
        symbolKey: 'key_alpha',
        fileHash: hashA,
        extractorVersion: '1.0.0',
    } as SymbolRecord;

    const canonicalRoot = fs.realpathSync(realRoot);
    const registry = {
        manifest: {
            builtAt: '2026-01-01T00:00:00.000Z',
            files: [
                { path: 'src/a.ts', hash: hashA },
                { path: 'other/b.ts', hash: hashOther },
                // Even if manifest listed the symlink name, FINAL_SYMLINK_REJECTED must still block it
                { path: 'src/link-inside.ts', hash: hashA },
                { path: 'src/link-outside.ts', hash: hashA },
            ],
        },
        symbolsByFile: new Map([
            ['src/a.ts', [symbolA]],
            ['src/link-inside.ts', [symbolA]],
            ['src/link-outside.ts', [symbolA]],
        ]),
    } as unknown as SymbolRegistry;
    const lease = {
        id: 'publication-1',
        publication: { id: 'publication-1', canonicalRoot },
        release: () => {},
    } as PublicationLease;
    const policy = buildWorkspacePolicy([canonicalRoot, linkRoot]);

    const navigationHandlers = new NavigationHandlers({
        toolResponseBuilders: { buildInvalidFileOutlineRequestPayload: ToolResponseBuilders.prototype.buildInvalidFileOutlineRequestPayload },
        prepareNavigationRead: async () => ({ state: 'ready', root: { path: canonicalRoot }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => 'valid',
        isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload,
        loadPreparedNavigationSymbolsByFile: async (_state: unknown, relFile: string) => ({
            status: 'ok',
            registry,
            symbols: registry.symbolsByFile.get(relFile) ?? [],
            manifestHash: 'manifest-hash-1',
        }),
        getRegistryFileFreshness: () => ({ status: 'fresh' }),
        loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: false }),
        buildRegistrySymbolCallGraphHint: () => ({ supported: false, reason: 'missing_relationship_navigation' }),
        buildOutlineSpanWarningCodes: () => [],
        normalizeRelativeFilePath: (file: string) => file,
        touchWatchedCodebase: async () => {},
        stringifyToolJson: JSON.stringify,
        readFileMaxBytes: 1024 * 1024,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);

    const ctx = {
        workspacePolicy: policy,
        toolHandlers: {
            navigationHandlers,
            handleFileOutline: ToolHandlers.prototype.handleFileOutline,
        } as unknown as ToolHandlers,
    } as unknown as ToolContext;

    // 1. Repo-relative baseline vs symlinked-workspace absolute path produce identical output
    const relResponse = await fileOutlineTool.execute({
        path: linkRoot,
        file: 'src/a.ts',
    }, ctx);
    assert.equal(relResponse.isError, undefined);
    const relPayload = JSON.parse(relResponse.content[0]!.text);

    const absSymlinkRootResponse = await fileOutlineTool.execute({
        path: linkRoot,
        file: path.join(linkRoot, 'src', 'a.ts'),
    }, ctx);
    assert.equal(absSymlinkRootResponse.isError, undefined);
    const absPayload = JSON.parse(absSymlinkRootResponse.content[0]!.text);
    assert.deepEqual(absPayload, relPayload);
    assert.equal(absPayload.file, 'src/a.ts');
    assert.equal(absPayload.outline.symbols[0].symbolId, 'syminst_alpha');

    for (const [requestRoot, fileRoot] of [[linkRoot, canonicalRoot], [canonicalRoot, linkRoot]]) {
        const mixed = await fileOutlineTool.execute({ path: requestRoot, file: path.join(fileRoot, 'src', 'a.ts') }, ctx);
        assert.equal(mixed.isError, undefined, mixed.content[0]!.text);
        assert.deepEqual(JSON.parse(mixed.content[0]!.text), relPayload);
    }

    // 2. Nested subdirectory scope: resolves against matched indexed root (canonicalRoot),
    // allows in-subdir file, and rejects sibling file outside requested subdirectory
    const nestedOk = await fileOutlineTool.execute({
        path: path.join(linkRoot, 'src'),
        file: path.join(linkRoot, 'src', 'a.ts'),
    }, ctx);
    assert.equal(nestedOk.isError, undefined);
    assert.equal(JSON.parse(nestedOk.content[0]!.text).file, 'src/a.ts');

    const nestedSiblingDenied = await fileOutlineTool.execute({
        path: path.join(linkRoot, 'src'),
        file: path.join(linkRoot, 'other', 'b.ts'),
    }, ctx);
    assert.equal(nestedSiblingDenied.isError, true);

    const outside = await fileOutlineTool.execute({ path: linkRoot, file: outsideFile }, ctx);
    assert.equal(outside.isError, true);
    const outsidePayload = JSON.parse(outside.content[0]!.text);
    assert.equal(outsidePayload.reason, 'invalid_request');
    assert.equal(outsidePayload.outline, null);
    assert.match(outsidePayload.message, /must resolve inside the indexed codebase root/);

    // 3. Final-component symlinks (both pointing inside repo and pointing outside repo) are rejected
    for (const symlinkPath of [
        path.join(linkRoot, 'src', 'link-inside.ts'),
        path.join(linkRoot, 'src', 'link-outside.ts'),
    ]) {
        const symlinkResponse = await fileOutlineTool.execute({
            path: linkRoot,
            file: symlinkPath,
        }, ctx);
        assert.equal(symlinkResponse.isError, true);
        const symlinkPayload = JSON.parse(symlinkResponse.content[0]!.text);
        assert.equal(symlinkPayload.status, 'not_found');
        assert.equal(symlinkPayload.outline, null);
    }

    // 4. Traversal segments inside an absolute file path are rejected
    const traversalResponse = await fileOutlineTool.execute({
        path: linkRoot,
        file: `${linkRoot}/src/../../outside.ts`,
    }, ctx);
    assert.equal(traversalResponse.isError, true);
});

const DART_HOLDER_SOURCE = [
    'class Holder {',
    '  final int value;',
    '  const Holder(this.value);',
    '}',
    '',
    'extension HolderMath on Holder {',
    '  int doubled() => value + value;',
    '  int tripled() => value + value + value;',
    "  String describeHolder() => 'holder';",
    '}',
    '',
    'int topLevelHelper(int x) => x + 1;',
    '',
    'extension on String {',
    '  bool isShout() => this == toUpperCase();',
    '}',
    '',
].join('\n');

function buildDartRegistry(root: string, symbols: SymbolRecord[]): SymbolRegistry {
    const symbolsByInstanceId = new Map(symbols.map((entry) => [entry.symbolInstanceId, entry]));
    const symbolsByKey = new Map<string, SymbolRecord[]>();
    const symbolsByFile = new Map<string, SymbolRecord[]>();
    const symbolsByLabel = new Map<string, SymbolRecord[]>();
    const symbolsByQualifiedName = new Map<string, SymbolRecord[]>();
    for (const entry of symbols) {
        for (const [map, key] of [
            [symbolsByKey, entry.symbolKey],
            [symbolsByFile, entry.file],
            [symbolsByLabel, entry.label],
            [symbolsByQualifiedName, entry.qualifiedName],
        ] as const) {
            map.set(key, [...(map.get(key) || []), entry]);
        }
    }
    return {
        manifest: {
            schemaVersion: SYMBOL_REGISTRY_SCHEMA_VERSION,
            normalizedRootPath: root,
            rootFingerprint: 'root-fp',
            indexPolicyHash: 'policy-hash',
            languageRouterVersion: 'router',
            extractorVersion: 'extractor',
            relationshipVersion: 'relationships',
            builtAt: '2026-11-24T00:00:00.000Z',
            files: [],
        },
        symbols,
        symbolsByInstanceId,
        symbolsByKey,
        symbolsByFile,
        symbolsByLabel,
        symbolsByQualifiedName,
        warnings: [],
    };
}

test('Dart extensions survive the agent-visible outline and exact-symbol read path', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-dart-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const relativeFile = 'lib/holder.dart';
    const absoluteFile = path.join(root, relativeFile);
    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
    fs.writeFileSync(absoluteFile, DART_HOLDER_SOURCE, 'utf8');

    assert.equal(detectLanguageId(relativeFile, DART_HOLDER_SOURCE), 'dart');
    const analysis = await createLanguageAnalysisService().analyze({
        content: DART_HOLDER_SOURCE,
        language: 'dart',
        relativePath: relativeFile,
    });
    const fileBytes = Buffer.from(DART_HOLDER_SOURCE, 'utf8');
    const fileHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
    const records = buildSymbolRecordsForFile({
        relativePath: relativeFile,
        language: 'dart',
        content: DART_HOLDER_SOURCE,
        fileHash,
        extractorVersion: 'test',
        chunks: [...analysis.chunks],
        extractedSymbols: analysis.symbols,
    });

    const outlineCtx = {
        workspacePolicy: buildWorkspacePolicy([root]),
        toolHandlers: {
            handleFileOutline: async () => {
                const payload = await buildRegistryFileOutlinePayload({
                    codebaseRoot: root,
                    file: relativeFile,
                    symbols: records,
                    limitSymbols: 500,
                    resolveMode: 'outline',
                    buildCallGraphHint: () => ({ supported: false, reason: 'test' }) as never,
                    buildOutlineSpanWarningCodes: () => [],
                    readSourceLines: async () => undefined,
                });
                return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
            },
        },
    } as unknown as ToolContext;
    const outline = await fileOutlineTool.execute({ path: root, file: relativeFile }, outlineCtx);
    assert.equal(outline.isError, undefined);
    const outlinePayload = JSON.parse(outline.content[0].text);
    assert.equal(outlinePayload.status, 'ok');

    const expected = new Map([
        ['Holder', { kind: 'class', label: 'class Holder', lines: [1, 4], text: 'class Holder {\n  final int value;\n  const Holder(this.value);\n}' }],
        ['HolderMath', { kind: 'class', label: 'class HolderMath', lines: [6, 10], text: "extension HolderMath on Holder {\n  int doubled() => value + value;\n  int tripled() => value + value + value;\n  String describeHolder() => 'holder';\n}" }],
        ['HolderMath.doubled', { kind: 'method', label: 'method doubled', lines: [7, 7], text: 'int doubled() => value + value;' }],
        ['HolderMath.tripled', { kind: 'method', label: 'method tripled', lines: [8, 8], text: 'int tripled() => value + value + value;' }],
        ['HolderMath.describeHolder', { kind: 'method', label: 'method describeHolder', lines: [9, 9], text: "String describeHolder() => 'holder';" }],
        ['topLevelHelper', { kind: 'function', label: 'function topLevelHelper', lines: [12, 12], text: 'int topLevelHelper(int x) => x + 1;' }],
        ['isShout', { kind: 'function', label: 'function isShout', lines: [15, 15], text: 'bool isShout() => this == toUpperCase();' }],
    ]);
    const outlined = new Map<string, FileOutlineSymbolResult>(
        (outlinePayload.outline.symbols as FileOutlineSymbolResult[]).map((symbol) => [symbol.qualifiedName, symbol]),
    );
    assert.equal(outlined.size, expected.size);
    assert.equal(new Set([...outlined.values()].map((symbol) => symbol.symbolId)).size, expected.size);
    for (const [qualifiedName, want] of expected) {
        const symbol = outlined.get(qualifiedName);
        assert.ok(symbol, qualifiedName);
        const record = records.find((entry) => entry.qualifiedName === qualifiedName);
        assert.ok(record, qualifiedName);
        assert.equal(symbol.kind, want.kind, qualifiedName);
        assert.equal(symbol.symbolLabel, want.label, qualifiedName);
        assert.equal(symbol.symbolId, record.symbolInstanceId, qualifiedName);
        assert.deepEqual([symbol.span.startLine, symbol.span.endLine], want.lines, qualifiedName);
        assert.deepEqual(
            [symbol.span.startByte, symbol.span.endByte],
            [record.span.startByte, record.span.endByte],
            qualifiedName,
        );
        const bytes = fileBytes.subarray(record.span.startByte, record.span.endByte).toString('utf8');
        assert.equal(bytes, want.text, qualifiedName);
    }
    assert.deepEqual(outlined.get('HolderMath.doubled')!.parentQualifiedNamePath, ['HolderMath']);
    assert.deepEqual(outlined.get('isShout')!.parentQualifiedNamePath, []);

    const snapshot: PreparedSymbolContextSnapshot = {
        canonicalRoot: root,
        registryManifestIdentity: 'dart-registry-manifest',
        registry: buildDartRegistry(root, records),
        navigationAuthority: 'remote_generation_proven',
        relationships: {
            status: 'available',
            authority: 'remote_generation_proven',
            manifestIdentity: 'dart-relationship-manifest',
            callers: { edges: [], availableCount: 0, suppressedCount: 0, suppressionNotes: [] },
            callees: { edges: [], availableCount: 0, suppressedCount: 0, suppressionNotes: [] },
        },
        validateAuthority: async () => true,
    };
    const publication = { publication: { canonicalRoot: root } };
    const readCtx = {
        readFileMaxLines: 200,
        workspacePolicy: buildWorkspacePolicy([root]),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({ fileHashes: [[relativeFile, fileHash]] }),
            hasSearchableGeneration: () => true,
            getCurrentSearchGeneration: () => ({ generationId: 'gen-1', compatibility: 'compatible' }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
        toolHandlers: {
            composeSymbolContext: async (input: ComposeSymbolContextInput) => composeSymbolContext(input, {
                prepareSnapshot: async () => ({ status: 'ready', snapshot }),
                prepareSource: async () => ({
                    status: 'available',
                    evidence: {
                        canonicalRoot: root,
                        relativeFile,
                        sourceBytes: fileBytes,
                        source: DART_HOLDER_SOURCE,
                        sourceByteLength: fileBytes.length,
                        observedHash: fileHash,
                        identity: {
                            platform: 'linux',
                            stableIdentity: 'dart-fixture-id',
                            canonicalRelativePath: relativeFile,
                            strength: 'target_only',
                        },
                        selectionCapabilities: {
                            localLexical: 'available',
                            lineWindows: 'available',
                            syntaxBoundaries: 'unavailable_streaming_source',
                            controlFlowAnchors: 'unavailable_streaming_source',
                        },
                    },
                    finalizer: {
                        finalize: async () => ({ status: 'available', freshness: 'current_at_final_observation' }),
                        release: async () => undefined,
                    },
                }),
            }),
        },
    } as unknown as ToolContext;

    const sourceLines = DART_HOLDER_SOURCE.replace(/\n$/, '').split('\n');
    for (const [qualifiedName, declaration] of [
        ['HolderMath.doubled', 'int doubled() => value + value;'],
        ['isShout', 'bool isShout() => this == toUpperCase();'],
    ] as const) {
        const record = records.find((entry) => entry.qualifiedName === qualifiedName);
        assert.ok(record, qualifiedName);
        const response = await readFileTool.execute({
            path: absoluteFile,
            codebaseRoot: root,
            open_symbol: { contractVersion: 2, symbolId: record.symbolInstanceId },
        }, readCtx);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.kind, 'symbol_context', qualifiedName);
        assert.equal(payload.status, 'ok', qualifiedName);
        assert.equal(payload.symbol.symbolId, record.symbolInstanceId, qualifiedName);
        assert.equal(payload.symbol.qualifiedName, qualifiedName);
        assert.equal(payload.source.status, 'available', qualifiedName);
        assert.equal(payload.source.mode, 'complete', qualifiedName);
        assert.equal(payload.source.truncated, false, qualifiedName);
        assert.equal(payload.source.excerpts.length, 1, qualifiedName);
        const content = payload.source.excerpts[0].content;
        assert.equal(content, sourceLines[record.span.startLine - 1], qualifiedName);
        assert.equal(content.trim(), declaration, qualifiedName);
    }
});

test('Dart multiline block-body extensions preserve full spans through file_outline and read_file(open_symbol)', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-dart-multiline-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const relativeFile = 'lib/multiline.dart';
    const absoluteFile = path.join(root, relativeFile);
    const source = [
        'extension Accumulator on int {',
        '  int scaled(int factor) {',
        '    final total = this * factor;',
        '    return total;',
        '  }',
        '}',
        '',
        'extension on String {',
        '  String shoutWrapped() {',
        '    final upper = toUpperCase();',
        '    return "[$upper]";',
        '  }',
        '}',
        '',
    ].join('\n');
    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
    fs.writeFileSync(absoluteFile, source, 'utf8');

    const analysis = await createLanguageAnalysisService().analyze({
        content: source,
        language: 'dart',
        relativePath: relativeFile,
    });
    const fileBytes = Buffer.from(source, 'utf8');
    const fileHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
    const records = buildSymbolRecordsForFile({
        relativePath: relativeFile,
        language: 'dart',
        content: source,
        fileHash,
        extractorVersion: 'test',
        chunks: [...analysis.chunks],
        extractedSymbols: analysis.symbols,
    });

    const outlinePayload = await buildRegistryFileOutlinePayload({
        codebaseRoot: root,
        file: relativeFile,
        symbols: records,
        limitSymbols: 500,
        resolveMode: 'outline',
        buildCallGraphHint: () => ({ supported: false, reason: 'test' }) as never,
        buildOutlineSpanWarningCodes: () => [],
        readSourceLines: async () => undefined,
    });
    const outlined = new Map<string, FileOutlineSymbolResult>(
        (outlinePayload.outline!.symbols as FileOutlineSymbolResult[]).map((symbol) => [symbol.qualifiedName, symbol]),
    );
    assert.deepEqual([outlined.get('Accumulator.scaled')!.span.startLine, outlined.get('Accumulator.scaled')!.span.endLine], [2, 5]);
    assert.deepEqual([outlined.get('shoutWrapped')!.span.startLine, outlined.get('shoutWrapped')!.span.endLine], [9, 12]);

    const snapshot: PreparedSymbolContextSnapshot = {
        canonicalRoot: root,
        registryManifestIdentity: 'dart-ml-manifest',
        registry: buildDartRegistry(root, records),
        navigationAuthority: 'remote_generation_proven',
        relationships: {
            status: 'available',
            authority: 'remote_generation_proven',
            manifestIdentity: 'dart-ml-rel',
            callers: { edges: [], availableCount: 0, suppressedCount: 0, suppressionNotes: [] },
            callees: { edges: [], availableCount: 0, suppressedCount: 0, suppressionNotes: [] },
        },
        validateAuthority: async () => true,
    };
    const publication = { publication: { canonicalRoot: root } };
    const readCtx = {
        readFileMaxLines: 200,
        workspacePolicy: buildWorkspacePolicy([root]),
        context: {
            listCurrentPublications: () => [publication],
            getCurrentPublication: (codebaseRoot: string) => codebaseRoot === root ? publication : undefined,
            getPublicationSourceCheckpoint: () => ({ fileHashes: [[relativeFile, fileHash]] }),
            hasSearchableGeneration: () => true,
            getCurrentSearchGeneration: () => ({ generationId: 'gen-1', compatibility: 'compatible' }),
        },
        mutationRuntime: { listActiveMutations: () => [], getOperation: () => undefined },
        syncManager: { touchWatchedCodebase: async () => undefined },
        toolHandlers: {
            composeSymbolContext: async (input: ComposeSymbolContextInput) => composeSymbolContext(input, {
                prepareSnapshot: async () => ({ status: 'ready', snapshot }),
                prepareSource: async () => ({
                    status: 'available',
                    evidence: {
                        canonicalRoot: root,
                        relativeFile,
                        sourceBytes: fileBytes,
                        source,
                        sourceByteLength: fileBytes.length,
                        observedHash: fileHash,
                        identity: {
                            platform: 'linux',
                            stableIdentity: 'dart-ml-fixture',
                            canonicalRelativePath: relativeFile,
                            strength: 'target_only',
                        },
                        selectionCapabilities: {
                            localLexical: 'available',
                            lineWindows: 'available',
                            syntaxBoundaries: 'unavailable_streaming_source',
                            controlFlowAnchors: 'unavailable_streaming_source',
                        },
                    },
                    finalizer: {
                        finalize: async () => ({ status: 'available', freshness: 'current_at_final_observation' }),
                        release: async () => undefined,
                    },
                }),
            }),
        },
    } as unknown as ToolContext;

    for (const [qualifiedName, expectedLines] of [
        ['Accumulator.scaled', ['  int scaled(int factor) {', '    final total = this * factor;', '    return total;', '  }']],
        ['shoutWrapped', ['  String shoutWrapped() {', '    final upper = toUpperCase();', '    return "[$upper]";', '  }']],
    ] as const) {
        const record = records.find((entry) => entry.qualifiedName === qualifiedName);
        assert.ok(record, qualifiedName);
        const response = await readFileTool.execute({
            path: absoluteFile,
            codebaseRoot: root,
            open_symbol: { contractVersion: 2, symbolId: record.symbolInstanceId },
        }, readCtx);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, 'ok', qualifiedName);
        assert.equal(payload.source.excerpts[0].content, expectedLines.join('\n'), qualifiedName);
    }
});

test('file_outline returns unsupported_language for ObjectScript UDL .cls and structural_evidence_unavailable for Apex .cls when structural_unavailable', async (t) => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-cls-')));
    t.after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

    const udlRel = 'Demo/Widget.cls';
    const apexRel = 'classes/Broken.cls';
    const udlSource = 'Class Demo.Widget Extends %RegisteredObject {\n  Method Run() As %Status {\n    Quit $$$OK\n  }\n}\n';
    const apexSource = 'public class Broken {\n    public void run(\n}\n';

    fs.mkdirSync(path.join(tmpBase, 'Demo'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'classes'), { recursive: true });
    fs.writeFileSync(path.join(tmpBase, udlRel), udlSource, 'utf8');
    fs.writeFileSync(path.join(tmpBase, apexRel), apexSource, 'utf8');

    const udlHash = crypto.createHash('sha256').update(udlSource).digest('hex');
    const apexHash = crypto.createHash('sha256').update(apexSource).digest('hex');

    const registry = {
        manifest: {
            builtAt: '2026-01-01T00:00:00.000Z',
            files: [
                { path: udlRel, hash: udlHash, definitionStatus: 'structural_unavailable' },
                { path: apexRel, hash: apexHash, definitionStatus: 'structural_unavailable' },
            ],
        },
        symbolsByFile: new Map<string, SymbolRecord[]>([
            [udlRel, []],
            [apexRel, []],
        ]),
    } as unknown as SymbolRegistry;
    const lease = {
        id: 'publication-cls',
        publication: { id: 'publication-cls', canonicalRoot: tmpBase },
        release: () => {},
    } as PublicationLease;

    const navigationHandlers = new NavigationHandlers({
        toolResponseBuilders: { buildInvalidFileOutlineRequestPayload: ToolResponseBuilders.prototype.buildInvalidFileOutlineRequestPayload },
        prepareNavigationRead: async () => ({ state: 'ready', root: { path: tmpBase }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => 'valid',
        isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload,
        loadPreparedNavigationSymbolsByFile: async (_state: unknown, relFile: string) => ({
            status: 'ok',
            registry,
            symbols: registry.symbolsByFile.get(relFile) ?? [],
            manifestHash: 'manifest-hash-cls',
        }),
        getRegistryFileFreshness: () => ({ status: 'fresh' }),
        loadRegistryValidatedRelationshipNavigation: async () => ({ relationshipReady: false }),
        buildRegistrySymbolCallGraphHint: () => ({ supported: false, reason: 'missing_relationship_navigation' }),
        buildOutlineSpanWarningCodes: () => [],
        normalizeRelativeFilePath: (file: string) => file,
        touchWatchedCodebase: async () => {},
        stringifyToolJson: JSON.stringify,
        readFileMaxBytes: 1024 * 1024,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);

    const ctx = {
        workspacePolicy: buildWorkspacePolicy([tmpBase]),
        toolHandlers: {
            navigationHandlers,
            handleFileOutline: ToolHandlers.prototype.handleFileOutline,
        } as unknown as ToolHandlers,
    } as unknown as ToolContext;

    const udlResponse = await fileOutlineTool.execute({ path: tmpBase, file: udlRel }, ctx);
    assert.equal(udlResponse.isError, undefined);
    const udlPayload = JSON.parse(udlResponse.content[0]!.text);
    assert.equal(udlPayload.status, 'unsupported');
    assert.equal(udlPayload.reason, 'unsupported_language');
    assert.equal(udlPayload.outline, null);

    const apexResponse = await fileOutlineTool.execute({ path: tmpBase, file: apexRel }, ctx);
    assert.equal(apexResponse.isError, undefined);
    const apexPayload = JSON.parse(apexResponse.content[0]!.text);
    assert.equal(apexPayload.status, 'not_ready');
    assert.equal(apexPayload.reason, 'structural_evidence_unavailable');
    assert.equal(apexPayload.outline, null);
});

test('file_outline missing-registry branch disambiguates .cls by content: UDL and VB6 return unsupported_language while Apex returns requires_reindex', async (t) => {
    const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-outline-cls-missing-')));
    t.after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

    const udlRel = 'Demo/Widget.cls';
    const vb6Rel = 'vb6/Customer.cls';
    const apexRel = 'classes/AccountService.cls';
    fs.mkdirSync(path.join(tmpBase, 'Demo'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'vb6'), { recursive: true });
    fs.mkdirSync(path.join(tmpBase, 'classes'), { recursive: true });
    fs.writeFileSync(path.join(tmpBase, udlRel), 'Class Demo.Widget Extends %RegisteredObject {\n  Method Run() As %Status {\n    Quit $$$OK\n  }\n}\n', 'utf8');
    fs.writeFileSync(path.join(tmpBase, vb6Rel), 'VERSION 1.0 CLASS\nBEGIN\n  MultiUse = -1\nEND\nAttribute VB_Name = "Customer"\n', 'utf8');
    fs.writeFileSync(path.join(tmpBase, apexRel), 'public with sharing class AccountService {\n    public static void run() {}\n}\n', 'utf8');

    const lease = {
        id: 'publication-cls-missing',
        publication: { id: 'publication-cls-missing', canonicalRoot: tmpBase },
        release: () => {},
    } as PublicationLease;

    const navigationHandlers = new NavigationHandlers({
        toolResponseBuilders: { buildInvalidFileOutlineRequestPayload: ToolResponseBuilders.prototype.buildInvalidFileOutlineRequestPayload },
        prepareNavigationRead: async () => ({ state: 'ready', root: { path: tmpBase }, publication: lease }),
        acquirePublicationLease: () => lease,
        isPublicationAdmitted: async () => true,
        getPublicationNavigationStatus: async () => 'valid',
        isPartialIndexNavigationUnavailable: () => false,
        withProofDebugHint: (payload: unknown) => payload,
        loadPreparedNavigationSymbolsByFile: async () => ({
            status: 'missing',
            reason: 'Symbol registry has not been built for this codebase.',
        }),
        getOutlineStatusForLanguage: () => 'ok',
        buildRequiresReindexFileOutlinePayload: (
            codebasePath: string,
            input: { file: string },
            message: string,
            reason: string,
        ) => ({
            status: 'requires_reindex',
            reason,
            path: codebasePath,
            file: input.file,
            outline: null,
            hasMore: false,
            message,
        }),
        normalizeRelativeFilePath: (file: string) => file,
        touchWatchedCodebase: async () => {},
        stringifyToolJson: JSON.stringify,
        readFileMaxBytes: 1024 * 1024,
    } as unknown as ConstructorParameters<typeof NavigationHandlers>[0]);

    const ctx = {
        workspacePolicy: buildWorkspacePolicy([tmpBase]),
        toolHandlers: {
            navigationHandlers,
            handleFileOutline: ToolHandlers.prototype.handleFileOutline,
        } as unknown as ToolHandlers,
    } as unknown as ToolContext;

    for (const rel of [udlRel, vb6Rel]) {
        const res = await fileOutlineTool.execute({ path: tmpBase, file: rel }, ctx);
        assert.equal(res.isError, undefined, rel);
        const payload = JSON.parse(res.content[0]!.text);
        assert.equal(payload.status, 'unsupported', rel);
        assert.equal(payload.reason, 'unsupported_language', rel);
        assert.equal(payload.outline, null, rel);
    }

    const apexRes = await fileOutlineTool.execute({ path: tmpBase, file: apexRel }, ctx);
    assert.equal(apexRes.isError, undefined);
    const apexPayload = JSON.parse(apexRes.content[0]!.text);
    assert.equal(apexPayload.status, 'requires_reindex');
    assert.equal(apexPayload.reason, 'missing_symbol_registry');
    assert.equal(apexPayload.outline, null);
});
