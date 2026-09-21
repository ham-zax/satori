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
    MANAGED_BIN_DIR,
    MANAGED_LAUNCHER_FILE,
    RETIRED_SATORI_RUNTIME_ENV_VARS,
    SATORI_RUNTIME_ENV_VARS,
} from "./install-contracts.js";

export const MANAGED_BLOCK_START = "# >>> satori-cli managed satori start >>>";
export const MANAGED_BLOCK_END = "# <<< satori-cli managed satori end <<<";
export const CODEX_ENV_TEMPLATE_START = "# >>> satori-cli optional satori env template >>>";
export const CODEX_ENV_TEMPLATE_END = "# <<< satori-cli optional satori env template <<<";
export const CODEX_GUIDANCE_HOOK_START = "# >>> satori-cli managed codex guidance hook start >>>";
export const CODEX_GUIDANCE_HOOK_END = "# <<< satori-cli managed codex guidance hook end <<<";
export const INSTRUCTIONS_BLOCK_START = "<!-- satori-mcp:start -->";
export const INSTRUCTIONS_BLOCK_END = "<!-- satori-mcp:end -->";
const CODEX_GUIDANCE_HOOK_MESSAGE = "Satori MCP is available for hybrid repository intelligence. Prefer search_codebase for unfamiliar behavior, ownership, or related implementation; use architecture_overview for repository-wide areas, cross-area boundaries, and hotspots; use the usual/native workflow for known paths, exact literals, or small local edits. Follow recommendedNextAction and verify important call_graph inbound results.";
const CODEX_GUIDANCE_HOOK_MATCHER = "startup|resume|clear|compact";
const CODEX_GUIDANCE_HOOK_TIMEOUT_SECONDS = 5;
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

