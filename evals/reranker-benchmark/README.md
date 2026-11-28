# Multi-Repo Offline Reranker Benchmark & Qualification Harness

Evaluates Satori's offline runtime (`Potion` + `LanceDB`) across 45 natural-language behavioral queries spanning three non-Satori repositories:

- `trufflehog` (Go)
- `tessera` (TypeScript/TSX)
- `claive` (Python + Rust)

## Explicit Freshness & Runtime Modes

`evals/reranker-benchmark/run.mjs` enforces explicit modes so benchmark comparisons never mix watcher or launcher settings:

- **`--freshness-mode production_watcher`** *(default)*: Enables `MCP_ENABLE_WATCHER=true`, matching production defaults (`packages/mcp/src/config.ts`). Avoids repeated per-query TypeScript control discovery and metadata walks.
- **`--freshness-mode conservative_scan`**: Disables the watcher (`MCP_ENABLE_WATCHER=false`) and labels the run separately. Never compare `production_watcher` against `conservative_scan` as a model-only speedup.
- **`--runtime-mode local`** *(default)*: Runs against `packages/mcp/dist/index.js` and **requires an explicit `--model-root`** (or `--potion-model-path` / `--lateon-model-path`). It never reads `~/.satori/bin/satori-mcp.js` or symlinks `~/.satori/models`.
- **`--runtime-mode installed`** *(or `--installed`)*: Runs the installed launcher under `~/.satori` explicitly.

## Usage

### Run the benchmark

```bash
pnpm build
node evals/reranker-benchmark/run.mjs \
  --freshness-mode production_watcher \
  --runtime-mode local \
  --model-root /abs/path/to/pinned-models \
  --repos trufflehog,tessera,claive \
  --arms offline-lateon,offline-none \
  --out /tmp/satori-reranker-benchmark-out
```

For installed runtime comparison:

```bash
node evals/reranker-benchmark/run.mjs \
  --freshness-mode production_watcher \
  --runtime-mode installed \
  --repos trufflehog,tessera,claive \
  --arms offline-lateon,offline-voyage-rerank-3-lite,offline-none \
  --out /tmp/satori-reranker-benchmark-out
```

### Run qualification gates & unit tests

```bash
pnpm run eval:reranker:qualify
node --import tsx --test \
  --test-reporter=./scripts/satori-test-reporter.mjs \
  evals/reranker-benchmark/run.test.mjs \
  evals/reranker-benchmark/contracts.test.mjs \
  evals/reranker-benchmark/qualify.test.mjs
```

## Metric Scopes & Provenance Guarantees

- **Same-request quality + freshness provenance:** Qualification capture runs one `search_codebase(..., debugMode: "full", debugCandidateLimit: 80)` request per query and extracts results, `freshnessMode`, `publicationId`, and `rerank` diagnostics from that exact response. Wall time is explicitly labelled `instrumentedFullDebugMs`.
- **Clean serving latency:** Optional `--clean-timing-repeats <N>` records clean serving latency in a separate `cleanTimingObservations` array and never borrows provenance from a debug call.
- **No denominator shrinking:** Failed, stale (`served_previous_generation`), or missing-freshness cases stay in `qualityCases` with `failed: true` and count as misses.
- **Exact-operation readiness:** `settleSync` tracks the exact operation ID returned by `manage_index sync`, rejects `failed`/`blocked`/`cancelled` immediately, recognizes explicit synchronous no-ops without inventing synthetic IDs, and enforces a bounded overall deadline.

## Recorded No-Go Decisions & Evidence

- **2026-11-26 baseline report:** [reranker-local-repos-benchmark-2026-11-26.md](../../docs/improvements/reranker-local-repos-benchmark-2026-11-26.md) (`docs/evidence/benchmarks/2026-11-26-reranker-3repo.json`).
- **2026-11-27 offline shootout & Ettin-17M sweep report:** [offline-reranker-shootout-2026-11-27.md](../../docs/improvements/offline-reranker-shootout-2026-11-27.md).
- **Artifact registry (`models.json`):** Evaluation-only manifest (`activationAllowed: false`). No tested replacement satisfied promotion gates (`LateOn-Code-edge` FP32 + `Potion` + shipped ranking policy remain retained).
