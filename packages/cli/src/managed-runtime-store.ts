import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverRuntimeOwnerRegistryPaths } from "./runtime-owner-path.js";

const MANAGED_RUNTIME_DIRECTORY = "mcp-runtime";
const LEASES_DIRECTORY = ".leases";
const LEASE_LOCK_FILE = ".leases.lock";
const MUTATION_LOCK_FILE = ".mutation.lock";
const RETIRED_DIRECTORY = ".retired";
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const METADATALESS_LOCK_STALE_MS = 30_000;

type ProcessIdentity = Readonly<{
    pid: number;
    bootId?: string;
    processStartTime?: string;
}>;

export type RuntimeUseLease = Readonly<{
    formatVersion: 1;
    leaseId: string;
    pid: number;
    bootId?: string;
    processStartTime?: string;
    runtimeRoot: string;
    acquiredAt: string;
}>;

type RuntimeOwnerRecord = Readonly<{
    pid: number;
    processStartTime?: string;
    satoriVersion: string;
}>;

type SharedRuntimeHostRecord = Readonly<{
    formatVersion: 1;
    hostPid: number;
    bootId: string;
    processStartTime: string;
    installedRuntimeRoot: string;
}>;

type ManagedRuntimeDirectory = Readonly<{
    root: string;
    version: string;
}>;

export type ManagedRuntimeRetentionResult = Readonly<{
    removedRuntimeRoots: readonly string[];
    warnings: readonly string[];
}>;

export interface ManagedRuntimeRetentionOptions {
    homeDir?: string;
    currentRuntimeRoot: string;
    env?: NodeJS.ProcessEnv;
    inspectProcess?: (pid: number) => ProcessIdentity | null;
    now?: () => number;
}

export interface ManagedRuntimeMutationLockOptions {
    homeDir?: string;
    inspectProcess?: (pid: number) => ProcessIdentity | null;
    now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBootId(): string | undefined {
    try {
        return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
    } catch {
        return undefined;
    }
}

function inspectProcessDefault(pid: number): ProcessIdentity | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return null;
    }
    try {
        process.kill(pid, 0);
    } catch {
        return null;
    }
    if (process.platform !== "linux") {
        return { pid };
    }
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const commandEnd = raw.lastIndexOf(")");
        if (commandEnd < 0) {
            return null;
        }
        const fieldsAfterCommand = raw.slice(commandEnd + 2).trim().split(/\s+/);
        const processStartTime = fieldsAfterCommand[19];
        if (!processStartTime) {
            return null;
        }
        const bootId = readBootId();
        return {
            pid,
            ...(bootId ? { bootId } : {}),
            processStartTime,
        };
    } catch {
        return null;
    }
}

function processIdentityMatches(
    expected: Pick<ProcessIdentity, "pid" | "bootId" | "processStartTime">,
    observed: ProcessIdentity | null,
): boolean {
    if (!observed || observed.pid !== expected.pid) {
        return false;
    }
    if (
        expected.processStartTime
        && observed.processStartTime
        && expected.processStartTime !== observed.processStartTime
    ) {
        return false;
    }
    if (expected.bootId && observed.bootId && expected.bootId !== observed.bootId) {
        return false;
    }
    return true;
}

function readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runtimeStorageRoot(homeDir: string): string {
    return path.join(homeDir, ".satori", MANAGED_RUNTIME_DIRECTORY);
}

function isDirectChild(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative.length > 0
        && !path.isAbsolute(relative)
        && !relative.startsWith(`..${path.sep}`)
        && relative !== ".."
        && !relative.includes(path.sep);
}

function inspectManagedRuntimeDirectory(
    storageRoot: string,
    candidateRoot: string,
): ManagedRuntimeDirectory | null {
    if (!isDirectChild(storageRoot, candidateRoot)) {
        return null;
    }
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(candidateRoot);
    } catch {
        return null;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return null;
    }
    const packageJsonPath = path.join(
        candidateRoot,
        "node_modules",
        "@satori-code",
        "mcp",
        "package.json",
    );
    try {
        const packageJson = readJson(packageJsonPath);
        if (
            !isRecord(packageJson)
            || packageJson.name !== "@satori-code/mcp"
            || typeof packageJson.version !== "string"
        ) {
            return null;
        }
        return {
            root: candidateRoot,
            version: packageJson.version,
        };
    } catch {
        return null;
    }
}

