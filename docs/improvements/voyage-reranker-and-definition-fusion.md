# Voyage rerankers and definition fusion

Recorded 2026-10-13 on `master` at `a710008a` plus uncommitted work. Every
figure below comes from 28 judged questions on three public repositories, with
one run per arm. Treat the quality figures as a strong signal and the latency
figures as indicative only.

## Summary

- Replacing the local LateOn reranker with Voyage `rerank-3` and keeping the
  rest of the pipeline unchanged raises MRR from 0.5557 to 0.6446.
- Most of the possible gain was being lost in one step: definition fusion.
  With that reorder skipped, `rerank-3` reaches MRR 0.7798 and puts the right
  owner first on 20 of 28 questions instead of 13.
- Definition fusion helps LateOn and hurts the `rerank-3` family. No single
  weighting serves both, so the rule depends on the reranker.
- The Voyage arms were also faster per request than local LateOn on this
  machine.
- The shipped Voyage provider path reproduces the result: `rerank-3-lite`
  scores 20/25/25 with MRR 0.7798, and the canonical projection raises that to
  22/26/26 with MRR 0.8452.
- The symbol-metadata pass is not an independent gain. On the native document it
  changes no rank. Under the canonical projection it recovers one rank (`p6`)
  for 1.2% more bytes.

## Problem

The 12 October investigation left ten questions classed as "reranker ordering":
the right owner was in the rerank window and the reranker placed it too low.
Earlier work ([reranker owner investigation](reranker-owner-investigation.md))
changed the query and document format for LateOn without a clean win. It never
compared a different model on the same candidates. This pass does that, then
asks why the full pipeline kept less of the gain than the raw comparison showed.

## Method

- Eval: `evals/real-repo-quality` (React 9, Polars 9, FlatBuffers 10 questions),
  `node evals/real-repo-quality/run.mjs --state-root <copy>/state --out <dir>
  --reuse-index --index-timeout-min 3`, each run under
  `systemd-run --user --scope -p MemoryMax=6G` on a copy of the saved index
  state. A run takes about four minutes.
- Baseline reranker: `lightonai/LateOn-Code-edge`, document projection
  `search_rerank_document_v5`, query projection `search_rerank_query_v2`, rerank
  window 64.
- Raw-pool comparison: the 64 rerank documents and the query of every question
  were captured once from the LateOn run. Each Voyage model then ranked those
  identical documents. This isolates model judgement from everything else.
- Full-pipeline arms: a scratch hook answered each LateOn rerank call with the
  Voyage model's scores for the same documents. Admission, definition fusion,
  pins and grouping then ran as shipped.
- Fusion-off arms: the same, with the definition-fusion reorder skipped.
  Definition-based admission was left on.
- Fusion replay: the inputs of every definition-fusion call were logged and
  replayed offline against variants of the rule. The replay reproduces the
  shipped rule's order on all 25 questions that reach the step. The other three
  are test-seeking questions, which do not use definition fusion.
- Metrics: hit@k counts questions whose accepted owner is at rank k or better;
  MRR is the mean of 1/rank over the 28 questions, zero when the owner is not in
  the top ten.

## Results

### Models on identical candidates

Raw reranker order over the 64 captured documents, before any Satori ranking
rule. MRR here counts ranks beyond ten, so it is not directly comparable with
the pipeline tables.

| Order | @1 | @3 | @5 | @10 | MRR |
|---|---|---|---|---|---|
| Retrieval order (reranker input) | 7 | 9 | 14 | 19 | 0.3523 |
| LateOn | 9 | 14 | 17 | 20 | 0.4466 |
| `rerank-2.5` | 13 | 22 | 23 | 24 | 0.6228 |
| `rerank-3-lite` | 19 | 24 | 24 | 24 | 0.7568 |
| `rerank-3` | 20 | 24 | 24 | 24 | 0.7819 |

Sending the bare question instead of Satori's rerank query lowered `rerank-3`
to 16 @1 and MRR 0.6918, and `rerank-3-lite` to 16 @1 and 0.6823. `rerank-2.5`
moved slightly the other way (14 @1, 0.6567). The Satori query format was kept.

Four questions are outside what any reranker can fix here: `r1`, `p3` and `f5`
have no accepted owner among the 64 documents, and `r2` stays low under every
model.

