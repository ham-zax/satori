import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	keyHint,
	truncateHead,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	classifyRetryEligibility,
	isCallToolPayload,
	isToolsListPayload,
	resolveGuardMode,
	resolveGuardRecoveryMode,
	type GuardMode,
	type GuardRecoveryMode,
	type CliCommandType,
} from "./recovery.js";

const DEFAULT_NPM_PACKAGE = "@zokizuan/satori-mcp@latest";
const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_CALL_TIMEOUT_MS = 600_000;
const HEALTHCHECK_TIMEOUT_MS = 15_000;

const COLLAPSED_PREVIEW_LINES = 14;
const EXPANDED_PREVIEW_LINES = 200;

type PiToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

interface BridgeConfigFile {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	envFile?: string;
	localPath?: string;
	cliPath?: string;
	forceNpx?: boolean;
	npmPackage?: string;
	startupTimeoutMs?: number;
	callTimeoutMs?: number;
	debug?: boolean;
	guardRecovery?: GuardRecoveryMode;
}

interface LoadedBridgeConfig {
	data: BridgeConfigFile;
	sourcePath: string;
	sourceDir: string;
}

interface CliInvocationConfig {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	label: string;
	startupTimeoutMs: number;
	callTimeoutMs: number;
	debug: boolean;
	guardMode: GuardMode;
	guardRecovery: GuardRecoveryMode;
}

interface CliExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface CliToolCallResult {
	isError?: boolean;
	content?: unknown;
	_meta?: unknown;
	[key: string]: unknown;
}

interface CliRecoveryMetadata {
	attemptCount: number;
	guardRecoveryAttempted: boolean;
	guardRecoverySucceeded: boolean;
	effectiveGuardMode: GuardMode;
}

interface CliToolCallExecution {
	result: CliToolCallResult;
	cli: CliExecResult;
	recovery: CliRecoveryMetadata;
}

interface CliToolsListExecution {
	tools: Array<{ name: string }>;
	cli: CliExecResult;
	recovery: CliRecoveryMetadata;
}

interface CliAttemptResult {
	cli?: CliExecResult;
	parsed?: unknown;
	parseError?: Error;
	executionError?: Error;
	guardMode: GuardMode;
}

interface CliExecutionRequest {
	commandType: CliCommandType;
	toolName?: string;
	commandArgs: string[];
}

let stickyGuardModeOff = false;

interface McpToolSpec {
	name: string;
	description: string;
	parameters: ReturnType<typeof Type.Object>;
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") {
			clean[key] = value;
		}
	}
	return clean;
}

function parseArgsJson(value: string | undefined): string[] | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
		throw new Error("SATORI_CLI_ARGS_JSON must be a JSON string array.");
	}
	return parsed;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

