import test from "node:test";
import assert from "node:assert/strict";
import { DoctorOptions, runDoctor } from "./doctor.js";

const successfulExecFileSync = (() => "0.0.0") as NonNullable<DoctorOptions["execFileSyncImpl"]>;

test("runDoctor reports missing default VoyageAI and Milvus env", () => {
    const result = runDoctor({
        nodeVersion: "v20.11.0",
        env: {},
        execFileSyncImpl: successfulExecFileSync,
    });

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Embedding provider: VoyageAI.");
    assert.equal(result.checks.find((check) => check.name === "embedding_model")?.message, "Embedding model: voyage-4-large.");
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension")?.message, "Embedding output dimension: 1024.");
    assert.equal(result.checks.some((check) => check.name === "embedding_provider_env" && check.status === "error"), true);
    assert.equal(result.checks.some((check) => check.name === "milvus_address" && check.status === "error"), true);
    assert.deepEqual(result.nextSteps, [
        "Set VOYAGEAI_API_KEY from the Voyage AI dashboard API keys page.",
        "Set MILVUS_ADDRESS to a Zilliz Cloud public endpoint or local Milvus address such as localhost:19530.",
        "Restart your MCP client after changing Satori environment variables.",
    ]);
});

test("runDoctor treats Ollama as keyless but still requires MILVUS_ADDRESS", () => {
    const result = runDoctor({
        nodeVersion: "v22.0.0",
        env: {
            EMBEDDING_PROVIDER: "Ollama",
            MILVUS_ADDRESS: "localhost:19530",
        },
        execFileSyncImpl: successfulExecFileSync,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Embedding provider: Ollama.");
    assert.equal(result.checks.find((check) => check.name === "embedding_model")?.message, "Embedding model: nomic-embed-text.");
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension")?.message, "Embedding output dimension: provider default.");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider_env")?.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "milvus_address")?.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "milvus_token")?.status, "ok");
});

test("runDoctor flags unsupported Node versions", () => {
    const result = runDoctor({
        nodeVersion: "v18.19.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
        execFileSyncImpl: successfulExecFileSync,
    });

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "node_version")?.status, "error");
});
