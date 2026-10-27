# Change-proportional edit sync

Status: item 1 implemented and measured; open issues below. Recorded 2026-09-28.
Updated 2026-10-27 07:08 IST.

## Question

Why does syncing a one-line edit take seconds, and how could its cost scale
with the size of the change instead of the size of the repository?

## Findings

Work for the changed file itself (chunking, embedding, symbol extraction) is
well under a second. The rest scales with the repository. On trufflehog
(3,295 Go files) a one-comment edit sync took ~20 s:

| Step | Time | Cause |
|---|---:|---|
| Fresh sync worker process | ~1.2 s | Each sync runs in an isolated, killable process group; nothing stays warm |
| Full-tree change scan | ~2 s | Stats every observed file |
| Reload previous registry and relationships | ~2.5 s | The fresh process has no navigation cache |
| Whole-language semantic analysis | ~4 s | See [incremental semantic analysis](incremental-semantic-analysis.md) |
| Stage navigation sidecars | ~1.9 s | Rewrites or links every shard |
| Pre-activation rescan | ~1.7 s | Proves the source did not change while the candidate was prepared |

Small repositories sync in 2–4 s only because each step is small.

## Proposal

1. Long-lived sync worker per root that keeps navigation state warm between
   syncs, while keeping cancellation and crash containment (today the
   supervisor cancels by killing the worker's process group; see
   `packages/mcp/src/server/mutation-worker-supervisor.ts`).
2. Use the file watcher's change set instead of full-tree scans, with a
   cheaper freshness proof (changed paths plus a watcher sequence), falling
   back to the full scan when the watcher overflowed or restarted.
3. Incremental semantic analysis (separate proposal).
4. Publication that only writes the changed files' navigation data.

Items 1 and 2 change deliberate guarantees (process isolation, source
freshness proof) and need their own design review.

## Design review of item 1 (2026-10-27)

Profile at 5d3b7736 (trufflehog, one-file Go edit, ~12.3 s median): worker
module load ~320 ms, bootstrap ~435 ms, source registry load ~1,090 ms,
relationship sidecar load ~1,320 ms. These ~3.2 s repeat on every sync only
because each sync starts a fresh process.

### Rejected: one long-lived worker per root

`spawnSupervisedMutationWorker` resolves `completion` only after the worker's
process group is proven absent, and `RootMutationRuntime` releases the bound
executor lease on that fence. A worker that outlives its operation breaks the
fence: unsettled work in a live process could still write after the lease is
released. Replacing it with an in-process "drained" claim is a weaker proof.

### Selected: one pre-started standby sync worker

The parent starts the next sync worker before it is needed. The standby
bootstraps and loads the current Publication's navigation state, then waits
for `start`. The worker still exits after its one operation, so the
process-group fence and the cancellation path stay unchanged.

- **Owner.** `packages/mcp/src/server/supervised-sync-worker.ts` owns the
  standby. `ProviderRuntime` constructs it and drains it at shutdown.
- **When it starts.** Automatically, with no user action: when the host
  starts to watch a root, after each sync of that root, and on the first
  watcher change for a root that has no standby (the watcher debounce hides
  part of the preload). The first sync of a session is therefore warm too.
- **Count and memory.** At most one standby in a host, for the root with
  the latest watch or sync activity. A standby for another root replaces it.
  The standby lives while its root is watched; it has no idle exit. Its
  resident memory is measured before this becomes the default.
- **Protocol.** The standby is spawned with its own worker id. The
  `mutation_worker_start` message carries the bound operation id, and the
  child runs `runBoundExecutor` with it. Workers that receive no bound id
  use their spawn id, so the index worker is unchanged.
- **Witness.** The preloaded state uses the existing
  `resolveReusableNavigationDeltaState` check: root, Publication id,
  navigation root and navigation observation token. On a mismatch the sync
  reads the sidecars as today. At `start` the child resolves its config and
  runtime fingerprint again. If they differ from the standby's bootstrap
  input, it rebuilds the provider runtime before it syncs.
