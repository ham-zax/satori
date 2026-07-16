import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { CliError } from "./errors.js";
import type { InstallClient, InstallProfile, InstallRuntime, InstallVectorStore } from "./args.js";
import {
    planInstallRuntimeEnvironment,
    probeLanceDbRuntime,
    probeManagedRuntimeCandidate,
    runInstallPreflight,
    selectedConnectedVectorStore,
    type InstallPreflightDependencies,
    type InstallPreflightInput,
    type InstallPreflightResult,
    type LanceDbModule,
} from "./install-preflight.js";
import { resolveManagedPackageSpecifier } from "./managed-package.js";
import { buildLauncherScript, parseManagedLauncherEnvironment } from "./managed-launcher-script.mjs";

const MANAGED_BLOCK_START = "# >>> satori-cli managed satori start >>>";
const MANAGED_BLOCK_END = "# <<< satori-cli managed satori end <<<";
const CODEX_ENV_TEMPLATE_START = "# >>> satori-cli optional satori env template >>>";
const CODEX_ENV_TEMPLATE_END = "# <<< satori-cli optional satori env template <<<";
const CODEX_GUIDANCE_HOOK_START = "# >>> satori-cli managed codex guidance hook start >>>";
const CODEX_GUIDANCE_HOOK_END = "# <<< satori-cli managed codex guidance hook end <<<";
const INSTRUCTIONS_BLOCK_START = "<!-- satori-mcp:start -->";
const INSTRUCTIONS_BLOCK_END = "<!-- satori-mcp:end -->";
const OWNED_SKILL_DIRS = ["satori"] as const;
const MANAGED_RUNTIME_DIR = "mcp-runtime";
const MANAGED_BIN_DIR = "bin";
const MANAGED_LAUNCHER_FILE = "satori-mcp.js";
const SATORI_RUNTIME_ENV_VARS = [
    "SATORI_RUNTIME_PROFILE",
    "VECTOR_STORE_PROVIDER",
    "LANCEDB_PATH",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_OUTPUT_DIMENSION",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "VOYAGEAI_API_KEY",
    "VOYAGEAI_RERANKER_MODEL",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "OLLAMA_HOST",
    "OLLAMA_MODEL",
    "OLLAMA_MODEL_DIGEST",
    "MILVUS_ADDRESS",
    "MILVUS_TOKEN",
    "READ_FILE_MAX_LINES",
    "MCP_ENABLE_WATCHER",
    "MCP_WATCH_DEBOUNCE_MS",
] as const;
const CODEX_ENV_TEMPLATE_LINES = [
    CODEX_ENV_TEMPLATE_START,
    "# Optional direct Codex env values. Uncomment/fill these if you prefer",
    "# ~/.codex/config.toml to store Satori runtime settings directly.",
    "# This template is outside the launcher block so reinstall keeps edits.",
    "# [mcp_servers.satori.env]",
    "# SATORI_RUNTIME_PROFILE = \"connected\"",
    "# VECTOR_STORE_PROVIDER = \"LanceDB\"",
    "# LANCEDB_PATH = \"/absolute/path/to/.satori/vector/lancedb\"",
    "# EMBEDDING_PROVIDER = \"VoyageAI\"",
    "# EMBEDDING_MODEL = \"voyage-code-3\"",
    "# EMBEDDING_OUTPUT_DIMENSION = \"1024\"",
    "# VOYAGEAI_API_KEY = \"pa-...\"",
    "# VOYAGEAI_RERANKER_MODEL = \"rerank-2.5\"",
    "# MILVUS_ADDRESS = \"https://your-zilliz-endpoint\"",
    "# MILVUS_TOKEN = \"your-zilliz-token\"",
    CODEX_ENV_TEMPLATE_END,
] as const;
const CODEX_GUIDANCE_HOOK_MESSAGE = "Satori MCP: use search_codebase for semantic ownership/context discovery, then use the returned codebaseRoot and canonical target for call_graph/read_file proof. Use exact ids/constants with operators when known; verify inbound impact with rg/tests. Reindex only on requires_reindex/hints.reindex.";
const CODEX_GUIDANCE_HOOK_SCRIPT = [
    `msg=${JSON.stringify(CODEX_GUIDANCE_HOOK_MESSAGE)}`,
    'key=$(printf "%s" "$PWD" | sed "s#[^A-Za-z0-9_.-]#_#g" | cut -c1-120)',
    'uid=$(id -u 2>/dev/null || printf "user")',
    'dir="${XDG_RUNTIME_DIR:-/tmp}/satori-codex-guidance.${uid}"',
    'mkdir -p "$dir" 2>/dev/null || true',
    'chmod 700 "$dir" 2>/dev/null || true',
    'stamp="$dir/${key:-global}"',
    'now=$(date +%s)',
    'last=$(cat "$stamp" 2>/dev/null || printf "0")',
    'case "$last" in *[!0-9]*|"") last=0;; esac',
    'if [ $((now - last)) -lt 10 ]; then exit 0; fi',
    'umask 077',
    'printf "%s" "$now" > "$stamp" 2>/dev/null || true',
    'printf "%s\\n" "$msg"',
].join("; ");
const CODEX_GUIDANCE_HOOK_COMMAND = `sh -lc '${CODEX_GUIDANCE_HOOK_SCRIPT}'`;
const CODEX_AGENT_INSTRUCTIONS = `# Satori MCP

This project uses Satori MCP for semantic-first code exploration, freshness-aware navigation, and index lifecycle management.

## Priority Order
1. \`search_codebase\` - Start with plain-English behavior or ownership queries; narrow with \`lang:\`, \`path:\`, \`must:\`, and \`exclude:\`
2. \`file_outline\` - lock exact symbol spans before reading or editing
3. \`call_graph\` - inspect outbound relationships and available caller/callee context when supported
4. \`read_file\` - open canonical bounded symbol context or bounded line windows for final evidence
5. \`manage_index\` - check status, create, sync, reindex, or clear only when explicitly needed

## When To Use Satori
- Use Satori primarily for semantic code exploration: finding behavioral owners, context-building, and understanding how a feature is implemented.
- Prefer plain-English queries first when the task is about intent, policy, ownership, runtime behavior, or unfamiliar code.
- Switch to exact identifiers, constants, warning codes, and path-scoped operators when narrowing or proving a candidate result.

## Verification Rules
- Treat the envelope \`recommendedNextAction\` as the default next move unless the user requested a different proof path.
- Read every \`warnings[].action\`; warnings are degraded, not fatal, unless \`blocksUse=true\`.
- Grouped \`formatVersion: 2\` results expose one canonical \`target\`. Prefer the returned \`recommendedNextAction\`. For a concrete symbol, the canonical read uses \`mode="plain"\` and \`open_symbol={contractVersion:2,symbolId,context:{preset:"implementation"}}\`; otherwise read the 1-based inclusive \`target.span\`.
- Pass \`target\` directly to \`call_graph\` only when \`navigation.graph="ready"\`; that state always carries \`navigation.inbound="verify"\`. Use optional \`callerSearchTerm\` in a separate \`must:<term> <term>\` search to verify inbound references.
- If any tool returns \`requires_reindex\` or \`hints.reindex\`, stop and run \`manage_index(action="reindex")\`; do not substitute \`sync\`.
- Do not treat call_graph inbound results as sole authority for blast radius; verify inbound impact with rg, tests, or direct references.
- For ultra-fast exact literal lookup, local lexical search may still be faster; use Satori when semantic ownership or freshness-aware navigation matters.
`;
const OPENCODE_INSTRUCTIONS = `# Satori MCP

This project uses Satori MCP for plain-English semantic code discovery, deterministic proof navigation, and index lifecycle management.

## Priority Order
1. \`search_codebase\` - start with behavior/concept queries; use exact identifiers or constants when known
2. \`file_outline\` - lock exact symbol spans before reading or editing
3. \`call_graph\` - inspect callers and callees when supported
4. \`read_file\` - open canonical bounded symbol context or fallback windows
5. \`manage_index\` - create, sync, reindex, or inspect index status

## Rules
- Prefer Satori for semantic code discovery before grep/glob.
- Start with plain-English behavior questions; switch to exact ids, constants, and operators for proof.
- Prefer the envelope \`recommendedNextAction\` and inspect every \`warnings[].action\`.
- In grouped \`formatVersion: 2\` output, use \`recommendedNextAction\`; exact-symbol reads require \`mode\`, \`contractVersion: 2\`, one identity, and one context or continuation operation. Pass \`target\` to \`call_graph\` only when \`navigation.graph="ready"\`.
- Treat graph-ready \`navigation.inbound="verify"\` as mandatory caller verification. Use optional \`callerSearchTerm\` with a separate \`must:<term> <term>\` search before treating inbound graph results as complete.
- If a tool returns \`requires_reindex\`, run \`manage_index(action="reindex")\` and retry the original call.
- Read the relevant implementation and call sites before editing behavior.
`;

