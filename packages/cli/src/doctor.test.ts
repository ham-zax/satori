import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
    DoctorOptions,
    DoctorPackageVersion,
    resolveCorePackageVersionViaMcp,
    runDoctor,
} from "./doctor.js";

const successfulExecFileSync = (() => "0.0.0") as NonNullable<DoctorOptions["execFileSyncImpl"]>;

const fixedPackageVersions = (): DoctorPackageVersion[] => [
    { name: "@zokizuan/satori-cli", version: "0.4.14", source: "test" },
    { name: "@zokizuan/satori-mcp", version: "4.11.16", source: "test" },
    { name: "@zokizuan/satori-core", version: "1.6.11", source: "test" },
];

/** Isolate doctor from the operator machine's ~/.satori/runtime/owners.json. */
const noRuntimeOwnersPath = path.join(os.tmpdir(), "satori-doctor-no-owners-registry.json");

function baseDoctorOptions(overrides: DoctorOptions = {}): DoctorOptions {
    return {
        execFileSyncImpl: successfulExecFileSync,
        resolvePackageVersions: fixedPackageVersions,
        runtimeOwnersPath: noRuntimeOwnersPath,
        ...overrides,
    };
}

test("runDoctor reports missing default VoyageAI and Milvus env", () => {
    const result = runDoctor(baseDoctorOptions({
        nodeVersion: "v20.11.0",
        env: {},
    }));

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Embedding provider: VoyageAI.");
    assert.equal(result.checks.find((check) => check.name === "embedding_model")?.message, "Embedding model: voyage-code-3.");
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension")?.message, "Embedding output dimension: 1024.");
    assert.equal(result.checks.some((check) => check.name === "embedding_provider_env" && check.status === "error"), true);
    assert.equal(result.checks.some((check) => check.name === "milvus_address" && check.status === "error"), true);
    assert.deepEqual(result.nextSteps, [
        "Set VOYAGEAI_API_KEY from the Voyage AI dashboard API keys page.",
        "Set MILVUS_ADDRESS to a Zilliz Cloud public endpoint or local Milvus address such as localhost:19530.",
        "Restart your MCP client after changing Satori environment variables.",
    ]);
});

test("runDoctor treats whitespace-only provider env as incomplete", () => {
    const result = runDoctor(baseDoctorOptions({
        nodeVersion: "v20.11.0",
        env: {
            VOYAGEAI_API_KEY: "   ",
            MILVUS_ADDRESS: "",
        },
    }));

    assert.equal(result.status, "error");
    assert.match(
        result.checks.find((check) => check.name === "embedding_provider_env")?.message || "",
        /non-empty VOYAGEAI_API_KEY/i,
    );
    assert.match(
        result.checks.find((check) => check.name === "milvus_address")?.message || "",
        /non-empty/i,
    );
});

test("runDoctor treats Ollama as keyless but still requires MILVUS_ADDRESS", () => {
    const result = runDoctor(baseDoctorOptions({
        nodeVersion: "v22.0.0",
        env: {
            EMBEDDING_PROVIDER: "Ollama",
            MILVUS_ADDRESS: "localhost:19530",
        },
    }));

    assert.equal(result.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Embedding provider: Ollama.");
    assert.equal(result.checks.find((check) => check.name === "embedding_model")?.message, "Embedding model: nomic-embed-text.");
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension")?.message, "Embedding output dimension: provider default.");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider_env")?.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "milvus_address")?.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "milvus_token")?.status, "ok");
});

test("runDoctor rejects unsupported embedding providers", () => {
    const result = runDoctor(baseDoctorOptions({
        nodeVersion: "v22.0.0",
        env: {
            EMBEDDING_PROVIDER: "Typo",
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
    }));

    assert.equal(result.status, "error");
    const providerCheck = result.checks.find((check) => check.name === "embedding_provider");
    assert.equal(providerCheck?.status, "error");
    assert.match(providerCheck?.message || "", /OpenAI, VoyageAI, Gemini, or Ollama/);
});

test("runDoctor flags unsupported Node versions", () => {
    const result = runDoctor(baseDoctorOptions({
        nodeVersion: "v18.19.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
    }));

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "node_version")?.status, "error");
});

test("runDoctor reports Satori package version set and independent-version policy", () => {
    const result = runDoctor(baseDoctorOptions({
        nodeVersion: "v20.11.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
    }));

    assert.equal(result.packageVersions.length, 3);
    assert.deepEqual(
        result.packageVersions.map((entry) => `${entry.name}@${entry.version}`),
        [
            "@zokizuan/satori-cli@0.4.14",
            "@zokizuan/satori-mcp@4.11.16",
            "@zokizuan/satori-core@1.6.11",
        ],
    );
    assert.match(result.packageVersionNote, /independent package versions/i);
    assert.equal(result.checks.find((check) => check.name === "package_version_cli")?.message, "@zokizuan/satori-cli@0.4.14");
    assert.equal(result.checks.find((check) => check.name === "package_version_mcp")?.message, "@zokizuan/satori-mcp@4.11.16");
    assert.equal(result.checks.find((check) => check.name === "package_version_core")?.message, "@zokizuan/satori-core@1.6.11");
    assert.equal(result.checks.find((check) => check.name === "package_version_policy")?.status, "ok");
});

