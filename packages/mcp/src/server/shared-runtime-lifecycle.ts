import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    claimAndUnlinkStaleFileLock,
    isLinuxProcessIdentityLive,
    publishAtomicFileLock,
    readLinuxProcessIdentity,
    removeOwnedFileLockIfUnchanged,
    type LinuxProcessIdentity,
} from "@satori-code/core/file-lock";
import {
    SHARED_RUNTIME_PROTOCOL_VERSION,
    type SharedRuntimeIdentity,
    type SharedRuntimePaths,
} from "./shared-runtime-identity.js";

export {
    isLinuxProcessIdentityLive,
    readLinuxProcessIdentity,
    type LinuxProcessIdentity,
};

export type SharedRuntimeHostMetadata = Readonly<{
    formatVersion: 1;
    protocolVersion: number;
    hostPid: number;
    bootId: string;
    processStartTime: string;
    mcpVersion: string;
    sharedRuntimeIdentityHash: string;
    installedRuntimeRoot: string;
    /** Lifecycle-state ownership marker only; never used to authenticate launcher attach sessions. */
    ownershipToken: string;
    socketPath: string;
    socketDevice: number;
    socketInode: number;
    readyAt: string;
}>;

type LifecycleLockRecord = Readonly<{
    formatVersion: 1;
    pid: number;
    bootId: string;
    processStartTime: string;
    ownershipToken: string;
    acquiredAt: string;
}>;

export type LifecycleLock = Readonly<{
    ownershipToken: string;
    release(): void;
}>;

function parseRecord(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function readHostMetadata(metadataPath: string): SharedRuntimeHostMetadata | null {
    try {
        const record = parseRecord(fs.readFileSync(metadataPath, "utf8"));
        if (
            !record
            || record.formatVersion !== 1
            || record.protocolVersion !== SHARED_RUNTIME_PROTOCOL_VERSION
            || typeof record.hostPid !== "number"
            || typeof record.bootId !== "string"
            || typeof record.processStartTime !== "string"
            || typeof record.mcpVersion !== "string"
            || typeof record.sharedRuntimeIdentityHash !== "string"
            || typeof record.installedRuntimeRoot !== "string"
            || typeof record.ownershipToken !== "string"
            || typeof record.socketPath !== "string"
            || typeof record.socketDevice !== "number"
            || typeof record.socketInode !== "number"
            || typeof record.readyAt !== "string"
        ) {
            return null;
        }
        return Object.freeze(record as unknown as SharedRuntimeHostMetadata);
    } catch {
        return null;
    }
}

export function writeHostMetadataAtomic(
    metadataPath: string,
    metadata: SharedRuntimeHostMetadata,
): void {
    const temporary = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    fs.renameSync(temporary, metadataPath);
}

function readLockRecord(lockPath: string): LifecycleLockRecord | null {
    try {
        const record = parseRecord(fs.readFileSync(lockPath, "utf8"));
        if (
            !record
            || record.formatVersion !== 1
            || typeof record.pid !== "number"
            || typeof record.bootId !== "string"
            || typeof record.processStartTime !== "string"
            || typeof record.ownershipToken !== "string"
            || typeof record.acquiredAt !== "string"
        ) {
            return null;
        }
        return Object.freeze(record as unknown as LifecycleLockRecord);
    } catch {
        return null;
    }
}

function removeStaleLockWithoutReplacingNewOwner(lockPath: string): boolean {
    return claimAndUnlinkStaleFileLock(lockPath, (claimPath) => {
        const claimedOwner = readLockRecord(claimPath);
        return !(
            claimedOwner
            && isLinuxProcessIdentityLive({
                pid: claimedOwner.pid,
                bootId: claimedOwner.bootId,
                startTime: claimedOwner.processStartTime,
            })
        );
    });
}

function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function acquireLifecycleLock(
    lockPath: string,
    timeoutMs = 10_000,
): Promise<LifecycleLock> {
    const current = readLinuxProcessIdentity();
    if (!current) {
        throw new Error("Cannot establish Linux process identity for shared runtime lifecycle lock.");
    }
    const ownershipToken = crypto.randomUUID();
    const record: LifecycleLockRecord = Object.freeze({
        formatVersion: 1,
        pid: current.pid,
        bootId: current.bootId,
        processStartTime: current.startTime,
        ownershipToken,
        acquiredAt: new Date().toISOString(),
    });
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        try {
            const lockIdentity = publishAtomicFileLock(
                lockPath,
                `${JSON.stringify(record)}\n`,
                0o600,
            );
            let released = false;
            return Object.freeze({
                ownershipToken,
                release(): void {
                    if (released) return;
                    released = true;
                    removeOwnedFileLockIfUnchanged(lockPath, lockIdentity);
                },
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") throw error;
        }

        const owner = readLockRecord(lockPath);
        const ownerLive = owner
            ? isLinuxProcessIdentityLive({
                pid: owner.pid,
                bootId: owner.bootId,
                startTime: owner.processStartTime,
            })
            : false;
        if (!ownerLive && removeStaleLockWithoutReplacingNewOwner(lockPath)) {
            continue;
        }
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for shared runtime lifecycle lock '${lockPath}'.`);
        }
        await wait(25);
    }
}

export function metadataMatchesIdentity(
    metadata: SharedRuntimeHostMetadata,
    identity: SharedRuntimeIdentity,
): boolean {
    return metadata.sharedRuntimeIdentityHash === identity.hash
        && metadata.mcpVersion === identity.mcpVersion
        && path.resolve(metadata.installedRuntimeRoot) === path.resolve(identity.installedRuntimeRoot);
}

export function removeOwnedLifecycleState(
    paths: SharedRuntimePaths,
    expected: Pick<
        SharedRuntimeHostMetadata,
        "hostPid" | "bootId" | "processStartTime" | "ownershipToken"
        | "sharedRuntimeIdentityHash" | "socketPath" | "socketDevice" | "socketInode"
    >,
): void {
    const current = readHostMetadata(paths.metadataPath);
    if (
        !current
        || current.hostPid !== expected.hostPid
        || current.bootId !== expected.bootId
        || current.processStartTime !== expected.processStartTime
        || current.ownershipToken !== expected.ownershipToken
        || current.sharedRuntimeIdentityHash !== expected.sharedRuntimeIdentityHash
        || current.socketPath !== expected.socketPath
        || current.socketDevice !== expected.socketDevice
        || current.socketInode !== expected.socketInode
    ) {
        return;
    }

    try {
        const socket = fs.lstatSync(expected.socketPath);
        if (
            socket.isSocket()
            && socket.dev === expected.socketDevice
            && socket.ino === expected.socketInode
        ) {
            fs.unlinkSync(expected.socketPath);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stillCurrent = readHostMetadata(paths.metadataPath);
    if (stillCurrent?.ownershipToken === expected.ownershipToken) {
        fs.unlinkSync(paths.metadataPath);
    }
}
