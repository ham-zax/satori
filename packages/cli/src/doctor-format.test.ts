import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorText } from "./doctor-format.js";
import type { DoctorResult } from "./doctor.js";

function resultWithActiveRuntime(): DoctorResult {
    return {
        status: "ok",
        packageVersions: [
            { name: "@satori-code/cli", version: "1.9.2", source: "/cli/package.json" },
            { name: "@satori-code/mcp", version: "6.8.1", source: "/cli/node_modules/mcp/package.json" },
            { name: "@satori-code/core", version: "3.6.0", source: "/cli/node_modules/core/package.json" },
        ],
        packageVersionNote: "independent package versions",
        checks: [],
        nextSteps: [],
        managedRuntime: {
            status: "active" as const,
            launcherPath: "/home/test/.satori/bin/satori-mcp.js",
            mcpVersion: "6.7.0",
            coreVersion: "3.5.0",
        },
        localDiagnostics: {
            schemaVersion: "v1",
            storage: "local_only",
            privacy: "No source, query text, path, symbol name, or repository identifier is stored.",
            eventsRead: 0,
            malformedEventsSkipped: 0,
            totalDurationMs: 0,
            toolCalls: [],
            warningCodes: [],
            fallbackUses: 0,
            lifecycleOutcomes: [],
        },
    };
}

test("Doctor uses active runtime authority and labels bundled package sources", () => {
    const text = formatDoctorText(resultWithActiveRuntime(), { verbose: true });
    assert.match(text, /Doctor runtime: CLI 1\.9\.2 · MCP 6\.7\.0 · Core 3\.5\.0/);
    assert.match(text, /@satori-code\/cli@1\.9\.2 \(CLI package source\)/);
    assert.match(text, /@satori-code\/mcp@6\.8\.1 \(CLI release metadata\)/);
    assert.match(text, /@satori-code\/core@3\.6\.0 \(CLI release metadata\)/);
    assert.doesNotMatch(text, /@satori-code\/cli@1\.9\.2 \(CLI release metadata\)/);
});

test("Doctor falls back to the bundle when the launcher is not active", () => {
    const result = { ...resultWithActiveRuntime(), managedRuntime: { status: "malformed" as const, launcherPath: "/home/test/.satori/bin/satori-mcp.js", mcpVersion: null, coreVersion: null } };
    const text = formatDoctorText(result, { verbose: false });
    assert.match(text, /Doctor bundle: CLI 1\.9\.2 · MCP 6\.8\.1 · Core 3\.6\.0/);
    assert.doesNotMatch(text, /Doctor runtime:/);
});

test("Doctor renders effective configuration for every supported client as a table", () => {
    const result: DoctorResult = {
        ...resultWithActiveRuntime(),
        runtimeConfigurations: [
            {
                client: "codex" as const,
                status: "configured" as const,
                source: "managed_launcher" as const,
                profile: "offline",
                embeddingProvider: "Potion",
                embeddingModel: "potion-code",
                embeddingDimension: "256",
                rerankerProvider: "lateon",
                rerankerProfile: "lateon_offline_quality_projection_v6_d128_v1",
                vectorStore: "LanceDB",
            },
            {
                client: "claude" as const,
                status: "not_configured" as const,
                source: null,
                profile: null,
                embeddingProvider: null,
                embeddingModel: null,
                embeddingDimension: null,
                rerankerProvider: null,
                rerankerProfile: null,
                vectorStore: null,
            },
            {
                client: "opencode" as const,
                status: "needs_repair" as const,
                source: "client_configuration" as const,
                profile: "connected",
                embeddingProvider: "VoyageAI",
                embeddingModel: "voyage-code-3",
                embeddingDimension: "1024",
                rerankerProvider: "none",
                rerankerProfile: null,
                vectorStore: "Milvus",
            },
            {
                client: "agy" as const,
                status: "not_configured" as const,
                source: null,
                profile: null,
                embeddingProvider: null,
                embeddingModel: null,
                embeddingDimension: null,
                rerankerProvider: null,
                rerankerProfile: null,
                vectorStore: null,
            },
        ],
    };

    const text = formatDoctorText(result, { verbose: false });
    assert.match(text, /Applied runtime configuration:/);
    assert.match(text, /Antigravity\s+\| Not configured\s+\| —/);
    assert.match(text, /Client\s+\| Status\s+\| Profile\s+\| Embedding\s+\| Dim\s+\| Reranker\s+\| Storage\s+\| Source/);
    assert.match(text, /Codex\s+\| Configured\s+\| offline\s+\| Potion \/ potion-code\s+\| 256\s+\| LateOn · Code-edge D128\s+\| LanceDB\s+\| Managed launcher/);
    assert.match(text, /Claude Code\s+\| Not configured\s+\| —/);
    assert.match(text, /OpenCode\s+\| Needs repair\s+\| connected\s+\| VoyageAI \/ voyage-code-3\s+\| 1024\s+\| none\s+\| Milvus\s+\| Client config/);
    assert.doesNotMatch(text, /Selected runtime:|Configured runtimes:/);
});

test("Doctor table shortens model identity and verbose output keeps the full identity", () => {
    const model = "minishlab/potion-code-16M@0123456789abcdef";
    const result: DoctorResult = {
        ...resultWithActiveRuntime(),
        runtimeConfigurations: [{
            client: "codex" as const,
            status: "configured" as const,
            source: "managed_launcher" as const,
            profile: "offline",
            embeddingProvider: "Potion",
            embeddingModel: model,
            embeddingDimension: "256",
            rerankerProvider: "none",
            rerankerProfile: null,
            vectorStore: "LanceDB",
        }],
    };

    const compact = formatDoctorText(result, { verbose: false });
    assert.match(compact, /Potion \/ potion-code-16M\s+\|/);
    assert.doesNotMatch(compact, /minishlab|0123456789abcdef/);

    const verbose = formatDoctorText(result, { verbose: true });
    assert.match(verbose, /Potion \/ minishlab\/potion-code-16M@0123456789abcdef/);
});
