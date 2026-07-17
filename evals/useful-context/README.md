# Useful-Context Evaluation

This local, labeled harness measures whether Satori returns enough evidence to reach the expected behavioral owner. The recorder calls an existing local MCP runtime and the grader evaluates its observations. It never creates or reindexes a repository and does not infer whether an edit was correct, but it explicitly runs incremental `sync` before measurement so the recorded calls cannot hide freshness work.

Each committed task includes exact setup and invocation payloads for the fixed six-tool MCP surface. The recorder safely replaces `$REPO_ROOT` with the canonical repository root. It starts a fresh runtime per task, performs an unmeasured explicit `sync`, proves the resulting completed receipt through status, records the workload for the first time as prepared-cold, then repeats the same invocation as warm. A measured call is rejected if it causes or joins synchronization, and the completed operation ID, generation, and fingerprint must remain unchanged through the task. Prepared-cold is workload-cold, not pristine-process latency: the runtime has completed protocol and freshness preparation. Exact-open span drift fails immediately.

## Record

Use the installed managed launcher at `~/.satori/bin/satori-mcp.js`, or override the executable and repeat `--command-arg` for its arguments:

```bash
pnpm eval:useful-context:record -- \
  --tasks evals/useful-context/tasks.json \
  --repo "$PWD" \
  --out /tmp/satori-useful-context-observations.json
```

Preview the fully expanded task plan without starting MCP:

```bash
pnpm eval:useful-context:record -- \
  --tasks evals/useful-context/tasks.json \
  --repo "$PWD" \
  --dry-run
```

`--startup-timeout-ms`, `--call-timeout-ms`, and `--close-timeout-ms` bound every process phase. `--out` must be outside the measured repository. Recording requires the same clean Git worktree before and after the run. Current recordings emit observation version 3 with one cold sample and numbered warm samples. Version 3 preserves tagged file-versus-symbol result identities; archived versions 1 and 2 remain readable. Metadata binds the report to the canonical root, Git revision, normalized task-suite SHA-256, MCP server name/version, Node version/platform/architecture, preparation sync statistics, and the completed operation generation and runtime fingerprint for every task. It also hashes the task file and each repeated `--authority-file` artifact. If an authority artifact inside the indexed repository appears in recorded candidates, the run fails instead of post-filtering it. The current status envelope does not expose a separate indexed fingerprint; the completed sync receipt is the available compatibility-gated fingerprint proof.

### Candidate capture and offline replay

Full-debug recordings may request a trace-only candidate superset with
`debugCandidateLimit=160`. That value does not replace the production
32-to-80 retrieval policy or the visible result limit: Core retrieves the
larger raw arms once for diagnostics, but returns and reranks only the normal
product candidate set. The trace is source-free and binds every dense, precise
lexical, and fallback lexical arm to its query/term digest and publication.

Create a replay artifact outside the indexed repository:

```bash
pnpm eval:search-candidates:capture -- \
  --tasks /absolute/evaluation/tasks.json \
  --observations /absolute/evaluation/observations.json \
  --require-replay-ready \
  --out /absolute/evaluation/candidates.json

pnpm eval:search-candidates:replay -- \
  --capture /absolute/evaluation/candidates.json \
  --out /absolute/evaluation/baseline-replay.json
```

The baseline replay recomputes both Core and MCP RRF stages and fails on any
ordering or score mismatch. A contender is supplied with `--policy-file`; the
policy explicitly freezes candidate depth, both RRF constants, source weights,
source minimums, and the conditional-OR threshold. Replay always proves the
baseline first. It performs no embeddings, storage reads, reranker calls, or
indexing. Newly admitted candidates still require one separately budgeted live
provider validation; the replay marks this requirement instead of inventing
reranker outcomes.

Candidate capture also requires mechanical measurement isolation: every timed
search must report `skipped_recent`, its preparation sync must be zero-change,
and its exact operation/publication proof must be unchanged after the samples.
Replay output records the replay script, canonical-JSON helper, Node identity,
measured-runtime digest, and exact policy-source bytes so later results can be
attributed to one executable replay artifact.

Capture readiness is classified separately. `fusionReady` covers the raw arms
and Core/MCP RRF stages used by fusion replay; `survivalReady` additionally
requires the local-scoring signals and removal evidence used by contender
admission; `agentReady` is reserved for the later reranker-output, grouping,
and disclosure replay contract. `--require-replay-ready` currently requires
complete fusion and survival authority, not the unfinished agent replay.

## Grade

Grade the recorded observations:

```bash
node scripts/satori-useful-context.mjs \
  --tasks evals/useful-context/tasks.json \
  --observations /tmp/satori-useful-context-observations.json \
  --out /tmp/satori-useful-context-report.json \
  --json
```

