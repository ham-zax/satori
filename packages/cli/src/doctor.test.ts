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
import { buildLauncherScript } from "./managed-launcher-script.mjs";

const successfulExecFileSync = (() => "0.0.0") as NonNullable<DoctorOptions["execFileSyncImpl"]>;

const fixedPackageVersions = (): DoctorPackageVersion[] => [
    { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
    { name: "@zokizuan/satori-mcp", version: "4.11.17", source: "test" },
    { name: "@zokizuan/satori-core", version: "1.6.12", source: "test" },
];

/** Isolate doctor from the operator machine's ~/.satori/runtime/owners.json. */
const noRuntimeOwnersPath = path.join(os.tmpdir(), "satori-doctor-no-owners-registry.json");
const noDiagnosticsPath = path.join(os.tmpdir(), "satori-doctor-no-diagnostics.jsonl");

function baseDoctorOptions(overrides: DoctorOptions = {}): DoctorOptions {
    return {
        execFileSyncImpl: successfulExecFileSync,
        resolvePackageVersions: fixedPackageVersions,
        runtimeOwnersPath: noRuntimeOwnersPath,
        diagnosticsPath: noDiagnosticsPath,
        mutationLeasesPath: null,
        managedLauncherPath: null,
        resolveOllamaIdentity: async ({ model }) => Object.freeze({
            configuredModel: model,
            resolvedModel: `${model}:latest`,
            artifactDigest: "a".repeat(64),
            artifactSize: 1,
            dimension: 768,
        }),
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
        satoriVersion: "4.11.17",
        runtimeFingerprint: { schemaVersion: "hybrid_v3" },
        runtimeOwnerIdentityHash: "same-hash",
        configSource: "env",
        startedAt: "2026-07-10T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        processStartTime: "start-111",
        ...overrides,
    };
}

test("runDoctor reports missing default VoyageAI credentials with LanceDB selected", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v20.11.0",
        env: {},
    }));

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Embedding provider: VoyageAI.");
    assert.equal(result.checks.find((check) => check.name === "embedding_model")?.message, "Embedding model: voyage-code-3.");
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension")?.message, "Embedding output dimension: 1024.");
    assert.equal(result.checks.some((check) => check.name === "embedding_provider_env" && check.status === "error"), true);
    assert.equal(result.checks.find((check) => check.name === "vector_store_provider")?.message, "Vector store provider: LanceDB.");
    assert.equal(result.checks.find((check) => check.name === "lancedb_path")?.status, "ok");
    assert.deepEqual(result.nextSteps, [
        "Set VOYAGEAI_API_KEY from the Voyage AI dashboard API keys page.",
        "Restart your MCP client after changing Satori environment variables.",
    ]);
});

test("runDoctor includes a privacy-safe summary of local CLI diagnostics", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-diagnostics-"));
    const diagnosticsPath = path.join(tempDir, "events.jsonl");
    try {
        fs.writeFileSync(diagnosticsPath, `${JSON.stringify({
            schemaVersion: "v1",
            kind: "tool_call",
            tool: "search_codebase",
            durationMs: 12,
            outcome: "ok",
            resultCount: 2,
            warningCodes: ["RERANKER_FAILED"],
            fallbackUsed: true,
        })}\n`);
        const result = await runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            diagnosticsPath,
        }));

        assert.equal(result.localDiagnostics.eventsRead, 1);
        assert.equal(result.localDiagnostics.totalDurationMs, 12);
        assert.deepEqual(result.localDiagnostics.warningCodes, [{ code: "RERANKER_FAILED", count: 1 }]);
        assert.doesNotMatch(JSON.stringify(result.localDiagnostics), /events\.jsonl|satori-doctor-diagnostics/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor treats whitespace-only provider env as incomplete", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v20.11.0",
        env: {
            VOYAGEAI_API_KEY: "   ",
            VECTOR_STORE_PROVIDER: "Milvus",
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

test("runDoctor treats Ollama as keyless but still requires MILVUS_ADDRESS", async () => {
    const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor proves the selected offline backend, model identity, and network invariant", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v22.0.0",
        env: {
            HOME: "/tmp/satori-offline-doctor",
            SATORI_RUNTIME_PROFILE: "offline",
            VECTOR_STORE_PROVIDER: "LanceDB",
            EMBEDDING_PROVIDER: "Ollama",
            OLLAMA_MODEL: "nomic-embed-text:latest",
            OLLAMA_MODEL_DIGEST: "a".repeat(64),
            OLLAMA_HOST: "http://127.0.0.1:11434",
            VOYAGEAI_API_KEY: "retained-but-disabled",
        },
    }));

    assert.equal(result.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "ollama_model_identity")?.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "offline_execution_invariant")?.status, "ok");
});