function resolvePath(rawPath: string, baseDir: string): string {
	return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

function deriveCliPathFromLegacyServerPath(maybeServerEntry: string): string | null {
	const normalized = maybeServerEntry.replace(/\\/g, "/");
	if (!normalized.endsWith("/dist/index.js")) {
		return null;
	}
	return path.resolve(maybeServerEntry, "..", "cli", "index.js");
}

function loadBridgeConfig(cwd: string): LoadedBridgeConfig | undefined {
	const explicitPath = process.env.SATORI_CLI_CONFIG?.trim();
	const candidatePaths = [
		explicitPath,
		path.join(getAgentDir(), "extensions", "satori-bridge", "config.json"),
		path.join(cwd, ".pi", "satori-bridge.json"),
	].filter((entry): entry is string => Boolean(entry));

	for (const candidatePath of candidatePaths) {
		if (!fs.existsSync(candidatePath)) {
			continue;
		}
		const raw = fs.readFileSync(candidatePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") {
			throw new Error(`Invalid bridge config at ${candidatePath}: expected a JSON object.`);
		}
		return {
			data: parsed as BridgeConfigFile,
			sourcePath: candidatePath,
			sourceDir: path.dirname(candidatePath),
		};
	}

	return undefined;
}

function parseEnvFile(filePath: string): Record<string, string> {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Bridge envFile not found: ${filePath}`);
	}
	const values: Record<string, string> = {};
	const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const separator = trimmed.indexOf("=");
		if (separator <= 0) {
			continue;
		}
		const key = trimmed.slice(0, separator).trim();
		let value = trimmed.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key) {
			values[key] = value;
		}
	}
	return values;
}

function resolveCliInvocationConfig(cwd: string): CliInvocationConfig {
	const config = loadBridgeConfig(cwd);
	const fileConfig = config?.data;

	const envFromProcess = sanitizeEnv(process.env);
	const envFilePathRaw = fileConfig?.envFile;
	const envFromFile = envFilePathRaw ? parseEnvFile(resolvePath(envFilePathRaw, config?.sourceDir ?? cwd)) : {};
	const env = {
		...envFromProcess,
		...envFromFile,
		...(fileConfig?.env ?? {}),
	};

	const startupTimeoutMs = parsePositiveInt(
		env.SATORI_CLI_STARTUP_TIMEOUT_MS,
		fileConfig?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
	);
	const callTimeoutMs = parsePositiveInt(
		env.SATORI_CLI_CALL_TIMEOUT_MS,
		fileConfig?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
	);
	const debug = parseBool(env.SATORI_CLI_DEBUG, fileConfig?.debug === true);
	const guardMode = resolveGuardMode(env.SATORI_CLI_STDOUT_GUARD);
	const guardRecovery = resolveGuardRecoveryMode(env.SATORI_CLI_GUARD_RECOVERY ?? fileConfig?.guardRecovery);

	const command = env.SATORI_CLI_COMMAND?.trim() || fileConfig?.command?.trim();
	const customArgs = parseArgsJson(env.SATORI_CLI_ARGS_JSON) ?? fileConfig?.args;
	const targetCwd = env.SATORI_CLI_CWD?.trim() || fileConfig?.cwd?.trim() || cwd;

	if (command) {
		return {
			command,
			args: customArgs ?? [],
			cwd: targetCwd,
			env,
			label: config ? `custom:${command} (${config.sourcePath})` : `custom:${command}`,
			startupTimeoutMs,
			callTimeoutMs,
			debug,
			guardMode,
			guardRecovery,
		};
	}

	const forceNpx =
		parseBool(env.SATORI_CLI_FORCE_NPX, false) ||
		fileConfig?.forceNpx === true;

	const localPathRaw =
		env.SATORI_CLI_LOCAL_PATH?.trim() ||
		fileConfig?.cliPath?.trim() ||
		fileConfig?.localPath?.trim() ||
		"packages/mcp/dist/cli/index.js";

	const localPath = resolvePath(localPathRaw, targetCwd);
	const legacyDerivedCliPath = deriveCliPathFromLegacyServerPath(localPath);
	const localCandidates = [legacyDerivedCliPath, localPath].filter((entry): entry is string => Boolean(entry));
	const localCliPath = localCandidates.find((entry) => fs.existsSync(entry));

	if (!forceNpx && localCliPath) {
		return {
			command: process.execPath,
			args: [localCliPath],
			cwd: targetCwd,
			env,
			label: config ? `local-cli:${localCliPath} (${config.sourcePath})` : `local-cli:${localCliPath}`,
			startupTimeoutMs,
			callTimeoutMs,
			debug,
			guardMode,
			guardRecovery,
		};
	}

	const npmPackage = env.SATORI_CLI_NPM_PACKAGE?.trim() || fileConfig?.npmPackage?.trim() || DEFAULT_NPM_PACKAGE;
	return {
		command: "npx",
		args: ["-y", "--package", npmPackage, "satori-cli"],
		cwd: targetCwd,
		env,
		label: config ? `npm:${npmPackage} (${config.sourcePath})` : `npm:${npmPackage}`,
		startupTimeoutMs,
		callTimeoutMs,
		debug,
		guardMode,
		guardRecovery,
	};
}

function runCliCommand(
	invocationConfig: CliInvocationConfig,
	commandArgs: string[],
	signal?: AbortSignal,
): Promise<CliExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			invocationConfig.command,
			[
				...invocationConfig.args,
				"--format",
				"json",
				"--startup-timeout-ms",
				String(invocationConfig.startupTimeoutMs),
				"--call-timeout-ms",
				String(invocationConfig.callTimeoutMs),
				...(invocationConfig.debug ? ["--debug"] : []),
				...commandArgs,
			],
			{
				cwd: invocationConfig.cwd,
				env: invocationConfig.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (error: Error | null, result?: CliExecResult) => {
			if (settled) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (error) {
				reject(error);
				return;
			}
			resolve(result as CliExecResult);
		};

		const onAbort = () => {
			child.kill("SIGTERM");
			finish(new Error("Operation aborted."));
		};

		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			finish(error);
		});
		child.on("close", (code) => {
			finish(null, {
				exitCode: code ?? -1,
				stdout,
				stderr,
			});
		});
	});
}

function withGuardMode(invocationConfig: CliInvocationConfig, guardMode: GuardMode): CliInvocationConfig {
	return {
		...invocationConfig,
		guardMode,
		env: {
			...invocationConfig.env,
			SATORI_CLI_STDOUT_GUARD: guardMode,
		},
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.message === "Operation aborted.";
}

async function runCliAttempt(
	invocationConfig: CliInvocationConfig,
	request: CliExecutionRequest,
	signal?: AbortSignal,
): Promise<CliAttemptResult> {
	try {
		const cli = await runCliCommand(invocationConfig, request.commandArgs, signal);
		try {
			const parsed = parseCliJson(cli.stdout, cli.stderr);
			return {
				cli,
				parsed,
				guardMode: invocationConfig.guardMode,
			};
		} catch (parseError) {
			return {
				cli,
				parseError: parseError instanceof Error ? parseError : new Error(String(parseError)),
				guardMode: invocationConfig.guardMode,
			};
		}
	} catch (executionError) {
		if (isAbortError(executionError)) {
			throw executionError;
		}
		return {
			executionError: executionError instanceof Error ? executionError : new Error(String(executionError)),
			guardMode: invocationConfig.guardMode,
		};
	}
}

function buildAttemptFailureMessage(
	request: CliExecutionRequest,
	attempt: CliAttemptResult,
	attemptIndex: number,
	invocationConfig: CliInvocationConfig,
): string {
	const kindPart = request.commandType === "tool-call" && request.toolName
		? `${request.commandType}:${request.toolName}`
		: request.commandType;
	const parts = [
		`attempt=${attemptIndex}`,
		`guardMode=${attempt.guardMode}`,
		`transport=${invocationConfig.label}`,
		`request=${kindPart}`,
	];
	if (attempt.cli) {
		parts.push(`exitCode=${attempt.cli.exitCode}`);
	}
	if (attempt.executionError) {
		parts.push(`executionError=${attempt.executionError.message}`);
	}
	if (attempt.parseError) {
		parts.push(`parseError=${attempt.parseError.message}`);
	}
	if (attempt.cli?.stderr?.trim()) {
		parts.push(`stderr=${attempt.cli.stderr.trim()}`);
	}
	return parts.join(" | ");
}

function validateParsedPayload(request: CliExecutionRequest, parsed: unknown): Error | null {
	if (request.commandType === "tools-list") {
		if (!isToolsListPayload(parsed)) {
			return new Error("satori-cli tools/list payload missing tools array.");
		}
		return null;
	}
	if (!isCallToolPayload(parsed)) {
		return new Error(`satori-cli returned an unexpected payload for ${request.toolName || "tool call"}.`);
	}
	return null;
}

function shouldRetryAttempt(
	invocationConfig: CliInvocationConfig,
	request: CliExecutionRequest,
	attempt: CliAttemptResult,
): boolean {
	if (invocationConfig.guardRecovery !== "auto") {
		return false;
	}

	if (attempt.guardMode === "off") {
		return false;
	}

	const parsedPayload = attempt.parsed;
	const classification = classifyRetryEligibility({
		commandType: request.commandType,
		toolName: request.toolName,
		exitCode: attempt.cli?.exitCode,
		stderr: attempt.cli?.stderr,
		parseErrorText: attempt.parseError?.message,
		executionErrorText: attempt.executionError?.message,
		parsedPayload,
	});
	return classification.retryable;
}

async function executeCliWithRecovery(
	invocationConfig: CliInvocationConfig,
	request: CliExecutionRequest,
	signal?: AbortSignal,
): Promise<{ parsed: unknown; cli: CliExecResult; recovery: CliRecoveryMetadata }> {
	const firstGuardMode = stickyGuardModeOff ? "off" : invocationConfig.guardMode;
	const firstAttemptConfig = withGuardMode(invocationConfig, firstGuardMode);
	const firstAttempt = await runCliAttempt(firstAttemptConfig, request, signal);

	if (firstAttempt.parsed !== undefined && firstAttempt.cli) {
		const validationError = validateParsedPayload(request, firstAttempt.parsed);
		const toolsListExitOk = request.commandType !== "tools-list" || firstAttempt.cli.exitCode === 0;
		if (!validationError && toolsListExitOk) {
			return {
				parsed: firstAttempt.parsed,
				cli: firstAttempt.cli,
				recovery: {
					attemptCount: 1,
					guardRecoveryAttempted: false,
					guardRecoverySucceeded: false,
					effectiveGuardMode: firstAttempt.guardMode,
				},
			};
		}
	}

	const firstError = new Error(buildAttemptFailureMessage(request, firstAttempt, 1, firstAttemptConfig));
	if (!shouldRetryAttempt(firstAttemptConfig, request, firstAttempt)) {
		throw firstError;
	}

	const secondAttemptConfig = withGuardMode(invocationConfig, "off");
	const secondAttempt = await runCliAttempt(secondAttemptConfig, request, signal);

	if (secondAttempt.parsed !== undefined && secondAttempt.cli) {
		const validationError = validateParsedPayload(request, secondAttempt.parsed);
		const toolsListExitOk = request.commandType !== "tools-list" || secondAttempt.cli.exitCode === 0;
		if (!validationError && toolsListExitOk) {
			stickyGuardModeOff = true;
			return {
				parsed: secondAttempt.parsed,
				cli: secondAttempt.cli,
				recovery: {
					attemptCount: 2,
					guardRecoveryAttempted: true,
					guardRecoverySucceeded: true,
					effectiveGuardMode: "off",
				},
			};
		}
	}

	const secondError = new Error(buildAttemptFailureMessage(request, secondAttempt, 2, secondAttemptConfig));
	throw new Error(`${firstError.message}; retry_failed: ${secondError.message}`);
}

function parseCliJson(stdout: string, stderr: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error(`satori-cli returned empty stdout. stderr:\n${stderr.trim() || "(empty)"}`);
	}
	try {
		return JSON.parse(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse satori-cli JSON output: ${message}\nstdout:\n${trimmed}\nstderr:\n${stderr.trim() || "(empty)"}`);
	}
}

