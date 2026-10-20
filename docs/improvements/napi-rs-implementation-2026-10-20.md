# Rust indexing experiment implementation, 20 October 2026

## Current checkpoint

- User intent covers the documented full-index bottlenecks and hardware use.
  The parent plan targets 200 seconds or less. Projection offload is one slice.
- Native kernel, opt-in pipeline integration, and ordered four-slot scheduling
  are implemented. Default indexing remains TypeScript.
- The new per-event lease-check regression is repaired at batch boundaries.
  All 52 focused tests, 29 original tests, root checks, and fresh SPEC/QUALITY
  reviews pass. No Git lifecycle operation is authorized or performed.
- Three exploratory r1 indexes have exact document/vector/source/navigation
  parity. Those runs expose the old cadence regression and are not final
  performance evidence for the repaired build.
- Repaired r2 measurements run sequentially with a frozen build, exact
  4400 MiB effective budget, four analysis workers, and a 6 GiB hard cap.
  First pair: 428.175 to 411.439 seconds critical, with 266.562 to 260.788
  seconds payload. Three-run medians and r2 artifact parity remain open.
- Next: finish the fixed six-run set, then take one separate native CPU
  profile to rank remaining costs. A scratch profiler launcher is prepared at
  `/tmp/satori-napi-20261020-TlXzQR/profile-run.mjs`. It reuses the r2 harness,
  records monotonic/wall-clock anchors, and enables Node CPU profiling only
  for that diagnostic. Do not include its timing in unprofiled medians.
- No source/build edits occur while r2 runs. The measurement follow-up is
  `napi-20261020-fullindex-r2` in the existing measurement worker thread.
  Detailed evidence and hashes follow in the historical checkpoints below.

## Scope and baseline

Hamza requests the start of the napi-rs experiment with Orchestrator V2
subagents. The parent specification is
`napi-rs-indexing-experiment-2026-10-20.md`. This first slice builds an isolated
projection kernel and its evidence tools. Production adoption still requires
a CPU profile, corpus parity, packaging, and full index measurements.
Hamza later clarifies that the note is a rough direction and permits design
and reasoning changes. Native microbenchmarks may therefore precede a worker
rewrite. The worker-thread alternative remains a comparison option. The
initial experiment does not change the indexing pipeline. Hamza then requests
opt-in pipeline integration and a measured full-index comparison while review
continues. The next slice implements that explicit extension.

TaskStartSnapshot: `master` at `97b5cca1b233851abfbcd681922c1e72e298441d`.
The initial working tree is clean. No commit, branch change, or publication
is authorized. TDD Route: off, skipped, from the local Aegis configuration.
Differential and fault tests remain required by the parent specification.

Baseline reads: the last three commits, the parent specification, r17 findings,
`core/search-projections.ts`, its tests, `core/indexing-pipeline.ts`,
`language-analysis/indexing-analysis.ts`, `analysis-worker-runner.ts`,
`paths/repository-path.ts`, package manifests, and the existing Potion Cargo
manifest. The codebase-memory graph reports October 6 metadata, so current
source reads supply the evidence for these owners.

The TypeScript projection builder owns published semantics. The experiment
owns only a candidate ASCII implementation, with an explicit unsure result
outside its proven subset. Native execution uses napi-rs AsyncTask on libuv.
No native file access, publication, global cache, or private thread pool exists.
Code is necessary to measure native boundary cost and compare real outputs.

## First slice contract

- Add a private package under `experiments/napi-search-projections/`.
- Use pinned Rust crates, Cargo.lock, napi-rs CLI, and a local pnpm lockfile.
  Keep the experiment outside the production package and release graph.
- Accept a batch of flat projection inputs. Preserve input order. Produce the
  exact four SearchProjections fields or null for an unsure input.
- Support ASCII only. Return unsure for Unicode, lone surrogates, or tokens
  longer than 256 bytes, or more than 256 breadcrumb entries. The TypeScript
  wrapper checks before string conversion. The count also bounds empty entries.
