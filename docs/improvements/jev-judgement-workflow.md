# Jev as an independent judge in the Satori workflow

Status: first lanes implemented and measured, 24 October 2026. The evidence-lane rubric and the
retrieval-triage adapter contracts were corrected on the same date and are covered by offline
tests. Two evidence-lane comparison runs and one retrieval-triage run exist; those historical
counts were produced before the corrections and remain provisional. No corrected-rubric model
rerun and no retrieval-triage model rerun exist. No product code path changed.

Evidence paths under `/tmp` are local transient artifacts. They are not versioned, and raw
reproducibility may be unavailable after cleanup. This document keeps the method, identities,
metrics, and limits.

## Why this exists

Satori's quality claims come from its own judges: the acceptable-owner regexes in
`evals/real-repo-quality/cases.json`, the adjudicated judge in `evals/judges/judge-v2.json`,
and the rank arithmetic over them. Those judges decide what counts as a correct answer, so a
defect in a judge silently moves every score. Jev is a cheap, independent text judge
(`jev-1.13.0`, $0.042 per million input tokens) that can be asked the same question the
deterministic judge answers, without sharing its code, its regexes, or its assumptions.

The rule this workflow follows: **Jev never decides anything.** It produces disagreement, and
every disagreement is adjudicated against the repository source by a person or an agent that
reads the code. Agreement is weak evidence that a judge is sane; disagreement is a work queue.

## What Jev is not

- Not a reasoner, planner, retriever, or generator. It judges text supplied in the request.
- Not a ground truth. Its confidence tracks its own distribution, not correctness.
- Not in the product path. No Satori runtime call, dependency, or configuration changes because
  of this document.

## Protocol

For each item: one question, both judges, one rubric.

1. **Shared rubric.** The two judges must answer the *same* question with the same acceptance
   level, including granularity (`symbol` versus `path`). Measured consequence of skipping this:
   the first run reported 12 disagreements that were entirely a rubric mismatch (see below).
2. **One request per item.** Batching many items into one state degrades the judgment: on 28
   pinned queries, batching produced 18/23 agreement with curated tags while single-question
   requests produced 5/5 on the same five disagreements, at 0.97–1.00 confidence.
3. **Confidence floor.** Below 0.7 an answer is recorded and not acted on. In the separate
   28-query intent experiment, wrong answers sat at 0.36–0.74 and correct answers at 0.79–1.00.
   That range is scoped to that experiment. Evidence-lane disagreements include a 0.80 answer, so
   0.7 is not a universal calibration guarantee. The floor only prioritizes review.
4. **Adjudicate against source.** A disagreement becomes a finding only after reading the file at
   the recorded path. Otherwise it is a hypothesis with a citation.
5. **Report agreement and disagreement separately.** A high agreement rate is not accuracy: it
   only means two judges read the text the same way.

## The first lane: `evidence`

`evals/judges/jev-dual-judge.mjs --lane evidence` asks, for every accepted entry in
`evals/judges/judge-v2.json`, whether the entry's evidence text names the code that answers the
question. Satori's verdict is `answers` by construction (the entry is in the accepted set), so a
disagreement is a candidate that the accepted evidence may not locate an answer. It is not proof
by itself.

Measured on 24 October 2026, all 47 accepted entries, concurrency 8:

| Run | Rubric | Items | Agree | Disagree | Cost | Wall |
|---|---|---|---|---|---|---|
| 1 | granularity-blind | 47 | 35 | 12 | $0.00113 | 2.3 s |
| 2 | granularity stated in question (criterion still required a symbol) | 47 | 37 | 10 | ~$0.001 | 2.2 s |

The script that produced both runs was internally inconsistent. Its instructions say that at
`path` granularity, naming the file is a full answer. Its `answers.what` criterion still required
the file and the function, class, or symbol (in the earlier script). Both 47-entry runs therefore
measured a mixed rubric. The counts below are observed under that rubric. They are not proof of
scoring tolerance, calibration, or accuracy. No corrected-rubric rerun has been performed, so those
counts remain provisional. The current script derives the rubric from `item.granularity`; the
correction has offline checks only and has not been run against the model.

