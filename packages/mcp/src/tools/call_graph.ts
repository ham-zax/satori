import { z } from 'zod';
import { requireAbsoluteFilesystemPath } from '../utils.js';
import {
    McpTool,
    ToolContext,
    ToolResponse,
    absoluteFilesystemPathSchema,
    formatZodError,
    repoRelativeFilePathSchema,
} from './types.js';
import { resolveVectorBackedToolContext } from './provider-context.js';
import {
    WorkspaceAuthorizationError,
    type AuthorizedWorkspacePath,
} from '../core/session-workspace-policy.js';
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
    direction: z.enum(['callers', 'callees', 'both']).default('both').optional().describe('Traversal direction from the starting symbol. both unions separate caller and callee traversals within the shared edge limit.'),
    depth: z.number().int().min(1).max(3).default(1).optional().describe('Traversal depth (max 3).'),
    limit: z.number().int().positive().default(20).optional().describe('Maximum number of returned edges.'),
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
    description: () => 'Traverse Publication relationship navigation when the indexed symbol\'s canonical language capability supports call-graph queries and the current Publication has compatible relationship navigation. When a grouped search result has navigation.graph="ready", pass its target directly as symbolRef and use the envelope codebaseRoot as path. Relationship-backed CALLS v0 is language-specific and conservative: some supported tiers use heuristic, name-based evidence, while CBM-backed Go, Java, C#, C++, and Rust expose qualified direct-call slices and exclude receiver/type-aware dispatch. Java and C# require caller and target to share the same detected build root (Maven/Gradle or .csproj), falling back to the same source directory when no manifest establishes broader authority. C++ currently rejects unproved cross-translation-unit targets, and Rust requires Cargo ownership while rejecting unmodeled cfg-dependent sources. For supported test-reference languages, including Python and Go, successful target traversals may also include resolved testReferences. Semantic providers additionally expose exactReferences from persisted resolution claims: resolved references corroborate admitted edges, while ambiguous or unresolved candidate references remain explicit evidence and are never promoted into edges. constructCoverage summarizes the call constructs actually observed inside the selected source symbol and reports exact gap spans for non-resolved observations. It is not a compiler-grade call graph; traversal is bounded, incomplete, advisory, and not authoritative blast-radius proof, so empty or short edge lists are not proof of no callers. Verify impact with search_codebase, read_file, tests, or direct references. Edges expose rule/heuristic strategy and argument source expressions when retained by the index; these are not LSP probabilities or evaluated values. Legacy edges may lack arguments. Node freshness distinguishes current-source hash checks from unknown per-file index age. Limit warnings indicate incomplete traversal. In successful responses, graph.nodeCount and graph.edgeCount count only records returned in that response.',
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

        return executionContext.context.toolHandlers.handleCallGraph(input, executionContext.context.workspacePolicy);
    }
};
