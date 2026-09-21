import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
    POTION_DIMENSION,
    POTION_MODEL_ID,
    POTION_SEMANTIC_VERSION,
} from "@zokizuan/satori-core";
import {
    buildRuntimeIndexFingerprint,
    type ContextMcpConfig,
} from "../config.js";
import { SharedRuntimeHost } from "./shared-runtime.js";
import { createSessionWorkspacePolicy } from "../core/session-workspace-policy.js";
import { runSharedRuntimeClient } from "./shared-runtime-client.js";
import { SharedRuntimeSocketHost } from "./shared-runtime-host.js";
import { BoundedSocketTransport } from "./shared-runtime-transport.js";
import {
    SHARED_RUNTIME_MESSAGE_MAX_BYTES,
    SHARED_RUNTIME_PROTOCOL_VERSION,
    buildSharedRuntimeIdentity,
    resolveSharedRuntimePaths,
} from "./shared-runtime-identity.js";
import { readHostMetadata } from "./shared-runtime-lifecycle.js";

type JsonRpcResponse = {
    id?: unknown;
    error?: unknown;
    result?: {
        tools?: Array<{ name: string }>;
    };
};

function config(root: string): ContextMcpConfig {
    return {
        name: "satori-shared-host-test",
        version: "1.0.0",
        stateRoot: root,
        executionProfile: "offline",
        networkPolicy: { kind: "local-only" },
        vectorStoreProvider: "LanceDB",
        lanceDbPath: path.join(root, "lancedb"),
        encoderProvider: "Potion",
        encoderModel: `${POTION_MODEL_ID}+${POTION_SEMANTIC_VERSION}`,
        encoderOutputDimension: POTION_DIMENSION,
        potionHelperPath: path.join(root, "helper"),
        potionModelPath: path.join(root, "model"),
        potionRequestTimeoutMs: 5000,
        watchSyncEnabled: false,
    };
}

function env(root: string): NodeJS.ProcessEnv {
    return {
        SATORI_STATE_ROOT: root,
        XDG_RUNTIME_DIR: path.join(root, "xdg"),
        SATORI_RUNTIME_PROFILE: "offline",
        EMBEDDING_PROVIDER: "Potion",
        EMBEDDING_MODEL: POTION_MODEL_ID,
        EMBEDDING_OUTPUT_DIMENSION: String(POTION_DIMENSION),
        POTION_HELPER_PATH: path.join(root, "helper"),
        POTION_MODEL_PATH: path.join(root, "model"),
        POTION_REQUEST_TIMEOUT_MS: "5000",
        VECTOR_STORE_PROVIDER: "LanceDB",
        LANCEDB_PATH: path.join(root, "lancedb"),
        MCP_ENABLE_WATCHER: "false",
    };
}

