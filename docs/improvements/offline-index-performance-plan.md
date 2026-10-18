# Offline full-index performance plan

Status: plan only. Three independent proposals from one profiled offline full
index, 16 October 2026. Nothing here is implemented.

## Baseline

One full index of a frozen `git archive d4f1b5a3` snapshot of this repository
(1,194 files, 46,025 chunks), offline profile: Potion embedder, no reranker,
LanceDB. Command shape:

```bash
systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 -- /usr/bin/time -v \
  env SATORI_RUNTIME_PROFILE=offline EMBEDDING_PROVIDER=Potion SATORI_RERANKER_PROVIDER=none \
  VECTOR_STORE_PROVIDER=LanceDB SATORI_PERF_TRACE=1 SATORI_STATE_ROOT=<fresh dir> \
  POTION_HELPER_PATH=<abs> POTION_MODEL_PATH=<abs> node --cpu-prof <harness> <snapshot>
```

| Phase (`SATORI_PERF_TRACE` span) | ms | % of 103,156 ms |
|---|---:|---:|
| `index.payloadPipeline` | 68,895 | 66.8% |
| `index.analysisWait` | 45,828 | 44.4% |
| `index.vectorWrites` | 39,026 | 37.8% |
| `index.embedding` (Potion) | 22,464 | 21.8% |
| `index.navigation` | 33,525 | 32.5% |
| `navigation.resolution` (typescript) | 20,430 | 19.8% |
| `navigation.stage` | 8,050 | 7.8% |
| `index.finalizeCollection` | 4,129 | 4.0% |

Rows overlap; percentages do not add up. Main thread idle: 53.5%. Peak cgroup
memory 2.64 GiB. Largest main-thread self time: `Buffer.toString` 16,055 ms
(caller Potion `handleFrame`), `splitIdentifierComponents` 4,118 ms, GC 3,231 ms.
For comparison, the same snapshot with remote VoyageAI took 1,287,508 ms, 98.6%
of it embedding at one request in flight (see
[Voyage embedding parity plan](voyage-embedding-parity-plan.md), Phase 6).

Limits of the baseline: one run, not a median. The profile loaded
`packages/core/dist`, so function-to-source mapping is not proven.

## Rules for every proposal

- AGENTS.md "Changes that claim unchanged behavior" and "Performance and
  robustness" apply. Each proposal promises identical published output.
- Step 1 of each proposal is a measurement. If the measurement contradicts the
  claim, stop and report; do not implement.
- Measure with `scripts/perf/index-probe.mjs` (build `core` and `mcp` first, see
  `scripts/perf/README.md`) or an equivalent harness, offline profile, on a
  frozen `git archive` snapshot, never on the live repository (live commits make
  source validation refuse publication). Fresh `SATORI_STATE_ROOT` per run. Do
  not touch `~/.satori`.
- Before/after: median of 3 runs each, with peak memory, load and the command.
  Run one heavy job at a time (about 7 GB RAM on this machine).
- Equivalence: the published generation must be the same before and after
  (row ids, content hashes, vectors byte for byte, navigation sidecars).
- One proposal per change and per commit. The proposals touch different owners
  and can be done in any order.

## Proposal 1: Potion response decoding

**Claim.** Main-thread cost of reading Potion responses is large and mostly
avoidable on the Node side, without changing the helper.

**Owner.** `packages/core/src/embedding/potion-embedding.ts`:
`handleStdout` (line ~505) and `handleFrame` (line ~587). Helper source:
`experiments/potion-l0-l1/src/main.rs` (`write_frame`, line ~74). Shipped helper:
`packages/mcp/assets/potion/linux-x64/satori-potion` with `manifest.json`.

**Facts that constrain the design.**
- The helper writes one compact JSON object per response, then `\n`, with one
  `write_all` (`main.rs` `write_frame`). Compact JSON never contains a raw
  newline, so `\n` ends a frame.
- `handleStdout` does `Buffer.concat` on every stdout chunk and rescans the
  whole buffer from byte 0 with a brace-matching loop. A frame that arrives in
  many chunks is copied and rescanned once per chunk.
- A response for 64 items at dimension 256 is a few hundred KB of JSON floats.
  `MAX_WORKER_FRAME_BYTES` is 1 MiB. 720 responses in the baseline.
- `toString` at 16 s does not fit 720 decodes of a few hundred KB each. The
  attribution needs a check before any design choice.

**Steps.**
1. Measure, on the baseline snapshot or a captured set of real responses:
   bytes per response, stdout chunks per response, time in `Buffer.concat`, in
   the scan loop, in `frame.toString`, in `JSON.parse`, and in vector
   validation (`record.vector.some(...)`, line ~795). Record which one holds the
   16 s. Confirm that the shipped `satori-potion` binary (not only the source)
   ends every frame with `\n`.
2. If the cost is framing (concat and rescan): keep a list of chunks and a scan
   offset, find the frame end with `indexOf(0x0a)` from the last scanned
   position, and concatenate once per frame. Keep the oversized-frame and
   invalid-frame errors with the same codes and messages.
3. If the cost is JSON decoding of floats after step 2: write a separate design
   for a binary vector payload (helper writes raw little-endian `f32` after a
   JSON header). This changes the helper protocol, needs a helper rebuild, a
   manifest update and a protocol version check at startup. Bring that design
   back for approval; do not implement it as part of this proposal.

**Tests.** Differential test: the same responses split at every chunk boundary
pattern (one byte at a time, one chunk, random splits) give the same vectors as
the current parser. Failure tests: oversized frame, invalid frame, frame that
ends without `\n` at EOF, worker exit mid-frame; each gives the current error and
no partial result. Mutation check: break the offset bookkeeping and confirm the
differential test fails.

