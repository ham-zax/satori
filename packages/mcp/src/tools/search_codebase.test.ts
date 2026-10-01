import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchCodebaseTool } from './search_codebase.js';
import { CapabilityResolver } from '../core/capabilities.js';
import { ContextMcpConfig } from '../config.js';
import { ToolContext } from './types.js';
import {
    createSessionWorkspacePolicy,
    type SessionWorkspacePolicy,
} from '../core/session-workspace-policy.js';

function buildWorkspacePolicy(roots: readonly string[]): SessionWorkspacePolicy {
    return createSessionWorkspacePolicy({
        roots,
        homeDirectory: os.homedir(),
        stateRoot: path.join(os.tmpdir(), 'search-codebase-test-state'),
    });
}

/** Session policy authorizing the synthetic '/repo' fixture used by existing tests. */
const REPO_WORKSPACE_POLICY = buildWorkspacePolicy(['/repo']);

function buildConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: 'test',
        version: '1.0.0',
        stateRoot: path.join(os.tmpdir(), 'satori-test-state-root'),
        executionProfile: 'connected',
        networkPolicy: { kind: 'remote-allowed' },
        vectorStoreProvider: 'Milvus',
        encoderProvider: 'VoyageAI',
        encoderModel: 'voyage-4-large',
        encoderOutputDimension: 1024,
        voyageKey: 'voyage-key',
        milvusEndpoint: 'https://example.zilliz.com',
        milvusApiToken: 'token',
        rankerModel: 'rerank-2.5',
        ...overrides,
    };
}

function captureTelemetry(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        const text = String(chunk);
        if (text.includes('[TELEMETRY]')) {
            lines.push(text.trim());
        }
        return originalWrite(
            chunk as string,
            ...(args as [NodeJS.BufferEncoding?, ((err?: Error | null | undefined) => void)?])
        );
    }) as typeof process.stderr.write;

    return run().finally(() => {
        process.stderr.write = originalWrite as typeof process.stderr.write;
    }).then(() => lines);
}

test('search_codebase forwards cancellation through provider acquisition and execution', async () => {
    const controller = new AbortController();
    const observed: Array<AbortSignal | undefined> = [];
    const ctx = {
        capabilities: new CapabilityResolver(buildConfig()),
        workspacePolicy: REPO_WORKSPACE_POLICY,
        requestSignal: controller.signal,
        toolHandlers: {
            handleSearchCode: async (_args: unknown, signal?: AbortSignal) => {
                observed.push(signal);
                controller.abort(new Error('cancel search'));
                signal?.throwIfAborted();
                return { content: [{ type: 'text', text: '{}' }] };
            },
        },
        providerRuntime: {
            requireToolContext: async (_operation: string, request?: { signal?: AbortSignal }) => {
                observed.push(request?.signal);
                return ctx;
            },
        },
    } as unknown as ToolContext;
    await assert.rejects(searchCodebaseTool.execute({ path: '/repo', query: 'cache invalidation' }, ctx),
        /cancel search/);
    assert.deepEqual(observed, [controller.signal, controller.signal]);
});

test('search_codebase does not execute after cancellation during provider acquisition', async () => {
    const controller = new AbortController();
    let executed = false;
    const ctx = {
        capabilities: new CapabilityResolver(buildConfig()),
        workspacePolicy: REPO_WORKSPACE_POLICY,
        requestSignal: controller.signal,
        toolHandlers: { handleSearchCode: async () => { executed = true; return {}; } },
        providerRuntime: {
            requireToolContext: async () => {
                controller.abort(new Error('cancel acquisition'));
                return ctx;
            },
        },
    } as unknown as ToolContext;
    await assert.rejects(searchCodebaseTool.execute({ path: '/repo', query: 'cache invalidation' }, ctx),
        /cancel acquisition/);
    assert.equal(executed, false);
});

test('search_codebase rejects relative path without CWD resolve', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        toolHandlers: {
            handleSearchCode: async () => {
                throw new Error('handler must not run for relative path');
            }
        }
    } as unknown as ToolContext;

    const response = await searchCodebaseTool.execute({
        path: 'relative/repo',
        query: 'auth',
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /absolute filesystem path|Invalid arguments for 'search_codebase'/i);
    assert.doesNotMatch(response.content[0].text, /handler must not run/);
});

