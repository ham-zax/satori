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

const fileOutlineInputSchema = z.object({
    path: absoluteFilesystemPathSchema('ABSOLUTE filesystem path to the indexed codebase root (relative paths are rejected).'),
    file: repoRelativeFilePathSchema('Repo-relative file path inside the codebase root (not absolute; resolved only against that root).'),
    start_line: z.number().int().positive().optional().describe('Optional start line filter (1-based, inclusive).'),
    end_line: z.number().int().positive().optional().describe('Optional end line filter (1-based, inclusive).'),
    limitSymbols: z.number().int().positive().default(500).optional().describe('Maximum number of returned symbols after line filtering.'),
    resolveMode: z.enum(['outline', 'exact']).default('outline').optional().describe('Outline mode returns all symbols (windowed/limited). Exact mode resolves deterministic symbol matches in this file.'),
    symbolIdExact: z.string().min(1).optional().describe('Used with resolveMode=\"exact\": exact symbol identifier match in the target file. On symbol-owned flows, pass the symbol\'s symbolInstanceId.'),
    symbolLabelExact: z.string().min(1).optional().describe('Used with resolveMode=\"exact\": exact symbol label match in the target file.'),
}).superRefine((input, ctx) => {
    if (input.resolveMode === 'exact') {
        if (!input.symbolIdExact && !input.symbolLabelExact) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['symbolIdExact'],
                message: 'resolveMode=\"exact\" requires symbolIdExact or symbolLabelExact.'
            });
        }
    }
});

export const fileOutlineTool: McpTool = {
    name: 'file_outline',
    description: () => 'Return a sidecar-backed symbol outline for one file, including call_graph jump handles.',
    inputSchemaZod: () => fileOutlineInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const parsed = fileOutlineInputSchema.safeParse(args || {});
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text',
                    text: formatZodError('file_outline', parsed.error)
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
            tool: 'file_outline',
            path: input.path,
            file: input.file,
        });
        if (!executionContext.ok) {
            return executionContext.response;
        }

        return executionContext.context.toolHandlers.handleFileOutline(input);
    }
};
