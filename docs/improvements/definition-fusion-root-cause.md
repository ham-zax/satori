# Definition fusion: root cause and replayed rules

Recorded 2026-10-13 on `master` at `861820e2`. No product code was changed.
Every figure comes from an offline replay of captured rerank windows: the 28
judged questions in `evals/real-repo-quality/cases.json`, replayed without
calling a model, and 44 further questions from `conceptual-cases.json`,
captured in one run per reranker (LateOn locally, three Voyage models through
the API). This continues
[Voyage rerankers and definition fusion](voyage-reranker-and-definition-fusion.md).

Provenance (annotated 25 October 2026): every figure below replays the definition-fusion rule as
it shipped at `861820e2`. Commit `0a2aa66c` later made that rule match inflected query words
(`packages/mcp/src/core/search-definition-discovery.ts`), so the rule replayed here is not the
rule that ships at HEAD `fb125738`. The graders changed once after these captures, at `5f96827c`
(a rubric-only p3 acceptance), which moves the 28-question set by one hit@10 and leaves the
44-question set unchanged.

## Summary

- **Root cause.** The shipped rule adds a symbol-name vote to the reranker's
  order with a formula in which having a name match at all is worth about as
  much as the reranker's whole verdict. The name vote's best pick is right
  about 4 times in 10. That beats LateOn's first pick (24%) and loses to
  `rerank-3`'s (60%), so the same rule lifts the weak reranker and overrides
  the strong one.
- **Metric.** Strict rank (the owning symbol must match) is now the primary
  metric. Lenient rank (the right file is enough) stays as a secondary number.
- **Scope.** The rerankers that matter are LateOn, `rerank-3-lite` (the
  Voyage default) and `rerank-3`. `rerank-2.5` was ruled out of scope as
  obsolete after these runs; its figures stay in the tables and no longer
  drive a decision.
- **No rule change is recommended.** The product already skips definition
  fusion for both `rerank-3` models and keeps it for LateOn, and 72 questions
  support both halves: the shipped rule would cost the two Voyage models 0.049
  and 0.063 strict MRR, and it lifts LateOn from 0.2293 to 0.2964. The best
  gentler rule beats "off" for the two Voyage models by at most 0.016, about
  one question in 72.
- **A gentler rule exists, as a fallback.** A rank-based rule with a small
  constant and a half-weight name vote is never below "fusion off" for any
  reranker on strict rank on the original 28 and stays close to the shipped
  rule for LateOn. It needs no model-name list and no within-file reorder. Its
  one material advantage was for Voyage models outside the name list.
- **It held on 44 questions it was not chosen on.** On strict rank it is
  within 0.004 MRR of "off" for all three Voyage models and within 0.003 of
  the shipped rule for LateOn. The shipped rule costs every Voyage model 0.05
  to 0.07 there. No single difference is statistically significant.
- **`rerank-3-lite` matches `rerank-3`.** With fusion off on 72 questions:
  strict MRR 0.3819 against 0.3906, lenient 0.4187 against 0.4253. The lite
  model ranks the owner higher on 4 questions and `rerank-3` on 7.
- **It is not a universal winner, and no formula tested is.** About 170 rules
  were replayed. None reaches both the shipped result for LateOn and the "off"
  result for `rerank-3` on strict rank; the closest is 0.012 short for LateOn.
  A vote of fixed strength cannot be both stronger than LateOn and weaker than
  `rerank-3`.
- **28 questions cannot rank the close candidates.** Rules that differ by less
  than about 0.05 MRR change one or two questions. Choosing parameters on two
  repositories and testing on the third picks a different rule each time.
- **The larger loss is before this step.** For 6 of the 25 questions that
  reach the step, the owning symbol is not among the 64 candidates at all. A
  perfect reorder would reach strict MRR 0.6786; `rerank-3` with fusion off is
  already at 0.6012. On the 44 new questions it is worse: the owner is in the
  window for 20, and for 4 of the 18 freshly written ones. Of the 25 owners
  absent from the window across all 72 questions, 18 are not in the top 80 of
  any retrieval arm. Retrieval recall is the main loss, ahead of core fusion
  and the window size. The captures sent no caller alt terms.

## Problem

The earlier document showed that definition fusion helps LateOn and hurts
`rerank-3`, and the shipped answer was to skip fusion for two named Voyage
models (`rerankerOrderNeedsDefinitionFusion`,
`packages/mcp/src/core/search-definition-discovery.ts:38`). A list of model
names is a per-reranker policy: `packages/mcp/src/config.ts` passes any model
name through, so `rerank-2.5` and every future model still get the rule that
harms a good reranker. The goal here was the cause, and one rule that does not
depend on which reranker is in use.

## Metric decision

Satori exists so an agent gets the owning file, the symbol and the
implementation in one call. A small model can then decide from what it was
handed, and a large model avoids follow-up calls, each of which resends the
conversation. A hit on the right file with the wrong symbol still costs a
follow-up call.

- **Primary:** `strictRank` from `scoreQuery`
  (`evals/real-repo-quality/score.mjs`): path and symbol must both match.
- **Secondary:** `rank`: a file-level hit on the right path also counts.

The choice changes conclusions. A learned linear rule looked like the best
result under lenient rank; its gain came from a large bonus for file-level
candidates, which the lenient grader accepts for any question. Under strict
rank it is worse than "off" for every strong reranker (0.4301 / 0.4694 /
0.5408 / 0.5417 against 0.3326 / 0.4732 / 0.5595 / 0.6012).

