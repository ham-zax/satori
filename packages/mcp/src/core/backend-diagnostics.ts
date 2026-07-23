import type { EmbeddingProviderErrorCode } from "@zokizuan/satori-core";

export type VectorBackendDiagnosticCode =
    | "ZILLIZ_CLUSTER_STOPPED"
    | "VECTOR_BACKEND_AUTH_FAILED"
    | "VECTOR_BACKEND_UNREACHABLE"
    | "VECTOR_BACKEND_TIMEOUT"
    | "VECTOR_BACKEND_CONNECTION_CLOSED";

export interface VectorBackendDiagnostic {
    code: VectorBackendDiagnosticCode;
    message: string;
    hints: {
        backend: {
            code: VectorBackendDiagnosticCode;
            provider: "zilliz" | "milvus" | "unknown";
            retryable: boolean;
            nextSteps: string[];
        };
    };
}

export type SemanticPassFailureDiagnostic = {
    passId: "primary" | "expanded";
    errorName:
        | "Error"
        | "TypeError"
        | "RangeError"
        | "ReferenceError"
        | "SyntaxError"
        | "AggregateError"
        | "EmbeddingProviderError"
        | "NonErrorThrow";
    code:
        | VectorBackendDiagnosticCode
        | EmbeddingProviderErrorCode
        | "UNCLASSIFIED_SEARCH_PASS_FAILURE";
    classifier: "embedding_provider" | "vector_backend" | "unclassified";
    retryable?: boolean;
};

const ALLOWED_SEARCH_PASS_ERROR_NAMES = new Set<SemanticPassFailureDiagnostic["errorName"]>([
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "AggregateError",
    "EmbeddingProviderError",
]);

function classifySearchPassErrorName(error: unknown): SemanticPassFailureDiagnostic["errorName"] {
    if (!(error instanceof Error)) {
        return "NonErrorThrow";
    }
    return ALLOWED_SEARCH_PASS_ERROR_NAMES.has(error.name as SemanticPassFailureDiagnostic["errorName"])
        ? error.name as SemanticPassFailureDiagnostic["errorName"]
        : "Error";
}

export function buildSemanticPassFailureDiagnostic(input: {
    passId: SemanticPassFailureDiagnostic["passId"];
    error: unknown;
    embeddingDiagnostic: { code: EmbeddingProviderErrorCode; retryable: boolean } | null;
    vectorDiagnostic: VectorBackendDiagnostic | null;
}): SemanticPassFailureDiagnostic {
    const errorName = classifySearchPassErrorName(input.error);
    if (input.embeddingDiagnostic) {
        return {
            passId: input.passId,
            errorName,
            code: input.embeddingDiagnostic.code,
            classifier: "embedding_provider",
            retryable: input.embeddingDiagnostic.retryable,
        };
    }
    if (input.vectorDiagnostic) {
        return {
            passId: input.passId,
            errorName,
            code: input.vectorDiagnostic.code,
            classifier: "vector_backend",
            retryable: input.vectorDiagnostic.hints.backend.retryable,
        };
    }
    return {
        passId: input.passId,
        errorName,
        code: "UNCLASSIFIED_SEARCH_PASS_FAILURE",
        classifier: "unclassified",
    };
}

function collectErrorText(value: unknown, depth = 0): string {
    if (depth > 2 || value == null) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (value instanceof Error) {
        const cause = "cause" in value ? collectErrorText((value as Error & { cause?: unknown }).cause, depth + 1) : "";
        return [value.name, value.message, cause].filter(Boolean).join(" ");
    }
    if (typeof value !== "object") {
        return "";
    }

    const record = value as Record<string, unknown>;
    const fields = ["code", "status", "details", "reason", "message", "name", "cause"];
    return fields
        .map((field) => collectErrorText(record[field], depth + 1))
        .filter(Boolean)
        .join(" ");
}

function hasBackendContext(text: string): boolean {
    return /\b(zilliz|milvus|vector|collection|hybrid_code_chunks|code_chunks_|grpc|embedding)\b/.test(text)
        || /\b(unauthenticated|deadline_exceeded|econnrefused|econnreset|enotfound)\b/.test(text)
        || text.includes("cluster status")
        || text.includes("connection closed")
        || text.includes("transport closed")
        || text.includes("socket closed")
        || text.includes("deadline exceeded");
}

