# Cold search latency: Step 1 result and deferred plan

Date: 2026-11-25
Status: Step 1 committed (`f727bf67`). Steps 2 and 3 deferred. Step 4 is tracked in the
[CBM plan](cbm-upstream-sync-and-dart-span-plan-2026-11-25.md#open-follow-up-go-semantic-resolution-slowdown-deferred).
Scope: the first `search_codebase` call after an MCP server restart. Warm searches are unaffected.

## Decision

Defer Steps 2 and 3 until cold-start search latency is a measured problem for someone. Step 1
took the cheap, safe win. What remains is a few seconds, once per session, and each remaining
step either adds a persisted format (symbol-shard checksums) or changes search ordering and
freshness behavior (watcher overlap). Both need the equivalence tests, differential tests and
mutation checks that `AGENTS.md` requires, for a gain that is not yet shown to matter.

Reopen when: cold first-search latency is reported as a problem, MCP sessions restart often
enough to make it one, or a later change moves the cold-search profile below.

## Step 1: relationship shard checksums (done, `f727bf67`)

Complete publications record `navigation.relationshipManifestHash`, and the relationship manifest
records `shardBytes` and `shardSha256` per file. Search readiness calls
`JsonNavigationStore.verifyRelationships`, which checks shards against those checksums (cached per
publication, with stat-size rejection before buffering) instead of hydrating every edge. A
publication without the hash or the checksums takes the full-parse fallback, so existing indexes
keep working.

Re-verified 25 November 2026 on `trufflehog` (`bcfcf73aa`, 3,454 files in the relationship manifest), `search_codebase`
with `NewDetector`, limit 5, LateOn off, fresh server process per trial, one discarded warm-up per
condition, trials interleaved A/B/A/B/A/B. A is the new publication with checksums. B is a copy of
the same publication with `relationshipManifestHash` deleted, which forces the full-parse path the
old readiness check used.

| Median of 3 | Checksum path | Full-parse path | Change |
|---|---|---|---|
| First search wall | 4,563 ms (4,553 / 4,563 / 4,931) | 5,747 ms (5,499 / 5,747 / 5,886) | -1,184 ms (-20.6%) |
| `search.coordinator_total` | 3,783 ms | 4,954 ms | -1,171 ms |
| `status.navigation_relationships` | 654 ms | 1,672 ms | -1,018 ms |
| Peak tree RSS | 1,181 MB | 1,289 MB | -108 MB |

All eight runs, warm-ups included, returned the same five results (digest `4f5e61b3d4bc`).
Machine load during the trials ranged from 0.95 to 1.53. Each run used
`systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0`, with `SATORI_PERF_TRACE=1` and
the offline profile from `scripts/perf/index-probe.mjs` (Potion, LanceDB, isolated `HOME`).

Limits:

- This is an A/B inside one build, not a comparison of two builds. It isolates the mechanism; it
  does not prove the HEAD~1 build behaves identically to the full-parse path.
- The first handoff reported 0.91 s (16%) and 96 MiB lower RSS from a two-build comparison on a
  saved publication. The only saved `trufflehog` publication still on disk
  (`/tmp/satori-rebench-state`, 1,371 relationship files, no checksums) predates this change, so
  that run cannot be reproduced from disk. The table above is the current evidence.
- Existing publications gain nothing until they are re-published. A full index or a sync writes
  the hash and checksums.
- The checksum pass itself still costs 646 to 759 ms of the remaining cold search.
- Three trials per side on one machine.
- Harness gotcha: a server started with the repository as its cwd runs an automatic `create` at
  startup (about 26 s on `trufflehog`). A manual `manage_index create` sent right after is
  refused as "already in progress". Wait for the automatic operation instead.

## Deferred Step 2: profile cold search by query class (gate for Step 3 and for symbol-shard checksums)

- **Next action:** On a checksum-bearing publication, run three cold-process trials per query
  class: an exact defined symbol (`NewDetectorHttpClient`), a partial identifier (`NewDetector`,
  Step 1's query; it is not a defined symbol in this checkout), and a plain-English conceptual
  query. Record phase timings for the symbol registry load (`buildSymbolRegistry()`),
  `prepareRead`, `assessSearchFreshness`, watcher startup and poll, and vector store open.
  Only `status.*` and `search.*` spans exist today, so add temporary spans or take a CPU profile
  (`--cpu-prof` misses time spent awaiting I/O).
- **Why necessary now:** The handoff put symbol validation at about 2.1 s of a 4.94 s cold search,
  the largest remaining slice. Exact queries load the registry directly
  (`packages/mcp/src/core/search-exact-fast-path.ts:256`), so lazy `SymbolRegistry` loading can
  only help non-exact queries. Whether that is worth a new checksum format depends on measured
  numbers, not on that estimate.
- **Observations from the 25 November runs that Step 2 must explain first:**
  `status.navigation_manifest` was 0.1 ms in all six trials, so the 2.1 s symbol-validation
  figure is not visible in any existing span. `sync.worker.prewarm` lasts 3.7 to 5.0 s, 50 to
  150 ms less than `search.coordinator_total` in every run, and fell by about the same amount
  (about 1.1 s) as the search when Step 1 applied; whether the standby prewarm competes with the
  search for CPU is unmeasured.
- **Stopping condition:** A phase table per query class and a recorded go or no-go on
  symbol-shard checksums with lazy `SymbolRegistry` loading.
- **Estimate, not a measurement:** at best a saving on the order of 1 to 2 s on non-exact
  queries, none on exact ones.

## Deferred Step 3: overlap watcher startup with `prepareRead`

- **Next action:** Start `touchWatchedCodebaseBestEffort` before `prepareRead` in
  `search-request-coordinator.ts`, keeping both `FileSynchronizer` walks while watcher coverage is
  `'starting'`. Measure cold freshness and watcher-ready polling.
- **Why necessary now:** `prepareRead` and `assessSearchFreshness` (about 0.86 s plus up to
  150 ms of polling, per the handoff) currently run serially.
- **Approval:** This changes search behavior (freshness and ordering) and needs a new approval.
  It needs an equivalence test over every freshness state it branches on, written before the
  change, and the background-work rule in `AGENTS.md` (no return or throw while the early watcher
  start is in flight).
- **Stopping condition:** Before and after medians of at least three cold runs on `trufflehog`
  showing a wall-time reduction with identical freshness behavior.
- **Estimate, not a measurement:** the gain is bounded by the serial time above, roughly 1 s.

## Deferred Step 4: Go semantic resolution slowdown

Indexing and sync cost, not search latency, so it is independent of the steps above. Tracked as
an open follow-up in the CBM plan.

## Working rules when this is reopened

One change at a time: equivalence test, then measurement, then commit. Every new cache or witness
gets a differential test against the old path and a mutation check. Report before and after
medians of at least three runs with peak memory, machine load and the command, as above.
