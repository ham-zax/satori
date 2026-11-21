# Phase 4 Plan — Ranking Authority, Projection Speed & Flash-Model Handoff, 21 November 2026

Sequenced execution plan synthesized from the 5-repository offline measurements (`react`, `flatbuffers`, `polars`, held-out `gin` and `flask`), four structured thinking passes (`first-principles`, `pre-mortem`, `inversion`, `concept-fan`), and read-only architectural counsel from `gpt-6.2-sol` (`xhigh`, Claive worker `117df06358b8`).

- **Baseline commit:** `39e79d2b` on `master` (Phases 1–3 + all 9 Slice 4.0 review blockers/corrections committed cleanly; working tree clean before Phase 4A).
- **North star:** Make offline Satori (`Potion-code-16M-v2` + `LanceDB` + `LateOn-Code-edge` 17M on CPU) fast, accurate at strict symbol `hit@1`, and effective enough that small/Flash coding models reach verified edit-ready context in 1–2 tool calls instead of 5–7.

## Governing Rules

1. **One variable at a time:** Every slice has a named owner, a falsifying kill test run *before* designing heuristics, and a hard ship gate.
2. **Keep definition discovery for candidate admission:** Never disable `symbol_metadata_bm25` candidate admission (`packages/mcp/src/core/search-execution.ts:1060`) while testing post-rerank ordering.
3. **Never confound raw LateOn with `rerank_blend`:** Turning off `definition_discovery` in `packages/mcp/src/core/search-rerank-execution.ts:579` lets LateOn's default 50/50 `rerank_blend` activate. Always hold candidate IDs and provider scores fixed in replay.
4. **No overfitting to `gin` / `flask`:** Because `gin` and `flask` failures were inspected, they are now **regression controls**, not tuning targets. Any new ranking or handoff policy must be qualified on fresh tasks (or `evals/agent-discovery/run-opencode.mjs`) and preserve existing unit test oracles (`AGENTS.md`).
5. **No new npm dependencies** without explicit approval; follow `AGENTS.md` (differential equivalence + witness mutation checks for caches/fast paths; 3-run medians + peak RSS + loadavg + exact command for latency claims).

---

## Kill / Keep / Defer Verdicts (Locked Decisions)

| Proposal | Verdict | Evidence & Mechanism |
|---|---|---|
| **Fix/replace post-LateOn BM25 vote in `fuseDefinitionDiscovery`** | **KEEP (Slice 4A — replay first)** | With `K=60`, provider `#6` + definition `#1` (`0.03154`) beats provider `#1` abstaining behind 20 lexical matches (`0.02874`), overturning LateOn's `#1` (`gin/g2`, `gin/g5`, `flask/f12`). Stemming alone changes who receives the vote without fixing excessive vote authority. Replay frozen pools first (`raw LateOn` vs `current fusion` vs `50/50 blend`); only add a bounded score-residual `s_i + ε·e_i` if pure provider order shows repeatable losses. |
| **Manifest / package-metadata focus routing (`flask/f15`)** | **KEEP (Slice 4A — separate from route)** | `pyproject.toml` reached `mcp_filtered #1`, then `"implementation"` focus omitted it. Fix `resolveSearchAnswerFocus` (`search-answer-focus.ts`) for build/package/dependency declaration intent **without** changing `search-query-planning.ts:517` (the `configuration` *route* has `rerankCalls: 0` and a sparse-only plan). |
| **`selectRerankSourceWithinBudget` upper-budget one-shot fast path** | **KEEP (Slice 4B)** | 125/128 real React docs fit on attempt 1 (`212 ms → 39 ms`, `5.5×`), but 3/128 diverged when unbounded. Provably bit-identical **only** when `selection.status === "selected"`, `selection.source.completeSymbolReturned === true`, and `Buffer.byteLength(candidateText, "utf8") <= MAXIMUM_UTF8_BYTES`; bounded excerpts keep exact binary search. |
| **Default top-2 inline structural-neighbor dump & label-only dedup** | **KILL** | Rerank projection only holds `(path, label)` pairs and can fall back to bounded windows; `48 KiB` disclosure evicts whole groups before trimming previews; same-name declarations can have distinct bodies (`search-group-ordering.ts:174` already owns proven wrapper collapse); a neighbor list gives Flash models another selection problem (`flask/f4` `save_session` lives on `SecureCookieSessionInterface`, not `SecureCookieSession`). |
| **Upgrade `recommendedNextAction` & A/B against 1 minimal post-disclosure inline excerpt** | **KEEP (Slice 4C)** | `recommendedNextAction` (`search-response-helpers.ts:464`) grabs the first actionable hit and can fall back to plain span reads. Steering it to the best already-ranked, verified executable target in the winning file (or 1 proven delegation edge) and comparing against 1 post-disclosure, budget-safe inline excerpt directly targets Flash-model tool-call count. |
| **Disk-backed persistent LateOn `documentCache`** | **DEFER TO LAST (Slice 4D — restart math first)** | Restart still pays worker startup (`readyMs`) + query encode; `85 ms` warm is not the restart target. Must store normalized **`Float64`** vectors (storing `Float32` breaks bit-identity), key on full encoding fingerprint + exact doc bytes, validate checksum/dimensions/tokenCount, and enforce parent-dir ownership + `O_NOFOLLOW` + atomic rename + disk quota. |
| **Idle background pre-warming of LateOn vectors** | **KILL** | Adds background CPU/RAM contention and lifecycle complexity before restart-cache ROI is proven. |

