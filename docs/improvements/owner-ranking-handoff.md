# Owner ranking: handoff for an independent agent

Written 2026-10-14 on `master` at `224183ca`. Status: open investigation.

Update, 23 October: the Satori runtime trial finds another admission and
ranking miss for a delegating handler. The
[S1 experiment plan](s1-owner-discovery-plan-2026-10-23.md) tests existing
metadata, file-symbol supplementation, and definition fusion separately.
The [normalization replay](s1-normalization-experiment-2026-10-23.md) rejects
the tested rules as sufficient: runtime metadata rank remains 663 and the
supplement still excludes the target. Graph expansion and scoring changes
remain unproven. This addendum does not change historical measurements below.

The subsequent [declaration-evidence replay](s1-declaration-evidence-experiment-2026-10-23.md)
admits S1 with name priority and trial role normalization, but loses the React
state-update owner from supplementation under both tokenizers. Reject an
unconditional name-priority replacement. The probes do not measure final search rank.

The [graph experiment](s1-graph-evidence-experiment-2026-10-23.md) now checks
the real entrypoint-to-handler-to-coordinator path through production sidecars.
Both proof-backed edges survive read-back. The entrypoint reaches 19 targets,
and its three-callee document context includes the handler. With admission
fixed, handler-only labels improve provider rank from 58 to 52. Fusion stays
at 16. The parent reproduces complete scores and ordering. Automatic discovery
remains unproven.

## Webharness budget comparison, 23 October 2026

Status: the uncommitted budget change improves one of five queries at output
limit five. Other owner misses remain. No fusion or routing repair is selected.
The pipeline and 64-candidate measurements below this addendum describe the
historical builds, not the current uncommitted budget policy.

### Setup and evidence boundary

The delegated comparison uses baseline `e92b3e906189daaebcf3d56721a70d305b4be063`
and that commit plus the existing 15 modified files under `packages/mcp/src/core/`.
The worker builds both copies with
`node ../../node_modules/typescript7/bin/tsc --build --pretty false` and starts
each built `packages/mcp/dist/index.js` through `connectCliMcpSession`.
Neither arm uses the installed runtime. The fixed build retrieves up to 80
candidates per arm and admits up to 128 rerank candidates, independent of output
limit. Available candidates, provider capacity, family selection, and byte limits
still apply. The old advertised-capacity policy admits up to 64 at limit five.

Both arms use an isolated copy of the existing Webharness state and LanceDB:

- Root: `/home/hamza/repo/webharness`, previously recorded HEAD `10842e1`.
- Publication: `7eb04fb1ca1bf0ad06d8ae1b329f712d42b24becf64725dd88f40e88ea6f84c2`.
- Generation: `91535a12-4e4e-45d2-a71c-c8da8cd9e0be`.
- Offline profile, LanceDB, Potion
  `minishlab/potion-code-16M-v2@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b`, dimension 256.
- LateOn `LateOn-Code-edge@07ef20f406c86badca122464808f4cac2f6e4b25`, profile
  `lateon_offline_quality_projection_v6_d128_v1`, activation policy
  `lateon_context_v6_d128_owner_default_v1`.

Requests use `scope=runtime`, `resultMode=grouped`, `groupBy=symbol`,
`rankingMode=default`, `limit=5`, `debugMode=full`, and `debugCandidateLimit=160`.
No alternate terms or experimental ranking flags are supplied. Three samples
per build run in order HEAD1, fixed1, fixed2, HEAD2, HEAD3, fixed3. Top-five lists
and target ranks remain stable within each arm. No sync or reindex occurs.

The API rejects explicit `disclosureLimit=10` with `limit=5`.
`packages/mcp/src/tools/search_codebase.ts` requires disclosure not to exceed
the requested total. The worker omits disclosureLimit and returns five results.
This corrects the earlier proposed invalid request. Keep the validation:
`limit=20, disclosureLimit=10` is valid when ten visible results are wanted.
Output and disclosure limits do not set the fixed build's retrieval budget.

The queries are:

