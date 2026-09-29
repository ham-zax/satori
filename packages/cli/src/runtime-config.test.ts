import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStaticRuntimeConfig } from "./runtime-config.js";

test("retired reranker application mode fails clearly during CLI configuration checks", () => {
    const checks = evaluateStaticRuntimeConfig({ SATORI_RERANK_APPLICATION_MODE: "legacy_rrf" });
    assert.deepEqual(checks, [{
        name: "rerank_application_mode",
        status: "error",
        message: "SATORI_RERANK_APPLICATION_MODE has been removed; the native reranker order is now mandatory.",
        nextStep: "Unset SATORI_RERANK_APPLICATION_MODE.",
    }]);
});

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

test("static runtime config accepts an absolute shared LateOn model path", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
        SATORI_RERANKER_PROVIDER: "lateon",
        SATORI_LATEON_MODEL_PATH: "/opt/satori/models/lateon-code-edge",
    });

    assert.equal(checks.some((check) => check.status === "error"), false);
    assert.equal(checks.find((check) => check.name === "reranker_provider")?.status, "ok");
});

test("static runtime config rejects an unbound LateOn selection", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RERANKER_PROVIDER: "lateon",
        SATORI_LATEON_MODEL_PATH: "relative/model",
        VOYAGEAI_API_KEY: "test",
        MILVUS_ADDRESS: "localhost:19530",
    });

    const reranker = checks.find((check) => check.name === "reranker_provider");
    assert.equal(reranker?.status, "error");
    assert.match(reranker?.message || "", /absolute SATORI_LATEON_MODEL_PATH/);
});

test("static runtime config exposes the bound LateOn activation policy", () => {
    const bound = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
        SATORI_RERANKER_PROVIDER: "lateon",
        SATORI_LATEON_MODEL_PATH: "/opt/satori/models/lateon-code-edge",
        SATORI_LATEON_ACTIVATION_POLICY: "lateon_context_v5_d32_owner_default_v1",
    });
    const boundCheck = bound.find((check) => check.name === "lateon_activation_policy");
    assert.equal(boundCheck?.status, "ok");
    assert.match(boundCheck?.message || "", /LateOn activation policy: lateon_context_v5_d32_owner_default_v1\./);

    const unbound = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
        SATORI_RERANKER_PROVIDER: "lateon",
        SATORI_LATEON_MODEL_PATH: "/opt/satori/models/lateon-code-edge",
    });
    const unboundCheck = unbound.find((check) => check.name === "lateon_activation_policy");
    assert.equal(unboundCheck?.status, "ok");
    assert.match(unboundCheck?.message || "", /No LateOn activation policy is bound\./);
});

test("static runtime config rejects an invalid LateOn activation policy", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
        SATORI_RERANKER_PROVIDER: "lateon",
        SATORI_LATEON_MODEL_PATH: "/opt/satori/models/lateon-code-edge",
        SATORI_LATEON_ACTIVATION_POLICY: "untrusted_policy_v1",
    });
    const policy = checks.find((check) => check.name === "lateon_activation_policy");
    assert.equal(policy?.status, "error");
    assert.match(policy?.message || "", /Invalid LateOn activation policy: untrusted_policy_v1\./);
});

test("static runtime config rejects a LateOn activation policy without the lateon provider", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
        SATORI_RERANKER_PROVIDER: "none",
        SATORI_LATEON_ACTIVATION_POLICY: "lateon_context_v5_d32_owner_default_v1",
    });
    const policy = checks.find((check) => check.name === "lateon_activation_policy");
    assert.equal(policy?.status, "error");
    assert.match(
        policy?.message || "",
        /SATORI_LATEON_ACTIVATION_POLICY requires SATORI_RERANKER_PROVIDER=lateon; received none\./,
    );
});

test("static runtime config rejects the context-v3 policy without the activated profile", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
        SATORI_RERANKER_PROVIDER: "lateon",
        SATORI_LATEON_MODEL_PATH: "/opt/satori/models/lateon-code-edge",
        SATORI_LATEON_PROFILE: "lateon_projection_v2_d16_v1",
        SATORI_LATEON_ACTIVATION_POLICY: "lateon_context_v5_d32_owner_default_v1",
    });
    const policy = checks.find((check) => check.name === "lateon_activation_policy");
    assert.equal(policy?.status, "error");
    assert.match(
        policy?.message || "",
        /SATORI_LATEON_ACTIVATION_POLICY=lateon_context_v5_d32_owner_default_v1 requires SATORI_LATEON_PROFILE=lateon_offline_quality_projection_v5_d32_v1; received lateon_projection_v2_d16_v1\./,
    );
});

test("static runtime config rejects a non-current activation policy with reinstall guidance", () => {
    const checks = evaluateStaticRuntimeConfig({
        SATORI_RUNTIME_PROFILE: "offline",
        VECTOR_STORE_PROVIDER: "LanceDB",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
        EMBEDDING_OUTPUT_DIMENSION: "256",
        POTION_HELPER_PATH: "/opt/satori/potion/satori-potion",
        POTION_MODEL_PATH: "/opt/satori/potion/model",
        SATORI_RERANKER_PROVIDER: "lateon",
        SATORI_LATEON_MODEL_PATH: "/opt/satori/models/lateon-code-edge",
        SATORI_LATEON_PROFILE: "lateon_offline_quality_projection_v3_d32_v1",
        SATORI_LATEON_ACTIVATION_POLICY: "lateon_d32_owner_default_v1",
    });
    const policy = checks.find((check) => check.name === "lateon_activation_policy");
    assert.equal(policy?.status, "error");
    assert.match(
        policy?.message || "",
        /Invalid LateOn activation policy: lateon_d32_owner_default_v1\./,
    );
    assert.match(policy?.nextStep || "", /Reinstall with `.*install --reranker lateon`/);
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
