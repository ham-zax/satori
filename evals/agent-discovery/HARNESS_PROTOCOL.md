# Satori Agent-Discovery Harness Protocol

Protocol version: `satori-agent-discovery-v3`

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
10. Exploratory runs use at least three paired repetitions. The Phase 0
    acceptance run uses exactly ten paired repetitions per task and arm through
    `pnpm eval:agent-discovery:baseline -- --repo <clean-worktree>`. Alternate
    arm order for every configured repetition:

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
13. Report median and range for the configured sample count. Do not report
    percentile claims from agent runs; the separate controlled-local latency
    protocol requires at least 30 recorded samples for percentile reporting.
14. Enforce a 24-tool runaway safety ceiling in the guard and configure OpenCode
    for 26 model steps. OpenCode turns the configured terminal step into a
    max-steps response, so the two-step reserve provides one ordinary post-tool
    JSON turn plus the terminal fallback without permitting a twenty-fifth tool
    call. The ceiling is not an efficiency gate: report actual tool calls,
    tokens, and wall time for every correct run.

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
- `investigationTailToolCalls`: final tool-call count minus
  `stepsToVerifiedAnswer`; use `null` when mandatory evidence never became
  complete.
- `finalResponseBytes`: UTF-8 bytes in the final model response.

The Markdown report keeps three measurement layers separate:

1. Retrieval quality uses first-target and first-source milestones from all
   attempts, including runs whose final answer was wrong. It reports milestone
   observation counts so missing retrieval is not hidden by nullable medians.
2. Evidence route reports when mandatory evidence became complete and how many
   later tool calls formed the investigation tail. A missing completion is
   `null`, not zero.
3. Full autonomous-agent cost uses final wall time, provider tokens, tool calls,
   model turns, and visible bytes. Correct-run totals support paired performance
   comparison; all-attempt totals retain the cost of failed runs. Final totals
   always include the investigation tail.

Source acquisition and downstream processing use a separate JSONL ledger. A
Satori tool operation owns each source observation, and every actual acquisition
event has one `(observationId, readId)` identity. Identical duplicate emissions
of that composite identity count once; conflicting reuse invalidates the run;
genuine rereads use new read IDs and count again. The portable gate uses
`sourceIo.portableBytesObtained`. Observation-scoped `uniqueBytesCovered` is a
diagnostic and never erases reread cost. `sourceProcessing.inputBytesProcessed`
is reported separately and never contributes to portable acquisition bytes.
Every observation has one `completed`, `partial`, or `failed` outcome; complete
scans require a completed outcome and full requested-byte coverage. Processing
events carry `success`, `failed`, or `rejected`. Path convenience reads use the
honest `path_read` basis rather than claiming descriptor-bound authority;
`sourceIo.byBasis` reports those acquisition classes separately and
`sourceProcessing.byOutcome` reports attempted work by result. `filesOpened`
counts observations whose acquisition completed or obtained partial source; a
failed observation with no acquired source does not increment it.

OpenCode 1.17 does not expose the native `read` tool's source-acquisition
boundary. Native runs therefore report source acquisition as unavailable rather
than relabeling model-visible output bytes as descriptor I/O. The adaptive
Satori baseline and later composed candidate must use the same internal source
ledger implementation.

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
  "protocolVersion": "satori-agent-discovery-v3",
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
    "satoriRuntime": {
      "command": ["node-executable", "absolute-mcp-entry"],
      "schemaVersion": 1,
      "nodeVersion": "version",
      "roots": [
        {
          "relativeRoot": "packages/core/dist",
          "fileCount": 0,
          "totalBytes": 0,
          "sha256": "hex"
        },
        {
          "relativeRoot": "packages/mcp/dist",
          "fileCount": 0,
          "totalBytes": 0,
          "sha256": "hex"
        }
      ],
      "sha256": "hex"
    },
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
    "investigationTailToolCalls": 0,
    "finalResponseBytes": 0,
    "sourceIo": null,
    "sourceWorkload": null,
    "sourceProcessing": null
  },
  "events": [],
  "grade": {
    "passed": false,
    "failureReasons": []
  },
  "harness": {
    "sourceMeasurement": {
      "status": "unavailable",
      "reason": "native_tool_source_acquisition_boundary_not_exposed",
      "ledgerStartByte": 0,
      "ledgerEndByte": 0,
      "records": []
    }
  }
}
```

Source measurement is a strict union. `status: "measured"` requires non-null
`sourceIo`, `sourceWorkload`, and `sourceProcessing` summaries and omits
`reason`. `status: "unavailable"` requires all three summaries to be `null` and
includes a bounded reason; the native arm uses
`native_tool_source_acquisition_boundary_not_exposed`.

Use `null`, not zero, for a measurement that could not be observed. For a
Satori arm, record the proven setup operation identity, generation, and runtime
fingerprint when the status contract exposes them. These provenance values do
not count as measured calls.

The runner compares revision, tree, staged-diff hash, and unstaged-diff hash
again after all arms finish. A clean checkout that changes to another commit
during measurement is rejected; worktree cleanliness alone is not sufficient.
It also hashes every generated file under Core and MCP `dist`, records the Node
version and exact command, and rejects a run if either runtime output changes
during measurement. This prevents a clean source tree from concealing stale or
changing ignored build artifacts.

## Grading

Grade from the raw event ledger and `evaluator-tasks.json`, not from the model's
confidence or self-check.

A run passes only when:

- the owner file, symbol, and complete inclusive span match;
- every task-specific fact exactly matches `evaluator-tasks.json`;
- the required caller and callee/helper relationships are supported;
- symbol fields contain exact bare identifiers or dot-qualified identifiers whose
  final segment is the exact identifier; prose and declaration prefixes fail;
- every operation and argument obeys the selected arm; parallel calls are
  allowed and every call remains independently measured;
- the real OpenCode tool sequence obeys the selected arm, root, read bound,
  and 24-call runaway safety ceiling;
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