function createVectorBackendDiagnostic(code: VectorBackendDiagnosticCode): VectorBackendDiagnostic {
    switch (code) {
        case "ZILLIZ_CLUSTER_STOPPED":
            return {
                code,
                message: "Zilliz Cloud cluster is stopped. Resume it in Zilliz Cloud, then retry the tool call.",
                hints: {
                    backend: {
                        code,
                        provider: "zilliz",
                        retryable: true,
                        nextSteps: [
                            "Resume the Zilliz Cloud cluster from https://cloud.zilliz.com.",
                            "Retry the MCP tool call after the cluster reports healthy.",
                            "Restart the MCP client/session only if the process died after the earlier failure.",
                        ],
                    },
                },
            };
        case "VECTOR_BACKEND_AUTH_FAILED":
            return {
                code,
                message: "Vector backend authentication failed.",
                hints: {
                    backend: {
                        code,
                        provider: "unknown",
                        retryable: false,
                        nextSteps: [
                            "Verify MILVUS_ADDRESS points at the intended backend.",
                            "Verify MILVUS_TOKEN is present and current, then restart the MCP server.",
                        ],
                    },
                },
            };
        case "VECTOR_BACKEND_UNREACHABLE":
            return {
                code,
                message: "Vector backend is unreachable.",
                hints: {
                    backend: {
                        code,
                        provider: "unknown",
                        retryable: true,
                        nextSteps: [
                            "Verify network access to MILVUS_ADDRESS.",
                            "Confirm the vector backend is running and accepting connections, then retry.",
                        ],
                    },
                },
            };
        case "VECTOR_BACKEND_TIMEOUT":
            return {
                code,
                message: "Vector backend request timed out.",
                hints: {
                    backend: {
                        code,
                        provider: "unknown",
                        retryable: true,
                        nextSteps: [
                            "Confirm the vector backend is healthy and not overloaded.",
                            "Retry the MCP tool call after the backend responds normally.",
                        ],
                    },
                },
            };
        case "VECTOR_BACKEND_CONNECTION_CLOSED":
            return {
                code,
                message: "Vector backend connection closed before the tool call completed. Check backend health, provider environment, network connectivity, or an MCP process restart in the previous log lines.",
                hints: {
                    backend: {
                        code,
                        provider: "unknown",
                        retryable: true,
                        nextSteps: [
                            "If the previous response mentions ZILLIZ_CLUSTER_STOPPED, resume the Zilliz cluster at https://cloud.zilliz.com.",
                            "If the previous response mentions MISSING_PROVIDER_CONFIG, set the missing env values in the MCP client environment and restart the client.",
                            "For non-Zilliz Milvus-compatible backends, confirm the service is running and reachable at MILVUS_ADDRESS.",
                            "Retry the MCP tool call after confirming the backend is healthy.",
                            "Restart the MCP client/session if the MCP process exited after the transport failure.",
                        ],
                    },
                },
            };
    }
}

export function classifyVectorBackendError(error: unknown): VectorBackendDiagnostic | null {
    const text = collectErrorText(error).toLowerCase();
    if (!text || !hasBackendContext(text)) {
        return null;
    }

    if ((text.includes("cluster status") && text.includes("stopped")) || text.includes("status stopped")) {
        return createVectorBackendDiagnostic("ZILLIZ_CLUSTER_STOPPED");
    }
    if (text.includes("connection closed") || text.includes("transport closed") || text.includes("socket closed")) {
        return createVectorBackendDiagnostic("VECTOR_BACKEND_CONNECTION_CLOSED");
    }
    if (text.includes("deadline exceeded") || text.includes("deadline_exceeded") || text.includes("timed out") || text.includes("timeout")) {
        return createVectorBackendDiagnostic("VECTOR_BACKEND_TIMEOUT");
    }
    if (
        text.includes("unauthenticated")
        || text.includes("unauthorized")
        || text.includes("permission denied")
        || text.includes("invalid token")
        || text.includes("authentication failed")
    ) {
        return createVectorBackendDiagnostic("VECTOR_BACKEND_AUTH_FAILED");
    }
    if (
        text.includes("econnrefused")
        || text.includes("econnreset")
        || text.includes("enotfound")
        || text.includes("unavailable")
        || text.includes("network error")
        || text.includes("fetch failed")
    ) {
        return createVectorBackendDiagnostic("VECTOR_BACKEND_UNREACHABLE");
    }

    return null;
}
