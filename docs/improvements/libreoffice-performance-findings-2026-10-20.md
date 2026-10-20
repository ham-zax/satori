# LibreOffice indexing: performance findings, 20 October 2026

This note records what the LibreOffice runs r10 to r14 and the scratch
benchmarks show: why each part is slow, which form is fast, and when to use
it. The plan and the run tables are in
`libreoffice-200s-implementation-plan-2026-10-20.md`.

Machine for all numbers: WSL2 on Windows, ext4, 16 cores, about 7 GB RAM,
Node v24.19.0. Corpus: LibreOffice, 149,719 files in 9,249 directories,
35,760 indexed files, 547,349 chunks. Full runs use MemoryMax=6G.

## Run results

| Metric | r10 | r12 (`664051e3`) | r13 (`71cc4659`) | r14 (profiled) | r15 (`c4458339`) |
| --- | --- | --- | --- | --- | --- |
| Critical path | 696.1 s | 600.6 s | 494.0 s | 500.8 s | 449.2 s |
| `index.payloadPipeline` | 352.8 s | 232.9 s | 238.2 s | 247.0 s | 253.6 s |
| `index.navigation` | 177.1 s | 213.1 s | 100.1 s | 91.4 s | 67.0 s |
| `fsync_tree` | 81.1 s | 123.4 s | 8.0 s | 6.7 s | 4.4 s |
| Peak anonymous memory | 4,222 MiB | 4,248 MiB | 4,310 MiB | 4,139 MiB | 4,391 MiB |

The goal is a critical path of 200 s or less.

## Rules

### 1. Durability of many new files: use one `syncfs`, not one `fsync` per file

- Finding: the staged navigation tree has 71,523 files (1.04 GB). Each file
  got its own `fsync`. In r12 that took 123.4 s.
- Measurement (scratch benchmark, ext4 on WSL2, 64 concurrent fsyncs,
  UV_THREADPOOL_SIZE=16): 71,523 files of 14.6 KB took 66.2 s with one
  fsync per file. One `sync -f` took 7.7 to 8.1 s. For 20,000 files: 16.3 s
  against 0.34 s.
- Why: each `fsync` waits for one journal commit. One `syncfs` flushes the
  whole filesystem with one commit.
- When: use `syncfs` if the tree is on one Linux device with ext4, xfs or
  btrfs. Else, use one fsync per file. `syncStagedFileSystem` in
  `packages/core/src/symbols/sidecar-lifecycle.ts` makes this decision.
- Result: `fsync_tree` 123.4 s to 8.0 s (r13). Commit `71cc4659`.

### 2. Repeated pure work: compute once per input, not once per use

- Finding: `splitIdentifierComponents` split the same identifier tokens many
  times for each chunk. In r11 it used 62.7 s of main-thread CPU (21 % of
  the payload window). `buildSearchProjections` used 104.8 s inclusive.
- Fix: `createIdentifierSplitter` in `core/search-projections.ts` keeps the
  split result of each token for one chunk. A differential test compares it
  with an uncached reference copy.
- Result: microbenchmark on 26,938 chunks: 7,275 ms to 3,317 ms. Commit
  `664051e3`.
- Remaining: in r14, `buildSearchProjections` still uses 52.6 s inclusive
  (21 % of the payload window). This is the largest single cost in the
  payload.

### 3. Many small file-system calls: sync calls are much cheaper than promise calls

Scratch benchmark on the 149,439 corpus files, 16 calls in flight for the
promise forms:

| Operation | Promise form | Sync form |
| --- | --- | --- |
| `lstat` | 4,731 ms (8,106 ms CPU) | 590 ms |
| `realpath` | 1,748 ms (5,535 ms CPU) | 2,846 ms (`realpathSync.native`) |
| Probe: open, read 16 bytes, close | 15,665 ms (24,032 ms CPU) | 1,019 ms |

- Why: each promise call allocates a request and a promise, crosses to the
  libuv thread pool and back, and resolves on the main thread. On WSL2 that
  costs about 30 to 100 µs of CPU for each call. The syscall itself costs
  about 4 to 7 µs. A larger thread pool does not help: the validating scan
  took 34.3 s with 4 threads and 34.6 s with 16.
- When to use sync calls: many small metadata calls (`lstat`,
  `realpath`, a short probe read) on local files, in a loop over a whole
  tree. Keep each block short: a scan must yield between directories, so
  that the event loop does not stop for long.
- When to keep promise calls: large reads, hashing whole files, and work on
  a filesystem that can be slow (for example a network mount), because a
  sync call blocks the event loop for the full call.