- Bound a call to 64 chunks and 4 MiB of input. The wrapper splits larger
  batches and uses the reference for an oversized individual input.
- Bound cumulative native output to 16 MiB per batch. Account for alias
  expansion before allocation and return unsure when the budget is insufficient.
- Keep canonical path validation in TypeScript. Reuse the reference builder
  unchanged for missing addon, load failure, and unsure inputs.
- Return native runtime errors. Discard a failed batch instead of returning
  partial results. Contain Rust panics at the task boundary.
- Use a per-call atomic cancellation flag. The wrapper waits for native work
  to settle before cancellation returns. Do not use Promise.race cancellation.
- Add a test-only Cargo feature for deterministic mid-batch errors, panic,
  and cancellation checks. Default builds expose no fault controls.
- Check fixture parity, direct native execution, mixed fallback, worker load,
  malformed input, bounds, cancellation, and whole-batch failure.
- Provide a streaming JSONL differential and benchmark command. Compare both
  projection strings and versions. Include boundary copying in native timings.
  Report fallback counts. Synthetic results never establish corpus acceptance.
- Add a reversible mutation check that proves a changed native result fails
  the differential comparison.

Inputs that affect parity include casing, digits, underscores, dollar signs,
empty fields, empty breadcrumbs, JSON control characters, CRLF, Unicode,
astral characters, lone surrogates, and long tokens. Preserve insertion order
for terms and aliases. ASCII byte lengths equal UTF-16 code-unit lengths.

## Execution and checks

One Sol6.1 implementation subagent uses medium reasoning in the shared
checkout. Explicit Orchestrator V2 selection takes precedence over the global
Claive default. The coordinator owns design, integration, and documentation.
The worker owns only the experiment directory. No Git lifecycle changes.
Independent spec review precedes independent quality review. Findings require
a bounded repair and a fresh review round.

