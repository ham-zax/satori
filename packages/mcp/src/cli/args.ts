import fs from "node:fs";
import { CliError } from "./errors.js";

export interface GlobalOptions {
    startupTimeoutMs: number;
    callTimeoutMs: number;
    format: "json" | "text";
    debug: boolean;
}

export type RawArgsMode =
    | { kind: "none" }
    | { kind: "json"; value: string }
    | { kind: "file"; path: string }
    | { kind: "stdin-json" };

export type ParsedCommand =
    | { kind: "help" }
    | { kind: "version" }
    | { kind: "tools-list" }
    | { kind: "tool-call"; toolName: string; rawArgsMode: RawArgsMode }
    | { kind: "wrapper"; toolName: string; rawArgsMode: RawArgsMode; wrapperArgs: string[] };

export interface ParsedCliInput {
    globals: GlobalOptions;
    command: ParsedCommand;
}

export interface ResolveRawArgsOptions {
    stdin?: NodeJS.ReadStream;
    stdinTimeoutMs: number;
}

const RESERVED_SUBCOMMANDS = new Set(["tools", "tool", "help", "version"]);
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

function parsePositiveInteger(value: string, flagName: string): number {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new CliError("E_USAGE", `${flagName} must be a positive integer.`, 2);
    }
    return parsed;
}

function normalizeFlagToken(token: string): string {
    return token.replace(/^--/, "").replace(/-/g, "_");
}

function stripFlagPrefix(token: string): string {
    if (!token.startsWith("--")) {
        throw new CliError("E_USAGE", `Expected a flag but found '${token}'.`, 2);
    }
    return token.slice(2);
}

function parseGlobalOptions(argv: string[]): { globals: GlobalOptions; rest: string[] } {
    const globals: GlobalOptions = {
        startupTimeoutMs: 180000,
        callTimeoutMs: 600000,
        format: "json",
        debug: false,
    };

    let i = 0;
    while (i < argv.length) {
        const token = argv[i];
        switch (token) {
            case "--startup-timeout-ms": {
                const next = argv[i + 1];
                if (!next) {
                    throw new CliError("E_USAGE", "Missing value for --startup-timeout-ms.", 2);
                }
                globals.startupTimeoutMs = parsePositiveInteger(next, "--startup-timeout-ms");
                i += 2;
                break;
            }
            case "--call-timeout-ms": {
                const next = argv[i + 1];
                if (!next) {
                    throw new CliError("E_USAGE", "Missing value for --call-timeout-ms.", 2);
                }
                globals.callTimeoutMs = parsePositiveInteger(next, "--call-timeout-ms");
                i += 2;
                break;
            }
            case "--format": {
                const next = argv[i + 1];
                if (!next || (next !== "json" && next !== "text")) {
                    throw new CliError("E_USAGE", "--format must be one of: json, text.", 2);
                }
                globals.format = next;
                i += 2;
                break;
            }
            case "--debug": {
                globals.debug = true;
                i += 1;
                break;
            }
            default: {
                return {
                    globals,
                    rest: argv.slice(i),
                };
            }
        }
    }

    return { globals, rest: [] };
}

function parseRawArgsMode(args: string[]): { rawArgsMode: RawArgsMode; remaining: string[] } {
    let rawArgsMode: RawArgsMode = { kind: "none" };
    const remaining: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (token === "--args-json") {
            if (rawArgsMode.kind !== "none") {
                throw new CliError("E_USAGE", "Use only one of --args-json or --args-file.", 2);
            }
            const next = args[i + 1];
            if (!next) {
                throw new CliError("E_USAGE", "Missing value for --args-json.", 2);
            }
            rawArgsMode = next === "@-"
                ? { kind: "stdin-json" }
                : { kind: "json", value: next };
            i += 1;
            continue;
        }
        if (token === "--args-file") {
            if (rawArgsMode.kind !== "none") {
                throw new CliError("E_USAGE", "Use only one of --args-json or --args-file.", 2);
            }
            const next = args[i + 1];
            if (!next) {
                throw new CliError("E_USAGE", "Missing value for --args-file.", 2);
            }
            rawArgsMode = { kind: "file", path: next };
            i += 1;
            continue;
        }
        remaining.push(token);
    }

    if (rawArgsMode.kind !== "none" && remaining.length > 0) {
        throw new CliError("E_USAGE", "Tool argument flags cannot be combined with --args-json/--args-file.", 2);
    }

    return { rawArgsMode, remaining };
}