- Do not use `fs.realpathSync` without `.native`. The plain form is a
  JavaScript loop of `lstat` calls. `.native` is the same `realpath(3)` that
  the promise form uses.

### 4. The synchronizer scan: most calls are for files that it never keeps

- Finding: each validating scan (`prepare_changes`, `source_current`) took
  about 34 s. It made 158,622 `realpath`, 167,852 `lstat` and 76,823
  `open` calls to keep 35,769 files. A warm `fd` walk of the same tree takes
  0.09 s.
- Why: the scan calls `lstat` and `realpath` for every file that is not
  ignored. For every extension that the language registry does not know
  (46,189 `.png`, 45,007 `.svg` and others), the policy opens the file and
  reads its first bytes to look for a shebang (`#!`). That is about 67,600
  probes for each scan.
- The full index walks the tree four times before publication:
  `observe_inputs` 31 s, `index.scanFiles` 28.5 s, `prepare_changes` 53 s
  (`finalize_collection` 27 s runs in parallel), and `source_current`
  36.5 s. Together that is about 149 s of the critical path.
- Fixed in `427ec19d`: `lstat`, `realpath` and the policy probe in sync
  form. The validating scan time goes from 34.3 s to 17.3 s, with the same
  35,769 files. In r15, `index.scanFiles` is 21.9 s (r13 28.6 s),
  `prepare_changes` is 46.3 s (53.1 s) and `source_current` is 22.7 s
  (36.5 s). `observe_inputs` stays at 31.7 s.
- The remaining 17 s is mostly the 9,231 directory opens. Each directory
  open does several promise calls (open, fstat, readlink, realpath), and the
  scan visits one directory at a time.

### 5. "Analysis wait" does not mean that the analysis workers are slow

- Finding: `index.analysisWait` is 174 to 183 s. But the analysis worker
  threads are idle 82 % (r11, thread 1) and 76 % (r14, thread 1) of the
  payload window. The 4 workers use 165 s of CPU in total over 238 s.
- Why: the span measures the time from the request for the next file until
  the main thread uses its result. During that wait, the main thread runs
  other callbacks: embedding responses, vector writes, projections. The main
  thread is 82 % busy (196 s of CPU in 238 s).
- Rule: the payload is limited by main-thread CPU. More analysis workers do
  not help. Remove main-thread work, or move it to another thread.

### 6. Payload main thread: remaining costs (r14, 247 s window)

| Cost | Inclusive | Owner |
| --- | --- | --- |
| Search projections | 52.6 s | `core/search-projections.ts` |
| Embedding transport (JSON over stdout, `handleStdout`, `handleFrame`, `TextEncoder.encode`) | about 20.6 s | `embedding/potion-embedding.ts` |
| LanceDB row encoding (`encodeSearchableRow`) | 15.6 s | `vectordb/lancedb-vectordb.ts` |
| File open checks (`openInsideRoot`: realpath, lstat, fstat, readlink per file) | 14.6 s | `sync/root-bound-fs.ts` |
| Symbol facts | 6.6 s | `symbols/registry.ts` |
| Garbage collection | 15.2 s | |
| Idle | 44.1 s | |

### 7. Navigation: the mutation lock check costs 18 s

- Finding (r14): `assertCurrent` → `isCurrent` → `withRootLock` in
  `generation/root-mutation-coordinator.ts` uses 17.8 s inclusive (19 % of
  the navigation window). `sleepSync` alone uses 11.1 s.
- Why: the relationship phase checked the mutation lease on every call, and
  each check takes the root lock and can wait in a sync sleep.
- Fixed in `c4458339`: the check runs once per yield to the event loop. In
  r15, `navigation.relationships` is 24.3 s (r13 50.6 s) and
  `index.navigation` is 67.0 s (r13 100.1 s).
- Other navigation costs: relationship resolution 41.6 s inclusive, of which
  Python resolution is 19.3 s.

## Method notes

- Profile before a change. Use `--cpu-prof` on the full run, then
  `analyze.mjs` (in the `full-r11-prof` bench folder) for one time window.
  The mutation index worker main thread (thread 0) runs the payload and
  navigation. Threads 1 to 4 are the analysis workers.
- Map the profile clock to the span clock with a span that both contain.
- A CPU profile adds overhead (r14 is about 7 s slower than r13). Compare
  profiled runs only with profiled runs.
- For fs costs, a small scratch benchmark on the real corpus gives a clear
  answer in a few minutes. It counts calls by type and times one scan.
