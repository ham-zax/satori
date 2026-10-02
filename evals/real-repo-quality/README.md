# Real-repo search-quality check

Measures `search_codebase` (default `runtime` scope) on three pinned open-source repos using the
local workspace build (`packages/*/dist`), not an npm release. It records raw data (per-file parse
outcomes, index operation records, every status response, full top-10 results with query-plan
fields) and scores each query against the acceptable-owner sets in `cases.json`.

```bash
pnpm build                      # the check imports packages/*/dist
systemd-run --user --scope -p MemoryMax=4G -q node evals/real-repo-quality/run.mjs
# options: --repos react,polars,flatbuffers  --out DIR  --state-root DIR  --index-timeout-min N  --reuse-index
```

Requires the offline runtime installed (`satori install --runtime offline`): the script reuses the
model paths and provider settings from `~/.satori/bin/satori-mcp.js`, but runs the local MCP build
with its own state root (default `~/.cache/satori-eval-state`, models symlinked) and clones the repos
into `~/.cache/satori-eval-repos/<name>@<sha12>` (checks out the pinned commit and verifies it).
Results go to `~/.cache/satori-eval-results/<timestamp>/`, outside the repo: `result.json`,
`harness-log.json`, `fused-pool.json`, and Markdown summaries. Sequential `--repos` runs into
the same `--out` retain earlier repositories in all three JSON files; rerunning a repository
replaces its records. Each harness record and fused-pool query retains its own run provenance.
Harness latency records expose aggregate retrieval time as `retrievalMs`. Individual retrieval
passes and MCP fusion are unmeasured and recorded as `null`; missing timings are also `null`.
The client drains the server's stderr; an undrained pipe blocks the index worker on exit.

For publishable quality and latency evidence, use a fresh task-owned state directory after building:

```bash
node evals/real-repo-quality/benchmark.mjs --state-root /tmp/satori-benchmark-state --out /tmp/satori-benchmark-results
```

This keeps the existing cases and scorer, rejects dirty pinned checkouts, and records source,
runtime, model, and oracle hashes. It runs quality once, then repeats the first query of each
repository in three fresh MCP sessions, with three warm requests per session. Cold latency means
a fresh MCP process over an existing index, and does not imply an empty filesystem cache.
It records request-only and startup-inclusive cold latency separately, machine load, sampled
process-tree RSS, and debug phase timings. Symbol accuracy excludes queries with a file-only
acceptable answer; the overall hit metric permits file results according to the original oracle.
The wrapper writes `benchmark.json` plus `quality/{result.json,summary.md}`. Source, runtime, and
models must remain unchanged throughout the run. `--reuse-index` is suitable only for task-owned
indexes already built by the same implementation.
The local session uses profile and activation identities from the current CLI build while reusing
installed model paths; rebuild CLI together with core and MCP when those identities change.
For consecutive, frozen-build policy comparisons over unchanged retrieval indexes, use a new
output directory with `--reuse-index --quality-only --label <variant>`; this skips repeated latency
sessions and records the new implementation identity. Do not change the build during a run.
To measure a separate representative warm workload without adding it to the quality oracle,
combine `--quality-only` with `--latency-request-json <request-file>` and
`--latency-state-root <existing-task-index>`. The JSON contains ordinary `search_codebase`
arguments. This runs one warmup and three measured warm calls, records the checkout's full HEAD,
and labels the workload as unscored; it does not report a cold median.
