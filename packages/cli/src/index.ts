#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseCliArgs, parseWrapperArgumentsFromSchema, resolveRawArguments } from "./args.js";
import type { ParsedCommand } from "./args.js";
import { connectCliMcpSession, type CallToolResult, type ListToolsResult } from "./client.js";
import { asCliError, CliError } from "./errors.js";
import { emitError, emitJson, inferManageStatusState, parseStructuredEnvelope, type CliWriters } from "./format.js";
import {
    assertAutoClientTargets,
    executeInstallCommand,
    executeManagedRuntimeUpgrade,
    type ManagedRuntimeCommand,
    type ManagedRuntimeUpgradePhase,
    type ManagedRuntimeUpgradeResult,
} from "./install.js";
import type {
    LateOnAuthorityLoader,
    LateOnModelProgressEvent,
    LateOnModelProgressReporter,
} from "./lateon-model-store.js";
import type {
    InstallPreflightDependencies,
    InstallPreflightInput,
    InstallPreflightResult,
} from "./install-preflight.js";
import {
    runInstallPostflight,
    type InstallPostflightOptions,
    type InstallPostflightResult,
} from "./install-postflight.js";
import { verifyManagedPackageInstallability } from "./package-installability.js";
import { resolveInstalledPackageVersions, resolveRuntimeVersionState, runDoctor } from "./doctor.js";
import type { DoctorPackageVersion, DoctorResult, RuntimeVersionState } from "./doctor.js";
import { emitDoctorText } from "./doctor-format.js";
import { emitInstallText } from "./install-format.js";
import { SATORI_CLI_NPX_COMMAND, satoriCliCommand } from "./cli-command.js";
import { buildLocalDiagnosticEvent, recordLocalDiagnosticEvent } from "./local-diagnostics.js";
import {
    CliUpgradeDelegationStartError,
    combineUpgradeResult,
    formatUpgradeText,
    installGlobalCliAndDelegate,
    type GlobalCliUpgradeInput,
} from "./upgrade.js";
import {
    compareStableVersions,
    parseStableVersion,
    resolveSatoriUpgradeTarget,
    type SatoriUpgradeTarget,
} from "./upgrade-target.js";
import {
    formatTerminateText,
    terminateSatoriServers,
    type TerminateOptions,
    type TerminateResult,
} from "./terminate.js";

interface RunCliOptions {
    writeStdout?: (text: string) => void;
    writeStderr?: (text: string) => void;
    stdin?: NodeJS.ReadStream;
    env?: NodeJS.ProcessEnv;
    serverCommand?: string;
    serverArgs?: string[];
    serverEnv?: Record<string, string>;
    startupTimeoutMs?: number;
    callTimeoutMs?: number;
    cwd?: string;
    installabilityVerifier?: () => string | Promise<string>;
    installRuntimeCommand?: ManagedRuntimeCommand;
    installPreflightDependencies?: InstallPreflightDependencies;
    installPreflightRunner?: (
        input: InstallPreflightInput,
        dependencies?: InstallPreflightDependencies,
    ) => Promise<InstallPreflightResult>;
    /** Structural test seam for LateOn acquisition; the production default binds the frozen digest. */
    installLateOnAuthorityLoader?: LateOnAuthorityLoader;
    doctorRunner?: (options: { env: NodeJS.ProcessEnv }) => DoctorResult | Promise<DoctorResult>;
    versionResolver?: () => DoctorPackageVersion[];
    runtimeStateResolver?: (
        homeDir: string,
        packageVersions: readonly DoctorPackageVersion[],
    ) => RuntimeVersionState;
    nowMs?: () => number;
    /** Test/embed override; null disables best-effort local recording. */
    diagnosticsPath?: string | null;
    installPostflightRunner?: (options: InstallPostflightOptions) => Promise<InstallPostflightResult>;
    upgradeTargetResolver?: () => SatoriUpgradeTarget | Promise<SatoriUpgradeTarget>;
    managedRuntimeUpgradeRunner?: (
        target: SatoriUpgradeTarget,
        options: {
            homeDir: string;
            env: NodeJS.ProcessEnv;
            preflightDependencies?: InstallPreflightDependencies;
            preflightRunner?: RunCliOptions["installPreflightRunner"];
            onUpgradeProgress?: (phase: ManagedRuntimeUpgradePhase) => void;
            lateOnProgress?: LateOnModelProgressReporter;
            lateOnRetryCommand?: string;
        },
    ) => Promise<ManagedRuntimeUpgradeResult>;
    globalCliUpgradeRunner?: (input: GlobalCliUpgradeInput) => number | Promise<number>;
    invokedScriptPath?: string;
    terminateRunner?: (options: TerminateOptions) => Promise<TerminateResult>;
    connectSession?: (options: {
        command: string;
        args: string[];
        env: Record<string, string | undefined>;
        cwd?: string;
        startupTimeoutMs: number;
        callTimeoutMs: number;
        writeStderr: (text: string) => void;
    }) => Promise<CliSession>;
}

