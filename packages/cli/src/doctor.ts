import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResolvedOllamaModelIdentity } from "@satori-code/core";
import { assertLocalOnlyEndpoint, resolveSatoriStateRoot } from "./local-runtime-contract.js";
import {
    readManagedRuntimeRelease,
    resolveCliPackageJsonPath,
    resolveManagedPackageSpecifier,
} from "./managed-package.js";
import { DEFAULT_LATEON_PROFILE_ID } from "./lateon-model-store.js";
import {
    inspectManagedClientConfigurations,
    type ManagedClientConfigProof,
} from "./install.js";
import { parseManagedLauncherDescriptor } from "./managed-launcher-script.mjs";
import {
    evaluateStaticRuntimeConfig,
    resolveRuntimeConfigSelection,
    selectedVectorStore,
} from "./runtime-config.js";
import { readLocalDiagnosticsSummary, type LocalDiagnosticsSummary } from "./local-diagnostics.js";
import { sanitizeTerminalText } from "./terminal-sanitize.js";
import { SATORI_CLI_NPX_COMMAND } from "./cli-command.js";
import {
    discoverRuntimeOwnerRegistryPaths,
    resolveRuntimeOwnerRegistryPath,
} from "./runtime-owner-path.js";
export { SATORI_CLI_NPX_COMMAND } from "./cli-command.js";

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

export interface RuntimeVersionState {
    cliVersion: string;
    releaseMcpVersion: string | null;
    releaseCoreVersion: string | null;
    activeManagedMcpVersion: string | null;
    activeManagedCoreVersion: string | null;
    activeLauncherPath: string | null;
    managedLauncherStatus: ManagedLauncherStatus;
}

export interface ManagedRuntimeSnapshot {
    status: ManagedLauncherStatus;
    launcherPath: string | null;
    mcpVersion: string | null;
    coreVersion: string | null;
}

export interface DoctorRuntimeConfiguration {
    client: ManagedClientConfigProof["client"];
    status: "configured" | "needs_repair" | "not_configured";
    source: "managed_launcher" | "client_configuration" | "unknown" | null;
    profile: "connected" | "offline" | null;
    embeddingProvider: "OpenAI" | "VoyageAI" | "Gemini" | "Ollama" | "Potion" | null;
    embeddingModel: string | null;
    embeddingDimension: string | null;
    rerankerProvider: "none" | "voyage" | "lateon" | null;
    rerankerProfile: string | null;
    vectorStore: "Milvus" | "LanceDB" | null;
}

export interface DoctorResult {
    status: CheckStatus;
    /** Installed Satori package set (independent versions are expected). */
    packageVersions: DoctorPackageVersion[];
    /** Operator note about multi-package versioning. */
    packageVersionNote: string;
    checks: DoctorCheck[];
    nextSteps: string[];
    /** Active managed launcher identity; null when no launcher is present. */
    managedRuntime: ManagedRuntimeSnapshot | null;
    /** Sanitized effective runtime selection for every supported client. */
    runtimeConfigurations?: DoctorRuntimeConfiguration[];
    /** Aggregated CLI activity stored only on this machine; contains no repository or request identity. */
    localDiagnostics: LocalDiagnosticsSummary;
}

export interface DoctorProcessSnapshot {
    pid: number;
    processStartTime?: string;
}

export type DoctorExecFileSync = (
    file: string,
    args: string[],
    options: {
        encoding: "utf8";
        stdio: ["ignore", "pipe", "pipe"];
    },
) => string;

export interface DoctorOptions {
    env?: NodeJS.ProcessEnv;
    nodeVersion?: string;
    execFileSyncImpl?: DoctorExecFileSync;
    /** Optional override for tests; defaults to resolveInstalledPackageVersions(). */
    resolvePackageVersions?: () => DoctorPackageVersion[];
    /** Override runtime owner registry path (default: discovered managed runtime-owner registries). */
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
    /** Override local diagnostics event log path. */
    diagnosticsPath?: string;
    resolveOllamaIdentity?: (input: {
        model: string;
        host?: string;
    }) => Promise<Readonly<ResolvedOllamaModelIdentity>>;
    /** Read-only exact-runtime LanceDB module load override. */
    loadManagedLanceDb?: (runtimeTarget: string) => Promise<void>;
}

interface DoctorRuntimeContext {
    client: ManagedClientConfigProof["client"] | null;
    environment: NodeJS.ProcessEnv;
}

interface EvaluatedDoctorRuntimeContext extends DoctorRuntimeContext {
    staticChecks: ReturnType<typeof evaluateStaticRuntimeConfig>;
}

const PACKAGE_VERSION_NOTE =
    "Satori ships independent package versions (cli, mcp, core). Doctor reports the installed set for support and debugging; versions need not match each other.";
const MAX_DIAGNOSTIC_DETAILS = 10;
const SUPPORTED_DOCTOR_CLIENTS = ["codex", "claude", "opencode", "agy"] as const satisfies readonly ManagedClientConfigProof["client"][];
const DISPLAYED_RUNTIME_PROFILES = new Set<NonNullable<DoctorRuntimeConfiguration["profile"]>>(["connected", "offline"]);
const DISPLAYED_EMBEDDING_PROVIDERS = new Set<NonNullable<DoctorRuntimeConfiguration["embeddingProvider"]>>([
    "OpenAI",
    "VoyageAI",
    "Gemini",
    "Ollama",
    "Potion",
]);
const DISPLAYED_RERANKER_PROVIDERS = new Set<NonNullable<DoctorRuntimeConfiguration["rerankerProvider"]>>([
    "none",
    "voyage",
    "lateon",
]);
const DISPLAYED_VECTOR_STORES = new Set<NonNullable<DoctorRuntimeConfiguration["vectorStore"]>>(["Milvus", "LanceDB"]);

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

