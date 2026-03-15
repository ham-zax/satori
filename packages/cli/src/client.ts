import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CliError } from "./errors.js";

interface SessionOptions {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
    cwd?: string;
    startupTimeoutMs: number;
    callTimeoutMs: number;
    writeStderr: (text: string) => void;
}

function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

function createTimeout<T>(promise: Promise<T>, timeoutMs: number, token: string, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new CliError(token, message, 3));
        }, timeoutMs);
        timer.unref();

        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }).catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

export class CliMcpSession {
    private readonly client: Client;
    private readonly transport: StdioClientTransport;
    private readonly callTimeoutMs: number;
    private readonly writeStderr: (text: string) => void;

    constructor(client: Client, transport: StdioClientTransport, callTimeoutMs: number, writeStderr: (text: string) => void) {
        this.client = client;
        this.transport = transport;
        this.callTimeoutMs = callTimeoutMs;
        this.writeStderr = writeStderr;
    }

    async listTools(): Promise<any> {
        return createTimeout(
            this.client.listTools(),
            this.callTimeoutMs,
            "E_CALL_TIMEOUT",
            `Timed out after ${this.callTimeoutMs}ms while calling tools/list.`
        );
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<any> {
        return createTimeout(
            this.client.callTool({ name, arguments: args }),
            this.callTimeoutMs,
            "E_CALL_TIMEOUT",
            `Timed out after ${this.callTimeoutMs}ms while calling tools/call for '${name}'.`
        );
    }

    async close(): Promise<void> {
        try {
            await this.client.close();
        } catch {
            // Best-effort close.
        }
        try {
            await this.transport.close();
        } catch {
            // Best-effort close.
        }
    }

    logProtocolFailure(error: unknown): never {
        if (error instanceof CliError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError("E_PROTOCOL_FAILURE", message, 3);
    }

    wireStderr(): void {
        const stderr = this.transport.stderr;
        if (!stderr) {
            return;
        }
        stderr.on("data", (chunk) => {
            this.writeStderr(String(chunk));
        });
    }
}

export async function connectCliMcpSession(options: SessionOptions): Promise<CliMcpSession> {
    const transport = new StdioClientTransport({
        command: options.command,
        args: options.args,
        env: sanitizeEnv(options.env),
        cwd: options.cwd,
        stderr: "pipe",
    });
    const client = new Client({
        name: "satori-cli",
        version: "1.1.0",
    });
    const session = new CliMcpSession(client, transport, options.callTimeoutMs, options.writeStderr);
    session.wireStderr();

    try {
        await createTimeout(
            client.connect(transport),
            options.startupTimeoutMs,
            "E_STARTUP_TIMEOUT",
            `Timed out after ${options.startupTimeoutMs}ms while starting MCP server.`
        );
        return session;
    } catch (error) {
        await session.close();
        if (error instanceof CliError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError("E_PROTOCOL_FAILURE", message, 3);
    }
}
