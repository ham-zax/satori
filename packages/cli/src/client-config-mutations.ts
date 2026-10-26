import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { CliError } from "./errors.js";
import { updateCodexConfig } from "./codex-config.js";
import { isManagedCommandParts } from "./managed-runtime-paths.js";
import {
    MANAGED_SESSION_HOOK_FILE,
    MANAGED_SESSION_HOOK_MARKER,
    buildSessionHookShimScript,
} from "./managed-launcher-script.mjs";
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
            writeTextFileAtomic(filePath, next);
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

// Client configs are often symlinks into a dotfiles repository. Rename the
// temp file over the link target so the link and its target stay intact.
function resolveSymlinkWriteTarget(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
        if (!fs.lstatSync(filePath).isSymbolicLink()) return filePath;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return filePath;
        throw error;
    }
    // Dangling link: create the file it names.
    return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
}

export function writeTextFileAtomic(requestedPath: string, content: string, mode?: number): void {
    const filePath = resolveSymlinkWriteTarget(requestedPath);
    ensureParentDir(filePath);
    if (mode === undefined) {
        try {
            mode = fs.statSync(filePath).mode & 0o7777;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tempPath, "wx", mode);
    try {
        try {
            fs.writeFileSync(fd, content, "utf8");
            if (mode !== undefined) fs.fchmodSync(fd, mode);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tempPath, filePath);
    } finally {
        fs.rmSync(tempPath, { force: true });
    }
}

export function prepareCodexInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    return prepareCodexMutation(filePath, runtimeCommand, "install");
}

export function prepareCodexUninstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    return prepareCodexMutation(filePath, runtimeCommand, "uninstall");
}

