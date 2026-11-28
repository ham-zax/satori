# Offline reranker shootout, Ettin-17M sweep, and Phase 1 qualification harness, 27 November 2026

Date: 2026-11-27  
Baseline checkout: `aa8a18a9` (`@satori-code/core@0.14.1`, `@satori-code/mcp@0.15.1`, `@satori-code/cli@0.12.1`)  
Host: AMD Ryzen 7 3800X (8C/16T, AVX2), 9.71 GiB RAM, WSL2 Linux x64, Node v24.19.0, `onnxruntime-node@1.30.0`.  
Raw disposable artifacts: `/tmp/satori-offline-shootout/results.json` (`612.7 MB`, `sha256: 4262dd112eee1647ce716b4457f4a43db956b1aebe93a9f7a15f01c94f1dfcb9`, 244 result files + 5 corpora), plus `/tmp/satori-offline-shootout/results/ettin17-and-depth-sweep.json`, `/tmp/satori-offline-shootout/results/ettin-cap512-check.json`, and `/tmp/satori-offline-shootout/results/live-ab-leads-2026-11-28.json`.

## Executive decision

**Retain the shipped offline default** (`minishlab/potion-code-16M-v2` + `search_rerank_document_v5` + `lightonai/LateOn-Code-edge` FP32 + shipped ranking policy). No tested replacement met the promotion gates (preserve all 30/45 strict baseline wins, maintain Hit@5 >= 43/45, warm novel p50 <= 800 ms, inference RSS <= 500 MB, and bounded whole-service memory).

**Phase 1 shipped in this repository** upgrades `evals/reranker-benchmark/` so every future shootout has:
1. Explicit freshness modes (`production_watcher` default vs `conservative_scan`) and runtime isolation (`local` with explicit `--model-root` vs `installed`).
2. Exact-operation readiness (`settleSync`, `ensureIndexed`) with bounded setup deadlines and terminal failure rejection.
3. Same-request quality + freshness provenance (`debugMode: "full"` in one call, separate optional clean timing).
4. Automated qualification gates (`contracts.mjs`, `models.json`, `qualify.mjs`, `fixtures/qualification-v1.json`) that catch AVX2 INT8 collapse, missing cross-encoder heads, dropped `[SEP]` truncation bugs, protected-win swaps, partial arms, omitted RSS, and cross-platform transfers.

Two new follow-up experiments also surfaced an important discovery: **`ettin-reranker-17m-v1` degrades sharply above 512 tokens**, and restricting it to `cap=512` on `search_rerank_document_v5` lifts raw Strict Hit@1 from `14/45` (`cap=768`) to **`22/45`** and replay policy Hit@1/Strict Hit@1 to **`33/45` / `31/45`** in **`409–488 ms` p50** (and cutting FP32 `LateOn-Code-edge` depth from `128 → 24` improves replay MRR `0.8093 → 0.8365` at ~`643 ms` estimated p50). Both remain unverified in full live MCP grouping and on held-out repos.

---

## 1. Resolution of the three architectural pushbacks

### A. Non-reranker latency gap (`tessera` vs `claive`): benchmark watcher bug, not navigation storage

The earlier benchmark forced `MCP_ENABLE_WATCHER='false'` in `evals/reranker-benchmark/run.mjs`, whereas production defaults to `MCP_ENABLE_WATCHER='true'` (`packages/mcp/src/config.ts:490–493`). Across **270 clean requests** (45 queries × 3 repeats × 2 modes, zero stale reads):

| Repository | Watcher disabled (`conservative_scan`) p50 / p95 | Watcher enabled (`production_watcher`) p50 / p95 |
|---|---:|---:|
| `tessera` (TS/TSX) | 284.09 / 302.34 ms | **80.26 / 94.36 ms** |
| `claive` (Py+Rust) | 108.86 / 156.78 ms | **51.69 / 81.38 ms** |
| `trufflehog` (Go) | 602.05 / 636.87 ms | **102.41 / 117.25 ms** |