Checks: native debug/release builds, experiment tests, `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, the existing projection test file,
and `pnpm run check`. Run heavy commands sequentially. Production hot paths
remain unchanged, so the full index suite is not a first-slice check.

## Checkpoint

- Baseline and design: read and fixed.
- Implementation: complete through Orchestrator V2, Sol6.1 medium.
  Request `napi-20261020-impl-r1`. Native output bounds and corpus context
  reach the active worker through steering messages. Live review also adds
  the breadcrumb count bound and removes repeated platform diagnostics.
  Follow-up task `node:delegated-task:d2bbb1ea-5e65-4844-9d32-8d6aa5dbd14b`
  completes with 18 experiment files. Worker reports 19 fault tests, 16 release
  tests with three fault-only skips, debug/release builds, fmt, both Clippy
  modes, locked install, and license inventory checks passing.
- Specification review: first review finds that `abort(null)` loses its reason.
  The reviewer also identifies missing standalone TypeScript checking. Repair
  both in the integration slice and request a fresh specification review.
- Quality review: pending.
- Coordinator checks and mutation: pending.
  The original projection test file passes all five tests. A three-repetition
  release benchmark/differential passes over all 547,349 exported corpus inputs.
  Reference times: 38.552, 38.118, 38.176 s. Native wrapper times: 34.419,
  33.869, 33.725 s. Medians: 38.176 to 33.869 s, 1.127x, 11.282% lower.
  Each pass: 535,899 native, 11,450 fallback, 8,520 native calls.
  Peak RSS: 257.223 MiB. Initial load: 1.76 / 2.80 / 3.19.
  Exact command and per-run data: temporary benchmark-clean.json.
  The result falls below the original note's 2x stop threshold. Hamza's later
  explicit request authorizes opt-in full-pipeline measurement despite that
  microbenchmark. No default activation or useful index speedup follows.
  Early raw-addon smoke: first 1,000 r17 inputs, 832 native results compare
  byte-identical to TypeScript, 168 return unsure. This does not close corpus
  parity or failure-path checks. Three platform-report calls take 42.691,
  2.156, and 2.064 ms, which supports caching the default addon lookup.
- Adoption gates: current CPU profile, 547,349-chunk corpus differential,
  full artifact differential, three full runs below 6 GiB, and platform
  packaging/CI remain open.

The r17 published Lance table contains exactly 547,349 rows. A read-only
one-row query checks that source content, relative path, line bounds,
metadata JSON, and published lexical text are available for corpus comparison.
Directory: `../bench-bugs/libreoffice-perf-20261020/full-r17/state/vector/lancedb`.
Table: `hybrid_code_chunks_6417a4b6__gen_77b8f70d_a123_4567_a2a7_f2461b02edba`.

A temporary read-only export completes: 547,349 inputs, 751,988,411 bytes.
The bounded query selects source, relative path, line bounds, and metadata,
without vectors. Export process RSS at completion is 854 MiB. Active files:
`/tmp/satori-napi-20261020-TlXzQR/corpus.jsonl` and a 10,000-input sample.
Remove these task-created temporary files after the comparison completes.

Resume from this checkpoint, the parent specification, and current Git status.
Stop this slice when the experiment checks pass and open adoption gates are
explicit. Never enable the native kernel from fixture or synthetic evidence.

## Authorized pipeline slice

Move the native batch wrapper to the dedicated core owner
`packages/core/src/core/native-search-projections.ts`. The experiment keeps a
thin loader facade and the Rust build. Do not duplicate native policy.
The TypeScript reference remains unchanged. Add an opt-in absolute addon path
through `SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS`. No variable means the existing
projection path. A missing addon still uses the TypeScript fallback.

`IndexingPipeline` processes resolved chunks in bounded native windows, at
most 64 inputs and 4 MiB, with one oversized item permitted only for reference
fallback. Preserve deferred chunk streaming, chunk order/IDs, ownership,
embedding batching, and every drain path. The native owner holds counters.
An aggregate perf trace proves native execution and fallback counts.
`Context` supplies only the mutation signal port to the pipeline. It gains
no native logic or state. The native task must settle before cancellation,
lease loss, or a native failure returns to publication cleanup.

The integration worker owns the new native owner, its focused tests, the
pipeline and a focused pipeline test file, one Context wiring line, and the
experiment facade/test configuration. It fixes null cancellation reasons and
adds a standalone type check without a new dependency. Use Sol6.1 high for
this slice. A fresh specification review covers the integrated baseline,
then a separate quality review follows.

Focused checks compare TypeScript/native pipeline outputs for eager and
deferred analysis, multiple windows, Unicode fallback, cancellation, and
native failure with pending payload work. Run the existing pipeline/projection
tests, static checks, and appropriate hot-path regression checks. Then build
the local runtime and compare fresh TypeScript/native full indexes on the
same corpus, sequentially within MemoryMax=6G. Record at least three runs per
variant, peak anonymous memory, load, native counts, and phase timings.
Preserve existing indexes. Temporary experiment indexes belong to this task.

## Latest intent and diagnostic checkpoint

Hamza clarifies that the intended outcome addresses the documented Node
bottlenecks and hardware utilization. The 4.3 s projection microbenchmark gain
does not satisfy that outcome. The work so far implements one kernel only,
with one native batch in flight. Embedding transport, row encoding,
relationships, navigation writes, and file checks remain unchanged.

The pipeline integration exists in the working tree but is not yet checked.
Its original child run is interrupted with no pending runs. Follow-up request
`napi-20261020-integration-finish-handoff` resumes only focused checks and repairs
of demonstrated defects, then returns a handoff. No further feature expansion.

No full-index comparison starts yet. A bounded diagnostic separates reference
projection, benchmark JSON encoding, raw native binding, wrapper time, and
one-versus-four concurrent batches on the 10,000-input sample. Scratch script:
`/tmp/satori-napi-20261020-TlXzQR/diagnose-projections.mjs`, managed session18632.
The diagnostic changes no product code. Read diagnostic.json when it exists,
then reassess the full-index critical path against the original phase profile.
The prepared full-index-run.mjs remains idle.

Diagnostic completes, three repetitions on 10,000 real inputs, 157 batches:

- Reference builder median 673.846 ms, comparison JSON 62.014 ms.
- Raw native binding median 414.948 ms, wrapper 611.477 ms, JSON 55.569 ms.
- Wrapper concurrency1 median 604.875 ms, concurrency4 332.661 ms.
- Main-thread CPU: 266.953 ms at concurrency1, 260.780 ms at concurrency4.
- Whole-process CPU: 612.229 ms and 592.412 ms respectively.
- 9,808 native outputs compare equal, 192 return unsure in each raw pass.
- Peak RSS 349.895 MiB. Initial load 0.97 / 1.46 / 2.16.

The check demonstrates a missing scheduling improvement, not a full-index
result. Four calls in flight reduce sample native wall time by about45%,
while main-thread CPU barely changes. The wrapper also adds about197 ms
over the raw binding on this sample. JSON comparison encoding is a smaller
common cost. Current code still awaits each native window sequentially.
The next design must address bounded concurrency and remaining main-thread
payload work, then judge improvement at the full-index boundary.

The integration worker completes its bounded handoff: 24 core parity/drain/
projection tests, 17 release experiment tests with three fault skips, core and
standalone type checks, focused ESLint, and whitespace checks pass according
to the worker. No checks remain running there. Snapshot prefixes: native owner
c57a4a4bf4e8, pipeline ee2b93e01eb1, unchanged addon0db6a439725e.
Fresh integrated specification review runs as `napi-20261020-spec-r2`, Sol6.1
high and returns SPEC PASS. Quality review `napi-20261020-quality-r1` returns
QUALITY PASS with no findings. Both reviewers inspect source without tests and
report no source hash drift. Parent runs `pnpm run check`: lint has no errors,
all three type checks pass, and version/scope checks pass. The 60 lint warnings
occur in unchanged tests. The original pipeline test file passes all24 tests.
The serial integration slice is checked. The overall performance work remains
incomplete and no full-index speedup is measured.

## Bounded parallel projection slice

Change necessity: the diagnostic shows that serial submission prevents useful
parallel execution. Changing libuv's thread count cannot fix a serial caller.
The native projection coordinator must receive an ordered stream of resolved
chunks across files. It retains four batches, including completed results
waiting for consumption. Existing output, file callbacks, IDs, and embedding
batches retain their order. Default TypeScript indexing avoids chunk-level
async iteration.

Corpus distribution supports both cross-file and within-file scheduling:
27,509 files contribute 141,124 chunks at <=16 per file. Another 6,672 files
contribute 206,288 chunks at <=64. Files over64 contribute 199,937 chunks.
There are 35,726 files with chunks. The 34 other indexed files have no chunks
and still require completion callbacks and source coverage.

One new owner, `core/indexing-projection-stream.ts`, schedules projection work.
Its invariants are ordered delivery, four retained batches, bounded inputs,
and settlement before exit. State lasts one operation, only this owner writes
the queue, and nothing persists. Its narrow ports are an async resolved-input
stream and the native builder. It depends on no Context or file system.

The stream carries chunk, file-complete, and file-error events. Each batch
holds <=64 chunks, <=128 events, and <=4 MiB flattened input, except one
oversized chunk alone for reference fallback. Completed batches keep their
slots until every event is consumed. At most one lookahead item is retained.
No file-wide chunk or projection arrays are materialized.

The native owner separates preparation from consumption. `prepare` returns
native projections or null markers without running reference fallback.
`finish` runs the unchanged reference for null markers during ordered
consumption. This prevents concurrent preparation from retaining several
unbounded reference outputs. `buildProjectionBatch` keeps its established
standalone API by composing the same two steps. Supported native outputs
retain the existing 16 MiB per-call bound, so four batches bound queued native
output at 64 MiB. The coordinator also owns a local cancellation controller
combined with the caller signal. It can cancel its own work without aborting
the root operation's signal.

IndexingPipeline factors existing file preparation and chunk resolution into
shared local helpers. A sync chunk loop remains for the default path. The
native path supplies the ordered event stream to the new coordinator.
File-complete events run the existing callbacks after earlier chunks enter
the embedding buffer. File-error events retain the original error and file
context. Source reservations release only after the producer emits that file
into the separately bounded projection windows. Source parsing and admission
rules keep their existing owners.

On source errors, flush earlier partial input before the error event. On a
native failure, deliver failure in request order. Observe every rejection
immediately, stop new submissions, and await every submitted task before
throwing. Early consumer return, embedding failure, callback failure, root
cancellation, and lease loss close the source, cancel coordinator-owned work,
and drain both native work and the existing payload/analysis owners.

Checks must prove four real calls start before the first settles, across
small files and within a large file. Deterministic barriers complete requests
out of order, block consumers, fail producers/native calls, and cancel work.
Assert ordered documents, embedding inputs, callbacks, source/symbol results,
bounded retained slots/bytes, and no background work or later writes at exit.
Unsupported and output-budget fallback must execute only during consumption.
Run focused tests, independent spec/quality review, and root checks before
full-index measurements. No Rust, dependencies, or Context changes belong to
this slice. Stop this slice at checked concurrency, then measure the complete
index and use its profile to select the next documented bottleneck.

Parallel implementation runs through Orchestrator V2, Sol6.1 high, request
`napi-20261020-parallel-r1`. The coordinator owns the fixed design and reviews.
The worker owns only stream/native/pipeline files and their necessary tests.
No full-index command runs while that source changes. The later full-index
comparison uses one frozen build with the addon flag unset/set, within6GiB.

### Parallel slice checkpoint

The worker completed six core files. It reports 43 focused tests, core and
experiment typechecks, focused lint, and 17 release experiment tests passing
with three fault-only skips. The coordinator independently ran `pnpm run
check` and the original pipeline/reference tests. All checks passed, including
29 original tests. Existing lint warnings remain outside this change.

Current source SHA-256 prefixes: stream `481295449902`, pipeline
`361883a47b45`, native owner `6853f0f1d7f2`. Release addon remains
`0db6a439725e`. These supersede the serial integration source hashes.

Independent concurrency specification review runs as request
`napi-20261020-parallel-spec-r1`, Sol6.1 high, read-only. The earlier serial
SPEC and QUALITY passes do not cover this concurrent implementation.

Full-index measurements run separately as request
`napi-20261020-fullindex-r1`, Sol6.1 medium. Evidence root:
`/home/hamza/repo/bench-bugs/libreoffice-perf-20261020/napi-parallel-r1`.
Its `run.mjs` uses the existing local offline session and fresh state for
every run. A build hash inventory freezes all workspace distribution files
and the addon. The six-run order is reference-1, native-1, native-2,
reference-2, reference-3, native-3. Runs are sequential, under systemd
`MemoryMax=6G`, `MemorySwapMax=0`, with the same 4800 MiB indexing budget
and four analysis workers. No builds or source repairs occur during valid
measurement. A review finding can invalidate the frozen build.

Each run records terminal publication/counts, critical time, wall time,
cgroup memory and CPU use, load, and phase spans. Native metrics must prove
actual addon work and bounded overlap. Performance medians and full artifact
parity remain pending. No full-index speedup claim is supported yet.

Concurrency SPEC r1 and QUALITY r1 both passed with no required repairs.
Requests are `napi-20261020-parallel-spec-r1` and
`napi-20261020-parallel-quality-r1`. Start/end source and addon hashes match.
The spec reviewer independently ran the native-rejection/payload-drain test,
which passed. Quality review was read-only without test execution.

The first reference index is running. `compare.mjs` in the evidence root
prepares a strict artifact comparison after measurements stop. It compares
all 547,349 document identities, content, lexical text, metadata, Float32
vector bytes, source coverage, and navigation sidecar files. Only metadata
`indexedAt` and the two manifest `builtAt` values are excluded. Comparison
has not run yet. No sidecar/vector equivalence claim is supported yet.

### First full-index pair and regression hypothesis

Reference-1 critical/wall times are 453.750/500.417 seconds. Native-1 times
are 556.466/610.618 seconds, a 22.6% critical-time regression. Both complete
35,760 files and 547,349 chunks without protocol errors. Frozen hashes pass.
Native counters show 535,893 native results, 11,456 fallbacks, 8,520 calls,
four retained batches, 659,816 peak input bytes, and four overlapping jobs.
Peak anonymous memory is 4334.77 MiB reference and 4257.55 MiB native.

Effective budgets differ: 4549 and 4702 MiB despite the same 4800 MiB cap.
The planner limits its override by observed host/cgroup headroom. All
discrete resource-plan controls match. Budget and its derived burst reserve
differ. This pair is evidence of a regression, not a controlled final result.
The worker finishes the already active native-2 run, then stops new runs.

The coordinator found a concrete added mechanism after both reviews passed:
the native consumer calls `assertMutationCurrent` on every chunk and file
completion. That is about 583,109 observations before submission/write
checks. The reference path has no corresponding per-chunk check. The runtime
resolves the root and reads lease state synchronously on each call. Native
main-thread system CPU rises from 29.874 to 92.823 seconds, while user CPU
changes from 189.271 to 186.156 seconds. Payload time rises from 277.122 to
407.363 seconds. These observations support, but do not yet prove, the
repeated lease checks as the dominant added cost.

Next falsifiable repair: retain checks before submission and before consuming
each settled ordered batch, with existing write guards unchanged. A focused
test must reject per-chunk observation growth and preserve lease-loss drains.
No source/build change occurs before native-2 finishes. The invalidated review
scope will receive fresh specification and quality reviews after repair.
Full-index medians and artifact parity remain open.

Further owner inspection strengthens the mechanism: `isCurrent` acquires
`withRootLock`. Each assertion creates/writes a lock file, reads state, and
removes/closes that lock. The added per-event call therefore performs lock
file writes, not only cached reads. The repair changes only the new caller's
cadence, never the mutation authority or its locking contract.

For the next controlled comparison, use a 4400 MiB input budget, below both
observed startup headroom values and above the 4096 MiB process-mode boundary.
Keep the same 6 GiB hard limit and four analysis workers. The scratch r2
harness fails if the effective budget differs from 4400 MiB. This is benchmark
configuration, not a product configuration change. Three fresh runs per
variant remain required after the repair and frozen-build checks.

Native-2 finishes at 550.064 seconds critical and 604.725 seconds wall, with
91.049 seconds main-thread system CPU. It repeats Native-1's payload cost
at 407.610 seconds. Counts, four-slot telemetry, and frozen hashes match.
Its effective budget is 4790 MiB. The exploratory set stops after three
runs, with no remaining jobs. No three-run-per-variant median exists.

Repair request `napi-20261020-lease-cadence-r1` runs on Sol6.1 high. Its
ownership is the stream, pipeline, and their focused tests. The fixed design
adds one consumption-boundary callback inside generator cleanup ownership,
wires it to the existing lease assertion, and removes only the new
per-event assertion. The mutation authority, binary, and preexisting write
guards remain unchanged. The worker must prove bounded observation counts
and original-error/drain behavior before new full-index measurements.

The lease-cadence worker reports DONE. Its regression checks fail before the
repair: 641 chunks across files cause 1293 extra assertions instead of 22,
and 257 empty files cause 257 instead of three. After repair, all 52 focused
tests pass. Core typecheck and focused lint pass. New deterministic cases
cover a consumption-check failure with native tasks and source close pending,
exact error/null preservation, no later writes/callbacks, and root isolation.

Current source prefixes: stream `cc3cc3fff2c6`, pipeline `9e240977e55e`.
Native owner remains `6853f0f1d7f2` and addon `0db6a439725e`.
Independent repair specification review is request
`napi-20261020-lease-spec-r1`, Sol6.1 high. Parent root checks and original
regressions are running. The next benchmark evidence root is
`/home/hamza/repo/bench-bugs/libreoffice-perf-20261020/napi-parallel-r2`.
No r2 index starts before verification and build freezing.

Repair SPEC r1 passes without findings. Parent `pnpm run check` and all 29
original pipeline/reference tests pass after repair. Fresh QUALITY review is
`napi-20261020-lease-quality-r1`. The r2 distribution/addon inventory is now
frozen. The r1 artifact comparison runs alone under a 6 GiB cap, before
measurement resumes. Neither performance nor full-index parity is concluded.

The parent specification's full-index target remains 200 seconds or less.
Projection concurrency is one slice. After controlled measurement, rank
remaining main-thread costs against the documented transport, row-encoding,
relationship, and navigation candidates. A checked projection kernel alone
does not meet that broader target.

Repair QUALITY r1 passes with no findings. Both new reviews inspect the
actual filesystem-lock cost and confirm the remaining write guard after
asynchronous embedding. Source hashes remain unchanged. Parent r1 artifact
comparison completes reference-1 and native-1: all 547,349 normalized rows,
exact Float32 vectors, source coverage, and 71,523 navigation files match.
Rows SHA-256: `959709eb958e1df2ea650cc6a8f27805979bfb7749da35aea1ac4e2aeb8a1024`.
Source SHA-256: `9c36ce4bfbfdca5252bc7d13b630fbb1bbcf98c968a597855c627343de1ae190`.
Sidecar inventory SHA-256:
`11073b0dbe4750baaf4dc490a1b0e23682b19c37125ddd7bda0a32977eee6dd2`.
Native-2 comparison remains running. These checks establish r1 output parity,
not repaired-build performance or completion of the 200-second target.

Native-2 also matches the same complete artifact hashes. The capped comparison
exits successfully after 146.789 seconds, with 145.259 seconds CPU and a
3.4 GiB memory peak. No comparison job remains. The reusable measurement
worker starts r2 through follow-up `napi-20261020-fullindex-r2`, using the
fixed 4400 MiB effective budget and the frozen repaired build. Six new indexes
run sequentially. Three-run medians and repaired-build parity remain pending.

R2 first pair completes with exactly equal resource-plan fields, 4400 MiB
effective budgets, valid 6 GiB/no-swap caps, correct counts, no protocol
errors, and frozen hashes. Critical times: reference 428.175 seconds, native
411.439 seconds, 3.909% lower in this pair. Payload: 266.562 to 260.788
seconds. Main-thread user CPU: 188.509 to 156.109 seconds. Main-thread system
CPU: 25.587 to 30.447 seconds. The added-lock regression is removed, but the
controlled pair does not establish a large full-index gain. Reference scan
time is 34.369 seconds versus native 20.099 seconds, so the critical-time
difference cannot all be credited to projections. Three-run medians remain
pending. Average cgroup busy cores: 4.966 and 5.121, on the 16-core host.

No new product change runs during the frozen six-run set. A separate native
CPU profile is needed after the set to rank remaining main-thread costs.
Reuse the established profiler and clock-to-span method. Do not count that
profiled run among the unprofiled performance medians. Current traces show
72-second navigation and 260-second payload phases. Inclusive embedding and
analysis-wait sums cannot substitute for a CPU profile or critical-path time.
