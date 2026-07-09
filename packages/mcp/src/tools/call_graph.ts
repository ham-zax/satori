import { z } from 'zod';
import { requireAbsoluteFilesystemPath } from '../utils.js';
import {
    McpTool,
    ToolContext,
    absoluteFilesystemPathSchema,
    formatZodError,
    repoRelativeFilePathSchema,
} from './types.js';
import { resolveVectorBackedToolContext } from './provider-context.js';

const symbolRefSchema = z.object({
    file: repoRelativeFilePathSchema('Repo-relative file path from the codebase root (not absolute; resolved only against that root).'),
    symbolId: z.string().min(1).describe('Symbol identifier from search_codebase.callGraphHint. On symbol-owned flows, this should carry the symbolInstanceId.'),
    symbolLabel: z.string().optional().describe('Optional symbol display label.'),
    span: z.object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
    }).optional().describe('Optional symbol span in the file.'),
});

const callGraphInputSchema = z.object({
    path: absoluteFilesystemPathSchema('ABSOLUTE filesystem path to the indexed codebase root or subdirectory (relative paths are rejected).'),
    symbolRef: symbolRefSchema.describe('Symbol reference from a grouped search result callGraphHint.'),
    direction: z.enum(['callers', 'callees', 'both']).default('both').optional().describe('Traversal direction from the starting symbol.'),
    depth: z.number().int().min(1).max(3).default(1).optional().describe('Traversal depth (max 3).'),
    limit: z.number().int().positive().default(20).optional().describe('Maximum number of returned edges.'),
});

export const callGraphTool: McpTool = {
    name: 'call_graph',
    description: () => 'Traverse registry-resolved caller/callee relationships for indexed TS/JS/Python code. Relationship-backed CALLS v0 is heuristic and name-based (not a compiler-grade call graph): unique same-file name matches are high confidence; cross-file edges stay low unless IMPORTS/EXPORTS evidence upgrades them. Traversal is bounded (depth/limit) and incomplete by design—empty or short edge lists are not proof of “no callers.” Output is advisory navigation context, not authoritative blast-radius proof; confirm impact with search_codebase, read_file, tests, and references before editing. In successful traversal responses, sidecar.nodeCount and sidecar.edgeCount report counts returned in that response, not whole-sidecar totals.',
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

        const absolutePathResult = requireAbsoluteFilesystemPath(parsed.data.path, 'path');
        if (!absolutePathResult.ok) {
            return {
                content: [{ type: 'text', text: absolutePathResult.message }],
                isError: true,
            };
        }

        const input = {
            ...parsed.data,
            path: absolutePathResult.absolutePath,
        };

        const executionContext = await resolveVectorBackedToolContext(ctx, {
            tool: 'call_graph',
            path: input.path,
            symbolRef: input.symbolRef,
        });
        if (!executionContext.ok) {
            return executionContext.response;
        }

        return executionContext.context.toolHandlers.handleCallGraph(input);
    }
};