function minimumNodeVersion(): string {
    const packageJson = JSON.parse(fs.readFileSync(resolveCliPackageJsonPath(), "utf8")) as {
        engines?: { node?: string };
    };
    const minimum = packageJson.engines?.node?.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
    if (!minimum) {
        throw new Error("CLI package engines.node must specify an exact minimum Node.js version.");
    }
    return minimum;
}

function nodeVersionMeetsMinimum(version: string, minimum: string): boolean {
    const actual = version.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    const required = minimum.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!actual || !required) return false;
    for (let index = 1; index <= 3; index += 1) {
        const difference = Number(actual[index]) - Number(required[index]);
        if (difference !== 0) return difference > 0;
    }
    return true;
}

function addCheck(checks: DoctorCheck[], name: string, status: CheckStatus, message: string): void {
    checks.push({ name, status, message });
}

function clientLabel(client: DoctorRuntimeContext["client"]): string {
    if (client === "codex") return "Codex";
    if (client === "opencode") return "OpenCode";
    if (client === "claude") return "Claude Code";
    if (client === "agy") return "Antigravity";
    return "Runtime";
}

function runtimeCheckValue(
    staticChecks: ReturnType<typeof evaluateStaticRuntimeConfig>,
    name: string,
): string | null {
    const message = staticChecks.find((check) => check.name === name)?.message;
    if (!message) return null;
    const separator = message.indexOf(":");
    return (separator === -1 ? message : message.slice(separator + 1)).trim().replace(/\.$/, "");
}

function appendRuntimeConfigurationChecks(
    checks: DoctorCheck[],
    nextSteps: string[],
    runtimeContexts: DoctorRuntimeContext[],
): EvaluatedDoctorRuntimeContext[] {
    const evaluated = runtimeContexts.map((context) => ({
        ...context,
        staticChecks: evaluateStaticRuntimeConfig(context.environment),
    }));

    for (const context of evaluated) {
        if (!context.client) continue;
        const values = [
            runtimeCheckValue(context.staticChecks, "runtime_profile"),
            (() => {
                const provider = runtimeCheckValue(context.staticChecks, "embedding_provider");
                const model = runtimeCheckValue(context.staticChecks, "embedding_model");
                return provider && model ? `${provider} / ${model}` : provider || model;
            })(),
            runtimeCheckValue(context.staticChecks, "vector_store_provider"),
        ].filter((value): value is string => Boolean(value));
        addCheck(
            checks,
            `client_runtime_${context.client}`,
            "ok",
            `${clientLabel(context.client)}: ${values.join(" · ") || "runtime configuration is invalid"}.`,
        );
    }

    const checkNames = [...new Set(evaluated.flatMap((context) => context.staticChecks.map((check) => check.name)))];
    for (const name of checkNames) {
        const contextualChecks = evaluated.flatMap((context) => {
            const check = context.staticChecks.find((candidate) => candidate.name === name);
            return check ? [{ context, check }] : [];
        });
        const status = contextualChecks.some(({ check }) => check.status === "error") ? "error" : "ok";
        const reportedChecks = status === "error"
            ? contextualChecks.filter(({ check }) => check.status === "error")
            : contextualChecks;
        const message = reportedChecks.length === 1 && reportedChecks[0].context.client === null
            ? reportedChecks[0].check.message
            : reportedChecks
                .map(({ context, check }) => `${clientLabel(context.client)}: ${check.message}`)
                .join(" ");
        addCheck(checks, name, status, message);
        for (const { context, check } of contextualChecks) {
            if (check.status !== "error" || !check.nextStep) continue;
            nextSteps.push(context.client
                ? `${clientLabel(context.client)}: ${check.nextStep}`
                : check.nextStep);
        }
    }
    return evaluated;
}

