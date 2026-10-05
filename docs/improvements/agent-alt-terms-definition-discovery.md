# Agent alt terms in definition discovery

Recorded 2026-10-06. `definition_alt_terms` is **on by default**. It only acts
when the caller supplies `alt_terms`; `flags: { definition_alt_terms: false }`
restores the previous behavior.

## Problem

Natural-language questions describe what code does; identifiers record what
the author called it. "Where does React run the cleanup function of
useEffect" is owned by `commitHookEffectListUnmount`, which calls the cleanup
`destroy`. No important query word appears in the owner. Lexical search cannot
match it, the static embedder cannot contextualize it, and the reranker never
sees it because it is not admitted into the 64-candidate window.

Before this change, caller `alt_terms` fed one extra lexical pass over chunk
text. Definition discovery (symbol-metadata BM25, see
[implementation ownership](implementation-owner-ranking.md)) only searched
with the user's words, so the agent's best evidence about identifier names
never reached the pass that searches identifier names.

## Change

With the flag on and `alt_terms` present, search runs a second
symbol-metadata BM25 pass over the alt terms and fuses definition evidence
using the query plus the alt terms. Without `alt_terms` the request is
unchanged.

## Evidence

46-question conceptual set (React, Polars, FlatBuffers, pinned commits),
LateOn on, `--reuse-index`. One model played the agent and wrote four alt
terms per question (`opencode/muse-spark-1.3-contributor-free`). The control
arms give each question another question's alt terms: confident, plausible
and wrong. Scored with the harness scorer on the corrected labels (below).

| Arm | Alt terms | `definition_alt_terms` | hit@1 | hit@5 | hit@10 | MRR |
|---|---|---|---|---|---|---|
| d0 | none | n/a | 8 | 14 | 16 | 0.230 |
| d1 | own | off | 12 | 23 | 27 | 0.355 |
| **d2** | own | **on** | **16** | **28** | **34** | **0.463** |
| d3 | another question's | on | 1 | 8 | 8 | 0.086 |
| d4 | another question's | off | 7 | 10 | 11 | 0.179 |

- Turning the flag on is d1 → d2: hit@10 27 → 34, hit@1 12 → 16.
- React r1 (cleanup → `destroy`): miss in d0, rank 1 in d1 and d2.
- Median request time: d0 2.7 s (rerun on an idle machine; the first run, 4.2 s, was under load), d1 3.1 s, d2 2.9 s. No index change.
- Later, with the host-adaptive LateOn encoder pool (4 sessions × 2 threads here), d0 dropped to 2.24 s median (rerank phase 2.12 → 1.68 s). Owner metrics are unchanged because scores are bit-identical.
- The controls show the cost: with wrong terms the flag hurts (d3 8 vs d4 11),
  and both are below sending nothing (d0 16). The flag amplifies the agent's
  terms in both directions.

Why it is on anyway: it is inert without `alt_terms`; the control is a stress
test where every term is systematically wrong; and it is a single flag that
callers can disable. Making wrong terms cost less is open (see Limits).

These are tuning-set results. The alt terms came from one model.

## Label corrections

Rescoring the misses showed seven expected answers in
`evals/real-repo-quality/conceptual-cases.json` pointed at code that does not
exist at the pinned commits, so no engine could hit them. An audit (`git
ls-files` at each pinned commit against every `pathRegex`) now reports zero
unreachable labels.

| Case | Old label assumed | Corrected owner |
|---|---|---|
| fresh_r5 | DevTools renderer at `backend/renderer.js` | `backend/fiber/renderer.js` `attach` |
| fresh_p1 | `unique` in a file without it | `polars-compute/src/unique/`, `polars-core/.../ops/unique/` |
| fresh_p4 | hash join in its old crate | `polars-ops/src/frame/join/hash_join/` |
| fresh_p5 | a `pivot` module that does not exist | `polars-lazy/src/frame/mod.rs`, `polars-plan/src/dsl/builder_dsl.rs` `pivot` |
| fresh_p6 | string tests at the old path | `py-polars/tests/unit/operations/namespaces/string/` |
| fresh_f3 | FlexBuffers at a stale path | `include/flatbuffers/flexbuffers.h`, Java `FlexBuffers.java` |
| fresh_f6 | `WhitePaper.md` | `docs/source/white_paper.md`, `internals.md` |

All seven are gap-cohort cases, so control scores do not move:

| Arm | hit@10 original → corrected | MRR original → corrected |
|---|---|---|
| d0 | 15 → 16 | 0.208 → 0.230 |
| d1 | 23 → 27 | 0.299 → 0.355 |
| d2 | 30 → 34 | 0.387 → 0.463 |
| d3 | 7 → 8 | 0.064 → 0.086 |
| d4 | 10 → 11 | 0.158 → 0.179 |

