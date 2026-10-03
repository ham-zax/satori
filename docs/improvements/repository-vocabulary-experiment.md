# Repository vocabulary experiment

Recorded 2026-10-02. The index is implemented; search expansion is experimental
and **off by default** (`repo_vocab: false`). This experiment did not improve
overall retrieval quality or achieve 11/11. Retain it as measured evidence,
not as a successful semantic retrieval fix.

The [complete results](../../evals/real-repo-quality/experiments/repository-vocabulary-2026-10-02.json)
contain every query, returned symbol, emitted alias, vocabulary provenance,
sample score, latency sample, publication identity, runtime/oracle digest,
model configuration, and machine-load observation.

## Implementation retained

- Extract actual words from symbol identifiers, source, and nearby comments;
  use resolved caller/callee and parent evidence for local context. Identifier
  terms must occur on their recorded source line. Synthetic callback labels
  and enclosing test titles are not identifier evidence.
- Write a dictionary-encoded vocabulary artifact inside staged navigation
  before publication. Bind it to the publication and symbol/relationship
  manifests; retain file hashes, source lines, and link provenance.
- Keep lookup in a dedicated vocabulary service. Cache by repository and
  immutable publication address under the existing read-admission contract;
  generation changes select a different entry. Returned evidence cannot
  mutate cached provenance.
- Bound document counts, terms, file size, and lookup results. Missing,
  incompatible, corrupt, or oversized vocabulary falls back to ordinary
  search. Existing indexes do not require a global extractor-version bump.
- Restrict automatic aliases to conceptual/mixed routes and the accepted
  repository scope. Caller-provided `alt_terms` takes precedence. Explicit
  `flags: { repo_vocab: true }` enables the experiment.

Vocabulary indexing is now **off by default** too. Start the indexer with
`SATORI_REPOSITORY_VOCABULARY_INDEX=1` and fully reindex to opt in. The policy
is captured once by the indexing pipeline and shared with full and incremental
navigation publication. Without the opt-in, source vocabulary is not extracted
and no vocabulary artifact is built, encoded, hashed, or written. Search's
`repo_vocab` flag alone does not enable indexing.

The initial experiment built the artifact unconditionally; that behavior was
removed after the user raised the indexing-cost concern. Historical artifacts
and evidence already present in immutable publications are preserved and follow
ordinary publication retention. New default indexing adds no vocabulary
metadata or artifact, regardless of repository size. Legacy indexes remain valid.

The opt-in experiment's 100,000-document and 64 MiB limits bound the returned
artifact, not peak construction work: relationship filtering/sorting precedes
the document limit, and byte rejection follows encoding/serialization. These
are known limitations of explicitly enabled indexing, not costs incurred by
the default-off path. No claim of bounded peak memory for the opt-in builder
or measured end-to-end indexing-speed equivalence is established here.

React's final artifact contains 63,586 documents in 36,073,357 bytes. The first
object-encoded attempt exceeded the 64 MiB artifact budget and produced no
usable vocabulary; dictionary encoding fixed that capacity failure.

## Measured quality

Pinned inputs:

| Repository | Commit | Queries | MRR@3 off | MRR@3 on | Top-three successes off → on |
|---|---|---:|---:|---:|---:|
| React | `7c6ac13e19fef500b7f669a16bbd01ecc95965ca` | 15 | 0.1556 | 0.1333 | 3 → 3 |
| Polars | `74dd736d655cc3c7a70857d859030d957deba7ac` | 15 | 0.2333 | 0.0000 | 4 → 0 |
| FlatBuffers | `b8431fbcd7a5c71817f314e18b332c0648554efa` | 16 | 0.0625 | 0.0833 | 1 → 2 |

| Case set | Queries | MRR@3 off | MRR@3 on | Top-three successes off → on |
|---|---:|---:|---:|---:|
| Previously selected difficult cases | 11 | 0.0303 | 0.0455 | 1 → 1 |
| Other cases used to detect regressions | 35 | 0.1857 | 0.0810 | 7 → 4 |
| All cases | 46 | 0.1486 | 0.0725 | 8 → 5 |

Scores use the existing strict acceptable-owner oracle in
`evals/real-repo-quality/conceptual-cases.json`, with limit 3. Selected cases
were run three times per arm in alternating order; other cases had one paired
run. MRR averages the per-case reciprocal-rank samples. There was no observed
rank variation in these runs. No caller `alt_terms` were supplied. Both arms
used the same publication for each repository.

