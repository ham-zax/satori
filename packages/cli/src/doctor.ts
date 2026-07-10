import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
    readManagedPackageJson,
    resolveManagedPackageJsonPath,
    resolveManagedPackageSpecifier,
} from "./managed-package.js";
import { inspectManagedClientConfigurations } from "./install.js";
import { evaluateStaticRuntimeConfig } from "./runtime-config.js";

type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
    name: string;
    status: CheckStatus;
    message: string;
}

export interface DoctorPackageVersion {
    name: string;
    version: string | null;
    /** Where the version was resolved from, for support/debugging. */
    source: string;
}

export interface DoctorResult {
    status: CheckStatus;
    /** Installed Satori package set (independent versions are expected). */
    packageVersions: DoctorPackageVersion[];
    /** Operator note about multi-package versioning. */
    packageVersionNote: string;
    checks: DoctorCheck[];
    nextSteps: string[];
}

export interface DoctorProcessSnapshot {
    pid: number;
    processStartTime?: string;
}

export interface DoctorOptions {
    env?: NodeJS.ProcessEnv;
    nodeVersion?: string;
    execFileSyncImpl?: typeof execFileSync;
    /** Optional override for tests; defaults to resolveInstalledPackageVersions(). */
    resolvePackageVersions?: () => DoctorPackageVersion[];
    /** Override runtime owner registry path (default: ~/.satori/runtime/owners.json). */
    runtimeOwnersPath?: string;
    /** Override process liveness check (default: process.kill(pid, 0)). */
    isProcessLive?: (pid: number) => boolean;
    /** Stronger process identity evidence used when available. */
    inspectProcess?: (pid: number) => DoctorProcessSnapshot | null;
    /** Override lease state directory; null disables the check (tests/embedded use). */
    mutationLeasesPath?: string | null;
    /** Override stable managed launcher path; null disables the check. */
    managedLauncherPath?: string | null;
    /** Override installed-client wiring inspection. */
    inspectManagedClients?: (homeDir: string) => ReturnType<typeof inspectManagedClientConfigurations>;
}

const PACKAGE_VERSION_NOTE =
    "Satori ships independent package versions (cli, mcp, core). Doctor reports the installed set for support and debugging; versions need not match each other.";
const requireFromHere = createRequire(import.meta.url);
const MAX_DIAGNOSTIC_DETAILS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (isRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? String(value);
}

function parseNodeMajor(version: string): number {
    const match = version.match(/^v?(\d+)/);
    return match ? Number(match[1]) : 0;
}

function addCheck(checks: DoctorCheck[], name: string, status: CheckStatus, message: string): void {
    checks.push({ name, status, message });
}

function overallStatus(checks: DoctorCheck[]): CheckStatus {
    if (checks.some((check) => check.status === "error")) {
        return "error";
    }
    if (checks.some((check) => check.status === "warning")) {
        return "warning";
    }
    return "ok";
}

function defaultInspectProcess(pid: number): DoctorProcessSnapshot | null {
    try {
        process.kill(pid, 0);
    } catch {
        return null;
    }
    if (process.platform !== "linux") {
        return { pid };
    }
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(")");
        const fields = closeParen >= 0 ? stat.slice(closeParen + 2).trim().split(/\s+/) : [];
        return fields[19] ? { pid, processStartTime: fields[19] } : { pid };
    } catch {
        return { pid };
    }
}

function resolveProcessInspector(options: DoctorOptions): (pid: number) => DoctorProcessSnapshot | null {
    if (options.inspectProcess) {
        return options.inspectProcess;
    }
    if (options.isProcessLive) {
        return (pid) => options.isProcessLive?.(pid) ? { pid } : null;
    }
    return defaultInspectProcess;
}

function isSameProcess(
    storedStartTime: unknown,
    current: DoctorProcessSnapshot | null,
): current is DoctorProcessSnapshot {
    if (!current) {
        return false;
    }
    return !(
        typeof storedStartTime === "string"
        && storedStartTime.length > 0
        && current.processStartTime
        && storedStartTime !== current.processStartTime
    );
}