type ExecFileSyncLike = typeof execFileSync;

type ClientName = Exclude<InstallClient, "all">;

export interface ManagedRuntimeCommand {
    command: string;
    args: string[];
}

type InstallCommandBase = {
        kind: "install";
        client: InstallClient;
        dryRun: boolean;
        installGuidanceHook?: boolean;
        profile?: InstallProfile;
};

export type InstallCommandInput =
    | (InstallCommandBase & {
        runtime: "voyage";
        vectorStore?: InstallVectorStore;
        ollamaModel?: never;
    })
    | (InstallCommandBase & {
        runtime: "offline";
        vectorStore?: "LanceDB";
        ollamaModel: string;
    })
    | {
        kind: "uninstall";
        client: InstallClient;
        dryRun: boolean;
    };

export interface InstallCommandOptions {
    homeDir?: string;
    repoDir?: string;
    packageSpecifier?: string;
    skillAssetRoot?: string;
    runtimeCommand?: ManagedRuntimeCommand;
    execFileSyncImpl?: ExecFileSyncLike;
    env?: NodeJS.ProcessEnv;
    preflightDependencies?: InstallPreflightDependencies;
    preflightRunner?: (
        input: InstallPreflightInput,
        dependencies?: InstallPreflightDependencies,
    ) => Promise<InstallPreflightResult>;
}

export interface ClientInstallResult {
    client: ClientName;
    configPath: string;
    skillsPath?: string;
    instructionsPath?: string;
    configChanged: boolean;
    skillsChanged: boolean;
    instructionsChanged: boolean;
    status: "updated" | "unchanged";
    dryRun: boolean;
}

export interface InstallCommandResult {
    action: "install" | "uninstall";
    client: InstallClient;
    dryRun: boolean;
    /** Managed MCP package specifier used for runtime install (install only). */
    packageSpecifier?: string;
    profile?: InstallProfile;
    profileConfigPath?: string;
    profileConfigChanged?: boolean;
    runtime?: InstallRuntime;
    /** Non-secret runtime values persisted in the managed launcher. */
    runtimeEnvironment?: Readonly<Record<string, string>>;
    results: ClientInstallResult[];
}

export interface InstallPlan {
    readonly command: InstallCommandInput;
    readonly homeDir: string;
    readonly packageSpecifier: string;
    readonly plannedRuntimeCommand: ManagedRuntimeCommand;
    readonly clientCommand: ManagedRuntimeCommand;
    readonly profileMutation: FileMutation & { filePath?: string };
    readonly prepared: PreparedMutation[];
    readonly options: InstallCommandOptions;
}

interface ClientTarget {
    client: ClientName;
    configPath: string;
    companions: CompanionTarget[];
}

type CompanionTarget =
    | { kind: "skills"; path: string }
    | { kind: "instructions"; path: string; instructions: string };

interface CompanionMutation {
    companion: CompanionTarget;
    changed: boolean;
    assertUnchanged?: () => void;
    apply: () => void;
}

interface PreparedMutation {
    target: ClientTarget;
    configMutation: FileMutation;
    configChanged: boolean;
    companionMutations: CompanionMutation[];
}

interface ManagedRuntimeCandidate {
    readonly command: ManagedRuntimeCommand;
    readonly identity: {
        readonly name: string;
        readonly version: string;
    };
    readonly runtimeRoot: string;
    readonly newlyInstalled: boolean;
}

interface FileMutation {
    changed: boolean;
    assertUnchanged?: () => void;
    apply: () => void;
}

export interface ManagedClientConfigProof {
    client: ClientName;
    configPath: string;
    status: "ok" | "error";
    message: string;
}

function resolveDefaultSkillAssetRoot(): string {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "..", "assets", "skills");
}

function resolveDefaultPackageSpecifier(): string {
    try {
        return resolveManagedPackageSpecifier();
    } catch {
        // Fall through to hard failure below.
    }
    throw new CliError("E_USAGE", "Unable to resolve the installed Satori package version for CLI install.", 2);
}

function resolveClientTargets(homeDir: string): ClientTarget[] {
    return [
        {
            client: "codex",
            configPath: path.join(homeDir, ".codex", "config.toml"),
            companions: [
                {
                    kind: "skills",
                    path: path.join(homeDir, ".codex", "skills"),
                },
                {
                    kind: "instructions",
                    path: path.join(homeDir, ".codex", "AGENTS.md"),
                    instructions: CODEX_AGENT_INSTRUCTIONS,
                },
            ],
        },
        {
            client: "claude",
            configPath: path.join(homeDir, ".claude.json"),
            companions: [{
                kind: "skills",
                path: path.join(homeDir, ".claude", "skills"),
            }],
        },
        {
            client: "opencode",
            configPath: path.join(homeDir, ".config", "opencode", "opencode.json"),
            companions: [{
                kind: "instructions",
                path: path.join(homeDir, ".config", "opencode", "AGENTS.md"),
                instructions: OPENCODE_INSTRUCTIONS,
            }],
        },
    ];
}

function selectTargets(homeDir: string, client: InstallClient): ClientTarget[] {
    const targets = resolveClientTargets(homeDir);
    if (client === "all") {
        return targets;
    }
    return targets.filter((target) => target.client === client);
}

function ensureParentDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
}

function readTextIfExists(filePath: string): string | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return fs.readFileSync(filePath, "utf8");
}

function assertFileContentUnchanged(filePath: string, expected: string | null): void {
    if (readTextIfExists(filePath) === expected) {
        return;
    }
    throw new CliError(
        "E_INSTALL_PLAN_STALE",
        `Refusing to overwrite '${filePath}' because it changed after the installation plan was created. Rerun the same command against the current file.`,
        1,
    );
}

function guardFileMutation(filePath: string, expected: string | null, mutation: FileMutation): FileMutation {
    assertFileContentUnchanged(filePath, expected);
    return {
        ...mutation,
        assertUnchanged: () => assertFileContentUnchanged(filePath, expected),
    };
}