The scorer reproduced the recorded original numbers before any label changed.
Historical oracles that mention these ids (`evals/score.mjs` judge fixtures,
`experiments/repository-vocabulary-2026-10-02.json`) record past runs and were
left unchanged.

## Rejected: diversifying the definition window

Three d2 misses looked like "homonym flooding": the 12-slot alt-terms
definition window filled with same-named methods from other language
runtimes. A simulation over the published symbol registries capped each area
(first two path segments) and backfilled. Owners admitted to the window across
the 46 cases: baseline 29, cap 1 → 24, cap 2 → 27, cap 3 → 30. The single gain
traded one case for another, and FlatBuffers Go `WriteVtable` sits at metadata
BM25 rank 388, beyond any cap. Not implemented.

## Finding: homolog families

Those three "misses" returned correct implementations in a language the label
did not accept. FlatBuffers f4 returned `endTable` in Java, C#, Swift and
Kotlin and Rust's `try_end_table`; f9 returned `CreateSharedString` /
`CreateString` in TypeScript, Python, Go and PHP; fresh_p5 returned Python
`DataFrame.pivot` at rank 4. The labels accept one language chosen from a vague
qualifier ("compiled runtime" = Go, "mobile client" = Swift). In a polyglot
repository a concept question can have a family of homologous owners, one per
area. Whether to widen these labels is an oracle decision and has not been
made.

## Embedder comparison

Question: is the static embedder (Potion) the bottleneck, and would a
contextual code embedder close the gap? Dense-only retrieval over 115,230
symbol units (one per extracted definition) of the three pinned repositories,
cosine top-k, scored with the harness owner rule (path pattern plus symbol
pattern on the unit name). No BM25, no reranker. `potion-code-16M-v2` is
distilled from CodeRankEmbed, so the second row is Potion's own teacher.

| Model | Query | hit@1 | hit@5 | hit@10 | hit@100 | MRR |
|---|---|---|---|---|---|---|
| Potion (static, 16M) | raw | 5 | 12 | 13 | 29 | 0.159 |
| CodeRankEmbed (contextual, 137M) | raw | 6 | 9 | 14 | 30 | 0.174 |
| Potion | raw + alt terms | 9 | 22 | 24 | 41 | 0.322 |
| CodeRankEmbed | raw + alt terms | 18 | 25 | 31 | 38 | 0.463 |

- On raw questions the teacher is no better than the student (14 vs 13
  hit@10). React r1 is outside the top 100 for both. A better embedder does
  not translate "cleanup" into `destroy`.
- With the agent's terms, the contextual model uses them much better (hit@1
  9 → 18, r1 rank 12 → 2).

### Wrong terms: concatenate or fuse

The same dense setup, comparing two ways to combine the agent's terms with
the question: concatenate them into one query, or rank the question and the
terms separately and fuse the two rankings with RRF (k = 60). "Wrong" uses
another question's terms. hit@64 is admission into a window the size of the
rerank window.

| Arm | Potion hit@10 | Potion hit@64 | CodeRankEmbed hit@10 | CodeRankEmbed hit@64 |
|---|---|---|---|---|
| question only | 13 | 26 | 14 | 27 |
| concatenated, own terms | 24 | 39 | 31 | 37 |
| concatenated, wrong terms | 3 | 9 | 4 | 18 |
| RRF(question, own terms) | 22 | 39 | 30 | 36 |
| RRF(question, wrong terms) | 12 | 20 | 9 | 24 |

- With correct terms, fusion matches concatenation at window level (39 vs
  39, 36 vs 37).
- With wrong terms, concatenation loses most owners the question alone found
  (Potion window 26 → 9); fusion loses fewer (26 → 20). Fusion bounds the
  damage but does not remove it: the wrong-terms ranking still takes half of
  every interleaved prefix. Guaranteeing the question's own ranking a fixed
  share of the window would bound it fully.

Satori concatenates in two places: the reranker question
(`buildSearchRerankQuery` appends caller terms) and definition fusion (query
plus alt terms).

A 1.5B code embedder (Qodo-Embed-1-1.5B, a stand-in for API-class models) was
not measured: its remote modeling code fails on the transformers version
CodeRankEmbed requires.

### Terms in the reranker question

The experimental flag `rerank_alt_terms` (default on, the existing behavior)
controls whether caller terms are appended to the LateOn question. Same
harness and settings as the five arms, `definition_alt_terms` on, with
`SATORI_SEARCH_FLAGS=no-rerank_alt_terms`:

| Arm | Alt terms | Terms in reranker question | hit@1 | hit@5 | hit@10 | MRR |
|---|---|---|---|---|---|---|
| d2 | own | yes | 16 | 28 | 34 | 0.463 |
| e2 | own | no | 16 | 23 | 31 | 0.433 |
| d3 | another question's | yes | 1 | 8 | 8 | 0.086 |
| e3 | another question's | no | 7 | 9 | 12 | 0.183 |
| d0 | none | n/a | 8 | 14 | 16 | 0.230 |

Appending terms to the reranker question causes about half of the
wrong-terms damage (8 → 12 of the 16 owners found without terms), and it is
also worth three owners when the terms are right (31 → 34). Turning it off
is a trade, not a fix. The remaining wrong-terms loss (12 vs 16) happens
before reranking: alt-term candidates displace the question's candidates from
the window.

### Rejected: dual rerank and question-slot reservation

Three fixes for wrong-terms damage were tested on the same harness and
labels. None is in the product.

| Arm | Alt terms | Change | hit@1 | hit@5 | hit@10 | MRR | Median | Owner in window |
|---|---|---|---|---|---|---|---|---|
| d2 | own | none (default) | 16 | 28 | 34 | 0.463 | 2.9 s | 38 |
| f2 | own | dual rerank | 16 | 25 | 32 | 0.444 | 5.2 s | — |
| g2 | own | pool reservation | 15 | 27 | 32 | 0.436 | 2.6 s | 37 |
| d3 | another question's | none (default) | 1 | 8 | 8 | 0.086 | 2.8 s | 19 |
| f3 | another question's | dual rerank | 6 | 9 | 11 | 0.152 | 4.6 s | 20 |
| g3 | another question's | pool reservation | 2 | 8 | 8 | 0.097 | 2.6 s | 19 |
| h3 | another question's | pool reservation + dual rerank | 5 | 9 | 12 | 0.144 | 4.6 s | 20 |

- **Dual rerank** reranked the window with the question alone and with
  question plus terms, then fused the two rankings with RRF (k = 60). With
  wrong terms it recovers less than dropping terms from the reranker
  question (e3: 12), and it costs two owners with own terms plus about 2 s
  per request. Both rankings cover the same window, so RRF averages two
  orders instead of taking a union of candidates.
- **Pool reservation** stopped counting `symbol_metadata_bm25_alt` as a
  primary pass in `isPrimarySearchCandidate`, so alt-term metadata hits
  compete only for the expansion share of the 80-candidate pool. Wrong-terms
  window admission is unchanged (19) and own terms lose two owners. Adding
  dual rerank on top (h3) reaches 12, the same as e3 at 1.8 s more. With it,
  five of the six owners that wrong terms push out of the window return to
  the pool, but at fused ranks 59 to 78. Example: f3_rewritten's owner
  (`python/flatbuffers/builder.py` `StartVector`) is primary rank 36, fused
  rank 48 with no terms and 73 with wrong terms. With two equal passes, RRF
  interleaves them, so the question's list gets about half of the window.
- **Window reservation** (guarantee the top K primary-pass candidates a
  window slot, fill the rest in fused order) was simulated on the saved
  `fused-pool.json` traces before building. With K = 0 the simulation
  matches the real windows within one case per arm. It ignores family
  grouping in `selectRerankCandidates`.

  | K | own (d2 traces) | wrong (d3 traces) | own + pool reservation (g2) | wrong + pool reservation (g3) |
  |---|---|---|---|---|
  | 0 | 39 | 19 | 38 | 20 |
  | 32 | 39 | 20 | 38 | 20 |
  | 40 | 38 | 20 | 38 | 22 |
  | 48 | 37 | 20 | 36 | 23 |
  | 56 | 37 | 21 | 36 | 24 |

  The best case adds two or three window admissions with wrong terms. It
  depends on pool reservation, which costs two top-10 owners with own terms,
  and window admission with wrong terms converts poorly (19 admitted, 8 in
  the top 10). Not built.

## Remaining d2 misses

- Translation: fresh_p3 (agent guessed CSV; owner is the NDJSON reader),
  fresh_r5 (terms found the reconciler hook; DevTools `attach` at rank 17).
- Routing: fresh_r4 ("bit flags" routes to the configuration focus and skips
  definition discovery); fresh_f6 (documentation focus gates definition
  discovery off by design).
- Ranking: p3_rewritten (admitted, rank 20).
- Homolog families: f4, f9, fresh_p5 (above).

## Limits

- Wrong alt terms cost more than sending none (8 vs 16 in the top 10). About
  half comes from the reranker question and the rest from window admission
  through RRF interleaving. The tested fixes (above) trade own-terms quality
  for a partial recovery, so the default accepts this cost; callers can turn
  off `definition_alt_terms` or `rerank_alt_terms` per request.
- One alt-term generator, one tuning set, no held-out run.