test('search_codebase rejects operator-only queries without a positive retrieval term', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        toolHandlers: {
            handleSearchCode: async () => {
                throw new Error('handler must not run for an empty derived query');
            },
        },
    } as unknown as ToolContext;

    const response = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'exclude:legacy -path:tests',
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /requires semantic text or a positive must:.*path:.*lang:/i);
    assert.doesNotMatch(response.content[0]?.text || '', /handler must not run/);
});

test('search_codebase forwards public debugMode selectors to the handler contract', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleSearchCode: async (args: Record<string, unknown>) => {
                calls.push(args);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            formatVersion: 2,
                            status: 'ok',
                            path: '/repo',
                            codebaseRoot: '/repo',
                            query: 'auth',
                            scope: 'runtime',
                            groupBy: 'symbol',
                            resultMode: 'grouped',
                            limit: 10,
                            freshnessDecision: { mode: 'skipped_recent' },
                            freshnessSummary: {
                                syncMode: 'skipped_recent',
                                lastSyncAt: null,
                                changedFileCount: 0,
                                gitDirtyFilesConsidered: false,
                                changedFilesBoostApplied: false,
                                changedFilesBoostSkippedForLargeChangeSet: false,
                            },
                            results: [],
                        }),
                    }],
                };
            },
        },
    } as unknown as ToolContext;

    await searchCodebaseTool.execute({ path: '/repo', query: 'auth' }, ctx);
    await searchCodebaseTool.execute({ path: '/repo', query: 'auth', debugMode: 'freshness' }, ctx);
    await searchCodebaseTool.execute({ path: '/repo', query: 'auth', debugMode: 'ranking' }, ctx);
    await searchCodebaseTool.execute({ path: '/repo', query: 'auth', debugMode: 'full' }, ctx);

    assert.equal('debug' in (calls[0] ?? {}), false);
    assert.equal(calls[0]?.debugMode, 'none');
    assert.equal('debug' in (calls[1] ?? {}), false);
    assert.equal(calls[1]?.debugMode, 'freshness');
    assert.equal('debug' in (calls[2] ?? {}), false);
    assert.equal(calls[2]?.debugMode, 'ranking');
    assert.equal('debug' in (calls[3] ?? {}), false);
    assert.equal(calls[3]?.debugMode, 'full');
});

test('search_codebase rejects the retired debug selector', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const response = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        debug: false,
        debugMode: 'summary',
    }, { capabilities } as unknown as ToolContext);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || '', /Unrecognized key.*debug/i);
});

test('search_codebase accepts bounded diagnostic candidate depth only with full diagnostics', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleSearchCode: async (args: Record<string, unknown>) => {
                calls.push(args);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                        formatVersion: 2,
                        status: 'ok',
                        path: '/repo',
                        codebaseRoot: '/repo',
                        query: 'auth',
                        scope: 'runtime',
                        groupBy: 'symbol',
                        resultMode: 'grouped',
                        limit: 3,
                        freshnessDecision: { mode: 'skipped_recent' },
                        freshnessSummary: {
                            syncMode: 'skipped_recent',
                            lastSyncAt: null,
                            changedFileCount: 0,
                            gitDirtyFilesConsidered: false,
                            changedFilesBoostApplied: false,
                            changedFilesBoostSkippedForLargeChangeSet: false,
                        },
                        results: [],
                    }) }],
                };
            },
        },
    } as unknown as ToolContext;

    const accepted = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        limit: 3,
        debugMode: 'full',
        debugCandidateLimit: 160,
    }, ctx);
    const rejectedWithoutFull = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        debugMode: 'ranking',
        debugCandidateLimit: 160,
    }, ctx);
    const rejectedAboveBound = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        debugMode: 'full',
        debugCandidateLimit: 161,
    }, ctx);

    assert.equal(accepted.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.debugCandidateLimit, 160);
    assert.equal(calls[0]?.limit, 3);
    assert.equal(rejectedWithoutFull.isError, true);
    assert.match(rejectedWithoutFull.content[0]?.text || '', /debugCandidateLimit.*full/i);
    assert.equal(rejectedAboveBound.isError, true);
    assert.match(rejectedAboveBound.content[0]?.text || '', /160|less than or equal/i);
});

