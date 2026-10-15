import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { BoundedSocketTransport } from "./shared-runtime-transport.js";

type WriteCallback = (error?: Error | null) => void;

class ControlledDuplex extends Duplex {
    readonly writes: string[] = [];
    private readonly writeCallbacks: WriteCallback[] = [];
    throwOnNextWrite: Error | null = null;

    override write(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | WriteCallback,
        callback?: WriteCallback,
    ): boolean {
        const error = this.throwOnNextWrite;
        this.throwOnNextWrite = null;
        if (error) throw error;

        this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        const writeCallback = typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
        if (writeCallback) this.writeCallbacks.push(writeCallback);
        return true;
    }

    feed(message: JSONRPCMessage): void {
        this.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
    }

    completeNextWrite(error?: Error): void {
        const callback = this.writeCallbacks.shift();
        assert.ok(callback, "expected a queued socket write callback");
        callback(error);
    }

    override _read(): void {}

    override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: WriteCallback,
    ): void {
        callback(new Error("ControlledDuplex.write must intercept writes"));
    }
}

class LinkedDuplex extends Duplex {
    peer: LinkedDuplex | undefined;

    override _read(): void {}

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
        if (!this.peer || this.peer.destroyed) {
            callback(new Error("Linked socket peer is closed."));
            return;
        }
        this.peer.push(Buffer.from(chunk));
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        if (this.peer && !this.peer.destroyed) this.peer.destroy();
        callback(error);
    }
}

function createTransport(maximumPendingRequests = 2, maximumMessageBytes = 256) {
    const socket = new ControlledDuplex();
    const errors: Error[] = [];
    const transport = new BoundedSocketTransport(
        socket as unknown as Socket,
        () => {},
        undefined,
        maximumMessageBytes,
        maximumPendingRequests,
    );
    transport.onerror = (error) => errors.push(error);
    return { socket, transport, errors };
}

function request(id: number | string): JSONRPCMessage {
    return { jsonrpc: "2.0", id, method: "tools/list" };
}

function response(id: number | string): JSONRPCMessage {
    return { jsonrpc: "2.0", id, result: { tools: [] } };
}

function oversizedResult(id: number | string): JSONRPCMessage {
    return { jsonrpc: "2.0", id, result: { payload: "x".repeat(512) } };
}

function oversizedError(id: number | string): JSONRPCMessage {
    return {
        jsonrpc: "2.0",
        id,
        error: { code: ErrorCode.InvalidParams, message: "x".repeat(512) },
    };
}

function sizeLimitError(id: number | string): JSONRPCMessage {
    return {
        jsonrpc: "2.0",
        id,
        error: { code: ErrorCode.InternalError, message: "Response exceeds size limit." },
    };
}

const notification: JSONRPCMessage = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
};

test("responses retain admitted request slots until their socket writes complete", async (t) => {
    for (const limit of [2, 16]) {
        const { socket, transport, errors } = createTransport(limit);
        t.after(() => transport.close());
        const received: JSONRPCMessage[] = [];
        transport.onmessage = (message) => received.push(message);
        await transport.start();

        for (let id = 1; id <= limit; id += 1) socket.feed(request(id));
        const sendResult = transport.send(response(1));
        const sendOutcome = sendResult.then(() => "resolved", () => "rejected");
        socket.feed(request(limit + 1));

        assert.equal(received.length, limit, `${limit} admitted requests must stay occupied`);
        assert.match(errors[0]?.message ?? "", new RegExp(`exceeds ${limit} pending requests`));
        assert.equal(await sendOutcome, "rejected", "closing on overload settles the blocked response");
    }
});

test("completed response writes release slots for later requests", async (t) => {
    const { socket, transport } = createTransport(2);
    t.after(() => transport.close());
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();

    socket.feed(request(1));
    socket.feed(request(2));
    const sent = transport.send(response(1));
    let settled = false;
    void sent.then(() => { settled = true; });
    assert.equal(settled, false, "send remains pending while the socket callback is blocked");

    socket.completeNextWrite();
    await sent;
    assert.equal(settled, true);
    socket.feed(request(3));
    assert.equal(received.length, 3, "successful response completion frees one request slot");
});