---

## Sequenced Implementation Plan

### Slice 4.0 — Pre-Flight: Phase 1–3 Review Bug Remediation
- **Status:** **DONE** (committed at `39e79d2b` on `master`; all 4 release blockers + 5 review corrections fixed with 13 deterministic regression tests, focused Core/MCP/CLI suites green, `pnpm run check` green).

---

### Slice 4A — Unconfounded Ranking Authority Replay & Manifest Focus Repair
- **Status:** **IMPLEMENTED & VERIFIED** (working tree on top of `39e79d2b`)
- **Owners:**
  - `packages/mcp/src/core/search-rerank-execution.ts` (`applyRerankOrder`, lines ~560–650)
  - `packages/mcp/src/core/search-definition-discovery.ts` (`fuseDefinitionDiscovery`, `rerankerOrderNeedsDefinitionFusion`)
  - `packages/mcp/src/core/search-answer-focus.ts` (`resolveSearchAnswerFocus`, `packages/mcp/src/core/search-answer-focus.test.ts`)
- **Concrete Execution Steps:**
  1. **Capture & freeze the 58-query replay pool (disposable `/tmp` harness, cleaned up afterward):**
     - Acquire pinned `LateOn-Code-edge` via `ensureDefaultLateOnModel` into `/tmp/satori-p4-home` and clone/index the 5 pinned repos (`react@7c6ac13e19fe`, `flatbuffers@b8431fbcd7a5`, `polars@74dd736d655c`, `gin@73726dc606796a025971fe451f0aa6f1b9b847f6`, `flask@22d924701a6ae2e4cd01e9a15bbaf3946094af65`) in **isolated per-repo state roots** under `/tmp/satori-p4-state/<repo>` (prevents shared-state RSS inflation and background sync contamination).
     - Record every query's exact `reranker_input`, `reranker_provider_output` (scores & candidateIds), `definitionMetadata`, language, path, and `answerFocus`.
  2. **Run the frozen-pool offline replay** holding admitted candidate IDs and LateOn provider scores 100% identical across arms:
     - **Arm 0 (Control — Raw LateOn):** Provider score order + existing explicit role/intent constraints (`preferImplementationCandidates`), **no** `fuseDefinitionDiscovery`, **no** `rerank_blend`.
     - **Arm 1 (Current default):** Current `fuseDefinitionDiscovery` (with polyglot language affinity).
     - **Arm 2 (Current blend):** LateOn 50/50 `rerank_blend` without `fuseDefinitionDiscovery`.
     - **Arm 3 (Raw LateOn + independent explicit language tie-break):** Provider order + explicit polyglot language match evaluated strictly on the original query.
     - **Arm 4 (Conditional — only if Arm 0/Arm 3 shows repeatable losses vs. Arm 1):** Bounded score-residual `s_i + ε·e_i` where `e_i ∈ [0, 1]` is zero for incidental/single-generic-token matches, guaranteeing any LateOn lead `> ε` survives. **Never** use a raw MaxSim score-margin cutoff (MaxSim scales linearly with query token count).
  3. **Implement the manifest-declaration focus fix separately:**
     - In `packages/mcp/src/core/search-answer-focus.ts`, recognize declaration-location intent for build/package/dependency metadata (e.g. `"where are ... build metadata / dependencies / version ... declared"`, `pyproject.toml` / `package.json` / `Cargo.toml` / `go.mod` style metadata asks) as `focus: "configuration"` **before** generic implementation cues, while keeping `plan.route.kind` untouched so it retains full semantic+rerank retrieval.
     - Add focused unit tests in `packages/mcp/src/core/search-answer-focus.test.ts` (including negative controls ensuring runtime implementation queries like `"where does config get parsed"` still stay `"implementation"`).
  4. **Implement the replay-proven ranking policy** in `search-rerank-execution.ts` / `search-definition-discovery.ts` (keeping `symbol_metadata_bm25` admission intact in `search-execution.ts:1060`!), update/add focused unit tests preserving all existing oracles, and run the **end-to-end live MCP verification** across all 5 repos.