test('search_codebase accepts a smaller grouped disclosure without lowering retrieval limit', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleSearchCode: async (args: Record<string, unknown>) => {
                calls.push(args);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                        status: 'ok',
                        results: [],
                    }) }],
                };
            },
        },
    } as unknown as ToolContext;

    const accepted = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        limit: 10,
        disclosureLimit: 3,
    }, ctx);
    const rejectedAboveLimit = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        limit: 3,
        disclosureLimit: 4,
    }, ctx);
    const rejectedRaw = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        resultMode: 'raw',
        disclosureLimit: 1,
    }, ctx);

    assert.equal(accepted.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.limit, 10);
    assert.equal(calls[0]?.disclosureLimit, 3);
    assert.equal(rejectedAboveLimit.isError, true);
    assert.match(rejectedAboveLimit.content[0]?.text ?? '', /disclosureLimit.*limit/i);
    assert.equal(rejectedRaw.isError, true);
    assert.match(rejectedRaw.content[0]?.text ?? '', /disclosureLimit.*grouped/i);
});

test('search_codebase accepts an optional compact result index only for grouped results', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleSearchCode: async (args: Record<string, unknown>) => {
                calls.push(args);
                return { content: [{ type: 'text' as const, text: '{"status":"ok","results":[]}' }] };
            },
        },
    } as unknown as ToolContext;

    const defaultOmitted = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth ownership',
    }, ctx);
    const acceptedGrouped = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth ownership',
        resultMode: 'grouped',
        includeResultIndex: true,
    }, ctx);
    const rejectedRaw = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth ownership',
        resultMode: 'raw',
        includeResultIndex: true,
    }, ctx);

    assert.equal(defaultOmitted.isError, undefined);
    assert.equal(acceptedGrouped.isError, undefined);
    assert.equal(rejectedRaw.isError, true);
    assert.equal(calls.length, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0] ?? {}, 'includeResultIndex'), false);
    assert.equal(calls[1]?.includeResultIndex, true);
    assert.match(rejectedRaw.content[0]?.text ?? '', /includeResultIndex.*grouped/i);
});

test('search_codebase accepts a large logical total on Potion while independently bounding disclosure', async () => {
    const capabilities = new CapabilityResolver(buildConfig({
        executionProfile: 'offline',
        networkPolicy: { kind: 'local-only' },
        vectorStoreProvider: 'LanceDB',
        lanceDbPath: '/tmp/satori-lancedb',
        encoderProvider: 'Potion',
        encoderModel: 'pinned-potion',
    }));
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleSearchCode: async (args: Record<string, unknown>) => {
                calls.push(args);
                return { content: [{ type: 'text' as const, text: '{"status":"ok","results":[]}' }] };
            },
        },
    } as unknown as ToolContext;

    const accepted = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth ownership',
        limit: 10_000,
        disclosureLimit: 200,
    }, ctx);
    const unsafe = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth ownership',
        limit: Number.MAX_SAFE_INTEGER + 1,
    }, ctx);
    const oversizedPage = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth ownership',
        limit: 10_000,
        disclosureLimit: 201,
    }, ctx);
    const pageAboveDefaultTotal = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth ownership',
        disclosureLimit: 11,
    }, ctx);

    assert.equal(accepted.isError, undefined);
    assert.equal(calls[0]?.limit, 10_000);
    assert.equal(calls[0]?.disclosureLimit, 200);
    assert.equal(unsafe.isError, true);
    assert.equal(oversizedPage.isError, true);
    assert.equal(pageAboveDefaultTotal.isError, true);
    assert.equal(calls.length, 1);
});

