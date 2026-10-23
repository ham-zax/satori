# S1 declaration-evidence experiment, 23 October 2026

Reject name-priority as an unconditional replacement for supplementation's
current ordering. With trial role normalization, it admits the S1 handler.
It also removes an accepted React state-update owner from the supplement
under both tokenizers. No production policy changes.

## Fixed comparison

The [plan](s1-owner-discovery-plan-2026-10-23.md) selects one intervention:
sort by declaration-name matches before total matches. Shipped ordering uses
total matches before declaration-name matches. Both retain source-line order
as the final tie breaker.

Total matches combine symbol-name terms and the complete source span,
including declarations and comments. They are not independent body-only
evidence. Calling the shipped order "body-first" can obscure that distinction.

Cross both orders with the exact shipped tokenizer and the previous trial
role tokenizer. The role stem function remains unchanged. Preserve eligibility,
file selection, source authority, and all limits, including six symbols per file.
The role tokenizer remains an unaccepted experimental prerequisite.

## Inputs and checks

S1 uses the original query, frozen publication, and `mcp_fusion` pool from the
[normalization experiment](s1-normalization-experiment-2026-10-23.md).
The replay reproduces the shipped supplement's selected files and complete
return order. It also reproduces the role/total target rank of 17 among 37.

External controls use seven unchanged React queries and acceptable-owner sets
from `evals/real-repo-quality/cases.json`: `r1`–`r5`, `r8`, and `r9`.
The React checkout is `7c6ac13e19fef500b7f669a16bbd01ecc95965ca`.
Three new source controls use FlatBuffers `ts/builder.ts` at
`b8431fbcd7a5c71817f314e18b332c0648554efa`: `endObject`, `finish`, and
`createString`. Their queries and source responsibilities are frozen before
measurement. The established evaluation oracle remains unchanged.

These controls deliberately supply implementation files. Production extraction
and hash checks then supply symbol identities and spans. This is oracle-assisted
file supplementation, not retrieval evaluation. Production Flow recovery
reports `recovered` with intact target declarations. No control is unscorable.
The pinned source files have no local changes.

Within each tokenizer, both ordering arms preserve selected/read files,
source hashes, eligible owner sets, and per-owner scores. Returned symbols
equal the first six entries under the corresponding order. All 738 returned
rows match registry owner identities, paths, and spans.

The single-concept controls include both `handler` and `handlers` together.
They normalize to one concept and return no symbols without source reads.
Injected source-hash mismatches return no symbols in all four variants.

## S1 results

| Tokenizer and order | Target rank within file | Target supplemented | Position in supplement output |
|---|---:|---|---:|
| Shipped tokenizer, total first | Ineligible | No | — |
| Shipped tokenizer, name first | Ineligible | No | — |
| Trial role tokenizer, total first | 17 of 37 | No | — |
| Trial role tokenizer, name first | 4 of 37 | Yes | 12 |

The name-first result does not establish a grouped top-ten result. Position 12
belongs to the combined supplement output. No reranker or final grouping runs.

## External controls

Positions below refer only to supplement output. Each cell compares total-first
with name-first ordering under one fixed tokenizer. A dash means no acceptable
symbol appears in that supplement output.

| Case | Shipped tokenizer | Trial role tokenizer | Observation |
|---|---|---|---|
| React cleanup `r1` | — → — | — → — | No recovery under either order |
| React state update `r2` | 7 → — | 10 → — | Acceptable owner loses admission |
| React dependencies `r3` | 1 → 1 | 2 → 2 | Same position |
| React missing key `r4` | 12 → 12 | 12 → 12 | Same position |
| React passive effects `r5` | 19 → 20 | 19 → 20 | Later position |
| React unchanged props `r8` | 23 → 21 | 22 → 21 | Earlier position |
| React invalid hook `r9` | 8 → 8 | 8 → 8 | Same position |
| FlatBuffers object completion | — → — | — → — | No recovery under either order |
| FlatBuffers buffer finalization | 1 → 1 | 1 → 1 | Same position |
| FlatBuffers string encoding | 1 → 1 | 1 → 1 | Same position |

There are ten unique external cases and twenty tokenizer-paired comparisons.
They produce zero admission gains and two admission losses, both for React
`r2`. Two positions improve, two worsen, ten stay the same with an admitted
owner, and four comparisons recover no owner under either order.

An ineligible target is not an extraction failure. React cleanup and FlatBuffers
object completion remain below the two-concept threshold in these probes.
Changing the comparator cannot recover an ineligible symbol.

## Decision and limits

The result rejects a global name-priority replacement at this boundary.
It does not prove that full React search loses the owner, because other
retrieval arms might already supply it. It demonstrates a repeatable loss
in the supplementation behavior this experiment changes.

Do not combine the S1 gain with a new score weight, larger cap, or special
identifier rule to conceal that loss. Do not ship the trial tokenizer from
this result. Any next mechanism must distinguish requested ownership roles
while retaining source-backed owners whose names share few query terms.
Structural evidence remains a separate hypothesis with its own deciding test.

No LateOn request, graph expansion, final fusion, grouped Hit@10, 72-query
benchmark, or latency comparison runs here. This diagnostic cohort cannot
establish general ranking quality. S1 remains open.

## Reproduction and artifacts

- [Experiment script](../../evals/code-intelligence-vs/s1-declaration-evidence-experiment.mjs)
- [Frozen cases](../../evals/code-intelligence-vs/fixtures/s1-declaration-evidence-cases.json)
- [Independent replay result](../../evals/code-intelligence-vs/fixtures/s1-declaration-evidence-result.json)

The pinned checkouts and S1 publication must exist locally. The output file
must be new. Script, fixture, source, checkout, and publication identities
are recorded and checked again after execution.

```bash
node --check evals/code-intelligence-vs/s1-declaration-evidence-experiment.mjs
node --import tsx evals/code-intelligence-vs/s1-declaration-evidence-experiment.mjs \
  --out /tmp/s1-declaration-replay.json > /tmp/s1-declaration-replay.log
```

DeepSeek V4.1 Flash runs the implementation through Claive. MiniMax is absent
from the provider catalog and returns HTTP 400 on both attempts. The user
authorizes the subsequent Codex review fallback. The parent relays findings
when peer delivery fails, then runs the final experiment independently.
Workers use default tools without added step or time caps.

Review catches inconsistent variant keys, an external-file hash lookup using
the wrong checkout, and an alias control that initially supplies only one form.
The corrected run checks all three. The verdict also separates admission losses
from position changes and rejects the rule when an accepted owner disappears.
Status `ok` means the experiment checks pass, not that the proposed repair works.
The parent's independent CLI run exits zero. Syntax, recorded hashes, and
81 documentation links pass their checks. The earlier staged patch remains
unchanged, and no production package or existing harness script gains edits.

For future experiment reviews, check canonical variant names and source-root
lookups before collecting the full output. Inspect the actual negative-control
terms, not only their labels. Archive results only after source hashes and
the independent run agree. These are process lessons, not new product or CI policy.