What run 1 actually measured: every one of the 12 disagreements was a `path`-granularity entry and
none was a `symbol` entry (32/32 symbol entries agreed). The pattern was consistent with Jev
re-deriving the judge's own granularity split, not finding defects. Run 2 stated granularity in
the question, but the criterion still demanded a symbol, so it still disagrees on 10 entries —
again all `path`-granularity, 7 of the 10 below the confidence floor, and 7 of the 10 in
`flatbuffers`.

The five rows below are an illustrative subset of the 10 path-level disagreements. The document
does not retain the other five rows, so do not infer missing counts or confidence values from it.

| Entry | Evidence | Jev |
|---|---|---|
| `flatbuffers:fresh_f1#0` | `src/reflection.cpp` | partial 0.80 |
| `flatbuffers:fresh_f3#0` | `include/flatbuffers/flexbuffers.h` | partial 0.72 |
| `flatbuffers:fresh_f3#1` | `java/src/main/java/com/google/flatbuffers/FlexBuffers.java` | partial 0.53 |
| `flatbuffers:fresh_f5#0` | `tests/fuzzer/flatbuffers_verifier_fuzzer.cc` | partial 0.51 |
| `flatbuffers:fresh_f6#0` | `docs/source/white_paper.md` | partial 0.67 |

Provisional reading at the time: the symbol-level answer set appeared to hold up under an
independent judge. The path-level acceptance looked like the place where the eval's tolerance
lives — a bare file path is accepted as a full answer, and Jev called it partial. The mixed rubric
means these runs do not prove that reading. They are not proof of scoring tolerance, calibration,
or accuracy, and the path-level result is not a defect to fix in product code.

### Current script contract (corrected, not rerun)

The evidence lane now uses one rubric per item, derived from the item's recorded granularity:

- **`path`.** The `answers` criterion accepts the file that owns the behaviour. No symbol is
  required, and a file-only answer is not classified as `partial` for that reason. This aligns the
  criterion with the instruction that already accepted the owning file.
- **`symbol`.** The `answers` criterion requires the answering function, class, or symbol itself.
  A file-only answer in the right file remains `partial`.
- **Question intent.** The rejection text no longer excludes a test or documentation file by
  itself: when the question asks for tests, documentation, or configuration, that file is the
  answer. One question per item is unchanged.
- **Unknown granularity.** A missing or unknown granularity is rejected with a diagnostic. The
  script does not guess a level.

Response handling accepts the documented bare `{choice, confidence, probabilities}` shape and the
nested `questions`, `answers`, and `results` containers. Only the choices `answers`, `partial`, and
`unrelated` are accepted. A malformed response is an item error, never agreement. Agreement treats
`partial` as a third explicit Satori outcome, keeps `answers`/`accept`/`accepted` and
`reject`/`rejected`/`unrelated` for compatibility, and returns `null` for an unknown baseline.

Each request attempt, including the response-body read, is bounded by
`AbortSignal.timeout(30000)`. The existing four-attempt limit remains, so a run cannot wait
forever. An abort or timeout is reported as a failed item. After the summary is written, any
failed item makes the process exit nonzero. `--concurrency` must be a positive integer and
`--limit` a non-negative integer, so a bad value cannot produce an empty success.

Offline tests cover both rubrics, the documented and malformed response shapes, partial agreement,
the request body and signal, deterministic timeout failures, worker settling, output-directory
creation, and the nonzero exit. They make no model or network call. No corrected-rubric model
rerun has been performed, so the run counts above are unchanged and provisional.

## From disagreement to root cause

A disagreement is not a finding. The judge comparison only produces a queue of cases whose two
verdicts differ. The work that matters is the step after it: establish **why** they differ, name the
owner of that mechanism, and write down the check that would falsify the claim. A disagreement that
cannot be traced to an owner is closed as `unexplained`, not filed as a defect.

