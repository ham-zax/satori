import { z } from 'zod';
import { McpTool, ToolContext, formatZodError } from './types.js';

const symbolRefSchema = z.object({
    file: z.string().min(1).describe('Relative file path from the codebase root.'),
    symbolId: z.string().min(1).describe('Stable symbol identifier from search_codebase.callGraphHint.'),
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
    description: () => 'Traverse the prebuilt TS/Python call graph sidecar for callers/callees/bidirectional symbol relationships.',
    inputSchemaZod: () => callGraphInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const parsed = callGraphInputSchema.safeParse(args || {});
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text',
                    text: formatZodError('call_graph', parsed.error)
                }],
                isError: true
            };
        }

        return ctx.toolHandlers.handleCallGraph(parsed.data);
    }
};
