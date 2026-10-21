# Agent-ready edit freshness plan, 22 October 2026

Status: A0 done, results below. D1, D2 and D3 approved by Hamza on 22 October
2026, as recommended. The reranker is the largest search cost. D4 is open, and
a rerank profile comes first.

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

## Decisions

D1, D2 and D3: approved as recommended (22 October 2026). D4: open.

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
