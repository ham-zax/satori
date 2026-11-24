import { z } from "zod";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import {
    type McpTool,
    type ToolContext,
    type ToolResponse,
    absoluteFilesystemPathSchema,
    formatZodError,
    repoRelativePathPrefixSchema,
} from "./types.js";
import { callGraphSymbolRefSchema } from "./call_graph.js";
import {
    WorkspaceAuthorizationError,
    type AuthorizedWorkspacePath,
} from "../core/session-workspace-policy.js";

export const findReferencesInputSchema = z.object({
    path: absoluteFilesystemPathSchema(
        "ABSOLUTE filesystem path to the indexed codebase root. Exact occurrence search is scoped separately with subtree/includePaths/excludePaths.",
    ),
    symbolRef: callGraphSymbolRefSchema.describe(
        "Canonical published symbol target. Use file + symbolId or file + symbolLabel from file_outline/search navigation.",
    ),
    subtree: repoRelativePathPrefixSchema(
        "Optional repo-relative subtree prefix. Only published files inside this subtree are inspected.",
    ).optional(),
    includePaths: z.array(repoRelativePathPrefixSchema(
        "Repo-relative file or subtree prefix to include.",
    )).max(64).optional(),
    excludePaths: z.array(repoRelativePathPrefixSchema(
        "Repo-relative file or subtree prefix to exclude deterministically.",
    )).max(64).optional(),
    limit: z.number().int().min(1).max(500).optional().meta({ default: 100 }).describe(
        "Maximum returned occurrences. All eligible published files are still inspected before this output limit is applied; truncation makes coverage partial.",
    ),
    cursor: z.string().min(1).max(1024).optional().describe(
        "Continuation returned as nextCursor by a previous find_references page. Bound to the serving Publication, symbol, and path scope.",
    ),
}).strict();

function formatWorkspaceAuthorizationError(
    path: string,
    error: unknown,
): ToolResponse {
    const code = error instanceof WorkspaceAuthorizationError
        ? error.code
        : "WORKSPACE_POLICY_NOT_BOUND";
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: "error",
                reason: code.toLowerCase(),
                code,
                path,
                message: error instanceof Error ? error.message : String(error),
            }),
        }],
        isError: true,
    };
}

export const findReferencesTool: McpTool = {
    name: "find_references",
    description: () =>
        "Find exact textual occurrences of one published symbol across the Publication source universe. Ranking-independent and observational (does not promote matches into authoritative CALLS). coverage=complete means every eligible file matched its Publication content hash and all hits were returned; changed/unverified source, unreadable files, or truncation yield coverage=partial with reasons. Filter with subtree/includePaths/excludePaths; page with cursor=nextCursor.",
    inputSchemaZod: () => findReferencesInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const parsed = findReferencesInputSchema.safeParse(args || {});
        if (!parsed.success) {
            return {
                content: [{
                    type: "text",
                    text: formatZodError("find_references", parsed.error),
                }],
                isError: true,
            };
        }

        const absolutePathResult = requireAbsoluteFilesystemPath(parsed.data.path, "path");
        if (!absolutePathResult.ok) {
            return {
                content: [{ type: "text", text: absolutePathResult.message }],
                isError: true,
            };
        }

        if (!ctx.workspacePolicy) {
            return formatWorkspaceAuthorizationError(
                absolutePathResult.absolutePath,
                new WorkspaceAuthorizationError(
                    "WORKSPACE_POLICY_NOT_BOUND",
                    "Tool context has not been bound to an MCP session workspace policy.",
                ),
            );
        }

        let authorized: AuthorizedWorkspacePath;
        try {
            authorized = ctx.workspacePolicy.authorizeRoot(absolutePathResult.absolutePath);
        } catch (error) {
            return formatWorkspaceAuthorizationError(absolutePathResult.absolutePath, error);
        }

        return ctx.toolHandlers.handleFindReferences({
            ...parsed.data,
            path: authorized.canonicalPath,
        }, ctx.workspacePolicy, ctx.requestSignal);
    },
};