function extractError(content: unknown): string {
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === "object") {
				const record = block as Record<string, unknown>;
				if (record.type === "text" && typeof record.text === "string" && record.text.trim()) {
					return record.text.trim();
				}
			}
		}
	}
	return "MCP tool call failed without a text error payload.";
}

function truncateText(text: string): string {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return text;
	}
	return `${truncation.content}\n\n[Bridge truncated output to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB.]`;
}

function normalizeContent(content: unknown): PiToolContent[] {
	if (!Array.isArray(content) || content.length === 0) {
		return [{ type: "text", text: "(no content returned by MCP tool)" }];
	}
	const blocks: PiToolContent[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const record = block as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") {
				blocks.push({ type: "text", text: truncateText(record.text) });
				continue;
			}
			if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
				blocks.push({ type: "image", data: record.data, mimeType: record.mimeType });
				continue;
			}
		}
		blocks.push({
			type: "text",
			text: truncateText(`[Unsupported MCP content block converted to text]\n${JSON.stringify(block, null, 2)}`),
		});
	}
	return blocks.length > 0 ? blocks : [{ type: "text", text: "(empty MCP response)" }];
}

function getTextBlocks(content: unknown): string[] {
	if (!Array.isArray(content)) {
		return [];
	}
	const blocks: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			blocks.push(record.text);
		}
	}
	return blocks;
}