test('search_codebase acquires embedding context only for routes that require dense retrieval', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const requestedOperations: string[] = [];
    const handler = {
        handleSearchCode: async () => ({
            content: [{
                type: 'text',
                text: JSON.stringify({ status: 'ok', results: [] }),
            }],
        }),
    };
    const providerContext = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        runtimeFingerprint: {
            embeddingProvider: 'VoyageAI',
            embeddingModel: 'voyage-4-large',
            embeddingDimension: 1024,
            vectorStoreProvider: 'Milvus',
            schemaVersion: 'hybrid_v3',
        },
        toolHandlers: handler,
    } as unknown as ToolContext;
    const ctx = {
        ...providerContext,
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperations.push(operation);
                return providerContext;
            },
        },
    } as unknown as ToolContext;

    await searchCodebaseTool.execute({
        path: '/repo',
        query: '"SOURCE_CHECKPOINT_MISSING"',
    }, ctx);
    await searchCodebaseTool.execute({
        path: '/repo',
        query: 'explain how checkpoint recovery preserves authority',
    }, ctx);

    assert.deepEqual(requestedOperations, ['vector_only', 'embedding_vector']);
});

test('search_codebase delegates debug projection to the handler without reparsing its response', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        formatVersion: 2,
                        status: 'ok',
                        hints: {
                            version: 1,
                            debugSummary: { path: 'exact_registry', totalLatencyMs: 4 },
                            debugSearch: { phaseTimingsMs: { prepareRead: 3 }, candidates: ['large'] },
                        },
                        results: [{ target: { file: 'src/a.ts' }, debug: { score: 1 } }],
                    }),
                }],
            }),
        },
    } as unknown as ToolContext;

    const response = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        debugMode: 'summary',
    }, ctx);
    const payload = JSON.parse(response.content[0]?.text ?? '{}');

    assert.deepEqual(payload.hints.debugSummary, { path: 'exact_registry', totalLatencyMs: 4 });
    assert.deepEqual(payload.hints.debugSearch, { phaseTimingsMs: { prepareRead: 3 }, candidates: ['large'] });
    assert.deepEqual(payload.results[0].debug, { score: 1 });
    assert.equal(Buffer.byteLength(response.content[0]?.text ?? '', 'utf8') < 8 * 1024, true);
});

test('search_codebase emits telemetry with diagnostics from handler meta', async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const responseText = JSON.stringify({
        status: 'ok',
        path: '/repo',
        query: 'auth',
        scope: 'runtime',
        groupBy: 'symbol',
        resultMode: 'grouped',
        limit: 10,
        freshnessDecision: { mode: 'skipped_recent' },
        results: [{ kind: 'group', groupId: 'sym_auth', file: 'src/auth.ts' }]
    });

    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{
                    type: 'text',
                    text: responseText
                }],
                meta: {
                    searchDiagnostics: {
                        resultsBeforeFilter: 9,
                        resultsAfterFilter: 5,
                        excludedByIgnore: 4,
                        freshnessMode: 'skipped_recent',
                        routeKind: 'conceptual',
                        retrievalMode: 'hybrid',
                        semanticSearchAttempts: 2,
                        embeddingCallsByCurrentContract: 2,
                        denseQueriesByCurrentContract: 2,
                        sparseQueriesByCurrentContract: 2,
                        rerankerCalls: 1,
                        rerankerCandidates: 6,
                        rerankerInputBytes: 1536,
                        candidatesWithSemanticEvidence: 5,
                        candidatesWithLexicalEvidence: 1,
                        candidatesWithCurrentSourceEvidence: 0,
                        semanticExpansionAttempted: true,
                        semanticExpansionReason: 'primary_candidate_pool_small',
                    }
                }
            })
        }
    } as unknown as ToolContext;

    const telemetry = await captureTelemetry(async () => {
        const response = await searchCodebaseTool.execute({
            path: '/repo',
            query: 'auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        }, ctx);

        assert.equal(response.isError, undefined);
    });

    assert.equal(telemetry.length, 1);
    const payload = JSON.parse(telemetry[0].replace(/^\[TELEMETRY\]\s*/, ''));
    assert.equal(payload.event, 'search_executed');
    assert.equal(payload.reranker_attempted, false);
    assert.equal(payload.reranker_used, false);
    assert.equal(payload.results_before_filter, 9);
    assert.equal(payload.results_after_filter, 5);
    assert.equal(payload.results_returned, 1);
    assert.equal(payload.excluded_by_ignore, 4);
    assert.equal(payload.freshness_mode, 'skipped_recent');
    assert.equal(payload.route, 'conceptual');
    assert.equal(payload.retrieval_mode, 'hybrid');
    assert.equal(payload.semantic_search_attempts, 2);
    assert.equal(payload.embedding_calls_by_current_contract, 2);
    assert.equal(payload.dense_queries_by_current_contract, 2);
    assert.equal(payload.sparse_queries_by_current_contract, 2);
    assert.equal(payload.reranker_calls, 1);
    assert.equal(payload.reranker_candidates, 6);
    assert.equal(payload.reranker_input_bytes, 1536);
    assert.equal(payload.candidates_with_semantic_evidence, 5);
    assert.equal(payload.candidates_with_lexical_evidence, 1);
    assert.equal(payload.candidates_with_current_source_evidence, 0);
    assert.equal(payload.semantic_expansion_attempted, true);
    assert.equal(payload.semantic_expansion_reason, 'primary_candidate_pool_small');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'parallel_fanout'), false);
    assert.doesNotMatch(telemetry[0], /auth|src\/auth\.ts/);
    assert.equal(payload.response_bytes, Buffer.byteLength(responseText, 'utf8'));
});

