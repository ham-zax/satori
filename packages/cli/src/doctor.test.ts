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
        mutationLeasesPath: null,
        managedLauncherPath: null,
        inspectManagedClients: () => [{
            client: "codex",
            configPath: "/tmp/config.toml",
            status: "ok",
            message: "codex config is current",
        }],
        ...overrides,
    };
}

function healthyEnv(): NodeJS.ProcessEnv {
    return {
        VOYAGEAI_API_KEY: "pa-test",
        MILVUS_ADDRESS: "localhost:19530",
    };
}

function runtimeOwner(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        ownerId: "owner",
        pid: 111,
        satoriVersion: "4.11.16",
        runtimeFingerprint: { schemaVersion: "hybrid_v3" },
        runtimeOwnerIdentityHash: "same-hash",
        configSource: "env",
        startedAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        processStartTime: "start-111",
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
    // Model/dimension/key checks are skipped so doctor does not emit contradictory "ok" or VoyageAI key guidance.
    assert.equal(result.checks.find((check) => check.name === "embedding_model"), undefined);
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension"), undefined);
    assert.equal(result.checks.find((check) => check.name === "embedding_provider_env"), undefined);
    assert.equal(result.nextSteps.some((step) => step.includes("VOYAGEAI_API_KEY")), false);
    assert.equal(
        result.nextSteps.some((step) => step.includes("Set EMBEDDING_PROVIDER to OpenAI, VoyageAI, Gemini, or Ollama.")),
        true,
    );
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

test("runDoctor errors when a live runtime version differs from the installed MCP version", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-stale-owner-"));
    const ownersPath = path.join(tempDir, "owners.json");
    try {
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({ satoriVersion: "4.11.15" })],
        }));

        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            runtimeOwnersPath: ownersPath,
            inspectProcess: (pid) => ({ pid, processStartTime: "start-111" }),
        }));

        const check = result.checks.find((entry) => entry.name === "runtime_owners");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /installed MCP version 4\.11\.16/);
        assert.match(check?.message || "", /pid=111.*4\.11\.15/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor errors on same-version runtime identity conflicts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-identity-owner-"));
    const ownersPath = path.join(tempDir, "owners.json");
    try {
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [
                runtimeOwner({ ownerId: "a", pid: 111, processStartTime: "start-111" }),
                runtimeOwner({
                    ownerId: "b",
                    pid: 222,
                    processStartTime: "start-222",
                    runtimeOwnerIdentityHash: "different-hash",
                    runtimeFingerprint: { schemaVersion: "dense_v2" },
                }),
            ],
        }));

        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            runtimeOwnersPath: ownersPath,
            inspectProcess: (pid) => ({ pid, processStartTime: `start-${pid}` }),
        }));

        const check = result.checks.find((entry) => entry.name === "runtime_owners");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /runtime fingerprint/);
        assert.match(check?.message || "", /config identity hash/);
        assert.match(check?.message || "", /runtime_owner_conflict/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor rejects reused owner pids when process-start evidence differs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-owner-start-"));
    const ownersPath = path.join(tempDir, "owners.json");
    try {
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({ processStartTime: "old-start" })],
        }));

        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            runtimeOwnersPath: ownersPath,
            inspectProcess: (pid) => ({ pid, processStartTime: "new-start" }),
        }));

        const check = result.checks.find((entry) => entry.name === "runtime_owners");
        assert.equal(check?.status, "warning");
        assert.match(check?.message || "", /stale \(dead or replaced\)/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor reports active and abandoned mutation leases without age expiry", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-leases-"));
    try {
        const lease = (root: string, pid: number, processStartTime: string) => ({
            formatVersion: "v1",
            canonicalRoot: root,
            generation: 4,
            lease: {
                canonicalRoot: root,
                generation: 4,
                operationId: `operation-${pid}`,
                action: "sync",
                ownerId: `owner-${pid}`,
                pid,
                processStartTime,
                acquiredAt: "2000-01-01T00:00:00.000Z",
            },
        });
        fs.writeFileSync(path.join(tempDir, "a.json"), JSON.stringify(lease("/repo/active", 111, "start-111")));
        fs.writeFileSync(path.join(tempDir, "b.json"), JSON.stringify(lease("/repo/abandoned", 222, "start-222")));

        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            mutationLeasesPath: tempDir,
            inspectProcess: (pid) => pid === 111 ? { pid, processStartTime: "start-111" } : null,
        }));

        const check = result.checks.find((entry) => entry.name === "mutation_leases");
        assert.equal(check?.status, "warning");
        assert.match(check?.message || "", /active=1/);
        assert.match(check?.message || "", /abandoned=1/);
        assert.match(check?.message || "", /operation-111/);
        assert.match(check?.message || "", /operation-222/);
        assert.equal(result.nextSteps.some((step) => /expiry|expired/i.test(step)), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor fails closed on malformed mutation lease state", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-corrupt-lease-"));
    try {
        fs.writeFileSync(path.join(tempDir, "broken.json"), "{not-json");
        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            mutationLeasesPath: tempDir,
        }));

        const check = result.checks.find((entry) => entry.name === "mutation_leases");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /broken\.json/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor diagnoses a managed launcher whose runtime target is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-missing-"));
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.writeFileSync(launcherPath, [
            "#!/usr/bin/env node",
            `const command = ${JSON.stringify(process.execPath)};`,
            `const baseArgs = ${JSON.stringify([path.join(tempDir, "missing", "dist", "index.js")])};`,
        ].join("\n"));
        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            managedLauncherPath: launcherPath,
        }));

        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /target does not exist/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor diagnoses a managed launcher targeting a stale MCP package version", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-version-"));
    const packageRoot = path.join(tempDir, "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(packageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.15",
        }));
        fs.writeFileSync(launcherPath, [
            "#!/usr/bin/env node",
            `const command = ${JSON.stringify(process.execPath)};`,
            `const baseArgs = ${JSON.stringify([target])};`,
        ].join("\n"));

        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            managedLauncherPath: launcherPath,
        }));

        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /4\.11\.15/);
        assert.match(check?.message || "", /installed MCP version 4\.11\.16/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor accepts a managed launcher targeting the installed MCP package", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-current-"));
    const packageRoot = path.join(tempDir, "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(packageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.16",
        }));
        fs.writeFileSync(launcherPath, [
            "#!/usr/bin/env node",
            `const command = ${JSON.stringify(process.execPath)};`,
            `const baseArgs = ${JSON.stringify([target])};`,
        ].join("\n"));

        const result = runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            managedLauncherPath: launcherPath,
        }));

        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "ok");
        assert.match(check?.message || "", /satori-mcp@4\.11\.16/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor errors when a configured MCP client does not point to the managed launcher", () => {
    const result = runDoctor(baseDoctorOptions({
        env: healthyEnv(),
        inspectManagedClients: () => [{
            client: "claude",
            configPath: "/tmp/.claude.json",
            status: "error",
            message: "claude config does not point exactly to the managed launcher.",
        }],
    }));

    const check = result.checks.find((entry) => entry.name === "managed_client_configuration");
    assert.equal(check?.status, "error");
    assert.match(check?.message || "", /claude config/);
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
