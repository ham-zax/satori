import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
    createMcpConfig,
    logConfigurationSummary,
    resolveMcpRuntimeBootstrap,
    showHelpMessage,
} from "../config.js";
import {
    McpSession,
    ServerRunMode,
    SharedRuntimeHost,
    createSessionWorkspacePolicyFromEnv,
} from "./shared-runtime.js";

export type { ServerRunMode } from "./shared-runtime.js";

export interface StartMcpServerOptions {
    runMode?: ServerRunMode;
    protocolStdin?: Readable;
    protocolStdout?: Writable;
    args?: string[];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function migrateLegacyStateDir(): void {
    const homeDir = os.homedir();
    const legacyDir = path.join(homeDir, ".context");
    const newDir = path.join(homeDir, ".satori");

    if (fs.existsSync(newDir) || !fs.existsSync(legacyDir)) {
        return;
    }

    try {
        fs.renameSync(legacyDir, newDir);
        console.log(`[MIGRATION] Moved legacy state directory '${legacyDir}' -> '${newDir}'`);
        return;
    } catch {
        // Fallback for cross-device moves: copy then remove.
    }

    try {
        fs.cpSync(legacyDir, newDir, { recursive: true, force: false, errorOnExist: true });
        fs.rmSync(legacyDir, { recursive: true, force: true });
        console.log(`[MIGRATION] Copied legacy state directory '${legacyDir}' -> '${newDir}' and removed source`);
    } catch (copyError) {
        console.error(`[MIGRATION] Failed to migrate '${legacyDir}' -> '${newDir}':`, errorMessage(copyError));
    }
}

export class ContextMcpServer {
    private readonly host: SharedRuntimeHost;
    private readonly session: McpSession;

    constructor(
        config: ConstructorParameters<typeof SharedRuntimeHost>[0],
        runtimeFingerprint: ConstructorParameters<typeof SharedRuntimeHost>[1],
        private readonly runMode: ServerRunMode,
        private readonly protocolStdout?: Writable,
        private readonly protocolStdin?: Readable,
    ) {
        this.host = new SharedRuntimeHost(config, runtimeFingerprint, runMode);
        // Direct stdio sessions bind the same environment-derived workspace
        // policy as the shared-runtime launcher: SATORI_SESSION_ROOTS_JSON
        // when present, otherwise [process.cwd()]. Invalid roots reject
        // startup with the policy's stable message; broad roots (filesystem
        // root, home directory, state root) reject unless
        // SATORI_ALLOW_BROAD_ROOTS=true opts in.
        this.session = this.host.createSession(
            createSessionWorkspacePolicyFromEnv(process.env),
        );
    }

    async start(): Promise<void> {
        console.log("Starting Satori MCP server...");
        if (this.runMode === "cli" && !this.protocolStdout) {
            throw new Error("E_PROTOCOL_FAILURE Missing protocolStdout for cli mode");
        }
        await this.session.connectStdio(
            this.protocolStdin,
            this.protocolStdout,
        );
        console.log("MCP server started and listening on stdio.");
    }

    async shutdown(): Promise<void> {
        console.log("Shutting down Satori MCP server...");
        await this.session.shutdown();
        await this.host.shutdown();
    }
}

function isHelpRequested(args: string[]): boolean {
    return args.includes("--help") || args.includes("-h");
}

export async function startMcpServerFromEnv(options: StartMcpServerOptions = {}): Promise<ContextMcpServer | null> {
    const args = options.args ?? process.argv.slice(2);
    const runMode = options.runMode ?? "mcp";

    if (isHelpRequested(args)) {
        showHelpMessage();
        return null;
    }

    migrateLegacyStateDir();

    const parsedConfig = createMcpConfig();
    const { config, runtimeFingerprint } = await resolveMcpRuntimeBootstrap(
        parsedConfig,
        {},
        {
            useRecordedOllamaIdentity: runMode === "postflight"
                && parsedConfig.executionProfile === "offline",
        },
    );
    logConfigurationSummary(config);

    const server = new ContextMcpServer(
        config,
        runtimeFingerprint,
        runMode,
        options.protocolStdout,
        options.protocolStdin,
    );
    await server.start();
    return server;
}
