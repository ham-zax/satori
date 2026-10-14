# Owner recall and fusion: design checkpoint

Recorded 2026-10-13 on `master` at `224183ca`.

**This is a checkpoint, not an implementation plan.** No proposal here is
approved or implemented. One product change was made while it was written,
with Hamza's approval: a sentence in the `search_codebase` tool description
(see "Caller alt terms through the real local reranker"). The document
records what is proposed and why, so that a new or compacted session can
resume without the earlier conversation. Each proposal needs its deciding
experiment and Hamza's approval before any product change. It continues
[Definition fusion: root cause and replayed rules](definition-fusion-root-cause.md),
which holds the measurements quoted here. A reader new to this work should
start with the [handoff](owner-ranking-handoff.md).

## Summary

- The owner is lost **before** the reranker far more often than it is
  misordered by it. Of 72 questions, 25 owners never reach the rerank window,
  and 18 of those are in no retrieval arm's top 80.
- Widening the window from 64 cannot fix this. At most 4 owners sit just
  outside it, and every other question pays for the extra candidates.
- The 64 seats are spent badly: about 42% of window documents are test files.
  Re-spending seats is a better lever than adding seats.
- Core fusion loses owners because each arm's depth equals the fused cut, up
  to three arms vote with equal weight, and votes add up per chunk, not per
  owner. A chunk found by one arm only is ranked below every chunk found by
  two.
- An earlier experiment suggested the 18 are a vocabulary gap between the
  question and the code. P1 narrows that: 11 are retrievable at rank 81 to
  400, where freeing the seats tests hold is enough for 8 of them. That does
  not make seats the only cause, and the 6 beyond 400 are ranks cut off by
  the measurement, not proven vocabulary failures. The captures behind these
  figures sent no alt terms.
- **P1 is done** (see "P1 result"). 11 of the 18 are at rank 96 to 395 in an
  arm, 6 are beyond 400 and 1 is excluded by scope. Test files fill the arms:
  when they are not counted, 8 of those 11 are inside an arm's top 80.
- **P8 is done** (see "Variant sweep"). One change gains without a loss: a
  cap on test rows per arm with the arms read to depth 400, 47 to 51 strict
  owners in the window at a cap of 10. Owner-counted arms, a larger fused
  cut, owner-level accumulation and a lower fallback weight gain nothing or
  trade owners.
- With the local reranker the larger loss is **inside** the window: 51 owners
  are in it and 21 finish first. The reranker's own order accounts for 26 of
  the 30 that do not; definition fusion is a net gain of 5 after it. This
  qualifies the first bullet for that reranker.
- **The cap through the real local reranker is done** (see "The cap through
  the real local reranker"). It puts 53 owners in the window against 51, and
  MRR over the 72 moves from 0.3559 to 0.3552, 0.3748 and 0.3646 at caps of
  10, 20 and 0. That is one to three questions moving a place, not ordered by
  cap size. With this reranker the cap is not an MRR lever.
- **Caller alt terms are the largest measured lever** (see "Caller alt terms
  through the real local reranker"). With the question's own terms 64 owners
  are in the window against 51 and MRR over the 72 goes from 0.3559 to
  0.4985. With another question's terms it falls to 0.1823. The gain is on
  the 46 conceptual questions; the original 28 gain reach but not MRR.
- **Alt terms already ship.** The parameter, both flags and the user
  documentation exist; only the tool's own description did not mention them,
  and it now does (uncommitted). What is left with the local reranker is
  ordering: with terms, 64 owners are in the window and 27 are first.
- **Earlier verdicts on ordering are data, not rulings** (Hamza, 2026-10-14).
  "Keep the wrapper, the JSON document and LateOn" was measured on a handful
  of targets with an older matcher; the 72-question strict recount is new.
- **Next:** the ordering experiments under "Ordering experiments with the
  local reranker", then a series of proposed changes for Hamza to approve.

## Scope and decisions already made

- Rerankers in scope: LateOn, `rerank-3-lite` (default Voyage model) and
  `rerank-3`. `rerank-2.5` is out of scope as obsolete.
- The definition-fusion rule stays as it is. It is already skipped for both
  Voyage models (`rerankerOrderNeedsDefinitionFusion`,
  `packages/mcp/src/core/search-definition-discovery.ts:38`).
- Strict rank is the primary metric.
- Limits today: `SEARCH_MAX_CANDIDATES = 80` and
  `SEARCH_RERANK_DEFAULT_CANDIDATE_DEPTH = 64`
  (`packages/mcp/src/core/search-constants.ts`). The first caps each
  retrieval request, not the MCP pool: symbol-metadata hits are added after
  the semantic passes (`search-execution.ts:1058`), which is how MCP ranks
  above 80 arise.

## Where the owner is lost

72 questions, strict matching, no caller alt terms.

| Stage | Owners |
|---|---|
| Questions | 72 |
| Reach the fusion step | 59 |
| Owner in the rerank window, among the 59 | 39 strict, 43 lenient |
| Owner in the rerank window, all 72 (baseline capture below) | 47 strict, 51 lenient |
| Best reranker, owner at rank 1 / top 3 | 24 / 32 |
| Strict MRR@10, best reranker / perfect reorder of the window | 0.3906 / 0.5417 |

The 33 strict misses against the fusion step. 25 of them are outside the
window; the 8 in the second row are inside it:

| Group | Count | Questions |
|---|---|---|
| In no arm's top 80 | 18 | `r1 r2 f5 r9_rewritten fresh_r3 p3_rewritten fresh_p1 fresh_p3 fresh_p4 fresh_p5 f4_rewritten f7_rewritten f9_rewritten fresh_f3 fresh_f4 fresh_r4 p8_rewritten fresh_f6` |
| In the window, fusion step not reached | 8 | `r7 p7 f8 r7_rewritten fresh_r6 p7_rewritten fresh_p6 fresh_f5` |
| Cut by the 64 window | 4 | `p3` (rank 89), `fresh_r1` (70), `fresh_r5` (78), `f2_rewritten` (71) |
| Lost in core fusion | 3 | `f7` (owner dedup), `f9` (rank 84 in core fusion before its cut, computed, not an observed MCP rank; measured since: the declaration chunk is at dense rank 369 in the primary pass and at any-terms lexical rank 52 in the expanded pass), `f8_rewritten` (dense 62 only) |

Three sizes follow from this, and they bound every proposal below:

- Retrieval recall: 18 owners (25% of questions).
- Seats and fusion budget: 7 owners.
- Ordering inside the window: about 0.15 MRR (39 owners in the window, 24 at
  rank 1).

## Why widening 64 to 96 or 128 hurts elsewhere

Not measured in this work. This is an explanation consistent with the data,
with the check that would confirm it.

- **The gain is capped at 4 questions.** Only `fresh_r1`, `f2_rewritten`,
  `fresh_r5` and `p3` sit between ranks 65 and 89. The 18 are not at rank 90
  or 120; they are absent.
- **Every question pays.** The other 68 questions get 32 or 64 more
  candidates that fused retrieval already ranked lower. The best reranker
  puts only 24 of 39 in-window owners at rank 1 with 64 candidates, so more
  distractors move some of those down.
- **The extra seats go to the same mix.** Windows are already 42% tests, and
  the candidates past rank 64 are not better.
- **Statistics shift for LateOn.** The name vote's BM25 statistics are
  computed over the window, so its output changes with window composition.
- **Cost doubles.** 64 documents are about 28,000 tokens and 750 ms per
  request on the Voyage models.

Check: replay at depth 96 and list the questions whose rank falls. The
explanation predicts that their owner was already inside 64 and that the
reranker placed new entrants above it.

## Why core fusion loses owners

Read in the code:

- `packages/core/src/core/semantic-search-service.ts` (lines 702 to 741)
  requests up to three arms, each with `limit: resolvedRequest.topK`, which
  is 80: dense, primary lexical (all terms), and a fallback lexical pass (any
  terms) that runs only when the primary pass returns fewer than `topK` rows.
  It fuses them with the same `topK` as the limit.
- `packages/core/src/core/vector-candidate-fusion.ts` skips a candidate whose
  owner id was already seen in the same arm (lines 108 to 110), gives each
  arm's survivors `1 / (k + rank)` with `k = 100` and weight 1 (lines 12 and
  115), and adds scores **per chunk id** (line 116). Two chunks of one owner
  found by different arms do not add up. The fused list is cut at `limit`
  (line 157). The owner id is the owning symbol, or the file path when the
  chunk has no owning symbol (lines 53 to 56).
- When the fallback pass is full, primary lexical hits that the fallback did
  not rank get a top-up equal to one rank past the fallback's end (lines 136
  to 148).
