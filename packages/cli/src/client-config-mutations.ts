import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { CliError } from "./errors.js";
import type { InstallProfile } from "./args.js";
import type {
    ClientTarget,
    CompanionTarget,
    InstallCommandInput,
    ManagedRuntimeCommand,
} from "./install-contracts.js";
import {
    LAUNCHER_OWNED_RUNTIME_ENV_VARS,
    SATORI_RUNTIME_ENV_VARS,
} from "./install-contracts.js";

export const MANAGED_BLOCK_START = "# >>> satori-cli managed satori start >>>";
export const MANAGED_BLOCK_END = "# <<< satori-cli managed satori end <<<";
export interface CompanionMutation {
    companion: CompanionTarget;
    changed: boolean;
    assertUnchanged?: () => void;
    apply: () => void;
}
export interface PreparedMutation {
    target: ClientTarget;
    configMutation: FileMutation;
    configChanged: boolean;
    companionMutations: readonly CompanionMutation[];
}
export interface FileMutation {
    changed: boolean;
    assertUnchanged?: () => void;
    apply: () => void;
}
export function ensureParentDir(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
}

export function readTextIfExists(filePath: string): string | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return fs.readFileSync(filePath, "utf8");
}

export function assertFileContentUnchanged(filePath: string, expected: string | null): void {
    if (readTextIfExists(filePath) === expected) {
        return;
    }
    throw new CliError(
        "E_INSTALL_PLAN_STALE",
        `Refusing to overwrite '${filePath}' because it changed after the installation plan was created. Rerun the same command against the current file.`,
        1,
    );
}

export function guardFileMutation(filePath: string, expected: string | null, mutation: FileMutation): FileMutation {
    assertFileContentUnchanged(filePath, expected);
    return {
        ...mutation,
        assertUnchanged: () => assertFileContentUnchanged(filePath, expected),
    };
}