test("runDoctor warns when a package version cannot be resolved", () => {
    const result = runDoctor(baseDoctorOptions({
        nodeVersion: "v20.11.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
        resolvePackageVersions: () => [
            { name: "@zokizuan/satori-cli", version: "0.4.14", source: "test" },
            { name: "@zokizuan/satori-mcp", version: null, source: "unresolved" },
            { name: "@zokizuan/satori-core", version: "1.6.11", source: "test" },
        ],
    }));

    assert.equal(result.status, "warning");
    assert.equal(result.checks.find((check) => check.name === "package_version_mcp")?.status, "warning");
});

test("runDoctor errors when multiple live Satori MCP package versions are registered", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-owners-"));
    const ownersPath = path.join(tempDir, "owners.json");
    try {
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            updatedAt: new Date().toISOString(),
            owners: [
                {
                    ownerId: "a",
                    pid: 111,
                    satoriVersion: "4.11.13",
                    runtimeFingerprint: {},
                    runtimeOwnerIdentityHash: "hash-a",
                    configSource: "env",
                    startedAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                },
                {
                    ownerId: "b",
                    pid: 222,
                    satoriVersion: "4.11.14",
                    runtimeFingerprint: {},
                    runtimeOwnerIdentityHash: "hash-b",
                    configSource: "env",
                    startedAt: new Date().toISOString(),
                    lastSeenAt: new Date().toISOString(),
                },
            ],
        }), "utf8");

        const result = runDoctor(baseDoctorOptions({
            nodeVersion: "v20.11.0",
            env: {
                VOYAGEAI_API_KEY: "pa-test",
                MILVUS_ADDRESS: "localhost:19530",
            },
            runtimeOwnersPath: ownersPath,
            isProcessLive: (pid) => pid === 111 || pid === 222,
        }));

        assert.equal(result.status, "error");
        const ownersCheck = result.checks.find((check) => check.name === "runtime_owners");
        assert.equal(ownersCheck?.status, "error");
        assert.match(ownersCheck?.message || "", /4\.11\.13/);
        assert.match(ownersCheck?.message || "", /4\.11\.14/);
        assert.match(ownersCheck?.message || "", /runtime_owner_conflict/);
        assert.equal(
            result.nextSteps.some((step) => /Stop extra Satori MCP|single version|4\.11/.test(step)),
            true,
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

// Doctor finding: core nested under mcp must still resolve (createRequire from MCP package.json).
test("resolveCorePackageVersionViaMcp resolves core nested under mcp package root", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-nested-"));
    try {
        const mcpDir = path.join(tempRoot, "node_modules", "@zokizuan", "satori-mcp");
        const coreDir = path.join(mcpDir, "node_modules", "@zokizuan", "satori-core");
        const mcpPackageJson = path.join(mcpDir, "package.json");
        fs.mkdirSync(coreDir, { recursive: true });
        fs.writeFileSync(
            mcpPackageJson,
            JSON.stringify({ name: "@zokizuan/satori-mcp", version: "9.9.9" }),
            "utf8",
        );
        fs.writeFileSync(
            path.join(coreDir, "package.json"),
            JSON.stringify({ name: "@zokizuan/satori-core", version: "8.8.8" }),
            "utf8",
        );

        // CLI-rooted require must not see nested core (repro of false warning layout).
        const requireFromCliRoot = createRequire(path.join(tempRoot, "cli-entry.js"));
        let cliSawCore = true;
        try {
            requireFromCliRoot.resolve("@zokizuan/satori-core/package.json");
        } catch {
            cliSawCore = false;
        }
        assert.equal(cliSawCore, false, "CLI root must not resolve nested core in this layout");

        const viaMcp = resolveCorePackageVersionViaMcp({ mcpPackageJsonPath: mcpPackageJson });
        assert.ok(viaMcp, "MCP-rooted core resolution should succeed for nested layout");
        assert.equal(viaMcp?.name, "@zokizuan/satori-core");
        assert.equal(viaMcp?.version, "8.8.8");
        assert.match(viaMcp?.source || "", /satori-core[/\\]package\.json$/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test("resolveCorePackageVersionViaMcp resolves core in the live workspace", () => {
    const viaMcp = resolveCorePackageVersionViaMcp();
    assert.ok(viaMcp, "MCP-rooted core resolution should succeed in this workspace");
    assert.equal(viaMcp?.name, "@zokizuan/satori-core");
    assert.ok(viaMcp?.version);
});
