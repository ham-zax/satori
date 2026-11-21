# Phase 4 Plan — Ranking Authority, Projection Speed & Flash-Model Handoff, 21 November 2026

Sequenced plan synthesized from the 5-repository offline measurements (`react`, `flatbuffers`, `polars`, held-out `gin` and `flask`), four structured thinking passes (`first-principles`, `pre-mortem`, `inversion`, `concept-fan`), and read-only architectural counsel from `gpt-6.2-sol` (`xhigh`, Claive worker `117df06358b8`).

## Governing Rules & Pre-Flight Gate

- **Pre-Flight Gate (Slice 4.0 — Review Bug Remediation):** Resolve and regression-test the 7–8 review bugs identified in the uncommitted Phase 1–3 working tree **before** starting any Phase 4 slice.
- **One variable at a time:** Every slice has a named owner, a falsifying kill test, and a hard ship gate.
- **No overfitting to `gin` / `flask`:** `gin` and `flask` are now regression controls because their failures were inspected; qualifying any new ranking or handoff policy requires fresh tasks or `evals/agent-discovery/run-opencode.mjs`.
- **Keep definition discovery for candidate admission:** Never remove `symbol_metadata_bm25` candidate admission while evaluating post-rerank ordering.

---

## Kill / Keep / Defer Verdicts (From Counsel & Thinking Passes)

| Proposal | Verdict | Why (Evidence & Mechanism) |
|---|---|---|
| **Fix/replace post-LateOn BM25 vote in `fuseDefinitionDiscovery`** | **KEEP (Slice 4A — replay first)** | With `K=60`, provider rank `#6` + definition rank `#1` (`0.03154`) beats provider rank `#1` abstaining behind 20 lexical matches (`0.02874`), letting incidental matches overturn LateOn's `#1` (`gin/g2`, `gin/g5`, `flask/f12`). Stemming alone changes who gets the vote without fixing excessive vote authority. Must test raw LateOn order **without** the `rerank_blend` confound first. |
| **Manifest / package-metadata focus routing (`flask/f15`)** | **KEEP (Slice 4A — separate from route)** | `pyproject.toml` already reached `mcp_filtered #1`, then `"implementation"` focus omitted it. Fix `resolveSearchAnswerFocus` (`search-answer-focus.ts`) for build/package/dependency declaration intent without altering the sparse-only `configuration` route in `search-query-planning.ts`. |
| **`selectRerankSourceWithinBudget` upper-budget one-shot fast path** | **KEEP (Slice 4B)** | 125/128 real React docs fit on attempt 1 (`212 ms → 39 ms`, `5.5×`), but 3/128 diverged when unbounded. Provably safe only when `completeSymbolReturned === true`, outer 4,000-byte JSON fits, and inner serialized-source budget matches existing binary search; bounded excerpts keep binary search. |
| **Default top-2 inline structural-neighbor dump & label-only dedup** | **KILL** | Rerank projection only holds `(path, label)` references and can use bounded windows (unsuitable as public context); `48 KiB` disclosure evicts whole groups before trimming previews; same-name declarations can have distinct bodies/bindings (`search-group-ordering.ts` already owns proven wrapper collapse); a neighbor list gives Flash models another selection problem instead of solving it (`flask/f4` `save_session` lives on `SecureCookieSessionInterface`, not `SecureCookieSession`). |
| **Make the 2nd call (`recommendedNextAction`) exact & compare against 1 minimal inline body excerpt** | **KEEP (Slice 4C)** | `recommendedNextAction` currently grabs the first actionable hit (and can fall back to plain span reads). Steering it to the highest-ranked verified executable target in the winning file (or one proven delegation edge) and A/B-testing that against a single post-disclosure, budget-safe inline body excerpt directly attacks the 5–7-tool-call loop on Flash models. |
| **Disk-backed persistent LateOn `documentCache`** | **DEFER TO LAST (Slice 4D — measure restarts first)** | Still pays worker startup after idle shutdown + query encode on new queries (so `85 ms` warm is not the restart target). Must stay `Float64` (ONNX emits `Float32` but normalization produces `Float64`; storing `Float32` breaks bit-identity), key on full encoding fingerprint + document bytes, and enforce parent-dir safety + atomic writes + quota + silent miss fallback. |
| **Idle background pre-warming of LateOn vectors** | **KILL** | Adds background CPU/RAM contention and lifecycle complexity before restart cache ROI is even proven. |