### Full pipeline

| Reranker | Definition fusion | hit@1 | hit@5 | hit@10 | strict@1 | MRR |
|---|---|---|---|---|---|---|
| LateOn (shipped default) | on | 13 | 19 | 21 | 13 | 0.5557 |
| LateOn | off | 10 | 19 | 21 | 8 | 0.4739 |
| `rerank-2.5` | on | 15 | 20 | 22 | 14 | 0.6176 |
| `rerank-3` | on | 16 | 21 | 22 | 15 | 0.6446 |
| `rerank-3` | off | 20 | 24 | 24 | 17 | 0.7798 |
| `rerank-3-lite` | on | 18 | 21 | 22 | 17 | 0.6808 |
| `rerank-3-lite` | off | 20 | 24 | 24 | 17 | 0.7738 |

Against the shipped default, `rerank-3` with definition fusion off is +0.224
MRR (+40% relative) and seven more questions answered at rank 1. With fusion
left on it is +0.089 MRR (+16%) and three more.

### Per question

Final rank of the accepted owner; `-` means not in the top ten.

| Question | LateOn | LateOn, fusion off | `rerank-2.5` | `rerank-3` | `rerank-3`, fusion off | `rerank-3-lite` | `rerank-3-lite`, fusion off |
|---|---|---|---|---|---|---|---|
| r1 | - | - | - | - | - | - | - |
| r2 | - | - | - | - | - | - | - |
| r3 | - | - | - | - | 1 | - | 2 |
| r4 | 1 | 3 | 2 | 2 | 1 | 2 | 1 |
| r5 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| r6 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| r7 | 4 | 4 | 6 | 2 | 2 | 1 | 1 |
| r8 | 2 | 4 | 1 | 1 | 1 | 1 | 1 |
| r9 | 1 | 2 | 1 | 1 | 1 | 1 | 1 |
| p1 | 2 | 1 | 4 | 4 | 2 | 4 | 1 |
| p2 | 3 | 4 | 2 | 2 | 1 | 1 | 1 |
| p3 | - | - | - | - | - | - | - |
| p4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| p5 | 1 | 2 | 1 | 1 | 1 | 1 | 1 |
| p6 | 1 | 1 | 1 | 1 | 2 | 1 | 3 |
| p7 | 8 | 8 | 1 | 1 | 1 | 1 | 1 |
| p8 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| p9 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| f1 | 1 | 5 | 1 | 1 | 1 | 1 | 1 |
| f2 | 4 | 4 | 4 | 5 | 3 | 5 | 3 |
| f3 | 10 | - | 1 | 1 | 1 | 1 | 1 |
| f4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| f5 | - | - | - | - | - | - | - |
| f6 | 1 | 2 | 2 | 1 | 1 | 1 | 1 |
| f7 | - | - | - | - | 1 | - | 1 |
| f8 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| f9 | 2 | 1 | 1 | 1 | 1 | 1 | 1 |
| f10 | - | 9 | 8 | 10 | 1 | 9 | 2 |

`rerank-3` with fusion off loses to the shipped default on one question (`p6`,
1 → 2) and matches or beats it on the other 27.

### Latency and cost

Per-request wall time across the 28 questions, one run per arm, on a WSL2
machine with LateOn on CPU. Voyage time includes the network round trip.

| Reranker | Definition fusion | Median request | Mean request | Median rerank step |
|---|---|---|---|---|
| LateOn | on | 2355 ms | 2834 ms | 1493 ms |
| LateOn | off | 2284 ms | 2948 ms | – |
| `rerank-2.5` | on | 1724 ms | 2111 ms | 851 ms |
| `rerank-3` | on | 1962 ms | 2333 ms | 1344 ms |
| `rerank-3` | off | 1737 ms | 2308 ms | – |
| `rerank-3-lite` | on | 1677 ms | 2144 ms | 742 ms |
| `rerank-3-lite` | off | 1641 ms | 2173 ms | – |

Median request time was 17–30% lower with a Voyage model than with local
LateOn. These are single runs over a network, not three-run medians, and a
machine with a GPU or a slower link would change the comparison.

