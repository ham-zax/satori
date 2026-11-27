import path from 'node:path';
import { z } from 'zod';
import { requireAbsoluteFilesystemPath, requireRepoRelativeFilePath } from '../utils.js';
import {
    McpTool,
    ToolContext,
    ToolResponse,
    absoluteFilesystemPathSchema,
    formatZodError,
} from './types.js';
import { resolveVectorBackedToolContext } from './provider-context.js';
import {
    WorkspaceAuthorizationError,
    type AuthorizedWorkspacePath,
} from '../core/session-workspace-policy.js';
import type { CallGraphSymbolRef } from '../core/search-types.js';

function hasUnsafePathSegments(value: string): boolean {
    if (value.includes('\0')) {
        return true;
    }
    const segments = value.split(/[\\/]/);
    return segments.includes('..');
}

export function isValidNavigationBoundaryFilePath(value: string): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed === '.' || hasUnsafePathSegments(trimmed)) {
        return false;
    }
    if (/^[A-Za-z]:(?![\\/])/.test(trimmed)) {
        return false;
    }
    if (path.isAbsolute(trimmed)) {
        const resolved = path.resolve(trimmed);
        return path.basename(resolved).length > 0;
    }
    return requireRepoRelativeFilePath(trimmed, 'file').ok;
}

export function navigationBoundaryFilePathSchema(description: string) {
    return z.string().min(1).describe(description).refine(
        (value) => isValidNavigationBoundaryFilePath(value),
        {
            message: "must be a repo-relative path or an absolute path inside the codebase root (not drive-relative; no .. escape segments; not '.')",
        },
    );
}

export const callGraphSymbolRefSchema: z.ZodType<CallGraphSymbolRef> = z.object({
    file: navigationBoundaryFilePathSchema('Repo-relative file path from the codebase root, or an absolute file path inside that root.'),
    symbolId: z.string().min(1).optional().describe('Concrete symbol identifier from search_codebase grouped result target.symbolId.'),
    symbolLabel: z.string().min(1).optional().describe('Exact symbol label or name in the target file when symbolId is not yet known.'),
    span: z.object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
    }).optional().describe('Optional symbol span in the file.'),
}).superRefine((ref, ctx) => {
    const hasSymbolId = typeof ref.symbolId === 'string' && ref.symbolId.trim().length > 0;
    const hasSymbolLabel = typeof ref.symbolLabel === 'string' && ref.symbolLabel.trim().length > 0;
    if (!hasSymbolId && !hasSymbolLabel) {
        ctx.addIssue({
            code: "custom",
            path: ['symbolId'],
            message: 'symbolRef requires either symbolId or symbolLabel.',
        });
    }
});

export const callGraphInputSchema = z.object({
    path: absoluteFilesystemPathSchema('ABSOLUTE filesystem path to the indexed codebase root or subdirectory (relative paths are rejected).'),
    symbolRef: callGraphSymbolRefSchema.describe('Pass a graph-ready grouped search result target or { file, symbolLabel }.'),
    direction: z.enum(['callers', 'callees', 'both']).optional().meta({ default: 'both' }).describe('Traversal direction from the starting symbol. both unions separate caller and callee traversals within the shared edge limit.'),
    depth: z.number().int().min(1).max(3).optional().meta({ default: 1 }).describe('Traversal depth (max 3).'),
    limit: z.number().int().positive().max(50).optional().meta({ default: 20 }).describe('Maximum number of returned edges (at most 50, which keeps one response within the 48 KiB budget the other navigation tools use).'),
    evidence: z.object({
        kind: z.enum([
            'exact_references',
            'source_references',
            'test_references',
            'construct_gaps',
            'candidate_conflicts',
            'edge_arguments',
        ]).describe('One evidence class to disclose in a bounded page. Omit evidence for the default summary-only response.'),
        cursor: z.string().min(1).max(1024).optional().describe('Publication- and requested-path-scope-bound continuation returned by a previous call_graph evidence page.'),
        limit: z.number().int().positive().max(50).optional().meta({ default: 10 }).describe('Maximum evidence items returned in this page.'),
    }).strict().optional().describe('Progressively disclose one bounded evidence table while keeping the graph and evidence counts in the response.'),
});

/**
 * Structured workspace denial per the security hardening contract. The
 * `reason` is the snake_case form of the policy's authorization code, so the
 * common rejection (ROOT_NOT_AUTHORIZED) renders exactly as documented while
 * BROAD_ROOT_NOT_ALLOWED / INVALID_WORKSPACE_ROOT / WORKSPACE_POLICY_NOT_BOUND
 * stay distinguishable to callers. The envelope never carries continuation
 * handles or frozen result sets from an unauthorized request.
 */
function formatWorkspaceAuthorizationError(
    toolName: string,
    path: string,
    error: unknown,
): ToolResponse {
    const code = error instanceof WorkspaceAuthorizationError
        ? error.code
        : 'WORKSPACE_POLICY_NOT_BOUND';
    const message = error instanceof Error
        ? error.message
        : `${toolName}: ${String(error)}`;
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                status: 'error',
                reason: code.toLowerCase(),
                code,
                path,
                message,
            }),
        }],
        isError: true,
    };
}

export const callGraphTool: McpTool = {
    name: 'call_graph',
    description: () => 'Traverse callers/callees in the current Publication when canonical language capability supports call-graph navigation. For a grouped search hit with navigation.graph="ready", pass its target as symbolRef and codebaseRoot as path (subdirectories confine traversal). Summary-first; pass evidence={kind,limit,cursor?} for details. CALLS is conservative/heuristic (name-based or qualified direct-call without receiver/type-aware dispatch), bounded, and advisory—not a compiler-grade call graph or authoritative blast-radius proof. Verify impact with find_references, read_file, or tests.',
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

        // Session workspace gate: the requested path must be authorized before
        // provider resolution, telemetry, or the navigation pipeline can run.
        // An unbound policy fails closed with WORKSPACE_POLICY_NOT_BOUND. The
        // authorized canonical path is the only path that reaches the
        // downstream request.
        const workspacePolicy = ctx.workspacePolicy;
        if (!workspacePolicy) {
            return formatWorkspaceAuthorizationError(
                'call_graph',
                absolutePathResult.absolutePath,
                new WorkspaceAuthorizationError(
                    'WORKSPACE_POLICY_NOT_BOUND',
                    'Tool context has not been bound to an MCP session workspace policy.',
                ),
            );
        }
        let authorized: AuthorizedWorkspacePath;
        try {
            authorized = workspacePolicy.authorizePath(absolutePathResult.absolutePath);
        } catch (error) {
            if (error instanceof WorkspaceAuthorizationError) {
                return formatWorkspaceAuthorizationError(
                    'call_graph',
                    absolutePathResult.absolutePath,
                    error,
                );
            }
            throw error;
        }

        const input = {
            ...parsed.data,
            path: authorized.canonicalPath,
        };

        const executionContext = await resolveVectorBackedToolContext(ctx, {
            tool: 'call_graph',
            path: input.path,
            symbolRef: input.symbolRef,
        });
        if (!executionContext.ok) {
            return executionContext.response;
        }

        return executionContext.context.toolHandlers.handleCallGraph(input, workspacePolicy, ctx.requestSignal);
    }
};
