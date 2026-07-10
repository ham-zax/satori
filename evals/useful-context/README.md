# Useful-Context Evaluation

This local, labeled harness measures whether Satori returns enough evidence to reach the expected behavioral owner. It grades previously recorded observations; it does not call MCP, index a repository, or infer whether an edit was correct.

Each committed task includes exact setup and invocation payloads for the fixed six-tool MCP surface. Replace `$REPO_ROOT` with the absolute repository root before recording. The cold phase restarts the MCP runtime before one invocation; the warm phase repeats the identical invocation once in the same runtime without file or index changes.

## Run

Record observations in the version 1 format described below, then run:

```bash
node scripts/satori-useful-context.mjs \
  --tasks evals/useful-context/tasks.json \
  --observations /tmp/satori-useful-context-observations.json \
  --out /tmp/satori-useful-context-report.json \
  --json
```

An observation set records both `cold` and `warm` results for every committed task:

```json
{
  "version": 1,
  "observations": [
    {
      "taskId": "find-search-handler",
      "phase": "cold",
      "status": "ok",
      "latencyMs": 120,
      "contextBytes": 2048,
      "response": { "status": "ok" },
      "results": [
        {
          "file": "packages/mcp/src/core/handlers.ts",
          "symbol": "handleSearchCode"
        }
      ]
    },
    {
      "taskId": "find-search-handler",
      "phase": "warm",
      "status": "ok",
      "latencyMs": 40,
      "contextBytes": 2048,
      "response": { "status": "ok" },
      "results": [
        {
          "file": "packages/mcp/src/core/handlers.ts",
          "symbol": "handleSearchCode"
        }
      ]
    }
  ]
}
```

The full observation set must contain exactly one observation for every task and phase. Exact-open tasks require a parser-derived expected span, an `ok` observation, and matching `openedSymbol` identity and boundaries. Caller recovery is derived from captured call-graph `nodes` and `edges`; the grader does not trust a separately claimed caller list. Stale-recovery evidence uses `staleIndexDetected` and `recoverySucceeded` where applicable.

## Metrics

The report includes owner-in-top-three, exact-open, caller-recovery, dirty-owner, and stale-recovery rates; zero-result and fallback rates; cold, warm, and exact-identifier latency percentiles; UTF-8 serialized response bytes by query class; and context-byte percentiles. Percentiles use deterministic nearest-rank semantics.

Task `baselineLimits` are optional regression gates. A configured gate failure is retained in the JSON report and makes the CLI exit with status 2. The committed corpus deliberately omits limits until a repeatable baseline has been measured; it does not invent absolute product budgets.

The committed corpus currently contains only non-destructive repeatable workloads. Caller recovery, dirty-file overlay, and stale-index recovery remain supported grading classes, but they are not baseline tasks until a dedicated fixture runner can create and restore those states without mutating a user's index or source tree. Do not compare ad hoc prompts or one-sided cold/warm samples as a baseline.

This harness is local evidence, not telemetry. Do not upload source, query text, paths, symbols, or observation files. Native bounded reads and tests remain the final proof for code changes.
