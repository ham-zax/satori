#!/usr/bin/env node
/**
 * Non-cooperative MCP runtime fixture for installer-managed launcher shutdown tests.
 * Speaks newline-delimited JSON-RPC for initialize + tools/list, then ignores EOF/SIGTERM.
 */
import fs from "node:fs";
import readline from "node:readline";

const pidFile = process.env.SATORI_TEST_PID_FILE;
if (typeof pidFile !== "string" || pidFile.length === 0) {
    process.stderr.write("SATORI_TEST_PID_FILE is required\n");
    process.exit(1);
}

fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");

// Refuse cooperative shutdown so the managed launcher must force-reap this process.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

// Keep the event loop alive after stdin EOF / ignored signals.
setInterval(() => {}, 1_000);

function writeMessage(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
    writeMessage({ jsonrpc: "2.0", id, result });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// EOF must not terminate this fixture; session close must reap via the launcher.
rl.on("close", () => {});

rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
        return;
    }

    let message;
    try {
        message = JSON.parse(trimmed);
    } catch {
        return;
    }

    if (!message || typeof message !== "object") {
        return;
    }

    const method = message.method;
    if (method === "notifications/initialized") {
        return;
    }

    if (method === "initialize") {
        const requested = message.params?.protocolVersion;
        respond(message.id, {
            protocolVersion: typeof requested === "string" ? requested : "2025-11-25",
            capabilities: {
                tools: {},
            },
            serverInfo: {
                name: "satori-test-fixture",
                version: "0.0.0",
            },
        });
        return;
    }

    if (method === "tools/list") {
        respond(message.id, {
            tools: [
                {
                    name: "list_codebases",
                    description: "fixture tool",
                    inputSchema: {
                        type: "object",
                        properties: {},
                    },
                },
            ],
        });
        return;
    }

    if (message.id !== undefined) {
        writeMessage({
            jsonrpc: "2.0",
            id: message.id,
            error: {
                code: -32601,
                message: `Method not found: ${String(method ?? "unknown")}`,
            },
        });
    }
});
