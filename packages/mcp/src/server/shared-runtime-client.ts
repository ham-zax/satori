import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import {
    SHARED_RUNTIME_ATTACH_TIMEOUT_MS,
    SHARED_RUNTIME_HANDSHAKE_MAX_BYTES,
    SHARED_RUNTIME_PROTOCOL_VERSION,
    buildSharedRuntimeIdentity,
    isSharedOfflineRuntimeEligible,
    resolveSharedRuntimePaths,
} from "./shared-runtime-identity.js";
import {
    acquireLifecycleLock,
    isLinuxProcessIdentityLive,
    metadataMatchesIdentity,
    readHostMetadata,
    removeOwnedLifecycleState,
    type SharedRuntimeHostMetadata,
} from "./shared-runtime-lifecycle.js";
import { resolveAllowBroadRoots, resolveSessionWorkspaceRoots } from "./shared-runtime.js";

type AttachRequest = Readonly<{
    type: "satori-shared-runtime-attach";
    protocolVersion: number;
    sharedRuntimeIdentityHash: string;
    installedRuntimeRoot: string;
    mcpVersion: string;
    challengeNonce: string;
    workspaceRoots: readonly string[];
    allowBroadRoots: boolean;
}>;

type AttachResponse = Readonly<{
    type: "satori-shared-runtime-attached";
    accepted: boolean;
    protocolVersion: number;
    sharedRuntimeIdentityHash: string;
    installedRuntimeRoot: string;
    mcpVersion: string;
    hostPid: number;
    bootId: string;
    processStartTime: string;
    challengeNonce: string;
    error?: string;
}>;

export type SharedRuntimeClientOptions = Readonly<{
    runtimeEntry: string;
    env: NodeJS.ProcessEnv;
    stdin?: Readable;
    stdout?: Writable;
    stderr?: Writable;
    attachTimeoutMs?: number;
}>;

class SharedRuntimeAttachError extends Error {
    constructor(
        message: string,
        readonly code: "EHOSTUNREADY" | "EHOSTREJECTED",
    ) {
        super(message);
        this.name = "SharedRuntimeAttachError";
    }
}

