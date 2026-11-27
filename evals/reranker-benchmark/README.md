# Multi-Repo Offline Reranker Benchmark

Compares Satori's offline runtime (`Potion` + `LanceDB`) across four query-time reranker configurations on 45 natural-language behavioral queries spanning three non-Satori repositories:

- `trufflehog` (Go)
- `tessera` (TypeScript/TSX)
- `claive` (Python + Rust)

## Usage

```bash
pnpm build
node evals/reranker-benchmark/run.mjs \
  --repos tessera,claive \
  --arms offline-none,offline-lateon,offline-voyage-rerank-3,offline-voyage-rerank-3-lite \
  --out /tmp/satori-reranker-benchmark-out \
  --installed
```

- Requires the offline runtime models installed under `~/.satori/models` (`satori install --runtime offline`).
- For Voyage arms, set `VOYAGEAI_API_KEY` in `~/.satori/.env` or the environment.
- Uses per-repository isolated `SATORI_STATE_ROOT` directories so background sync for one repository never interferes with queries on another.
- Recorded baseline report: [reranker-local-repos-benchmark-2026-11-26.md](../../docs/improvements/reranker-local-repos-benchmark-2026-11-26.md) and raw output in `docs/evidence/benchmarks/2026-11-26-reranker-3repo.json`.
