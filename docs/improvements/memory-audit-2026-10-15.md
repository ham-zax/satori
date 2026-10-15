# Memory audit and scoped repairs, 15 October 2026

## Review follow-up, 16 October 2026

Baseline: `85a9b4c2` on `master`. Hamza requested the three findings from the
review of `4e5b61cb`, `668e3ff2`, and `85a9b4c2` be fixed.

- Analysis reservations retain the 8 MiB maximum until the source read completes.
  Verified source size then replaces that reservation and refills the requested
  window. Sixteen tiny files can enter a 64 MiB window. Eight 8 MiB files retain
  the same bound. Failure and source-limit cleanup stop refills before draining
  every started read. No stat preflight or public API change was added.
- Watcher callers retry a cancelled registration after its completion. The retry
  checks the watch list and uses the existing mode and publication guards.
  Concurrent callers share one replacement. Stop and unwatch prevent resurrection.
- Python package import bindings now prevent false submodule call edges when
  their bound name shadows the requested import. Tests cover re-exports, aliases,
  dotted imports, and an unrelated import that still permits a real submodule.
  Existing claim classification remains unchanged.

Checks on the integrated result:

- Core: **21 indexing tests and 21 Python-resolution tests pass**.
- MCP: **13 tests pass** across watcher lifecycle, read freshness, and `read_file` roots.
- Total: **55 focused tests across five files**.
- The static check caught a missing internal capability assertion in a new test.
  The parent added the assertion. Both affected cases and `pnpm run check` pass.
  Production code stayed unchanged after the measurement.
- `git diff --check` passes. Hamza authorized a separate commit for these follow-up changes.

The focused commands use each package's raw Node flags and concurrency 1:

```sh
pnpm --filter @satori-code/core exec node --liftoff-only --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/core/indexing-pipeline.test.ts src/relationships/python-resolution.test.ts
pnpm --filter @satori-code/mcp exec node --import tsx --import ./src/test-state-root.ts --test --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1 src/core/sync-watcher-lifecycle.test.ts src/core/sync-read-freshness.test.ts src/tools/read_file-root.test.ts
pnpm run check
```

Measurement: three alternating runs per variant use 277 repository TypeScript
files, totaling 2,651,574 bytes. Selection takes non-test files between 1 and
32 KiB. Both variants use eight real analysis threads, a sixteen-file window,
and the 64 MiB source cap. Embeddings and database writes use local test doubles.
The measurement covers reads, analysis, chunks, projections, rows, and pool
shutdown. It excludes semantic project analysis and external service latency.

| Local indexing measurement | `85a9b4c2` | Repaired |
|---|---:|---:|
| Median time | 1,714.077 ms | 1,644.572 ms |
| Median peak RSS | 755,156 KiB | 801,760 KiB |
| Time runs, ms | 1761.143 / 1710.670 / 1714.077 | 1738.163 / 1644.572 / 1609.195 |
| Peak RSS runs, KiB | 799584 / 755156 / 745732 | 895416 / 801760 / 781116 |

The repair improves median time by **4.1%** and increases median peak RSS by
**6.2%**. More small files occupy the window. This is a throughput tradeoff,
not an additional RAM reduction. All runs produce 7,360 identical document rows
and projections, excluding `indexedAt`. Their SHA-256 digest is
`d8e2bcf8b4c84971ebdaa228b41546ba0717c6fbeb68ae2ff0e28b12f92d495d`.

Node is `v24.19.0`, with 15 available CPUs. One-minute load ranges from 2.62 to
2.97 during the final pairs. The large-host resource plan is configured for
this comparison. The command uses the inspected scratch harness:

```sh
node --liftoff-only --import /home/hamza/repo/satori/node_modules/tsx/dist/loader.mjs /tmp/satori-review-fixes-20261016/benchmark.ts "$variant"
```

An earlier three-pair comparison gives 1,636.902 ms for `668e3ff2` and
1,703.062 ms for `85a9b4c2`, with identical output. Changing only the original
byte cap to admit sixteen files gives noisy results. That comparison does not
isolate the full cause of the earlier slowdown. The final paired measurement
above supports the repair's local throughput result only.

Claive workers: Luna max `17ea3a534273` handles watcher and Python fixes.
Sol 6.1 medium `b5eb2de4517c` handles the analysis-window fix in an isolated
checkout. The parent checks both diffs, integrates the two pipeline files,
fixes the test type assertion, and runs the final checks. Normal Claive history
retains worker evidence. Both workers are accepted and closed. The parent removed
the inspected scratch files after integration and final checks.

Brief process review: concurrent writers required isolation, so an isolated
checkout replaced the refused shared-workspace launch. Future runs must select
isolation before launching concurrent writers. The first benchmark used document
wrapper fields in its digest. The parent corrected the digest and repeated all
reported output comparisons. Future harnesses must inspect one document before
running measurement batches. No additional product change is proposed.


