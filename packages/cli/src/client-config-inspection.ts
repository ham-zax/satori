import { CliError } from "./errors.js";
import type {
    InstallVectorStore,
} from "./args.js";
import type {
    ClientTarget,
    InstallCommandResult,
    ManagedClientConfigProof,
    ManagedRuntimeCommand,
} from "./install-contracts.js";
import { resolveClientTargets } from "./client-targets.js";
import { resolveLauncherPath, resolveManagedClientCommand } from "./managed-runtime-paths.js";
import { SATORI_RUNTIME_ENV_VARS } from "./install-contracts.js";
import { parseManagedLauncherEnvironment } from "./managed-launcher-script.mjs";
import {
    buildCodexManagedBlock,
    isManagedCommandParts,
    MANAGED_BLOCK_START,
    objectValue,
    parseJsonObject,
    parseJsoncObject,
    readTextIfExists,
    toTomlString,
} from "./client-config-mutations.js";

export function commandMatchesExpected(command: unknown, args: unknown, expected: ManagedRuntimeCommand): boolean {
    return command === expected.command
        && Array.isArray(args)
        && args.length === expected.args.length
        && args.every((entry, index) => entry === expected.args[index]);
}

export function resolveConfiguredEnvironmentValue(
    value: unknown,
    inheritedEnv: NodeJS.ProcessEnv,
): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const reference = value.match(/^\{env:([A-Z][A-Z0-9_]*)\}$/)
        ?? value.match(/^\$\{([A-Z][A-Z0-9_]*)(?::-)?\}$/);
    if (reference) {
        return inheritedEnv[reference[1]];
    }
    return value;
}

export function filteredRuntimeEnvironment(
    value: unknown,
    inheritedEnv: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
    const input = objectValue(value);
    if (!input) {
        return Object.freeze({});
    }
    const entries: Array<[string, string]> = [];
    for (const name of SATORI_RUNTIME_ENV_VARS) {
        const resolved = resolveConfiguredEnvironmentValue(input[name], inheritedEnv);
        if (resolved !== undefined) {
            entries.push([name, resolved]);
        }
    }
    return Object.freeze(Object.fromEntries(entries));
}

export function readCodexRuntimeEnvironment(
    content: string,
    inheritedEnv: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
    let section = "";
    const configured: Record<string, string> = {};
    for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
        const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
        if (table) {
            section = table[1];
            continue;
        }
        if (section !== "mcp_servers.satori.env") {
            continue;
        }
        const literal = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
        if (!literal || !SATORI_RUNTIME_ENV_VARS.includes(literal[1] as typeof SATORI_RUNTIME_ENV_VARS[number])) {
            continue;
        }
        const raw = literal[2].startsWith('"')
            ? JSON.parse(literal[2]) as string
            : literal[2].slice(1, -1);
        const resolved = resolveConfiguredEnvironmentValue(raw, inheritedEnv);
        if (resolved !== undefined) {
            configured[literal[1]] = resolved;
        }
    }
    return Object.freeze(configured);
}

