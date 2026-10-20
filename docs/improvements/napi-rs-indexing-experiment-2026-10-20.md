# napi-rs experiment: native kernels for the full index, 20 October 2026

This note is a plan for an experiment that Hamza runs. It names the
single-thread costs that remain on the LibreOffice full-index critical path
after r16, says for each cost if a Rust addon built with napi-rs can help,
and defines the parity, packaging, safety and measurement rules that a
native kernel must pass before it can replace TypeScript code.

Evidence comes from `libreoffice-performance-findings-2026-10-20.md` (runs
r10 to r16 and the r14 CPU profile). Machine, corpus and memory limit are
the same as in that note: WSL2, 16 cores, about 7 GB RAM, 35,760 indexed
files, 547,349 chunks, MemoryMax=6G.

## Summary

- The critical path is 403.9 s (r16). The goal is 200 s or less. The
  codebase-memory-mcp graph-only index (C) takes 236 s on the same corpus
  and is a reference point, not a parity target.
- The payload pipeline (257.5 s) is limited by main-thread CPU. The main
  thread is 82 % busy, and the 4 analysis workers are about 76 % idle
  (findings §5). Any change that does not remove work from the main thread
  does not shorten the payload.
- A napi-rs call made from the main thread still runs on the main thread.
  It helps only if the Rust kernel is much faster than the JavaScript code
  after the cost of copying the data across the boundary, or if the call
  runs as an `AsyncTask` on the libuv thread pool.
- Recommendation: first move main-thread payload work to Node worker threads
  (planned as the next step after r17). Then profile again. Use napi-rs only
  for kernels that stay at the top of that profile. Two costs have a better
  fix than napi-rs: the embedding transport and the file-open checks.

## Where the 404 s go (r16)

| Phase | Wall time | Note |
| --- | --- | --- |
| `index.policy.observe_inputs` | 31.3 s | Ignore-file walk. `cfac56cc` makes it sync (2.3 s to 1.2 s alone). r17 measures it. |
| `index.scanFiles` | 20.2 s | `getCodeFiles` walk with promise `readdir` and `stat`. |
| `index.payloadPipeline` | 257.5 s | Analysis, projections, embedding, vector writes. Main thread 82 % busy. |
| `index.prepare_changes` | 27.9 s | Validating scan. Runs before navigation because navigation needs its auxiliary hashes. |
| `index.navigation` | 75.1 s | Relationships 27.6 s, stage 32.2 s (of which `fsync_tree` 6.5 s). |
| Publication tail | 17.0 s | `source_current` 11.1 s, `policy_current` 2.6 s, activation. |

The `navigation.stage.write` and `navigation.stage.mkdir` spans add the time
of concurrent calls (288.9 s and 277.7 s in r16). They are not wall time.
The wall time of the whole stage is 32.2 s.

## Ranked candidates

Costs are main-thread CPU from the r14 profile (247 s payload window) unless
the row says otherwise. "Single thread" says why the cost does not spread
over the 16 cores today.