async function createBridge(runtimeEntry: string, runtimeEnv: NodeJS.ProcessEnv) {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = new Map<number, (response: JsonRpcResponse) => void>();
    let buffer = "";
    output.on("data", (chunk) => {
        buffer += chunk.toString();
        for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const response = JSON.parse(line) as JsonRpcResponse;
            if (typeof response.id === "number") {
                pending.get(response.id)?.(response);
                pending.delete(response.id);
            }
        }
    });
    const running = runSharedRuntimeClient({
        runtimeEntry,
        env: runtimeEnv,
        stdin: input,
        stdout: output,
        attachTimeoutMs: 1_000,
    });
    let nextId = 1;
    const request = (method: string, params: Record<string, unknown> = {}) => {
        const id = nextId++;
        const response = new Promise<JsonRpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`request ${id} timed out`)), 1_000);
            pending.set(id, (value) => {
                clearTimeout(timer);
                resolve(value);
            });
        });
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        return response;
    };
    const initialized = await request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "shared-host-test", version: "1.0.0" },
    });
    assert.equal(initialized.error, undefined);
    input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
    })}\n`);
    return {
        request,
        close: async () => {
            input.end();
            await running;
            input.destroy();
            output.destroy();
        },
    };
}

async function sendHandshake(socketPath: string, payload: string): Promise<string> {
    const socket = net.createConnection({ path: socketPath });
    return new Promise((resolve, reject) => {
        let response = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("handshake test timed out"));
        }, 1_000);
        socket.on("data", (chunk) => {
            response += chunk.toString();
        });
        socket.once("connect", () => socket.write(payload));
        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.once("close", () => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

/** Resolves on the first complete response line, then closes the connection. */
async function sendHandshakeLine(socketPath: string, payload: string): Promise<string> {
    const socket = net.createConnection({ path: socketPath });
    return new Promise((resolve, reject) => {
        let response = "";
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("handshake line test timed out"));
        }, 1_000);
        socket.on("data", (chunk) => {
            response += chunk.toString();
            const newline = response.indexOf("\n");
            if (newline < 0) return;
            clearTimeout(timer);
            const line = response.slice(0, newline);
            socket.destroy();
            resolve(line);
        });
        socket.once("connect", () => socket.write(payload));
        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function sendOversizedJsonRpcFrame(
    socketPath: string,
    request: Record<string, unknown>,
): Promise<void> {
    const socket = net.createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
        let response = Buffer.alloc(0);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("oversized frame test timed out"));
        }, 2_000);
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk) => {
            response = response.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([response, chunk]);
            const newline = response.indexOf(0x0a);
            if (newline < 0) return;
            const attached = JSON.parse(response.subarray(0, newline).toString("utf8")) as {
                accepted?: boolean;
            };
            if (attached.accepted !== true) {
                clearTimeout(timer);
                socket.destroy();
                reject(new Error("host rejected the valid oversized-frame test handshake"));
                return;
            }
            socket.removeAllListeners("data");
            socket.write(Buffer.alloc(SHARED_RUNTIME_MESSAGE_MAX_BYTES + 1, 0x78));
        });
        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        socket.once("close", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

test("bounded socket transport applies its limit per JSON-RPC frame", async () => {
    const stream = new PassThrough();
    const messages: unknown[] = [];
    const transport = new BoundedSocketTransport(
        stream as unknown as net.Socket,
        () => {},
        undefined,
        48,
    );
    transport.onmessage = (message) => messages.push(message);
    await transport.start();

    const first = JSON.stringify({ jsonrpc: "2.0", method: "ping" });
    const second = JSON.stringify({ jsonrpc: "2.0", method: "pong" });
    assert.ok(Buffer.byteLength(first) < 48);
    assert.ok(Buffer.byteLength(second) < 48);
    assert.ok(Buffer.byteLength(`${first}\n${second}\n`) > 48);
    stream.write(`${first}\n${second}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(messages.length, 2);
    await transport.close();
});

test("bounded socket transport closes a session above its pending-request limit", async () => {
    const stream = new PassThrough();
    const messages: unknown[] = [];
    let transportError = "";
    const transport = new BoundedSocketTransport(
        stream as unknown as net.Socket,
        () => {},
        undefined,
        256,
        2,
    );
    transport.onmessage = (message) => messages.push(message);
    transport.onerror = (error) => {
        transportError = error.message;
    };
    await transport.start();

    stream.write([
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
        "",
    ].join("\n"));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(messages.length, 2);
    assert.match(transportError, /exceeds 2 pending requests/);
});

test("private socket host keeps MCP sessions independent and shares one runtime owner", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-host-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(
        runtimeHost,
        identity,
        paths,
        5_000,
    );
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const rejected = JSON.parse(await sendHandshake(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: "f".repeat(64),
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "a".repeat(48),
        workspaceRoots: [path.join(root, "workspace")],
    })}\n`)) as { accepted: boolean; error: string };
    assert.equal(rejected.accepted, false);
    assert.match(rejected.error, /identity does not match/);

    const protocolRejected = JSON.parse(await sendHandshake(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION + 1,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "a".repeat(48),
    })}\n`)) as { accepted: boolean; error: string };
    assert.equal(protocolRejected.accepted, false);
    assert.match(protocolRejected.error, /identity does not match/);

    const prematureMcp = JSON.parse(await sendHandshake(
        paths.socketPath,
        `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
        })}\n`,
    )) as { accepted: boolean; error: string };
    assert.equal(prematureMcp.accepted, false);
    assert.match(prematureMcp.error, /malformed/);

    const oversized = await sendHandshake(
        paths.socketPath,
        `${"x".repeat(16 * 1024 + 1)}\n`,
    );
    assert.match(oversized, /byte limit/);

    await sendOversizedJsonRpcFrame(paths.socketPath, {
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "b".repeat(48),
        workspaceRoots: [path.join(root, "workspace")],
    });
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 0, operations: 0 });

    const first = await createBridge(runtimeEntry, runtimeEnv);
    const alternateRuntimeDirectory = path.join(root, "alternate-xdg");
    fs.mkdirSync(alternateRuntimeDirectory, { mode: 0o700 });
    const second = await createBridge(runtimeEntry, {
        ...runtimeEnv,
        XDG_RUNTIME_DIR: alternateRuntimeDirectory,
    });
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 2, operations: 0 });

    const [firstTools, secondTools] = await Promise.all([
        first.request("tools/list"),
        second.request("tools/list"),
    ]);
    assert.equal(firstTools.result?.tools?.length, 9);
    assert.equal(secondTools.result?.tools?.length, 9);

    await first.close();
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 1, operations: 0 });
    assert.equal((await second.request("tools/list")).result?.tools?.length, 9);
    await second.close();
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 0, operations: 0 });
});

