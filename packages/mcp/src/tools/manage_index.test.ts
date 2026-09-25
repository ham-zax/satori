import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { manageIndexTool, MANAGE_INDEX_ACTIONS } from "./manage_index.js";
import { CapabilityResolver } from "../core/capabilities.js";
import { ContextMcpConfig } from "../config.js";
import { ToolContext } from "./types.js";
import { createSessionWorkspacePolicy } from "../core/session-workspace-policy.js";

/** Session policy authorizing the canonical test repo for existing fixtures. */
const TEST_WORKSPACE_POLICY = createSessionWorkspacePolicy({
    roots: ["/repo"],
    homeDirectory: os.homedir(),
    stateRoot: path.join(os.homedir(), ".satori"),
});

function buildWorkspacePolicy(roots: readonly string[]) {
    return createSessionWorkspacePolicy({
        roots,
        homeDirectory: os.homedir(),
        stateRoot: path.join(os.homedir(), ".satori"),
    });
}

function buildConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: "test",
        version: "1.0.0",
        stateRoot: path.join(os.tmpdir(), "satori-test-state-root"),
        executionProfile: "connected",
        networkPolicy: { kind: "remote-allowed" },
        vectorStoreProvider: "Milvus",
        encoderProvider: "VoyageAI",
        encoderModel: "voyage-4-large",
        encoderOutputDimension: 1024,
        voyageKey: "voyage-key",
        milvusEndpoint: "https://example.zilliz.com",
        milvusApiToken: "token",
        rankerModel: "rerank-2.5",
        ...overrides,
    };
}

test("manage_index rejects relative path without CWD resolve", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        toolHandlers: {
            handleGetIndexingStatus: async () => {
                throw new Error("handler must not run for relative path");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "status",
        path: "relative/repo",
    }, ctx);

    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /absolute filesystem path|Invalid arguments for 'manage_index'/i);
    assert.doesNotMatch(response.content[0].text, /handler must not run/);
});

test("manage_index public action enum exposes only the current lifecycle set", () => {
    assert.deepEqual([...MANAGE_INDEX_ACTIONS], [
        "create",
        "reindex",
        "sync",
        "status",
        "cancel",
        "clear",
    ]);

    const schema = manageIndexTool.inputSchemaZod({} as ToolContext);
    assert.equal(schema.safeParse({ action: "repair", path: "/repo" }).success, false);
    assert.equal(schema.safeParse({ action: "not_an_action", path: "/repo" }).success, false);
});

test("manage_index status defaults detail to summary and forwards explicit detail", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const calls: Array<Record<string, unknown>> = [];
    const statusHandlers = {
        handleGetIndexingStatus: async (args: Record<string, unknown>) => {
            calls.push(args);
            return {
                content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                        tool: "manage_index",
                        version: 1,
                        action: "status",
                        path: args.path,
                        detail: args.detail,
                        status: "ok",
                        message: "indexed",
                        humanText: "indexed",
                    }),
                }],
            };
        },
    };
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        toolHandlers: statusHandlers,
    } as unknown as ToolContext;

    await manageIndexTool.execute({ action: "status", path: "/repo" }, ctx);
    await manageIndexTool.execute({ action: "status", path: "/repo", detail: "diagnostics" }, ctx);

    assert.equal(calls[0]?.detail, "summary");
    assert.equal(calls[1]?.detail, "diagnostics");
});

test("manage_index rejects status detail on non-status actions", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const response = await manageIndexTool.execute({
        action: "sync",
        path: "/repo",
        detail: "full",
    }, { capabilities } as unknown as ToolContext);

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text || "", /detail.*status/i);
});

test("manage_index description documents the current lifecycle contract", () => {
    const description = manageIndexTool.description({} as ToolContext);
    for (const action of MANAGE_INDEX_ACTIONS) {
        assert.match(description, new RegExp(action));
    }
    assert.match(description, /Managed offline runtimes automatically start or join rebuild-safe background reindex maintenance/i);
    assert.match(description, /explicit reindex is the operator recovery override/i);
    assert.match(description, /cancel requires the exact live supervised create\/reindex\/sync operationId/i);
    assert.match(description, /process-lifetime diagnostic state, not persistent history/i);
});