function countImageBlocks(content: unknown): number {
	if (!Array.isArray(content)) {
		return 0;
	}
	let count = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") {
			continue;
		}
		if ((block as Record<string, unknown>).type === "image") {
			count += 1;
		}
	}
	return count;
}

function renderMcpResult(result: { content: unknown }, expanded: boolean, isPartial: boolean, toolName: string, theme: any) {
	if (isPartial) {
		return new Text(theme.fg("warning", `Calling ${toolName}...`), 0, 0);
	}

	const textBlocks = getTextBlocks(result.content);
	const imageBlocks = countImageBlocks(result.content);

	if (textBlocks.length === 0) {
		if (imageBlocks > 0) {
			return new Text(theme.fg("success", `${toolName}: ${imageBlocks} image block(s)`), 0, 0);
		}
		return new Text(theme.fg("muted", `${toolName}: (no textual output)`), 0, 0);
	}

	const merged = textBlocks.join("\n\n");
	const lines = merged.split("\n");
	const maxLines = expanded ? EXPANDED_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES;
	const shown = lines.slice(0, maxLines);

	let output = theme.fg("success", `${toolName}: ${lines.length} line(s)`);
	if (imageBlocks > 0) {
		output += theme.fg("muted", ` | ${imageBlocks} image block(s)`);
	}

	for (const line of shown) {
		output += `\n${theme.fg("toolOutput", line)}`;
	}

	if (lines.length > maxLines) {
		output += `\n${theme.fg("muted", `... ${lines.length - maxLines} more lines`)}`;
	}

	if (!expanded && lines.length > COLLAPSED_PREVIEW_LINES) {
		output += `\n${theme.fg("muted", "(")}${keyHint("expandTools", "to expand")}${theme.fg("muted", ")")}`;
	}

	if (expanded && lines.length > EXPANDED_PREVIEW_LINES) {
		output += `\n${theme.fg("dim", "Use read_file with line ranges for precise deep reads.")}`;
	}

	return new Text(output, 0, 0);
}

