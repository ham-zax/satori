import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { CliError } from "./errors.js";
import type { InstallClient, InstallProfile } from "./args.js";

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
    "# EMBEDDING_PROVIDER = \"VoyageAI\"",
    "# EMBEDDING_MODEL = \"voyage-4-large\"",
    "# EMBEDDING_OUTPUT_DIMENSION = \"1024\"",
    "# VOYAGEAI_API_KEY = \"pa-...\"",
    "# VOYAGEAI_RERANKER_MODEL = \"rerank-2.5\"",
    "# MILVUS_ADDRESS = \"https://your-zilliz-endpoint\"",
    "# MILVUS_TOKEN = \"your-zilliz-token\"",
    CODEX_ENV_TEMPLATE_END,
] as const;
const CODEX_GUIDANCE_HOOK_MESSAGE = "Satori MCP: use search_codebase for semantic ownership/context discovery, then file_outline/call_graph/read_file for proof. Use exact ids/constants with operators when known; verify inbound impact with rg/tests. Reindex only on requires_reindex/hints.reindex; trust navigationFallback.";
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
4. \`read_file\` - open exact symbols or bounded line windows for final evidence
5. \`manage_index\` - check status, create, sync, reindex, or clear only when explicitly needed

## When To Use Satori
- Use Satori primarily for semantic code exploration: finding behavioral owners, context-building, and understanding how a feature is implemented.
- Prefer plain-English queries first when the task is about intent, policy, ownership, runtime behavior, or unfamiliar code.
- Switch to exact identifiers, constants, warning codes, and path-scoped operators when narrowing or proving a candidate result.

## Verification Rules
- Treat \`navigationFallback\` as authoritative. Do not reconstruct spans from prose.
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
4. \`read_file\` - open exact spans or fallback windows
5. \`manage_index\` - create, sync, reindex, or inspect index status

## Rules
- Prefer Satori for semantic code discovery before grep/glob.
- Start with plain-English behavior questions; switch to exact ids, constants, and operators for proof.
- If a tool returns \`requires_reindex\`, run \`manage_index(action="reindex")\` and retry the original call.
- Treat \`navigationFallback\` as authoritative when call graph is unavailable.
- Read the relevant implementation and call sites before editing behavior.
`;

type ExecFileSyncLike = typeof execFileSync;

type ClientName = Exclude<InstallClient, "all">;

export interface ManagedRuntimeCommand {
    command: string;
    args: string[];
}

export interface InstallCommandInput {
    kind: "install" | "uninstall";
    client: InstallClient;
    dryRun: boolean;
    installGuidanceHook?: boolean;
    profile?: InstallProfile;
}

export interface InstallCommandOptions {
    homeDir?: string;
    repoDir?: string;
    packageSpecifier?: string;
    skillAssetRoot?: string;
    runtimeCommand?: ManagedRuntimeCommand;
    execFileSyncImpl?: ExecFileSyncLike;
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
    profile?: InstallProfile;
    profileConfigPath?: string;
    profileConfigChanged?: boolean;
    results: ClientInstallResult[];
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
    apply: () => void;
}

interface PreparedMutation {
    target: ClientTarget;
    configChanged: boolean;
    companionMutations: CompanionMutation[];
    apply: () => void;
}

interface FileMutation {
    changed: boolean;
    apply: () => void;
}

function resolveDefaultSkillAssetRoot(): string {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), "..", "..", "assets", "skills");
}

