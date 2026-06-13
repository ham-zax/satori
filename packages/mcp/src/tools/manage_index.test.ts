import test from "node:test";
import assert from "node:assert/strict";
import { manageIndexTool } from "./manage_index.js";
import { CapabilityResolver } from "../core/capabilities.js";
import { ContextMcpConfig } from "../config.js";
import { ToolContext } from "./types.js";

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