test("notification writes are bounded while socket callbacks are blocked", async (t) => {
    const maximumMessageBytes = 64;
    const { socket, transport, errors } = createTransport(2, maximumMessageBytes);
    t.after(() => transport.close());
    await transport.start();

    const first = transport.send(notification);
    const second = transport.send(notification);
    const firstOutcome = first.then(() => "resolved", () => "rejected");
    const secondOutcome = second.then(() => "resolved", () => "rejected");
    const third = transport.send(notification);
    const thirdOutcome = third.then(() => "resolved", (error: Error) => error.message);

    assert.equal(socket.writes.length, 2, "overload is rejected before socket.write");
    assert.ok(socket.writes.reduce((total, frame) => total + Buffer.byteLength(frame), 0)
        <= 2 * (maximumMessageBytes + 1));
    assert.match(await thirdOutcome, /outgoing writes/);
    assert.equal(await firstOutcome, "rejected");
    assert.equal(await secondOutcome, "rejected");
    assert.match(errors[0]?.message ?? "", /outgoing writes/);
});

test("outbound frame limit excludes its newline and rejects oversized frames", async (t) => {
    const exact = {
        jsonrpc: "2.0" as const,
        method: "notifications/initialized",
    };
    const maximumMessageBytes = Buffer.byteLength(JSON.stringify(exact));
    const { socket, transport } = createTransport(2, maximumMessageBytes);
    t.after(() => transport.close());
    await transport.start();

    const accepted = transport.send(exact);
    assert.equal(socket.writes[0], `${JSON.stringify(exact)}\n`);
    socket.completeNextWrite();
    await accepted;

    const oversized = {
        jsonrpc: "2.0" as const,
        method: "notifications/initialized",
        params: { value: "x" },
    };
    const limited = createTransport(2, Buffer.byteLength(JSON.stringify(oversized)) - 1);
    t.after(() => limited.transport.close());
    await limited.transport.start();
    let oversizedError: Error | undefined;
    let oversizedSettled = false;
    void limited.transport.send(oversized).then(
        () => { oversizedSettled = true; },
        (error: Error) => {
            oversizedError = error;
            oversizedSettled = true;
        },
    );
    await Promise.resolve();
    assert.equal(oversizedSettled, true, "oversized frames fail without waiting for a write callback");
    assert.match(oversizedError?.message ?? "", /outgoing JSON-RPC frame exceeds/);
    assert.equal(limited.socket.writes.length, 0, "oversized frames never reach socket.write");
    assert.equal(limited.socket.destroyed, true);
});

test("oversized requests retain fail-and-close behavior", async (t) => {
    const oversized = request(1);
    const maximumMessageBytes = Buffer.byteLength(JSON.stringify(oversized)) - 1;
    const { socket, transport } = createTransport(2, maximumMessageBytes);
    t.after(() => transport.close());
    await transport.start();

    await assert.rejects(transport.send(oversized), /outgoing JSON-RPC frame exceeds/);

    assert.equal(socket.writes.length, 0);
    assert.equal(socket.destroyed, true);
});