Exclusive span attribution (98.56% / 96.65% wall-time closure on `tessera` / `claive`) traced the watcher-off overhead to per-query TypeScript control-file discovery RPC (`95.60 ms` mean on `tessera`, `0.00 ms` on `claive`) plus unchanged source-tree walks (`35.16 ms` / `25.10 ms`). Navigation/registry lookup was `0.30 ms` / `0.29 ms`. **Verdict:** no Rust navigation-storage rewrite is warranted; fix the benchmark default to `production_watcher`.

### B. Full publication-time LateOn encoding vs lazy persistent cache

Unbiased 288-owner throughput probe (96 owners/repo × 3 passes, tokenization + ONNX + normalization only):

| Configuration (Repaired Edge INT8) | `trufflehog` ms/doc `[measured]` | Peak RSS `[measured]` | 17,931 owners `[extrapolated]` | 26,000 items `[extrapolated]` |
|---|---:|---:|---:|---:|
| `cap=512`, 1 session × 4 threads | 12.70 ms | 264.52 MiB | 227.7 s | 330.2 s |
| `cap=768`, 1 session × 4 threads | 19.83 ms | 290.97 MiB | 355.5 s | 515.5 s |
| `cap=512`, 4 workers × 2 threads | 7.84 ms | 660.38 MiB | 140.7 s | 203.9 s |

Full `trufflehog` Potion index creation took **21.19 s** `[measured]`; eager LateOn precomputation would inflate indexing by **10–25×**. A query-blind graph-centrality hot seed (384 owners, `5.95 s` prep) hit only `4.16%` of candidates and cost **53.97 s** total vs **50.74 s** for empty lazy Q8 caching (`2,490` encodings in `36.65 MB` logical / `42.04 MB` allocated; fresh-process reopen hit `61.13 ms` p50 with zero rank/score drift). **Verdict:** reject eager publication precompute and hot-owner seeding; retain lazy content-addressed persistence as a future primitive once a qualified query-independent packet + model wins accuracy.

### C. Critical artifact & runtime findings

1. **Upstream `LateOn-Code-edge` INT8 (`eac35bda...`) collapsed numerically on Ryzen AVX2:** Scored **0/45 Hit@1** (`unrelatedQueryCosineMax > 0.9999`, `alignedTokenCosMean = 0.695`). Shifting the 30 signed `MatMulInteger` weight tensors + zero points by `+128` to `UINT8` (`dae58a14...`) restored exact dequantized weights and cosine geometry (`0.961`), confirming an AVX2 `U8S8` saturation issue under `onnxruntime-node@1.30.0`, though repaired INT8 still trailed FP32 in accuracy.
2. **Ettin ONNX graphs omit the scoring head and Transformers.js drops terminal `[SEP]` on truncated pairs:** Both `ettin-reranker-32m-v1` (hidden 384) and `ettin-reranker-17m-v1` (hidden 256) emit `last_hidden_state` only; fusing `CLS -> Linear(no bias) -> GELU(exact erf) -> LayerNorm(eps=1e-5) -> Linear(bias)` achieved PyTorch parity within `2.86e-6` (32M) and `7.63e-6` (17M) across 32 real pairs, and truncating A/B before `[CLS] A [SEP] B [SEP]` achieved 32/32 exact token-ID parity (plus 102/102 fixtures).
3. **Whole-service RAM ceiling:** Even `offline-none` with watcher enabled consumed `1,264–1,859 MiB` summed RSS across the process tree (`main` + standby + Potion). Sub-500 MB inference child RSS alone does not satisfy a sub-500 MB service budget.
4. **Forked Node RPC overhead is tiny (`1.01 ms` p50 / `1.43 ms` p95):** No Rust rewrite is justified for IPC overhead. However, `onnxruntime-node`'s `session.run` executes synchronously inside `setImmediate`, so parallel sessions must live in separate worker threads (not `Promise.all` on one JS thread: `20.86 ms/doc` vs `7.84 ms/doc`).