- **Before start.** The standby holds no mutation lease and makes no
  Publication write except the startup orphan prune that every Context
  already runs, which skips roots with an active lease. The registry and
  relationship reads hold a process-local Publication read lease. Host GC
  cannot see the child's lease. If GC removes the generation during preload,
  a failed sidecar read falls back to a cold read. Review found no evidence
  of a partial publication from this race.
- **Failure.** If the standby fails, exits, or is not ready, the sync uses a
  fresh worker as today. If the start arrives during preload, the sync
  waits for the preload and then runs.
- **Tests.** Differential: a standby sync and a fresh-worker sync publish
  the same output. Stale witness: a Publication change after preload forces
  the sidecar read. Cancellation: cancel before and after start kills the
  group and publishes nothing. Unwatch, replacement and shutdown leave no
  process.

Expected saving: ~3.2 s on every sync whose root has a ready standby,
including the first. Remaining costs for every language: the
whole-language semantic analysis (Go ~3.85 s, see
[incremental semantic analysis](incremental-semantic-analysis.md)), sidecar
staging (~0.96 s), change preparation (~0.48 s) and activation (~0.33 s).

## Measured results of item 1 (2026-10-27)

The build is the uncommitted standby work on top of `1e435f17`. It also
contains another session's uncommitted `publication-store.ts` edits. Each
probe ran in an isolated HOME on a clone, with 3 runs of 1 edit:

```bash
systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 \
  node scripts/perf/index-probe.mjs <repo> --save-search 1 --ext <ext> --runs 3 --log <log>
```

Other agents ran on the machine during every run. Load averages are given
per run. The "before" side is the same build with fresh workers, not `HEAD`.

### Fix found during measurement

The first trufflehog run used the standby in 2 of 12 syncs. Cause:
`manage_index sync` runs on the session's provider-free `localSyncManager`
(`packages/mcp/src/server/shared-runtime.ts`), and that manager had no
standby. Fix: `SyncManager` takes an optional `syncWorkerStandby` (take
only). `SharedRuntime` passes `ProviderRuntime.externalSyncWorkerStandby`,
and `manage-maintenance-handlers.ts` passes it to
`startSupervisedSyncWorker`. After the fix, the standby served 11 of 11
syncs.

### Trufflehog (3,295 Go files)

| Run | Load (1 min) | Standby used | Real edit round trip | Restore sync |
|---|---|---:|---|---|
| Fresh workers | 10.1 → 6.6 | 1/11 | 11,186–12,565 ms, median ~11.7 s | 4,275–5,388 ms, median ~4.7 s |
| Standby | 2.2 → 4.8 | 11/11 | 10,672–11,649 ms, median ~10.9 s | 843–2,636 ms, median ~2.5 s |

Index wall time ~34–37 s. Peak process-tree RSS ~2.1–2.2 GB. Real-edit
breakdown with the standby: navigation checkpoint ~5.6 s, of which
`navigation.semantic language=go files=3288` is ~4.2–5.5 s. Sidecar stage
~1.05 s, relationship delta ~0.6 s, activation ~0.4 s.

### TypeScript (`satori_v2` clone, 317 `.ts` files)

Load 3.6 → 7.9. Index wall time 46 s, peak tree RSS 2,040 MB. Standby used
11/11. Real-edit round trip 5,590–7,102 ms (median ~6.3 s). Restore sync
1.2–2.3 s.

| Phase (median, n=6 real edits) | ms |
|---|---:|
| `sync.worker.freshness` | 3,827 |
| `sync.incremental_publication` | 3,760 |
| `sync.publication_navigation_delta` | 2,072 |
| `sync.publication_navigation_checkpoint` | 2,009 |
| `sync.worker.prewarm` | 1,450 |
| `sync.worker.bootstrap` | 588 |
| `sync.worker.module_load` | 442 |
| sidecar stage | 317 |
| relationship delta | 293 |
| payload count | 286 |
| activation | 248 |
| payload delta | 171 |

