# Full-index architecture and optimization record, 21 October 2026

This note explains how a Satori full index runs and lists each optimization:
what changed, why (intent), and what the measurement showed (outcome). It
also records the rejected candidates and the plan for more speed. It is the
summary of the detailed loop notes. Numbers come from those notes, and each
section names its source.

Machine for every LibreOffice number: WSL2, ext4, 16 cores, about 7 GB RAM,
Node v24.19.0, cgroup MemoryMax=6G, index memory budget 4,400 MiB, 4
analysis workers. Corpus: LibreOffice, 149,719 files, 35,760 indexed files,
547,349 chunks. "Total" means server start to `publication.commit`.

Source notes: `libreoffice-performance-findings-2026-10-20.md` (r10-r17),
`napi-rs-indexing-experiment-2026-10-20.md` (ranked costs, napi-rs rules),
`napi-rs-implementation-2026-10-20.md` (first native slice),
`rust-acceleration-loop-2026-10-20.md` (loop state, overlap design, P4').

## 1. Result

| Point | Commit | Total | Note |
| --- | --- | --- | --- |
| r10 | before `664051e3` | 696.1 s | First measured LibreOffice full index. |
| r16 | `78d5c4f0` | 403.9 s | After the TypeScript fixes of section 3.1. |
| Loop start, native opt-in | `ee5e91ca` | 411.4 / 421.4 s | TypeScript reference 415.8-447.8 s. |
| Candidate A | `207496e6` | 337.0 s median | TypeScript reference 375.1 s median. |
| P4' watcher start | `24bbfe5b` | 304.8 s median | Base 343.6 s median, same build without P4'. |
| Native default | `d434fa96` | 391.3 s (1 run, loaded) | Same code path as P4' native; no env var needed. Load rose from 0.5 to 6.4 during the run, so it does not replace 304.8 s. |

The goal of 300 s is not reached: the median is 304.8 s, about 5 s above.
The longer-term goal of 200 s needs a faster payload (section 6).

## 2. Architecture of a full index

Owner of the flow: `IndexGenerationWorkflow`
(`packages/core/src/core/index-generation-workflow.ts`, full-index path
about lines 780-1000). The MCP server (`packages/mcp`) starts the operation
through `FullIndexOperation` and owns the file watcher
(`packages/mcp/src/core/sync.ts`).

| Stage | Span | Owner | Needs | Produces |
| --- | --- | --- | --- | --- |
| Policy observe | `index.policy.observe_inputs` | `core/ignore-file-inputs.ts` | root control files | ignore patterns, control signature |
| Scan | `index.scanFiles` | `core/indexing-pipeline.ts` (`getCodeFiles`) | policy | `codeFiles`, source controls |
| Payload | `index.payloadPipeline` | `core/indexing-pipeline.ts`, `core/indexing-projection-stream.ts` | `codeFiles` | chunks, search projections, vectors, LanceDB rows, symbols, file hashes |
| Prepare changes | `index.prepare_changes` | `Synchronizer.prepareChanges` | captured hashes and stats | `fileHashes`, source checkpoint |
| Navigation | `index.navigation` | `symbols/*`, `relationships/*` | analysis, `fileHashes` | staged symbol and relationship sidecars |
| Publication | `publication.*` | generation and publication owners | navigation, payload drain, checkpoint | active Publication |

Inside the payload, per file batch:

1. Read and admit each file (`sync/root-bound-fs.ts` `openInsideRoot`,
   `config/index-policy.ts`).
2. Parse and chunk in tree-sitter WASM analysis workers (4 threads).
3. Build search projections for each chunk (`core/search-projections.ts`,
   or the native addon through `core/native-search-projections.ts`).
4. Embed the chunks with the Potion helper process
   (`embedding/potion-embedding.ts`, JSON frames over stdout).
5. Encode rows and write them to LanceDB (`vectordb/lancedb-vectordb.ts`).

Safety rules that every optimization keeps:

- Nothing publishes on failure. Navigation is staged, and the publication
  checks (`assertSourceObservationCurrent`, policy check) run last.
- Published artifacts are byte-identical between the TypeScript path and
  any fast path. Each change is checked with `compare.mjs`: same row hashes,
  source hash and sidecar hashes.
- The mutation lease protects writes. The write guard
  `flushVectorWriteBuffer` checks it before each vector write.

## 3. Optimizations that stayed

### 3.1 TypeScript fixes, r10 to r17 (findings note)

| Commit | What | Why (intent) | Outcome |
| --- | --- | --- | --- |
| `664051e3` | `createIdentifierSplitter` splits each identifier token once per chunk. | `splitIdentifierComponents` repeated the same work and used 62.7 s of main-thread CPU in r11. | Total 696.1 to 600.6 s (r12). Payload 352.8 to 232.9 s. |
| `71cc4659` | One `syncfs` for the staged navigation tree, not one `fsync` per file. | 71,523 files with one `fsync` each took 123.4 s in r12. | `fsync_tree` 123.4 to 8.0 s. Total 494.0 s (r13). |
| `c4458339` | Relationships check the mutation lease per yield, not per call. | Each check took the root lock and could sleep: 17.8 s in r14. | Navigation 91.4 to 67.0 s. Total 449.2 s (r15). |
| `78d5c4f0` | The sync scan opens directories synchronously and verifies each directory once. | Each validating scan made about 158,622 `realpath` and 167,852 `lstat` calls to keep 35,769 files. Sync calls are much cheaper than promise calls here. | Total 403.9 s (r16). |
| `cfac56cc` | Nested ignore-file directories are read synchronously. | The ignore-file walk was promise-based. Alone, sync took 1.2 s against 2.3 s. | Walk faster alone. The full-run gain was hidden by watcher contention (fixed by P4'). |

### 3.2 Native search projections (napi-rs addon)

- What: a Rust addon (`experiments/napi-search-projections/`, built with
  napi-rs) builds the four search-projection fields for a batch of chunks
  on the libuv thread pool (`AsyncTask`).
- Why: projections were the largest main-thread cost in the payload
  (52.6 s inclusive in r14). Pure string work fits Rust, and an async task
  takes the work off the main thread.
- Contract (`ee5e91ca`): ASCII only. The addon returns "unsure" for Unicode,
  lone surrogates, tokens over 256 bytes and more than 256 breadcrumbs, and
  the TypeScript builder handles those inputs. A call takes at most 64
  chunks and 4 MiB of input, with a 16 MiB output budget. A failed batch is
  discarded whole. Rust panics stop at the task boundary. Cancellation uses
  an atomic flag, and the wrapper waits for native work to settle.
- Candidate A (`207496e6`): the per-batch lease hooks were removed (20.6 s,
  mostly `sleepSync`), and the backtracking support regex was replaced by
  one `charCodeAt` pass (`nativeInputBytes`, 586.9 to 135.4 ms on 12,643
  chunks). The lease stays checked at the write guard.
- Outcome: median total 375.1 s (TypeScript) to 337.0 s (native), 3 runs
  each. Every native run was faster than every TypeScript run. Artifacts
  identical. On LibreOffice, 535,893 of 547,349 projections are native and
  11,456 use the fallback.

### 3.3 P4': start the watcher when the source scan ends (`24bbfe5b`)

- What: Core reports the end of the source scan through
  `onSourceScanCompleted`. `FullIndexOperation` starts the candidate watcher
  at that point, not before the index.
- Why: the chokidar crawl of the whole root ran at the same time as the
  policy walk. The walk took 28.6 s in a full run against 1.1-1.2 s alone,
  and the root was crawled twice.
- Outcome: median total 343.6 to 304.8 s (-38.8 s), 3 runs each.
  `observe_inputs` 28 s to 1.1 s. Artifacts identical. No run logged an
  unverified source handoff or a watcher failure.

### 3.4 Native projections become the default (`d434fa96`)

- What: the prebuilt linux-x64 addon ships in
  `packages/core/assets/native-projections/linux-x64/` with `manifest.json`
  (SHA-256) and `THIRD_PARTY_NOTICES.md`, the same pattern as the Potion
  helper. `resolveNativeProjectionAddonPath` in
  `core/native-search-projections.ts` decides:
  - `SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS` set to a path: use that addon.
  - Set to an empty string: TypeScript path.
  - Unset, linux-x64, and the bundled file matches the manifest hash: use
    the bundled addon (the hash check runs once per asset root).
  - Otherwise: TypeScript path. The output is the same.
- Why: users run one command (`npx @satori-code/cli install`) and get the
  fast path with no extra step.
- Checks: `native-search-projections.test.ts` (manifest matches the files,
  resolution rules, bundled addon parity against `buildSearchProjections`).
  Mutations (no hash check, old opt-in default, no platform gate) each fail
  a test. Core and MCP suites pass. A packed-tarball install loads the addon
  from `node_modules/@satori-code/core/assets/...` and indexes with 2,571
  native and 59 fallback projections on the `claive` repository.

## 4. Candidates that were measured and dropped

| Id | What | Why tried | Outcome and reason |
| --- | --- | --- | --- |
| D | Admission verdict cache behind a stat witness | The profile showed 21-36 s of shebang probe reads in the later scans. | Gain about 0.5 s. The CPU profile overstated blocking I/O: unprofiled, `prepare_changes` was 14.1 s, not 35.9 s. Patch `screen-D/candD.patch`. |
| B1 | Potion stdout framing with `Buffer.indexOf` | 9 s of main-thread framing work. | Framing 374.0 to 28.8 ms in a microbenchmark, but the total gain was 3.3 s, inside the ±10 s noise. The main thread is not the payload limit at this size of saving. Patch `screen-B1/candB1.patch`. |
| P1 | `prepare_changes` in parallel with navigation | 15.9 s serial wait before navigation. | Java semantic needs the hashes about 3 s into navigation, and a parallel `prepare_changes` is slower: 95 s against 88 s serial. |
| P2 | Write symbol sidecars during semantic analysis | Stage 33 s. | Stage saved 16.9 s, but semantic analysis lost about 14 s on the shared disk. Net 1.7 s, noise. Patch `screen-P2/candP2.patch`. |

Method lessons:

- Check the unprofiled span before a candidate that targets a sync-I/O
  frame. The profiler inflates blocking I/O.
- A main-thread saving shortens the payload only when the main thread is
  the limit. Measure the span, not only the CPU time.
- The 6 GiB cgroup charges the page cache. Probed files leave the cache
  between scans, so the run order changes cold and warm costs. Interleave
  runs and report the order.

## 5. Validation on other repositories (21 October 2026)

Three Codex workers (gpt-6-luna max) and the parent ran each repository with
the default build (native) and with `SATORI_EXPERIMENTAL_NATIVE_PROJECTIONS=`
(TypeScript), under `tools/heavy.sh` (flock, MemoryMax=6G). Tools:
`bench-bugs/multi-repo-native-20261021/tools/` (`run.mjs default|typescript
CORPUS RUN`, `compare.mjs`, `heavy.sh`).

| Repository | Artifacts | Search | Native | TypeScript | Runs |
| --- | --- | --- | --- | --- | --- |
| codebase-memory-mcp (C) | identical, 147,803 rows, 3,953 sidecars | not checked | 139.0 s median | 143.9 s median | 3 per variant, interleaved |
| trufflehog (Go) | identical, 28,444 rows, 6,927 sidecars (checked twice) | top-8 identical for 5 queries | 32.8 s | 34.3 s | 1 per variant |
| claive (Python) | identical, 2,630 rows | top-8 identical, 2 sessions | 7.76 s | 7.65 s | 1 per variant |
| webharness, create + incremental sync | 13,995 rows identical after corpus-path normalization | added file found, deleted file absent | create 18.1 s, sync 6.2 s | create 15.9 s, sync 6.8 s | 1 per variant |
| LibreOffice | native 535,893 / fallback 11,456, same as P4' | not checked | 391.3 s | not rerun | 1, loaded (end load 6.4) |

Outcome: native output equals the TypeScript output on every repository.
Native is faster on the two larger repositories (3-4 %) and on LibreOffice
(section 3.2: 337.0 s against 375.1 s median). On the small repositories the
difference is within single-run noise. The first trufflehog search difference
came from a background gen-2 sync (`sync_in_progress`), not from the native
path; the recheck under equal conditions was identical. The new LibreOffice
run is invalid as a timing because other work loaded the machine. A quiet
rerun is still needed to confirm 304.8 s with no env var.

Packaged check: `pnpm pack` of core, mcp and cli, installed with npm, resolves
`assets/native-projections/linux-x64/projection.node` and indexes claive
(2,571 native / 59 fallback).

## 6. Plan for more speed

Timeline of the P4' native run `screen-P4/candP4-2` (seconds from server
start): payload ends at about 216 s, `prepare_changes` 216-231 s,
navigation 231-296 s, `finalize_collection` ends at 257 s, publication
296-305 s. `finalize_collection` overlaps navigation and ends 39 s before
it, so it is not on the critical path. After the payload, about 89 s of
serial work remains (`prepare_changes`, navigation, publication). For a
200 s total with that tail unchanged, the payload must end by about 111 s.

Ranked next actions (revised after review):

1. Find the payload limit. Measure in one run: Potion helper processing
   time, helper queue waits, vector write time, storage backpressure, and
   input starvation of the analysis workers. Several stages can limit the
   pipeline together, so no single stage needs to explain all of the span.
   B1 shows only that its specific CPU saving gave no reliable wall-time
   gain. Stop when the measurements explain the payload span, and use them
   to choose between actions 2 and 3.
2. Binary Potion vectors (B2), only if serialization, decoding or transport
   limits throughput. The profile supports about 7 s of `JSON.parse` cost.
   It does not establish the wall-time saving, and it does not justify more
   helper processes. Needs a rebuilt shipped helper and Hamza's approval.
3. Arrow construction off the main thread (candidate C), only if encoding
   delays writes or blocks other work (`makeArrowTable` 16.3 s on the main
   thread). The comparison must include the worker transfer and Arrow IPC
   serialization: moving the construction alone does not remove those
   costs.
4. Navigation (about 65 s, serial) stays an independent target. Start with
   redundant directory creation (`navigation.stage.mkdir` makes 35,764 calls
   for symbols) and Python argument lookup in relationship resolution. P5
   (resolve other languages while Java semantic runs) needs evidence that
   CPU contention does not consume the saving. P3 (reuse Java content)
   needs a memory budget.
5. Scan reuse (P4 (a)): reassess. The policy walk now takes about 1.1 s, so
   reuse of its listings cannot remove the whole 18 s scan. File identity
   and the final source checks stay.
6. Finalization: deprioritized. Shortening it alone does not move
   publication (see the timeline above).
7. Packaging (separate from this Linux result): prebuilt addons for
   darwin-arm64, darwin-x64 and win32-x64. Today those platforms use the
   TypeScript path, which gives the same output. The 38.1 s Linux
   difference (Candidate A runs) does not predict macOS or Windows savings.
   Needs a CI build and a release decision.