async function callToolThroughCli(
	invocationConfig: CliInvocationConfig,
	toolName: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<CliToolCallExecution> {
	const execution = await executeCliWithRecovery(
		invocationConfig,
		{
			commandType: "tool-call",
			toolName,
			commandArgs: ["tool", "call", toolName, "--args-json", JSON.stringify(params)],
		},
		signal,
	);
	const result = execution.parsed as CliToolCallResult;
	if (result.isError) {
		throw new Error(extractError(result.content));
	}
	return {
		result,
		cli: execution.cli,
		recovery: execution.recovery,
	};
}

async function listToolsThroughCli(
	invocationConfig: CliInvocationConfig,
	signal?: AbortSignal,
): Promise<CliToolsListExecution> {
	const execution = await executeCliWithRecovery(
		invocationConfig,
		{
			commandType: "tools-list",
			commandArgs: ["tools", "list"],
		},
		signal,
	);
	const payload = execution.parsed as { tools: Array<{ name: string }> };
	return {
		tools: payload.tools,
		cli: execution.cli,
		recovery: execution.recovery,
	};
}

const MANAGE_INDEX_SCHEMA = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("reindex"),
		Type.Literal("sync"),
		Type.Literal("status"),
		Type.Literal("clear"),
	]),
	path: Type.String({ description: "ABSOLUTE path to the target codebase." }),
	force: Type.Optional(Type.Boolean({ description: "Only for create. Force rebuild from scratch." })),
	customExtensions: Type.Optional(Type.Array(Type.String(), { description: "Only for create. Extra file extensions." })),
	ignorePatterns: Type.Optional(Type.Array(Type.String(), { description: "Only for create. Extra ignore patterns." })),
	zillizDropCollection: Type.Optional(
		Type.String({ description: "Only for create. Zilliz-only collection drop target." }),
	),
});