test('search_codebase telemetry reports reranker_used when handler diagnostics indicate rerank applied', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'ok',
                        path: '/repo',
                        query: 'auth',
                        scope: 'runtime',
                        groupBy: 'symbol',
                        resultMode: 'grouped',
                        limit: 10,
                        freshnessDecision: { mode: 'skipped_recent' },
                        results: [{ kind: 'group', groupId: 'sym_auth', file: 'src/auth.ts' }]
                    })
                }],
                meta: {
                    searchDiagnostics: {
                        resultsBeforeFilter: 3,
                        resultsAfterFilter: 1,
                        excludedByIgnore: 2,
                        freshnessMode: 'skipped_recent',
                        rerankerAttempted: true,
                        rerankerUsed: true
                    }
                }
            })
        }
    } as unknown as ToolContext;

    const telemetry = await captureTelemetry(async () => {
        const response = await searchCodebaseTool.execute({
            path: '/repo',
            query: 'auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        }, ctx);

        assert.equal(response.isError, undefined);
    });

    assert.equal(telemetry.length, 1);
    const payload = JSON.parse(telemetry[0].replace(/^\[TELEMETRY\]\s*/, ''));
    assert.equal(payload.reranker_attempted, true);
    assert.equal(payload.reranker_used, true);
});

test('search_codebase falls back to parsed JSON response for telemetry diagnostics', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        status: 'ok',
                        path: '/repo',
                        query: 'token',
                        scope: 'docs',
                        groupBy: 'file',
                        resultMode: 'raw',
                        limit: 20,
                        freshnessDecision: { mode: 'synced' },
                        results: [
                            { kind: 'chunk', file: 'docs/auth.md' },
                            { kind: 'chunk', file: 'docs/token.md' }
                        ]
                    })
                }]
            })
        }
    } as unknown as ToolContext;

    const telemetry = await captureTelemetry(async () => {
        const response = await searchCodebaseTool.execute({
            path: '/repo',
            query: 'token',
            scope: 'docs',
            resultMode: 'raw',
            groupBy: 'file',
            limit: 20
        }, ctx);

        assert.equal(response.isError, undefined);
    });

    assert.equal(telemetry.length, 1);
    const payload = JSON.parse(telemetry[0].replace(/^\[TELEMETRY\]\s*/, ''));
    assert.equal(payload.results_before_filter, 2);
    assert.equal(payload.results_after_filter, 2);
    assert.equal(payload.results_returned, 2);
    assert.equal(payload.freshness_mode, 'synced');
});