- `packages/mcp/src/core/search-rerank-policy.ts:169` takes
  `candidatePool.slice(0, budget)` for the window.

Consequences:

- Arm depth equals the fused cut, so up to 240 chunks compete for 80 places.
  With `k = 100`, any chunk found by two arms (at least 2/180) outranks every
  chunk found by one (at most 1/101). Single-arm chunks then interleave by
  rank. Measured in the baseline capture: an owner that exactly one arm finds
  survives the fused cut down to about the 45th distinct owner of that arm
  (median 46 on the original 28, range 40 to 54; median 42 on the 44 scored
  conceptual questions, range 40 to 76). `p3`: dense 46, core 80, MCP 89. `f9`: deduplicated rank 43,
  fused 84. `f8_rewritten`: dense 62, lost.
- The lexical arm's evidence comes from its fallback pass for almost every
  natural-language question, because the all-terms pass returns nothing. That
  noisier pass gets the same weight as the dense arm. For `p3`, 32
  fallback-only candidates and 2 double-voted ones overtake the owner.
- Chunks without an owning symbol collapse to one per file per arm.

## Findings not recorded elsewhere

**Test files take a large share of every capped stage.** 72 questions, path
category `tests` from `classifyPathCategory`.

- Window documents by role: 1,655 implementation, 1,204 test (about 42%), 14
  example, 7 configuration. All 45 captured windows hold exactly 64 documents.
- Tests in the pool of 80 / in the window, median: React 53 / 28, Polars
  22 / 16, FlatBuffers 13 / 8, all 25 / 18. 27 of 72 windows hold 24 or more
  tests.
- Owners cut after fusion, counted as non-test candidates ranked above them
  in the pool: `fresh_r1` 12, `f2_rewritten` 29, `p3` 56, `fresh_r5` 59,
  `f9` 67. With test seats re-spent and no widening, the first two fit in 64
  with room, the next two fit narrowly, and `f9` does not.
- Tests fill the arms' top 80 too. This is now measured; see "P1 result".

**Seats are not wasted on duplicates.** Distinct owners per window: median 61
(49 to 64). Distinct paths: median 31. Trimming supplemental chunks frees
about 3 seats.

**`f7` is an attribution miss, not a retrieval miss.** In
`flatbuffers/src/idl_parser.cpp`, `Parser::ParseAnyValue` spans lines 1362 to
1507. The dense rank-1 chunk (lines 1387 to 1444) lies inside it and reached
window rank 7, shown as a file candidate with no symbol.
`resolveOwnerSymbolForChunk` (`packages/core/src/symbols/registry.ts`) assigns
the tightest symbol that contains the chunk and falls back to the file only
when none does. So either no symbol record exists for `ParseAnyValue`, or
containment failed. Not yet checked. Bound: strict and lenient in-window
counts differ by 4 of 59.

**The 18 are mostly a vocabulary gap** (earlier measurement,
[alt terms](agent-alt-terms-definition-discovery.md), 46 questions, dense
only, symbol units):