function buildRuntimeConfigurationRows(
    clientProofs: readonly ManagedClientConfigProof[],
    runtimeContexts: readonly EvaluatedDoctorRuntimeContext[],
): DoctorRuntimeConfiguration[] {
    const withoutSelection = (
        client: ManagedClientConfigProof["client"],
        status: DoctorRuntimeConfiguration["status"],
        source: DoctorRuntimeConfiguration["source"],
    ): DoctorRuntimeConfiguration => ({
        client,
        status,
        source,
        profile: null,
        embeddingProvider: null,
        embeddingModel: null,
        embeddingDimension: null,
        rerankerProvider: null,
        rerankerProfile: null,
        vectorStore: null,
    });
    const sanitizedValue = (value: string): string | null => {
        const sanitized = sanitizeTerminalText(value);
        return sanitized || null;
    };
    const allowlistedValue = <T extends string>(value: string, allowed: ReadonlySet<T>): T | null => {
        const sanitized = sanitizedValue(value);
        return sanitized && allowed.has(sanitized as T) ? sanitized as T : null;
    };
    const sanitizedDimension = (value: string): string | null => {
        const sanitized = sanitizedValue(value);
        if (sanitized === "provider default") return sanitized;
        if (!sanitized || !/^\d+$/.test(sanitized)) return null;
        const dimension = Number(sanitized);
        return Number.isSafeInteger(dimension) && dimension > 0 ? String(dimension) : null;
    };
    const sanitizedModelIdentity = (value: string): string | null => {
        const sanitized = sanitizedValue(value);
        if (!sanitized) return null;
        if (
            path.posix.isAbsolute(sanitized)
            || path.win32.isAbsolute(sanitized)
            || /^file:/i.test(sanitized)
            || /^~[\\/]/.test(sanitized)
            || /^\.{1,2}[\\/]/.test(sanitized)
        ) {
            return null;
        }
        return sanitized;
    };
    return SUPPORTED_DOCTOR_CLIENTS.map((client) => {
        const proof = clientProofs.find((candidate) => candidate.client === client);
        if (!proof) {
            return withoutSelection(client, "not_configured", null);
        }
        const source = proof.usesManagedLauncher === true
            ? "managed_launcher"
            : proof.usesManagedLauncher === false
                ? "client_configuration"
                : "unknown";
        const context = runtimeContexts.find((candidate) => candidate.client === client);
        if (!context) {
            return withoutSelection(client, "needs_repair", source);
        }
        const selection = resolveRuntimeConfigSelection(context.environment);
        return {
            client,
            status: proof.status === "ok" ? "configured" : "needs_repair",
            source,
            profile: allowlistedValue(selection.executionProfile, DISPLAYED_RUNTIME_PROFILES),
            embeddingProvider: allowlistedValue(selection.embeddingProvider, DISPLAYED_EMBEDDING_PROVIDERS),
            embeddingModel: sanitizedModelIdentity(selection.embeddingModel),
            embeddingDimension: sanitizedDimension(selection.embeddingDimension),
            rerankerProvider: allowlistedValue(selection.rerankerProvider, DISPLAYED_RERANKER_PROVIDERS),
            rerankerProfile: selection.rerankerProvider === "lateon"
                && (context.environment.SATORI_LATEON_PROFILE?.trim() ?? DEFAULT_LATEON_PROFILE_ID) === DEFAULT_LATEON_PROFILE_ID
                ? DEFAULT_LATEON_PROFILE_ID
                : null,
            vectorStore: allowlistedValue(selection.vectorStore, DISPLAYED_VECTOR_STORES),
        };
    });
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

/**
 * Resolve the installed Satori package version set for operator support.
 * Independent package versions are expected; this is not a lockstep matrix.
 */
export function resolveInstalledPackageVersions(): DoctorPackageVersion[] {
    const currentFile = fileURLToPath(import.meta.url);
    const cliPackageJson = path.resolve(path.dirname(currentFile), "..", "package.json");
    const cliInfo = readJsonVersion(cliPackageJson);
    const release = readManagedRuntimeRelease();
    const releaseSource = `${cliPackageJson}#satoriManagedRuntime`;
    return [
        {
            name: "@satori-code/cli",
            version: cliInfo?.version ?? null,
            source: cliPackageJson,
        },
        {
            name: "@satori-code/mcp",
            version: release.mcp,
            source: releaseSource,
        },
        {
            name: "@satori-code/core",
            version: release.core,
            source: releaseSource,
        },
    ];
}

type ManagedLauncherStatus =
    | "missing"
    | "active"
    | "malformed"
    | "missing_target"
    | "outside_store"
    | "custom";

function managedLauncherProvidesRuntimeAuthority(status: ManagedLauncherStatus | undefined): boolean {
    return status === "active" || status === "outside_store";
}

function clientProofProvidesRuntimeAuthority(
    proof: ManagedClientConfigProof,
    managedLauncherIsUsable: boolean,
): proof is ManagedClientConfigProof & {
    runtimeEnvironment: Readonly<Record<string, string>>;
    usesManagedLauncher: boolean;
} {
    return proof.runtimeEnvironment !== undefined
        && proof.usesManagedLauncher !== undefined
        && (!proof.usesManagedLauncher || managedLauncherIsUsable);
}

interface ActiveManagedRuntimeResolution {
    status: ManagedLauncherStatus;
    launcherPath: string;
    target: string;
    managedEnvironment: Readonly<Record<string, string>>;
    mcpPackageRoot: string;
    mcpVersion: string;
    coreVersion: string | null;
}

function isPathWithinReal(rootPath: string, candidatePath: string): boolean {
    try {
        const relative = path.relative(fs.realpathSync(rootPath), fs.realpathSync(candidatePath));
        return relative.length > 0
            && relative !== ".."
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative);
    } catch {
        return false;
    }
}