function normalizeTrailingNewline(value: string): string {
    return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toTomlString(value: string): string {
    return JSON.stringify(value);
}

function buildTomlArray(values: string[]): string {
    return `[${values.map(toTomlString).join(", ")}]`;
}

function buildSatoriProjectConfig(profile: InstallProfile): string {
    return [
        "# Satori project config",
        "[index]",
        `profile = ${toTomlString(profile)}`,
        "",
    ].join("\n");
}

function updateSatoriProjectConfig(current: string, profile: InstallProfile): string {
    if (current.trim().length === 0) {
        return buildSatoriProjectConfig(profile);
    }

    const lines = current.replace(/\r\n/g, "\n").split("\n");
    let indexTableLine = -1;
    let nextTableLine = lines.length;

    for (let i = 0; i < lines.length; i += 1) {
        const tableMatch = lines[i]?.match(/^\s*\[([A-Za-z0-9_.-]+)\]\s*(?:#.*)?$/);
        if (!tableMatch) {
            continue;
        }
        if (tableMatch[1] === "index") {
            indexTableLine = i;
            nextTableLine = lines.length;
            continue;
        }
        if (indexTableLine !== -1 && nextTableLine === lines.length) {
            nextTableLine = i;
        }
    }

    if (indexTableLine === -1) {
        return `${normalizeTrailingNewline(current)}\n[index]\nprofile = ${toTomlString(profile)}\n`;
    }

    for (let i = indexTableLine + 1; i < nextTableLine; i += 1) {
        if (/^\s*profile\s*=/.test(lines[i] || "")) {
            lines[i] = `profile = ${toTomlString(profile)}`;
            return normalizeTrailingNewline(lines.join("\n"));
        }
    }

    lines.splice(indexTableLine + 1, 0, `profile = ${toTomlString(profile)}`);
    return normalizeTrailingNewline(lines.join("\n"));
}

function prepareProjectProfileInstall(repoDir: string, profile: InstallProfile | undefined): FileMutation & { filePath?: string } {
    if (!profile) {
        return { changed: false, apply: () => {} };
    }
    const filePath = path.join(repoDir, "satori.toml");
    const currentFile = readTextIfExists(filePath);
    const current = currentFile ?? "";
    const next = updateSatoriProjectConfig(current, profile);
    return {
        filePath,
        changed: next !== current,
        assertUnchanged: () => assertFileContentUnchanged(filePath, currentFile),
        apply: () => {
            if (next === current) {
                return;
            }
            ensureParentDir(filePath);
            fs.writeFileSync(filePath, next, "utf8");
        },
    };
}

function runtimeEnvMap(valueForName: (name: string) => string): Record<string, string> {
    return Object.fromEntries(SATORI_RUNTIME_ENV_VARS.map((name) => [name, valueForName(name)]));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

function mergeRuntimeEnv(existing: unknown, defaults: Record<string, string>): Record<string, unknown> {
    return {
        ...defaults,
        ...(objectValue(existing) ?? {}),
    };
}

/** Bash-style `${VAR:-}` expands unset vars to empty string and can override host env. */
function isEmptyDefaultingShellExpansion(value: string): boolean {
    return /^\$\{[A-Z0-9_]+:-\}$/.test(value.trim());
}

/**
 * Keep only non-empty managed env entries. Prefer omitting keys over writing
 * empty-defaulting placeholders that inject "" into the MCP process.
 */
function buildPreservedManagedEnv(existing: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    const existingEnv = objectValue(existing);
    if (!existingEnv) {
        return out;
    }
    for (const name of SATORI_RUNTIME_ENV_VARS) {
        const raw = existingEnv[name];
        if (typeof raw !== "string") {
            continue;
        }
        if (raw.trim().length === 0 || isEmptyDefaultingShellExpansion(raw)) {
            continue;
        }
        out[name] = raw;
    }
    return out;
}

function packageNameFromSpecifier(packageSpecifier: string): string {
    if (packageSpecifier.startsWith("@")) {
        const versionMarker = packageSpecifier.indexOf("@", 1);
        return versionMarker === -1 ? packageSpecifier : packageSpecifier.slice(0, versionMarker);
    }
    const versionMarker = packageSpecifier.indexOf("@");
    return versionMarker === -1 ? packageSpecifier : packageSpecifier.slice(0, versionMarker);
}

function safeRuntimeDirName(packageSpecifier: string): string {
    return packageSpecifier.replace(/[^A-Za-z0-9._@-]+/g, "-");
}

function resolveRuntimeRoot(homeDir: string, packageSpecifier: string): string {
    return path.join(homeDir, ".satori", MANAGED_RUNTIME_DIR, safeRuntimeDirName(packageSpecifier));
}

function resolveRuntimePackageRoot(homeDir: string, packageSpecifier: string): string {
    return path.join(resolveRuntimeRoot(homeDir, packageSpecifier), "node_modules", ...packageNameFromSpecifier(packageSpecifier).split("/"));
}

function resolveRuntimePackageRootFromRoot(runtimeRoot: string, packageSpecifier: string): string {
    return path.join(runtimeRoot, "node_modules", ...packageNameFromSpecifier(packageSpecifier).split("/"));
}

function resolveRuntimeEntryPath(packageRoot: string, packageJson?: { bin?: unknown; main?: unknown }): string {
    const bin = packageJson?.bin;
    let relativeEntry = "dist/index.js";
    if (bin && typeof bin === "object" && !Array.isArray(bin) && typeof (bin as Record<string, unknown>).satori === "string") {
        relativeEntry = (bin as Record<string, string>).satori;
    } else if (typeof bin === "string") {
        relativeEntry = bin;
    } else if (typeof packageJson?.main === "string") {
        relativeEntry = packageJson.main;
    }
    return path.resolve(packageRoot, relativeEntry);
}

export function resolveLauncherPath(homeDir: string): string {
    return path.join(homeDir, ".satori", MANAGED_BIN_DIR, MANAGED_LAUNCHER_FILE);
}

function plannedManagedRuntimeCommand(homeDir: string, packageSpecifier: string): ManagedRuntimeCommand {
    return {
        command: process.execPath,
        args: [resolveRuntimeEntryPath(resolveRuntimePackageRoot(homeDir, packageSpecifier))],
    };
}

export function resolveManagedClientCommand(homeDir: string): ManagedRuntimeCommand {
    return {
        command: process.execPath,
        args: [resolveLauncherPath(homeDir)],
    };
}

function writeTextFileAtomic(filePath: string, content: string, mode?: number): void {
    ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, content, "utf8");
    if (mode !== undefined) {
        fs.chmodSync(tempPath, mode);
    }
    fs.renameSync(tempPath, filePath);
}

function prepareLauncherInstall(
    homeDir: string,
    runtimeCommand: ManagedRuntimeCommand,
    managedEnv: Readonly<Record<string, string>> = {},
): FileMutation {
    const launcherPath = resolveLauncherPath(homeDir);
    const current = readTextIfExists(launcherPath);
    const next = buildLauncherScript({
        command: runtimeCommand.command,
        args: runtimeCommand.args,
        managedEnv,
    });
    return {
        changed: current !== next,
        assertUnchanged: () => assertFileContentUnchanged(launcherPath, current),
        apply: () => {
            if (current === next) {
                return;
            }
            writeTextFileAtomic(launcherPath, next, 0o755);
        },
    };
}

function npmOutput(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const stdout = "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string"
        ? (error as { stdout: string }).stdout
        : "";
    const stderr = "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    return `${stdout}\n${stderr}\n${error.message}`.trim();
}

function installManagedRuntimeCandidate(
    homeDir: string,
    packageSpecifier: string,
    execImpl: ExecFileSyncLike
): ManagedRuntimeCandidate {
    const stableRuntimeRoot = resolveRuntimeRoot(homeDir, packageSpecifier);
    const existing = resolveInstalledRuntimeCommand(stableRuntimeRoot, packageSpecifier, true);
    if (existing) {
        return {
            ...existing,
            runtimeRoot: stableRuntimeRoot,
            newlyInstalled: false,
        };
    }
    // Never reinstall into a directory that may still be the target of the
    // active launcher. A failed or stale reinstall must leave the old runtime
    // bytes untouched.
    const runtimeRoot = fs.existsSync(stableRuntimeRoot)
        ? fs.mkdtempSync(`${stableRuntimeRoot}.generation-`)
        : stableRuntimeRoot;
    ensureDir(runtimeRoot);
    try {
        execImpl("npm", [
            "install",
            "--prefix",
            runtimeRoot,
            "--omit=dev",
            "--no-package-lock",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--",
            packageSpecifier,
        ], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        throw new CliError(
            "E_USAGE",
            `Failed to install Satori MCP runtime package ${packageSpecifier} into ${runtimeRoot}. ${npmOutput(error)}`,
            2
        );
    }

    const installed = resolveInstalledRuntimeCommand(runtimeRoot, packageSpecifier, false);
    if (!installed) {
        const packageRoot = resolveRuntimePackageRootFromRoot(runtimeRoot, packageSpecifier);
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        throw new CliError(
            "E_USAGE",
            `Installed Satori MCP runtime is missing a usable entry under ${packageRoot}.`,
            2,
        );
    }
    return {
        ...installed,
        runtimeRoot,
        newlyInstalled: true,
    };
}

const EXACT_PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function requestedExactPackageVersion(packageSpecifier: string): string | null {
    const packageName = packageNameFromSpecifier(packageSpecifier);
    const suffix = packageSpecifier.slice(packageName.length);
    if (!suffix.startsWith("@")) {
        return null;
    }
    const version = suffix.slice(1);
    return EXACT_PACKAGE_VERSION_PATTERN.test(version) ? version : null;
}

function resolveInstalledRuntimeCommand(
    runtimeRoot: string,
    packageSpecifier: string,
    forReuse: boolean,
): Pick<ManagedRuntimeCandidate, "command" | "identity"> | null {
    const packageRoot = resolveRuntimePackageRootFromRoot(runtimeRoot, packageSpecifier);
    const packageJsonPath = path.join(packageRoot, "package.json");
    let packageJson: { name?: unknown; version?: unknown; bin?: unknown; main?: unknown };
    try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as typeof packageJson;
    } catch {
        return null;
    }
    const expectedName = packageNameFromSpecifier(packageSpecifier);
    const expectedVersion = requestedExactPackageVersion(packageSpecifier);
    if (
        packageJson.name !== expectedName
        || typeof packageJson.version !== "string"
        || !EXACT_PACKAGE_VERSION_PATTERN.test(packageJson.version)
        || (expectedVersion !== null && packageJson.version !== expectedVersion)
        || (forReuse && expectedVersion === null)
    ) {
        return null;
    }

    const command = {
        command: process.execPath,
        args: [resolveRuntimeEntryPath(packageRoot, packageJson)],
    };
    if (!fs.existsSync(command.args[0])) {
        return null;
    }
    return {
        command,
        identity: {
            name: packageJson.name,
            version: packageJson.version,
        },
    };
}

function exactRuntimeLanceDbProbe(runtimeCommand: ManagedRuntimeCommand): (databasePath: string) => Promise<void> {
    const runtimeEntry = runtimeCommand.args[0];
    return async (databasePath: string): Promise<void> => {
        const requireFromRuntime = createRequire(runtimeEntry);
        const resolved = requireFromRuntime.resolve("@zokizuan/satori-core/lancedb");
        await probeLanceDbRuntime(databasePath, {
            loadLanceDb: () => import(pathToFileURL(resolved).href) as Promise<LanceDbModule>,
        });
    };
}

function buildCodexManagedBlock(runtimeCommand: ManagedRuntimeCommand): string {
    return [
        MANAGED_BLOCK_START,
        "[mcp_servers.satori]",
        `command = ${toTomlString(runtimeCommand.command)}`,
        `args = ${buildTomlArray(runtimeCommand.args)}`,
        "# Satori reads provider/vector settings from environment at MCP startup.",
        "# env_vars forwards these names from Codex's parent environment when set.",
        `env_vars = ${buildTomlArray([...SATORI_RUNTIME_ENV_VARS])}`,
        MANAGED_BLOCK_END,
        "",
    ].join("\n");
}

function buildCodexEnvTemplateBlock(): string {
    return `${CODEX_ENV_TEMPLATE_LINES.join("\n")}\n`;
}

function buildCodexGuidanceHookBlock(): string {
    return [
        CODEX_GUIDANCE_HOOK_START,
        "[[hooks.SessionStart]]",
        `matcher = ${toTomlString("startup|resume|clear|compact")}`,
        "",
        "[[hooks.SessionStart.hooks]]",
        `type = ${toTomlString("command")}`,
        `command = ${toTomlString(CODEX_GUIDANCE_HOOK_COMMAND)}`,
        CODEX_GUIDANCE_HOOK_END,
        "",
    ].join("\n");
}

function removeCodexGuidanceHookBlock(content: string): string {
    if (!content.includes(CODEX_GUIDANCE_HOOK_START) || !content.includes(CODEX_GUIDANCE_HOOK_END)) {
        return content;
    }
    return content
        .replace(new RegExp(`\\n?${escapeRegExp(CODEX_GUIDANCE_HOOK_START)}[\\s\\S]*?${escapeRegExp(CODEX_GUIDANCE_HOOK_END)}\\n?`, "m"), "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "");
}

function codexHasSatoriEnvTable(content: string): boolean {
    return /^\s*\[mcp_servers\.satori\.env\]\s*$/m.test(content);
}

function ensureCodexEnvTemplate(content: string): string {
    if (content.includes(CODEX_ENV_TEMPLATE_START) || codexHasSatoriEnvTable(content)) {
        return content;
    }
    return `${normalizeTrailingNewline(content)}\n${buildCodexEnvTemplateBlock()}`;
}

function ensureCodexGuidanceHook(content: string): string {
    const block = buildCodexGuidanceHookBlock();
    if (content.includes(CODEX_GUIDANCE_HOOK_START) && content.includes(CODEX_GUIDANCE_HOOK_END)) {
        return content.replace(
            new RegExp(`${escapeRegExp(CODEX_GUIDANCE_HOOK_START)}[\\s\\S]*?${escapeRegExp(CODEX_GUIDANCE_HOOK_END)}\\n?`, "m"),
            block
        );
    }
    return `${normalizeTrailingNewline(content)}\n${block}`;
}

function codexHasUnmanagedSatoriSection(content: string): boolean {
    if (!content.includes("[mcp_servers.satori]")) {
        return false;
    }
    return !(content.includes(MANAGED_BLOCK_START) && content.includes(MANAGED_BLOCK_END));
}

function prepareCodexInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand, installGuidanceHook: boolean): FileMutation {
    const current = readTextIfExists(filePath) ?? "";
    if (codexHasUnmanagedSatoriSection(current)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove [mcp_servers.satori] manually or convert it to the managed block first.`,
            2
        );
    }

    const managedBlock = buildCodexManagedBlock(runtimeCommand);
    let next = current;
    if (current.includes(MANAGED_BLOCK_START) && current.includes(MANAGED_BLOCK_END)) {
        next = current.replace(
            new RegExp(`${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}\\n?`, "m"),
            managedBlock
        );
    } else if (current.trim().length === 0) {
        next = managedBlock;
    } else {
        next = `${normalizeTrailingNewline(current)}\n${managedBlock}`;
    }

    next = ensureCodexEnvTemplate(next);
    if (installGuidanceHook) {
        next = ensureCodexGuidanceHook(next);
    }

    return {
        changed: next !== current,
        apply: () => {
            if (next === current) {
                return;
            }
            ensureParentDir(filePath);
            fs.writeFileSync(filePath, next, "utf8");
        },
    };
}

function prepareCodexUninstall(filePath: string): FileMutation {
    const current = readTextIfExists(filePath);
    if (!current) {
        return { changed: false, apply: () => {} };
    }
    if (codexHasUnmanagedSatoriSection(current)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to remove unmanaged Satori config in ${filePath}. Remove [mcp_servers.satori] manually instead.`,
            2
        );
    }
    if (!current.includes(MANAGED_BLOCK_START) || !current.includes(MANAGED_BLOCK_END)) {
        const next = removeCodexGuidanceHookBlock(current);
        return {
            changed: next !== current,
            apply: () => {
                if (next === current) {
                    return;
                }
                fs.writeFileSync(filePath, next, "utf8");
            },
        };
    }

    const withoutManagedBlock = current
        .replace(new RegExp(`\\n?${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}\\n?`, "m"), "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "");
    const next = removeCodexGuidanceHookBlock(withoutManagedBlock);

    if (next === current) {
        return { changed: false, apply: () => {} };
    }

    return {
        changed: next !== current,
        apply: () => {
            if (next === current) {
                return;
            }
            fs.writeFileSync(filePath, next, "utf8");
        },
    };
}

function parseJsonObject(filePath: string): Record<string, unknown> {
    const current = readTextIfExists(filePath);
    if (!current) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(current);
    } catch (error) {
        throw new CliError("E_USAGE", `Failed to parse JSON config at ${filePath}: ${(error as Error).message}`, 2);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliError("E_USAGE", `Expected top-level JSON object in ${filePath}.`, 2);
    }
    return parsed as Record<string, unknown>;
}

function buildClaudeServerConfig(runtimeCommand: ManagedRuntimeCommand, existing?: Record<string, unknown>): Record<string, unknown> {
    // Always return an env object so reinstall replaces legacy empty-defaulting maps.
    // Empty object means "omit env" (host process env supplies credentials).
    return {
        type: "stdio",
        command: runtimeCommand.command,
        args: runtimeCommand.args,
        env: buildPreservedManagedEnv(existing?.env),
    };
}

function isManagedLauncherPath(value: unknown): value is string {
    return typeof value === "string" && value.replace(/\\/g, "/").endsWith(`/.satori/${MANAGED_BIN_DIR}/${MANAGED_LAUNCHER_FILE}`);
}

function isManagedCommandParts(command: unknown, args: unknown): boolean {
    if (!Array.isArray(args)) {
        return false;
    }

    const entryPath = args[0];
    return typeof command === "string"
        && command.length > 0
        && args.length === 1
        && isManagedLauncherPath(entryPath);
}

function isManagedClaudeEntry(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return isManagedCommandParts(entry.command, entry.args);
}

function prepareClaudeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const currentObject = parseJsonObject(filePath);
    const currentSerialized = JSON.stringify(currentObject);
    const existingSatori = objectValue((currentObject.mcpServers as Record<string, unknown> | undefined)?.satori);
    const desiredServer = buildClaudeServerConfig(runtimeCommand, existingSatori);

    const mcpServersValue = currentObject.mcpServers;
    let mcpServers: Record<string, unknown>;
    if (mcpServersValue === undefined) {
        mcpServers = {};
    } else if (mcpServersValue && typeof mcpServersValue === "object" && !Array.isArray(mcpServersValue)) {
        mcpServers = { ...(mcpServersValue as Record<string, unknown>) };
    } else {
        throw new CliError("E_USAGE", `Expected mcpServers to be an object in ${filePath}.`, 2);
    }

    if (mcpServers.satori !== undefined && !isManagedClaudeEntry(mcpServers.satori)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove mcpServers.satori manually or align it to the managed Satori form first.`,
            2
        );
    }

    mcpServers.satori = {
        ...existingSatori,
        ...desiredServer,
    };
    delete (mcpServers.satori as Record<string, unknown>).timeout;
    // Drop empty env map so clients inherit host process env instead of overriding with {}.
    const desiredEnv = (mcpServers.satori as Record<string, unknown>).env;
    if (desiredEnv && typeof desiredEnv === "object" && !Array.isArray(desiredEnv) && Object.keys(desiredEnv).length === 0) {
        delete (mcpServers.satori as Record<string, unknown>).env;
    }
    currentObject.mcpServers = mcpServers;

    const next = `${JSON.stringify(currentObject, null, 2)}\n`;
    return {
        changed: JSON.stringify(currentObject) !== currentSerialized,
        apply: () => {
            if (JSON.stringify(currentObject) === currentSerialized) {
                return;
            }
            ensureParentDir(filePath);
            fs.writeFileSync(filePath, next, "utf8");
        },
    };
}

function prepareClaudeUninstall(filePath: string): FileMutation {
    const currentObject = parseJsonObject(filePath);
    const mcpServersValue = currentObject.mcpServers;
    if (!mcpServersValue || typeof mcpServersValue !== "object" || Array.isArray(mcpServersValue)) {
        return { changed: false, apply: () => {} };
    }

    const mcpServers = { ...(mcpServersValue as Record<string, unknown>) };
    if (!Object.prototype.hasOwnProperty.call(mcpServers, "satori")) {
        return { changed: false, apply: () => {} };
    }
    if (!isManagedClaudeEntry(mcpServers.satori)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to remove unmanaged Satori config in ${filePath}. Remove mcpServers.satori manually instead.`,
            2
        );
    }

    delete mcpServers.satori;
    if (Object.keys(mcpServers).length === 0) {
        delete currentObject.mcpServers;
    } else {
        currentObject.mcpServers = mcpServers;
    }

    const next = `${JSON.stringify(currentObject, null, 2)}\n`;
    return {
        changed: true,
        apply: () => {
            fs.writeFileSync(filePath, next, "utf8");
        },
    };
}

