import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import type { InstallClient } from "./args.js";

const MANAGED_BLOCK_START = "# >>> satori-cli managed satori start >>>";
const MANAGED_BLOCK_END = "# <<< satori-cli managed satori end <<<";
const OWNED_SKILL_DIRS = ["satori-search", "satori-navigation", "satori-indexing"] as const;
const LEGACY_MANAGED_TIMEOUT_MS = 180000;
const MANAGED_RUNTIME_DIR = "mcp-runtime";
const MANAGED_PACKAGE_NAME = "@zokizuan/satori-mcp";

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
}

export interface InstallCommandOptions {
    homeDir?: string;
    packageSpecifier?: string;
    skillAssetRoot?: string;
    runtimeCommand?: ManagedRuntimeCommand;
    execFileSyncImpl?: ExecFileSyncLike;
}

export interface ClientInstallResult {
    client: ClientName;
    configPath: string;
    skillsPath: string;
    configChanged: boolean;
    skillsChanged: boolean;
    status: "updated" | "unchanged";
    dryRun: boolean;
}

export interface InstallCommandResult {
    action: "install" | "uninstall";
    client: InstallClient;
    dryRun: boolean;
    results: ClientInstallResult[];
}

interface ClientTarget {
    client: ClientName;
    configPath: string;
    skillsPath: string;
}