- **Ship Gate:**
  - Improves **strict symbol `hit@1`** over baseline (`39e79d2b`) with **zero new accepted-owner misses at top-10** across the 58-query set.
  - Passes all exact, reference, language, and manifest controls (including `flask/f15` recovery without breaking runtime queries).
  - `gin` and `flask` act as regression controls; document remaining gaps and qualify any tuned parameter on fresh queries/tasks.

---

### Slice 4B — Bit-Identical `selectRerankSourceWithinBudget` One-Shot Fast Path
- **Status:** **IMPLEMENTED & VERIFIED** (working tree on top of `39e79d2b`)
- **Owners:**
  - `packages/mcp/src/core/search-rerank-projection-primitives.ts` (`selectRerankSourceWithinBudget`, lines ~264–313)
  - `packages/mcp/src/core/bounded-source-selector.ts` (`selectPreparedBoundedSource`, lines ~595–618)
  - `packages/mcp/src/core/search-rerank-document.test.ts` (note line 100!)
- **Concrete Execution Steps:**
  1. **Diagnose the 3/128 divergent React documents first:** Run a quick script against the real React corpus comparing `selectRerankSourceWithinBudget` binary search vs. `upperBudget`-first, logging the exact reason each of the 3 diverged (expected: JSON escaping overhead making `Buffer.byteLength(candidateText, "utf8") > 4000` when `sourceBudget = upperBudget`, or `completeSymbolReturned === false` bounded excerpt differences).
  2. **Implement the mathematically airtight fast path in `selectRerankSourceWithinBudget`:**
     - Before the binary search loop, evaluate `selectSource(input.normalized, upperBudget, input.selectionPolicyVersion, select)` once (`selectionAttemptCount = 1`).
     - Compute `candidateText = input.buildProjectionText(selectedExcerptText(selection.source))` and `candidateBytes = Buffer.byteLength(candidateText, "utf8")`.
     - **Short-circuit ONLY when all three hold:**
       1. `selection.status === "selected"`
       2. `selection.source.completeSymbolReturned === true`
       3. `candidateBytes <= MAXIMUM_UTF8_BYTES`
     - **Proof of bit-identity:** In `selectPreparedBoundedSource`, `completeProjection` depends only on `(sourceBytes, lines, symbolSpan, capabilities, selectionPolicyVersion)` and is independent of `sourceBudget`. If `upperBudget` already satisfies `totalBytes <= upperBudget`, `totalLines <= 200`, `completeSerializedBytes <= upperBudget`, and outer `candidateBytes <= 4000`, the existing binary search moves monotonically upward to `upperBudget` and returns the exact same `completeProjection` and `candidateText`.
     - If any of the 3 conditions fails, fall through to the exact existing binary search loop (`lowerBudget = 1`, `upperBudget = candidateBytes > MAXIMUM_UTF8_BYTES ? upperBudget - 1 : upperBudget`, adjusting `attempt` budget cleanly so existing behavior is preserved identically).
  3. **Respect the existing unit test oracle at `search-rerank-document.test.ts:93-102`:**
     - That test (`"canonical projection encodes the source once across budget attempts"`) currently uses the tiny 4-line `CONTENT` and asserts `assert.ok(result.selectionAttemptCount > 1); assert.equal(encodings, 1);`.
     - Inspect why that test exists: it verifies `Buffer.from(content, "utf8")` is called only once even across multiple binary-search attempts. Do **not** weaken the assertion — either ensure multi-attempt coverage runs against a symbol that actually triggers binary search (e.g., >4,000 bytes so `completeSymbolReturned === false`), AND add a new differential test asserting bit-identical `text`, `utf8Bytes`, and `sha256` against the original binary-search algorithm across:
       - Complete symbols (1 attempt),
       - Heavy JSON-escaping symbols (`\"`, `\\`, `\n`, `\u001b`, multi-byte UTF-8 emojis/CJK near the 4,000-byte boundary),
       - Truncated/bounded symbols (`> 4,000 B` and `> 200 lines`),
       - All 128 real React candidates (`0/128` diffs).
  4. **Witness/fast-path mutation check:** Temporarily drop the `completeSymbolReturned === true` or `candidateBytes <= MAXIMUM_UTF8_BYTES` guard, confirm the differential test fails on the escaping/bounded fixture, then restore.