export function removeLegacyCodexGuidanceHookBlock(content: string): string {
    if (!content.includes(CODEX_GUIDANCE_HOOK_START) || !content.includes(CODEX_GUIDANCE_HOOK_END)) {
        return content;
    }
    return content
        .replace(new RegExp(`\\n?${escapeRegExp(CODEX_GUIDANCE_HOOK_START)}[\\s\\S]*?${escapeRegExp(CODEX_GUIDANCE_HOOK_END)}\\n?`, "m"), "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "");
}

export function removeManagedCodexEnvTemplate(content: string): string {
    if (!content.includes(CODEX_ENV_TEMPLATE_START) || !content.includes(CODEX_ENV_TEMPLATE_END)) {
        return content;
    }
    return content
        .replace(new RegExp(`\\n?${escapeRegExp(CODEX_ENV_TEMPLATE_START)}[\\s\\S]*?${escapeRegExp(CODEX_ENV_TEMPLATE_END)}\\n?`, "m"), "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+/, "");
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

    next = removeManagedCodexEnvTemplate(removeLegacyCodexGuidanceHookBlock(next));

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
        const next = removeManagedCodexEnvTemplate(removeLegacyCodexGuidanceHookBlock(current));
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
    const next = removeManagedCodexEnvTemplate(removeLegacyCodexGuidanceHookBlock(withoutManagedBlock));

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

export function buildCodexGuidanceHookEntry(): Record<string, unknown> {
    return {
        matcher: CODEX_GUIDANCE_HOOK_MATCHER,
        hooks: [{
            type: "command",
            command: CODEX_GUIDANCE_HOOK_COMMAND,
            timeout: CODEX_GUIDANCE_HOOK_TIMEOUT_SECONDS,
        }],
    };
}

export function codexSessionStartHooks(document: Record<string, unknown>, filePath: string): {
    hooks: Record<string, unknown>;
    entries: unknown[];
} {
    const hooks = document.hooks === undefined ? {} : objectValue(document.hooks);
    if (!hooks) {
        throw new CliError("E_USAGE", `Expected 'hooks' to be an object in ${filePath}.`, 2);
    }
    const entries = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
    if (!Array.isArray(entries)) {
        throw new CliError("E_USAGE", `Expected 'hooks.SessionStart' to be an array in ${filePath}.`, 2);
    }
    return { hooks, entries };
}

export function isManagedCodexGuidanceHook(value: unknown): boolean {
    const entry = objectValue(value);
    if (!entry || entry.matcher !== CODEX_GUIDANCE_HOOK_MATCHER || !Array.isArray(entry.hooks) || entry.hooks.length !== 1) {
        return false;
    }
    const hook = objectValue(entry.hooks[0]);
    return hook?.type === "command"
        && typeof hook.command === "string"
        && hook.command.includes("satori-codex-guidance.");
}

export function hasManagedCodexGuidanceHook(filePath: string): boolean {
    const current = readTextIfExists(filePath);
    if (!current?.includes("satori-codex-guidance.")) {
        return false;
    }
    const document = parseJsonObject(filePath);
    return codexSessionStartHooks(document, filePath).entries.some(isManagedCodexGuidanceHook);
}

export function prepareCodexGuidanceHookInstall(filePath: string): FileMutation {
    const currentFile = readTextIfExists(filePath);
    const document = parseJsonObject(filePath);
    const { hooks, entries } = codexSessionStartHooks(document, filePath);
    const canonical = buildCodexGuidanceHookEntry();
    const managed = entries.filter(isManagedCodexGuidanceHook);
    if (managed.length === 1 && JSON.stringify(managed[0]) === JSON.stringify(canonical)) {
        return { changed: false, apply: () => {} };
    }
    const nextDocument = {
        ...document,
        hooks: {
            ...hooks,
            SessionStart: [...entries.filter((entry) => !isManagedCodexGuidanceHook(entry)), canonical],
        },
    };
    const next = `${JSON.stringify(nextDocument, null, 2)}\n`;
    return {
        changed: next !== currentFile,
        assertUnchanged: () => assertFileContentUnchanged(filePath, currentFile),
        apply: () => {
            assertFileContentUnchanged(filePath, currentFile);
            ensureParentDir(filePath);
            fs.writeFileSync(filePath, next, { encoding: "utf8", mode: 0o600 });
            fs.chmodSync(filePath, 0o600);
        },
    };
}

export function prepareCodexGuidanceHookRemoval(filePath: string): FileMutation {
    const currentFile = readTextIfExists(filePath);
    if (!currentFile?.includes("satori-codex-guidance.")) {
        return { changed: false, apply: () => {} };
    }
    const document = parseJsonObject(filePath);
    const { hooks, entries } = codexSessionStartHooks(document, filePath);
    const retained = entries.filter((entry) => !isManagedCodexGuidanceHook(entry));
    if (retained.length === entries.length) {
        return { changed: false, apply: () => {} };
    }
    const nextHooks = { ...hooks };
    if (retained.length > 0) {
        nextHooks.SessionStart = retained;
    } else {
        delete nextHooks.SessionStart;
    }
    const nextDocument = { ...document };
    if (Object.keys(nextHooks).length > 0) {
        nextDocument.hooks = nextHooks;
    } else {
        delete nextDocument.hooks;
    }
    const next = `${JSON.stringify(nextDocument, null, 2)}\n`;
    return {
        changed: next !== currentFile,
        assertUnchanged: () => assertFileContentUnchanged(filePath, currentFile),
        apply: () => {
            assertFileContentUnchanged(filePath, currentFile);
            fs.writeFileSync(filePath, next, { encoding: "utf8", mode: 0o600 });
            fs.chmodSync(filePath, 0o600);
        },
    };
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

export function isManagedLauncherPath(value: unknown): value is string {
    return typeof value === "string" && value.replace(/\\/g, "/").endsWith(`/.satori/${MANAGED_BIN_DIR}/${MANAGED_LAUNCHER_FILE}`);
}

export function isManagedCommandParts(command: unknown, args: unknown): boolean {
    if (!Array.isArray(args)) {
        return false;
    }

    const entryPath = args[0];
    return typeof command === "string"
        && command.length > 0
        && args.length === 1
        && isManagedLauncherPath(entryPath);
}

export function isManagedClaudeEntry(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return isManagedCommandParts(entry.command, entry.args);
}

export function prepareClaudeInstall(filePath: string, runtimeCommand: ManagedRuntimeCommand): FileMutation {
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

export function prepareClaudeUninstall(filePath: string): FileMutation {
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
    for (const name of [
        ...LAUNCHER_OWNED_RUNTIME_ENV_VARS,
        ...RETIRED_SATORI_RUNTIME_ENV_VARS,
    ]) {
        delete environment[name];
    }
    return {
        enabled: true,
        type: "local",
        command: [runtimeCommand.command, ...runtimeCommand.args],
        environment,
    };
}

export function isManagedOpenCodeEntry(value: unknown): value is Record<string, unknown> {
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
    if (existingSatori !== undefined && !isManagedOpenCodeEntry(existingSatori)) {
        throw new CliError(
            "E_USAGE",
            `Refusing to overwrite unmanaged Satori config in ${filePath}. Remove mcp.satori manually or align it to the managed Satori form first.`,
            2
        );
    }
    return mutateJsonc(filePath, current, ["mcp", "satori"], buildOpenCodeServerConfig(runtimeCommand, objectValue(existingSatori)));
}

export function prepareOpenCodeUninstall(filePath: string): FileMutation {
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

export function prepareLegacySkillRemoval(skillPath: string): FileMutation {
    const changed = fs.existsSync(skillPath);
    return {
        changed,
        apply: () => {
            if (changed) {
                fs.rmSync(skillPath, { recursive: true, force: true });
            }
        },
    };
}

export function buildManagedInstructionsBlock(instructions: string): string {
    return [
        INSTRUCTIONS_BLOCK_START,
        instructions.trim(),
        INSTRUCTIONS_BLOCK_END,
        "",
    ].join("\n");
}

export function prepareInstructionsInstall(filePath: string, instructions: string): FileMutation {
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

export function prepareInstructionsRemoval(filePath: string): FileMutation {
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

export function prepareCompanionMutation(
    companion: CompanionTarget,
    command: InstallCommandInput,
    installGuidanceHook: boolean,
): CompanionMutation {
    let mutation: FileMutation;
    if (companion.kind === "legacy-skill") {
        mutation = prepareLegacySkillRemoval(companion.path);
    } else if (companion.kind === "instructions") {
        mutation = command.kind === "install"
            ? prepareInstructionsInstall(companion.path, companion.instructions)
            : prepareInstructionsRemoval(companion.path);
    } else {
        mutation = command.kind === "uninstall"
            ? prepareCodexGuidanceHookRemoval(companion.path)
            : installGuidanceHook
            ? prepareCodexGuidanceHookInstall(companion.path)
            : { changed: false, apply: () => {} };
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

export function prepareMutation(
    target: ClientTarget,
    command: InstallCommandInput,
    runtimeCommand: ManagedRuntimeCommand,
): PreparedMutation {
    const legacyGuidanceHook = target.client === "codex"
        && (readTextIfExists(target.configPath)?.includes(CODEX_GUIDANCE_HOOK_START) ?? false);
    const guidanceHookTarget = target.companions.find((companion) => companion.kind === "guidance-hook");
    const installGuidanceHook = command.kind === "install"
        && target.client === "codex"
        && (
            command.installGuidanceHook === true
            || legacyGuidanceHook
            || (guidanceHookTarget ? hasManagedCodexGuidanceHook(guidanceHookTarget.path) : false)
        );
    const configMutation = prepareConfigMutation(target, command, runtimeCommand);
    const companionMutations = target.companions.map((companion) => (
        prepareCompanionMutation(companion, command, installGuidanceHook)
    ));

    return {
        target,
        configMutation,
        configChanged: configMutation.changed,
        companionMutations,
    };
}
