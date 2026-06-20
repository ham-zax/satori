import { ToolContext, ToolResponse } from "./types.js";
import { classifyVectorBackendError, isMissingProviderConfigIssue } from "./setup-errors.js";

type NavigationToolName = "file_outline" | "call_graph" | "read_file";

type NavigationProviderFailureInput = {
    tool: NavigationToolName;
    path: string;
    file?: string;
    symbolRef?: unknown;
    messagePrefix?: string;
};

export type ProviderContextResolution =
    | { ok: true; context: ToolContext }
    | { ok: false; response: ToolResponse };

function stringifyToolJson(payload: unknown): string {
    return JSON.stringify(payload);
}

function buildNavigationProviderFailureResponse(
    input: NavigationProviderFailureInput,
    failure: {
        reason: "missing_provider_config" | "vector_backend_unavailable";
        code: string;
        message: string;
        hints?: Record<string, unknown>;
    }
): ToolResponse {
    const base = {
        status: "not_ready",
        reason: failure.reason,
        code: failure.code,
        path: input.path,
        message: input.messagePrefix
            ? `${input.messagePrefix} ${failure.message}`
            : failure.message,
        ...(failure.hints ? { hints: failure.hints } : {}),
    };

    if (input.tool === "file_outline") {
        return {
            content: [{
                type: "text",
                text: stringifyToolJson({
                    ...base,
                    file: input.file || "",
                    outline: null,
                    hasMore: false,
                })
            }]
        };
    }

    if (input.tool === "call_graph") {
        return {
            content: [{
                type: "text",
                text: stringifyToolJson({
                    ...base,
                    supported: false,
                    symbolRef: input.symbolRef,
                    nodes: [],
                    edges: [],
                    notes: [],
                })
            }]
        };
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify(base, null, 2)
        }],
        isError: true
    };
}

export async function resolveVectorBackedToolContext(
    ctx: ToolContext,
    failureInput: NavigationProviderFailureInput
): Promise<ProviderContextResolution> {
    if (!ctx.providerRuntime) {
        return { ok: true, context: ctx };
    }

    try {
        const providerContext = await ctx.providerRuntime.requireToolContext("vector_only");
        if (isMissingProviderConfigIssue(providerContext)) {
            return {
                ok: false,
                response: buildNavigationProviderFailureResponse(failureInput, {
                    reason: "missing_provider_config",
                    code: providerContext.code,
                    message: providerContext.message,
                    hints: providerContext.hints,
                })
            };
        }
        return { ok: true, context: providerContext };
    } catch (error) {
        const diagnostic = classifyVectorBackendError(error);
        if (!diagnostic) {
            throw error;
        }
        return {
            ok: false,
            response: buildNavigationProviderFailureResponse(failureInput, {
                reason: "vector_backend_unavailable",
                code: diagnostic.code,
                message: diagnostic.message,
                hints: diagnostic.hints,
            })
        };
    }
}
