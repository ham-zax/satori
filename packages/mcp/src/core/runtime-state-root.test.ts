import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    resolveRuntimeOwnerStateDir,
    resolveSatoriStateRoot,
} from "@satori-code/core/integration";

const HOME = "/home/tester";

test("default state root is <homeDir>/.satori when unconfigured", () => {
    const stateRoot = resolveSatoriStateRoot({ homeDir: HOME });
    assert.equal(stateRoot, path.join(HOME, ".satori"));
});

test("default state root is <homeDir>/.satori when configured value is empty", () => {
    assert.equal(
        resolveSatoriStateRoot({ configured: "", homeDir: HOME }),
        path.join(HOME, ".satori"),
    );
    assert.equal(
        resolveSatoriStateRoot({ configured: "   ", homeDir: HOME }),
        path.join(HOME, ".satori"),
    );
});

test("explicit absolute state root is returned verbatim", () => {
    const configured = path.join(os.tmpdir(), "satori-ab-cd");
    const stateRoot = resolveSatoriStateRoot({ configured, homeDir: HOME });
    assert.equal(stateRoot, configured);
});

test("relative state root is rejected", () => {
    assert.throws(
        () => resolveSatoriStateRoot({ configured: "relative/state", homeDir: HOME }),
        /SATORI_STATE_ROOT must be an absolute path/,
    );
});

test("two LanceDB state roots produce different owner directories", () => {
    const alpha = resolveRuntimeOwnerStateDir({
        stateRoot: "/state/alpha",
        vectorStoreProvider: "LanceDB",
        homeDir: HOME,
    });
    const beta = resolveRuntimeOwnerStateDir({
        stateRoot: "/state/beta",
        vectorStoreProvider: "LanceDB",
        homeDir: HOME,
    });
    assert.notEqual(alpha, beta);
    assert.equal(alpha, path.join("/state/alpha", "runtime-owner"));
    assert.equal(beta, path.join("/state/beta", "runtime-owner"));
});

test("same Milvus endpoint across state roots produces the same owner directory", () => {
    const endpoint = "grpc://milvus.example:19530";
    const alpha = resolveRuntimeOwnerStateDir({
        stateRoot: "/state/alpha",
        vectorStoreProvider: "Milvus",
        milvusEndpoint: endpoint,
        homeDir: HOME,
    });
    const beta = resolveRuntimeOwnerStateDir({
        stateRoot: "/state/beta",
        vectorStoreProvider: "Milvus",
        milvusEndpoint: endpoint,
        homeDir: HOME,
    });
    assert.equal(alpha, beta);
    const expectedHash = crypto.createHash("sha256")
        .update(endpoint.trim().toLowerCase())
        .digest("hex");
    assert.equal(
        alpha,
        path.join(HOME, ".satori", "runtime-owner", "milvus", expectedHash),
    );
});

test("different Milvus endpoints produce different owner directories", () => {
    const a = resolveRuntimeOwnerStateDir({
        stateRoot: "/state/any",
        vectorStoreProvider: "Milvus",
        milvusEndpoint: "grpc://cluster-a:19530",
        homeDir: HOME,
    });
    const b = resolveRuntimeOwnerStateDir({
        stateRoot: "/state/any",
        vectorStoreProvider: "Milvus",
        milvusEndpoint: "grpc://cluster-b:19530",
        homeDir: HOME,
    });
    assert.notEqual(a, b);
});