export function verifyManagedClientTarget(
    target: Pick<ClientTarget, "client" | "configPath">,
    expected: ManagedRuntimeCommand,
    inheritedEnv: NodeJS.ProcessEnv = process.env,
): ManagedClientConfigProof {
    let matches = false;
    let disabled = false;
    let usesManagedLauncher: boolean | undefined;
    let runtimeEnvironment: Readonly<Record<string, string>> | undefined;
    try {
        if (target.client === "codex") {
            const content = readTextIfExists(target.configPath) ?? "";
            matches = content.includes(buildCodexManagedBlock(expected));
            usesManagedLauncher = content.includes(toTomlString(expected.args[0]));
            runtimeEnvironment = readCodexRuntimeEnvironment(content, inheritedEnv);
        } else if (target.client === "claude" || target.client === "agy") {
            const config = parseJsonObject(target.configPath);
            const entry = objectValue(objectValue(config.mcpServers)?.satori);
            // agy skips entries flagged disabled, so the launcher wiring alone does not make it configured.
            disabled = target.client === "agy" && entry?.disabled === true;
            matches = commandMatchesExpected(entry?.command, entry?.args, expected) && !disabled;
            usesManagedLauncher = isManagedCommandParts(entry?.command, entry?.args);
            runtimeEnvironment = filteredRuntimeEnvironment(entry?.env, inheritedEnv);
        } else {
            const content = readTextIfExists(target.configPath) ?? "";
            const config = parseJsoncObject(target.configPath, content);
            const entry = objectValue(objectValue(config.mcp)?.satori);
            matches = Array.isArray(entry?.command)
                && commandMatchesExpected(entry.command[0], entry.command.slice(1), expected);
            usesManagedLauncher = Array.isArray(entry?.command)
                ? isManagedCommandParts(entry.command[0], entry.command.slice(1))
                : isManagedCommandParts(entry?.command, entry?.args);
            runtimeEnvironment = filteredRuntimeEnvironment(entry?.environment, inheritedEnv);
        }
    } catch {
        matches = false;
        usesManagedLauncher = undefined;
        runtimeEnvironment = undefined;
    }

    return {
        client: target.client,
        configPath: target.configPath,
        status: matches ? "ok" : "error",
        message: matches
            ? `${target.client} config points to ${expected.args[0]}.`
            : disabled
            ? `${target.client} config has the Satori entry disabled. Set \"disabled\" to false or rerun install --client ${target.client}.`
            : `${target.client} config does not point exactly to ${expected.command} ${expected.args[0]}.`,
        runtimeEnvironment,
        usesManagedLauncher,
    };
}

export function hasSatoriClientEntry(target: ClientTarget): boolean {
    const content = readTextIfExists(target.configPath);
    if (content === null) {
        return false;
    }
    try {
        if (target.client === "codex") {
            return content.includes(MANAGED_BLOCK_START) || /\[mcp_servers\.satori(?:\.|\])/.test(content);
        }
        if (target.client === "claude" || target.client === "agy") {
            return objectValue(objectValue(parseJsonObject(target.configPath).mcpServers)?.satori) !== undefined;
        }
        return objectValue(objectValue(parseJsoncObject(target.configPath, content).mcp)?.satori) !== undefined;
    } catch {
        return content.includes("satori");
    }
}

export function parseVectorStoreLiteral(value: unknown, source: string): InstallVectorStore | undefined {
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

export function readCodexVectorStore(filePath: string): InstallVectorStore | undefined {
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

export function readClientVectorStore(target: ClientTarget): InstallVectorStore | undefined {
    if (target.client === "codex") {
        return readCodexVectorStore(target.configPath);
    }
    if (target.client === "claude" || target.client === "agy") {
        const entry = objectValue(objectValue(parseJsonObject(target.configPath).mcpServers)?.satori);
        return parseVectorStoreLiteral(
            objectValue(entry?.env)?.VECTOR_STORE_PROVIDER,
            `${target.client === "agy" ? "Antigravity" : "Claude"} config '${target.configPath}'`,
        );
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

export function readManagedLauncherVectorStore(
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

export function readManagedRuntimeEnvironment(homeDir: string): Readonly<Record<string, string>> {
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

export function runtimeEnvironmentWithManagedFallbacks(
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

export function inspectManagedClientConfigurations(
    homeDir: string,
    inheritedEnv: NodeJS.ProcessEnv = process.env,
): ManagedClientConfigProof[] {
    const expected = resolveManagedClientCommand(homeDir);
    return resolveClientTargets(homeDir, inheritedEnv)
        .filter(hasSatoriClientEntry)
        .map((target) => verifyManagedClientTarget(target, expected, inheritedEnv));
}

export function verifyManagedClientConfigurations(
    installResult: InstallCommandResult,
    homeDir: string,
): ManagedClientConfigProof[] {
    const expected = resolveManagedClientCommand(homeDir);
    return installResult.results.map((result) => verifyManagedClientTarget(result, expected));
}
