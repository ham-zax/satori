import { z } from 'zod';
import { McpTool, ToolContext, formatZodError } from './types.js';
import { resolveVectorBackedToolContext } from './provider-context.js';

const symbolRefSchema = z.object({
    file: z.string().min(1).describe('Relative file path from the codebase root.'),
    symbolId: z.string().min(1).describe('Symbol identifier from search_codebase.callGraphHint. On symbol-owned flows, this should carry the symbolInstanceId.'),
    symbolLabel: z.string().optional().describe('Optional symbol display label.'),
    span: z.object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
    }).optional().describe('Optional symbol span in the file.'),
});

const callGraphInputSchema = z.object({
    path: z.string().min(1).describe('ABSOLUTE path to the indexed codebase root (or subdirectory).'),
    symbolRef: symbolRefSchema.describe('Symbol reference from a grouped search result callGraphHint.'),
    direction: z.enum(['callers', 'callees', 'both']).default('both').optional().describe('Traversal direction from the starting symbol.'),
    depth: z.number().int().min(1).max(3).default(1).optional().describe('Traversal depth (max 3).'),
    limit: z.number().int().positive().default(20).optional().describe('Maximum number of returned edges.'),
});

export const callGraphTool: McpTool = {
    name: 'call_graph',
    description: () => 'Traverse registry-resolved caller/callee relationships for indexed TS/JS/Python code. On symbol-owned indexes, call_graph uses compatible relationship sidecars for conservative CALLS v0 traversal and upgrades low-confidence cross-file calls only when current IMPORTS/EXPORTS evidence deterministically supports the target symbol. In successful traversal responses, sidecar.nodeCount and sidecar.edgeCount report the counts returned in that response, not whole-sidecar totals for the indexed codebase.',
    inputSchemaZod: () => callGraphInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const normalizedArgs = (args && typeof args === 'object')
            ? { ...(args as Record<string, unknown>) }
            : (args || {});
        if (
            normalizedArgs
            && typeof normalizedArgs === 'object'
            && (normalizedArgs as Record<string, unknown>).direction === 'bidirectional'
        ) {
            (normalizedArgs as Record<string, unknown>).direction = 'both';
        }

        const parsed = callGraphInputSchema.safeParse(normalizedArgs);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text',
                    text: formatZodError('call_graph', parsed.error)
                }],
                isError: true
            };
        }

        const executionContext = await resolveVectorBackedToolContext(ctx, {
            tool: 'call_graph',
            path: parsed.data.path,
            symbolRef: parsed.data.symbolRef,
        });
        if (!executionContext.ok) {
            return executionContext.response;
        }

        return executionContext.context.toolHandlers.handleCallGraph(parsed.data);
    }
};