## Completed project checkpoint, 16 October 2026

Baseline: `668e3ff2` on `master`. Hamza requested repairs for all ten remaining
findings through Claive, then requested this project checkpoint. All ten are
implemented, integrated, independently reviewed, and checked. The earlier
M01/M02/M06 repairs remain intact. No production indexes or user data changed.

Final checks on the combined source:

- Core: **270 passed across 16 files**. The command uses Core's raw test flags
  with concurrency 1 and the exact changed-owner test paths.
- MCP: **61 passed across 7 files**, including real continuation ownership,
  shared runtime, vocabulary consumers, freshness, and Git-status retention.
- **331 focused tests passed across 23 files.**
- `pnpm run check` passed after the final ASCII change: lint, all three package
  typechecks, version freshness, and package scope. Existing lint warnings
  remain in unchanged files. Whitespace checks and scratch ShellCheck pass.
- No required implementation or verification work remains running. The parent
  closes the task's idle workers and removes inspected scratch state after
  recording acceptance. Worker reports remain in Claive's normal history.

Implementation results:

| Finding | Delivered behavior |
|---|---|
| M03 | Shared codec validation, encoded terms, flat posting pairs, evidence created for matches. The empty-parent-ID review regression is corrected. The two-entry cache policy remains. |
| M04 | Built-in indexing defers chunk strings until consumption. Local/thread/process delivery carries serializable structural evidence. Byte reservations bound read-ahead and drain on all exits. Public eager callers and custom analyzers retain their behavior. |
| M05 | Lazy UTF-16 tables, one shared source buffer, and a native ASCII witness that avoids prefix decoding. Unicode retains the existing decoder. |
| M07 | Single-pass ordinary JSON byte accounting, exact fallback for raw JSON, and immutable owned inspection without full continuation clones. Ordinary lookup copies and stale/admission error order remain. |
| M08 | Registry-owned comparison reuse behind deeply frozen checkpoint identity, root, and policy. Context delegates. Mutation synchronizers remain separate. |
| M09 | Replacement and clearing retire every alias and mutation target belonging to the displaced synchronizer object. Other roots and candidates remain independent. |
| M10 | Retirement joins, concurrent disposal, replacement gating, and failed-termination ownership. Ordinary job errors remain isolated from other requests. |
| M11 | Expired roots are pruned. Every access and probe respects a 32-root LRU limit. The requested root's captured stale fallback survives a failed probe. Evicted abandoned entries are forgotten. |
| M12 | Retry delays remove abort listeners on normal completion and cancellation. |
| M13 | Allocation and copy failures free all buffers already acquired, exactly once, while preserving original errors. |

Before/after results are medians of three isolated runs on the same input.
Array-buffer memory is included in external memory, so do not add it twice.

| Fixture / journey | Before | Final or measured step |
|---|---|---|
| M03, 10,000 documents / 480,000 postings | 106.39 MiB heap plus external, 359,800 KiB peak RSS | 44.22 MiB heap plus external, 215,940 KiB peak RSS |
| M04/M05, four 217,795-byte nested-function files, window 4 | 415,832 KiB peak RSS, 5,722 ms | 345,840 KiB peak RSS, 2,520 ms |
| M04/M05, same fixture with one file | 265,580 KiB peak RSS, 1,481 ms | 271,248 KiB peak RSS, 539 ms |
| M05 lazy-table step, 1 MiB Unicode source, byte-only use | 7,915,624 B retained heap, 1,048,640 B external | 213,056 B retained heap, 1,048,640 B external |
| M07, rejected 11,173,781-byte / 36,000-row value | 88.3 MiB heap delta, 288.4 MiB peak RSS | 12.3 MiB heap delta, 153.2 MiB peak RSS |
| M07, 32 warm reads of 2,400 rows | 5.82 MiB heap delta, 188.7 ms | 0.206 MiB heap delta, 0.124 ms |
| M08, one cold plus 30 warm checkpoint acquisitions | 1,197.242 ms, 304,164 KiB peak RSS | 92.031 ms, 136,032 KiB peak RSS |

M04/M05 four-file output is identical: 39,600 chunks, 98,524,980 text bytes,
SHA-256 `bbd5906d04ec440bcbf257cde74d83fc00b4feb73b2060b1a3586b0daad7124a`.
Median one-minute load is 1.79 before and 2.11 after on 15 available CPUs.
The one-file RSS median is about 2.1% higher. Its before range is
265,552–276,800 KiB and final range is 264,840–286,016 KiB. Do not claim a
single-file peak-RSS win or universal memory reduction. Sampled heap is lower,
but timer sampling can miss synchronous allocation peaks. Process RSS uses
Node's operating-system high-water mark.

