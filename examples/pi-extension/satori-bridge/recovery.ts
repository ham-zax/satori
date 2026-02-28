export type GuardMode = "drop" | "redirect" | "off";
export type GuardRecoveryMode = "auto" | "never";
export type CliCommandType = "tools-list" | "tool-call";

export interface RetryClassificationInput {
    commandType: CliCommandType;
    toolName?: string;
    exitCode?: number;
    stderr?: string;
    parseErrorText?: string;
    executionErrorText?: string;
    parsedPayload?: unknown;
}

export interface RetryClassification {
    retryable: boolean;
    validResponse: boolean;
    startupFailure: boolean;
    reason:
        | "valid_response"
        | "usage_error"
        | "non_protocol_failure"
        | "manage_index_retry_blocked"
        | "protocol_retry_allowed";
}

const RETRYABLE_PROTOCOL_SIGNATURES = [
    "E_PROTOCOL_FAILURE",
    "STDOUT_BLOCKED",
    "MCP error -32001",
    "satori-cli returned empty stdout",
    "Failed to parse satori-cli JSON output",
    "Connection closed",
];

const STARTUP_SIGNATURES = [
    "E_STARTUP_TIMEOUT",
    "startup timeout",
];

export function resolveGuardMode(raw: string | undefined): GuardMode {
    const normalized = raw?.trim().toLowerCase();
    if (normalized === "redirect") {
        return "redirect";
    }
    if (normalized === "off" || normalized === "false" || normalized === "0" || normalized === "disable") {
        return "off";
    }
    return "drop";
}

export function resolveGuardRecoveryMode(raw: string | undefined): GuardRecoveryMode {
    const normalized = raw?.trim().toLowerCase();
    return normalized === "never" ? "never" : "auto";
}

export function isToolsListPayload(payload: unknown): payload is { tools: Array<{ name: string }> } {
    if (!payload || typeof payload !== "object") {
        return false;
    }
    const maybeTools = (payload as { tools?: unknown }).tools;
    return Array.isArray(maybeTools);
}

export function isCallToolPayload(payload: unknown): payload is { content: unknown[]; isError?: boolean } {
    if (!payload || typeof payload !== "object") {
        return false;
    }
    return Array.isArray((payload as { content?: unknown }).content);
}

export function extractEnvelopeStatus(payload: unknown): string | null {
    if (!isCallToolPayload(payload)) {
        return null;
    }
    for (const block of payload.content) {
        if (!block || typeof block !== "object") {
            continue;
        }
        const record = block as { type?: unknown; text?: unknown };
        if (record.type !== "text" || typeof record.text !== "string") {
            continue;
        }
        try {
            const parsed = JSON.parse(record.text) as { status?: unknown };
            if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
                return parsed.status;
            }
        } catch {
            // ignore non-json text blocks
        }
    }
    return null;
}

export function hasRetryableProtocolSignature(text: string): boolean {
    return RETRYABLE_PROTOCOL_SIGNATURES.some((signature) => text.includes(signature));
}

export function hasStartupFailureSignature(text: string): boolean {
    return STARTUP_SIGNATURES.some((signature) => text.includes(signature));
}

function isValidResponse(input: RetryClassificationInput): boolean {
    if (input.commandType === "tools-list") {
        return isToolsListPayload(input.parsedPayload);
    }
    if (isCallToolPayload(input.parsedPayload)) {
        return true;
    }
    return false;
}

function buildFailureText(input: RetryClassificationInput): string {
    return [
        input.stderr || "",
        input.parseErrorText || "",
        input.executionErrorText || "",
    ].join("\n");
}

function isManageIndex(input: RetryClassificationInput): boolean {
    return input.commandType === "tool-call" && input.toolName === "manage_index";
}

export function classifyRetryEligibility(input: RetryClassificationInput): RetryClassification {
    const validResponse = isValidResponse(input);
    if (validResponse) {
        return {
            retryable: false,
            validResponse: true,
            startupFailure: false,
            reason: "valid_response",
        };
    }

    if (input.exitCode === 2) {
        return {
            retryable: false,
            validResponse: false,
            startupFailure: false,
            reason: "usage_error",
        };
    }

    const failureText = buildFailureText(input);
    const protocolFailure = input.exitCode === 3 || hasRetryableProtocolSignature(failureText);
    if (!protocolFailure) {
        return {
            retryable: false,
            validResponse: false,
            startupFailure: false,
            reason: "non_protocol_failure",
        };
    }

    const startupFailure = hasStartupFailureSignature(failureText) || (Boolean(input.executionErrorText) && !input.parseErrorText);
    if (isManageIndex(input) && !startupFailure) {
        return {
            retryable: false,
            validResponse: false,
            startupFailure: false,
            reason: "manage_index_retry_blocked",
        };
    }

    return {
        retryable: true,
        validResponse: false,
        startupFailure,
        reason: "protocol_retry_allowed",
    };
}
