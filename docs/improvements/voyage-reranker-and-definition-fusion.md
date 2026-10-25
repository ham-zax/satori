# Voyage rerankers and definition fusion

Recorded 2026-10-13 on `master` at `a710008a` plus uncommitted work. Every
figure below comes from 28 judged questions on three public repositories, with
one run per arm unless a section says otherwise. Treat the quality figures as a
strong signal and single-run latency figures as indicative only.

Provenance (annotated 25 October 2026): the 2026-10-13 arms predate the `5f96827c` rubric change
and the `0a2aa66c` fusion change. The "Shipped Voyage path" section starts with the later re-run at
`0a2aa66c`, under the current rubric, and ends with the matched three-run comparison at code
`fb125738`, re-scored with the `008b5a2b` f5 oracle. Read that section for current behaviour, and
the sections before it as the history that chose the shipping rule.

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
  23/27/27 with MRR 0.8810.
- The symbol-metadata pass is not an independent gain. On the native document it
  changes no rank. Under the canonical projection it changes neither a rank nor
  a byte of rerank input, so the shipped path leaves it off.

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

Provenance: these captures were taken before `5f96827c` (the p3 rubric change) and before
`0a2aa66c` (inflected query words in definition fusion). LateOn's hit@5 and hit@10 here are
therefore three below the `fb125738` re-measurement of the same 28 questions: 13/22/24 with MRR
0.5664, measured in the `0a2aa66c` differential at workspace `07ab8334`. The MRR column is MRR@10,
the mean of 1/rank for rank <= 10. Do not compare it across documents: the same 13/21/22 counts
carry MRR@10 0.5509 in the `0a2aa66c` differential and 0.580697 in the 24 October rescore of
capture C, so the two values use different inputs. Compare hit counts across builds.

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
`0a2aa66c`. The arms differ in the projection Voyage is handed; arm C also
turns `definition_discovery` off. This run uses the current rubric
(`5f96827c`), so its counts compare with the other 28-question figures of
24 October onwards and not with the 2026-10-13 tables above.

| Arm | Projection | hit@1 | hit@5 | hit@10 | MRR | Mean input | Rerank median |
|---|---|---|---|---|---|---|---|
| A | native provider document | 20 | 25 | 25 | 0.7798 | 105,445 bytes | 806 ms |
| D | native + symbol-metadata pass | 20 | 25 | 25 | 0.7798 | 104,196 bytes | 888 ms |
| C | canonical, definition discovery off | 22 | 26 | 26 | 0.8393 | 166,424 bytes | 935 ms |
| B | canonical, shipped flags | 23 | 27 | 27 | 0.8810 | 168,374 bytes | 993 ms |

All rows are re-scored with the `008b5a2b` f5 oracle. Only arm B changes: its
accepted `src/flatc.cpp` `ParseFile` answer lifts it to 23/27/27 with MRR 0.8810.

Four repeat runs at `fb125738` (three without and one with
`symbol_metadata_bm25`) reproduce 23/27/27 and MRR 0.881 every time, with the
same 168,374-byte mean input and the same billed tokens. The metadata flag
changes neither the ranks nor the rerank input at this build. One run bills
1,209,744 provider tokens over the 28 questions: mean 43,205 per search, range
24,664–60,404. At that rate the 200-million-token free tier covers about 4,600
searches.

Arm C is not a projection-only control: it also turns `definition_discovery`
off. Its `p6` rank 3 against 2 for the shipped arm is that flag's effect, not
the projection's. Against arm A, which keeps the shipped flags, the projection
moves `r3` 3 → 2, `r7` absent → 1, `p1` 3 → 1, and `f5` absent → 1. It
costs 60% more input bytes (168,374 against 105,445 per query, mean). In the
single-run table its rerank median is 187 ms higher (993 against 806 ms).

The symbol-metadata pass is not a gain under either document. On the native
document (A → D) it changes no rank. Under the canonical projection it changes
neither the ranks nor the rerank input, so the shipped path uses the canonical
document with the pass off.

### Matched three-run comparison (2026-10-25)

Same 28 questions, same Publication, same flags, three fresh runs per arm. The
reranker path is `fb125738`, the token accounting is `7b7c23dc`, and the f5
oracle is `008b5a2b`. The LateOn arm's third run records docs-only `16fbd7eb`;
the code and index are unchanged. Both arms see the same 116.3 mean rerank
candidates and the same 168,374 mean input bytes.

| Reranker | hit@1 | hit@5 | hit@10 | MRR | Rerank median | Total median |
|---|---|---|---|---|---|---|
| Voyage `rerank-3-lite`, canonical | 23 | 27 | 27 | 0.8810 | 1,033 ms (899–1,157) | 2,234 ms (2,177–2,402) |
| LateOn | 13 | 22 | 24 | 0.5664 | 2,576 ms (2,434–2,577) | 3,410 ms (3,255–3,688) |

