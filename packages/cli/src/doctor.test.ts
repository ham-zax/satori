import test from "node:test";
import assert from "node:assert/strict";
import { DoctorOptions, DoctorPackageVersion, runDoctor } from "./doctor.js";

const successfulExecFileSync = (() => "0.0.0") as NonNullable<DoctorOptions["execFileSyncImpl"]>;

const fixedPackageVersions = (): DoctorPackageVersion[] => [
    { name: "@zokizuan/satori-cli", version: "0.4.11", source: "test" },
    { name: "@zokizuan/satori-mcp", version: "4.11.13", source: "test" },
    { name: "@zokizuan/satori-core", version: "1.6.9", source: "test" },
];

test("runDoctor reports missing default VoyageAI and Milvus env", () => {
    const result = runDoctor({
        nodeVersion: "v20.11.0",
        env: {},
        execFileSyncImpl: successfulExecFileSync,
        resolvePackageVersions: fixedPackageVersions,
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
        resolvePackageVersions: fixedPackageVersions,
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
        resolvePackageVersions: fixedPackageVersions,
    });

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "node_version")?.status, "error");
});

test("runDoctor reports Satori package version set and independent-version policy", () => {
    const result = runDoctor({
        nodeVersion: "v20.11.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
        execFileSyncImpl: successfulExecFileSync,
        resolvePackageVersions: fixedPackageVersions,
    });

    assert.equal(result.packageVersions.length, 3);
    assert.deepEqual(
        result.packageVersions.map((entry) => `${entry.name}@${entry.version}`),
        [
            "@zokizuan/satori-cli@0.4.11",
            "@zokizuan/satori-mcp@4.11.13",
            "@zokizuan/satori-core@1.6.9",
        ],
    );
    assert.match(result.packageVersionNote, /independent package versions/i);
    assert.equal(result.checks.find((check) => check.name === "package_version_cli")?.message, "@zokizuan/satori-cli@0.4.11");
    assert.equal(result.checks.find((check) => check.name === "package_version_mcp")?.message, "@zokizuan/satori-mcp@4.11.13");
    assert.equal(result.checks.find((check) => check.name === "package_version_core")?.message, "@zokizuan/satori-core@1.6.9");
    assert.equal(result.checks.find((check) => check.name === "package_version_policy")?.status, "ok");
});

test("runDoctor warns when a package version cannot be resolved", () => {
    const result = runDoctor({
        nodeVersion: "v20.11.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
        execFileSyncImpl: successfulExecFileSync,
        resolvePackageVersions: () => [
            { name: "@zokizuan/satori-cli", version: "0.4.11", source: "test" },
            { name: "@zokizuan/satori-mcp", version: null, source: "unresolved" },
            { name: "@zokizuan/satori-core", version: "1.6.9", source: "test" },
        ],
    });

    assert.equal(result.status, "warning");
    assert.equal(result.checks.find((check) => check.name === "package_version_mcp")?.status, "warning");
});
