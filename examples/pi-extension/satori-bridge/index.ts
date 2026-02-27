import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MCP_CALL_TIMEOUT_MS = 180_000;

type PiToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

interface TransportConfig {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	label: string;
}

interface ConnectedBridge {
	client: Client;
	label: string;
	close: () => Promise<void>;
}

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
	if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
		throw new Error("SATORI_MCP_ARGS_JSON must be a JSON string array.");
	}
	return parsed;
}

function resolveTransportConfig(cwd: string): TransportConfig {
	const env = sanitizeEnv(process.env);
	const command = env.SATORI_MCP_COMMAND?.trim();
	const args = parseArgsJson(env.SATORI_MCP_ARGS_JSON);
	const serverCwd = env.SATORI_MCP_CWD?.trim() || cwd;

	if (command) {
		return {
			command,
			args: args ?? [],
			cwd: serverCwd,
			env,
			label: `custom:${command}`,
		};
	}

	const forceNpx = env.SATORI_MCP_FORCE_NPX === "1" || env.SATORI_MCP_FORCE_NPX === "true";
	const localPath = env.SATORI_MCP_LOCAL_PATH?.trim() || path.join(cwd, "packages/mcp/dist/index.js");

	if (!forceNpx && fs.existsSync(localPath)) {
		return {
			command: process.execPath,
			args: [localPath],
			cwd: serverCwd,
			env,
			label: `local:${localPath}`,
		};
	}

	return {
		command: "npx",
		args: ["-y", "@zokizuan/satori-mcp@latest"],
		cwd: serverCwd,
		env,
		label: "npm:@zokizuan/satori-mcp@latest",
	};
}

async function connectBridge(config: TransportConfig): Promise<ConnectedBridge> {
	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		cwd: config.cwd,
		env: config.env,
	});

	const client = new Client({
		name: "pi-satori-bridge",
		version: "0.1.0",
	});

	try {
		await client.connect(transport);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to connect to Satori MCP server (${config.label}). Command: ${config.command} ${config.args.join(" ")}\n${message}`,
		);
	}

	return {
		client,
		label: config.label,
		close: () => client.close(),
	};
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
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

		const text = `[Unsupported MCP content block converted to text]\n${safeJson(block)}`;
		blocks.push({ type: "text", text: truncateText(text) });
	}

	return blocks.length > 0 ? blocks : [{ type: "text", text: "(empty MCP response)" }];
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
	let bridgePromise: Promise<ConnectedBridge> | undefined;

	const getBridge = async (ctx: ExtensionContext): Promise<ConnectedBridge> => {
		if (!bridgePromise) {
			const config = resolveTransportConfig(ctx.cwd);
			bridgePromise = connectBridge(config).catch((error) => {
				bridgePromise = undefined;
				throw error;
			});
		}
		return bridgePromise;
	};

	for (const spec of TOOL_SPECS) {
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: spec.description,
			parameters: spec.parameters,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				onUpdate?.({
					content: [{ type: "text", text: `Calling ${spec.name} via Satori MCP...` }],
					details: { stage: "proxy-call" },
				});

				const bridge = await getBridge(ctx);
				const response = await bridge.client.callTool(
					{ name: spec.name, arguments: params as Record<string, unknown> },
					undefined,
					{ signal, timeout: MCP_CALL_TIMEOUT_MS },
				);

				if (response.isError) {
					throw new Error(extractError(response.content));
				}

				return {
					content: normalizeContent(response.content),
					details: {
						bridge: bridge.label,
						tool: spec.name,
						meta: response._meta,
					},
				};
			},
		});
	}

	pi.registerCommand("satori-mcp", {
		description: "Check Satori MCP bridge connectivity",
		handler: async (_args, ctx) => {
			try {
				const bridge = await getBridge(ctx);
				ctx.ui.notify(`Satori MCP connected (${bridge.label})`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Satori MCP connection failed: ${message}`, "error");
			}
		},
	});

	pi.on("session_shutdown", async () => {
		if (!bridgePromise) {
			return;
		}
		try {
			const bridge = await bridgePromise;
			await bridge.close();
		} finally {
			bridgePromise = undefined;
		}
	});
}