| Rank | Cost | Owner | Single thread because | napi-rs verdict |
| --- | --- | --- | --- | --- |
| 1 | Search projections, 52.6 s inclusive | `packages/core/src/core/search-projections.ts` (`buildSearchProjections`, `createIdentifierSplitter`) | Runs on the main thread for each chunk after analysis returns. | Good candidate. Pure string work: tokenize, split identifiers, lower-case, deduplicate. Run as an `AsyncTask` per file batch, not per chunk. Worker thread first. |
| 2 | Relationship resolution, 41.6 s inclusive (Python 19.3 s) | `packages/core/src/relationships/builder.ts`, `relationships/python-resolution.ts`, `relationships/contributions/*` | One pass on the main thread over all symbols after the payload. | Possible, but the input is large JavaScript maps of symbols and bindings. Copying them into Rust may cost as much as the work. Try a worker-thread split by language first. |
| 3 | Navigation stage, 32.2 s wall (r16) | `packages/core/src/symbols/sidecar-writes.ts`, `symbols/sidecar-lifecycle.ts` | Serialize on the main thread, then 71,523 promise `mkdir` and `write` calls. | Design fix first: fewer, larger files or sync writes in batches (findings §3). A Rust writer on its own thread pool is an option only if the file count must stay. Durability rules stay as they are (`syncfs` decision in `syncStagedFileSystem`). |
| 4 | Embedding transport, about 20.6 s | `packages/core/src/embedding/potion-embedding.ts` (`handleStdout`, `handleFrame`, `TextEncoder.encode`) | Vectors come back as JSON over the stdout of the `satori-potion` helper and are parsed on the main thread. | Better fix without napi-rs: a binary frame of little-endian `float32` values from the helper. A napi-rs addon that loads model2vec-rs in-process removes the process and the pipe, but changes the process model and the memory budget. Measure the binary frame first. |
| 5 | LanceDB row encoding, 15.6 s | `packages/core/src/vectordb/lancedb-vectordb.ts` (`encodeSearchableRow`, about line 362) | Builds JavaScript row objects on the main thread before each write. | Medium. `@lancedb/lancedb` is already a native addon. Build Arrow record batches in a worker thread first. A Rust encoder helps only if it hands Arrow buffers to LanceDB without a copy back into JavaScript objects. |
| 6 | Garbage collection, 15.2 s | Whole payload | Short-lived strings and objects from ranks 1, 4 and 5. | Indirect. GC falls when ranks 1, 4 and 5 allocate less on the main heap. Do not target it alone. |
| 7 | File-open checks, 14.6 s | `packages/core/src/sync/root-bound-fs.ts` (`openInsideRoot`) | realpath, lstat, fstat and readlink for each file through promise calls. | No. This code is a security boundary. Fix it in TypeScript the same way as `78d5c4f0`: one descriptor check per directory, sync calls. |
| 8 | Symbol facts, 6.6 s | `packages/core/src/symbols/registry.ts` | Main thread per analyzed file. | No. Too small for the boundary cost. Move it with the worker-thread step. |
| 9 | Tree walks: `observe_inputs`, `scanFiles`, `prepare_changes`, `source_current` | `core/ignore-file-inputs.ts`, `core/indexing-pipeline.ts` (`getCodeFiles`), `sync/sync-scan.ts` | One directory at a time, promise calls (findings §3, §4). | No. A Rust walker (for example the `ignore` crate) must copy the ignore, policy and admission rules of Satori exactly. AGENTS.md forbids a copy of a library rule that gives definite answers. Sync calls already give most of the gain. |

The analysis itself (tree-sitter WASM in 4 worker threads) is not on this
list. Its workers are idle most of the time.

## What napi-rs can and cannot change

- Boundary cost: a JavaScript string is UTF-16 or Latin-1 in V8. Rust uses
  UTF-8. Each string that crosses is copied and converted. Each JavaScript
  object that crosses is read field by field. Send one batch per file or per
  write, as flat buffers or arrays of strings, never one call per chunk.
- Thread: a sync napi-rs function blocks the main thread for its full
  duration. Use `AsyncTask` (libuv pool) or a Rust thread pool with a
  `ThreadsafeFunction` callback so that the main thread stays free.
- Worker threads: an addon loaded in a Node worker thread must be
  context-aware. napi-rs addons are, but test the load in a worker thread
  early.
- Panics: a Rust panic must not stop the process. Return `napi::Result`
  errors and catch panics at the boundary.
- Cancellation: a long Rust loop must check a cancellation flag between
  batches, the same way the TypeScript loop checks the mutation lease once
  per yield (`c4458339`). Background Rust work must stop before the
  TypeScript caller returns or throws.

## Parity plan

A native kernel replaces TypeScript only if it produces the same published
output.

1. Keep the TypeScript function as the reference. Do not delete it during
   the experiment.
2. Differential test on fixtures: list the inputs the kernel branches on
   (ASCII, non-ASCII and astral-plane identifiers, mixed case, digits,
   underscores and `$`, empty chunks, very long tokens, CRLF). Assert equal
   output from both implementations.
3. Corpus differential: run both implementations on all 547,349 chunks of
   the LibreOffice corpus and compare the outputs byte for byte. Any
   difference blocks the change.
4. Rules that differ between JavaScript and Rust and must match exactly:
   - Offsets and lengths: JavaScript counts UTF-16 code units. Rust counts
     bytes. Every offset that reaches published output must use the
     JavaScript unit.
   - Case mapping: `toLowerCase` and Rust `to_lowercase` differ on some
     characters (for example final sigma). Use the same mapping or fall
     back to TypeScript for non-ASCII input.
   - Regular expressions: JavaScript `\w`, `\b` and Unicode property
     escapes do not match the Rust `regex` defaults.
   - Sort order: compare with the same rule (code unit order, not
     `localeCompare`, unless the TypeScript code uses it). Equal scores
     keep a deterministic order.
   - Numbers: float values that reach the index must be bit-identical.
