# Performance tooling

Tools for measuring and profiling indexing, sync, embedding, and semantic
analysis. They are kept for reuse; nothing here runs in CI.

Run heavy commands memory-capped and one at a time, for example:

```bash
systemd-run --user --scope -q -p MemoryMax=7G -p MemorySwapMax=0 node scripts/perf/index-probe.mjs <repo>
```

Most tools load `packages/*/dist`, so build first:

```bash
pnpm --filter @zokizuan/satori-core build && pnpm --filter @zokizuan/satori-mcp build
```

## Built-in tracing

Set `SATORI_PERF_TRACE=1` on any Satori process to print one JSON line per timed
span to stderr, prefixed `[perf]`. It is off by default and costs nothing when off.

| Span | Where |
|---|---|
| `index.*` | Full-index phases: scan, payload pipeline, analysis wait, embedding, vector writes, finalize, navigation, publication |
| `navigation.semantic` | CBM semantic engine per language (full index and sync delta) |
| `navigation.resolution` | Resolution providers (TypeScript compiler) per language |
| `navigation.relationships`, `navigation.stage` | Relationship build and sidecar staging (full index) |
| `typescript.program`, `typescript.reference_authority`, `typescript.claims` | Per TypeScript project: program build, TS6305 check (`decision=fast` or `diagnostics`), call claims |
| `sync.*` | Edit-sync phases from the sync worker |

`packages/core/src/utils/perf-trace.ts` has `perfSpan` and `perfTrace` for adding spans.

## Tools

| Tool | Measures |
|---|---|
| `index-probe.mjs <repo> [--edit <file>] [--cpu-prof <dir>] [--log <file>]` | Full index (and optional one-file edit sync) through the built MCP server with tracing on; prints wall time and every span |
| `cpuprofile.mjs self\|inclusive\|subtree\|callers <profile> ...` | Summarizes `.cpuprofile` files from `--cpu-prof` |
| `potion-throughput.cjs helper <repo> [--batch N] [--mode serial\|pipelined] [--helper <bin>]` | Native Potion helper MB/s and CPU cores used |
| `potion-throughput.cjs client <repo> [--batch N]` | Embedding throughput through `PotionEmbedding`, as the indexer sees it |
| `potion-throughput.cjs parity <repo> <helperA> <helperB>` | Every vector and token count from two helper builds must hash equal |
| `potion-throughput.cjs texts <repo> <out.json>` | Chunk-sized texts for `experiments/potion-l0-l1/examples/components.rs` (tokenizer vs model vs JSON timings) |
| `analysis-parity.cjs <repo> [--workers N]` | Language analysis in-process vs worker pool: results must be identical; prints both timings |
| `semantic-engine-bench.cjs <repo> [lang] [ext] [--engine <js>]` | CBM semantic engine resolve time and a result hash (compare hashes across engine builds) |
| `build-named-semantic-engine.mjs <outDir>` | Engine copy with WASM function names for CPU profiles |

`scripts/bench-vs-cbm.mjs` is the end-to-end comparison against codebase-memory-mcp.

## Tunables

| Variable | Default | Effect |
|---|---|---|
| `SATORI_PERF_TRACE` | off | Timing spans on stderr |
| `SATORI_ANALYSIS_WORKERS` | cores - 1, max 8 | Language-analysis worker threads; `0` analyzes in-process |