function resolveActiveManagedRuntime(homeDir: string, launcherPath: string): ActiveManagedRuntimeResolution | null {
    if (!fs.existsSync(launcherPath)) {
        return { status: "missing", launcherPath, target: "", managedEnvironment: Object.freeze({}), mcpPackageRoot: "", mcpVersion: "", coreVersion: null };
    }
    let descriptor: {
        command: string;
        args: readonly string[];
        managedEnv: Readonly<Record<string, string>>;
    };
    try {
        descriptor = parseManagedLauncherDescriptor(fs.readFileSync(launcherPath, "utf8"));
    } catch {
        return { status: "malformed", launcherPath, target: "", managedEnvironment: Object.freeze({}), mcpPackageRoot: "", mcpVersion: "", coreVersion: null };
    }
    const managedEnvironment = descriptor.managedEnv;
    if (descriptor.command !== process.execPath || descriptor.args.length !== 1) {
        return { status: "custom", launcherPath, target: "", managedEnvironment: Object.freeze({}), mcpPackageRoot: "", mcpVersion: "", coreVersion: null };
    }
    const target = descriptor.args[0];
    if (!target || !path.isAbsolute(target)) {
        return { status: "malformed", launcherPath, target: "", managedEnvironment: Object.freeze({}), mcpPackageRoot: "", mcpVersion: "", coreVersion: null };
    }
    const managedRuntimeRoot = path.join(homeDir, ".satori", "mcp-runtime");
    if (!isRegularFile(target)) {
        return { status: "missing_target", launcherPath, target, managedEnvironment: Object.freeze({}), mcpPackageRoot: "", mcpVersion: "", coreVersion: null };
    }
    if (!isPathWithinReal(managedRuntimeRoot, target)) {
        return { status: "outside_store", launcherPath, target, managedEnvironment, mcpPackageRoot: "", mcpVersion: "", coreVersion: null };
    }
    const targetRealPath = fs.realpathSync(target);
    const mcpPackage = findMcpPackage(targetRealPath);
    if (!mcpPackage || !isPathWithinReal(managedRuntimeRoot, mcpPackage.root)) {
        return { status: "custom", launcherPath, target: targetRealPath, managedEnvironment: Object.freeze({}), mcpPackageRoot: "", mcpVersion: "", coreVersion: null };
    }
    const generationRoot = path.dirname(path.dirname(mcpPackage.root));
    let coreVersion: string | null = null;
    try {
        const corePackageJsonPath = createRequire(mcpPackage.packageJsonPath)
            .resolve("@satori-code/core/package.json");
        if (isPathWithinReal(generationRoot, corePackageJsonPath)) {
            const coreInfo = readJsonVersion(corePackageJsonPath);
            if (coreInfo?.name === "@satori-code/core") {
                coreVersion = coreInfo.version;
            }
        }
    } catch {
        // Keep the active MCP identity while reporting unresolved Core explicitly.
    }
    return {
        status: "active",
        launcherPath,
        target: targetRealPath,
        managedEnvironment,
        mcpPackageRoot: mcpPackage.root,
        mcpVersion: mcpPackage.version,
        coreVersion,
    };
}

export function resolveRuntimeVersionState(
    homeDir: string,
    packageVersions: readonly DoctorPackageVersion[],
): RuntimeVersionState {
    const launcherPath = path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const active = resolveActiveManagedRuntime(homeDir, launcherPath);
    return {
        cliVersion: installedPackageVersion(packageVersions, "@satori-code/cli") ?? "unknown",
        releaseMcpVersion: installedPackageVersion(packageVersions, "@satori-code/mcp"),
        releaseCoreVersion: installedPackageVersion(packageVersions, "@satori-code/core"),
        activeManagedMcpVersion: active?.status === "active" ? active.mcpVersion : null,
        activeManagedCoreVersion: active?.status === "active" ? active.coreVersion : null,
        activeLauncherPath: active?.status === "missing" ? null : (active?.launcherPath ?? null),
        managedLauncherStatus: active?.status ?? "missing",
    };
}