---

## 2. Clean 45-query shootout summary (`trufflehog` + `tessera` + `claive`)

Stage-1 Potion admitted **45/45** broad and **44/45** strict accepted owners (only `th13` absent), with **42/45** strict owners already inside **Stage-1 top 12** and **43/45** inside **Stage-1 top 24**.

| Arm (all `[measured]`, out of 45) | Hit@1 | Strict Hit@1 | Hit@5 | MRR@10 | p50 / p95 ms | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| **A: Shipped FP32 Edge + legacy policy** *(control)* | **30** | **30** | **43** | **0.7944** | 2,482 / 3,550 *(watcher off, debug)* | 2,869 MiB tree |
| A: FP32 Edge, `v5`, raw | 19 | 14 | 38 | 0.6180 | 2,354 / 3,690 *(model only)* | 591.4 MiB |
| B: Upstream Edge INT8, packet, `cap=512` | 0 | 0 | 6 | 0.0896 | 1,059 / 1,801 *(model only)* | 358.8 MiB |
| B*: Repaired U8U8 Edge INT8, packet, `cap=512` / `768` | 15 / 17 | 14 / 15 | 31 / 32 | 0.4911 / 0.5336 | 1,035 / 1,444 *(model only)* | 361 / 394 MiB |
| C: Ettin-32M (`cap=768`), B* top-12 / top-16 | 19 / 18 | 15 / 14 | 33 / 35 | 0.5627 / 0.5533 | 603 / 806 *(CE only)* | 363 / 370 MiB |
| C: Ettin-17M (`cap=768`), B* top-16 | 18 | 12 | 39 | 0.6061 | 330 / 492 *(CE only)* | 344.3 MiB |
| D: LateOn-Code 149M INT8 (`cap=768`), B* top-16 | 24 | 17 | 42 | 0.7074 | 3,845 / 5,731 *(model only)* | 639.6 MiB |
| E: `blink-code-16M` Stage-1 only (ties Potion strict 19/45) | 20 | 19 | 37 | 0.6127 | 470 / 809 *(stubbed)* | 1,985 MiB tree |
| **Live Combined: Ettin-17M (`cap=768`, S1 top-12, chunk) + legacy policy** | **30** | **30** | 40 | 0.7741 | **454 / 613** *(watcher on, clean)* | **264.5 MiB child** (2,141 MiB tree) |

*Leave-one-repo-out 5-feature owner scorer:* Every neural arm lost 4–13 protected wins when replacing the shipped ranking policy (best was Arm A features at `31/45` strict Hit@1 with `4` protected losses). The shipped policy lifts raw LateOn `14 → 30` and raw Ettin-17M `15 → 30`, so wholesale deletion is rejected.

---

## 3. Follow-up discovery: Ettin-17M `cap=512` sweet spot & LateOn FP32 depth sweep

Prompted by Stage-1 top-12/24 recall (`42–43/45`), two additional sweeps ran on the frozen 45-query corpus (`results/ettin17-and-depth-sweep.json`, `results/ettin-cap512-check.json`, `applyRerankOrder` + owner-collapsed replay, 1 session × 4 threads):

### A. Ettin-17M / Ettin-32M sequence-cap & format sweep (Stage-1 direct top-K)

