# S1 graph evidence experiment, 23 October 2026

The real Satori call path survives production sidecar write/read after the
staged S2 repairs. Graph labels improve LateOn rank but leave fusion rank 16.
The comparison does not establish a sufficient S1 repair. No production
ranking policy changes, managed reindex, or release occurs in this experiment.

## Foundation

The [plan](s1-owner-discovery-plan-2026-10-23.md) requires real call proof before
testing graph-based ownership evidence. The runner reads the retained
publication's TypeScript file set, then extracts current source with production
services and the current extractor. It builds a fresh registry, uses the
production TypeScript semantic provider, and writes and reads both sidecars.
All output belongs to a task directory. No managed publication pointer changes.

| Measurement | Initial TypeScript check | Expanded replay foundation |
|---|---:|---:|
| Selected and analyzed files | 692 | 695 |
| TypeScript files | 692 | 692 |
| Files with complete structural extraction | 692 | 693 |
| Symbols in the fresh registry | 15,043 | 15,071 |
| TypeScript semantic resolution claims | 70,568 | 70,568 |
| Admitted relationships | 23,728 | 23,749 |
| Admitted CALLS records | 19,062 | 19,081 |
| CALLS records with proof-backed authority | 19,062 | 19,062 |
| Registry and relationship read warnings | 0 | 0 |

The expanded foundation also extracts the fixed replay window's two JSON files
and one JavaScript file. Production extraction reports unsupported structural
analysis for JSON. Their real file identities remain available for projection.
The semantic provider's complete coverage applies to the 692 TypeScript files.
The additional JavaScript relationships do not acquire invented proof authority.

Provider coverage is `complete`. That means the provider analyzes the selected
files. It does not mean every call resolves. Source hashes match the retained
manifest for all selected files and remain unchanged during the run. The runner
also checks source-control inputs and its own bytes after execution.

Both required edges appear in the read-back relationship sidecar, with exact
source and target instance identities and retained resolved claims:

| Caller | Callee | Authority |
|---|---|---|
| `searchCodebaseTool.execute` | `ToolHandlers.handleSearchCode` | `direct_binding` |
| `ToolHandlers.handleSearchCode` | `SearchRequestCoordinator.attempt` | `direct_binding` |

The parent independently reads both sidecars and checks those exact edges,
their registry identities, and the retained resolved claims. This establishes
the measured path, not complete graph correctness or full search acceptance.

## Fan-out and serialized context

The entrypoint has 35 call sites inside its source span. The provider resolves
27, leaves seven unresolved, and marks one ambiguous. Six unresolved sites have
`unsupported` authority. The 27 admitted calls reach 19 distinct targets.
Eight calls repeat a target. That difference does not establish duplicate
records for the same call site.

The current three-callee context for `searchCodebaseTool.execute` contains:

1. `classifyVectorBackendError` in `core/backend-diagnostics.ts`.
2. `getDefaultSearchLimit` in `core/capabilities.ts`.
3. `handleSearchCode` in `core/handlers.ts`.

The earlier prediction that lexicographic truncation removes the handler is
false for this measured graph. The internal relationship index retains all
admitted edges. The document projection applies its separate three-callee cap.

The handler's context contains caller label `method execute` from
`tools/search_codebase.ts` and callee label `method attempt` from
`core/search-request-coordinator.ts`. The labels omit qualified container names.
Whether these labels improve learned similarity requires a real model run.

## Ranking comparison

The already-admitted control window fixes all 64 identities, source spans,
query, caller terms, and candidate count. It contains 45 persisted Lance chunks
and 19 candidates reconstructed from exact captured source spans. All owners
map uniquely by stable key, file hash, and full owner span into the task registry.
Raw Lance owner metadata does not override the captured resolved owner.

The comparison uses the unchanged v5 document producer, actual installed LateOn
model, contextV6D128 profile, and unmodified production definition fusion.
Caller terms remain `search code handler`, as captured in the admitted control.
This is not the original no-alternate-terms search request.

| Context arm | Handler provider rank | Handler fusion rank |
|---|---:|---:|
| Empty on every candidate | 58 | 16 |
| Present only on the handler | 52 | 16 |
| Present on every candidate | 53 | 16 |
| Empty-context repeat | 58 | 16 |

Every packet outside the handler remains byte-identical in the handler-only
arm. No non-structural packet field changes in either context arm. Existing
document and total byte budgets remain intact. The empty repeat reproduces
provider scores and fusion ordering exactly. All 3,948 recorded input hashes
remain unchanged. The runner closes its model and vector resources.

