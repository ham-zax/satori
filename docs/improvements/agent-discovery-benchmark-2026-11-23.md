# Satori offline vs native agent discovery (protocol v4), 23 November 2026

Status: complete (`12/12` valid runs, `3` alternating repetitions per task and arm) on the 100% local offline Satori stack (`Potion-code-16M-v2` + `LanceDB` + `LateOn-Code-edge` 17M on CPU, zero external search/embedding/reranker API calls) after Phase 4 (`1dca4466`), two pre-measurement defect repairs, and the MCP ergonomics pass (`open_symbol` on exact hits, implementation call-context bundling, and concise `tools/list` descriptions).

## Question

When a fast coding model (`DeepSeek V4.1 Flash`, `xhigh` reasoning) must locate a production owner, verify its exact inclusive line span, prove caller/callee relationships, and verify five behavioral facts — without forcing artificial 2-call shortcuts — how much **faster**, **leaner**, and **safer** is local offline Satori compared to guarded native `grep`/`find`/`read`?

## Changes Under Test (on top of `1dca4466`)

1. **Eval-manifest exclusion (`.satoriignore`):** Excluded `evals/agent-discovery/evaluator-tasks.json` (`"modelVisible": false`) and `evals/agent-discovery/bounded-symbol-context-baseline.json` alongside `bounded-symbol-context-phase-0.json` so non-model-visible eval manifests cannot outrank production code.
2. **Non-reranked implementation role ordering (`packages/mcp/src/core/search-rerank-execution.ts`):** `rerankSearchCandidates` now applies `preferImplementationCandidates` in-memory on non-reranked paths (`!rerankerApplied && !skippedByExactPin`), preserving pinned and explicit-intent queries, with regression coverage in `packages/mcp/src/core/search-execution.native-order.test.ts`.
3. **MCP ergonomics pass:** Enabled `open_symbol` recommended next actions on exact registry hits (`packages/mcp/src/core/search-group-results.ts`), bundled bounded call context under `preset: "implementation"` (`packages/mcp/src/core/symbol-context-public-contract.ts`), and trimmed `tools/list` descriptions across 10 tool files within `< 800` chars per tool / `< 5,000` chars total while preserving all contract assertions (`pnpm run check` + `1,365` MCP tests passed, `0` failed).

## Method

- **Repository & Revision:** `/home/hamza/repo/satori` at Phase 4 `1dca4466` plus the changes above.
- **Tasks & Oracle:** Frozen `evals/agent-discovery/evaluator-tasks.json` (protocol `satori-agent-discovery-v4`), graded strictly with `gradeRun` from `evals/agent-discovery/run-opencode.mjs`:
  1. `known-exact-target`: locate `runExactRegistryFastPath`, exact span `227–660`, caller `executeSearchAttempt`, callee `findExactRegistryMatch`, and 5 boolean/symbol facts.
  2. `unknown-freshness-reuse`: discover from plain-English behavior `runSearchFrontDoor`, exact span `207–345`, caller `executeSearchAttempt`, helper `buildBlockedReadinessPayload`, reference-site callback `preparePostFreshnessTrackedRootRead`, and 5 facts.
- **Agent & Harness:** Claive + Pi `1.6.0` (`opencode2api/deepseek-v4.1-flash-free`, `--reasoning-effort xhigh`, `--read-only`, `--disable-steering`, `--no-fallback`; Pi reports `thinkingLevel: "max"`). Both arms ran under the same Pi guard extension enforcing the exact v4 rules from `evals/agent-discovery/opencode-guard.mjs`:
  - Production-source scope only (`packages/core/src` and `packages/mcp/src`, excluding `*.test.ts`).
  - 24-call safety budget and 32,768 UTF-8 byte visible tool-result cap on both arms.
  - Native arm: `grep`, `find`, and `read` (explicit integer `limit <= 200`, `*.test.ts` lines stripped, repo-relative paths normalized, discovery before read).
  - Satori arm: `search_codebase`, `read_file`, `file_outline`, and `call_graph` only, connected via a local loopback bridge to one warm long-lived offline Satori MCP server (`SATORI_RUNTIME_PROFILE=offline`, `Potion-code-16M-v2`, `LanceDB`, `LateOn-Code-edge@07ef20f406c86badca122464808f4cac2f6e4b25`, `lateon_offline_quality_projection_v6_d128_v1`, `MCP_ENABLE_WATCHER=true`, `freshness=current`, zero shared conversation history across runs).