An observation set records both `cold` and `warm` results for every committed task. Versions 2 and 3 record `sample`, `sourceReached`, nullable `callsToSource`, and `sourceMode` (`search_preview`, `read_file`, or `null`) so non-source tool calls are not mislabeled as source access. Version 3 result identities are tagged unions: symbol results contain `kind`, `file`, and `symbol`; file-level results contain only `kind` and `file`. Version 1 observations may contain an explicit source-evidence tuple. When `callsToSource` is non-null it must identify an actual call in `1..toolCalls`; legacy records without the tuple remain unknown rather than being inferred as source-backed.

```json
{
  "version": 3,
  "warmSampleCount": 1,
  "observations": [
    {
      "taskId": "find-search-handler",
      "phase": "cold",
      "sample": 0,
      "status": "ok",
      "latencyMs": 120,
      "contextBytes": 2048,
      "sourceReached": false,
      "callsToSource": null,
      "sourceMode": null,
      "response": { "status": "ok" },
      "results": [
        {
          "kind": "symbol",
          "file": "packages/mcp/src/core/handlers.ts",
          "symbol": "handleSearchCode"
        }
      ]
    },
    {
      "taskId": "find-search-handler",
      "phase": "warm",
      "sample": 1,
      "status": "ok",
      "latencyMs": 40,
      "contextBytes": 2048,
      "sourceReached": false,
      "callsToSource": null,
      "sourceMode": null,
      "response": { "status": "ok" },
      "results": [
        {
          "kind": "symbol",
          "file": "packages/mcp/src/core/handlers.ts",
          "symbol": "handleSearchCode"
        }
      ]
    }
  ]
}
```

The full observation set must contain exactly one cold observation and the declared number of numbered warm observations for every task. Exact-open tasks require a parser-derived expected span, an `ok` observation, and matching `openedSymbol` identity and boundaries. Caller recovery is derived from captured call-graph `nodes` and `edges`; the grader does not trust a separately claimed caller list. Stale-recovery evidence uses `staleIndexDetected` and `recoverySucceeded` where applicable.

## Metrics

The report includes owner-in-top-three, exact-open, caller-recovery, dirty-owner, and stale-recovery rates; zero-result and fallback rates; latency, UTF-8 payload bytes, context bytes, tool calls, and calls-to-source distributions; plus query-class latency and payload distributions. Recorder observations also retain the model-visible UTF-8 text-content bytes aggregated across measured tool responses and, for freshness/full search calls, structured readiness proof mode, invalidation reason, and operation counters. The recorder rejects a cold search without an exact recount and a warm search that does not prove receipt revalidation with zero recounts. Version 2 publishes separate `metrics.cold` and `metrics.warm` trees so increasing the warm sample count cannot reweight cold observations. Percentiles use deterministic nearest-rank semantics.

Task `baselineLimits` are optional regression gates. A configured gate failure is retained in the JSON report and makes the CLI exit with status 2. Context bytes count ordered result `content` and `preview` through the first expected owner; when the owner is absent, all returned result evidence counts. Later invocations do not add context after the owner has been reached. The committed corpus deliberately omits limits until a repeatable baseline has been measured; it does not invent absolute product budgets.

The main committed corpus contains source-read-only repeatable workloads. Its explicit preparation sync can update stale index chunks and always advances durable mutation receipts; those changes occur before timing and are recorded as provenance. Provider-backed caller recovery, dirty-file overlay, and stale-index recovery use the separate mutation-isolated fixture corpus below, so they do not mutate a user's index or source tree. Do not mix fixture observations into the clean-revision baseline or compare ad hoc prompts and one-sided cold/warm samples as a baseline.

## Mutation-Isolated Fixtures

The dedicated fixture recorder covers caller recovery, dirty-file owner discovery, and stale-index recovery in fresh temporary Git roots:

```bash
pnpm eval:useful-context:fixtures -- \
  --tasks evals/useful-context/fixture-tasks.json \
  --fixture-template evals/useful-context/fixture-repo \
  --out /tmp/satori-useful-context-fixture-observations.json
```

Each task copies the committed template into a separate `satori-useful-context-fixture-*` directory, initializes a Git repository, indexes only that temporary root, applies path-contained replacements, records cold and warm evidence, calls `manage_index clear`, and removes the directory. `--out` must be outside the Git checkout containing the fixture template. A failed clear leaves the exact temporary root in place and exits non-zero so remote cleanup remains mechanically possible. Traversal paths and non-unique replacements are rejected before mutation.

This command is explicit because it performs provider-backed create, sync, and clear operations and may consume embedding quota. It never mutates the source checkout or its index. Dirty-owner recording uses an explicit no-change sync in the same runtime to establish the process-local freshness throttle, then changes the fixture and invokes the exact workload for the first time. Its cold phase is therefore prepared workload-cold, not fresh-process latency. The measured search must return the expected owner with `freshnessDecision.mode=skipped_recent`, proving that an implicit sync did not service the call. Stale recovery is credited only when the runner-owned replacement is followed by a completed durable `sync` receipt with `syncStats.modified >= 1` and both recorded proof calls recover the expected owner; a warning, receipt alone, or inferred file change is not proof.

This harness is local evidence, not telemetry. Do not upload source, query text, paths, symbols, or observation files. Native bounded reads and tests remain the final proof for code changes.