export function parseCliArgs(argv: string[]): ParsedCliInput {
    const { globals, rest } = parseGlobalOptions(argv);
    if (rest.length === 0 || rest[0] === "help" || rest.includes("--help") || rest.includes("-h")) {
        return {
            globals,
            command: { kind: "help" }
        };
    }

    if (rest[0] === "version" || rest.includes("--version") || rest.includes("-v")) {
        return {
            globals,
            command: { kind: "version" }
        };
    }

    if (rest[0] === "tools") {
        if (rest.length === 2 && rest[1] === "list") {
            return {
                globals,
                command: { kind: "tools-list" }
            };
        }
        throw new CliError("E_USAGE", "Unsupported tools subcommand. Use: tools list", 2);
    }

    if (rest[0] === "tool") {
        if (rest[1] !== "call") {
            throw new CliError("E_USAGE", "Unsupported tool subcommand. Use: tool call <toolName>", 2);
        }
        const toolName = rest[2];
        if (!toolName) {
            throw new CliError("E_USAGE", "Missing tool name. Use: tool call <toolName>", 2);
        }
        const { rawArgsMode, remaining } = parseRawArgsMode(rest.slice(3));
        if (remaining.length > 0) {
            throw new CliError("E_USAGE", `Unknown arguments for tool call: ${remaining.join(" ")}`, 2);
        }
        return {
            globals,
            command: {
                kind: "tool-call",
                toolName,
                rawArgsMode
            }
        };
    }

    if (RESERVED_SUBCOMMANDS.has(rest[0])) {
        throw new CliError("E_USAGE", `Unsupported command '${rest[0]}'.`, 2);
    }

    const toolName = rest[0];
    const { rawArgsMode, remaining } = parseRawArgsMode(rest.slice(1));
    return {
        globals,
        command: {
            kind: "wrapper",
            toolName,
            rawArgsMode,
            wrapperArgs: remaining
        }
    };
}

function readStdin(stdin: NodeJS.ReadStream, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: string[] = [];
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new CliError("E_USAGE", "Timed out while reading stdin JSON for --args-json @-.", 2));
        }, timeoutMs);
        timeout.unref();

        stdin.setEncoding("utf8");
        stdin.on("data", (chunk) => {
            chunks.push(String(chunk));
        });
        stdin.on("error", (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            reject(new CliError("E_USAGE", `Failed to read stdin: ${(error as Error).message}`, 2));
        });
        stdin.on("end", () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve(chunks.join(""));
        });
        stdin.resume();
    });
}

function parseJsonObject(value: string, source: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError("E_USAGE", `Invalid JSON from ${source}: ${message}`, 2);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CliError("E_USAGE", `JSON from ${source} must be an object.`, 2);
    }
    return parsed as Record<string, unknown>;
}

export async function resolveRawArguments(rawArgsMode: RawArgsMode, options: ResolveRawArgsOptions): Promise<Record<string, unknown>> {
    switch (rawArgsMode.kind) {
        case "none":
            return {};
        case "json":
            return parseJsonObject(rawArgsMode.value, "--args-json");
        case "file": {
            if (!fs.existsSync(rawArgsMode.path)) {
                throw new CliError("E_USAGE", `Arguments file not found: ${rawArgsMode.path}`, 2);
            }
            const content = fs.readFileSync(rawArgsMode.path, "utf8");
            return parseJsonObject(content, "--args-file");
        }
        case "stdin-json": {
            const text = await readStdin(options.stdin || process.stdin, options.stdinTimeoutMs);
            if (text.trim().length === 0) {
                throw new CliError("E_USAGE", "stdin was empty for --args-json @-.", 2);
            }
            return parseJsonObject(text, "--args-json @-");
        }
        default:
            return {};
    }
}

