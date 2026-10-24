# Definition-fusion inflection fallback, 24 October 2026

Status: implemented. Focused tests pass. One 28-query differential run moves f7
from absent to rank 10 without changing another scored rank.

## Problem

Definition fusion adds a symbol-name vote to the reranker order. The vote uses
exact metadata tokens. It cannot relate an inflected query word to the
declaration it names.

The f7 probe is the measured case:

| Stage | `ParseAnyValue` rank |
|---|---:|
| Dense retrieval | 2 |
| Provider reranker | 37 |
| Definition fusion | 53 |
| Final disclosure | absent |

The query ends with `parsing`. The owner metadata is `ParseAnyValue`,
`flatbuffers.Parser.ParseAnyValue`, and `src/idl_parser.cpp`. The tokenizer
splits camel case, but it does not stem. `parsing` does not equal `parse` or
`parser`. The owner therefore receives no definition vote. It keeps only its
provider vote, `1 / (60 + 37) = 0.01031`.

Fifteen candidates behind it match `union`, `type`, or `flatc` in their name or
path. Each gains a second vote of up to `1 / (60 + 1) = 0.01639`. They pass the
owner. `SupportsUnionUnderlyingType` moves from provider 6 to rank 1, and
`add_union_type` from provider 38 to rank 9.

The word form decides the outcome. Replaying the same fusion over the same 92
candidates gives:

| Query text | `ParseAnyValue` rank |
|---|---:|
| `...resolve a union type when parsing` | 52 |
| `...resolve a union type when parse` | 10 |
| `...resolve a union type when parser` | 15 |
| `...resolve a union type` | 52 |

The reconstruction reproduces the recorded top six exactly and the recorded
target within one place. The difference comes from rebuilding `qualifiedName`
from breadcrumbs.

Definition fusion is not the original cause of the miss. The reranker moved the
owner from dense rank 2 to provider rank 37. Fusion is the only stage that
could rescue it, and the token gap blocked that rescue.

## Intent

Let definition fusion see the base form of an inflected query word without
changing document metadata, BM25 weights, the index, or the reranker.

## Rule

`inflectedBaseTerm` in `packages/mcp/src/core/search-definition-discovery.ts`:

- Applies only to query tokens of at least five characters that end in `ing`.
- Derives the base form, drops a doubled final consonant, then prefers
  `stem + "e"` and falls back to `stem`.
- Adds at most one base term.
- Adds it only when the exact query token has zero documents in the current
  rerank window. Exact matches keep priority, and the rule cannot invent a base
  that no candidate carries.

The document side is unchanged. Symbol metadata, the shared tokenizer, and the
`symbol_metadata_bm25` flag keep their existing meaning. No index rebuild and
no embedding change are needed.

## Verification

Focused tests: `packages/mcp/src/core/search-definition-discovery.test.ts`
passes 10 of 10. Three tests are new:

- An inflected query term reaches its declaration when the exact token is
  absent.
- An exact query token keeps its own vote and does not trigger the fallback.
- A doubled consonant and a silent `e` resolve to the document base.

Differential run: 28 queries, `react`, `polars`, and `flatbuffers`, the same
Publication at workspace `07ab8334`, `--reuse-index`, no `alt_terms`.

| Metric | Before | After |
|---|---:|---:|
| hit@1 | 13 | 13 |
| hit@5 | 21 | 21 |
| hit@10 | 22 | 23 |
| strict hit@10 | 22 | 23 |
| MRR@10 | 0.5509 | 0.5545 |
| strict MRR@10 | 0.5509 | 0.5545 |

Only f7 changes: rank absent to 10, strict absent to 10. The final f7 top 10 is
`IsUnionType`, `SupportsUnionUnderlyingType`, `addUnionType`,
`UnionTypeFieldSuffix`, `add_union_type`, `EnumValAddUnionType`,
`ParseTypeIdent`, `IsUnionType`, `VerifyUnion`, and `ParseAnyValue`.

Median total query time was 3531 ms against 3676 ms before. This is one
unpaired run on one host, with one 17 s cold outlier in the mean. It is not a
speed claim.

Command:

```bash
node evals/real-repo-quality/run.mjs \
  --repos react,polars,flatbuffers \
  --state-root /tmp/satori-full-20261024/state \
  --out /tmp/satori-inflection-20261024/out \
  --reuse-index
```

Artifacts are in `/tmp/satori-inflection-20261024/out`. The Publication
directories in the reused state were not rebuilt.

## Limits

- The rule handles English `ing` inflection only. Other inflections remain
  exact-token matches.
- It does not repair the reranker demotion from dense rank 2 to provider rank
  37. It restores the fusion vote that the demotion made decisive.
- The comparison is one run, one Publication, and one host.
- The base-form check depends on candidates in the current rerank window. A
  base form that exists only outside that window is not considered.

## Files

- `packages/mcp/src/core/search-definition-discovery.ts`
- `packages/mcp/src/core/search-definition-discovery.test.ts`
