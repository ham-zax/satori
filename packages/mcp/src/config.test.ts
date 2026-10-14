import assert from "node:assert/strict";
import test from "node:test";
import { logConfigurationSummary, type ContextMcpConfig } from "./config.js";

test("configuration summary redacts OpenAI endpoint credentials and query", (t) => {
    const messages: string[] = [];
    t.mock.method(console, "log", (message: string) => messages.push(message));
    const config = {
        encoderProvider: "OpenAI",
        vectorStoreProvider: "LanceDB",
        networkPolicy: { kind: "local-only" },
        rerankerProvider: "none",
    } as ContextMcpConfig;
    for (const endpoint of [
        "https://fixture-user:fixture-password@example.test/v1?token=fixture-token#fixture-fragment",
        "https://example.test/v1",
    ]) {
        messages.length = 0;
        logConfigurationSummary({ ...config, openaiEndpoint: endpoint });
        // Keep assertion failures free of the unredacted URL.
        assert.equal(messages.includes("[MCP]   OpenAI Base URL: https://example.test/v1"), true);
        assert.equal(messages.some((message) => /fixture-(user|password|token|fragment)/.test(message)), false);
    }
});

test("configuration summary does not expose malformed OpenAI endpoints", (t) => {
    const messages: string[] = [];
    t.mock.method(console, "log", (message: string) => messages.push(message));
    logConfigurationSummary({
        encoderProvider: "OpenAI",
        vectorStoreProvider: "LanceDB",
        networkPolicy: { kind: "local-only" },
        rerankerProvider: "none",
        openaiEndpoint: "malformed?token=fixture-token",
    } as ContextMcpConfig);
    assert.equal(messages.includes("[MCP]   OpenAI Base URL: [Invalid URL]"), true);
    assert.equal(messages.some((message) => message.includes("fixture-token")), false);
});

test("configuration summary redacts Gemini endpoint credentials and query", (t) => {
    const messages: string[] = [];
    t.mock.method(console, "log", (message: string) => messages.push(message));
    logConfigurationSummary({
        encoderProvider: "Gemini",
        vectorStoreProvider: "LanceDB",
        networkPolicy: { kind: "local-only" },
        rerankerProvider: "none",
        geminiEndpoint: "https://fixture-user:fixture-password@example.test/v1?key=fixture-token#fixture-fragment",
    } as ContextMcpConfig);
    assert.equal(messages.includes("[MCP]   Gemini Base URL: https://example.test/v1"), true);
    assert.equal(messages.some((message) => /fixture-(user|password|token|fragment)/.test(message)), false);
});

test("configuration summary redacts Milvus address credentials", (t) => {
    const messages: string[] = [];
    t.mock.method(console, "log", (message: string) => messages.push(message));
    for (const [address, expected] of [
        ["https://fixture-user:fixture-password@example.test:19530?token=fixture-token", "https://example.test:19530/"],
        ["fixture-user:fixture-password@localhost:19530", "localhost:19530"],
        ["localhost:19530", "localhost:19530"],
    ]) {
        messages.length = 0;
        logConfigurationSummary({
            encoderProvider: "Potion",
            vectorStoreProvider: "Milvus",
            networkPolicy: { kind: "local-only" },
            rerankerProvider: "none",
            milvusEndpoint: address,
        } as ContextMcpConfig);
        assert.equal(messages.includes(`[MCP]   Milvus Address: ${expected}`), true);
        assert.equal(messages.some((message) => /fixture-(user|password|token)/.test(message)), false);
    }
});