function parseJsoncObject(filePath: string, content: string): Record<string, unknown> {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
        throw new CliError("E_USAGE", `Failed to parse JSONC config at ${filePath}.`, 2);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliError("E_USAGE", `Expected top-level JSON object in ${filePath}.`, 2);
    }
    return parsed as Record<string, unknown>;
}

function buildOpenCodeServerConfig(runtimeCommand: ManagedRuntimeCommand, existing?: Record<string, unknown>): Record<string, unknown> {
    return {
        enabled: true,
        type: "local",
        command: [runtimeCommand.command, ...runtimeCommand.args],
        environment: mergeRuntimeEnv(existing?.environment, runtimeEnvMap((name) => `{env:${name}}`)),
    };
}

function isManagedOpenCodeEntry(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    if (Array.isArray(entry.command)) {
        const [command, ...args] = entry.command;
        return isManagedCommandParts(command, args);
    }
    return isManagedCommandParts(entry.command, entry.args);
}

function mutateJsonc(filePath: string, current: string, pathSegments: Array<string | number>, value: unknown): FileMutation {
    const edits = modify(current, pathSegments, value, {
        formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: "\n",
        },
    });
    const next = applyEdits(current, edits);
    return {
        changed: next !== current,
        apply: () => {
            if (next === current) {
                return;
            }
            ensureParentDir(filePath);
            fs.writeFileSync(filePath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
        },
    };
}

function prepareOpenCodeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const current = readTextIfExists(filePath) ?? "{}\n";
    const currentObject = parseJsoncObject(filePath, current);
    const mcpValue = currentObject.mcp;
    if (mcpValue !== undefined && (!mcpValue || typeof mcpValue !== "object" || Array.isArray(mcpValue))) {
        throw new CliError("E_USAGE", `Expected mcp to be an object in ${filePath}.`, 2);
    }
    const existingSatori = (mcpValue as Record<string, unknown> | undefined)?.satori;
    if (existingSatori !== undefined && !isManagedOpenCodeEntry(existingSatori)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove mcp.satori manually or align it to the managed Satori form first.`,
            2
        );
    }
    return mutateJsonc(filePath, current, ["mcp", "satori"], buildOpenCodeServerConfig(runtimeCommand, objectValue(existingSatori)));
}

function prepareOpenCodeUninstall(filePath: string): FileMutation {
    const current = readTextIfExists(filePath);
    if (!current) {
        return { changed: false, apply: () => {} };
    }
    const currentObject = parseJsoncObject(filePath, current);
    const mcpValue = currentObject.mcp;
    if (!mcpValue || typeof mcpValue !== "object" || Array.isArray(mcpValue)) {
        return { changed: false, apply: () => {} };
    }
    const existingSatori = (mcpValue as Record<string, unknown>).satori;
    if (existingSatori === undefined) {
        return { changed: false, apply: () => {} };
    }
    if (!isManagedOpenCodeEntry(existingSatori)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to remove unmanaged Satori config in ${filePath}. Remove mcp.satori manually instead.`,
            2
        );
    }
    return mutateJsonc(filePath, current, ["mcp", "satori"], undefined);
}

function prepareSkillInstall(skillsPath: string, skillAssetRoot: string): FileMutation {
    const writes: Array<{ destinationDir: string; destinationFile: string; content: string }> = [];
    let changed = false;

    for (const skillDirName of OWNED_SKILL_DIRS) {
        const sourceFile = path.join(skillAssetRoot, skillDirName, "SKILL.md");
        if (!fs.existsSync(sourceFile)) {
            throw new CliError("E_USAGE", `Missing packaged skill asset: ${sourceFile}`, 2);
        }
        const content = fs.readFileSync(sourceFile, "utf8");
        const destinationDir = path.join(skillsPath, skillDirName);
        const destinationFile = path.join(destinationDir, "SKILL.md");
        if (readTextIfExists(destinationFile) !== content) {
            changed = true;
            writes.push({ destinationDir, destinationFile, content });
        }
    }

    return {
        changed,
        apply: () => {
            for (const write of writes) {
                ensureDir(write.destinationDir);
                fs.writeFileSync(write.destinationFile, write.content, "utf8");
            }
        },
    };
}

function prepareSkillRemoval(skillsPath: string): FileMutation {
    const removals = OWNED_SKILL_DIRS
        .map((skillDirName) => path.join(skillsPath, skillDirName))
        .filter((destinationDir) => fs.existsSync(destinationDir));

    return {
        changed: removals.length > 0,
        apply: () => {
            for (const destinationDir of removals) {
                fs.rmSync(destinationDir, { recursive: true, force: true });
            }
        },
    };
}

