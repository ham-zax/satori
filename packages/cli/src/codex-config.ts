import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { CliError } from "./errors.js";
import { SATORI_RUNTIME_ENV_VARS, type ManagedRuntimeCommand } from "./install-contracts.js";
import { isManagedCommandParts } from "./managed-runtime-paths.js";

const SATORI_PATH = ["mcp_servers", "satori"];
const WIRING_KEYS = ["command", "args", "env_vars"] as const;
const LEGACY_MARKERS = new Set([
    "# >>> satori-cli managed satori start >>>",
    "# <<< satori-cli managed satori end <<<",
]);
const INSTALLER_COMMENTS = new Set([
    "# Runtime selection is installer-owned by ~/.satori/bin/satori-mcp.js.",
    "# env_vars forwards optional credentials and operational overrides.",
]);
const UNINSTALL_COMMENTS = new Set([...LEGACY_MARKERS, ...INSTALLER_COMMENTS]);

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

export function parseCodexConfig(content: string, filePath = "Codex config") {
    let ast: AST.TOMLProgram;
    try {
        ast = parseTOML(content, { tomlVersion: "1.0" });
    } catch {
        // Parser messages can include config values; never print credentials.
        throw new CliError("E_USAGE", `Invalid TOML in ${filePath}. Fix the TOML syntax and rerun the command; the file has not been changed.`, 2);
    }
    const config = record(getStaticTOMLValue(ast))!;
    const servers = record(config.mcp_servers);
    const entry = record(servers?.satori);
    if ((config.mcp_servers !== undefined && !servers) || (servers?.satori !== undefined && !entry)) {
        throw new CliError("E_USAGE", `Expected mcp_servers.satori to be a TOML table in ${filePath}; the file has not been changed.`, 2);
    }
    return { ast, entry };
}

type Container = AST.TOMLTopLevelTable | AST.TOMLTable | AST.TOMLInlineTable;
interface LocatedKey {
    node: AST.TOMLKeyValue;
    container: Container;
    path: string[];
}

function keyParts(key: AST.TOMLKey): string[] {
    return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value);
}

function locate(ast: AST.TOMLProgram) {
    const keys: LocatedKey[] = [];
    const containers: { node: Container; path: string[] }[] = [];
    function visit(container: Container, prefix: string[]) {
        containers.push({ node: container, path: prefix });
        for (const node of container.body) {
            if (node.type === "TOMLTable") {
                // Array tables cannot be ancestors of a valid Satori server table.
                if (node.kind === "standard") visit(node, node.resolvedKey as string[]);
            } else {
                const path = [...prefix, ...keyParts(node.key)];
                keys.push({ node, container, path });
                if (node.value.type === "TOMLInlineTable") visit(node.value, path);
            }
        }
    }
    visit(ast.body[0], []);
    return { keys, containers };
}

function samePath(a: string[], b: string[]) {
    return a.length === b.length && a.every((part, index) => part === b[index]);
}

function lineStart(content: string, offset: number) {
    return content.lastIndexOf("\n", offset - 1) + 1;
}

function lineAfter(content: string, offset: number) {
    const newline = content.indexOf("\n", offset);
    return newline === -1 ? content.length : newline + 1;
}

function splice(content: string, start: number, end: number, value: string) {
    return content.slice(0, start) + value + content.slice(end);
}

function formatValue(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    }
    return JSON.stringify(value) ?? "null";
}

function removeKey(content: string, { node, container }: LocatedKey) {
    if (container.type !== "TOMLInlineTable") {
        return splice(content, lineStart(content, node.range[0]), lineAfter(content, node.range[1]), "");
    }
    const index = container.body.indexOf(node);
    const next = container.body[index + 1];
    const previous = container.body[index - 1];
    return next
        ? splice(content, node.range[0], next.range[0], "")
        : splice(content, previous?.range[1] ?? node.range[0], node.range[1], "");
}

function setWiringField(content: string, filePath: string, key: string, value: unknown): string {
    const { ast } = parseCodexConfig(content, filePath);
    const { keys, containers } = locate(ast);
    const path = [...SATORI_PATH, key];
    const existing = keys.find((item) => samePath(item.path, path));
    if (existing) {
        if (value === undefined) return removeKey(content, existing);
        if (JSON.stringify(getStaticTOMLValue(existing.node.value)) === JSON.stringify(value)) return content;
        return splice(content, ...existing.node.value.range, JSON.stringify(value));
    }
    if (value === undefined) return content;
    const parent = containers.filter((item) => item.path.length <= SATORI_PATH.length
        && item.path.every((part, index) => part === SATORI_PATH[index]))
        .sort((a, b) => b.path.length - a.path.length)[0];
    // Bare names are ours, not user input; existing user key spellings stay intact.
    const assignment = `${path.slice(parent.path.length).join(".")} = ${formatValue(value)}`;
    if (parent.node.type === "TOMLInlineTable") {
        const offset = parent.node.range[1] - 1;
        return splice(content, offset, offset, `${parent.node.body.length ? ", " : " "}${assignment} `);
    }
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    const firstTable = parent.node.type === "TOMLTopLevelTable"
        ? parent.node.body.find((node) => node.type === "TOMLTable") : undefined;
    const offset = parent.node.type === "TOMLTopLevelTable"
        ? firstTable ? lineStart(content, firstTable.range[0]) : content.length
        : lineAfter(content, parent.node.range[1]);
    const prefix = offset > 0 && content[offset - 1] !== "\n" ? newline : "";
    return splice(content, offset, offset, `${prefix}${assignment}${newline}`);
}

