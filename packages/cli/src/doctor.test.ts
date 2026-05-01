import test from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "./doctor.js";

test("runDoctor reports missing default VoyageAI and Milvus env", () => {
    const result = runDoctor({
        nodeVersion: "v20.11.0",
        env: {},
        execFileSyncImpl: (() => "0.0.0") as any,
    });

    assert.equal(result.status, "error");
    assert.equal(result.checks.some((check) => check.name === "embedding_provider_env" && check.status === "error"), true);
    assert.equal(result.checks.some((check) => check.name === "milvus_address" && check.status === "error"), true);
    assert.deepEqual(result.nextSteps, [
        "Set VOYAGEAI_API_KEY.",
        "Set MILVUS_ADDRESS.",
    ]);
});

test("runDoctor treats Ollama as keyless but still requires MILVUS_ADDRESS", () => {
    const result = runDoctor({
        nodeVersion: "v22.0.0",
        env: {
            EMBEDDING_PROVIDER: "Ollama",
            MILVUS_ADDRESS: "localhost:19530",
        },
        execFileSyncImpl: (() => "0.0.0") as any,
    });

    assert.equal(result.status, "ok");
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
        execFileSyncImpl: (() => "0.0.0") as any,
    });

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "node_version")?.status, "error");
});
