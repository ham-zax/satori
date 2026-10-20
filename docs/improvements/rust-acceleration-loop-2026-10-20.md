# Rust acceleration loop, 20 October 2026

Approved working plan for the napi-rs experiment after Claude took it over
from Hamza's first slice. This file is the resume point after a context
compaction. Update the "State" section at every step.

Parent documents: `napi-rs-indexing-experiment-2026-10-20.md` (ranked costs
and parity rules), `napi-rs-implementation-2026-10-20.md` (history of the
first slice), `libreoffice-performance-findings-2026-10-20.md` (run results).

## Goal

LibreOffice full index, critical path 200 s or less, MemoryMax=6G, with
byte-identical published artifacts. Rust stays only where it beats the
TypeScript or worker-thread form by more than the run-to-run noise.

## The loop (one candidate at a time)

| Step | Work | Who | Gate |
| --- | --- | --- | --- |
| 1. Profile | One CPU-profiled full run of the current build. Analyze the payload and navigation windows. | Sol low runs, Claude analyzes | Ranked main-thread costs with owners, plus time spent waiting for Potion and vector writes. |
| 2. Check cheaply | Microbenchmark on real inputs: TypeScript, Rust including the boundary copy, worker thread. Count calls per index. Run the failure tests. | Claude writes, Sol medium runs | Rust beats the worker-thread form by more than the noise. Else use the worker-thread form. |
| 3. One complete slice | Exact brief. One Sol medium worker in a worktree from `exp/napi-projections`. Claude reviews correctness and performance assumptions (calls per index, copies, locks). | Sol medium, Claude reviews | Focused tests pass. Call counts match the brief. |
| 4. Screening pair | One reference run and one candidate run, start load under 2.0. | Sol low | If the candidate regresses, stop and diagnose before more runs. |
| 5. Validate | 3 runs per variant, interleaved. Compare payload spans, not only the critical path. Compare full artifacts. | Sol low runs, Claude judges | Median gain above the run spread. Artifacts identical. |
| 6. Record | Commit on the branch. Update this file and the findings note. Delete the run `state/` folders. | Claude | Next candidate. |

Rules:

- Repeat a check only when its inputs changed. Reference runs stay valid
  while the default path and build hashes are unchanged.
- One heavy job at a time (full run, test suite, build).
- Each run brief deletes `state/` after the span table and artifact
  comparison. Logs, spans and `final.json` stay.
- Claude owns design, briefs, reviews, merges and decisions. Workers make no
  design choices and report when a brief cannot be followed literally.

## Candidate queue (order set by the step 1 profile)

| Id | Candidate | Owner | Why Rust can win |
| --- | --- | --- | --- |
| A | Finish projections: count bytes once, support check inside the addon, lease-hook decision | `core/native-search-projections.ts`, `core/indexing-projection-stream.ts` | About 30 % of projection cost still runs on the main thread. |
| B | Binary Potion frame | `experiments/potion-l0-l1` (Rust helper), `embedding/potion-embedding.ts` | Removes about 20.6 s of JSON parsing on the main thread. |
| C | LanceDB row encoding | `vectordb/lancedb-vectordb.ts` | Only if Arrow buffers reach LanceDB without a copy back to JavaScript. |
| D | Relationship resolution | `relationships/*` | Only if the profile puts it on the critical path. |

Stop rule: a candidate that fails step 5 goes back to TypeScript or a worker
thread.

Lease hooks (`beforePrepare`, `beforeConsume` in `indexing-pipeline.ts`):
decided after the profile. Remove them only if their measured cost is above
1 s. Five tests encode them.

## Fixed facts