function installedPackageVersion(
    packages: readonly DoctorPackageVersion[],
    packageName: string,
): string | null {
    return packages.find((entry) => entry.name === packageName)?.version ?? null;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
    const env = options.env || process.env;
    const homeDir = env.HOME || os.homedir();
    const nodeVersion = options.nodeVersion || process.version;
    const execImpl = options.execFileSyncImpl || execFileSync;
    const checks: DoctorCheck[] = [];
    const nextSteps: string[] = [];
    const packageVersions = options.resolvePackageVersions
        ? options.resolvePackageVersions()
        : resolveInstalledPackageVersions();
    const managedLauncherPath = options.managedLauncherPath === null
        ? null
        : options.managedLauncherPath || path.join(homeDir, ".satori", "bin", "satori-mcp.js");
    const activeManagedRuntime = managedLauncherPath
        ? resolveActiveManagedRuntime(homeDir, managedLauncherPath)
        : null;
    const managedRuntime: ManagedRuntimeSnapshot | null = activeManagedRuntime
        ? {
            status: activeManagedRuntime.status,
            launcherPath: activeManagedRuntime.status === "missing" ? null : activeManagedRuntime.launcherPath,
            mcpVersion: activeManagedRuntime.status === "active"
                ? activeManagedRuntime.mcpVersion
                : null,
            coreVersion: activeManagedRuntime.status === "active"
                ? activeManagedRuntime.coreVersion
                : null,
        }
        : null;
    const managedLauncherIsUsable = managedLauncherProvidesRuntimeAuthority(activeManagedRuntime?.status);
    const managedRuntimeEnvironment = managedLauncherIsUsable
        ? activeManagedRuntime?.managedEnvironment ?? Object.freeze({})
        : Object.freeze({});
    const releaseMcpVersion = installedPackageVersion(packageVersions, "@satori-code/mcp");
    const releaseCoreVersion = installedPackageVersion(packageVersions, "@satori-code/core");
    if (
        managedRuntime?.mcpVersion
        && releaseMcpVersion
        && (managedRuntime.mcpVersion !== releaseMcpVersion || managedRuntime.coreVersion !== releaseCoreVersion)
    ) {
        nextSteps.push(
            "The CLI release target differs from the active managed runtime.\nThe active launcher has not been changed.",
        );
    }
    const runtimeEnv: NodeJS.ProcessEnv = { ...env, ...managedRuntimeEnvironment };
    const managedClientProofs = options.inspectManagedClients
        ? options.inspectManagedClients(homeDir)
        : inspectManagedClientConfigurations(homeDir, env);
    const authoritativeClientProofs = managedClientProofs.filter((proof) => (
        clientProofProvidesRuntimeAuthority(proof, managedLauncherIsUsable)
    ));
    // Not installed: no usable launcher and no client entry. The CLI process environment is not
    // the runtime in that state, so runtime-environment checks would only report defaults.
    const notInstalled = managedClientProofs.length === 0 && !managedLauncherIsUsable;
    const runtimeContexts: DoctorRuntimeContext[] = authoritativeClientProofs.length > 0
        ? authoritativeClientProofs.map((proof) => ({
            client: proof.client,
            environment: {
                ...env,
                ...proof.runtimeEnvironment,
                ...(proof.usesManagedLauncher ? managedRuntimeEnvironment : {}),
            },
        }))
        : managedClientProofs.length === 0 && !notInstalled
            ? [{ client: null, environment: runtimeEnv }]
            : [];

    for (const pkg of packageVersions) {
        const shortName = pkg.name.includes("/")
            ? pkg.name.slice(pkg.name.lastIndexOf("/") + 1).replace(/^satori-/, "")
            : pkg.name;
        // shortName → cli | mcp | core for stable check ids
        const checkName = `package_version_${shortName}`;
        if (pkg.version) {
            const label = shortName === "cli"
                ? "CLI package"
                : shortName === "mcp"
                    ? "CLI release MCP target"
                    : shortName === "core"
                        ? "CLI release Core target"
                        : null;
            addCheck(checks, checkName, "ok", label ? `${label}: ${pkg.name}@${pkg.version}` : `${pkg.name}@${pkg.version}`);
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
    if (activeManagedRuntime?.status === "active") {
        addCheck(
            checks,
            "active_runtime_mcp",
            "ok",
            `Active managed MCP runtime: @satori-code/mcp@${activeManagedRuntime.mcpVersion}`,
        );
        if (activeManagedRuntime.coreVersion) {
            addCheck(
                checks,
                "active_runtime_core",
                "ok",
                `Active managed Core runtime: @satori-code/core@${activeManagedRuntime.coreVersion}`,
            );
        } else {
            addCheck(
                checks,
                "active_managed_core_version",
                "error",
                `Active managed MCP ${activeManagedRuntime.mcpVersion} could not resolve @satori-code/core inside its managed generation.`,
            );
            nextSteps.push(`Rerun ${SATORI_CLI_NPX_COMMAND} install so the managed runtime closure includes a matching @satori-code/core.`);
        }
    }

    const minimum = minimumNodeVersion();
    if (nodeVersionMeetsMinimum(nodeVersion, minimum)) {
        addCheck(checks, "node_version", "ok", `Node ${nodeVersion} satisfies >=${minimum}.`);
    } else {
        addCheck(checks, "node_version", "error", `Node ${nodeVersion} is unsupported. Install Node.js ${minimum} or newer.`);
        nextSteps.push(`Install Node.js ${minimum} or newer.`);
    }

    if (!managedLauncherIsUsable) {
        try {
            const specifier = resolveManagedPackageSpecifier();
            execImpl("npm", ["view", specifier, "version", "--json"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
            addCheck(checks, "npm_package_access", "ok", `${specifier} is visible to npm.`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addCheck(checks, "npm_package_access", "warning", `Could not verify npm package access: ${message}`);
            nextSteps.push("Verify npm can access @satori-code/mcp from this machine.");
        }
    }

    const evaluatedRuntimeContexts = appendRuntimeConfigurationChecks(checks, nextSteps, runtimeContexts);
    const runtimeConfigurations = buildRuntimeConfigurationRows(managedClientProofs, evaluatedRuntimeContexts);

    if (
        evaluatedRuntimeContexts.some((context) => selectedVectorStore(context.environment) === "LanceDB")
        && activeManagedRuntime?.status === "active"
    ) {
        try {
            await (options.loadManagedLanceDb ?? loadManagedLanceDbFromRuntime)(activeManagedRuntime.target);
            addCheck(
                checks,
                "lancedb_native_load",
                "ok",
                "The managed MCP runtime loaded its LanceDB adapter and native dependency without writing database state.",
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addCheck(
                checks,
                "lancedb_native_load",
                "error",
                `The managed MCP runtime could not load LanceDB: ${message}`,
            );
            nextSteps.push("Reinstall Satori on a supported Node/platform pair or repair the managed MCP runtime package.");
        }
    }

    for (const context of evaluatedRuntimeContexts) {
        if (context.staticChecks.some((check) => check.status === "error")) {
            continue;
        }
        const checkSuffix = evaluatedRuntimeContexts.length === 1 || !context.client ? "" : `_${context.client}`;
        const provider = context.environment.EMBEDDING_PROVIDER?.trim() || "VoyageAI";
        let ollamaIdentityFailed = false;
        if (provider === "Ollama") {
            const host = context.environment.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434";
            const model = context.environment.EMBEDDING_MODEL?.trim() || "nomic-embed-text";
            try {
                if ((context.environment.SATORI_RUNTIME_PROFILE?.trim() || "connected") === "offline") {
                    assertLocalOnlyEndpoint(host, "OLLAMA_HOST");
                }
                const resolveOllamaIdentity = options.resolveOllamaIdentity
                    ?? (activeManagedRuntime?.status === "active"
                        ? async (input: { model: string; host?: string }) => {
                            const requireFromRuntime = createRequire(activeManagedRuntime.target);
                            const coreEntry = requireFromRuntime.resolve("@satori-code/core");
                            const core = await import(pathToFileURL(coreEntry).href) as {
                                resolveOllamaModelIdentity: NonNullable<DoctorOptions["resolveOllamaIdentity"]>;
                            };
                            return core.resolveOllamaModelIdentity(input);
                        }
                        : undefined);
                if (!resolveOllamaIdentity) {
                    throw new Error("Ollama identity probe requires an active managed Satori runtime.");
                }
                const identity: Readonly<ResolvedOllamaModelIdentity> = await resolveOllamaIdentity({ model, host });
                const recordedDigest = context.environment.OLLAMA_MODEL_DIGEST?.trim().replace(/^sha256:/i, "").toLowerCase();
                if (recordedDigest && recordedDigest !== identity.artifactDigest) {
                    throw new Error("installed model digest does not match OLLAMA_MODEL_DIGEST");
                }
                addCheck(
                    checks,
                    `ollama_model_identity${checkSuffix}`,
                    "ok",
                    `${clientLabel(context.client)} Ollama model ${identity.resolvedModel} resolved with dimension ${identity.dimension} and the recorded artifact digest.`,
                );
            } catch (error) {
                ollamaIdentityFailed = true;
                const message = error instanceof Error ? error.message : String(error);
                addCheck(checks, `ollama_model_identity${checkSuffix}`, "error", `${clientLabel(context.client)} Ollama model identity probe failed: ${message}`);
                nextSteps.push(context.client
                    ? `${clientLabel(context.client)}: Start Ollama and reinstall the offline profile with the intended local model.`
                    : "Start Ollama and reinstall the offline profile with the intended local model.");
            }
        }

        if ((context.environment.SATORI_RUNTIME_PROFILE?.trim() || "connected") === "offline") {
            addCheck(
                checks,
                `offline_execution_invariant${checkSuffix}`,
                ollamaIdentityFailed ? "error" : "ok",
                `${clientLabel(context.client)} offline profile selects LanceDB and ${provider}; remote inference and reranking construction is prohibited.`,
            );
        }
    }

    const activeRuntimeOwnersPath = options.runtimeOwnersPath
        || resolveRuntimeOwnerRegistryPath(homeDir, runtimeEnv);
    const runtimeOwnersPaths = options.runtimeOwnersPath
        ? [options.runtimeOwnersPath]
        : discoverRuntimeOwnerRegistryPaths(homeDir, runtimeEnv);
    const inspectProcess = resolveProcessInspector(options);
    const expectedRuntimeOwnerVersion = activeManagedRuntime?.status === "active"
        ? activeManagedRuntime.mcpVersion
        : (packageVersions.find((entry) => entry.name === "@satori-code/mcp")?.version ?? null);
    appendRuntimeOwnerChecks(
        checks,
        nextSteps,
        runtimeOwnersPaths,
        activeRuntimeOwnersPath,
        inspectProcess,
        expectedRuntimeOwnerVersion,
    );

    if (options.mutationLeasesPath !== null) {
        appendMutationLeaseChecks(
            checks,
            nextSteps,
            options.mutationLeasesPath || path.join(
                resolveSatoriStateRoot({
                    configured: runtimeEnv.SATORI_STATE_ROOT,
                    homeDir,
                }),
                "runtime",
                "mutation-leases",
            ),
            inspectProcess,
        );
    }

    if (managedLauncherPath) {
        appendManagedLauncherCheck(checks, nextSteps, activeManagedRuntime, notInstalled);
    }

    appendManagedClientChecks(
        checks,
        nextSteps,
        managedClientProofs,
        notInstalled ? { launcherStatus: activeManagedRuntime?.status ?? "missing" } : null,
    );

    if (nextSteps.length > 0 && !notInstalled) {
        nextSteps.push("Restart your MCP client after changing Satori environment variables.");
    }

    return {
        status: overallStatus(checks),
        packageVersions,
        packageVersionNote: PACKAGE_VERSION_NOTE,
        checks,
        nextSteps: [...new Set(nextSteps)],
        managedRuntime,
        runtimeConfigurations,
        localDiagnostics: readLocalDiagnosticsSummary(
            options.diagnosticsPath || path.join(homeDir, ".satori", "diagnostics", "events.jsonl"),
        ),
    };
}

function appendManagedClientChecks(
    checks: DoctorCheck[],
    nextSteps: string[],
    proofs: ReturnType<typeof inspectManagedClientConfigurations>,
    notInstalled: { launcherStatus: ManagedLauncherStatus } | null,
): void {
    if (notInstalled) {
        addCheck(
            checks,
            "managed_client_configuration",
            "error",
            "Satori is not installed for any supported client (Codex, Claude Code, OpenCode, Antigravity).",
        );
        // A present-but-broken launcher already carries its own repair step.
        if (notInstalled.launcherStatus === "missing") {
            nextSteps.push(`Run ${SATORI_CLI_NPX_COMMAND} install.`);
        }
        return;
    }
    if (proofs.length === 0) {
        addCheck(checks, "managed_client_configuration", "warning", "No supported MCP client has a Satori configuration entry.");
        nextSteps.push(`Run ${SATORI_CLI_NPX_COMMAND} install.`);
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
        for (const failure of failures) {
            const provider = failure.runtimeEnvironment?.EMBEDDING_PROVIDER?.trim();
            const runtime = failure.runtimeEnvironment?.SATORI_RUNTIME_PROFILE?.trim()
                || (provider === "Potion" || provider === "Ollama"
                    ? "offline"
                    : provider
                        ? "connected"
                        : undefined);
            const runtimeArgs = runtime === "offline"
                ? " --runtime offline"
                : runtime === "connected"
                    ? ` --runtime voyage --vector-store ${selectedVectorStore(failure.runtimeEnvironment || {}) === "Milvus" ? "milvus" : "lancedb"}`
                    : "";
            nextSteps.push(
                `Run ${SATORI_CLI_NPX_COMMAND} install --client ${failure.client}${runtimeArgs}, then restart ${clientLabel(failure.client)}.`,
            );
        }
    }
}

function appendRuntimeOwnerRegistryCheck(
    checks: DoctorCheck[],
    nextSteps: string[],
    runtimeOwnersPath: string,
    inspectProcess: (pid: number) => DoctorProcessSnapshot | null,
    expectedActiveMcpVersion: string | null,
    isActiveRegistry: boolean,
): void {
    const registryLabel = isActiveRegistry ? "Active" : "Inactive/historical";
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(runtimeOwnersPath, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addCheck(checks, "runtime_owners", "warning", `Could not parse ${registryLabel.toLowerCase()} runtime owner registry at ${runtimeOwnersPath}: ${message}`);
        nextSteps.push(`Inspect or remove the corrupt runtime owner file at ${runtimeOwnersPath}, then restart Satori MCP clients.`);
        return;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { owners?: unknown }).owners)) {
        addCheck(checks, "runtime_owners", "warning", `${registryLabel} runtime owner registry shape is invalid at ${runtimeOwnersPath}.`);
        nextSteps.push(`Fix or remove ${runtimeOwnersPath}, then restart Satori MCP clients.`);
        return;
    }

    const owners = (parsed as { owners: Array<Record<string, unknown>> }).owners;
    const registryLocation = ` at ${runtimeOwnersPath}`;
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
                ? `${registryLabel} runtime owner registry has ${dead} stale (dead or replaced) entr${dead === 1 ? "y" : "ies"} and no live MCP owners${registryLocation}.`
                : `${registryLabel} runtime owner registry is empty${registryLocation}.`,
        );
        if (dead > 0) {
            nextSteps.push(`Start any Satori MCP client once so dead runtime owners prune, or remove stale entries from ${runtimeOwnersPath} after all MCP processes exit.`);
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
            `${registryLabel} Satori MCP runtime identities conflict${registryLocation} (pids ${pids}; versions ${versions.join(", ")}; evidence: ${conflictReasons.join(", ")}). manage_index mutations will return runtime_owner_conflict.`,
        );
        nextSteps.push(
            `Stop extra Satori MCP clients for ${runtimeOwnersPath} so one runtime identity remains (live pids: ${pids}), then restart the intended client.`,
        );
        return;
    }

    const installedMismatches = expectedActiveMcpVersion
        ? live.filter((owner) => String(owner.satoriVersion || "unknown") !== expectedActiveMcpVersion)
        : [];
    if (installedMismatches.length > 0) {
        const details = installedMismatches.map((owner) => `pid=${owner.pid} version=${String(owner.satoriVersion || "unknown")}`).join(", ");
        addCheck(
            checks,
            "runtime_owners",
            "error",
            `${registryLabel} Satori MCP runtime${registryLocation} does not match expected MCP version ${expectedActiveMcpVersion}: ${details}. This is a stale resident runtime.`,
        );
        nextSteps.push(`Stop stale Satori MCP runtime pids ${installedMismatches.map((owner) => owner.pid).join(", ")} and restart the intended MCP client.`);
        return;
    }

    if (live.length > 1) {
        addCheck(
            checks,
            "runtime_owners",
            "ok",
            `${live.length} live Satori MCP processes in the ${registryLabel.toLowerCase()} registry${registryLocation} share version ${versions[0]} (pids ${pids}). Same identity is allowed; stop extras only if you want a single client.`,
        );
        return;
    }

    addCheck(
        checks,
        "runtime_owners",
        "ok",
        `One live Satori MCP owner in the ${registryLabel.toLowerCase()} registry${registryLocation}: pid=${pids} satori@${versions[0]}.`,
    );
}

function appendRuntimeOwnerChecks(
    checks: DoctorCheck[],
    nextSteps: string[],
    runtimeOwnersPaths: readonly string[],
    activeRuntimeOwnersPath: string,
    inspectProcess: (pid: number) => DoctorProcessSnapshot | null,
    expectedActiveMcpVersion: string | null,
): void {
    const existingPaths = runtimeOwnersPaths.filter((filePath) => fs.existsSync(filePath));
    if (fs.existsSync(activeRuntimeOwnersPath)) {
        appendRuntimeOwnerRegistryCheck(
            checks,
            nextSteps,
            activeRuntimeOwnersPath,
            inspectProcess,
            expectedActiveMcpVersion,
            true,
        );
    } else {
        addCheck(
            checks,
            "runtime_owners",
            "ok",
            `Active runtime owner registry has not been created yet at ${activeRuntimeOwnersPath} (no concurrent MCP owners recorded).`,
        );
    }

    const inactivePaths = existingPaths.filter((filePath) => filePath !== activeRuntimeOwnersPath);
    const emptyInactivePaths: string[] = [];
    for (const runtimeOwnersPath of inactivePaths) {
        try {
            const parsed = JSON.parse(fs.readFileSync(runtimeOwnersPath, "utf8")) as { owners?: unknown };
            if (Array.isArray(parsed?.owners) && parsed.owners.length === 0) {
                emptyInactivePaths.push(runtimeOwnersPath);
                continue;
            }
        } catch {
            // Let the full registry check report malformed historical state.
        }
        appendRuntimeOwnerRegistryCheck(
            checks,
            nextSteps,
            runtimeOwnersPath,
            inspectProcess,
            expectedActiveMcpVersion,
            false,
        );
    }

    if (emptyInactivePaths.length > 0) {
        addCheck(
            checks,
            "runtime_owners_history",
            "ok",
            `${emptyInactivePaths.length} inactive/historical runtime owner ${emptyInactivePaths.length === 1 ? "registry is" : "registries are"} retained and empty: ${emptyInactivePaths.join(", ")}.`,
        );
    }
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
        || !["create", "reindex", "sync", "clear", "gc"].includes(lease.action)
        || typeof lease.pid !== "number"
        || !Number.isSafeInteger(lease.pid)
        || lease.pid <= 0
        || typeof lease.ownerId !== "string"
        || lease.ownerId.length === 0
        || (lease.processStartTime !== undefined && typeof lease.processStartTime !== "string")
        || typeof lease.acquiredAt !== "string"
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

async function loadManagedLanceDbFromRuntime(runtimeTarget: string): Promise<void> {
    const requireFromRuntime = createRequire(runtimeTarget);
    const resolvedModule = requireFromRuntime.resolve("@satori-code/core/lancedb");
    await import(pathToFileURL(resolvedModule).href);
}

function isRegularFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function findMcpPackage(runtimeTarget: string): {
    root: string;
    packageJsonPath: string;
    version: string;
} | null {
    let current = path.dirname(runtimeTarget);
    while (true) {
        const packageJsonPath = path.join(current, "package.json");
        const info = readJsonVersion(packageJsonPath);
        if (info?.name === "@satori-code/mcp") {
            return { root: current, packageJsonPath, version: info.version };
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
    activeManagedRuntime: ActiveManagedRuntimeResolution | null,
    notInstalled: boolean,
): void {
    const resolution = activeManagedRuntime;
    const status = resolution?.status ?? "missing";
    if (status === "missing" || !resolution) {
        // The not-installed problem already says this and carries the single install step.
        if (notInstalled) return;
        addCheck(checks, "managed_launcher", "warning", `Managed Satori launcher is missing at ${resolution?.launcherPath || ""}.`);
        nextSteps.push(`Run ${SATORI_CLI_NPX_COMMAND} install to create the stable managed launcher.`);
        return;
    }
    if (status === "active") {
        addCheck(
            checks,
            "managed_launcher",
            "ok",
            `Managed Satori launcher targets @satori-code/mcp@${resolution.mcpVersion}: ${resolution.launcherPath}.`,
        );
        return;
    }
    if (status === "malformed") {
        addCheck(checks, "managed_launcher", "error", `Managed Satori launcher is malformed at ${resolution.launcherPath}.`);
        nextSteps.push(`Rerun ${SATORI_CLI_NPX_COMMAND} install to replace the managed launcher with the current generated form.`);
        return;
    }
    if (status === "missing_target") {
        addCheck(checks, "managed_launcher", "error", `Managed Satori launcher target does not exist: ${resolution.target}.`);
        nextSteps.push(`Rerun ${SATORI_CLI_NPX_COMMAND} install to install the resident MCP runtime and refresh its launcher target.`);
        return;
    }
    if (status === "outside_store") {
        addCheck(
            checks,
            "managed_launcher",
            "warning",
            `Managed Satori launcher target is outside the managed runtime store: ${resolution.target}.`,
        );
        nextSteps.push(`Inspect the custom launcher target, then rerun ${SATORI_CLI_NPX_COMMAND} install to restore the managed runtime.`);
        return;
    }
    // custom: the launcher does not use the installer-generated Node form.
    addCheck(
        checks,
        "managed_launcher",
        "warning",
        `Managed Satori launcher does not use the expected Node launcher form: ${resolution.launcherPath}.`,
    );
    nextSteps.push(`Rerun ${SATORI_CLI_NPX_COMMAND} install to replace the managed launcher with the current generated form.`);
}