Both arms explicitly set all search flags: `compound_join` and
`path_demotion` on; `dealias`, `focus_cue_wide`, `prf`, and `rerank_blend` off.
Only `repo_vocab` differed between arms.

Runtime: Potion code 16M v2, revision
`e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b`, 256 dimensions; LateOn-Code-edge,
revision `07ef20f406c86badca122464808f4cac2f6e4b25`, using
`lateon_offline_quality_projection_v6_d128_v1` and
`lateon_context_v6_d128_owner_default_v1`.

These are diagnostic cases, including previously studied cases, not a blind
generalization benchmark. The measurements were made during development on
base `1bbf2646`; the recorded runtime digest identifies the tested compiled
files. The final default was subsequently changed to off. Both measured arms
explicitly supplied the flag, so they did not depend on its default.

An intermediate run reused an earlier React publication. Those React results
were excluded and replaced by a fresh run, publication
`0451598d-f274-49c7-b266-16eae53167c2`. The fresh run also checked all 154,776
identifier terms against their source lines. The reproduction script always
creates fresh state and does not support resuming earlier indexes.

## Findings and decision

Observed gains: React `r3_rewritten` moved from rank 3 to 2; FlatBuffers
`f8_rewritten` became rank 1 and `fresh_f5` became rank 3. The React cleanup
case `r1` still missed, as did `r8` and `fresh_r1`.

Observed regressions: React `r5_rewritten` moved from rank 1 to 2. Polars
`p4_rewritten`, `p6_rewritten`, `p9_rewritten`, and `fresh_p2`, plus FlatBuffers
`fresh_f1`, lost previously successful top-three owner results. Emitted aliases
include real test-function identifiers that match query words without owning
the requested behavior.

The leading explanation is that word overlap and call adjacency are weak
proxies for intent. Appending nominated identifiers to both candidate
retrieval and the reranker query can steer both toward a distractor. The
combined experiment establishes the quality regression; it does not isolate
each phase's contribution. Provenance establishes a term's origin, not its
semantic usefulness. Do not describe the small selected-case MRR gain as an
overall improvement or a learned cleanup/destroy equivalence.

Keep expansion off. Any future replacement needs measured owner-retrieval
gains while preserving already successful cases before changing that default.
Latency samples and process memory/load observations are retained, but no
speedup or indexing-overhead claim is established by this experiment.

## Reproduction and verification

Requires the offline runtime, the pinned clean repositories in
`~/.cache/satori-eval-repos/<name>@<commit>`, and current local build output.
The normal real-repository harness populates that repository cache.

```sh
node node_modules/typescript7/bin/tsc --build packages/cli --force
SATORI_REPOSITORY_VOCABULARY_INDEX=1 VOCABULARY_EVAL_OUTPUT=/tmp/satori-vocabulary-ablation.json node evals/real-repo-quality/vocabulary-ablation.mjs
```

`VOCABULARY_EVAL_REPO=react` selects one repository. Each invocation owns its
temporary state and removes it after success; failures retain that state for
diagnosis. The script does not write to existing user indexes or source
repositories. Re-running yields new publication identities and can produce
different timings or scores; the saved JSON is the historical measurement.

Verification performed:

- Forced CLI TypeScript build passed.
- Final focused core checks: 21 tests passed across vocabulary, extraction,
  encoding, indexing-pipeline, and sidecar-write behavior.
- Full MCP suite before changing the flag default: 964 passed, 1 skipped.
  After changing the default, 53 focused MCP checks passed.
- Docs, manifest, reranker-contract, and diff-whitespace checks passed.
- Cache/generation and publication failure checks included differential and
  mutation checks; source provenance and alias filtering have regressions.
- Harness repair checks: 26 passed. Target resolution now follows successful
  indexing; incremental outputs retain unselected repositories consistently;
  unmeasured retrieval/fusion phases are null and aggregate retrieval is named
  accurately.

The portable reproduction script was syntax-checked after saving; the entire
46-query experiment was not repeated solely for relocating that script.

### Indexing default-off follow-up, 2026-10-03

The extraction-equivalence and disabled-publication regressions failed on
the unconditional implementation before the gate was added. After the repair,
the forced CLI TypeScript build and all 630 core tests (94 files) passed;
all 964 MCP tests passed with one skipped (129 files). Disabled extraction
preserves legacy symbol bytes, and disabled publication succeeds even when
the vocabulary writer is fault-injected to fail. Explicit opt-in still builds
the artifact, and environment changes do not alter an already-created
pipeline's policy. The reproduction script's syntax and refusal to run without
the indexing opt-in were verified. Historical benchmark JSON was preserved.