- **Ship Gate:**
  - **0** `search_rerank_document_v5` document or SHA-256 differences across all 128 React candidates + edge fixtures.
  - **≥50% reduction** in 3-run median projection latency on the 128-doc workload, with no fallback p95 regression.

---

### Slice 4C — Flash/Small-Model Evidence Handoff (Measured on Agent Discovery)
- **Status:** **ARM 2 IMPLEMENTED & VERIFIED / ARM 3 SKIPPED** (working tree on top of `39e79d2b`)
- **Owners:**
  - `packages/mcp/src/core/search-group-ordering.ts` (`collapseEquivalentImplementationGroups`, lines ~174–207)
  - `packages/mcp/src/core/search-response-helpers.ts` (`buildTopRecommendedSearchAction` / `buildSearchGroupRecommendedAction`, lines ~464–545)
  - `packages/mcp/src/core/search-file-symbol-supplement.ts` (inspect only if executable targets miss the provider window)
  - `packages/mcp/src/core/search-disclosure.ts` & `packages/mcp/src/core/search-response-envelopes.ts` (Arm 3 only if Arm 2 fails to capture the gain)
- **Concrete Execution Steps:**
  1. **Trace React `r3` before changing grouping:** Inspect why `collapseEquivalentImplementationGroups` did not collapse the repeated `ReactFiberHooks.js::useEffect` dispatcher stubs (`HooksDispatcherOnMount`, `OnUpdate`, etc.) — check whether their bodies actually differ (which makes them legitimately distinct) or whether `simpleWrapperTokens` rejected valid Flow/TS syntax. Only widen `simpleWrapperTokens` if bodies are provably equivalent; **never** add label-only dedup.
  2. **Upgrade `buildTopRecommendedSearchAction` (zero wire-schema change):**
     - Currently picks the first actionable result (`results.findIndex(...)`), which on `gin/g7` (`defaultValidator` struct), `flask/f4` (`SecureCookieSession` class), or file-level top hits sends a Flash model to a coarse container or plain line span instead of the winning executable implementation.
     - When `results[0]` is a coarse container (`file`, `module`, `class`, `struct`, `interface`, `type`) on an `implementationSeeking` / behavioral query, check if an already-ranked, verified executable (`function` / `method` / `constructor`) with `symbolId` exists in the **same winning file** (or reachable via **one proven high-confidence delegation edge** to an eligible implementation). If unambiguous, target that `resultIndex` with `read_file(open_symbol, preset: "implementation")`; leave ambiguous cases untouched.
     - Add deterministic unit tests in `packages/mcp/src/core/search-response-helpers.test.ts` (or nearest response helper test).
  3. **Measure on `evals/agent-discovery/run-opencode.mjs`** (or isolated Flash-model task harness letting the model formulate its own first query):
     - **Arm 1:** Current `search_codebase` output (baseline).
     - **Arm 2:** Upgraded exact `recommendedNextAction` handoff (2-call sufficiency, zero schema change).
     - **Arm 3 (only if Arm 2 falls short):** One minimal verified body excerpt attached to `#1` **strictly after** baseline `projectGroupedDisclosure` (spending only remaining 48 KiB serialized headroom, dropped first before any group is evicted, bound to serving publication + exact `symbolInstanceId`, verified against MCP client schemas & continuation pages).
- **Ship Gate:**
  - **≥10-point gain** in correctly completed tasks within 2 tool calls with zero loss in overall correctness; track 1-call completion separately.
  - **Zero** change to disclosed IDs, `returnedGroupCount`, or continuation page boundaries.
  - **Drop Arm 3 completely if Arm 2 already captures the gain.**

---