function readJsonVersion(packageJsonPath: string): { name: string; version: string } | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
        if (typeof parsed.name === "string" && typeof parsed.version === "string") {
            return { name: parsed.name, version: parsed.version };
        }
    } catch {
        // unresolved
    }
    return null;
}

function resolvePackageJsonPath(packageName: string, monorepoSegment: string): { path: string; source: string } | null {
    try {
        const resolved = requireFromHere.resolve(`${packageName}/package.json`);
        return { path: resolved, source: resolved };
    } catch {
        // fall through to monorepo sibling layout (dev / workspace)
    }

    const currentFile = fileURLToPath(import.meta.url);
    // packages/cli/src|dist → packages/<segment>/package.json
    const monorepoPath = path.resolve(path.dirname(currentFile), "..", "..", monorepoSegment, "package.json");
    if (fs.existsSync(monorepoPath)) {
        return { path: monorepoPath, source: monorepoPath };
    }
    return null;
}

/**
 * Resolve @zokizuan/satori-core via the installed MCP package.
 * Production installs often nest core under mcp/node_modules; CLI cannot see it via its own require.
 */
export function resolveCorePackageVersionViaMcp(options?: {
    /** Test override: absolute path to MCP package.json used as createRequire root. */
    mcpPackageJsonPath?: string;
}): DoctorPackageVersion | null {
    try {
        const mcpPackageJsonPath = options?.mcpPackageJsonPath ?? resolveManagedPackageJsonPath();
        const requireFromMcp = createRequire(mcpPackageJsonPath);
        const corePackageJsonPath = requireFromMcp.resolve("@zokizuan/satori-core/package.json");
        const info = readJsonVersion(corePackageJsonPath);
        if (!info) {
            return null;
        }
        return { name: info.name, version: info.version, source: corePackageJsonPath };
    } catch {
        return null;
    }
}

/**
 * Resolve the installed Satori package version set for operator support.
 * Independent package versions are expected; this is not a lockstep matrix.
 */
export function resolveInstalledPackageVersions(): DoctorPackageVersion[] {
    const entries: Array<{ packageName: string; monorepoSegment: string; preferredRead?: () => DoctorPackageVersion | null }> = [
        {
            packageName: "@zokizuan/satori-cli",
            monorepoSegment: "cli",
            preferredRead: () => {
                const currentFile = fileURLToPath(import.meta.url);
                const cliPackageJson = path.resolve(path.dirname(currentFile), "..", "package.json");
                const info = readJsonVersion(cliPackageJson);
                if (!info) {
                    return null;
                }
                return { name: info.name, version: info.version, source: cliPackageJson };
            },
        },
        {
            packageName: "@zokizuan/satori-mcp",
            monorepoSegment: "mcp",
            preferredRead: () => {
                try {
                    const pkg = readManagedPackageJson();
                    const name = typeof pkg.name === "string" ? pkg.name : null;
                    const version = typeof pkg.version === "string" ? pkg.version : null;
                    if (!name || !version) {
                        return null;
                    }
                    const source = resolvePackageJsonPath(name, "mcp")?.source
                        || "managed-package";
                    return { name, version, source };
                } catch {
                    return null;
                }
            },
        },
        {
            packageName: "@zokizuan/satori-core",
            monorepoSegment: "core",
            // Prefer MCP-rooted resolution so nested production installs do not false-warn.
            preferredRead: () => resolveCorePackageVersionViaMcp(),
        },
    ];

    return entries.map(({ packageName, monorepoSegment, preferredRead }) => {
        if (preferredRead) {
            const preferred = preferredRead();
            if (preferred) {
                return preferred;
            }
        }
        const resolved = resolvePackageJsonPath(packageName, monorepoSegment);
        if (!resolved) {
            return { name: packageName, version: null, source: "unresolved" };
        }
        const info = readJsonVersion(resolved.path);
        if (!info) {
            return { name: packageName, version: null, source: resolved.source };
        }
        return { name: info.name, version: info.version, source: resolved.source };
    });
}

