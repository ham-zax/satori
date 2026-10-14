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
