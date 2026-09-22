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
    scope: z.enum(["runtime", "all"]).default("runtime").optional().describe(
        "runtime excludes tests, documentation, generated/fixture/artifact paths, scripts/tooling, examples, benchmarks, and experiments. all includes every published non-file symbol.",
    ),
    limit: z.number().int().min(1).max(50).default(15).optional().describe(
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
        "Return bounded deterministic architecture facts from the current Publication's symbol registry, relationship sidecar, and persisted package ownership snapshot. Existing logical areas, cross-area CALLS/IMPORTS boundaries, area fan-in/fan-out, hotspots, structural graph-root entry candidates, area SCC cycles, filtering counts, and semantic resolution-claim coverage remain unchanged. packageArchitecture adds factual workspace/package identities, scoped package file/symbol counts, cross-package CALLS/IMPORTS boundaries, package fan-in/fan-out, and owned-package SCC cycles; root packageRoot=\"\" is distinct from null unowned files/endpoints, and null endpoints are excluded only from package cycle calculation. subtree/excludePaths and runtime/all scope filter underlying file/symbol/relationship evidence before both area and package aggregation. Fan-in/fan-out summarize distinct counterpart nodes and relationship evidence; boundaries remain the canonical dependency rows. Entry candidates are structural roots, not proven runtime entry points. Ambiguous/unresolved claims remain coverage evidence and are not counted as CALLS.",
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
            limit: parsed.data.limit ?? 15,
            ...(parsed.data.subtree ? { subtree: parsed.data.subtree } : {}),
            ...(parsed.data.excludePaths ? { excludePaths: parsed.data.excludePaths } : {}),
        });
    },
};
