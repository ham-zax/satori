import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

const CONFIG_MAX_BYTES = 64 * 1024;
const MESSAGE_MAX_BYTES = 1024 * 1024;
const serverSchema = z.strictObject({
    command: z.string().min(1).max(4096).refine((value) => !value.includes("\0")),
    args: z.array(z.string().max(4096).refine((value) => !value.includes("\0"))).max(64).optional(),
    allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).min(1).max(32),
});
const configSchema = z.strictObject({
    mcpServers: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), serverSchema),
});
type ServerConfig = z.infer<typeof serverSchema>;

async function readConfig(configPath: string) {
    if (!path.isAbsolute(configPath)) {
        throw new Error("SATORI_CODEMODE_MCP_CONFIG must be an absolute path.");
    }
    const file = await open(configPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!(await file.stat()).isFile()) throw new Error("Configuration must be a regular file.");
        const buffer = Buffer.alloc(CONFIG_MAX_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > CONFIG_MAX_BYTES) throw new Error("Configuration exceeds 64 KiB.");
        let config: unknown;
        try {
            config = JSON.parse(buffer.toString("utf8", 0, offset));
        } catch {
            // JSON.parse diagnostics can include excerpts of operator-only command arguments.
            throw new Error("CodeMode MCP configuration is not valid JSON.");
        }
        const parsed = configSchema.safeParse(config);
        if (!parsed.success || Object.keys(parsed.data.mcpServers).length > 16) {
            throw new Error("Invalid mcpServers entries. Use command, optional args, and explicit allowedTools.");
        }
        return parsed.data.mcpServers;
    } finally {
        await file.close();
    }
}

// The SDK may close on handshake failure or invalid frames. Keep the same close promise
// so script cleanup waits for that operation too, including after partial startup.
class ScriptTransport extends StdioClientTransport {
    private closing?: Promise<void>;

    override close(): Promise<void> {
        return this.closing ??= super.close();
    }
}

export async function configureDownstream(
    configPath: string,
    reservedNames: readonly string[],
    aliasFor: (name: string) => string,
    signal: AbortSignal,
) {
    const configured = await readConfig(configPath);
    const clients = new Map<string, { ready: Promise<void>; client: Client; transport: ScriptTransport }>();
    const names = new Set(reservedNames);
    const tools = new Map<string, (args: unknown, callSignal: AbortSignal) => Promise<CallToolResult>>();

    function clientFor(server: string, config: ServerConfig) {
        const existing = clients.get(server);
        if (existing) return existing;
        const client = new Client({ name: "satori-codemode", version: "1" }, { versionNegotiation: { mode: "legacy" } });
        const transport = new ScriptTransport({
            command: config.command,
            args: config.args,
            cwd: path.dirname(configPath),
            stderr: "ignore",
            maxBufferSize: MESSAGE_MAX_BYTES,
        });
        const ready = client.connect(transport, { signal, timeout: 5_000 });
        const entry = { ready, client, transport };
        clients.set(server, entry);
        return entry;
    }

    for (const [server, config] of Object.entries(configured)) {
        for (const tool of config.allowedTools) {
            const name = `${server}__${tool}`;
            const alias = aliasFor(name);
            if (names.has(name) || names.has(alias)) {
                throw new Error(`Duplicate CodeMode tool name or alias: ${name}`);
            }
            names.add(name);
            names.add(alias);
            tools.set(name, async (args, callSignal) => {
                if (args === null || typeof args !== "object" || Array.isArray(args)) {
                    throw new Error("MCP tool arguments must be an object.");
                }
                callSignal.throwIfAborted();
                const { ready, client } = clientFor(server, config);
                await ready;
                callSignal.throwIfAborted();
                return client.callTool({ name: tool, arguments: args as Record<string, unknown> }, {
                    signal: callSignal,
                    timeout: 15_000,
                });
            });
        }
    }

    return {
        tools,
        async close() {
            await Promise.allSettled([...clients.values()].map(({ transport }) => transport.close()));
        },
    };
}