## Method

- Inputs: the captured rerank windows and reranker scores from the earlier
  bake-off. LateOn, `rerank-3-lite` and `rerank-3` are logged runs;
  `rerank-2.5` is rebuilt from cached scores on the same candidates.
- Each rule reorders the same 64-candidate window and is graded with
  `scoreQuery`. Cells are `@1 / @3 / MRR@10`, all over 28 questions.
- 25 questions reach the fusion step. `r7`, `p7` and `f8` do not and count as
  misses in every row, so these figures are lower than full-pipeline figures
  and are comparable only with each other.
- The older document's replay table uses reciprocal rank with no cut-off at
  10. Recomputed that way, the "off" and "shipped" rows here match it exactly
  (0.3974 / 0.5454 / 0.6497 / 0.6926 and 0.5032 / 0.5420 / 0.5786 / 0.5601).

Rule notation: `rrf GATE kK wW` scores a candidate as
`1/(K + rerankerRank) + W/(K + nameRank)`. `nameRank` is the rank from the
shipped symbol-name BM25 (name, qualified name, file). The second term is
added only for candidates that pass the gate: `any` is any name match, `cov2`
is at least two query terms in the symbol name or qualified name. "Score-aware"
is the reranker's score standardised within the window plus 0.5 times the
owner-name match scaled to 0–1.

## Root cause

The shipped rule is equal-weight reciprocal-rank fusion with `K = 60`, and a
candidate with no name match gets no second term.

- With `K = 60` the reranker's whole order spans 1/61 to 1/124, a spread of
  0.0083. A name match adds between 1/61 and 1/124, so at least 0.0081.
  Matching the name at all is worth as much as moving from last to first in
  the reranker's order. A candidate at reranker rank 64 with a name match in
  the top 60 beats the reranker's first pick if that pick has no name match.
- The reranker's top five to ten are near-tied under this formula
  (1/61 against 1/65), so among them the name vote decides.
- LateOn's wrong first picks and `rerank-3`'s right first picks have the same
  small margins. The rule cannot tell them apart and overrides both.

How good the name vote is, measured on the same windows (strict; 1,600
candidates, 182 correct, base rate 11.4%):

| Pick | Correct |
|---|---|
| Best name match with two or more query terms in the name | 41.7% |
| Best name match | 36.0% |
| Any candidate with two or more query terms in the name | 29.9% |
| Any candidate in the first-stage top 5 | 25.6% |
| LateOn's first pick (25 questions) | 24% |
| `rerank-3`'s first pick (25 questions) | 60% |

The name vote sits between the two rerankers. Any fixed strength is therefore
a compromise: strong enough to correct LateOn means strong enough to override
`rerank-3`.

Per question (strict rank of the owner; only questions where a rule changes
the rank):

| Question | Reranker | Off | Shipped | `any k5 w0.5` | `cov2 k5 w0.5` | `cov2 k5 w0.75` |
|---|---|---|---|---|---|---|
| `r3` | `rerank-3` | 1 | 19 | 1 | 1 | 3 |
| `f10` | `rerank-3` | 1 | 10 | 1 | 3 | 5 |
| `r4` | `rerank-3` | 1 | 2 | 1 | 1 | 2 |
| `p2` | `rerank-3` | 1 | 2 | 1 | 1 | 1 |
| `p1` | `rerank-3` | 2 | 4 | 2 | 2 | 1 |
| `f2` | `rerank-3` | 3 | 6 | 4 | 5 | 5 |
| `p6` | `rerank-3` | 2 | 1 | 1 | 1 | 1 |
| `f1` | `rerank-3` | 2 | 1 | 1 | 1 | 1 |
| `f3` | LateOn | 48 | 10 | 9 | 5 | 2 |
| `r8` | LateOn | 23 | 3 | 6 | 23 | 23 |
| `f1` | LateOn | 7 | 1 | 2 | 2 | 1 |
| `r4` | LateOn | 3 | 1 | 2 | 2 | 2 |
| `r9` | LateOn | 3 | 1 | 2 | 1 | 1 |
| `r5`, `f4`, `f6` | LateOn | 2 | 1 | 1 | 1 | 1 |
| `p5` | LateOn | 2 | 1 | 2 | 1 | 1 |
| `p1`, `p9` | LateOn | 1 | 2 | 1 | 1 | 1 |
| `p2` | LateOn | 4 | 3 | 4 | 4 | 4 |
| `f2` | LateOn | 7 | 8 | 8 | 9 | 11 |
| `f10` | LateOn | 9 | 14 | 10 | 14 | 20 |
| `r3` | LateOn | 43 | 45 | 45 | 44 | 44 |

## Results

### Strict rank (primary)

