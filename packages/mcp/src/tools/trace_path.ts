import { z } from 'zod';
import { TRACE_PATH_RELATIONSHIP_KINDS } from '@satori-code/core';
import { requireAbsoluteFilesystemPath } from '../utils.js';
import { WorkspaceAuthorizationError } from '../core/session-workspace-policy.js';
import {
    absoluteFilesystemPathSchema,
    formatZodError,
    type McpTool,
    type ToolResponse,
} from './types.js';

const relationshipKindSchema = z.enum(TRACE_PATH_RELATIONSHIP_KINDS);

export const tracePathInputSchema = z.object({
    path: absoluteFilesystemPathSchema(
        'Absolute indexed codebase root or nested directory. A nested path confines every path node and relationship site.',
    ),
    sourceSymbolId: z.string().min(1).describe('Exact symbol instance ID from published navigation.'),
    targetSymbolId: z.string().min(1).describe('Exact symbol instance ID from published navigation.'),
    relationshipKinds: z.array(relationshipKindSchema).min(1).max(TRACE_PATH_RELATIONSHIP_KINDS.length)
        .default(['CALLS', 'IMPORTS', 'EXPORTS'])
        .describe('Persisted directed relationship kinds allowed in the path.'),
    maxDepth: z.number().int().min(1).max(6).default(3),
    maxVisitedNodes: z.number().int().min(1).max(500).default(100),
    maxTraversedEdges: z.number().int().min(1).max(2000).default(500),
}).strict();

function authorizationFailure(path: string, error: WorkspaceAuthorizationError): ToolResponse {
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                status: 'error',
                reason: error.code.toLowerCase(),
                code: error.code,
                path,
                message: error.message,
            }),
        }],
        isError: true,
    };
}

export const tracePathTool: McpTool = {
    name: 'trace_path',
    description: () =>
        'Find one shortest directed path between two exact published symbol IDs across persisted CALLS, IMPORTS, EXPORTS, or TESTS edges within the current Publication (a subdirectory path confines all nodes and edges). Enforces hard depth, visited-node, and edge limits; empty means no path found within bounds, not proof of absence. For CALLS, targetProofBacked distinguishes semantic proof from heuristic locality confidence.',
    inputSchemaZod: () => tracePathInputSchema,
    execute: async (args, ctx) => {
        const parsed = tracePathInputSchema.safeParse(args ?? {});
        if (!parsed.success) {
            return {
                content: [{ type: 'text', text: formatZodError('trace_path', parsed.error) }],
                isError: true,
            };
        }
        const absolutePath = requireAbsoluteFilesystemPath(parsed.data.path, 'path');
        if (!absolutePath.ok) {
            return { content: [{ type: 'text', text: absolutePath.message }], isError: true };
        }
        if (!ctx.workspacePolicy) {
            return authorizationFailure(absolutePath.absolutePath, new WorkspaceAuthorizationError(
                'WORKSPACE_POLICY_NOT_BOUND',
                'Tool context has not been bound to an MCP session workspace policy.',
            ));
        }
        let canonicalPath: string;
        try {
            canonicalPath = ctx.workspacePolicy.authorizePath(absolutePath.absolutePath).canonicalPath;
        } catch (error) {
            if (error instanceof WorkspaceAuthorizationError) {
                return authorizationFailure(absolutePath.absolutePath, error);
            }
            throw error;
        }
        const input = { ...parsed.data, path: canonicalPath };
        return ctx.toolHandlers.handleTracePath(input);
    },
};