export function runDoctor(options: DoctorOptions = {}): DoctorResult {
    const env = options.env || process.env;
    const homeDir = env.HOME || os.homedir();
    const nodeVersion = options.nodeVersion || process.version;
    const execImpl = options.execFileSyncImpl || execFileSync;
    const checks: DoctorCheck[] = [];
    const nextSteps: string[] = [];
    const packageVersions = options.resolvePackageVersions
        ? options.resolvePackageVersions()
        : resolveInstalledPackageVersions();

    for (const pkg of packageVersions) {
        const shortName = pkg.name.includes("/")
            ? pkg.name.slice(pkg.name.lastIndexOf("/") + 1).replace(/^satori-/, "")
            : pkg.name;
        // shortName → cli | mcp | core for stable check ids
        const checkName = `package_version_${shortName}`;
        if (pkg.version) {
            addCheck(checks, checkName, "ok", `${pkg.name}@${pkg.version}`);
        } else {
            addCheck(
                checks,
                checkName,
                "warning",
                `${pkg.name} version could not be resolved (${pkg.source}).`,
            );
        }
    }
    addCheck(checks, "package_version_policy", "ok", PACKAGE_VERSION_NOTE);

    const nodeMajor = parseNodeMajor(nodeVersion);
    if (nodeMajor >= 20) {
        addCheck(checks, "node_version", "ok", `Node ${nodeVersion} satisfies >=20.`);
    } else {
        addCheck(checks, "node_version", "error", `Node ${nodeVersion} is unsupported. Install Node.js 20 or newer.`);
        nextSteps.push("Install Node.js 20 or newer.");
    }

    try {
        const specifier = resolveManagedPackageSpecifier();
        const pkg = readManagedPackageJson();
        execImpl("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        addCheck(checks, "npm_package_access", "ok", `${specifier} is visible to npm.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addCheck(checks, "npm_package_access", "warning", `Could not verify npm package access: ${message}`);
        nextSteps.push("Verify npm can access @zokizuan/satori-mcp from this machine.");
    }

    for (const check of evaluateStaticRuntimeConfig(env)) {
        addCheck(checks, check.name, check.status, check.message);
        if (check.nextStep) {
            nextSteps.push(check.nextStep);
        }
    }

    const runtimeOwnersPath = options.runtimeOwnersPath
        || path.join(homeDir, ".satori", "runtime", "owners.json");
    const inspectProcess = resolveProcessInspector(options);
    const installedMcpVersion = packageVersions.find((entry) => entry.name === "@zokizuan/satori-mcp")?.version ?? null;
    appendRuntimeOwnerChecks(checks, nextSteps, runtimeOwnersPath, inspectProcess, installedMcpVersion);

    if (options.mutationLeasesPath !== null) {
        appendMutationLeaseChecks(
            checks,
            nextSteps,
            options.mutationLeasesPath || path.join(homeDir, ".satori", "runtime", "mutation-leases"),
            inspectProcess,
        );
    }

    if (options.managedLauncherPath !== null) {
        appendManagedLauncherCheck(
            checks,
            nextSteps,
            options.managedLauncherPath || path.join(homeDir, ".satori", "bin", "satori-mcp.js"),
            installedMcpVersion,
        );
    }

    appendManagedClientChecks(
        checks,
        nextSteps,
        (options.inspectManagedClients || inspectManagedClientConfigurations)(homeDir),
    );

    if (nextSteps.length > 0) {
        nextSteps.push("Restart your MCP client after changing Satori environment variables.");
    }

    return {
        status: overallStatus(checks),
        packageVersions,
        packageVersionNote: PACKAGE_VERSION_NOTE,
        checks,
        nextSteps: [...new Set(nextSteps)],
    };
}

function appendManagedClientChecks(
    checks: DoctorCheck[],
    nextSteps: string[],
    proofs: ReturnType<typeof inspectManagedClientConfigurations>,
): void {
    if (proofs.length === 0) {
        addCheck(checks, "managed_client_configuration", "warning", "No supported MCP client has a Satori configuration entry.");
        nextSteps.push("Run satori-cli install for the intended MCP client.");
        return;
    }
    const failures = proofs.filter((proof) => proof.status === "error");
    addCheck(
        checks,
        "managed_client_configuration",
        failures.length > 0 ? "error" : "ok",
        failures.length > 0
            ? failures.map((proof) => proof.message).join(" ")
            : `${proofs.length} configured MCP client${proofs.length === 1 ? "" : "s"} point exactly to the managed launcher.`,
    );
    if (failures.length > 0) {
        nextSteps.push("Rerun satori-cli install for each stale configured MCP client, then restart it.");
    }
}

function appendRuntimeOwnerChecks(
    checks: DoctorCheck[],
    nextSteps: string[],
    runtimeOwnersPath: string,
    inspectProcess: (pid: number) => DoctorProcessSnapshot | null,
    installedMcpVersion: string | null,
): void {
    if (!fs.existsSync(runtimeOwnersPath)) {
        addCheck(checks, "runtime_owners", "ok", "No runtime owner registry yet (no concurrent MCP owners recorded).");
        return;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(runtimeOwnersPath, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addCheck(checks, "runtime_owners", "warning", `Could not parse runtime owner registry at ${runtimeOwnersPath}: ${message}`);
        nextSteps.push(`Inspect or remove the corrupt runtime owner file at ${runtimeOwnersPath}, then restart Satori MCP clients.`);
        return;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { owners?: unknown }).owners)) {
        addCheck(checks, "runtime_owners", "warning", `Runtime owner registry shape is invalid at ${runtimeOwnersPath}.`);
        nextSteps.push(`Fix or remove ${runtimeOwnersPath}, then restart Satori MCP clients.`);
        return;
    }

    const owners = (parsed as { owners: Array<Record<string, unknown>> }).owners;
    const live = owners.filter((owner) => (
        typeof owner.pid === "number"
        && isSameProcess(owner.processStartTime, inspectProcess(owner.pid))
    )).sort((a, b) => Number(a.pid) - Number(b.pid));
    const dead = owners.length - live.length;
    if (live.length === 0) {
        addCheck(
            checks,
            "runtime_owners",
            dead > 0 ? "warning" : "ok",
            dead > 0
                ? `Runtime owner registry has ${dead} stale (dead or replaced) entr${dead === 1 ? "y" : "ies"} and no live MCP owners at ${runtimeOwnersPath}.`
                : `Runtime owner registry is empty at ${runtimeOwnersPath}.`,
        );
        if (dead > 0) {
            nextSteps.push("Start any Satori MCP client once so dead runtime owners prune, or remove stale entries from ~/.satori/runtime/owners.json after all MCP processes exit.");
        }
        return;
    }

    const versions = [...new Set(live.map((owner) => String(owner.satoriVersion || "unknown")))].sort();
    const pids = live.map((owner) => String(owner.pid)).join(", ");
    const fingerprints = new Set(live.map((owner) => stableStringify(owner.runtimeFingerprint)));
    const identityHashes = new Set(live.map((owner) => String(owner.runtimeOwnerIdentityHash || "unknown")));
    const conflictReasons: string[] = [];
    if (versions.length > 1) conflictReasons.push("Satori package version");
    if (fingerprints.size > 1) conflictReasons.push("runtime fingerprint");
    if (identityHashes.size > 1) conflictReasons.push("config identity hash");
    if (conflictReasons.length > 0) {
        addCheck(
            checks,
            "runtime_owners",
            "error",
            `Live Satori MCP runtime identities conflict (pids ${pids}; versions ${versions.join(", ")}; evidence: ${conflictReasons.join(", ")}). manage_index mutations will return runtime_owner_conflict.`,
        );
        nextSteps.push(
            `Stop extra Satori MCP clients so one runtime identity remains (live pids: ${pids}), then restart the intended client.`,
        );
        return;
    }

    const installedMismatches = installedMcpVersion
        ? live.filter((owner) => String(owner.satoriVersion || "unknown") !== installedMcpVersion)
        : [];
    if (installedMismatches.length > 0) {
        const details = installedMismatches.map((owner) => `pid=${owner.pid} version=${String(owner.satoriVersion || "unknown")}`).join(", ");
        addCheck(
            checks,
            "runtime_owners",
            "error",
            `Live Satori MCP runtime does not match installed MCP version ${installedMcpVersion}: ${details}. This is a stale resident runtime.`,
        );
        nextSteps.push(`Stop stale Satori MCP runtime pids ${installedMismatches.map((owner) => owner.pid).join(", ")} and restart the intended MCP client.`);
        return;
    }

    if (live.length > 1) {
        addCheck(
            checks,
            "runtime_owners",
            "ok",
            `${live.length} live Satori MCP processes share version ${versions[0]} (pids ${pids}). Same identity is allowed; stop extras only if you want a single client.`,
        );
        return;
    }

    addCheck(
        checks,
        "runtime_owners",
        "ok",
        `One live Satori MCP owner: pid=${pids} satori@${versions[0]}.`,
    );
}