Every run produced the same hit counts and MRR, so the quality spread is zero.
Voyage ranks 13 questions better and one worse (`p6` 1 → 2). Its rerank median
is 1,543 ms lower; the total median is 1,176 ms lower because retrieval and
response overhead are shared.

Definition fusion skips the Voyage `rerank-3` family. On the shipped path the
post-fusion order equals the provider order on 28 of 28 queries.

These runs predate `9abe9006` (the default-on `cleanup` → `destroy` bridge).
The 28-query rerank-3 run at `5253c443` with the bridge scores hit@1/5/10
23/28/28, MRR 0.8899, with no misses; the `rerank-3-lite` arm is not re-measured.

## Changes in the working tree

Uncommitted at the time of writing. Committed since: the core fusion credit in
`a9be87e3`, the `rerank-3` acceptance and fusion skip in `22a56c06`, the
canonical projection in `fb125738`, the provider token accounting and eval
arm override in `7b7c23dc`, and the f5 oracle in `008b5a2b`.

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
  bytes as LateOn. This is the shipped arm above.
- **LateOn-only activation policy** (`packages/mcp/src/config.ts`,
  `packages/cli/src/runtime-config.ts`): a leftover
  `SATORI_LATEON_ACTIVATION_POLICY` no longer stops the server or the static
  runtime config when the provider is `voyage` or `none`.
- **Provider token accounting** (`packages/core/src/reranker/reranker.ts`,
  `voyageai-reranker.ts`, `packages/mcp/src/core/search-rerank-execution.ts`):
  Voyage's wire `usage.total_tokens` is summed over attempts and exposed as
  `providerTokens`; the search debug hint and eval record carry it as
  `rerankerProviderTokens`. Local providers omit the field.
- **Eval arm override** (`evals/real-repo-quality/session.mjs`, `run.mjs`):
  non-secret `SATORI_EVAL_RUNTIME_ENV` selects a provider arm without editing the
  installed launcher, and `provenance.runtime` records the resolved arm. Secrets
  stay in `~/.satori/.env`.

## Limits

- 28 questions, three repositories. The shipped Voyage arm and the matched
  LateOn arm have three runs each, with identical counts in every run. The other
  projection arms have one run, so a one-question difference between them is
  within noise.
- The projection table was measured at `0a2aa66c` on a fresh index. The matched
  comparison uses the `fb125738` reranker path, the `7b7c23dc` token
  accounting, and the `008b5a2b` f5 oracle, on one Publication built at
  `0a2aa66c` and reused unchanged. The canonical projection sends 60% more bytes
  than the native document (168 KB against 105 KB per query, mean). The native
  document is measured and scores lower (20/25/25, MRR 0.7798); no equivalence
  is claimed.
- The fusion skip matches the literal model names `rerank-3` and
  `rerank-3-lite`. A different pass-through model name keeps definition fusion.
- Fusion-off for `rerank-2.5` was replayed offline only.
- The rule was chosen on the same 28 questions it is reported on. It has not
  been checked on questions it was not tuned against.
- Latency is three runs on one host and one network path. It does not predict
  another host or a congested network.
- A larger local model (`LateOn-Code`) and local cross-encoders were not tested.

## Guidance for the README

The measurements support recommending Voyage `rerank-3` (or `rerank-3-lite`
where cost matters) as the best-quality option, and keeping local LateOn as the
offline default. Quote the result as measured on this eval: 23 of 28 owners at
rank 1 against 13, with the canonical projection. Using Voyage sends rerank
documents (code excerpts) to a third party and is billed per token; say so next
to the recommendation. One search bills 43,205 tokens on average, range
24,664–60,404. At the listed `rerank-3-lite` price of $0.02 per million tokens
([Voyage pricing](https://docs.voyageai.com/docs/pricing), 25 October 2026),
that is about $0.00086 per search, or $0.024 per 28-question pass, after the
200-million-token free tier.

## Open

- `r1`: the owner never reaches the rerank window. This is retrieval and
  admission work, independent of the reranker. `9abe9006` later adds a
  default-on `cleanup` → `destroy` behavior bridge; on the 28-query rerank-3 run
  at `5253c443` it moves r1 from absent to rank 1 with no other case change
  (hit@1/5/10 23/28/28, MRR 0.8899). The `rerank-3-lite` table above is not
  re-measured with that bridge.
- `f5` was an oracle mismatch, not a retrieval miss. Voyage ranks `src/flatc.cpp`
  `ParseFile` first, and the `008b5a2b` oracle accepts it.
- `r2` ranks low under every model.
- Definition fusion itself is to be revisited in a separate session.