test("manage_index status envelope includes symbolQuality observed registry field", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const statusHandlers = {
        handleGetIndexingStatus: async () => ({
            content: [{
                type: "text",
                text: JSON.stringify({
                    tool: "manage_index",
                    version: 1,
                    action: "status",
                    path: "/repo",
                    status: "ok",
                    message: "indexed",
                    humanText: "indexed",
                    symbolQuality: {
                        status: "symbol_sparse",
                        basis: "symbol_registry",
                        eligibleFiles: 2,
                        filesWithNonFileSymbols: 0,
                        fileOwnerOnlyFiles: 2,
                        nonFileSymbolCount: 0,
                        languages: [],
                        message: "Index is searchable but eligible files mostly lack non-file symbols.",
                    },
                }),
            }],
        }),
    };
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async () => ({
                capabilities,
                runtimeFingerprint: {
                    embeddingProvider: "VoyageAI",
                    embeddingModel: "voyage-4-large",
                    embeddingDimension: 1024,
                    vectorStoreProvider: "Milvus",
                    schemaVersion: "hybrid_v3",
                },
                toolHandlers: statusHandlers,
                context: {},
            }),
        },
        toolHandlers: statusHandlers,
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "status",
        path: "/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.tool, "manage_index");
    assert.equal(payload.action, "status");
    assert.ok(payload.symbolQuality);
    assert.equal(payload.symbolQuality.basis, "symbol_registry");
    assert.equal(payload.symbolQuality.status, "symbol_sparse");
    assert.equal(typeof payload.symbolQuality.message, "string");
});

test("manage_index status envelope preserves additive languageCapabilities evidence", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const statusHandlers = {
        handleGetIndexingStatus: async () => ({
            content: [{
                type: "text",
                text: JSON.stringify({
                    tool: "manage_index",
                    version: 1,
                    action: "status",
                    path: "/repo",
                    status: "ok",
                    message: "indexed",
                    humanText: "indexed",
                    languageCapabilities: {
                        basis: "language_declarations_and_navigation_sidecars",
                        registryEvidence: "compatible",
                        relationshipEvidence: "compatible",
                        languages: [{
                            language: "typescript",
                            declaredClaim: "calls_v0",
                            indexedFileCount: 1,
                            symbolEvidence: {
                                eligibleFiles: 1,
                                filesWithNonFileSymbols: 1,
                                status: "symbol_rich",
                            },
                            relationshipEvidence: "compatible",
                            capabilities: {
                                semanticSearch: "ready",
                                exactSymbol: "ready",
                                outline: "ready",
                                callGraph: "ready",
                            },
                            degradationReasons: [],
                        }],
                    },
                }),
            }],
        }),
    };
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async () => ({
                capabilities,
                runtimeFingerprint: {
                    embeddingProvider: "VoyageAI",
                    embeddingModel: "voyage-4-large",
                    embeddingDimension: 1024,
                    vectorStoreProvider: "Milvus",
                    schemaVersion: "hybrid_v3",
                },
                toolHandlers: statusHandlers,
                context: {},
            }),
        },
        toolHandlers: statusHandlers,
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({ action: "status", path: "/repo" }, ctx);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.languageCapabilities.basis, "language_declarations_and_navigation_sidecars");
    assert.equal(payload.languageCapabilities.languages[0].language, "typescript");
    assert.equal(payload.languageCapabilities.languages[0].capabilities.callGraph, "ready");
});

test("manage_index sync uses the supervised local handler without eager provider resolution", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async () => {
                throw new Error("sync must not eagerly resolve provider context");
            }
        },
        toolHandlers: {
            handleSyncCodebase: async () => ({
                content: [{
                    type: "text" as const,
                    text: JSON.stringify({
                        tool: "manage_index",
                        version: 1,
                        action: "sync",
                        path: "/repo",
                        status: "ok",
                        message: "sync accepted",
                        humanText: "sync accepted",
                    }),
                }],
            }),
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "sync",
        path: "/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.action, "sync");
    assert.equal(payload.status, "ok");
    assert.equal(payload.message, "sync accepted");
});

