import type { CliWriters } from "./format.js";
import type { InstallCommandResult } from "./install.js";
import type { InstallPostflightCheck, InstallPostflightResult } from "./install-postflight.js";

const CLIENT_LABELS = {
    codex: "Codex",
    claude: "Claude Code",
    opencode: "OpenCode",
} as const;

const CHECK_LABELS: Record<InstallPostflightCheck["name"], string> = {
    launcher: "Managed launcher",
    client_configuration: "Client configuration",
    provider_configuration: "Runtime configuration",
    mcp_initialize: "MCP startup",
    tool_list: "Tool registration",
    runtime_owner: "Runtime ownership",
    termination: "Clean shutdown",
};

function titleCase(value: string): string {
    return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function packageVersion(specifier: string | undefined): string | null {
    if (!specifier) return null;
    const separator = specifier.lastIndexOf("@");
    return separator > 0 ? specifier.slice(separator + 1) || null : null;
}

function runtimeSummary(result: InstallCommandResult): string | null {
    if (result.action !== "install") return null;
    const environment = result.runtimeEnvironment ?? {};
    const profile = environment.SATORI_RUNTIME_PROFILE ?? result.runtime;
    const provider = environment.EMBEDDING_PROVIDER;
    const vectorStore = environment.VECTOR_STORE_PROVIDER;
    const values = [profile ? titleCase(profile) : null, provider, vectorStore]
        .filter((value): value is string => Boolean(value));
    return values.length > 0 ? values.join(" · ") : null;
}

function clientLabels(result: InstallCommandResult): string[] {
    return result.results.map((entry) => CLIENT_LABELS[entry.client]);
}

function restartInstruction(result: InstallCommandResult): string | null {
    if (result.action !== "install" || result.dryRun) return null;
    const clients = clientLabels(result);
    if (clients.length === 0) return null;
    if (clients.length === 1) return `Restart ${clients[0]} to load Satori.`;
    return `Restart ${clients.slice(0, -1).join(", ")}, and ${clients.at(-1)} to load Satori.`;
}

function verificationLines(postflight: InstallPostflightResult): string[] {
    const problems = postflight.checks.filter((check) => check.status !== "ok");
    if (postflight.status === "ok") {
        const checkCount = postflight.checks.length;
        return [`Verification: passed (${checkCount} ${checkCount === 1 ? "check" : "checks"})`];
    }
    const status = postflight.status === "warning" ? "passed with warnings" : "failed";
    return [
        `Verification: ${status}`,
        ...problems.map((check) => `  ${check.status === "warning" ? "!" : "✗"} ${CHECK_LABELS[check.name]}`),
    ];
}

export function formatInstallText(
    result: InstallCommandResult,
    postflight?: InstallPostflightResult,
): string {
    const heading = result.dryRun
        ? `Satori ${result.action} preview`
        : result.action === "install"
            ? "Satori installed"
            : "Satori uninstalled";
    const lines = [heading];
    const runtime = runtimeSummary(result);
    if (runtime) lines.push("", `Runtime: ${runtime}`);
    const version = packageVersion(result.packageSpecifier);
    if (version) lines.push(`MCP package: ${version}`);
    const clients = clientLabels(result);
    if (clients.length > 0) lines.push(`${clients.length === 1 ? "Client" : "Clients"}: ${clients.join(", ")}`);

    if (postflight) {
        lines.push("", ...verificationLines(postflight));
    }

    if (result.action === "uninstall" && !result.dryRun) {
        lines.push("", "Existing indexes and the managed runtime were kept.");
    }
    const restart = restartInstruction(result);
    if (restart) lines.push("", restart);
    if (postflight?.status !== undefined && postflight.status !== "ok") {
        lines.push("Run `satori doctor --verbose` for diagnostic details.");
    }
    return `${lines.join("\n")}\n`;
}

export function emitInstallText(
    writers: CliWriters,
    result: InstallCommandResult,
    postflight?: InstallPostflightResult,
): void {
    writers.writeStdout(formatInstallText(result, postflight));
}