interface LeaseDiagnostic {
    state: "idle" | "active" | "abandoned" | "corrupt";
    detail: string;
}

function inspectLeaseFile(
    filePath: string,
    inspectProcess: (pid: number) => DoctorProcessSnapshot | null,
): LeaseDiagnostic {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return { state: "corrupt", detail: path.basename(filePath) };
    }
    if (
        !isRecord(parsed)
        || parsed.formatVersion !== "v1"
        || typeof parsed.canonicalRoot !== "string"
        || !Number.isSafeInteger(parsed.generation)
        || Number(parsed.generation) < 0
    ) {
        return { state: "corrupt", detail: path.basename(filePath) };
    }
    if (parsed.lease === undefined) {
        return { state: "idle", detail: parsed.canonicalRoot };
    }
    const lease = parsed.lease;
    if (
        !isRecord(lease)
        || lease.canonicalRoot !== parsed.canonicalRoot
        || lease.generation !== parsed.generation
        || !Number.isSafeInteger(lease.generation)
        || Number(lease.generation) <= 0
        || typeof lease.operationId !== "string"
        || lease.operationId.length === 0
        || typeof lease.action !== "string"
        || !["create", "reindex", "sync", "repair", "clear"].includes(lease.action)
        || typeof lease.pid !== "number"
        || !Number.isSafeInteger(lease.pid)
        || lease.pid <= 0
        || typeof lease.ownerId !== "string"
        || lease.ownerId.length === 0
        || (lease.processStartTime !== undefined && typeof lease.processStartTime !== "string")
        || typeof lease.acquiredAt !== "string"
        || typeof lease.lastHeartbeatAt !== "string"
    ) {
        return { state: "corrupt", detail: path.basename(filePath) };
    }
    const detail = `root=${lease.canonicalRoot} action=${lease.action} operation=${lease.operationId} generation=${lease.generation} pid=${lease.pid}`;
    return {
        state: isSameProcess(lease.processStartTime, inspectProcess(lease.pid)) ? "active" : "abandoned",
        detail,
    };
}