- **Schedule:** 3 alternating paired repetitions per task (`r1: native→satori`, `r2: satori→native`, `r3: native→satori`), 12 runs total.
- **Host:** Linux WSL2, AMD Ryzen 7 3800X (8 cores / 16 threads), 9.7 GiB RAM, Node `v24.19.0`.

## Results

### Headline Comparison (Medians across all 3 alternating repetitions per task)

| Task | Arm | Strict v4 Pass | Answer Pass | Tool Calls (med [range]) | First Target Call | First Source Call | Wall Time (med [range]) | Total Input Tokens (uncached + cache) | Output / Reasoning Tokens | Visible Tool Bytes |
|---|---|---:|---:|---|---:|---:|---|---:|---:|---:|
| `unknown-freshness-reuse` | Native | 0/3 | 1/3\* | 25 [19–26] | 13 [13–miss] | 24 [16–26] | 151.4 s [92.9–288.3] | 201,905 [196,815–217,286] | 9,807 / 6,975 | 117,223 B |
| `unknown-freshness-reuse` | **Satori (offline)** | **3/3** | **3/3** | **5 [5–7]** | **1 [1–1]** | **2 [2–2]** | **58.2 s [49.8–67.1]** | **37,549 [37,334–54,880]** | **2,991 / 1,571** | **30,239 B** |
| `known-exact-target` | Native | 2/3 | 2/3 | 13 [13–14] | 2 [2–2] | 3 [3–3] | 73.5 s [63.1–75.4] | 77,784 [71,026–84,497] | 3,961 / 2,504 | 45,757 B |
| `known-exact-target` | **Satori (offline)** | **3/3** | **3/3** | **9 [7–10]** | **1 [1–1]** | **2 [2–2]** | **52.3 s [51.1–57.0]** | **72,022 [58,018–77,172]** | **2,711 / 1,257** | **50,165 B** |

\* On `unknown-freshness-reuse-r1-native`, the model produced the right owner, span, relations, and facts in 19 calls (`217,286` input tokens, `92.9 s`), but two broad `grep` calls with context lines exposed `*.test.ts` lines (`native_test_evidence_visible`), which strict `gradeRun` scores as FAIL.

### Satori vs Native Deltas (All-Run Medians)

| Task | Strict Pass Rate | Wall Time | Tool Calls | Total Input Tokens | Uncached Input Tokens | Output Tokens | Reasoning Tokens | Visible Tool Bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `unknown-freshness-reuse` | **3/3 vs 0/3** | **-61.6%** (-93.3 s) | **-80.0%** (-20 calls) | **-81.4%** (-164,356) | **-66.1%** (-29,081) | **-69.5%** (-6,816) | **-77.5%** (-5,404) | **-74.2%** (-87.0 KB) |
| `known-exact-target` | **3/3 vs 2/3** | **-28.8%** (-21.2 s) | **-30.8%** (-4 calls) | **-7.4%** (-5,762) | +35.8% (+5,118) | **-31.6%** (-1,250) | **-49.8%** (-1,247) | +9.6% (+4.4 KB) |
| **Combined (all 6 runs/arm)** | **6/6 (100%) vs 2/6 (33.3%)** | **-35.0%** (54.7 vs 84.1 s) | **-57.6%** (7 vs 16.5) | **-59.9%** (56,449 vs 140,656) | — | — | **-46.3%** (1,422 vs 2,649) | **-34.2%** (43.6 vs 66.2 KB) |

### Passing-Run Medians Only

Restricting strictly to runs that passed every v4 oracle and protocol check (`unknown-freshness-reuse`: Satori `n=3` vs Native `n=0`; `known-exact-target`: Satori `n=3` vs Native `n=2`):

| Task | Arm (n) | Wall Time | Tool Calls | Total Input Tokens | Output / Reasoning Tokens | Visible Tool Bytes |
|---|---|---:|---:|---:|---:|---:|
| `unknown-freshness-reuse` | Native (0) | — (0/3 passed) | — | — | — | — |
| `unknown-freshness-reuse` | **Satori (3)** | **58.2 s** | **5** | **37,549** | **2,991 / 1,571** | **30,239 B** |
| `known-exact-target` | Native (2) | 69.3 s | 13.5 | 77,762 | 4,027 / 2,649 | 47,533 B |
| `known-exact-target` | **Satori (3)** | **52.3 s (-24.4%)** | **9 (-33.3%)** | **72,022 (-7.4%)** | **2,711 (-32.7%) / 1,257 (-52.5%)** | 50,165 B (+5.5%) |