| Rule | LateOn | `rerank-2.5` | `rerank-3-lite` | `rerank-3` | Worst change against off |
|---|---|---|---|---|---|
| Off | 6 / 12 / 0.3326 | 9 / 18 / 0.4732 | 13 / 19 / 0.5595 | 15 / 19 / 0.6012 | 0 |
| Shipped (`K = 60`, weight 1, within-file reorder) | 11 / 15 / 0.4604 | 12 / 15 / 0.5015 | 14 / 15 / 0.5379 | 13 / 15 / 0.5185 | −0.0827 |
| Score-aware | 9 / 12 / 0.3943 | 11 / 17 / 0.4982 | 15 / 18 / 0.5923 | 16 / 18 / 0.6161 | +0.0149 |
| `rrf any k5 w0.5` | 9 / 13 / 0.4197 | 11 / 16 / 0.4985 | 15 / 18 / 0.5863 | 17 / 18 / 0.6339 | +0.0253 |
| `rrf cov2 k5 w0.5` | 11 / 13 / 0.4486 | 11 / 16 / 0.4997 | 14 / 17 / 0.5637 | 16 / 18 / 0.6083 | +0.0042 |
| `rrf cov2 k5 w0.75` | 12 / 14 / 0.4732 | 12 / 16 / 0.5119 | 15 / 16 / 0.5750 | 15 / 17 / 0.5798 | −0.0214 |
| `rrf cov2 k10 w1` | 14 / 14 / 0.5089 | 13 / 16 / 0.5218 | 14 / 16 / 0.5433 | 15 / 16 / 0.5655 | −0.0357 |
| `rrf cov2 k60 w1` | 12 / 15 / 0.4762 | 13 / 16 / 0.5218 | 14 / 16 / 0.5397 | 14 / 16 / 0.5397 | −0.0615 |

### Lenient rank (secondary)

| Rule | LateOn | `rerank-2.5` | `rerank-3-lite` | `rerank-3` | Worst change against off |
|---|---|---|---|---|---|
| Off | 8 / 13 / 0.3882 | 11 / 20 / 0.5446 | 16 / 21 / 0.6488 | 18 / 21 / 0.6905 | 0 |
| Shipped | 12 / 16 / 0.4961 | 13 / 16 / 0.5372 | 15 / 16 / 0.5736 | 14 / 16 / 0.5542 | −0.1363 |
| Score-aware | 11 / 13 / 0.4491 | 13 / 19 / 0.5696 | 17 / 20 / 0.6637 | 18 / 20 / 0.6875 | −0.0030 |
| `rrf any k5 w0.5` | 10 / 14 / 0.4555 | 13 / 18 / 0.5699 | 17 / 20 / 0.6577 | 18 / 20 / 0.6875 | −0.0030 |
| `rrf cov2 k5 w0.5` | 12 / 14 / 0.4843 | 13 / 18 / 0.5711 | 16 / 19 / 0.6351 | 17 / 20 / 0.6619 | −0.0286 |
| `rrf cov2 k5 w0.75` | 13 / 15 / 0.5089 | 13 / 18 / 0.5655 | 16 / 18 / 0.6286 | 16 / 19 / 0.6333 | −0.0571 |
| `rrf cov2 k10 w1` | 15 / 15 / 0.5446 | 14 / 17 / 0.5635 | 15 / 17 / 0.5849 | 16 / 17 / 0.6071 | −0.0833 |

### What the tables show

- **Small `K` is the repair.** With `K = 5` and weight 0.5 the reranker's
  first pick scores 0.167 and the best name match adds 0.083. A name-matched
  candidate can pass an unmatched first pick only from reranker rank 6 or
  better. The name vote still lifts a buried owner into the top ten (`f3`
  under LateOn: 48 to 9), but it no longer drags the reranker's first pick
  down to rank 19 (`r3` under `rerank-3`).
- **The rules form a dial, not a winner.**
  - `rrf any k5 w0.5`: above off for every reranker on strict rank and within
    0.003 of off on lenient rank; LateOn keeps about two thirds of its shipped
    gain (9 rank-1 answers against 11).
  - `rrf cov2 k5 w0.5`: no reranker below off on strict rank; LateOn keeps its
    11 rank-1 answers and loses two top-3 answers against shipped. Under
    lenient rank `rerank-3` loses one rank-1 answer against off.
  - `rrf cov2 k5 w0.75`: at or above the shipped rule for all four rerankers
    under both metrics; `rerank-3` is 0.021 (strict) below off.
- **Score-aware is matched by a simpler rule.** `rrf any k5 w0.5` is within
  0.006 of it for every reranker under both metrics, ahead for LateOn, and
  uses ranks only, so it does not depend on a provider's score scale.
- **The within-file reorder earns nothing.** Removing it from the shipped rule
  changes no strict figure for any reranker. Adding it to the gentler rules
  hurts (`rrf cov2 k5 w0.5` for `rerank-3`: 0.6083 to 0.5726). Under lenient
  rank it helps shipped LateOn by one question (0.4783 to 0.4961) and nothing
  else.

## How much of this is noise

Questions that got better or worse (strict), LateOn / `rerank-2.5` /
`rerank-3-lite` / `rerank-3`:

| Comparison | LateOn | `rerank-2.5` | `rerank-3-lite` | `rerank-3` |
|---|---|---|---|---|
| Shipped against off | +10 / −4 | +4 / −5 | +3 / −5 | +2 / −6 |
| Score-aware against off | +5 / −2 | +2 / −1 | +3 / −1 | +1 / −1 |
| `rrf any k5 w0.5` against off | +8 / −2 | +3 / −3 | +3 / −2 | +2 / −1 |
| `rrf cov2 k5 w0.5` against off | +8 / −2 | +4 / −3 | +2 / −3 | +2 / −2 |
| `rrf cov2 k5 w0.5` against shipped | +3 / −5 | +4 / −2 | +5 / −2 | +6 / −0 |
| `rrf cov2 k5 w0.75` against shipped | +3 / −4 | +3 / −1 | +4 / −1 | +5 / −0 |

