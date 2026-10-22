# Agent-ready edit freshness plan, 22 October 2026

Status: A0 and A1 done, results below. D1, D2 and D3 approved by Hamza on 22
October 2026, as recommended. The reranker is the largest search cost. D4 is
open. A3 done (limits 32). A2 done as the claim-4 fix only (see "A2 results").

## Goal

An AI agent saves one or many files, then searches. The next `search_codebase`
call must return results from the saved content, with ignore policies applied,
or say clearly which paths it could not freshen. Target: the search sees the
change within about 150 ms of the save for up to 50 changed files. That number
is an estimate and Task A0 must confirm it. Navigation (call graph,
relationships) may lag, but must mark affected files as pending.

## Why this work is needed (evidence)

- trufflehog, 3,288 Go files, one-line edit to `main.go`: sync wall 15.0 s
  after `8e6893a0`. The search payload delta (chunk, embed, write) is 279 ms.
  The rest is navigation work and process start (`sync.publication_*` spans).
- Search does not wait for a sync. `search-frontdoor.ts:242` serves the previous
  publication while a sync runs (`served_previous_generation`).
- Satori already has a dirty-file overlay:
  `SearchQuerySupport.buildDirtyFileSearchResults`
  (`packages/mcp/src/core/search-query-support.ts:415`), called by
  `runDirtyOverlayPass` (`search-execution.ts:611`). It has four limits that
  defeat agents:
  1. It is off while a sync runs: `search-execution.ts:569-571` and
     `search-request-coordinator.ts:1261`. Commit `56eb6b32` ("isolate stale
     publication search evidence") made this deliberate. The same mode also
     turns off tracked lexical search, the reranker
     (`search-rerank-execution.ts:699`) and the exact fast path
     (`search-exact-fast-path.ts:291`). The commit message gives no reason,
     but the commits before it do (see "A0 results").
  2. The dirty set comes from `git status` (`working-tree-state.ts:138`,
     `execFileSync` with a TTL cache). It misses edits that the agent has already
     committed but Satori has not synced. It is unavailable outside git.
  3. At most 16 files (`SEARCH_DIRTY_OVERLAY_MAX_FILES`,
     `search-query-support.ts:53`) and a total byte cap.
  4. Lexical only, with a flat score of 1 (`search-query-support.ts:406`).
- Watcher events do not start a sync. `onPathChange` (`sync.ts:2201`) records an
  event reason only, not the path. The background interval is 3 min
  (`config.ts:47`).
- `Synchronizer.compareSourceToOwnedCheckpoint` (`synchronizer.ts:504`) already
  diffs the tree against the publication checkpoint. It returns only
  `matches | differs | unavailable`, not the changed paths.

## Constraints

- No partial publication. The overlay is query-time evidence only and never
  writes to a publication.
- Root-bound reads with the existing checks (`openRegularFileInsideRoot*`).
- Ignore policy: the overlay must use the active ignore matcher
  (`buildActiveIgnoreMatcher`), as it does today.
- Bounded work for each query: file count, bytes and time limits stay, with
  higher values.
- Deterministic ordering for equal scores.
- Concurrent sessions: two Claude windows can share one root.
- `Context` gains no new domain logic (AGENTS.md "Ownership").

## A0 results (22 October 2026)

Command: `node scripts/perf/index-probe.mjs ../trufflehog --save-search 1,16,50
--ext .go --runs 3` under `systemd-run --user --scope -p MemoryMax=5G`. trufflehog
working tree clean after the run. Index wall 25,129 ms, peak tree RSS 1,950 MB,
load average 3.4 to 4.0. Medians of 3 runs:

| N files | Idle: first search | Idle: hits | Sync running: first search | Sync running: hits | Save to all hits (sync) |
|---|---|---|---|---|---|
| 1 | 5,762 ms | 1/1 | 74 ms | 0/1 | 21,007 ms |
| 16 | 4,356 ms | 16/16 | 121 ms | 0/16 | 19,715 ms |
| 50 | 4,904 ms | 16/50 | 118 ms | 1/50 | 20,293 ms |

"Idle" means no sync: `freshnessDecision.mode = read_only`, the overlay runs.
"Sync running" means the search right after `manage_index sync` is accepted:
`served_previous_generation`, `freshness.state = sync_in_progress`,
`changedFileCount = 0`. Sync wall 16.2 to 18.6 s.

Observations:

1. The read-your-writes inversion is real. Idle search finds the edit. Once a
   sync starts, search returns 0 of the edits for about 17 s, then finds them
   after publication.
2. The 16-file overlay cap is real (A3): 50 edited files give 16 or 17 hits.
3. New: idle search takes 3.2 to 6.2 s. Clean searches after the sync
   (`skipped_source_unchanged`) also take 5.3 to 7.5 s. The search during a
   sync takes about 120 ms, with the reranker and tracked lexical search off.
   So the overlay is probably not the main cost. The likely cost is the reranker
   (`RERANKER_INPUT_DEGRADED` appears) or tracked lexical search.

Second run, same command, phases over 100 ms from
`hints.debugSearch.phaseTimingsMs` (index wall 26,395 ms, peak RSS 1,934 MB,
load 1.7 to 4.3). Medians of 3 runs:

| Phase | Idle N=1 | Idle N=16 | Idle N=50 | First search after publication N=1 / 16 / 50 |
|---|---|---|---|---|
| `rerank` | 3,997 ms | 4,041 ms | 3,747 ms | 4,602 / 5,184 / 2,166 ms |
| `ensureFreshness` | 360 ms | 477 ms | 686 ms | 181 / 334 / 671 ms |
| of which `freshnessExactPathComparison` | 311 ms | 403 ms | 570 ms | 121 / 270 / 606 ms |
| `completionProof` (inside `prepareRead`) | under 100 ms | under 100 ms | under 100 ms | 2,643 / 2,270 / 2,304 ms |
| `trackedLexical` | up to 190 ms | up to 190 ms | up to 172 ms | about 125 ms |
| search wall | 4,706 ms | 4,979 ms | 4,793 ms | 7,956 / 8,143 / 5,405 ms |

The overlay pass itself stays under the 100 ms report floor. The ranked costs
on the save-to-search path:

1. `rerank` (LateOn on CPU, the probe uses it when `~/.satori/models/lateon`
   exists): 2.0 to 5.4 s on every search that has the reranker on. This is
   about 80% of the idle search wall.
2. `completionProof`: about 2.3 s on the first search after a new publication.
3. `ensureFreshness` / `freshnessExactPathComparison`: 0.3 to 0.7 s, grows with
   the dirty file count.

The 150 ms goal is impossible while the reranker runs on the query path. The
order of work changes: the reranker cost needs a decision (a budget, a skip
for exact-term queries, or a skip for overlay-only hits) before the overlay
work (A1 to A4) can show a user-visible gain. That decision is a new open
decision (D4), not part of A1 to A4.

D1 reason (verified in git): `a91287cc` ("docs(plan): qualify stale-while-sync
MVCC repair", plan file since removed from the tree) defined
`served_previous_generation` as "a publication-only read mode, not a
working-tree overlay ... must never generate, suppress, rewrite, preview, or
rerank results in this mode". `12e7c2b2` added
`search-execution.stale-publication.test.ts`, which asserts
`dirtyOverlay === 0` (line 158). `56eb6b32` implemented it. So D1 reverses a
documented contract, not an accident.

`RELATIONSHIP_SHARD_IO_CONCURRENCY = 8` came from `b6a7cb17` ("perf(core):
bound native Python relationship costs"). The hard-link reuse branch
(`sidecar-writes.ts:655-664`) runs inside the same batch loop of 8. A separate
limit for links is a B2 idea that needs a measurement.

## A1 results (22 October 2026)

A1 keeps the dirty overlay and the stale-hit suppression on in
`served_previous_generation`. The reranker, tracked lexical search, the
changed-first boost, the live path supplement and the exact source preview stay
off. A dirty exact target or a dirty relationship peer now makes the exact fast
path defer to full search, so the overlay answers for it. The
`freshness` block adds `overlaidPaths` (sorted dirty paths answered from the
working tree, absent when empty).

Same probe as A0 (trufflehog, `.go`, 3 runs, 5 GB cgroup), first search after
the save, during a running sync:

| N edited | A0 hits | A1 hits | A1 first search | A1 save to all hits |
| --- | --- | --- | --- | --- |
| 1 | 0/1 | 1/1 (3 runs) | 169-219 ms | 1.7-2.1 s |
| 16 | 0/16 | 16/16 (3 runs) | 216-230 ms | 1.8-2.0 s |
| 50 | 0/50 | 16-18/50 | 222-255 ms | 18.3-20.0 s |

At N = 50, the 16-file overlay cap limits hits until the sync publishes. A3
owns that cap. Idle searches (no sync) are unchanged at 4.0-7.3 s, and rerank
takes 3.1-6.5 s of that (D4).

## A3 results (22 October 2026)

A `search.dirty_overlay` perf span measured the overlay with the limits raised
for one run (trufflehog, `.go`, 3 runs, idle and during a sync). The cost is
linear at about 3.2 ms per file: 16 files 48-91 ms, 64 files 201-723 ms, 200
files 590-1,460 ms. During a sync, the first search took 233-338 ms (16 files),
403-416 ms (64) and 844-916 ms (200). Until A2, the dirty set comes from
`git status`, so every search with uncommitted files pays this cost. A3 sets
the file limit and the result limit to 32 (about 100 ms) and keeps both byte
limits. At 64 and 200 edited files, search showed only 42-43 and 150-164 hits
even with every file overlaid. A different limit causes that, not yet found.

## A2 results (22 October 2026)

D2 is REPLACED. A watcher-based dirty set was built and measured: the first
search after a save found 0 edited files and 0 hits in 3 of 3 runs (N=1) and
in 1 of 3 runs (N=16, N=32), because the watcher event arrives after the
search. Only `git status` reads the disk at search time, so search keeps it.
Hamza chose to keep only the claim-4 fix: `SyncManager.assessReadFreshness`
skips the whole-tree source comparison when an earlier comparison found
differences against the same checkpoint and no watcher event arrived since
(`RootWatcherObservation.differingComparison`, dropped when coverage leaves
`ready`). Probe (trufflehog, `.go`, `--save-search 1,16,32 --runs 3`, idle):
first searches found every edited file (1/1, 16/16). The second and later
repeat searches no longer pay `freshnessExactPathComparison` (A1: 297-583 ms
on every repeat). The first repeat can still pay about 300 ms when the watcher
event arrives after the first search. The probe stopped at N=32 in both runs
with "Mutation 'sync' is already in progress"; cause not found.

## D4 and B1 results (22 October 2026)

D4: `rerankAllowed` is false for a single bare lowercase word
(`search-query-planning.ts`). Dirty overlay candidates carry
`dirtyOverlaySourceHash`, the SHA-256 of the bytes the overlay read, and
rerank projection checks the live file against that hash instead of the
publication hash (`search-rerank-projection.ts`). B1: perf spans
`sync.parent.garbage_collect`, `sync.parent.flight_complete`,
`status.symbol_registry_read`, `status.navigation_manifest`,
`status.navigation_relationships`.

Probe (trufflehog, `.go`, `--runs 3`, load 1.2-2.4). N=32 idle, 8459fa0e
(A3) against D4: first search 4,006-7,276 ms (median 5,373, `rerank`
2,848-5,644 ms, 62-76 candidates) against 837-1,205 ms (median 891, no
rerank); repeats 3,366-6,140 ms against 448-461 ms. N=1 and N=16 idle first
searches 494-1,084 ms and 604-957 ms, every file a hit. Searches during a sync
are unchanged (299-311 ms at N=32). Neither run hit the "sync already in
progress" failure, so that failure is intermittent, not caused by A2.

N=32 finds 26 of 32 files in every run, on 8459fa0e too. Leading cause, not
proven: the overlay keeps 32 results (`SEARCH_DIRTY_OVERLAY_MAX_RESULTS`) and
some files give more than one matching chunk. A read-only trace also found
that raw `debugMode: "full"` responses are trimmed to a 2 MiB budget without a
removal record, which may explain the 64/200 counts in "A3 results".

B1 spans, same run: `status.symbol_registry_read` costs 853-1,523 ms (median
935, 263 calls) on every status call; `status.navigation_relationships` is
0 ms except a few cold reads up to 1,371 ms; garbage collection and flight
completion have medians under 1 ms. The parent-side cost is the status path
rereading the symbol registry sidecar, multiplied by the probe's 100 ms status
polling.

## Status registry read results (22 October 2026)

Status reads the symbol registry through `JsonNavigationStore`
(`getSymbolRegistrySidecarRead`); a publication's navigation directory is
immutable, so the publication identity is the witness. `Context` only
delegates (`readPublicationSymbolRegistry`). Probe (trufflehog, `.go`,
`--save-search 1,16 --runs 3`, load 6.2 falling to 2.6, index peak tree RSS
1,940 MB): `status.symbol_registry_read` median 0.1 ms (0.1-0.5 ms, 1,210
calls) against 935 ms (853-1,523 ms, 263 calls). Every N=1 and N=16 search
hits every edited file.

## Exact-match pinning results (22 October 2026)

User decision: a single bare lowercase word (`singleBareLookup`) turns on
`exactMatchPinningEnabled` (`search-query-planning.ts`), so hits with a whole
term match sort above dense hits without it before the request limit. Risk
accepted: a search for one common word acts like grep. Golden tests are
unchanged (34 pass). Probe (trufflehog, `.go`, `--save-search 32 --runs 3`,
load 2.6-3.3, index peak tree RSS 2,002 MB): 32 of 32 edited files in every
run, against 26 of 32. First searches: idle 842-1,342 ms (median 850, against
891 for D4), during a sync 199-301 ms.

## B2 results (22 October 2026)

`buildRelationshipDelta` (`relationships/builder.ts`) returns
`filesToRewrite`: the affected files whose records or analysis evidence differ
from the previous shard, plus every changed file. Evidence is snapshotted
before the rebuild because `attachResolutionClaims` replaces it. The
publication links all other relationship shards. The comparison is
language-agnostic. Semantic evidence still marks every file of its language as
affected, and only the shard rewrite is narrowed. A first version with
key-sorted canonical JSON added 1,700 ms to `relationship_delta`. Plain
`JSON.stringify` replaced it: a representation-only difference rewrites the
shard, which is safe.

Probe (trufflehog, `.go`, `index-probe.mjs ../trufflehog --save-search 1 --ext
.go --runs 3`, load 1.6-4.3), one N=1 sync, before → after:

- Shards rewritten: 3,289 → 149 (`rewriting 148` of 3,288 owners).
- `navigation.stage.write relationships`: 4,197 ms → about 155 ms.
- `navigation.stage.fsync_tree`: 610 → about 125 ms.
- `sync.publication_sidecar_stage`: 1,870 → 940-1,041 ms.
- `sync.publication_relationship_delta`: 289-297 → 624-672 ms.
- `syncWallMs` median: 13,906 → 12,569 ms.

This probe does not record peak memory. The N=16 trial failed with
"Mutation 'sync' is already in progress", the known intermittent failure, so
N=16 has no after numbers. Go semantic analysis (`navigation.semantic go`,
about 3,960 ms) is now the largest sync cost.

## Commit gap (gap 1) design (22 October 2026)

Evidence: a throwaway 6-file TypeScript repository (temporary HOME, build
`1e59127f`). An uncommitted edit is found through the overlay. Right after
`git commit`, two searches miss it: `git status` is empty, so the overlay has
no paths, and search serves the old publication with `SOURCE_CHANGES_PENDING`.
An automatic sync (`Trigger: watcher_pending`) closes the gap within 3 s on
this repository. On trufflehog one sync takes about 12.6 s.

Mechanism: with the watcher observation still pending, every search runs the
full source comparison (`compareAllSourceToFreshnessCheckpoint`). The
synchronizer computes `prepared.changes` (added, modified, removed) and
returns only `differs`.

Design:

- `SourceFreshnessPathComparison` `differs` carries optional sorted
  `changedPaths` from `compareSourceToOwnedCheckpoint`
  (`core/src/sync/synchronizer.ts`). The synchronizer stays the owner of
  "which paths differ from the publication".
- `assessReadFreshness` (`mcp/src/core/sync.ts`) reports them through a new
  `onSourceChangedPaths` option, like `onPhaseTiming`. `FreshnessDecision`
  and the response shape do not change.
- The search coordinator adds the reported paths to a copy of the
  `git status` set before the overlay reads it. If `git status` is not
  available, the overlay stays off, as before.
- The fix is language-agnostic. Existing overlay limits (32 files) apply.

Checks: a `sync-read-freshness.test.ts` case for the callback, a synchronizer
case for `changedPaths`, and the commit-gap probe (the search after the commit
must find the edit).

Gap 1 results: `sync-read-freshness.test.ts` 9 pass (the new case fails with
the callback off), `synchronizer-registry.test.ts` 14 pass. Commit-gap probe:
step B (search at once after `git commit`, no sync) now returns
`src/mod2.ts` with `overlaidPaths: ["src/mod2.ts"]`. Before the fix it
returned no files.

## Remaining work (22 October 2026, after D4 and B1)

In this order:

1. **Probe misses.** `scripts/perf/index-probe.mjs` records `resultCount`,
   `missedCount` and up to 10 sorted `missed` paths for each search, so a
   partial hit count names the lost files.
2. **Status registry read (done, see "Status registry read results").** `status.symbol_registry_read`
   (`manage-maintenance-handlers.ts`) rereads the whole symbol registry
   sidecar on every status call, median 935 ms. Cache it behind a witness for
   the publication, with a differential test and a mutation check.
3. **Fusion ties for exact matches (done, see "Exact-match pinning results").** N=32 finds 26
   of 32 files. The probe shows `resultCount` 52 (the request limit) and
   `editedResultCount` 26, so the overlay cap is not the cause. In one dumped
   response, results alternate between an overlay hit (content has the term,
   `baseScore` 1) and a dense `primary` hit without the term (`lexicalScore`
   0) at the same RRF score (`rrfK` 60, equal ranks tie), so the request
   limit keeps 26 of each. `exactMatchPinningEnabled` is false for this
   single-word "uncertain" query. A fix changes search ranking.
4. **B2 (done, see "B2 results").** Narrow relationship rewrites.
5. **A4.** Dense overlay scores; the embedding-cache design goes to the user
   first.
6. **B3.** Debounced automatic sync, only after B1 and B2.

Reported, not scheduled:

- "Mutation 'sync' is already in progress" at N=32 is intermittent; cause not
  known.
- Raw `debugMode: "full"` responses are trimmed to 2 MiB without a removal
  record (`search-result-finalization.ts:491-542`).
- D4 has no search-quality evaluation yet; the golden tests are unchanged.
- Retro proposal: read a worker's report before judging a `claive list`
  "shell: exit 1" flag; the flag also shows red test runs before a fix.

## Decisions

D1, D2 and D3: approved as recommended (22 October 2026). D4: approved
(22 October 2026): skip the reranker for a single bare lowercase word, and
project dirty overlay candidates from the live bytes they were read from.

- **D1. Overlay during a sync.** Recommendation: allow the dirty overlay and the
  stale-hit suppression in `served_previous_generation`. Keep the reranker and
  tracked lexical search off, as `56eb6b32` made them. Response metadata keeps
  `freshness.state = "sync_in_progress"` and adds the overlaid paths. Cost:
  D1 reverses the publication-only contract from `a91287cc` (see "A0
  results") and changes the assertions in
  `search-execution.stale-publication.test.ts` and
  `search-exact-fast-path.stale-publication.test.ts`.
- **D2. Dirty set source.** Recommendation: the watcher records changed relative
  paths for each root since the served publication. The overlay uses that set
  when watcher coverage is `ready`. Otherwise it uses `git status` as today.
  Owner: the existing watcher owner in `packages/mcp/src/core/sync.ts`, not a
  new module. A new publication clears the paths that its checkpoint covers.
- **D3. Dense scores in the overlay.** Recommendation: embed overlay chunks with
  the active embedding provider and score them by cosine similarity, merged as
  today. Cache by `(relativePath, sourceHash)` in the search owner, with a bound
  of entries and bytes. This needs a decision because it adds persistent
  in-memory state and provider calls on the query path. Without D3, an agent
  finds new code only by exact terms.
- **D4. Reranker cost on the query path.** A0 measured `rerank` at 2.0 to 5.4 s
  per search (LateOn on CPU). No option is chosen yet. Possible options: a time
  budget, a skip for exact-term queries, a smaller candidate window.

  Rerank profile (probe with 3 repeated idle searches, `debugMode: "full"`,
  N=1 and N=16, 2 runs, load 0.1 to 4.3): the cost is steady, not a cold
  start. Repeats of one query cost the same as the first search: 2,644 to
  5,662 ms `rerank` for 70 to 74 candidates and 89 to 124 KB of reranker input.
  The `[RERANKER] ... initialized` log lines (30 in one run) come from the
  server plus one per sync worker process (29 `sync.worker.bootstrap` spans),
  not from LateOn restarts. The sizing comment in `lateon-execution-plan.ts`
  reports 1.23 s for 64 candidates (4 sessions x 2 threads, same CPU). The
  probe is 2 to 4 times slower. Not yet known: the session layout the probe
  gets (`planLateOnExecution` sizes sessions from free memory, and the probe
  runs in a 5 GB cgroup), and the effect of other load on the machine. The
  probe term (`satoriprobe...`, lowercase) does not take the
  identifier-intent rerank skip.

## TDD route

Mode `off` (Aegis config), decision `skipped` for strict RED/GREEN. AGENTS.md
still requires a focused regression test for each changed behavior, a
failure-path test, and a mutation check for each cache or fast path.

## Tasks

Each task: focused tests only (`test:raw` flags with the file path), then
`pnpm run check`, then a commit.

- **A0. Measure (no behavior change).** Add a probe mode to
  `scripts/perf/index-probe.mjs`: edit N files (1, 16, 50), then time
  `search_codebase` for a term in the new content, with and without a running
  sync. Record overlay pass time, hit or miss, and `freshness` metadata. Also fix
  the known probe defect (it ignores the create response and has no timeout).
  Read the tests for `56eb6b32` for the reason behind D1.
- **A1. Overlay during a sync (needs D1).** Files:
  `search-execution.ts:569-571`, `search-request-coordinator.ts:1261-1265`,
  response envelope metadata. Tests: a search during a sync returns the new
  content of a dirty file and suppresses its stale indexed hits.
- **A2. Watcher dirty set (needs D2).** Files: `sync.ts` (record paths in
  `onPathChange`, clear on publication), `working-tree-state.ts` (choose the
  source), the coordinator call site. Tests: committed-but-unsynced edit is in
  the set; ignored path is not; watcher overflow or `starting` coverage uses git.
- **A3. Higher bounds.** Raise the 16-file limit to a value from A0 (time per
  file), keep the byte cap, and report unread paths as today.
- **A4. Dense overlay scores (needs D3).** Files: `search-query-support.ts`,
  `search-execution.ts` merge. Tests: differential test that an overlay chunk and
  the same chunk from the publication get the same dense score; cache mutation
  check (break the hash key, confirm the test fails).
- **B1. Parent-side spans.** Time `collectPublicationGarbageAfterSync`
  (`manage-maintenance-handlers.ts:875`) and the status path
  (`context.ts:1191` `getPublicationNavigationStatus`, symbol sidecar read at
  `manage-maintenance-handlers.ts:606`). Decide whether the 3.8 s outside the
  worker is real or a probe artifact (the probe polls status every 100 ms).
- **B2. Narrow affected files** at `packages/core/src/relationships/builder.ts:535-545`
  so unchanged relationship shards link from the previous generation.
  Equivalence test against a full rebuild. Do not change
  `RELATIONSHIP_SHARD_IO_CONCURRENCY` (`sidecar-writes.ts:50`) without a memory
  measurement.
- **B3. Debounced automatic sync** after watcher bursts. Only after B1 and B2,
  because each sync costs 15 s of CPU today.
- **Deferred, design review first:** warm sync worker
  ([change-proportional-sync](change-proportional-sync.md), it changes process
  isolation and cancellation) and incremental semantic analysis
  ([incremental-semantic-analysis](incremental-semantic-analysis.md), the
  provider must own any delta decision).

## Verification at the user-visible seam

The A0 probe, run 3 times before and after each A task: time from save to a
search hit on the new content, for 1, 16 and 50 files, with and without a
running sync. Report medians, peak memory, machine load and the command.

## Risks

- D1 may reverse a deliberate isolation rule.
- Dense scoring adds provider latency to the query path. A0 must measure it.
- Watcher sets can miss events (overflow, restart). The git fallback and the
  checkpoint diff stay as the safety path.