| Model | Query | hit@10 | hit@100 |
|---|---|---|---|
| Potion | raw | 13 | 29 |
| CodeRankEmbed (Potion's teacher) | raw | 14 | 30 |
| Potion | raw + own alt terms | 24 | 41 |
| CodeRankEmbed | raw + own alt terms | 31 | 38 |

On raw questions 17 of 46 owners are outside the dense top 100 for both
embedders, which matches the 18 of 72 here. Own alt terms recover 12 of them.
Wrong alt terms cost more than none (hit@10 3 against 13).

## P1 result

Run by Hamza's Codex agent on 2026-10-13 against the saved index, read-only,
no alt terms. Its report, per-question results, indexed rows and the 400-deep
arm lists are in `/tmp/satori-owner-diagnostic.FTqoMe/` (`README.md`,
`results.json`, `rows/`, `arms/`, `diagnose.mjs`). It reconstructed 22 query
vectors with matching hashes and reproduced every captured top-80 prefix.

- 11 of the 18 have an acceptable target at rank 96 to 395 in at least one
  arm. 6 are beyond 400: `r1 r9_rewritten fresh_r3 fresh_p3 fresh_p5
  f9_rewritten`. `fresh_f6` is excluded by the captured runtime scope (its
  targets are documentation files).
- Every question that requires a symbol has a matching symbol-level chunk, so
  none of the 18 is an attribution miss.
- `fresh_r4` ran lexical retrieval only: no dense arm exists for it.
  Unexplained.

Computed from those arm lists in this session (`armshare.mjs`): the owner's
best rank as returned, and its rank when test files are not counted and each
owner counts once, as fusion already does.

| Question | Arm | Rank as returned | Without tests, one per owner |
|---|---|---|---|
| `r2` | dense, expanded pass | 205 | 15 |
| `fresh_p4` | dense | 101 | 45 |
| `p8_rewritten` | lexical (dense) | 96 (163) | 55 (79) |
| `f4_rewritten` | lexical | 170 | 57 |
| `f5` | lexical (dense) | 123 (155) | 60 (83) |
| `fresh_f3` | dense | 171 | 67 |
| `fresh_f4` | lexical | 282 | 77 |
| `f7_rewritten` | lexical (dense) | 303 (257) | 79 (133) |
| `fresh_p1` | dense | 172 | 91 |
| `fresh_r4` | lexical | 370 | 166 |
| `p3_rewritten` | dense | 395 | 296 |

- 8 of the 11 are inside an arm's top 80 once tests are not counted.
- Tests in an arm's top 80, over these 18 questions: dense median 27 (2 to
  74), lexical median 29 (2 to 76). The React arms hold 61 to 76 tests in 80,
  so an arm reaches only 4 to 19 implementation candidates there.
- The arm limit counts chunks, and owners are deduplicated afterwards in
  fusion. Counting one per owner alone puts `f5` at lexical rank 75 and
  `p8_rewritten` at 73, both inside 80.
- Limits: these are the 18 hardest questions, not all 72. Reaching an arm's
  top 80 is not reaching the window: a candidate found by one arm still lands
  near twice its rank after fusion. Candidates found by both arms do much
  better (`f5`, `p8_rewritten`, `f7_rewritten`), so deeper arms help most
  where both arms see the owner. What a seat policy or deeper arms cost the
  other questions is not measured; P8 measures it.

## Proposals

Ranked by owners at stake and strength of evidence. Every item is unapproved.
P1 is done. After its result the order to work in is P8, then P3 and P4 as
P8 decides, then P2 for the 6 that no arm reaches.

### P1. Classify the 18 (diagnostic, no product change)

- **What:** for each of the 18, the indexed rows of the target (label, owner
  id, span, whether a symbol-level chunk exists), and its rank in the dense
  arm and the lexical fallback arm widened to 400, with the original query
  embedding. Also the share of test files in each arm's top 80.
- **Classes:** rank 81 to 400 | far or absent | no symbol-level chunk.
- **Sanity check first:** reproduce the known ranks (`p3` dense 46, `f9`
  fallback 52 and deduplicated 43, `f8_rewritten` dense 62).
- **Decides:** whether P2, P3, P4 or P5 is the main lever.
- **Status:** done; see "P1 result". It points at P3 and P4 for 11 owners
  and leaves P2 for 6.

### P2. Measure the 72 questions with caller alt terms (experiment)

- **What:** write own alt terms for the 72 questions and repeat the capture
  with `--alt-terms-file` (`evals/real-repo-quality/run.mjs:41`).
- **Evidence:** the table above, and 27 to 34 of 46 owners in the top 10 in
  the earlier document.
- **Why now:** every figure in this work was taken without alt terms, so it
  understates the product for a caller that sends them. If alt terms recover
  most of the 18, the remaining work is on the calling side (what the tool
  description asks agents to send), not in retrieval.
- **Risk:** wrong terms are worse than none; the wrong-terms arm must be run
  beside it.
- **Status:** done; see "Caller alt terms through the real local reranker".

### P3. Re-spend the 64 seats: a seat policy for test files

- **What:** at window admission, limit the seats test-role candidates can
  take unless the question asks about tests. The limit and the intent signal
  are not designed yet.
- **Owner:** `selectRerankCandidates`
  (`packages/mcp/src/core/search-rerank-policy.ts`).
- **Evidence:** 42% of seats are tests; no test-role candidate is correct in
  the 28 judged windows; 2 to 4 of the 4 window-cut owners would fit.
- **Constraint from history:**
  [Implementation ownership](implementation-owner-ranking.md) rejected a
  blanket path partition, and ownership is "a relevance-qualified goal". So
  this must be a quota conditioned on the question, never a blanket demotion,
  and it must be measured on test-seeking questions.
- **Deciding experiment:** replay window admission offline from the saved
  fused pools and count owners in the window; then one capture run for final
  ranks, with a set of test-seeking questions.

### P4. Core fusion budget

- **What:** four separate experiments, never combined in one run: (a) arm
  depth separate from the fused cut, counted in owners instead of chunks; (b)
  the size of the fused output; (c) a lower weight for the lexical fallback
  pass; (d) adding votes per owner across arms before a representative chunk
  is picked, with the two lexical passes treated as one family.
- **Owner:** `vector-candidate-fusion.ts` and its caller in
  `semantic-search-service.ts`.
- **Evidence:** 3 owners lost in core fusion, plus the two-arm owners among
  the 11 of P1 (`f5`, `p8_rewritten`). Prediction to test: deeper arms alone
  recover no owner seen by a single arm at rank 101 to 205.
- **Risk:** a hot path, and an equivalence test cannot apply because the
  output changes on purpose. Needs a replay with arm-level captures, which
  the current captures do not hold.

### P5. Chunk to symbol attribution

- **What:** two separate items. (a) Find why a chunk inside `ParseAnyValue`
  has no owning symbol and fix that at indexing. The chunk would pass line
  containment if a symbol record existed, so a missing or malformed record is
  the leading hypothesis; inspect the record first. (b) Stop collapsing
  unowned chunks to one per file inside an arm.
- **Owner:** symbol extraction and `resolveOwnerSymbolForChunk`.
- **Evidence:** `f7` read in source. Bound: at most 4 owners.

### P6. Ordering inside the window

- **What:** change what the reranker reads: field order, a qualified-name
  field, excerpt selection (`buildSearchRerankDocument`,
  `packages/mcp/src/core/search-rerank-document.ts:284`).
- **Evidence:** 0.15 MRR of headroom; canonical JSON sorts keys, so the
  excerpt comes after role and label and before path and signature.
- **Deciding experiment:** re-serialise the captured documents in the swap
  hook and call Voyage again. No product change is needed to measure it.