Each Voyage arm made 28 rerank calls and consumed 681,260 billed tokens, about
24,000 per search at 64 documents.

## Where the pipeline lost the gain

The raw comparison gave `rerank-3` an MRR of 0.7819; the full pipeline with
fusion on delivered 0.6446. The difference comes from definition fusion
(`fuseDefinitionDiscovery`, `packages/mcp/src/core/search-definition-discovery.ts`),
which runs straight after the reranker:

1. it ranks the same candidates by BM25 over symbol name, qualified name and
   file path against the query terms;
2. it merges that rank with the reranker's rank by equal-weight reciprocal rank
   fusion (`k = 60`); and
3. inside each file it reorders that file's candidates by how many query terms
   their names cover.

Rank of the accepted owner with `rerank-3`, before and after the step:

| Question | Reranker order | After definition fusion | Final |
|---|---|---|---|
| r3 | 1 | 19 | not in top 10 |
| f7 | 1 | 15 | not in top 10 |
| f10 | 1 | 9 | 10 |
| r4 | 1 | 2 | 2 |
| p1 | 2 | 4 | 4 |
| f2 | 3 | 6 | 5 |

Pins and grouping after that step barely move ranks: with fusion off, the full
pipeline reaches 0.7798 against 0.7819 raw.

The same step is what makes LateOn usable. With LateOn it lifts `r8` from 23
to 3 and `f3` from 48 to 10, and removing it costs three rank-1 answers. The
name vote corrects a reranker that misjudges owners, and overrides one that
judges them correctly.

### Variants replayed offline

Rank of the owner immediately after the step, on the 25 questions that reach
it. MRR is over 28 for comparability with the tables above.

| Rule | LateOn @1 / MRR | `rerank-2.5` @1 / MRR | `rerank-3-lite` @1 / MRR | `rerank-3` @1 / MRR |
|---|---|---|---|---|
| Shipped rule | 12 / 0.5032 | 13 / 0.5420 | 15 / 0.5786 | 14 / 0.5601 |
| Step off | 8 / 0.3974 | 11 / 0.5454 | 16 / 0.6497 | 18 / 0.6926 |
| Within-file reorder only | 10 / 0.4494 | 11 / 0.5372 | 16 / 0.6326 | 17 / 0.6579 |
| Name vote at weight 0.5 | 13 / 0.5162 | 13 / 0.5450 | 16 / 0.6019 | 16 / 0.5998 |
| Name vote at weight 0.1 | 11 / 0.4736 | 13 / 0.5671 | 17 / 0.6506 | 17 / 0.6580 |
| Name vote at weight 0.1, no within-file reorder | 10 / 0.4451 | 13 / 0.5713 | 17 / 0.6675 | 17 / 0.6746 |

The `rerank-2.5` and `rerank-3-lite` columns use cached scores from the raw-pool
comparison; the same construction for `rerank-3` reproduces its logged run
exactly.

Findings:

- LateOn wants the full rule; quality falls as the name vote weakens.
- `rerank-3` is best with the step off. The within-file reorder alone moves
  `r3` from rank 1 to rank 36.
- `rerank-2.5` is undecided: turning the step off leaves MRR flat, with fewer
  rank-1 answers (11 against 13) and more top-3 answers (20 against 16).
- Rules that break ties only within a reranker score margin did not beat "off"
  for `rerank-3` or the shipped rule for LateOn.
- A learned weighting is not justified on 28 questions; a one-line rule already
  recovers nearly all of the raw gain.

## Shipped Voyage path (2026-10-24)

Same 28 questions, same Publication, same parameters, one fresh index, at
`0a2aa66c`. The arms differ only in the projection Voyage is handed.

| Arm | Projection | hit@1 | hit@5 | hit@10 | MRR | Mean input | Rerank median |
|---|---|---|---|---|---|---|---|
| A | native provider document | 20 | 25 | 25 | 0.7798 | 105,445 bytes | 806 ms |
| D | native + symbol-metadata pass | 20 | 25 | 25 | 0.7798 | 104,196 bytes | 888 ms |
| C | canonical document and query | 22 | 26 | 26 | 0.8393 | 166,424 bytes | 935 ms |
| B | canonical + symbol-metadata pass | 22 | 26 | 26 | 0.8452 | 168,374 bytes | 993 ms |

