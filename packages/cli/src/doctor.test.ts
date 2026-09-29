import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    DoctorOptions,
    DoctorPackageVersion,
    type DoctorResult,
    resolveRuntimeVersionState,
    runDoctor,
} from "./doctor.js";
import { formatDoctorText } from "./doctor-format.js";
import type { ManagedClientConfigProof } from "./install.js";
import { buildLauncherScript } from "./managed-launcher-script.mjs";

const successfulExecFileSync: NonNullable<DoctorOptions["execFileSyncImpl"]> = () => "0.0.0";

const fixedPackageVersions = (): DoctorPackageVersion[] => [
    { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
    { name: "@zokizuan/satori-mcp", version: "4.11.17", source: "test" },
    { name: "@zokizuan/satori-core", version: "1.6.12", source: "test" },
];

/** Isolate doctor from the operator machine's managed runtime-owner registries. */
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
            usesManagedLauncher: false,
            runtimeEnvironment: Object.freeze({}),
        }],
        ...overrides,
    };
}

function managedLauncherClientProof(
    client: ManagedClientConfigProof["client"] = "opencode",
): ManagedClientConfigProof {
    return {
        client,
        configPath: `/tmp/${client}.config`,
        status: "ok",
        message: `${client} config points to the managed launcher`,
        usesManagedLauncher: true,
        runtimeEnvironment: Object.freeze({}),
    };
}

function assertManagedRuntimeSelectionUnavailable(
    result: DoctorResult,
    client: ManagedClientConfigProof["client"] = "opencode",
): void {
    const configuration = result.runtimeConfigurations?.find((candidate) => candidate.client === client);
    assert.deepEqual(configuration, {
        client,
        status: "needs_repair",
        source: "managed_launcher",
        profile: null,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingDimension: null,
        rerankerProvider: null,
        rerankerProfile: null,
        vectorStore: null,
    });
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
        nodeVersion: "v22.13.0",
        env: {},
    }));

    assert.equal(result.status, "error");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Codex: Embedding provider: VoyageAI.");
    assert.equal(result.checks.find((check) => check.name === "embedding_model")?.message, "Codex: Embedding model: voyage-code-3.");
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension")?.message, "Codex: Embedding output dimension: 1024.");
    assert.equal(result.checks.some((check) => check.name === "embedding_provider_env" && check.status === "error"), true);
    assert.equal(result.checks.find((check) => check.name === "vector_store_provider")?.message, "Codex: Vector store provider: LanceDB.");
    assert.equal(result.checks.find((check) => check.name === "lancedb_path")?.status, "ok");
    assert.deepEqual(result.nextSteps, [
        "Codex: Set VOYAGEAI_API_KEY from the Voyage AI dashboard API keys page.",
        "Restart your MCP client after changing Satori environment variables.",
    ]);
});

test("runDoctor validates each configured client runtime instead of a shell-default runtime", async () => {
    const result = await runDoctor(baseDoctorOptions({
        env: {},
        inspectManagedClients: (): ManagedClientConfigProof[] => [
            {
                client: "codex",
                configPath: "/tmp/codex.toml",
                status: "error",
                message: "codex config uses a direct runtime",
                usesManagedLauncher: false,
                runtimeEnvironment: {
                    SATORI_RUNTIME_PROFILE: "offline",
                    VECTOR_STORE_PROVIDER: "LanceDB",
                    EMBEDDING_PROVIDER: "Potion",
                    EMBEDDING_MODEL: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
                    EMBEDDING_OUTPUT_DIMENSION: "256",
                    POTION_HELPER_PATH: "/tmp/potion-helper",
                    POTION_MODEL_PATH: "/tmp/potion-model",
                },
            },
            {
                client: "opencode",
                configPath: "/tmp/opencode.json",
                status: "error",
                message: "opencode config uses a direct runtime",
                usesManagedLauncher: false,
                runtimeEnvironment: {
                    VECTOR_STORE_PROVIDER: "Milvus",
                    EMBEDDING_PROVIDER: "VoyageAI",
                    EMBEDDING_MODEL: "voyage-code-3",
                    EMBEDDING_OUTPUT_DIMENSION: "1024",
                    VOYAGEAI_API_KEY: "pa-client-owned",
                    MILVUS_ADDRESS: "localhost:19530",
                },
            },
        ],
    }));

    assert.match(
        result.checks.find((check) => check.name === "client_runtime_codex")?.message || "",
        /Codex: offline · Potion/,
    );
    assert.match(
        result.checks.find((check) => check.name === "client_runtime_opencode")?.message || "",
        /OpenCode: connected · VoyageAI/,
    );
    assert.deepEqual(
        result.runtimeConfigurations?.map((configuration) => ({
            client: configuration.client,
            status: configuration.status,
            source: configuration.source,
            profile: configuration.profile,
            provider: configuration.embeddingProvider,
            model: configuration.embeddingModel,
            dimension: configuration.embeddingDimension,
            reranker: configuration.rerankerProvider,
            store: configuration.vectorStore,
        })),
        [
            {
                client: "codex",
                status: "needs_repair",
                source: "client_configuration",
                profile: "offline",
                provider: "Potion",
                model: "minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b",
                dimension: "256",
                reranker: "none",
                store: "LanceDB",
            },
            {
                client: "claude",
                status: "not_configured",
                source: null,
                profile: null,
                provider: null,
                model: null,
                dimension: null,
                reranker: null,
                store: null,
            },
            {
                client: "opencode",
                status: "needs_repair",
                source: "client_configuration",
                profile: "connected",
                provider: "VoyageAI",
                model: "voyage-code-3",
                dimension: "1024",
                reranker: "none",
                store: "Milvus",
            },
            {
                client: "agy",
                status: "not_configured",
                source: null,
                profile: null,
                provider: null,
                model: null,
                dimension: null,
                reranker: null,
                store: null,
            },
        ],
    );
    assert.equal(result.checks.find((check) => check.name === "embedding_provider_env")?.status, "ok");
    assert.equal(result.nextSteps.some((step) => step.includes("VOYAGEAI_API_KEY")), false);
    assert.equal(result.nextSteps.some((step) => step.includes("--client codex --runtime offline")), true);
    assert.equal(
        result.nextSteps.some((step) => step.includes("--client opencode --runtime voyage --vector-store milvus")),
        true,
    );
    assert.equal(result.checks.some((check) => (
        check.name === "offline_execution_invariant_codex" && check.status === "ok"
    )), true);
});