function buildManagedInstructionsBlock(instructions: string): string {
    return [
        INSTRUCTIONS_BLOCK_START,
        instructions.trim(),
        INSTRUCTIONS_BLOCK_END,
        "",
    ].join("\n");
}

function prepareInstructionsInstall(filePath: string, instructions: string): FileMutation {
    const currentFile = readTextIfExists(filePath);
    const current = currentFile ?? "";
    const block = buildManagedInstructionsBlock(instructions);
    let next = current;
    if (current.includes(INSTRUCTIONS_BLOCK_START) && current.includes(INSTRUCTIONS_BLOCK_END)) {
        next = current.replace(
            new RegExp(`${escapeRegExp(INSTRUCTIONS_BLOCK_START)}[\\s\\S]*?${escapeRegExp(INSTRUCTIONS_BLOCK_END)}\\n?`, "m"),
            block
        );
    } else if (current.trim().length === 0) {
        next = block;
    } else {
        next = `${normalizeTrailingNewline(current)}\n${block}`;
    }

    return {
        changed: next !== current,
        assertUnchanged: () => assertFileContentUnchanged(filePath, currentFile),
        apply: () => {
            if (next === current) {
                return;
            }
            ensureParentDir(filePath);
            fs.writeFileSync(filePath, next, "utf8");
        },
    };
}

function prepareInstructionsRemoval(filePath: string): FileMutation {
    const current = readTextIfExists(filePath);
    if (!current || !current.includes(INSTRUCTIONS_BLOCK_START) || !current.includes(INSTRUCTIONS_BLOCK_END)) {
        return { changed: false, apply: () => {} };
    }

    const next = current
        .replace(new RegExp(`\\n?${escapeRegExp(INSTRUCTIONS_BLOCK_START)}[\\s\\S]*?${escapeRegExp(INSTRUCTIONS_BLOCK_END)}\\n?`, "m"), "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "");

    return {
        changed: next !== current,
        assertUnchanged: () => assertFileContentUnchanged(filePath, current),
        apply: () => {
            if (next === current) {
                return;
            }
            fs.writeFileSync(filePath, next, "utf8");
        },
    };
}

function prepareCompanionMutation(
    companion: CompanionTarget,
    command: InstallCommandInput,
    skillAssetRoot: string
): CompanionMutation {
    const mutation = companion.kind === "skills"
        ? (command.kind === "install"
            ? prepareSkillInstall(companion.path, skillAssetRoot)
            : prepareSkillRemoval(companion.path))
        : command.kind === "install"
        ? prepareInstructionsInstall(companion.path, companion.instructions)
        : prepareInstructionsRemoval(companion.path);
    return {
        companion,
        changed: mutation.changed,
        assertUnchanged: mutation.assertUnchanged,
        apply: mutation.apply,
    };
}

function prepareConfigMutation(
    target: ClientTarget,
    command: InstallCommandInput,
    runtimeCommand: ManagedRuntimeCommand
): FileMutation {
    const expected = readTextIfExists(target.configPath);
    let mutation: FileMutation;
    if (target.client === "codex") {
        mutation = command.kind === "install"
            ? prepareCodexInstall(target.configPath, runtimeCommand, command.installGuidanceHook === true)
            : prepareCodexUninstall(target.configPath);
    } else if (target.client === "claude") {
        mutation = command.kind === "install"
            ? prepareClaudeInstall(target.configPath, runtimeCommand)
            : prepareClaudeUninstall(target.configPath);
    } else {
        mutation = command.kind === "install"
            ? prepareOpenCodeInstall(target.configPath, runtimeCommand)
            : prepareOpenCodeUninstall(target.configPath);
    }
    return guardFileMutation(target.configPath, expected, mutation);
}

function prepareMutation(
    target: ClientTarget,
    command: InstallCommandInput,
    runtimeCommand: ManagedRuntimeCommand,
    skillAssetRoot: string
): PreparedMutation {
    const configMutation = prepareConfigMutation(target, command, runtimeCommand);
    const companionMutations = target.companions.map((companion) => (
        prepareCompanionMutation(companion, command, skillAssetRoot)
    ));

    return {
        target,
        configMutation,
        configChanged: configMutation.changed,
        companionMutations,
    };
}

function commandMatchesExpected(command: unknown, args: unknown, expected: ManagedRuntimeCommand): boolean {
    return command === expected.command
        && Array.isArray(args)
        && args.length === expected.args.length
        && args.every((entry, index) => entry === expected.args[index]);
}

function verifyManagedClientTarget(target: Pick<ClientTarget, "client" | "configPath">, expected: ManagedRuntimeCommand): ManagedClientConfigProof {
    let matches = false;
    try {
        if (target.client === "codex") {
            const content = readTextIfExists(target.configPath) ?? "";
            matches = content.includes(buildCodexManagedBlock(expected));
        } else if (target.client === "claude") {
            const config = parseJsonObject(target.configPath);
            const entry = objectValue(objectValue(config.mcpServers)?.satori);
            matches = commandMatchesExpected(entry?.command, entry?.args, expected);
        } else {
            const content = readTextIfExists(target.configPath) ?? "";
            const config = parseJsoncObject(target.configPath, content);
            const entry = objectValue(objectValue(config.mcp)?.satori);
            matches = Array.isArray(entry?.command)
                && commandMatchesExpected(entry.command[0], entry.command.slice(1), expected);
        }
    } catch {
        matches = false;
    }

    return {
        client: target.client,
        configPath: target.configPath,
        status: matches ? "ok" : "error",
        message: matches
            ? `${target.client} config points to ${expected.args[0]}.`
            : `${target.client} config does not point exactly to ${expected.command} ${expected.args[0]}.`,
    };
}

function hasSatoriClientEntry(target: ClientTarget): boolean {
    const content = readTextIfExists(target.configPath);
    if (content === null) {
        return false;
    }
    try {
        if (target.client === "codex") {
            return content.includes(MANAGED_BLOCK_START) || /\[mcp_servers\.satori(?:\.|\])/.test(content);
        }
        if (target.client === "claude") {
            return objectValue(objectValue(parseJsonObject(target.configPath).mcpServers)?.satori) !== undefined;
        }
        return objectValue(objectValue(parseJsoncObject(target.configPath, content).mcp)?.satori) !== undefined;
    } catch {
        return content.includes("satori");
    }
}

function parseVectorStoreLiteral(value: unknown, source: string): InstallVectorStore | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new CliError("E_USAGE", `${source} VECTOR_STORE_PROVIDER must be Milvus or LanceDB.`, 2);
    }
    if (/^\$\{|^\{env:/.test(value.trim())) {
        return undefined;
    }
    if (value === "Milvus" || value === "LanceDB") {
        return value;
    }
    throw new CliError("E_USAGE", `${source} VECTOR_STORE_PROVIDER must be Milvus or LanceDB.`, 2);
}

function readCodexVectorStore(filePath: string): InstallVectorStore | undefined {
    const content = readTextIfExists(filePath);
    if (content === null) {
        return undefined;
    }
    let inSatoriEnvironment = false;
    let selected: InstallVectorStore | undefined;
    for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
        const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
        if (table) {
            inSatoriEnvironment = table[1] === "mcp_servers.satori.env";
            continue;
        }
        if (!inSatoriEnvironment || !/^\s*VECTOR_STORE_PROVIDER\s*=/.test(line)) {
            continue;
        }
        const literal = line.match(/^\s*VECTOR_STORE_PROVIDER\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
        const candidate = parseVectorStoreLiteral(literal?.[1] ?? literal?.[2], `Codex config '${filePath}'`);
        if (!candidate) {
            throw new CliError("E_USAGE", `Codex config '${filePath}' has an unreadable VECTOR_STORE_PROVIDER value.`, 2);
        }
        if (selected && selected !== candidate) {
            throw new CliError("E_USAGE", `Codex config '${filePath}' contains conflicting VECTOR_STORE_PROVIDER values.`, 2);
        }
        selected = candidate;
    }
    return selected;
}

function readClientVectorStore(target: ClientTarget): InstallVectorStore | undefined {
    if (target.client === "codex") {
        return readCodexVectorStore(target.configPath);
    }
    if (target.client === "claude") {
        const entry = objectValue(objectValue(parseJsonObject(target.configPath).mcpServers)?.satori);
        return parseVectorStoreLiteral(objectValue(entry?.env)?.VECTOR_STORE_PROVIDER, `Claude config '${target.configPath}'`);
    }
    const content = readTextIfExists(target.configPath);
    if (content === null) {
        return undefined;
    }
    const entry = objectValue(objectValue(parseJsoncObject(target.configPath, content).mcp)?.satori);
    return parseVectorStoreLiteral(
        objectValue(entry?.environment)?.VECTOR_STORE_PROVIDER,
        `OpenCode config '${target.configPath}'`,
    );
}

function readManagedLauncherVectorStore(
    homeDir: string,
    managedEnvironment?: Readonly<Record<string, string>>,
): InstallVectorStore | undefined {
    try {
        return parseVectorStoreLiteral(
            (managedEnvironment ?? readManagedRuntimeEnvironment(homeDir)).VECTOR_STORE_PROVIDER,
            `Managed launcher '${resolveLauncherPath(homeDir)}'`,
        );
    } catch (error) {
        if (error instanceof CliError) {
            throw error;
        }
        return undefined;
    }
}

function readManagedRuntimeEnvironment(homeDir: string): Readonly<Record<string, string>> {
    const launcherPath = resolveLauncherPath(homeDir);
    const launcher = readTextIfExists(launcherPath);
    if (launcher === null) {
        return Object.freeze({});
    }
    try {
        return parseManagedLauncherEnvironment(launcher);
    } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new CliError(
            "E_MANAGED_RUNTIME_ENV_INVALID",
            `Managed launcher '${launcherPath}' contains invalid runtime identity: ${cause}`,
            1,
        );
    }
}

