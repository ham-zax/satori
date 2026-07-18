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
        EMBEDDING_PROVIDER: "OpenAI",
        EMBEDDING_OUTPUT_DIMENSION: "1024",
        OPENAI_API_KEY: "sk-test",
        MILVUS_ADDRESS: "localhost:19530",
    });

    const dimension = checks.find((check) => check.name === "embedding_dimension");
    assert.equal(dimension?.status, "error");
    assert.match(dimension?.message || "", /OpenAI ignores this setting/);
});

test("static runtime config accepts an installer-resolved Ollama dimension", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Ollama",
        OLLAMA_MODEL: "nomic-embed-text:latest",
        OLLAMA_MODEL_DIGEST: "a".repeat(64),
        EMBEDDING_OUTPUT_DIMENSION: "768",
    });

    assert.equal(checks.find((check) => check.name === "embedding_dimension")?.status, "ok");
});

test("static runtime config accepts the installer-owned Potion offline identity", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: "/tmp/satori-lancedb",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
    });

    assert.equal(checks.some((check) => check.status === "error"), false);
    assert.equal(checks.find((check) => check.name === "potion_artifacts")?.status, "ok");
});

test("static runtime config rejects a changed Potion model identity", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@mutable",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
    });

    const model = checks.find((check) => check.name === "embedding_model");
    assert.equal(model?.status, "error");
    assert.match(model?.message || "", /requires the pinned model identity/);
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

test("static runtime config enforces the explicit offline policy and recorded model identity", () => {
    const complete = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Ollama",
        OLLAMA_MODEL: "nomic-embed-text:latest",
        OLLAMA_MODEL_DIGEST: "a".repeat(64),
        VOYAGEAI_API_KEY: "retained-but-unreachable",
    });
    assert.equal(complete.some((check) => check.status === "error"), false);
    assert.equal(complete.find((check) => check.name === "offline_model_digest")?.status, "ok");

    const invalid = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "Milvus",
        EMBEDDING_PROVIDER: "VoyageAI",
        VOYAGEAI_API_KEY: "pa-test",
        MILVUS_ADDRESS: "localhost:19530",
    });
    assert.equal(invalid.find((check) => check.name === "offline_embedding_policy")?.status, "error");
    assert.equal(invalid.find((check) => check.name === "offline_vector_policy")?.status, "error");
    assert.equal(invalid.find((check) => check.name === "offline_model_digest")?.status, "error");
});
