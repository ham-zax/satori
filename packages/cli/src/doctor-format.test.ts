import assert from "node:assert/strict";
import test from "node:test";
import { formatDoctorText } from "./doctor-format.js";
import type { DoctorResult } from "./doctor.js";
import { LATEON_PROFILE_ID } from "./local-runtime-contract.js";

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
                rerankerProfile: LATEON_PROFILE_ID,
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
    assert.match(text, /Codex\s+\| Configured\s+\| offline\s+\| Potion \/ potion-code\s+\| 256\s+\| LateOn · Code-edge D24\s+\| LanceDB\s+\| Managed launcher/);
    assert.match(text, /Claude Code\s+\| Not configured\s+\| —/);
    assert.match(text, /OpenCode\s+\| Needs repair\s+\| connected\s+\| VoyageAI \/ voyage-code-3\s+\| 1024\s+\| none\s+\| Milvus\s+\| Client config/);
    assert.doesNotMatch(text, /Online: search queries and code excerpts are sent to Voyage\./);
    assert.doesNotMatch(text, /Selected runtime:|Configured runtimes:/);
});

test("Doctor table reports the Voyage reranker model and online disclosure", () => {
    const result: DoctorResult = {
        ...resultWithActiveRuntime(),
        runtimeConfigurations: [{
            client: "codex",
            status: "configured",
            source: "managed_launcher",
            profile: "connected",
            embeddingProvider: "VoyageAI",
            embeddingModel: "voyage-code-3",
            embeddingDimension: "1024",
            rerankerProvider: "voyage",
            rerankerModel: "rerank-3-lite",
            rerankerProfile: null,
            vectorStore: "Milvus",
        }],
    };

    const text = formatDoctorText(result, { verbose: false });
    assert.match(text, /Codex\s+\| Configured\s+\| connected\s+\| VoyageAI \/ voyage-code-3\s+\| 1024\s+\| Voyage \/ rerank-3-lite\s+\| Milvus\s+\| Managed launcher/);
    assert.match(text, /Online: search queries and code excerpts are sent to Voyage\./);
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

test("Doctor renders Cursor, VS Code, Windsurf, and Pi in runtime table and expands their stale config checks", () => {
    const result: DoctorResult = {
        ...resultWithActiveRuntime(),
        status: "error",
        checks: [{
            name: "managed_client_configuration",
            status: "error",
            message: "cursor config does not point exactly to launcher. vscode config does not point exactly to launcher. windsurf config does not point exactly to launcher. pi config does not point exactly to launcher.",
        }],
        nextSteps: [
            "Run npx -y @satori-code/cli@latest install --client cursor, then restart Cursor.",
            "Run npx -y @satori-code/cli@latest install --client vscode, then restart VS Code.",
            "Run npx -y @satori-code/cli@latest install --client windsurf, then restart Windsurf.",
            "Run npx -y @satori-code/cli@latest install --client pi, then restart Pi.",
            "Restart your MCP client after changing Satori environment variables.",
        ],
        runtimeConfigurations: [
            {
                client: "cursor",
                status: "needs_repair",
                source: "client_configuration",
                profile: "offline",
                embeddingProvider: "Potion",
                embeddingModel: "potion-code",
                embeddingDimension: "256",
                rerankerProvider: "none",
                rerankerProfile: null,
                vectorStore: "LanceDB",
            },
            {
                client: "vscode",
                status: "configured",
                source: "managed_launcher",
                profile: "offline",
                embeddingProvider: "Potion",
                embeddingModel: "potion-code",
                embeddingDimension: "256",
                rerankerProvider: "lateon",
                rerankerProfile: LATEON_PROFILE_ID,
                vectorStore: "LanceDB",
            },
            {
                client: "windsurf",
                status: "not_configured",
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
                client: "pi",
                status: "needs_repair",
                source: "client_configuration",
                profile: "offline",
                embeddingProvider: "Potion",
                embeddingModel: "potion-code",
                embeddingDimension: "256",
                rerankerProvider: "none",
                rerankerProfile: null,
                vectorStore: "LanceDB",
            },
        ],
    };

    const text = formatDoctorText(result, { verbose: false });
    assert.match(text, /4 problems/);
    assert.match(text, /Cursor\s+\| Needs repair/);
    assert.match(text, /VS Code\s+\| Configured/);
    assert.match(text, /Windsurf\s+\| Not configured/);
    assert.match(text, /Pi\s+\| Needs repair/);
    assert.match(text, /Cursor configuration/);
    assert.match(text, /VS Code configuration/);
    assert.match(text, /Windsurf configuration/);
    assert.match(text, /Pi configuration/);
    assert.match(text, /Cursor is not using the managed Satori launcher\./);
    assert.match(text, /VS Code is not using the managed Satori launcher\./);
    assert.match(text, /Windsurf is not using the managed Satori launcher\./);
    assert.match(text, /Pi is not using the managed Satori launcher\./);
    assert.doesNotMatch(text, /Restart your MCP client after changing Satori environment variables\./);
});