### Slice 4D — Conditional Persistent Disk-Backed LateOn `Float64` Vector Cache
- **Status:** **SKIPPED (Killed by Restart Benchmark)** — representative cross-query overlap (`31%–35%`) measured `19.5%–21.8%` restart-inclusive speedup, missing the `≥25%` ship gate due to the fixed `~640 ms` cold worker startup floor.
- **Owners:**
  - `packages/mcp/src/server/lateon-reranker-worker.ts` (lookup, scoring, token-budget accounting)
  - `packages/mcp/src/server/lateon-reranker.ts` & `packages/mcp/src/server/provider-runtime.ts` (lifecycle & `stateRoot` wiring)
- **Concrete Execution Steps:**
  1. **Kill-test restart benchmark BEFORE writing cache code:**
     - Measure 3-run medians of real cold worker restarts (`readyMs` + query encode + 128-doc scoring) on overlapping (`30%`, `60%`, `90%` overlap) and disjoint (`0%` overlap) sessions, comparing cold ONNX encoding vs. reading pre-stored `Float64` vectors from disk.
     - **Stop and skip Slice 4D** if worker startup + query encode + disk I/O prevents reaching **≥25% reduction** in restart-inclusive median latency on representative overlapping sessions (~31–35% overlap observed on `gin`/`flask`, higher within active feature work).
  2. **If justified, implement with full Phase-1 security rigor:**
     - **Key / Encoding Fingerprint:** `sha256` over `(modelRevision, sorted artifact sha256s, tokenizer/preprocessing params: queryPrefix/documentPrefix/lowercase/documentTokenLimit/documentSkipTokenIds/embeddingDimensions, formatVersion)` + `sha256(documentText)`. Any model/profile/preprocessing change naturally misses.
     - **Payload:** Normalized **`Float64`** vectors (strictly bit-identical; **do not** store `Float32`), `dimensions`, `tokenCount`, magic header + version + SHA-256 checksum.
     - **Lookup order:** Only after normal source authorization and `search_rerank_document_v5` projection (worker never touches repo files). Validate bounded entry size, dimensions, `vectors.length % dimensions === 0`, `tokenCount`, and checksum before scoring. Any corruption, truncation, race, or I/O error silently degrades to a cache miss and removes the corrupt entry.
     - **FS safety & quota:** Validate parent directory ownership + non-symlink components under `stateRoot`, use `O_NOFOLLOW` + atomic temp-file + rename writes, and enforce a bounded disk quota (e.g., `256 MiB` LRU/mtime sweep) + bounded in-memory `64 MiB` cache.
  3. **Fault & differential tests:**
     - Bit-identical scores and ordering across worker restarts (`Object.is` + SHA-256 digest).
     - Concurrent writers to the same key, truncated/corrupt cache files, symlinked cache dir/entry refusal, and profile/fingerprint mutation check (break fingerprint → test fails → restore).
- **Ship Gate:**
  - Bit-identical scores and ordering; bounded disk and peak RSS.
  - **≥25% reduction** in restart-inclusive 3-run median latency on representative overlapping sessions, with equivalent warm p95.
  - All fault, security, and differential tests pass; otherwise **drop Slice 4D** and record the negative measurement.

---

## Measured Implementation Results (21 November 2026)

All offline measurements ran on `wsl_webharness` (16 logical CPUs, Linux WSL2, Node `v24.19.0`, `Potion-code-16M-v2` + `LanceDB` + pinned `LateOn-Code-edge@07ef20f406c86badca122464808f4cac2f6e4b25` `lateon_offline_quality_projection_v6_d128_v1`, isolated per-repo `SATORI_STATE_ROOT`s under `/tmp/satori-p4-state/<repo>`, cleaned up after measurement). Every measured query asserted `freshnessMode !== "served_previous_generation"`.

### Slice 4A — Unconfounded Frozen-Pool Replay & Live 58-Query Verification

**1. Unconfounded 58-query frozen-pool replay (holding `reranker_input` candidate IDs and exact LateOn provider scores fixed):**