test('search_codebase returns validation error for invalid arguments', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => ({
                content: [{ type: 'text', text: 'should not run' }]
            })
        }
    } as unknown as ToolContext;

    const response = await searchCodebaseTool.execute({
        path: '/repo',
        query: '',
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Invalid arguments for 'search_codebase'/);
});

test('search_codebase returns structured backend diagnostics when provider runtime fails', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        reranker: null,
        providerRuntime: {
            requireToolContext: async () => {
                throw new Error('16 UNAUTHENTICATED: The action is unavailable under current cluster status STOPPED.');
            }
        },
        toolHandlers: {
            handleSearchCode: async () => {
                throw new Error('should not run');
            }
        }
    } as unknown as ToolContext;

    const telemetry = await captureTelemetry(async () => {
        const response = await searchCodebaseTool.execute({
            path: '/repo',
            query: 'auth',
            scope: 'runtime',
            resultMode: 'grouped',
            groupBy: 'symbol',
            limit: 10
        }, ctx);
        const payload = JSON.parse(response.content[0].text);

        assert.equal(payload.status, 'not_ready');
        assert.equal(payload.reason, 'vector_backend_unavailable');
        assert.equal(payload.code, 'ZILLIZ_CLUSTER_STOPPED');
        assert.equal(payload.freshnessDecision, undefined);
        assert.deepEqual(payload.results, []);
        assert.equal(payload.hints.backend.code, 'ZILLIZ_CLUSTER_STOPPED');
        assert.match(payload.hints.backend.nextSteps.join(' '), /Resume the Zilliz Cloud cluster/);
        assert.doesNotMatch(payload.message, /UNAUTHENTICATED/);
    });

    assert.equal(telemetry.length, 1);
    const payload = JSON.parse(telemetry[0].replace(/^\[TELEMETRY\]\s*/, ''));
    assert.equal(payload.error, 'ZILLIZ_CLUSTER_STOPPED');
});

test('search_codebase returns structured backend diagnostics when handler backend call fails', async () => {
    const capabilities = new CapabilityResolver(buildConfig());

    const ctx = {
        capabilities,
        workspacePolicy: REPO_WORKSPACE_POLICY,
        reranker: null,
        toolHandlers: {
            handleSearchCode: async () => {
                throw new Error('Connection closed');
            }
        }
    } as unknown as ToolContext;

    const response = await searchCodebaseTool.execute({
        path: '/repo',
        query: 'auth',
        scope: 'runtime',
        resultMode: 'grouped',
        groupBy: 'symbol',
        limit: 10
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.status, 'not_ready');
    assert.equal(payload.reason, 'vector_backend_unavailable');
    assert.equal(payload.code, 'VECTOR_BACKEND_CONNECTION_CLOSED');
    assert.deepEqual(payload.results, []);
});

test('search_codebase denies an unauthorized root in grouped mode without running the handler', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-b-'));
    try {
        const capabilities = new CapabilityResolver(buildConfig());
        let handlerRan = false;
        const ctx = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([rootA]),
            toolHandlers: {
                handleSearchCode: async () => {
                    handlerRan = true;
                    throw new Error('handler must not run for an unauthorized path');
                },
            },
        } as unknown as ToolContext;

        const telemetry = await captureTelemetry(async () => {
            const response = await searchCodebaseTool.execute({
                path: rootB,
                query: 'auth',
                resultMode: 'grouped',
            }, ctx);
            const payload = JSON.parse(response.content[0].text);

            assert.equal(response.isError, true);
            assert.equal(payload.status, 'error');
            assert.equal(payload.code, 'ROOT_NOT_AUTHORIZED');
            assert.equal(payload.reason, 'root_not_authorized');
            assert.equal(payload.path, rootB);
            assert.equal(typeof payload.message, 'string');
        });

        assert.equal(handlerRan, false);
        // The gate precedes telemetry: a denied search emits no [TELEMETRY] line.
        assert.equal(telemetry.length, 0);
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});

