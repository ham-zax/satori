import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";
import type { InstallClient } from "./args.js";

const MANAGED_BLOCK_START = "# >>> satori-cli managed satori start >>>";
const MANAGED_BLOCK_END = "# <<< satori-cli managed satori end <<<";
const OWNED_SKILL_DIRS = ["satori-search", "satori-navigation", "satori-indexing"] as const;
const MANAGED_TIMEOUT_MS = 180000;

type ClientName = Exclude<InstallClient, "all">;

export interface InstallCommandInput {
    kind: "install" | "uninstall";
    client: InstallClient;
    dryRun: boolean;
}

export interface InstallCommandOptions {
    homeDir?: string;
    packageSpecifier?: string;
    skillAssetRoot?: string;
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

function buildCodexManagedBlock(packageSpecifier: string): string {
    return [
        MANAGED_BLOCK_START,
        "[mcp_servers.satori]",
        'command = "npx"',
        `args = ["-y", "--package", "${packageSpecifier}", "satori"]`,
        `startup_timeout_ms = ${MANAGED_TIMEOUT_MS}`,
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

function prepareCodexInstall(filePath: string, packageSpecifier: string): FileMutation {
    const current = readTextIfExists(filePath) ?? "";
    if (codexHasUnmanagedSatoriSection(current)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove [mcp_servers.satori] manually or convert it to the managed block first.`,
            2
        );
    }

    const managedBlock = buildCodexManagedBlock(packageSpecifier);
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

function buildClaudeServerConfig(packageSpecifier: string): Record<string, unknown> {
    return {
        command: "npx",
        args: ["-y", "--package", packageSpecifier, "satori"],
        timeout: MANAGED_TIMEOUT_MS,
    };
}

function isManagedClaudeEntry(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    if (entry.command !== "npx") {
        return false;
    }
    if (entry.timeout !== MANAGED_TIMEOUT_MS) {
        return false;
    }
    if (!Array.isArray(entry.args) || entry.args.length !== 4) {
        return false;
    }
    return entry.args[0] === "-y"
        && entry.args[1] === "--package"
        && typeof entry.args[2] === "string"
        && /^@zokizuan\/satori-mcp@.+$/.test(entry.args[2])
        && entry.args[3] === "satori";
}

function prepareClaudeInstall(filePath: string, packageSpecifier: string): FileMutation {
    const currentObject = parseJsonObject(filePath);
    const currentSerialized = JSON.stringify(currentObject);
    const desiredServer = buildClaudeServerConfig(packageSpecifier);

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
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove mcpServers.satori manually or align it to the managed npx form first.`,
            2
        );
    }

    mcpServers.satori = {
        ...(existingSatori as Record<string, unknown> | undefined),
        ...desiredServer,
    };
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
    packageSpecifier: string,
    skillAssetRoot: string
): PreparedMutation {
    const configMutation = command.kind === "install"
        ? target.client === "codex"
            ? prepareCodexInstall(target.configPath, packageSpecifier)
            : prepareClaudeInstall(target.configPath, packageSpecifier)
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

    const prepared = selectTargets(homeDir, command.client).map((target) => (
        prepareMutation(target, command, packageSpecifier, skillAssetRoot)
    ));

    if (!command.dryRun) {
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