Inside one sync: `navigation.resolution language=typescript files=321` is
1,302 ms for a one-file edit, `navigation.stage.fsync_tree` 175 ms,
`typescript.program` 111 ms. The standby peak RSS from this run (976 MB) is
not valid: that sampler also counted the worker's child processes.

### Python (`tradingview_ratio` clone, 1,013 `.py` files; 1,519 indexed files)

Load 5.6 → 6.4. Index wall time 36.2 s, peak tree RSS 2,413 MB. The result
is not valid for a cost ranking (see issues 1 and 3): the standby served 1 of
10 syncs, and the probe's edited file never appeared in search
(`editedResultCount` 0 in 21 of 21 searches). Each fresh-worker sync took
4.7–6.1 s round trip, of which prewarm was 3.3–4.4 s, bootstrap 0.46–0.65 s,
and incremental publication only 0.36–0.53 s. Standby RSS with the fixed
sampler (main worker process only): peak 376 MB; last sample per standby
156–376 MB.

### Ranking of the remaining costs for every language

From Go and TypeScript (Python is not valid yet):

1. Whole-language navigation analysis for a one-file edit. Go
   `navigation.semantic` ~4.2–5.5 s for 3,288 files. TypeScript
   `navigation.resolution` ~1.3 s for 321 files. See
   [incremental semantic analysis](incremental-semantic-analysis.md). That
   proposal covers only the CBM semantic languages, not the TypeScript
   compiler provider.
2. Standby not ready when syncs run back to back (issue 2): ~3.1 s on Go,
   ~2.5 s (prewarm + bootstrap + module load) on TypeScript.
3. Shared publication steps: sidecar stage (Go ~1.05 s, TS ~0.32 s),
   relationship delta (~0.6 s, ~0.29 s), activation (~0.4 s, ~0.25 s),
   payload count (TS ~0.29 s).

## Issues recorded at 2026-10-27 05:45 IST

The later Python rerun and current disposition follow this historical table.

| # | Priority | Issue | Evidence | Next check |
|---|---|---|---|---|
| 1 | P1 | In the Python run the standby served only the first sync (1/10). Every later sync spawned a fresh worker and paid ~3.3–4.4 s prewarm inside the sync. The RSS sampler saw 7 standby processes, so standbys were spawned but not taken. | Only one `standby-` operation id in the probe output. Each later op has `sync.worker.bootstrap` and `sync.worker.prewarm` under its own id. The first standby reported `prewarmed:false`. | Hypothesis (not proven): the edited file is outside the index (issue 3), the sync finds no indexed change, and the standby is cancelled or replaced on that path. Disproving check: log `SyncWorkerStandby` discard reasons and `take` results for one Python sync. Stop when the miss reason is known. |
| 2 | P2 | Back-to-back syncs: the next standby is still loading when the next sync arrives, so bootstrap and prewarm (~3.1 s Go) run inside that sync. | Trufflehog worker-internal freshness 7.5 s with the standby. The probe syncs right after the last one. | Measure one edit after a pause longer than the prewarm. If the round trip falls by ~3 s, the standby works and only the probe cadence limits it. |
| 3 | P2 | The Python probe edits `investigations/invisible_bugs/invbug_20260209_001129_UTC/evidence/probe_verification_timestamps.py`, and no search finds it. The Python numbers therefore do not measure a real edit. | `missedCount` 1 and `editedResultCount` 0 in all 21 searches. Incremental publication ~0.4 s. | Check if the index policy excludes that path. If it does, make the probe pick an indexed file, then rerun the Python profile. |
| 4 | P1 | Whole-language navigation analysis is the top remaining cost in Go and TypeScript (ranking item 1). | See the ranking above. | Design a per-language delta that falls back to the full analysis when it is unsure, with an equivalence test against the full path. |
| 5 | P3 | Shared publication steps cost ~1–2 s together on Go. | Ranking item 3. | Profile after issue 4. Rank again. |
| 6 | P3 | The TypeScript standby RSS is unknown. | The first sampler counted child processes. | Rerun the TypeScript probe with the fixed sampler. |

