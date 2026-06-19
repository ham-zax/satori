#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, parseWrapperArgumentsFromSchema, resolveRawArguments } from "./args.js";
import type { ParsedCommand } from "./args.js";
import { connectCliMcpSession, type CallToolResult, type ListToolsResult } from "./client.js";
import { asCliError, CliError } from "./errors.js";
import { emitError, emitJson, parseStructuredEnvelope } from "./format.js";
import { executeInstallCommand, type ManagedRuntimeCommand } from "./install.js";
import { verifyManagedPackageInstallability } from "./package-installability.js";
import { resolveServerEntryPath } from "./resolve-server-entry.js";

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
}

interface TextContentEntry {
    type: "text";
    text: string;
}

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

function readPackageVersion(): string {
    try {
        const currentFile = fileURLToPath(import.meta.url);
        const packagePath = path.resolve(path.dirname(currentFile), "..", "..", "package.json");
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

function resolveDefaultServerArgs(): string[] {
    const serverEntry = resolveServerEntryPath();
    if (serverEntry.endsWith(".ts")) {
        return ["--import", "tsx", serverEntry];
    }
    return [serverEntry];
}

function buildHelpPayload() {
    return {
        usage: "satori-cli <command>",
        commands: [
            "install [--client all|codex|claude|opencode] [--profile default|minimal|all-text] [--dry-run] [--install-guidance-hook]",
            "uninstall [--client all|codex|claude|opencode] [--dry-run]",
            "tools list",
            "tool call <toolName> --args-json '<json>'",
            "tool call <toolName> --args-file <path>",
            "<toolName> [schema-driven flags]"
        ],
        globalFlags: [
            "--startup-timeout-ms <n>",
            "--call-timeout-ms <n>",
            "--format json|text",
            "--debug"
        ]
    };
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

async function invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    session: CliSession,
    _callTimeoutMs: number,
    writers: { writeStdout: (text: string) => void; writeStderr: (text: string) => void; },
    format: "json" | "text"
): Promise<number> {
    let result = await session.callTool(toolName, args);

    const initialErrorExit = evaluateToolResultForError(result, writers);
    if (initialErrorExit !== null) {
        emitJson(writers, result);
        if (format === "text") {
            maybeEmitTextSummary(writers, result);
        }
        return initialErrorExit;
    }

    emitJson(writers, result);
    if (format === "text") {
        maybeEmitTextSummary(writers, result);
    }

    const finalErrorExit = evaluateToolResultForError(result, writers);
    if (finalErrorExit !== null) {
        return finalErrorExit;
    }

    return 0;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
    const writers = {
        writeStdout: options.writeStdout || ((text: string) => process.stdout.write(text)),
        writeStderr: options.writeStderr || ((text: string) => process.stderr.write(text)),
    };
    const effectiveEnv = options.env || process.env;
    let parsedFormat: "json" | "text" = "json";
    let parsedCommandKind: ParsedCommand["kind"] | null = null;

    try {
        const parsed = parseCliArgs(argv);
        parsedFormat = parsed.globals.format;
        parsedCommandKind = parsed.command.kind;
        const startupTimeoutMs = options.startupTimeoutMs ?? parsed.globals.startupTimeoutMs;
        const callTimeoutMs = options.callTimeoutMs ?? parsed.globals.callTimeoutMs;

        if (parsed.command.kind === "help") {
            emitJson(writers, buildHelpPayload());
            if (parsed.globals.format === "text") {
                writers.writeStderr("satori-cli help requested.\n");
            }
            return 0;
        }

        if (parsed.command.kind === "version") {
            emitJson(writers, {
                name: "@zokizuan/satori-mcp",
                cli: "satori-cli",
                version: readPackageVersion(),
            });
            if (parsed.globals.format === "text") {
                writers.writeStderr("satori-cli version shown.\n");
            }
            return 0;
        }

        if (parsed.command.kind === "install" || parsed.command.kind === "uninstall") {
            let packageSpecifier: string | undefined;
            if (parsed.command.kind === "install") {
                packageSpecifier = await (options.installabilityVerifier || verifyManagedPackageInstallability)();
            }
            const result = executeInstallCommand(parsed.command, {
                homeDir: effectiveEnv.HOME,
                packageSpecifier,
                runtimeCommand: options.installRuntimeCommand,
            });
            emitJson(writers, result);
            if (parsed.globals.format === "text") {
                writers.writeStderr(`satori-cli ${parsed.command.kind} completed for ${parsed.command.client}.\n`);
            }
            return 0;
        }

        const session = await (options.connectSession || connectCliMcpSession)({
            command: options.serverCommand || process.execPath,
            args: options.serverArgs || resolveDefaultServerArgs(),
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
                return await invokeTool(parsed.command.toolName, args, session, callTimeoutMs, writers, parsed.globals.format);
            }

            const listToolsResult = await session.listTools();
            const schema = resolveToolSchema(listToolsResult, parsed.command.toolName);
            const args = parsed.command.rawArgsMode.kind !== "none"
                ? await resolveRawArguments(parsed.command.rawArgsMode, {
                    stdin: options.stdin,
                    stdinTimeoutMs: callTimeoutMs,
                })
                : parseWrapperArgumentsFromSchema(parsed.command.toolName, schema, parsed.command.wrapperArgs);
            return await invokeTool(parsed.command.toolName, args, session, callTimeoutMs, writers, parsed.globals.format);
        } finally {
            await session.close();
        }
    } catch (error) {
        const cliError = asCliError(error);
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
        emitError(writers, cliError.token, cliError.message);
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