test("oversized results and errors use bounded writes and release their request slots on completion", async (t) => {
    const { socket, transport, errors } = createTransport(3, 192);
    t.after(() => transport.close());
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();

    socket.feed(request(1));
    socket.feed(request("two"));
    socket.feed(request(99));
    assert.equal(received.length, 3, "the unrelated response belongs to an admitted request");
    const unrelated = transport.send(response(99));
    let replacementSettled = false;
    const replacement = transport.send(oversizedResult(1)).then(() => {
        replacementSettled = true;
    });

    assert.deepEqual(socket.writes.map((frame) => JSON.parse(frame)), [
        response(99),
        sizeLimitError(1),
    ]);
    assert.equal(replacementSettled, false, "replacement send waits for its socket callback");
    assert.equal(socket.destroyed, false, "replacing one response leaves the session open");

    socket.completeNextWrite();
    await unrelated;
    assert.equal(replacementSettled, false, "an unrelated callback cannot settle the replacement");
    socket.feed(request(3));
    assert.equal(received.length, 4, "the unrelated response callback frees its own request slot");
    socket.completeNextWrite();
    await replacement;
    assert.equal(replacementSettled, true);

    socket.feed(request(4));
    assert.equal(received.length, 5, "replacement completion frees the original numeric request slot");
    const ordinary = transport.send(response(4));
    socket.completeNextWrite();
    await ordinary;
    socket.feed(request("filler"));
    assert.equal(received.length, 6, "another admitted call fills the remaining slot");

    const oversizedFailure = transport.send(oversizedError("two"));
    assert.deepEqual(JSON.parse(socket.writes.at(-1) ?? "null"), sizeLimitError("two"));
    let errorReplacementSettled = false;
    const errorReplacement = oversizedFailure.then(() => { errorReplacementSettled = true; });
    assert.equal(errorReplacementSettled, false, "oversized error send waits for replacement completion");
    socket.completeNextWrite();
    await errorReplacement;

    socket.feed(request("five"));
    assert.equal(received.length, 7, "replacement completion frees the original string request slot");
    assert.deepEqual(errors, []);
    assert.equal(socket.destroyed, false);
});

test("oversized response replacement accepts the exact byte limit without counting its newline", async (t) => {
    const id = "exact-boundary";
    const expected = sizeLimitError(id);
    const maximumMessageBytes = Buffer.byteLength(JSON.stringify(expected));
    const { socket, transport } = createTransport(2, maximumMessageBytes);
    t.after(() => transport.close());
    await transport.start();
    socket.feed(request(id));

    const sent = transport.send(oversizedResult(id));

    assert.equal(socket.writes[0], `${JSON.stringify(expected)}\n`);
    assert.equal(Buffer.byteLength(socket.writes[0]?.slice(0, -1) ?? ""), maximumMessageBytes);
    assert.equal(Buffer.byteLength(socket.writes[0] ?? ""), maximumMessageBytes + 1);
    socket.completeNextWrite();
    await sent;
});

test("an oversized replacement that cannot fit retains fail-and-close behavior", async (t) => {
    const replacement = sizeLimitError(1);
    const maximumMessageBytes = Buffer.byteLength(JSON.stringify(replacement)) - 1;
    const { socket, transport, errors } = createTransport(2, maximumMessageBytes);
    t.after(() => transport.close());
    await transport.start();

    await assert.rejects(
        transport.send(oversizedResult(1)),
        new RegExp(`outgoing JSON-RPC frame exceeds ${maximumMessageBytes} bytes`),
    );

    assert.equal(socket.writes.length, 0);
    assert.equal(socket.destroyed, true);
    assert.match(errors[0]?.message ?? "", /outgoing JSON-RPC frame exceeds/);
});

test("a replacement write failure rejects the send and closes the transport", async (t) => {
    const { socket, transport, errors } = createTransport(2, 192);
    t.after(() => transport.close());
    await transport.start();
    socket.feed(request("failed"));
    const writeError = new Error("replacement socket write failed");

    const sent = transport.send(oversizedError("failed"));
    const outcome = sent.then(() => undefined, (error: Error) => error);
    assert.deepEqual(JSON.parse(socket.writes[0] ?? "null"), sizeLimitError("failed"));
    socket.completeNextWrite(writeError);

    assert.equal(await outcome, writeError);
    assert.equal(errors[0], writeError);
    assert.equal(socket.destroyed, true);
});