The first isolated M04 implementation regressed peak RSS to 340,908 KiB.
The parent did not accept that as an improvement. A bounded source-position
experiment identified unnecessary ASCII prefix decoding. The final M05 witness
uses native `isAscii`, byte length only for proven ASCII, and the old Unicode
decoder otherwise. Tests count real allocations/decodes and fail when the
witness is corrupted. The final four-file measurement is for the combined
M04/M05 implementation, not deferred chunking alone.

Other limits: M03 uses a valid 6,348,682-byte synthetic artifact because the
original exact artifact was unavailable. Two simultaneous compact entries
were not measured, and the suggested 4 MiB target was not achieved. M08 uses
a 1.640 MB synthetic checkpoint. Its cold acquisition rises from 48.581 ms
to 91.948 ms due to the first immutability check. M07's read measurement is
warm and excludes the first freeze. M03 timing is confounded by different
machine loads. No host-wide or native-model leak-free claim is made.

Execution used four reusable Claive workers:

| Worker | Model | Work |
|---|---|---|
| `0812a3f48f46` | Luna max | M03, empty-ID correction, M07 |
| `b0684802cea5` | Luna max | M04 |
| `8e67bc38256e` | Sol 6.1 medium | M12/M13/M10/M11, consumer wiring, independent reviews |
| `b01da1ff4232` | Sol 6.1 medium | M08/M09/M05, ASCII witness, independent reviews |

The isolated snapshots use copied source and Git metadata, with links to
installed dependencies. No main-repository branch or worktree was created.
Heavy work shared a serial lock. Scratch commands below describe the executed
experiments. Their temporary harnesses are removed after acceptance. Final
reports remain under `/home/hamza/.local/state/claive/`.

Retrospective proposals only: split a 15-file implementation into smaller
checkable worker turns to avoid late handoffs. Use short-line limit fixtures
to exercise the real 450,000-row cap without unrelated quadratic column work.
Check end-to-end memory before accepting a deferred-allocation design. Existing
checks already cover lint and types, so no new CI gate or global rule is added.

## Remaining repair execution, 16 October 2026

TaskStartSnapshot: `668e3ff2`, clean working tree. Hamza authorizes fixing all
ten remaining findings through Claive with Luna max and Sol 6.1 medium or low.
Reuse the completed audit. Preserve public contracts and search/index outputs.
No dependency, release, push, production-data deletion, or branch change is
part of this task. The parent owns integration and this checkpoint.

Decision: code-change. Each finding has a demonstrated allocation or cleanup
mismatch. Fix the recorded owner rather than adding a downstream workaround.
Architecture review is required for the internal M04 analysis boundary and
M08 checkpoint reuse. The remaining repairs stay at their existing owners.
Failure cleanup tests run before repairs. Optimizations require old/new output
equivalence and mutation checks. Performance results use three comparable runs.

Execution queue, each with focused tests, parent inspection, and Sol review:

1. M03: codec-owned compact validation and compact vocabulary postings.
2. M04: internal deferred chunk materialization and byte-bounded read-ahead.
3. M05: lazy source-map conversion data and shared source bytes.
4. M07: continuation accounting and lookup without unnecessary full copies.
5. M08: reuse validated publication checkpoints at their domain owner.
6. M09: retire generation aliases with the synchronizer that owns them.
7. M10: retain and join semantic-worker termination promises.
8. M11: prune expired Git-status entries and bound retained roots.
9. M12: remove retry abort listeners on every settlement path.
10. M13: unwind native allocations from the first successful allocation.

Historical execution notes follow. The completed checkpoint above is current.
All ten implementations are integrated and their final combined checks pass. Luna implements one bounded slice per turn. Sol reviews
specification first, then correctness. Heavy checks share a serial lock.

- M03: Luna `0812a3f48f46` replaces posting/evidence objects with encoded terms
  and flat posting pairs. Seventeen focused tests pass. Deliberately corrupting
  link decoding makes the independent reference tests fail. Sol found an empty
  parent-ID equivalence defect. Luna added a failing fixture and restored the
  old truthiness condition. Parent checked the correction. Final review remains.
- M08: Sol `b01da1ff4232` adds a weak comparison cache to SynchronizerRegistry.
  Context only delegates. The checkpoint must be deeply frozen, with matching
  root and policy. Mutation synchronizers remain separate. Ten focused tests
  pass. Disabling reuse, weakening the witness, and ignoring policy each fail
  their regression checks. Parent inspected and integrated the three files.
- M12: Sol `8e67bc38256e` removes retry listeners on normal and abort settlement.
  New tests fail before repair. All 31 reranker tests pass in the worker and
  main checkout. Parent and independent Sol review find no concrete defect.
- M13: The same Sol worker protects allocations from the first successful
  allocation, including copy failures. Eleven fault cases fail before repair.
  All 25 tests pass, including native tests. Parent integrated the changes.
  Independent Sol review finds no concrete defect.
