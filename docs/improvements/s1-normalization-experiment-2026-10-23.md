# S1 normalization replay, 23 October 2026

Normalization alone does not fix S1. The tested rules improve metadata rank
and definition fusion, but neither admits the target through the existing
bounded retrieval lanes.

## Inputs and method

The replay reads publication `330c18e2-af44-4491-a85a-6af3d468c5ae`.
Its registry contains 23,754 symbols across 1,249 files. The metadata corpus
contains 22,505 named non-file symbols. The production runtime predicate
accepts 21,275 of them. Runtime scope still includes test paths.

The query is unchanged:

```text
search_codebase grouped result handler freshness warnings next actions
```

The [script](../../evals/code-intelligence-vs/s1-normalization-experiment.mjs)
loads the production BM25, supplementation, and definition-fusion functions.
It changes tokenization only in temporary experiment copies. It preserves
the production formula, sorting, file selection, source checks, and budgets.
Those copies are removed after execution. Production source remains unchanged.

The frozen capture contains 171 candidate identities. The replay reads 146
persisted Lance rows and reconstructs 25 source-derived candidates from
captured spans and exact published owner identities. No persisted row is
missing. It uses `mcp_fusion`, with 124 candidates, as supplementation input.
`mcp_filtered` comes after supplementation and cannot supply that input.

The two captured rerank windows contain 64 candidates each. One comes from
the original request. The other uses `alt_terms: ["search code handler"]`.
The replay preserves that difference, original input positions, and provider
ranks. Both baseline fusion orders reproduce exactly before any ablation.

## Trial tokenizers

Baseline uses the shipped functions without changes. Plural-additive preserves
metadata tokens and adds namespaced plural stems. Role-additive also removes
the trial `ing`, `ed`, `er`, `or`, and final `e` suffixes under fixed length
rules. The script records the exact rules. It adds no S1-specific exception.

Supplementation uses one canonical term per lexical concept, rather than
counting an exact token and its alias twice. The single-term `search` control
returns no symbols and reads no files in every variant.

These rules are experimental suffix rules, not an established English stemmer.
Additive metadata terms change BM25 document lengths and IDF. Preserving exact
tokens does not guarantee that exact matches outrank stem matches.

## Results

| Measurement | Baseline | Plural-additive | Role-additive |
|---|---:|---:|---:|
| Target metadata rank, all symbols | 1,835 | 728 | 678 |
| Target metadata rank, runtime predicate | 1,792 | 715 | 663 |
| Target metadata rank, package source excluding tests | 824 | 367 | 355 |
| Matching symbols, package diagnostic filter | 1,386 | 1,667 | 1,693 |
| Supplement reads `handlers.ts` | No | No | Yes |
| Target matches under supplement tokenizer | 1 | 1 | 2 |
| Target rank before the six-symbol cut | Ineligible | Ineligible | 17 of 37 |
| Supplement admits target | No | No | No |
| Total symbols returned across selected files | 20 | 20 | 26 |
| Target fusion rank, already-admitted control | 16 | 13 | 13 |
| Target enters original window through fusion | No | No | No |

Metadata admission allows twelve symbols. Even role-additive leaves the target
at runtime metadata rank 663. The earlier diagnostic rank 824 of 1,386
reproduces exactly under the separately labelled package-source filter.
That filter is narrower than the actual request predicate.

Baseline supplementation does not select `handlers.ts`. Role normalization
selects and reads it, accepts its source hash, and gives the target two term
matches. The existing ordering places the eligible target 17th among 37
symbols, then returns six other symbols. It ranks body-term coverage before
declaration-name coverage. The first symbol matches six terms in its body
and zero in its name. The target matches two terms, both in its name.
Passing the lexical threshold therefore does not establish admission.

Frozen-window fusion improves from 16 to 13. Those are fusion ranks before
implementation preference and grouping. They are not grouped ranks or an
end-to-end result. The original window still lacks the target in every variant.

## Controls and limits

The role rules join `handler/handle/handlers`, `group/grouped/grouping`, and
`coordinator/coordinate`. They also join `server/serve` and `buffer/buff`.
The plural-only rules leave `buses` as `buse` and `statuses` as `statuse`.
The short `user/use` pair remains different under the chosen length guards.
These controls show why a suffix list is not a proven general search policy.

The replay changes neither dense nor lexical vector-store retrieval. It makes
no new model request, builds no index, and changes no query/document contract.
It does not test graph admission, variable-definition eligibility, named
adapter preference, the five-task benchmark, or the 72-query evaluation.
No general quality gain or latency improvement follows from these results.

The dataset already informed the diagnosis. It is not held-out evidence.

## Decision

Reject the tested normalization variants as sufficient repairs. Do not ship
them from this experiment. The review's predicted top-twelve admission and
successful file-symbol recovery do not occur.

The [declaration-evidence replay](s1-declaration-evidence-experiment-2026-10-23.md)
subsequently tests name priority with the same six-symbol cap. It admits S1
under trial role normalization but removes an accepted React state-update owner
from supplementation under both tokenizers. Reject that unconditional replacement.
Graph admission and structural fusion remain separate, unproven alternatives.
The [revised plan](s1-owner-discovery-plan-2026-10-23.md) owns the remaining boundary.

## Reproduction

The archived trace and result are in `evals/code-intelligence-vs/fixtures/`.
The publication must still exist locally. The script refuses a publication
mismatch, source-hash drift, truncated capture, or invalid candidate identity.
It refuses to overwrite an existing output file.

```bash
node --import tsx evals/code-intelligence-vs/s1-normalization-experiment.mjs \
  --navigation-root /home/hamza/.satori/publications/f0595d90c4bd7dcbb53a1045d868ba457f99f442c32dba041ff3bda12ab365d6/generations/330c18e2-af44-4491-a85a-6af3d468c5ae/navigation \
  --out /tmp/s1-normalization-replay.json
```

The result records script, fixture, source, and manifest hashes. Check the
recorded source identities before comparing a later run. Status `ok` means
that the replay checks pass. It does not mean that S1 is fixed.

## Checks and process lessons

Claive Sol 6.1 medium implements the replay. The parent checks the script and
runs it independently to produce the archived result. `node --check` and
`git diff --check` pass. Both captured fusion orders match exactly. The staged
patch checksum remains unchanged. No product source or installed runtime changes.

The first attempt assumes every candidate has a persisted vector row and
stops without a result. The initial brief also names the post-supplement stage.
Both errors cost correction work. Future replay briefs must inspect candidate
kinds and identify the exact input stage before implementation. The final
fixture and replay preserve both checks. No global rule or CI change is proposed.
