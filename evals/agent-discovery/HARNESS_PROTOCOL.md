# Satori Agent-Discovery Harness Protocol

Protocol version: `satori-agent-discovery-v2`

This file defines collection and grading behavior for the executable OpenCode
runner in `run-opencode.mjs`. Do not include this file or
`evaluator-tasks.json` in model context. The runner embeds a compact task prompt;
the model never reads evaluator instructions as a measured tool step.

## Isolation and fairness

1. Use one clean Git revision for every paired run. Record the revision and
   verify the production worktree is unchanged afterward.
2. Prepare or synchronize Satori before measurement. Setup time and setup calls
   are excluded from both arms.
3. Use a fresh OpenCode session and model context for every task and arm. The
   long-lived headless server may preserve ordinary MCP process caches, but no
   conversation, prompt, result, or session ID may cross arms.
4. Do not expose evaluator-only expected answers to the model. Do not let the
   native arm search outside the allowed production roots.
5. For the native arm, expose the harness's ordinary default local search,
   file-listing, and bounded range-read tools. Do not replace them with a
   benchmark-only shell recipe when the harness normally provides tools such as
   `Grep`, `Glob`, or `Read`.
6. Generate the native profile from the actual OpenCode tool definitions seen
   by the model. Enforce root, test-exclusion, read-size, and read-only
   constraints before or immediately after tool execution rather than trusting
   model self-report. Reject events outside the restricted profile.
7. Use the same model, model version, system instructions, temperature,
   reasoning setting, context limit, and task prompt for a paired run. Tool
   availability is the only intended arm difference.
8. Use temperature `0`, or the provider's lowest deterministic setting when
   zero is unavailable. Record the actual setting.
9. Count tool schemas and all repeated conversation context in API input-token
   usage. This is part of the real agent overhead.
10. Run at least three paired repetitions. Alternate order:

   ```text
   repetition 1: native, satori
   repetition 2: satori, native
   repetition 3: native, satori
   ```

11. Do not pool results from different models, harnesses, or native tool
    profiles. Report each combination separately.
12. Capture built-in tool definitions in OpenCode's `tool.definition` hook and
    Satori definitions from its authoritative MCP `tools/list` response.
    Canonicalize the allowed arm definitions and record their SHA-256 and UTF-8
    byte count. A difference in tool-schema input is part of the measured arm
    overhead.
13. Report median and range for three samples. Do not report percentile claims
    from three samples.

## Tool-result normalization

The OpenCode guard records raw and model-visible built-in tool results and caps
them at 32,768 UTF-8 bytes before the next model request. OpenCode 1.17 does not
expose MCP result bodies to `tool.execute.after`; use bounded Satori arguments,
record the persisted model-visible MCP result, and reject any run whose MCP
result exceeds 32,768 bytes. Do not claim a pre-OpenCode raw MCP byte count when
that value was not observable.

1. Serialize the result exactly as it will be shown to the model.
2. If it exceeds the cap, retain the longest valid UTF-8 prefix that leaves room
   for `\n[TRUNCATED AT 32768 UTF-8 BYTES]\n`.
3. For line-oriented text, end the retained prefix at the last complete newline.
4. Append the marker.
5. Record `truncated=true`, raw bytes, and visible bytes.

Do not silently use provider-specific truncation as the benchmark rule.

## Authoritative measurements

Capture these values from actual events; model claims are not authoritative:

- `taskWallTimeMs`: task dispatch through final response receipt.
- `timeToFirstCorrectTargetMs`: task dispatch through the first visible tool
  result containing the expected owner file and symbol together.
- `timeToFirstOwnerSourceMs`: task dispatch through the first visible owner
  implementation body.
- `modelApiLatencyMs`: sum of model API request durations, excluding tool
  execution.
- `toolLatencyMs`: sum of measured tool-call durations.
- `apiInputTokens`: sum of provider-reported input tokens for every model call.
- `apiOutputTokens`: sum of provider-reported output tokens for every model call.
- `reasoningTokens` and `cachedInputTokens`: record separately when exposed;
  otherwise use `null`.
- `visibleToolResultBytes`: sum of normalized UTF-8 tool-result bytes delivered
  to the model.
- `rawToolResultBytes`: sum before normalization.
- `modelTurns`: number of model API calls, including the final answer call.
- `toolCalls`: number of actual tool calls.
- `stepsToFirstCorrectTarget`: 1-based tool-call ordinal for the first correct
  owner target.
- `stepsToFirstOwnerSource`: 1-based tool-call ordinal for the first owner body.
- `stepsToVerifiedAnswer`: last tool-call ordinal required to establish all
  mandatory evidence.
