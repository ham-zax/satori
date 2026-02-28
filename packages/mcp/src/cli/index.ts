#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, parseWrapperArgumentsFromSchema, resolveRawArguments } from "./args.js";
import type { ParsedCommand } from "./args.js";
import { connectCliMcpSession } from "./client.js";
import { asCliError, CliError } from "./errors.js";
import { emitError, emitJson, inferManageStatusState, parseStructuredEnvelope } from "./format.js";
import { resolveServerEntryPath } from "./resolve-server-entry.js";

const MANAGE_INDEX_MIN_POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface RunCliOptions {
    writeStdout?: (text: string) => void;
    writeStderr?: (text: string) => void;
    stdin?: NodeJS.ReadStream;
    serverCommand?: string;
    serverArgs?: string[];
    serverEnv?: Record<string, string>;
    startupTimeoutMs?: number;
    callTimeoutMs?: number;
    cwd?: string;
}

interface ToolDescriptor {
    name: string;
    inputSchema?: unknown;
}

function firstText(result: any): string | null {
    const content = result?.content;
    if (!Array.isArray(content)) {
        return null;
    }
    const entry = content.find((item: any) => item?.type === "text" && typeof item?.text === "string");
    return entry?.text || null;
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

function resolveToolSchema(toolsResult: any, toolName: string): unknown {
    const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools as ToolDescriptor[] : [];
    const tool = tools.find((entry) => entry && entry.name === toolName);
    if (!tool) {
        throw new CliError("E_USAGE", `Unknown tool '${toolName}'.`, 2);
    }
    const schema = (tool as any).inputSchema ?? (tool as any).input_schema;
    if (!schema || typeof schema !== "object") {
        throw new CliError("E_SCHEMA_UNSUPPORTED", `${toolName} schema is missing or invalid. Use --args-json/--args-file.`, 2);
    }
    return schema;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}

async function pollManageIndexUntilTerminal(
    pathArg: string,
    session: Awaited<ReturnType<typeof connectCliMcpSession>>,
    timeoutMs: number
): Promise<{ result: any; state: ReturnType<typeof inferManageStatusState> }> {
    const startedAt = Date.now();
    const pollIntervalMs = 500;

    while (Date.now() - startedAt < timeoutMs) {
        await sleep(pollIntervalMs);
        const statusResult = await session.callTool("manage_index", {
            action: "status",
            path: pathArg
        });
        const state = inferManageStatusState(statusResult);
        if (state === "indexing" || state === "unknown") {
            continue;
        }
        return { result: statusResult, state };
    }

    throw new CliError("E_CALL_TIMEOUT", `Timed out after ${timeoutMs}ms while waiting for manage_index status.`, 3);
}

function shouldWaitManageIndex(toolName: string, args: Record<string, unknown>): boolean {
    if (toolName !== "manage_index") {
        return false;
    }
    const action = args.action;
    if (action !== "create" && action !== "reindex") {
        return false;
    }
    return typeof args.path === "string" && args.path.length > 0;
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

function maybeEmitTextSummary(writers: { writeStderr: (text: string) => void }, result: any): void {
    const text = firstText(result);
    if (text) {
        writers.writeStderr(`${text}\n`);
    }
}

function evaluateToolResultForError(
    result: any,
    writers: { writeStderr: (text: string) => void; },
): number | null {
    if (result?.isError === true) {
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
    session: Awaited<ReturnType<typeof connectCliMcpSession>>,
    callTimeoutMs: number,
    writers: { writeStdout: (text: string) => void; writeStderr: (text: string) => void; },
    format: "json" | "text"
): Promise<number> {
    let result = await session.callTool(toolName, args);
    let manageWaitState: ReturnType<typeof inferManageStatusState> | null = null;

    const initialErrorExit = evaluateToolResultForError(result, writers);
    if (initialErrorExit !== null) {
        emitJson(writers, result);
        if (format === "text") {
            maybeEmitTextSummary(writers, result);
        }
        return initialErrorExit;
    }

    if (shouldWaitManageIndex(toolName, args)) {
        const effectiveManagePollTimeoutMs = Math.max(callTimeoutMs, MANAGE_INDEX_MIN_POLL_TIMEOUT_MS);
        const polled = await pollManageIndexUntilTerminal(args.path as string, session, effectiveManagePollTimeoutMs);
        result = polled.result;
        manageWaitState = polled.state;
    }

    emitJson(writers, result);
    if (format === "text") {
        maybeEmitTextSummary(writers, result);
    }

    const finalErrorExit = evaluateToolResultForError(result, writers);
    if (finalErrorExit !== null) {
        return finalErrorExit;
    }

    if (manageWaitState === "indexfailed" || manageWaitState === "requires_reindex" || manageWaitState === "not_indexed") {
        emitError(writers, "E_TOOL_ERROR", `manage_index terminal state=${manageWaitState}`);
        return 1;
    }

    return 0;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
    const writers = {
        writeStdout: options.writeStdout || ((text: string) => process.stdout.write(text)),
        writeStderr: options.writeStderr || ((text: string) => process.stderr.write(text)),
    };
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

        const session = await connectCliMcpSession({
            command: options.serverCommand || process.execPath,
            args: options.serverArgs || resolveDefaultServerArgs(),
            env: {
                ...process.env,
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
