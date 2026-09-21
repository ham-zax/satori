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

const fileOutlineInputSchema = z.object({
    path: absoluteFilesystemPathSchema('ABSOLUTE filesystem path to the indexed codebase root (relative paths are rejected).'),
    file: repoRelativeFilePathSchema('Repo-relative file path inside the codebase root (not absolute; resolved only against that root).'),
    start_line: z.number().int().positive().optional().describe('Optional start line filter (1-based, inclusive).'),
    end_line: z.number().int().positive().optional().describe('Optional end line filter (1-based, inclusive).'),
    limitSymbols: z.number().int().positive().default(500).optional().describe('Maximum number of returned symbols after line filtering.'),
    resolveMode: z.enum(['outline', 'exact']).default('outline').optional().describe('Outline mode returns all symbols (windowed/limited). Exact mode resolves deterministic symbol matches in this file.'),
    symbolIdExact: z.string().min(1).optional().describe('Used with resolveMode=\"exact\": exact symbol identifier match in the target file. On symbol-owned flows, pass the symbol\'s symbolInstanceId.'),
    symbolLabelExact: z.string().min(1).optional().describe('Used with resolveMode=\"exact\": exact symbol label match in the target file.'),
    detail: z.enum(['summary', 'analysis', 'relationships', 'relationship_coverage']).default('summary').optional().describe('Summary returns the outline. Analysis adds Python/Go structural-v1 metrics. Relationships adds direct metadata for one exact symbol. relationship_coverage adds file-wide observed ResolutionClaim construct calibration and does not require a symbol.'),
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
    if (
        (input.detail === 'analysis' || input.detail === 'relationships')
        && (input.resolveMode !== 'exact' || !input.symbolIdExact)
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['detail'],
            message: `detail=\"${input.detail}\" requires resolveMode=\"exact\" and symbolIdExact.`
        });
    }
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

export const fileOutlineTool: McpTool = {
    name: 'file_outline',
    description: () => 'Return indexed symbols for one published file, with call_graph jump handles when available. If the file is published but structural extraction was unavailable, returns status="not_ready" with reason="structural_evidence_unavailable" plus read_file and structural-coverage hints. Use detail="summary" for structure, detail="analysis" for Python or Go structural metrics, detail="relationships" for direct metadata on one exact symbol, or detail="relationship_coverage" for file-wide observed call-construct calibration from persisted ResolutionClaims. analysis/relationships require an exact canonical symbol; relationship_coverage does not.',
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

        // Session workspace gate: the requested path must be authorized before
        // provider resolution, telemetry, or the navigation pipeline can run.
        // An unbound policy fails closed with WORKSPACE_POLICY_NOT_BOUND. The
        // authorized canonical path is the only path that reaches the
        // downstream request.
        const workspacePolicy = ctx.workspacePolicy;
        if (!workspacePolicy) {
            return formatWorkspaceAuthorizationError(
                'file_outline',
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
                    'file_outline',
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
            tool: 'file_outline',
            path: input.path,
            file: input.file,
        });
        if (!executionContext.ok) {
            return executionContext.response;
        }

        return executionContext.context.toolHandlers.handleFileOutline(input, executionContext.context.workspacePolicy);
    }
};