- M04: Luna `b0684802cea5` owns deferred indexing analysis in an isolated copy.
- M07: Luna `0812a3f48f46` next owns continuation allocation and trusted reads.
- M09: Sol `b01da1ff4232` next owns synchronizer alias retirement.
- M10: Sol `8e67bc38256e` owns termination draining. Parent review requests
  preservation of ordinary job-error isolation and ownership after failed
  termination. The first passing result is not accepted as final.

M03 measurement: three isolated runs per version use 10,000 documents, 48
terms each, 480,000 postings, and a 6,348,682-byte valid synthetic artifact.
The prior exact artifact was unavailable. Median retained heap is 106.26 MiB
before and 40.43 MiB after. Array buffers grow to 3.66 MiB. Heap plus external
retention falls from 106.39 MiB to 44.22 MiB. Median peak RSS falls from
359,800 KiB to 215,940 KiB. Duration is 419.1 ms before and 326.8 ms after,
but machine load differs, 0.91 versus 4.70. No latency improvement is claimed.
Command: `node --expose-gc --import tsx /tmp/satori-memory-remaining-20261016/measure-m03.mts`.
The two-entry policy remains. Combined retention of two entries is unmeasured.
The proposed 4 MiB expectation was not achieved or claimed.

M08 measurement: three isolated runs use a 1.640 MB synthetic checkpoint with
10,000 files. Median cold acquisition rises from 48.581 ms to 91.948 ms due to
the one-time immutability check. Median warm acquisition falls from 37.746 ms
to 0.000870 ms. One cold plus 30 warm acquisitions falls from 1,197.242 ms to
92.031 ms. Retained heap is 3,224,968 B before and 3,191,768 B after. Median
peak process RSS falls from 304,164 KiB to 136,032 KiB. Load is 2.42 versus
2.30 on 16 logical CPUs. These are acquisition measurements, not request latency.
Command: `flock /tmp/satori-memory-remaining-20261016/heavy.lock bash /tmp/satori-memory-remaining-20261016/run-m08.sh`.

## Scope and authorization

Hamza requested a repository memory audit, then authorized scoped repairs through
Claive using `gpt-6-luna` at `max` and `gpt-6.1-sol` at `medium` or `low`.
Reuse the completed audit evidence. Do not repeat the repository audit.

Initial TaskStartSnapshot: `40720b71`, current branch, clean working tree.
Hamza later authorized committing all current changes, including the existing
Python relationship repair, and requested the M03/M04 design update below.
No push, branch change, release, dependency change, or production data mutation
is authorized. Documentation belongs in `docs/improvements/`.

Decision: code-change. Resource owners lose cleanup responsibility or allocate
more than their intended bounds permit. Documentation alone cannot repair them.
Initial implementation batch: M01, M02, and M06. Other findings remain recorded
for later bounded slices. This document is also the durable repair checkpoint.

## Evidence and coverage

The audit inventoried 347 non-test TypeScript files across Core, MCP, and CLI.
It traced retention and allocation owners and inspected selected native semantic
allocation and cleanup code. The MCP worker read all 19 production server files,
the complete SyncManager, and all eight production Core sync files. Search
coverage followed lifecycle, continuation, freshness, retrieval, and cache owners.
This is owner-level coverage, not a claim of complete source-line coverage.

Baseline audit worker: `5a9fe9bd6625`, Sol 6.1 xhigh. Its retained Claive report
contains the watcher, blocked-output, and synchronizer-alias reproductions.
The parent independently ran those three reproductions against current source
and the installed MCP SDK. Other measurements below came from isolated parent
experiments. No production indexing, paid API calls, or production-data changes
were needed. Scratch files were removed after the audit.

The initial live RAM snapshot was not a leak diagnosis. Existing indexing
measurements are historical, not new measurements from this audit. Existing
focused tests passing did not prove that the repository was leak-free.

## Findings