Every case is closed as exactly one of:

| Closure | Meaning | Where the owner lives |
|---|---|---|
| `product` | A Satori mechanism produced the wrong behaviour | the owning module, cited by `file:line` |
| `eval-defect` | The measurement, case data, or acceptance rule is wrong | the eval asset, cited by path |
| `no-defect` | Both verdicts are defensible; the evidence was ambiguous | none — recorded and dropped |
| `unexplained` | No mechanism found within the bounded investigation | none — recorded, not filed |

The cause taxonomy below is the routing table for that step. Each row was confirmed on real cases in
this lane, not assumed.

| Cause class | Signal in the disagreement | Owner |
|---|---|---|
| Acceptance tolerance | Disagreements cluster on one `granularity` value | case data + scoring in `evals/real-repo-quality/` |
| Missing oracle | The case has no curated expectation to test against | case curation |
| Retrieval budget | The correct owner never reaches the reranker | candidate budget in `packages/mcp/src/core/search-policy.ts` |
| Role ordering | Owner is retrieved but ranked under tests/docs/adapters | `preferImplementationCandidates`, `packages/mcp/src/core/search-ranking-policy.ts:191` |
| Intent classification | The answer-focus role split never engages | `resolveSearchAnswerFocus`, `packages/mcp/src/core/search-answer-focus.ts`; `packages/mcp/src/core/search-query-planning.ts` |
| Evidence projection | Judge sees a summary the code does not support | the eval's evidence generator |

Fusion and query routing are deliberately absent: they are separately known problems and must not be
reached from a judge disagreement without their own evidence.

### Worked example: the ten path-level disagreements

The `evidence` lane disagreed on 10 of 47 entries, all of them `path`-granularity, none of the 32
`symbol` entries. Provisional cause class: acceptance tolerance. The eval's scoring accepts the position of the
first top-10 result whose path matches and whose symbol matches *or* the result is whole-file — so a
bare file path is a full answer for those cases while the `answers.what` criterion demanded a symbol.

- **Owner:** the acceptance rule and case data, not search.
- **Falsifiable check:** rerun the lane with one consistent rubric. The prediction is that
the path-level disagreements shrink and no ranking changes. If any survive, that residual is a real
`product` case and gets its own investigation.
- **Status:** not run. The script now uses one granularity-aware rubric, but no corrected-rubric
  model rerun exists. The prediction remains unmeasured, and the historical counts were not
  regenerated.

This is why the lane's output is a queue, not a score. A 10/47 disagreement rate looks like a
quality problem. It is probably a measurement artifact, but the inconsistent rubric means that
conclusion is not established.

### Worked example: four implementation cases and one tooling mismatch

The earlier classifier lane flagged five cases with two different expected intents.
On the exact case strings, `p3`, `p5`, `f5` and `f7` return
`focus=neutral, reasons=no_focus_signal`. These are the four implementation-intent hypotheses.
`r6` is separate: its curated `tooling-ask` tag expects tooling intent, but the classifier returns
`focus=implementation, reasons=implementation_seeking_query`. The word `check` matches the
implementation cue at `packages/mcp/src/core/search-query-planning.ts:659`.
The tooling mismatch remains open. The exact-string check does not close it.

Mechanism, in evaluation order:

1. `implementationSeeking` stays false because the implementation cue vocabulary at
   `packages/mcp/src/core/search-query-planning.ts:659` lists engineering verbs (`implement`, `emit`,
   `normalize`, `reconcile`, `control`, …) but no data-processing verbs, so *cast*, *push down*,
   *parse* and *resolve* match nothing.
2. The identifier-gated fallback at `packages/mcp/src/core/search-query-planning.ts:667` requires an
   identifier token; these are all natural-language `where does <subject> <verb>` questions.
