import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStaticRuntimeConfig } from "./runtime-config.js";

test("static runtime config rejects unsupported providers without unrelated key guidance", () => {
    const checks = evaluateStaticRuntimeConfig({ EMBEDDING_PROVIDER: "Unknown" });

    assert.deepEqual(checks.map((check) => check.name), ["embedding_provider"]);
    assert.equal(checks[0]?.status, "error");
    assert.doesNotMatch(checks[0]?.message || "", /VOYAGEAI_API_KEY/);
});

test("static runtime config rejects dimensions the runtime would ignore", () => {
    const checks = evaluateStaticRuntimeConfig({
        EMBEDDING_PROVIDER: "Ollama",
        EMBEDDING_OUTPUT_DIMENSION: "999",
        MILVUS_ADDRESS: "localhost:19530",
    });

    const dimension = checks.find((check) => check.name === "embedding_dimension");
    assert.equal(dimension?.status, "error");
    assert.match(dimension?.message || "", /256, 512, 1024, or 2048/);
});

test("static runtime config reports a complete Ollama and local Milvus setup", () => {
    const checks = evaluateStaticRuntimeConfig({
        EMBEDDING_PROVIDER: "Ollama",
        OLLAMA_MODEL: "nomic-embed-text",
        MILVUS_ADDRESS: "localhost:19530",
    });

    assert.equal(checks.some((check) => check.status === "error"), false);
    assert.equal(checks.find((check) => check.name === "embedding_provider_env")?.message, "Ollama does not require an API key.");
});
