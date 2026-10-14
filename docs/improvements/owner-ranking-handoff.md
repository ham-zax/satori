# Owner ranking: handoff for an independent agent

Written 2026-10-14 on `master` at `224183ca`. Status: open investigation.

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
   the tool description now tells callers to use it (uncommitted, see
   [State of the tree](#state-of-the-tree)).
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
| Soften definition fusion for LateOn: rank candidates with no name match as tied last instead of scoring them zero | Not run; fusion's downward moves cost 0.042 MRR without caller terms and 0.074 with; see the results log |
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
  moves. Not run: unmatched candidates tied last instead of zero. Script
  `fusion-moves.mjs`.
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

- Uncommitted product change: one sentence added to the `search_codebase`
  tool description telling callers to pass `alt_terms` for plain-English
  questions (`packages/mcp/src/tools/search_codebase.ts`). Typecheck, the
  tool-reference and manifest checks and `src/tools/registry.test.ts` pass.
- The MCP server instructions (`SATORI_MCP_INSTRUCTIONS`,
  `packages/mcp/src/server/shared-runtime.ts`) do not mention `alt_terms`.
  Not changed; reported here.
- Local captures and scripts on the original machine are listed under
  "Resuming this work" in the checkpoint. One scratch directory named there
  holds an API key file. Never read, print or copy it.