function resolveDefaultPackageSpecifier(): string {
    try {
        const currentFile = fileURLToPath(import.meta.url);
        const packagePath = path.resolve(path.dirname(currentFile), "..", "..", "package.json");
        const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: unknown; version?: unknown };
        if (typeof parsed.name === "string" && typeof parsed.version === "string") {
            return `${parsed.name}@${parsed.version}`;
        }
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
    const current = readTextIfExists(filePath) ?? "";
    const next = updateSatoriProjectConfig(current, profile);
    return {
        filePath,
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

function resolveLauncherPath(homeDir: string): string {
    return path.join(homeDir, ".satori", MANAGED_BIN_DIR, MANAGED_LAUNCHER_FILE);
}

function plannedManagedRuntimeCommand(homeDir: string, packageSpecifier: string): ManagedRuntimeCommand {
    return {
        command: process.execPath,
        args: [resolveRuntimeEntryPath(resolveRuntimePackageRoot(homeDir, packageSpecifier))],
    };
}

function managedClientCommand(homeDir: string): ManagedRuntimeCommand {
    return {
        command: process.execPath,
        args: [resolveLauncherPath(homeDir)],
    };
}

function buildLauncherScript(runtimeCommand: ManagedRuntimeCommand): string {
    return [
        "#!/usr/bin/env node",
        "",
        "const { spawn } = require(\"node:child_process\");",
        "",
        `const command = ${JSON.stringify(runtimeCommand.command)};`,
        `const baseArgs = ${JSON.stringify(runtimeCommand.args)};`,
        "const child = spawn(command, [...baseArgs, ...process.argv.slice(2)], {",
        "  stdio: \"inherit\",",
        "  env: process.env,",
        "});",
        "",
        "child.on(\"error\", (error) => {",
        "  console.error(`Failed to start Satori MCP runtime: ${error.message}`);",
        "  process.exit(1);",
        "});",
        "",
        "child.on(\"exit\", (code, signal) => {",
        "  if (signal) {",
        "    console.error(`Satori MCP runtime exited from signal ${signal}`);",
        "    process.exit(1);",
        "  }",
        "  process.exit(code ?? 0);",
        "});",
        "",
    ].join("\n");
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

function prepareLauncherInstall(homeDir: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const launcherPath = resolveLauncherPath(homeDir);
    const current = readTextIfExists(launcherPath);
    const next = buildLauncherScript(runtimeCommand);
    return {
        changed: current !== next,
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

function installManagedRuntimeCommand(
    homeDir: string,
    packageSpecifier: string,
    execImpl: ExecFileSyncLike
): ManagedRuntimeCommand {
    const runtimeRoot = resolveRuntimeRoot(homeDir, packageSpecifier);
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
            packageSpecifier,
        ], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        throw new CliError(
            "E_USAGE",
            `Failed to install Satori MCP runtime package ${packageSpecifier} into ${runtimeRoot}. ${npmOutput(error)}`,
            2
        );
    }

    const packageRoot = resolveRuntimePackageRoot(homeDir, packageSpecifier);
    const packageJsonPath = path.join(packageRoot, "package.json");
    let packageJson: { bin?: unknown; main?: unknown };
    try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { bin?: unknown; main?: unknown };
    } catch (error) {
        throw new CliError("E_USAGE", `Installed Satori MCP runtime is missing package metadata at ${packageJsonPath}: ${(error as Error).message}`, 2);
    }

    const command = {
        command: process.execPath,
        args: [resolveRuntimeEntryPath(packageRoot, packageJson)],
    };
    if (!fs.existsSync(command.args[0])) {
        throw new CliError("E_USAGE", `Installed Satori MCP runtime entry does not exist: ${command.args[0]}`, 2);
    }
    return command;
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
    return {
        type: "stdio",
        command: runtimeCommand.command,
        args: runtimeCommand.args,
        env: mergeRuntimeEnv(existing?.env, runtimeEnvMap((name) => `\${${name}:-}`)),
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
    const current = readTextIfExists(filePath) ?? "";
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
        apply: mutation.apply,
    };
}

function prepareConfigMutation(
    target: ClientTarget,
    command: InstallCommandInput,
    runtimeCommand: ManagedRuntimeCommand
): FileMutation {
    if (target.client === "codex") {
        return command.kind === "install"
            ? prepareCodexInstall(target.configPath, runtimeCommand, command.installGuidanceHook === true)
            : prepareCodexUninstall(target.configPath);
    }
    if (target.client === "claude") {
        return command.kind === "install"
            ? prepareClaudeInstall(target.configPath, runtimeCommand)
            : prepareClaudeUninstall(target.configPath);
    }
    return command.kind === "install"
        ? prepareOpenCodeInstall(target.configPath, runtimeCommand)
        : prepareOpenCodeUninstall(target.configPath);
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
        configChanged: configMutation.changed,
        companionMutations,
        apply: () => {
            configMutation.apply();
            for (const companionMutation of companionMutations) {
                companionMutation.apply();
            }
        },
    };
}

export function executeInstallCommand(
    command: InstallCommandInput,
    options: InstallCommandOptions = {}
): InstallCommandResult {
    const homeDir = options.homeDir ?? os.homedir();
    const repoDir = options.repoDir ?? process.cwd();
    const packageSpecifier = options.packageSpecifier ?? resolveDefaultPackageSpecifier();
    const skillAssetRoot = options.skillAssetRoot ?? resolveDefaultSkillAssetRoot();
    const plannedRuntimeCommand = options.runtimeCommand ?? plannedManagedRuntimeCommand(homeDir, packageSpecifier);
    const clientCommand = managedClientCommand(homeDir);
    let launcherMutation = command.kind === "install"
        ? prepareLauncherInstall(homeDir, plannedRuntimeCommand)
        : { changed: false, apply: () => {} };
    const profileMutation: FileMutation & { filePath?: string } = command.kind === "install"
        ? prepareProjectProfileInstall(repoDir, command.profile)
        : { changed: false, apply: () => {} };

    const prepared = selectTargets(homeDir, command.client).map((target) => (
        prepareMutation(target, command, clientCommand, skillAssetRoot)
    ));

    if (!command.dryRun) {
        if (command.kind === "install" && !options.runtimeCommand) {
            const installedRuntimeCommand = installManagedRuntimeCommand(homeDir, packageSpecifier, options.execFileSyncImpl ?? execFileSync);
            launcherMutation = prepareLauncherInstall(homeDir, installedRuntimeCommand);
        }
        if (command.kind === "install") {
            launcherMutation.apply();
            profileMutation.apply();
        }
        for (const mutation of prepared) {
            mutation.apply();
        }
    }

    return {
        action: command.kind,
        client: command.client,
        dryRun: command.dryRun,
        profile: command.kind === "install" ? command.profile : undefined,
        profileConfigPath: command.kind === "install" ? profileMutation.filePath : undefined,
        profileConfigChanged: command.kind === "install" ? profileMutation.changed : undefined,
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
