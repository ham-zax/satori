import type { ListToolsResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CapabilityResolver, type CapabilityMatrix } from "../core/capabilities.js";
import { architectureOverviewTool } from "./architecture_overview.js";
import { manageIndexTool } from "./manage_index.js";
import { searchCodebaseTool } from "./search_codebase.js";
import { continueSearchTool } from "./continue_search.js";
import { callGraphTool } from "./call_graph.js";
import { tracePathTool } from "./trace_path.js";
import { detectChangesTool } from "./detect_changes.js";
import { fileOutlineTool } from "./file_outline.js";
import { findReferencesTool } from "./find_references.js";
import { readFileTool } from "./read_file.js";
import { listCodebasesTool } from "./list_codebases.js";
import { McpTool, ToolContext } from "./types.js";

type ToolInputSchema = ListToolsResult["tools"][number]["inputSchema"];
export type McpToolAdvertisement = Readonly<{
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
}>;

const cachedToolListByMatrix = new WeakMap<Readonly<CapabilityMatrix>, readonly McpToolAdvertisement[]>();

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child);
        }
    }
    return value;
}

function resolveCapabilityCacheWitness(ctx: ToolContext): Readonly<CapabilityMatrix> | undefined {
    const capabilities = ctx.capabilities;
    if (!capabilities || Object.getPrototypeOf(capabilities) !== CapabilityResolver.prototype) {
        return undefined;
    }
    const witness = capabilities.getMatrixWitness();
    return Object.isFrozen(witness) ? witness : undefined;
}

export const toolList: McpTool[] = [
    manageIndexTool,
    searchCodebaseTool,
    architectureOverviewTool,
    continueSearchTool,
    callGraphTool,
    tracePathTool,
    findReferencesTool,
    detectChangesTool,
    fileOutlineTool,
    readFileTool,
    listCodebasesTool,
];

export const toolRegistry: Record<string, McpTool> = Object.fromEntries(
    toolList.map((tool) => [tool.name, tool])
);

function toJsonSchema(schema: z.ZodType): ToolInputSchema {
    const jsonSchema = z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        io: 'input',
        reused: 'inline',
    }) as Record<string, unknown>;

    // MCP 2025-11-25 defaults to JSON Schema 2020-12, so omit redundant $schema metadata.
    delete jsonSchema.$schema;
    if (jsonSchema.type !== 'object') {
        throw new Error(`MCP tool inputSchema root must have type "object", got ${String(jsonSchema.type)}`);
    }
    return jsonSchema as ToolInputSchema;
}

export function buildMcpToolList(ctx: ToolContext): Array<{ name: string; description: string; inputSchema: ToolInputSchema }> {
    return toolList.map((tool) => ({
        name: tool.name,
        description: tool.description(ctx),
        inputSchema: toJsonSchema(tool.inputSchemaZod(ctx)),
    }));
}

export function getMcpToolList(ctx: ToolContext): Array<{ name: string; description: string; inputSchema: ToolInputSchema }> {
    const witness = resolveCapabilityCacheWitness(ctx);
    if (!witness) {
        return buildMcpToolList(ctx);
    }
    let cached = cachedToolListByMatrix.get(witness);
    if (!cached) {
        cached = deepFreeze(buildMcpToolList(ctx));
        cachedToolListByMatrix.set(witness, cached);
    }
    return [...cached];
}