Arm C isolates the projection: `r3` 3 → 2, `r7` absent → 1, `p1` 3 → 1, and
`p6` 2 → 3. The projection costs 58% more input bytes and about 130 ms of
provider time. Arm D adds the symbol-metadata pass to the native document and
changes no rank. With the projection, the pass adds 47 documents, moves `p6`
back to 2, and changes no other rank, so arm B is the current path.

Relative to the native document, the projection is +7.6% MRR and +10% hit@1.
Adding the metadata pass to the projection is +0.7% MRR, one rank on `p6`, for
+1.2% bytes. Adding it to the native document is 0.0%. Arm C is the cheaper
design. Arm B is the default because the difference is one rank, within the
noise of 28 questions, and it needs no Voyage-only gate.

Definition fusion skips the Voyage `rerank-3` family. On the shipped path the
post-fusion order equals the provider order on 28 of 28 queries.

## Changes in the working tree

Uncommitted at the time of writing. Committed since: the core fusion credit in
`a9be87e3`, the `rerank-3` acceptance and fusion skip in `22a56c06`.

- **Core fusion credit** (`packages/core/src/core/vector-candidate-fusion.ts`,
  `semantic-search-service.ts`): when the any-terms lexical arm filled its limit
  and cut off a row that matched all terms, that row is credited the first rank
  past the cut. Effect on the default pipeline: `f3` from unranked to 10.
  Together with the pin fix in `a710008a` the default moved from 11/19/20, MRR
  0.5164, to 13/19/21, MRR 0.5557.
- **Fusion switch** (`search-definition-discovery.ts`,
  `search-rerank-execution.ts`): the definition-fusion reorder is skipped when
  the reranker identifies as Voyage `rerank-3` or `rerank-3-lite`. Every other
  reranker keeps the shipped rule. One test covers both directions.
- **Model names** (`packages/core/src/reranker/voyageai-reranker.ts`,
  `packages/mcp/src/config.ts`): `rerank-3` and `rerank-3-lite` are accepted for
  `VOYAGEAI_RERANKER_MODEL`. The fixed list of accepted names is to be replaced
  by pass-through names; see
  [Reranker selection plan](reranker-selection-plan.md).
- **Voyage canonical projection** (`packages/mcp/src/server/voyage-reranker.ts`,
  `provider-runtime.ts`): Voyage advertises `search_rerank_document_v5` and
  `search_rerank_query_v2`, so the coordinator builds the same publication-bound
  bytes as LateOn. This is arm B above.
- **LateOn-only activation policy** (`packages/mcp/src/config.ts`,
  `packages/cli/src/runtime-config.ts`): a leftover
  `SATORI_LATEON_ACTIVATION_POLICY` no longer stops the server or the static
  runtime config when the provider is `voyage` or `none`.

## Limits

- 28 questions, three repositories, one run per arm. A difference of one
  question is within noise.
- The shipped Voyage path was measured at `0a2aa66c` on a fresh index. The
  canonical projection sends 58% more bytes than the native document (166 KB
  against 105 KB per query, mean), so a cheaper variant must be measured before
  it is claimed equivalent.
- The fusion skip matches the literal model names `rerank-3` and
  `rerank-3-lite`. A different pass-through model name keeps definition fusion.
- Fusion-off for `rerank-2.5` was replayed offline only.
- The rule was chosen on the same 28 questions it is reported on. It has not
  been checked on questions it was not tuned against.
- Latency is single-run; Voyage latency depends on the network.
- A larger local model (`LateOn-Code`) and local cross-encoders were not tested.

## Guidance for the README

The measurements support recommending Voyage `rerank-3` (or `rerank-3-lite`
where cost matters) as the best-quality option, and keeping local LateOn as the
offline default. Quote the result as measured on this eval: 22 of 28 owners at
rank 1 against 13, with the canonical projection. Using Voyage sends rerank
documents (code excerpts) to a third party and is billed per token; say so next
to the recommendation.

## Open

- `r1` and `f5`: the owner never reaches the rerank window. This is retrieval
  and admission work, independent of the reranker.
- `r2` ranks low under every model.
- Definition fusion itself is to be revisited in a separate session.
