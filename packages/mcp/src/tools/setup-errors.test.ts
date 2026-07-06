import test from "node:test";
import assert from "node:assert/strict";
import { classifyVectorBackendError, formatManageVectorBackendError, formatSearchVectorBackendError } from "./setup-errors.js";

test("classifyVectorBackendError identifies stopped Zilliz clusters before generic auth failures", () => {
    const diagnostic = classifyVectorBackendError(
        new Error("16 UNAUTHENTICATED: The action is unavailable under current cluster status STOPPED.")
    );

    assert.equal(diagnostic?.code, "ZILLIZ_CLUSTER_STOPPED");
    assert.match(diagnostic?.message || "", /Zilliz Cloud cluster is stopped/);
    assert.equal(diagnostic?.hints.backend.provider, "zilliz");
    assert.equal(diagnostic?.hints.backend.retryable, true);
    assert.match(diagnostic?.hints.backend.nextSteps.join(" "), /Resume the Zilliz Cloud cluster/);
});

test("classifyVectorBackendError maps common transport failures to stable backend codes", () => {
    assert.equal(classifyVectorBackendError(new Error("Connection closed"))?.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
    assert.equal(classifyVectorBackendError(new Error("4 DEADLINE_EXCEEDED: Deadline exceeded after 15s"))?.code, "VECTOR_BACKEND_TIMEOUT");
    assert.equal(classifyVectorBackendError(new Error("ECONNREFUSED 127.0.0.1:19530"))?.code, "VECTOR_BACKEND_UNREACHABLE");
    assert.equal(classifyVectorBackendError(new Error("invalid token: unauthenticated"))?.code, "VECTOR_BACKEND_AUTH_FAILED");
});

test("classifyVectorBackendError ignores unrelated non-vector errors", () => {
    assert.equal(classifyVectorBackendError(new Error("Feature unavailable for this account")), null);
    assert.equal(classifyVectorBackendError(new Error("Permission denied while reading local config")), null);
    assert.equal(classifyVectorBackendError({ reason: "unauthorized user role" }), null);
});

test("formatSearchVectorBackendError returns a deterministic not_ready search envelope", () => {
    const diagnostic = classifyVectorBackendError(new Error("Connection closed"));
    assert.ok(diagnostic);

    const response = formatSearchVectorBackendError({
        path: "/repo",
        query: "auth",
        scope: "runtime",
        groupBy: "symbol",
        resultMode: "grouped",
        limit: 10,
    }, diagnostic);
    const payload = JSON.parse(response.content[0].text);

    assert.doesNotMatch(response.content[0].text, /\n\s+"/);
    assert.equal(payload.status, "not_ready");
    assert.equal(payload.reason, "vector_backend_unavailable");
    assert.equal(payload.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
    assert.equal(payload.freshnessDecision, null);
    assert.deepEqual(payload.results, []);
    assert.equal(payload.humanText, payload.message);
    assert.equal(payload.hints.backend.code, "VECTOR_BACKEND_CONNECTION_CLOSED");
    assert.doesNotMatch(payload.message, /Connection closed/);
    assert.doesNotMatch(payload.message, /Zilliz/);
    assert.match(payload.message, /backend health, provider environment, network connectivity/);
    assert.match(payload.hints.backend.nextSteps.join(" "), /MISSING_PROVIDER_CONFIG/);
    assert.match(payload.hints.backend.nextSteps.join(" "), /non-Zilliz Milvus-compatible backends/);
});

test("formatManageVectorBackendError returns a deterministic manage_index envelope", () => {
    const diagnostic = classifyVectorBackendError(
        new Error("16 UNAUTHENTICATED: The action is unavailable under current cluster status STOPPED.")
    );
    assert.ok(diagnostic);

    const response = formatManageVectorBackendError("sync", "/repo", diagnostic);
    const payload = JSON.parse(response.content[0].text);

    assert.doesNotMatch(response.content[0].text, /\n\s+"/);
    assert.equal(payload.tool, "manage_index");
    assert.equal(payload.version, 1);
    assert.equal(payload.status, "error");
    assert.equal(payload.reason, "vector_backend_unavailable");
    assert.equal(payload.action, "sync");
    assert.equal(payload.path, "/repo");
    assert.equal(payload.code, "ZILLIZ_CLUSTER_STOPPED");
    assert.match(payload.humanText, /Zilliz Cloud cluster is stopped/);
    assert.equal(payload.hints.backend.code, "ZILLIZ_CLUSTER_STOPPED");
    assert.doesNotMatch(payload.message, /UNAUTHENTICATED/);
});