- For the three Voyage models a name vote of any strength is a wash against
  off: two to four questions each way.
- The solid results are the two large ones: the shipped rule harms `rerank-3`
  (2 better, 6 worse against off; 0 better, 6 worse against the gentle rule),
  and a name vote helps LateOn (8 to 10 better, 2 to 4 worse).
- **Leave one repository out.** Choosing gate, `K` and weight on two
  repositories and scoring the third picks a different rule in each fold
  (`cov2 k10 w1`, `any k5 w0.5`, `cov2 k10 w0.5`). Held-out strict result:
  12 / 13 / 0.4653, 10 / 16 / 0.4702, 13 / 16 / 0.5363, 14 / 16 / 0.5528, which
  is 0.048 below off for `rerank-3`. The family (small `K`, weight at most 1)
  is robust; the exact member is not established, and "no harm to a strong
  reranker" is not yet shown on held-out questions.

## Held-out replay: 44 new questions

The 46 questions in `evals/real-repo-quality/conceptual-cases.json` were
captured and replayed the same way. Two repeat the original set (`r1`, `r8`)
and are excluded, leaving 44 new questions and 72 in total. 26 are rewrites
of original questions that avoid code vocabulary and 18 are freshly written.
All four rerankers are logged runs here, `rerank-2.5` included. The six rules
compared were fixed before the capture.

Strict rank, 44 new questions (`@1 / @3 / MRR@10` over 44):

| Rule | LateOn | `rerank-2.5` | `rerank-3-lite` | `rerank-3` |
|---|---|---|---|---|
| off | 4 / 9 / 0.1636 | 9 / 14 / 0.2606 | 11 / 13 / 0.2689 | 9 / 13 / 0.2566 |
| shipped | 7 / 9 / 0.1920 | 8 / 9 / 0.2119 | 8 / 9 / 0.2031 | 7 / 9 / 0.2058 |
| score-aware | 5 / 9 / 0.1756 | 8 / 14 / 0.2470 | 11 / 13 / 0.2737 | 9 / 13 / 0.2570 |
| `rrf any k5 w0.5` | 5 / 10 / 0.1790 | 9 / 14 / 0.2583 | 11 / 13 / 0.2746 | 9 / 13 / 0.2602 |
| `rrf cov2 k5 w0.5` (lead) | 6 / 10 / 0.1895 | 10 / 14 / 0.2689 | 11 / 13 / 0.2652 | 10 / 13 / 0.2652 |
| `rrf cov2 k5 w0.75` | 7 / 10 / 0.2011 | 9 / 11 / 0.2470 | 11 / 11 / 0.2614 | 10 / 10 / 0.2527 |

Strict rank, all 72 questions (over 72):

| Rule | LateOn | `rerank-2.5` | `rerank-3-lite` | `rerank-3` |
|---|---|---|---|---|
| off | 10 / 21 / 0.2293 | 18 / 32 / 0.3433 | 24 / 32 / 0.3819 | 24 / 32 / 0.3906 |
| shipped | 18 / 24 / 0.2964 | 20 / 24 / 0.3245 | 22 / 24 / 0.3333 | 20 / 24 / 0.3274 |
| score-aware | 14 / 21 / 0.2606 | 19 / 31 / 0.3447 | 26 / 31 / 0.3976 | 25 / 31 / 0.3967 |
| `rrf any k5 w0.5` | 14 / 23 / 0.2726 | 20 / 30 / 0.3517 | 26 / 31 / 0.3958 | 26 / 31 / 0.4056 |
| `rrf cov2 k5 w0.5` (lead) | 17 / 23 / 0.2902 | 21 / 30 / 0.3587 | 25 / 30 / 0.3812 | 26 / 31 / 0.3986 |
| `rrf cov2 k5 w0.75` | 19 / 24 / 0.3069 | 21 / 27 / 0.3500 | 26 / 27 / 0.3833 | 25 / 27 / 0.3799 |

Lenient rank, MRR@10 only:

| Rule | Set | LateOn | `rerank-2.5` | `rerank-3-lite` | `rerank-3` |
|---|---|---|---|---|---|
| off | 44 new | 0.2027 | 0.2606 | 0.2722 | 0.2566 |
| shipped | 44 new | 0.2042 | 0.2144 | 0.2048 | 0.2063 |
| `rrf cov2 k5 w0.5` | 44 new | 0.2295 | 0.2689 | 0.2684 | 0.2652 |
| off | all 72 | 0.2749 | 0.3711 | 0.4187 | 0.4253 |
| shipped | all 72 | 0.3177 | 0.3399 | 0.3482 | 0.3416 |
| `rrf cov2 k5 w0.5` | all 72 | 0.3286 | 0.3865 | 0.4110 | 0.4194 |

Questions better / worse for the lead rule, strict rank (two-sided sign test):

