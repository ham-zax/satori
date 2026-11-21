import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Any `.stale-claim` or `.candidate` helper link older than this (or owned by a
// dead PID) was abandoned by a crashed contender and may be pruned so stale lock
// recovery can make progress.
const ABANDONED_LOCK_HELPER_MAX_AGE_MS = 5_000;

function isPidAliveForLockHelper(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function parseHelperLinkPid(fileName: string, lockBaseName: string): number | null {
    const prefix = `${lockBaseName}.`;
    if (!fileName.startsWith(prefix)) return null;
    if (!fileName.endsWith('.stale-claim') && !fileName.endsWith('.candidate')) return null;
    const rest = fileName.slice(prefix.length);
    const dotIndex = rest.indexOf('.');
    if (dotIndex <= 0) return null;
    const pid = Number(rest.slice(0, dotIndex));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function pruneAbandonedHelperLinksForInode(
    lockPath: string,
    targetInode: FileLockIdentity,
    ownClaimPath: string,
): void {
    const lockDir = path.dirname(lockPath);
    const lockBaseName = path.basename(lockPath);
    const ownClaimBaseName = path.basename(ownClaimPath);
    let entries: string[];
    try {
        entries = fs.readdirSync(lockDir);
    } catch {
        return;
    }
    const now = Date.now();
    for (const entry of entries) {
        if (entry === lockBaseName || entry === ownClaimBaseName) continue;
        const helperPid = parseHelperLinkPid(entry, lockBaseName);
        if (helperPid === null) continue;
        const helperPath = path.join(lockDir, entry);
        let helperStat: fs.Stats;
        try {
            helperStat = fs.lstatSync(helperPath);
        } catch {
            continue;
        }
        if (!sameFileLockIdentity(helperStat, targetInode)) continue;
        const abandoned = !isPidAliveForLockHelper(helperPid)
            || (now - helperStat.mtimeMs) > ABANDONED_LOCK_HELPER_MAX_AGE_MS;
        if (!abandoned) continue;
        try {
            fs.unlinkSync(helperPath);
        } catch {
            // Concurrent cleaner may have already removed this abandoned link.
        }
    }
}

export type FileLockIdentity = Readonly<{
    dev: number;
    ino: number;
}>;

export type LinuxProcessIdentity = Readonly<{
    pid: number;
    bootId: string;
    startTime: string;
}>;

export function sameFileLockIdentity(
    left: FileLockIdentity,
    right: FileLockIdentity,
): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

export function readLinuxBootId(): string | null {
    if (process.platform !== 'linux') return null;
    try {
        const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        return bootId.length > 0 ? bootId : null;
    } catch {
        return null;
    }
}

export function readLinuxProcessStartTime(pid = process.pid): string | null {
    if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) {
        return null;
    }
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const commandEnd = raw.lastIndexOf(')');
        if (commandEnd < 0) return null;
        const fieldsAfterCommand = raw.slice(commandEnd + 2).trim().split(/\s+/);
        const startTime = fieldsAfterCommand[19];
        return startTime && startTime.length > 0 ? startTime : null;
    } catch {
        return null;
    }
}

export function readLinuxProcessIdentity(pid = process.pid): LinuxProcessIdentity | null {
    const startTime = readLinuxProcessStartTime(pid);
    const bootId = readLinuxBootId();
    if (!startTime || !bootId) return null;
    return Object.freeze({
        pid,
        bootId,
        startTime,
    });
}

export function isLinuxProcessIdentityLive(
    identity: Readonly<{ pid: number; bootId?: string; startTime: string }>,
): boolean {
    const current = readLinuxProcessIdentity(identity.pid);
    if (!current || current.startTime !== identity.startTime) {
        return false;
    }
    if (identity.bootId !== undefined && current.bootId !== identity.bootId) {
        return false;
    }
    return true;
}

/**
 * Publishes a complete lock record atomically via a same-filesystem hard link,
 * eliminating the empty-file window of `open(O_EXCL) + write`.
 * Returns the published inode identity for safe ownership-verified release.
 */
export function publishAtomicFileLock(
    lockPath: string,
    content: string,
    mode = 0o600,
): FileLockIdentity {
    const candidatePath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.candidate`;
    let fd: number | null = null;
    try {
        fd = fs.openSync(candidatePath, 'wx', mode);
        fs.writeFileSync(fd, content, 'utf8');
        const stat = fs.fstatSync(fd);
        const identity: FileLockIdentity = Object.freeze({ dev: stat.dev, ino: stat.ino });
        fs.closeSync(fd);
        fd = null;
        fs.linkSync(candidatePath, lockPath);
        try {
            fs.unlinkSync(candidatePath);
        } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw cleanupError;
            }
        }
        return identity;
    } catch (error) {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch { /* Best-effort close. */ }
        }
        try {
            fs.unlinkSync(candidatePath);
        } catch {
            // Preserve the primary publication error (e.g., EEXIST).
        }
        throw error;
    }
}

/**
 * Safely reclaims a stale lock file without unlinking a replacement lock
 * created by a concurrent contender.
 *
 * Keeps a unique hard-link claim pinning the suspected stale inode until after
 * unlinking `lockPath`: any concurrent cleaner observes either a different
 * inode, no canonical lock, or `nlink > 2` and backs off.
 */
export function claimAndUnlinkStaleFileLock(
    lockPath: string,
    isStale: (claimPath: string, claimStat: fs.Stats) => boolean,
): boolean {
    const claimPath = `${lockPath}.${process.pid}.${crypto.randomUUID()}.stale-claim`;
    try {
        fs.linkSync(lockPath, claimPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return true;
        }
        throw error;
    }

    try {
        const claimStat = fs.lstatSync(claimPath);
        if (!isStale(claimPath, claimStat)) {
            return false;
        }

        let lockStat: fs.Stats;
        let currentClaimStat: fs.Stats;
        try {
            lockStat = fs.lstatSync(lockPath);
            currentClaimStat = fs.lstatSync(claimPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return true;
            }
            throw error;
        }
        if (!sameFileLockIdentity(lockStat, currentClaimStat)) {
            return false;
        }
        if (currentClaimStat.nlink > 2) {
            pruneAbandonedHelperLinksForInode(lockPath, currentClaimStat, claimPath);
            try {
                lockStat = fs.lstatSync(lockPath);
                currentClaimStat = fs.lstatSync(claimPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return true;
                }
                throw error;
            }
        }
        if (!sameFileLockIdentity(lockStat, currentClaimStat) || currentClaimStat.nlink !== 2) {
            return false;
        }

        try {
            fs.unlinkSync(lockPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        return true;
    } finally {
        try {
            fs.unlinkSync(claimPath);
        } catch {
            // The unique claim is non-authoritative after this attempt.
        }
    }
}

/**
 * Unlinks `lockPath` only if it still refers to the exact `(dev, ino)` inode
 * owned by this lock holder. Ignores `ENOENT` so release is idempotent.
 */
export function removeOwnedFileLockIfUnchanged(
    lockPath: string,
    expected: FileLockIdentity,
): boolean {
    let current: fs.Stats;
    try {
        current = fs.lstatSync(lockPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
    if (!sameFileLockIdentity(current, expected)) {
        return false;
    }
    try {
        fs.unlinkSync(lockPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