**Done when.** Vectors are identical, all existing `potion-embedding.test.ts`
cases pass, and the median `index.embedding` plus main-thread self time drops by
an amount you report. Expected gain: up to about 16 s of main-thread time; the
wall-time gain is smaller because the main thread is idle 53% of the time.

## Proposal 2: LanceDB vector writes

**Claim.** Vector writes (39,026 ms over 180 writes) cost more on a fresh
publication collection than the work needs.

**Owner.** `packages/core/src/vectordb/lancedb-vectordb.ts`, the write method
around lines 660 to 704. Write size: `vectorWriteMaxRows` in
`packages/core/src/indexing/resources.ts:233` (`min(256, queuedEmbeddingTextBytes / 32 KiB)`)
and `maxWriteBatchSize` (line ~476, default 512). The baseline plan wrote 256
rows per write.

**Facts that constrain the design.**
- Every batch first queries existing `id, contentHash` for its ids, then runs
  `mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll()`.
- A full index writes into a collection created for this publication
  (`resolvePublicationCollectionName(codebasePath, publicationId)` and
  `prepareCollection` in `packages/core/src/generation/index-generation-workflow.ts`
  around line 761). The query and merge exist for idempotent rewrites; whether a
  full index can ever write the same id twice into its own collection is not
  established yet.
- A merge on a growing table may cost more per write as the table grows. Not
  measured yet.

**Steps.**
1. Measure per write: rows, time in `encodeSearchableRow`, in the existing-row
   query, in `mergeInsert`, and the table row count at that point. Plot or list
   cost against table size. Report whether cost grows with table size.
2. Choose by the data, then bring the choice back for approval:
   - a. Larger writes on full index (for example 512 or 1,024 rows), if cost is
     per write and flat in table size. Check the memory effect against the
     frozen resource plan.
   - b. Append (`table.add`) instead of query plus merge, only when the writer
     can prove the ids are new: collection created by this publication and ids
     not written before in this run, tracked by the writer. Any doubt falls back
     to the current query plus merge. Name the invariant in a comment at the
     remaining check.
3. Implement only the approved option.

**Tests.** Differential test: the same documents written with the old and the
new path give the same rows (ids, hashes, vectors, searchable fields). For
option b: a rewrite of an existing id in the same collection still updates the
row (fallback path), and a cancelled or failed index publishes nothing. Mutation
check: break the "ids are new" witness and confirm a test fails.

**Done when.** Published rows are identical and the median `index.vectorWrites`
drops by an amount you report. Search results on a fixed question set are
unchanged.

## Proposal 3: navigation start and TypeScript resolution

**Claim.** Navigation (33,525 ms, main thread 86% idle) starts late and runs
TypeScript projects one at a time, so part of it can overlap other work.

**Owner.** `packages/core/src/generation/index-generation-workflow.ts`: full
index orchestration around lines 810 to 900, and
`stageSymbolRegistryForCompletedIndex` (resolution at line ~561, semantic at
line ~513). Resource plan: `typescriptProjectConcurrency` in
`packages/core/src/indexing/resources.ts:199`.

**Facts that constrain the design.**
- Navigation already overlaps the payload drain: it starts after
  `processFileList` returns (all analysis done) and runs while embedding and
  vector writes finish (`payloadDrain`). Offline, embedding is fast, so little
  drain is left to overlap. Navigation then runs mostly after analysis.
- Navigation consumes `result.analysisByFile`, `result.symbolRecords` and
  `preparedChanges.fileHashes` from `synchronizer.prepareChanges`, which needs
  the completed source capture. These dependencies limit how early it can start.
- TypeScript resolution runs per project. `typescriptProjectConcurrency` is
  `min(cpu limit, jobBytes / TYPESCRIPT_JOB_BYTES)`; the 4 GiB baseline plan gave
  1 project at a time. The limit exists for memory.

**Steps.**
1. Measure: a timeline of `navigation.resolution` and `typescript.*` spans per
   project, worker CPU versus idle, and the time from analysis end to
   navigation start. List which inputs each navigation sub-step needs.
2. From step 1, write the option with the best expected gain, then bring it
   back for approval. Candidates:
   - a. Start the TypeScript program build and resolution for a project as soon
     as the analysis inputs it needs exist, not after all files.
   - b. Change the memory estimate behind `typescriptProjectConcurrency` only if
     step 1 shows `TYPESCRIPT_JOB_BYTES` overstates measured per-project peak
     memory; measure peak memory under a 4 GiB cap.
3. Implement only the approved option. Any new scheduling must keep the current
   rule that every publication step waits for navigation and payload, and that
   cancellation or failure stops background work and publishes nothing.

**Tests.** Equivalence: navigation sidecars and the published navigation
manifest are identical. Failure tests with deterministic fault injection:
failure in one project while another runs, cancellation during resolution;
assert cleanup completed and nothing published. Memory: peak under the 4 GiB cap.

**Done when.** Navigation output is identical, the failure tests pass and fail
on the broken code, and the median `index.navigation` or index wall time drops
by an amount you report with peak memory.

## Out of scope

- Concurrent VoyageAI requests: Phase 6 of the
  [Voyage embedding parity plan](voyage-embedding-parity-plan.md).
- `index.analysisWait` (45,828 ms) is the largest single span offline but is not
  one of these three proposals. Proposal 1 may reduce it by freeing the main
  thread; measure it in every run.
- A Rust or WASM port of `splitIdentifierComponents` (4,118 ms): consider only
  after these proposals, with its own profile.