const SEARCH_CODEBASE_SCHEMA = Type.Object({
	path: Type.String({ description: "ABSOLUTE path to an indexed codebase or subdirectory." }),
	query: Type.String({ description: "Natural-language query." }),
	scope: Type.Optional(
		Type.Union([Type.Literal("runtime"), Type.Literal("mixed"), Type.Literal("docs")], {
			description: "Search scope policy.",
		}),
	),
	resultMode: Type.Optional(
		Type.Union([Type.Literal("grouped"), Type.Literal("raw")], {
			description: "Output mode.",
		}),
	),
	groupBy: Type.Optional(
		Type.Union([Type.Literal("symbol"), Type.Literal("file")], {
			description: "Grouping strategy in grouped mode.",
		}),
	),
	rankingMode: Type.Optional(
		Type.Union([Type.Literal("default"), Type.Literal("auto_changed_first")], {
			description: "Ranking policy.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum groups/chunks to return." })),
	debug: Type.Optional(Type.Boolean({ description: "Include search debug payload." })),
});

const CALL_GRAPH_SCHEMA = Type.Object({
	path: Type.String({ description: "ABSOLUTE path to indexed root or subdirectory." }),
	symbolRef: Type.Object({}, { additionalProperties: true, description: "Symbol reference from search callGraphHint." }),
	direction: Type.Optional(
		Type.Union([Type.Literal("callers"), Type.Literal("callees"), Type.Literal("both")], {
			description: "Traversal direction.",
		}),
	),
	depth: Type.Optional(Type.Number({ description: "Traversal depth (max 3)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of returned edges." })),
});

const FILE_OUTLINE_SCHEMA = Type.Object({
	path: Type.String({ description: "ABSOLUTE path to indexed codebase root." }),
	file: Type.String({ description: "Relative file path inside codebase root." }),
	start_line: Type.Optional(Type.Number({ description: "Optional start line (1-based, inclusive)." })),
	end_line: Type.Optional(Type.Number({ description: "Optional end line (1-based, inclusive)." })),
	limitSymbols: Type.Optional(Type.Number({ description: "Max symbols after filtering." })),
	resolveMode: Type.Optional(
		Type.Union([Type.Literal("outline"), Type.Literal("exact")], {
			description: "Outline or deterministic exact resolution.",
		}),
	),
	symbolIdExact: Type.Optional(Type.String({ description: "Used when resolveMode=exact." })),
	symbolLabelExact: Type.Optional(Type.String({ description: "Used when resolveMode=exact." })),
});

const READ_FILE_SCHEMA = Type.Object({
	path: Type.String({ description: "ABSOLUTE path to file." }),
	start_line: Type.Optional(Type.Number({ description: "Optional start line (1-based, inclusive)." })),
	end_line: Type.Optional(Type.Number({ description: "Optional end line (1-based, inclusive)." })),
	mode: Type.Optional(
		Type.Union([Type.Literal("plain"), Type.Literal("annotated")], {
			description: "Read mode.",
		}),
	),
	open_symbol: Type.Optional(
		Type.Object(
			{
				symbolId: Type.Optional(Type.String()),
				symbolLabel: Type.Optional(Type.String()),
				start_line: Type.Optional(Type.Number()),
				end_line: Type.Optional(Type.Number()),
			},
			{ additionalProperties: false },
		),
	),
});