| ID | Owner | Evidence and effect | Repair direction | State |
|---|---|---|---|---|
| M01 | `packages/mcp/src/server/shared-runtime-transport.ts`, `BoundedSocketTransport.send` | Request IDs leave admission accounting before response writes settle. A blocked SDK peer retained 4,201,526 output bytes and 64 handlers while the transport reported zero pending IDs, despite its 16-request limit. | Retain request ownership through writes. Bound all outgoing frames, including notifications, using the existing size and count ceilings. Replace oversized responses with a bounded call error. | Repaired and reviewed, 31 focused tests pass |
| M02 | `packages/mcp/src/core/sync.ts`, watcher registration and shutdown | Registration checks the watcher map before awaits. Two registrations created two watchers and shutdown closed only one. A registration also installed a watcher after watcher mode stopped. | Share each root's registration flight. Invalidate and drain registrations before shutdown or unwatch returns. | Repaired and reviewed, 13 focused tests pass |
| M03 | `packages/core/src/vocabulary/service.ts`, preparation and artifact cache | A valid 5.8258 MiB artifact with 10,000 documents and 480,000 postings retained about 105.49 MiB of extra heap after GC. The cache retains two artifacts without an idle or byte budget. | Keep terms encoded, flatten postings, and create matched evidence on demand. | Repaired and reviewed, 17 vocabulary tests pass; opt-in |
| M04 | `packages/core/src/language-analysis/chunks.ts` and indexing read-ahead | A valid 217,795-byte JavaScript fixture with 100 nested functions produced 9,900 chunks containing 24,631,245 bytes of text. Results materialize before indexing queue limits apply. Process peak RSS was 155.33 MiB, including the harness. | Defer indexing strings, bound source read-ahead, and preserve outputs and eager callers. | Repaired with M05; output equivalence and measured limits above |
| M05 | `packages/core/src/language-analysis/source-map.ts`, `Utf8SourceMap` | Three 1 MiB fixtures allocated about 8.904 MiB of heap plus a 1 MiB buffer each. Byte-offset-only callers still construct the dense UTF-16 conversion array. Chunking creates another source buffer. | Build conversion tables lazily, share source bytes, and use a native ASCII witness with Unicode fallback. | Repaired and reviewed; lazy, sharing, Unicode and witness tests pass |
| M06 | `packages/mcp/src/server/provider-runtime.ts`, `createRuntime` | A backend, Context, sync manager, and continuation owner exist before lifecycle startup completes. Failure cleanup closes only embedding and reranker resources. Worker fault injection showed three failed attempts, zero backend closes, zero Context disposals, and three retained owner tokens. | Keep construction ownership local and unwind every resource before rejecting startup. | Repaired and reviewed, 43 focused tests pass |
| M07 | `packages/mcp/src/core/search-result-set-cache.ts` | Byte accounting performs JSON serialization, parsing, and canonical serialization before rejecting oversized entries. A value of 11,173,781 serialized bytes caused temporary heap deltas of 87.96, 87.47, and 87.48 MiB. Lookups clone complete payloads before caller replay/cursor checks. | Use single-pass byte accounting with raw-JSON fallback and trusted frozen inspection. Preserve admission and error order. | Repaired and reviewed, 28 cache/continuation/runtime tests pass |
| M08 | `packages/core/src/core/context.ts`, `getPublicationSourceSynchronizer`, and `sync/snapshot-codec.ts` | Exact-path checks construct a new synchronizer from the complete checkpoint. Reconstruction serializes and reparses the checkpoint, then copies maps. Parent runs on a 10,000-file, 1,457,886-byte checkpoint took 82.33, 64.05, and 62.58 ms. | Reuse comparison synchronizers behind frozen checkpoint/root/policy witnesses at the registry owner. Context delegates. | Repaired and reviewed; 16 combined synchronizer tests pass |
| M09 | `packages/core/src/sync/synchronizer-registry.ts`, full publication and clear callers | Registration retires old aliases only when they reference the same synchronizer object. Four replacement generations retained four distinct synchronizers under five keys. Clearing the family alias left four physical aliases. | Retire aliases and mutation targets with the displaced or cleared synchronizer object. | Repaired and reviewed; 16 combined synchronizer tests pass |
| M10 | `packages/core/src/semantic/wasm/wasm-threaded-analyzer.ts`, `releaseWorker` | The owner clears its worker reference and discards `terminate()`'s promise. Injected delayed termination showed both later idle release and disposal returning before exit. | Retain retiring-worker promises and join them during cleanup. | Repaired and reviewed, 23 tests pass |
| M11 | `packages/mcp/src/core/working-tree-state.ts` and the module-level `read_file` cache | Expiry controls freshness but does not remove abandoned roots. A reproduction retained all 25 expired roots after accessing another root. Each entry can retain its changed-file set. | Bound roots and prune expired entries at the cache owner. | Repaired and reviewed, 21 tests pass |
| M12 | `packages/core/src/reranker/voyageai-reranker.ts`, `delayBeforeRetry` | Five completed retry delays left five abort listeners on the same signal. Listeners survive until cancellation or collection of that signal. | Remove the abort listener when the delay completes normally. | Repaired and reviewed, 31 tests pass |
| M13 | `packages/core/src/semantic/wasm/wasm-engine.ts`, `WasmSemanticSession` allocations | Allocations happen before cleanup protection. A later allocation returning zero left one prior allocation unfreed in `addSource` and two in `addAuxiliary`. | Protect ownership from the first successful allocation. | Repaired and reviewed, 25 tests pass |

M03 is not a default-runtime RAM explanation. Vocabulary indexing and search are
off by default. Indexing requires `SATORI_REPOSITORY_VOCABULARY_INDEX=1`, and search
requires its experiment flag. See [the experiment record](repository-vocabulary-experiment.md).
The artifact size bound does not describe expanded posting memory.

