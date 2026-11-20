import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
    readManagedRuntimeEnvironment,
    runtimeEnvironmentWithManagedFallbacks,
} from "./client-config-inspection.js";
import { resolveLanceDbPath } from "./install-preflight.js";
import { resolveSatoriStateRoot } from "./local-runtime-contract.js";
import { parseManagedLauncherDescriptor } from "./managed-launcher-script.mjs";
import { resolveLauncherPath } from "./managed-runtime-paths.js";
import { pruneManagedRuntimeStore } from "./managed-runtime-store.js";
import { selectedVectorStore } from "./runtime-config.js";
import { discoverRuntimeOwnerRegistryPaths } from "./runtime-owner-path.js";
import {
    DEFAULT_MAX_STORAGE_GIB,
    DEFAULT_WORKTREE_IDLE_DAYS,
    runPublicationStorageMaintenance,
    type StorageBreakdown,
    type StorageMaintenanceResult,
} from "./storage-maintenance.cjs";

interface GcMutationLeasePort {
    isRootMutationActive(canonicalRoot: string, rootKey: string): boolean;
    hasAnyActiveOrUnverifiableLease(): boolean;
    runWithRootMutationLease(canonicalRoot: string, rootKey: string, fn: () => boolean): boolean;
}

interface GcMaintenanceAuthority {
    leasePort: GcMutationLeasePort;
    withOwnerLock: <T>(stateDir: string, fn: () => T) => T;
}

export interface GcCommandOptions {
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    dryRun?: boolean;
    olderThanDays?: number;
    worktreeDays?: number;
    maxSizeGib?: number;
    nowMs?: number;
}

export interface GcResult extends StorageMaintenanceResult {
    liveOwnerCount: number;
    removedManagedRuntimes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLinuxProcessStartTime(pid: number): string | undefined {
    if (process.platform !== "linux") return undefined;
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const commandEnd = raw.lastIndexOf(")");
        if (commandEnd < 0) return undefined;
        const fieldsAfterCommand = raw.slice(commandEnd + 2).trim().split(/\s+/);
        return fieldsAfterCommand[19] || undefined;
    } catch {
        return undefined;
    }
}

function isPidAliveWithIdentity(pid: unknown, expectedStartTime?: unknown): boolean {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
    if (typeof expectedStartTime === "string" && expectedStartTime.length > 0) {
        const currentStartTime = resolveLinuxProcessStartTime(pid);
        if (currentStartTime && currentStartTime !== expectedStartTime) {
            return false;
        }
    }
    return true;
}