function managedRuntimeRootContaining(
    storageRoot: string,
    installedPackageRoot: string,
): string | null {
    const absolutePackageRoot = path.resolve(installedPackageRoot);
    const relative = path.relative(storageRoot, absolutePackageRoot);
    if (
        relative.length === 0
        || path.isAbsolute(relative)
        || relative === ".."
        || relative.startsWith(`..${path.sep}`)
    ) {
        return null;
    }
    const directoryName = relative.split(path.sep)[0];
    const candidateRoot = path.join(storageRoot, directoryName);
    return inspectManagedRuntimeDirectory(storageRoot, candidateRoot)?.root ?? null;
}

function parseRuntimeUseLease(value: unknown): RuntimeUseLease | null {
    if (
        !isRecord(value)
        || value.formatVersion !== 1
        || typeof value.leaseId !== "string"
        || !Number.isSafeInteger(value.pid)
        || Number(value.pid) <= 0
        || typeof value.runtimeRoot !== "string"
        || typeof value.acquiredAt !== "string"
    ) {
        return null;
    }
    return {
        formatVersion: 1,
        leaseId: value.leaseId,
        pid: Number(value.pid),
        ...(typeof value.bootId === "string" ? { bootId: value.bootId } : {}),
        ...(typeof value.processStartTime === "string"
            ? { processStartTime: value.processStartTime }
            : {}),
        runtimeRoot: value.runtimeRoot,
        acquiredAt: value.acquiredAt,
    };
}

function collectLeaseProtectedRoots(
    storageRoot: string,
    inspectProcess: (pid: number) => ProcessIdentity | null,
): { roots: Set<string>; leases: RuntimeUseLease[]; warnings: string[]; unsafe: boolean } {
    const leasesRoot = path.join(storageRoot, LEASES_DIRECTORY);
    const roots = new Set<string>();
    const leases: RuntimeUseLease[] = [];
    const warnings: string[] = [];
    if (!fs.existsSync(leasesRoot)) {
        return { roots, leases, warnings, unsafe: false };
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(leasesRoot, { withFileTypes: true });
    } catch (error) {
        return {
            roots,
            leases,
            warnings: [`Could not read managed runtime leases: ${error instanceof Error ? error.message : String(error)}`],
            unsafe: true,
        };
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
            continue;
        }
        const leasePath = path.join(leasesRoot, entry.name);
        let lease: RuntimeUseLease | null;
        try {
            lease = parseRuntimeUseLease(readJson(leasePath));
        } catch {
            lease = null;
        }
        if (!lease) {
            let oldEnoughToRecover: boolean;
            try {
                oldEnoughToRecover = Date.now() - fs.statSync(leasePath).mtimeMs >= METADATALESS_LOCK_STALE_MS;
            } catch {
                oldEnoughToRecover = true;
            }
            if (oldEnoughToRecover) {
                fs.rmSync(leasePath, { force: true });
                continue;
            }
            warnings.push(`Managed runtime lease is malformed at ${leasePath}.`);
            return { roots, leases, warnings, unsafe: true };
        }
        if (!processIdentityMatches(lease, inspectProcess(lease.pid))) {
            fs.rmSync(leasePath, { force: true });
            continue;
        }
        const managedRoot = managedRuntimeRootContaining(storageRoot, lease.runtimeRoot)
            ?? inspectManagedRuntimeDirectory(storageRoot, path.resolve(lease.runtimeRoot))?.root;
        if (!managedRoot) {
            warnings.push(`Live managed runtime lease points outside the runtime store: ${leasePath}.`);
            return { roots, leases, warnings, unsafe: true };
        }
        roots.add(managedRoot);
        leases.push(lease);
    }
    return { roots, leases, warnings, unsafe: false };
}

