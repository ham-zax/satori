import type { DoctorCheck, DoctorResult } from "./doctor.js";
import type { CliWriters } from "./format.js";

export interface DoctorTextOptions {
    verbose: boolean;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

function packageLabel(packageName: string): string {
    if (packageName.endsWith("-cli")) return "CLI";
    if (packageName.endsWith("-mcp")) return "MCP";
    if (packageName.endsWith("-core")) return "Core";
    return packageName;
}

function checkValue(result: DoctorResult, name: string): string | null {
    const message = result.checks.find((check) => check.name === name)?.message;
    if (!message) return null;
    const separator = message.indexOf(":");
    return (separator === -1 ? message : message.slice(separator + 1)).trim().replace(/\.$/, "");
}

function selectedRuntimeLines(result: DoctorResult): string[] {
    const clientRuntimes = result.checks
        .filter((check) => check.name.startsWith("client_runtime_"))
        .map((check) => check.message);
    if (clientRuntimes.length > 0) {
        return ["Configured runtimes:", ...clientRuntimes.map((message) => `  ${message}`)];
    }
    const profile = checkValue(result, "runtime_profile");
    const provider = checkValue(result, "embedding_provider");
    const model = checkValue(result, "embedding_model");
    const vectorStore = checkValue(result, "vector_store_provider");
    const values = [
        profile,
        provider && model ? `${provider} / ${model}` : provider || model,
        vectorStore,
    ].filter((value): value is string => Boolean(value));
    return values.length > 0 ? [`Selected runtime: ${values.join(" · ")}`] : [];
}

function clientName(checkName: string): string | null {
    const prefix = "managed_client_configuration_";
    if (!checkName.startsWith(prefix)) return null;
    const client = checkName.slice(prefix.length);
    if (client === "codex") return "Codex";
    if (client === "opencode") return "OpenCode";
    if (client === "claude") return "Claude Code";
    return client;
}

function expandedHumanChecks(checks: DoctorCheck[]): DoctorCheck[] {
    return checks.flatMap((check) => {
        if (check.name !== "managed_client_configuration" || check.status !== "error") {
            return [check];
        }
        const clients = [...check.message.matchAll(/\b(codex|opencode|claude) config\b/gi)]
            .map((match) => match[1].toLowerCase())
            .filter((client, index, values) => values.indexOf(client) === index);
        if (clients.length === 0) return [check];
        return clients.map((client) => ({
            name: `managed_client_configuration_${client}`,
            status: check.status,
            message: check.message,
        }));
    });
}

function checkTitle(check: DoctorCheck): string {
    const client = clientName(check.name);
    if (client) return `${client} configuration`;
    const titles: Record<string, string> = {
        embedding_provider_env: "Embedding credentials",
        lancedb_native_load: "LanceDB runtime",
        lancedb_path: "LanceDB storage",
        managed_client_configuration: "MCP client configuration",
        managed_launcher: "Managed runtime",
        milvus_address: "Milvus address",
        mutation_leases: "Indexing operation",
        node_version: "Node.js version",
        npm_package_access: "npm package access",
        runtime_owners: "Runtime ownership",
        runtime_profile: "Runtime profile",
        vector_store_provider: "Vector storage",
    };
    if (titles[check.name]) return titles[check.name];
    if (check.name.startsWith("package_version_")) return "Package identity";
    return check.name.replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase());
}