| Comparison | Set | LateOn | `rerank-2.5` | `rerank-3-lite` | `rerank-3` |
|---|---|---|---|---|---|
| lead vs off | 44 new | +3 / −3 | +1 / −2 | +0 / −1 | +1 / −1 |
| lead vs shipped | 44 new | +4 / −5 | +6 / −5 | +5 / −4 | +6 / −4 |
| lead vs off | all 72 | +11 / −5 (p=0.21) | +5 / −5 | +2 / −4 | +3 / −3 |
| lead vs shipped | all 72 | +7 / −10 (p=0.63) | +10 / −7 (p=0.63) | +10 / −6 (p=0.45) | +12 / −4 (p=0.08) |
| shipped vs off | all 72 | +16 / −9 (p=0.23) | +10 / −12 | +7 / −10 | +7 / −12 (p=0.36) |

What the held-out replay shows:

- **The shipped rule does not transfer.** On the new questions it adds 0.028
  for LateOn on strict rank and 0.002 on lenient rank, and it costs the Voyage
  models 0.049, 0.066 and 0.051. It leaves exactly 9 owners in the top three
  for every reranker, against 13 or 14 with fusion off: the name vote decides
  the top of the list and the reranker's order is lost.
- **`rerank-2.5` is harmed too.** It is 0.049 below "off" on the new questions
  and 0.019 below on all 72. The model-name skip only covers the `rerank-3`
  family.
- **The lead rule transfers.** Against "off" on the new questions it is
  +0.026, +0.008, −0.004 and +0.009. Against the shipped rule it is −0.003 for
  LateOn and +0.057 to +0.062 for the Voyage models. On all 72 it is the only
  rule of the six that is within 0.001 of "off" for every Voyage model and
  within 0.007 of the shipped rule for LateOn.
- **The stronger vote does not transfer.** `rrf cov2 k5 w0.75` is the best
  rule for LateOn and is below "off" for all three Voyage models on the new
  questions, with 6 and 5 questions worse against 1 better for `rerank-2.5`
  and `rerank-3`.
- **The within-file reorder costs on new questions.** The lead rule with the
  reorder added scores 0.1853 / 0.2300 / 0.2328 / 0.2262, that is 0.03 to
  0.04 lower for each Voyage model. On the original 28, removing the reorder
  from the shipped rule changed nothing.
- **Nothing here is statistically significant on its own.** The closest is
  the lead rule against the shipped rule for `rerank-3` on all 72 (p = 0.08
  strict, 0.05 lenient). The case for the lead rule is the consistent
  direction across four rerankers and two question sets, not one test.
- **By repository** the lead rule is never more than 0.011 below "off" for a
  Voyage model. It is 0.010 below "off" for LateOn on FlatBuffers, where the
  shipped rule is 0.011 below.

### `rerank-3-lite` against `rerank-3`

Fusion off, all 72 questions:

| Metric | `rerank-3-lite` | `rerank-3` |
|---|---|---|
| Strict @1 / @3 / MRR@10 | 24 / 32 / 0.3819 | 24 / 32 / 0.3906 |
| Lenient MRR@10 | 0.4187 | 0.4253 |
| Questions where it ranks the owner higher (strict) | 4 | 7 |

The difference is under one question in 72. On the 44 new questions the lite
model is ahead (strict 0.2689 against 0.2566). Latency per call in the capture
run was the same: a median of 752 ms against 746 ms for 64 documents and about
28,000 tokens, measured through the test hook. These runs give no reason to
prefer `rerank-3` over `rerank-3-lite` as the default.

## What did not work

- **Reliability from agreement.** Estimating each reranker's reliability from
  how well it agrees with the name vote and the first-stage order gives LateOn
  0.428 and `rerank-3` 0.414. It cannot tell the weak reranker from the strong
  one, so it cannot set the vote's strength.
- **About 95 hand rules in ten families** (margins, gates, caps, tie-breaks,
  score blends): under either metric none reaches both LateOn's shipped result
  and `rerank-3`'s off result. The same holds for the 80 rank-fusion and
  new-signal rules; the closest is `rrf cov2 k5 w0.5`.
- **A learned linear rule:** learned the lenient grader, not relevance (see
  Metric decision).
- **Identifier coverage** (how much of the symbol name the query covers, the
  direction `isStrongFirstStageOwner` measures): as a score term or as a gate
  it is below off for the strong rerankers and weak for LateOn (for example
  0.3653 / 0.4732 / 0.5298 / 0.5952). It is no better a gate than `cov2`.
- **Candidate has references:** neutral to slightly negative.
- **Penalising long documents:** hurts every reranker
  (0.3212 / 0.4315 / 0.5111 / 0.5387).

## Headroom

| Question set | Strict | Lenient |
|---|---|---|
| Reach the fusion step | 25 of 28 | 25 of 28 |
| Owner among the 64 candidates | 19 of 25 | 22 of 25 |
| MRR of a perfect reorder | 0.6786 | 0.7857 |
| `rerank-3`, fusion off | 0.6012 | 0.6905 |

The same on the 44 new questions and on all 72:

| Question set | Reach the step | Owner in window (strict / lenient) | Perfect reorder (strict / lenient) | Best reranker, fusion off (strict) |
|---|---|---|---|---|
| 44 new | 34 | 20 / 21 | 0.4545 / 0.4773 | 0.2689 |
| Rewritten (26) | 21 | 16 / 16 | 0.6154 / 0.6154 | 0.3449 |
| Freshly written (18) | 13 | 4 / 5 | 0.2222 / 0.2778 | 0.1667 |
| All 72 | 59 | 39 / 43 | 0.5417 / 0.5972 | 0.3906 |