- **Status:** measured for LateOn on 2026-10-14; no form gains. See
  "Ordering experiments with the local reranker". Not run for Voyage.

### P7. Why the fusion step does not run for 13 questions (diagnostic)

Answered by the baseline capture: all 13 are excluded by the step's own
eligibility rule (`packages/mcp/src/core/search-definition-discovery.ts`,
lines 25 to 29), read from each question's recorded query plan. Nine are
test-seeking (`r7 p7 f8 r7_rewritten fresh_r6 p7_rewritten fresh_p6
f8_rewritten fresh_f5`), `fresh_f6` is documentation-seeking, `p8_rewritten`
and `f2_rewritten` take the structural route, and `fresh_r4` takes the
configuration route and is not reranked at all. The 8 owners that are in the
window for such questions are therefore not a fusion loss. Three stages share
the word fusion and must be named apart: core retrieval fusion, MCP pass
fusion, and the definition-fusion step.

### P8. Replay fusion and window admission on deep arms (experiment)

- **What:** for all 72 questions, run the real pipeline through import hooks
  that record every stage without truncation: each arm as requested and at
  depth 400, the core fused list, the full MCP pool entering
  `selectRerankCandidates`, and the window. Variants are hooks on the same
  run, so no product logic is re-implemented. Only the local reranker runs.
- **Self-check:** the unchanged run must reproduce each captured window and
  the first 80 pool entries before any variant is trusted.
- **Variants, one per run:** the four of P4; a seat quota for test files at
  the arm, at the fused cut and at the window, applied only when
  `queryPlan.testSeeking` is false.
- **Metric:** strict owners in the window at a fixed size of 64, counted
  over every rerank window: 47 today (51 lenient), 25 misses. Reported as
  the questions gained and lost per variant rather than a net figure, with
  the nine test-seeking questions as a guard. Latency is measured only for a
  winning variant.
- **Then:** rerank only the winning variant's windows to get final ranks.

## Review by a second agent (2026-10-14)

A Codex worker (`gpt-6.1-sol`) checked this document against the code. Its
corrections that were re-read in source are folded in above: three core arms
with `k = 100`, votes added per chunk id, the request cap of 80 that does not
cap the MCP pool, P4 and P5 split into separate experiments, and the existing
`queryPlan.testSeeking` signal. Stated by the review and not re-checked:
`p3` has 89 MCP candidates and `f9` 140 in the harness log, and a window
above 80 can fill, because its size is bounded by the pool, provider capacity
and a global limit of 128 (`search-rerank-policy.ts:134` to `:159`). Agreed
deciding criterion: the P8 metric. The widening explanation and the doubled
latency remain a hypothesis until measured.

## Baseline capture (2026-10-14)

The P8 capture ran on both question sets with the unchanged pipeline and the
local reranker. Hooks written by the Codex worker record every stage; nothing
in the repository changed.

| Check | Original 28 | Conceptual 46 |
|---|---|---|
| Rerank windows equal the earlier captures, in order | 28 of 28 | 45 of 45 (`fresh_r4` has none) |
| First 80 pool candidates: path, span, order, score, window flag | 28 of 28 | 46 of 46 |
| Same, including the symbol label | 28 of 28 | 43 of 46 |
| Depth-400 arm call agrees with the normal arm on its first rows | 28 of 28 | 46 of 46 |
| Known ranks | `p3` dense 46, pool 89 | `f8_rewritten` dense 62 |

The label difference is 5 rows in `r3_rewritten`, `p1_rewritten` and
`p3_rewritten`, empty in the reference and filled now. The label is read from
the `grouped` stage after the reranker
(`evals/real-repo-quality/harness-logger.mjs:250`), and the reference run for
the conceptual set had definition fusion bypassed by a hook. Read as a
difference in the reference, not in the pipeline; the cause was inferred, not
re-run.

What the complete stages add:

- Owner in the rerank window over all 72 questions: 47 strict, 51 lenient.
  The 25 strict misses are the 18 never retrieved, the 4 cut by the window
  and the 3 lost in core fusion.
