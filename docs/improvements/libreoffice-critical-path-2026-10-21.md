# LibreOffice full index: critical path after Candidate C, 21 October 2026

Status: analysis checkpoint. No product code changed. The window screening experiment confirms the
producer claim (section 5.1): window 32 saves 26.3 s of producer time with identical output.

Inputs: the Candidate C report is in the Codex worktree
`~/.codex/worktrees/d59b/satori` (`docs/improvements/candidate-c-payload-worker-report-2026-10-21.md`,
uncommitted). Evidence: `~/repo/bench-bugs/libreoffice-perf-20261020/napi-loop/payload-attribution-20261021/screen-C`.
Earlier context: [findings](libreoffice-performance-findings-2026-10-20.md) and
[architecture and optimizations](indexing-architecture-and-optimizations-2026-10-21.md), section 6.

## 1. Result

Candidate C, B1, and P1 each removed work that is not on the critical path. The critical path of a
full index is serial: scan → payload producer → `prepare_changes` → navigation → publication checks.
The vector writes and the payload drain run in the background and add no time.
Inside the producer, `index.analysisWait` takes 192 of 212 s.

## 2. Timeline (inline-2, from `stderr.jsonl` timestamps)

| Time (UTC) | Event |
| --- | --- |
| 23:54:45.5 | `payload.producer` ends (211.9 s) |
| 23:54:46 to 23:55:07.3 | `index.prepare_changes` (21.0 s) on the main thread |
| 23:55:06.4 | last LanceDB write (write 67, the tail batch) ends, inside `prepare_changes` |
| 23:55:06.5 | `payload.queue` ends (232.8 s) |
| 23:55:07 to 23:56:21 | navigation (about 74 s) |
| 23:56:21.3 | `publication.payload_drain` waits 0 ms |

worker-1 shows the same order: producer ends 23:38:01.1, `prepare_changes` ends 23:38:19.6 (17.8 s),
`payload.queue` ends 23:38:22.2, and `publication.payload_drain` waits 0 ms.

Code order (`generation/index-generation-workflow.ts`, about lines 858-942): the workflow starts
`payloadDrain` in the background, awaits `synchronizer.prepareChanges`, runs navigation, then awaits
`payloadDrain`.

Full timeline (Codex gpt-6.1-sol cross-check, read-only; seconds from benchmark start, matching
`criticalSeconds`; the operation starts 3.555 s later). Endpoints come from pipe receipt times in
`session.mjs`, so they are approximate.

| Inline-2 stage | Start-end (s) | Duration (s) |
| --- | ---: | ---: |
| Scan | 3.678-22.958 | 19.3 |
| Producer | 22.964-234.828 | 211.9 |
| Payload drain | 234.828-255.780 | 21.0 |
| Source preparation (`prepare_changes`) | 235.714-256.672 | 21.0 |
| Collection finalization | 255.779-282.712 | 26.9 |
| Navigation | 256.672-330.613 | 73.9 |
| Publication preparation | 330.613-346.702 | 16.1 |
| Activation through commit | 346.702-347.251 | 0.5 |

Critical path: scan → producer → source preparation → navigation → publication. Navigation
starts 0.9 s after the drain ends. The drain and source preparation end within 1 s of each other.
Possible reason: the drain waits before `table.add` while synchronous scanning holds the main
thread. The traces do not separate the two causes.

Navigation internals: registry 256.7-260.0, semantic (Java 11.7 s) 260.3-273.1, relationships
273.1-301.6, staging 301.6-330.6 (symbols 9.5 s, relationships 15.5 s, `fsync_tree` 3.9 s).
Finalization ends at 282.7 s and publication waits for it. So only about 47.9 s of navigation is
exposed. If navigation got faster by more than that, finalization would become the critical step.

## 3. Consequences

- **Measure the producer, not the payload.** `payloadSeconds` equals producer plus drain. The drain
  overlaps `prepare_changes` and is not on the critical path. Candidate evaluations must report
  `payload.producer` and time to publication.
- **Candidate C did not test the main-thread hypothesis cleanly.** In worker runs,
  `documents.map(normalizeLanceDbRow)` (`vectordb/lancedb-vectordb.ts:581`) runs on the main thread
  before the `payload.lance_rows` timer starts. The drop in `lance_rows` from 16.9 s to 8.1 s
  therefore overstates the main-thread saving. The 42 inline batches fall from about 250 to about
  190 ms per batch for that reason alone. Main-thread CPU stays at about 177 s in both variants.
- **Main-thread CPU and window latency are two different hypotheses.** Findings section 5 says the
  payload is limited by main-thread CPU (82% busy). B1 and C removed small amounts of CPU with no
  gain. A second mechanism fits the same data: the analysis window is small and ordered, so each
  main-thread stall delays the next file. Section 4 describes it.

## 4. Producer hypothesis: the analysis window is latency-bound

Observations (code):

- `indexing-pipeline.ts:883`: `analysisWindow = min(max(1, concurrency) × 2, plan.analysisWindowFiles)`.
  With 4 analysis workers the window is 8 files, consumed in path order. No environment variable
  widens it past `concurrency × 2`.
