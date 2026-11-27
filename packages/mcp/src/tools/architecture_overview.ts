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
import { resolveVectorBackedToolContext } from "./provider-context.js";
import { WorkspaceAuthorizationError } from "../core/session-workspace-policy.js";

const architectureOverviewInputSchema = z.object({
    path: absoluteFilesystemPathSchema(
        "ABSOLUTE filesystem path to the indexed codebase root.",
    ),
    scope: z.enum(["runtime", "all"]).optional().meta({ default: "runtime" }).describe(
        "runtime excludes tests, documentation, generated/fixture/artifact paths, scripts/tooling, examples, benchmarks, and experiments. all includes every published non-file symbol.",
    ),
    limit: z.number().int().min(1).max(50).optional().meta({ default: 8 }).describe(
        "Maximum rows returned for each bounded section: areas, boundaries, fan-in, fan-out, hotspots, entry candidates, cycles, packages, package boundaries, package fan-in/fan-out, and package cycles.",
    ),
    subtree: repoRelativePathPrefixSchema(
        "Optional repo-relative subtree prefix used to restrict all architecture evidence.",
    ).optional(),
    excludePaths: z.array(repoRelativePathPrefixSchema(
        "Repo-relative file or subtree prefix excluded from all architecture evidence.",
    )).max(64).optional(),
}).strict();

function formatWorkspaceAuthorizationError(path: string, error: unknown): ToolResponse {
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

export const architectureOverviewTool: McpTool = {
    name: "architecture_overview",
    description: () =>
        "Return bounded architecture facts from the current Publication: logical areas, packageArchitecture (Node/Cargo workspaces and packages), cross-area/package CALLS/IMPORTS boundaries, fan-in/fan-out, hotspots, structural entry candidates (not proven runtime entrypoints), SCC cycles, and resolution-claim coverage. Filter with scope=\"runtime\"|\"all\", subtree, and excludePaths.",
    inputSchemaZod: () => architectureOverviewInputSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
        const parsed = architectureOverviewInputSchema.safeParse(args || {});
        if (!parsed.success) {
            return {
                content: [{
                    type: "text",
                    text: formatZodError("architecture_overview", parsed.error),
                }],
                isError: true,
            };
        }

        const absolutePathResult = requireAbsoluteFilesystemPath(parsed.data.path, "path");
        if (!absolutePathResult.ok) {
            return {
                content: [{
                    type: "text",
                    text: absolutePathResult.message,
                }],
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

        let authorizedRoot: string;
        try {
            authorizedRoot = ctx.workspacePolicy.authorizeRoot(
                absolutePathResult.absolutePath,
            ).canonicalPath;
        } catch (error) {
            return formatWorkspaceAuthorizationError(
                absolutePathResult.absolutePath,
                error,
            );
        }

        const executionContext = await resolveVectorBackedToolContext(ctx, {
            tool: "architecture_overview",
            path: authorizedRoot,
        });
        if (!executionContext.ok) {
            return executionContext.response;
        }

        return executionContext.context.toolHandlers.handleArchitectureOverview({
            path: authorizedRoot,
            scope: parsed.data.scope ?? "runtime",
            limit: parsed.data.limit ?? 8,
            ...(parsed.data.subtree ? { subtree: parsed.data.subtree } : {}),
            ...(parsed.data.excludePaths ? { excludePaths: parsed.data.excludePaths } : {}),
        }, ctx.requestSignal);
    },
};