test("the MCP SDK requester receives the replacement error and the session serves a later request", async (t) => {
    const clientSocket = new LinkedDuplex();
    const serverSocket = new LinkedDuplex();
    clientSocket.peer = serverSocket;
    serverSocket.peer = clientSocket;
    const server = new Server(
        { name: "bounded-transport-test", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );
    let firstList = true;
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (firstList) {
            firstList = false;
            return {
                tools: [{
                    name: "oversized",
                    description: "x".repeat(8_192),
                    inputSchema: { type: "object" },
                }],
            };
        }
        return { tools: [] };
    });
    const client = new Client({ name: "bounded-transport-test-client", version: "1.0.0" });
    const serverTransport = new BoundedSocketTransport(
        serverSocket as unknown as Socket,
        () => {},
        undefined,
        4_096,
    );
    const clientTransport = new BoundedSocketTransport(
        clientSocket as unknown as Socket,
        () => {},
        undefined,
        4_096,
    );
    t.after(async () => {
        await client.close();
        await server.close();
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await assert.rejects(client.listTools(), (error: unknown) => {
        assert.ok(error instanceof McpError);
        assert.equal(error.code, ErrorCode.InternalError);
        assert.ok(error.message.endsWith("Response exceeds size limit."));
        return true;
    });
    assert.deepEqual(await client.listTools(), { tools: [] });
});

test("close rejects every send whose write callback is still blocked", async () => {
    const { socket, transport } = createTransport();
    await transport.start();
    const first = transport.send(notification);
    const second = transport.send(notification);
    let firstSettled = false;
    let secondSettled = false;
    let firstRejected = false;
    let secondRejected = false;
    void first.then(
        () => { firstSettled = true; },
        () => { firstSettled = true; firstRejected = true; },
    );
    void second.then(
        () => { secondSettled = true; },
        () => { secondSettled = true; secondRejected = true; },
    );

    await transport.close();
    await Promise.resolve();
    assert.deepEqual([firstSettled, secondSettled, firstRejected, secondRejected], [true, true, true, true]);
    assert.equal(socket.writes.length, 2);
});

test("write callback errors reject the send and close the transport", async (t) => {
    const { socket, transport, errors } = createTransport();
    t.after(() => transport.close());
    await transport.start();
    const writeError = new Error("socket write failed");
    const sent = transport.send(notification);
    const outcome = sent.then(() => "resolved", (error: Error) => error);

    socket.completeNextWrite(writeError);

    assert.equal(await outcome, writeError);
    assert.equal(errors[0], writeError);
    assert.equal(socket.destroyed, true);
});

test("synchronous socket.write throws reject and close the transport", async (t) => {
    const { socket, transport, errors } = createTransport();
    t.after(() => transport.close());
    await transport.start();
    const writeError = new Error("synchronous socket write failure");
    socket.throwOnNextWrite = writeError;

    await assert.rejects(transport.send(notification), (error) => error === writeError);

    assert.equal(socket.writes.length, 0);
    assert.equal(errors[0], writeError);
    assert.equal(socket.destroyed, true);
});

test("serialization failures close the transport and release request and queued write ownership", async (t) => {
    const { socket, transport, errors } = createTransport(3);
    t.after(() => transport.close());
    await transport.start();
    socket.feed(request(1));
    const first = transport.send(notification).then(() => "resolved", () => "rejected");
    const second = transport.send(notification).then(() => "resolved", () => "rejected");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const stringify = JSON.stringify;
    let serializationError: unknown;
    t.mock.method(JSON, "stringify", (value: unknown) => {
        try {
            return stringify(value);
        } catch (error) {
            serializationError = error;
            throw error;
        }
    });

    await assert.rejects(
        transport.send({ jsonrpc: "2.0", id: 1, result: circular }),
        (error) => error instanceof TypeError && error === serializationError,
    );

    assert.equal(socket.destroyed, true);
    assert.equal(errors[0], serializationError);
    assert.deepEqual(await Promise.all([first, second]), ["rejected", "rejected"]);
    assert.equal(socket.writes.length, 2, "failed serialization never reaches socket.write");
    const internals = transport as unknown as {
        pendingRequests: Set<string>;
        pendingWrites: Set<unknown>;
        pendingWriteBytes: number;
    };
    assert.equal(internals.pendingRequests.size, 0);
    assert.equal(internals.pendingWrites.size, 0);
    assert.equal(internals.pendingWriteBytes, 0);
});
