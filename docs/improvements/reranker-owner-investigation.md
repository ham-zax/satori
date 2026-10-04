# Implementation-owner discovery: investigation and current decision

Updated 2026-10-04. This consolidates the Colonist investigation, the two
default-off experiments, the subsequent offline reranker labs and the default
definition-discovery repair. It supersedes the labs' intermediate recommendations
where later evidence contradicted them. The new path
improves the measured Colonist discovery results and is enabled by default.

## Current decision

- Keep `neutral_owner_preference` and `symbol_metadata_bm25` off by default.
- Enable `definition_discovery` by default. An explicit
  `flags: { definition_discovery: false }` restores the baseline for comparison.
  Default adoption is a bounded engineering decision based on the measured
  gains below, not a claim that every owner or query is solved.
- Keep the current rerank query wrapper, JSON document projection and LateOn
  model. Definition evidence now participates in ranking; wrapper removal,
  plain-text projection, blending and mechanical split-query replacement are
  not part of the repair.
- Do not implement windowed supplemental discovery from these results. Under
  a fixed sixteen-result budget it added one strict owner in twenty-four
  development cases, at the final slot, while displacing other evidence.
- The definition engine combines that admission arm with independent
  definition evidence and selection within a file. This now gets both Q5
  owners through ranking and disclosure in the paired Colonist run below.

The practical goal remains finding relevant implementation ownership. A
production-path preference is insufficient evidence of that ownership.

## Definition-discovery engine

The repair separates three decisions that the earlier experiments mixed:

1. **Admission:** reuse the bounded published-symbol BM25 arm to get definitions
   into the candidate pool. Its existing hash, root, span, cancellation and
   excerpt checks remain in force.
2. **Ordering:** compute BM25 over names, qualified names and paths in the
   source-validated rerank window, then fuse that rank with LateOn using the
   existing RRF constant. Supporting test/fixture/docs/generated paths and
   prose callback labels do not receive the extra implementation-definition
   vote. They retain their provider evidence. A production path without a
   metadata match receives no extra vote.
3. **Selection within a file:** order candidates in that file's existing slots
   by query-term coverage in their names/qualified names, with fused order as
   the tie-breaker. This stops a file's generic helpers consuming its diversity
   allowance before its specific matching definition. It does not raise the
   result budget or move the file into another file's slots.

The dedicated owner is `search-definition-discovery.ts`; the coordinator
supplies publication-bound registry metadata. Cached tokenization checks a
witness of all four metadata fields and invalidates on changed records.
Conceptual, mixed and descriptive ownership queries can use the engine.
Exact identifiers, explicit tests/docs/configuration/references, `must:` and
path-constrained requests retain their established paths. There is still one
LateOn request, with unchanged query/document projections and model assets.
File fallbacks remain file targets; the engine does not invent symbol identity.

The new `definition_fusion_order` has its own frozen ranking-policy identity.
Grouping preserves its authoritative order, and continuation verification
uses the frozen policy identity rather than assuming every provider-backed
set has the old provider-only order.

### Paired live Colonist results

Clean commit `40a7c1261a2af2df901d8e85bcbd538306c66805`, publication
`e5808ff0-2546-4f1b-9177-2b660269aa47`, symbol grouping, ten visible results,
three alternating repeats per state. All result/stage orders agreed across
repeats. These are live product results, not an offline best-rank upper bound.

| Evidence | Engine disabled | Engine enabled |
|---|---:|---:|
| Tracker path evidence | 7 | 1 |
| Exact `search_maxn` | 9 | 3 |
| Exact `tradeWorkflow` | Outside ten | 2 |
| Exact `nextClickStillLegal`, broad Q5 | Absent | 4 |
| Exact `legal_actions`, broad Q5 | Absent | 8 |
| Relevant guard `validatedClick` | 2 | 1 |
| Focused click-legality owner | 1 | 1 |
| Focused legal-action owner | 1 | 1 |

All four explicit test/caller/configuration/path controls had identical
results. Before selection within a file was added, trade reached grouped rank
8 but was omitted by the diversity cap: `startWorkflow` and `WorkflowStep`
consumed the file's slots. Fixing that selection boundary produced the final
visible rank 2 without adding slots.