M09's accumulation affects a reused Core Context. Ordinary supervised MCP
mutation workers exit, which limits exposure across production worker runs.
M12 and M13 are real cleanup defects, but their demonstrated retained allocations
are smaller than M01-M08. Measurements are fixture observations, not guaranteed
production savings or an explanation of the earlier live process snapshot.

## Additional observations and exclusions

- Failed Potion workers retain their stdout buffer until explicit close. Direct
  field injection retained 4 MiB, but that bypassed the real 1 MiB frame bound.
  Do not treat that injected size as a production-sized leak. This is a lower
  priority bounded-retention observation, not a new unbounded finding.
- `runBoundedWorkers` returns on the first rejected lane before sibling lanes
  settle. A controlled promise reproduced the helper behavior. A production
  failure path and its memory consequence need a separate bounded check before
  assigning another repair. Do not silently add it to this batch.
- Vocabulary construction checks byte capacity after encoding and serialization.
  The existing experiment record already discloses this opt-in limitation.
- Navigation state shares in-flight loads, replaces old publication identities,
  and releases idle roots. Publication read leases use `finally` cleanup.
- Periodic synchronization schedules its next pass after the current pass
  settles. LateOn's ready queue has a limit and removes abort listeners.
- CLI model acquisition streams downloads, checks artifact size, and uses a
  bounded worker pool. The audit found no confirmed persistent CLI leak.
- Unchecked areas include generated parser internals, native model allocation,
  every ranking/finalization helper, aggregate multi-session stress, and long
  duration heap behavior. No universal memory-safety claim follows from this audit.
- Jev selection did not run because the task environment lacked its API key.
  Source reads, the Claive review, and deterministic experiments supplied evidence.

## Initial repair batch

Aegis debugging owns repair scope. The existing audit supplies root evidence.
The transport and SyncManager already own these resources. No new domain,
persistence boundary, public configuration, fallback, or dependency is needed.
Each slice must remove the demonstrated ownership gap at its current owner.

TDD mode: off, general route skipped. Repository policy independently requires
deterministic failure-path tests before concurrency/cleanup repairs. Tests must
fail against the broken mechanism and pass after repair. Existing assertions,
fixtures, protocol outputs, and cancellation semantics remain authoritative.

Fit gate: completed audit answers the diagnosis; focused regression commands
check each repair; a wrong repair can leak resources or break cancellation;
Hamza explicitly requests Claive execution with Luna and Sol. Keep one bounded
implementation task per Luna turn. Sol medium reviews the resulting diff.
The parent reads the diff, resolves scope questions, and owns final checks.

1. M01: Luna changes the transport and adds focused transport tests. Preserve
   incoming admission and cancellation. Outgoing frames use existing count and
   size limits, with derived aggregate capacity. Check blocked writes,
   notifications, oversize output, write errors, and close.
2. M02: Luna changes only watcher registration/unwatch/shutdown and focused tests.
   Own one registration per root. Shutdown prevents late installation and joins
   every registration and watcher close. Check overlapping touches, stop during
   registration, unwatch during registration, and restart after stop.
3. M06: Sol medium changes startup cleanup and its focused tests in separate files. Drain synchronization,
   release continuation ownership, close the backend, dispose Context, and close
   providers before rejection. Cleanup failures must not replace the startup
   failure or prevent other resources from being released.
4. Sol medium reviews Luna's completed transport and watcher changes for spec
   compliance, correctness, missing failure paths, and compatibility. Luna and
   the parent review Sol's startup cleanup. Implement only concrete in-scope
   corrections. Do not repeat the memory audit.
5. Run affected checks serially and `pnpm run check` once after the initial
   batch. Record actual results and limits. Keep all changes uncommitted.

## Initial checkpoint

- M01: Luna max worker `80a7fdf290e7` completed implementation. The new failure
  tests failed against old code. Sol medium found an unhandled serialization
  exception in the new path. The parent checked the installed SDK error path,
  accepted the finding, and assigned the narrow correction to Sol. The new
  regression failed before correction. All 25 transport and host tests now pass.
  The parent reviewed the corrected diff. No wider diagnosis was repeated.
- M06: Sol medium worker `b41303f62935` completed implementation. Eleven failure
  cases were red before repair. Provider and shared-runtime tests pass 43 tests.
- M02: Luna completed implementation in its second turn. Seven new lifecycle
  regressions and two related files pass 13 tests. Sol's changed-code review
  passed spec compliance and correctness with no concrete findings.
- Initial `pnpm run check`: lint passed with warnings in unchanged files. Core
  typecheck passed. MCP and CLI typechecks found three missing parameter types
  in the new watcher test. The parent added annotations only. The affected MCP
  and CLI typechecks then passed, as did lint on that test, version freshness,
  and package scope. Passing checks with unchanged inputs were reused.
- Luna's independent startup review passed spec compliance and code quality with
  no concrete defect. The parent reviewed the three scoped diffs and the review
  correction. No functional source changed after its focused passing result.