| Variant (`[measured]` model time, replay policy) | Raw Hit@1 / Strict / Hit@5 | Raw MRR | Replay Policy Hit@1 / Strict / Hit@5 | Replay MRR | Model p50 / p95 |
|---|---:|---:|---:|---:|---:|
| **`ettin17`, `v5`, `cap=512`, top-12** | **28 / 22 / 42** | **0.7551** | 32 / 30 / 42 | 0.8058 | **247 / 317 ms** |
| **`ettin17`, `v5`, `cap=512`, top-16** | **29 / 21 / 42** | **0.7626** | 32 / 30 / 42 | 0.8095 | **327 / 432 ms** |
| **`ettin17`, `v5`, `cap=512`, top-20** | 28 / 20 / 41 | 0.7428 | **33 / 31 / 42** | **0.8206** | **409 / 539 ms** |
| **`ettin17`, `v5`, `cap=512`, top-24** | 27 / 19 / 41 | 0.7238 | **33 / 31 / 42** | **0.8239** | **488 / 645 ms** |
| `ettin17`, `v5`, `cap=384`, top-16 | 24 / 15 / 42 | 0.7063 | 31 / 29 / 41 | 0.7928 | 370 / 523 ms |
| `ettin17`, `v5`, `cap=768`, top-12 | 21 / 14 / 42 | 0.6585 | 30 / 28 / 42 | 0.7891 | 351 / 504 ms |
| `ettin17`, `chunk`, `cap=512`, top-20 | 25 / 17 / 42 | 0.7046 | 32 / 30 / 41 | 0.8096 | 339 / 513 ms |
| `ettin17`, `chunk`, `cap=768`, top-20 | 23 / 14 / 41 | 0.6787 | 32 / 29 / 41 | 0.8115 | 461 / 785 ms |
| `ettin32`, `v5`, `cap=512`, top-12 | 25 / 16 / 43 | 0.7219 | 29 / 28 / 42 | 0.7775 | 757 / 1,304 ms |
| `ettin32`, `v5`, `cap=512`, top-20 | 26 / 16 / 43 | 0.7254 | 30 / 29 / 42 | 0.7850 | 1,221 / 2,204 ms |

**Key takeaway:** Running `ettin-reranker-17m-v1` at **`cap=512` on `v5`** jumps raw Strict Hit@1 by **+8** (`14 → 22`) and raw MRR by **+0.10** (`0.6585 → 0.7551`) over `cap=768`, and even beats `ettin-reranker-32m-v1` at `cap=512` while running **3× faster**. In replay at `top-20/24`, it gained 5 strict wins (`th4`, `th9`, `ts6`, `cl1`, `cl12` — including `cl12`, which Voyage-3-lite missed) against 2 true non-artifact losses (`ts14`, `cl3`; `th1` and `th3` were replay-grouping artifacts also shown on FP32 `depth=128`).

### B. LateOn-Code-edge FP32 Stage-1 depth sweep (replay)

| Depth (FP32 Edge on `v5`) | Raw Hit@1 / Strict / Hit@5 | Replay Policy Hit@1 / Strict / Hit@5 | Replay MRR | Proportional Model p50 `[extrapolated]` |
|---|---:|---:|---:|---:|
| `top-12` | 22 / 15 / 42 | 32 / 29 / 42 | 0.8161 | ~324 ms |
| `top-16` | 22 / 14 / 41 | 32 / 29 / 42 | 0.8185 | ~430 ms |
| **`top-24`** | 20 / 14 / 42 | **33 / 30 / 42** | **0.8365** | **~643 ms** |
| `top-32` | 20 / 14 / 40 | 31 / 29 / 43 | 0.8156 | ~856 ms |
| `top-128` *(current)* | 19 / 14 / 38 | 31 / 29 / 44 | 0.8093 | 2,235 ms `[measured]` |

Reducing candidate depth from `128 → 24` eliminates noisy tail false positives while cutting model work ~3.5×.

### Limitations & live end-to-end MCP A/B verification (28 November 2026)

Because replay used `applyRerankOrder` + owner-collapsed scoring rather than full MCP `finalizeSearchResults` grouping, we immediately ran all four arms live end-to-end through `packages/mcp/dist/index.js` under matched **`production_watcher`** (`MCP_ENABLE_WATCHER=true`, `debugMode="full"`, fresh MCP session per repo per arm, zero failed queries, zero stale reads, zero leaked child PIDs; `/tmp/satori-offline-shootout/results/live-ab-leads-2026-11-28.json`):