The four broad queries' before/after latency medians were respectively
2,539/2,571, 2,414/2,354, 3,043/3,084 and 3,274/3,326 ms. This repairs measured
quality; natural-language latency still remains in seconds.

### Cross-repository checks and adoption tradeoffs

Sixteen paired development queries on clean pinned React, Polars and
FlatBuffers publications preserved every previously visible accepted owner
within ten results. React's missing-key owner moved 2→1, bailout owner 6→2,
and hook-error owner 2→1; FlatBuffers' finish owner moved 5→1. There were also
head regressions: React's setter owner moved 1→4 and Polars' CSV path evidence
1→2. Both remained visible. Explicit React/Polars test questions were unchanged.

This is a tradeoff, not universal superiority. Some oracles are path-only;
named-symbol and file evidence must be reported separately. The initial
FlatBuffers vector-start query bypassed the engine because it was routed as
`ownership`; that descriptive route is now included. Three cases initially
remained misses in both states, including two React behaviors. Definition
metadata matches are relevance evidence, not proof of behavioral ownership;
weak matches can still be promoted. A calling agent must read the returned
owner and check its contract.

The standalone `symbol_metadata_bm25` and `neutral_owner_preference`
experiments remain disabled. The default engine reuses the metadata producer
without enabling blanket path partitioning or adding another persistent
index, dependency, model, LLM call, or multi-query protocol.

### What the ten upstream repositories contributed

The sources were inspected at pinned revisions. Their ideas were adapted;
no upstream implementation was copied into Satori.

