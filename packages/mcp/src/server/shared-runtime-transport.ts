import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
    JSONRPCMessage,
    MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { CancelledNotificationSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Socket } from "node:net";
import {
    SHARED_RUNTIME_MAX_PENDING_REQUESTS,
    SHARED_RUNTIME_MESSAGE_MAX_BYTES,
} from "./shared-runtime-identity.js";

function requestKey(message: JSONRPCMessage): string | null {
    if (!("method" in message) || !("id" in message)) return null;
    return `${typeof message.id}:${String(message.id)}`;
}

function responseKey(message: JSONRPCMessage): string | null {
    if (
        !("id" in message)
        || (!("result" in message) && !("error" in message))
    ) {
        return null;
    }
    return `${typeof message.id}:${String(message.id)}`;
}

export class BoundedSocketTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
    private buffer = Buffer.alloc(0);
    private readonly pendingRequests = new Set<string>();
    private started = false;
    private closed = false;

    constructor(
        private readonly socket: Socket,
        private readonly onSocketClosed: () => void,
        initialBytes?: Buffer,
        private readonly maximumMessageBytes = SHARED_RUNTIME_MESSAGE_MAX_BYTES,
        private readonly maximumPendingRequests = SHARED_RUNTIME_MAX_PENDING_REQUESTS,
    ) {
        if (initialBytes && initialBytes.length > 0) {
            this.buffer = Buffer.from(initialBytes);
        }
    }

    async start(): Promise<void> {
        if (this.started) {
            throw new Error("Bounded socket transport is already started.");
        }
        this.started = true;
        this.socket.on("data", this.handleData);
        this.socket.on("error", this.handleError);
        this.socket.on("close", this.handleClose);
        if (this.buffer.length > 0) {
            this.processBuffer();
        }
        this.socket.resume();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (this.closed || this.socket.destroyed) {
            throw new Error("Shared runtime session transport is closed.");
        }
        const completedRequest = responseKey(message);
        if (completedRequest !== null) {
            this.pendingRequests.delete(completedRequest);
        }
        const serialized = `${JSON.stringify(message)}\n`;
        await new Promise<void>((resolve, reject) => {
            this.socket.write(serialized, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.detach();
        if (!this.socket.destroyed) {
            this.socket.destroy();
        }
        this.onSocketClosed();
        this.onclose?.();
    }

    private readonly handleData = (chunk: Buffer): void => {
        if (this.closed) return;
        let offset = 0;
        while (offset < chunk.length && !this.closed) {
            const newline = chunk.indexOf(0x0a, offset);
            const end = newline < 0 ? chunk.length : newline;
            const segment = chunk.subarray(offset, end);
            if (this.buffer.length + segment.length > this.maximumMessageBytes) {
                this.fail(new Error(
                    `Shared runtime JSON-RPC frame exceeds ${this.maximumMessageBytes} bytes.`,
                ));
                return;
            }
            if (segment.length > 0) {
                this.buffer = this.buffer.length === 0
                    ? Buffer.from(segment)
                    : Buffer.concat([this.buffer, segment]);
            }
            if (newline < 0) return;
            this.processCompleteLine();
            offset = newline + 1;
        }
    };

    private processBuffer(): void {
        for (;;) {
            const newline = this.buffer.indexOf(0x0a);
            if (newline < 0) {
                if (this.buffer.length > this.maximumMessageBytes) {
                    this.fail(new Error(
                        `Shared runtime JSON-RPC frame exceeds ${this.maximumMessageBytes} bytes.`,
                    ));
                }
                return;
            }
            const line = this.buffer.subarray(0, newline);
            this.buffer = this.buffer.subarray(newline + 1);
            if (line.length === 0) continue;
            this.processCompleteLine(line);
        }
    }

    private processCompleteLine(line?: Buffer): void {
        const completeLine = line ?? this.buffer;
        if (line === undefined) {
            this.buffer = Buffer.alloc(0);
        }
        const serialized = completeLine.toString("utf8").replace(/\r$/, "");
        if (!serialized) return;
        try {
            const message = JSONRPCMessageSchema.parse(JSON.parse(serialized));
            if (!("id" in message) && "method" in message && message.method === "notifications/cancelled") {
                const cancelled = CancelledNotificationSchema.safeParse(message);
                if (cancelled.success) {
                    const id = cancelled.data.params.requestId;
                    // The protocol suppresses responses for cancelled requests.
                    this.pendingRequests.delete(`${typeof id}:${String(id)}`);
                }
            }
            const pendingRequest = requestKey(message);
            if (pendingRequest !== null) {
                if (
                    this.pendingRequests.has(pendingRequest)
                    || this.pendingRequests.size >= this.maximumPendingRequests
                ) {
                    this.fail(new Error(
                        `Shared runtime session exceeds ${this.maximumPendingRequests} pending requests.`,
                    ));
                    return;
                }
                this.pendingRequests.add(pendingRequest);
            }
            this.onmessage?.(message);
        } catch (error) {
            this.fail(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private readonly handleError = (error: Error): void => {
        this.onerror?.(error);
    };

    private readonly handleClose = (): void => {
        if (this.closed) return;
        this.closed = true;
        this.detach();
        this.onSocketClosed();
        this.onclose?.();
    };

    private fail(error: Error): void {
        this.onerror?.(error);
        void this.close();
    }

    private detach(): void {
        this.socket.off("data", this.handleData);
        this.socket.off("error", this.handleError);
        this.socket.off("close", this.handleClose);
        this.buffer = Buffer.alloc(0);
        this.pendingRequests.clear();
    }
}