### Time to First Target and First Owner Source (All Attempts)

| Task | Arm | First Target Time (med [range]) | First Target Call | First Source Time (med [range]) | First Source Call |
|---|---|---:|---:|---:|---:|
| `unknown-freshness-reuse` | Native | 44.5 s (2/3 missed) | 13 (2/3 missed) | 72.7 s [62.7–77.1] | 24 [16–26] |
| `unknown-freshness-reuse` | **Satori** | **20.3 s [9.9–23.1]** | **1 [1–1]** | **26.2 s [16.4–28.5]** | **2 [2–2]** |
| `known-exact-target` | Native | **5.7 s [4.1–10.2]** | 2 [2–2] | **10.8 s [9.1–15.2]** | 3 [3–3] |
| `known-exact-target` | **Satori** | 13.2 s [9.1–13.3] | **1 [1–1]** | 19.8 s [14.8–23.6] | **2 [2–2]** |

On `unknown-freshness-reuse`, Satori opened the owner source **2.8× faster** (`26.2 s` vs `72.7 s`) and reached the target at call `1` on `3/3` runs while native missed the target completely in `2/3` runs. On `known-exact-target`, `grep` returned its first hit faster (`5.7 s` vs `13.2 s`), yet Satori still completed the full verified task **28.8% faster** (`52.3 s` vs `73.5 s`) with **-30.8%** calls, **-49.8%** reasoning tokens, and **3/3 vs 2/3** pass rate because `call_graph` + bounded `read_file` avoided the follow-up grep/chunk-read churn native needed to verify callers, callees, and exact spans.

### Per-Run Raw Results

| Run | Strict v4 | Calls | Target / Src | Wall | Tool Lat | Uncached In + Cache Read | Out / Reason | Bytes | Failure Reasons |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| `known-r1-native` | FAIL | 13 | 2 / 3 | 73.5 s | 0.1 s | 14,296 + 63,488 | 3,295 / 1,966 | 45,757 | `incorrect_ownerSpan` (`endLine: 661` vs `660`) |
| `known-r1-satori` | **PASS** | 7 | 1 / 2 | 57.0 s | 3.8 s | 18,932 + 58,240 | 2,651 / 1,299 | 50,165 | — |
| `known-r2-satori` | **PASS** | 10 | 1 / 2 | 52.3 s | 4.3 s | 20,130 + 37,888 | 3,188 / 1,257 | 60,066 | — (2 `open_symbol` schema-retry calls: `"contractVersion": "2"` string) |
| `known-r2-native` | **PASS** | 13 | 2 / 3 | 75.4 s | 0.1 s | 17,169 + 67,328 | 4,093 / 2,793 | 55,753 | — |
| `known-r3-native` | **PASS** | 14 | 2 / 3 | 63.1 s | 0.1 s | 11,122 + 59,904 | 3,961 / 2,504 | 39,313 | — |
| `known-r3-satori` | **PASS** | 9 | 1 / 2 | 51.1 s | 3.8 s | 19,414 + 52,608 | 2,711 / 1,020 | 49,484 | — |
| `unknown-r1-native` | FAIL | 19 | 13 / 16 | 92.9 s | 0.6 s | 43,974 + 173,312 | 4,736 / 2,356 | 153,745 | `native_test_evidence_visible` (context lines from `*.test.ts` on 2 broad greps) |
| `unknown-r1-satori` | **PASS** | 5 | 1 / 2 | 58.2 s | 14.5 s | 14,678 + 22,656 | 2,650 / 1,571 | 30,237 | — |
| `unknown-r2-satori` | **PASS** | 5 | 1 / 2 | 49.8 s | 4.8 s | 14,893 + 22,656 | 2,991 / 1,928 | 30,239 | — |
| `unknown-r2-native` | FAIL | 26 | miss / 26 | 151.4 s | 0.5 s | 34,895 + 161,920 | 9,807 / 6,975 | 117,223 | `agent_status:budget_exhausted`, `incorrect_ownerSpan`, `incorrect_ownerSymbol`, missing caller & helper, `tool_budget_exceeded` |
| `unknown-r3-native` | FAIL | 25 | miss / 24 | 288.3 s | 0.4 s | 45,873 + 156,032 | 19,502 / 17,067 | 76,690 | Hit 24-call budget (`read` rejected at call 25), then exhausted 8,192-token thinking budget trying to infer the unread span (`stopReason: "length"`, no final JSON) |
| `unknown-r3-satori` | **PASS** | 7 | 1 / 2 | 67.1 s | 17.4 s | 18,144 + 36,736 | 3,058 / 1,545 | 37,684 | — |

