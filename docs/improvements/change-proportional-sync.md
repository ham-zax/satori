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
navigation checkpoint. Go still pays whole-project native analysis. The
TypeScript resolution span remains expensive, but its registry count does
not prove whole-language analysis. The Python run provides no fresh-worker baseline.

The later Go HEAD comparison used `--sync-gap 6000`, three runs per side:
edit wall median fell from 13,426 to 9,408 ms, and worker round trip median
from 11,868 to 7,691 ms. Load was 3.2 → 3.1 before and 7.8 → 3.6 after.
Peak index process-tree RSS was 1,907 MB before and 2,103 MB after. The after
build included uncommitted changes. Standby memory was not isolated in this run.

Disposition at this checkpoint, superseded by the SL-5 section below: issue 3 is fixed for this probe. Issue 1 did not recur in
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

### Tree-cache collision repair, 2026-10-27

The engine-local tree cache had 16,384 direct-mapped slots. On the 3,363-file
Go clone, 395 files (11.7%) shared a slot with another path and lost their
cached tree. The cache now has 65,536 slots and probes up to 64 entries before
it parses without caching. The exact path-and-source witness is unchanged.

Emscripten 3.1.64 was installed on the ARM host and the engine rebuilt (WASM
digest `46fd320c`). Three cold resolves were 5,887 / 5,993 / 5,986 ms. Warm
resolve fell from 2,690–2,695 to 1,777–1,789 ms. Prepare plus resolve fell
from 3,861 + 3,086 to 3,799 + 2,138 and 3,802 + 2,022 ms. Output is identical:
26,941 results with hash `392180f6097f8da6`. The five prewarm tests pass, and
removing the source comparison fails the equal-length syntax-change test. The
full edit-sync probe cannot run on this host, so these are engine-level
numbers.

#### End-to-end edit-sync A/B, WSL x86-64

The full probe needs the x86-64 Potion helper, so the matched A/B ran on the
WSL host (16 cores, 11 GiB, Emscripten 3.1.64). Both engines were built there
from HEAD `368bbc27`; the only source difference was this cache change. The
corpus was the trufflehog clone with 3,295 Go files. The command was the
standard `--save-search 1 --ext .go --runs 3 --sync-gap 6000` probe, run as
three alternating old/new pairs with no memory cap, because that host has no
user systemd bus. Load stayed between 1.6 and 2.8.

| Side | Sync wall, nine trials (ms) | Median |
|---|---|---|
| Old | 6,680 / 6,817 / 6,603 / 6,518 / 6,632 / 6,646 / 6,493 / 6,469 / 6,510 | 6,603 |
| New | 5,996 / 6,041 / 6,804 / 5,988 / 5,963 / 6,144 / 6,009 / 6,000 / 6,010 | 6,009 |

The median falls 594 ms (9.0%). The new side had the lower median in each
paired run: 6,680→6,041, 6,632→5,988, 6,493→6,009. Ranges overlap because one
new run reached 6,804 ms. Every one of the 18 search trials found the edited
file. Peak index process-tree RSS was 2,470–2,492 MB old and 2,454–2,491 MB
new, so the larger table costs no measurable peak. Both engines published
24,529 results with hash `095cded2b906914e`, and the single-resolve bench moved
from 3,756 to 3,499 ms.

The span means move with the same sign: `navigation.semantic` 2,940→2,729 ms,
`sync.parent.worker_round_trip` 4,382→4,194 ms, and
`sync.publication_navigation_delta` 4,591→4,334 ms. Publication sidecar,
payload and activation spans are unchanged, which is consistent with a parse
saving rather than a publication change.

Limit: this is one Go corpus on one host. The gain is about 9% of edit wall,
not the 34% warm-resolve figure from the engine bench, because publication and
worker steps dominate the sync.

### TypeScript reference declaration reuse, 2026-10-27

Discovery rebuilt every referenced project's declaration program on each run.
The published value is only the declaration output path list, and probe runs
showed it depends on compiler options and ordered root file names alone:
content edits, type errors, emit failures, `isolatedDeclarations` violations,
added project references and added `@types` packages left it equal, while an
added file, a `.tsx`/`.mts`/`.cts` input, a deleted file and any output-root
option changed it. A two-file library costs 115-124 ms in `getProgram` and 3 ms
in `getDeclarationEmit`; `packages/core`'s 296 roots cost 900-971 ms. Parsing
the configs costs about 40 ms, which is why the earlier parsed-config cache
gained nothing.

`TypeScriptReferenceDeclarationCache` keeps its entry and byte bounds and gains
an optional disk backing under `options.stateDirectory`. One document per
discovery root holds every proven proof plus a witness: format, provider and
compiler version, root, config chain hashes, ordered file names, admission
budget, and the compiler's own filesystem answers (probed path kinds, realpaths,
directory listings, reads). Each read keeps the budget that admitted it and an
aggregate digest of the exact bytes the compiler consumed. Reads are bounded and
validated before any path is used, writes are atomic with a rename, and the name
ends in `.reference-declarations.json`, so it never collides with the retired
parsed-config file. Unproven proofs and resource failures are never saved, and a
failed observation, content or budget check returns the computation instead of a
guess. Metadata is read once per discovery, not once per project.

Review repair, 27 October 2026. Two gaps could let a saved success outlive a
fresh resource failure. A source edit can add an import or a triple-slash
reference, so a fresh computation reads a file the saved observation never saw.
The digest of every read now invalidates the proof on any content change. The
verifier also charged every JSON file against the metadata transport budget
only, while the native session charges imported JSON to the source budget. The
session now records which budget admitted each read, and the verifier replays
both charges. The format moved to 2, so documents from the first version are
ignored.