| Repository | Relevant finding | Decision |
|---|---|---|
| [Vera](https://github.com/VeraTools/vera/blob/6cb92d553da58e35062c7ce7148830bc8c11fbaf/crates/vera-core/src/retrieval/ranking/score.rs) | Definition/name priors alongside semantic ranking; optional reranker | Adopt an independent definition signal; keep LateOn |
| [Codelens](https://github.com/mupozg823/codelens-mcp-plugin/tree/212f33b964b82c8d46bbd407838234d0d4b77f14) | Per-symbol metadata fields and lexical/semantic lanes | Keep definition fields separate from chunk-body vocabulary; its BM25F weights were not copied |
| [gortex](https://github.com/zzet/gortex/tree/5f1fc3837de42ce2ff561e79ecdd70bc6617c240) | Deterministic ownership/graph evidence and owner recovery | Use specific-owner selection; graph expansion needs separate evidence |
| [ivygrep](https://github.com/bvolpato/ivygrep/tree/e9c48aa202d12c42a0b1737d489a08a471990dce) | Symbol anchors and learned file ranking | Relevant definition emphasis; do not import an unvalidated learned file policy |
| [CodeNib](https://github.com/sysevol-ai/CodeNib/tree/4232ddfab2ee0cf08d1649d4e97fa416848873fd) | Graph expansion plus optional embedding/cross-encoder/LLM reranking | No demonstrated repair of this fixed-pool failure; no extra LLM dependency |
| [kosha](https://github.com/vedicreader/kosha/tree/83d8eaf95e6ae0979cf4f91a783a0fac24b12303) | Optional FlashRank, definition/path boosts and saturation | Keep bounded selection; no evidence justifies a model swap |
| [SeekStorm](https://github.com/SeekStorm/SeekStorm/tree/50cb0ddffe1e45eb574f927079d1bcffecf8980b) | BM25/vector hybrid retrieval and RRF | Already present in Satori; replacing storage does not repair ranking authority |
| [supergrep](https://github.com/infino-ai/supergrep/tree/f6a6afd4189cd8a07e56852c9846ace5f231410b) | Hybrid code retrieval | No separate validated definition-owner repair to transplant |
| [zvec-grep](https://github.com/zvec-ai/zvec-grep/tree/30c316052f4298ff6fac1e71f45ea40606e24723) | Hybrid/entity lanes; reranker placeholder | Useful representation ideas, not an implemented owner-ranking solution |
| [Stella](https://github.com/macanderson/stella/tree/0ac4c0b63963b231459c0ac090d93bc0ef7d15d2) | Graph-assisted recall, MMR and budget packing | No measured reason to replace this selection policy or copy its AGPL source |

Independent graph expansion, learned weights and model replacement were not
added because the measured fix lies in admission, ranking authority and
selection. Breaking internal interfaces was permitted; compatibility did not
prevent changes. Robustness still requires bounded work, current-publication
source proof, correct canonical IDs and working frozen-result continuation.

## Problem and why it matters to a coding agent

The supplied Sep 26/Oct 3 comparison distinguished two search paths. Exact
identifiers such as `search_maxn`, `tradeWorkflow`, `legal_actions` and
`nextClickStillLegal` resolved quickly to correct, navigable targets. Broad
descriptions instead returned fixtures, scripts, tests, enums or generic
executor helpers ahead of the requested implementation boundaries.

An agent needs natural-language discovery when it does not know the symbol
names. Its useful next step is to read the behavior owner, confirm the caller
or contract, and inspect supporting tests. Blast-radius analysis follows an
identified target; a search result does not establish complete impact coverage.
Tests, configuration and scripts can themselves own the answer when that is
what the question asks. The problem is incomplete or misleading evidence,
not that those file categories should always be demoted.

These are the complete reproduced Colonist queries. Q1's original bridge query
was abbreviated in the supplied report and was not replayed verbatim.

| Query | Judged evidence |
|---|---|
| `belief tracker hidden card probabilities` | Evidence in `src/core/tracker.ts`; the lab oracle is path-only, not one exact tracker symbol |
| `MaxN search default AlphaBeta defensive simulator` | `search_maxn` in `engine/crates/catan-search/src/depth.rs`; default-selection logic is also relevant but not covered by this symbol oracle |
| `trade workflow idempotent rejected bundle loop` | `tradeWorkflow` in `src/content/action-guide.ts` |
| `click executor state signature legal target validation` | `nextClickStillLegal` in `src/content/overlay.ts`, `legal_actions` in `engine/crates/catan-core/src/state.rs`, and relevant guard `validatedClick` in `src/content/action-guide.ts` |

Q5 spans multiple responsibilities. `validatedClick` is relevant execution
evidence, the overlay checks the next click against board legality, and the
Rust engine generates legal actions for the current phase. A guard-only
answer can be relevant yet incomplete. The source-backed callback handoff
does not establish a direct TypeScript-to-Rust call-graph edge.

The earlier report also observed changing index inventories and repeated
publications on an apparently clean tree. This investigation did not isolate
a watcher cause or reproduce that instability. Earlier code inspection
identified changed retrieval/admission/projection inputs, including document
v4-to-v5 changes, but no paired rollback established which historical change
caused the weekly ranking differences. Do not describe this work as that fix.

## Separate admission, ordering, identity and disclosure

1. **Admission:** did any retrieval arm supply evidence owned by the requested
   target? Fusion cannot recover evidence absent from every bounded arm.
2. **Ordering:** given a fixed pool, where did the reranker place that same
   candidate? Minimum ranks across a file can refer to different candidates.
3. **Identity:** does the excerpt retain its canonical symbol target through
   grouping? A matching filename is not a verified function target.
4. **Disclosure:** did the final, budgeted response actually expose the target?
   Improving rank 55 to 39 does not recover it in ten visible results.

Exact-name success establishes publication and navigation, not prose-query
recall. Absence from a truncated debug list establishes only bounded absence.
Scorer replication validates the scorer, not downstream grouping or output.

## What is implemented, and what its paired evaluations showed

### Neutral owner preference: unsuccessful as a default repair

The existing role partition ran for implementation-focused queries, but the
four descriptive queries resolved to neutral focus. The
`neutral_owner_preference` flag extends that partition to eligible neutral
queries without changing answer-focus resolution or the reranker's input.
Explicit test, documentation, configuration, reference and constrained-path
queries preserve their existing order.

On a clean, pinned Colonist checkout this did not restore the judged owners.
The fixture basename `crop6309_fixture.rs` still classified as runtime code.
For trade, relevant test results were displaced by weaker production helpers
without recovering `tradeWorkflow`. This falsified the small pilot as a
sufficient repair; it did not falsify relevance-qualified ownership as a goal.

### Symbol-metadata BM25: candidate recovery, not a final ranking fix

Satori already fused Potion dense retrieval with chunk BM25. CBM's lexical
search scored different documents: symbol names, qualified names, paths and
docstrings, with node filters and bonuses. Satori's chunk lexical text also
contains source-body vocabulary. Both use BM25, but their fields, boundaries
and bounded candidate selection differ. Identifier splitting already existed.

For Q5, all-terms chunk lexical search produced zero rows and OR fallback
still omitted the two legality owners. The new `symbol_metadata_bm25` flag
adds a separate BM25 arm over published non-file symbol names, qualified
names and paths. It supplies at most twelve filtered, source-verified symbol
excerpts to fusion before reranking; it adds no persistent index or model.
It does not copy CBM's node bonuses or require production-path preference.

The corrected paired run used clean commit
`40a7c1261a2af2df901d8e85bcbd538306c66805`, publication
`fb96d5ed-1b50-4c09-945c-fbd7b38323c8`, one runtime, three alternating repeats
per flag state, runtime scope, symbol grouping and default ten-result
disclosure. Result and stage orders agreed across repeats.

| Q5 target | Baseline reranker input | Metadata-arm rank | Enabled reranker input | Enabled grouped rank |
|---|---|---|---|---|
| `nextClickStillLegal` | Absent | 3 | 8 | 34 |
| `legal_actions` | Absent | 8 | 17 | 55 |
| `validatedClick` | 1 | Outside the twelve selected metadata candidates | 5 | 2 |

Both missing owners now enter fusion and reranking and preserve canonical
identity, but neither enters visible results. Tracker path evidence moves
8 to 9, `search_maxn` stays 13, and `tradeWorkflow` moves 34 to 36. All four
explicit-intent controls are unchanged. These results do not support enabling
the flag by default.

This is not a guarantee that nothing is missed. The arm has a twelve-candidate
budget, scope/route restrictions, hash and span admission checks, an eighty-line
excerpt bound and the existing 256 KiB source-read cap. Larger files and lower
metadata ranks can still be omitted. Dense and chunk arms remain necessary.

The [Q5 investigation](q5-retrieval-investigation.md) records the implementation
invariants, owner traces, source checks and reproducible paired harness. An
initial byte-span omission was corrected before the reported full rerun.

## Reranker lab: real inputs and controlled scoring

The lab captured requests and returned scores from the LateOn worker, then
rescored the same query/document pools offline. The first replay matched all
eleven captured requests exactly in order and score. Tracker, MaxN and trade
experiments use flag-off pools; Q5 uses the metadata-on pool because its two
owners are absent without that arm. These are different experiments from the
paired publication table above; their ranks must not be mixed.

The model is **LateOn-Code-edge**, a local late-interaction model, not Voyage.
The captured revision is
`07ef20f406c86badca122464808f4cac2f6e4b25`. In the inspected runtime:

- Query and document token vectors are L2-normalized. The final score is a raw
  sum of per-query-token maximum dot products; there is no query-length
  normalization of that aggregate. Dividing all scores by the same query
  length would not change that query's ranking.
- Document punctuation tokens are skipped; the query side has no equivalent
  skiplist. Limits are 256 query tokens, 2,048 document tokens and 128 documents.
- The v2 query projection includes `Question:` and a requested-answer-type
  sentence. Documents use sorted canonical JSON with symbol, path, excerpt,
  source-reference and structural fields, under a 4,000-byte cap.
- `rerank_blend` is off. Existing debug-stage `score` fields are fusion scores,
  not the returned LateOn scores; worker capture was needed for diagnosis.

| Evidence in captured pool | Request position, in fusion order | LateOn rank | LateOn score |
|---|---|---|---|
| Best-ranked tracker-path document, `readyDevCardCount` | 62 | 8 | 15.488 |
| `search_maxn` | 3 | 13 | 17.826 |
| `tradeWorkflow` | 23 | 34 | 16.928 |
| `nextClickStillLegal` | 8 | 34 | 16.337 |
| `legal_actions` | 17 | 55 | 16.187 |
| `validatedClick` | 5 | 2 | 17.145 |

Tracker is an explicit exception to the claim that every owner was demoted:
the same R8 document improved from request position 62. Earlier file-level
stage minima such as 3 to 8 need not track that document. The fixture comment
ranked first at 15.909, the `Engine` enum at 18.537, and the trade guard test
at 17.619. Those results can match the question's terms without owning all
of the behavior it asks about.

### Arms and negative results

Ranks below are within the whole captured rerank pool, not final product
disclosure. Tracker remains a path-only oracle. NCL, LA and VC denote the
three Q5 targets above. The two focused controls retrieve NCL and LA at rank 1.

| Arm | Tracker | MaxN | Trade | Q5 NCL / LA / VC | Focused NCL / LA controls |
|---|---|---|---|---|---|
| Baseline | 8 | 13 | 34 | 34 / 55 / 2 | 1 / 1 |
| Raw query, no wrapper | 2 | 12 | 24 | 24 / 39 / 2 | 1 / 1 |
| `Question:` only | 2 | 10 | 26 | 16 / 54 / 2 | 1 / 1 |
| Plain-text documents | 3 | 9 | 50 | 15 / 25 / 2 | 1 / 1 |
| Plain text plus raw query | 1 | 7 | 41 | 24 / 22 / 2 | 1 / 1 |
| Equal provider/fusion-rank blend | 5 | 3 | 26 | 14 / 31 / 3 | 1 / 12 |
| Handwritten query-word facets, score sum | 3 | 7 | 13 | 17 / 44 / 2 | 1 / 1 |
| Automatic bigrams, score sum | 1 | 34 | 14 | 12 / 28 / 4 | 1 / 1 |

The first report recommended wrapper removal and meaningful facets. Later
work withdrew the former and weakened the latter:

- Twenty seeded random contiguous splits matched or beat the handwritten
  score-sum facets for tracker, trade and NCL. Their median ranks were 1, 10
  and 17 versus 3, 13 and 17. MaxN favored the hand split, 7 versus random
  median 12; isolating `MaxN` helped some random trials. Summing single-word
  queries instead collapsed MaxN to rank 62.
- Per-token analysis showed trade's owner winning `trade` and `workflow` but
  losing `rejected` and `bundle`. Broad token coverage can outweigh one
  responsibility's stronger match. Joint-versus-facet token vectors also
  changed, with mean cosines about 0.83–0.88. Neither measurement isolates a
  universal short-query repair or proves the model has reached its ceiling.
- The token heuristic assigned nearly constant contributions to wrapper
  words. It missed some subword/special-token distinctions, so it is not a
  definitive causal decomposition. A constant additive offset cannot compress
  absolute score gaps or change order. The original incidental-boilerplate
  explanation is unsupported by this analysis.
- The eighteen-pool wrapper experiment reported permissive top-1/top-10
  counts of 5/11 versus 4/10. Its matcher did not normalize symbol-kind
  prefixes, so those totals omit real named-owner matches and cannot support
  a strict-symbol quality conclusion. The alternative-query orders were not
  retained for a corrected recount. Wrapper removal remains unadopted; the
  existing projection is versioned and hash-pinned in runtime assets.

The earlier React split-query totals share the same oracle limitation and
must be rescored before claiming a strict-symbol regression. Plain-text
projection regressed trade; blend regressed a focused legal-action control.
None is adopted as the repair.

## Windows: promising upper bounds did not survive an output budget

The next experiment evaluated overlapping two-/three-word windows on twenty-four
development pools: eighteen React/Polars queries, four Colonist queries and
two focused controls. All-window best ranks suggested substantial coverage:
trade 34 to 1, NCL 34 to 1, and LA 55 to 5 in some window variants.

That metric selects the best result across many lists after seeing the target.
It is not one deliverable ranking. Disclosing every list's top ten also spends
many more results than the baseline.

Follow-up 3 therefore froze two budgeted policies before inspecting outcomes:

- **A:** baseline's first sixteen documents.
- **B:** unchanged baseline top ten, plus at most six supplemental documents
  from at most three wrapped windows. Windows use first/middle/last positions
  and query words only. Selection is deterministic round-robin, skipping seen
  document indices. Owner-shared duplicates were reported separately; this
  was not canonical-owner deduplication or a product grouping implementation.

The policy's stopword list also removes `not`, `no`, `before` and `after`.
It therefore does not preserve negation and ordering relations merely by
keeping the remaining words contiguous. This limits any future reuse of that
policy, independently of its weak recovery result.

| Target or control | A: sixteen baseline documents | B: two-word windows | B: three-word windows |
|---|---|---|---|
| Tracker path evidence | 8 | 8 | 8 |
| `search_maxn`, exact wrapper | 13 | 14 | Absent |
| `tradeWorkflow` | Absent | Absent | Absent |
| `nextClickStillLegal`, broad Q5 | Absent | Absent | 16 |
| `legal_actions`, broad Q5 | Absent | Absent | Absent |
| `validatedClick`, broad Q5 | 2 | 2 | 2 |
| Both focused Q5 owners | 1 in their respective queries | 1 | 1 |

Two-word windows added no owner beyond A on any of the twenty-four cases.
Three-word windows added exactly one: NCL at slot 16. The reported MaxN at
slot 11 was `search_maxn_bounded`, incorrectly accepted by a substring
oracle; the exact wrapper regresses under the three-word policy. React and
Polars had no additional oracle successes. B displaced three to six of A's
documents per case. The sampled Q5 supplements included relevant neighbors
as well as unrelated material; every non-owner is not automatically noise.

This rejects the tested automatic window policy as an implementation direction.
It does not establish that every possible caller-supplied decomposition fails.
No multi-query protocol, grouping API or default ranking change was implemented.

### Metric corrections and replication limits

- The earlier claim of zero named owners was incorrect. Labels such as
  `method legal_actions` and `function dispatchSetStateInternal` require
  kind-prefix normalization. The repository's official `normalizeHit` and
  `scoreQuery` already perform it. A corrected audit finds named owners in
  eight of the eighteen pools; nine cases have named-symbol oracles, while
  the remaining nine have path-only oracles.
- In the captured baseline, React r2's owner is rank 4, r4 has accepted
  symbols at 2 and 7, r5 at 2, r8 at 18, and r9 at 4/5. React r3's
  `areHookInputsEqual` is present at 41. Polars p8's `to_numpy` is at 19,
  and p9's `NotebookFormatter` is at 1. React r1 and Polars p3 remain actual
  whole-pool misses. These distinguish admission loss from ranking loss;
  they do not imply every other repository target was admitted.
- The all-window replica matched captured scores within about `6.25e-7` and
  top-ten order in all twenty-four cases. Follow-up 3's saved scores were
  rounded to four decimals: their maximum reported difference is about
  `5.02e-5`, with full-pool order agreement in nineteen of twenty-four cases.
  Top-sixteen sets agree. These are distinct fidelity checks, not an exact
  full-pipeline replay claim.

## Historical lab costs and unresolved coverage

Document encoding dominated the offline replica. On the eighty-eight-document
Q5 pool, the initial measurement spent about 4,134 ms encoding documents,
2.9 ms encoding one query and 102 ms scoring cached vectors. Encoding once
for several queries avoids repeating that dominant work.

Follow-up 3 measured three repetitions with seven queries each: document
encoding 3,674–3,778 ms, query encoding 14–15 ms total, scoring 380–390 ms,
total 4,068–4,184 ms, and sampled process RSS 338–381 MB. These are offline
in-process measurements, not production-worker latency or a validated memory
bound. A production multi-query design would still need protocol and lifecycle
work; the observed quality gain does not justify it.

The default repair above was subsequently evaluated on paired live Colonist
queries and sixteen cross-repository development queries. Held-out admission
coverage remains unverified. Further quality claims would require verified symbol targets
on held-out queries/repos, including whether the metadata arm generalizes.
Measure strict-symbol presence, identity preservation and actual budgeted
disclosure separately from file evidence. Retain broad Q5, its focused
controls, explicit test/configuration/reference questions, and cases where
reranking already helps. Admission alone did not fix Q5's demonstrated
reranker demotions; the default engine also changes ordering and selection.

## Evidence, verification and reproduction

The committed reproduction entry points are
[`neutral-owner-preference-ablation.mjs`](../../evals/real-repo-quality/neutral-owner-preference-ablation.mjs)
and
[`symbol-metadata-bm25-ablation.mjs`](../../evals/real-repo-quality/symbol-metadata-bm25-ablation.mjs).
They require a clean pinned Colonist checkout and a fresh built runtime;
use an isolated temporary index and compare flag states on one publication.
See the [Q5 paired-result instructions](q5-retrieval-investigation.md#paired-result-of-the-metadata-experiment).

To reproduce the definition-engine comparison after building the runtime:

```bash
OWNER_PREFERENCE_EVAL_FLAG=definition_discovery \
OWNER_PREFERENCE_EVAL_REPEATS=3 \
OWNER_PREFERENCE_EVAL_OUTPUT=/tmp/satori-definition-discovery.json \
node evals/real-repo-quality/neutral-owner-preference-ablation.mjs
```

The harness explicitly disables the default engine before setting the compared
flag. This keeps the older metadata and role-preference ablations isolated;
otherwise default metadata admission would make the older retrieval comparison
a no-op.

The later lab scripts and raw captures remain local, unversioned artifacts:

| Artifact | Purpose |
|---|---|
| `/tmp/satori-symbol-metadata-bm25.json` | Paired product evaluation and owner-stage traces |
| `/tmp/rerank-lab/REPORT.md`, `capture.jsonl`, `results/` | Real LateOn requests/scores, exact initial replication and fixed-pool arms |
| `/tmp/rerank-lab/followup/REPORT.md`, `f2.json`, `f3.json`, `f5-scores.json` | Random splits, token analysis, cross-repo wrapper checks |
| `/tmp/rerank-lab/followup2/split-sum.json`, `windows-best.json` | Twenty-four-pool replacement and all-window diagnostics |
| `/tmp/rerank-lab/followup3/REPORT.md`, `eval.json`, `rankings/`, `timing.json` | Budgeted supplementation, per-query orders and offline timings |
| `/tmp/satori-upstream-research-20261004/live-definition-final.json` | Three-repeat paired Colonist product results and latency medians |
| `/tmp/satori-upstream-research-20261004/cross-repo-check.json` | Sixteen paired development queries, with separate accepted and strict-symbol oracles |
| `/tmp/satori-upstream-research-20261004/default-live-check.json` | Actual default versus explicit opt-out, plus continuation in default and full debug modes |

This document preserves the numerical findings and corrections without
requiring those temporary files. The labs are not yet a portable committed
benchmark. Their twenty-four cases are reused development data, not held-out
validation. Handwritten facets and the author's prior exposure limit claims
of blind evaluation. Earlier live probes also used different source witnesses.

The earlier experimental source passed sixty distinct focused tests covering scoring,
filters, cache witnesses, cancellation, source hashes, UTF8/CRLF byte spans,
fusion wiring, default-off behavior and canonical grouping. Changed-source lint,
runtime build/typecheck and both harness syntax checks passed. A disposable
cache-witness mutation failed its regression test as expected. Later lab reviews
changed no implementation.

The final default engine passed 113 focused tests covering its policy and wiring,
native reranking, source validation, cache witnesses, order identity, grouping
and continuation storage. Changed-source lint, runtime build/typecheck, package
scope validation and harness syntax checks passed. A fresh live run omitted
flags entirely for the enabled arm: trade was rank 2, broad Q5 owners were
ranks 4 and 8, and the FlatBuffers Finish symbol was rank 1. Continuation
returned the next ten results with the same ranked-set digest, both with debug
omitted and with full debug. The initial cross-repo continuation probe supplied
an invalid `debugMode: "none"`; this harness error was corrected in the final
live run by omitting debug mode. All owned index state and processes were
cleaned up. The FlatBuffers vector-start query still missed after the ownership
route was enabled; definition admission and fusion are not a coverage guarantee.

No watcher/index-stability repair, model change,
wrapper removal or windowed product feature is part of this work.