function collectLiveRuntimeOwnerVersions(
    homeDir: string,
    env: NodeJS.ProcessEnv,
    inspectProcess: (pid: number) => ProcessIdentity | null,
): { versions: Set<string>; warnings: string[]; unsafe: boolean } {
    const versions = new Set<string>();
    for (const ownersPath of discoverRuntimeOwnerRegistryPaths(homeDir, env)) {
        if (!fs.existsSync(ownersPath)) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = readJson(ownersPath);
        } catch (error) {
            return {
                versions,
                warnings: [`Could not read runtime-owner evidence at ${ownersPath}: ${error instanceof Error ? error.message : String(error)}`],
                unsafe: true,
            };
        }
        if (!isRecord(parsed) || parsed.formatVersion !== "v1" || !Array.isArray(parsed.owners)) {
            return {
                versions,
                warnings: [`Runtime-owner evidence is malformed at ${ownersPath}.`],
                unsafe: true,
            };
        }
        for (const value of parsed.owners) {
            if (
                !isRecord(value)
                || !Number.isSafeInteger(value.pid)
                || Number(value.pid) <= 0
                || typeof value.satoriVersion !== "string"
            ) {
                return {
                    versions,
                    warnings: [`Runtime-owner evidence contains an invalid owner at ${ownersPath}.`],
                    unsafe: true,
                };
            }
            const owner: RuntimeOwnerRecord = {
                pid: Number(value.pid),
                ...(typeof value.processStartTime === "string"
                    ? { processStartTime: value.processStartTime }
                    : {}),
                satoriVersion: value.satoriVersion,
            };
            if (processIdentityMatches(owner, inspectProcess(owner.pid))) {
                versions.add(owner.satoriVersion);
            }
        }
    }
    return { versions, warnings: [], unsafe: false };
}

function collectSharedRuntimeProtectedRoots(
    homeDir: string,
    storageRoot: string,
    inspectProcess: (pid: number) => ProcessIdentity | null,
): { roots: Set<string>; warnings: string[]; unsafe: boolean } {
    const hostsRoot = path.join(homeDir, ".satori", "runtime-host");
    const roots = new Set<string>();
    if (!fs.existsSync(hostsRoot)) {
        return { roots, warnings: [], unsafe: false };
    }
    let directories: fs.Dirent[];
    try {
        directories = fs.readdirSync(hostsRoot, { withFileTypes: true });
    } catch (error) {
        return {
            roots,
            warnings: [`Could not read shared runtime ownership: ${error instanceof Error ? error.message : String(error)}`],
            unsafe: true,
        };
    }
    for (const directory of directories) {
        if (!directory.isDirectory()) {
            continue;
        }
        const metadataPath = path.join(hostsRoot, directory.name, "host.json");
        if (!fs.existsSync(metadataPath)) {
            continue;
        }
        let value: unknown;
        try {
            value = readJson(metadataPath);
        } catch {
            value = null;
        }
        if (
            !isRecord(value)
            || value.formatVersion !== 1
            || !Number.isSafeInteger(value.hostPid)
            || Number(value.hostPid) <= 0
            || typeof value.bootId !== "string"
            || typeof value.processStartTime !== "string"
            || typeof value.installedRuntimeRoot !== "string"
        ) {
            return {
                roots,
                warnings: [`Shared runtime ownership is malformed at ${metadataPath}.`],
                unsafe: true,
            };
        }
        const host: SharedRuntimeHostRecord = {
            formatVersion: 1,
            hostPid: Number(value.hostPid),
            bootId: value.bootId,
            processStartTime: value.processStartTime,
            installedRuntimeRoot: value.installedRuntimeRoot,
        };
        if (!processIdentityMatches({
            pid: host.hostPid,
            bootId: host.bootId,
            processStartTime: host.processStartTime,
        }, inspectProcess(host.hostPid))) {
            continue;
        }
        const managedRoot = managedRuntimeRootContaining(storageRoot, host.installedRuntimeRoot);
        if (!managedRoot) {
            return {
                roots,
                warnings: [`Live shared runtime points outside the managed runtime store: ${metadataPath}.`],
                unsafe: true,
            };
        }
        roots.add(managedRoot);
    }
    return { roots, warnings: [], unsafe: false };
}

function sleepSync(milliseconds: number): void {
    const waitBuffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(waitBuffer), 0, 0, milliseconds);
}