3. The default question cue at `packages/mcp/src/core/search-answer-focus.ts:16` matches
   `how does|do|is|are` and `where is … implemented`, but not `where does`. The variant that would
   match it, `IMPLEMENTATION_QUESTION_CUE_WIDE` at line 24, is gated behind `focus_cue_wide`, which is
   `false` by default (`packages/mcp/src/core/search-flags.ts:58`).
4. Resolution therefore falls through to `neutral` at `packages/mcp/src/core/search-answer-focus.ts:80`.

Consequence: `preferImplementationCandidates` engages only for `implementation` focus unless
`neutral_owner_preference` is set, and that flag is also `false` by default
(`packages/mcp/src/core/search-flags.ts:61`), wired at
`packages/mcp/src/core/search-rerank-execution.ts:602`. So these four questions get no role split at
all: a test file or a doc page competes with the owning implementation on score alone.

Classification effect, measured on all 28 pinned queries by running `buildSearchQueryPlan` and
`resolveSearchAnswerFocus` from `packages/mcp/dist` over `evals/real-repo-quality/cases.json` with the
flag object `{focus_cue_wide: false}` and `{focus_cue_wide: true}`: the flag changes the focus of
exactly four queries — `p3`, `p5`, `f5`, `f7` — and all four move `neutral` to `implementation`. No
other pinned query changes focus. The cue is consulted only after the test, documentation,
configuration and reference branches have already returned, so those families cannot be reclassified
by it at all; the warning in the comment at `packages/mcp/src/core/search-answer-focus.ts:19` that the
wide cue "also captures reference and conceptual questions" is unreachable for all four branches and
is not observed on the pinned set.

One honest limit on that chain:

- **The oracle is missing for two of the four.** `p5` and `f5` carry no curated tag, and the `tags`
  field is not a correctness oracle. The harness reads tags for cohort selection, but no eval consumer
  uses the tag as a correctness oracle. "The classifier is wrong here" is an opinion
  about phrasing, not a measured defect, for half the family.

**The rank effect is measured, and it is zero.** On the polars publication, `focus_cue_wide`
off versus on gives `p3` absent→absent and `p5` rank 1→1, while the other seven queries return
identical hits. The cue does not repair the only total miss, and it changes one non-owner position
in `p5` without moving the owner. Closure: `no-defect` for the cue hypothesis; widening it is not
the repair.

**What the miss was at that date (historical, 24 October 2026).** In the saved p3 capture, two
kernel chunks at `crates/polars-core/src/chunked_array/cast.rs` entered dense retrieval at ranks
46 and 55. One survived core fusion at rank 80, the last of the 80-candidate pool. That chunk
then moved to MCP fusion rank 89, reranker input 88 of 89, provider rank 61, reranked fusion
rank 41, and grouped rank 40. It was not absent from the fused pool. The dispatch owner
`Column::cast` at `crates/polars-core/src/frame/column/mod.rs:486` followed a different path in
that capture: reranker input rank 3, provider rank 30, and reranked fusion rank 14. The top-10
named seven candidate results that Jev rated `answers` (six at 0.83–0.98 and one at 0.40), but not the dispatch
owner. The original closure was `eval-defect` for the acceptable set, which then named only the
kernel file. These ranks describe the historical p3 capture, not the current rubric rescoring.

**Current correction, 24 October 2026.** The approved path-level acceptance now adds
`crates/polars-core/src/frame/column/mod.rs` with `symbolRegex: null`. `cases.json` carries the
entry committed separately as `5f96827c`. Rescoring three saved captures
adds one hit@10 and one strict hit@10, with MRR@10 +1/7/28 = +0.005102. Hit@1 and hit@5 do not
change. The returned hits are `cast_unchecked` at rank 7 and `strict_cast` at rank 10. Because the
regex is null, these hits satisfy the path-level rule but do not prove `Column::cast`. This is a
rubric-only change with no retrieval change.

## The retrieval-triage lane: one historical measurement

