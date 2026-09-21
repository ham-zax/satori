import { z } from "zod";
import { requireAbsoluteFilesystemPath } from "../utils.js";
import {
    type McpTool,
    type ToolContext,
    type ToolResponse,
    absoluteFilesystemPathSchema,
    formatZodError,
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
        "Maximum rows returned for each bounded section: areas, boundaries, and hotspots.",
    ),
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
        "Return bounded deterministic architecture facts from the current Publication's symbol registry and relationship sidecar: logical areas, cross-area CALLS/IMPORTS evidence, call hotspots, and coverage/filtering counts. This is a structural evidence view, not an inferred architecture narrative: it does not invent layers, clusters, services, or missing relationships. Use scope=runtime to suppress tests/docs/generated/configuration noise; use scope=all for the full published navigation corpus.",
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
        });
    },
};