interface ToolDescriptor {
    name: string;
    inputSchema?: unknown;
    input_schema?: unknown;
}

interface CliSession {
    listTools(): Promise<ListToolsResult>;
    callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
    close(): Promise<void>;
    readonly launcherPid?: number | null;
    readonly serverVersion?: { name?: string; version?: string };
}

interface TextContentEntry {
    type: "text";
    text: string;
}

const DEFAULT_MANAGE_INDEX_POLL_INTERVAL_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function firstText(result: unknown): string | null {
    const content = isRecord(result) ? result.content : undefined;
    if (!Array.isArray(content)) {
        return null;
    }
    const entry = content.find((item): item is TextContentEntry => (
        isRecord(item) && item.type === "text" && typeof item.text === "string"
    ));
    return entry?.text ?? null;
}

function parseToolPayload(result: unknown): Record<string, unknown> | null {
    const text = firstText(result);
    if (!text) {
        return null;
    }
    try {
        const payload: unknown = JSON.parse(text);
        return isRecord(payload) ? payload : null;
    } catch {
        return null;
    }
}

function operationPhase(result: unknown): string | null {
    const operation = parseToolPayload(result)?.operation;
    return isRecord(operation) && typeof operation.phase === "string"
        ? operation.phase
        : null;
}

function shouldAwaitManagedIndex(toolName: string, args: Record<string, unknown>): boolean {
    return toolName === "manage_index"
        && (args.action === "create" || args.action === "reindex")
        && typeof args.path === "string";
}

function isManageIndexTerminal(result: unknown): boolean {
    const phase = operationPhase(result);
    const state = inferManageStatusState(result);
    if (phase === "failed" || phase === "blocked" || phase === "cancelled") {
        return true;
    }
    if (phase === "completed") {
        return state === "indexed";
    }
    return state === "indexed"
        || state === "indexfailed"
        || state === "requires_reindex"
        || state === "not_indexed";
}

