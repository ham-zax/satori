import path from "node:path";
import { z } from "zod";
import { Context, VoyageAIReranker } from "@zokizuan/satori-core";
import { CapabilityResolver } from "../core/capabilities.js";
import { SnapshotManager } from "../core/snapshot.js";
import { SyncManager } from "../core/sync.js";
import { IndexFingerprint } from "../config.js";
import { ToolHandlers } from "../core/handlers.js";
import type { RuntimeOwnerMutationGate } from "../core/runtime-owner.js";

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
    snapshotManager: SnapshotManager;
    syncManager: SyncManager;
    capabilities: CapabilityResolver;
    reranker: VoyageAIReranker | null;
    runtimeFingerprint: IndexFingerprint;
    toolHandlers: ToolHandlers;
    readFileMaxLines: number;
    /** Optional: live multi-runtime owner diagnostics for list_codebases / status. */
    runtimeOwnerGate?: RuntimeOwnerMutationGate | null;
    providerRuntime?: {
        requireToolContext(operation: ProviderBackedOperation): Promise<ToolContext | MissingProviderConfigIssue>;
    };
}

export interface McpTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
    name: string;
    description: (ctx: ToolContext) => string;
    inputSchemaZod: (ctx: ToolContext) => TSchema;
    execute: (args: unknown, ctx: ToolContext) => Promise<ToolResponse>;
}

export function formatZodError(toolName: string, error: z.ZodError): string {
    const issues = error.issues.map((issue) => {
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

/** Zod string for repo-relative file paths (not absolute; resolved only against a validated root by handlers). */
export function repoRelativeFilePathSchema(description: string) {
    return z.string().min(1).describe(description).refine(
        (value) => {
            const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
            // Reject empty-after-strip and bare "." (not a file path).
            if (!normalized || normalized === ".") {
                return false;
            }
            // Reject absolute and Windows drive-relative forms (C:foo, C:/x, C:\x) — CWD-dependent.
            if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
                return false;
            }
            if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../") || normalized.endsWith("/..")) {
                return false;
            }
            return true;
        },
        {
            message: "must be a repo-relative path inside the codebase root (not absolute or drive-relative; no .. escape segments; not '.')",
        },
    );
}