test("manage_index returns structured backend diagnostics when provider runtime fails", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async () => {
                throw new Error("Connection closed");
            }
        },
        toolHandlers: {
            handleReindexCodebase: async () => {
                throw new Error("should not run");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "reindex",
        path: "/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.tool, "manage_index");
    assert.equal(payload.version, 1);
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "vector_backend_unavailable");
    assert.equal(payload.action, "reindex");
    assert.equal(payload.path, "/repo");
    assert.equal(payload.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
    assert.equal(payload.hints.backend.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
    assert.doesNotMatch(payload.message, /Connection closed/);
});

test("manage_index status prefers the embedding-capable provider context", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const requestedOperations: string[] = [];
    const providerContext = {
        toolHandlers: {
            handleGetIndexingStatus: async () => ({
                content: [{ type: "text", text: "provider-backed status" }]
            })
        }
    } as unknown as ToolContext;
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperations.push(operation);
                return providerContext;
            }
        },
        toolHandlers: {
            handleGetIndexingStatus: async () => {
                throw new Error("startup context should not handle status when provider context is available");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "status",
        path: "/repo",
    }, ctx);

    assert.deepEqual(requestedOperations, ["embedding_vector"]);
    assert.equal(response.content[0].text, "provider-backed status");
});

test("manage_index status falls back to the vector-only context without embedding credentials", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const requestedOperations: string[] = [];
    const providerContext = {
        toolHandlers: {
            handleGetIndexingStatus: async () => ({
                content: [{ type: "text", text: "vector-only status" }],
            }),
        },
    } as unknown as ToolContext;
    const missingEmbedding = {
        ok: false as const,
        code: "MISSING_PROVIDER_CONFIG" as const,
        missingEnv: ["VOYAGEAI_API_KEY"],
        message: "Missing embedding credentials.",
        hints: {
            setup: {
                code: "MISSING_PROVIDER_CONFIG" as const,
                missingEnv: ["VOYAGEAI_API_KEY"],
                nextSteps: [],
            },
        },
    };
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperations.push(operation);
                return operation === "embedding_vector"
                    ? missingEmbedding
                    : providerContext;
            },
        },
        toolHandlers: {
            handleGetIndexingStatus: async () => {
                throw new Error("startup context should not handle provider-backed status");
            },
        },
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "status",
        path: "/repo",
    }, ctx);

    assert.deepEqual(requestedOperations, ["embedding_vector", "vector_only"]);
    assert.equal(response.content[0].text, "vector-only status");
});

test("manage_index status prefers missing_provider_config over fingerprint requires_reindex when provider is incomplete", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const missingIssue = {
        ok: false as const,
        code: "MISSING_PROVIDER_CONFIG" as const,
        missingEnv: ["MILVUS_ADDRESS", "VOYAGEAI_API_KEY"],
        message: "Satori provider setup is incomplete. Missing required environment variable(s): MILVUS_ADDRESS, VOYAGEAI_API_KEY.",
        hints: {
            setup: {
                code: "MISSING_PROVIDER_CONFIG" as const,
                missingEnv: ["MILVUS_ADDRESS", "VOYAGEAI_API_KEY"],
                nextSteps: [
                    "Set MILVUS_ADDRESS, restart the MCP server, then retry the tool call.",
                    "Set VOYAGEAI_API_KEY, restart the MCP server, then retry the tool call.",
                ],
            },
        },
    };
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async () => missingIssue,
        },
        toolHandlers: {
            handleGetIndexingStatus: async () => ({
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        tool: "manage_index",
                        version: 1,
                        action: "status",
                        path: "/repo",
                        status: "requires_reindex",
                        reason: "requires_reindex",
                        message: "Index fingerprint mismatch.",
                        humanText: "Index fingerprint mismatch.\n🧬 Reindex reason: fingerprint_mismatch",
                        hints: {
                            reindex: { tool: "manage_index", args: { action: "reindex", path: "/repo" } },
                            activeMutation: { action: "create", generation: 7, operationId: "op-7", pid: 42 },
                        },
                    }),
                }],
            }),
        },
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "status",
        path: "/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.status, "not_ready");
    assert.equal(payload.reason, "missing_provider_config");
    assert.equal(payload.code, "MISSING_PROVIDER_CONFIG");
    assert.equal(payload.detail, "summary");
    assert.deepEqual(payload.hints.setup.missingEnv, ["MILVUS_ADDRESS", "VOYAGEAI_API_KEY"]);
    assert.deepEqual(payload.hints.activeMutation, { action: "create", generation: 7, operationId: "op-7", pid: 42 });
    assert.doesNotMatch(payload.message, /fingerprint/i);
});