1. `Trace a request from bin/websession-call to the websession-adapter client. Name the functions that select the adapter and make the request.`
2. `Where does browser-fast resolve lifecycle for an action command? Name the normal path and any lifecycle-bypass function.`
3. `How do runtime-leases.acquireRuntimeLease and one-mcp-runtime-ownership.reclaimStaleRuntimeOwnership relate? Identify their state and call sites.`
4. `Where does browser-fast select its Linux browser backend? Identify the settings that determine the target.`
5. `How does browser-memory choose the persistent profile root and canonical browser host?`

### Measured results

Counts and medians are baseline → fixed. Raw dense counts exclude other
retrieval lanes. Rerank input can therefore exceed that count.

| Query | Raw dense count | Rerank input | Grouped count | Median call latency |
|---|---:|---:|---:|---:|
| Q1 | 40 → 80 | 40 → 80 | 40 → 80 | 6,235.9 → 7,275.0 ms |
| Q2 | 40 → 80 | 64 → 100 | 64 → 100 | 2,481.7 → 3,614.5 ms |
| Q3 | 40 → 80 | 40 → 80 | 40 → 80 | 1,690.1 → 2,854.6 ms |
| Q4 | 0 → 0 | 0 → 0 | 27 → 57 | 109.8 → 198.6 ms |
| Q5 | 40 → 80 | 64 → 128 | 76 → 128 | 2,133.8 → 3,361.6 ms |

All requests disclose five results. Q4 uses lexical retrieval and skips reranking.
Selected exact-symbol outcomes follow. Absence means no hit in the captured
stages, not merely absence from the visible five.

| Query and target | Baseline → fixed | Interpretation |
|---|---|---|
| Q1 `request` | Absent → visible 4 | Lexical rank 46 now reaches rerank input 61, provider 4, grouped 4 |
| Q1 `callMcpTool` | Absent → visible 5 | Lexical rank 64 now reaches rerank input 71, provider 7, grouped 7 |
| Q1 `connectMcp` | Visible 5 → outside visible five | Grouped rank 6 → 8 |
| Q1 `publicBase` | Grouped 9 → 11 | More admission does not preserve every target rank |
| Q2 `withoutLifecycle` | Provider 1 → 1, grouped 14 → 15 | Post-provider policy still hides the bypass function |
| Q2 `actionCommand`, `execute` | Visible 1 and 2 in both arms | Normal-path owners remain visible |
| Q2 `serializeLifecycle` | Visible 3 → 4 | The backend resolver moves from visible 4 → 3 |
| Q3 `acquireRuntimeLease` | Grouped 7 → 7 | Wider admission does not repair this miss |
| Q3 `reclaimStaleRuntimeOwnership` | Visible 2 → 2 | Unchanged |
| Q4 `resolveLinuxBrowserBackend` | Grouped 13 → 13 | Wider lexical discovery does not repair final rank |
| Q5 `canonicalBrowserHost`, `defaultBrowserMemoryRoot`, `resolveBrowserMemory` | Visible 1, 2, and 4 in both arms | Unchanged |

Provider output counts match rerank input counts. The distinction between
grouped and visible ranks matters: grouping diagnostics include candidates
that do not become disclosed results. Do not substitute one rank for the other.

Peak process-tree RSS across the three runs is 2,599 / 2,621 / 2,625 MiB on
baseline and 2,594 / 2,638 / 2,696 MiB on fixed. Peak single-process RSS is
1,210 / 1,211 / 1,220 MiB and 1,274 / 1,290 / 1,306 MiB respectively. Each run
uses at most eight processes. One-minute system load ranges from 0.26 to 3.89.
Latency medians rise in every query, but host-load variation prevents attributing
the entire difference to the budget change.

The earlier reported comparison at `limit=20, disclosureLimit=10` finds identical
top-ten lists across both builds. At those parameters the advertised-capacity
budgets already match. That result does not measure the changed narrow-request
behavior. Retrieval changes below limit ten. Advertised-capacity reranking can
change below limit twenty, including limit ten, subject to the pool and provider.
The old no-advertised-capacity path uses a different adaptive formula.