Capture-race repair, 28 October 2026. Path probes and realpaths now record the
answers returned to the compiler, rather than checking those paths after
compilation. Conflicting reads or repeated filesystem answers invalidate the
computation. Before retaining a proof, the analyzer checks its recorded inputs
against current files. Native stat and directory-listing callbacks skip caching
because their complete answers are not recorded. Ordinary callbacks preserve
the native path when observation is disabled.

The cache format is now 3. Earlier proofs can contain observations from the
capture race, so the loader ignores them without deleting saved files.
Deterministic tests cover a dependency created before capture and conflicting
observations. The local timings below precede this repair. End-to-end edit-sync
measurement remains open.

The cross-project sync tests now separate serial and worker modes into four
files. Each mode retains all six edits and the full publication comparison.
The reporter still enforces its 90-second budget per file.
Repair checks pass: 38 focused tests, all four sync-equivalence files under the
normal reporter budget, and `pnpm run check`.

Local discovery seam, `getSourceControlFiles` on a composite fixture (library
plus consumer), five samples per case, analyzer disposed between samples, HEAD
`368bbc27` with 14 dirty entries. Two runs after the review repair:

| Case | Run 1 (ms) | Run 2 (ms) | Builder spawns |
|---|---|---|---|
| Cold cache, fresh state directory each sample | 31.3 | 31.8 | 3 |
| Warm, same analyzer | 18.2 | 19.4 | 2 |
| Warm, new analyzer per sample | 18.5 | 17.8 | 2 |
| Consumer source edit, new analyzer | 17.9 | 19.0 | 2 |
| Referenced-source content edit (invalidates) | 29.6 | 29.3 | 3 |
| Added referenced file (invalidates) | 31.8 | 29.5 | 3 |
| Referenced tsconfig target edit (invalidates) | 32.8 | 30.7 | 3 |
| Baseline: saved metadata ignored, new analyzer | 30.3 | — | 3 |

The baseline is the same build with `/tmp/opencode/ts-ref-measure.ts` set to
skip the metadata read from the harness, so no source or branch changed. One
baseline run gave 28.0-30.6 ms for its new-analyzer cases. Peak process RSS was
107-116 MB across the fixed runs. The spawn count falls from 3 to 2 only when a
proof is reused, which is the declaration program. A referenced source edit now
rebuilds it, because its contents decide which files the declaration program
reads.

Real-repository discovery seam, `/tmp/opencode/ts-cache-bench.cjs` on this
repository (713 tracked TypeScript files, five plans, fresh state directory per
cold sample, five samples per case, HEAD `368bbc27` with the same dirty tree):
run 1 cold median 3,346 ms (3,611 / 3,302 / 3,381 / 3,282 / 3,346) and
new-analyzer warm median 597 ms (597 / 567 / 601 / 620 / 585), a 2,749 ms
saving. Run 2 cold median 3,312 ms (3,521 / 3,312 / 3,204 / 3,382 / 3,293) and
warm median 582 ms (582 / 572 / 570 / 589 / 584), a 2,730 ms saving. Both runs
save 82%. `getSourceControlFiles` returned the same 790 control paths cold,
warm and with a fresh directory, and the five job keys matched. The saved
document is 2.88 MB. Warm verification reads and hashes 28.1 MB over 3,208
observed files on this repository, which adds about 140 ms to a hit and about
100 ms to a cold capture. Cold discovery is about 0.8 s above the earlier 2,515
ms baseline because capture stats every observed path and hashes every read.

Equivalence: a consumer edit then a new analyzer matches a fresh state directory
for `analyze` results and for `getSourceControlFiles`; a referenced-source edit
that imports an oversized file matches fresh discovery instead of reusing the
old success; sharded and unsharded runs agree; deleted and edited emitted
declarations still change the consumer's environment identity; and an extended
config outside the root still invalidates. Mutation checks: skipping the read
digest fails the same-size cache test and the oversized-dependency analyzer
test; skipping the source charge for JSON files fails the JSON program-input
test.

Limits: the fixture saving is 12 ms and the repository discovery saving is
2,730-2,749 ms (82%). The content check costs about 140 ms on a repository hit
and about 100 ms on a cold capture. No end-to-end edit-sync probe ran for
TypeScript on this host, so no edit wall-time claim is made. Content edits to
referenced sources now invalidate by design; consumer edits and unchanged
inputs reuse. The retired parsed-config cache was not reinstated, and the
parsed-project argument in `TypeScriptLanguageServiceSession` remains because
discovery supplies it.

### Handoff checkpoint, 2026-10-27

Commit `c7214df216bf4e30fb7950545cf1c7624577d600` contains the standby,
native parse reuse, rebuilt engine assets, tests and measurement records.
The Go and TypeScript benchmarks above precede the final lifecycle repairs.
The parent checked the repaired sources with 30 focused MCP tests and
`pnpm run check`. The final fixture cleanup adjustment passed its ten
standby tests. No matched benchmark of the exact commit was run.

Python still lacks a matched before/after run, a full warm/cold publication
equivalence case, and an idle standby measurement comparable to the final
Go/TypeScript probes. The historical 376 MB Python standby sample came from
the earlier invalid edit probe and does not close that evidence gap.

The next cost reduction remains partial. Read current task status and the
exhausted three-dispatch budget in `TASKS.md`, not the historical checkpoints.
The independent review and one repair round are complete. Further worker
work requires a renewed ledger budget. Both owned worker sessions are closed.
Temporary run reports and measurement helpers were removed after their
commands, values and limitations were recorded here. Worker history remains
available through Claive IDs in the ledger.

## When to do it

When edit-to-searchable latency on medium or large repositories becomes the
main complaint. Target: sub-second sync for a one-file edit, regardless of
repository size.