async function waitForManageIndex(
    session: CliSession,
    pathValue: string,
    pollIntervalMs: number,
): Promise<CallToolResult> {
    while (true) {
        const status = await session.callTool("manage_index", { action: "status", path: pathValue });
        if (isManageIndexTerminal(status)) {
            return status;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}

function readPackageVersion(): string {
    try {
        const currentFile = fileURLToPath(import.meta.url);
        const packagePath = path.resolve(path.dirname(currentFile), "..", "package.json");
        const content = fs.readFileSync(packagePath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed.version === "string") {
            return parsed.version;
        }
    } catch {
        // Best-effort only.
    }
    return "unknown";
}

function installedPackageVersion(
    packages: DoctorPackageVersion[],
    packageName: string,
): string | null {
    return packages.find((entry) => entry.name === packageName)?.version ?? null;
}

function buildVersionPayload(packages: DoctorPackageVersion[], state: RuntimeVersionState) {
    const cliVersion = state.cliVersion || readPackageVersion();
    const releaseMcpVersion = installedPackageVersion(packages, "@zokizuan/satori-mcp")
        ?? state.releaseMcpVersion;
    const releaseCoreVersion = installedPackageVersion(packages, "@zokizuan/satori-core")
        ?? state.releaseCoreVersion;
    const hasActiveMcp = state.activeManagedMcpVersion !== null;
    return {
        name: "@zokizuan/satori-cli",
        cli: "satori",
        version: cliVersion,
        cliVersion,
        mcpVersion: hasActiveMcp ? state.activeManagedMcpVersion : releaseMcpVersion,
        coreVersion: hasActiveMcp ? state.activeManagedCoreVersion : releaseCoreVersion,
        releaseMcpVersion,
        releaseCoreVersion,
        activeManagedMcpVersion: state.activeManagedMcpVersion,
        activeManagedCoreVersion: state.activeManagedCoreVersion,
        activeLauncherPath: state.activeLauncherPath,
        managedLauncherStatus: state.managedLauncherStatus,
    };
}

function formatVersionText(result: ReturnType<typeof buildVersionPayload>): string {
    const lines = [
        "Satori",
        "",
        `CLI: ${result.cliVersion}`,
    ];
    const hasActiveRuntime = result.activeManagedMcpVersion !== null;
    const activeMatchesReleaseTarget = hasActiveRuntime
        && result.activeManagedMcpVersion === result.releaseMcpVersion
        && result.activeManagedCoreVersion !== null
        && result.activeManagedCoreVersion === result.releaseCoreVersion;
    if (activeMatchesReleaseTarget) {
        lines.push(
            `Active managed runtime: MCP ${result.activeManagedMcpVersion}${result.activeManagedCoreVersion ? ` · Core ${result.activeManagedCoreVersion}` : ""}`,
            `Managed launcher: ${result.activeLauncherPath ?? "unknown"}`,
        );
    } else {
        if (result.releaseMcpVersion !== null) {
            lines.push(`CLI release target: MCP ${result.releaseMcpVersion}${result.releaseCoreVersion ? ` · Core ${result.releaseCoreVersion}` : ""}`);
        }
        if (hasActiveRuntime) {
            lines.push(
                `Active managed runtime: MCP ${result.activeManagedMcpVersion}${result.activeManagedCoreVersion ? ` · Core ${result.activeManagedCoreVersion}` : ""}`,
                `Managed launcher: ${result.activeLauncherPath ?? "unknown"}`,
            );
        } else if (result.activeLauncherPath && result.managedLauncherStatus !== "missing") {
            lines.push(`Managed launcher: ${result.activeLauncherPath}`);
        } else {
            lines.push("Managed launcher: not installed");
        }
        if (hasActiveRuntime) {
            lines.push("", "CLI release target and active managed runtime differ.");
        }
    }
    lines.push("");
    return lines.join("\n");
}

function resolveDefaultServerInvocation(homeDir: string): { command: string; args: string[] } {
    const managedLauncherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    if (fs.existsSync(managedLauncherPath)) {
        return { command: process.execPath, args: [managedLauncherPath] };
    }
    throw new CliError(
        "E_USAGE",
        `Satori managed runtime is not installed. Run ${satoriCliCommand("install")} first.`,
        2,
    );
}

function buildHelpPayload() {
    return {
        usage: "satori <command>",
        commands: [
            "install [--client auto|all|codex|claude|opencode] [--runtime offline|voyage] [--vector-store lancedb|milvus] [--ollama-model <model>] [--reranker lateon|none] [--profile default|minimal|all-text] [--dry-run] [--install-guidance-hook] (default: auto-detect supported clients; offline Potion embeddings with LateOn D32 reranking on Linux x64; --ollama-model selects Ollama; --reranker none disables reranking)",
            "version (-v, --version)",
            "upgrade (alias: update)",
            "terminate",
            "uninstall [--client auto|all|codex|claude|opencode] [--dry-run] (default: all supported clients)",
            "doctor [--verbose] [--json]",
            "tools list",
            "tool call <toolName> --args-json '<json>'",
            "tool call <toolName> --args-file <path>",
            "<toolName> [schema-driven flags]"
        ],
        globalFlags: [
            "--startup-timeout-ms <n>",
            "--call-timeout-ms <n>",
            "--format json|text",
            "--debug",
            "-v, --version"
        ]
    };
}

function formatHelpText(): string {
    return [
        "Satori",
        "",
        "Give your coding agent a searchable map of your repository.",
        "",
        "Usage:",
        "  satori <command>",
        "",
        "Get started (no global install required):",
        `  ${satoriCliCommand("install")}`,
        `  ${satoriCliCommand("doctor")}`,
        "",
        "Optional persistent command:",
        "  npm install -g @zokizuan/satori-cli@latest",
        "",
        "Optional Codex startup reminder:",
        `  ${satoriCliCommand("install --client codex --install-guidance-hook")}`,
        "",
        "Commands:",
        "  install       Install Satori for detected clients; use --client all to force all supported clients",
        "  version       Show installed CLI, MCP, and Core versions",
        "  upgrade       Update the CLI and its compatible MCP/Core runtime",
        "  terminate     Stop all running Satori MCP servers",
        "  doctor        Check installation, runtime, and client configuration",
        "  uninstall     Remove Satori-managed client configuration (defaults to all supported clients)",
        "  tools list    List the available MCP tools",
        "  tool call     Call an MCP tool from the terminal",
        "",
        "Options:",
        "  -v, --version     Show installed CLI, MCP, and Core versions",
        "  --format json     Print structured output",
        "  --debug           Show MCP startup details",
        "",
        `Run \`${SATORI_CLI_NPX_COMMAND} --format json --help\` for complete command syntax.`,
        "",
    ].join("\n");
}

function resolveToolSchema(toolsResult: unknown, toolName: string): unknown {
    const tools = isRecord(toolsResult) && Array.isArray(toolsResult.tools)
        ? toolsResult.tools
        : [];
    const tool = tools.find((entry): entry is ToolDescriptor => (
        isRecord(entry) && typeof entry.name === "string" && entry.name === toolName
    ));
    if (!tool) {
        throw new CliError("E_USAGE", `Unknown tool '${toolName}'.`, 2);
    }
    const schema = tool.inputSchema ?? tool.input_schema;
    if (!schema || typeof schema !== "object") {
        throw new CliError("E_SCHEMA_UNSUPPORTED", `${toolName} schema is missing or invalid. Use --args-json/--args-file.`, 2);
    }
    return schema;
}

function summarizeEnvelopeError(writers: { writeStderr: (text: string) => void }, envelope: ReturnType<typeof parseStructuredEnvelope>): void {
    if (!envelope) {
        return;
    }
    const status = envelope.status;
    const reasonPart = envelope.reason ? ` reason=${envelope.reason}` : "";
    const statusHintPart = envelope.hintStatus ? ` status_hint=${JSON.stringify(envelope.hintStatus)}` : "";
    writers.writeStderr(`E_TOOL_ERROR status=${status}${reasonPart}${statusHintPart}\n`);
}

function maybeEmitTextSummary(writers: { writeStderr: (text: string) => void }, result: unknown): void {
    const text = firstText(result);
    if (text) {
        writers.writeStderr(`${text}\n`);
    }
}

function evaluateToolResultForError(
    result: unknown,
    writers: { writeStderr: (text: string) => void; },
): number | null {
    if (isRecord(result) && result.isError === true) {
        const message = firstText(result) || "tool call failed";
        writers.writeStderr(`E_TOOL_ERROR ${message}\n`);
        return 1;
    }

    const envelope = parseStructuredEnvelope(result);
    if (envelope && envelope.status !== "ok") {
        summarizeEnvelopeError(writers, envelope);
        return 1;
    }

    return null;
}

function manageIndexOperationFailureExit(
    result: unknown,
    writers: { writeStderr: (text: string) => void; },
): number | null {
    const phase = operationPhase(result);
    if (phase === "failed" || phase === "blocked" || phase === "cancelled") {
        writers.writeStderr(`E_TOOL_ERROR manage_index operation phase=${phase}\n`);
        return 1;
    }
    return null;
}

async function invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    session: CliSession,
    manageIndexPollIntervalMs: number,
    writers: { writeStdout: (text: string) => void; writeStderr: (text: string) => void; },
    format: "json" | "text",
    diagnostics: { path: string; nowMs: () => number } | null,
): Promise<number> {
    const startedAt = diagnostics?.nowMs() ?? 0;
    let result: CallToolResult;
    let initialErrorExit: number | null;
    try {
        result = await session.callTool(toolName, args);
        initialErrorExit = evaluateToolResultForError(result, writers);
        if (initialErrorExit === null && shouldAwaitManagedIndex(toolName, args)) {
            result = await waitForManageIndex(session, args.path as string, manageIndexPollIntervalMs);
        }
    } catch (error) {
        if (diagnostics) {
            recordLocalDiagnosticEvent(diagnostics.path, buildLocalDiagnosticEvent({
                toolName,
                args,
                result: { isError: true },
                durationMs: diagnostics.nowMs() - startedAt,
            }));
        }
        throw error;
    }
    if (diagnostics) {
        recordLocalDiagnosticEvent(diagnostics.path, buildLocalDiagnosticEvent({
            toolName,
            args,
            result,
            durationMs: diagnostics.nowMs() - startedAt,
        }));
    }

    emitJson(writers, result);
    if (format === "text") {
        maybeEmitTextSummary(writers, result);
    }

    const awaitedManageIndex = initialErrorExit === null && shouldAwaitManagedIndex(toolName, args);
    const finalErrorExit = initialErrorExit
        ?? (awaitedManageIndex ? manageIndexOperationFailureExit(result, writers) : null)
        ?? evaluateToolResultForError(result, writers);
    if (finalErrorExit !== null) {
        return finalErrorExit;
    }

    return 0;
}

const MEBIBYTE = 1024 * 1024;

function formatModelBytes(bytes: number): string {
    return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}

function createLateOnProgressReporter(writers: CliWriters): LateOnModelProgressReporter {
    let nextProgressPercent = 10;
    return (event: LateOnModelProgressEvent) => {
        if (event.phase === "checking") {
            writers.writeStderr("LateOn model: checking local cache...\n");
            return;
        }
        if (event.phase === "downloading") {
            nextProgressPercent = 10;
            writers.writeStderr(
                `LateOn model: downloading ${event.repository} from Hugging Face (${formatModelBytes(event.totalBytes)})...\n`,
            );
            return;
        }
        if (event.phase === "progress") {
            const percent = Math.min(100, Math.floor((event.totalBytesDownloaded / event.totalBytes) * 100));
            if (percent < nextProgressPercent && event.totalBytesDownloaded < event.totalBytes) {
                return;
            }
            const displayPercent = event.totalBytesDownloaded >= event.totalBytes
                ? 100
                : Math.floor(percent / 10) * 10;
            while (nextProgressPercent <= displayPercent) nextProgressPercent += 10;
            writers.writeStderr(
                `  ${String(displayPercent).padStart(3)}% · ${formatModelBytes(event.totalBytesDownloaded)} / ${formatModelBytes(event.totalBytes)} · ${event.artifact}\n`,
            );
            return;
        }
        if (event.phase === "verifying") {
            const label = event.source === "cached" ? "cached model" : "downloaded model";
            writers.writeStderr(`LateOn model: verifying ${label}...\n`);
            return;
        }
        const label = event.source === "cached" ? "cached and verified" : "downloaded and verified";
        writers.writeStderr(`LateOn model: ${label} (${formatModelBytes(event.totalBytes)}).\n`);
    };
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
    const writers = {
        writeStdout: options.writeStdout || ((text: string) => process.stdout.write(text)),
        writeStderr: options.writeStderr || ((text: string) => process.stderr.write(text)),
    };
    const effectiveEnv = options.env || process.env;
    const homeDir = effectiveEnv.HOME || os.homedir();
    const diagnosticsPath = options.diagnosticsPath === null || (options.connectSession && options.diagnosticsPath === undefined)
        ? null
        : options.diagnosticsPath || path.join(homeDir, ".satori", "diagnostics", "events.jsonl");
    const diagnostics = diagnosticsPath
        ? { path: diagnosticsPath, nowMs: options.nowMs || (() => performance.now()) }
        : null;
    let parsedFormat: "json" | "text" = "json";
    let parsedFormatExplicit = false;
    let parsedCommandKind: ParsedCommand["kind"] | null = null;

    try {
        const parsed = parseCliArgs(argv);
        parsedFormat = parsed.globals.format;
        parsedFormatExplicit = parsed.globals.formatExplicit;
        parsedCommandKind = parsed.command.kind;
        const startupTimeoutMs = options.startupTimeoutMs ?? parsed.globals.startupTimeoutMs;
        const callTimeoutMs = options.callTimeoutMs ?? parsed.globals.callTimeoutMs;

        if (parsed.command.kind === "help") {
            if (parsed.globals.formatExplicit && parsed.globals.format === "json") {
                emitJson(writers, buildHelpPayload());
            } else {
                writers.writeStdout(formatHelpText());
            }
            return 0;
        }

        if (parsed.command.kind === "version") {
            const packageVersions = options.versionResolver?.() ?? resolveInstalledPackageVersions();
            const state = (options.runtimeStateResolver ?? resolveRuntimeVersionState)(homeDir, packageVersions);
            const result = buildVersionPayload(
                packageVersions,
                state,
            );
            if (parsed.globals.formatExplicit && parsed.globals.format === "json") {
                emitJson(writers, result);
            } else {
                writers.writeStdout(formatVersionText(result));
            }
            return 0;
        }

        if (parsed.command.kind === "doctor") {
            const result = await (options.doctorRunner || ((doctorOptions: { env: NodeJS.ProcessEnv }) => runDoctor({ env: doctorOptions.env })))({
                env: effectiveEnv,
            });
            const wantsJson = parsed.command.json
                || (parsed.globals.formatExplicit && parsed.globals.format === "json");
            if (wantsJson) {
                emitJson(writers, result);
            } else {
                emitDoctorText(writers, result, { verbose: parsed.command.verbose });
            }
            return result.status === "error" ? 1 : 0;
        }

        if (parsed.command.kind === "upgrade") {
            const showProgress = !(parsed.globals.formatExplicit && parsed.globals.format === "json");
            if (showProgress) {
                writers.writeStderr("Checking latest Satori release...\n");
            }
            const target = await (options.upgradeTargetResolver || resolveSatoriUpgradeTarget)();
            const currentCliVersion = readPackageVersion();
            const cliComparison = compareStableVersions(currentCliVersion, target.cliVersion);
            if (cliComparison > 0) {
                throw new CliError(
                    "E_USAGE",
                    `Installed CLI ${currentCliVersion} is newer than npm latest ${target.cliVersion}; refusing to downgrade it.`,
                    2,
                );
            }
            if (cliComparison < 0) {
                if (effectiveEnv.SATORI_UPGRADE_DELEGATED_TARGET === target.cliVersion) {
                    throw new CliError(
                        "E_USAGE",
                        `Global CLI update reported success, but the delegated command still runs CLI ${currentCliVersion}; expected ${target.cliVersion}.`,
                        2,
                    );
                }
                const delegatedArgs = [
                    ...(parsed.globals.formatExplicit ? ["--format", parsed.globals.format] : []),
                    ...(parsed.globals.debug ? ["--debug"] : []),
                    "upgrade",
                ];
                if (showProgress) {
                    writers.writeStderr(`Updating CLI ${currentCliVersion} → ${target.cliVersion}...\n`);
                }
                return await (options.globalCliUpgradeRunner || installGlobalCliAndDelegate)({
                    target,
                    currentCliVersion,
                    invokedScriptPath: options.invokedScriptPath ?? process.argv[1],
                    delegatedArgs,
                    env: effectiveEnv,
                });
            }

            const runtimeResult = await (
                options.managedRuntimeUpgradeRunner
                || ((upgradeTarget, upgradeOptions) => executeManagedRuntimeUpgrade(upgradeTarget, upgradeOptions))
            )(target, {
                homeDir,
                env: effectiveEnv,
                preflightDependencies: options.installPreflightDependencies,
                preflightRunner: options.installPreflightRunner,
                onUpgradeProgress: showProgress
                    ? (phase: ManagedRuntimeUpgradePhase) => {
                        const messages: Record<ManagedRuntimeUpgradePhase, string> = {
                            installing: `Installing MCP ${target.mcpVersion} and Core ${target.coreVersion}...`,
                            verifying: "Verifying candidate runtime...",
                            activating: "Activating verified runtime...",
                        };
                        writers.writeStderr(`${messages[phase]}\n`);
                    }
                    : undefined,
                lateOnProgress: showProgress ? createLateOnProgressReporter(writers) : undefined,
                lateOnRetryCommand: satoriCliCommand("update"),
            });
            const delegatedFromCli = effectiveEnv.SATORI_UPGRADE_DELEGATED_TARGET === currentCliVersion
                ? effectiveEnv.SATORI_UPGRADE_FROM_CLI_VERSION
                : undefined;
            if (delegatedFromCli !== undefined) {
                parseStableVersion(delegatedFromCli, "Previous CLI version");
            }
            const result = combineUpgradeResult(
                runtimeResult,
                delegatedFromCli ?? currentCliVersion,
                currentCliVersion,
            );
            if (parsed.globals.formatExplicit && parsed.globals.format === "json") {
                emitJson(writers, result);
            } else {
                writers.writeStdout(formatUpgradeText(result));
            }
            return 0;
        }

        if (parsed.command.kind === "terminate") {
            const result = await (options.terminateRunner ?? terminateSatoriServers)({
                homeDir,
                env: effectiveEnv,
            });
            if (parsed.globals.formatExplicit && parsed.globals.format === "json") {
                emitJson(writers, result);
            } else {
                writers.writeStdout(formatTerminateText(result));
            }
            return result.status === "partial" ? 1 : 0;
        }

        if (parsed.command.kind === "install" || parsed.command.kind === "uninstall") {
            const wantsJson = parsed.globals.formatExplicit && parsed.globals.format === "json";
            let packageSpecifier: string | undefined;
            if (parsed.command.kind === "install" && !parsed.command.dryRun) {
                assertAutoClientTargets(parsed.command.client, homeDir, effectiveEnv);
                packageSpecifier = await (options.installabilityVerifier || verifyManagedPackageInstallability)();
            }
            const result = await executeInstallCommand(parsed.command, {
                homeDir,
                packageSpecifier,
                runtimeCommand: options.installRuntimeCommand,
                env: effectiveEnv,
                preflightDependencies: options.installPreflightDependencies,
                preflightRunner: options.installPreflightRunner,
                lateOnAuthorityLoader: options.installLateOnAuthorityLoader,
                lateOnProgress: wantsJson ? undefined : createLateOnProgressReporter(writers),
                lateOnRetryCommand: parsed.command.kind === "install" && parsed.command.runtime === "offline"
                    ? satoriCliCommand([
                        "install --runtime offline --reranker lateon",
                        `--client ${parsed.command.client}`,
                        ...(parsed.command.ollamaModel ? [`--ollama-model ${parsed.command.ollamaModel}`] : []),
                        ...(parsed.command.profile ? [`--profile ${parsed.command.profile}`] : []),
                        ...(parsed.command.installGuidanceHook ? ["--install-guidance-hook"] : []),
                    ].join(" "))
                    : undefined,
            });
            if (parsed.command.kind === "install" && !parsed.command.dryRun) {
                const postflight = await (options.installPostflightRunner || runInstallPostflight)({
                    installResult: result,
                    homeDir,
                    env: effectiveEnv,
                    startupTimeoutMs,
                    callTimeoutMs,
                    writeStderr: parsed.globals.debug ? writers.writeStderr : () => {},
                    connectSession: options.connectSession,
                });
                if (wantsJson) emitJson(writers, { ...result, postflight });
                else emitInstallText(writers, result, postflight);
                return postflight.status === "error" ? 1 : 0;
            }
            if (wantsJson) emitJson(writers, result);
            else emitInstallText(writers, result);
            return 0;
        }

        const defaultServer = options.serverCommand
            ? { command: options.serverCommand, args: options.serverArgs ?? [] }
            : resolveDefaultServerInvocation(homeDir);
        const session = await (options.connectSession || connectCliMcpSession)({
            command: defaultServer.command,
            args: options.serverArgs ?? defaultServer.args,
            env: {
                ...effectiveEnv,
                ...options.serverEnv,
                SATORI_RUN_MODE: "cli",
            },
            cwd: options.cwd,
            startupTimeoutMs,
            callTimeoutMs,
            writeStderr: writers.writeStderr,
        });

        try {
            if (parsed.command.kind === "tools-list") {
                const result = await session.listTools();
                emitJson(writers, result);
                return 0;
            }

            if (parsed.command.kind === "tool-call") {
                const args = await resolveRawArguments(parsed.command.rawArgsMode, {
                    stdin: options.stdin,
                    stdinTimeoutMs: callTimeoutMs,
                });
                return await invokeTool(parsed.command.toolName, args, session, DEFAULT_MANAGE_INDEX_POLL_INTERVAL_MS, writers, parsed.globals.format, diagnostics);
            }

            const listToolsResult = await session.listTools();
            const schema = resolveToolSchema(listToolsResult, parsed.command.toolName);
            const args = parsed.command.rawArgsMode.kind !== "none"
                ? await resolveRawArguments(parsed.command.rawArgsMode, {
                    stdin: options.stdin,
                    stdinTimeoutMs: callTimeoutMs,
                })
                : parseWrapperArgumentsFromSchema(parsed.command.toolName, schema, parsed.command.wrapperArgs);
            return await invokeTool(parsed.command.toolName, args, session, DEFAULT_MANAGE_INDEX_POLL_INTERVAL_MS, writers, parsed.globals.format, diagnostics);
        } finally {
            await session.close();
        }
    } catch (error) {
        const cliError = asCliError(error);
        const currentCliVersion = readPackageVersion();
        const delegationStartError = error instanceof CliUpgradeDelegationStartError
            ? error
            : null;
        const delegatedRuntimeUpgrade = parsedCommandKind === "upgrade"
            && effectiveEnv.SATORI_UPGRADE_DELEGATED_TARGET === currentCliVersion
            && typeof effectiveEnv.SATORI_UPGRADE_FROM_CLI_VERSION === "string";
        const cliUpgradeCompleted = delegationStartError !== null || delegatedRuntimeUpgrade;
        const reportedMessage = delegatedRuntimeUpgrade
            ? `CLI ${currentCliVersion} is installed, but the managed MCP/Core runtime was not changed. `
                + `The managed launcher remains unchanged. ${cliError.message}`
            : cliError.message;
        if (
            parsedFormat === "json"
            && (parsedCommandKind === "tool-call" || parsedCommandKind === "wrapper")
        ) {
            emitJson(writers, {
                isError: true,
                content: [{
                    type: "text",
                    text: `${cliError.token} ${cliError.message}`
                }],
                _meta: {
                    cliErrorToken: cliError.token,
                    exitCode: cliError.exitCode
                }
            });
        }
        if (
            parsedCommandKind === "upgrade"
            && parsedFormatExplicit
            && parsedFormat === "json"
        ) {
            emitJson(writers, {
                action: "upgrade",
                status: "error",
                cliUpgrade: cliUpgradeCompleted ? "completed" : "unchanged",
                runtimeUpgrade: "failed",
                launcherChanged: false,
                fromCliVersion: delegationStartError?.fromCliVersion
                    ?? (delegatedRuntimeUpgrade
                        ? effectiveEnv.SATORI_UPGRADE_FROM_CLI_VERSION
                        : currentCliVersion),
                toCliVersion: delegationStartError?.toCliVersion ?? currentCliVersion,
                error: {
                    token: cliError.token,
                    message: cliError.message,
                },
            });
        }
        if (
            parsedCommandKind === "terminate"
            && parsedFormatExplicit
            && parsedFormat === "json"
        ) {
            emitJson(writers, {
                action: "terminate",
                status: "error",
                error: {
                    token: cliError.token,
                    message: cliError.message,
                },
            });
        }
        emitError(writers, cliError.token, reportedMessage);
        return cliError.exitCode;
    }
}

async function main(): Promise<void> {
    const exitCode = await runCli(process.argv.slice(2));
    process.exit(exitCode);
}

function isExecutedDirectly(): boolean {
    return isExecutedDirectlyForPaths(import.meta.url, process.argv[1]);
}

export function isExecutedDirectlyForPaths(moduleUrl: string, entryPath: string | undefined): boolean {
    if (!entryPath) {
        return false;
    }
    try {
        const modulePath = fs.realpathSync(fileURLToPath(moduleUrl));
        const invokedPath = fs.realpathSync(path.resolve(entryPath));
        return modulePath === invokedPath;
    } catch {
        try {
            const modulePath = path.resolve(fileURLToPath(moduleUrl));
            const invokedPath = path.resolve(entryPath);
            return modulePath === invokedPath;
        } catch {
            return false;
        }
    }
}

if (isExecutedDirectly()) {
    void main();
}