function runtimeEnvironmentWithManagedFallbacks(
    managed: Readonly<Record<string, string>>,
    env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    const fallbacks: NodeJS.ProcessEnv = {};
    // These non-secret location values are installer-owned runtime identity.
    // Provider credentials and tokens must never be recovered from a launcher.
    for (const key of ["LANCEDB_PATH", "OLLAMA_HOST"] as const) {
        if (typeof managed[key] === "string" && managed[key].length > 0) {
            fallbacks[key] = managed[key];
        }
    }
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            if ((key === "LANCEDB_PATH" || key === "OLLAMA_HOST") && value.trim().length === 0) {
                continue;
            }
            fallbacks[key] = value;
        }
    }
    return fallbacks;
}

function readConfiguredClientVectorStore(homeDir: string): InstallVectorStore | undefined {
    const selections = resolveClientTargets(homeDir)
        .filter(hasSatoriClientEntry)
        .map(readClientVectorStore)
        .filter((value): value is InstallVectorStore => value !== undefined);
    const distinct = [...new Set(selections)];
    if (distinct.length > 1) {
        throw new CliError(
            "E_USAGE",
            "Configured Satori clients disagree about VECTOR_STORE_PROVIDER. Re-run install with an explicit --vector-store after reconciling literal client settings.",
            2,
        );
    }
    return distinct[0];
}

function resolveConnectedVectorStoreForInstall(
    command: Extract<InstallCommandInput, { kind: "install" }>,
    homeDir: string,
    env: NodeJS.ProcessEnv,
    managedEnvironment?: Readonly<Record<string, string>>,
): InstallVectorStore {
    if (command.vectorStore) {
        return command.vectorStore;
    }
    const environmentSelection = env.VECTOR_STORE_PROVIDER === undefined
        ? undefined
        : selectedConnectedVectorStore({ runtime: "voyage", homeDir, env });
    const managedSelection = readManagedLauncherVectorStore(homeDir, managedEnvironment);
    const clientSelection = readConfiguredClientVectorStore(homeDir);
    const discovered = [environmentSelection, managedSelection, clientSelection]
        .filter((value): value is InstallVectorStore => value !== undefined);
    if (new Set(discovered).size > 1) {
        throw new CliError(
            "E_USAGE",
            "The installer environment, managed launcher, and configured Satori clients disagree about VECTOR_STORE_PROVIDER. Re-run install with an explicit --vector-store after reconciling literal client settings.",
            2,
        );
    }
    return environmentSelection
        ?? managedSelection
        ?? clientSelection
        ?? selectedConnectedVectorStore({ runtime: "voyage", homeDir, env });
}