function redactSensitiveDetails(message: string): string {
    return message
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<hidden>")
        .replace(/\b(pid|generation|operation)=\S+/gi, "$1=<hidden>")
        .replace(/(^|[\s("'=])\/[^\s,;)]*/g, "$1<hidden>")
        .replace(/\b[A-Za-z]:\\[^\s,;)]*/g, "<hidden>");
}

function issueMessage(check: DoctorCheck, verbose: boolean): string {
    if (verbose) return check.message;
    const client = clientName(check.name);
    if (client) return `${client} is not using the managed Satori launcher.`;
    if (check.name === "mutation_leases" && /abandoned/i.test(check.message)) {
        return "An abandoned indexing operation was found.";
    }
    if (check.name === "lancedb_native_load") {
        return "The managed runtime could not load LanceDB.";
    }
    if (check.name === "npm_package_access") {
        return "The configured Satori MCP package could not be verified on npm.";
    }
    if (check.name === "runtime_owners") {
        return "The active Satori runtime ownership state needs attention.";
    }
    if (check.name.startsWith("package_version_")) {
        return "A Satori package version could not be resolved.";
    }
    return redactSensitiveDetails(check.message);
}

function renderIssues(lines: string[], heading: string, checks: DoctorCheck[], verbose: boolean): void {
    if (checks.length === 0) return;
    lines.push("", heading, "");
    checks.forEach((check, index) => {
        lines.push(`${index + 1}. ${checkTitle(check)}`);
        lines.push(`   ${issueMessage(check, verbose)}`);
        if (verbose) lines.push(`   Check: ${check.name}`);
        lines.push("");
    });
    if (lines[lines.length - 1] === "") lines.pop();
}

function visibleNextSteps(result: DoctorResult, checks: DoctorCheck[], verbose: boolean): string[] {
    const staleClients = checks
        .filter((check) => check.status === "error")
        .map((check) => ({ id: check.name.replace("managed_client_configuration_", ""), name: clientName(check.name) }))
        .filter((client): client is { id: string; name: string } => Boolean(client.name));
    const specificRestartExists = staleClients.length > 0
        || result.nextSteps.some((step) => /restart (Codex|OpenCode|Claude Code)/i.test(step));
    const steps = result.nextSteps.filter((step) => !(
        (specificRestartExists && step === "Restart your MCP client after changing Satori environment variables.")
        || (staleClients.length > 0 && step === "Rerun satori install for each stale configured MCP client, then restart it.")
    ));
    const rendered = steps.map((step) => {
        if (verbose) return step;
        if (step.startsWith("Retry the intended manage_index action;")) {
            return "Inspect the abandoned operation with `satori doctor --verbose` before retrying indexing.";
        }
        return redactSensitiveDetails(step);
    });
    for (const client of staleClients) {
        if (rendered.some((step) => step.includes(`--client ${client.id}`))) {
            continue;
        }
        rendered.push(`Run satori install --client ${client.id}, then restart ${client.name}.`);
    }
    return [...new Set(rendered)];
}

export function formatDoctorText(result: DoctorResult, options: DoctorTextOptions): string {
    const humanChecks = expandedHumanChecks(result.checks);
    const errors = humanChecks.filter((check) => check.status === "error");
    const warnings = humanChecks.filter((check) => check.status === "warning");
    const passed = result.checks.filter((check) => (
        check.status === "ok" && !check.name.startsWith("client_runtime_")
    ));
    const lines = [
        "Satori Doctor",
        "",
        `${countLabel(errors.length, "problem")} · ${countLabel(warnings.length, "warning")} · ${countLabel(passed.length, "check")} passed`,
    ];

    if (result.packageVersions.length > 0) {
        lines.push(
            "",
            `Doctor bundle: ${result.packageVersions.map((pkg) => `${packageLabel(pkg.name)} ${pkg.version ?? "unknown"}`).join(" · ")}`,
        );
    }
    lines.push(...selectedRuntimeLines(result));

    renderIssues(lines, "Problems", errors, options.verbose);
    renderIssues(lines, "Warnings", warnings, options.verbose);

    const nextSteps = visibleNextSteps(result, humanChecks, options.verbose);
    if (nextSteps.length > 0) {
        lines.push("", "Next steps", "");
        nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    }

    if (options.verbose) {
        lines.push("", "Checks", "");
        for (const check of result.checks) {
            const marker = check.status === "ok" ? "✓" : check.status === "warning" ? "!" : "✗";
            lines.push(`${marker} ${check.name}: ${check.message}`);
        }
        lines.push("", "Package sources", "");
        for (const pkg of result.packageVersions) {
            lines.push(`- ${pkg.name}@${pkg.version ?? "unknown"}: ${pkg.source}`);
        }
        lines.push("", "Local diagnostics", "", JSON.stringify(result.localDiagnostics, null, 2));
    } else {
        lines.push("", "Run `satori doctor --verbose` for paths and complete diagnostics.");
    }
    lines.push("No automatic repair was performed.");

    return `${lines.join("\n")}\n`;
}

export function emitDoctorText(writers: CliWriters, result: DoctorResult, options: DoctorTextOptions): void {
    writers.writeStdout(formatDoctorText(result, options));
}
