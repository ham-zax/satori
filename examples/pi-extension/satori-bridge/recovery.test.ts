import test from "node:test";
import assert from "node:assert/strict";
import {
    classifyRetryEligibility,
    extractEnvelopeStatus,
    hasRetryableProtocolSignature,
    isCallToolPayload,
    resolveGuardMode,
    resolveGuardRecoveryMode,
} from "./recovery.js";

test("resolveGuardMode supports drop/redirect/off values", () => {
    assert.equal(resolveGuardMode(undefined), "drop");
    assert.equal(resolveGuardMode("redirect"), "redirect");
    assert.equal(resolveGuardMode("off"), "off");
    assert.equal(resolveGuardMode("false"), "off");
});

test("resolveGuardRecoveryMode defaults to auto", () => {
    assert.equal(resolveGuardRecoveryMode(undefined), "auto");
    assert.equal(resolveGuardRecoveryMode("auto"), "auto");
    assert.equal(resolveGuardRecoveryMode("never"), "never");
});

test("classifyRetryEligibility retries protocol failures when no valid response was produced", () => {
    const classified = classifyRetryEligibility({
        commandType: "tool-call",
        toolName: "search_codebase",
        exitCode: 3,
        stderr: "E_PROTOCOL_FAILURE MCP error -32001: Request timed out",
        parsedPayload: undefined,
    });
    assert.equal(classified.retryable, true);
    assert.equal(classified.reason, "protocol_retry_allowed");
});

test("classifyRetryEligibility does not retry parseable non-ok tool envelopes", () => {
    const payload = {
        isError: false,
        content: [
            {
                type: "text",
                text: JSON.stringify({ status: "not_ready", reason: "indexing" }),
            },
        ],
    };
    const classified = classifyRetryEligibility({
        commandType: "tool-call",
        toolName: "search_codebase",
        exitCode: 1,
        stderr: "E_TOOL_ERROR status=not_ready reason=indexing",
        parsedPayload: payload,
    });
    assert.equal(isCallToolPayload(payload), true);
    assert.equal(extractEnvelopeStatus(payload), "not_ready");
    assert.equal(classified.retryable, false);
    assert.equal(classified.reason, "valid_response");
});

test("classifyRetryEligibility blocks automatic retry for manage_index except startup failures", () => {
    const blocked = classifyRetryEligibility({
        commandType: "tool-call",
        toolName: "manage_index",
        exitCode: 3,
        stderr: "E_PROTOCOL_FAILURE MCP error -32001: Request timed out",
        parsedPayload: undefined,
    });
    assert.equal(blocked.retryable, false);
    assert.equal(blocked.reason, "manage_index_retry_blocked");

    const startup = classifyRetryEligibility({
        commandType: "tool-call",
        toolName: "manage_index",
        exitCode: 3,
        stderr: "E_STARTUP_TIMEOUT startup timeout after 15000ms",
        parsedPayload: undefined,
    });
    assert.equal(startup.retryable, true);
    assert.equal(startup.reason, "protocol_retry_allowed");
});

test("hasRetryableProtocolSignature catches blocked stdout signatures", () => {
    assert.equal(hasRetryableProtocolSignature("[STDOUT_BLOCKED_BINARY len=155]"), true);
});
