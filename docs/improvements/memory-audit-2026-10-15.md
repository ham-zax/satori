# Memory audit and scoped repairs, 15 October 2026

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
| M03 | `packages/core/src/vocabulary/service.ts`, preparation and artifact cache | A valid 5.8258 MiB artifact with 10,000 documents and 480,000 postings retained about 105.49 MiB of extra heap after GC. The cache retains two artifacts without an idle or byte budget. | Compact postings and bound retained memory at this owner. Preserve vocabulary results and provenance. | Open, opt-in path |
| M04 | `packages/core/src/language-analysis/chunks.ts` and indexing read-ahead | A valid 217,795-byte JavaScript fixture with 100 nested functions produced 9,900 chunks containing 24,631,245 bytes of text. Results materialize before indexing queue limits apply. Process peak RSS was 155.33 MiB, including the harness. | Bound chunk production and read-ahead retention while preserving output and order. | Open, design required |
| M05 | `packages/core/src/language-analysis/source-map.ts`, `Utf8SourceMap` | Three 1 MiB fixtures allocated about 8.904 MiB of heap plus a 1 MiB buffer each. Byte-offset-only callers still construct the dense UTF-16 conversion array. Chunking creates another source buffer. | Construct conversion data only when needed. Share source bytes and prove Unicode equivalence. | Open |
| M06 | `packages/mcp/src/server/provider-runtime.ts`, `createRuntime` | A backend, Context, sync manager, and continuation owner exist before lifecycle startup completes. Failure cleanup closes only embedding and reranker resources. Worker fault injection showed three failed attempts, zero backend closes, zero Context disposals, and three retained owner tokens. | Keep construction ownership local and unwind every resource before rejecting startup. | Repaired and reviewed, 43 focused tests pass |
| M07 | `packages/mcp/src/core/search-result-set-cache.ts` | Byte accounting performs JSON serialization, parsing, and canonical serialization before rejecting oversized entries. A value of 11,173,781 serialized bytes caused temporary heap deltas of 87.96, 87.47, and 87.48 MiB. Lookups clone complete payloads before caller replay/cursor checks. | Avoid redundant size-accounting copies. Perform metadata checks before copying payloads where the existing contract permits. | Open |
| M08 | `packages/core/src/core/context.ts`, `getPublicationSourceSynchronizer`, and `sync/snapshot-codec.ts` | Exact-path checks construct a new synchronizer from the complete checkpoint. Reconstruction serializes and reparses the checkpoint, then copies maps. Parent runs on a 10,000-file, 1,457,886-byte checkpoint took 82.33, 64.05, and 62.58 ms. | Reuse immutable validated checkpoint state behind its publication witness. Keep Context as a facade. | Open |
| M09 | `packages/core/src/sync/synchronizer-registry.ts`, full publication and clear callers | Registration retires old aliases only when they reference the same synchronizer object. Four replacement generations retained four distinct synchronizers under five keys. Clearing the family alias left four physical aliases. | Retire root/publication aliases together at the registry owner. | Open, reused Core contexts |
| M10 | `packages/core/src/semantic/wasm/wasm-threaded-analyzer.ts`, `releaseWorker` | The owner clears its worker reference and discards `terminate()`'s promise. Injected delayed termination showed both later idle release and disposal returning before exit. | Retain retiring-worker promises and join them during cleanup. | Open |
| M11 | `packages/mcp/src/core/working-tree-state.ts` and the module-level `read_file` cache | Expiry controls freshness but does not remove abandoned roots. A reproduction retained all 25 expired roots after accessing another root. Each entry can retain its changed-file set. | Bound roots and prune expired entries at the cache owner. | Open |
| M12 | `packages/core/src/reranker/voyageai-reranker.ts`, `delayBeforeRetry` | Five completed retry delays left five abort listeners on the same signal. Listeners survive until cancellation or collection of that signal. | Remove the abort listener when the delay completes normally. | Open, small retained closures |
| M13 | `packages/core/src/semantic/wasm/wasm-engine.ts`, `WasmSemanticSession` allocations | Allocations happen before cleanup protection. A later allocation returning zero left one prior allocation unfreed in `addSource` and two in `addAuxiliary`. | Protect ownership from the first successful allocation. | Open, allocation-failure path |

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

## Proposed repairs for items 10 and 9: M03 and M04

Hamza supplied both proposals. Sol medium worker `935c35d2f6be` assessed the
owning code without repeating the audit. Both findings remain **open**.
The order is item 10 (M03), then item 9 (M04). These are designs, not completed
repairs or measured improvements.

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