test("runDoctor does not synthesize runtime values for an unreadable client configuration", async () => {
    const result = await runDoctor(baseDoctorOptions({
        env: {
            EMBEDDING_PROVIDER: "VoyageAI",
            EMBEDDING_MODEL: "shell-model-must-not-be-reported",
            VOYAGEAI_API_KEY: "shell-key-must-not-create-authority",
        },
        inspectManagedClients: () => [{
            client: "opencode",
            configPath: "/tmp/malformed-opencode.json",
            status: "error",
            message: "opencode config could not be parsed",
            usesManagedLauncher: undefined,
            runtimeEnvironment: undefined,
        }],
    }));

    const configuration = result.runtimeConfigurations?.find((candidate) => candidate.client === "opencode");
    assert.deepEqual(configuration, {
        client: "opencode",
        status: "needs_repair",
        source: "unknown",
        profile: null,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingDimension: null,
        rerankerProvider: null,
        rerankerProfile: null,
        vectorStore: null,
    });
    assert.equal(result.checks.some((check) => check.name === "client_runtime_opencode"), false);
    assert.equal(result.checks.some((check) => check.name === "embedding_model"), false);
});

test("runDoctor excludes path-shaped model values and controls from structured runtime rows", async () => {
    const result = await runDoctor(baseDoctorOptions({
        env: {},
        inspectManagedClients: () => [{
            client: "opencode",
            configPath: "/tmp/opencode.json",
            status: "error",
            message: "opencode config uses a direct runtime",
            usesManagedLauncher: false,
            runtimeEnvironment: {
                SATORI_RUNTIME_PROFILE: "offline\n",
                VECTOR_STORE_PROVIDER: "LanceDB\u001b[31m",
                EMBEDDING_PROVIDER: "Potion",
                EMBEDDING_MODEL: "/home/test/models/private-model.onnx",
                EMBEDDING_OUTPUT_DIMENSION: "256",
                POTION_HELPER_PATH: "/tmp/potion-helper",
                POTION_MODEL_PATH: "/tmp/potion-model",
            },
        }],
    }));

    const configuration = result.runtimeConfigurations?.find((candidate) => candidate.client === "opencode");
    assert.equal(configuration?.status, "needs_repair");
    assert.equal(configuration?.source, "client_configuration");
    assert.equal(configuration?.profile, "offline");
    assert.equal(configuration?.embeddingProvider, "Potion");
    assert.equal(configuration?.embeddingModel, null);
    assert.equal(configuration?.embeddingDimension, "256");
    assert.equal(configuration?.vectorStore, "LanceDB");
    const serializedConfiguration = JSON.stringify(configuration);
    assert.doesNotMatch(serializedConfiguration, /private-model/);
    assert.equal(serializedConfiguration.includes("\u001b"), false);
    assert.equal(serializedConfiguration.includes("\n"), false);
    const text = formatDoctorText(result, { verbose: false });
    const table = text.slice(
        text.indexOf("Applied runtime configuration:"),
        text.indexOf("\nProblems"),
    );
    assert.match(table, /Potion \/ —/);
    assert.doesNotMatch(table, /private-model/);
    assert.equal(table.includes("\u001b[31m"), false);
});