- Owner absent from the window: `r1`, `p3`, `f5` under both metrics, and `r2`,
  `f7`, `f9` under strict only (the window holds the right file but not the
  owning symbol).
- A perfect reorder is worth at most 0.077 strict MRR over what `rerank-3`
  already does. The nine questions with no reachable owner cost every reranker
  up to 0.32. Getting the owner into the window is the larger lever, and it
  helps every reranker regardless of strength.
- On all 72 questions a perfect reorder is worth at most 0.15 over `rerank-3`
  with fusion off, and the 33 questions with no reachable owner cost 0.46.
  For freshly written questions the owner reaches the window 4 times in 18.
- New questions with the owner absent under strict rank: 10 that do not reach
  the step (`r7_rewritten`, `fresh_r4`, `fresh_r6`, `p7_rewritten`,
  `p8_rewritten`, `fresh_p6`, `f2_rewritten`, `f8_rewritten`, `fresh_f5`,
  `fresh_f6`) and 14 that reach it (`r9_rewritten`, `fresh_r1`, `fresh_r3`,
  `fresh_r5`, `p3_rewritten`, `fresh_p1`, `fresh_p3`, `fresh_p4`, `fresh_p5`,
  `f4_rewritten`, `f7_rewritten`, `f9_rewritten`, `fresh_f3`, `fresh_f4`).
  Questions that do not reach the step are counted as misses here although
  the full pipeline may still answer them.

## Where the owner is lost (separate trace)

A second, read-only session traced the six original questions through the
harness log of the capture run. The `p3` and `f7` rows were checked against
the log here; the others were not re-verified.

| Question | Last stage where the owner is present | Lost at |
|---|---|---|
| `r1` | none recorded (absent from every arm and from the replay union of 267) | retrieval arms |
| `r2` | none recorded (the window holds the file and `useState`, not `dispatchSetState`) | retrieval arms |
| `p3` | MCP fusion, rank 89 (dense 46, core fusion 80, MCP fusion 89) | the 64-item window cut |
| `f5` | none recorded (the window holds `StartParseFile`, not `DoParse` / `Parse`) | retrieval arms |
| `f7` | dense arm, rank 10 (`ParseAnyValue`, lines 1328–1397) | core fusion, owner deduplication (see the mechanism table) |
| `f9` | expanded lexical fallback arm, rank 52 (`create`, lines 706–717); the window holds a file candidate for lines 690–706 | core fusion's top 80 (fused rank 84) |

Cautions from that trace:

- Harness stage ranks (`evals/real-repo-quality/harness-logger.mjs:30`) match
  a target chunk, an evidence-line overlap, or a file-level candidate on the
  right path. A rank is not proof that the owning symbol is present.
- `mcp_replay_signals` (`packages/mcp/src/core/search-execution.ts:1185`) is a
  diagnostic union of raw arms, not a stage a candidate must survive.
- "None recorded" is bounded by 80 candidates per arm per pass, 64 in the
  window, and 142 to 267 in the replay union.

### Mechanism per owner (second trace)

The same session then named the rule for each row. It reproduced every
recorded core-fusion id and score for `p3`, `f7` and `f9`, and ran no index
queries. It is not one mechanism.

| Question | Mechanism | Rule | Evidence |
|---|---|---|---|
| `r1` | Unresolved: absent from the returned arms | arm limit, `packages/core/src/core/semantic-search-service.ts:703` | Dense and lexical fallback return 80 each, all-terms returns none. Two indexed target ids exist; ranks beyond 80 are not recorded |
| `r2` | Unresolved: the declaration chunk is indexed but not retrieved | same | Chunk for lines 3656–3721 starts at `dispatchSetStateInternal`. Another question retrieves it at fallback rank 77; for `r2` it is absent from both passes |
| `p3` | Arm fusion demotes it, then the window cuts it | `packages/core/src/core/vector-candidate-fusion.ts:115`, `packages/mcp/src/core/search-rerank-policy.ts:169` | Dense rank 46 becomes core rank 80: 32 fallback-only candidates and two lower dense candidates with a second vote overtake it. MCP rank 89 misses the 64 window |
| `f5` | Unresolved: absent from the returned arms | arm limit, as `r1` | Six indexed target ids exist; dense and fallback return 80, all-terms none |
| `f7` | Owner deduplication inside one arm drops the declaration chunk | `vector-candidate-fusion.ts:109` | Dense ranks 1, 10 and 20 share one owner id. Rank 1 wins and rank 10 (lines 1328–1397) is skipped. The surviving sibling reaches window rank 7 as `file idl_parser.cpp` |
| `f9` | Core fusion ranks `create` below its cut | `vector-candidate-fusion.ts:157` | `create` is expanded fallback rank 52, deduplicated rank 43, fused rank 84, cut at 80. The file candidate for lines 690–706 has a different owner id, two primary-arm votes, core rank 4 and window rank 8. No rule prefers a file over a symbol |

Checked here against the code and the captured pool:

- The four rule lines are what the table says: both arms are requested with
  `limit: topK`, line 109 skips a candidate whose owner id was already seen in
  that arm, line 115 scores by the deduplicated rank, line 157 keeps the top
  `limit`, and `search-rerank-policy.ts:169` cuts the pool to the budget.