- Branch `exp/napi-projections`. Baseline commit `ee5e91ca` (Hamza's slice).
  Master stays at `97b5cca1`.
- Release addon `experiments/napi-search-projections/projection.linux-x64-gnu.node`,
  SHA-256 prefix `0db6a439725e` (ignored by git; rebuild with
  `pnpm --ignore-workspace run build` in that folder).
- Core and mcp dist at `ee5e91ca` match `napi-parallel-r2/build.sha256`
  except `packages/core/dist/.tsbuildinfo`. The five r2 runs are valid
  evidence for this build.
- r2 runs (unprofiled, 4,400 MiB budget, 4 analysis workers): reference
  428.2, 415.8, 447.8 s; native 411.4, 421.4 s critical path. Main-thread user
  CPU 188 s to 156-159 s. No reliable wall-time gain yet.
- Tools: `bench-bugs/libreoffice-perf-20261020/napi-loop/tools/` (copies of
  the `/tmp/satori-napi-20261020-TlXzQR` scripts). `profile-run.mjs native
  <evidence>/run` writes `<evidence>/profiles` and clock anchors, then
  `analyze-profile.mjs <evidence>` writes `payload.txt`, `navigation.txt`
  and analysis-thread files. Full runs use `napi-parallel-r2/run.mjs
  reference|native <dir>`.
- On 20 October at 17:52 a WSL restart left an empty commit object. The
  repair backup is in the session scratchpad. Run `sync` after commits.

## State

- Step 1 done (profile of `ee5e91ca`, native, evidence
  `bench-bugs/libreoffice-perf-20261020/napi-loop/profile-1`): critical path
  395.8 s (profiled), payload 254.7 s, navigation 62.8 s, anonymous peak
  4,423 MiB, start load 1.69. Payload window, main thread: idle 48.3 s,
  GC 12.9 s.
- Ranked main-thread costs in the payload window (inclusive):
  1. Lease hooks of the projection stream: 20.6 s (`sleepSync` 15.4 s self).
     By caller: `streamIndexingProjections` (beforeConsume) 13.5 s, `produce`
     (beforePrepare) 7.1 s, existing write guard (`flushVectorWriteBuffer`)
     0.05 s. Above the 1 s rule: remove both hooks.
  2. Potion transport: `handleStdout` 18.7 s (`handleFrame` 9.2 s,
     `TextEncoder.encode` 7.2 s self). Candidate B.
  3. Policy admission in the payload: `isIndexableFileObservationByPolicy`
     16.8 s, `hasSearchableShebang` 13.3 s, `openInsideRoot` 13.5 s. TypeScript
     file-check fix, not Rust.
  4. Native projection wrapper: `prepare` 15.0 s, of which `supported()`
     9.8 s (regex `[a-zA-Z0-9_$]{257}` alone 9.9 s self) and `flush` 3.4 s.
     Candidate A.
  5. LanceDB `encodeSearchableRow` 14.0 s. Candidate C.
  6. A sync-scan runs inside the payload window: `sync-scan.ts:270/303`
     10.5 s. Not yet explained.
- Candidate A slice (steps 2-3) done, merged uncommitted into this tree,
  dist rebuilt. Worktree `/home/hamza/repo/satori-wt-candA` holds the same
  diff (remove after commit).
  - Lease hooks removed. The native path checks the lease only at the
    reference write guard `flushVectorWriteBuffer`. Consequences, now in the
    tests: lease loss surfaces wrapped as `Failed to persist ...` with the
    original reason as `cause` (the reference contract), and one embedding
    batch can run before the guard rejects it. No document is written.
  - `nativeInputBytes()` replaces `supported()` + `rawBytes` in `prepare()`:
    one charCodeAt pass, early exit above `MAX_BYTES`. Differential test
    against the old regex oracle (fixed cases + 2,000 seeded strings).
    Mutations (run 258, `> 0x80`, `MAX_BYTES + 1`) each fail the test.
    Microbenchmark on 12,643 LibreOffice chunks of 2,500 chars: old 586.9 ms,
    new 135.4 ms median of 3, 0 mismatches.
  - Focused tests: native-search-projections 10/0, indexing-projection-stream
    20/0, indexing-pipeline.native-projections 23/0. `tsc --noEmit` clean.
  - The support check stays in TypeScript: napi converts lone surrogates
    before Rust sees them.
- Step 4 done (`napi-loop/screen-A`, start load 1.42 / 1.49): reference
  critical path 378.1 s, payload 244.3 s, navigation 73.4 s, anonymous peak
  4,311 MiB. Native 337.0 s, payload 211.3 s, navigation 67.2 s, peak
  4,381 MiB, projections 547,349 total, 535,893 native, 11,456 fallback,
  8,520 calls. No regression. The worker deleted both states before the
  artifact comparison (against its brief), so this pair has no comparison.
- Post-publication sync, not a race: after the `create` commits, a
  background `sync` of generation 2 can start (`sync.incremental_publication`
  about 18 s). It runs after the critical path and appears by timing (screen
  native-1, validate reference-2). `manage_index status` then shows that sync
  as the latest operation, so the r2 runner failed its completion and budget
  checks although the create published. `napi-loop/tools/run.mjs` now judges
  the create operation. Artifacts stay identical with the extra sync.
- Step 5 pair 2 (`napi-loop/validate-A`, start load 0.84 / 1.63): native-2
  328.2 s (payload 208.1 s, navigation 63.7 s, peak 4,408 MiB), reference-2
  363.6 s (payload 240.3 s, navigation 65.1 s, peak 4,352 MiB). Artifacts of
  reference-2, native-2 and r2 reference-1 identical (547,349 rows, same
  rows, source and sidecar hashes). States deleted.
- Step 5 pair 3 (start load 1.24 / 1.86): native-3 345.3 s (payload
  215.6 s, navigation 69.9 s), reference-3 375.1 s (payload 249.4 s,
  navigation 66.9 s). The runner copy had a scope bug (`createOperation`
  declared inside `try`), so both runs wrote no `summary.json`. Both
  publications committed. The comparison summaries are reconstructed from
  `terminal.jsonl` (marked `reconstructedFrom`). Artifacts identical to
  r2 reference-1. Runner fixed. States deleted.
- Step 5 verdict: PASS. Critical path median reference 375.1 s (spread
  14.5 s), native 337.0 s (spread 17.1 s), gain 38.1 s. Every native run
  is faster than every reference run. Payload median 244.3 to 211.3 s.
  Findings note section 8.
- Step 6: Candidate A committed on `exp/napi-projections` (`207496e6`). Worktree removed.
- Step 1 again done (profile-2 of `207496e6`, native, evidence
  `napi-loop/profile-2`, start load 1.57, 15-min load 5.50): critical path
  393.9 s (profiled), payload 237.9 s, navigation 63.6 s, anonymous peak
  4,400 MiB. Payload window: idle 47.6 s, GC 13.1 s.
- Ranked main-thread costs in the payload window (inclusive):
  1. Policy admission 25.6 s. Of it, 21.0 s is a blocking `readSync` in the
     shebang probe: `read` <- `readSync` <- index-policy.ts:166 (the sync
     `readProbe` of `isIndexableFileByPolicy`) <- `hasSearchableShebang`
     (:85) <- `isIndexableFileObservationByPolicy` (:123), resumed from a
     microtask. The sync-scan frames `sync-scan.ts:270/303` (10.6 s) run in
     the same window. Owner question: which operation starts that scan
     during the payload, and does it repeat the create's own scan?
  2. Potion transport: `handleStdout` 19.1 s (`handleFrame` 9.2 s, `encode`
     8.2 s self). Candidate B.
  3. `flushVectorWriteBuffer` 14.8 s, of which `encodeSearchableRow` 14.2 s.
     Candidate C.
  4. `openInsideRoot` 14.3 s, `readIndexableFileObservationInsideRoot`
     13.1 s.
  5. Native projection `prepare` 6.7 s (was 15.0 s), `flush` 3.7 s self.
- Trace done. The sync-scan is not inside the payload. Profile clock (IST)
  against spans (UTC): scan bursts at 240-280 s and 340-365 s match
  `index.prepare_changes` (35.9 s, after the payload ends) and
  `publication.source_current` (20.0 s), both serial on the critical path.
  Owner: `IndexGenerationWorkflow` full-index path
  (index-generation-workflow.ts:910 and :964) calls
  `Synchronizer.prepareChanges` (validates the captured source) and
  `assertSourceObservationCurrent` (final freshness check). Both are
  required freshness checks, not accidental duplicates. Each one walks the
  tree again and runs policy admission on every file.
- Cost per scan: shebang probe 22.2 s of `prepare_changes`, 13.9 s of
  `source_current`, 22.9 s in the payload window (`getCodeFiles`). Cause:
  cold reads. A scratch pass over 149,685 corpus files (open, read 8 KiB,
  close): cold 23.0 s (154 us/file), warm 1.6 s (11 us/file). The 6G cgroup
  charges page cache, anonymous peak is about 4.4 GiB, so the probed files
  leave the cache between scans. About 91,000 `.png`/`.svg` files have no
  language and get probed in every scan.
- Candidate D (TypeScript, owner `config/index-policy.ts`): an admission
  verdict cache behind the stat witness the synchronizer already trusts to
  skip hashing (size, mtimeMs, ctimeMs, plus dev, ino). Key: absolute path
  and policy identity. Bounded, process-wide, misses fall back to the probe.
  Callers that hold a stat (`getCodeFiles`, sync-scan `isSupportedFile`)
  pass it. Expected: up to 36 s off the serial tail (later scans skip the
  probe reads). Steps 2-5 as usual.
- Candidate D slice (steps 2-3) done in worktree
  `/home/hamza/repo/satori-wt-candD` (uncommitted, dist built). Optional
  `statWitness` on `isIndexableFileByPolicy` and `isObservableFileByPolicy`.
  Cache key `dev:ino` plus relative path, hit requires equal size, mtimeMs,
  ctimeMs and policy key (sorted extension set plus all-text limit).
  262,144 entries, cleared on overflow. Callers `getCodeFiles` and sync-scan
  `isSupportedFile` pass their stat. Focused tests: index-policy 6/0
  (2 new: differential against the uncached path, and witness/policy
  misses), sync-scan 18/0, synchronizer-observation 4/0, indexing-pipeline
  24/0, `tsc` clean. Mutations (no ctime check, constant policy key, no
  ino in key) each fail a test.
- Runner: `napi-loop/tools/run.mjs` reads `SATORI_BENCH_ROOT` (default main
  tree), so a pair can compare the main tree with a worktree build.
- Step 4 screening pair D (`napi-loop/screen-D`, start load 0.60 / 1.71):
  base (207496e6 native) critical path 333.1 s, candD 332.6 s. Spans base
  / candD: scanFiles 18.9 / 19.4 s, payload 213.0 / 212.0 s,
  prepare_changes 14.1 / 13.4 s, source_current 5.9 / 4.3 s, navigation
  63.4 / 65.2 s, finalize_collection 22.3 / 23.3 s. Peak anonymous 4,397 /
  4,558 MiB. Verdict: DROPPED. The gain (about 2 s of spans, 0.5 s
  critical path) is noise. The patch is kept at `screen-D/candD.patch`.
  Worktree and run states removed. No artifact comparison (see runner).
- Lesson: the CPU profile overstated blocking I/O. Unprofiled,
  `prepare_changes` is 14.1 s (profiled 35.9 s) and `source_current` 5.9 s
  (profiled 20.0 s). Before a candidate that targets a sync-I/O frame,
  check the unprofiled span first.
- Runner fix: `summary.json` took `phase` from the terminal status
  operation, which is the post-publication background `sync` (phase
  `preflight`), so `compare.mjs` refused both runs. The summary now reports
  `completed` when that sync owns the terminal status and the create
  published (the loop guard already judged the create). `criticalSeconds` in
  such a summary belongs to the sync. Use the spans critical path.
- Unprofiled critical path ranking (base): payload 213.0 s, navigation
  63.4 s, finalize_collection 22.3 s, scanFiles 18.9 s, prepare_changes
  14.1 s, source_current 5.9 s.
- Correction to the profile-2 ranking: `windows.json` payload window ends at
  280.1 s profile time, so it includes `prepare_changes` (240-278 s). The
  21.0 s shebang `readSync` belongs to that scan, not to the payload. True
  payload (profile 42.2-240 s, 197.8 s main thread): idle 47.3 s, GC 12.5 s.
  Analysis worker threads are 70-78% idle, so the main thread feeds the
  pipeline. Inclusive main-thread costs: Potion transport `handleStdout`
  19.0 s (byte scan loop 9.0 s self, `JSON.parse` in `handleFrame` 7.3 s,
  `toString` 1.7 s, `Buffer.concat` 0.9 s); LanceDB `makeArrowTable` 16.3 s
  (Arrow UTF-8 `encode` 8.2 s self: this is the `encode` frame, not Potion);
  `openInsideRoot` 14.2 s (`realpath` 3.8 s, `fstat` 3.8 s + 2.4 s);
  `prepareFile` 12.3 s; hash `update`+`Hash` 8.0 s; native projections
  `flush` 3.6 s + `prepare` 2.4 s self.
- Candidate B1 (TypeScript, owner `PotionEmbedding.handleStdout`,
  potion-embedding.ts:505): frame on `\n` with `Buffer.indexOf` and a resume
  offset instead of the brace-matching rescan from byte 0 on every chunk.
  Contract: the helper writes every worker frame as compact JSON plus `\n`
  in one write (`write_frame`, experiments/potion-l0-l1/src/main.rs:74).
  Differences only for output that breaks that contract (two objects on one
  line, an object without `\n`). Expected gain up to 9 s of main thread.
  B2 (binary vectors, needs a rebuilt shipped helper) is out of loop scope
  without Hamza's approval.
- B1 slice (worktree /home/hamza/repo/satori-b1 from 207496e6, built core,
  mcp, cli). Microbenchmark (200 frames of 64 x 256 JSON floats, 64.8 MB,
  64 KiB chunks, median of 7): framing only 374.0 ms old vs 28.8 ms new,
  framing + `JSON.parse` 535.3 vs 192.5 ms. New tests in
  potion-embedding.test.ts drive `handleStdout` directly: every 2-chunk
  split, 1-byte chunks and 50 seeded random chunkings give the one-chunk
  result; non-`{` frame, two objects on one line, and > 1 MiB frames (with
  and without `\n`) reject. Mutation: no scan offset reset after a frame
  fails "split at byte 49". Potion tests 27 + pool 5 pass, tsc and eslint
  clean. Screening pair `napi-loop/screen-B1` running.
- B1 screening pair 1 (`screen-B1`, start load 0.82 / 1.72): artifacts
  identical (compare exit 0). The PC slept during candB1 `scanFiles` (wall
  clock jump of about 2.7 h), so its critical path is invalid. Payload,
  outside the pause: base 221.1 s, candB1 221.0 s, no gain. Base critical
  381.0 s with a cold cache (prepare_changes 25.0 s, source_current
  20.1 s). Peak anonymous 4,631 / 4,462 MiB. States deleted. Pair 2 runs
  in reversed order (candB1 first) as `base-2` / `candB1-2`.
- B1 screening pair 2 (candB1 first, start load 1.36 / 1.79): critical path
  (server start to `publication.commit`) candB1 354.6 s, base 357.9 s.
  Payload 215.3 / 226.5 s, navigation 70.2 / 69.7 s, finalize_collection
  24.4 / 25.3 s, scanFiles 23.8 / 20.0 s. Peak anonymous 4,222 / 4,429 MiB.
  Artifacts identical (compare exit 0). States deleted.
- DECISION: B1 DROPPED. Critical-path gain 3.3 s and payload gains 0.1 s and
  11.2 s are inside run noise (about ±10 s). The 9 s of main-thread framing
  work does not shorten the payload span: the main thread is not the payload
  limit at this size of saving. Patch kept at `screen-B1/candB1.patch`.
  Worktree removed.
- Interleaved review repairs (outside the loop, from the follow-up review in
  `libreoffice-fundamentals-review-2026-10-20.md`): R5 receipt recovery
  matches the stored canonical root exactly; R6 scan policy probes read
  through the directory descriptor (`openRegularFileAtDirectoryDescriptorSync`).
- Next: stop the loop. Ask Hamza about B2 and off-main-thread or overlap
  architecture (navigation 63-70 s and finalize_collection 22-25 s are serial).
- Hamza approved option 2 (overlap and off-main-thread architecture), design
  first. Design below. No code until Hamza approves a proposal.

## Overlap design (option 2), 20 October 2026

Source run: `screen-B1/base-2` (critical path 357.9 s). Times are seconds
from server start.

### Dependency graph of the full index

`index-generation-workflow.ts` full-index flow (about lines 780-1000):

| Stage | Span (s) | Needs | Produces |
| --- | --- | --- | --- |
| policy observe | 0-30 (29.8) | root control files | ignore patterns, control signature |
| scan | 30-50 (20.0) | policy | `codeFiles`, publication source controls |
| payload analysis | 52-259 (205) | `codeFiles` | symbols, `analysisByFile`, `sourceFiles` (hash + stat) |
| payload drain + finalize | 259-304 | analysis | searchable collection |
| prepare_changes | 260-276 (15.9) | captured hashes and stats | `fileHashes` (captured + auxiliary), source checkpoint |
| navigation | 276-346 (69.7) | analysis, `fileHashes` | staged navigation |
| publication | 346-357 (11) | navigation, drain, checkpoint | active Publication |

Facts that constrain the design:

- Navigation uses `preparedChanges.fileHashes` only in
  `collectSemanticAuxiliariesForLanguage` (workflow :1878). That function
  reads semantic auxiliary files (for example build files for Java) and
  checks each hash against the map. Everything else in navigation uses
  analysis output. So the 15.9 s prepare_changes wait protects only the
  auxiliary-file inputs.
- The source checkpoint and `assertSourceObservationCurrent` (8.3 s at
  publication) stay the authority for "source unchanged". Every proposal
  keeps both checks.
- The policy walk (`observeNestedGitignores`, ignore-file-inputs.ts:114) is
  a serial `readdirSync` walk by design (warm: sync 3 s vs promise 10 s). In
  base-2 it is cold and takes 29.8 s. The scan (`getCodeFiles`, 16 reads in
  flight) then reads the same directories again and stats every file. No
  span splits the 20.0 s scan into readdir, stat and source-control parts.
- Navigation profile (`profile-2/navigation.txt`, 63.6 s window): 22.7 %
  idle, Python resolution about 13 s self time, `serializeShardJson` 3.1 s,
  file system calls (open, close, stat, write, mkdir) about 11 s.
- Stage sub-spans: symbols 9.1 s, relationships 14.9 s, fsync_tree 5.7 s.
  `writeSymbolRegistrySidecarInternal` (sidecar-lifecycle.ts:311) needs only
  the registry, not the relationship records.
- Java semantic: language loop 9.6 s, of which `analyze` is 4.5 s. The other
  5 s re-read and re-hash every Java source and the auxiliary files.
- Payload analysis alone ends at 259 s. Without a faster payload, the 200 s
  goal is not reachable by overlap. Overlap can remove at most the serial
  work after 259 s (about 98 s) and part of the 50 s before 52 s.

### Proposals, ranked by expected critical-path saving per risk

P1. prepare_changes in parallel with navigation (expected 10-16 s).
- Start `synchronizer.prepareChanges` and navigation at the same time after
  analysis. Navigation gets the auxiliary files from its own observation:
  the scan already walks the same tree with the same ignore matcher, so the
  scan also returns the semantic auxiliary paths (`isSemanticAuxiliaryFilename`).
  Navigation reads and hashes them as today.
- Before publication, a new check requires that the auxiliary paths and
  hashes navigation used equal the auxiliary entries of
  `preparedChanges.fileHashes`. A mismatch throws
  `source_observation_changed`, the same error class as today.
- Failure handling: if either branch throws, the workflow awaits the other
  branch before it rethrows (no background work after return). Navigation
  stays staged, not published, so a failure leaves nothing published.
- Interface change: `getCodeFiles` (or a new scan result field) returns the
  auxiliary paths. `stageSymbolRegistryForCompletedIndex` takes auxiliary
  observations instead of `observedFileHashes`.
- Equivalence test: same artifacts with and without an auxiliary file, a
  test where an auxiliary file changes between the two observations (must
  fail before publication), and a fault-injection test where
  prepare_changes throws while navigation runs.

P2. Stage symbol sidecars in parallel with semantic and relationships
(expected 4-9 s).
- Start `writeSymbolRegistrySidecarInternal` right after the registry is
  built, and join it in `stagePublicationNavigation`. The symbol shards then
  overlap the Java semantic run (worker) and Python resolution. The file
  system part overlaps on the main thread. The 3.1 s of JSON serialization
  overlaps only if it moves to a worker thread (second step, only if the
  first step measures less than 4 s).
- Invariant: the symbol manifest hash and the fsync of the full build tree
  stay after both writes complete. Same join-before-throw rule as P1.

P3. Remove the Java source re-read in semantic (expected about 4 s, not
overlap).
- Reuse the analysis-time content when `sourceFiles` keeps it, else keep the
  read. Listed for completeness: it needs a memory check (Java content of
  LibreOffice in RAM until navigation ends) and is a cache, so it needs a
  witness (the captured hash) and a differential test.

P4. Merge or parallelize the policy walk and the scan (up to 20-30 s, not
yet measurable).
- Step 1 is measurement only: add sub-spans to the scan (readdir, stat,
  source controls) and time a cold policy walk serial vs 16 reads in flight.
- Then choose one: (a) the policy walk keeps its directory listings and the
  scan reuses them (saves the second readdir), or (b) a parallel cold walk.
  The scan cannot start before the policy is resolved, so plain overlap is
  not possible.

P5. Split relationship building by language so non-Java languages resolve
while Java semantic runs (up to 9.6 s, high risk). Deferred: the builder
takes all evidence in one call, and record order must stay deterministic.

Not proposed: moving `assertSourceObservationCurrent` earlier (it must stay
the last source check), and streaming navigation into the payload window
(the registry and relationships need the complete analysis).

### Open decisions (recommendation first)

1. Order: P1, then P2, then P4 measurement. Recommended: the three give an
   expected 15-25 s now, and P4 decides if the pre-payload 50 s can shrink.
2. P1 auxiliary source: from the scan walk (recommended, no extra walk) or a
   separate small walk (simpler interface, adds a third cold-ish walk).
3. P3 and P5: defer until P1 and P2 are measured. Recommended.

### Measurement plan

Per proposal: one screening pair (both orders if the gain is under 15 s),
then 3 + 3 runs if the screening gain exceeds the ±10 s noise. Report
median critical path, navigation span, peak anonymous memory and start
load. Artifacts must stay identical (`compare.mjs` exit 0). The PC must
stay awake during each pair.