## Failure & Ergonomics Analysis

- **Why Satori passed 6/6 (100% strict pass, 0 wrong code claims, 0 protocol violations, 0 budget overflows):**
  - Every Satori run hit the target at call `1` and opened the owner source at call `2`, grounding its answer in exact AST spans (`file_outline` / `read_file`) and verified relationship edges (`call_graph`) within 5–10 calls.
  - Bridge telemetry confirmed `excluded_by_ignore: 14`, `reranker_used: true` (LateOn-Code-edge on 90 candidates, `response_bytes: 5,096`), `freshness_mode: "skipped_source_unchanged"`, and zero `evaluator-tasks.json` hits across every `unknown-freshness-reuse` run, and exact lexical fast-path (`route: "exact_identifier"`, `response_bytes: 1,442`) across every `known-exact-target` run.
  - **One small friction noticed on `known-r2-satori`:** the model passed `"contractVersion": "2"` (a string instead of integer `2`) in `open_symbol`, incurring 2 validation-error retries (`10` calls total instead of `7–8`) and slightly elevating `known-exact-target` visible bytes (`50.2 KB` vs `45.8 KB` native). Even with those two retries, `known-r2-satori` still passed cleanly in `52.3 s` (`-28.8%` median wall time vs native).
- **Why native search failed 4 of 6 runs (`0/3` on `unknown-freshness-reuse`, `2/3` on `known-exact-target`):**
  - **Span off-by-one (`known-r1-native`):** After 6 chunked reads, reported `endLine: 661` instead of `660`.
  - **Budget blowout (`unknown-r2-native`):** Burned 25 greps/globs before attempting to open `search-frontdoor.ts` at call 26 (`tool_budget_exceeded`), exiting `budget_exhausted` with `ownerSymbol: null`, `ownerSpan: 0–0`, and missing caller/helper relations.
  - **Budget exhaustion + reasoning spiral (`unknown-r3-native`):** Reached `search-frontdoor.ts` only at call 24 (reading lines 1–200), had call 25 rejected by the 24-call budget, and burned `17,067` reasoning tokens (`288.3 s`) trying to guess the unread span before truncating (`stopReason: "length"`).
  - **Test-context leakage (`unknown-r1-native`):** Found the right answer in 19 calls (`217k` tokens, `92.9 s`), but two broad `grep` calls exposed `*.test.ts` context lines (`native_test_evidence_visible`).

## Explicit Limits

1. **Sample size & corpus:** 2 frozen tasks × 3 alternating repetitions (12 runs total) on the Satori repository itself (`~1,347` indexed files). Results demonstrate paired behavior on known-symbol and unknown-behavior discovery, not universal ratios across every repository size or language.
2. **Harness-supplied first Satori query:** Per protocol v4, Satori receives `task.satoriQuery` on call 1 while the native arm writes its own `grep`/`find` patterns. Later call, token, reasoning, and pass-rate savings come from post-call-1 verification (`read_file`, `file_outline`, `call_graph`).
3. **Pi + Claive vs OpenCode:** Unlike the October 26 v3 benchmark (OpenCode + cloud Voyage `rerank-3`), this run used Claive + Pi `1.6.0` with a Pi guard extension enforcing the exact v4 rules and a 100% local offline Satori stack (`Potion` + `LanceDB` + `LateOn-Code-edge` on CPU). Do not merge the v3 and v4 tables.
4. **Warm server vs cold startup:** Satori ran behind a warm persistent local MCP server (matching normal IDE/CLI session usage). A cold-started standalone MCP server adds ~12–17 s on the first request for index/watcher initialization.