- The owner id is `symbol + path + owner symbol instance`, or `file + path`
  when a chunk has no owning symbol (`vectorCandidateOwnerId`, line 53). Every
  chunk of a file that has no owning symbol therefore collapses to one
  candidate per arm. In the `f7` pool `src/idl_parser.cpp` has exactly one
  such row (lines 1387–1444, fused rank 7, in the window) and no row for lines
  1328–1397. The per-arm ranks 1, 10 and 20 were not re-checked: the captures
  hold the fused pool, not the arms.
- The harness log has `p3` at fused rank 89 and the `f9` file candidate at
  fused rank 8 in the window.

For `r1` and `f5` an indexed target id proves that a row exists, not that a
separately labelled symbol chunk does: the harness accepts a symbol-label
match or an evidence-line overlap
(`evals/real-repo-quality/harness-logger.mjs:483`).

### Stage census on all 72 questions

The harness logs of both capture runs were read for the 33 owners that strict
replay counts as missing. Harness matching is looser than a strict symbol
match, so "present" is an upper bound.

| Stage | Owners | Questions |
|---|---|---|
| Not in the top 80 of any arm | 15 | `r1`, `r2`, `f5`, `r9_rewritten`, `fresh_r3`, `p3_rewritten`, `fresh_p1`, `fresh_p3`, `fresh_p4`, `fresh_p5`, `f4_rewritten`, `f7_rewritten`, `f9_rewritten`, `fresh_f3`, `fresh_f4` |
| Fusion step not reached, owner in the window anyway | 8 | `r7`, `p7`, `f8`, `r7_rewritten`, `fresh_r6`, `p7_rewritten`, `fresh_p6`, `fresh_f5` |
| Fusion step not reached, owner not in the window | 5 | `fresh_r4`, `p8_rewritten`, `fresh_f6` (in no arm); `f8_rewritten` (dense 62 only, lost in core fusion); `f2_rewritten` (fused rank 71) |
| In the fused list, cut by the 64 window | 3 | `p3` (89), `fresh_r1` (70), `fresh_r5` (78) |
| In an arm, lost in core fusion | 2 | `f7` (owner deduplication), `f9` (fused rank 84) |

- The 8 owners in the second row are not lost. Replay counts them as misses
  because the fusion step does not run for those questions; the harness finds
  6 of them in the final disclosed list. Why the step does not run was not
  examined.
- Of the 25 owners that are absent from the window, **18 are in no arm's top
  80**, 3 are lost in core fusion and 4 are cut by the window. The three
  mechanisms named above explain at most 7.
- The all-terms lexical pass returns nothing for almost all of these
  questions, so the lexical evidence comes from the fallback pass.
- **No caller alt terms.** `evals/real-repo-quality/run.mjs:41` sends
  `alt_terms` only with `--alt-terms-file`, neither case file carries them,
  and every expansion trace shows none emitted.
  [Agent alt terms in definition discovery](agent-alt-terms-definition-discovery.md)
  reports that alt terms raise owners in the top 10 from 27 to 34 of 46 on
  the conceptual set. The retrieval gap here is the gap without them.

### Where name evidence already enters (survey)

From the same session, read-only, not re-verified here except where noted:

- Before reranking, names enter through the symbol-metadata BM25 pass
  (`packages/mcp/src/core/search-execution.ts:1059`).
- The window is chosen by `selectRerankCandidates`
  (`packages/mcp/src/core/search-rerank-policy.ts:114`), called from
  `buildRerankInput` (`packages/mcp/src/core/search-rerank-execution.ts:186`):
  the first representative of each owner family, then up to two supplemental
  chunks, to a default depth of 64. `file_symbols` candidates can reserve half
  the budget, and projection failures or the 1 MiB input budget can shrink it.
  The caller holds the query and the definition metadata (name and qualified
  name); the selector does not use them.
- The reranker document is built by `buildSearchRerankDocument`
  (`packages/mcp/src/core/search-rerank-document.ts:284`) with a
  query-focused excerpt inside 4,000 UTF-8 bytes and no separate
  qualified-name field. The serialized key order is role, symbol label,
  excerpt, path, signature, references, structural context, kind, because
  canonical JSON sorts keys (`packages/mcp/src/core/canonical-json.ts:16`).

## Observations not yet explained

- **LateOn and document length.** Correct candidates are longer than the
  window average (0.62 standard deviations in log length). The Voyage models'
  scores correlate with length (+0.21 to +0.30) and their first picks are long.
  LateOn's score does not (−0.04) and its first picks are shorter than
  average. Truncation is an unlikely cause: LateOn's document limit is 2,048
  tokens and the longest captured document is 3,994 characters. No cause is
  established, and a positive length bonus was not tested because it would be
  a proxy fitted to this dataset.
- **Field order in the reranker document.** `search-rerank-document.ts` lists
  path, role, kind, label, signature, then excerpt, but the canonical JSON
  writer sorts keys, so the path and signature follow the excerpt (path starts
  at a median of 614 characters, 2,580 at the 90th percentile). Whether this
  costs any reranker anything is untested.
- **Core arm fusion.** All-terms rows may collect two lexical votes in
  `packages/core/src/core/vector-candidate-fusion.ts`. The second trace links
  extra votes to one missing owner (`p3`); how often it happens is not
  measured.
- **Test candidates.** No candidate with a test role is correct in these
  windows, but the test-seeking questions are among the three that do not
  reach the step, so a rule that demotes tests would look good by construction.
  Not tested as a rule.

