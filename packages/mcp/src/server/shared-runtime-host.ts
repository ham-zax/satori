import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
    createMcpConfig,
    resolveMcpRuntimeBootstrap,
} from "../config.js";
import {
    WorkspaceAuthorizationError,
    createSessionWorkspacePolicy,
    type SessionWorkspacePolicy,
} from "../core/session-workspace-policy.js";
import {
    SHARED_RUNTIME_HANDSHAKE_MAX_BYTES,
    SHARED_RUNTIME_IDLE_MS,
    SHARED_RUNTIME_PROTOCOL_VERSION,
    buildSharedRuntimeIdentity,
    isSharedOfflineRuntimeEligible,
    resolveSharedRuntimePaths,
    type SharedRuntimeIdentity,
    type SharedRuntimePaths,
} from "./shared-runtime-identity.js";
import {
    acquireLifecycleLock,
    readHostMetadata,
    readLinuxProcessIdentity,
    removeOwnedLifecycleState,
    writeHostMetadataAtomic,
    type SharedRuntimeHostMetadata,
} from "./shared-runtime-lifecycle.js";
import { SharedRuntimeHost, type McpSession } from "./shared-runtime.js";
import { BoundedSocketTransport } from "./shared-runtime-transport.js";

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

function isAbsolutePathArray(value: unknown): value is readonly string[] {
    return Array.isArray(value)
        && value.length >= 1
        && value.length <= 16
        && value.every((entry) => typeof entry === "string" && path.isAbsolute(entry));
}

function parseAttachRequest(line: string): AttachRequest | null {
    try {
        const value = JSON.parse(line) as Partial<AttachRequest> & {
            launcherNonce?: unknown;
        };
        // Protocol v1 launchers send the legacy `launcherNonce` field. The host
        // accepts it during parsing so the protocol-version gate below can
        // reject v1 handshakes with the incompatible-runtime response instead
        // of a malformed-message error. Protocol v2 requires `challengeNonce`.
        const challengeNonce = typeof value.challengeNonce === "string"
            ? value.challengeNonce
            : value.protocolVersion === 1 && typeof value.launcherNonce === "string"
                ? value.launcherNonce
                : "";
        // Strict parsing: the legacy `launcherNonce` field is unknown in the
        // current protocol version. A v2 request carrying it (with or without
        // challengeNonce) is malformed, never ambiguously parsed.
        if (
            value.protocolVersion === SHARED_RUNTIME_PROTOCOL_VERSION
            && value.launcherNonce !== undefined
        ) {
            return null;
        }
        if (
            value.type !== "satori-shared-runtime-attach"
            || typeof value.protocolVersion !== "number"
            || typeof value.sharedRuntimeIdentityHash !== "string"
            || typeof value.installedRuntimeRoot !== "string"
            || typeof value.mcpVersion !== "string"
            || !/^[a-f0-9]{48}$/.test(challengeNonce)
        ) {
            return null;
        }
        // Protocol v2 carries the launcher's immutable workspace roots; shape
        // is validated here (absolute strings, 1-16), and the session policy
        // is constructed after identity checks so broad or unauthorized roots
        // reject the attach with a stable message, unless the launcher's
        // per-session SATORI_ALLOW_BROAD_ROOTS=true opt-in is present. The
        // flag is optional so older launchers stay compatible (absent=false,
        // fail closed); a non-boolean value never opts in.
        if (
            value.protocolVersion === SHARED_RUNTIME_PROTOCOL_VERSION
            && !isAbsolutePathArray(value.workspaceRoots)
        ) {
            return null;
        }
        return Object.freeze({
            type: "satori-shared-runtime-attach",
            protocolVersion: value.protocolVersion,
            sharedRuntimeIdentityHash: value.sharedRuntimeIdentityHash,
            installedRuntimeRoot: value.installedRuntimeRoot,
            mcpVersion: value.mcpVersion,
            challengeNonce,
            workspaceRoots: value.protocolVersion === SHARED_RUNTIME_PROTOCOL_VERSION
                ? value.workspaceRoots
                : [],
            allowBroadRoots: value.allowBroadRoots === true,
        } as AttachRequest);
    } catch {
        return null;
    }
}

export class SharedRuntimeSocketHost {
    private readonly server: net.Server;
    private readonly sessions = new Set<McpSession>();
    /**
     * Lifecycle-state ownership marker only. Written to host.json (mode 0600)
     * so the owning host can prove it may remove stale socket/metadata state.
     * It is never transmitted over the socket and never used to authenticate
     * launcher attach sessions: same-UID processes are inside the shared
     * runtime trust boundary, so a metadata-readable token cannot serve as
     * an authentication secret.
     */
    private readonly ownershipToken = crypto.randomUUID();
    private metadata: SharedRuntimeHostMetadata | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private closing = false;
    private readonly unsubscribeActivity: () => void;