Evidence source: the completed T3 task `Measure limit-5 search budgets`, with
client request ID `satori-limit5-budget-comparison-20261023-1`, reports the above
counts, ranks, runtime identities, and cleanup. The parent checks the API
validation and removal of `/tmp/satori-retrieval-budget.7GJHgW`. The worker
removes the scratch runner, captures, and copied state. These tables preserve
the returned summary, not raw captures or a retained executable harness.
The worker makes no repository edits. The parent separately runs 65 tests
across search-policy, search-rerank-policy, search-rerank-request-contract, and
search-execution.golden before this documentation update, all passing.
This five-query comparison does not establish general accuracy or S1 acceptance.

### Proposed next action, not an implemented repair

Keep the bounded budget change for the demonstrated Q1 recovery. Do not enlarge
budgets again as the next repair. Do not relax the disclosure validation.

Test one change at the post-provider boundary using existing owner cases and
negative controls. The leading hypothesis is that definition fusion gives
name evidence enough weight to override a correct provider result. Q2 is a
direct acceptance case: `withoutLifecycle` must reach the visible first five
while `actionCommand` and `execute` remain visible. A provider-first rule alone
is not selected: historical LateOn results show that fusion also repairs errors.
No confidence threshold or new weighting formula is established by this run.

Preserve strict owner quality on the existing 72-query set and explicit helper,
test, reference, and path requests. Reject a rule that fixes Q2 by moving the
loss elsewhere. Stop after one controlled comparison, reporting target ranks
and regressions. A passing comparison selects a repair, not a new tuning loop.
No production fusion change is authorized by this documentation update.