test("ordinary doctor leaves an empty home directory unchanged", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-read-only-"));
    try {
        const before = fs.readdirSync(homeDir);
        await runDoctor(baseDoctorOptions({
            env: {
                HOME: homeDir,
                SATORI_RUNTIME_PROFILE: "connected",
                VECTOR_STORE_PROVIDER: "LanceDB",
                EMBEDDING_PROVIDER: "VoyageAI",
                VOYAGEAI_API_KEY: "test-only",
            },
        }));
        assert.deepEqual(fs.readdirSync(homeDir), before);
    } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
    }
});

test("runDoctor uses installer-owned launcher settings over stale ambient providers", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-managed-profile-"));
    const packageRoot = path.join(tempDir, "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(packageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: {
                SATORI_RUNTIME_PROFILE: "offline",
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: path.join(tempDir, "lancedb"),
                EMBEDDING_PROVIDER: "Ollama",
                OLLAMA_MODEL: "nomic-embed-text:latest",
                OLLAMA_MODEL_DIGEST: "a".repeat(64),
                OLLAMA_HOST: "http://127.0.0.1:11434",
            },
        }));

        const result = await runDoctor(baseDoctorOptions({
            env: {
                HOME: tempDir,
                VOYAGEAI_API_KEY: "retained-but-disabled",
                MILVUS_ADDRESS: "stale-cloud-endpoint",
            },
            managedLauncherPath: launcherPath,
            loadManagedLanceDb: async () => undefined,
        }));

        assert.equal(result.status, "ok");
        assert.equal(result.checks.find((check) => check.name === "runtime_profile")?.message, "Runtime profile: offline.");
        assert.equal(result.checks.find((check) => check.name === "vector_store_provider")?.message, "Vector store provider: LanceDB.");
        assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Embedding provider: Ollama.");
        assert.equal(result.checks.find((check) => check.name === "offline_execution_invariant")?.status, "ok");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor rejects unsupported embedding providers", async () => {
    const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor flags unsupported Node versions", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v18.19.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
    }));

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "node_version")?.status, "error");
});

test("runDoctor reports Satori package version set and independent-version policy", async () => {
    const result = await runDoctor(baseDoctorOptions({
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
            "@zokizuan/satori-cli@0.4.15",
            "@zokizuan/satori-mcp@4.11.17",
            "@zokizuan/satori-core@1.6.12",
        ],
    );
    assert.match(result.packageVersionNote, /independent package versions/i);
    assert.equal(result.checks.find((check) => check.name === "package_version_cli")?.message, "@zokizuan/satori-cli@0.4.15");
    assert.equal(result.checks.find((check) => check.name === "package_version_mcp")?.message, "@zokizuan/satori-mcp@4.11.17");
    assert.equal(result.checks.find((check) => check.name === "package_version_core")?.message, "@zokizuan/satori-core@1.6.12");
    assert.equal(result.checks.find((check) => check.name === "package_version_policy")?.status, "ok");
});

test("runDoctor warns when a package version cannot be resolved", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v20.11.0",
        env: {
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
        resolvePackageVersions: () => [
            { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
            { name: "@zokizuan/satori-mcp", version: null, source: "unresolved" },
            { name: "@zokizuan/satori-core", version: "1.6.12", source: "test" },
        ],
    }));

    assert.equal(result.status, "warning");
    assert.equal(result.checks.find((check) => check.name === "package_version_mcp")?.status, "warning");
});