test('search_codebase does not resolve a provider context for a denied path', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-b-'));
    try {
        const capabilities = new CapabilityResolver(buildConfig());
        let providerResolved = false;
        let handlerRan = false;
        const ctx = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([rootA]),
            providerRuntime: {
                requireToolContext: async () => {
                    providerResolved = true;
                    throw new Error('provider resolution must not run for a denied path');
                },
            },
            toolHandlers: {
                handleSearchCode: async () => {
                    handlerRan = true;
                    throw new Error('handler must not run for an unauthorized path');
                },
            },
        } as unknown as ToolContext;

        const response = await searchCodebaseTool.execute({
            path: rootB,
            query: 'auth',
        }, ctx);
        const payload = JSON.parse(response.content[0].text);

        assert.equal(response.isError, true);
        assert.equal(payload.code, 'ROOT_NOT_AUTHORIZED');
        assert.equal(providerResolved, false);
        assert.equal(handlerRan, false);
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});

test("search_codebase isolates sessions: session B cannot search session A's root", async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-b-'));
    try {
        const capabilities = new CapabilityResolver(buildConfig());
        const receivedPaths: string[] = [];
        const ctxA = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([rootA]),
            toolHandlers: {
                handleSearchCode: async (args: Record<string, unknown>) => {
                    receivedPaths.push(String(args.path));
                    return { content: [{ type: 'text' as const, text: '{"status":"ok","results":[]}' }] };
                },
            },
        } as unknown as ToolContext;
        const ctxB = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([rootB]),
            toolHandlers: {
                handleSearchCode: async (args: Record<string, unknown>) => {
                    receivedPaths.push(String(args.path));
                    return { content: [{ type: 'text' as const, text: '{"status":"ok","results":[]}' }] };
                },
            },
        } as unknown as ToolContext;

        const denied = await searchCodebaseTool.execute({ path: rootB, query: 'auth' }, ctxA);
        const deniedPayload = JSON.parse(denied.content[0].text);

        assert.equal(denied.isError, true);
        assert.equal(deniedPayload.code, 'ROOT_NOT_AUTHORIZED');
        assert.equal(receivedPaths.length, 0);

        const authorized = await searchCodebaseTool.execute({ path: rootB, query: 'auth' }, ctxB);

        assert.equal(authorized.isError, undefined);
        // The handler receives the authorized canonical path (real path of B).
        assert.deepEqual(receivedPaths, [fs.realpathSync(rootB)]);
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});

test('search_codebase authorizes a nested subdirectory of an authorized root with its canonical path', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-a-'));
    const subdir = path.join(rootA, 'nested', 'repo');
    fs.mkdirSync(subdir, { recursive: true });
    try {
        const capabilities = new CapabilityResolver(buildConfig());
        const receivedPaths: string[] = [];
        const ctx = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([rootA]),
            toolHandlers: {
                handleSearchCode: async (args: Record<string, unknown>) => {
                    receivedPaths.push(String(args.path));
                    return { content: [{ type: 'text' as const, text: '{"status":"ok","results":[]}' }] };
                },
            },
        } as unknown as ToolContext;

        const response = await searchCodebaseTool.execute({ path: subdir, query: 'auth' }, ctx);

        assert.equal(response.isError, undefined);
        assert.deepEqual(receivedPaths, [fs.realpathSync(subdir)]);
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
    }
});

test('search_codebase denial envelope never carries a continuation handle', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'search-codebase-auth-b-'));
    try {
        const capabilities = new CapabilityResolver(buildConfig());
        const ctx = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([rootA]),
            toolHandlers: {
                handleSearchCode: async () => {
                    throw new Error('handler must not run for an unauthorized path');
                },
            },
        } as unknown as ToolContext;

        const response = await searchCodebaseTool.execute({
            path: rootB,
            query: 'auth',
            limit: 3,
            disclosureLimit: 2,
        }, ctx);
        const payload = JSON.parse(response.content[0].text);

        assert.equal(response.isError, true);
        assert.equal(payload.code, 'ROOT_NOT_AUTHORIZED');
        for (const leakedField of ['handle', 'nextOffset', 'continuation', 'results']) {
            assert.equal(Object.prototype.hasOwnProperty.call(payload, leakedField), false);
        }
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
        fs.rmSync(rootB, { recursive: true, force: true });
    }
});