One polars run (`node evals/real-repo-quality/run.mjs --repos polars`) indexed in 99 s, scored 9
queries with hit@5 of 8/9, and produced the artifact the lane needs. `result.json` stores only a
median 137-character preview per hit, so the adapter `evals/judges/result-triage.mjs` resolves each
recorded path and span against the local checkout at `repo.path` and judges the source itself. The
recorded `commit` and `head` label the revision; the adapter does not hash or verify the checkout.

90 hit-question pairs at concurrency 8, 76k input tokens, $0.0032, 31 s of model time:

| Verdict | Hits |
|---|---|
| answers | 57 |
| partial | 18 |
| unrelated | 15 |
| below the 0.7 floor | 23 of the 33 non-answers |

These are model judgments of the supplied snippets. They are not source-adjudicated verdicts. The
run used an earlier version of `evals/judges/result-triage.mjs`, which hardcoded
`granularity: 'path'` because it was written for the polars path-level cases, and recorded
`satori.verdict: 'answers'` from harness top-k admission. That is an admission proxy, not an
independent Satori judge verdict. The current adapter does not reproduce that fabrication: it
emits `admission` metadata and omits `satori`, so the judge lane reports `satori: null` and
`agree: null` for those rows. Historical item files that carry a real `satori.verdict` still
compare. The 90 historical judgments were not regenerated.

### Current triage contract (corrected, not rerun)

- **Rubric source.** Granularity comes from `evals/real-repo-quality/cases.json`, resolved relative
  to the adapter. The lookup uses repository name, query id, and the exact pinned query text. An
  unknown repository, unknown query id, or mismatched query text is refused with a diagnostic; the
  adapter does not invent a rubric. No `--cases` flag was added.
- **Per-hit level.** Acceptable entries whose `pathRegex` matches the hit path select the level. If
  none match, the query's full acceptable set selects it. The level is `path` when any selected
  entry has `symbolRegex: null`, otherwise `symbol`. This preserves the mixed `p8` case: a hit on
  the Python `series.py` entry is `symbol`, and a hit under the Rust `interop/numpy/` entry is
  `path`. All 28 pinned cases were inspected; `p8` is the only mixed query.
- **Admission metadata.** Each item carries `admission: {source: 'harness top-k admission', rank}`.
  It carries no `satori` field. The judge lane preserves `admission` in its output.
- **Source evidence.** Source text is read from the local checkout at triage time. The recorded
  `commit` and `head` are provenance labels, not verified bytes: `revisionVerified` is `false`
  because no hash check or Git command runs. A missing source file falls back to the preview stored
  in `result.json`, marked by `evidenceSource: 'preview'`, `sourceReadFailed: true`, and
  `previewChars`. A hit with neither source text nor a non-empty preview is refused with a
  diagnostic rather than judged as empty text.
- **Output.** The adapter creates `--out` recursively, writes repo-qualified item ids such as
  `polars:p8#1`, and keeps `triage-index.json` for joins.

This is adapter and contract work only. It adds no production logic and does not edit the oracle.

The disagreement rate is not the finding. Where the disagreements sit is:

- **Rank damage is rare in this sample.** Only one query has a confidence-passing non-answering
  hit above its scored owner. `p2` admits `to_dummies.rs sort_columns` at rank 2 (`unrelated`,
  0.76) through a word collision, while the owner sits at rank 3. Every other admission problem is
  below the owner or below the floor. The proxy does not establish source-level correctness.
- **Noise concentrates in the tail.** Ten of the fifteen `unrelated` verdicts are at ranks 7-10.
- **The one total miss was an acceptance gap at that date.** `p3` returned seven candidate
  results that Jev rated `answers` (six at 0.83–0.98 and one at 0.40), but none in the then-accepted file
  `crates/polars-core/src/chunked_array/cast.rs`. The acceptable set did not include the dispatch
  owner `Column::cast` at `crates/polars-core/src/frame/column/mod.rs:486`. The approved
  path-level acceptance now adds that file; the rescore adds one hit@10 and one strict hit@10, and
  the returned hits are `cast_unchecked` and `strict_cast`, not `Column::cast`.