test("runDoctor does not echo invalid categorical values or home-relative model paths", async () => {
    const result = await runDoctor(baseDoctorOptions({
        env: {},
        inspectManagedClients: () => [{
            client: "opencode",
            configPath: "/tmp/opencode.json",
            status: "error",
            message: "opencode config contains invalid runtime values",
            usesManagedLauncher: false,
            runtimeEnvironment: {
                SATORI_RUNTIME_PROFILE: "/home/test/private/profile",
                EMBEDDING_PROVIDER: "/home/test/private/provider",
                EMBEDDING_MODEL: "~/private/models/model.onnx",
                EMBEDDING_OUTPUT_DIMENSION: "/home/test/private/dimension",
                SATORI_RERANKER_PROVIDER: "/home/test/private/reranker",
                VECTOR_STORE_PROVIDER: "/home/test/private/store",
            },
        }],
    }));

    const configuration = result.runtimeConfigurations?.find((candidate) => candidate.client === "opencode");
    assert.deepEqual(configuration, {
        client: "opencode",
        status: "needs_repair",
        source: "client_configuration",
        profile: null,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingDimension: null,
        rerankerProvider: null,
        rerankerProfile: null,
        vectorStore: null,
    });
    assert.doesNotMatch(JSON.stringify(configuration), /\/home\/test|~\/private/);
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
        nodeVersion: "v22.13.0",
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
        nodeVersion: "v22.13.0",
        env: {
            EMBEDDING_PROVIDER: "Ollama",
            MILVUS_ADDRESS: "localhost:19530",
        },
    }));

    assert.equal(result.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "Codex: Embedding provider: Ollama.");
    assert.equal(result.checks.find((check) => check.name === "embedding_model")?.message, "Codex: Embedding model: nomic-embed-text.");
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension")?.message, "Codex: Embedding output dimension: provider default.");
    assert.equal(result.checks.find((check) => check.name === "embedding_provider_env")?.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "milvus_address")?.status, "ok");
    assert.equal(result.checks.find((check) => check.name === "milvus_token")?.status, "ok");
});

test("runDoctor proves the selected offline backend, model identity, and network invariant", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v22.13.0",
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
    const packageRoot = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(packageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.mkdirSync(path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-core"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-core", "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            version: "1.6.12",
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
            inspectManagedClients: () => [managedLauncherClientProof()],
            loadManagedLanceDb: async () => undefined,
            execFileSyncImpl: () => { throw new Error("npm should not be queried for an installed runtime"); },
        }));

        assert.equal(result.status, "ok");
        assert.equal(result.checks.find((check) => check.name === "runtime_profile")?.message, "OpenCode: Runtime profile: offline.");
        assert.equal(result.checks.find((check) => check.name === "vector_store_provider")?.message, "OpenCode: Vector store provider: LanceDB.");
        assert.equal(result.checks.find((check) => check.name === "embedding_provider")?.message, "OpenCode: Embedding provider: Ollama.");
        assert.equal(result.checks.find((check) => check.name === "offline_execution_invariant")?.status, "ok");
        assert.equal(result.checks.find((check) => check.name === "npm_package_access"), undefined);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor surfaces the installer-bound LateOn activation policy", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-lateon-policy-"));
    const packageRoot = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(packageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.mkdirSync(path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-core"), { recursive: true });
        fs.writeFileSync(path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-core", "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            version: "1.6.12",
        }));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: {
                SATORI_RUNTIME_PROFILE: "offline",
                VECTOR_STORE_PROVIDER: "LanceDB",
                LANCEDB_PATH: path.join(tempDir, "lancedb"),
                EMBEDDING_PROVIDER: "Potion",
                POTION_HELPER_PATH: path.join(tempDir, "potion", "satori-potion"),
                POTION_MODEL_PATH: path.join(tempDir, "potion", "model"),
                SATORI_RERANKER_PROVIDER: "lateon",
                SATORI_LATEON_MODEL_PATH: path.join(tempDir, "lateon-model"),
                SATORI_LATEON_PROFILE: "lateon_offline_quality_projection_v5_d32_v1",
                SATORI_LATEON_ACTIVATION_POLICY: "lateon_context_v5_d32_owner_default_v1",
            },
        }));

        const result = await runDoctor(baseDoctorOptions({
            env: {
                HOME: tempDir,
                VOYAGEAI_API_KEY: "retained-but-disabled",
            },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [managedLauncherClientProof()],
            loadManagedLanceDb: async () => undefined,
        }));

        assert.equal(result.status, "ok");
        const policy = result.checks.find((check) => check.name === "lateon_activation_policy");
        assert.equal(policy?.status, "ok");
        assert.equal(policy?.message, "OpenCode: LateOn activation policy: lateon_context_v5_d32_owner_default_v1.");
        assert.equal(
            result.checks.find((check) => check.name === "reranker_provider")?.status,
            "ok",
        );
        assert.equal(
            result.runtimeConfigurations?.find((configuration) => configuration.client === "opencode")?.rerankerProfile,
            "lateon_offline_quality_projection_v5_d32_v1",
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor flags a managed launcher whose LateOn activation policy contradicts its profile", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-lateon-policy-mismatch-"));
    const packageRoot = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-mcp");
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
                EMBEDDING_PROVIDER: "Potion",
                POTION_HELPER_PATH: path.join(tempDir, "potion", "satori-potion"),
                POTION_MODEL_PATH: path.join(tempDir, "potion", "model"),
                SATORI_RERANKER_PROVIDER: "lateon",
                SATORI_LATEON_MODEL_PATH: path.join(tempDir, "lateon-model"),
                SATORI_LATEON_PROFILE: "lateon_projection_v2_d16_v1",
                SATORI_LATEON_ACTIVATION_POLICY: "lateon_context_v5_d32_owner_default_v1",
            },
        }));

        const result = await runDoctor(baseDoctorOptions({
            env: {
                HOME: tempDir,
                VOYAGEAI_API_KEY: "retained-but-disabled",
            },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [managedLauncherClientProof()],
            loadManagedLanceDb: async () => undefined,
        }));

        const policy = result.checks.find((check) => check.name === "lateon_activation_policy");
        assert.equal(policy?.status, "error");
        assert.match(
            policy?.message || "",
            /requires SATORI_LATEON_PROFILE=lateon_offline_quality_projection_v5_d32_v1; received lateon_projection_v2_d16_v1/,
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor rejects unsupported embedding providers", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v22.13.0",
        env: {
            EMBEDDING_PROVIDER: "Typo",
            VOYAGEAI_API_KEY: "pa-test",
            MILVUS_ADDRESS: "localhost:19530",
        },
    }));

    assert.equal(result.status, "error");
    const providerCheck = result.checks.find((check) => check.name === "embedding_provider");
    assert.equal(providerCheck?.status, "error");
    assert.match(providerCheck?.message || "", /OpenAI, VoyageAI, Gemini, Ollama, or Potion/);
    // Model/dimension/key checks are skipped so doctor does not emit contradictory "ok" or VoyageAI key guidance.
    assert.equal(result.checks.find((check) => check.name === "embedding_model"), undefined);
    assert.equal(result.checks.find((check) => check.name === "embedding_dimension"), undefined);
    assert.equal(result.checks.find((check) => check.name === "embedding_provider_env"), undefined);
    assert.equal(result.nextSteps.some((step) => step.includes("VOYAGEAI_API_KEY")), false);
    assert.equal(
        result.nextSteps.some((step) => step.includes("Set EMBEDDING_PROVIDER to OpenAI, VoyageAI, Gemini, Ollama, or Potion.")),
        true,
    );
});

