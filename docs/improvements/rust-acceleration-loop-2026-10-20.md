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
- Next: candidate A slice = remove both lease hooks (update the five tests
  that encode them) and replace `supported()` with one linear pass or move it
  into the addon. Then step 4 screening pair.