## Decision and next actions

Decided:

- Strict rank is the primary metric; lenient rank is reported beside it.
- Stop searching for a better formula on 28 questions. The remaining
  candidates differ by less than the data can resolve.
- Do not pursue reliability estimation. The label-free version failed, and a
  probing version would add a component and paid calls for a second-order
  gain.
- Scope: LateOn, `rerank-3-lite` (default Voyage model) and `rerank-3`.
  `rerank-2.5` is out of scope as obsolete.
- Keep the code as it is. `rerankerOrderNeedsDefinitionFusion`
  (`packages/mcp/src/core/search-definition-discovery.ts:38`) already skips
  definition fusion for `rerank-3` and `rerank-3-lite`, and LateOn keeps the
  shipped rule.

Withdrawn:

- The proposal to replace the shipped rule for every reranker with
  `rrf cov2 k5 w0.5` and remove the model-name skip. Its case rested on
  Voyage models outside the name list, which are now out of scope. For the
  models in scope, strict rank on 72 questions:

  | Rule | LateOn | `rerank-3-lite` | `rerank-3` |
  |---|---|---|---|
  | Current product behaviour | 0.2964 (shipped rule) | 0.3819 (off) | 0.3906 (off) |
  | `rrf cov2 k5 w0.5` | 0.2902 | 0.3812 | 0.3986 |
  | `rrf any k5 w0.5` | 0.2726 | 0.3958 | 0.4056 |
  | Score-aware | 0.2606 | 0.3976 | 0.3967 |

  No rule gains more than 0.016 for a Voyage model, about one question in 72,
  and each costs LateOn. The rule stays recorded as the fallback if a reranker
  outside the list has to be supported.

Next action (`next action | why necessary now | stopping condition`):

1. Classify the 18 owners that are in no arm's top 80 | they are the largest
   group, no reranker, fusion rule or window size recovers them, and whether
   the fix is a limit, the query side or indexing is unknown | each of the 18
   has its indexed rows (label, owner id, span), its rank in a dense arm and a
   lexical fallback arm widened well past 80, and one class: within reach of a wider arm, far or absent, or no symbol-level
   chunk. Read-only, one sequential job, using the saved index.

Not proposed: a change to owner deduplication or to the core fusion cut. They
explain 3 owners of 72, which is not enough evidence for a hot-path change.

## Limits

- 72 questions on three repositories, one captured run per reranker. One
  question is 0.036 MRR on the original 28 and 0.023 on the 44 new ones.
- Replay grades the order leaving the fusion step, not the final response.
  Later stages are not modelled.
- `rerank-2.5` is rebuilt from cached scores on the original 28 and is a
  logged run on the 44 new questions. It is out of scope for the decision.
- No capture sent caller alt terms, which agents normally send. Retrieval
  recall with alt terms was not measured here.
- The stage census reads harness logs, whose matching is looser than strict
  rank, and the per-arm ranks in the second trace were not re-checked.
- The candidate rules were found on the original 28 questions. The 44 new
  questions are held out for the six rules fixed in advance, and for nothing
  else: the other rules in this document were not rerun on them.
- The 44 new questions use the same three repositories and the same index.
  A fourth repository was not tested.
- The Voyage models answered through a test hook that swaps the reranker
  response, not through the shipped Voyage path.
- No external literature was consulted.

## Reproducing

The replay scripts and captures are **not in the repository**. They live in
session scratch directories under `/tmp/claude-1000/` and will not survive a
reboot. Moving them into `evals/` is a separate decision.

- Captures of the original 28 (about 6 MB of JSONL): `cap.jsonl` and
  `fusion-in-<arm>.jsonl` in the bake-off scratch directory. That directory
  also holds an API key file, which was not read and must not be copied.
- Captures of the 46 conceptual questions (about 24 MB): `cap-<arm>.jsonl`,
  `fusion-in-<arm>.jsonl` and `swap-<arm>.jsonl` in the `bake46` scratch
  directory, written by `run46.sh` from a copy of the saved index state.
- Scripts: `fusion-rootcause.mjs` (mechanism), `fusion-factor.mjs`
  (reliability from agreement), `fusion-reveng.mjs` (hand rules),
  `fusion-learn.mjs` (learned rule), `fusion-next.mjs` (rank-fusion grid,
  leave-one-repository-out, base rates, per-question ranks).
- Command: `[STRICT=1] node fusion-next.mjs <capture dir> [table|grid|loro|lift|ids|uncapped]`.
  Without `STRICT=1` the lenient rank is used. `CASES=<file>` selects the
  question file, `ARMS=<list>` the rerankers, `EXCLUDE=r1,r8` drops the two
  repeated questions, and `DUMP=<file>` writes per-question ranks.
- `node fusion-combine.mjs <dump of the 28> <dump of the 44>` prints the
  tables and the better / worse counts per set, variant and repository.

## Open

- Why 18 owners are in no arm's top 80 (next action 1).
- Why the fusion step does not run for 13 of 72 questions.
- Whether caller alt terms close the retrieval gap. No alt-terms file for
  these questions was found under `evals/`.
- Whether name and path evidence helps more as reranker input or as a
  window-admission signal than as a vote after reranking. Not tested; it can
  only help the 7 owners that reach an arm.
- Whether to bring the replay scripts and captures into the repository.