| Arm | Policy | `hit@1` / `strict@1` | `hit@5` | `hit@10` | `MRR` | New Top-10 Misses vs Live |
|---|---|---:|---:|---:|---:|---|
| Baseline (live `39e79d2b`) | Current `fuseDefinitionDiscovery` (preempts `rerank_blend`) | `25/58` | `41/58` | `47/58` | `0.5478` | — |
| Arm 0 (Raw LateOn) | Provider order + `preferImplementationCandidates` only | `21/58` | `39/58` | `40/58` | `0.4734` | `7` (`g3, g7, fb/f3, fb/f5, fb/f7, fb/f10, p3`) |
| Arm 3 (Raw + Polyglot) | Provider order + explicit polyglot language affinity | `21/58` | `40/58` | `41/58` | `0.4796` | `6` (`g3, g7, fb/f3, fb/f5, fb/f7, p3`) |
| Arm 2 (50/50 blend + lang) | `0.5*providerRank + 0.5*sliceRank` + polyglot lang, no def fusion | `29/58` | `47/58` | `50/58` | `0.6250` | `1` (`flatbuffers/f3`) |
| **Shipped 4A (blend-first + `minTerms=2`)** | Apply `rerank_blend` before `fuseDefinitionDiscovery(minimumMatchedTerms: 2)` | `27/58` | `43/58` | `50/58` | `0.5845` | **`0`** |

- **Root cause proven:** In `packages/mcp/src/core/search-rerank-execution.ts`, `if (executionFlags.rerank_blend && !definitionFusionApplied)` discarded LateOn's first-stage consensus (`sliceRank`) whenever definition discovery ran, and single-token incidental definition matches (`minimumMatchedTerms: 1`) overturned LateOn's top owners. Applying `rerank_blend` before `fuseDefinitionDiscovery` (with `minimumMatchedTerms: 2` when blended) preserves both first-stage consensus and `symbol_metadata_bm25` admission without dropping `flatbuffers/f3`.
- **Manifest focus fix (`packages/mcp/src/core/search-answer-focus.ts`):** Added `isManifestDeclarationQuery` returning `{ focus: "configuration", reasons: ["manifest_declaration_query"] }` before `implementationSeeking` / `implementationCue` while leaving `plan.route.kind` unchanged. Verified across all 58 queries to trigger exclusively on `flask/f15` and `gin/g15` (positive + negative runtime controls added in `search-answer-focus.test.ts`).

**2. Live end-to-end MCP verification across all 5 pinned repositories (58 queries):**

| Repo (commit) | Queries | Baseline `39e79d2b` (`h@1 / h@5 / h@10 / MRR`) | Slice 4A Live (`h@1 / h@5 / h@10 / MRR`) | Strict `hit@1` Delta | Notable Rank Shifts |
|---|---:|---|---|---:|---|
| `react@7c6ac13e19fe` | 9 | `5/9 · 7/9 · 7/9 · 0.6333` | `5/9 · 7/9 · 7/9 · 0.6333` | `0` | Unchanged (zero regressions) |
| `flatbuffers@b8431fbcd7a5` | 10 | `4/10 · 6/10 · 9/10 · 0.4972` | `4/10 · 7/10 · 9/10 · 0.5202` | `0` | `f3: 9→7`, `f7: 9→7`, `f9: 6→3` |
| `polars@74dd736d655c` | 9 | `5/9 · 8/9 · 9/9 · 0.7381` | `6/9 · 8/9 · 9/9 · 0.7426` | `+1` | `p3: 7→1`, `p1: 2→10`, `p2: 2→4`, `p6: 2→3` |
| `gin@73726dc60679` (control) | 15 | `4/15 · 9/15 · 11/15 · 0.3973` | `7/15 · 9/15 · 12/15 · 0.5429` | `+3` | `g1: 2→1`, `g2: 4→3`, `g6: -→3`, `g7: 5→1`, `g8: 2→1`, `g3: 5→6` |
| `flask@22d924701a6a` (control) | 15 | `7/15 · 11/15 · 11/15 · 0.5667` | `8/15 · 14/15 · 14/15 · 0.6833` | `+1` | `f4: -→1`, `f6: -→3`, `f15: -→1`, `f8: 3→4`, `f11: 1→2` |
| **Combined** | **58** | **`25/58 · 41/58 · 47/58 · 0.5478`** | **`30/58 · 45/58 · 51/58 · 0.6203`** | **`+5` (`+20%`)** | **`0` new top-10 misses (`+4` recovered)** |

- **Gate verdict:** **PASS.** Strict `hit@1` improved `+5` (`25/58 → 30/58`), `MRR` improved `+0.0725`, `0` new accepted-owner misses at top-10, `127/127` focused MCP tests (including all 34 `search-execution.golden.test.ts` snapshots unchanged) pass.

---

### Slice 4B — Bit-Identical `selectRerankSourceWithinBudget` One-Shot Fast Path & Selector Memoization