- `finalResponseBytes`: UTF-8 bytes in the final model response.

Use provider token usage exactly as reported. Never retokenize one provider's
transcript with another tokenizer and present it as authoritative token usage.
UTF-8 byte counts are the cross-provider comparison metric.

## Event ledger

Preserve one ordered event per model call and tool call with:

```json
{
  "sequence": 1,
  "kind": "model|tool",
  "startedAt": "RFC-3339 timestamp",
  "durationMs": 123,
  "operation": "tool name or model response",
  "request": {},
  "rawResultBytes": 1000,
  "visibleResultBytes": 1000,
  "truncated": false,
  "usage": {
    "inputTokens": 100,
    "outputTokens": 20,
    "reasoningTokens": null,
    "cachedInputTokens": null
  }
}
```

Fields that do not apply to an event must be `null`, not omitted. Preserve the
provider's raw usage object separately.

## Harness output JSON

Write one JSON file per run with this top-level shape. This wrapper is the
portable result exchanged between harnesses:

```json
{
  "protocolVersion": "satori-agent-discovery-v2",
  "runId": "harness-unique-id",
  "pairedRunId": "shared-id-for-native-and-satori",
  "repetition": 1,
  "taskId": "known-exact-target",
  "arm": "native",
  "environment": {
    "gitRevision": "40-character commit",
    "gitTree": "40-character tree",
    "gitDiffSha256": "hex",
    "gitCachedDiffSha256": "hex",
    "worktreeCleanBefore": true,
    "worktreeCleanAfter": true,
    "instructionsSha256": "hex",
    "evaluatorTasksSha256": "hex",
    "taskPromptSha256": "hex",
    "harnessName": "name",
    "harnessVersion": "version",
    "platform": "platform",
    "architecture": "architecture",
    "agentPromptBytes": 0,
    "toolProfile": {
      "profileId": "harness-and-arm-specific-id",
      "tools": [],
      "definitionsSha256": "hex",
      "definitionsBytes": 0
    },
    "satoriOperationId": null,
    "satoriGeneration": null,
    "satoriRuntimeFingerprint": null
  },
  "model": {
    "provider": "provider",
    "name": "model",
    "version": "version-or-null",
    "temperature": 0,
    "reasoningSetting": "setting-or-null",
    "contextLimit": 0
  },
  "agentResult": {
    "status": "success",
    "answer": {}
  },
  "measurements": {
    "taskWallTimeMs": 0,
    "timeToFirstCorrectTargetMs": 0,
    "timeToFirstOwnerSourceMs": 0,
    "modelApiLatencyMs": 0,
    "toolLatencyMs": 0,
    "apiInputTokens": 0,
    "apiOutputTokens": 0,
    "reasoningTokens": null,
    "cachedInputTokens": null,
    "visibleToolResultBytes": 0,
    "rawToolResultBytes": 0,
    "modelTurns": 0,
    "toolCalls": 0,
    "stepsToFirstCorrectTarget": 0,
    "stepsToFirstOwnerSource": 0,
    "stepsToVerifiedAnswer": 0,
    "finalResponseBytes": 0
  },
  "events": [],
  "grade": {
    "passed": false,
    "failureReasons": []
  }
}
```

Use `null`, not zero, for a measurement that could not be observed. For a
Satori arm, record the proven setup operation identity, generation, and runtime
fingerprint when the status contract exposes them. These provenance values do
not count as measured calls.

The runner compares revision, tree, staged-diff hash, and unstaged-diff hash
again after all arms finish. A clean checkout that changes to another commit
during measurement is rejected; worktree cleanliness alone is not sufficient.

## Grading

Grade from the raw event ledger and `evaluator-tasks.json`, not from the model's
confidence or self-check.

A run passes only when:

- the owner file, symbol, and complete inclusive span match;
- every task-specific fact exactly matches `evaluator-tasks.json`;
- the required caller and callee/helper relationships are supported;
- every operation and argument obeys the selected arm;
- the real OpenCode tool sequence obeys the selected arm, root, read bound,
  one-call-per-turn rule, and 12-call budget;
- no answer key, test, documentation, Git history, or prior result was accessed.

The primary paired comparison reports correctness first. Compare latency,
tokens, bytes, and steps only among correct runs. Report failed and violating
runs separately; do not turn them into fast successes.

Before running against a new production revision, verify that every hidden
owner and relationship still resolves to the configured file, symbol, and span.
If it does not, stop and version the task key. Never adjust an expected answer
after seeing a model's result.

Raw event ledgers can contain source code and local paths. Keep all results
local unless the repository owner explicitly approves sharing them.