These observed counts support a triage queue for this one repository. They do not prove that the
eval's hit@5 is not luck, and they do not prove that only one defect exists. The single
rank-damaging `p2` case is a lexical collision that a reviewer can adjudicate from the citation.
Treat it as a candidate, not a confirmed product defect.

## Next lanes, in the order they earn their cost

1. **Claim verification.** `buildTypeScriptResolutionClaims` publishes call and import claims;
   Jev can judge whether a sampled claim's evidence text supports it. Catches a class of wrong
   edge that rank arithmetic cannot see.
2. **Doc-code agreement.** `docs/` prose against the code it names, judged for whether the doc
   still describes the current owner. Cheap, and it finds stale contracts.

Each lane stops when adjudication stops changing decisions. If a lane's disagreements are
consistently adjudicated in the judge's favour, the lane is measuring rubric noise and should be
dropped rather than tuned.

## Running it

```bash
bash -ic 'node evals/judges/jev-dual-judge.mjs --lane evidence --concurrency 8'
bash -ic 'node evals/judges/jev-dual-judge.mjs --lane items --items pairs.json'
# Retrieval triage from one real harness run:
node evals/judges/result-triage.mjs --result /tmp/polars/result.json --out /tmp/polars
bash -ic 'node evals/judges/jev-dual-judge.mjs --lane items --items /tmp/polars/triage-items.json'
```

The key lives in the login shell as `TYPESAFE_API_KEY` (or `JEV_API_KEY`); a non-interactive
shell has neither, so `bash -ic` is required. Responses are cached by payload hash under
`~/.cache/satori-jev-judge/`, and every run writes its rows to a timestamped directory there, or to
`--out` when given. Nothing is written inside the repository except the runners and their tests.

Offline checks, with no model call and no repository write:

```bash
node --test evals/judges/jev-workflow.test.mjs
pnpm exec eslint evals/judges/jev-dual-judge.mjs evals/judges/result-triage.mjs evals/judges/jev-workflow.test.mjs
```

The tests cover both rubrics, documented and malformed response shapes, partial agreement,
admission-only rows, symbol/path/mixed triage levels, unknown and mismatched query refusal, the
request body and timeout signal, worker settling, recursive output-directory creation, and the
nonzero exit on an item error. They use mocked fetch and temporary directories. They are not a
corrected-rubric model run.

## Limits

- Two comparison runs on the evidence lane used a mixed rubric: the instructions allowed a
  file-only answer at `path` granularity, while `answers.what` demanded a symbol. The 32/32 symbol
  agreements and 10 path disagreements are observed counts under that rubric. They are provisional
  and are not proof of scoring tolerance, calibration, or accuracy. The current script respects
  granularity, but the historical counts were not regenerated and no corrected-rubric rerun exists.
- One retrieval-triage run covers one repository (polars, 90 judgments). That run used a path-only
  rubric and the harness admission proxy. The current adapter derives symbol/path levels and
  separates admission from verdict, but the 90 judgments were not regenerated. The historical
  counts do not extend to another repository or to symbol-level precision, and they are not
  source-adjudicated proof.
- Source evidence is read from the local checkout at triage time. The adapter records `commit` and
  `head` and sets `revisionVerified: false`; it does not hash the bytes or verify the checkout, so
  a stale local checkout can change the evidence without detection.
- The evidence lane judges curator-written evidence summaries, not raw code, so a disagreement
  can mean "the summary is weak" rather than "the judge is wrong".
- The 0.36–0.74 confidence range comes from the separate 28-query intent experiment.
  Evidence-lane disagreements include 0.80. Jev confidence is not calibrated for all lanes.
  The 0.7 floor is a prioritization rule, not a validated threshold, and it was not tuned on
  held-out data.
- Jev's own failure modes were not characterised beyond the batching and confidence observations.