- Initial batch complete: M01, M02, and M06. The seven focused test files pass
  81 tests in total. Lint, type, version, and package-scope evidence is complete.
  All eight changed or new repository paths belong to this batch and its record.
- Remaining findings retain open status. No repair is complete until its focused
  checks and diff review pass.
- Both reusable workers are closed after their assigned work. Changes remain
  uncommitted. The remaining ten findings stay open and have no implemented fix
  in this batch. No native-model memory reduction or whole-repository leak-free
  result is claimed.
- Next action for a later slice: choose the next recorded finding and resolve
  its bounded owner/design requirements before implementation. Reuse this
  evidence rather than repeating the audit.

## Initial verification commands

Run the focused commands from `packages/mcp` with this common prefix:

```sh
node --import tsx --import ./src/test-state-root.ts --test \
  --test-reporter=../../scripts/satori-test-reporter.mjs --test-concurrency=1
```

Append each group separately. Do not append another default glob.

| Repair | Test paths | Result |
|---|---|---|
| M01 | `src/server/shared-runtime-transport.test.ts src/server/shared-runtime-host.test.ts` | 25 pass |
| M02 | `src/core/sync-watcher-lifecycle.test.ts src/core/sync-ignore-matcher.test.ts src/core/sync-read-freshness.test.ts` | 13 pass |
| M06 | `src/server/provider-runtime.test.ts src/server/shared-runtime.test.ts` | 43 pass |

After the three test-only type annotations, the following root commands passed:

```sh
pnpm --filter @satori-code/mcp run typecheck
pnpm --filter @satori-code/cli run typecheck
pnpm --filter @satori-code/mcp exec eslint src/core/sync-watcher-lifecycle.test.ts
pnpm run versions:check
pnpm run scope:check
```

The earlier complete lint run and Core typecheck passed and their inputs did not
change. The complete `pnpm run check` command itself stopped at the initial
typecheck failure. Its remaining components subsequently passed separately.
Tests use controlled sockets, watchers, and provider seams. They prove cleanup
ownership and bounds, not native model memory use or OS-level stress behavior.

## Brief retrospective: proposals only

- Raw `tsx` tests did not catch three missing mock callback types. The existing
  typecheck caught them later. Proposal: include the affected package typecheck
  in future briefs that add typed test doubles. Existing CI already runs checks
  and tests, so this does not justify another CI gate.
- Luna briefly attempted nested delegation despite being the assigned worker.
  Claive refused the launch. Proposal: begin future briefs with the worker's
  actual model, role, owned files, and immediate executable deliverable. Keep
  parent orchestration instructions outside the implementation assignment.
- Status-only `send --mode now` messages woke an already idle reviewer and
  caused extra acknowledgment turns. Proposal: use `--mode note` for status
  annotations and `followup` for executable work. Reserve steering for an
  observed active turn. No Claive or global skill change is included here.

## M01 refinement and commit preparation

Hamza requested call isolation for oversized responses and authorized committing
all current changes. Luna max worker `491115738ecc` changed the transport and
its focused tests. Oversized results and errors now become an `InternalError`
response with the original request ID. The session and unrelated writes remain
open. The replacement uses the existing byte/count limits and frees its request
slot only after its write completes. If the replacement itself cannot fit,
the transport retains the existing close behavior. Oversized requests and
notifications, serialization failures, write failures, and overload retain
their existing behavior.

Two new regressions failed before the production repair. After repair, the
parent independently ran all 31 transport and host tests successfully. The SDK
integration test receives the size error and completes a later call on the
same session. Sol medium reviewed the refinement and found no concrete defect.
The complete `pnpm run check` command reached successful lint, all three package
typechecks, version freshness, and package-scope checks. Lint retains warnings
in unchanged files. The existing Python relationship repair also passes its
15 focused tests. Previous unchanged M02/M06 results remain applicable.

Commit scope includes the initial repair batch, this refinement, this document,
its README entry, and the existing Python relationship repair. No push is
authorized. M03 and M04 below remain proposals, with no implementation or new
memory measurement claimed.

## Approved design baseline for items 10 and 9: M03 and M04

Hamza supplied both proposals. Sol medium worker `935c35d2f6be` assessed the
owning code without repeating the audit. Hamza later authorized implementation.
The following design is historical. The completed checkpoint above records
the final implementation, checks, measurements, and remaining limits.

### Item 10 / M03: compact vocabulary cache

Replace retained posting and evidence objects with a stem-to-offset/count map
and flat `Uint32Array` posting pairs. Each posting identifies its destination
document and its origin document, term position, and link type (`via`). Prove
that the packed representation fits the existing document and term limits.
Keep line numbers in their original term tuples because valid line numbers
are safe integers and need not fit in 32 bits.