S1 remains a separate acceptance gap: the ordinary query misses admission and
the admitted control still loses after reranking. Follow the existing
[S1 deciding experiment](s1-owner-discovery-plan-2026-10-23.md#next-deciding-experiment-not-yet-executed)
for call-backed admission and ownership-aware fusion. The Webharness budget
gain does not establish either mechanism or repair S1.

## Historical investigation

This is the entry point for an agent that has the repository and nothing
else: no earlier conversation, no scratch files. It tells the story in order,
says which document holds which evidence, states the open problem, and lists
what is needed to measure a new idea. It holds no measurement of its own
except the [results log](#results-log); every other figure is quoted from the
document named beside it.

## The problem

A coding agent asks Satori a question in plain English ("where does the
builder finish a buffer"). The **owner** is the symbol that implements the
answer. The goal is the owner at rank 1 of `search_codebase`.

- **Questions:** 72 scored. 28 in `evals/real-repo-quality/cases.json` and 46
  in `conceptual-cases.json`; `r1` and `r8` of the 46 repeat the 28 and are
  not counted twice. Repositories: React, Polars and FlatBuffers at the
  commits pinned in those files.
- **Metric:** strict rank is primary (the owning symbol must match); lenient
  rank (the right file is enough) is secondary. `scoreQuery` in
  `evals/real-repo-quality/score.mjs` returns both. Tables give lenient MRR
  with strict in brackets unless they say otherwise.
- **Rerankers in scope:** LateOn (local, the default), Voyage `rerank-3-lite`
  (the Voyage default) and `rerank-3`. `rerank-2.5` is out of scope.

Provenance (recorded 2026-10-23 at `26eba5c8`, annotated 25 October 2026): every figure below is
measured on the 72-question set, from captures taken before `07ab8334` (Jev judges, which changed
only `evals/judges/`) and before `0a2aa66c` (inflected query words in definition fusion). The
28-question reference in item 1 (13 owners first, MRR 0.5557) is the pre-`5f96827c` capture. The
current build `fb125738` measures 13/21/23 and MRR 0.5545 on those 28 questions. A 72-question
figure is not comparable with a 28-question figure.

## The pipeline, and where each loss sits

1. Retrieval arms: dense (Potion embeddings), lexical, lexical fallback.
2. Core fusion of the arms
   (`packages/core/src/core/vector-candidate-fusion.ts`).
3. MCP candidate pool, at most 80 per request plus symbol-metadata hits.
4. Rerank window: the first 64 candidates.
5. Reranker orders the window (LateOn or Voyage).
6. Definition fusion (a symbol-name vote) and implementation preference
   adjust that order. Skipped for the two Voyage models.
7. Grouping and per-file caps produce the response.

Without caller terms, of 72 owners: 21 never reach the window (steps 1 to 4)
and 30 are in the window but not first (steps 5 to 7). With caller terms the
figures are 8 and 37. **The open problem is step 5 with LateOn.**

## The story so far

1. **LateOn alone.** On the 28 the default pipeline puts 13 owners first, MRR
   0.5557. [Owner discovery and reranker investigation](reranker-owner-investigation.md)
   records the earlier work that produced definition fusion.
2. **Voyage rerankers were added** (`22a56c06`, CLI selection in `46c0349b`).
   Swapping in `rerank-3` and changing nothing else gave 0.6446, far less than
   the model's own order promised.
   [Voyage rerankers and definition fusion](voyage-reranker-and-definition-fusion.md).
3. **Definition fusion was eating the gain.** Its name vote is worth about as
   much as the reranker's whole verdict and is right about 4 times in 10.
   That beats LateOn's first pick (24%) and loses to `rerank-3`'s (60%), so
   one rule lifts the weak reranker and overrides the strong one.
   [Definition fusion: root cause](definition-fusion-root-cause.md).
4. **A reranker-aware rule fixed it.** Fusion is skipped for `rerank-3` and
   `rerank-3-lite` and kept for LateOn (`rerankerOrderNeedsDefinitionFusion`,
   `packages/mcp/src/core/search-definition-discovery.ts:38`). `rerank-3`
   then reaches 20 of 28 first and MRR 0.7798. About 170 fusion rules were
   replayed; no single formula serves both rerankers. `rerank-3-lite` matches
   `rerank-3` within noise.
5. **The larger loss was before the reranker.** 25 of 72 owners never reached
   the window, 18 of them in no arm's top 80. Widening the window does not
   help. Test files hold about 42% of the seats. A cap on test rows per arm
   brings two more owners in and does not move MRR with LateOn.
   [Owner recall checkpoint](owner-recall-design-checkpoint.md).
6. **Caller alt terms are the largest lever found.** The caller passes up to
   four likely identifiers in `alt_terms`. Through the real LateOn pipeline:
   owners in the window 51 to 64, first places 21 to 27, MRR 0.3559 to
   0.4985. Another question's terms give 0.1823, worse than none. The feature
   already ships ([Agent alt terms](agent-alt-terms-definition-discovery.md));
   the tool description and the MCP server instructions now tell callers to
   use it (`39be5634`, see [State of the tree](#state-of-the-tree)).
7. **What is left is ordering inside the window.** With terms, 64 owners are
   in the window and 27 are first. LateOn's own order puts the owner first
   for 16 of the 51 in the window without terms; definition fusion and
   implementation preference add a net 5. This is the open problem.

## The open problem

> With the local reranker the owner is among the 64 candidates for 64 of 72
> questions and first for 27. Find a way to order the window that puts more
> owners first, works on repositories it was not tuned on, and needs no
> remote call.

What a solution has to respect:

- **It must generalise.** 72 questions cannot separate rules that differ by
  less than about 0.05 MRR (one or two questions). Choose on one question set
  or repository and check on the other. Prefer a rule with no tuned number.
  The root-cause document shows what happens otherwise: parameters chosen on
  two repositories pick a different rule each time.
- **A change to the query or document text must be LateOn-only.** The bare
  question lowers `rerank-3` from 20 to 16 first on the 28 and
  `rerank-3-lite` from 19 to 16.
- **The rerank request is a pinned contract.** The query wrapper and the
  document projection are versioned and hash-pinned
  (`packages/mcp/src/core/search-rerank-request-contract.ts`,
  `search-rerank-query.ts`, `search-rerank-document.ts`). Changing them is a
  contract change with its own checks.
- **Wrong caller terms cost more than no terms.** A rule that trusts caller
  terms more raises that cost.
- **Latency.** Reranking is already the slow local step. LateOn limits: 256
  query tokens, 2,048 document tokens, 128 documents.
- **Earlier verdicts are data, not rulings.** "Keep", "rejected" and "no rule
  change recommended" in the older documents describe what was measured with
  the matcher and question set of the time. The four-arm lab in the reranker
  investigation, for one, used a matcher that did not normalise symbol-kind
  prefixes. Re-measure before treating a direction as closed.

How LateOn scores, which is where the ideas below come from: Satori computes
the score itself (`maxSimScore` in
`packages/mcp/src/server/lateon-reranker-encoder.ts`). It is the sum, over
the query's tokens, of the best dot product between that token and any
document token. Every query token counts equally, including the wrapper's
words ("Question", "Requested answer type", ...). Nothing normalises for
query or document length. The document is sorted canonical JSON under a
4,000-byte cap, so the excerpt comes after role and label and before path and
signature.

## Ideas and their state

| Idea | State |
|---|---|
| Change what LateOn reads: bare question, plain-text document, identity fields only | Measured end to end; no gain; see the results log |
| Weight the question's tokens by how much they separate the 64 candidates | Replayed on a token-level capture; gains without caller terms, loses with them; see the results log |
| Score name and signature as a short separate document with the model's own vectors, in place of the BM25 name vote | Same capture; gains 3 first places with caller terms, flat without; not confirmed end to end |
| Calibrate for document length or genericness | Same capture; no gain; score and length are uncorrelated |
| Put a space at camelCase boundaries before LateOn lowercases its input | No gain: +0.0145 MRR without caller terms, +0.0062 with them, both inside the noise; with terms the raw reranker order gets worse (26 owners first to 20) and fusion restores it |
| Soften definition fusion for LateOn: give candidates with no name match a tie rank instead of zero | No gain end to end (0.3553 against 0.3559 without caller terms, 0.4960 against 0.4985 with); the same 4 and 6 owners still lose first place; see the results log |
| Match word stems in the name vote, so `optimization` meets `optimize` | Not run; needs a suffix list and also helps generic distractors; measure apart from the row above |
| Let a test or caller vote for the code it exercises | Ruled out with the links the documents carry today; see the results log |
| Derive alt terms inside Satori from the first-pass results, so the gain does not depend on the caller | Not tried here; read `evals/real-repo-quality/vocabulary-ablation.mjs` and the alt-terms document first |
| A stronger local reranker model | Not tried here; needs approval (new dependency); the reranker investigation compared four |
| Voyage rerankers with caller alt terms | Not measured |

Definition fusion (step 6) is a net gain for LateOn and also takes owners
out of first place: 4 without caller terms, 6 with them, plus `fresh_p2`
from raw rank 2 to 29. The per-file cap
(`packages/mcp/src/core/search-grouping.ts:78`) removes `r3_rewritten` at
rank 3. Counts and the code location are in the results log.

## Results log

Newest last. Each entry names its command or script.

- **2026-10-14, tests vote.** On the recorded LateOn orders, a document
  inherits the best score of any window document that calls it or contains a
  reference to it. Of 35 owners in the window and not first, one has such a
  document above it (two of 36 with caller terms). Raw-order MRR 0.3184 to
  0.3202 (strict 0.2696 to 0.2726); a rank-reciprocal vote lowers it to
  0.2503. `supporting_tests` is empty in all 4,544 window documents, so tests
  are linked to code only where a call edge or reference exists. The idea is
  closed for these links, not for a better link source.
- **2026-10-14, what LateOn reads.** Full pipeline, real reranker, no caller
  terms; a hook rewrote the query or documents just before the model.
  Shipped 0.3559 (0.3420), 21 first. Bare question 0.3598 (0.3405), 21.
  Plain-text document 0.3481 (0.3342), 20. Path, label, signature and
  excerpt only 0.3497 (0.3288), 20. Each form moves 13 to 15 questions in
  both directions. Not a lever; the pinned request contract stays. Table in
  the checkpoint under "Ordering experiments with the local reranker".
- **2026-10-14, token-level scoring rules.** A Codex worker captured, for
  every question and window document, each question token's best match
  (`~/.cache/satori-owner-recall/tok/<base|alt>/<set>/<id>.json`; the sums
  reproduce the recorded scores within 0.0001). About forty rules replayed on
  raw reranker order. Shipped: 16 first, 0.3184 without caller terms; 26
  first, 0.4798 with them. Weighting tokens by their spread across the
  candidates: 20, 0.3410 without; 18, 0.4091 with. Per-token maximum of the
  document and a name card (path, label, signature): 17, 0.3151 without; 29,
  0.5255 with. Averaging views, length correction, question tokens only and
  rank fusion with the input order: all within two first places. No rule
  gains on both sources. Table in the checkpoint.
- **2026-10-14, why tests outrank implementation.** Per-token differences
  between the top document and the owner show the top document winning on
  the question's own words. For "where does React bail out of re-rendering a
  component whose props did not change", a test titled "does not bail out
  if…" leads the owner `updateSimpleMemoComponent` by 0.47, of which `bail`
  and `out` supply 0.45. The model's config sets `do_lower_case`, and the
  tokenizer is a cased BPE, so lowercasing erases camelCase boundaries
  before tokenizing: `updateSimpleMemoComponent` becomes
  `up|dates|imple|mem|ocom|p|onent`, `useState` becomes `us|est|ate`. With a
  space at each camelCase boundary they become `update|simple|memo|component`
  and `use|state`. Snake case is already split at the underscore.
- **2026-10-14, splitting camelCase before LateOn encodes, end to end.** A
  space at each camelCase boundary in the question and in every document,
  full pipeline, both sources. Owners in the window do not change (51 and
  64). Without caller terms: 23/31/37 at ranks 1/5/10, MRR 0.3704 (strict
  0.3482), against 21/32/36, 0.3559 (0.3420). With caller terms: 28/46/57,
  0.5047 (0.4984), against 27/48/56, 0.4985 (0.4932). Both differences are
  below what 72 questions separate. In raw reranker order the split helps
  without terms (16 owners first to 18, 0.3184 to 0.3383) and hurts with
  them (26 to 20, 0.4798 to 0.4153); definition fusion then carries 13 owners
  to first and hides the loss. The tokenizer finding explains the failure but
  the repair does not pay. Closed. Runs `form-split` and `form-split-alt`.
- **2026-10-14, window-contrastive scoring (proposed by a second agent).**
  For each question token, take the document's value minus the token's
  median across the window, keep the positive part, divide by the token's
  median absolute deviation, and sum. Raw reranker order: 3 first, 0.1565
  without caller terms; 11 first, 0.2740 with them (shipped: 16, 0.3184 and
  26, 0.4798). Restricted to the question's own tokens: 8, 0.2120 and 21,
  0.3781. Multiplying by the deviation instead of dividing: 16, 0.3115 and
  18, 0.3835. Dividing by a token's spread amplifies the tokens that barely
  vary. Closed. Same capture, `rules.mjs`.
- **2026-10-14, where definition fusion moves the owner (from the same
  agent's review).** `fuseDefinitionDiscovery`
  (`packages/mcp/src/core/search-definition-discovery.ts:104`) gives a
  candidate with any name or path match a second rank vote of up to 1/61 and
  a candidate with none zero, so a one-word match at reranker rank 28
  outranks an unmatched candidate at rank 2. The `reranker_output` stage
  records both `rerankerRank` and the order after fusion. Without caller
  terms: 16 owners first in reranker order, 21 after fusion; 9 taken to
  first, 4 taken from it (`28/p1`, `28/f9`, `46/r2_rewritten`,
  `46/f1_rewritten`, each to rank 2); `46/fresh_p2` 2 to 29. With caller
  terms: 26 to 29; 9 taken to first, 6 taken from it (`28/r2` to 3, `28/f1`
  to 9, `28/f9` to 4, `46/r2_rewritten` to 10, `46/p6_rewritten` to 2,
  `46/f5_rewritten` to 3). Downward moves cost 0.042 MRR without terms and
  0.074 with them, which is the ceiling for a rule that keeps the upward
  moves. Script
  `fusion-moves.mjs`.
- **2026-10-14, a tie rank for unmatched candidates in definition fusion,
  end to end.** Unmatched candidates get the rank after the last matched one
  (`tied`) instead of a zero second vote. Full pipeline, both sources, scored
  after grouping. Without caller terms: 21/32/37 at ranks 1/5/10, MRR 0.3553
  (strict 0.3414), against 21/32/36, 0.3559 (0.3420). With caller terms:
  27/48/55, 0.4960 (0.4905), against 27/48/56, 0.4985 (0.4932). The same 4
  and 6 owners lose first place and the same 9 are taken to it, so the cost of
  0.044 and 0.074 MRR stays. Reason: the candidate that passes the owner is
  itself matched, and a tie rank moves only unmatched candidates. An offline
  replay of the captured fusion inputs (59 questions where fusion ran) also
  tried the two other tie conventions, the middle of the unmatched ranks and
  the last rank: both equal the shipped rule within 0.0006 MRR, with and
  without terms. Closed; the shipped rule stays. Runs `fusion-tied` and
  `fusion-tied-alt`.
- **2026-10-14, the earlier rank-fusion rules with caller terms.** The rules
  of `definition-fusion-root-cause.md` were measured without caller terms. An
  offline replay of today's LateOn fusion inputs ranked `rrf cov2 k5 w0.75`
  first: 22 owners first against 19, MRR 0.3524 against 0.3250 without terms,
  and 0.4483 against 0.4375 with them (59 questions where fusion ran, order
  before grouping). End to end, both sources, scored after grouping, LateOn:
  24/33/38, 0.3877 (strict 0.3478) without terms against 21/32/36, 0.3559
  (0.3420); 26/48/58, 0.5040 (0.4924) with them against 27/48/56, 0.4985
  (0.4932). Lenient MRR gains 0.032 and 0.006; strict rank, the primary
  measure, gains 0.006 and loses 0.001. Not a product change on this
  evidence. Runs `fusion-cov2-75` and `fusion-cov2-75-alt`.
- **2026-10-14, `rerank-3-lite` end to end with and without caller terms.**
  LateOn swapped for `rerank-3-lite` at the reranker call, fusion off (the
  product's behaviour for this model), both sources, scored after grouping.
  Without terms: 34/42/44, 0.5160 (0.4813). With terms: 31/56/60, 0.5959
  (0.5770). Median Voyage call 0.70 s. On the recorded inputs no fusion rule
  beats off by more than 0.007 MRR (`rrf any k5 w0.5`: 0.4288 against
  0.4244). Runs `v3l` and `v3l-alt`.
- **2026-10-14, the rest of that review.** Its reference-graph vote uses the
  links the tests-vote entry above already measured (one owner of 35). Its
  claim that wrong caller terms do no harm at retrieval is contradicted:
  owners in the window fall from 51 to 43 with another question's terms. Its
  point that chunks without a symbol carry only the file name as label is
  proposal P5 in the checkpoint; count the affected owners before acting.

## Reading order

| Document | Read it for | Care |
|---|---|---|
| [owner-recall-design-checkpoint.md](owner-recall-design-checkpoint.md) | Current numbers on 72 questions, the eight proposals, the variant sweep, the alt-terms run, local paths | Longest and newest; start with its Summary |
| [definition-fusion-root-cause.md](definition-fusion-root-cause.md) | Why one fusion rule cannot serve both rerankers; the strict-metric decision; noise on 28 questions; the held-out 44 | Offline replay of step 6 only; its LateOn figures are not the end-to-end ones |
| [voyage-reranker-and-definition-fusion.md](voyage-reranker-and-definition-fusion.md) | The Voyage comparison on the 28, latency and cost | Measured through a test hook, not the shipped provider path; says "uncommitted" where the change has since been committed |
| [agent-alt-terms-definition-discovery.md](agent-alt-terms-definition-discovery.md) | How alt terms enter retrieval, fusion and the rerank question; the wrong-terms arms | Measured on the 46 only |
| [reranker-owner-investigation.md](reranker-owner-investigation.md) | How LateOn is fed and scored; the earlier lab on query and document forms | Older matcher; a handful of targets |
| [voyage-embedding-parity-plan.md](voyage-embedding-parity-plan.md) | The separate plan for Voyage embeddings | A different piece of work; it starts after this one |
| [reranker-selection-plan.md](reranker-selection-plan.md) | How the reranker is chosen from the CLI | Background only |

Repository rules are in `AGENTS.md`. The ones that bite here: state a product
change and wait for approval before making it; a fast path or changed scoring
rule needs a differential test against the old path; report medians of three
runs for any timing claim.

## Code map

| Concern | Owner |
|---|---|
| Rerank query text | `packages/mcp/src/core/search-rerank-query.ts` |
| Rerank document text | `buildSearchRerankDocument`, `packages/mcp/src/core/search-rerank-document.ts:284` |
| LateOn encoding and scoring | `packages/mcp/src/server/lateon-reranker-encoder.ts`, `lateon-reranker-worker.ts` |
| Rerank execution and reranker identity | `packages/mcp/src/core/search-rerank-execution.ts` |
| Definition fusion and its reranker switch | `packages/mcp/src/core/search-definition-discovery.ts` |
| Grouping and per-file cap | `packages/mcp/src/core/search-grouping.ts` |
| Window and pool limits | `packages/mcp/src/core/search-constants.ts` |
| Core fusion of retrieval arms | `packages/core/src/core/vector-candidate-fusion.ts`, `semantic-search-service.ts` |
| `alt_terms` parameter and tool description | `packages/mcp/src/tools/search_codebase.ts` |

## Measuring from a clean machine

End-to-end figures need only the harness in the repository:

```bash
pnpm install && pnpm build        # the harness runs the built dist
node evals/real-repo-quality/run.mjs --state-root <dir> --out <dir>            # the 28
node evals/real-repo-quality/run.mjs --state-root <dir> --out <dir> \
  --cases evals/real-repo-quality/conceptual-cases.json                         # the 46
# add --alt-terms-file <file> for caller terms, --reuse-index on later runs
```

- Options and the pinned checkouts are described in
  `evals/real-repo-quality/README.md`. Indexing the three repositories is the
  slow part; a run that reuses the index takes about four minutes per set on
  the machine used here.
- The alt-terms files are not in the tree at this commit. Recover them with
  `git show 5f03a5b3:evals/real-repo-quality/conceptual-alt-terms-n4-primary.json`
  (and `-n4-shuffled.json` for the wrong-terms arm). They cover all 72 ids.
- "Owners in the window" and every offline replay need the reranker's input
  and output per question. The capture hooks that record them are scratch
  tooling and are **not in the repository**: a module loaded through
  `NODE_OPTIONS=--import` that wraps the reranker's `rerank` call and the core
  fusion and writes one JSON record per question (query, the 64 documents,
  returned scores, fusion inputs). Rebuild that first if an idea needs
  per-stage data.
- Run one heavy job at a time and cap its memory; the eval machine has about
  7 GB to share.

## State of the tree

- Committed in `39be5634`: one sentence in the `search_codebase` tool
  description (`packages/mcp/src/tools/search_codebase.ts`) and one in the MCP
  server instructions (`SATORI_MCP_INSTRUCTIONS`,
  `packages/mcp/src/server/shared-runtime.ts`) telling callers to pass
  `alt_terms` for plain-English questions. `src/tools/search_codebase.test.ts`,
  `src/server/shared-runtime.test.ts` and `pnpm run check` pass.
- Local captures and scripts on the original machine are listed under
  "Resuming this work" in the checkpoint. One scratch directory named there
  holds an API key file. Never read, print or copy it.