function inspectRuntimeOwners(
    homeDir: string,
    env: NodeJS.ProcessEnv,
    stateRoot: string,
    heldOwnerLock?: string,
): { liveCount: number; soleOwner: boolean } {
    const registryPaths = discoverRuntimeOwnerRegistryPaths(homeDir, env);
    const livePids = new Set<number>();
    let unverifiable = false;

    for (const registryPath of registryPaths) {
        const lockPath = path.join(path.dirname(registryPath), "owners.lock");
        if (lockPath !== heldOwnerLock) {
            try {
                const lockStat = fs.lstatSync(lockPath);
                if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
                    unverifiable = true;
                } else {
                    const lockParsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as unknown;
                    if (!isRecord(lockParsed) || isPidAliveWithIdentity(lockParsed.pid, lockParsed.processStartTime)) {
                        unverifiable = true;
                    }
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    unverifiable = true;
                }
            }
        }

        let raw: string;
        try {
            raw = fs.readFileSync(registryPath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            unverifiable = true;
            continue;
        }
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (!isRecord(parsed) || parsed.formatVersion !== "v1" || !Array.isArray(parsed.owners)) {
                unverifiable = true;
                continue;
            }
            for (const owner of parsed.owners) {
                if (!isRecord(owner) || typeof owner.pid !== "number") {
                    unverifiable = true;
                    continue;
                }
                if (isPidAliveWithIdentity(owner.pid, owner.processStartTime)) {
                    livePids.add(owner.pid);
                }
            }
        } catch {
            unverifiable = true;
        }
    }

    const hostsRoot = path.join(stateRoot, "runtime-host");
    try {
        for (const entry of fs.readdirSync(hostsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const hostJsonPath = path.join(hostsRoot, entry.name, "host.json");
            let raw: string;
            try {
                raw = fs.readFileSync(hostJsonPath, "utf8");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
                unverifiable = true;
                continue;
            }
            try {
                const parsed = JSON.parse(raw) as unknown;
                if (!isRecord(parsed) || typeof parsed.hostPid !== "number") {
                    unverifiable = true;
                    continue;
                }
                if (isPidAliveWithIdentity(parsed.hostPid, parsed.processStartTime)) {
                    livePids.add(parsed.hostPid);
                }
            } catch {
                unverifiable = true;
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            unverifiable = true;
        }
    }

    return {
        liveCount: livePids.size,
        soleOwner: !unverifiable && livePids.size === 0,
    };
}

function formatBytes(bytes: number): string {
    const gib = 1024 ** 3;
    const mib = 1024 ** 2;
    if (bytes >= gib) return `${(bytes / gib).toFixed(2)} GiB`;
    if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
}

function formatBreakdownLines(label: string, breakdown: StorageBreakdown): string[] {
    return [
        `${label}: ${formatBytes(breakdown.totalBytes)} total`,
        `  publications          ${formatBytes(breakdown.publicationsBytes)} (${breakdown.publicationRootCount} root(s))`,
        `  vector                ${formatBytes(breakdown.vectorBytes)} (${breakdown.vectorCollectionCount} collection(s))`,
        `  mcp-runtime           ${formatBytes(breakdown.mcpRuntimeBytes)}`,
        `  models                ${formatBytes(breakdown.modelsBytes)}`,
        `  typescript-resolution ${formatBytes(breakdown.typescriptResolutionBytes)}`,
        `  diagnostics           ${formatBytes(breakdown.diagnosticsBytes)}`,
        ...(breakdown.otherBytes > 0 ? [`  other                 ${formatBytes(breakdown.otherBytes)}`] : []),
    ];
}

function resolveActiveManagedRuntimeRoot(homeDir: string): string | null {
    const launcherPath = resolveLauncherPath(homeDir);
    let content: string;
    try {
        content = fs.readFileSync(launcherPath, "utf8");
    } catch {
        return null;
    }
    try {
        const descriptor = parseManagedLauncherDescriptor(content);
        const entryPath = descriptor.args[0];
        if (!entryPath) return null;
        const storageRoot = path.resolve(homeDir, ".satori", "mcp-runtime");
        const relative = path.relative(storageRoot, path.resolve(entryPath));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
        const firstSegment = relative.split(path.sep)[0];
        if (!firstSegment || firstSegment.startsWith(".")) return null;
        return path.join(storageRoot, firstSegment);
    } catch {
        return null;
    }
}

function findMcpPackageJson(entryPath: string): string | null {
    let current = path.dirname(entryPath);
    for (let depth = 0; depth < 6; depth += 1) {
        const candidate = path.join(current, "package.json");
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: unknown };
            if (parsed.name === "@satori-code/mcp") return candidate;
        } catch {
            // keep walking up
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

function resolveManagedMaintenanceAuthority(
    homeDir: string,
    stateRoot: string,
): GcMaintenanceAuthority | null {
    const launcherPath = resolveLauncherPath(homeDir);
    let content: string;
    try {
        content = fs.readFileSync(launcherPath, "utf8");
    } catch {
        return null;
    }
    try {
        const descriptor = parseManagedLauncherDescriptor(content);
        const entryPath = descriptor.args[0];
        if (!entryPath || !path.isAbsolute(entryPath)) return null;
        const mcpPackageJson = findMcpPackageJson(fs.realpathSync(entryPath));
        if (!mcpPackageJson) return null;
        const requireFromMcp = createRequire(mcpPackageJson);
        const coreIntegration = requireFromMcp("@satori-code/core/integration") as {
            createRootMutationLeasePort?: (source: { stateDir: string }) => GcMutationLeasePort;
        };
        const registry = requireFromMcp("./dist/core/runtime-owner.js") as {
            withRuntimeOwnerMaintenanceLock?: GcMaintenanceAuthority["withOwnerLock"];
        };
        if (
            typeof coreIntegration.createRootMutationLeasePort !== "function"
            || typeof registry.withRuntimeOwnerMaintenanceLock !== "function"
        ) {
            return null;
        }
        return {
            leasePort: coreIntegration.createRootMutationLeasePort({
                stateDir: path.join(stateRoot, "runtime", "mutation-leases"),
            }),
            withOwnerLock: registry.withRuntimeOwnerMaintenanceLock,
        };
    } catch {
        return null;
    }
}

export async function runGcCommand(options: GcCommandOptions = {}): Promise<GcResult> {
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    const dryRun = options.dryRun === true;
    const defaultStateRoot = path.resolve(path.join(homeDir, ".satori"));
    const stateRoot = path.resolve(resolveSatoriStateRoot({
        configured: env.SATORI_STATE_ROOT,
        homeDir,
    }));
    const usesDefaultStateRoot = stateRoot === defaultStateRoot;

    const managedEnv: Readonly<Record<string, string>> = usesDefaultStateRoot
        ? readManagedRuntimeEnvironment(homeDir)
        : Object.freeze({});
    const effectiveVectorEnv: NodeJS.ProcessEnv = {
        ...(usesDefaultStateRoot && managedEnv.VECTOR_STORE_PROVIDER
            ? { VECTOR_STORE_PROVIDER: managedEnv.VECTOR_STORE_PROVIDER }
            : {}),
        ...runtimeEnvironmentWithManagedFallbacks(managedEnv, env),
    };
    const vectorStoreProvider = selectedVectorStore(effectiveVectorEnv) === "Milvus" ? "Milvus" : "LanceDB";
    const hasExplicitLanceDbPath = Boolean(env.LANCEDB_PATH?.trim());
    const vectorDbPath = vectorStoreProvider === "Milvus"
        ? null
        : (usesDefaultStateRoot || hasExplicitLanceDbPath)
            ? resolveLanceDbPath(homeDir, effectiveVectorEnv)
            : null;

    let ownerCheck = inspectRuntimeOwners(homeDir, env, stateRoot);
    const maxSizeGib = options.maxSizeGib === undefined ? DEFAULT_MAX_STORAGE_GIB : options.maxSizeGib;
    const authority = resolveManagedMaintenanceAuthority(homeDir, stateRoot);
    const leasePort = authority?.leasePort;
    const runMaintenance = (hasAdmission: boolean) => runPublicationStorageMaintenance({
        stateRoot,
        dryRun,
        soleOwner: ownerCheck.soleOwner,
        vectorStoreProvider,
        vectorDbPath,
        worktreeIdleDays: options.worktreeDays ?? DEFAULT_WORKTREE_IDLE_DAYS,
        idleDays: options.olderThanDays,
        maxStorageBytes: Math.round(maxSizeGib * (1024 ** 3)),
        nowMs: options.nowMs,
        isRootMutationActive: leasePort?.isRootMutationActive,
        hasAnyActiveOrUnverifiableLease: leasePort?.hasAnyActiveOrUnverifiableLease,
        runWithRootMutationLease: hasAdmission ? leasePort?.runWithRootMutationLease : undefined,
    });

    let maintenance: StorageMaintenanceResult | undefined;
    let admissionWarning: string | undefined;
    if (!dryRun && authority && vectorStoreProvider === "LanceDB" && ownerCheck.soleOwner) {
        const ownerDir = path.join(stateRoot, "runtime-owner");
        let acquired = false;
        try {
            maintenance = authority.withOwnerLock(ownerDir, () => {
                acquired = true;
                ownerCheck = inspectRuntimeOwners(homeDir, env, stateRoot, path.join(ownerDir, "owners.lock"));
                return runMaintenance(ownerCheck.soleOwner);
            });
        } catch (error) {
            if (acquired) throw error;
            admissionWarning = "Could not acquire the runtime-owner admission lock.";
        }
    }
    maintenance ??= runMaintenance(false);
    const removedManagedRuntimes: string[] = [];
    const warnings = admissionWarning ? [admissionWarning, ...maintenance.warnings] : [...maintenance.warnings];
    if (!dryRun) {
        const activeRuntimeRoot = resolveActiveManagedRuntimeRoot(homeDir);
        if (activeRuntimeRoot) {
            try {
                const pruned = pruneManagedRuntimeStore({
                    homeDir,
                    currentRuntimeRoot: activeRuntimeRoot,
                    env,
                });
                removedManagedRuntimes.push(...pruned.removedRuntimeRoots);
                warnings.push(...pruned.warnings);
            } catch (error) {
                warnings.push(
                    `Could not prune unused managed runtimes: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    return {
        ...maintenance,
        warnings,
        liveOwnerCount: ownerCheck.liveCount,
        removedManagedRuntimes,
    };
}

export function formatGcText(result: GcResult): string {
    const verb = result.dryRun ? "Would reclaim" : "Reclaimed";
    const lines: string[] = [
        `Satori Storage GC (${result.dryRun ? "dry-run" : "apply"})`,
        `State root: ${result.stateRoot}`,
        "",
        ...formatBreakdownLines("Before", result.before),
        "",
    ];

    if (result.liveOwnerCount > 0) {
        lines.push(
            `Note: ${result.liveOwnerCount} live Satori server(s) detected; publication cleanup requires exclusive ownership.`,
            "Run `satori terminate` before applying publication cleanup.",
            "",
        );
    }

    lines.push(
        `${verb}: ${formatBytes(result.reclaimedBytes)}`,
        `  publications removed    ${result.removedRoots.length}`,
        `  retired generations     ${result.removedRetiredGenerations.length}`,
        `  orphan vector tables    ${result.removedOrphanCollections.length}`,
        `  ts-resolution files     ${result.removedTypescriptResolutionFiles}`,
        `  old managed runtimes    ${result.removedManagedRuntimes.length}`,
    );

    if (result.removedRoots.length > 0) {
        lines.push("", result.dryRun ? "Eligible publications:" : "Removed publications:");
        for (const root of result.removedRoots) {
            lines.push(`  - ${root.canonicalRoot ?? root.rootKey} [${root.reason}] (${formatBytes(root.bytesFreed)})`);
        }
    }

    if (!result.dryRun) {
        lines.push("", ...formatBreakdownLines("After", result.after));
    }

    if (result.warnings.length > 0) {
        lines.push("", "Warnings:");
        for (const warning of result.warnings) {
            lines.push(`  - ${warning}`);
        }
    }

    lines.push("");
    return lines.join("\n");
}