---

## Sequenced Implementation Plan

### Slice 4.0 — Pre-Flight: Fix Phase 1–3 Review Bugs (Blocker Gate)
- **Scope:** Apply targeted, root-cause repairs and deterministic regression tests for the review bugs found in the current uncommitted working tree.
- **Verification:** Focused tests for every fixed bug + `pnpm run check` (and full `pnpm test` once bugs are cleared).
- **Gate:** Zero open review defects; clean baseline ready for Phase 4.

---

### Slice 4A — Ranking Authority Replay & Manifest Focus Repair
- **Owners:** `packages/mcp/src/core/search-rerank-execution.ts`, `packages/mcp/src/core/search-definition-discovery.ts`, `packages/mcp/src/core/search-answer-focus.ts`.
- **Confound trap to avoid:** `SATORI_SEARCH_FLAGS=no-definition_discovery` disables metadata **admission** (`search-execution.ts:1060`) AND lets LateOn's default 50/50 `rerank_blend` activate (`search-rerank-execution.ts:579`). A valid test must hold the **exact same admitted candidate pool and provider scores** fixed.
- **Steps:**
  1. **Frozen-pool replay harness:** Capture/replay identical `reranker_input` + `reranker_provider_output` scores across the 58-query 5-repo set under:
     - Raw LateOn provider order (no definition fusion, no `rerank_blend`, keeping existing explicit role/intent constraints).
     - Current `fuseDefinitionDiscovery` (with and without explicit polyglot language affinity evaluated on the original query).
     - Current LateOn 50/50 `rerank_blend`.
     - **Only if replay shows repeatable losses from pure provider order:** bounded score-residual adjustment `s_i + ε·e_i` (`e_i ∈ [0, 1]`, zero for incidental matches, guaranteeing any provider lead `> ε` survives; no raw MaxSim margin threshold because MaxSim sums across variable query-token counts).
  2. **Separate manifest-intent fix:** Update `resolveSearchAnswerFocus` in `packages/mcp/src/core/search-answer-focus.ts` to recognize package/build/dependency declaration queries as `"configuration"` focus before generic implementation cues (without routing them to the sparse-only `configuration` retrieval route).
  3. **Run the winning policy end-to-end through MCP** and verify existing controls (exact, reference, language, manifest, and all `search-definition-discovery.test.ts` / `search-ranking-policy.test.ts` contracts).
- **Ship gate:** Improves strict symbol `hit@1` with **zero new accepted-owner misses at top-10** across the 58-query set; `gin`/`flask` serve as regression controls; qualify final policy on fresh queries/tasks.

---

### Slice 4B — Bit-Identical `selectRerankSourceWithinBudget` One-Shot Fast Path
- **Owners:** `packages/mcp/src/core/search-rerank-projection-primitives.ts`, `packages/mcp/src/core/bounded-source-selector.ts`.
- **Steps:**
  1. Investigate the exact 3/128 divergent React documents from the earlier probe (JSON escaping expansion, inner `maxSerializedSourceBytes` vs. outer 4,000-byte JSON budget, line-ending/UTF-8 boundaries).
  2. Implement the fast path: try `upperBudget` first and short-circuit **only** when `selection.status === "selected"`, `selection.source.completeSymbolReturned === true`, and `Buffer.byteLength(candidateText, "utf8") <= MAXIMUM_UTF8_BYTES` (proving the existing binary search would converge to the identical complete excerpt). Fall back to exact binary search for any truncated/bounded excerpt.
  3. Verify `search-rerank-document.test.ts:100` (`selectionAttemptCount > 1` on a bounded fixture) and add a differential test across all 128 real React documents + UTF-8/escaping boundary cases asserting **0/128** document or SHA-256 diffs.