| Live MCP Arm (`[measured]`, `production_watcher`, `debugMode=full`, 45 queries) | Hit@1 | Strict Hit@1 | Hit@5 | Strict Hit@5 | MRR@10 | Strict MRR | Full-Debug p50 / p95 | Inference Child RSS | Tree RSS | Diff vs `d128` (strict@1) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **`lateon-fp32-d128`** *(shipped control)* | 28/45 | 28/45 | **43/45** | **41/45** | 0.7685 | 0.7556 | 2,538 / 3,723 ms | 928.2 MiB | 2,865.6 MiB | baseline |
| **`lateon-fp32-d24-native`** *(FP32 Edge, `getMaxDocuments=24`)* | 30/45 | 30/45 | 41/45 | 40/45 | 0.7889 | 0.7778 | 894 / 1,262 ms (`2.84×`) | 740.3 MiB | 2,557.1 MiB | `-1` (`th8`→2), `+3` (`ts4, ts6, ts7`) |
| **`ettin17-v5-c512-d20-native`** *(Ettin-17M AVX2, `v5`, `cap=512`, `depth=20`)* | **32/45** | 31/45 | 42/45 | 40/45 | **0.8119** | 0.7852 | **702 / 830 ms (`3.62×`)** | **241.1 MiB (`3.85×`)** | 2,147.7 MiB | `-2` (`ts14`→2, `cl3`→2), `+5` (`th4, ts6, ts7, cl1, cl12`) |
| **`ettin17-v5-c512-top20-fullpool`** *(Ettin-17M AVX2, `v5`, `cap=512`, top-20 over full pool)* | **32/45** | **32/45** | 42/45 | 40/45 | **0.8119** | **0.7963** | 774 / 976 ms (`3.28×`) | **243.7 MiB (`3.81×`)** | **2,095.2 MiB** | `-2` (`ts14`→2, `cl3`→2), **`+6`** (`th4, th9, ts6, ts7, cl1, cl12`) |

Per-repository live strict Hit@1 (`d128` → `d24` → `ettin17-d20` → `ettin17-top20-fullpool`):
- **`trufflehog` (Go):** `9/15` → `8/15` → `10/15` → **`11/15`** (`mrr 0.7611 → 0.8022`)
- **`tessera` (TS/TSX):** `8/15` → **`11/15`** → `9/15` → `9/15` (`mrr 0.6778 → 0.7333`)
- **`claive` (Py+Rust):** `11/15` → `11/15` → **`12/15`** → **`12/15`** (`mrr 0.8667 → 0.9000`)

**Live A/B verdict:**
- **`ettin-reranker-17m-v1` (`v5`, `cap=512`, `top-20`)** is a genuine, live-verified breakthrough over shipped `LateOn-Code-edge` FP32: **+4 Hit@1 / +4 Strict Hit@1 (`62.2% → 71.1%`)**, **+0.0434 MRR**, **3.3–3.6× faster p50** (`702–774 ms` *including* `debugMode="full"` overhead), and **3.8× lower inference-child RSS** (`241–244 MiB` vs `928 MiB`), beating shipped LateOn on all three repos with only two minor rank `1 → 2` shifts (`ts14`, `cl3`) and zero misses introduced from top-2.
- **Why not promoted yet:** It remains below the aggressive `39/45` (85%+) / zero-protected-loss gate, dropped 1 Hit@5 (`43 → 42`, `th15`), and has not yet been qualified on held-out `evals/real-repo-quality/` repositories or on Linux ARM64.
- **Next step:** Qualify `ettin-reranker-17m-v1` (`v5`, `cap=512`, `top-20`) and `LateOn-Code-edge` FP32 (`depth=24`) on held-out `evals/real-repo-quality/` (`react`, `polars`, `flatbuffers`, `gin`, `flask`) and Linux ARM64 before deciding whether to ship either as an opt-in or default offline profile.