test("manage_index status still reports not_indexed without provider when path is untracked", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const missingIssue = {
        ok: false as const,
        code: "MISSING_PROVIDER_CONFIG" as const,
        missingEnv: ["MILVUS_ADDRESS"],
        message: "Satori provider setup is incomplete. Missing required environment variable(s): MILVUS_ADDRESS.",
        hints: {
            setup: {
                code: "MISSING_PROVIDER_CONFIG" as const,
                missingEnv: ["MILVUS_ADDRESS"],
                nextSteps: ["Set MILVUS_ADDRESS, restart the MCP server, then retry the tool call."],
            },
        },
    };
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async () => missingIssue,
        },
        toolHandlers: {
            handleGetIndexingStatus: async () => ({
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        tool: "manage_index",
                        version: 1,
                        action: "status",
                        path: "/repo",
                        status: "not_indexed",
                        reason: "not_indexed",
                        message: "Codebase is not indexed.",
                        humanText: "Codebase is not indexed.",
                        hints: { create: { tool: "manage_index", args: { action: "create", path: "/repo" } } },
                    }),
                }],
            }),
        },
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "status",
        path: "/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.status, "not_indexed");
    assert.equal(payload.reason, "not_indexed");
    assert.equal(payload.code, undefined);
});

test("manage_index returns structured backend diagnostics when handler backend call fails", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        toolHandlers: {
            handleSyncCodebase: async () => {
                throw new Error("deadline exceeded");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "sync",
        path: "/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "vector_backend_unavailable");
    assert.equal(payload.code, "VECTOR_BACKEND_TIMEOUT");
});

test("manage_index reindex uses provider embedding/vector context when available", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    let requestedOperation: string | null = null;
    const providerContext = {
        toolHandlers: {
            handleReindexCodebase: async () => ({
                content: [{ type: "text", text: "provider-backed reindex" }]
            })
        }
    } as unknown as ToolContext;
    const ctx = {
        capabilities,
        workspacePolicy: TEST_WORKSPACE_POLICY,
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperation = operation;
                return providerContext;
            }
        },
        toolHandlers: {
            handleReindexCodebase: async () => {
                throw new Error("startup context should not handle reindex when provider context is available");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "reindex",
        path: "/repo",
    }, ctx);

    assert.equal(requestedOperation, "embedding_vector");
    assert.equal(response.content[0].text, "provider-backed reindex");
});

test("manage_index rejects an unauthorized path before provider resolution", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    let providerResolved = false;
    let handlerCalled = false;
    const ctx = {
        capabilities,
        workspacePolicy: buildWorkspacePolicy(["/repo"]),
        providerRuntime: {
            requireToolContext: async () => {
                providerResolved = true;
                throw new Error("provider must not resolve for an unauthorized path");
            },
        },
        toolHandlers: {
            handleIndexCodebase: async () => {
                handlerCalled = true;
                throw new Error("handler must not run for an unauthorized path");
            },
        },
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "create",
        path: "/other-workspace/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(response.isError, true);
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "root_not_authorized");
    assert.equal(payload.code, "ROOT_NOT_AUTHORIZED");
    assert.equal(payload.path, "/other-workspace/repo");
    assert.equal(typeof payload.message, "string");
    assert.equal(providerResolved, false);
    assert.equal(handlerCalled, false);
});