test("a stale SATORI_RERANK_APPLICATION_MODE blocks shared-runtime attach", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-host-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(
        runtimeHost,
        identity,
        paths,
        5_000,
    );
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const staleEnv = { ...runtimeEnv, SATORI_RERANK_APPLICATION_MODE: "legacy_rrf" };
    const input = new PassThrough();
    const output = new PassThrough();
    await assert.rejects(
        runSharedRuntimeClient({
            runtimeEntry,
            env: staleEnv,
            stdin: input,
            stdout: output,
            attachTimeoutMs: 1_000,
        }),
        /SATORI_RERANK_APPLICATION_MODE has been removed/,
    );
    // The compatible host is running, but the stale rollback variable must
    // prevent any attach: rejection happens at the trust boundary, before
    // identity resolution or socket connection.
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 0, operations: 0 });
    input.destroy();
    output.destroy();
});

test("protocol v2 echoes challengeNonce", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-nonce-echo-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const response = JSON.parse(await sendHandshakeLine(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "c".repeat(48),
        workspaceRoots: [path.join(root, "workspace")],
    })}\n`)) as { accepted: boolean; challengeNonce: string; error?: string };
    assert.equal(response.accepted, true, response.error);
    assert.equal(response.challengeNonce, "c".repeat(48));
});

test("protocol v1 is rejected", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-v1-reject-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    // A protocol-v1 launcher still sends the legacy launcherNonce field. The
    // host parses it so the version gate can reject the handshake with the
    // incompatible-runtime response rather than a malformed-message error.
    const response = JSON.parse(await sendHandshake(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: 1,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        launcherNonce: "a".repeat(48),
    })}\n`)) as { accepted: boolean; protocolVersion: number; error: string };
    assert.equal(response.accepted, false);
    assert.equal(response.protocolVersion, SHARED_RUNTIME_PROTOCOL_VERSION);
    assert.match(response.error, /identity does not match/);
});

test("protocol v2 rejects a legacy-only launcherNonce attach request", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-v2-legacy-only-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    // A v2 request carrying only the removed legacy field cannot derive a
    // challengeNonce, so parsing fails: malformed rejection, no session, no
    // compatibility fallback, no tool context.
    const response = JSON.parse(await sendHandshakeLine(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        launcherNonce: "0".repeat(48),
        workspaceRoots: [path.join(root, "workspace")],
    })}\n`)) as { accepted: boolean; error: string };
    assert.equal(response.accepted, false);
    assert.match(response.error, /malformed/);
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 0, operations: 0 });
});

test("protocol v2 rejects a request carrying the legacy launcherNonce alongside challengeNonce", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-v2-ambiguous-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    // Strict parsing: the legacy field is unknown in protocol v2, so a request
    // mixing both fields must be malformed rather than ambiguously parsed.
    const response = JSON.parse(await sendHandshakeLine(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "c".repeat(48),
        launcherNonce: "0".repeat(48),
        workspaceRoots: [path.join(root, "workspace")],
    })}\n`)) as { accepted: boolean; error: string };
    assert.equal(response.accepted, false);
    assert.match(response.error, /malformed/);
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 0, operations: 0 });
});