## Python rerun and current issues (2026-10-27 06:25 IST)

Correction from the SL-5 investigation: the earlier claim that TypeScript
re-analyzes all 321 files on each measured edit was inaccurate. The
`navigation.resolution files=321` field counts the input registry. The saved
trace reports `typescript.claims files=1` for all six edit publications.
TypeScript already reuses digest-checked dependency state and analyzes affected
files. The 1.3–1.6 s resolution span includes other work that still needs
profiling. The Go whole-language parse finding remains valid.

The original probe chose the first sorted Git-tracked Python file. The file
matched `investigations/**` in the clone's `.gitignore`: Git still tracks it,
but Satori's ignore matcher excludes it. The probe now intersects tracked paths
with the current Publication's navigation registry before selecting edits.

On the same clone, the current build used the standby in 4/4 syncs with the
original ignored file and 4/4 with an indexed file. The later external-sync
completion change prepares a new standby and may explain the old 1/10 result;
the old run did not log enough to prove that cause.

The normal probe ran with `--save-search 1 --ext .py --runs 3 --sync-gap 6000`
under `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0`.
The selected edit reached search in all six trials. Standby use was 10/10.
Explicit edit sync wall times were 2,728, 2,567 and 2,640 ms, median 2,640 ms.
Initial indexing took 35,149 ms with peak process-tree RSS 2,419 MB. Load was
2.36 → 3.35. The build includes the uncommitted standby changes. The peak is
for the index process tree, not idle standby RSS.

For six real edit publications, median navigation delta was 854 ms, including
navigation checkpoint 621 ms. Sidecar stage was 462 ms, relationship delta
351 ms, and activation 165 ms. These spans overlap, so do not add them. The
Python trace does not establish whether whole-language analysis dominates its
navigation checkpoint. Go and TypeScript still show whole-language analysis as
their main measured cost. The Python run provides no fresh-worker baseline.

The later Go HEAD comparison used `--sync-gap 6000`, three runs per side:
edit wall median fell from 13,426 to 9,408 ms, and worker round trip median
from 11,868 to 7,691 ms. Load was 3.2 → 3.1 before and 7.8 → 3.6 after.
Peak index process-tree RSS was 1,907 MB before and 2,103 MB after. The after
build included uncommitted changes. Standby memory was not isolated in this run.

Current disposition: issue 3 is fixed for this probe. Issue 1 did not recur in
the current Python runs, but its historical cause remains unproven. Issues 2,
4, 5 and 6 remain. Full warm-versus-cold publication equivalence and the final
independent review remain outstanding. The one-file Python sync remains above
the sub-second target.

The probe RSS sampler and phase script were session scratch files, not
repository files. The sampler reads `VmRSS` only for processes whose command
line contains `mutation-sync-worker` and whose environment has
`SATORI_MUTATION_OPERATION_ID=standby-`. The phase script takes the median
of each `sync.*` span over worker operations whose
`sync.incremental_publication` exceeds 2,000 ms.

## SL-5 measured result, 2026-10-27 07:08 IST

The native parser now keeps a bounded cache of exact-source Tree-sitter trees.
Standby preparation fills it before an operation. Source bytes and grammar
must match before reuse. Definition building and call resolution still use
the current complete inputs. The implementation applies to all seven native
grammars, and tests compare each with a fresh engine. Preparation skips roots
with several native languages because the cache retains one grammar.
An arriving sync cancels and drains unfinished speculative parsing.

All probes used the current uncommitted standby build and the same command:

```bash
systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 \
  node scripts/perf/index-probe.mjs <repo> --save-search 1 --ext <ext> --runs 3 --sync-gap 6000
```

