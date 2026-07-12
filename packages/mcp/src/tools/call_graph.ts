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
import type { CallGraphSymbolRef } from '../core/search-types.js';

export const callGraphSymbolRefSchema: z.ZodType<CallGraphSymbolRef> = z.object({
    file: repoRelativeFilePathSchema('Repo-relative file path from the codebase root (not absolute; resolved only against that root).'),
    symbolId: z.string().min(1).describe('Concrete symbol identifier from search_codebase grouped result target.symbolId.'),
    symbolLabel: z.string().optional().describe('Optional symbol display label.'),
    span: z.object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
    }).optional().describe('Optional symbol span in the file.'),
});

export const callGraphInputSchema = z.object({
    path: absoluteFilesystemPathSchema('ABSOLUTE filesystem path to the indexed codebase root or subdirectory (relative paths are rejected).'),
    symbolRef: callGraphSymbolRefSchema.describe('Pass a graph-ready grouped search result target directly.'),
    direction: z.enum(['callers', 'callees', 'both']).default('both').optional().describe('Traversal direction from the starting symbol.'),
    depth: z.number().int().min(1).max(3).default(1).optional().describe('Traversal depth (max 3).'),
    limit: z.number().int().positive().default(20).optional().describe('Maximum number of returned edges.'),
});

export const callGraphTool: McpTool = {
    name: 'call_graph',
    description: () => 'Traverse registry-resolved caller/callee relationships for indexed TS/JS/Python code. When a grouped search result has navigation.graph="ready", pass its target directly as symbolRef and use the envelope codebaseRoot as path. Relationship-backed CALLS v0 is heuristic and name-based (not a compiler-grade call graph); traversal is bounded, incomplete, advisory, and not authoritative blast-radius proof, so empty or short edge lists are not proof of no callers. Verify impact with search_codebase, read_file, tests, or direct references. In successful responses, sidecar.nodeCount and sidecar.edgeCount count only records returned in that response.',
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
