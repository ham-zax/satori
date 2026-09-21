import path from "node:path";
import { z } from "zod";
import { Context, type Reranker } from "@zokizuan/satori-core";
import type { RootMutationRuntime } from "@zokizuan/satori-core/integration";
import { CapabilityResolver } from "../core/capabilities.js";
import { SyncManager } from "../core/sync.js";
import { IndexFingerprint } from "../config.js";
import { ToolHandlers } from "../core/handlers.js";
import type { RuntimeOwnerMutationGate } from "../core/runtime-owner.js";
import type { SessionWorkspacePolicy } from "../core/session-workspace-policy.js";

export type ProviderBackedOperation = "embedding_vector" | "vector_only";

export interface MissingProviderConfigIssue {
    ok: false;
    code: "MISSING_PROVIDER_CONFIG";
    missingEnv: string[];
    message: string;
    hints: {
        setup: {
            code: "MISSING_PROVIDER_CONFIG";
            missingEnv: string[];
            nextSteps: string[];
        };
    };
}

export interface ToolResponse {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
}

export interface ToolContext {
    context: Context;
    mutationRuntime: RootMutationRuntime;
    syncManager: SyncManager;
    capabilities: CapabilityResolver;
    reranker: Reranker | null;
    runtimeFingerprint: IndexFingerprint;
    toolHandlers: ToolHandlers;
    readFileMaxLines: number;
    /** Whole-file byte ceiling for read_file (config READ_FILE_MAX_BYTES). */
    readFileMaxBytes?: number;
    /** Immutable per-session workspace authorization policy. */
    workspacePolicy: SessionWorkspacePolicy;
    /** Optional: live multi-runtime owner diagnostics for list_codebases / status. */
    runtimeOwnerGate?: RuntimeOwnerMutationGate | null;
    /** Exact MCP request cancellation scope; mutation handlers must opt in explicitly. */
    requestSignal?: AbortSignal;
    providerRuntime?: {
        requireToolContext(
            operation: ProviderBackedOperation,
            request?: { signal?: AbortSignal },
        ): Promise<ToolContext | MissingProviderConfigIssue>;
    };
}

export interface McpTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
    name: string;
    description: (ctx: ToolContext) => string;
    inputSchemaZod: (ctx: ToolContext) => TSchema;
    execute: (args: unknown, ctx: ToolContext) => Promise<ToolResponse>;
}

function flattenUnionIssues(issues: readonly z.ZodIssue[]): z.ZodIssue[] {
    const flattened: z.ZodIssue[] = [];
    for (const issue of issues) {
        const unionErrors = (issue as { unionErrors?: readonly z.ZodError[] }).unionErrors;
        if (issue.code === z.ZodIssueCode.invalid_union && unionErrors && unionErrors.length > 0) {
            for (const unionError of unionErrors) {
                flattened.push(...flattenUnionIssues(unionError.issues));
            }
        } else {
            flattened.push(issue);
        }
    }
    return flattened;
}

export function formatZodError(toolName: string, error: z.ZodError): string {
    const issues = flattenUnionIssues(error.issues).map((issue) => {
        const key = issue.path.length > 0 ? issue.path.join('.') : 'input';
        return `${key}: ${issue.message}`;
    });

    return `Error: Invalid arguments for '${toolName}'. ${issues.join('; ')}`;
}

/** Zod string for public ABSOLUTE filesystem path fields (rejects relative / CWD-dependent inputs). */
export function absoluteFilesystemPathSchema(description: string) {
    return z.string().min(1).describe(description).refine(
        (value) => path.isAbsolute(value),
        {
            message: "must be an absolute filesystem path (relative paths are rejected; not resolved against process CWD)",
        },
    );
}

function isSafeRepoRelativePath(value: string, allowDot: boolean): boolean {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
    if (!normalized || (!allowDot && normalized === ".")) {
        return false;
    }
    if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
        return false;
    }
    if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../") || normalized.endsWith("/..")) {
        return false;
    }
    return true;
}

/** Zod string for repo-relative file paths (not absolute; resolved only against a validated root by handlers). */
export function repoRelativeFilePathSchema(description: string) {
    return z.string().min(1).describe(description).refine(
        (value) => isSafeRepoRelativePath(value, false),
        {
            message: "must be a repo-relative path inside the codebase root (not absolute or drive-relative; no .. escape segments; not '.')",
        },
    );
}

/** Zod string for repo-relative file-or-subtree prefixes used only after a validated root is bound. */
export function repoRelativePathPrefixSchema(description: string) {
    return z.string().min(1).describe(description).refine(
        (value) => isSafeRepoRelativePath(value, true),
        {
            message: "must be a repo-relative path or subtree prefix inside the codebase root (not absolute or drive-relative; no .. escape segments)",
        },
    );
}