- **Changes:**
  - `packages/mcp/src/core/search-rerank-projection-primitives.ts`: Added one-shot `upperBudget` probe in `selectRerankSourceWithinBudget` that short-circuits only when `probeSelection.status === "selected"`, `probeSelection.source.completeSymbolReturned === true`, and `Buffer.byteLength(probeText, "utf8") <= MAXIMUM_UTF8_BYTES`; any incomplete or over-budget probe falls through to the exact existing binary search with unchanged bounds.
  - `packages/mcp/src/core/bounded-source-selector.ts`: Guarded `completeProjection` construction behind `totalBytes <= maxSourceBytes && totalLines <= maxSourceLines` and added value-witnessed (`query`, `evidenceSpans`, `structuralAnchors`, `contextLines`) memoization of `buildOrderedCandidates` inside `createBoundedSourceSelector`.
  - `packages/mcp/src/core/search-rerank-document.test.ts`: Preserved the single-encoding multi-attempt oracle by exercising an oversized truncating fixture (`selectionAttemptCount > 1`, `encodings === 1`) alongside a 1-attempt assertion on `CONTENT`; added 6-fixture differential equivalence suite (complete, heavy JSON escaping over 4,000 B, CJK/emoji under 4,000 B, >4,000 B truncated, >200 lines truncated, and outer-projection overflow on a complete symbol).
- **Equivalence & live witness mutation checks:**
  - **0/128 diffs** on real React v5 candidates (`combinedSha256 = 1ae582e20d576ff9418b4d21ad5dc94ffefeddfff8e72ad43f0c9bf0b4183698`, `totalAttempts: 1536 → 248`, `118/128` 1-shot fast hits, `10/128` bounded fallbacks).
  - Live source mutation checks (3/3 killed & restored): (1) removing `probeBytes <= MAXIMUM_UTF8_BYTES` → `search-rerank-document.test.ts` failed (`14 pass, 1 fail`); (2) removing `completeSymbolReturned === true` → failed (`13 pass, 2 fail`); (3) dropping `candidateOrderingWitness` equality check in `bounded-source-selector.ts` → `bounded-source-selector.test.ts` failed (`14 pass, 1 fail`). All restored and green (`30/30`).
- **5-run median benchmark on 128 real React candidates:**

| Metric | Before (`39e79d2b`) | After (Slice 4B) | Delta | Runs (ms) | Peak RSS / `os.loadavg()` |
|---|---:|---:|---:|---|---|
| Direct `selectRerankSourceWithinBudget` (128 docs) | `235.80 ms` | **`72.11 ms`** | **`-69.4%`** | Before `[236.10, 233.70, 228.58, 235.80, 248.42]` · After `[307.75, 72.11, 72.80, 70.78, 71.35]` | `187.6 MiB` · `[0.62, 1.38, 1.38]` |
| Direct fallback p95 (10 bounded docs) | `15.116 ms` | **`9.235 ms`** | **`-38.9%`** | Same 5-run paired invocation | `187.6 MiB` · `[0.62, 1.38, 1.38]` |
| End-to-end `buildSearchRerankDocument` (128 docs) | `180.91 ms` | **`94.58 ms`** | **`-47.7%`** | Before `[469.69, 180.91, 173.56, 163.59, 231.07]` · After `[125.84, 94.58, 95.23, 89.21, 92.73]` | `184.6 MiB` · `[0.74, 1.56, 1.44]` |
| End-to-end fallback p95 | `8.959 ms` | **`4.423 ms`** | **`-50.6%`** | Same 5-run script (`node /tmp/satori-p4-4b-bench.mjs before\|after2`) | `184.6 MiB` · `[0.74, 1.56, 1.44]` |

- **Gate verdict:** **PASS.** `0` diffs across all 128 React candidates + 6 edge fixtures, `-69.4%` direct projection median reduction (`≥50%` gate met), no fallback p95 regression (`-38.9%` faster).

---

### Slice 4C — Flash/Small-Model Evidence Handoff