    constructor(
        private readonly runtimeHost: SharedRuntimeHost,
        private readonly identity: SharedRuntimeIdentity,
        private readonly paths: SharedRuntimePaths,
        private readonly idleMs = SHARED_RUNTIME_IDLE_MS,
    ) {
        this.server = net.createServer({ pauseOnConnect: true }, (socket) => {
            this.cancelIdleShutdown();
            this.acceptHandshake(socket);
        });
        this.unsubscribeActivity = this.runtimeHost.subscribeActivity(() => {
            const activity = this.runtimeHost.getActivity();
            if (activity.sessions > 0 || activity.operations > 0) {
                this.cancelIdleShutdown();
            } else {
                this.scheduleIdleShutdown();
            }
        });
    }

    async start(): Promise<void> {
        let boundSocket: Readonly<{ device: number; inode: number }> | null = null;
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => {
                    this.server.off("listening", onListening);
                    reject(error);
                };
                const onListening = (): void => {
                    this.server.off("error", onError);
                    resolve();
                };
                this.server.once("error", onError);
                this.server.once("listening", onListening);
                this.server.listen(this.paths.socketPath);
            });
            const socketStat = fs.lstatSync(this.paths.socketPath);
            boundSocket = Object.freeze({
                device: socketStat.dev,
                inode: socketStat.ino,
            });
            fs.chmodSync(this.paths.socketPath, 0o600);
            const processIdentity = readLinuxProcessIdentity();
            if (!processIdentity) {
                throw new Error("Cannot establish shared runtime host process identity.");
            }
            this.metadata = Object.freeze({
                formatVersion: 1,
                protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
                hostPid: processIdentity.pid,
                bootId: processIdentity.bootId,
                processStartTime: processIdentity.startTime,
                mcpVersion: this.identity.mcpVersion,
                sharedRuntimeIdentityHash: this.identity.hash,
                installedRuntimeRoot: this.identity.installedRuntimeRoot,
                ownershipToken: this.ownershipToken,
                socketPath: this.paths.socketPath,
                socketDevice: socketStat.dev,
                socketInode: socketStat.ino,
                readyAt: new Date().toISOString(),
            });
            writeHostMetadataAtomic(this.paths.metadataPath, this.metadata);
            try {
                fs.unlinkSync(this.paths.errorPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            this.scheduleIdleShutdown();
        } catch (error) {
            this.closing = true;
            if (this.server.listening) {
                await new Promise<void>((resolve) => {
                    this.server.close(() => resolve());
                });
            }
            if (boundSocket) {
                try {
                    const current = fs.lstatSync(this.paths.socketPath);
                    if (
                        current.isSocket()
                        && current.dev === boundSocket.device
                        && current.ino === boundSocket.inode
                    ) {
                        fs.unlinkSync(this.paths.socketPath);
                    }
                } catch {
                    // The launcher owns stale-path recovery. Startup cleanup
                    // must still release provider and runtime-owner state.
                }
            }
            this.unsubscribeActivity();
            await this.runtimeHost.shutdown().catch(() => undefined);
            throw error;
        }
    }

    private acceptHandshake(socket: net.Socket): void {
        let buffered = Buffer.alloc(0);
        const timer = setTimeout(() => {
            cleanup();
            socket.destroy();
            this.scheduleIdleShutdown();
        }, 10_000);
        const cleanup = (): void => {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
        };
        const onError = (): void => {
            cleanup();
            this.scheduleIdleShutdown();
        };
        const onClose = (): void => {
            cleanup();
            this.scheduleIdleShutdown();
        };
        const reject = (message: string): void => {
            const response = {
                type: "satori-shared-runtime-attached",
                accepted: false,
                protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
                sharedRuntimeIdentityHash: this.identity.hash,
                installedRuntimeRoot: this.identity.installedRuntimeRoot,
                mcpVersion: this.identity.mcpVersion,
                hostPid: process.pid,
                bootId: this.metadata?.bootId ?? "",
                processStartTime: this.metadata?.processStartTime ?? "",
                challengeNonce: "",
                error: message,
            };
            socket.once("error", () => {
                // A rejected peer owns no session state.
            });
            socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
            this.scheduleIdleShutdown();
        };
        const onData = (chunk: Buffer): void => {
            if (buffered.length + chunk.length > SHARED_RUNTIME_HANDSHAKE_MAX_BYTES) {
                cleanup();
                reject("Attach handshake exceeded its byte limit.");
                return;
            }
            buffered = buffered.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([buffered, chunk]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) return;
            cleanup();
            const request = parseAttachRequest(
                buffered.subarray(0, newline).toString("utf8"),
            );
            const trailing = buffered.subarray(newline + 1);
            if (!request) {
                reject("Attach handshake is malformed.");
                return;
            }
            if (
                request.protocolVersion !== SHARED_RUNTIME_PROTOCOL_VERSION
                || request.sharedRuntimeIdentityHash !== this.identity.hash
                || request.installedRuntimeRoot !== this.identity.installedRuntimeRoot
                || request.mcpVersion !== this.identity.mcpVersion
            ) {
                reject("Attach handshake runtime identity does not match this host.");
                return;
            }
            if (!this.metadata || this.closing) {
                reject("Shared runtime host is not accepting sessions.");
                return;
            }
            let workspacePolicy: SessionWorkspacePolicy;
            try {
                workspacePolicy = createSessionWorkspacePolicy({
                    roots: request.workspaceRoots,
                    homeDirectory: os.homedir(),
                    stateRoot: this.identity.stateRoot,
                    allowBroadRoots: request.allowBroadRoots,
                });
            } catch (error) {
                const reason = error instanceof WorkspaceAuthorizationError
                    ? error.message
                    : error instanceof Error
                        ? error.message
                        : String(error);
                reject(`Attach handshake workspace roots are not authorized: ${reason}`);
                return;
            }
            const response = {
                type: "satori-shared-runtime-attached",
                accepted: true,
                protocolVersion: SHARED_RUNTIME_PROTOCOL_VERSION,
                sharedRuntimeIdentityHash: this.identity.hash,
                installedRuntimeRoot: this.identity.installedRuntimeRoot,
                mcpVersion: this.identity.mcpVersion,
                hostPid: this.metadata.hostPid,
                bootId: this.metadata.bootId,
                processStartTime: this.metadata.processStartTime,
                // The challenge is echoed as a freshness/correlation value only.
                // The socket's 0600 mode and owned directories enforce an
                // OS-user boundary; within the same UID, every process is
                // trusted by this release's shared-runtime model.
                challengeNonce: request.challengeNonce,
            };
            socket.write(`${JSON.stringify(response)}\n`);
            void this.attachSession(socket, trailing, workspacePolicy).catch(() => {
                socket.destroy();
                this.scheduleIdleShutdown();
            });
        };
        socket.on("data", onData);
        socket.once("error", onError);
        socket.once("close", onClose);
        socket.resume();
    }

    private async attachSession(
        socket: net.Socket,
        trailing: Buffer,
        workspacePolicy: SessionWorkspacePolicy,
    ): Promise<void> {
        if (this.closing) {
            socket.destroy();
            return;
        }
        const session = this.runtimeHost.createSession(workspacePolicy);
        let released = false;
        const release = (): void => {
            if (released) return;
            released = true;
            this.sessions.delete(session);
            void session.shutdown().finally(() => this.scheduleIdleShutdown());
        };
        const transport = new BoundedSocketTransport(socket, release, trailing);
        this.sessions.add(session);
        try {
            await session.connect(transport);
        } catch (error) {
            this.sessions.delete(session);
            socket.destroy();
            await session.shutdown();
            this.scheduleIdleShutdown();
            throw error;
        }
    }

    private cancelIdleShutdown(): void {
        if (!this.idleTimer) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    private scheduleIdleShutdown(): void {
        if (this.closing || this.sessions.size > 0 || this.idleTimer) return;
        const activity = this.runtimeHost.getActivity();
        if (activity.sessions > 0 || activity.operations > 0) return;
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            void this.shutdown({ onlyIfIdle: true });
        }, this.idleMs);
        this.idleTimer.unref?.();
    }

    async shutdown(options: { onlyIfIdle?: boolean } = {}): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        this.cancelIdleShutdown();

        const lock = await acquireLifecycleLock(this.paths.lockPath);
        try {
            if (options.onlyIfIdle && this.runtimeHost.getActivity().operations > 0) {
                this.closing = false;
                this.scheduleIdleShutdown();
                return;
            }
            const serverClosed = new Promise<void>((resolve) => {
                this.server.close(() => resolve());
            });
            await Promise.all([...this.sessions].map((session) => session.shutdown()));
            this.sessions.clear();
            await serverClosed;
            await this.runtimeHost.shutdown();
            this.unsubscribeActivity();
            if (this.metadata) {
                removeOwnedLifecycleState(this.paths, this.metadata);
            }
        } finally {
            lock.release();
        }
    }
}

