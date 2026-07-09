import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manageIndexTool, MANAGE_INDEX_ACTIONS } from "./manage_index.js";
import { CapabilityResolver } from "../core/capabilities.js";
import { ContextMcpConfig } from "../config.js";
import { ToolContext } from "./types.js";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, "../../../..");

function buildConfig(overrides: Partial<ContextMcpConfig> = {}): ContextMcpConfig {
    return {
        name: "test",
        version: "1.0.0",
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

test("manage_index public action enum includes repair and full lifecycle set", () => {
    assert.deepEqual([...MANAGE_INDEX_ACTIONS], [
        "create",
        "reindex",
        "sync",
        "status",
        "clear",
        "repair",
    ]);
    assert.equal(MANAGE_INDEX_ACTIONS.includes("repair"), true);

    const schema = manageIndexTool.inputSchemaZod({} as ToolContext);
    const parsed = schema.safeParse({ action: "repair", path: "/repo" });
    assert.equal(parsed.success, true);

    const rejected = schema.safeParse({ action: "not_an_action", path: "/repo" });
    assert.equal(rejected.success, false);
});

test("manage_index tool description lists every public action including repair", () => {
    const description = manageIndexTool.description({} as ToolContext);
    for (const action of MANAGE_INDEX_ACTIONS) {
        assert.match(description, new RegExp(action));
    }
    assert.match(description, /create\/reindex\/sync\/status\/clear\/repair/);
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

test("manage_index response shape is a JSON envelope in MCP text content", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        providerRuntime: {
            requireToolContext: async () => {
                throw new Error("Connection closed");
            }
        },
        toolHandlers: {
            handleSyncCodebase: async () => {
                throw new Error("should not run");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "sync",
        path: "/repo",
    }, ctx);

    const raw = response.content[0].text;
    assert.equal(typeof raw, "string");
    const payload = JSON.parse(raw);
    assert.equal(payload.tool, "manage_index");
    assert.equal(payload.version, 1);
    assert.equal(typeof payload.action, "string");
    assert.equal(typeof payload.path, "string");
    assert.equal(typeof payload.status, "string");
    assert.ok(
        typeof payload.message === "string" || typeof payload.humanText === "string",
        "envelope must expose message and/or humanText",
    );
});

test("public docs and skills list manage_index repair and do not claim text-only responses", () => {
    const agents = fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    assert.doesNotMatch(agents, /Text responses for lifecycle actions/);
    assert.match(agents, /JSON envelope/);
    assert.match(agents, /repair/);
    for (const action of MANAGE_INDEX_ACTIONS) {
        assert.match(agents, new RegExp(action));
    }

    const e2e = fs.readFileSync(
        path.join(REPO_ROOT, "docs/SATORI_END_TO_END_FEATURE_BEHAVIOR_SPEC.md"),
        "utf8",
    );
    assert.match(e2e, /create\|reindex\|sync\|status\|clear\|repair/);
    assert.match(e2e, /JSON envelope \(serialized in `content\[0\]\.text`\)/);
    assert.doesNotMatch(
        e2e,
        /manage_index` action router supports `create\|reindex\|sync\|status\|clear`;/,
    );

    for (const skillRel of [
        "packages/cli/assets/skills/satori/SKILL.md",
        "packages/mcp/assets/skills/satori/SKILL.md",
    ]) {
        const skill = fs.readFileSync(path.join(REPO_ROOT, skillRel), "utf8");
        assert.match(skill, /JSON envelopes/);
        for (const action of MANAGE_INDEX_ACTIONS) {
            assert.match(skill, new RegExp(`\`${action}\``));
        }
    }
});

test("manage_index returns structured backend diagnostics when provider runtime fails", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
        providerRuntime: {
            requireToolContext: async () => {
                throw new Error("Connection closed");
            }
        },
        toolHandlers: {
            handleSyncCodebase: async () => {
                throw new Error("should not run");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "sync",
        path: "/repo",
    }, ctx);
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.tool, "manage_index");
    assert.equal(payload.version, 1);
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "vector_backend_unavailable");
    assert.equal(payload.action, "sync");
    assert.equal(payload.path, "/repo");
    assert.equal(payload.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
    assert.equal(payload.hints.backend.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
    assert.doesNotMatch(payload.message, /Connection closed/);
});

test("manage_index status uses provider vector context when available", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    let requestedOperation: string | null = null;
    const providerContext = {
        toolHandlers: {
            handleGetIndexingStatus: async () => ({
                content: [{ type: "text", text: "provider-backed status" }]
            })
        }
    } as unknown as ToolContext;
    const ctx = {
        capabilities,
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperation = operation;
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

    assert.equal(requestedOperation, "vector_only");
    assert.equal(response.content[0].text, "provider-backed status");
});

test("manage_index returns structured backend diagnostics when handler backend call fails", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    const ctx = {
        capabilities,
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

test("manage_index repair uses provider embedding/vector context when available", async () => {
    const capabilities = new CapabilityResolver(buildConfig());
    let requestedOperation: string | null = null;
    const providerContext = {
        toolHandlers: {
            handleRepairIndex: async () => ({
                content: [{ type: "text", text: "provider-backed repair" }]
            })
        }
    } as unknown as ToolContext;
    const ctx = {
        capabilities,
        providerRuntime: {
            requireToolContext: async (operation: string) => {
                requestedOperation = operation;
                return providerContext;
            }
        },
        toolHandlers: {
            handleRepairIndex: async () => {
                throw new Error("startup context should not handle repair when provider context is available");
            }
        }
    } as unknown as ToolContext;

    const response = await manageIndexTool.execute({
        action: "repair",
        path: "/repo",
    }, ctx);

    assert.equal(requestedOperation, "embedding_vector");
    assert.equal(response.content[0].text, "provider-backed repair");
});