test("runDoctor errors when multiple live Satori MCP package versions are registered", async () => {
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

        const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor errors when a live runtime version differs from the installed MCP version", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-stale-owner-"));
    const ownersPath = path.join(tempDir, "owners.json");
    try {
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({ satoriVersion: "4.11.15" })],
        }));

        const result = await runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            runtimeOwnersPath: ownersPath,
            inspectProcess: (pid) => ({ pid, processStartTime: "start-111" }),
        }));

        const check = result.checks.find((entry) => entry.name === "runtime_owners");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /installed MCP version 4\.11\.17/);
        assert.match(check?.message || "", /pid=111.*4\.11\.15/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor errors on same-version runtime identity conflicts", async () => {
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

        const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor rejects reused owner pids when process-start evidence differs", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-owner-start-"));
    const ownersPath = path.join(tempDir, "owners.json");
    try {
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({ processStartTime: "old-start" })],
        }));

        const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor reports active and abandoned mutation leases without age expiry", async () => {
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

        const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor fails closed on malformed mutation lease state", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-corrupt-lease-"));
    try {
        fs.writeFileSync(path.join(tempDir, "broken.json"), "{not-json");
        const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor diagnoses a managed launcher whose runtime target is missing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-missing-"));
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.writeFileSync(launcherPath, [
            "#!/usr/bin/env node",
            `const command = ${JSON.stringify(process.execPath)};`,
            `const baseArgs = ${JSON.stringify([path.join(tempDir, "missing", "dist", "index.js")])};`,
        ].join("\n"));
        const result = await runDoctor(baseDoctorOptions({
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

test("runDoctor diagnoses a managed launcher targeting a stale MCP package version", async () => {
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

        const result = await runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            managedLauncherPath: launcherPath,
        }));

        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /4\.11\.15/);
        assert.match(check?.message || "", /installed MCP version 4\.11\.17/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor accepts a managed launcher targeting the installed MCP package", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-current-"));
    const packageRoot = path.join(tempDir, "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(packageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.writeFileSync(launcherPath, [
            "#!/usr/bin/env node",
            `const command = ${JSON.stringify(process.execPath)};`,
            `const baseArgs = ${JSON.stringify([target])};`,
        ].join("\n"));

        const result = await runDoctor(baseDoctorOptions({
            env: healthyEnv(),
            managedLauncherPath: launcherPath,
        }));

        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "ok");
        assert.match(check?.message || "", /satori-mcp@4\.11\.17/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor reports an exact-runtime LanceDB native load failure independently of provider credentials", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-lancedb-native-"));
    const packageRoot = path.join(tempDir, "node_modules", "@zokizuan", "satori-mcp");
    const coreRoot = path.join(tempDir, "node_modules", "@zokizuan", "satori-core");
    const target = path.join(packageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(coreRoot, { recursive: true });
        fs.writeFileSync(target, "// runtime", "utf8");
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }), "utf8");
        fs.writeFileSync(path.join(coreRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            version: "1.6.12",
            exports: { "./lancedb": "./lancedb.cjs" },
        }), "utf8");
        fs.writeFileSync(
            path.join(coreRoot, "lancedb.cjs"),
            'throw new Error("blocked exact-runtime LanceDB native binding");\n',
            "utf8",
        );
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: {
                SATORI_RUNTIME_PROFILE: "connected",
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: path.join(tempDir, "vector"),
                EMBEDDING_PROVIDER: "VoyageAI",
                EMBEDDING_MODEL: "voyage-code-3",
                EMBEDDING_OUTPUT_DIMENSION: "1024",
            },
        }), "utf8");

        const result = await runDoctor(baseDoctorOptions({
            env: {},
            managedLauncherPath: launcherPath,
        }));

        const check = result.checks.find((entry) => entry.name === "lancedb_native_load");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /blocked exact-runtime LanceDB native binding/);
        assert.equal(result.checks.find((entry) => entry.name === "embedding_provider_env")?.status, "error");
        assert.equal(fs.existsSync(path.join(tempDir, "vector")), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor errors when a configured MCP client does not point to the managed launcher", async () => {
    const result = await runDoctor(baseDoctorOptions({
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
test("resolveCorePackageVersionViaMcp resolves core nested under mcp package root", async () => {
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

test("resolveCorePackageVersionViaMcp resolves core in the live workspace", async () => {
    const viaMcp = resolveCorePackageVersionViaMcp();
    assert.ok(viaMcp, "MCP-rooted core resolution should succeed in this workspace");
    assert.equal(viaMcp?.name, "@zokizuan/satori-core");
    assert.ok(viaMcp?.version);
});