function formatDiagnosticDetails(entries: LeaseDiagnostic[], state: LeaseDiagnostic["state"]): string {
    const details = entries.filter((entry) => entry.state === state).map((entry) => entry.detail).sort();
    if (details.length === 0) {
        return "";
    }
    const visible = details.slice(0, MAX_DIAGNOSTIC_DETAILS);
    const omitted = details.length - visible.length;
    return `; ${state}=[${visible.join(" | ")}${omitted > 0 ? ` | +${omitted} more` : ""}]`;
}

function appendMutationLeaseChecks(
    checks: DoctorCheck[],
    nextSteps: string[],
    leaseDir: string,
    inspectProcess: (pid: number) => DoctorProcessSnapshot | null,
): void {
    if (!fs.existsSync(leaseDir)) {
        addCheck(checks, "mutation_leases", "ok", `No mutation lease state directory at ${leaseDir}.`);
        return;
    }
    let fileNames: string[];
    try {
        fileNames = fs.readdirSync(leaseDir).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
        addCheck(checks, "mutation_leases", "error", `Could not read mutation lease directory ${leaseDir}: ${error instanceof Error ? error.message : String(error)}`);
        nextSteps.push(`Restore read access to ${leaseDir}; doctor never removes mutation leases.`);
        return;
    }
    const diagnostics = fileNames.map((name) => inspectLeaseFile(path.join(leaseDir, name), inspectProcess));
    const count = (state: LeaseDiagnostic["state"]) => diagnostics.filter((entry) => entry.state === state).length;
    const active = count("active");
    const abandoned = count("abandoned");
    const corrupt = count("corrupt");
    const message = `Mutation lease states: active=${active}, abandoned=${abandoned}, corrupt=${corrupt}`
        + formatDiagnosticDetails(diagnostics, "active")
        + formatDiagnosticDetails(diagnostics, "abandoned")
        + formatDiagnosticDetails(diagnostics, "corrupt")
        + ".";
    addCheck(checks, "mutation_leases", corrupt > 0 ? "error" : active > 0 || abandoned > 0 ? "warning" : "ok", message);
    if (corrupt > 0) {
        nextSteps.push(`Inspect malformed mutation lease files under ${leaseDir}; doctor will not delete or rewrite them.`);
    }
    if (active > 0) {
        nextSteps.push("Use manage_index status for each active root and let the live writer finish; leases do not expire by age.");
    }
    if (abandoned > 0) {
        nextSteps.push("Retry the intended manage_index action; the mutation coordinator can fence a lease only after process-death or process-start mismatch proof.");
    }
}

