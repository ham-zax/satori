import { ManageIndexAction } from "../core/manage-types.js";
import { SearchGroupBy, SearchResultMode, SearchScope } from "../core/search-constants.js";
import {
    classifyVectorBackendError,
} from "../core/backend-diagnostics.js";
import type {
    VectorBackendDiagnostic,
    VectorBackendDiagnosticCode
} from "../core/backend-diagnostics.js";
import { MissingProviderConfigIssue, ToolResponse } from "./types.js";

export { classifyVectorBackendError };
export type { VectorBackendDiagnostic, VectorBackendDiagnosticCode };

export function isMissingProviderConfigIssue(value: unknown): value is MissingProviderConfigIssue {
    return Boolean(value)
        && typeof value === "object"
        && (value as MissingProviderConfigIssue).ok === false
        && (value as MissingProviderConfigIssue).code === "MISSING_PROVIDER_CONFIG";
}

export function formatManageProviderConfigError(
    action: ManageIndexAction,
    path: string,
    issue: MissingProviderConfigIssue
): ToolResponse {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                tool: "manage_index",
                version: 1,
                action,
                path,
                status: "error",
                reason: "missing_provider_config",
                code: issue.code,
                message: issue.message,
                humanText: issue.message,
                hints: issue.hints,
            }, null, 2)
        }]
    };
}

export function formatManageVectorBackendError(
    action: ManageIndexAction,
    path: string,
    diagnostic: VectorBackendDiagnostic
): ToolResponse {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                tool: "manage_index",
                version: 1,
                action,
                path,
                status: "error",
                reason: "vector_backend_unavailable",
                code: diagnostic.code,
                message: diagnostic.message,
                humanText: diagnostic.message,
                hints: diagnostic.hints,
            }, null, 2)
        }]
    };
}

export function formatSearchProviderConfigError(
    input: {
        path: string;
        query: string;
        scope: SearchScope;
        groupBy: SearchGroupBy;
        resultMode: SearchResultMode;
        limit: number;
    },
    issue: MissingProviderConfigIssue
): ToolResponse {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: "not_ready",
                reason: "missing_provider_config",
                code: issue.code,
                path: input.path,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit,
                freshnessDecision: null,
                message: issue.message,
                hints: issue.hints,
                results: [],
            }, null, 2)
        }]
    };
}

export function formatSearchVectorBackendError(
    input: {
        path: string;
        query: string;
        scope: SearchScope;
        groupBy: SearchGroupBy;
        resultMode: SearchResultMode;
        limit: number;
    },
    diagnostic: VectorBackendDiagnostic
): ToolResponse {
    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: "not_ready",
                reason: "vector_backend_unavailable",
                code: diagnostic.code,
                path: input.path,
                query: input.query,
                scope: input.scope,
                groupBy: input.groupBy,
                resultMode: input.resultMode,
                limit: input.limit,
                freshnessDecision: null,
                message: diagnostic.message,
                hints: diagnostic.hints,
                results: [],
            }, null, 2)
        }]
    };
}