test("manage_index allows a repository below an authorized workspace", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const received: string[] = [];
    const ctx = {
        capabilities,
        workspacePolicy: buildWorkspacePolicy(["/workspace"]),
        toolHandlers: {
            handleIndexCodebase: async (args: Record<string, unknown>) => {
                received.push(String(args.path));
                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({
                            tool: "manage_index",
                            version: 1,
                            action: "create",
                            path: args.path,
                            status: "indexing",
                            message: "indexing started",
                        }),
                    }],
                };
            },
        },
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "create",
        path: "/workspace/sub-repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.status, "indexing");
    assert.deepEqual(received, ["/workspace/sub-repo"]);
});

test("manage_index status cannot probe an unauthorized path", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    let handlerCalled = false;
    const ctx = {
        capabilities,
        workspacePolicy: buildWorkspacePolicy(["/repo"]),
        toolHandlers: {
            handleGetIndexingStatus: async () => {
                handlerCalled = true;
                throw new Error("status must not run for an unauthorized path");
            },
        },
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "status",
        path: "/sibling-workspace",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(response.isError, true);
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "root_not_authorized");
    assert.equal(payload.code, "ROOT_NOT_AUTHORIZED");
    assert.equal(payload.path, "/sibling-workspace");
    assert.equal(handlerCalled, false);
});

test("manage_index denies broad roots like the filesystem root and home", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    for (const broad of ["/", os.homedir()]) {
        const ctx = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy(["/repo"]),
            toolHandlers: {
                handleIndexCodebase: async () => {
                    throw new Error("handler must not run for a broad root");
                },
            },
        } as unknown as ToolContext;

        const response = await manageIndexTool.execute({
            action: "create",
            path: broad,
        }, ctx);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.status, "error");
        assert.equal(payload.code, "BROAD_ROOT_NOT_ALLOWED");
        assert.equal(payload.path, broad);
    }
});

test("symlinked root escape is denied", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "satori-manage-escape-"));
    const workspace = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    const escapeLink = path.join(workspace, "escape");
    fs.symlinkSync(outside, escapeLink);
    try {
        let handlerCalled = false;
        const ctx = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([workspace]),
            toolHandlers: {
                handleIndexCodebase: async () => {
                    handlerCalled = true;
                    throw new Error("handler must not run for a symlink escape");
                },
            },
        } as unknown as ToolContext;

        const response = await manageIndexTool.execute({
            action: "create",
            path: escapeLink,
        }, ctx);
        const payload = JSON.parse(response.content[0].text);

        assert.equal(response.isError, true);
        assert.equal(payload.status, "error");
        assert.equal(payload.reason, "root_not_authorized");
        assert.equal(payload.code, "ROOT_NOT_AUTHORIZED");
        assert.equal(payload.path, escapeLink);
        assert.equal(handlerCalled, false);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test("manage_index passes authorizedRoot.canonicalPath to handlers when path is a symlink inside authorized root", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "satori-manage-canonical-"));
    const realDir = path.join(base, "real_repo");
    const linkDir = path.join(base, "symlink_repo");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir);
    const canonicalRealDir = fs.realpathSync.native(realDir);
    try {
        let receivedPath: string | null = null;
        const ctx = {
            capabilities,
            workspacePolicy: buildWorkspacePolicy([base]),
            toolHandlers: {
                handleGetIndexingStatus: async (input: { path: string }) => {
                    receivedPath = input.path;
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({
                                tool: "manage_index",
                                version: 1,
                                action: "status",
                                path: input.path,
                                status: "not_indexed",
                                reason: "not_indexed",
                            }),
                        }],
                    };
                },
            },
        } as unknown as ToolContext;

        const response = await manageIndexTool.execute({
            action: "status",
            path: linkDir,
        }, ctx);

        assert.equal(response.isError, undefined);
        assert.equal(receivedPath, canonicalRealDir);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