The labels improve the handler's provider rank by six positions in isolation.
Changing all candidates reduces that gain to five positions. Neither change
alters the handler's fusion rank. Reject serialized labels alone as a sufficient
repair for the measured post-rerank loss. The result does not reject direct
graph evidence in admission or definition fusion, because neither policy changes.

This is controlled admission. The experiment cannot establish automatic graph
admission, grouped top-ten acceptance, or external-query non-regression.

## Reproduction and provenance

```bash
node --check evals/code-intelligence-vs/s1-graph-foundation-experiment.mjs
node --max-old-space-size=8192 --import tsx evals/code-intelligence-vs/s1-graph-foundation-experiment.mjs \
  --out /tmp/s1-graph-foundation.json \
  --artifacts-dir /tmp/s1-graph-foundation-artifacts
node --check evals/code-intelligence-vs/s1-graph-ranking-experiment.mjs
node --import tsx evals/code-intelligence-vs/s1-graph-ranking-experiment.mjs \
  --foundation /tmp/s1-graph-foundation.json \
  --out /tmp/s1-graph-ranking.json
```

Both output paths must be fresh. The archived
[foundation result](../../evals/code-intelligence-vs/fixtures/s1-graph-foundation-result.json)
contains complete edge claims, source hashes, source-control hashes, coverage,
and original scratch paths. Those paths identify this run, not permanent state.
The reproduction command creates its own artifacts. This is an artifact
roundtrip, not a sealed publication with vectors. The expanded
[replay foundation](../../evals/code-intelligence-vs/fixtures/s1-graph-replay-foundation-result.json)
records the 695-file run. Its first attempt reaches Node's default heap ceiling.
The rerun raises that process ceiling to 8 GiB and passes without changing
Satori's resource policy.

DeepSeek runs through Claive as worker `2a5ced704d90`. Its first runner fails
in the fan-out report due to a function-scope error. Parent review also requires
edge assertions to use read-back objects and source-span call counts.
The corrected run passes with exit zero. The parent independently checks it.
The first ranking request returns a provider quota error. Its retry produces
a runner whose first failure masks its diagnostic output. The next run reports
the setup mismatch: the fixed window includes three non-TypeScript files absent
from the task registry. DeepSeek preserves the diagnostic and stops.

The parent selected too narrow a registry file set. The corrected design adds
all files referenced by the fixed window through current production extraction.
It preserves all 64 candidates and requires exact owner mapping. The authorized
Sol 6.1 medium fallback runs through Claive as worker `f78869048a83`.
The fallback repairs source-derived reconstruction, emitted JSON field names,
and the ESM file context used to compare source transpilation with built workers.
The final worker and encoder comparisons match exactly. No runtime build occurs.
The final model comparison passes with exit zero. Complete scores, orders,
packet hashes, runtime identities, and input hashes are archived in the
[ranking result](../../evals/code-intelligence-vs/fixtures/s1-graph-ranking-result.json).
The parent independently runs the same four model passes. Every provider score,
provider order, fusion order, and document-set hash matches the worker result.
The [parent check](../../evals/code-intelligence-vs/fixtures/s1-graph-parent-check.json)
records that comparison and the raw result hashes. No model, analyzer, or task
worker remains active after verification.
Claive refuses to attach verification to its frozen worker snapshot after
parent documentation and archive changes. The parent rejects that stale record.
Fresh independent parent checks cover the final scripts and measured result.

Initial foundation script SHA-256:
`d8be202896f571c87838885e8718aeef77820a84c6e86969e0a2a6afb39dfad0`.
Initial archived result SHA-256:
`61906bc80cee4fc6cfce835933df38c5ac3f0da8c0cf66214ab720eeb91e3a4d`.

Expanded foundation script SHA-256:
`d95123ff17166b04ea68f6d348d2799beced403dde8cd5316346de7d2ef50852`.
Expanded result SHA-256:
`f0faa6778f173916617dbf1cc336c99595ddf71193c497f1a18ea7aee4945f5a`.

Ranking script SHA-256:
`608accc661f919bcb2a595322ac2537585e7b32789560f4c1d6bf46140c56b73`.
Ranking result SHA-256:
`f5f8f03042b8b1ca9d45a62c91c769f9c27700db57a2f24c58fff7b43bba9727`.

## Brief retrospective

The parent initially omitted three replay languages from the foundation.
The resulting registry could prove the call path but could not support the
full frozen window. Proposed workflow change: check every captured descriptor
against the selected file set before starting semantic extraction.

Broad worker API reading delayed execution. Independent runner implementations
also mishandled source-derived candidates, serialized field names, and module
context. Proposed workflow change: include one real candidate of each origin
and the exact existing reconstruction reference in the initial executable brief.
These are workflow proposals. They add no product behavior or new test gate.