- The fused cut line for an owner found by one arm (see "Why core fusion
  loses owners"). An arm-level change alone cannot recover an owner it places
  beyond about the 45th distinct owner; it needs a change at the fused cut as
  well. Of the 8 owners that come inside an arm's top 80 once test files are
  removed, only `r2` (15) and `fresh_p4` (45) are within that line.
- The 13 questions that skip the definition-fusion step are explained (P7).

Variants were then measured one per run with the reranker stubbed (the metric
is read before it). Results are in the next section.

## Variant sweep (2026-10-14)

Each variant replays both sets through the unchanged pipeline with one
transform applied by a hook and counts owners inside the 64-document window
on the 72 scored questions. The `identity` variant (hooks installed, no
transform) reproduces every baseline window exactly: 74 questions, 73
windows. A variant that leaves any window shorter than 64 documents is marked
ineligible, because the window size is fixed.

| Variant | Strict | Lenient | Gained (strict) | Lost (strict) |
|---|---|---|---|---|
| Baseline and `identity` | 47 | 51 | | |
| `arm-owners:400`: arms read to depth 400 and counted by owner | 47 | 51 | none | none |
| `arm-testquota:20`: arms read to depth 400, at most 20 test rows each | 50 | 53 | `r2 fresh_r1 f2_rewritten` | none |
| `arm-testquota:40` | 48 | 51 | `r2` | none |
| `arm-testquota:10` | 51 | 53 | `r2 f7 fresh_r1 f2_rewritten` | none |
| `arm-testquota:0`: no test rows in the arms | 51 | 53 | the same four | none |
| `arm-owners:400,arm-testquota:20` | 50 | 53 | `r2 fresh_r1 f2_rewritten` | none |
| `arm-owners:400,arm-testquota:0` | 51 | 52 | `r2 f7 fresh_r1 f2_rewritten` | none strict; `fresh_r3` lenient |
| `arm-testquota:20,fallback-weight:0.5` | 49 | 52 | `r2 p3 fresh_r1 f2_rewritten f8_rewritten` | `r8 f10 fresh_f5` |
| `arm-owners:400,arm-testquota:20,owner-accum` (owner-level accumulation in fusion) | 50 | 52 | `r2 fresh_r1 f2_rewritten f7` | `f3` |
| `owner-accum` alone | 46 | 50 | none | `f3` |
| `fused-limit:160`: fused cut at 160 instead of 80 | 47 | 51 | none | none |
| `fallback-weight:0.5`: fallback lexical arm at half weight | 48 | 52 | `p3 fresh_r1 f2_rewritten f8_rewritten` | `r8 f10 fresh_f5` |
| `fused-testquota:20`: test cap at the fused cut | 49 | 53 | `fresh_r1 f2_rewritten` | none, but ineligible: 2 short windows |
| `window-testquota:16`: test cap at the window | 49 | 53 | `fresh_r1 f2_rewritten` | none, but ineligible: 17 short windows |

- The test cap is skipped for the nine test-seeking questions, and none of
  them changes under it. Under the half-weight fallback one of them is gained
  (`f8_rewritten`) and one lost (`fresh_f5`).
- Cap size: 40 gains one owner, 20 gains three, 10 and 0 gain four, none
  with a loss. A cap of 10 keeps test rows in the arms and matches removing
  them all on this metric. The lower fallback weight keeps its three losses
  when combined with the cap.
- The cap needs the deeper arm read to gain `r2` (raw arm rank 205).
  `fresh_r1` and `f2_rewritten` are also recovered by a cap at depth 80, but
  the window then runs short, which is why the two later-stage caps are
  ineligible.
- Counting arms by owner adds nothing, alone or on top of the cap, and a
  larger fused cut adds nothing. Reading: the window, not the fused cut, is
  the binding limit for an owner found by one arm (see "Why core fusion loses
  owners").

Where the 22 remaining strict misses stop under
`arm-owners:400,arm-testquota:20`:

| Furthest stage | Count | Questions |
|---|---|---|
| In the fused list, outside the window | 4 | `p3 f7 f9 fresh_r5` |
| In an arm's first 80, dropped by core fusion | 5 | `f5 p8_rewritten fresh_p4 f4_rewritten f8_rewritten` |
| In no arm's first 80 | 13 | `r1 r9_rewritten fresh_r3 fresh_r4 p3_rewritten fresh_p1 fresh_p3 fresh_p5 f7_rewritten f9_rewritten fresh_f3 fresh_f4 fresh_f6` |

Six of the 13 are not within depth 400 of either arm (`r1 r9_rewritten
fresh_r3 fresh_p3 fresh_p5 f9_rewritten`). Under the cap alone at 10 the 21
remaining are 3 outside the window (`p3 f9 fresh_r5`), 3 dropped by core
fusion (`fresh_p4 f4_rewritten f8_rewritten`) and 15 in no arm's first 80.
Those in the first two rows have no clean fix among the variants: owner
accumulation loses `f3`, and the half-weight fallback moves `p3` and
`f8_rewritten` into the window while `f9` and `fresh_r5` fall back a stage and
three other owners leave the window.

### What limits MRR with the local reranker

Final ranks from the baseline capture with the real local reranker (lenient
rank in the response):

| | Original 28 | Conceptual 46 | Scored 72 |
|---|---|---|---|
| Owner in the window | 25 | 27 | 51 |
| Rank 1 | 13 | 8 | 21 |
| Within 5 | 19 | 14 | 32 |
| Within 10 | 21 | 16 | 36 |
| MRR (strict) | 0.5557 (0.5378) | 0.2297 (0.2188) | 0.3559 (0.3420) |

Upper bounds on MRR over the 72, from these counts:

| Lever | Bound | Arithmetic |
|---|---|---|
| Every in-window owner ranked first | +0.35 | 51 / 72 = 0.708 against 0.356 |
| The 19 owners still outside the window after the cap, brought in and ranked first | +0.26 | 19 / 72 |
| The test cap at 10, its owners ranked first | +0.03 lenient, +0.06 strict | 2 / 72, 4 / 72 |

Reading: fusion changes that respect the fixed window are close to exhausted.
The cap is the only one with a gain and no loss in the window, and through
the real reranker it is worth between -0.001 and +0.019 MRR (see "The cap
through the real local reranker"). Most of the
missing MRR is ordering inside the window (30 of the 51 in-window owners are
not first, 15 are below rank 10 or absent), which no variant here touches
(see "Where in-window owners lose first place"). The 13 never-retrieved owners cannot be
helped at the fused stage. For those, the earlier measurement in "Findings not
recorded elsewhere" argues that the lever is the query's vocabulary, not the
embedder: raw hit@100 is 29 against 30 across two embedders and 41 with own
alt terms. Voyage embeddings themselves were not measured.

### Where in-window owners lose first place

Analysed by the Codex worker from the baseline capture; its script
(`ordering/analyze.mjs`) reproduces the figures above before it reports.
Rank 1 among the 51 in-window owners, step by step:

| Step | Lenient rank 1 | Strict rank 1 |
|---|---|---|
| Window input (fused order) | 9 | 9 |
| Raw reranker order | 16 | 12 |
| After definition fusion and implementation preference | 21 | 20 |
| Grouped, disclosed, final | 21 | 21 |

- The reranker's own order is the main loss: 26 of the 30 owners that do not
  finish first already trail another row in the raw order. The step after it
  is a net gain of 5 (9 promoted to first, 4 demoted to second: `p1 f9
  r2_rewritten f1_rewritten`). No later step costs a first place.
- Above those 30 owners the raw order holds 433 rows: 176 tests and 256 other
  source, 415 of them from a different file and none a second chunk of the
  owner. Of the test rows, 97 precede 13 owners whose question is not
  test-seeking; the other 79 belong to test-seeking questions.
- All 15 owners that finish below rank 10 are absent from the response: 10
  fall past the visible limit and 5 are removed by the per-file cap
  (`search-grouping.ts:78` to `:110`). Eleven were already below rank 10 in
  the raw order. The four that were not: `r3_rewritten` (raw 3, grouped 5,
  removed as the fourth group of its file), `fresh_p2` (raw 2, 29 after the
  fusion step), `f10` (9 to 14) and `f6_rewritten` (9 to 20).

Scored on the raw reranker list alone (a list diagnostic over the 72, not a
replayed response):

| Raw reranker list | Rank 1 / 5 / 10 | MRR | Strict MRR |
|---|---|---|---|
| As returned | 16 / 30 / 37 | 0.3184 | 0.2696 |
| Test rows removed unless the question is test-seeking | 19 / 34 / 42 | 0.3608 | 0.3096 |
| One row per owner | 16 / 30 / 37 | 0.3184 | 0.2697 |

Reading: removing tests from the reranker's list recovers about 0.04. The
rest of the gap to 0.71 is other source code ranked above the owner, which is
the reranker's quality and not a fusion or seat problem. Duplicate owner
chunks are not a factor. Limits: definition fusion and implementation
preference are captured as one step; four in-window matches are file-level
only (`r2 f7 f9 fresh_r3`); "different file" is an identity relation, not
proof that the row is irrelevant.

### The cap through the real local reranker

Both sets replayed with the real local reranker, once per cap, and scored on
the response (lenient, strict in brackets):

| Run | Owner in the window | Rank 1 / 5 / 10 | MRR, scored 72 | MRR, original 28 | MRR, conceptual 46 |
|---|---|---|---|---|---|
| Baseline | 51 | 21 / 32 / 36 | 0.3559 (0.3420) | 0.5557 (0.5378) | 0.2297 (0.2188) |
| `arm-testquota:10` | 53 | 21 / 33 / 37 | 0.3552 (0.3436) | 0.5467 (0.5289) | 0.2341 (0.2268) |
| `arm-testquota:20` | 53 | 23 / 33 / 37 | 0.3748 (0.3539) | 0.5818 (0.5461) | 0.2433 (0.2324) |
| `arm-testquota:0` | 53 | 22 / 33 / 37 | 0.3646 (0.3530) | 0.5709 (0.5531) | 0.2341 (0.2268) |

Every lenient rank that changed against the baseline:

| Cap | Better | Worse |
|---|---|---|
| 10 | `r2` absent to 2, `r2_rewritten` 2 to 1 | `p1` 2 to 4, `p5` 1 to 2, `p5_rewritten` 3 to 5, `f1_rewritten` 2 to 3 |
| 20 | `r2` absent to 2, `r2_rewritten` 2 to 1, `f9` 2 to 1, `fresh_r1` absent to 8 | `p1` 2 to 3, `f3` 10 to absent |
| 0 | `r2` absent to 2, `r2_rewritten` 2 to 1, `f3` 10 to 9 | `p2` 3 to 4, `p5_rewritten` 3 to 5, `f1_rewritten` 2 to 3 |

- Control: questions whose window the cap leaves unchanged (20, 30 and 10 of
  them at caps of 10, 20 and 0) keep every rank, so the differences come from
  the changed windows and not from run-to-run variation.
- Of the owners the cap brings into the window, `r2` reaches rank 2 at every
  cap and `fresh_r1` reaches rank 8 at 20 only. `f2_rewritten` and `f7` enter
  the window and stay out of the response.
- The same change of window contents moves other owners down a place or two,
  which cancels most of the gain. One question at rank 1 instead of 2 is worth
  0.007 over 72, so the spread between the caps (0.02) is under three such
  moves and does not rank them.

Reading: the cap does what the sweep showed for the window (two more owners,
no owner lost from it) and almost nothing for MRR with this reranker, because
the owners it admits are ranked low by the reranker and the displaced rows
reorder a few other questions. It is consistent with "Where in-window owners
lose first place": seats are not what limits this reranker. Whether a
stronger reranker turns the two extra owners into first places is not
measured.

### Caller alt terms through the real local reranker

P2, run 2026-10-14. Same harness, index and reranker as the baseline capture,
plus `--alt-terms-file`. The terms are the files from commit `5f03a5b3`
(`conceptual-alt-terms-n4-primary.json` and `-n4-shuffled.json`): four terms
per question for all 72, written by `opencode/muse-spark-1.3-contributor-free`
from the question and repository name alone. The wrong-terms arm gives each
question the terms of another question in the same repository. Default flags
(`definition_alt_terms` and `rerank_alt_terms` on). Lenient MRR, strict in
brackets.

| Run | In window | Rank 1 / 5 / 10 | MRR 72 | MRR 28 | MRR 46 |
|---|---|---|---|---|---|
| No terms (baseline) | 51 | 21 / 32 / 36 | 0.3559 (0.3420) | 0.5557 (0.5378) | 0.2297 (0.2188) |
| Own terms | 64 | 27 / 48 / 56 | 0.4985 (0.4932) | 0.5671 (0.5593) | 0.4786 (0.4750) |
| Another question's terms | 43 | 7 / 22 / 27 | 0.1823 (0.1800) | 0.3111 (0.3051) | 0.0960 (0.0960) |

- **Reach:** own terms bring 13 owners into the window and lose none. Eight
  of the 72 stay outside it.
- **The 46 conceptual questions carry the gain** (MRR 0.2297 to 0.4786, rank
  1 from 8 to 17), which reproduces the earlier 0.230 to 0.463.
- **The original 28 gain reach, not MRR:** top 10 goes from 21 to 26, rank 1
  from 13 to 12. Six questions that were first drop (`f1` 1 to 10, `p8` and
  `f8` 1 to 4, `r4`, `r5`, `f4` 1 to 2), offset by `r1`, `r2`, `r3` and `p3`
  appearing and `r7`, `r8`, `p1` reaching first.
- **Losses with own terms:** four owners still in the window leave the
  response (`r2_rewritten` from 2, `f1_rewritten` from 2, `f10_rewritten`
  from 5, `fresh_r6` from 10).
- **Ordering is now the larger gap:** 64 owners are in the window and 27
  finish first.
- **Wrong terms** remove 8 owners from the window and 14 first places.

Limits: one model wrote the terms, and React, Polars and FlatBuffers are
public repositories it may know by name (`r1` received
`commitHookEffectListUnmount`). A caller on a private repository will write
weaker terms, so 0.4985 is an upper reading, and the wrong-terms arm is a
stress test, not a typical caller. Outputs:
`~/.cache/satori-owner-recall/codex/replay/variants/out-real/alt-own` and
`alt-shuffled`.

**Follow-up, 2026-10-14.** The feature is already shipped and documented: the
`alt_terms` field description, the README ("Plain-English questions"), the
Satori skill, the product guide and the reference all describe it. The tool's
main description did not. One sentence was added after the `scope="runtime"`
default (`packages/mcp/src/tools/search_codebase.ts`): "For a plain-English
question, also pass up to 4 likely code identifiers in alt_terms: grounded
guesses raise owner recall, unrelated ones rank worse than none." Typecheck,
`docs:check`, `manifest:check` and `src/tools/registry.test.ts` pass. The MCP
server instructions (`SATORI_MCP_INSTRUCTIONS`,
`packages/mcp/src/server/shared-runtime.ts`) still do not mention alt terms;
that was not approved and is not changed.

### Ordering experiments with the local reranker

Started 2026-10-14 for P6, widened beyond it. The question: with the owner
among the 64 candidates, what makes LateOn put it first more often, without
fitting these 72 questions? LateOn's score is a sum over the question's
tokens of the best match in the document, computed by Satori
(`maxSimScore`, `packages/mcp/src/server/lateon-reranker-encoder.ts`); every
token counts equally, wrapper words included, and nothing normalises for
length.

**Tests vote: ruled out with today's links.** On the recorded LateOn orders,
a document inherits the best score of any window document that calls it or
holds a reference to it.

| Raw LateOn order | Rank 1 (strict) | MRR (strict) |
|---|---|---|
| No terms, as recorded | 16 (12) | 0.3184 (0.2696) |
| No terms, inherit best linked score | 16 (12) | 0.3202 (0.2726) |
| No terms, rank-reciprocal vote | 10 (9) | 0.2503 (0.2374) |
| Own terms, as recorded | 26 (24) | 0.4798 (0.4478) |
| Own terms, inherit best linked score | 26 (24) | 0.4773 (0.4458) |

Of 35 owners in the window and not first, one has a linked document above it
(two of 36 with own terms). `supporting_tests` is empty in all 4,544 window
documents, so a test is tied to code only where a call edge or reference was
indexed. The idea is closed for these links, not for a better link source.
Script: `vote.mjs <base|alt-own>` in the session scratch directory.

**What LateOn reads: not a lever.** P6, through the full pipeline with the
real reranker and no caller terms. A hook rewrote the query or the documents
just before the model; retrieval, the window and every later step are the
shipped ones. Lenient MRR, strict in brackets.

| LateOn input | Rank 1 / 5 / 10 | MRR 72 | MRR 28 | MRR 46 |
|---|---|---|---|---|
| Shipped (wrapped question, JSON document) | 21 / 32 / 36 | 0.3559 (0.3420) | 0.5557 (0.5378) | 0.2297 (0.2188) |
| Bare question, no wrapper | 21 / 31 / 36 | 0.3598 (0.3405) | 0.5628 (0.5271) | 0.2314 (0.2229) |
| Plain-text document | 20 / 32 / 37 | 0.3481 (0.3342) | 0.5369 (0.5190) | 0.2289 (0.2181) |
| Path, label, signature and excerpt only | 20 / 34 / 38 | 0.3497 (0.3288) | 0.5111 (0.4932) | 0.2471 (0.2254) |

- Each form moves 13 to 15 questions, about as many up as down. No form is
  outside one or two questions of the shipped one on either set.
- Dropping references and structural context costs the 28 two first places
  (`p5`, `p6`, `f8` drop; `f3` goes from 10 to 1) and gains the 46 reach
  (top 10 from 16 to 19). Not a net gain.
- This agrees with the earlier lab ("keep the wrapper and the JSON
  projection") on a larger set with the strict matcher. The pinned request
  contract stays as it is.
- Forms: `q-bare`, `d-plain`, `d-core` in `lateon-form.mjs`; outputs in
  `variants/out-real/form-*`; the identity-fields-first form was not run.

**Token-level scoring rules: no general winner.** P6. LateOn's score is a
sum, over the question's tokens, of each token's best match in the document.
A capture stored that per-token value for every question and every document
in the window, without and with caller terms, for three document forms (the
shipped JSON, the core plain text, and a "name card" of path, label and
signature) and two question forms (wrapped and bare). The per-token sums
reproduce the recorded scores (largest difference 0.00008 over 9,088
documents). Rules were replayed on raw reranker order, so definition fusion
is not applied. First place, strict in brackets, then lenient MRR.

| Rule | No caller terms | Caller terms |
|---|---|---|
| Shipped sum | 16 (12), 0.3184 | 26 (24), 0.4798 |
| Weight each token by its spread across the 64 candidates | 20 (16), 0.3410 | 18 (16), 0.4091 |
| Square root of that spread | 21 (17), 0.3493 | 19 (17), 0.4212 |
| Standardise each token across the candidates | 6 (5), 0.1766 | 11 (11), 0.2376 |
| Content tokens only | 18 (15), 0.3284 | 24 (22), 0.4612 |
| Question tokens only, wrapper tokens dropped | 15 (11), 0.3047 | 24 (22), 0.4589 |
| Bare question | 16 (11), 0.3157 | 27 (26), 0.5097 |
| Remove the part a log-length line explains | 17 (14), 0.3287 | 25 (23), 0.4678 |
| Per token, the better of the document and its name card | 17 (14), 0.3151 | 29 (25), 0.5255 |
| Standardised document score plus standardised name-card score | 14 (12), 0.2901 | 29 (27), 0.5188 |
| Four views averaged (JSON and core, wrapped and bare) | 17 (13), 0.3136 | 30 (27), 0.5188 |
| Reciprocal-rank fusion with the window's input order, k = 10 | 16 (14), 0.3272 | 24 (24), 0.4671 |

- No rule gains on both sources. Weighting by spread gains four first places
  without terms and loses eight with them. The name-card rules gain three or
  four with terms and are flat or negative without.
- The largest gain, 0.046 MRR with terms, is at the edge of what 72
  questions separate, and it would cost one extra short encoding per
  document.
- Scores are tightly packed. The median window has a standard deviation of
  0.32 on a score near 20, and where the owner is in the window and not
  first, its median gap to first place is 0.75 of that deviation. Averaging
  views does not help, so the errors are shared across views, not random.
- Length is not the cause: the correlation between score and log length has
  a median of -0.01 across windows.
- Scripts: `capture-tokens.mjs`, `rules.mjs`, `peek.mjs`, `spread.mjs`,
  `attrib.mjs` in the session scratch directory `tok/`; capture in
  `~/.cache/satori-owner-recall/tok/` (15 MB).

**Definition fusion's moves, counted.** P6. A second agent pointed at the
shape of the fusion score, and the recorded stage dumps confirm it. In
`fuseDefinitionDiscovery`
(`packages/mcp/src/core/search-definition-discovery.ts:104`) a candidate
whose name or path matches any question word gets a second rank vote of up
to 1/61, and a candidate with no match gets zero. A one-word match at
reranker rank 28 (1/88 + 1/87) therefore outranks an unmatched candidate at
rank 2 (1/62). The `reranker_output` stage holds both the reranker's rank
and the order after fusion, so each owner's move can be read directly.
Lenient ranks, 72 questions.

| | No caller terms | Caller terms |
|---|---|---|
| Owners first, reranker order | 16 | 26 |
| Owners first, after fusion | 21 | 29 |
| Taken to first by fusion | 9 | 9 |
| Taken from first by fusion | 4 | 6 |
| Owners moved up, down, unchanged | 17, 15, 19 | 22, 12, 30 |
| MRR gained by the upward moves | 0.086 | 0.097 |
| MRR lost by the downward moves | 0.042 | 0.074 |

- Taken from first without terms: `28/p1`, `28/f9`, `46/r2_rewritten`,
  `46/f1_rewritten`, each to rank 2. With terms: `28/r2` to 3, `28/f1` to 9,
  `28/f9` to 4, `46/r2_rewritten` to 10, `46/p6_rewritten` to 2,
  `46/f5_rewritten` to 3. `46/fresh_p2` falls from 2 to 29 without terms.
- Fusion is a net gain for LateOn on both sources, so removing it is wrong.
  The lost MRR is the ceiling for a rule that keeps the upward moves and
  drops the downward ones: 0.042 without terms, 0.074 with them. This
  replaces the earlier 0.012 estimate, which counted only the four owners
  that fell out of the top ten.
- Untested candidate with no tuned number: rank unmatched candidates as tied
  last (the standard treatment of a missing rank) instead of scoring them
  zero. A second candidate, matching word stems so `optimization` meets
  `optimize`, needs a suffix list and also helps the generic distractors
  match; measure it separately.
- The same review's other proposals were checked against the token capture
  and closed: a window-contrastive score (residual above the token's median,
  divided by its median absolute deviation) gives 3 first, 0.1565 without
  terms and 11 first, 0.2740 with them; summing only the question's tokens
  gives 15, 0.3047 and 24, 0.4589. Its chunk-labelling point is P5.
- Script: `fusion-moves.mjs` in the session scratch directory `tok/`.

### Pending

- Identifier splitting before LateOn encodes: run, no gain. Full pipeline,
  ranks 1/5/10 and MRR (strict): 23/31/37, 0.3704 (0.3482) without caller
  terms against 21/32/36, 0.3559 (0.3420); 28/46/57, 0.5047 (0.4984) with
  them against 27/48/56, 0.4985 (0.4932). With terms the raw reranker order
  falls from 26 owners first to 20. Closed; see the handoff's results log.
- Definition fusion with a tie rank for unmatched candidates: run end to end
  on both sources, no gain. 21/32/37, 0.3553 (0.3414) without caller terms
  and 27/48/55, 0.4960 (0.4905) with them. The owners that lose first place
  lose it to matched candidates, which a tie rank does not move. Closed; see
  the handoff's results log.
- `rrf cov2 k5 w0.75` for LateOn, end to end: 0.3877 (0.3478) without caller
  terms and 0.5040 (0.4924) with them. Strict rank gains 0.006 and loses
  0.001, so the shipped rule stays.
- `rerank-3-lite`, end to end, fusion off: 0.5160 (0.4813) without caller
  terms and 0.5959 (0.5770) with them, against LateOn's 0.3559 and 0.4985.
- Latency of the depth-400 arm read (medians of three runs), needed only if a
  cap is proposed. The sweep's own timings are not comparable: the hooks add
  depth-400 diagnostic reads.

## Not proposed, with the measurement that argues against it

- Widening the rerank window (this document).
- A new name-vote rule for the Voyage models: no rule gains more than one
  question in 72.
- A blanket demotion of test paths (rejected earlier).
- Swapping the embedder to recover raw-question recall: hit@100 29 against 30.
- Dual rerank, pool reservation, window reservation and an area cap: all
  measured in the alt-terms document, none gained.

## Resuming this work

- A partial copy of the first scratch directory is at
  `~/.cache/satori-owner-recall/` (scripts, replay and sweep tooling, the
  `bake46` captures, the real-reranker runs, and a fresh `replay/state` copy
  of the saved index). The stubbed sweep outputs for `identity`,
  `owner-accum`, `window-testquota:16` and `fused-testquota:20` are missing or
  partial there, and so are the second agent's reply files.
- The first scratch directory below was withdrawn from the session that wrote
  it on 2026-10-14, after the runs in this document finished. Its files were
  not copied into the repository and that session could no longer read or
  clean them, so the 1.6 GB `replay/state` copy named below was left in place.
- Captures and scripts are in session scratch directories under
  `/tmp/claude-1000/-home-hamza-repo-satori/` and do not survive a reboot:
  `b46323f6-14ca-4460-9579-4668696e371c/scratchpad` (scripts, `bake46`
  captures of the 46 conceptual questions) and
  `bdccc2aa-85d9-4da8-9d11-dc9fcd2cd25e/scratchpad/bake` (captures of the
  original 28). **The second directory holds an API key file named `key`.
  Never read, print or copy it.**
- `fused-pool.json` holds the first 80 MCP candidates per question, not the
  arms and not the whole pool. Arm-level data for the 18 is in
  `/tmp/satori-owner-diagnostic.FTqoMe/`; `armshare.mjs` computes the
  test-share ranks from it.
- The second agent's workspace is `b46323f6-...-4668696e371c/scratchpad/codex`
  (`turn1-reply.md` to `turn3-reply.md`, `briefs/`). Its `replay/` holds the
  capture hooks, `run.sh <28|46>`, `selfcheck.mjs <28|46>` and the baseline
  stages (`replay/stages/<set>/<question>.json`, about 8 MB each).
  `winbase.mjs` there defines the owner-in-window metric.
- Variant sweep: `replay/variants/` (`sweep.sh VARIANT...`, `transforms.mjs`,
  `compare.mjs`, `comparison.json`, outputs in `out/<variant>/`). Reruns with
  the real reranker: `scratchpad/real.sh VARIANT...` writes
  `variants/out-real/`, and `node scratchpad/mrr-compare.mjs VARIANT...`
  prints final ranks and MRR against the baseline. `replay/state` is a 1.6 GB
  copy of the saved index (`~/.cache/satori-behavior-20261012/state`); delete
  it by hand when the captures are no longer needed.
- Replay commands are in the "Reproducing" section of the root-cause
  document. Test-share figures: `node testshare.mjs <fused-pool.json> ...`.
- Eval repository checkouts: `~/.cache/satori-eval-repos/`.
- Working arrangement asked for by Hamza: Claude and a Codex worker
  (`gpt-6.1-sol`, effort `xhigh`, through `claive`) design this together, and
  Codex takes the larger tasks, starting with P1.