export async function startSharedRuntimeHostFromEnv(): Promise<SharedRuntimeSocketHost> {
    const runtimeEntry = process.env.SATORI_SHARED_RUNTIME_ENTRY
        ?? process.argv[1];
    if (!runtimeEntry) {
        throw new Error("Shared runtime host requires its installed runtime entry path.");
    }
    if (!isSharedOfflineRuntimeEligible(process.env)) {
        throw new Error("Shared runtime host requires managed offline Potion + LanceDB configuration.");
    }
    const identity = buildSharedRuntimeIdentity(runtimeEntry, process.env);
    if (process.env.SATORI_SHARED_RUNTIME_EXPECTED_HASH !== identity.hash) {
        throw new Error("Shared runtime host identity differs from the starting launcher.");
    }
    const paths = resolveSharedRuntimePaths(identity, process.env);
    const existing = readHostMetadata(paths.metadataPath);
    if (existing) {
        throw new Error("Shared runtime host metadata already exists; launcher recovery must resolve it.");
    }

    const parsedConfig = createMcpConfig();
    const { config, runtimeFingerprint } = await resolveMcpRuntimeBootstrap(parsedConfig);
    const runtimeHost = new SharedRuntimeHost(config, runtimeFingerprint, "host");
    const socketHost = new SharedRuntimeSocketHost(runtimeHost, identity, paths);
    await socketHost.start();
    return socketHost;
}