function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function connectSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`Timed out connecting to Satori shared runtime at '${socketPath}'.`));
        }, timeoutMs);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function attach(
    socketPath: string,
    identity: ReturnType<typeof buildSharedRuntimeIdentity>,
    timeoutMs: number,
    workspaceRoots: readonly string[],
    allowBroadRoots: boolean,
    expectedHost?: SharedRuntimeHostMetadata,
): Promise<net.Socket> {
    const socket = await connectSocket(socketPath, timeoutMs);
    socket.pause();
    // Client-generated freshness/correlation challenge. The host echoes it
    // verbatim; the echo proves the live host answered this exact attach, not
    // that the launcher holds a secret. Same-UID processes are inside the
    // shared-runtime trust boundary, so no metadata-readable token could
    // authenticate against them anyway.
    const challengeNonce = crypto.randomBytes(24).toString("hex");
    const request: AttachRequest = Object.freeze({
        type: "satori-shared-runtime-attach",
        protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
        sharedRuntimeIdentityHash: identity.hash,
        installedRuntimeRoot: identity.installedRuntimeRoot,
        mcpVersion: identity.mcpVersion,
        challengeNonce,
        workspaceRoots,
        allowBroadRoots,
    });
    socket.write(`${JSON.stringify(request)}\n`);

    let response: AttachResponse;
    try {
        response = await new Promise<AttachResponse>((resolve, reject) => {
            let buffered = Buffer.alloc(0);
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("Timed out waiting for Satori shared runtime handshake."));
            }, timeoutMs);
            const cleanup = (): void => {
                clearTimeout(timer);
                socket.off("data", onData);
                socket.off("error", onError);
                socket.off("close", onClose);
            };
            const onError = (error: Error): void => {
                cleanup();
                reject(error);
            };
            const onClose = (): void => {
                cleanup();
                reject(new Error("Satori shared runtime closed before completing the handshake."));
            };
            const onData = (chunk: Buffer): void => {
                if (buffered.length + chunk.length > SHARED_RUNTIME_HANDSHAKE_MAX_BYTES) {
                    cleanup();
                    reject(new Error("Satori shared runtime handshake response exceeded its byte limit."));
                    return;
                }
                buffered = buffered.length === 0
                    ? Buffer.from(chunk)
                    : Buffer.concat([buffered, chunk]);
                const newline = buffered.indexOf(0x0a);
                if (newline < 0) return;
                const trailing = buffered.subarray(newline + 1);
                try {
                    const parsed = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as AttachResponse;
                    cleanup();
                    if (trailing.length > 0) socket.unshift(trailing);
                    resolve(parsed);
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            };
            socket.on("data", onData);
            socket.once("error", onError);
            socket.once("close", onClose);
            socket.resume();
        });
    } catch (error) {
        socket.destroy();
        throw error;
    }

    if (
        response.type !== "satori-shared-runtime-attached"
        || response.protocolVersion !== SHARED_RUNTIME_PROTOCOL_VERSION
        || response.sharedRuntimeIdentityHash !== identity.hash
        || response.installedRuntimeRoot !== identity.installedRuntimeRoot
        || response.mcpVersion !== identity.mcpVersion
    ) {
        socket.destroy();
        throw new SharedRuntimeAttachError(
            response.error || "Satori shared runtime returned an incompatible handshake.",
            "EHOSTREJECTED",
        );
    }
    if (response.accepted !== true) {
        socket.destroy();
        const message = response.error || "Satori shared runtime rejected the launcher identity.";
        throw new SharedRuntimeAttachError(
            message,
            message.includes("not accepting sessions")
                ? "EHOSTUNREADY"
                : "EHOSTREJECTED",
        );
    }
    if (
        response.challengeNonce !== challengeNonce
        || (expectedHost !== undefined && (
            response.hostPid !== expectedHost.hostPid
            || response.bootId !== expectedHost.bootId
            || response.processStartTime !== expectedHost.processStartTime
        ))
    ) {
        socket.destroy();
        throw new SharedRuntimeAttachError(
            "Satori shared runtime live process identity does not match its metadata.",
            "EHOSTREJECTED",
        );
    }
    socket.pause();
    return socket;
}

async function attachFromMetadata(
    identity: ReturnType<typeof buildSharedRuntimeIdentity>,
    metadataPath: string,
    timeoutMs: number,
    workspaceRoots: readonly string[],
    allowBroadRoots: boolean,
): Promise<net.Socket | null> {
    const metadata = readHostMetadata(metadataPath);
    if (!metadata) return null;
    if (!metadataMatchesIdentity(metadata, identity)) {
        throw new Error("Satori shared runtime metadata belongs to an incompatible runtime.");
    }
    if (!isLinuxProcessIdentityLive({
        pid: metadata.hostPid,
        bootId: metadata.bootId,
        startTime: metadata.processStartTime,
    })) {
        return null;
    }
    return attach(metadata.socketPath, identity, timeoutMs, workspaceRoots, allowBroadRoots, metadata);
}

function isTransientAttachError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EHOSTUNREADY"
        || code === "ECONNREFUSED"
        || code === "ENOENT"
        || code === "ECONNRESET";
}