5. Full-index differential: index the corpus with and without the addon.
   Compare the published artifacts (search rows, symbol sidecars,
   relationships) after a stable sort.
6. Mutation check: break the kernel on purpose (for example skip the
   identifier split for one character class). The differential test must
   fail. Then restore.
7. Fallback: if the addon is missing, fails to load, or reports "unsure"
   for an input, the TypeScript path runs. A test covers each case.

## Build and packaging gaps

- Toolchain: Rust stable and `@napi-rs/cli` become build requirements.
  AGENTS.md requires approval before a new build requirement or dependency.
- Prebuilt binaries: users must not need Rust. Publish one package per
  platform (for example `@satori/native-linux-x64-gnu`) as
  `optionalDependencies`, the napi-rs standard layout. The current
  `satori-potion` helper ships only `linux-x64` in
  `packages/mcp/assets/potion/`. Decide the platform list before the
  experiment ends: linux-x64, linux-arm64, darwin-arm64, win32-x64.
- CI: a build matrix per platform, and the differential tests on each.
- Node-API version: pick the lowest Node-API version that the kernels need,
  so one binary works on all supported Node versions.
- WSL: build inside WSL (`~/repo`), not on `/mnt/c`. A Windows build is a
  separate target.
- Version and scope checks: `pnpm run check` must still pass. The new
  package needs the same version rules as `core`, `mcp` and `cli`.
- License: record the licenses of all Rust crates in the published package.

## Safety

- Root-bound file system access (`sync/root-bound-fs.ts`) stays in
  TypeScript. If a Rust kernel ever opens files, it must receive open
  descriptors or verified paths from TypeScript, or its root checks must be
  proved again with the same fault tests (moved directory, symlink out of
  the root, replaced file).
- No partial publication: a native failure in the middle of a batch must
  leave the same state as a TypeScript failure. Add a fault-injection test
  for a failure in the middle of a batch.
- Untrusted input: source text is untrusted. A kernel must handle invalid
  UTF-16 (lone surrogates), very long lines and binary-like text without a
  panic or unbounded memory.

## Memory budget

- The full run must stay under MemoryMax=6G. Peak anonymous memory is
  4,288 MiB in r16, so the headroom is about 1.7 GiB.
- Rust memory is outside the V8 heap and the GC does not see it. Bound
  every Rust buffer by batch size. Free it before the call returns.
- A Rust thread pool adds stack memory per thread. Cap the pool size.
- An in-process Potion model (rank 4, second option) adds the model size to
  the index process. Measure it before choosing that option.

## Measurement

- Profile first: a `--cpu-prof` full run, then `analyze.mjs` from the
  `full-r11-prof` bench folder for the payload window. Rank costs again
  after each change.
- Microbenchmark each kernel on the real corpus data: TypeScript against
  Rust, including the boundary copy.
- Full run: median of 3 runs on the same input, alone on the machine.
  Report critical path, the phase spans above, peak anonymous memory, the
  1-minute load at start, and the command. Use the run and span scripts in
  `bench-bugs/libreoffice-perf-20261020/full-r16/`.
- Compare profiled runs only with profiled runs.

## Experiment steps

| Step | Claim | Check that can disprove it | Stop when |
| --- | --- | --- | --- |
| 1 | The worker-thread step leaves search projections at the top of the main-thread profile. | New CPU profile after the worker-thread step. | Projections are under 10 s of main-thread CPU: skip napi-rs for them. |
| 2 | A Rust projection kernel is at least 3 times faster than TypeScript, including the boundary copy. | Microbenchmark on all corpus chunks. | Less than 2 times faster: stop. |
| 3 | The kernel output is identical. | Fixture and corpus differential tests, mutation check. | Any difference that cannot be fixed without a copy of a JavaScript rule. |
| 4 | The full critical path falls. | Median of 3 full runs, peak memory under 6 GiB. | Gain under 5 % of the critical path: keep TypeScript. |
| 5 | Repeat steps 2 to 4 for rank 2, then rank 5. | Same checks. | Same stop rules. |

## Out of scope

- Rewriting tree walks, ignore rules or root-bound file access in Rust.
- Replacing LanceDB, tree-sitter or the Potion model.
- Any change to search ranking or published formats.