- **React `r3` trace:** Inspected `packages/react-reconciler/src/ReactFiberHooks.js` lines `4053–4061` (`mountEffect`), `4386–4393` (`updateEffect`), and `4909–4917` (`warnInvalidHookAccess` + `updateEffect`). All 3 `useEffect` dispatcher methods have genuinely distinct executable bodies; `collapseEquivalentImplementationGroups` is working as intended and was left unchanged (no label-only deduplication).
- **Arm 2 (`buildTopRecommendedSearchAction` in `packages/mcp/src/core/search-response-helpers.ts`, `search-result-finalization.ts`, `search-request-coordinator.ts`):** Upgraded top recommendation so that when `#1` is a coarse container (`file`, `module`, `namespace`, `class`, `struct`, `interface`, `type`, `enum`, `trait`) or lacks `symbolId` on an `implementationSeeking` (non-reference) query, it targets an unambiguous already-ranked executable (`function`, `method`, `constructor`) with `symbolId` in the same winning file (disambiguated by class/struct span containment when multiple file executables exist) using `read_file(open_symbol, preset: "implementation")` (preserving `#1` whenever ambiguous or non-implementation). Unified `actionIntent` in `finalizeSearchResults` with resolved `answerFocus` so `"how does ..."` / `"what validates ..."` queries (`focus === "implementation"`) also receive `preset: "implementation"` and executable targeting, while manifest/configuration queries keep `preset: "definition"`. Zero wire-schema changes; zero changes to disclosed IDs, `returnedGroupCount`, or continuation page boundaries.
- **Arm 3 (post-disclosure inline body excerpt) — SKIPPED:** After Slice 4A already moved `gin/g7` (`ValidateStruct`) and `flask/f4` (`save_session`) directly to rank `#1`, only `1/58` queries (`gin/g5`) remained a coarse container on an implementation query. Furthermore, `evals/agent-discovery/run-opencode.mjs` enforces a clean committed Git worktree (`requireCleanWorktree`), so multi-repetition live Flash A/B against uncommitted edits was not run; per the plan's ship gate, Arm 3 is not shipped without measured `≥10-point` live 2-call evidence.

---

### Slice 4D — Persistent Disk-Backed LateOn `Float64` Vector Cache (KILLED / SKIPPED)

- **Kill-test benchmark command:** Cold-restart 3-run median benchmark (`node /tmp/satori-p4-4d-killtest-strat.mjs`, cleaned up after measurement) running real `LateOnReranker` worker restarts (`3×4` host execution plan, `LateOn-Code-edge`, `128` real React v5 docs, `13.19 MiB` / `105.5 KiB/doc` binary `Float64` + SHA-256 cache files, length-stratified unbiased overlap selection).
- **Measured restart-inclusive 3-run medians (`peakRss 249.7 MiB`, `os.loadavg() = [2.79, 1.69, 1.42]`):**

| Overlap | Hits / Misses | 3-Run Totals (ms) | Median Total (ms) | Worker (Startup + Encode) | Disk Read + SHA-256 + MaxSim | Speedup vs 0% | Ship Gate (`≥25%`) |
|---:|---:|---|---:|---:|---:|---:|---|
| `0%` (disjoint) | `0 / 128` | `[2397.2, 2579.5, 2796.7]` | `2579.5` | `2579.5 ms` | `0.0 ms` | `0.0%` | Baseline |
| **`31%` (`gin` observed `31.3%`)** | `40 / 88` | `[2010.7, 2075.3, 2082.0]` | **`2075.3`** | `2063.6 ms` | `11.6 ms` | **`19.5%`** | **FAIL (< 25%)** |
| **`35%` (`flask` observed `35.2%`)** | `45 / 83` | `[1981.0, 2016.4, 2162.5]` | **`2016.4`** | `2003.0 ms` | `13.4 ms` | **`21.8%`** | **FAIL (< 25%)** |
| `60%` | `77 / 51` | `[1540.7, 1494.8, 1724.3]` | `1540.7` | `1514.7 ms` | `25.9 ms` | `40.3%` | High-overlap only |
| `90%` | `115 / 13` | `[909.8, 916.0, 1035.5]` | `916.0` | `876.3 ms` | `39.9 ms` | `64.5%` | Near-repeat only |

- **Unstratified prefix-order cross-check (`peakRss 231.6 MiB`, `loadavg [2.43, 1.29, 1.27]`):** `0% = 2558.6 ms`, `35% = 2258.0 ms` (`11.7%`), `60% = 1737.5 ms` (`32.1%`), `90% = 970.6 ms` (`62.1%`).
- **Mechanism:** Each cold worker restart pays a fixed `~633–670 ms` startup + ONNX session initialization + query encode floor (`readyMs` + `encodeQuery`), capping restart-inclusive savings at `19.5%–21.8%` for the `31%–35%` cross-query overlap observed on real repositories.
- **Decision:** **SKIP Slice 4D.** No persistent disk cache code added; the bounded 64 MiB in-memory worker `documentCache` from Phase 3 remains the sole document vector cache.