interface PreparedMutation {
    target: ClientTarget;
    configChanged: boolean;
    skillsChanged: boolean;
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
            skillsPath: path.join(homeDir, ".codex", "skills"),
        },
        {
            client: "claude",
            configPath: path.join(homeDir, ".claude", "settings.json"),
            skillsPath: path.join(homeDir, ".claude", "skills"),
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

function plannedManagedRuntimeCommand(homeDir: string, packageSpecifier: string): ManagedRuntimeCommand {
    return {
        command: process.execPath,
        args: [resolveRuntimeEntryPath(resolveRuntimePackageRoot(homeDir, packageSpecifier))],
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

function runtimeCommandsEqual(left: ManagedRuntimeCommand, right: ManagedRuntimeCommand): boolean {
    return left.command === right.command
        && left.args.length === right.args.length
        && left.args.every((arg, index) => arg === right.args[index]);
}

function buildCodexManagedBlock(runtimeCommand: ManagedRuntimeCommand): string {
    return [
        MANAGED_BLOCK_START,
        "[mcp_servers.satori]",
        `command = ${toTomlString(runtimeCommand.command)}`,
        `args = ${buildTomlArray(runtimeCommand.args)}`,
        MANAGED_BLOCK_END,
        "",
    ].join("\n");
}

function codexHasUnmanagedSatoriSection(content: string): boolean {
    if (!content.includes("[mcp_servers.satori]")) {
        return false;
    }
    return !(content.includes(MANAGED_BLOCK_START) && content.includes(MANAGED_BLOCK_END));
}

function prepareCodexInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
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
        return { changed: false, apply: () => {} };
    }

    const next = current
        .replace(new RegExp(`\\n?${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}\\n?`, "m"), "\n")
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

function buildClaudeServerConfig(runtimeCommand: ManagedRuntimeCommand): Record<string, unknown> {
    return {
        command: runtimeCommand.command,
        args: runtimeCommand.args,
    };
}

function isManagedPackageSpecifier(value: unknown): value is string {
    return typeof value === "string" && /^@zokizuan\/satori-mcp@.+$/.test(value);
}

function isManagedClaudeEntry(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    if (!Array.isArray(entry.args)) {
        return false;
    }
    if (entry.command === "npx") {
        if (entry.timeout !== undefined && entry.timeout !== LEGACY_MANAGED_TIMEOUT_MS) {
            return false;
        }
        if (entry.args.length === 2) {
            return entry.args[0] === "-y" && isManagedPackageSpecifier(entry.args[1]);
        }
        if (entry.args.length === 4) {
            return entry.args[0] === "-y"
                && entry.args[1] === "--package"
                && isManagedPackageSpecifier(entry.args[2])
                && entry.args[3] === "satori";
        }
        return false;
    }

    const command = entry.command;
    const entryPath = entry.args[0];
    if (typeof command !== "string" || command.length === 0 || entry.args.length !== 1 || typeof entryPath !== "string") {
        return false;
    }
    const normalizedEntryPath = entryPath.replace(/\\/g, "/");
    return normalizedEntryPath.includes("/.satori/mcp-runtime/")
        && normalizedEntryPath.includes(`/node_modules/${MANAGED_PACKAGE_NAME}/`);
}

function prepareClaudeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const currentObject = parseJsonObject(filePath);
    const currentSerialized = JSON.stringify(currentObject);
    const desiredServer = buildClaudeServerConfig(runtimeCommand);

    const mcpServersValue = currentObject.mcpServers;
    let mcpServers: Record<string, unknown>;
    if (mcpServersValue === undefined) {
        mcpServers = {};
    } else if (mcpServersValue && typeof mcpServersValue === "object" && !Array.isArray(mcpServersValue)) {
        mcpServers = { ...(mcpServersValue as Record<string, unknown>) };
    } else {
        throw new CliError("E_USAGE", `Expected mcpServers to be an object in ${filePath}.`, 2);
    }

    const existingSatori = mcpServers.satori;
    if (existingSatori !== undefined && !isManagedClaudeEntry(existingSatori)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove mcpServers.satori manually or align it to the managed Satori form first.`,
            2
        );
    }

    mcpServers.satori = {
        ...(existingSatori as Record<string, unknown> | undefined),
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

function prepareMutation(
    target: ClientTarget,
    command: InstallCommandInput,
    runtimeCommand: ManagedRuntimeCommand,
    skillAssetRoot: string
): PreparedMutation {
    const configMutation = command.kind === "install"
        ? target.client === "codex"
            ? prepareCodexInstall(target.configPath, runtimeCommand)
            : prepareClaudeInstall(target.configPath, runtimeCommand)
        : target.client === "codex"
            ? prepareCodexUninstall(target.configPath)
            : prepareClaudeUninstall(target.configPath);

    const skillsMutation = command.kind === "install"
        ? prepareSkillInstall(target.skillsPath, skillAssetRoot)
        : prepareSkillRemoval(target.skillsPath);

    return {
        target,
        configChanged: configMutation.changed,
        skillsChanged: skillsMutation.changed,
        apply: () => {
            configMutation.apply();
            skillsMutation.apply();
        },
    };
}

export function executeInstallCommand(
    command: InstallCommandInput,
    options: InstallCommandOptions = {}
): InstallCommandResult {
    const homeDir = options.homeDir ?? os.homedir();
    const packageSpecifier = options.packageSpecifier ?? resolveDefaultPackageSpecifier();
    const skillAssetRoot = options.skillAssetRoot ?? resolveDefaultSkillAssetRoot();
    let runtimeCommand = options.runtimeCommand ?? plannedManagedRuntimeCommand(homeDir, packageSpecifier);

    let prepared = selectTargets(homeDir, command.client).map((target) => (
        prepareMutation(target, command, runtimeCommand, skillAssetRoot)
    ));

    if (!command.dryRun) {
        if (command.kind === "install" && !options.runtimeCommand) {
            const installedRuntimeCommand = installManagedRuntimeCommand(homeDir, packageSpecifier, options.execFileSyncImpl ?? execFileSync);
            if (!runtimeCommandsEqual(runtimeCommand, installedRuntimeCommand)) {
                runtimeCommand = installedRuntimeCommand;
                prepared = selectTargets(homeDir, command.client).map((target) => (
                    prepareMutation(target, command, runtimeCommand, skillAssetRoot)
                ));
            }
        }
        for (const mutation of prepared) {
            mutation.apply();
        }
    }

    return {
        action: command.kind,
        client: command.client,
        dryRun: command.dryRun,
        results: prepared.map((mutation) => ({
            client: mutation.target.client,
            configPath: mutation.target.configPath,
            skillsPath: mutation.target.skillsPath,
            configChanged: mutation.configChanged,
            skillsChanged: mutation.skillsChanged,
            status: mutation.configChanged || mutation.skillsChanged ? "updated" : "unchanged",
            dryRun: command.dryRun,
        })),
    };
}
