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
- Step 6: Candidate A committed on `exp/napi-projections`.
- Next: profile the Candidate A build (step 1 again) and re-rank. Expected
  leaders from profile-1: Potion transport 18.7 s (B), policy admission in
  the payload (TypeScript), `encodeSearchableRow` 14.0 s (C), the
  in-payload sync-scan 10.5 s.