function parseManagedLauncherTarget(content: string): string | null {
    const match = content.match(/^const baseArgs = (.+);$/m);
    if (!match) {
        return null;
    }
    try {
        const args: unknown = JSON.parse(match[1]);
        return Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
    } catch {
        return null;
    }
}

function isRegularFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function findMcpPackageMetadata(runtimeTarget: string): { version: string; packageJsonPath: string } | null {
    let current = path.dirname(runtimeTarget);
    while (true) {
        const packageJsonPath = path.join(current, "package.json");
        const info = readJsonVersion(packageJsonPath);
        if (info?.name === "@zokizuan/satori-mcp") {
            return { version: info.version, packageJsonPath };
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}

function appendManagedLauncherCheck(
    checks: DoctorCheck[],
    nextSteps: string[],
    launcherPath: string,
    installedMcpVersion: string | null,
): void {
    if (!fs.existsSync(launcherPath)) {
        addCheck(checks, "managed_launcher", "warning", `Managed Satori launcher is missing at ${launcherPath}.`);
        nextSteps.push("Run satori-cli install for the intended MCP client to create the stable managed launcher.");
        return;
    }
    let target: string | null = null;
    try {
        target = parseManagedLauncherTarget(fs.readFileSync(launcherPath, "utf8"));
    } catch {
        // Report the same bounded remediation for unreadable and unrecognized launchers.
    }
    if (!target) {
        addCheck(checks, "managed_launcher", "error", `Managed Satori launcher at ${launcherPath} is unreadable or not recognized.`);
        nextSteps.push("Rerun satori-cli install to replace the managed launcher with the current generated form.");
        return;
    }
    if (!path.isAbsolute(target) || !isRegularFile(target)) {
        addCheck(checks, "managed_launcher", "error", `Managed Satori launcher target does not exist: ${target}.`);
        nextSteps.push("Rerun satori-cli install to install the resident MCP runtime and refresh its launcher target.");
        return;
    }
    const metadata = findMcpPackageMetadata(target);
    if (!metadata) {
        addCheck(checks, "managed_launcher", "warning", `Managed Satori launcher target exists but MCP package metadata could not be found for ${target}.`);
        nextSteps.push("Inspect the managed launcher target, then rerun satori-cli install if it is not an intentional local runtime.");
        return;
    }
    if (installedMcpVersion && metadata.version !== installedMcpVersion) {
        addCheck(checks, "managed_launcher", "error", `Managed Satori launcher targets MCP ${metadata.version}, but installed MCP version ${installedMcpVersion} is expected (${metadata.packageJsonPath}).`);
        nextSteps.push("Rerun satori-cli install and restart every MCP client to replace the stale resident launcher target.");
        return;
    }
    addCheck(checks, "managed_launcher", "ok", `Managed Satori launcher targets @zokizuan/satori-mcp@${metadata.version}: ${target}.`);
}