function resolveConnectedVectorStoreForInstallOrThrow(
    command: Extract<InstallCommandInput, { kind: "install" }>,
    homeDir: string,
    env: NodeJS.ProcessEnv,
    managedEnvironment?: Readonly<Record<string, string>>,
): InstallVectorStore {
    try {
        return resolveConnectedVectorStoreForInstall(command, homeDir, env, managedEnvironment);
    } catch (error) {
        if (error instanceof CliError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError("E_USAGE", message, 2);
    }
}

export function inspectManagedClientConfigurations(homeDir: string): ManagedClientConfigProof[] {
    const expected = resolveManagedClientCommand(homeDir);
    return resolveClientTargets(homeDir)
        .filter(hasSatoriClientEntry)
        .map((target) => verifyManagedClientTarget(target, expected));
}

export function verifyManagedClientConfigurations(
    installResult: InstallCommandResult,
    homeDir: string,
): ManagedClientConfigProof[] {
    const expected = resolveManagedClientCommand(homeDir);
    return installResult.results.map((result) => verifyManagedClientTarget(result, expected));
}

export function createInstallPlan(
    command: InstallCommandInput,
    options: InstallCommandOptions = {}
): InstallPlan {
    const homeDir = options.homeDir ?? os.homedir();
    const repoDir = options.repoDir ?? process.cwd();
    const packageSpecifier = options.packageSpecifier ?? resolveDefaultPackageSpecifier();
    const skillAssetRoot = options.skillAssetRoot ?? resolveDefaultSkillAssetRoot();
    const plannedRuntimeCommand = options.runtimeCommand ?? plannedManagedRuntimeCommand(homeDir, packageSpecifier);
    const clientCommand = resolveManagedClientCommand(homeDir);
    const profileMutation: FileMutation & { filePath?: string } = command.kind === "install"
        ? prepareProjectProfileInstall(repoDir, command.profile)
        : { changed: false, apply: () => {} };

    const prepared = selectTargets(homeDir, command.client).map((target) => (
        prepareMutation(target, command, clientCommand, skillAssetRoot)
    ));

    return Object.freeze({
        command: Object.freeze({ ...command }),
        homeDir,
        packageSpecifier,
        plannedRuntimeCommand: Object.freeze({
            command: plannedRuntimeCommand.command,
            args: Object.freeze([...plannedRuntimeCommand.args]) as unknown as string[],
        }),
        clientCommand: Object.freeze({
            command: clientCommand.command,
            args: Object.freeze([...clientCommand.args]) as unknown as string[],
        }),
        profileMutation,
        prepared,
        options,
    });
}

export function applyInstallPlan(
    plan: InstallPlan,
    preflight?: InstallPreflightResult,
): InstallCommandResult {
    const { command, homeDir, packageSpecifier, profileMutation, prepared, options } = plan;
    if (command.kind === "install" && !command.dryRun && !preflight) {
        throw new CliError(
            "E_INSTALL_PREFLIGHT_REQUIRED",
            "Refusing to apply an installation plan without a completed runtime preflight.",
            1,
        );
    }
    const runtimeEnvironment = preflight?.runtimeEnvironment ?? Object.freeze({});
    let launcherMutation = command.kind === "install"
        ? prepareLauncherInstall(homeDir, plan.plannedRuntimeCommand, runtimeEnvironment)
        : { changed: false, apply: () => {} };

    if (!command.dryRun) {
        const plannedSteps: Array<{ description: string; changed: boolean; apply: () => void }> = [];
        if (command.kind === "install" && !options.runtimeCommand) {
            plannedSteps.push({
                description: `managed runtime package at ${resolveRuntimeRoot(homeDir, packageSpecifier)}`,
                changed: true,
                apply: () => {
                    const installedRuntime = installManagedRuntimeCandidate(
                        homeDir,
                        packageSpecifier,
                        options.execFileSyncImpl ?? execFileSync,
                    );
                    profileMutation.assertUnchanged?.();
                    for (const mutation of prepared) {
                        mutation.configMutation.assertUnchanged?.();
                        for (const companion of mutation.companionMutations) {
                            companion.assertUnchanged?.();
                        }
                    }
                    launcherMutation.assertUnchanged?.();
                    launcherMutation = prepareLauncherInstall(homeDir, installedRuntime.command, runtimeEnvironment);
                },
            });
        }
        if (command.kind === "install") {
            plannedSteps.push({
                description: `managed launcher at ${resolveLauncherPath(homeDir)}`,
                changed: launcherMutation.changed || !options.runtimeCommand,
                apply: () => {
                    launcherMutation.assertUnchanged?.();
                    launcherMutation.apply();
                },
            });
            plannedSteps.push({
                description: `repository profile at ${profileMutation.filePath ?? "satori.toml"}`,
                changed: profileMutation.changed,
                apply: () => {
                    profileMutation.assertUnchanged?.();
                    profileMutation.apply();
                },
            });
        }
        for (const mutation of prepared) {
            plannedSteps.push({
                description: `${mutation.target.client} client configuration at ${mutation.target.configPath}`,
                changed: mutation.configMutation.changed,
                apply: () => {
                    mutation.configMutation.assertUnchanged?.();
                    mutation.configMutation.apply();
                },
            });
            for (const companion of mutation.companionMutations) {
                plannedSteps.push({
                    description: `${mutation.target.client} ${companion.companion.kind} at ${companion.companion.path}`,
                    changed: companion.changed,
                    apply: () => {
                        companion.assertUnchanged?.();
                        companion.apply();
                    },
                });
            }
        }

        const mutationSteps = plannedSteps.filter((step) => step.changed);
        const applied: string[] = [];
        for (let index = 0; index < mutationSteps.length; index += 1) {
            const step = mutationSteps[index];
            try {
                step.apply();
                applied.push(step.description);
            } catch (error) {
                const cause = error instanceof Error ? error.message : String(error);
                const notYetApplied = mutationSteps.slice(index + 1).map((entry) => entry.description);
                throw new CliError(
                    command.kind === "install" ? "E_INSTALL_PARTIAL" : "E_UNINSTALL_PARTIAL",
                    `${command.kind === "install" ? "Installation" : "Uninstallation"} failed while applying ${step.description}: ${cause} `
                    + `Successfully changed: ${applied.length > 0 ? applied.join(", ") : "none"}. `
                    + `Not yet applied: ${notYetApplied.length > 0 ? notYetApplied.join(", ") : "none"}. `
                    + "The failing step may be partially applied; correct the error and rerun the same command.",
                    1,
                );
            }
        }
    }

    return {
        action: command.kind,
        client: command.client,
        dryRun: command.dryRun,
        packageSpecifier: command.kind === "install" ? packageSpecifier : undefined,
        profile: command.kind === "install" ? command.profile : undefined,
        profileConfigPath: command.kind === "install" ? profileMutation.filePath : undefined,
        profileConfigChanged: command.kind === "install" ? profileMutation.changed : undefined,
        runtime: command.kind === "install" ? command.runtime : undefined,
        runtimeEnvironment: command.kind === "install" && command.runtime
            ? runtimeEnvironment
            : undefined,
        results: prepared.map((mutation) => ({
            client: mutation.target.client,
            configPath: mutation.target.configPath,
            skillsPath: mutation.target.companions.find((companion) => companion.kind === "skills")?.path,
            instructionsPath: mutation.target.companions.find((companion) => companion.kind === "instructions")?.path,
            configChanged: mutation.configChanged,
            skillsChanged: mutation.companionMutations.some((entry) => entry.companion.kind === "skills" && entry.changed),
            instructionsChanged: mutation.companionMutations.some((entry) => entry.companion.kind === "instructions" && entry.changed),
            status: mutation.configChanged || mutation.companionMutations.some((entry) => entry.changed) || launcherMutation.changed || profileMutation.changed ? "updated" : "unchanged",
            dryRun: command.dryRun,
        })),
    };
}

export async function executeInstallCommand(
    command: InstallCommandInput,
    options: InstallCommandOptions = {}
): Promise<InstallCommandResult> {
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    let preflight: InstallPreflightResult | undefined;
    let installedRuntimeCommand = options.runtimeCommand;
    let managedRuntimeCandidate: ManagedRuntimeCandidate | undefined;
    let plan: InstallPlan;
    try {
        if (command.kind === "install") {
            if (command.runtime === "offline" && command.vectorStore !== undefined && command.vectorStore !== "LanceDB") {
                throw new CliError("E_USAGE", "Offline install requires --vector-store lancedb.", 2);
            }
            const managedRuntimeEnvironment = readManagedRuntimeEnvironment(homeDir);
            const vectorStore = command.runtime === "voyage"
                ? resolveConnectedVectorStoreForInstallOrThrow(command, homeDir, env, managedRuntimeEnvironment)
                : "LanceDB";
            const effectiveEnv = runtimeEnvironmentWithManagedFallbacks(managedRuntimeEnvironment, env);
            const preflightInput = {
                runtime: command.runtime,
                homeDir,
                env: effectiveEnv,
                vectorStore,
                ollamaModel: command.ollamaModel,
            };
            if (command.dryRun) {
                preflight = { runtimeEnvironment: planInstallRuntimeEnvironment(preflightInput) };
            } else {
                if (!installedRuntimeCommand) {
                    managedRuntimeCandidate = installManagedRuntimeCandidate(
                        homeDir,
                        options.packageSpecifier ?? resolveDefaultPackageSpecifier(),
                        options.execFileSyncImpl ?? execFileSync,
                    );
                    installedRuntimeCommand = managedRuntimeCandidate.command;
                }
                const preflightDependencies: InstallPreflightDependencies = {
                    ...options.preflightDependencies,
                    probeLanceDb: options.preflightDependencies?.probeLanceDb
                        ?? exactRuntimeLanceDbProbe(installedRuntimeCommand),
                };
                try {
                    preflight = await (options.preflightRunner ?? runInstallPreflight)(
                        preflightInput,
                        preflightDependencies,
                    );
                    if (managedRuntimeCandidate) {
                        try {
                            await (preflightDependencies.probeCandidateRuntime ?? probeManagedRuntimeCandidate)({
                                runtimeCommand: managedRuntimeCandidate.command,
                                runtimeEnvironment: preflight.runtimeEnvironment,
                                inheritedEnvironment: effectiveEnv,
                                homeDir,
                                expectedVersion: managedRuntimeCandidate.identity.version,
                            });
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            throw new CliError(
                                "E_INSTALL_PREFLIGHT",
                                `Candidate runtime preflight failed: ${message}`,
                                1,
                            );
                        }
                    }
                } catch (error) {
                    if (error instanceof CliError) throw error;
                    const message = error instanceof Error ? error.message : String(error);
                    throw new CliError("E_INSTALL_PREFLIGHT", `Runtime preflight failed: ${message}`, 1);
                }
            }
            if (
                command.runtime === "voyage"
                && resolveConnectedVectorStoreForInstallOrThrow(command, homeDir, env) !== vectorStore
            ) {
                throw new CliError(
                    "E_INSTALL_PLAN_STALE",
                    "Connected vector-store selection changed while runtime preflight was running. Rerun install against the current configuration.",
                    1,
                );
            }
            const currentManagedRuntimeEnvironment = readManagedRuntimeEnvironment(homeDir);
            for (const key of ["LANCEDB_PATH", "OLLAMA_HOST"] as const) {
                if (currentManagedRuntimeEnvironment[key] !== managedRuntimeEnvironment[key]) {
                    throw new CliError(
                        "E_INSTALL_PLAN_STALE",
                        `Managed ${key} changed while runtime preflight was running. Rerun install against the current launcher.`,
                        1,
                    );
                }
            }
        }
        // Read mutable client/profile files only after awaited preflight completes.
        plan = createInstallPlan(command, {
            ...options,
            homeDir,
            ...(installedRuntimeCommand ? { runtimeCommand: installedRuntimeCommand } : {}),
        });
    } catch (error) {
        if (managedRuntimeCandidate?.newlyInstalled) {
            fs.rmSync(managedRuntimeCandidate.runtimeRoot, { recursive: true, force: true });
        }
        throw error;
    }
    return applyInstallPlan(plan, preflight);
}