function isPrimitiveEnum(enumValues: unknown[]): boolean {
    return enumValues.every((value) => {
        const valueType = typeof value;
        return valueType === "string" || valueType === "number" || valueType === "boolean";
    });
}

function unsupportedSchemaReason(schema: any): string | null {
    if (!schema || typeof schema !== "object") {
        return "schema is not an object";
    }
    if ("oneOf" in schema) {
        return "oneOf is not supported in wrapper mode";
    }
    if ("anyOf" in schema) {
        return "anyOf is not supported in wrapper mode";
    }
    if ("allOf" in schema) {
        return "allOf is not supported in wrapper mode";
    }
    if ("$ref" in schema) {
        return "$ref is not supported in wrapper mode";
    }
    if ("patternProperties" in schema) {
        return "patternProperties is not supported in wrapper mode";
    }

    if (Array.isArray(schema.enum) && !isPrimitiveEnum(schema.enum)) {
        return "enum values must be primitive";
    }

    if (schema.type === "array") {
        const itemSchema = schema.items;
        if (!itemSchema || typeof itemSchema !== "object") {
            return "array items schema is missing";
        }
        const itemReason = unsupportedSchemaReason(itemSchema);
        if (itemReason) {
            return `array item schema unsupported: ${itemReason}`;
        }
        if (typeof itemSchema.type === "string" && !PRIMITIVE_TYPES.has(itemSchema.type) && !Array.isArray(itemSchema.enum)) {
            return "array item type must be primitive";
        }
    }

    if (typeof schema.type === "string" && schema.type !== "object" && !PRIMITIVE_TYPES.has(schema.type) && !Array.isArray(schema.enum)) {
        return `schema type '${schema.type}' is not supported`;
    }

    return null;
}

function parseBooleanValue(value: string): boolean {
    if (value === "true") {
        return true;
    }
    if (value === "false") {
        return false;
    }
    throw new CliError("E_USAGE", `Invalid boolean value '${value}'. Use true or false.`, 2);
}

function parseEnumValue(raw: string, enumValues: unknown[]): unknown {
    for (const entry of enumValues) {
        if (typeof entry === "string" && entry === raw) {
            return entry;
        }
        if (typeof entry === "number" && Number(raw) === entry) {
            return entry;
        }
        if (typeof entry === "boolean") {
            if (raw === "true" && entry === true) {
                return true;
            }
            if (raw === "false" && entry === false) {
                return false;
            }
        }
    }
    throw new CliError("E_USAGE", `Value '${raw}' is not in enum [${enumValues.map(String).join(", ")}].`, 2);
}

function parsePrimitive(schema: any, raw: string): unknown {
    if (Array.isArray(schema.enum)) {
        return parseEnumValue(raw, schema.enum);
    }

    switch (schema.type) {
        case "string":
            return raw;
        case "number": {
            const parsed = Number(raw);
            if (!Number.isFinite(parsed)) {
                throw new CliError("E_USAGE", `Value '${raw}' must be a finite number.`, 2);
            }
            return parsed;
        }
        case "integer": {
            const parsed = Number(raw);
            if (!Number.isInteger(parsed)) {
                throw new CliError("E_USAGE", `Value '${raw}' must be an integer.`, 2);
            }
            return parsed;
        }
        case "boolean":
            return parseBooleanValue(raw);
        default:
            throw new CliError("E_SCHEMA_UNSUPPORTED", `Primitive parsing unsupported for schema type '${String(schema.type)}'. Use --args-json/--args-file.`, 2);
    }
}