test("runDoctor enforces the CLI package's minimum Node version", async () => {
    for (const [nodeVersion, expectedStatus] of [
        ["v20.19.0", "error"],
        ["v22.12.0", "error"],
        ["v22.13.0", "ok"],
        ["v24.0.0", "ok"],
    ] as const) {
        const result = await runDoctor(baseDoctorOptions({ nodeVersion, env: healthyEnv() }));
        const check = result.checks.find((entry) => entry.name === "node_version");
        assert.equal(check?.status, expectedStatus, nodeVersion);
        assert.match(check?.message || "", /22\.13\.0/);
    }
});

test("runDoctor reports Satori package version set and independent-version policy", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v22.13.0",
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
    assert.equal(result.checks.find((check) => check.name === "package_version_cli")?.message, "CLI package: @zokizuan/satori-cli@0.4.15");
    assert.equal(result.checks.find((check) => check.name === "package_version_mcp")?.message, "CLI release MCP target: @zokizuan/satori-mcp@4.11.17");
    assert.equal(result.checks.find((check) => check.name === "package_version_core")?.message, "CLI release Core target: @zokizuan/satori-core@1.6.12");
    assert.equal(result.checks.find((check) => check.name === "package_version_policy")?.status, "ok");
});

test("runDoctor warns when a package version cannot be resolved", async () => {
    const result = await runDoctor(baseDoctorOptions({
        nodeVersion: "v22.13.0",
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
            nodeVersion: "v22.13.0",
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

test("runDoctor errors when a live runtime version differs from the expected MCP version", async () => {
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
        assert.match(check?.message || "", /expected MCP version 4\.11\.17/);
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

test("runDoctor keeps independent runtime-owner registries out of one conflict domain", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-owner-domains-"));
    const lanceOwnersPath = path.join(tempDir, ".satori", "runtime-owner", "owners.json");
    const milvusOwnersPath = path.join(tempDir, ".satori", "runtime-owner", "milvus", "endpoint-a", "owners.json");
    try {
        fs.mkdirSync(path.dirname(lanceOwnersPath), { recursive: true });
        fs.mkdirSync(path.dirname(milvusOwnersPath), { recursive: true });
        fs.writeFileSync(lanceOwnersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({
                ownerId: "lance",
                pid: 111,
                processStartTime: "start-111",
                runtimeFingerprint: { schemaVersion: "hybrid_v3", vectorStoreProvider: "LanceDB" },
                runtimeOwnerIdentityHash: "lance-hash",
            })],
        }));
        fs.writeFileSync(milvusOwnersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({
                ownerId: "milvus",
                pid: 222,
                processStartTime: "start-222",
                runtimeFingerprint: { schemaVersion: "hybrid_v3", vectorStoreProvider: "Milvus" },
                runtimeOwnerIdentityHash: "milvus-hash",
            })],
        }));

        const result = await runDoctor(baseDoctorOptions({
            env: { ...healthyEnv(), HOME: tempDir },
            runtimeOwnersPath: undefined,
            inspectProcess: (pid) => ({ pid, processStartTime: `start-${pid}` }),
        }));

        const ownerChecks = result.checks.filter((entry) => entry.name === "runtime_owners");
        assert.equal(ownerChecks.length, 3);
        assert.equal(ownerChecks.every((check) => check.status === "ok"), true);
        assert.equal(ownerChecks.some((check) => /runtime_owner_conflict/.test(check.message)), false);
        assert.equal(ownerChecks.some((check) => /Active runtime owner registry has not been created yet/.test(check.message)), true);
        assert.equal(ownerChecks.some((check) => check.message.includes(lanceOwnersPath)), true);
        assert.equal(ownerChecks.some((check) => check.message.includes(milvusOwnersPath)), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor reports a corrupt runtime-owner registry without suppressing healthy domains", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-owner-corrupt-domain-"));
    const lanceOwnersPath = path.join(tempDir, ".satori", "runtime-owner", "owners.json");
    const milvusOwnersPath = path.join(tempDir, ".satori", "runtime-owner", "milvus", "endpoint-a", "owners.json");
    try {
        fs.mkdirSync(path.dirname(lanceOwnersPath), { recursive: true });
        fs.mkdirSync(path.dirname(milvusOwnersPath), { recursive: true });
        fs.writeFileSync(lanceOwnersPath, "{not-json", "utf8");
        fs.writeFileSync(milvusOwnersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({
                ownerId: "milvus",
                pid: 222,
                processStartTime: "start-222",
            })],
        }));

        const result = await runDoctor(baseDoctorOptions({
            env: { ...healthyEnv(), HOME: tempDir },
            runtimeOwnersPath: undefined,
            inspectProcess: (pid) => ({ pid, processStartTime: `start-${pid}` }),
        }));

        const ownerChecks = result.checks.filter((entry) => entry.name === "runtime_owners");
        assert.equal(ownerChecks.length, 3);
        const warning = ownerChecks.find((check) => check.status === "warning");
        const healthyDomain = ownerChecks.find((check) => check.message.includes(milvusOwnersPath));
        assert.match(warning?.message || "", /Could not parse inactive\/historical runtime owner registry/);
        assert.match(warning?.message || "", new RegExp(lanceOwnersPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.equal(healthyDomain?.status, "ok");
        assert.match(healthyDomain?.message || "", /pid=222/);
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
            inspectManagedClients: () => [managedLauncherClientProof()],
        }));

        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /target does not exist/);
        assertManagedRuntimeSelectionUnavailable(result);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor validates the resident launcher independently of the transient doctor bundle", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-version-"));
    const packageRoot = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-mcp");
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
            env: { ...healthyEnv(), HOME: tempDir },
            managedLauncherPath: launcherPath,
        }));

        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "ok");
        assert.match(check?.message || "", /satori-mcp@4\.11\.15/);
        assert.doesNotMatch(check?.message || "", /installed MCP version/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor accepts a managed launcher targeting the installed MCP package", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-current-"));
    const packageRoot = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-mcp");
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
            env: { ...healthyEnv(), HOME: tempDir },
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
    const packageRoot = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-mcp");
    const coreRoot = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-core");
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
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [managedLauncherClientProof()],
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