function stripComments(content: string, ast: AST.TOMLProgram, removable: ReadonlySet<string>): string {
    // Only actual comment nodes may be removed, never matching text in strings.
    for (const comment of [...ast.comments].reverse()) {
        const text = content.slice(...comment.range);
        if (!removable.has(text)) continue;
        const start = lineStart(content, comment.range[0]);
        const end = lineAfter(content, comment.range[1]);
        const isWholeLine = content.slice(start, comment.range[0]).trim() === "";
        content = splice(content, isWholeLine ? start : comment.range[0], isWholeLine ? end : comment.range[1], "");
    }
    return content;
}

export function updateCodexConfig(
    content: string,
    filePath: string,
    runtime: ManagedRuntimeCommand,
    operation: "install" | "uninstall",
): string {
    const { ast, entry } = parseCodexConfig(content, filePath);
    const hasWiring = entry && (entry.command !== undefined || entry.args !== undefined || entry.url !== undefined);
    if (hasWiring && (entry.url !== undefined || !isManagedCommandParts(entry.command, entry.args, runtime.args[0]))) {
        throw new CliError("E_USAGE", `Refusing to ${operation === "install" ? "overwrite" : "remove"} unmanaged Satori config in ${filePath}. The existing mcp_servers.satori entry uses a custom command or URL instead of this home's Satori launcher. Keep it, or explicitly remove that entry before retrying.`, 2);
    }
    if (operation === "uninstall" && !hasWiring) return stripComments(content, ast, UNINSTALL_COMMENTS);
    if (entry?.env_vars !== undefined && (!Array.isArray(entry.env_vars) || entry.env_vars.some((name) => typeof name !== "string"))) {
        throw new CliError("E_USAGE", `Expected mcp_servers.satori.env_vars to be an array of strings in ${filePath}; the file has not been changed.`, 2);
    }
    let next = stripComments(content, ast, operation === "uninstall" ? UNINSTALL_COMMENTS : LEGACY_MARKERS);
    if (operation === "install" && !entry) {
        const hasInlineParent = locate(ast).containers.some(({ node, path }) => node.type === "TOMLInlineTable"
            && path.length <= SATORI_PATH.length && path.every((part, index) => part === SATORI_PATH[index]));
        if (!hasInlineParent) {
            const newline = content.includes("\r\n") ? "\r\n" : "\n";
            next += `${next && !next.endsWith("\n") ? newline : ""}${next ? newline : ""}`
                + `# Runtime selection is installer-owned by ~/.satori/bin/satori-mcp.js.${newline}`
                + `# env_vars forwards optional credentials and operational overrides.${newline}`
                + `[mcp_servers.satori]${newline}`;
        }
    }
    const envVars = [...new Set([...(entry?.env_vars as string[] | undefined ?? []), ...SATORI_RUNTIME_ENV_VARS])];
    const desired = { command: runtime.command, args: runtime.args, env_vars: envVars };
    const userEnvVars = (entry?.env_vars as string[] | undefined ?? []).filter(
        (name) => !SATORI_RUNTIME_ENV_VARS.includes(name as typeof SATORI_RUNTIME_ENV_VARS[number]),
    );
    for (const key of WIRING_KEYS) {
        next = setWiringField(next, filePath, key, operation === "install" ? desired[key]
            : key === "env_vars" && userEnvVars.length > 0 ? userEnvVars : undefined);
    }
    if (operation === "uninstall") {
        const remaining = parseCodexConfig(next, filePath);
        if (remaining.entry && Object.keys(remaining.entry).length === 0) {
            const { keys, containers } = locate(remaining.ast);
            const inline = keys.find((item) => samePath(item.path, SATORI_PATH));
            if (inline) next = removeKey(next, inline);
            else {
                const table = containers.find(({ node, path }) => node.type === "TOMLTable" && samePath(path, SATORI_PATH));
                if (table) next = splice(next, lineStart(next, table.node.range[0]), lineAfter(next, table.node.range[0]), "");
            }
        }
    }
    parseCodexConfig(next, filePath);
    return next;
}
