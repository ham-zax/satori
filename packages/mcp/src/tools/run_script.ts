import { z } from "zod";
import { SCRIPT_TOOL_GUIDE } from "../codemode/tool-guide.js";
import { formatZodError, type McpTool } from "./types.js";

export const SCRIPT_SOURCE_MAX_BYTES = 64 * 1024;

const inputSchema = z.strictObject({
    code: z.string().min(1).max(SCRIPT_SOURCE_MAX_BYTES)
        .refine((code) => Buffer.byteLength(code, "utf8") <= SCRIPT_SOURCE_MAX_BYTES, {
            message: "Script source exceeds 64 KiB.",
        })
        .describe("JavaScript in an async function body. Use return or text() for selected output."),
});

const specialistCalls = Array.from(SCRIPT_TOOL_GUIDE, ([name, usage]) => `tools.${name}${usage}.`).join(" ");
const description = "Chain tool calls in bounded JavaScript. Use return or text() for output. ALL_TOOLS lists available tools. Use manage_index only with action='status' here. Call configured MCP tools as tools['server__tool'].";

export const runScriptTool: McpTool = {
    name: "run_script",
    description: (ctx) => ctx.codeMode?.compact
        ? `${description} Example code is 'return await tools.list_codebases({});'. ${specialistCalls} Supply absolute paths.`
        : description,
    inputSchemaZod: () => inputSchema,
    async execute(args, ctx) {
        const parsed = inputSchema.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{ type: "text", text: formatZodError("run_script", parsed.error) }],
                isError: true,
            };
        }
        if (!ctx.callSessionTool || ctx.codeMode?.enabled === false) {
            return { content: [{ type: "text", text: "run_script is unavailable." }], isError: true };
        }
        const { runScript } = await import("../codemode/runner.js");
        return runScript({
            code: parsed.data.code,
            callSessionTool: ctx.callSessionTool,
            configPath: ctx.codeMode?.configPath,
            signal: ctx.requestSignal,
        });
    },
};