| Repository | Before edit wall, ms | After edit wall, ms | Median before → after | Load before run → end | Peak index process-tree RSS before → after |
|---|---|---|---|---|---|
| trufflehog, `.go` | 8,854 / 9,473 / 8,906 | 6,917 / 6,826 / 6,715 | 8,906 → 6,826 ms | before 2.19→1.90; after 1.17→2.56 | 2,357 → 2,282 MB |
| TypeScript clone, `.ts` | 3,404 / 3,289 / 3,301 | 3,458 / 3,352 / 3,471 | 3,301 → 3,458 ms | before 0.42→2.43; after 1.83→3.18 | 2,575 → 2,601 MB |

Go edit sync improves by 2,080 ms (23.4%). Its semantic phase falls from a
3,841 ms median to 1,797 ms. Navigation checkpoint falls from 5,521 to
3,444 ms. Sidecar stage remains about 978 ms and relationship delta about
662 ms. Restore syncs arrive before preparation completes and still pay
about 3.8 s for semantic analysis. The improvement assumes a prepared standby.

TypeScript has no demonstrated speed gain. It already analyzes affected files;
the measured edit claims cover one file. Its final resolution span has a
1,134 ms median. A separate config-client sharing experiment passed 24 tests
but changed the wall median only from 3,301 to 3,251 ms; that experiment was
removed. Different machine loads limit the before/after comparisons.

All six search trials find the edited file in each final probe. The final
Go and TypeScript probes each use the standby for 10/10 worker syncs.
During the post-trial idle gaps, 250 ms samples of descendant standby main
processes give peaks of 743 MB for Go and 435 MB for TypeScript. Samples cover
six standby PIDs per probe. Child helper processes are excluded. There is no
matched before measurement of idle Go standby RSS, so its memory increase
cannot be isolated from these results.

Verification: native build and manifest verification pass. The native test
set passes 47 cases, including fresh-engine differential tests for seven
grammars. Removing the byte witness fails the equal-length syntax-change
regression; the witness and correct assets were restored. The parent reran
the five native differential tests, 27 threaded lifecycle tests, nine preload
tests, and the full published-output equivalence case for Go and TypeScript
edits. Core and MCP runtime builds pass. `pnpm run check` passes with existing
lint warnings. The independent graph review found three standby lifecycle
and configuration defects. One repair round keeps discarded process handles
until completion, serializes replacements, drains standby release during
watcher stop and unwatch, and derives the bootstrap key from the provider's
actual inputs. The parent reran 30 MCP tests across four files. The new
regressions first failed against the old code. MCP typecheck and runtime
build pass. The bootstrap test uses a real isolated worker with a patched
provider and does not exercise a live embedding backend.

Remaining issues:

| Priority | Issue | Current evidence |
|---|---|---|
| P1 | Sync latency remains above the sub-second target. | Go median 6,826 ms; TypeScript median 3,458 ms. Go still rebuilds definitions and resolves the current project; TypeScript still pays compiler metadata and client-request costs. |
| P2 | Cold and closely spaced syncs cannot use completed native preparation. | Go preload is about 5.1–5.3 s including navigation; an early start aborts parsing and uses the normal path. Mixed native-language roots skip preparation. |
| P2 | Shared publication work still scales with the repository. | Go sidecar stage about 978 ms and relationship delta about 662 ms after the change. |
| P3 | Memory tradeoff lacks a matched idle baseline. | Final sampled idle main-process peaks: Go 743 MB, TypeScript 435 MB. |
| P3 | Historical Python standby miss cause is unproven. | It did not recur in current checks; the original unsearchable probe file is fixed. |
| P3 | Host GC cannot see the standby's process-local publication read lease. | Concurrent collection can fail a preload sidecar read and force cold reads. Review established no partial publication from this race. |

The old TypeScript RSS uncertainty is resolved by the main-process sampler.
The old TypeScript whole-language-analysis claim is withdrawn. No claim of
universal latency reduction or dependency-scoped native call resolution is made.

## When to do it

When edit-to-searchable latency on medium or large repositories becomes the
main complaint. Target: sub-second sync for a one-file edit, regardless of
repository size.
