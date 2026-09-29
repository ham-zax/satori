import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";
import { satoriCliCommand } from "./cli-command.js";
import {
    SATORI_SKILL_NAME,
    type ClientName,
    type ClientTarget,
} from "./install-contracts.js";
import type { InstallClient } from "./args.js";

export function resolveConfiguredPath(value: string | undefined, homeDir: string): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed === "~") {
        return homeDir;
    }
    if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith("~/")) {
        return path.join(homeDir, trimmed.slice(2));
    }
    return trimmed;
}

export function resolveOpenCodeGlobalConfigDir(homeDir: string): string {
    return path.join(homeDir, ".config", "opencode");
}

export function resolveClientTargets(homeDir: string, env: NodeJS.ProcessEnv = process.env): ClientTarget[] {
    const codexHome = resolveConfiguredPath(env.CODEX_HOME, homeDir)
        ?? path.join(homeDir, ".codex");
    const claudeConfigDir = resolveConfiguredPath(env.CLAUDE_CONFIG_DIR, homeDir)
        ?? path.join(homeDir, ".claude");
    const claudeUserRoot = resolveConfiguredPath(env.CLAUDE_CONFIG_DIR, homeDir) ?? homeDir;
    const agyConfigDir = path.join(homeDir, ".gemini", "config");
    const opencodeGlobalConfigDir = resolveOpenCodeGlobalConfigDir(homeDir);
    const opencodeConfigPath = resolveConfiguredPath(env.OPENCODE_CONFIG, homeDir)
        ?? path.join(opencodeGlobalConfigDir, "opencode.json");

    // One canonical skill in the cross-agent skills directory. Codex and
    // OpenCode load it natively; Claude Code and Antigravity scan their own
    // directories, so they receive a link to the same copy.
    const canonicalSkillPath = resolveCanonicalSkillPath(homeDir);
    const skill = { kind: "skill", path: canonicalSkillPath } as const;

    return [
        {
            client: "codex",
            configPath: path.join(codexHome, "config.toml"),
            companions: [
                skill,
            ],
        },
        {
            client: "claude",
            configPath: path.join(claudeUserRoot, ".claude.json"),
            companions: [
                skill,
                {
                    kind: "skill-link",
                    path: path.join(claudeConfigDir, "skills", SATORI_SKILL_NAME),
                    target: canonicalSkillPath,
                },
            ],
        },
        {
            client: "opencode",
            configPath: opencodeConfigPath,
            companions: [
                skill,
            ],
        },
        {
            client: "agy",
            configPath: path.join(agyConfigDir, "mcp_config.json"),
            companions: [
                skill,
                // agy scans ~/.gemini/skills. Where that directory already is the
                // canonical one (a symlink), the link mutation leaves it alone.
                {
                    kind: "skill-link",
                    path: path.join(homeDir, ".gemini", "skills", SATORI_SKILL_NAME),
                    target: canonicalSkillPath,
                },
            ],
        },
    ];
}

export function resolveCanonicalSkillPath(homeDir: string): string {
    return path.join(homeDir, ".agents", "skills", SATORI_SKILL_NAME);
}

function isExecutable(filePath: string): boolean {
    try {
        const stats = fs.statSync(filePath);
        return stats.isFile() && (stats.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function executableExists(command: string, homeDir: string, env: NodeJS.ProcessEnv): boolean {
    const pathEntries = (env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => entry.length > 0);
    const fallbackEntries = [
        ...(path.resolve(homeDir) === path.resolve(os.homedir()) ? ["/usr/local/bin"] : []),
        path.join(homeDir, ".npm", "bin"),
        path.join(homeDir, ".local", "bin"),
        path.join(homeDir, ".cargo", "bin"),
    ];
    return [...new Set([...pathEntries, ...fallbackEntries])]
        .some((entry) => isExecutable(path.join(entry, command)));
}

function configuredPathExists(value: string | undefined, homeDir: string, directory: boolean): boolean {
    const resolved = resolveConfiguredPath(value, homeDir);
    if (!resolved) {
        return false;
    }
    try {
        const stats = fs.statSync(resolved);
        return directory ? stats.isDirectory() : stats.isFile();
    } catch {
        return false;
    }
}

function isClientDetected(target: ClientTarget, homeDir: string, env: NodeJS.ProcessEnv): boolean {
    switch (target.client) {
        case "codex":
            return configuredPathExists(path.dirname(target.configPath), homeDir, true)
                || executableExists("codex", homeDir, env);
        case "claude": {
            const link = target.companions.find((companion) => companion.kind === "skill-link");
            const configDir = link ? path.dirname(path.dirname(link.path)) : undefined;
            return configuredPathExists(configDir, homeDir, true)
                || configuredPathExists(target.configPath, homeDir, false)
                || executableExists("claude", homeDir, env);
        }
        case "opencode": {
            const customConfigDir = resolveConfiguredPath(env.OPENCODE_CONFIG_DIR, homeDir);
            return configuredPathExists(target.configPath, homeDir, false)
                || configuredPathExists(resolveOpenCodeGlobalConfigDir(homeDir), homeDir, true)
                || configuredPathExists(customConfigDir, homeDir, true)
                || executableExists("opencode", homeDir, env);
        }
        case "agy":
            return configuredPathExists(path.dirname(target.configPath), homeDir, true)
                || executableExists("agy", homeDir, env);
    }
}

// Opt-in clients are installed only when named (--client agy) or with --client all;
// auto-detection covers the default set so a detected extra CLI is never configured unasked.
const OPT_IN_CLIENTS: ReadonlySet<ClientName> = new Set<ClientName>(["agy"]);

export function detectClientTargets(
    homeDir: string,
    env: NodeJS.ProcessEnv = process.env,
): ClientName[] {
    return resolveClientTargets(homeDir, env)
        .filter((target) => !OPT_IN_CLIENTS.has(target.client) && isClientDetected(target, homeDir, env))
        .map((target) => target.client);
}

export function assertAutoClientTargets(
    client: InstallClient,
    homeDir: string,
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (client !== "auto" || detectClientTargets(homeDir, env).length > 0) {
        return;
    }
    throw new CliError(
        "E_NO_CLIENTS_DETECTED",
        [
            "No supported coding clients were detected.",
            "",
            "Detected clients: none",
            "",
            "Install Codex, Claude Code, or OpenCode, or explicitly choose:",
            `  ${satoriCliCommand("install --client codex")}`,
            `  ${satoriCliCommand("install --client claude")}`,
            `  ${satoriCliCommand("install --client opencode")}`,
            `  ${satoriCliCommand("install --client agy")}`,
            `  ${satoriCliCommand("install --client all")}`,
        ].join("\n"),
        2,
    );
}

export function selectClientTargets(homeDir: string, client: InstallClient, env: NodeJS.ProcessEnv): ClientTarget[] {
    const targets = resolveClientTargets(homeDir, env);
    if (client === "all") {
        return targets;
    }
    if (client === "auto") {
        const detectedClients = new Set(detectClientTargets(homeDir, env));
        return targets.filter((target) => detectedClients.has(target.client));
    }
    return targets.filter((target) => target.client === client);
}