const TOOL_SPECS: McpToolSpec[] = [
	{
		name: "list_codebases",
		description: "List tracked codebases and their indexing state.",
		parameters: Type.Object({}),
	},
	{
		name: "manage_index",
		description: "Manage Satori index lifecycle operations (create/reindex/sync/status/clear).",
		parameters: MANAGE_INDEX_SCHEMA,
	},
	{
		name: "search_codebase",
		description: "Semantic code search with deterministic grouping/ranking and freshness gates.",
		parameters: SEARCH_CODEBASE_SCHEMA,
	},
	{
		name: "call_graph",
		description: "Traverse callers/callees/bidirectional symbol relationships.",
		parameters: CALL_GRAPH_SCHEMA,
	},
	{
		name: "file_outline",
		description: "Return sidecar-backed file symbol outline with deterministic exact resolve mode.",
		parameters: FILE_OUTLINE_SCHEMA,
	},
	{
		name: "read_file",
		description: "Read file content with line ranges and optional symbol-open semantics.",
		parameters: READ_FILE_SCHEMA,
	},
];

export default function satoriBridgeExtension(pi: ExtensionAPI) {
	for (const spec of TOOL_SPECS) {
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: spec.description,
			parameters: spec.parameters,
			renderCall(args, theme) {
				const primaryArg = typeof args.path === "string" ? ` ${args.path}` : "";
				const text = `${theme.fg("toolTitle", "Satori CLI:")} ${theme.fg("muted", spec.name)}${theme.fg("accent", primaryArg)}`;
				return new Text(text, 0, 0);
			},
				async execute(_toolCallId, params, signal, onUpdate, ctx) {
					onUpdate?.({
						content: [{ type: "text", text: `Calling ${spec.name} via satori-cli...` }],
						details: { stage: "proxy-call" },
					});

					const invocationConfig = resolveCliInvocationConfig(ctx.cwd);
					const { result, cli, recovery } = await callToolThroughCli(
						invocationConfig,
						spec.name,
						params as Record<string, unknown>,
						signal,
					);
					return {
						content: normalizeContent(result.content),
						details: {
							tool: spec.name,
							transport: invocationConfig.label,
							exitCode: cli.exitCode,
							stderr: cli.stderr.trim() || undefined,
							meta: result._meta,
							attemptCount: recovery.attemptCount,
							guardRecoveryAttempted: recovery.guardRecoveryAttempted,
							guardRecoverySucceeded: recovery.guardRecoverySucceeded,
							effectiveGuardMode: recovery.effectiveGuardMode,
						},
					};
				},
			renderResult(result, { expanded, isPartial }, theme) {
				return renderMcpResult(result, expanded, isPartial, spec.name, theme);
			},
		});
	}

	pi.registerCommand("satori-mcp", {
		description: "Check Satori CLI bridge connectivity",
		handler: async (_args, ctx) => {
			const invocationConfig = resolveCliInvocationConfig(ctx.cwd);
			const healthCliConfig: CliInvocationConfig = {
				...invocationConfig,
				startupTimeoutMs: Math.min(invocationConfig.startupTimeoutMs, HEALTHCHECK_TIMEOUT_MS),
				callTimeoutMs: Math.min(invocationConfig.callTimeoutMs, HEALTHCHECK_TIMEOUT_MS),
			};

				const runHealthCheck = async () => {
					try {
						const toolsExecution = await listToolsThroughCli(healthCliConfig);
						const recoverySuffix = toolsExecution.recovery.guardRecoverySucceeded
							? " (guard recovery applied: off)"
							: toolsExecution.recovery.effectiveGuardMode === "off"
								? " (guard mode: off)"
								: "";
						const message = `Satori CLI connected (${invocationConfig.label}) - ${toolsExecution.tools.length} tools reflected${recoverySuffix}`;
						if (ctx.hasUI) {
							ctx.ui.notify(message, "info");
						} else {
							process.stdout.write(`${message}\n`);
						}
					} catch (error) {
						const failureMessage = error instanceof Error ? error.message : String(error);
						if (ctx.hasUI) {
							ctx.ui.notify(`Satori CLI connection failed: ${failureMessage}`, "error");
							return;
						}
						throw new Error(`Satori CLI connection failed: ${failureMessage}`);
					}
				};

			if (!ctx.hasUI) {
				await runHealthCheck();
				return;
			}

			ctx.ui.setStatus("satori-bridge", "Checking Satori CLI...");
			void runHealthCheck().finally(() => {
				ctx.ui.setStatus("satori-bridge", undefined);
			});
		},
	});

}