export function parseWrapperArgumentsFromSchema(
    toolName: string,
    inputSchema: unknown,
    wrapperArgs: string[]
): Record<string, unknown> {
    if (!inputSchema || typeof inputSchema !== "object") {
        throw new CliError("E_SCHEMA_UNSUPPORTED", `${toolName} schema is missing or invalid. Use --args-json/--args-file.`, 2);
    }

    const schema = inputSchema as Record<string, any>;
    const rootReason = unsupportedSchemaReason(schema);
    if (rootReason) {
        throw new CliError("E_SCHEMA_UNSUPPORTED", `${toolName} schema unsupported (${rootReason}). Use --args-json/--args-file.`, 2);
    }

    const properties = schema.properties;
    if (!properties || typeof properties !== "object") {
        throw new CliError("E_SCHEMA_UNSUPPORTED", `${toolName} schema has no object properties. Use --args-json/--args-file.`, 2);
    }

    const requiredProps = Array.isArray(schema.required)
        ? schema.required.filter((entry: unknown): entry is string => typeof entry === "string")
        : [];

    const normalizedToCanonical = new Map<string, string>();
    const propertySchemas = new Map<string, any>();

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
        const unsupportedReason = unsupportedSchemaReason(propertySchema);
        if (unsupportedReason) {
            throw new CliError(
                "E_SCHEMA_UNSUPPORTED",
                `${toolName}.${propertyName} uses unsupported schema (${unsupportedReason}). Use --args-json/--args-file.`,
                2
            );
        }
        const normalized = normalizeFlagToken(`--${propertyName}`);
        normalizedToCanonical.set(normalized, propertyName);
        propertySchemas.set(propertyName, propertySchema);
    }

    const parsed: Record<string, unknown> = {};

    for (let i = 0; i < wrapperArgs.length; i += 1) {
        const token = wrapperArgs[i];
        if (!token.startsWith("--")) {
            throw new CliError("E_USAGE", `Unexpected positional argument '${token}'.`, 2);
        }

        const normalizedFlag = normalizeFlagToken(token);
        const isJsonFlag = normalizedFlag.endsWith("_json");
        const baseNormalized = isJsonFlag ? normalizedFlag.slice(0, -5) : normalizedFlag;
        const canonicalName = normalizedToCanonical.get(baseNormalized);
        if (!canonicalName) {
            throw new CliError("E_USAGE", `Unknown flag '${token}' for tool '${toolName}'.`, 2);
        }

        const propertySchema = propertySchemas.get(canonicalName) as any;
        if (isJsonFlag) {
            const next = wrapperArgs[i + 1];
            if (!next) {
                throw new CliError("E_USAGE", `Missing JSON value for ${token}.`, 2);
            }
            parsed[canonicalName] = parseJsonObject(next, token);
            i += 1;
            continue;
        }

        if (propertySchema?.type === "object") {
            throw new CliError("E_USAGE", `Flag '${token}' requires JSON input. Use --${stripFlagPrefix(token)}-json '<json>'.`, 2);
        }

        if (propertySchema?.type === "array") {
            const next = wrapperArgs[i + 1];
            if (!next || next.startsWith("--")) {
                throw new CliError("E_USAGE", `Missing value for ${token}.`, 2);
            }
            const itemSchema = propertySchema.items;
            const parsedValue = parsePrimitive(itemSchema, next);
            const existing = parsed[canonicalName];
            if (!Array.isArray(existing)) {
                parsed[canonicalName] = [parsedValue];
            } else {
                existing.push(parsedValue);
            }
            i += 1;
            continue;
        }

        if (propertySchema?.type === "boolean") {
            const next = wrapperArgs[i + 1];
            if (!next || next.startsWith("--")) {
                parsed[canonicalName] = true;
            } else {
                parsed[canonicalName] = parseBooleanValue(next);
                i += 1;
            }
            continue;
        }

        const next = wrapperArgs[i + 1];
        if (!next || next.startsWith("--")) {
            throw new CliError("E_USAGE", `Missing value for ${token}.`, 2);
        }
        parsed[canonicalName] = parsePrimitive(propertySchema, next);
        i += 1;
    }

    for (const requiredProp of requiredProps) {
        if (!(requiredProp in parsed)) {
            throw new CliError("E_USAGE", `Missing required flag for '${toolName}': --${requiredProp}.`, 2);
        }
    }

    return parsed;
}
