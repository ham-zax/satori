# Satori benchmarks

These runs measure different tasks and use specific repository snapshots, runtime builds, and hardware. Use each result with the method and limits in its linked evidence.

## Agent discovery

The November 23, 2026 paired run used Claive and Pi with DeepSeek V4.1 Flash at `xhigh`. It compared offline Satori with guarded native search on two frozen tasks, three alternating runs per arm per task. The Satori arm started with a warm local index and a harness-supplied first query. Times and token counts are all-run medians within each task.

| Task | Arm | Strict v4 Pass | Total input tokens | Reasoning tokens | Tool calls | Source call | Wall time |
|---|---|---:|---:|---:|---:|---:|---:|
| `unknown-freshness-reuse` | Native | 0/3 | 201,905 | 6,975 | 25 | 24 [16–26] | 151.4 s |
| | **Satori (offline)** | **3/3** | **37,549 (-81.4%)** | **1,571 (-77.5%)** | **5 (-80.0%)** | **2 [2–2]** | **58.2 s (-61.6%)** |
| `known-exact-target` | Native | 2/3 | 77,784 | 2,504 | 13 | 3 [3–3] | 73.5 s |
| | **Satori (offline)** | **3/3** | **72,022 (-7.4%)** | **1,257 (-49.8%)** | **9 (-30.8%)** | **2 [2–2]** | **52.3 s (-28.8%)** |

Across both tasks, Satori passed 6 of 6 strict v4 runs and the native arm passed 2 of 6. The results apply to this harness and task set. The [full v4 report](improvements/agent-discovery-benchmark-2026-11-23.md) includes passing-only medians and limitations. The [earlier v3 report](improvements/agent-discovery-benchmark-2026-10-26.md) used a different setup.

## Reranking

The November 26 comparison measured 30 behavior questions across Tessera and Claive on the same offline Potion and LanceDB index. First-ranked answers went from 12/30 without reranking to 19/30 with LateOn, 25/30 with Voyage `rerank-3`, and 28/30 with Voyage `rerank-3-lite`. The report describes the background sync that affected the separate TruffleHog results. [November 26 reranker benchmark](improvements/reranker-local-repos-benchmark-2026-11-26.md)

An earlier tuning run used 36 owner-finding tasks across six repositories and measured the effect of adding LateOn at a candidate depth of 32. The [evidence and limits](evidence/lateon-quality-20260804/) describe the tuning set and the projection used in that run.

| Stack | Owner at 1 | Owner at 3 | MRR |
|---|---:|---:|---:|
| Potion + BM25 + exact | 0.19 | 0.36 | 0.29 |
| + LateOn reranking (depth 32) | **0.39** | **0.64** | **0.50** |

A separate [named-symbol comparison](improvements/reranker-owner-investigation.md) went from 4 to 13 first-ranked owners across 19 questions when LateOn and definition fusion were enabled. Both arms found 15 owners in the top 10.

The following comparison used 28 plain-language questions across React, Polars, and FlatBuffers with the same Potion index. Each row has three runs. Times cover the reranking phase on one WSL2 laptop, including network latency for Voyage.

| Reranker | Right answer first | In top 5 | In top 10 | MRR | Rerank median |
|---|---:|---:|---:|---:|---:|
| LateOn (local, default) | 13/28 | 22/28 | 24/28 | 0.566 | 2.58 s |
| Voyage `rerank-3-lite` (Voyage default) | 23/28 | 27/28 | 27/28 | 0.881 | 1.03 s |

The comparison used build `fb125738`. A later behavior-term change was measured with Voyage `rerank-3` and moved one case to rank 1. The `rerank-3-lite` row is from the earlier build. For setup and data handling, see [choosing a reranker](REFERENCE.md#choosing-a-reranker).

### Alternative query terms

This tuning set used 46 questions across React, Polars, and FlatBuffers. Grounded terms helped with vocabulary that differed from the wording of the question. Terms taken from unrelated queries served as a stress test.

| `alt_terms` | Owner at 1 | Owner in top 10 | Median request |
|---|---:|---:|---:|
| None | 8 | 16 | 2.7 s |
| The agent's own guesses | **16** | **34** | 2.9 s |
| Another question's guesses (stress test) | 1 | 8 | 2.8 s |

See the [run details and label corrections](improvements/agent-alt-terms-definition-discovery.md).

### Local reranker performance

The offline React run reported 178 ms median retrieval on a 6,918-file index before reranking. In a separate WSL2 run on a Ryzen 7 3800X with 15 logical CPUs visible, an adaptive pool reduced median reranking time and used more memory.

| Measurement | One session (1 × 8 threads) | Adaptive pool (4 × 2) |
|---|---:|---:|
| Rerank 64 candidates (median of 3 runs) | 1.86 s | **1.22 s** |
| Plain-English question to ranked owners (46 questions, median) | 2.63 s | **2.24 s** |
| Rerank phase of those requests (median) | 2.12 s | **1.68 s** |
| Peak reranker memory | 0.53 GB | 1.64 GB |

## Satori versus codebase-memory-mcp

Five pinned repositories, two sequential runs each, measured on the same machine with [`scripts/bench-vs-cbm.mjs`](../scripts/bench-vs-cbm.mjs). Satori used build `3a438a96` with offline Potion, LanceDB, and LateOn. Codebase Memory used version 0.11.0. The ranges span two runs, with 20 unique called functions per repository.

| Repository | System | Full index | Symbol lookup (p50) | Callers (p50) | One-file edit |
|:---|:---|---:|---:|---:|---:|
| **satori** (TypeScript) | **Satori** | 42–46 s | **11 ms** | 21–24 ms | **13 s** |
| | CBM 0.11 | **20 s** | 29–30 ms | **20 ms** | 13 s |
| **trufflehog** (Go) | **Satori** | 42–55 s | 22–23 ms | 29–30 ms | **19 s** |
| | CBM 0.11 | **8.9–9.2 s** | **17–18 ms** | **15 ms** | 24–32 s |
| **ripgrep** (Rust) | **Satori** | 5.8 s | **8–9 ms** | 136–146 ms | 3.3 s |
| | CBM 0.11 | **2.8–2.9 s** | 13 ms | **13 ms** | **2.1–2.2 s** |
| **kotlinpoet** (Kotlin) | **Satori** | 5.9–6.7 s | **8.6–8.9 ms** | 171–172 ms | 3.3–3.4 s |
| | CBM 0.11 | **2.7–2.8 s** | 13 ms | **12.7 ms** | **2.1–2.2 s** |
| **fastapi-template** (Python + TS) | **Satori** | 5.9–8.0 s | **7.6–8.0 ms** | 189–192 ms | 3.9–4.0 s |
| | CBM 0.11 | **2.2 s** | 12.5 ms | **12.3 ms** | **2.0 s** |

Satori found a same-name definition in the defining file for 80–100% of sampled lookups. Its outlines covered 76–100% of Codebase Memory’s definitions across 30 sampled files per repository. Peak indexing RSS was 1.9–3.8 GB for Satori’s process tree and 0.1–1.7 GB for the Codebase Memory daemon. See the [committed results](evidence/benchmarks/2026-10-01.json) for the run data.