- `readIndexableFileObservationInsideRoot` (`indexing-pipeline.ts:405-469`) awaits, per file:
  `openRegularFileInsideRoot` (realpath, lstat, open, fstat, readlink), `handle.stat`, an optional
  policy read, `readFileHandleExactly`, `handle.stat`, a second `openRegularFileInsideRoot`,
  `currentPathHandle.stat`, and two `close` calls. Each await needs a free main-thread turn.
- Analysis workers are 71-80% idle (`payload.worker.cpu` 165-171 s for 4 workers).
  `payload.worker.transfer` sums to 68-72 s.
- The charged queue never reaches its 64 MiB bound: `backpressureCount` is 0.

- Codex cross-check: the producer outside `index.analysisWait` is only 20.0 s. Ordered persistence
  waits 139.4 s and embedding slots wait 142.7 s, but those waits do not block producer admission.
  Potion helpers spend 29-54% of their time waiting for input. The traces have no per-file
  submission, completion, or consumption timestamps, so they cannot name the file that gates the producer.
- In worker-1, the producer is 4.9 s slower than in inline-2 although row encoding falls 8.8 s.

Inference (not verified): when the main thread runs a 200-400 ms callback (Potion response parsing,
row encoding, symbol facts), all 8 file chains stop at their next await. The workers and the Potion
helpers then wait for input. If this is true, a wider window hides the stalls without removing CPU.

Unverified numbers from an external review: about 17 awaits per file, about 600,000 event-loop turns
in total, and 18.7 s of main-thread fs CPU in `analysis.json`. The findings doc measured 14.6 s for
`openInsideRoot` in r14.

## 5. Next experiment (screening)

| Claim | Disproving check | Stop when |
| --- | --- | --- |
| The producer is latency-bound by the 8-file window. | Widen the window to 32 files in an experiment worktree (change `× 2` at `indexing-pipeline.ts:883` and the plan value), then run one interleaved pair against the unchanged build with the existing harness. If `payload.producer` does not fall by more than the about 10 s noise, the claim is false. | One pair gives a clear result. If the claim holds, run three interleaved runs per variant, check the artifact comparison, and check peak memory under the 6 GiB cgroup. If it fails, return to the main-thread CPU hypothesis. |

Risk: a wider window keeps more source files and analysis results in memory. The resource plan
derives the window from the memory budget (`indexing/resources.ts:202`). The experiment must record
the anonymous memory peak.

### 5.1 Result: the claim holds

Evidence: `~/repo/bench-bugs/libreoffice-perf-20261020/napi-loop/payload-attribution-20261021/screen-W`.
The d59b worktree build got a temporary environment override that replaced the window file count
(`min(concurrency × 2, plan)`) with 32, plus a trace event that records the value used. One build
served both variants, which ran alternately under a 6 GiB cgroup with no swap. The override has
been removed, and the build again matches `screen-C/build.sha256`.

Medians of four runs per variant (`base-1..4` window 8, `w32-1..4` window 32):

| Metric | Window 8 | Window 32 | Change |
| --- | ---: | ---: | ---: |
| Critical path | 323.3 s | 291.1 s | -32.2 s |
| `payload.producer` | 195.9 s | 169.6 s | -26.3 s |
| `index.analysisWait` | 176.8 s | 140.4 s | -36.5 s |
| Peak anonymous memory | 4,434 MiB | 4,416 MiB | -18 MiB |

- The ranges do not overlap: the slowest window-32 producer (172.6 s) beats the fastest window-8
  producer (192.1 s), and the slowest window-32 critical path (304.4 s) beats the fastest window-8
  critical path (309.5 s).
- Window-32 runs mostly started on a busier machine (1-minute load 3.43, 5.40, 4.06, 4.38 against
  0.71, 1.57, 3.59, 4.34).
- The first pair showed -74.7 s on the critical path because `base-1` was a slow outlier (371.5 s).
- `compare-full-index.mjs` over all eight runs: 547,349 rows and 71,523 navigation files with
  identical row, source and navigation hashes in every run, equal to the `screen-C` hashes.
- `index.analysisWait` is still 140 s at window 32. The window is a lever on the per-file latency,
  not its cause.

Only after this result: decide between the per-file read path (synchronous descriptor reads, one
open per file), B2, and the navigation items.

## 6. Other targets (known, not re-measured here)

| Target | Size | Prior result |
| --- | ---: | --- |
| Navigation, serial | 73.9 s gross, 47.9 s exposed (finalization ends at 282.7 s) | Plan item 4: `navigation.stage.mkdir` makes 35,764 symbol and 35,763 relationship calls (summed async time 219 s and 44 s, mostly overlapping). P2 net 1.7 s. |
| `prepare_changes`, serial | 18-29 s | P1 (parallel with navigation) is slower. D (verdict cache) saves 0.5 s. |
| Publication preparation | 16.1 s (`publication.source_current` 11.9 s) | Not tested. |
| B2 binary Potion vectors | at most about 10-20 s of main-thread CPU | B1 (framing) saves 3.3 s, within noise. Useful only where main-thread stalls delay the window. |

External estimates of 85-115 s total saving and a 178 s floor exist. They add overlapping savings
and are not measured. This document does not rely on them.
