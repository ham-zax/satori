# LateOn reranking quality (2026-08-04)

What LateOn reranking adds on top of Satori's Potion + BM25 + exact retrieval,
measured on owner-finding tasks.

## Result

Six repositories, 36 owner-quality tasks, and 12 negative tasks. Each
repository has equal weight in the average. "Owner at k" means the symbol that
owns the asked-about behavior appears in the top k results.

| Stack | Owner at 1 | Owner at 3 | Owner at 10 | MRR | Hard negatives in top 3 |
|---|---:|---:|---:|---:|---:|
| Potion + BM25 + exact (no reranker) | 0.194 | 0.361 | 0.500 | 0.290 | 0 |
| + LateOn, projection v2, depth 16 | 0.361 | 0.611 | 0.694 | 0.484 | 0 |
| + LateOn, projection v1, depth 50 | 0.361 | 0.611 | 0.694 | 0.493 | 0 |
| **+ LateOn, projection v2, depth 32** | **0.389** | **0.639** | **0.694** | **0.505** | 0 |
| + LateOn, projection v2, depth 50 | 0.389 | 0.611 | 0.667 | 0.485 | 0 |

Reranking never changed which candidates were eligible. It only reordered them.

## Scope and limits

- These are tuning-set results. The planned held-out evaluation was never run,
  so generalization to other repositories is not proven.
- Satori ships LateOn at depth 32 by default. The shipped prompt projection has
  since moved from v2 to v4, and v4 has not been re-measured. Treat these numbers as
  evidence for the model and depth, not as a measurement of the exact current
  build.
- On the local WSL CPU profile, depth 32 measured a warm p95 of 1,378 ms and a
  peak RSS of 713 MiB. Disable reranking with
  `satori install --runtime offline --reranker none`.

## Setup

- Reranker: `lightonai/LateOn-Code-edge` at revision
  `07ef20f406c86badca122464808f4cac2f6e4b25`, FP32 ONNX, CPU.
- Repositories: `gitnexus`, `bookmark-ai-organizer`, `duas`, `vox-infinity`,
  `rpc`, `edge-tts-app`.
- Scores came from immutable candidate captures; the model did not run during
  replay or pagination.

## Reproduce the table

`artifacts.tar.gz` (SHA-256
`71faba8d308c239e9e49b029b363957662288ec1470876b2c9c796256fb168b1`) holds the
manifest, capture authority, score files, replays, and `result.json`.

```bash
mkdir -p /tmp/lateon && tar -xzf artifacts.tar.gz -C /tmp/lateon
jq -r '.summaries | to_entries[] | .key as $arm
  | [.value.repositoryQuality[]] as $r
  | [$arm,
     ([$r[].ownerAt1] | add / length),
     ([$r[].ownerAt3] | add / length),
     ([$r[].ownerAt10] | add / length),
     ([$r[].reciprocalRank] | add / length)] | @tsv' /tmp/lateon/track-l/result.json
```

The original qualification receipt is in Git history at
`d0314de2^:docs/evidence/deep-lateon-l3-20260804/L3_QUALIFICATION_RECEIPT.md`.