function shouldRecoverLock(
    lockPath: string,
    value: unknown,
    inspectProcess: (pid: number) => ProcessIdentity | null,
    now: () => number,
): boolean {
    if (isRecord(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) {
        return !processIdentityMatches({
            pid: Number(value.pid),
            ...(typeof value.bootId === "string" ? { bootId: value.bootId } : {}),
            ...(typeof value.processStartTime === "string"
                ? { processStartTime: value.processStartTime }
                : {}),
        }, inspectProcess(Number(value.pid)));
    }
    try {
        return now() - fs.statSync(lockPath).mtimeMs >= METADATALESS_LOCK_STALE_MS;
    } catch {
        return true;
    }
}

function acquireStoreLock(
    storageRoot: string,
    lockFileName: string,
    inspectProcess: (pid: number) => ProcessIdentity | null,
    now: () => number,
): () => void {
    fs.mkdirSync(storageRoot, { recursive: true });
    const lockPath = path.join(storageRoot, lockFileName);
    const deadline = now() + LOCK_WAIT_MS;
    let lockFd: number | null = null;
    while (now() <= deadline) {
        try {
            const openedFd = fs.openSync(lockPath, "wx");
            const current = inspectProcess(process.pid) ?? { pid: process.pid };
            try {
                fs.writeFileSync(openedFd, JSON.stringify({
                    formatVersion: 1,
                    pid: current.pid,
                    ...(current.bootId ? { bootId: current.bootId } : {}),
                    ...(current.processStartTime
                        ? { processStartTime: current.processStartTime }
                        : {}),
                }));
            } catch (error) {
                fs.closeSync(openedFd);
                fs.rmSync(lockPath, { force: true });
                throw error;
            }
            lockFd = openedFd;
            break;
        } catch (error) {
            if (!isRecord(error) || error.code !== "EEXIST") {
                throw error;
            }
            let existing: unknown;
            try {
                existing = readJson(lockPath);
            } catch {
                existing = null;
            }
            if (shouldRecoverLock(lockPath, existing, inspectProcess, now)) {
                fs.rmSync(lockPath, { force: true });
                continue;
            }
            sleepSync(LOCK_RETRY_MS);
        }
    }
    if (lockFd === null) {
        throw new Error(`Timed out waiting for managed runtime lock ${lockFileName}.`);
    }
    return () => {
        fs.closeSync(lockFd);
        fs.rmSync(lockPath, { force: true });
    };
}

export function acquireManagedRuntimeLeaseLock(
    options: ManagedRuntimeMutationLockOptions = {},
): () => void {
    const homeDir = options.homeDir ?? os.homedir();
    const inspectProcess = options.inspectProcess ?? inspectProcessDefault;
    const now = options.now ?? (() => Date.now());
    return acquireStoreLock(
        runtimeStorageRoot(homeDir),
        LEASE_LOCK_FILE,
        inspectProcess,
        now,
    );
}

export function inspectManagedRuntimeLeases(
    options: ManagedRuntimeMutationLockOptions = {},
): Readonly<{
    leases: readonly RuntimeUseLease[];
    warnings: readonly string[];
    unsafe: boolean;
}> {
    const homeDir = options.homeDir ?? os.homedir();
    const storageRoot = runtimeStorageRoot(homeDir);
    if (!fs.existsSync(storageRoot)) {
        return { leases: [], warnings: [], unsafe: false };
    }
    const inspectProcess = options.inspectProcess ?? inspectProcessDefault;
    const result = collectLeaseProtectedRoots(storageRoot, inspectProcess);
    return {
        leases: result.leases,
        warnings: result.warnings,
        unsafe: result.unsafe,
    };
}

function withRetentionLock<T>(
    storageRoot: string,
    inspectProcess: (pid: number) => ProcessIdentity | null,
    now: () => number,
    operation: () => T,
): T {
    const release = acquireStoreLock(
        storageRoot,
        LEASE_LOCK_FILE,
        inspectProcess,
        now,
    );
    try {
        return operation();
    } finally {
        release();
    }
}

function listManagedRuntimeDirectories(storageRoot: string): ManagedRuntimeDirectory[] {
    return fs.readdirSync(storageRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => inspectManagedRuntimeDirectory(storageRoot, path.join(storageRoot, entry.name)))
        .filter((entry): entry is ManagedRuntimeDirectory => entry !== null);
}

function removeRetiredDirectories(retiredRoot: string, warnings: string[]): void {
    if (!fs.existsSync(retiredRoot)) {
        return;
    }
    for (const entry of fs.readdirSync(retiredRoot, { withFileTypes: true })) {
        const target = path.join(retiredRoot, entry.name);
        try {
            fs.rmSync(target, { recursive: true, force: true });
        } catch (error) {
            warnings.push(`Could not remove retired managed runtime ${target}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

export function pruneManagedRuntimeStore(
    options: ManagedRuntimeRetentionOptions,
): ManagedRuntimeRetentionResult {
    const homeDir = options.homeDir ?? os.homedir();
    const storageRoot = runtimeStorageRoot(homeDir);
    const inspectProcess = options.inspectProcess ?? inspectProcessDefault;
    const env = options.env ?? process.env;
    const now = options.now ?? (() => Date.now());
    if (!fs.existsSync(storageRoot)) {
        return { removedRuntimeRoots: [], warnings: [] };
    }

    const warnings: string[] = [];
    const stagedRemovals: Array<{ original: string; retired: string }> = [];
    try {
        withRetentionLock(storageRoot, inspectProcess, now, () => {
            const current = inspectManagedRuntimeDirectory(
                storageRoot,
                path.resolve(options.currentRuntimeRoot),
            );
            if (!current) {
                warnings.push("Current managed runtime is not a valid direct child of the runtime store; cleanup was skipped.");
                return;
            }
            const leaseEvidence = collectLeaseProtectedRoots(storageRoot, inspectProcess);
            const ownerEvidence = collectLiveRuntimeOwnerVersions(homeDir, env, inspectProcess);
            const hostEvidence = collectSharedRuntimeProtectedRoots(homeDir, storageRoot, inspectProcess);
            warnings.push(...leaseEvidence.warnings, ...ownerEvidence.warnings, ...hostEvidence.warnings);
            if (leaseEvidence.unsafe || ownerEvidence.unsafe || hostEvidence.unsafe) {
                return;
            }

            const protectedRoots = new Set<string>([
                current.root,
                ...leaseEvidence.roots,
                ...hostEvidence.roots,
            ]);
            const retiredRoot = path.join(storageRoot, RETIRED_DIRECTORY);
            fs.mkdirSync(retiredRoot, { recursive: true });
            for (const runtime of listManagedRuntimeDirectories(storageRoot)) {
                if (
                    protectedRoots.has(runtime.root)
                    || ownerEvidence.versions.has(runtime.version)
                ) {
                    continue;
                }
                const retiredPath = path.join(
                    retiredRoot,
                    `${path.basename(runtime.root)}-${crypto.randomUUID()}`,
                );
                fs.renameSync(runtime.root, retiredPath);
                stagedRemovals.push({ original: runtime.root, retired: retiredPath });
            }
        });
    } catch (error) {
        warnings.push(`Managed runtime cleanup was skipped: ${error instanceof Error ? error.message : String(error)}`);
    }

    const retiredRoot = path.join(storageRoot, RETIRED_DIRECTORY);
    removeRetiredDirectories(retiredRoot, warnings);
    try {
        if (fs.existsSync(retiredRoot) && fs.readdirSync(retiredRoot).length === 0) {
            fs.rmdirSync(retiredRoot);
        }
    } catch {
        // A later cleanup can remove the empty internal directory.
    }
    return {
        removedRuntimeRoots: stagedRemovals.map((entry) => entry.original),
        warnings,
    };
}

export function acquireManagedRuntimeMutationLock(
    options: ManagedRuntimeMutationLockOptions = {},
): () => void {
    const homeDir = options.homeDir ?? os.homedir();
    const inspectProcess = options.inspectProcess ?? inspectProcessDefault;
    const now = options.now ?? (() => Date.now());
    return acquireStoreLock(
        runtimeStorageRoot(homeDir),
        MUTATION_LOCK_FILE,
        inspectProcess,
        now,
    );
}