- **Ship gate:** **Zero** `search_rerank_document_v5` document or SHA-256 differences; **≥50% reduction** in projection median latency on the same workload; no fallback p95 regression.

---

### Slice 4C — Flash/Small-Model Evidence Handoff (Measured on Agent Discovery)
- **Owners:** `packages/mcp/src/core/search-response-helpers.ts` (recommended action), `packages/mcp/src/core/search-group-ordering.ts` (proven wrapper equivalence; trace React `r3` before touching diversity caps), `packages/mcp/src/core/search-disclosure.ts` & `packages/mcp/src/core/search-response-envelopes.ts` (only if inline excerpt proves necessary).
- **Steps:**
  1. **Trace `r3` first:** Inspect why `collapseEquivalentImplementationGroups` did not collapse the repeated `ReactFiberHooks.js::useEffect` dispatcher stubs before considering any grouping change.
  2. **Upgrade `recommendedNextAction` (zero schema change):** When the top-ranked result is a coarse target (file/class/struct or plain span), select the best already-ranked, verified executable target in the winning file (or allow one proven delegation edge to an eligible implementation; leave ambiguous cases alone). If the executable target never entered the provider window, inspect `search-file-symbol-supplement.ts` before adding extra lookups.
  3. **Controlled 3-arm A/B on `evals/agent-discovery/run-opencode.mjs`** (letting the Flash model formulate its own first query):
     - Arm 1: Current `search_codebase` response.
     - Arm 2: Upgraded exact `recommendedNextAction` handoff (2-call sufficiency).
     - Arm 3: Minimal post-disclosure inline verified body excerpt on `#1` only — computed strictly **after** baseline 48 KiB disclosure using remaining serialized headroom, dropped first before any result group is evicted, bound to the serving publication + exact symbol instance.
- **Ship gate:** **≥10-point gain** in correctly completed tasks within 2 tool calls with zero loss in overall correctness; 1-call completion tracked separately; **zero** change to disclosed IDs, counts, or continuation page boundaries. **Drop Arm 3 (inline excerpt) if Arm 2 captures the gain.**

---

### Slice 4D — Persistent Disk-Backed LateOn Vector Cache (Restart Benchmark First)
- **Owners:** `packages/mcp/src/server/lateon-reranker-worker.ts` (lookup/scoring/token accounting), `packages/mcp/src/server/lateon-reranker.ts` & `packages/mcp/src/server/provider-runtime.ts` (lifecycle & `stateRoot` wiring).
- **Steps:**
  1. **Measure before building:** Benchmark real worker restarts (cold process + `readyMs` + query encode + overlapping vs. disjoint next queries) to confirm whether restart-inclusive savings clear the 25% bar.
  2. **If justified, implement safely:**
     - Key by full encoding fingerprint (`modelRevision`, verified artifact digests, tokenizer/preprocessing/normalization params, `embeddingDimensions`, `documentTokenLimit`) + `sha256(documentText)`.
     - Store normalized `Float64` vectors (preserving strict bit-identity) + `tokenCount` + `dimensions` + magic/version/checksum header.
     - Lookup **only after** normal source authorization and v5 projection; validate bounded size, dimensions, token count, and checksum on read (any corruption, race, or I/O error degrades silently to a cache miss).
     - Enforce parent-directory ownership, `O_NOFOLLOW`, atomic temp-file + rename writes, and bounded disk quota + peak RSS.
- **Ship gate:** Bit-identical scores and ordering; bounded disk & peak RSS; **≥25% reduction** in restart-inclusive median latency on representative overlapping sessions; equivalent warm p95; passes concurrent-writer, truncation/corruption, and model/profile-change fault tests. **Stop and skip if overlap or startup overhead makes net gain <25%.**