Recompute weights with the current expressions. Keep document, posting, and
query-term order so score accumulation remains identical. Create evidence
objects during lookup instead of retaining one object per posting. Preserve
first-stem-wins behavior, self/parent/call precedence, same-file parent checks,
fan-in cutoffs, identifier-only links, link caps, aliases, ties, and limits.
Preserve the full document argument supplied to an `accepts` predicate through
on-demand materialization. Preserve isolation of returned objects.

**Change to the supplied proposal:** `codec.ts` currently expands every encoded
term before `service.ts` receives it. Keeping dictionary indexes also requires
a codec-owned validated compact representation. Share authoritative validation
with the existing expanded decoder. Preserve the existing decoder output and
artifact format. Do not duplicate decoding rules inside `service.ts` merely
to claim a one-file implementation. The service remains the cache and ranking
owner. Proposed production files are `vocabulary/codec.ts` and
`vocabulary/service.ts` under `packages/core/src/`.

Use a frozen old implementation as an independent full-result reference.
Compare cold and cached results, exact scores, ordered evidence, provenance,
filter arguments, and returned-object isolation. Cover self, parent, and call
links, more than eight callers, the 96-link and per-link limits, identifier-only
filtering, duplicate stems, accepts filters, limits 0/4/N, alias rejection, and
ties. Preserve malformed-artifact tests. Break `via` decoding, confirm that
the differential test fails, then restore it.

Measure compaction before adding retention policy. The supplied estimate of
about 4 MB is unmeasured. Keep the two-entry cache initially. Add no idle timer
or byte budget unless measurements show that two compact entries retain too
much memory. The remaining design decision is the compact codec boundary.
The supplied one-day estimate remains provisional until the brief is complete.

### Item 9 / M04: defer indexing chunk strings

Keep the public `CodeChunk` shape and eager `buildAnalysisChunks` output.
Preserve duplicate text from nested symbols because removing it changes search
results. The repair changes when indexing creates strings, not which chunks
the system publishes.

Use one deterministic span iterator in `language-analysis/chunks.ts`, yielding
start byte, end byte, and symbol index. Define an absent-symbol value for gaps.
Keep symbol order, overlap, UTF-8 boundaries, coverage merging, and whitespace
gap rules. `buildAnalysisChunks` materializes this iterator for existing
callers. Indexing consumes spans and creates each chunk string as the bounded
consumer needs it. The iterator avoids retaining all 9,900 plan records.
Queued embedding payloads still own their strings until processing completes.

**Resolved unknown:** `buildSymbolRecordsForFile` does not read chunk content.
When indexing supplies extracted symbols, the function returns before using
chunks. Its legacy fallback uses metadata and spans. Symbol generation does
not require eager indexing chunk strings.

**Change to the supplied proposal:** the analysis service and its thread and
process runners also create eager chunks. A pipeline-only change leaves that
allocation intact. Introduce an internal indexing analysis contract carrying
source ownership and structural evidence. Transfer serializable evidence
through workers and create the iterator in the consuming process. Generators
cannot cross worker communication boundaries. Preserve the exported analysis
service and port contracts. Preserve ordinals and partial-file behavior at
`INDEX_CHUNK_LIMIT`, using a count pass or one-item lookahead where required.

The existing resource planner owns budget policy. The pipeline owns source
reservations and release. Add retained-source byte admission beside the file
count limit. Reserve before reads and reconcile with actual source size.
Always admit the current file so indexing progresses. Pause further read-ahead
when that file exceeds the budget. Drain started work and release reservations
on success, failure, cancellation, and early limits. Source bytes are not a
complete process-memory budget. Parsers, strings, source maps, worker copies,
symbols, and queued projections also consume memory. Keep M05 separate.

Proposed production boundaries are chunking, the analysis service and worker
runners, indexing consumption, and `indexing/resources.ts`. Change `Context`
only if composition wiring requires it. Add no domain policy to `Context`.
Before implementation, decide the internal contract, budget derivation, and
oversized-current-file reservation policy. The supplied 1–2-day estimate is
provisional because worker delivery adds scope to the original proposal.

Compare complete materialized chunk lists against a frozen old reference.
Cover nested and overlapping symbols, UTF-8 edges, whitespace gaps, missing
spans, and chunk-size/overlap edge values. Compare published rows and ordering
for analysis window 1 versus the default, including owners, identifiers,
projections, duplicate text, and chunk limits. Cover local, thread, and process
delivery, byte admission, oversized-file progress, and reservation cleanup.

### Measurements, execution, and stopping condition

For each finding, use the same audit fixture before and after. Report medians
from at least three runs, commands, machine load, retained heap, peak RSS,
and external/array-buffer memory. State whether RSS includes worker processes.
The M04 fixture is the 217,795-byte source with 100 nested functions.

The parent resolves the design and writes one bounded Luna max brief per
slice. Sol 6.1 medium reviews the implementation. Heavy checks run serially.
Neither finding becomes repaired until equivalence tests, mutation checks,
focused checks, diff review, and measurements support the claimed outcome.