test("ownershipToken is not described as launcher authentication", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-token-role-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    // The handshake never transmits the token: an attach request carries only
    // the client-generated challenge, and the response echoes it without any
    // ownershipToken field. The token stays in host.json as a lifecycle-state
    // ownership marker (mode 0600) used only for cleanup bookkeeping.
    const response = JSON.parse(await sendHandshakeLine(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "d".repeat(48),
        workspaceRoots: [path.join(root, "workspace")],
    })}\n`)) as Record<string, unknown> & { accepted?: boolean; error?: string };
    assert.equal(response.accepted, true, String(response.error));
    assert.equal("ownershipToken" in response, false);
    assert.equal("token" in response, false);
    const metadata = readHostMetadata(paths.metadataPath);
    assert.ok(metadata);
    assert.equal(typeof metadata.ownershipToken, "string");
    assert.ok(metadata.ownershipToken.length > 0);
});

test("socket host shutdown closes active sessions before awaiting listener closure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-shutdown-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);

    try {
        await socketHost.start();
        const bridge = await createBridge(runtimeEntry, runtimeEnv);
        assert.deepEqual(runtimeHost.getActivity(), { sessions: 1, operations: 0 });

        await Promise.race([
            socketHost.shutdown(),
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error("socket host shutdown timed out")), 1_000);
            }),
        ]);
        await bridge.close().catch((error: NodeJS.ErrnoException) => {
            assert.equal(error.code, "ECONNRESET");
        });

        assert.equal(fs.existsSync(paths.metadataPath), false);
        assert.equal(fs.existsSync(paths.socketPath), false);
    } finally {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a new session cancels idle shutdown before listener closure", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-idle-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 100);
    await socketHost.start();
    let client: Awaited<ReturnType<typeof createBridge>> | undefined;
    t.after(async () => {
        await client?.close();
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    client = await createBridge(runtimeEntry, runtimeEnv);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await client.request("tools/list")).result?.tools?.length, 9);
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 1, operations: 0 });
});

test("a rejected handshake does not suppress idle shutdown", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-reject-idle-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 50);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const response = JSON.parse(await sendHandshake(
        paths.socketPath,
        `${JSON.stringify({ type: "wrong" })}\n`,
    )) as { accepted: boolean };
    assert.equal(response.accepted, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(paths.socketPath), false);
    assert.equal(fs.existsSync(paths.metadataPath), false);
});

test("host-owned operation activity resets idle shutdown until the operation completes", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-active-idle-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 50);
    await socketHost.start();
    t.after(async () => {
        runtimeHost.endOperation();
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    runtimeHost.beginOperation();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(paths.socketPath), true);
    assert.equal(fs.existsSync(paths.metadataPath), true);

    runtimeHost.endOperation();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(paths.socketPath), false);
    assert.equal(fs.existsSync(paths.metadataPath), false);
});

test("host startup failure closes its listener and shared runtime authorities", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-start-failure-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    fs.mkdirSync(paths.metadataPath);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 50);
    t.after(() => {
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    await assert.rejects(socketHost.start());
    assert.equal(fs.existsSync(paths.socketPath), false);
    const boundPolicy = createSessionWorkspacePolicy({
        roots: [path.join(root, "workspace")],
        homeDirectory: os.homedir(),
        stateRoot: root,
    });
    assert.throws(() => runtimeHost.createSession(boundPolicy), /shutting down/);
});

test("attach with more than 16 workspace roots is rejected", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-too-many-roots-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const tooManyRoots = Array.from({ length: 17 }, (_, index) => (
        path.join(root, `workspace-${index}`)
    ));
    const response = JSON.parse(await sendHandshake(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "e".repeat(48),
        workspaceRoots: tooManyRoots,
    })}\n`)) as { accepted: boolean; error: string };
    assert.equal(response.accepted, false);
    assert.match(response.error, /malformed/);
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 0, operations: 0 });
});

test("attach with a broad workspace root is rejected", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "satori-shared-broad-root-"));
    fs.mkdirSync(path.join(root, "xdg"), { mode: 0o700 });
    const previousStateRoot = process.env.SATORI_STATE_ROOT;
    process.env.SATORI_STATE_ROOT = root;
    const runtimeEntry = path.resolve("dist/index.js");
    const runtimeEnv = env(root);
    const identity = buildSharedRuntimeIdentity(runtimeEntry, runtimeEnv);
    const runtimeConfig = config(root);
    const runtimeHost = new SharedRuntimeHost(
        runtimeConfig,
        buildRuntimeIndexFingerprint(runtimeConfig, POTION_DIMENSION),
        "host",
    );
    const paths = resolveSharedRuntimePaths(identity, runtimeEnv);
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths, 5_000);
    await socketHost.start();
    t.after(async () => {
        await socketHost.shutdown();
        if (previousStateRoot === undefined) delete process.env.SATORI_STATE_ROOT;
        else process.env.SATORI_STATE_ROOT = previousStateRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });

    const response = JSON.parse(await sendHandshake(paths.socketPath, `${JSON.stringify({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce: "f".repeat(48),
        workspaceRoots: [path.sep],
    })}\n`)) as { accepted: boolean; error: string };
    assert.equal(response.accepted, false);
    assert.match(response.error, /not authorized/);
    assert.deepEqual(runtimeHost.getActivity(), { sessions: 0, operations: 0 });
});
