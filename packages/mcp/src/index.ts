#!/usr/bin/env node

import { Writable } from "node:stream";

type ServerHandle = {
    shutdown: () => Promise<void>;
};

let activeServer: ServerHandle | null = null;
let shuttingDown = false;
let guardDisabledWarningEmitted = false;

function resolveRunMode(): "mcp" | "cli" {
    return process.env.SATORI_RUN_MODE === "cli" ? "cli" : "mcp";
}

function resolveGuardMode(): "drop" | "redirect" | "off" {
    const value = process.env.SATORI_CLI_STDOUT_GUARD?.trim().toLowerCase();
    if (value === "redirect") {
        return "redirect";
    }
    if (value === "off" || value === "false" || value === "0" || value === "disable") {
        return "off";
    }
    return "drop";
}

function createProtocolStdout(originalWrite: typeof process.stdout.write): Writable {
    return new Writable({
        write(chunk, encoding, callback) {
            try {
                originalWrite(chunk, encoding as BufferEncoding, (error?: Error | null) => {
                    callback(error ?? undefined);
                });
            } catch (error) {
                callback(error as Error);
            }
        }
    });
}

async function handleShutdownSignal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    console.error(`Received ${signal}, shutting down gracefully...`);
    try {
        if (activeServer) {
            await activeServer.shutdown();
        }
    } catch (error) {
        console.error("Error during graceful shutdown:", error);
    } finally {
        process.exit(0);
    }
}

async function main(): Promise<void> {
    const runMode = resolveRunMode();
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const protocolStdout = createProtocolStdout(originalStdoutWrite);

    const { installCliStdoutRedirect, installConsoleToStderrPatch } = await import("./server/stdio-safety.js");
    installConsoleToStderrPatch();
    if (runMode === "cli") {
        const guardMode = resolveGuardMode();
        if (guardMode !== "off") {
            installCliStdoutRedirect({
                mode: guardMode,
            });
        } else if (!guardDisabledWarningEmitted) {
            guardDisabledWarningEmitted = true;
            console.error("[STDOUT_GUARD_DISABLED] SATORI_CLI_STDOUT_GUARD=off");
        }
    }

    const { startMcpServerFromEnv } = await import("./server/start-server.js");
    activeServer = await startMcpServerFromEnv({
        runMode,
        protocolStdout,
        args: process.argv.slice(2),
    });
}

process.on("SIGINT", () => {
    void handleShutdownSignal("SIGINT");
});

process.on("SIGTERM", () => {
    void handleShutdownSignal("SIGTERM");
});

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("E_PROTOCOL_FAILURE")) {
        console.error(`E_PROTOCOL_FAILURE ${message}`);
    } else {
        console.error("Fatal error:", error);
    }
    process.exit(1);
});