async function waitForHostTransition(
    identity: ReturnType<typeof buildSharedRuntimeIdentity>,
    metadataPath: string,
    socketPath: string,
    timeoutMs: number,
    workspaceRoots: readonly string[],
    allowBroadRoots: boolean,
): Promise<net.Socket | null> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        const metadata = readHostMetadata(metadataPath);
        if (!metadata) {
            if (!fs.existsSync(socketPath)) return null;
            try {
                const unexpected = await attach(
                    socketPath,
                    identity,
                    Math.min(500, Math.max(1, deadline - Date.now())),
                    workspaceRoots,
                    allowBroadRoots,
                );
                unexpected.destroy();
                throw new Error(
                    "Satori shared runtime accepted a session before publishing lifecycle metadata.",
                );
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ECONNRESET") {
                    return null;
                }
                if (code !== "EHOSTUNREADY") throw error;
                lastError = error;
            }
        } else {
            if (!metadataMatchesIdentity(metadata, identity)) {
                throw new Error("Satori shared runtime metadata belongs to an incompatible runtime.");
            }
            if (!isLinuxProcessIdentityLive({
                pid: metadata.hostPid,
                bootId: metadata.bootId,
                startTime: metadata.processStartTime,
            })) {
                return null;
            }
            try {
                return await attach(
                    metadata.socketPath,
                    identity,
                    Math.min(500, Math.max(1, deadline - Date.now())),
                    workspaceRoots,
                    allowBroadRoots,
                    metadata,
                );
            } catch (error) {
                if (!isTransientAttachError(error)) throw error;
                lastError = error;
            }
        }
        await wait(25);
    }
    throw new Error(
        `Timed out waiting for the existing Satori shared runtime to finish starting or stopping.`
        + (lastError ? ` ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""),
    );
}

function startDetachedHost(
    runtimeEntry: string,
    identity: ReturnType<typeof buildSharedRuntimeIdentity>,
    env: NodeJS.ProcessEnv,
): void {
    const child = spawn(process.execPath, [runtimeEntry], {
        detached: true,
        stdio: "ignore",
        env: {
            ...env,
            SATORI_RUN_MODE: "host",
            SATORI_SHARED_RUNTIME_EXPECTED_HASH: identity.hash,
            SATORI_SHARED_RUNTIME_ENTRY: runtimeEntry,
            SATORI_SHARED_RUNTIME_ERROR_PATH: resolveSharedRuntimePaths(identity, env).errorPath,
        },
    });
    child.unref();
}

async function connectOrStart(options: SharedRuntimeClientOptions): Promise<net.Socket> {
    const timeoutMs = options.attachTimeoutMs ?? SHARED_RUNTIME_ATTACH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const identity = buildSharedRuntimeIdentity(options.runtimeEntry, options.env);
    const paths = resolveSharedRuntimePaths(identity, options.env);
    // The launcher captures its immutable workspace roots before connecting;
    // the host binds them to the session from the attach request, along with
    // the per-session broad-root opt-in. The flag stays out of the shared
    // runtime identity so one host can serve narrow and broad sessions.
    const workspaceRoots = resolveSessionWorkspaceRoots(options.env);
    const allowBroadRoots = resolveAllowBroadRoots(options.env);
    const remainingTime = (): number => Math.max(1, deadline - Date.now());

    for (;;) {
        let existing: net.Socket | null;
        try {
            existing = await attachFromMetadata(
                identity,
                paths.metadataPath,
                Math.min(500, remainingTime()),
                workspaceRoots,
                allowBroadRoots,
            );
        } catch (error) {
            if (!isTransientAttachError(error)) throw error;
            existing = await waitForHostTransition(
                identity,
                paths.metadataPath,
                paths.socketPath,
                remainingTime(),
                workspaceRoots,
                allowBroadRoots,
            );
        }
        if (existing) return existing;
        if (Date.now() >= deadline) {
            throw new Error("Timed out attaching to the Satori shared runtime.");
        }

        const lifecycleLock = await acquireLifecycleLock(paths.lockPath, remainingTime());
        try {
            let joined: net.Socket | null;
            try {
                joined = await attachFromMetadata(
                    identity,
                    paths.metadataPath,
                    Math.min(500, remainingTime()),
                    workspaceRoots,
                    allowBroadRoots,
                );
            } catch (error) {
                if (!isTransientAttachError(error)) throw error;
                // The existing host may already be waiting for this same lock
                // to finish shutdown. Release it before waiting for the
                // lifecycle transition, then re-enter through the outer
                // metadata/handshake proof.
                continue;
            }
            if (joined) return joined;

            const stale = readHostMetadata(paths.metadataPath);
            if (fs.existsSync(paths.metadataPath) && !stale) {
                throw new Error(
                    `Satori shared runtime metadata is malformed at '${paths.metadataPath}'. `
                    + "Run `satori doctor --verbose` before retrying.",
                );
            }
            if (stale && !isLinuxProcessIdentityLive({
                pid: stale.hostPid,
                bootId: stale.bootId,
                startTime: stale.processStartTime,
            })) {
                removeOwnedLifecycleState(paths, stale);
            }

            if (fs.existsSync(paths.socketPath)) {
                try {
                    return await attach(
                        paths.socketPath,
                        identity,
                        Math.min(500, remainingTime()),
                        workspaceRoots,
                        allowBroadRoots,
                    );
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "EHOSTUNREADY") {
                        // As above, never wait for shutdown while holding its
                        // lifecycle lock.
                        continue;
                    }
                    if (code !== "ECONNREFUSED" && code !== "ENOENT") {
                        throw error;
                    }
                    if (fs.existsSync(paths.socketPath)) {
                        const socket = fs.lstatSync(paths.socketPath);
                        if (!socket.isSocket()) {
                            throw new Error(
                                `Shared runtime path '${paths.socketPath}' is not a Unix-domain socket.`,
                            );
                        }
                        fs.unlinkSync(paths.socketPath);
                    }
                }
            }
            try {
                fs.unlinkSync(paths.errorPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            startDetachedHost(options.runtimeEntry, identity, options.env);
            let lastError: unknown = null;
            while (Date.now() < deadline) {
                try {
                    const connected = await attachFromMetadata(
                        identity,
                        paths.metadataPath,
                        Math.min(500, remainingTime()),
                        workspaceRoots,
                        allowBroadRoots,
                    );
                    if (connected) return connected;
                } catch (error) {
                    lastError = error;
                }
                await wait(25);
            }
            let startupDetail = "";
            try {
                const errorRecord = JSON.parse(fs.readFileSync(paths.errorPath, "utf8")) as {
                    message?: unknown;
                };
                if (typeof errorRecord.message === "string") {
                    startupDetail = ` Host startup failed: ${errorRecord.message}`;
                }
            } catch {
                // No bounded host diagnostic was published.
            }
            throw new Error(
                `Satori shared runtime did not become ready within ${timeoutMs}ms.`
                + startupDetail
                + (lastError
                    ? ` ${lastError instanceof Error ? lastError.message : String(lastError)}`
                    : ""),
            );
        } finally {
            lifecycleLock.release();
        }
    }
}

export async function runSharedRuntimeClient(options: SharedRuntimeClientOptions): Promise<void> {
    if (options.env.SATORI_RERANK_APPLICATION_MODE !== undefined) {
        throw new Error(
            "SATORI_RERANK_APPLICATION_MODE has been removed; unset it or roll back to the previous Satori release for legacy_rrf behavior.",
        );
    }
    if (!isSharedOfflineRuntimeEligible(options.env)) {
        throw new Error("Shared runtime client was invoked for an ineligible configuration.");
    }
    const input = options.stdin ?? process.stdin;
    const output = options.stdout ?? process.stdout;
    const socket = await connectOrStart(options);

    await new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (error?: Error): void => {
            if (finished) return;
            finished = true;
            input.unpipe(socket);
            socket.unpipe(output);
            if (error) reject(error);
            else resolve();
        };
        input.pipe(socket);
        socket.pipe(output);
        input.once("end", () => socket.end());
        input.once("error", (error) => {
            socket.destroy();
            finish(error);
        });
        socket.once("error", finish);
        socket.once("close", () => finish());
        socket.resume();
    });
}
