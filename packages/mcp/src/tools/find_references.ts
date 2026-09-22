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
        "Canonical published symbol target. Use file + symbolId from file_outline/search navigation.",
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
    limit: z.number().int().min(1).max(500).default(100).optional().describe(
        "Maximum returned occurrences. All eligible published files are still inspected before this output limit is applied; truncation makes coverage partial.",
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
        "Find exact textual occurrences of one canonical published symbol across the validated Publication source universe. This is a ranking-independent observational floor: it scans eligible published files directly and does not use semantic retrieval, lexical top-N candidate selection, reranking, or must: budgets. Results include exact file/span, owning symbol when mechanically available, occurrence kind, matched member/text, and evidenceClass=published_source_text. Textual matches are observational only and never become authoritative CALLS without normal relationship proof. coverage=complete means every eligible source file was inspected, its current bytes matched the Publication content hash, and every match was returned; unreadable/oversized/replaced/changed/unverified source or output truncation yields coverage=partial with concrete reasons. Freshness metadata is also surfaced when available. Use subtree/includePaths/excludePaths for deterministic source scope.",
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
        }, ctx.workspacePolicy);
    },
};
