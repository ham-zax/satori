import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { manageIndexTool } from "./manage_index.js";
import { searchCodebaseTool } from "./search_codebase.js";
import { callGraphTool } from "./call_graph.js";
import { fileOutlineTool } from "./file_outline.js";
import { readFileTool } from "./read_file.js";
import { listCodebasesTool } from "./list_codebases.js";
import { McpTool, ToolContext } from "./types.js";

type JsonSchemaObject = Record<string, unknown> & {
    $schema?: unknown;
    definitions?: unknown;
};

export const toolList: McpTool[] = [
    manageIndexTool,
    searchCodebaseTool,
    callGraphTool,
    fileOutlineTool,
    readFileTool,
    listCodebasesTool,
];

export const toolRegistry: Record<string, McpTool> = Object.fromEntries(
    toolList.map((tool) => [tool.name, tool])
);

function toJsonSchema(schema: z.ZodTypeAny): JsonSchemaObject {
    const jsonSchema = zodToJsonSchema(schema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
    }) as JsonSchemaObject;

    // MCP doesn't need draft metadata in the tool schema payload.
    delete jsonSchema.$schema;
    delete jsonSchema.definitions;
    return jsonSchema;
}

export function getMcpToolList(ctx: ToolContext): Array<{ name: string; description: string; inputSchema: JsonSchemaObject }> {
    return toolList.map((tool) => ({
        name: tool.name,
        description: tool.description(ctx),
        inputSchema: toJsonSchema(tool.inputSchemaZod(ctx)),
    }));
}