test("runtime version state consumes the already-resolved bundled package set", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-version-state-"));
    try {
        const packageVersions: DoctorPackageVersion[] = [
            { name: "@zokizuan/satori-cli", version: "9.0.0", source: "test" },
            { name: "@zokizuan/satori-mcp", version: "9.0.1", source: "test" },
            { name: "@zokizuan/satori-core", version: "9.0.2", source: "test" },
        ];
        const state = resolveRuntimeVersionState(tempDir, packageVersions);
        assert.equal(state.cliVersion, "9.0.0");
        assert.equal(state.releaseMcpVersion, "9.0.1");
        assert.equal(state.releaseCoreVersion, "9.0.2");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runtime version state preserves managed launcher status and path", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-status-"));
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    const packageVersions = [
        { name: "@zokizuan/satori-cli", version: "9.0.0", source: "test" },
        { name: "@zokizuan/satori-mcp", version: "9.0.1", source: "test" },
        { name: "@zokizuan/satori-core", version: "9.0.2", source: "test" },
    ];
    try {
        assert.equal(resolveRuntimeVersionState(tempDir, packageVersions).managedLauncherStatus, "missing");
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(launcherPath, "not a managed launcher\n");
        const state = resolveRuntimeVersionState(tempDir, packageVersions);
        assert.equal(state.managedLauncherStatus, "malformed");
        assert.equal(state.activeLauncherPath, launcherPath);
        assert.equal(state.activeManagedMcpVersion, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

function launcherFixtureWithRuntime(tempDir: string, versions: { mcp: string; core: string }): string {
    const runtimeRoot = path.join(tempDir, ".satori", "mcp-runtime", `@zokizuan-satori-mcp@${versions.mcp}`);
    const mcpPackageRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
    const corePackageRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-core");
    const target = path.join(mcpPackageRoot, "dist", "index.js");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(corePackageRoot, { recursive: true });
    fs.writeFileSync(target, "// runtime");
    fs.writeFileSync(path.join(mcpPackageRoot, "package.json"), JSON.stringify({
        name: "@zokizuan/satori-mcp",
        version: versions.mcp,
    }));
    fs.writeFileSync(path.join(corePackageRoot, "package.json"), JSON.stringify({
        name: "@zokizuan/satori-core",
        version: versions.core,
    }));
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    return launcherPath;
}

test("doctor resolves active Core when it is nested under the active MCP package", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-nested-active-core-"));
    const runtimeRoot = path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17");
    const mcpPackageRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
    const corePackageRoot = path.join(mcpPackageRoot, "node_modules", "@zokizuan", "satori-core");
    const target = path.join(mcpPackageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(corePackageRoot, { recursive: true });
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(mcpPackageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.writeFileSync(path.join(corePackageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            version: "1.6.12",
        }));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const state = resolveRuntimeVersionState(tempDir, [
            { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
            { name: "@zokizuan/satori-mcp", version: "4.11.17", source: "test" },
            { name: "@zokizuan/satori-core", version: "1.6.12", source: "test" },
        ]);
        assert.equal(state.activeManagedMcpVersion, "4.11.17");
        assert.equal(state.activeManagedCoreVersion, "1.6.12");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor does not claim a launcher target outside the managed runtime store", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-custom-launcher-"));
    const outsideRoot = path.join(tempDir, "custom-runtime", "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(outsideRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(target, "// custom runtime");
        fs.writeFileSync(path.join(outsideRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [managedLauncherClientProof()],
        }));
        assert.equal(result.managedRuntime?.status, "outside_store");
        assert.equal(result.managedRuntime?.mcpVersion, null);
        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.notEqual(check?.status, "ok");
        assert.match(check?.message || "", /outside the managed runtime store|target does not exist/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor rejects a managed-store symlink that escapes the runtime root", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-symlink-launcher-"));
    const outsideRoot = path.join(tempDir, "outside", "node_modules", "@zokizuan", "satori-mcp");
    const managedRoot = path.join(tempDir, ".satori", "mcp-runtime");
    const outsideTarget = path.join(outsideRoot, "dist", "index.js");
    const target = path.join(managedRoot, "escaped", "dist", "index.js");
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(outsideTarget), { recursive: true });
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(outsideRoot + "/package.json", JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.writeFileSync(outsideTarget, "// outside runtime");
        fs.mkdirSync(managedRoot, { recursive: true });
        fs.symlinkSync(path.join(tempDir, "outside"), path.join(managedRoot, "escaped"));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
        }));
        assert.equal(result.managedRuntime?.status === "outside_store" || result.managedRuntime?.status === "missing_target", true);
        assert.equal(result.managedRuntime?.mcpVersion, null);
        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.notEqual(check?.status, "ok");
        assert.match(check?.message || "", /outside the managed runtime store|target does not exist/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor reports the effective environment from a repository-backed managed launcher", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-env-trust-"));
    const outsideRoot = path.join(tempDir, "custom", "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(outsideRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(target, "// custom runtime");
        fs.writeFileSync(path.join(outsideRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: {
                VECTOR_STORE_PROVIDER: "Milvus",
                MILVUS_ADDRESS: "milvus.example:19530",
            },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [{
                client: "opencode",
                configPath: "/tmp/opencode.json",
                status: "ok",
                message: "opencode config points to the managed launcher",
                usesManagedLauncher: true,
                runtimeEnvironment: {},
            }],
        }));
        assert.equal(result.managedRuntime?.status, "outside_store");
        const storeCheck = result.checks.find((entry) => entry.name === "vector_store_provider");
        assert.match(storeCheck?.message || "", /Milvus/);
        assert.equal(
            result.runtimeConfigurations?.find((configuration) => configuration.client === "opencode")?.vectorStore,
            "Milvus",
        );
        assert.equal(
            result.runtimeConfigurations?.find((configuration) => configuration.client === "opencode")?.source,
            "managed_launcher",
        );
        const launcherCheck = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(launcherCheck?.status, "warning");
        assert.match(launcherCheck?.message || "", /outside the managed runtime store/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor rejects a launcher that is not the expected Node form", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-form-"));
    const runtimeRoot = path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17");
    const mcpPackageRoot = path.join(runtimeRoot, "node_modules", "@zokizuan", "satori-mcp");
    const target = path.join(mcpPackageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(mcpPackageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
        }));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: "/usr/bin/some-other-node",
            args: [target, "--extra"],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
        }));
        assert.equal(result.managedRuntime?.status, "custom");
        assert.equal(result.managedRuntime?.mcpVersion, null);
        const launcherCheck = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(launcherCheck?.status, "warning");
        assert.match(launcherCheck?.message || "", /does not use the expected Node launcher form/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor rejects Core resolved from the store level outside the active generation", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-store-core-"));
    const generationA = path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17");
    const mcpPackageRoot = path.join(generationA, "node_modules", "@zokizuan", "satori-mcp");
    const storeLevelCore = path.join(tempDir, ".satori", "mcp-runtime", "node_modules", "@zokizuan", "satori-core");
    const target = path.join(mcpPackageRoot, "dist", "index.js");
    const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.mkdirSync(storeLevelCore, { recursive: true });
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(target, "// runtime");
        fs.writeFileSync(path.join(mcpPackageRoot, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-mcp",
            version: "4.11.17",
            dependencies: { "@zokizuan/satori-core": "1.6.12" },
        }));
        fs.writeFileSync(path.join(storeLevelCore, "package.json"), JSON.stringify({
            name: "@zokizuan/satori-core",
            version: "1.6.12",
        }));
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [target],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const state = resolveRuntimeVersionState(tempDir, [
            { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
            { name: "@zokizuan/satori-mcp", version: "4.11.17", source: "test" },
            { name: "@zokizuan/satori-core", version: "1.6.12", source: "test" },
        ]);
        assert.equal(state.managedLauncherStatus, "active");
        assert.equal(state.activeManagedCoreVersion, null);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor summary uses the active managed launcher version as runtime authority", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-active-authority-"));
    try {
        const launcherPath = launcherFixtureWithRuntime(tempDir, { mcp: "4.11.17", core: "1.6.12" });
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17", "node_modules", "@zokizuan", "satori-mcp", "dist", "index.js")],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            resolvePackageVersions: () => [
                { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
                { name: "@zokizuan/satori-mcp", version: "5.0.0", source: "test" },
                { name: "@zokizuan/satori-core", version: "2.0.0", source: "test" },
            ],
        }));
        assert.equal(result.managedRuntime?.mcpVersion, "4.11.17");
        assert.equal(result.managedRuntime?.coreVersion, "1.6.12");
        assert.match(formatDoctorText(result, { verbose: false }), /Doctor runtime: CLI 0\.4\.15 · MCP 4\.11\.17 · Core 1\.6\.12/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor guidance neutrally identifies a bundle and active runtime mismatch", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-stale-launcher-"));
    try {
        const launcherPath = launcherFixtureWithRuntime(tempDir, { mcp: "4.11.17", core: "1.6.12" });
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17", "node_modules", "@zokizuan", "satori-mcp", "dist", "index.js")],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            resolvePackageVersions: () => [
                { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
                { name: "@zokizuan/satori-mcp", version: "5.0.0", source: "test" },
                { name: "@zokizuan/satori-core", version: "2.0.0", source: "test" },
            ],
        }));
        assert.equal(
            result.nextSteps.includes(
                "The CLI release target differs from the active managed runtime.\nThe active launcher has not been changed.",
            ),
            true,
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor resolves active Core from the managed runtime closure", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-active-core-"));
    try {
        const launcherPath = launcherFixtureWithRuntime(tempDir, { mcp: "4.11.17", core: "1.6.12" });
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17", "node_modules", "@zokizuan", "satori-mcp", "dist", "index.js")],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const state = resolveRuntimeVersionState(tempDir, [
            { name: "@zokizuan/satori-cli", version: "0.4.15", source: "test" },
            { name: "@zokizuan/satori-mcp", version: "4.11.17", source: "test" },
            { name: "@zokizuan/satori-core", version: "1.6.12", source: "test" },
        ]);
        assert.equal(state.activeLauncherPath, launcherPath);
        assert.equal(state.activeManagedMcpVersion, "4.11.17");
        assert.equal(state.activeManagedCoreVersion, "1.6.12");
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("doctor keeps the independent-version policy note with an active runtime present", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-policy-"));
    try {
        const launcherPath = launcherFixtureWithRuntime(tempDir, { mcp: "4.11.17", core: "1.6.12" });
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17", "node_modules", "@zokizuan", "satori-mcp", "dist", "index.js")],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
        }));
        const policy = result.checks.find((check) => check.name === "package_version_policy");
        assert.equal(policy?.status, "ok");
        assert.match(policy?.message || "", /independent package versions/i);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor compares live runtime owners against the active launcher version", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-owner-active-authority-"));
    const ownersPath = path.join(tempDir, "owners.json");
    try {
        const launcherPath = launcherFixtureWithRuntime(tempDir, { mcp: "6.7.0", core: "3.6.0" });
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@6.7.0", "node_modules", "@zokizuan", "satori-mcp", "dist", "index.js")],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        fs.writeFileSync(ownersPath, JSON.stringify({
            formatVersion: "v1",
            owners: [runtimeOwner({ satoriVersion: "6.7.0" })],
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            runtimeOwnersPath: ownersPath,
            inspectProcess: (pid) => ({ pid, processStartTime: "start-111" }),
            resolvePackageVersions: () => [
                { name: "@zokizuan/satori-cli", version: "1.9.2", source: "test" },
                { name: "@zokizuan/satori-mcp", version: "6.8.1", source: "test" },
                { name: "@zokizuan/satori-core", version: "3.6.0", source: "test" },
            ],
        }));
        const check = result.checks.find((entry) => entry.name === "runtime_owners");
        assert.equal(check?.status, "ok");
        assert.match(check?.message || "", /6\.7\.0/);
        assert.doesNotMatch(check?.message || "", /stale resident runtime/);
        assert.equal(
            result.checks.find((entry) => entry.name === "active_runtime_mcp")?.message,
            "Active managed MCP runtime: @zokizuan/satori-mcp@6.7.0",
        );
        assert.equal(
            result.checks.find((entry) => entry.name === "active_runtime_core")?.message,
            "Active managed Core runtime: @zokizuan/satori-core@3.6.0",
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor reports a missing managed launcher as a warning", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-absent-"));
    try {
        const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [managedLauncherClientProof()],
        }));
        assert.equal(result.managedRuntime?.status, "missing");
        assert.equal(result.managedRuntime?.launcherPath, null);
        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "warning");
        assert.match(check?.message || "", /missing/);
        assertManagedRuntimeSelectionUnavailable(result);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor reports a malformed managed launcher as an error", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-launcher-malformed-"));
    try {
        const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(launcherPath, "not a managed launcher\n");
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [managedLauncherClientProof()],
        }));
        assert.equal(result.managedRuntime?.status, "malformed");
        assert.equal(result.managedRuntime?.mcpVersion, null);
        const check = result.checks.find((entry) => entry.name === "managed_launcher");
        assert.equal(check?.status, "error");
        assert.match(check?.message || "", /malformed/);
        assertManagedRuntimeSelectionUnavailable(result);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor errors when the active managed MCP cannot resolve Core", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-unresolved-core-"));
    try {
        const launcherPath = launcherFixtureWithRuntime(tempDir, { mcp: "4.11.17", core: "3.6.0" });
        fs.rmSync(
            path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17", "node_modules", "@zokizuan", "satori-core"),
            { recursive: true, force: true },
        );
        fs.writeFileSync(launcherPath, buildLauncherScript({
            command: process.execPath,
            args: [path.join(tempDir, ".satori", "mcp-runtime", "@zokizuan-satori-mcp@4.11.17", "node_modules", "@zokizuan", "satori-mcp", "dist", "index.js")],
            managedEnv: { SATORI_RUNTIME_PROFILE: "offline" },
        }));
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            loadManagedLanceDb: async () => undefined,
        }));
        assert.equal(result.managedRuntime?.status, "active");
        assert.equal(result.managedRuntime?.coreVersion, null);
        const check = result.checks.find((entry) => entry.name === "active_managed_core_version");
        assert.equal(check?.status, "error");
        assert.match(
            check?.message || "",
            /Active managed MCP 4\.11\.17 could not resolve @zokizuan\/satori-core inside its managed generation\./,
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor reports one not-installed problem and one install step when nothing is installed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-not-installed-"));
    try {
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: path.join(tempDir, ".satori", "bin", "satori-mcp.js"),
            inspectManagedClients: () => [],
        }));
        const problems = result.checks.filter((check) => check.status === "error");
        assert.equal(result.status, "error");
        assert.equal(problems.length, 1);
        assert.match(problems[0]?.message ?? "", /^Satori is not installed for any supported client/);
        assert.deepEqual(result.nextSteps, ["Run npx -y @zokizuan/satori-cli@latest install."]);
        // The CLI's own environment is not a Satori runtime, so no runtime-environment verdicts.
        assert.equal(result.checks.some((check) => check.name === "embedding_provider_env"), false);
        assert.equal(result.checks.some((check) => /Voyage/i.test(check.message)), false);
        assert.equal(result.checks.some((check) => check.name === "managed_launcher"), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test("runDoctor keeps a broken launcher's repair step without a duplicate install step", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "satori-doctor-not-installed-broken-"));
    try {
        const launcherPath = path.join(tempDir, ".satori", "bin", "satori-mcp.js");
        fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
        fs.writeFileSync(launcherPath, "not a managed launcher\n");
        const result = await runDoctor(baseDoctorOptions({
            env: { HOME: tempDir },
            managedLauncherPath: launcherPath,
            inspectManagedClients: () => [],
        }));
        assert.equal(result.status, "error");
        assert.equal(result.checks.find((check) => check.name === "managed_launcher")?.status, "error");
        assert.equal(result.checks.some((check) => check.name === "embedding_provider_env"), false);
        assert.equal(result.nextSteps.length, 1);
        assert.match(result.nextSteps[0] ?? "", /replace the managed launcher/);
        assert.equal(result.nextSteps.some((step) => step === "Run npx -y @zokizuan/satori-cli@latest install."), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