export function normalizeTrailingNewline(value: string): string {
    return value.endsWith("\n") ? value : `${value}\n`;
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function toTomlString(value: string): string {
    return JSON.stringify(value);
}

export function buildTomlArray(values: string[]): string {
    return `[${values.map(toTomlString).join(", ")}]`;
}

export function buildSatoriProjectConfig(profile: InstallProfile): string {
    return [
        "# Satori project config",
        "[index]",
        `profile = ${toTomlString(profile)}`,
        "",
    ].join("\n");
}

export function updateSatoriProjectConfig(current: string, profile: InstallProfile): string {
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

export function prepareProjectProfileInstall(repoDir: string, profile: InstallProfile | undefined): FileMutation & { filePath?: string } {
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

export function runtimeEnvMap(valueForName: (name: string) => string): Record<string, string> {
    return Object.fromEntries(SATORI_RUNTIME_ENV_VARS.map((name) => [name, valueForName(name)]));
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value as Record<string, unknown>;
}

export function mergeRuntimeEnv(existing: unknown, defaults: Record<string, string>): Record<string, unknown> {
    return {
        ...defaults,
        ...(objectValue(existing) ?? {}),
    };
}

/** Bash-style `${VAR:-}` expands unset vars to empty string and can override host env. */
export function isEmptyDefaultingShellExpansion(value: string): boolean {
    return /^\$\{[A-Z0-9_]+:-\}$/.test(value.trim());
}

/**
 * Keep only non-empty managed env entries. Prefer omitting keys over writing
 * empty-defaulting placeholders that inject "" into the MCP process.
 */
export function buildPreservedManagedEnv(existing: unknown): Record<string, string> {
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

export function writeTextFileAtomic(filePath: string, content: string, mode?: number): void {
    ensureParentDir(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, content, "utf8");
    if (mode !== undefined) {
        fs.chmodSync(tempPath, mode);
    }
    fs.renameSync(tempPath, filePath);
}

export function buildCodexManagedBlock(runtimeCommand: ManagedRuntimeCommand): string {
    return [
        MANAGED_BLOCK_START,
        "[mcp_servers.satori]",
        `command = ${toTomlString(runtimeCommand.command)}`,
        `args = ${buildTomlArray(runtimeCommand.args)}`,
        "# Runtime selection is installer-owned by ~/.satori/bin/satori-mcp.js.",
        "# env_vars forwards optional credentials and operational overrides.",
        `env_vars = ${buildTomlArray([...SATORI_RUNTIME_ENV_VARS])}`,
        MANAGED_BLOCK_END,
        "",
    ].join("\n");
}

export function codexHasUnmanagedSatoriSection(content: string): boolean {
    if (!content.includes("[mcp_servers.satori]")) {
        return false;
    }
    return !(content.includes(MANAGED_BLOCK_START) && content.includes(MANAGED_BLOCK_END));
}

export function prepareCodexInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
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

export function prepareCodexUninstall(filePath: string): FileMutation {
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

    const withoutManagedBlock = current
        .replace(new RegExp(`\\n?${escapeRegExp(MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegExp(MANAGED_BLOCK_END)}\\n?`, "m"), "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "");
    const next = withoutManagedBlock;

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

export function parseJsonObject(filePath: string): Record<string, unknown> {
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

export function buildClaudeServerConfig(runtimeCommand: ManagedRuntimeCommand, existing?: Record<string, unknown>): Record<string, unknown> {
    // Always return an env object so reinstall replaces legacy empty-defaulting maps.
    // Empty object means "omit env" (host process env supplies credentials).
    return {
        type: "stdio",
        command: runtimeCommand.command,
        args: runtimeCommand.args,
        env: buildPreservedManagedEnv(existing?.env),
    };
}

/** Ownership is this home's launcher exactly; another home's launcher belongs to that install. */
export function isManagedLauncherPath(value: unknown, expectedLauncher: string): value is string {
    return typeof value === "string" && canonicalPath(value) === canonicalPath(expectedLauncher);
}

/**
 * Resolves symlinks through the deepest existing ancestor, so a symlinked HOME
 * spelling matches even while the launcher file itself does not exist yet.
 */
function canonicalPath(value: string): string {
    const missing: string[] = [];
    let current = path.resolve(value);
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...missing.reverse());
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(value);
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

export function isManagedCommandParts(command: unknown, args: unknown, expectedLauncher: string): boolean {
    if (!Array.isArray(args)) {
        return false;
    }

    const entryPath = args[0];
    return typeof command === "string"
        && command.length > 0
        && args.length === 1
        && isManagedLauncherPath(entryPath, expectedLauncher);
}

export function isManagedClaudeEntry(value: unknown, expectedLauncher: string): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return isManagedCommandParts(entry.command, entry.args, expectedLauncher);
}

/** Antigravity (agy) reads the same `mcpServers` map; entries carry `disabled` instead of `type`. */
export function buildAgyServerConfig(runtimeCommand: ManagedRuntimeCommand, existing?: Record<string, unknown>): Record<string, unknown> {
    return {
        command: runtimeCommand.command,
        args: runtimeCommand.args,
        env: buildPreservedManagedEnv(existing?.env),
        disabled: false,
    };
}

export function prepareClaudeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    return prepareMcpServersJsonInstall(filePath, runtimeCommand, buildClaudeServerConfig);
}

export function prepareAgyInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    return prepareMcpServersJsonInstall(filePath, runtimeCommand, buildAgyServerConfig);
}

function prepareMcpServersJsonInstall(
    filePath: string,
    runtimeCommand: ManagedRuntimeCommand,
    buildServer: (runtimeCommand: ManagedRuntimeCommand, existing?: Record<string, unknown>) => Record<string, unknown>,
): FileMutation {
    const currentObject = parseJsonObject(filePath);
    const currentSerialized = JSON.stringify(currentObject);
    const existingSatori = objectValue((currentObject.mcpServers as Record<string, unknown> | undefined)?.satori);
    const desiredServer = buildServer(runtimeCommand, existingSatori);

    const mcpServersValue = currentObject.mcpServers;
    let mcpServers: Record<string, unknown>;
    if (mcpServersValue === undefined) {
        mcpServers = {};
    } else if (mcpServersValue && typeof mcpServersValue === "object" && !Array.isArray(mcpServersValue)) {
        mcpServers = { ...(mcpServersValue as Record<string, unknown>) };
    } else {
        throw new CliError("E_USAGE", `Expected mcpServers to be an object in ${filePath}.`, 2);
    }

    if (mcpServers.satori !== undefined && !isManagedClaudeEntry(mcpServers.satori, runtimeCommand.args[0])) {
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

export function prepareClaudeUninstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const currentObject = parseJsonObject(filePath);
    const mcpServersValue = currentObject.mcpServers;
    if (!mcpServersValue || typeof mcpServersValue !== "object" || Array.isArray(mcpServersValue)) {
        return { changed: false, apply: () => {} };
    }

    const mcpServers = { ...(mcpServersValue as Record<string, unknown>) };
    if (!Object.prototype.hasOwnProperty.call(mcpServers, "satori")) {
        return { changed: false, apply: () => {} };
    }
    if (!isManagedClaudeEntry(mcpServers.satori, runtimeCommand.args[0])) {
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

export function parseJsoncObject(filePath: string, content: string): Record<string, unknown> {
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

export function buildOpenCodeServerConfig(runtimeCommand: ManagedRuntimeCommand, existing?: Record<string, unknown>): Record<string, unknown> {
    const environment = mergeRuntimeEnv(existing?.environment, runtimeEnvMap((name) => `{env:${name}}`));
    for (const name of LAUNCHER_OWNED_RUNTIME_ENV_VARS) {
        delete environment[name];
    }
    return {
        enabled: true,
        type: "local",
        command: [runtimeCommand.command, ...runtimeCommand.args],
        environment,
    };
}

export function isManagedOpenCodeEntry(value: unknown, expectedLauncher: string): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    if (Array.isArray(entry.command)) {
        const [command, ...args] = entry.command;
        return isManagedCommandParts(command, args, expectedLauncher);
    }
    return isManagedCommandParts(entry.command, entry.args, expectedLauncher);
}

export function mutateJsonc(filePath: string, current: string, pathSegments: Array<string | number>, value: unknown): FileMutation {
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

export function prepareOpenCodeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const current = readTextIfExists(filePath) ?? "{}\n";
    const currentObject = parseJsoncObject(filePath, current);
    const mcpValue = currentObject.mcp;
    if (mcpValue !== undefined && (!mcpValue || typeof mcpValue !== "object" || Array.isArray(mcpValue))) {
        throw new CliError("E_USAGE", `Expected mcp to be an object in ${filePath}.`, 2);
    }
    const existingSatori = (mcpValue as Record<string, unknown> | undefined)?.satori;
    if (existingSatori !== undefined && !isManagedOpenCodeEntry(existingSatori, runtimeCommand.args[0])) {
        throw new CliError(
            "E_USAGE",
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove mcp.satori manually or align it to the managed Satori form first.`,
            2
        );
    }
    return mutateJsonc(filePath, current, ["mcp", "satori"], buildOpenCodeServerConfig(runtimeCommand, objectValue(existingSatori)));
}

export function prepareOpenCodeUninstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
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
    if (!isManagedOpenCodeEntry(existingSatori, runtimeCommand.args[0])) {
        throw new CliError(
            "E_USAGE",
            `Refusing to remove unmanaged Satori config in ${filePath}. Remove mcp.satori manually instead.`,
            2
        );
    }
    return mutateJsonc(filePath, current, ["mcp", "satori"], undefined);
}

const SATORI_SKILL_SOURCE_URL = new URL("../assets/skills/satori/SKILL.md", import.meta.url);
const SATORI_SKILL_OWNERSHIP_MARKER = "satori-managed-skill";

function unchangedMutation(): FileMutation {
    return { changed: false, apply: () => {} };
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
    try {
        return fs.lstatSync(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export function readSatoriSkillSource(): string {
    return fs.readFileSync(SATORI_SKILL_SOURCE_URL, "utf8");
}

/** Writes the canonical skill copy; refuses to replace a skill Satori did not write. */
export function prepareSkillInstall(skillDir: string, source: string = readSatoriSkillSource()): FileMutation {
    const skillFile = path.join(skillDir, "SKILL.md");
    const dirStats = lstatIfExists(skillDir);
    if (dirStats && !dirStats.isDirectory()) {
        throw new CliError("E_USAGE", `Refusing to replace ${skillDir}: it is not a Satori-managed skill directory.`, 2);
    }
    const current = readTextIfExists(skillFile);
    if (current !== null && !current.includes(SATORI_SKILL_OWNERSHIP_MARKER)) {
        throw new CliError("E_USAGE", `Refusing to overwrite unmanaged skill at ${skillFile}. Move it aside and rerun install.`, 2);
    }
    if (current === source) {
        return unchangedMutation();
    }
    return {
        changed: true,
        assertUnchanged: () => assertFileContentUnchanged(skillFile, current),
        apply: () => {
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(skillFile, source, "utf8");
        },
    };
}

export function prepareSkillRemoval(skillDir: string): FileMutation {
    const skillFile = path.join(skillDir, "SKILL.md");
    const current = readTextIfExists(skillFile);
    if (!lstatIfExists(skillDir)?.isDirectory() || !current?.includes(SATORI_SKILL_OWNERSHIP_MARKER)) {
        return unchangedMutation();
    }
    return {
        changed: true,
        assertUnchanged: () => assertFileContentUnchanged(skillFile, current),
        apply: () => {
            fs.rmSync(skillFile, { force: true });
            if (fs.readdirSync(skillDir).length === 0) {
                fs.rmdirSync(skillDir);
            }
        },
    };
}

/** Resolves a directory that may not exist yet, following a whole (possibly dangling) symlink chain. */
function resolveDirectory(directory: string): string {
    try {
        return fs.realpathSync(directory);
    } catch {
        let current = path.resolve(directory);
        for (let hop = 0; hop < 40 && lstatIfExists(current)?.isSymbolicLink(); hop += 1) {
            current = path.resolve(path.dirname(current), fs.readlinkSync(current));
        }
        return current;
    }
}

/**
 * True when the link's directory already resolves to the target's directory
 * (for example ~/.gemini/skills symlinked to ~/.agents/skills). The link path
 * is then the canonical skill itself, so it must never be replaced or removed.
 */
function linkParentIsTargetParent(linkPath: string, target: string): boolean {
    return resolveDirectory(path.dirname(linkPath)) === resolveDirectory(path.dirname(target));
}

function linkPointsTo(linkPath: string, target: string): boolean {
    return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === path.resolve(target);
}

/**
 * Links an agent's own skills directory to the canonical skill. Anything else at
 * the link path (a real directory, a file, another symlink) is unmanaged: the
 * install fails and the user removes it; it is never replaced.
 */
export function prepareSkillLinkInstall(linkPath: string, target: string): FileMutation {
    if (linkParentIsTargetParent(linkPath, target)) {
        return unchangedMutation();
    }
    const stats = lstatIfExists(linkPath);
    if (stats?.isSymbolicLink() && linkPointsTo(linkPath, target)) {
        return unchangedMutation();
    }
    if (stats) {
        throw new CliError("E_USAGE", `Refusing to replace ${linkPath}: it is not managed by Satori. Remove it manually and rerun install.`, 2);
    }
    return {
        changed: true,
        apply: () => {
            fs.mkdirSync(path.dirname(linkPath), { recursive: true });
            // "junction" lets Windows link directories without elevation; POSIX ignores it.
            fs.symlinkSync(target, linkPath, "junction");
        },
    };
}

export function prepareSkillLinkRemoval(linkPath: string, target: string): FileMutation {
    if (linkParentIsTargetParent(linkPath, target)) {
        return unchangedMutation();
    }
    const stats = lstatIfExists(linkPath);
    if (stats?.isSymbolicLink()) {
        return linkPointsTo(linkPath, target)
            ? { changed: true, apply: () => fs.unlinkSync(linkPath) }
            : unchangedMutation();
    }
    return unchangedMutation();
}

export function prepareCompanionMutation(
    companion: CompanionTarget,
    command: InstallCommandInput,
    removeSharedSkill: boolean,
): CompanionMutation {
    const install = command.kind === "install";
    let mutation: FileMutation;
    switch (companion.kind) {
        case "skill":
            mutation = install
                ? prepareSkillInstall(companion.path)
                : removeSharedSkill ? prepareSkillRemoval(companion.path) : unchangedMutation();
            break;
        case "skill-link":
            mutation = install
                ? prepareSkillLinkInstall(companion.path, companion.target)
                : prepareSkillLinkRemoval(companion.path, companion.target);
            break;
    }
    return {
        companion,
        changed: mutation.changed,
        assertUnchanged: mutation.assertUnchanged,
        apply: mutation.apply,
    };
}

export function prepareConfigMutation(
    target: ClientTarget,
    command: InstallCommandInput,
    runtimeCommand: ManagedRuntimeCommand
): FileMutation {
    const expected = readTextIfExists(target.configPath);
    let mutation: FileMutation;
    if (target.client === "codex") {
        mutation = command.kind === "install"
            ? prepareCodexInstall(target.configPath, runtimeCommand)
            : prepareCodexUninstall(target.configPath);
    } else if (target.client === "claude" || target.client === "agy") {
        // Both keep Satori under mcpServers.satori; uninstall removal is identical.
        mutation = command.kind === "install"
            ? (target.client === "agy" ? prepareAgyInstall : prepareClaudeInstall)(target.configPath, runtimeCommand)
            : prepareClaudeUninstall(target.configPath, runtimeCommand);
    } else {
        mutation = command.kind === "install"
            ? prepareOpenCodeInstall(target.configPath, runtimeCommand)
            : prepareOpenCodeUninstall(target.configPath, runtimeCommand);
    }
    return guardFileMutation(target.configPath, expected, mutation);
}

export function prepareMutation(
    target: ClientTarget,
    command: InstallCommandInput,
    runtimeCommand: ManagedRuntimeCommand,
): PreparedMutation {
    const configMutation = prepareConfigMutation(target, command, runtimeCommand);
    const companionMutations = target.companions.map((companion) => (
        prepareCompanionMutation(companion, command, command.client === "all")
    ));

    return {
        target,
        configMutation,
        configChanged: configMutation.changed,
        companionMutations,
    };
}