function prepareCodexMutation(filePath: string, runtimeCommand: ManagedRuntimeCommand, operation: "install" | "uninstall"): FileMutation {
    const current = readTextIfExists(filePath) ?? "";
    const next = updateCodexConfig(current, filePath, runtimeCommand, operation);
    return {
        changed: next !== current,
        apply: () => {
            if (next !== current) writeTextFileAtomic(filePath, next);
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
            writeTextFileAtomic(filePath, next);
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
            writeTextFileAtomic(filePath, next);
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
            writeTextFileAtomic(filePath, next.endsWith("\n") ? next : `${next}\n`);
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

/**
 * Resolves the directory that holds the canonical skill. A symlink (for example one
 * a skill manager such as Skillshare created) is followed to a real directory; the
 * ownership marker in SKILL.md, not the path type, then decides ownership.
 */
function resolveSkillDirectory(skillDir: string): string {
    const stats = lstatIfExists(skillDir);
    if (!stats) return skillDir;
    if (stats.isSymbolicLink()) {
        const resolved = (() => {
            try {
                return fs.realpathSync(skillDir);
            } catch {
                return undefined;
            }
        })();
        if (resolved && fs.statSync(resolved).isDirectory()) return resolved;
    } else if (stats.isDirectory()) {
        return skillDir;
    }
    throw new CliError("E_USAGE", `Refusing to replace ${skillDir}: it is not a Satori-managed skill directory.`, 2);
}

/** Writes the canonical skill copy; refuses to replace a skill Satori did not write. */
export function prepareSkillInstall(linkedSkillDir: string, source: string = readSatoriSkillSource()): FileMutation {
    const skillDir = resolveSkillDirectory(linkedSkillDir);
    const skillFile = path.join(skillDir, "SKILL.md");
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

function isSatoriManagedSkill(skillDir: string): boolean {
    return readTextIfExists(path.join(skillDir, "SKILL.md"))?.includes(SATORI_SKILL_OWNERSHIP_MARKER) === true;
}

/** Removes only a real directory; a linked skill stays with the tool that owns the link. */
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

/** True when the link and the target already reach the same real directory (for example both link to one Skillshare copy). */
function linkResolvesTo(linkPath: string, target: string): boolean {
    try {
        return fs.realpathSync(linkPath) === fs.realpathSync(target);
    } catch {
        return false;
    }
}

/**
 * Links an agent's own skills directory to the canonical skill. Anything else at
 * the link path (a real directory, a file, a symlink to another directory) is unmanaged: the
 * install fails and the user removes it; it is never replaced.
 */
export function prepareSkillLinkInstall(linkPath: string, target: string): FileMutation {
    if (linkParentIsTargetParent(linkPath, target)) {
        return unchangedMutation();
    }
    const stats = lstatIfExists(linkPath);
    if (stats?.isSymbolicLink() && (linkPointsTo(linkPath, target) || linkResolvesTo(linkPath, target))) {
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

function resolveSessionHookShimPath(runtimeCommand: ManagedRuntimeCommand): string {
    return path.join(path.dirname(runtimeCommand.args[0]), MANAGED_SESSION_HOOK_FILE);
}

function sessionStartEntries(filePath: string, settings: Record<string, unknown>): unknown[] {
    const hooks = settings.hooks;
    if (hooks === undefined) return [];
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
        throw new CliError("E_USAGE", `Expected "hooks" to be an object in ${filePath}.`, 2);
    }
    const sessionStart = (hooks as Record<string, unknown>).SessionStart;
    if (sessionStart === undefined) return [];
    if (!Array.isArray(sessionStart)) {
        throw new CliError("E_USAGE", `Expected "hooks.SessionStart" to be an array in ${filePath}.`, 2);
    }
    return sessionStart;
}

/** Drops only hook commands that run this install's shim; other hooks and entries stay intact. */
function withoutSatoriSessionHooks(entries: readonly unknown[], shimPath: string): unknown[] {
    const result: unknown[] = [];
    for (const entry of entries) {
        const hooks = objectValue(entry)?.hooks;
        if (!Array.isArray(hooks)) {
            result.push(entry);
            continue;
        }
        const kept = hooks.filter((hook) => {
            const hookCommand = objectValue(hook)?.command;
            return !(typeof hookCommand === "string" && hookCommand.includes(shimPath));
        });
        if (kept.length === hooks.length) result.push(entry);
        else if (kept.length > 0) result.push({ ...(entry as Record<string, unknown>), hooks: kept });
    }
    return result;
}

function assertShimOwned(shimPath: string, current: string | null): void {
    if (current !== null && !current.includes(MANAGED_SESSION_HOOK_MARKER)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to replace ${shimPath}: it is not managed by Satori. Remove it manually and rerun install.`,
            2,
        );
    }
}

export function prepareSessionHookInstall(settingsPath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const shimPath = resolveSessionHookShimPath(runtimeCommand);
    const currentShim = readTextIfExists(shimPath);
    assertShimOwned(shimPath, currentShim);
    const shim = buildSessionHookShimScript();
    const current = readTextIfExists(settingsPath);
    const settings = current ? parseJsoncObject(settingsPath, current) : {};
    const entries = sessionStartEntries(settingsPath, settings);
    // No matcher: the hook runs for startup, resume, clear, and compact sessions.
    const next = [
        ...withoutSatoriSessionHooks(entries, shimPath),
        { hooks: [{ type: "command", command: `${JSON.stringify(runtimeCommand.command)} ${JSON.stringify(shimPath)}`, timeout: 5 }] },
    ];
    const settingsMutation = mutateJsonc(settingsPath, current ?? "{}\n", ["hooks", "SessionStart"], next);
    const shimChanged = currentShim !== shim;
    return guardFileMutation(settingsPath, current, {
        changed: shimChanged || settingsMutation.changed || current === null,
        apply: () => {
            assertFileContentUnchanged(shimPath, currentShim);
            if (shimChanged) writeTextFileAtomic(shimPath, shim, 0o755);
            settingsMutation.apply();
        },
    });
}

export function prepareSessionHookRemoval(settingsPath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
    const shimPath = resolveSessionHookShimPath(runtimeCommand);
    const currentShim = readTextIfExists(shimPath);
    const removeShim = currentShim !== null && currentShim.includes(MANAGED_SESSION_HOOK_MARKER);
    const current = readTextIfExists(settingsPath);
    let settingsMutation: FileMutation = unchangedMutation();
    if (current) {
        const settings = parseJsoncObject(settingsPath, current);
        const entries = sessionStartEntries(settingsPath, settings);
        const kept = withoutSatoriSessionHooks(entries, shimPath);
        if (kept.length !== entries.length || kept.some((entry, index) => entry !== entries[index])) {
            const hooks = settings.hooks as Record<string, unknown>;
            settingsMutation = kept.length > 0
                ? mutateJsonc(settingsPath, current, ["hooks", "SessionStart"], kept)
                : Object.keys(hooks).length > 1
                    ? mutateJsonc(settingsPath, current, ["hooks", "SessionStart"], undefined)
                    : mutateJsonc(settingsPath, current, ["hooks"], undefined);
        }
    }
    return guardFileMutation(settingsPath, current, {
        changed: removeShim || settingsMutation.changed,
        apply: () => {
            settingsMutation.apply();
            if (removeShim) {
                assertFileContentUnchanged(shimPath, currentShim);
                fs.rmSync(shimPath, { force: true });
            }
        },
    });
}

export function prepareCompanionMutation(
    companion: CompanionTarget,
    command: InstallCommandInput,
    removeSharedSkill: boolean,
    runtimeCommand: ManagedRuntimeCommand,
): CompanionMutation {
    const install = command.kind === "install";
    // The skill is opt-in (--skill). Without the flag, install keeps an existing
    // Satori-written skill current and linked, and never creates one.
    const skillRequested = command.kind === "install" && command.skill === true;
    let mutation: FileMutation;
    switch (companion.kind) {
        case "skill":
            mutation = install
                ? (skillRequested || isSatoriManagedSkill(companion.path)
                    ? prepareSkillInstall(companion.path)
                    : unchangedMutation())
                : removeSharedSkill ? prepareSkillRemoval(companion.path) : unchangedMutation();
            break;
        case "skill-link":
            mutation = install
                ? (skillRequested || isSatoriManagedSkill(companion.target)
                    ? prepareSkillLinkInstall(companion.path, companion.target)
                    : unchangedMutation())
                : prepareSkillLinkRemoval(companion.path, companion.target);
            break;
        case "session-hook":
            mutation = install
                ? prepareSessionHookInstall(companion.path, runtimeCommand)
                : prepareSessionHookRemoval(companion.path, runtimeCommand);
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
            : prepareCodexUninstall(target.configPath, runtimeCommand);
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
        prepareCompanionMutation(companion, command, command.client === "all", runtimeCommand)
    ));

    return {
        target,
        configMutation,
        configChanged: configMutation.changed,
        companionMutations,
    };
}
